import * as THREE from 'three';
import { audio } from '../core/audio.js';

// Gear generation with rarity tiers + world drop entities.

export const RARITIES = {
  common:    { name: 'Common', mult: 1.0, color: 0x9a9a9a, css: 'common', weight: 65 },
  rare:      { name: 'Rare', mult: 1.6, color: 0x4f8bd9, css: 'rare', weight: 27 },
  epic:      { name: 'Epic', mult: 2.4, color: 0xa03bd9, css: 'epic', weight: 8 },
  legendary: { name: 'Legendary', mult: 4.0, color: 0xff8c1a, css: 'legendary', weight: 0 }, // gamble-only
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

function makeLegendary(def, floor) {
  return {
    id: nextItemId++, slot: def.slot, rarity: 'legendary', name: def.name,
    icon: def.icon, stats: def.stats(floor), value: 500 + floor * 40, unique: true,
  };
}

// Boss/miniboss-only legendaries. Never sold, never gambled.
export function dropLegendary(floor) {
  return makeLegendary(DROP_LEGENDARIES[Math.floor(Math.random() * DROP_LEGENDARIES.length)], floor);
}

// Zoltan's gamble: pricey, usually junk, sometimes glory (his own uniques only).
export function gambleItem(floor) {
  const roll = Math.random();
  if (roll < 0.05) {
    return makeLegendary(GAMBLE_LEGENDARIES[Math.floor(Math.random() * GAMBLE_LEGENDARIES.length)], floor);
  }
  if (roll < 0.20) return generateGear(floor + 1, 'epic');
  if (roll < 0.50) return generateGear(floor, 'rare');
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

export function generateGear(floor, forcedRarity = null, classId = 'knight') {
  const slot = ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket'][Math.floor(Math.random() * 6)];
  const isWeapon = slot === 'weapon';
  const rarity = forcedRarity || rollRarity(floor);
  // weapons take their names/icon from the finder's class (and are class-locked)
  const def = isWeapon
    ? { ...SLOT_DEFS.weapon, ...(CLASS_WEAPONS[classId] || CLASS_WEAPONS.knight) }
    : SLOT_DEFS[slot];
  const power = (Math.sqrt(floor) * 1.7 + Math.random()) * RARITIES[rarity].mult;

  const stats = def.stats(power);

  // Shared gear is attuned to a class — usually the finder's, sometimes
  // another's (so off-class loot exists to trade/inspect). Its bonus stats
  // come from that class's affinity pool, and off-class wearers get half
  // value in Player.recompute.
  const affinity = isWeapon ? null
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

  const prefix = def.prefixes[Math.min(def.prefixes.length - 1, Math.floor(power / 2.2))];
  let name = `${prefix} ${def.names[Math.floor(Math.random() * def.names.length)]}`;
  if (rarity === 'epic') name += ` ${SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)]}`;

  const value = Math.round((14 + floor * 6) * RARITIES[rarity].mult);
  // weapons carry the class that can wield them; shared gear carries affinity
  const forClass = isWeapon ? classId : null;
  return { id: nextItemId++, slot, rarity, name, icon: def.icon, stats, value, forClass, affinity };
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

  dropGear(x, z, item) {
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
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.drops.push({ kind: 'gear', item, mesh: g, x, z, bob: Math.random() * 6, spinner: box });
  }

  update(dt, game) {
    const p = game.player;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.bob += dt * 3;
      const base = d.kind === 'gold' ? 0.15 : 0;
      d.mesh.position.y = base + Math.sin(d.bob) * 0.06;
      if (d.spinner) d.spinner.rotation.y += dt * 2;

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
      const amount = Math.round(d.amount * (1 + 0.06 * p.skillRank('greed')));
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
    }
    game.requestSave();
  }

  clear() {
    for (const d of this.drops) this.scene.remove(d.mesh);
    this.drops.length = 0;
  }
}
