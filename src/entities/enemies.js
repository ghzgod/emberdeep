import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { learner } from '../ai/learner.js';
import { attachEnemyModel, bossModelKey, typeModelKey } from './enemyModel.js';

// Distance-tiered animation throttle (mirrors world-of-claudecraft's approach):
// enemies close to the camera update their mixer every frame, mid-range ones
// every 2nd frame, far ones every 6th (or freeze on a static pose once the
// live cap below is exceeded). Keeps a packed floor's total animated-mixer
// cost bounded regardless of how many modeled mobs are on screen.
const ANIM_NEAR_DIST = 14;
const ANIM_MID_DIST = 26;
const MAX_ANIMATED = 18; // concurrently mixer-updated modeled enemies per frame

// Approximate hero mesh half-width (KayKit adventurer rigs), used only for the
// visual stand-off nudge below so a melee mob's real footprint doesn't
// overlap the player mesh at point-blank range. Not a gameplay hitbox.
const PLAYER_BODY_RADIUS = 0.32;

// Per-frame mixer-update budget, shared across every Enemy instance. Reset
// once at the top of each frame's enemy loop (see resetEnemyAnimBudget,
// called from game.js right before it iterates this.enemies) so near-camera
// mobs always get priority and only the overflow beyond MAX_ANIMATED freezes
// on its last pose for that frame instead of mixer.update()-ing.
let _animBudget = MAX_ANIMATED;
export function resetEnemyAnimBudget() { _animBudget = MAX_ANIMATED; }

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
  ghost: {
    name: 'Wraith',
    base: { hp: 30, damage: 13, speed: 4.5, xp: 11, gold: [2, 7] },
    perFloor: { hp: 10, damage: 3.2, xp: 3.5 },
    attack: { kind: 'melee', range: 1.6, cooldown: 1.3, windup: 0.3 },
    aggroRange: 12, radius: 0.4,
    sounds: { hurt: 'imp_hurt', death: 'imp_death' },
    color: 0xbcd0e8,
  },
  ghoul: {
    name: 'Ghoul',
    base: { hp: 26, damage: 10, speed: 5.2, xp: 9, gold: [1, 5] },
    perFloor: { hp: 8, damage: 2.8, xp: 3 },
    attack: { kind: 'melee', range: 1.4, cooldown: 0.9, windup: 0.22 },
    aggroRange: 11, radius: 0.36,
    sounds: { hurt: 'skeleton_hurt', death: 'skeleton_death' },
    color: 0x8a9a6a,
  },
  witch: {
    name: 'Witch',
    base: { hp: 28, damage: 11, speed: 4.2, xp: 13, gold: [3, 9] },
    perFloor: { hp: 9, damage: 3.0, xp: 3.5 },
    attack: { kind: 'ranged', range: 8.5, keepDistance: 6, cooldown: 1.5, windup: 0.4, projSpeed: 12 },
    aggroRange: 12, radius: 0.36,
    sounds: { hurt: 'imp_hurt', death: 'imp_death', shoot: 'imp_shoot' },
    color: 0x2a4a3a,
  },
  warlock: {
    name: 'Warlock',
    base: { hp: 34, damage: 12, speed: 3.6, xp: 15, gold: [4, 10] },
    perFloor: { hp: 11, damage: 3.4, xp: 4 },
    attack: { kind: 'ranged', range: 9, keepDistance: 6.5, cooldown: 1.7, windup: 0.5, projSpeed: 11 },
    aggroRange: 12, radius: 0.38,
    sounds: { hurt: 'imp_hurt', death: 'imp_death', shoot: 'imp_shoot' },
    color: 0x4a3a6a,
  },
  demon: {
    name: 'Demon',
    base: { hp: 70, damage: 20, speed: 3.4, xp: 24, gold: [6, 14] },
    perFloor: { hp: 20, damage: 4.6, xp: 6 },
    attack: { kind: 'melee', range: 1.8, cooldown: 1.4, windup: 0.4 },
    aggroRange: 10, radius: 0.5,
    sounds: { hurt: 'golem_hurt', death: 'golem_death' },
    color: 0x8a2a2a,
  },
};

const MINIBOSS_NAMES = {
  skeleton: 'Gravelord Ossus',
  spider: 'Broodmother Vex',
  imp: 'Pyrelord Snikt',
  golem: 'The Unmoved Colossus',
};

// Ghost ambient moans: very seldom, and never in a chorus. A module-level
// throttle caps how often ANY ghost may moan (across the whole pack), on top
// of each ghost's own long randomized cooldown.
const GHOST_MOAN_RANGE = 14;      // player must be within this many units to hear it
const GHOST_MOAN_GLOBAL_GAP = 12000; // ms; min gap between any two ghost moans
let _lastGhostMoanAt = -Infinity;

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
    // wraiths moan very seldom -- randomized per-ghost cooldown before the
    // first possible moan too, so a pack doesn't all sigh on spawn
    if (typeId === 'ghost') this._moanCd = 25 + Math.random() * 35;

    this.mesh = buildEnemyMesh(typeId, this.miniboss ? 1.5 : this.elite ? 1.3 : 1);
    // Swap the box placeholder for the modeled creature once its (lazily
    // fetched, cached-per-type) GLB resolves. attachEnemyModel mutates
    // this.mesh's children in place, so the group reference above never
    // changes and every existing call site (scene.add, e.mesh.position, ...)
    // keeps working unmodified.
    // Boss (see the subclass below) rebuilds this.mesh itself right after
    // calling super(), so skip the base 'golem' model fetch/attach here: it
    // would just be immediately discarded work, and Boss attaches its own
    // act-specific model instead.
    const modelKey = opts.skipModel ? null : typeModelKey(typeId);
    if (modelKey) {
      // Kick off (or join) the fetch for this type's GLB; swaps into this.mesh
      // in place once resolved. Re-applies elite gilding afterward since the
      // gilding below runs immediately against the (soon-to-be-replaced) box
      // placeholder and attachEnemyModel discards those cloned materials.
      attachEnemyModel(this.mesh, modelKey).then((anim) => {
        if (!anim) return;
        this._modelReady = true;
        if (this.elite) this._applyEliteGilding();
      });
    }
    if (this.elite) this._applyEliteGilding();
  }

  // The floor's one guaranteed elite is GILDED so it's unmistakable: every
  // material tinted toward gold with a warm glow, plus a golden crown. Called
  // once immediately (box placeholder) and again after the modeled GLB swaps
  // in (see the constructor above), since the swap clones fresh materials.
  _applyEliteGilding() {
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
    const crown = this.mesh.children.find((c) => c.name === 'MinibossCrown' || c.geometry?.type === 'TorusGeometry');
    if (crown) crown.material = new THREE.MeshBasicMaterial({ color: 0xffe680 });
  }

  get moveSpeed() {
    let s = this.speed;
    for (const st of this.statuses) if (st.slow) s *= st.slow.mult;
    return s;
  }

  // Visual footprint radius for anti-clipping (separation from other enemies
  // and stand-off from the player), as opposed to this.radius which is the
  // smaller GAMEPLAY hit-circle (untouched, still drives damageEnemy/attack
  // range/collision-with-walls exactly as before). Once a modeled GLB has
  // swapped in, its real measured footprint (enemyModel.js) scaled by the
  // same miniboss/elite multiplier the mesh group itself uses is at least as
  // large as the old box radius for every current type, so two modeled
  // creatures (or a creature and the hero) never visibly interpenetrate even
  // though their much smaller hit-circles would allow it. Falls back to
  // this.radius while the model is still loading (box placeholder).
  get visualRadius() {
    const fp = this.mesh.userData?.footprintRadius;
    if (!fp) return this.radius;
    const meshScale = this.miniboss ? 1.5 : this.elite ? 1.3 : 1;
    return Math.max(this.radius, fp * meshScale);
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

  // Oscillate the registered limbs so the mob visibly walks/flaps rather than
  // gliding. Legs/arms swing hard while chasing, idle otherwise; wings and tails
  // always move. Child rotations are safe (the group's position is copied each
  // frame, its children's rotations are not).
  // Drive limbs from ACTUAL movement, not just the chase state: legs only
  // stride when the body is really translating (no more walking in place),
  // amplitude and frequency scale with speed, eased in and out smoothly.
  // Also drives the modeled-creature AnimationMixer (walk/idle crossfade) when
  // a GLB has swapped in for this enemy; box-gait stays as the fallback path
  // for any type that has no model mapping or whose model hasn't loaded yet.
  _animateGait(dt, speed01 = 0, animDt = dt) {
    const anim = this.mesh.userData?.anim;
    if (anim) {
      anim.setLocomotion(speed01);
      if (animDt > 0) anim.update(animDt);
      return;
    }
    const gait = this.mesh.userData?.gait;
    if (!gait || !gait.length) return;
    if (this._gt === undefined) this._gt = Math.random() * 6;
    this._gaitDrive = (this._gaitDrive ?? 0) + (speed01 - (this._gaitDrive ?? 0)) * Math.min(1, dt * 10);
    const drive = this._gaitDrive;
    this._gt += dt * (3 + drive * 9); // stride frequency rises with speed
    const t = this._gt;
    for (const p of gait) {
      // legs/arms swing only while moving; wings always flap (flight); tails
      // keep a faint idle sway so a standing mob is not utterly frozen.
      if (p.kind === 'leg') p.mesh.rotation.x = p.bx + Math.sin(t + p.phase) * p.amp * drive;
      else if (p.kind === 'arm') p.mesh.rotation.x = p.bx + Math.sin(t + p.phase) * p.amp * drive * 0.85;
      else if (p.kind === 'wing') p.mesh.rotation.z = p.bz + Math.sin(t * 1.9 + p.phase) * p.amp;
      else if (p.kind === 'tail') p.mesh.rotation.x = p.bx + Math.sin(t * 1.2 + p.phase) * p.amp * (0.25 + drive * 0.75);
    }
  }

  update(dt, game) {
    if (this.dead) return;
    const player = game.player;

    this.attackCd = Math.max(0, this.attackCd - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    // real movement since last frame -> gait drive (0..1 of top speed)
    const pxz = this._lastPos || (this._lastPos = { x: this.pos.x, z: this.pos.z });
    const moved = Math.hypot(this.pos.x - pxz.x, this.pos.z - pxz.z);
    pxz.x = this.pos.x; pxz.z = this.pos.z;
    const topSpeed = (this.def?.speed || 2.2) * dt;
    // Distance-tiered mixer throttle for modeled (GLB) enemies only: near the
    // camera every frame, mid-range every 2nd, far every 6th. Box-gait mobs
    // are cheap procedural rotations and stay full-rate regardless (see the
    // animDt=0 skip inside _animateGait, which no-ops the mixer.update call
    // but still advances the walk/idle crossfade state so it doesn't pop).
    let animDt = dt;
    const anim = this.mesh.userData?.anim;
    if (anim) {
      const dCam = Math.hypot(this.pos.x - player.pos.x, this.pos.z - player.pos.z);
      const near = dCam < ANIM_NEAR_DIST;
      const tier = near ? 1 : dCam < ANIM_MID_DIST ? 2 : 6;
      this._animTick = ((this._animTick ?? 0) + 1) % tier;
      const dueThisFrame = this._animTick === 0;
      // Near-camera mobs always get priority; only mid/far tiers spend from
      // the shared per-frame cap, so a packed room never exceeds MAX_ANIMATED
      // live mixer updates regardless of how many modeled mobs are on screen.
      if (dueThisFrame && (near || _animBudget > 0)) {
        if (!near) _animBudget--;
        animDt = dt * tier;
      } else {
        animDt = 0;
      }
      // Eyes-on-you: only for near, alive, non-idle (aggroed) enemies (cheap,
      // and skipped entirely for anything far enough that a head turn would
      // never read anyway; matches the same near-tier gate as the mixer
      // throttle above, so it costs nothing extra on a packed floor). Uses
      // the local player directly (co-op remote targets are handled the same
      // way visually: every client's own camera-near enemies look at ITS
      // local hero, which is the only hero that client renders up close).
      if (near && this.state !== 'idle' && !player.dead) {
        anim.lookAtTarget?.(player.pos.x, player.pos.y + 1.0, player.pos.z);
      }
    }
    this._animateGait(dt, topSpeed > 0 ? Math.min(1, moved / topSpeed) : 0, animDt);
    // Wraiths leave a wispy stream behind them as they drift (self-fading, so
    // it's RAM-bounded via the particle system's own lifetimes).
    if (this.typeId === 'ghost' && this.state === 'chase') {
      this._trailT = (this._trailT || 0) - dt;
      if (this._trailT <= 0) {
        this._trailT = 0.1;
        game.particles.burst(this.pos.x, 0.7 + Math.random() * 0.4, this.pos.z, 2, 0x9ec8f0, { speed: 0.4, life: 0.75, size: 0.18, up: 0.4 });
      }
    }

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

    // Wraiths moan very seldom -- long per-ghost cooldown, plus a global
    // throttle so a pack of ghosts never chorus together.
    if (this.typeId === 'ghost') {
      this._moanCd = (this._moanCd ?? 25 + Math.random() * 35) - dt;
      if (this._moanCd <= 0 && distToPlayer < GHOST_MOAN_RANGE && performance.now() - _lastGhostMoanAt > GHOST_MOAN_GLOBAL_GAP) {
        audio.ghostMoan(undefined, { pos: this.pos, volume: 0.5 });
        _lastGhostMoanAt = performance.now();
        this._moanCd = 25 + Math.random() * 35;
      }
    }

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
        // never wind up on a target sheltering in the portal safe zone
        if (inRange && this.attackCd <= 0 && !game.inSafeZone(tPos)) {
          this.state = 'windup';
          this.stateTimer = atk.windup;
          if (atk.kind === 'slam') audio.play(this.def.sounds.special, { pos: this.pos, volume: 0.6 });
          this.mesh.userData?.anim?.playAttack();
          break;
        }
        // ---- tactical approach: flank to the target's side/rear, dodge their
        // swings, and circle-strafe at range. It reads THIS enemy's own target's
        // facing (so it works per-player in co-op) and adapts to how that hero
        // fights — the learned engagement range is a "kite factor". ----
        const pa = target.local ? (player.aimAngle || 0) : (target.aim || 0);
        const fwdX = Math.cos(pa), fwdZ = Math.sin(pa);   // target's forward
        const perpX = -fwdZ, perpZ = fwdX;                // lateral
        // Seed the flank side by id so a pack SPLITS both ways instead of
        // funneling single file through one doorway (which a mage just AoEs);
        // rare re-picks toward the nearer side avoid dithering.
        if (this._flankSide === undefined) this._flankSide = (this.netId % 2 === 0) ? 1 : -1;
        else if (Math.random() < 0.006) {
          const s = (this.pos.x - tPos.x) * perpX + (this.pos.z - tPos.z) * perpZ;
          this._flankSide = s >= 0 ? 1 : -1;
        }
        const kite = Math.min(1, Math.max(0, ((learner.dangerRange?.() || 2) - 1.6) / 5));
        let dirX, dirZ;
        if (atk.kind === 'ranged') {
          // keep just beyond the learned danger range AND circle-strafe (no sitting duck)
          const learned = learner.dangerRange?.();
          const keep = learned ? Math.max(atk.keepDistance, Math.min(atk.keepDistance + 2.5, learned + 1.5)) : atk.keepDistance;
          let rx = tPos.x - this.pos.x, rz = tPos.z - this.pos.z;
          const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
          if (distToPlayer < keep) { rx = -rx; rz = -rz; }
          dirX = rx * 0.7 + perpX * this._flankSide * 0.7;
          dirZ = rz * 0.7 + perpZ * this._flankSide * 0.7;
        } else {
          // melee: aim for a point on the target's flank/rear, widening with
          // distance and with how much the hero kites, then lead with the predictor
          const flank = Math.min(2.6, distToPlayer * 0.45) * (0.6 + 0.7 * kite);
          let targetX = tPos.x + perpX * this._flankSide * flank - fwdX * flank * 0.45;
          let targetZ = tPos.z + perpZ * this._flankSide * flank - fwdZ * flank * 0.45;
          if (distToPlayer > 3 && target.local) {
            const pred = learner.predict(player);
            if (pred) { const lead = 0.7 + ((this.elite || this.miniboss) ? Math.min(0.5, game.fleeTendency || 0) : 0); targetX += pred.dx * lead; targetZ += pred.dz * lead; }
          }
          dirX = targetX - this.pos.x; dirZ = targetZ - this.pos.z;
          // dodge: if the hero is swinging and we're in their frontal arc, juke aside
          if (target.local && distToPlayer < 3.2 && game.playerIsAttacking?.()) {
            let ang = Math.atan2(this.pos.z - tPos.z, this.pos.x - tPos.x) - pa;
            while (ang > Math.PI) ang -= Math.PI * 2; while (ang < -Math.PI) ang += Math.PI * 2;
            if (Math.abs(ang) < 0.85) { dirX = dirX * 0.25 + perpX * this._flankSide * 1.2; dirZ = dirZ * 0.25 + perpZ * this._flankSide * 1.2; }
          }
        }
        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len; dirZ /= len;
        const spd = this.moveSpeed;
        const step = spd * dt;
        const okAt = (x, z) => game.isWalkable(x, z, this.radius) && !game.inSafeZone({ x, z }, this.radius);
        // walls block movement; the portal safe zone also repels enemies
        let moved = false;
        if (okAt(this.pos.x + dirX * step, this.pos.z)) { this.pos.x += dirX * step; moved = true; }
        if (okAt(this.pos.x, this.pos.z + dirZ * step)) { this.pos.z += dirZ * step; moved = true; }
        // Corner-stuck failsafe: if both axes are blocked, try slipping around by
        // rotating the heading, so a chaser flows around a wall instead of
        // trickling single-file through the one gap it found.
        if (!moved) {
          for (const a of [0.7, -0.7, 1.4, -1.4, 2.3, -2.3]) {
            const c = Math.cos(a), s = Math.sin(a);
            const ax = dirX * c - dirZ * s, az = dirX * s + dirZ * c;
            const tx = this.pos.x + ax * step, tz = this.pos.z + az * step;
            if (okAt(tx, tz)) { this.pos.x = tx; this.pos.z = tz; break; }
          }
        }
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

    // Separation from other enemies (cheap). Uses visualRadius (the modeled
    // mesh's real measured footprint once it has loaded, else the gameplay
    // hit-circle) rather than the raw gameplay radius, so two real creature
    // meshes keep a visible gap instead of clipping through each other the
    // way their smaller hit-circles alone would allow.
    const myVisR = this.visualRadius;
    for (const other of game.enemies) {
      if (other === this || other.dead) continue;
      const dx = this.pos.x - other.pos.x;
      const dz = this.pos.z - other.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = myVisR + (other.visualRadius ?? other.radius);
      if (d > 0.001 && d < minD) {
        const push = (minD - d) * 0.5;
        const nx = this.pos.x + (dx / d) * push;
        const nz = this.pos.z + (dz / d) * push;
        if (game.isWalkable(nx, nz, this.radius)) { this.pos.x = nx; this.pos.z = nz; }
      }
    }

    // Stand-off from the hero: a modeled creature's real footprint can be
    // wider than its gameplay hit-circle, so a mob sitting right at its
    // attack range (a gameplay distance, left untouched above) could still
    // visually overlap the player mesh. Nudge back to the mesh-safe distance
    // ONLY when actually closer than that: never interferes with the
    // approach/flank/attack-range logic above, which already stopped the mob
    // at atk.range; this only catches the cases where flanking math, knockback
    // drift, or a pack squeeze puts it nearer than its own visible silhouette
    // allows. Skipped for ranged attackers (they already keep well back) and
    // while mid-windup/attack (the telegraphed lunge should visually connect).
    if (!target.dead && atk.kind !== 'ranged' && this.state !== 'windup') {
      const standOff = this.visualRadius + PLAYER_BODY_RADIUS;
      if (distToPlayer > 0.001 && distToPlayer < standOff) {
        const push = standOff - distToPlayer;
        const bx = (this.pos.x - tPos.x) / distToPlayer;
        const bz = (this.pos.z - tPos.z) / distToPlayer;
        const nx = this.pos.x + bx * push;
        const nz = this.pos.z + bz * push;
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
    super('golem', floor, { skipModel: true });
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
    // Each act lord gets a distinct, imposing modeled creature (see
    // bossModelKey/enemyModel.js) instead of the shared box boss rig: a big
    // armored skeleton, a spider queen, a fire demon, a stone colossus, and
    // finally a dragon for the Dungeon Lord. Swaps into this.mesh in place,
    // same lazy-load-then-attach pattern as every other enemy type.
    attachEnemyModel(this.mesh, bossModelKey(act), { tint: def.glow, tintStrength: 0.12 })
      .then((anim) => { if (anim) this._modelReady = true; });
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
          // The Dungeon Lord (act 5) alternates its ranged barrage with a
          // fire-breath stream instead of always firing the same barrage:
          // attack variety at the AI-decision level, on top of the modeled
          // creature's own attack-clip variety (see enemyModel.js).
          if (this.act === 5 && Math.random() < 0.5) this.fireBreath(game);
          else this.fireBarrage(game);
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

  // The Dungeon Lord's fire breath: a cone of flame particles aimed at its
  // current target, with damage applied along the same line (a forward-offset
  // hit circle straddling the stream, matching how the existing golem
  // slam/AoE attacks already resolve damage, see game.aoeHitPlayers). Plays
  // one of the dragon rig's own attack clips (Headbutt/Punch, its only two
  // baked one-shots: dragonevolved.glb ships no dedicated cast/breath clip)
  // as the physical cue so the lunge reads as the source of the flame.
  fireBreath(game) {
    const target = game.getNearestTarget(this.pos);
    if (target.dead) return;
    audio.play('golem_slam', { pos: this.pos, rate: 1.4, volume: 0.8 });
    let dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    this.mesh.userData?.anim?.playAttack();
    game.shake(0.25);
    const range = 7.5;
    const steps = 5; // stagger a few bursts along the stream so it animates as a jet, not one static puff
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      game.particles.breath(
        this.pos.x + dx * 0.6, 1.1, this.pos.z + dz * 0.6,
        dx, dz, { range: range * (0.5 + t * 0.5), spread: 0.28 + t * 0.1, count: 16 }
      );
    }
    // Damage: a hit circle straddling the stream partway to its max range,
    // anyone standing in the flame's path (not just at its exact tip) takes
    // it, mirroring the golem slam's simple radius-at-a-point resolution.
    const hitX = this.pos.x + dx * range * 0.5;
    const hitZ = this.pos.z + dz * range * 0.5;
    game.aoeHitPlayers(hitX, hitZ, range * 0.5 + 0.8, this.damage * 0.75);
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

  // Limbs registered here are oscillated by Enemy._animateGait so mobs actually
  // walk/flap instead of gliding. Each entry remembers its base rotation.
  const gait = [];
  const reg = (mesh, kind, phase = 0, amp = 0.3) =>
    gait.push({ mesh, kind, phase, amp, bx: mesh.rotation.x, bz: mesh.rotation.z });

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
    reg(legLU, 'leg', 0, 0.42); reg(legLL, 'leg', 0.3, 0.34);
    reg(legRU, 'leg', Math.PI, 0.42); reg(legRL, 'leg', Math.PI + 0.3, 0.34);
    reg(armLU, 'arm', Math.PI, 0.28); reg(armLL, 'arm', Math.PI + 0.2, 0.2);
    reg(armRU, 'arm', 0, 0.28); reg(armRL, 'arm', 0.2, 0.2);
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
        // alternating tetrapod gait: neighbouring legs step out of phase
        const ph = i * 0.9 + (dir < 0 ? 0 : Math.PI);
        reg(hip, 'leg', ph, 0.22); reg(shin, 'leg', ph + 0.5, 0.3);
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
    reg(wingL, 'wing', 0, 0.45); reg(wingR, 'wing', Math.PI, 0.45); // symmetric flap
    reg(armL, 'arm', Math.PI, 0.22); reg(armR, 'arm', 0, 0.22);
    reg(tailA, 'tail', 0, 0.25); reg(tailB, 'tail', 0.6, 0.32);
    g.add(body, head, hornL, hornR, eyeL, eyeR, wingL, wingR, armL, armR, tailA, tailB, orb, orbGlow);
    addShadowBlob(g, 0.35);
  } else if (typeId === 'ghost') {
    // A floating wraith — translucent hooded body over a tattered shroud, with
    // glowing eyes and wispy arms. No ground shadow (it hovers).
    const ghostMat = new THREE.MeshStandardMaterial({ color: def.color, transparent: true, opacity: 0.5, roughness: 1, emissive: 0x3a5a8a, emissiveIntensity: 0.35, depthWrite: false });
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.5, 8), ghostMat);
    hood.position.y = 1.18;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 9, 8), ghostMat);
    head.position.y = 1.06;
    const shroud = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.95, 8, 1, true), ghostMat);
    shroud.position.y = 0.62;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8ad0ff });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), eyeMat);
    eyeL.position.set(-0.06, 1.08, 0.14);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.06;
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.01, 0.36, 5), ghostMat);
    armL.position.set(-0.24, 0.92, 0.05); armL.rotation.z = 0.7;
    const armR = armL.clone(); armR.position.x = 0.24; armR.rotation.z = -0.7;
    g.add(hood, head, shroud, eyeL, eyeR, armL, armR);
    reg(armL, 'arm', 0, 0.32); reg(armR, 'arm', Math.PI, 0.32);
    reg(shroud, 'tail', 0, 0.12);
  } else if (typeId === 'ghoul') {
    // A gaunt, hunched undead — long clawed arms, heavy jaw, spindly legs.
    const flesh = def.color;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.4, 4, 7), makeMat(flesh, 0.9));
    body.position.y = 0.62; body.rotation.x = 0.35; // hunched
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), makeMat(0x9aaa78));
    head.position.set(0, 0.98, 0.16); head.scale.set(1, 0.9, 1.1);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.13), makeMat(0x7a8a5a));
    jaw.position.set(0, 0.9, 0.24);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xf0e060 });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 6), eyeMat); eyeL.position.set(-0.05, 1.0, 0.27);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.05;
    const armL = limbSeg(0.04, 0.03, 0.36, flesh); armL.position.set(-0.22, 0.66, 0.1); armL.rotation.set(0.5, 0, 0.5);
    const armR = armL.clone(); armR.position.x = 0.22; armR.rotation.z = -0.5;
    const legL = limbSeg(0.045, 0.03, 0.34, flesh); legL.position.set(-0.1, 0.28, 0);
    const legR = legL.clone(); legR.position.x = 0.1;
    g.add(body, head, jaw, eyeL, eyeR, armL, armR, legL, legR);
    reg(legL, 'leg', 0, 0.45); reg(legR, 'leg', Math.PI, 0.45);
    reg(armL, 'arm', Math.PI, 0.3); reg(armR, 'arm', 0, 0.3);
    addShadowBlob(g, 0.36);
  } else if (typeId === 'witch') {
    // A hag in a pointed hat with a wand; robe hides the feet, so she glides.
    const robeMat = makeMat(def.color, 0.9);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.85, 8), robeMat); body.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), makeMat(0x9ab080)); head.position.y = 0.98;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.14, 5), makeMat(0x9ab080)); nose.position.set(0, 0.97, 0.16); nose.rotation.x = Math.PI / 2;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.03, 12), makeMat(0x1a1420)); brim.position.y = 1.1;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 10), makeMat(0x1a1420)); cone.position.y = 1.35; cone.rotation.z = 0.15;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8aff6a });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), eyeMat); eyeL.position.set(-0.05, 1.0, 0.13);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.05;
    const armL = limbSeg(0.04, 0.03, 0.28, def.color); armL.position.set(-0.18, 0.66, 0.08); armL.rotation.z = 0.6;
    const armR = armL.clone(); armR.position.set(0.22, 0.72, 0.12); armR.rotation.z = -0.8;
    const wand = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.4, 5), makeMat(0x3a2a1a)); wand.position.set(0.34, 0.9, 0.14); wand.rotation.z = -0.9;
    g.add(body, head, nose, brim, cone, eyeL, eyeR, armL, armR, wand);
    reg(armR, 'arm', 0, 0.2); reg(cone, 'tail', 0, 0.05);
    addShadowBlob(g, 0.38);
  } else if (typeId === 'warlock') {
    // Robed dark caster with a hood and a glowing staff orb.
    const robeMat = makeMat(def.color, 0.9);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.95, 8), robeMat); body.position.y = 0.55;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.35, 8), robeMat); hood.position.y = 1.1;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), makeMat(0x6a5a4a)); head.position.set(0, 1.0, 0.08);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xb060ff });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), eyeMat); eyeL.position.set(-0.05, 1.02, 0.16);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.05;
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6), makeMat(0x3a2a1a)); staff.position.set(0.3, 0.7, 0.1);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), new THREE.MeshBasicMaterial({ color: 0xb060ff })); orb.position.set(0.3, 1.28, 0.1);
    const orbGlow = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0xb060ff, transparent: true, opacity: 0.3 })); orbGlow.position.copy(orb.position);
    const armL = limbSeg(0.05, 0.04, 0.3, def.color); armL.position.set(-0.2, 0.7, 0.08); armL.rotation.z = 0.6;
    const armR = armL.clone(); armR.position.set(0.24, 0.78, 0.1); armR.rotation.z = -0.7;
    g.add(body, hood, head, eyeL, eyeR, staff, orb, orbGlow, armL, armR);
    reg(armL, 'arm', 0, 0.18); reg(armR, 'arm', Math.PI, 0.15);
    addShadowBlob(g, 0.4);
  } else if (typeId === 'demon') {
    // A horned, muscular bruiser with a lashing tail.
    const skin = def.color;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 5, 8), makeMat(skin, 0.85)); body.position.y = 0.78;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.35), makeMat(0x9a3030, 0.85)); chest.position.set(0, 0.95, 0.05);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 9, 8), makeMat(0x7a2020)); head.position.y = 1.4;
    const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 6), makeMat(0x2a1010)); hornL.position.set(-0.12, 1.55, 0); hornL.rotation.z = 0.5;
    const hornR = hornL.clone(); hornR.position.x = 0.12; hornR.rotation.z = -0.5;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd020 });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat); eyeL.position.set(-0.07, 1.42, 0.17);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.07;
    const armL = limbSeg(0.07, 0.05, 0.42, skin); armL.position.set(-0.34, 0.85, 0.05); armL.rotation.z = 0.4;
    const armR = armL.clone(); armR.position.x = 0.34; armR.rotation.z = -0.4;
    const legL = limbSeg(0.09, 0.06, 0.4, skin); legL.position.set(-0.14, 0.3, 0);
    const legR = legL.clone(); legR.position.x = 0.14;
    const tail = limbSeg(0.05, 0.02, 0.5, skin); tail.position.set(0, 0.5, -0.28); tail.rotation.x = -0.8;
    g.add(body, chest, head, hornL, hornR, eyeL, eyeR, armL, armR, legL, legR, tail);
    reg(legL, 'leg', 0, 0.4); reg(legR, 'leg', Math.PI, 0.4);
    reg(armL, 'arm', Math.PI, 0.35); reg(armR, 'arm', 0, 0.35);
    reg(tail, 'tail', 0, 0.3);
    addShadowBlob(g, 0.5);
  } else { // golem — a craggy stone brute, not a stack of boxes
    const rockMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true });
    const rock = def.color;
    // boulder torso: two overlapping craggy masses
    const torso = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), rockMat(rock));
    torso.position.y = 0.98; torso.scale.set(1.05, 1.15, 0.9); torso.rotation.y = 0.4;
    const belly = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), rockMat(0x6f6a63));
    belly.position.set(0.03, 0.58, 0.02); belly.scale.set(1.1, 0.9, 0.95); belly.rotation.y = 0.9;
    // hunched craggy shoulders
    const shoulderL = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), rockMat(0x6f6a63));
    shoulderL.position.set(-0.55, 1.26, 0); shoulderL.rotation.set(0.3, 0.4, 0);
    const shoulderR = shoulderL.clone(); shoulderR.position.x = 0.55; shoulderR.rotation.y = -0.4;
    // rounded head with a heavy brow + glowing eye
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), rockMat(0x5f5b56));
    head.position.set(0, 1.5, 0.04); head.scale.set(1, 0.85, 1);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.12), rockMat(0x4f4b47));
    brow.position.set(0, 1.56, 0.16); brow.rotation.x = 0.25;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffc03a }));
    eye.position.set(0, 1.46, 0.18);
    // molten core glowing between the chest slabs
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a }));
    core.position.set(0, 0.92, 0.24);
    const coreGlow = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.3 }));
    coreGlow.position.copy(core.position);
    const seamMat = new THREE.MeshBasicMaterial({ color: 0xff9a2a });
    const seam1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.32, 0.03), seamMat); seam1.position.set(-0.18, 0.9, 0.34); seam1.rotation.z = 0.4;
    const seam2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.03), seamMat); seam2.position.set(0.22, 1.12, 0.32); seam2.rotation.z = -0.3;
    // thick tapered arms ending in boulder fists
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.6, 6), rockMat(0x6a655e));
    armL.position.set(-0.6, 0.9, 0.03); armL.rotation.z = 0.12;
    const armR = armL.clone(); armR.position.x = 0.6; armR.rotation.z = -0.12;
    const fistL = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), rockMat(0x545049)); fistL.position.set(-0.63, 0.5, 0.04);
    const fistR = fistL.clone(); fistR.position.x = 0.63;
    // stout stone legs (now a proper walk cycle)
    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 0.44, 6), rockMat(0x565248)); legL.position.set(-0.2, 0.22, 0);
    const legR = legL.clone(); legR.position.x = 0.2;
    reg(legL, 'leg', 0, 0.28); reg(legR, 'leg', Math.PI, 0.28);
    reg(armL, 'arm', 0, 0.22); reg(armR, 'arm', Math.PI, 0.22);
    reg(fistL, 'arm', 0, 0.18); reg(fistR, 'arm', Math.PI, 0.18);
    g.add(torso, belly, shoulderL, shoulderR, head, brow, eye, core, coreGlow, seam1, seam2, armL, armR, fistL, fistR, legL, legR);
    addShadowBlob(g, 0.65);
  }

  g.userData.gait = gait;
  g.scale.setScalar(scale);
  if (scale !== 1) {
    // miniboss glow crown, named + kept out of userData.gait so attachEnemyModel
    // (enemyModel.js) can find it, leave it parented through the box->model swap,
    // and reposition it above the modeled creature's real height instead of the
    // box mesh's assumed one.
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.04, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd75e })
    );
    crown.name = 'MinibossCrown';
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

  // Same limb-registration pattern the per-type mobs use so Enemy._animateGait
  // strides the boss instead of letting it slide rigidly.
  const gait = [];
  const reg = (mesh, kind, phase = 0, amp = 0.3) =>
    gait.push({ mesh, kind, phase, amp, bx: mesh.rotation.x, bz: mesh.rotation.z });

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
  // Split legs (was one block) so a left/right walk cycle reads when it strides.
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.9), dark);
  legL.position.set(-0.34, 0.45, 0);
  const legR = legL.clone(); legR.position.x = 0.34;
  // glowing chest core (layered for depth)
  const chestCore = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), glowMat);
  chestCore.position.set(0, 1.9, 0.58);
  const chestRing = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.03, 6, 14), glowMat);
  chestRing.position.copy(chestCore.position);

  g.add(cloak, cloak2, torso, head, eyeL, eyeR, hornL, hornR, hornCL, hornCR,
    pauldronL, pauldronR, armL, armR, gauntletL, gauntletR, clawsL, clawsR,
    legL, legR, chestCore, chestRing);
  // legs stride out of phase; arms + gauntlets counter-swing (small amp so the
  // hulking silhouette lumbers rather than jogs). Gauntlets share their arm's
  // phase so the whole limb swings as one.
  reg(legL, 'leg', 0, 0.32); reg(legR, 'leg', Math.PI, 0.32);
  reg(armL, 'arm', Math.PI, 0.24); reg(armR, 'arm', 0, 0.24);
  reg(gauntletL, 'arm', Math.PI, 0.2); reg(gauntletR, 'arm', 0, 0.2);
  g.userData.gait = gait;
  // boss is noticeably larger than a golem — scale whole rig up
  g.scale.setScalar(1.35);
  addShadowBlob(g, 1.5);
  return g;
}
