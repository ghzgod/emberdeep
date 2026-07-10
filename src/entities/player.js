import * as THREE from 'three';
import { CLASSES, buildHeroMesh } from './classes.js';
import { buildAnimatedHero, skinToneById } from './heroModel.js';
import { audio } from '../core/audio.js';

export function xpForLevel(level) {
  return Math.floor(80 * Math.pow(level, 1.4));
}

export const LEVEL_CAP = 100;
// Gear stat keys recompute() actually understands; anything else on a loaded
// item is ignored so a hand-edited save can't inject bogus stats.
const ALLOWED_ITEM_STATS = [
  'damagePct', 'maxHp', 'armor', 'crit', 'speed', 'regen', 'cdr4',
  // offhand special-ability procs (see loot.js OFFHAND_PROCS)
  'blockChance', 'thorns', 'procRegen', 'goldFind', 'killHeal',
];

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
    this.equipped = { weapon: null, helmet: null, chest: null, legs: null, hands: null, trinket: null, offhand: null };
    this.skills = {};        // mastery tree: id -> rank

    this.pos = new THREE.Vector3();
    this.aimAngle = 0;
    this.aimDir = { x: 1, z: 0 };
    this.cursor = { x: 0, z: 0 };   // actual mouse point on the ground plane
    this.moveDir = { x: 0, z: 0 };

    this.buffs = [];
    this.statuses = [];      // debuffs on the player (slow etc.)
    this.dash = null;
    this.spinTimer = 0;
    this.whirl = null;        // sustained whirlwind state: { t, tick, tickT, radius, perTick, knockback }
    this.glideVel = { x: 0, z: 0 }; // carried momentum used only while whirling (ice movement)
    this.attackCd = 0;
    this.abilityCds = [0, 0, 0, 0];
    this.abilityCdMax = [0, 0, 0, 0]; // actual (post-reduction) cooldown, for the UI wheel
    // Hotbar slot -> ability index. Cooldowns above stay indexed by ABILITY,
    // not slot, so re-slotting mid-cooldown never resets or duplicates a
    // timer; only the slot-4 cdr4 bonus below follows the slot itself.
    this.abilityOrder = [0, 1, 2, 3];
    this.footstepTimer = 0;
    this.attackAnim = 0;
    this.comboIndex = 0;      // advances per basic-attack swing (melee variation cycle); resets after a short idle
    this.dead = false;
    this.invulnTimer = 0;
    this.aiming = false;      // set by the game while attack input is held
    this.faceAimTimer = 0;    // keep facing the aim briefly after an attack
    this.visualAngle = 0;     // smoothed facing angle

    this.recompute();
    this.hp = this.maxHp;
    this.resource = this.maxResource;

    // Seed small per-hero cosmetic variation (scar/tint) from the player's
    // chosen name, reusing the same key game.js's playerName() reads so a
    // reload or a remote peer sees the identical look for the same name.
    const heroName = (typeof localStorage !== 'undefined' && localStorage.getItem('emberdeep-name-v1')) || 'Hero';

    // Character-creation appearance choices. For a brand-new character these
    // come from the char-select pickers (persisted to localStorage as they are
    // chosen); fromSave overwrites them afterwards for a loaded character. Old
    // saves without these keys fall back to sensible defaults.
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    this.gender = ls?.getItem('emberdeep-gender-v1') === 'female' ? 'female' : 'male';
    this.skinTone = ls?.getItem('emberdeep-skin-v1') || 'light';

    // Prefer the animated KayKit model; fall back to primitives if it failed to load.
    this.anim = buildAnimatedHero(classId, heroName, { gender: this.gender, skinTone: this.skinTone });
    this.mesh = this.anim ? this.anim.mesh : buildHeroMesh(this.classDef, heroName);
  }

  // ---- mastery tree ----
  skillRank(id) { return this.skills[id] || 0; }
  spentSkillPoints() { return Object.values(this.skills).reduce((s, r) => s + r, 0); }
  // Mastery points accrue ~1 per 3 levels plus a +2 "slot" bonus at every 10th
  // level milestone. Mastering all 45 ranks is possible but takes deep into the
  // level cap (~lvl 84), not a mid-game formality.
  masteryEarned() { return Math.floor(this.level / 3) + Math.floor(this.level / 10) * 2; }
  skillPoints() { return Math.max(0, this.masteryEarned() - this.spentSkillPoints()); }
  addSkillRank(id, max = 5) {
    if (this.skillPoints() <= 0 || this.skillRank(id) >= max) return false;
    this.skills[id] = this.skillRank(id) + 1;
    this.recompute();
    return true;
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
    // Regen scales gently: at 0.6/level a level-50 mage out-regenned every
    // possible drain and the bar never moved. 0.15/level keeps sustained
    // spam net-negative at all levels (see the drain math in classes.js)
    // while high level still buys a noticeably faster refill.
    let regen = this.classDef.resource.regen + lvl * 0.15;

    // Gear percentages pool ADDITIVELY across items, then hit hard caps and
    // diminishing returns — no stat can stack into an auto-win:
    //   damage: full value to +100%, half value beyond
    //   move speed: capped at +30% · crit: capped 50% total · armor: 60%
    let dmgPct = 0, speedPct = 0, critPct = 0, armorPct = 0, regenFlat = 0, cdr4 = 0;
    // Offhand special-ability procs (see loot.js OFFHAND_PROCS) — one stat
    // slot each, capped below so no single item trivializes combat.
    let blockChance = 0, thorns = 0, goldFindPct = 0, killHealPct = 0;
    for (const item of Object.values(this.equipped)) {
      if (!item) continue;
      // Off-class gear (attuned to another class) yields HALF its stats, so
      // the same ring "better suits" the class it was made for.
      const scale = (item.affinity && item.affinity !== this.classId) ? 0.5 : 1;
      for (const [stat, val] of Object.entries(item.stats)) {
        const v = val * scale;
        if (stat === 'damagePct') dmgPct += v;
        else if (stat === 'maxHp') maxHp += v;
        else if (stat === 'armor') armorPct += v;
        else if (stat === 'crit') critPct += v;
        else if (stat === 'speed') speedPct += v;
        else if (stat === 'regen') regenFlat += v;
        else if (stat === 'cdr4') cdr4 += v; // ultimate (slot-4) cooldown reduction %
        else if (stat === 'blockChance') blockChance += v;
        else if (stat === 'thorns') thorns += v;
        else if (stat === 'procRegen') regenFlat += v; // folds into the same regen pool/cap
        else if (stat === 'goldFind') goldFindPct += v;
        else if (stat === 'killHeal') killHealPct += v;
      }
    }
    // Weapon-borne reduction to the slot-4 (ultimate/AoE) ability cooldown, capped.
    this.ult4Cdr = Math.min(0.5, cdr4 / 100);
    const effDmg = dmgPct <= 100 ? dmgPct : 100 + (dmgPct - 100) * 0.5;
    damage *= 1 + effDmg / 100;
    speed *= 1 + Math.min(30, speedPct) / 100;
    crit += Math.min(35, critPct) / 100;
    armor += Math.min(45, armorPct) / 100;
    regen += Math.min(15, regenFlat);
    this.blockChance = Math.min(30, blockChance) / 100;
    this.thorns = Math.min(60, thorns);
    this.goldFindPct = Math.min(60, goldFindPct);
    this.killHealPct = Math.min(15, killHealPct) / 100;

    // mastery tree bonuses (small, capped by the same limits below)
    maxHp *= 1 + 0.06 * this.skillRank('vitality');
    damage *= 1 + 0.04 * this.skillRank('brutality');
    crit += 0.02 * this.skillRank('precision');
    armor += 0.02 * this.skillRank('ironhide');
    speed *= 1 + 0.01 * this.skillRank('swiftness');

    this.maxHp = Math.round(maxHp);
    this.baseDamage = damage;
    this.speed = speed;
    this.armor = Math.min(0.6, armor);
    this.crit = Math.min(0.5, crit);
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
      : this.facingDir();
    this.dash = { dir, speed, t: duration, ...opts, hitSet: new Set() };
    if (opts.invulnerable) this.invulnTimer = Math.max(this.invulnTimer, duration + 0.05);
  }

  // Begin a sustained whirlwind: spins the mesh, ticks AoE damage around the
  // hero as it moves, and switches movement to low-friction "ice" gliding for
  // the duration. Seeds the glide velocity from current movement (or facing) so
  // the player keeps drifting the way they were going.
  startWhirl(opts) {
    const spd = this.moveSpeed;
    const dir = (this.moveDir.x || this.moveDir.z) ? this.moveDir : this.facingDir();
    this.glideVel = { x: dir.x * spd, z: dir.z * spd };
    this.whirl = {
      t: opts.duration,
      tick: opts.tick,
      tickT: 0, // fire a first damage tick immediately
      radius: opts.radius,
      perTick: opts.perTick,
      knockback: opts.knockback || 0,
    };
    audio.startWhirl();
  }

  // The direction the character is actually facing (the heading the mesh is
  // turned to), as a unit vector on the ground plane. Directional abilities
  // fire along this so they always launch where the hero points, on both
  // mouse and touch (touch has no cursor, so aimDir can be stale).
  facingDir() {
    return { x: Math.cos(this.visualAngle), z: Math.sin(this.visualAngle) };
  }

  blink(distance, game) {
    // step toward facing until blocked
    const dir = this.facingDir();
    const steps = 20;
    let bestX = this.pos.x, bestZ = this.pos.z;
    for (let i = 1; i <= steps; i++) {
      const x = this.pos.x + dir.x * distance * (i / steps);
      const z = this.pos.z + dir.z * distance * (i / steps);
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
    // the portal ring is a safe zone — no damage while standing inside it
    if (game.inSafeZone && game.inSafeZone(this.pos)) return;
    let mult = 1 - this.armor;
    for (const b of this.buffs) if (b.damageTakenMult) mult *= b.damageTakenMult;
    // Offhand block-chance proc: a successful block cuts the hit sharply
    // (partial, not a full negate, so it stays a bonus rather than immunity).
    const blocked = this.blockChance > 0 && Math.random() < this.blockChance;
    if (blocked) mult *= 0.4;
    const final = Math.max(1, Math.round(amount * mult));
    this.hp -= final;
    audio.classHurt(this.classId); // per-class vocal grunt (throttled internally)
    game.ui.floaters.spawn(this.pos, blocked ? `-${final} (blocked)` : `-${final}`, 'player-dmg');
    game.particles.burst(this.pos.x, 1.0, this.pos.z, 10, 0xd94a4a, { speed: 3.5, life: 0.35, size: 0.11 });
    game.shake(0.25);
    this.invulnTimer = 0.25;
    // Offhand thorns proc: a small burst of damage to whatever's nearby when
    // hit. No single-target attacker ref is threaded through every damage
    // path in this codebase (AoE splash has none), so this reads as "reflect"
    // without needing one — same damageEnemy call the dash/charge path uses.
    if (this.thorns > 0) {
      for (const e of game.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
        if (d < 2.2 + (e.radius || 0)) game.damageEnemy(e, this.thorns, { silent: true });
      }
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.whirl = null; // interrupt a sustained whirlwind if death lands mid-spin
      audio.stopWhirl();
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
    this.heal(Math.round(this.maxHp * 0.45 * (1 + 0.08 * this.skillRank('alchemy'))), game);
    return true;
  }

  gainXp(amount, game) {
    amount = Math.round(amount * (1 + 0.06 * this.skillRank('scholar')));
    this.xp += amount;
    game.ui.floaters.spawn(this.pos, `+${amount} xp`, 'xp');
    while (this.level < LEVEL_CAP && this.xp >= xpForLevel(this.level)) {
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
    if (this.level >= LEVEL_CAP) this.xp = 0; // capped: no overflow XP past max level
  }

  tryBasicAttack(game) {
    if (this.attackCd > 0 || this.dead) return;
    const basic = this.classDef.basic;
    const basicCost = basic.basicCost || 0;
    if (this.resource < basicCost) {
      game.ui.floaters.spawn(this.pos, `Out of ${this.classDef.resource.name}`, 'player-dmg');
      return;
    }
    this.resource -= basicCost;
    this.attackCd = basic.cooldown;
    this.attackAnim = 0.22;
    // Brief facing settle toward the target, only applied while stationary (see
    // the facing block in update). Kept short so it never fights move-direction.
    this.faceAimTimer = 0.25;
    const now = performance.now();
    // Combo cycle: pick the next melee variation, resetting to the first swing
    // if it's been a beat since the last attack so the combo doesn't carry
    // across separate fights. Only the knight's melee basic has variations;
    // other classes' basics ignore this and just play their one attack clip.
    let variation = null;
    if (basic.variations && basic.variations.length) {
      const idleMs = basic.idleResetMs ?? 1200;
      if (!this._lastAttackAt || now - this._lastAttackAt > idleMs) this.comboIndex = 0;
      variation = basic.variations[this.comboIndex % basic.variations.length];
      this.comboIndex++;
    }
    this._lastAttackAt = now;
    if (this.anim) this.anim.playAttack(variation?.clip);
    audio.play(basic.sound);
    if (basic.kind === 'melee') {
      game.meleeAttack(this, basic, variation);
    } else {
      game.spawnProjectile({
        x: this.pos.x, z: this.pos.z, dir: this.aimDir, speed: basic.speed,
        radius: 0.3, damage: this.damage, friendly: true, color: basic.color,
        size: basic.arrow ? 0.14 : 0.18, arrow: basic.arrow, hitSound: basic.hitSound,
      });
    }
  }

  // `slot` is the hotbar position (0-3, what keybinds/clicks fire); it maps
  // through abilityOrder to the actual ability index, so a re-slotted
  // ability keeps its own cooldown instead of inheriting the slot's.
  tryAbility(slot, game) {
    if (game.inTown) return;
    if (this.dead) return;
    const index = this.abilityOrder[slot];
    const ab = this.classDef.abilities[index];
    if (!ab || this.abilityCds[index] > 0) return;
    // Cost scales with the pool (maxResource grows +6/level) so casts-per-full-bar
    // stays constant at every level. With flat costs, regen growth alone crossed
    // the ability-only drain rate around level 18 (knight) / 10 (ranger) and the
    // bar stopped mattering again.
    const cost = Math.round(ab.cost * (this.maxResource / this.classDef.resource.max));
    if (this.resource < cost) {
      game.ui.flashNoResource(slot);
      return;
    }
    this.resource -= cost;
    let cd = ab.cd * (1 - 0.03 * this.skillRank('celerity'));
    if (slot === 3) cd *= 1 - (this.ult4Cdr || 0); // weapon ultimate-CDR affects whatever sits in slot 4
    this.abilityCds[index] = cd;
    this.abilityCdMax[index] = cd; // remember the true duration so the UI wheel is accurate
    this.attackAnim = 0.25;
    this.faceAimTimer = 0.25; // brief stationary-only facing settle (see update)
    if (this.anim) this.anim.playAttack();
    ab.exec(game, this);
  }

  // Re-slotting: swap which ability two hotbar slots point to. Cooldowns
  // live on abilityCds/abilityCdMax (indexed by ability), so this never
  // touches a timer in flight.
  swapAbilitySlots(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) return;
    if (a < 0 || a > 3 || b < 0 || b > 3 || a === b) return;
    const order = this.abilityOrder;
    [order[a], order[b]] = [order[b], order[a]];
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

    // Sustained whirlwind: tick AoE damage around the moving hero, then glide.
    if (this.whirl) {
      const w = this.whirl;
      w.tickT -= dt;
      if (w.tickT <= 0) {
        w.tickT += w.tick;
        game.aoeDamage(this.pos.x, this.pos.z, w.radius, w.perTick, {
          source: 'player', knockback: w.knockback,
        });
      }
      w.t -= dt;
      if (w.t <= 0) {
        this.whirl = null;
        audio.stopWhirl();
      }
    }

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
    } else if (this.whirl) {
      // "Ice" movement while spinning: keep a velocity that drifts in the last
      // heading and only steers loosely toward new input, so the hero slides
      // rather than stopping or turning sharply. Low blend factor = low friction.
      const spd = this.moveSpeed;
      const targetX = this.moveDir.x * spd;
      const targetZ = this.moveDir.z * spd;
      const grip = Math.min(1, 1.6 * dt); // small = slippery; ~1.6/s pull toward input
      this.glideVel.x += (targetX - this.glideVel.x) * grip;
      this.glideVel.z += (targetZ - this.glideVel.z) * grip;
      const mx = this.glideVel.x * dt;
      const mz = this.glideVel.z * dt;
      if (mx && game.isWalkable(this.pos.x + mx, this.pos.z, 0.35)) this.pos.x += mx;
      else if (mx) this.glideVel.x = 0; // scrub speed on a wall instead of grinding
      if (mz && game.isWalkable(this.pos.x, this.pos.z + mz, 0.35)) this.pos.z += mz;
      else if (mz) this.glideVel.z = 0;
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

    // mesh sync + facing. The body follows MOVEMENT direction whenever the hero
    // is walking (the loved feel); aiming only steers the body when the hero is
    // essentially stationary, so it settles toward the target between steps
    // instead of snapping to the enemy and back every frame while strafing.
    // Aim itself (where shots/melee are directed) is decoupled: it always uses
    // aimAngle/aimDir, so facing changes here never affect where attacks fire.
    this.mesh.position.copy(this.pos);
    this.faceAimTimer = Math.max(0, this.faceAimTimer - dt);
    const movingNow = !!(this.moveDir.x || this.moveDir.z) || !!this.dash;
    let targetRot = this.visualAngle;
    if (movingNow) targetRot = Math.atan2(this.moveDir.z, this.moveDir.x);
    else if (this.aiming || this.faceAimTimer > 0) targetRot = this.aimAngle;
    // Drag-to-aim override (touch cluster): while the ground aim arrow is out,
    // the hero turns to face the drag direction live, even mid-walk. Set and
    // cleared by game.setAimIndicator; normal rules resume on release.
    if (this.aimOverride != null) targetRot = this.aimOverride;
    // shortest-path smooth turn
    let diff = targetRot - this.visualAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.visualAngle += diff * Math.min(1, 14 * dt);
    if (this.whirl) {
      this.mesh.rotation.y += 16 * dt; // sustained whirlwind spin (~2.5 turns/sec)
    } else if (this.spinTimer > 0) {
      this.mesh.rotation.y += 18 * dt; // legacy short spin
    } else {
      this.mesh.rotation.y = -this.visualAngle + Math.PI / 2;
    }
    // Normalize actual speed (walk vs a dash/sprint) into 0-1 so the gait
    // reads faster when moving faster, instead of one fixed-speed loop.
    const curSpeed = this.dash ? this.dash.speed : (movingNow ? this.moveSpeed : 0);
    const speed01 = curSpeed > 0 ? Math.min(1, curSpeed / (this.speed * 1.8)) : 0;
    if (this.anim) {
      if (this.whirl) {
        // Hold the swing pose so the blade reads as held out horizontally while
        // the root spins, instead of running the walk/idle loop.
        this.anim.holdWhirlPose();
      } else {
        this.anim.setLocomotion(speed01, dt, this.attackAnim > 0);
      }
    } else {
      // primitive fallback: weapon bob + basic leg/idle gait. While whirling,
      // jam the weapon arm out to the side so the blade sweeps horizontally.
      const w = this.mesh.userData.weapon;
      if (w) w.rotation.x = this.whirl ? -Math.PI / 2 : -this.attackAnim * 5;
      if (this.mesh.userData.updateGait) this.mesh.userData.updateGait(dt, speed01, this.attackAnim > 0 || !!this.whirl);
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
      skills: this.skills,
      abilityOrder: this.abilityOrder,
      gender: this.gender,
      skinTone: this.skinTone,
    };
  }

  static fromSave(data) {
    data = data || {};
    const clampNum = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
    };
    // Keep only recognized, finite gear stats — reject anything else on load.
    const cleanItem = (item) => {
      if (!item || typeof item !== 'object') return null;
      if (item.slot === 'armor') item.slot = 'chest'; // migrate the old single armour slot
      if (item.stats && typeof item.stats === 'object') {
        const clean = {};
        for (const k of ALLOWED_ITEM_STATS) {
          if (item.stats[k] !== undefined) clean[k] = clampNum(item.stats[k], -100, 1000, 0);
        }
        item.stats = clean;
      } else {
        item.stats = {};
      }
      return item;
    };

    const classId = CLASSES[data.classId] ? data.classId : 'knight';
    const p = new Player(classId);
    p.level = Math.floor(clampNum(data.level, 1, LEVEL_CAP, 1));
    p.xp = clampNum(data.xp, 0, Number.MAX_SAFE_INTEGER, 0);
    p.gold = clampNum(data.gold, 0, Number.MAX_SAFE_INTEGER, 0);
    p.potions = Math.floor(clampNum(data.potions, 0, 99, 2));
    p.inventory = Array.isArray(data.inventory) ? data.inventory.map(cleanItem).filter(Boolean) : [];
    p.invSize = Math.floor(clampNum(data.invSize, 12, 24, 12));
    const eq = data.equipped && typeof data.equipped === 'object' ? data.equipped : {};
    p.equipped = {
      weapon: cleanItem(eq.weapon),
      helmet: cleanItem(eq.helmet),
      chest: cleanItem(eq.chest) || cleanItem(eq.armor), // old single 'armor' slot → chest
      legs: cleanItem(eq.legs),
      hands: cleanItem(eq.hands),
      trinket: cleanItem(eq.trinket),
      offhand: cleanItem(eq.offhand), // absent on old saves — stays null, no migration needed
    };
    // Mastery ranks are capped at 5 in play; clamp loaded ranks the same way.
    const skills = {};
    if (data.skills && typeof data.skills === 'object') {
      for (const [id, rank] of Object.entries(data.skills)) {
        const r = Math.floor(clampNum(rank, 0, 5, 0));
        if (r > 0) skills[id] = r;
      }
    }
    p.skills = skills;
    // abilityOrder must be a genuine permutation of 0-3, else reset to identity
    // (a hand-edited or corrupt save could otherwise point two slots at the
    // same ability, or leave one unreachable).
    const order = Array.isArray(data.abilityOrder) ? data.abilityOrder.map((n) => Math.floor(Number(n))) : null;
    const isValidOrder = order && order.length === 4 && [0, 1, 2, 3].every((n) => order.includes(n));
    p.abilityOrder = isValidOrder ? order : [0, 1, 2, 3];

    // Restore the saved appearance. Old saves without these keys keep the
    // constructor defaults (male / light). If the saved look differs from what
    // the constructor happened to build (it seeds from localStorage, which may
    // hold a different character's last pick), rebuild the hero mesh so a loaded
    // character always shows ITS OWN gender + skin tone. The scene hasn't added
    // p.mesh yet (game.js does that after fromSave), so swapping it is safe.
    const savedGender = data.gender === 'female' ? 'female' : 'male';
    const savedSkin = skinToneById(data.skinTone) ? data.skinTone : 'light';
    if (savedGender !== p.gender || savedSkin !== p.skinTone) {
      p.gender = savedGender;
      p.skinTone = savedSkin;
      const heroName = (typeof localStorage !== 'undefined' && localStorage.getItem('emberdeep-name-v1')) || 'Hero';
      const rebuilt = buildAnimatedHero(classId, heroName, { gender: p.gender, skinTone: p.skinTone });
      if (rebuilt) { p.anim = rebuilt; p.mesh = rebuilt.mesh; }
    }

    p.recompute();
    p.hp = p.maxHp;
    p.resource = p.maxResource;
    return p;
  }
}
