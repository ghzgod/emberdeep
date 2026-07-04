import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { learner } from '../ai/learner.js';

// Enemy archetypes. Stats scale with dungeon floor.
export const ENEMY_TYPES = {
  skeleton: {
    name: 'Skeleton',
    base: { hp: 32, damage: 9, speed: 3.5, xp: 14, gold: [2, 6] },
    perFloor: { hp: 9, damage: 2.2, xp: 5 },
    attack: { kind: 'melee', range: 1.5, cooldown: 1.2, windup: 0.35 },
    aggroRange: 9, radius: 0.4,
    sounds: { hurt: 'skeleton_hurt', death: 'skeleton_death' },
    color: 0xd8d4c8,
  },
  spider: {
    name: 'Cave Spider',
    base: { hp: 20, damage: 6, speed: 5.4, xp: 11, gold: [1, 4] },
    perFloor: { hp: 6, damage: 1.6, xp: 4 },
    attack: { kind: 'melee', range: 1.3, cooldown: 0.9, windup: 0.2 },
    aggroRange: 10, radius: 0.35,
    sounds: { hurt: 'spider_hurt', death: 'spider_death' },
    color: 0x3a3a44,
  },
  imp: {
    name: 'Imp',
    base: { hp: 24, damage: 8, speed: 4.0, xp: 16, gold: [3, 8] },
    perFloor: { hp: 7, damage: 2.0, xp: 5 },
    attack: { kind: 'ranged', range: 8.5, keepDistance: 6, cooldown: 1.8, windup: 0.5, projSpeed: 10 },
    aggroRange: 11, radius: 0.35,
    sounds: { hurt: 'imp_hurt', death: 'imp_death', shoot: 'imp_shoot' },
    color: 0xc85a3a,
  },
  golem: {
    name: 'Stone Golem',
    base: { hp: 85, damage: 18, speed: 2.2, xp: 30, gold: [6, 14] },
    perFloor: { hp: 18, damage: 3.5, xp: 8 },
    attack: { kind: 'slam', range: 2.0, aoe: 2.6, cooldown: 2.2, windup: 0.7 },
    aggroRange: 8, radius: 0.6,
    sounds: { hurt: 'golem_hurt', death: 'golem_death', special: 'golem_slam' },
    color: 0x7a7a85,
  },
};

const MINIBOSS_NAMES = {
  skeleton: 'Gravelord Ossus',
  spider: 'Broodmother Vex',
  imp: 'Pyrelord Snikt',
  golem: 'The Unmoved Colossus',
};

export class Enemy {
  constructor(typeId, floor, opts = {}) {
    this.typeId = typeId;
    this.def = ENEMY_TYPES[typeId];
    this.miniboss = !!opts.miniboss;
    this.elite = !!opts.elite;

    const f = floor - 1;
    let hp = this.def.base.hp + this.def.perFloor.hp * f;
    let damage = this.def.base.damage + this.def.perFloor.damage * f;
    this.xp = this.def.base.xp + this.def.perFloor.xp * f;
    this.goldRange = this.def.base.gold;
    this.speed = this.def.base.speed;
    this.radius = this.def.radius;

    if (this.miniboss) {
      hp *= 3.5; damage *= 1.6; this.xp = Math.round(this.xp * 4);
      this.radius *= 1.4;
      this.name = MINIBOSS_NAMES[typeId] || 'Champion';
    } else if (this.elite) {
      hp *= 2.2; damage *= 1.3; this.xp = Math.round(this.xp * 2.5);
      this.radius *= 1.2;
      this.name = `Elite ${this.def.name}`;
    } else {
      this.name = this.def.name;
    }

    this.maxHp = Math.round(hp);
    this.hp = this.maxHp;
    this.damage = damage;

    this.pos = new THREE.Vector3();
    this.state = 'idle';        // idle | chase | windup | recover | stunned
    this.stateTimer = 0;
    this.attackCd = 0;
    this.statuses = [];
    this.dead = false;
    this.hitFlash = 0;
    this.knockback = null;

    this.mesh = buildEnemyMesh(typeId, this.miniboss ? 1.5 : this.elite ? 1.25 : 1);
    if (this.elite) {
      // silver elite crown
      const crown = this.mesh.children.find((c) => c.geometry?.type === 'TorusGeometry');
      if (crown) crown.material = new THREE.MeshBasicMaterial({ color: 0xc8d8e8 });
    }
  }

  get moveSpeed() {
    let s = this.speed;
    for (const st of this.statuses) if (st.slow) s *= st.slow.mult;
    return s;
  }

  addStatus(status, game) {
    if (status.burn) this.statuses.push({ burn: status.burn, t: status.burn.duration, tickT: 0 });
    if (status.poison) this.statuses.push({ poison: status.poison, t: status.poison.duration, tickT: 0 });
    if (status.slow) this.statuses.push({ slow: status.slow, t: status.slow.duration });
  }

  stun(duration) {
    if (this.dead) return;
    this.state = 'stunned';
    this.stateTimer = duration;
  }

  update(dt, game) {
    if (this.dead) return;
    const player = game.player;

    this.attackCd = Math.max(0, this.attackCd - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    // DoT statuses
    for (const st of this.statuses) {
      st.t -= dt;
      const dot = st.burn || st.poison;
      if (dot) {
        st.tickT -= dt;
        if (st.tickT <= 0) {
          st.tickT = 0.5;
          const dmg = Math.max(1, Math.round(dot.dps * 0.5));
          game.damageEnemy(this, dmg, { silent: true, noFlash: true, dot: true, color: st.burn ? 'burn' : 'poison' });
          if (this.dead) return;
        }
      }
    }
    this.statuses = this.statuses.filter((s) => s.t > 0);

    // knockback velocity decays
    if (this.knockback) {
      const k = this.knockback;
      const nx = this.pos.x + k.x * dt;
      const nz = this.pos.z + k.z * dt;
      if (game.isWalkable(nx, this.pos.z, this.radius)) this.pos.x = nx;
      if (game.isWalkable(this.pos.x, nz, this.radius)) this.pos.z = nz;
      k.x *= 1 - 6 * dt; k.z *= 1 - 6 * dt;
      if (Math.abs(k.x) + Math.abs(k.z) < 0.3) this.knockback = null;
    }

    // Target the nearest living hero (in co-op that may be a remote player).
    const target = game.getNearestTarget(this.pos);
    const tPos = target.pos;
    const distToPlayer = Math.hypot(tPos.x - this.pos.x, tPos.z - this.pos.z);
    const atk = this.def.attack;

    switch (this.state) {
      case 'idle': {
        if (!target.dead && distToPlayer < this.def.aggroRange && game.hasLineOfSight(this.pos, tPos)) {
          this.state = 'chase';
          if (this.miniboss) audio.play(this.def.sounds.hurt, { pos: this.pos, volume: 0.8, rate: 0.7 });
        }
        break;
      }
      case 'chase': {
        if (target.dead) { this.state = 'idle'; break; }
        const inRange = atk.kind === 'ranged'
          ? distToPlayer < atk.range && game.hasLineOfSight(this.pos, tPos)
          : distToPlayer < atk.range;
        if (inRange && this.attackCd <= 0) {
          this.state = 'windup';
          this.stateTimer = atk.windup;
          if (atk.kind === 'slam') audio.play(this.def.sounds.special, { pos: this.pos, volume: 0.6 });
          break;
        }
        // move toward target (imps keep their distance).
        // If the movement learner has a prediction (local player only), steer
        // toward the INTERCEPT point instead of tail-chasing.
        let targetX = tPos.x, targetZ = tPos.z;
        if (atk.kind !== 'ranged' && distToPlayer > 3 && target.local) {
          const pred = learner.predict(player);
          if (pred) { targetX += pred.dx * 0.7; targetZ += pred.dz * 0.7; }
        }
        let dirX = targetX - this.pos.x;
        let dirZ = targetZ - this.pos.z;
        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len; dirZ /= len;
        if (atk.keepDistance && distToPlayer < atk.keepDistance) { dirX = -dirX; dirZ = -dirZ; }
        const spd = this.moveSpeed;
        const nx = this.pos.x + dirX * spd * dt;
        const nz = this.pos.z + dirZ * spd * dt;
        if (game.isWalkable(nx, this.pos.z, this.radius)) this.pos.x = nx;
        if (game.isWalkable(this.pos.x, nz, this.radius)) this.pos.z = nz;
        break;
      }
      case 'windup': {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.executeAttack(game, distToPlayer, target);
          this.state = 'recover';
          this.stateTimer = 0.3;
          this.attackCd = atk.cooldown;
        }
        break;
      }
      case 'recover': {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.state = 'chase';
        break;
      }
      case 'stunned': {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.state = 'chase';
        break;
      }
    }

    // separation from other enemies (cheap)
    for (const other of game.enemies) {
      if (other === this || other.dead) continue;
      const dx = this.pos.x - other.pos.x;
      const dz = this.pos.z - other.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = this.radius + other.radius;
      if (d > 0.001 && d < minD) {
        const push = (minD - d) * 0.5;
        const nx = this.pos.x + (dx / d) * push;
        const nz = this.pos.z + (dz / d) * push;
        if (game.isWalkable(nx, nz, this.radius)) { this.pos.x = nx; this.pos.z = nz; }
      }
    }

    // mesh sync
    this.mesh.position.copy(this.pos);
    if (!target.dead && this.state !== 'idle') {
      this.mesh.rotation.y = Math.atan2(tPos.x - this.pos.x, tPos.z - this.pos.z);
    }
    // windup telegraph: lean/scale
    const scaleBase = this.miniboss ? 1.5 : 1;
    if (this.state === 'windup') {
      const t = 1 - this.stateTimer / atk.windup;
      this.mesh.scale.setScalar(scaleBase * (1 + t * 0.15));
    } else {
      this.mesh.scale.setScalar(scaleBase);
    }
    // hit flash
    this.mesh.traverse((o) => {
      if (o.isMesh && o.material?.emissive !== undefined) {
        o.material.emissive.setScalar(this.hitFlash > 0 ? 0.6 : 0);
      }
    });
  }

  executeAttack(game, distToTarget, target) {
    const atk = this.def.attack;
    target = target || game.getNearestTarget(this.pos);
    const tPos = target.pos;
    if (atk.kind === 'melee') {
      if (distToTarget < atk.range + 0.4) game.hitTarget(target, this.damage);
    } else if (atk.kind === 'slam') {
      game.shake(0.3);
      game.particles.ring(this.pos.x, 0.3, this.pos.z, atk.aoe, 0xaaa8a0);
      audio.play('golem_slam', { pos: this.pos });
      game.aoeHitPlayers(this.pos.x, this.pos.z, atk.aoe, this.damage);
    } else if (atk.kind === 'ranged') {
      audio.play(this.def.sounds.shoot, { pos: this.pos });
      // Lead the shot toward where the learner thinks the (local) player will be.
      let tx = tPos.x, tz = tPos.z;
      if (target.local) {
        const pred = learner.predict(game.player);
        if (pred) { tx += pred.dx * 0.8; tz += pred.dz * 0.8; }
      }
      const dx = tx - this.pos.x, dz = tz - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      game.spawnProjectile({
        x: this.pos.x, z: this.pos.z, dir: { x: dx / len, z: dz / len },
        speed: atk.projSpeed, radius: 0.3, damage: this.damage,
        friendly: false, color: 0xff7a3a, size: 0.2, trail: 0xff5a2a,
      });
    }
  }
}

// ---------------- Act bosses ----------------
// One lord per act; The Dungeon Lord himself waits at the bottom of Act V.
export const ACT_BOSSES = [
  null,
  { name: 'Gravewarden Malruk', glow: 0xff5a4a, summons: ['skeleton', 'skeleton', 'spider'] },
  { name: 'Broodqueen Sszarra', glow: 0x8ade5a, summons: ['spider', 'spider', 'spider'] },
  { name: 'Pyrarch Vexmal', glow: 0xff8c1a, summons: ['imp', 'imp', 'skeleton'] },
  { name: 'The Obsidian Colossus', glow: 0xb35eff, summons: ['golem', 'imp', 'spider'] },
  { name: 'The Dungeon Lord', glow: 0x4ae8d8, summons: ['skeleton', 'imp', 'golem'] },
];

export class Boss extends Enemy {
  constructor(floor) {
    super('golem', floor, {});
    const act = Math.min(5, Math.max(1, Math.ceil(floor / 10)));
    const def = ACT_BOSSES[act];
    this.act = act;
    this.name = def.name;
    this.summonTypes = def.summons;
    this.isBoss = true;
    this.maxHp = 500 + act * 550 + floor * 25;
    this.hp = this.maxHp;
    this.damage = 14 + act * 6;
    this.speed = 2.5 + act * 0.12;
    this.radius = 1.0;
    this.xp = 220 + act * 160;
    this.goldRange = [60 + act * 25, 120 + act * 40];
    this.phase = 1;
    this.summonCd = 6;
    this.barrageCd = 4;

    this.mesh = buildBossMesh(def.glow);
  }

  update(dt, game) {
    if (this.dead) return;
    // phase transitions
    const frac = this.hp / this.maxHp;
    if (this.phase === 1 && frac < 0.66) this.enterPhase(2, game);
    else if (this.phase === 2 && frac < 0.33) this.enterPhase(3, game);

    // phase behaviors layered on top of base golem melee AI
    if (this.state !== 'idle' && !game.player.dead) {
      if (this.phase >= 1) {
        this.summonCd -= dt;
        if (this.summonCd <= 0 && this.phase >= 2) {
          this.summonCd = this.phase === 3 ? 9 : 12;
          game.bossSummon(this);
        }
      }
      if (this.phase >= 2) {
        this.barrageCd -= dt;
        if (this.barrageCd <= 0) {
          this.barrageCd = this.phase === 3 ? 3.2 : 5;
          this.fireBarrage(game);
        }
      }
    }
    super.update(dt, game);
  }

  enterPhase(n, game) {
    this.phase = n;
    audio.play('boss_roar');
    game.shake(0.7);
    game.particles.ring(this.pos.x, 1, this.pos.z, 6, 0xb35eff);
    game.ui.floaters.spawn(this.pos, n === 2 ? 'THE LORD CALLS HIS DEAD' : 'THE LORD IS ENRAGED', 'crit');
    if (n === 3) { this.speed = 3.8; this.damage *= 1.3; }
  }

  fireBarrage(game) {
    audio.play('imp_shoot', { pos: this.pos, rate: 0.7 });
    const count = this.phase === 3 ? 10 : 6;
    const glow = ACT_BOSSES[this.act]?.glow ?? 0xb35eff;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      game.spawnProjectile({
        x: this.pos.x, z: this.pos.z, dir: { x: Math.cos(a), z: Math.sin(a) },
        speed: 7, radius: 0.35, damage: this.damage * 0.6,
        friendly: false, color: glow, size: 0.24, trail: glow,
      });
    }
  }
}

// ---------------- Meshes ----------------
function makeMat(color, rough = 0.8) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough });
}

function addShadowBlob(g, radius) {
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  g.add(shadow);
}

export function buildEnemyMesh(typeId, scale = 1) {
  const g = new THREE.Group();
  const def = ENEMY_TYPES[typeId];

  if (typeId === 'skeleton') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 8), makeMat(def.color));
    body.position.y = 0.65;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), makeMat(0xe8e4d8));
    skull.position.y = 1.25;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    eyeL.position.set(-0.08, 1.28, 0.16);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.08;
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.1), makeMat(0x9a9aa8, 0.4));
    sword.position.set(0.35, 0.7, 0.1);
    sword.rotation.z = -0.4;
    g.add(body, skull, eyeL, eyeR, sword);
    addShadowBlob(g, 0.4);
  } else if (typeId === 'spider') {
    const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), makeMat(def.color));
    abdomen.position.set(0, 0.35, -0.2);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), makeMat(0x2a2a34));
    head.position.set(0, 0.3, 0.2);
    g.add(abdomen, head);
    for (let i = 0; i < 4; i++) {
      const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 4), makeMat(0x222228));
      legL.position.set(-0.3, 0.28, -0.25 + i * 0.16);
      legL.rotation.z = 0.9;
      const legR = legL.clone(); legR.position.x = 0.3; legR.rotation.z = -0.9;
      g.add(legL, legR);
    }
    const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), new THREE.MeshBasicMaterial({ color: 0x8aff4a }));
    eyes.position.set(0, 0.38, 0.38);
    g.add(eyes);
    addShadowBlob(g, 0.42);
  } else if (typeId === 'imp') {
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.8, 8), makeMat(def.color));
    body.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), makeMat(0xd86a48));
    head.position.y = 1.0;
    const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.2, 5), makeMat(0x3a2a20));
    hornL.position.set(-0.12, 1.16, 0);
    hornL.rotation.z = 0.4;
    const hornR = hornL.clone(); hornR.position.x = 0.12; hornR.rotation.z = -0.4;
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffa03a }));
    orb.position.set(0.3, 0.75, 0.15);
    g.add(body, head, hornL, hornR, orb);
    addShadowBlob(g, 0.35);
  } else { // golem
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.6), makeMat(def.color, 0.95));
    torso.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.4), makeMat(0x6a6a75, 0.95));
    head.position.y = 1.45;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffc03a }));
    eye.position.set(0, 1.45, 0.22);
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.35), makeMat(0x6f6f7a, 0.95));
    armL.position.set(-0.62, 0.8, 0);
    const armR = armL.clone(); armR.position.x = 0.62;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.5), makeMat(0x5a5a64, 0.95));
    legs.position.y = 0.22;
    g.add(torso, head, eye, armL, armR, legs);
    addShadowBlob(g, 0.65);
  }

  g.scale.setScalar(scale);
  if (scale !== 1) {
    // miniboss glow crown
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.04, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd75e })
    );
    crown.rotation.x = Math.PI / 2;
    crown.position.y = (typeId === 'spider' ? 0.6 : 1.6);
    g.add(crown);
  }
  return g;
}

export function buildBossMesh(glow = 0xb35eff) {
  const g = new THREE.Group();
  const dark = makeMat(0x2f2438, 0.9);
  const glowMat = new THREE.MeshBasicMaterial({ color: glow });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.7, 1.1), dark);
  torso.position.y = 1.6;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), makeMat(0x3f3050, 0.9));
  head.position.y = 2.85;
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), glowMat);
  eyeL.position.set(-0.18, 2.9, 0.38);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.18;
  const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 6), dark);
  hornL.position.set(-0.35, 3.4, 0);
  hornL.rotation.z = 0.35;
  const hornR = hornL.clone(); hornR.position.x = 0.35; hornR.rotation.z = -0.35;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 0.6), makeMat(0x3a2c48, 0.9));
  armL.position.set(-1.2, 1.5, 0);
  const armR = armL.clone(); armR.position.x = 1.2;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.9), dark);
  legs.position.y = 0.45;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), glowMat);
  chest.position.set(0, 1.9, 0.58);
  g.add(torso, head, eyeL, eyeR, hornL, hornR, armL, armR, legs, chest);
  addShadowBlob(g, 1.3);
  return g;
}
