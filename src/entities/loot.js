import * as THREE from 'three';
import { audio } from '../core/audio.js';

// Gear generation with rarity tiers + world drop entities.

export const RARITIES = {
  common:    { name: 'Common', mult: 1.0, color: 0x9a9a9a, css: 'common', weight: 65 },
  rare:      { name: 'Rare', mult: 1.6, color: 0x4f8bd9, css: 'rare', weight: 27 },
  epic:      { name: 'Epic', mult: 2.4, color: 0xa03bd9, css: 'epic', weight: 8 },
  legendary: { name: 'Legendary', mult: 4.0, color: 0xff8c1a, css: 'legendary', weight: 0 }, // gamble-only
};

// Super-unique legendary items — only from Zoltan's gamble.
const LEGENDARIES = [
  { slot: 'weapon', icon: '🗡️', name: 'Doomblade Vharkûl', stats: (f) => ({ damagePct: 45 + f * 4, crit: 12 }) },
  { slot: 'weapon', icon: '🔨', name: 'Starfall, Hammer of Dawn', stats: (f) => ({ damagePct: 35 + f * 3, maxHp: 40 + f * 6 }) },
  { slot: 'armor', icon: '🛡️', name: 'Aegis of the Fallen King', stats: (f) => ({ maxHp: 90 + f * 12, armor: 14, regen: 4 }) },
  { slot: 'armor', icon: '🥋', name: 'Shroud of the Last Ember', stats: (f) => ({ maxHp: 55 + f * 8, speed: 10, crit: 8 }) },
  { slot: 'trinket', icon: '💎', name: 'The Emberdeep Heart', stats: (f) => ({ crit: 12, speed: 8, regen: 5 + Math.floor(f / 2) }) },
  { slot: 'trinket', icon: '🗝️', name: 'Zoltan’s Loaded Die', stats: (f) => ({ crit: 18 + f, speed: 5 }) },
];

// Zoltan's gamble: pricey, usually junk, sometimes glory.
export function gambleItem(floor) {
  const roll = Math.random();
  if (roll < 0.05) {
    const def = LEGENDARIES[Math.floor(Math.random() * LEGENDARIES.length)];
    return {
      id: nextItemId++, slot: def.slot, rarity: 'legendary', name: def.name,
      icon: def.icon, stats: def.stats(floor), value: 500 + floor * 40, unique: true,
    };
  }
  if (roll < 0.20) return generateGear(floor + 1, 'epic');
  if (roll < 0.50) return generateGear(floor, 'rare');
  return generateGear(floor, 'common');
}

const SLOT_DEFS = {
  weapon: {
    icon: '⚔️',
    names: ['Sword', 'Blade', 'Edge', 'Cleaver', 'Fang'],
    prefixes: ['Rusty', 'Fine', 'Steel', 'Tempered', 'Runed', 'Ancient'],
    stats: (power) => ({ damagePct: Math.round(6 + power * 9) }),
  },
  armor: {
    icon: '🛡️',
    names: ['Mail', 'Plate', 'Cuirass', 'Vestments', 'Hide'],
    prefixes: ['Worn', 'Sturdy', 'Reinforced', 'Warded', 'Dragonscale'],
    stats: (power) => ({ maxHp: Math.round(15 + power * 22), armor: Math.round(2 + power * 3) }),
  },
  trinket: {
    icon: '💍',
    names: ['Ring', 'Amulet', 'Charm', 'Talisman', 'Idol'],
    prefixes: ['Cracked', 'Polished', 'Gleaming', 'Enchanted', 'Fabled'],
    stats: (power) => {
      const roll = Math.random();
      if (roll < 0.34) return { crit: Math.round(3 + power * 4) };
      if (roll < 0.67) return { speed: Math.round(3 + power * 3) };
      return { regen: Math.round(2 + power * 2.5) };
    },
  },
};

const SUFFIXES = ['of Embers', 'of the Wolf', 'of Vigor', 'of the Depths', 'of Shadows', 'of the Colossus', 'of Swiftness'];

let nextItemId = 1;

export function rollRarity(bonus = 0) {
  const roll = Math.random() * 100 - bonus;
  if (roll < RARITIES.epic.weight) return 'epic';
  if (roll < RARITIES.epic.weight + RARITIES.rare.weight) return 'rare';
  return 'common';
}

export function generateGear(floor, forcedRarity = null) {
  const slot = ['weapon', 'armor', 'trinket'][Math.floor(Math.random() * 3)];
  const rarity = forcedRarity || rollRarity(floor);
  const def = SLOT_DEFS[slot];
  const power = (floor * 0.5 + Math.random()) * RARITIES[rarity].mult;

  const stats = def.stats(power);
  // rare/epic get a bonus secondary stat
  if (rarity !== 'common') {
    const extras = { rare: 1, epic: 2 }[rarity];
    for (let i = 0; i < extras; i++) {
      const pool = ['maxHp', 'crit', 'speed', 'regen'];
      const stat = pool[Math.floor(Math.random() * pool.length)];
      stats[stat] = (stats[stat] || 0) + Math.round(2 + power * 2);
    }
  }

  const prefix = def.prefixes[Math.min(def.prefixes.length - 1, Math.floor(power / 2.2))];
  let name = `${prefix} ${def.names[Math.floor(Math.random() * def.names.length)]}`;
  if (rarity === 'epic') name += ` ${SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)]}`;

  const value = Math.round((14 + floor * 6) * RARITIES[rarity].mult);
  return { id: nextItemId++, slot, rarity, name, icon: def.icon, stats, value };
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
      p.gold += d.amount;
      audio.play('coin_pickup', { volume: 0.7, throttleMs: 60 });
      game.ui.floaters.spawn(p.pos, `+${d.amount}g`, 'gold');
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
