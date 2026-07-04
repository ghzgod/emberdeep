import * as THREE from 'three';
import { CLASSES, buildHeroMesh } from './classes.js';
import { buildAnimatedHero } from './heroModel.js';
import { audio } from '../core/audio.js';

export function xpForLevel(level) {
  return Math.floor(80 * Math.pow(level, 1.4));
}

export class Player {
  constructor(classId) {
    this.classDef = CLASSES[classId];
    this.classId = classId;
    this.level = 1;
    this.xp = 0;
    this.gold = 0;
    this.potions = 2;
    this.inventory = [];     // gear items
    this.invSize = 12;       // expandable via rare bag drops, max 24
    this.equipped = { weapon: null, armor: null, trinket: null };

    this.pos = new THREE.Vector3();
    this.aimAngle = 0;
    this.aimDir = { x: 1, z: 0 };
    this.cursor = { x: 0, z: 0 };   // actual mouse point on the ground plane
    this.moveDir = { x: 0, z: 0 };

    this.buffs = [];
    this.statuses = [];      // debuffs on the player (slow etc.)
    this.dash = null;
    this.spinTimer = 0;
    this.attackCd = 0;
    this.abilityCds = [0, 0, 0, 0];
    this.footstepTimer = 0;
    this.attackAnim = 0;
    this.dead = false;
    this.invulnTimer = 0;

    this.recompute();
    this.hp = this.maxHp;
    this.resource = this.maxResource;

    // Prefer the animated KayKit model; fall back to primitives if it failed to load.
    this.anim = buildAnimatedHero(classId);
    this.mesh = this.anim ? this.anim.mesh : buildHeroMesh(this.classDef);
  }

  // ---- derived stats: class base + level growth + gear ----
  recompute() {
    const s = this.classDef.stats;
    const lvl = this.level - 1;
    let maxHp = s.maxHp + lvl * 14;
    let damage = s.damage + lvl * 2.4;
    let speed = s.speed;
    let armor = s.armor;
    let crit = s.crit;
    let maxResource = this.classDef.resource.max + lvl * 6;
    let regen = this.classDef.resource.regen + lvl * 0.6;

    for (const item of Object.values(this.equipped)) {
      if (!item) continue;
      for (const [stat, val] of Object.entries(item.stats)) {
        if (stat === 'damagePct') damage *= 1 + val / 100;
        else if (stat === 'maxHp') maxHp += val;
        else if (stat === 'armor') armor += val / 100;
        else if (stat === 'crit') crit += val / 100;
        else if (stat === 'speed') speed *= 1 + val / 100;
        else if (stat === 'regen') regen += val;
      }
    }

    this.maxHp = Math.round(maxHp);
    this.baseDamage = damage;
    this.speed = speed;
    this.armor = Math.min(0.75, armor);
    this.crit = Math.min(0.6, crit);
    this.maxResource = Math.round(maxResource);
    this.resourceRegen = regen;
    if (this.hp !== undefined) this.hp = Math.min(this.hp, this.maxHp);
    if (this.resource !== undefined) this.resource = Math.min(this.resource, this.maxResource);
  }

  get damage() {
    let d = this.baseDamage;
    for (const b of this.buffs) if (b.damageMult) d *= b.damageMult;
    return d;
  }

  get moveSpeed() {
    let s = this.speed;
    for (const st of this.statuses) if (st.slow) s *= st.slow.mult;
    return s;
  }

  addBuff(buff) {
    this.buffs = this.buffs.filter((b) => b.id !== buff.id);
    this.buffs.push({ ...buff, t: buff.duration });
  }

  addStatus(status) {
    this.statuses.push({ ...status, t: status.duration ?? status.slow?.duration ?? 2 });
  }

  startDash(speed, duration, opts = {}) {
    const dir = (this.moveDir.x || this.moveDir.z)
      ? { ...this.moveDir }
      : { ...this.aimDir };
    this.dash = { dir, speed, t: duration, ...opts, hitSet: new Set() };
    if (opts.invulnerable) this.invulnTimer = Math.max(this.invulnTimer, duration + 0.05);
  }

  blink(distance, game) {
    // step toward aim until blocked
    const steps = 20;
    let bestX = this.pos.x, bestZ = this.pos.z;
    for (let i = 1; i <= steps; i++) {
      const x = this.pos.x + this.aimDir.x * distance * (i / steps);
      const z = this.pos.z + this.aimDir.z * distance * (i / steps);
      if (game.isWalkable(x, z, 0.35)) { bestX = x; bestZ = z; }
      else break;
    }
    this.pos.x = bestX; this.pos.z = bestZ;
  }

  // Targeted abilities land on the cursor, clamped to the ability's max range.
  aimPoint(maxDist) {
    const dx = this.cursor.x - this.pos.x;
    const dz = this.cursor.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= maxDist) return { x: this.cursor.x, z: this.cursor.z };
    return {
      x: this.pos.x + (dx / d) * maxDist,
      z: this.pos.z + (dz / d) * maxDist,
    };
  }

  takeDamage(amount, game) {
    if (this.dead || this.invulnTimer > 0) return;
    let mult = 1 - this.armor;
    for (const b of this.buffs) if (b.damageTakenMult) mult *= b.damageTakenMult;
    const final = Math.max(1, Math.round(amount * mult));
    this.hp -= final;
    audio.play('player_hurt', { throttleMs: 200 });
    game.ui.floaters.spawn(this.pos, `-${final}`, 'player-dmg');
    game.particles.burst(this.pos.x, 1.0, this.pos.z, 10, 0xd94a4a, { speed: 3.5, life: 0.35, size: 0.11 });
    game.shake(0.25);
    this.invulnTimer = 0.25;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      if (this.anim) this.anim.playDeath();
      audio.play('player_death');
      game.onPlayerDeath();
    }
  }

  heal(amount, game) {
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const gained = Math.round(this.hp - before);
    if (gained > 0) game.ui.floaters.spawn(this.pos, `+${gained}`, 'heal');
  }

  drinkPotion(game) {
    if (this.potions <= 0 || this.hp >= this.maxHp) return false;
    this.potions--;
    this._lastPotionAt = performance.now();
    audio.play('potion_drink');
    this.heal(Math.round(this.maxHp * 0.45), game);
    return true;
  }

  gainXp(amount, game) {
    this.xp += amount;
    game.ui.floaters.spawn(this.pos, `+${amount} xp`, 'xp');
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      this.recompute();
      this.hp = this.maxHp;
      this.resource = this.maxResource;
      audio.play('level_up');
      game.ui.showLevelUp(this.level);
      game.particles.ring(this.pos.x, 0.5, this.pos.z, 3, 0xffd75e);
      game.particles.burst(this.pos.x, 1.2, this.pos.z, 30, 0xffd75e, { speed: 4, life: 0.9 });
    }
  }

  tryBasicAttack(game) {
    if (this.attackCd > 0 || this.dead) return;
    const basic = this.classDef.basic;
    this.attackCd = basic.cooldown;
    this.attackAnim = 0.22;
    this._lastAttackAt = performance.now();
    if (this.anim) this.anim.playAttack();
    audio.play(basic.sound);
    if (basic.kind === 'melee') {
      game.meleeAttack(this, basic);
    } else {
      game.spawnProjectile({
        x: this.pos.x, z: this.pos.z, dir: this.aimDir, speed: basic.speed,
        radius: 0.3, damage: this.damage, friendly: true, color: basic.color,
        size: basic.arrow ? 0.14 : 0.18, arrow: basic.arrow, hitSound: basic.hitSound,
      });
    }
  }

  tryAbility(index, game) {
    if (this.dead) return;
    const ab = this.classDef.abilities[index];
    if (!ab || this.abilityCds[index] > 0) return;
    if (this.resource < ab.cost) {
      game.ui.flashNoResource(index);
      return;
    }
    this.resource -= ab.cost;
    this.abilityCds[index] = ab.cd;
    this.attackAnim = 0.25;
    if (this.anim) this.anim.playAttack();
    ab.exec(game, this);
  }

  update(dt, game) {
    if (this.anim) this.anim.mixer.update(dt);
    if (this.dead) return;

    // timers
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.spinTimer = Math.max(0, this.spinTimer - dt);
    this.attackAnim = Math.max(0, this.attackAnim - dt);
    for (let i = 0; i < 4; i++) this.abilityCds[i] = Math.max(0, this.abilityCds[i] - dt);
    this.buffs = this.buffs.filter((b) => (b.t -= dt) > 0);
    this.statuses = this.statuses.filter((s) => (s.t -= dt) > 0);

    // resource regen
    this.resource = Math.min(this.maxResource, this.resource + this.resourceRegen * dt);

    // dash movement overrides normal movement
    if (this.dash) {
      const d = this.dash;
      const step = d.speed * dt;
      const nx = this.pos.x + d.dir.x * step;
      const nz = this.pos.z + d.dir.z * step;
      if (game.isWalkable(nx, this.pos.z, 0.35)) this.pos.x = nx;
      if (game.isWalkable(this.pos.x, nz, 0.35)) this.pos.z = nz;
      if (d.damageMult) {
        // charge: damage enemies we pass through
        for (const e of game.enemies) {
          if (e.dead || d.hitSet.has(e)) continue;
          const dist = Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
          if (dist < 1.1) {
            d.hitSet.add(e);
            game.damageEnemy(e, this.damage * d.damageMult, { knockback: d.knockback, kbFrom: this.pos });
            audio.play('sword_hit', { pos: e.pos });
          }
        }
      }
      d.t -= dt;
      if (d.t <= 0) this.dash = null;
    } else {
      // normal movement
      const spd = this.moveSpeed;
      const mx = this.moveDir.x * spd * dt;
      const mz = this.moveDir.z * spd * dt;
      if (mx && game.isWalkable(this.pos.x + mx, this.pos.z, 0.35)) this.pos.x += mx;
      if (mz && game.isWalkable(this.pos.x, this.pos.z + mz, 0.35)) this.pos.z += mz;

      // footsteps
      if (mx || mz) {
        this.footstepTimer -= dt;
        if (this.footstepTimer <= 0) {
          this.footstepTimer = 0.34;
          audio.play('footstep', { volume: 0.4 });
        }
      } else {
        this.footstepTimer = 0.1;
      }
    }

    // mesh sync
    this.mesh.position.copy(this.pos);
    const targetRot = this.aimAngle;
    if (this.spinTimer > 0) {
      this.mesh.rotation.y += 18 * dt; // whirlwind spin
    } else {
      // face aim direction (negate for three.js Y rotation from XZ angle)
      this.mesh.rotation.y = -targetRot + Math.PI / 2;
    }
    if (this.anim) {
      const moving = !!(this.moveDir.x || this.moveDir.z) || !!this.dash;
      this.anim.setLocomotion(moving);
    } else {
      // primitive fallback: weapon bob
      const w = this.mesh.userData.weapon;
      if (w) w.rotation.x = -this.attackAnim * 5;
    }
  }

  toSave() {
    return {
      classId: this.classId,
      level: this.level,
      xp: this.xp,
      gold: this.gold,
      potions: this.potions,
      inventory: this.inventory,
      invSize: this.invSize,
      equipped: this.equipped,
    };
  }

  static fromSave(data) {
    const p = new Player(data.classId);
    p.level = data.level;
    p.xp = data.xp;
    p.gold = data.gold;
    p.potions = data.potions;
    p.inventory = data.inventory || [];
    p.invSize = data.invSize || 12;
    p.equipped = data.equipped || { weapon: null, armor: null, trinket: null };
    p.recompute();
    p.hp = p.maxHp;
    p.resource = p.maxResource;
    return p;
  }
}
