import * as THREE from 'three';
import { audio } from '../core/audio.js';

// Gear generation with rarity tiers + world drop entities.

// Tiers (internal keys are stable; display names/colours below):
//   common (grey) < rare (blue) < 'epic' key = Super Rare (purple) <
//   'legendary' key = EPIC (orange) — the pinnacle: ~0.001% drop, never bought.
export const RARITIES = {
  common:    { name: 'Common', mult: 1.0, color: 0x9a9a9a, css: 'common', weight: 65 },
  rare:      { name: 'Rare', mult: 1.6, color: 0x4f8bd9, css: 'rare', weight: 27 },
  epic:      { name: 'Epic', mult: 2.4, color: 0xa03bd9, css: 'epic', weight: 8 },
  legendary: { name: 'Legendary', mult: 4.0, color: 0xff8c1a, css: 'legendary', weight: 0 }, // pinnacle: earned only
};

// Legendary uniques come in two pools:
//  - GAMBLE pool: only Zoltan's risky Mystery Relics can produce these.
//  - DROP pool: money can't buy them — only minibosses and the Dungeon Lord
//    have a chance to drop them. Some things you have to fight for.
// Legendaries sit meaningfully ABOVE a same-floor epic on every stat — the
// runtime caps in Player.recompute keep them powerful, never game-breaking.
const L = (f) => Math.sqrt(Math.min(f, 60)); // shared depth factor
const GAMBLE_LEGENDARIES = [
  { slot: 'weapon', icon: '🔨', name: 'Starfall, Hammer of Dawn', stats: (f) => ({ damagePct: Math.round(45 + L(f) * 14), maxHp: Math.round(60 + L(f) * 22), crit: 8 }) },
  { slot: 'chest', icon: '🥋', name: 'Shroud of the Last Ember', stats: (f) => ({ maxHp: Math.round(110 + L(f) * 30), speed: 15, crit: 12, armor: 8 }) },
  { slot: 'trinket', icon: '🗝️', name: 'Zoltan’s Loaded Die', stats: (f) => ({ crit: Math.round(24 + L(f) * 2), speed: 10, regen: Math.round(4 + L(f)) }) },
];
const DROP_LEGENDARIES = [
  { slot: 'weapon', icon: '🗡️', name: 'Doomblade Vharkûl', stats: (f) => ({ damagePct: Math.round(60 + L(f) * 16), crit: 18 }) },
  { slot: 'chest', icon: '🛡️', name: 'Aegis of the Fallen King', stats: (f) => ({ maxHp: Math.round(150 + L(f) * 36), armor: 18, regen: 7 }) },
  { slot: 'trinket', icon: '💎', name: 'The Emberdeep Heart', stats: (f) => ({ crit: 18, speed: 12, regen: Math.round(7 + L(f) * 1.5) }) },
  { slot: 'trinket', icon: '👑', name: 'Crown of the Dungeon Lord', stats: (f) => ({ maxHp: Math.round(110 + L(f) * 26), crit: 16, regen: 6 }) },
];

// Legendary WEAPONS additionally roll an elemental identity - a flame or
// frost brand that shows up in the name/on the item card (see makeLegendary),
// as a visual (updateHeroGear in game.js: emissive blade/grip edges + drifting
// motes) and as an on-hit effect (game.js meleeAttack/spawnProjectile wire the
// element into the existing burn/slow status system). Extensible: add a key
// here (plus a matching branch anywhere WEAPON_ELEMENTS is read) for more.
export const WEAPON_ELEMENTS = {
  flame: { name: 'Flamebrand', color: 0xff5a1a, particleColor: 0xffb347 },
  frost: { name: 'Frostbite', color: 0x5ad1ff, particleColor: 0xcfefff },
};
const WEAPON_ELEMENT_KEYS = Object.keys(WEAPON_ELEMENTS);

function makeLegendary(def, floor) {
  const item = {
    id: nextItemId++, slot: def.slot, rarity: 'legendary', name: def.name,
    icon: def.icon, ilvl: floor, stats: def.stats(floor), value: 500 + floor * 40, unique: true,
  };
  // Old saves may hold a legendary weapon from before this system existed -
  // those simply have no `element` and stay plain (see updateHeroGear/
  // meleeAttack: both only branch on it when present). Only NEW weapon rolls
  // get one.
  if (def.slot === 'weapon') {
    const key = WEAPON_ELEMENT_KEYS[Math.floor(Math.random() * WEAPON_ELEMENT_KEYS.length)];
    item.element = key;
    item.name = `${WEAPON_ELEMENTS[key].name} ${def.name}`;
  }
  return item;
}

// The pinnacle EPIC uniques — earned in a fight only, never sold or gambled.
const EPIC_UNIQUES = [...GAMBLE_LEGENDARIES, ...DROP_LEGENDARIES];
// Boss jackpot: opts.perfectChance lets act bosses / the Dungeon Lord roll a
// small shot at a "perfect" legendary: every stat maxed for its item level
// (a flat +15%, rounded), same legendary tier and visuals as always. The
// bump is fixed and capped by the L() depth clamp inside the stat formulas,
// so there is no runaway inflation and no new tier.
export function dropLegendary(floor, opts = {}) {
  const item = makeLegendary(EPIC_UNIQUES[Math.floor(Math.random() * EPIC_UNIQUES.length)], floor);
  if (opts.perfectChance && Math.random() < opts.perfectChance) {
    for (const k of Object.keys(item.stats)) item.stats[k] = Math.round(item.stats[k] * 1.15);
    item.name = `Perfect ${item.name}`;
    item.perfect = true;
    item.value = Math.round(item.value * 1.5);
  }
  return item;
}

// Zoltan's gamble: pricey, usually junk — fate can grant up to a Super Rare,
// but the pinnacle EPIC can never be bought or gambled.
export function gambleItem(floor) {
  const roll = Math.random();
  // Fate alone (never a fixed-price purchase) can rarely grant the pinnacle EPIC.
  if (roll < 0.015) return makeLegendary(EPIC_UNIQUES[Math.floor(Math.random() * EPIC_UNIQUES.length)], floor);
  if (roll < 0.12) return generateGear(floor + 2, 'epic'); // Super Rare (purple)
  if (roll < 0.45) return generateGear(floor, 'rare');
  return generateGear(floor, 'common');
}

// Item power grows with the square root of floor depth (not linearly), so
// late-act gear is strong but never explodes into free-win territory.
// Weapons are flavored to the class that finds them — a mage never picks up
// a sword, a ranger never a staff.
const CLASS_WEAPONS = {
  knight: { icon: '⚔️', names: ['Sword', 'Blade', 'Greatsword', 'Cleaver', 'Warblade'] },
  mage:   { icon: '🪄', names: ['Staff', 'Wand', 'Scepter', 'Rod', 'Focus'] },
  ranger: { icon: '🏹', names: ['Bow', 'Longbow', 'Recurve', 'Shortbow', 'Warbow'] },
};

// Offhand flavour per class, for the ~55% of offhands that roll class-LOCKED
// (same forClass mechanism as weapons — see generateGear). The other ~45%
// roll as a universal offhand (lantern/charm/relic) that anyone can carry,
// using the same affinity mechanic as armour/trinkets (half value off-class).
const CLASS_OFFHANDS = {
  knight: { icon: '🛡️', names: ['Shield', 'Bulwark', 'Aegis', 'Bannershield', 'Wardplate'] },
  mage:   { icon: '📖', names: ['Tome', 'Grimoire', 'Codex', 'Orb', 'Focus Stone'] },
  ranger: { icon: '🏹', names: ['Quiver', 'Talisman', 'Trophy', 'Fetish', 'Charm'] },
};
const UNIVERSAL_OFFHANDS = { icon: '🏮', names: ['Lantern', 'Charm', 'Relic', 'Emblem', 'Idol'] };
// Class-locked roll chance for a generated offhand (rest are universal/affinity).
const OFFHAND_CLASS_LOCK_CHANCE = 0.55;

// Passive special abilities an offhand can grant — exactly one per item,
// rolled at generation (see SLOT_DEFS.offhand.stats below). Each maps to a
// single gear stat key that Player.recompute folds into a dedicated derived
// field; the actual effect is applied where cheap (player.js takeDamage for
// on-hit reactions, game.js killEnemy for on-kill, loot.js pickup for gold
// find) rather than inventing a whole new buff system.
export const OFFHAND_PROCS = {
  blockChance: (power) => Math.round(4 + power * 1.4),   // % chance to block a hit (partial mitigation)
  thorns:      (power) => Math.round(3 + power * 1.6),   // reflect damage burst around the wearer on hit
  procRegen:   (power) => Math.round(3 + power * 1.1),   // extra flat resource regen/sec
  goldFind:    (power) => Math.round(6 + power * 2.2),   // % bonus gold from pickups
  killHeal:    (power) => Math.round(2 + power * 1.3),   // % max HP healed on kill
};
const OFFHAND_PROC_KEYS = Object.keys(OFFHAND_PROCS);

// Six wearable slots. Weapons are class-LOCKED (a mage can't hold a sword).
// Armour pieces + trinkets are shareable across classes but carry an
// "affinity": the class they're tuned for. See CLASS_AFFINITY below.
const SLOT_DEFS = {
  weapon: {
    icon: '⚔️',
    names: ['Sword', 'Blade', 'Edge', 'Cleaver', 'Fang'],
    prefixes: ['Rusty', 'Fine', 'Steel', 'Tempered', 'Runed', 'Ancient'],
    stats: (power) => ({ damagePct: Math.round(5 + power * 4) }),
  },
  helmet: {
    icon: '⛑️',
    names: ['Helm', 'Coif', 'Hood', 'Casque', 'Visage'],
    prefixes: ['Worn', 'Sturdy', 'Reinforced', 'Warded', 'Dragoncrest'],
    stats: (power) => ({ maxHp: Math.round(7 + power * 6), armor: Math.round(1 + power * 0.6) }),
  },
  chest: {
    icon: '🛡️',
    names: ['Mail', 'Plate', 'Cuirass', 'Vestments', 'Hauberk'],
    prefixes: ['Worn', 'Sturdy', 'Reinforced', 'Warded', 'Dragonscale'],
    stats: (power) => ({ maxHp: Math.round(14 + power * 11), armor: Math.round(2 + power * 0.9) }),
  },
  legs: {
    icon: '👖',
    names: ['Greaves', 'Legguards', 'Leggings', 'Tassets', 'Faulds'],
    prefixes: ['Worn', 'Sturdy', 'Reinforced', 'Warded', 'Dragonhide'],
    stats: (power) => ({ maxHp: Math.round(8 + power * 7), armor: Math.round(1 + power * 0.6) }),
  },
  hands: {
    icon: '🧤',
    names: ['Gauntlets', 'Gloves', 'Grips', 'Bracers', 'Fists'],
    prefixes: ['Worn', 'Fine', 'Steel', 'Runed', 'Ancient'],
    stats: (power) => ({ damagePct: Math.round(3 + power * 2.2) }),
  },
  trinket: {
    icon: '💍',
    names: ['Ring', 'Amulet', 'Charm', 'Talisman', 'Idol'],
    prefixes: ['Cracked', 'Polished', 'Gleaming', 'Enchanted', 'Fabled'],
    stats: (power) => {
      const roll = Math.random();
      if (roll < 0.34) return { crit: Math.round(2 + power * 0.9) };
      if (roll < 0.67) return { speed: Math.round(2 + power * 0.6) };
      return { regen: Math.round(1 + power * 0.4) };
    },
  },
  // Offhand: grants exactly one passive proc (see OFFHAND_PROCS above), shown
  // on the item card like any other stat. Names/icon come from CLASS_OFFHANDS
  // or UNIVERSAL_OFFHANDS in generateGear depending on the class-lock roll.
  offhand: {
    icon: '🏮',
    prefixes: ['Worn', 'Sturdy', 'Warded', 'Enchanted', 'Fabled'],
    stats: (power) => {
      const key = OFFHAND_PROC_KEYS[Math.floor(Math.random() * OFFHAND_PROC_KEYS.length)];
      return { [key]: OFFHAND_PROCS[key](power) };
    },
  },
};

// The stat that best serves each class — an affinity item rolls its bonus
// stats from here, so a Mage-attuned ring leans into crit/regen while a
// Knight-attuned one leans into health/armour. Off-class wearers still get
// HALF value (see Player.recompute), so gear "better suits one class".
const CLASS_AFFINITY = {
  knight: ['maxHp', 'armor', 'damagePct'],
  mage:   ['crit', 'regen', 'maxHp'],
  ranger: ['speed', 'crit', 'damagePct'],
};
const CLASS_LIST = ['knight', 'mage', 'ranger'];
// Slots that are shared across classes (everything except the locked weapon).
const AFFINITY_SLOTS = ['helmet', 'chest', 'legs', 'hands', 'trinket'];

const SUFFIXES = ['of Embers', 'of the Wolf', 'of Vigor', 'of the Depths', 'of Shadows', 'of the Colossus', 'of Swiftness'];

let nextItemId = 1;
// Shared id source so consumables/elixirs get unique ids too.
export function newItemId() { return nextItemId++; }

export function rollRarity(bonus = 0) {
  const roll = Math.random() * 100 - bonus;
  if (roll < RARITIES.epic.weight) return 'epic';
  if (roll < RARITIES.epic.weight + RARITIES.rare.weight) return 'rare';
  return 'common';
}

// ---------------- Smart loot influence ----------------
const GEAR_SLOTS = ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket', 'offhand'];
// Elite kills shift the rarity roll up (rollRarity bonus is subtracted from
// the d100), roughly a tier's worth. Legendary rules are untouched: rollRarity
// can never produce legendary, elite or not.
const ELITE_RARITY_BONUS = 12;

// Rough power score of a worn piece: item level scaled by its rarity mult.
function wornScore(item) { return (item.ilvl || 1) * (RARITIES[item.rarity]?.mult || 1); }

// Fill-the-gap slot pick. Weights: EMPTY slot 4x (strongly favour gearing
// bare slots), the WEAKEST filled slot 2x (nudge upgrades where they matter
// most), everything else 1x. Falls back to a uniform pick when the finder's
// equipped set is unknown (vendor stock, gamble, old call sites).
function pickDropSlot(equipped) {
  if (!equipped) return GEAR_SLOTS[Math.floor(Math.random() * GEAR_SLOTS.length)];
  let weakest = null, weakestScore = Infinity;
  for (const s of GEAR_SLOTS) {
    const it = equipped[s];
    if (it && wornScore(it) < weakestScore) { weakestScore = wornScore(it); weakest = s; }
  }
  const weights = GEAR_SLOTS.map((s) => (!equipped[s] ? 4 : s === weakest ? 2 : 1));
  let total = 0;
  for (const w of weights) total += w;
  let roll = Math.random() * total;
  for (let i = 0; i < GEAR_SLOTS.length; i++) {
    roll -= weights[i];
    if (roll < 0) return GEAR_SLOTS[i];
  }
  return GEAR_SLOTS[GEAR_SLOTS.length - 1];
}

// ctx (all optional, personal to the finder so multiplayer loot stays per-player):
//   equipped: the finder's equipped-slots map (drives slot + upgrade bias)
//   elite:    true when the kill was a crowned elite (rarity boost)
export function generateGear(floor, forcedRarity = null, classId = 'knight', ctx = null) {
  const slot = pickDropSlot(ctx?.equipped);
  const isWeapon = slot === 'weapon';
  // Offhands roll class-locked (shield/tome/quiver, same forClass mechanism
  // as weapons) most of the time; the rest are universal lanterns/charms
  // that use the ordinary affinity mechanic like armour/trinkets.
  const isOffhand = slot === 'offhand';
  const offhandLocked = isOffhand && Math.random() < OFFHAND_CLASS_LOCK_CHANCE;
  const isClassLocked = isWeapon || offhandLocked;
  const rarity = forcedRarity || rollRarity(floor + (ctx?.elite ? ELITE_RARITY_BONUS : 0));

  // All-slots-filled upgrade bias: once every slot is worn, aim the item level
  // slightly above the piece currently in the chosen slot so drops trend
  // toward upgrades. Capped at floor + 2 (the gamble already sells floor + 2),
  // so the floor's normal power budget holds and nothing inflates.
  let ilvl = floor;
  if (ctx?.equipped && GEAR_SLOTS.every((s) => ctx.equipped[s])) {
    const worn = ctx.equipped[slot];
    ilvl = Math.min(floor + 2, Math.max(floor, (worn.ilvl || floor) + 1));
  }
  // weapons take their names/icon from the finder's class (and are class-locked);
  // a class-locked offhand does the same from CLASS_OFFHANDS, a universal
  // offhand from UNIVERSAL_OFFHANDS.
  const def = isWeapon
    ? { ...SLOT_DEFS.weapon, ...(CLASS_WEAPONS[classId] || CLASS_WEAPONS.knight) }
    : isOffhand
      ? { ...SLOT_DEFS.offhand, ...(offhandLocked ? (CLASS_OFFHANDS[classId] || CLASS_OFFHANDS.knight) : UNIVERSAL_OFFHANDS) }
      : SLOT_DEFS[slot];
  const power = (Math.sqrt(ilvl) * 1.7 + Math.random()) * RARITIES[rarity].mult;

  const stats = def.stats(power);

  // Shared gear is attuned to a class — usually the finder's, sometimes
  // another's (so off-class loot exists to trade/inspect). Its bonus stats
  // come from that class's affinity pool, and off-class wearers get half
  // value in Player.recompute. Class-locked items (weapon, or a class-locked
  // offhand) skip affinity entirely — forClass already gates who can wear them.
  const affinity = isClassLocked ? null
    : (Math.random() < 0.6 ? classId : CLASS_LIST[Math.floor(Math.random() * CLASS_LIST.length)]);

  // rare/epic get bonus secondary stats, flavoured by the affinity
  if (rarity !== 'common') {
    const extras = { rare: 1, epic: 2, legendary: 2 }[rarity] || 1;
    const pool = affinity ? CLASS_AFFINITY[affinity] : ['maxHp', 'crit', 'speed', 'regen'];
    for (let i = 0; i < extras; i++) {
      const stat = pool[Math.floor(Math.random() * pool.length)];
      const gain = stat === 'maxHp' ? Math.round(8 + power * 5)
        : stat === 'damagePct' ? Math.round(2 + power * 1.5)
        : Math.round(1 + power * 0.5);
      stats[stat] = (stats[stat] || 0) + gain;
    }
  }

  // Epic+ weapons can roll cooldown reduction for the slot-4 ultimate/AoE.
  if (isWeapon && (rarity === 'epic' || rarity === 'legendary') && Math.random() < 0.55) {
    stats.cdr4 = (stats.cdr4 || 0) + Math.round(8 + power);
  }

  const prefix = def.prefixes[Math.min(def.prefixes.length - 1, Math.floor(power / 2.2))];
  let name = `${prefix} ${def.names[Math.floor(Math.random() * def.names.length)]}`;
  if (rarity === 'epic') name += ` ${SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)]}`;

  const value = Math.round((14 + ilvl * 6) * RARITIES[rarity].mult);
  // weapons and class-locked offhands carry the class that can wield them;
  // everything else (including universal offhands) carries affinity instead.
  const forClass = isClassLocked ? classId : null;
  return { id: nextItemId++, slot, rarity, name, icon: def.icon, ilvl, stats, value, forClass, affinity };
}

// Gold received when selling (items from old saves may lack a stored value).
export function sellValue(item) {
  if (item.value) return Math.round(item.value * 0.5);
  return Math.round(10 * RARITIES[item.rarity].mult);
}

// Vendor asking price.
export function buyPrice(item) {
  return item.value || Math.round(20 * RARITIES[item.rarity].mult);
}

export function statLabel(stat, val) {
  switch (stat) {
    case 'damagePct': return `+${val}% damage`;
    case 'maxHp': return `+${val} max health`;
    case 'armor': return `+${val}% armor`;
    case 'crit': return `+${val}% crit chance`;
    case 'speed': return `+${val}% move speed`;
    case 'regen': return `+${val} resource regen`;
    case 'cdr4': return `-${val}% ultimate cooldown`;
    case 'blockChance': return `${val}% chance to block`;
    case 'thorns': return `+${val} thorns (reflect on hit)`;
    case 'procRegen': return `+${val} bonus resource regen`;
    case 'goldFind': return `+${val}% gold find`;
    case 'killHeal': return `heal ${val}% max HP on kill`;
    default: return `+${val} ${stat}`;
  }
}

// ---------------- World drops ----------------
export class LootSystem {
  constructor(scene) {
    this.scene = scene;
    this.drops = [];
  }

  dropGold(x, z, amount) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.06, 10),
      new THREE.MeshStandardMaterial({ color: 0xe8c05a, metalness: 0.7, roughness: 0.3 })
    );
    mesh.position.set(x + (Math.random() - 0.5) * 0.6, 0.15, z + (Math.random() - 0.5) * 0.6);
    this.scene.add(mesh);
    this.drops.push({ kind: 'gold', amount, mesh, x: mesh.position.x, z: mesh.position.z, bob: Math.random() * 6 });
  }

  dropPotion(x, z) {
    const g = new THREE.Group();
    const bottle = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xd93a3a, roughness: 0.3 })
    );
    bottle.position.y = 0.2;
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.12, 6),
      new THREE.MeshStandardMaterial({ color: 0x6a4a2a })
    );
    neck.position.y = 0.4;
    g.add(bottle, neck);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.drops.push({ kind: 'potion', mesh: g, x, z, bob: Math.random() * 6 });
  }

  // Very rare: expands inventory capacity by 3 (max 24).
  dropBag(x, z) {
    const g = new THREE.Group();
    const sack = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a6534, roughness: 0.9 })
    );
    sack.scale.y = 1.15;
    sack.position.y = 0.28;
    const tie = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.1, 0.12, 6),
      new THREE.MeshStandardMaterial({ color: 0x5a3f1e, roughness: 1 })
    );
    tie.position.y = 0.58;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.14, 2.4, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xe8c05a, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    beam.position.y = 1.2;
    g.add(sack, tie, beam);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.drops.push({ kind: 'bag', mesh: g, x, z, bob: Math.random() * 6 });
  }

  dropGear(x, z, item, did = null) {
    const color = RARITIES[item.rarity].color;
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    box.position.y = 0.35;
    // light beam for visibility
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.14, 2.4, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    beam.position.y = 1.2;
    g.add(box, beam);
    // Epic pinnacle (and, lighter, Super Rare) get a glow halo + orbiting stardust.
    let sparkles = null;
    if (item.rarity === 'legendary' || item.rarity === 'epic') {
      const epic = item.rarity === 'legendary';
      beam.material.opacity = epic ? 0.42 : 0.3;
      box.material.emissiveIntensity = epic ? 0.95 : 0.65;
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 10, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: epic ? 0.22 : 0.14, depthWrite: false })
      );
      halo.position.y = 0.35;
      g.add(halo);
      sparkles = new THREE.Group();
      const n = epic ? 7 : 4;
      const sMat = new THREE.MeshBasicMaterial({ color: epic ? 0xfff2c0 : 0xe6c8ff });
      for (let i = 0; i < n; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 5, 5), sMat);
        const a = (i / n) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.32, 0.35 + Math.sin(a * 1.5) * 0.12, Math.sin(a) * 0.32);
        sparkles.add(s);
      }
      g.add(sparkles);
    }
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.drops.push({ kind: 'gear', item, mesh: g, x, z, bob: Math.random() * 6, spinner: box, sparkles, did });
  }

  // Remove a networked ground drop (someone else picked it up) without granting it.
  removeByDid(did) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      if (this.drops[i].did === did) { this.scene.remove(this.drops[i].mesh); this.drops.splice(i, 1); return; }
    }
  }

  update(dt, game) {
    const p = game.player;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.bob += dt * 3;
      const base = d.kind === 'gold' ? 0.15 : 0;
      d.mesh.position.y = base + Math.sin(d.bob) * 0.06;
      if (d.spinner) d.spinner.rotation.y += dt * 2;
      if (d.sparkles) { d.sparkles.rotation.y -= dt * 1.6; d.sparkles.rotation.x = Math.sin(d.bob * 0.5) * 0.2; }

      if (p.dead) continue;
      const dist = Math.hypot(p.pos.x - d.x, p.pos.z - d.z);
      // gold magnetizes toward the player
      if (d.kind === 'gold' && dist < 2.6) {
        const pull = 8 * dt;
        d.x += (p.pos.x - d.x) * pull;
        d.z += (p.pos.z - d.z) * pull;
        d.mesh.position.x = d.x;
        d.mesh.position.z = d.z;
      }
      if (dist < 0.9) {
        this.pickup(d, game);
        this.scene.remove(d.mesh);
        this.drops.splice(i, 1);
      }
    }
  }

  pickup(d, game) {
    const p = game.player;
    if (d.kind === 'gold') {
      // Greed mastery + an offhand's goldFind proc stack additively.
      const amount = Math.round(d.amount * (1 + 0.06 * p.skillRank('greed') + (p.goldFindPct || 0) / 100));
      p.gold += amount;
      audio.play('coin_pickup', { volume: 0.7, throttleMs: 60 });
      game.ui.floaters.spawn(p.pos, `+${amount}g`, 'gold');
    } else if (d.kind === 'potion') {
      p.potions++;
      audio.play('potion_pickup');
      game.ui.floaters.spawn(p.pos, '+1 potion', 'heal');
    } else if (d.kind === 'bag') {
      if (p.invSize < 24) {
        p.invSize = Math.min(24, p.invSize + 3);
        audio.play('gear_pickup');
        audio.play('level_up', { volume: 0.5, rate: 1.4 });
        game.ui.floaters.spawn(p.pos, '🎒 +3 inventory slots!', 'crit');
      } else {
        p.gold += 50;
        audio.play('coin_pickup');
        game.ui.floaters.spawn(p.pos, 'Bags full — +50g', 'gold');
      }
    } else if (d.kind === 'gear') {
      if (p.inventory.length >= p.invSize) {
        game.ui.floaters.spawn(p.pos, 'Inventory full!', 'player-dmg');
        // put it back (stop trying to pick it up for a moment)
        this.dropGear(d.x + 0.8, d.z, d.item);
        return;
      }
      p.inventory.push(d.item);
      audio.play('gear_pickup');
      game.ui.floaters.spawn(p.pos, d.item.name, RARITIES[d.item.rarity].css === 'common' ? '' : 'crit');
      if (d.did) game.onDropPickedUp(d.did); // networked drop — remove it for everyone
    }
    game.requestSave();
  }

  clear() {
    for (const d of this.drops) this.scene.remove(d.mesh);
    this.drops.length = 0;
  }
}
