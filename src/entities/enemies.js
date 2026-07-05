import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { learner } from '../ai/learner.js';

// Enemy archetypes. Stats scale with dungeon floor.
export const ENEMY_TYPES = {
  skeleton: {
    name: 'Skeleton',
    base: { hp: 38, damage: 12, speed: 3.6, xp: 10, gold: [2, 6] },
    perFloor: { hp: 13, damage: 3.4, xp: 3.5 },
    attack: { kind: 'melee', range: 1.5, cooldown: 1.1, windup: 0.32 },
    aggroRange: 10, radius: 0.4,
    sounds: { hurt: 'skeleton_hurt', death: 'skeleton_death' },
    color: 0xd8d4c8,
  },
  spider: {
    name: 'Cave Spider',
    base: { hp: 24, damage: 8, speed: 5.6, xp: 8, gold: [1, 4] },
    perFloor: { hp: 9, damage: 2.6, xp: 3 },
    attack: { kind: 'melee', range: 1.3, cooldown: 0.85, windup: 0.18 },
    aggroRange: 11, radius: 0.35,
    sounds: { hurt: 'spider_hurt', death: 'spider_death' },
    color: 0x3a3a44,
  },
  imp: {
    name: 'Imp',
    base: { hp: 28, damage: 11, speed: 4.1, xp: 12, gold: [3, 8] },
    perFloor: { hp: 11, damage: 3.1, xp: 3.5 },
    attack: { kind: 'ranged', range: 9, keepDistance: 6, cooldown: 1.6, windup: 0.45, projSpeed: 11 },
    aggroRange: 12, radius: 0.35,
    sounds: { hurt: 'imp_hurt', death: 'imp_death', shoot: 'imp_shoot' },
    color: 0xc85a3a,
  },
  golem: {
    name: 'Stone Golem',
    base: { hp: 105, damage: 24, speed: 2.3, xp: 22, gold: [6, 14] },
    perFloor: { hp: 27, damage: 5.4, xp: 6 },
    attack: { kind: 'slam', range: 2.0, aoe: 2.7, cooldown: 2.0, windup: 0.65 },
    aggroRange: 9, radius: 0.6,
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
      hp *= 4.0; damage *= 1.8; this.xp = Math.round(this.xp * 4);
      this.radius *= 1.4;
      this.name = MINIBOSS_NAMES[typeId] || 'Champion';
    } else if (this.elite) {
      hp *= 2.6; damage *= 1.5; this.xp = Math.round(this.xp * 2.5);
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

    this.mesh = buildEnemyMesh(typeId, this.miniboss ? 1.5 : this.elite ? 1.3 : 1);
    if (this.elite) {
      // The floor's one guaranteed elite is GILDED so it's unmistakable — every
      // material tinted toward gold with a warm glow, plus a golden crown.
      const gold = new THREE.Color(0xffd24a);
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.color) {
          o.material = o.material.clone();
          o.material.color.lerp(gold, 0.55);
          if ('emissive' in o.material) {
            o.material.emissive = new THREE.Color(0xffa51e);
            o.material.emissiveIntensity = 0.35;
          }
        }
      });
      const crown = this.mesh.children.find((c) => c.geometry?.type === 'TorusGeometry');
      if (crown) crown.material = new THREE.MeshBasicMaterial({ color: 0xffe680 });
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
          if (pred) {
            // elites lean into interception harder the more the hero flees
            const lead = 0.7 + (this.elite || this.miniboss ? Math.min(0.5, game.fleeTendency || 0) : 0);
            targetX += pred.dx * lead; targetZ += pred.dz * lead;
          }
        }
        let dirX = targetX - this.pos.x;
        let dirZ = targetZ - this.pos.z;
        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len; dirZ /= len;
        if (atk.keepDistance && distToPlayer < atk.keepDistance) { dirX = -dirX; dirZ = -dirZ; }
        const spd = this.moveSpeed;
        const nx = this.pos.x + dirX * spd * dt;
        const nz = this.pos.z + dirZ * spd * dt;
        // walls block movement; the portal safe zone also repels enemies
        if (game.isWalkable(nx, this.pos.z, this.radius) && !game.inSafeZone({ x: nx, z: this.pos.z }, this.radius)) this.pos.x = nx;
        if (game.isWalkable(this.pos.x, nz, this.radius) && !game.inSafeZone({ x: this.pos.x, z: nz }, this.radius)) this.pos.z = nz;
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
    this.maxHp = 560 + act * 620 + floor * 28;
    this.hp = this.maxHp;
    this.damage = 18 + act * 7;
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

function limbSeg(radiusTop, radiusBottom, length, color, radialSegs = 5) {
  return new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, radialSegs), makeMat(color));
}

export function buildEnemyMesh(typeId, scale = 1) {
  const g = new THREE.Group();
  const def = ENEMY_TYPES[typeId];

  if (typeId === 'skeleton') {
    const bone = def.color;
    // pelvis + spine
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.16), makeMat(bone));
    pelvis.position.y = 0.62;
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.42, 5), makeMat(bone));
    spine.position.y = 0.86;
    // ribcage: a few curved struts via thin torus slices
    const ribGeo = new THREE.TorusGeometry(0.16, 0.018, 4, 8, Math.PI * 1.1);
    const rib1 = new THREE.Mesh(ribGeo, makeMat(bone));
    rib1.position.set(0, 0.98, -0.02); rib1.rotation.set(Math.PI / 2, 0, Math.PI * 0.45);
    const rib2 = rib1.clone(); rib2.position.y = 0.86;
    const rib3 = rib1.clone(); rib3.position.y = 0.74; rib3.scale.setScalar(0.9);
    // skull with jaw + eye sockets
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), makeMat(0xe8e4d8));
    skull.position.y = 1.18; skull.scale.set(0.9, 1, 1.05);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.14), makeMat(0xd8d4c4));
    jaw.position.set(0, 1.06, 0.05);
    const socketMat = new THREE.MeshBasicMaterial({ color: 0x1a1410 });
    const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), socketMat);
    socketL.position.set(-0.06, 1.19, 0.13);
    const socketR = socketL.clone(); socketR.position.x = 0.06;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 5, 5), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
    eyeL.position.set(-0.06, 1.19, 0.16);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.06;
    // arms: shoulder->forearm bone segments, hunched
    const armLU = limbSeg(0.035, 0.03, 0.28, bone);
    armLU.position.set(-0.22, 0.9, 0.04); armLU.rotation.set(0.3, 0, 0.5);
    const armLL = limbSeg(0.028, 0.024, 0.24, bone);
    armLL.position.set(-0.34, 0.68, 0.14); armLL.rotation.set(0.4, 0, 0.35);
    const armRU = armLU.clone(); armRU.position.x = 0.22; armRU.rotation.z = -0.5;
    const armRL = armLL.clone(); armRL.position.x = 0.34; armRL.rotation.z = -0.35;
    // legs: thigh + shin bones
    const legLU = limbSeg(0.04, 0.035, 0.3, bone);
    legLU.position.set(-0.09, 0.44, 0);
    const legLL = limbSeg(0.032, 0.026, 0.28, bone);
    legLL.position.set(-0.09, 0.16, 0.02); legLL.rotation.x = 0.1;
    const legRU = legLU.clone(); legRU.position.x = 0.09;
    const legRL = legLL.clone(); legRL.position.x = 0.09;
    // chipped sword + small shield
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.55, 0.08), makeMat(0x9a9aa8, 0.4));
    sword.position.set(0.42, 0.78, 0.12); sword.rotation.z = -0.35;
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 6), makeMat(0x6a5a3a, 0.6));
    shield.position.set(-0.4, 0.82, 0.06); shield.rotation.x = Math.PI / 2; shield.rotation.z = 0.2;
    g.add(pelvis, spine, rib1, rib2, rib3, skull, jaw, socketL, socketR, eyeL, eyeR,
      armLU, armLL, armRU, armRL, legLU, legLL, legRU, legRL, sword, shield);
    addShadowBlob(g, 0.4);
  } else if (typeId === 'spider') {
    const chitin = def.color;
    const cephalothorax = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 7), makeMat(chitin));
    cephalothorax.position.set(0, 0.28, 0.2); cephalothorax.scale.set(1, 0.85, 1.1);
    const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.3, 9, 8), makeMat(chitin));
    abdomen.position.set(0, 0.32, -0.22); abdomen.scale.set(1, 0.95, 1.25);
    // marking stripe on abdomen
    const marking = new THREE.Mesh(new THREE.SphereGeometry(0.31, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.35), makeMat(0x8a2a2a, 0.7));
    marking.position.copy(abdomen.position); marking.scale.copy(abdomen.scale);
    marking.rotation.x = Math.PI;
    // chelicerae/fangs
    const fangMat = makeMat(0x1a1a1e, 0.5);
    const fangL = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.14, 5), fangMat);
    fangL.position.set(-0.06, 0.2, 0.36); fangL.rotation.x = Math.PI * 0.55;
    const fangR = fangL.clone(); fangR.position.x = 0.06;
    // eye cluster
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8aff4a });
    const eyes = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.028, 5, 5), eyeMat);
      const a = (i - 2.5) * 0.11;
      e.position.set(a, 0.34 + (i % 2) * 0.02, 0.38);
      eyes.add(e);
    }
    g.add(cephalothorax, abdomen, marking, fangL, fangR, eyes);
    // 8 articulated legs: hip -> knee -> tip, two segments each via cylinders
    const legColor = 0x18181c;
    for (let i = 0; i < 4; i++) {
      const side = -0.16 - i * 0.05;
      const zOff = 0.22 - i * 0.16;
      for (const dir of [-1, 1]) {
        const hip = limbSeg(0.028, 0.022, 0.34, legColor);
        hip.position.set(dir * (0.18 + i * 0.02), 0.3, zOff);
        hip.rotation.set(0.15, 0, dir * (0.85 + i * 0.05));
        const shin = limbSeg(0.02, 0.012, 0.32, legColor);
        shin.position.set(dir * (0.4 + i * 0.05), 0.1, zOff - 0.06);
        shin.rotation.set(0.5, 0, dir * 0.5);
        g.add(hip, shin);
      }
    }
    addShadowBlob(g, 0.45);
  } else if (typeId === 'imp') {
    const skin = def.color;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 4, 7), makeMat(skin));
    body.position.y = 0.55; body.rotation.x = 0.15; // hunched lean
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), makeMat(0xd86a48));
    head.position.set(0, 0.98, 0.06);
    const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.18, 5), makeMat(0x2a1a14));
    hornL.position.set(-0.1, 1.12, 0.02); hornL.rotation.z = 0.4;
    const hornR = hornL.clone(); hornR.position.x = 0.1; hornR.rotation.z = -0.4;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffa028 });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), eyeMat);
    eyeL.position.set(-0.06, 1.0, 0.19);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.06;
    // membranous bat wings: thin cone/plane fans
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x5a1a2a, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    const wingL = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.06, 4, 1, true), wingMat);
    wingL.position.set(-0.28, 0.72, -0.14); wingL.rotation.set(0, 0, -1.15); wingL.scale.set(1, 2.2, 0.35);
    const wingR = wingL.clone(); wingR.position.x = 0.28; wingR.rotation.z = 1.15; wingR.scale.x = 1;
    // clawed arms
    const armL = limbSeg(0.03, 0.024, 0.26, skin);
    armL.position.set(-0.22, 0.6, 0.08); armL.rotation.set(0.2, 0, 0.6);
    const armR = armL.clone(); armR.position.x = 0.22; armR.rotation.z = -0.6;
    // whipping tail: two segments curving back
    const tailA = limbSeg(0.035, 0.024, 0.3, skin);
    tailA.position.set(0, 0.4, -0.2); tailA.rotation.x = -0.9;
    const tailB = limbSeg(0.024, 0.012, 0.26, skin);
    tailB.position.set(0, 0.28, -0.42); tailB.rotation.x = -1.7;
    // floating fireball
    const orbMat = new THREE.MeshBasicMaterial({ color: 0xffa03a });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 7, 7), orbMat);
    orb.position.set(0.32, 0.7, 0.2);
    const orbGlow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.35 }));
    orbGlow.position.copy(orb.position);
    g.add(body, head, hornL, hornR, eyeL, eyeR, wingL, wingR, armL, armR, tailA, tailB, orb, orbGlow);
    addShadowBlob(g, 0.35);
  } else { // golem
    const rock = def.color;
    // layered stone slabs of varied size for torso
    const slabLow = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.55), makeMat(rock, 0.95));
    slabLow.position.y = 0.58;
    const slabMid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.62), makeMat(0x767068, 0.95));
    slabMid.position.set(0.02, 0.95, -0.02); slabMid.rotation.y = 0.05;
    const slabUp = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.5), makeMat(rock, 0.95));
    slabUp.position.set(-0.02, 1.28, 0.02); slabUp.rotation.y = -0.04;
    // shoulders, bulky
    const shoulderL = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.5), makeMat(0x6f6a63, 0.95));
    shoulderL.position.set(-0.58, 1.28, 0);
    const shoulderR = shoulderL.clone(); shoulderR.position.x = 0.58;
    // head sunk between shoulders
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.34), makeMat(0x5f5b56, 0.95));
    head.position.y = 1.5;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffc03a }));
    eye.position.set(0, 1.5, 0.19);
    // cracked glowing seams: thin emissive strips
    const seamMat = new THREE.MeshBasicMaterial({ color: 0xff9a2a });
    const seam1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.35, 0.03), seamMat);
    seam1.position.set(-0.15, 0.85, 0.29); seam1.rotation.z = 0.3;
    const seam2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), seamMat);
    seam2.position.set(0.2, 1.15, 0.32); seam2.rotation.z = -0.25;
    // heavy fists
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.55, 0.32), makeMat(0x6a655e, 0.95));
    armL.position.set(-0.62, 0.85, 0.02);
    const armR = armL.clone(); armR.position.x = 0.62;
    const fistL = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.36), makeMat(0x545049, 0.95));
    fistL.position.set(-0.63, 0.52, 0.04);
    const fistR = fistL.clone(); fistR.position.x = 0.63;
    // legs
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.42, 0.48), makeMat(0x565248, 0.95));
    legs.position.y = 0.21;
    g.add(slabLow, slabMid, slabUp, shoulderL, shoulderR, head, eye, seam1, seam2,
      armL, armR, fistL, fistR, legs);
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
  const cloakMat = new THREE.MeshStandardMaterial({ color: 0x1c1526, roughness: 0.85, side: THREE.DoubleSide });
  const glowMat = new THREE.MeshBasicMaterial({ color: glow });

  // tattered cloak silhouette behind torso (wide cone, jagged via low radial segs)
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(1.15, 2.6, 7, 1, true), cloakMat);
  cloak.position.set(0, 1.4, -0.35); cloak.rotation.x = Math.PI;
  const cloak2 = new THREE.Mesh(new THREE.ConeGeometry(0.85, 2.0, 6, 1, true), cloakMat);
  cloak2.position.set(0, 1.1, -0.5); cloak2.rotation.x = Math.PI;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.7, 1.1), dark);
  torso.position.y = 1.6;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), makeMat(0x3f3050, 0.9));
  head.position.y = 2.85;
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), glowMat);
  eyeL.position.set(-0.18, 2.9, 0.38);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.18;
  // crown of horns: center pair + two smaller flanking horns
  const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 6), dark);
  hornL.position.set(-0.35, 3.4, 0);
  hornL.rotation.z = 0.35;
  const hornR = hornL.clone(); hornR.position.x = 0.35; hornR.rotation.z = -0.35;
  const hornCL = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.4, 5), dark);
  hornCL.position.set(-0.14, 3.25, -0.05); hornCL.rotation.z = 0.15;
  const hornCR = hornCL.clone(); hornCR.position.x = 0.14; hornCR.rotation.z = -0.15;
  // big pauldrons
  const pauldronL = new THREE.Mesh(new THREE.SphereGeometry(0.38, 8, 7, 0, Math.PI * 2, 0, Math.PI * 0.6), dark);
  pauldronL.position.set(-1.05, 2.35, 0); pauldronL.rotation.z = Math.PI;
  const pauldronR = pauldronL.clone(); pauldronR.position.x = 1.05;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 0.6), makeMat(0x3a2c48, 0.9));
  armL.position.set(-1.2, 1.5, 0);
  const armR = armL.clone(); armR.position.x = 1.2;
  // clawed gauntlets
  const gauntletL = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.46), makeMat(0x50405c, 0.9));
  gauntletL.position.set(-1.2, 0.6, 0.06);
  const gauntletR = gauntletL.clone(); gauntletR.position.x = 1.2;
  const clawMat = makeMat(0xd8d0c8, 0.4);
  const clawGeo = new THREE.ConeGeometry(0.03, 0.16, 4);
  const clawsL = new THREE.Group();
  for (let i = -1; i <= 1; i++) {
    const c = new THREE.Mesh(clawGeo, clawMat);
    c.position.set(-1.2 + i * 0.1, 0.44, 0.24); c.rotation.x = 1.6;
    clawsL.add(c);
  }
  const clawsR = clawsL.clone(); clawsR.position.x = 2.4;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.9), dark);
  legs.position.y = 0.45;
  // glowing chest core (layered for depth)
  const chestCore = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), glowMat);
  chestCore.position.set(0, 1.9, 0.58);
  const chestRing = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.03, 6, 14), glowMat);
  chestRing.position.copy(chestCore.position);

  g.add(cloak, cloak2, torso, head, eyeL, eyeR, hornL, hornR, hornCL, hornCR,
    pauldronL, pauldronR, armL, armR, gauntletL, gauntletR, clawsL, clawsR,
    legs, chestCore, chestRing);
  // boss is noticeably larger than a golem — scale whole rig up
  g.scale.setScalar(1.35);
  addShadowBlob(g, 1.5);
  return g;
}
