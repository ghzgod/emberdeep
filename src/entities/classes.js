import * as THREE from 'three';
import { audio } from '../core/audio.js';

// Class definitions: stats, basic attack, four abilities each.
// Ability exec() receives (game, player) and uses the game's combat API.
//
// Resource economy: basic.basicCost makes even the free-spam basic attack
// drain the resource bar faster than passive regen, so sustained fighting
// forces pacing (waiting for regen or leaning on abilities). Verified drain
// rate (basicCost / cooldown) minus resource.regen, and time to empty a full
// bar assuming continuous basic-attack spam with no ability casts:
//   knight: 9 / 0.45s = 20/s - 12 regen = -8/s  -> 100 stamina / 8  ≈ 12.5s
//   mage:   10 / 0.42s = 23.8/s - 11 regen = -12.8/s -> 120 mana / 12.8 ≈ 9.4s
//   ranger: 8 / 0.34s = 23.5/s - 15 regen = -8.5/s -> 100 energy / 8.5 ≈ 11.8s
// All three land in the targeted ~9-13s full-bar-drain window.
export const CLASSES = {
  knight: {
    id: 'knight',
    name: 'Knight',
    role: 'Melee Bruiser',
    desc: 'A steel-clad warrior who wades into the horde with sword and shield.',
    color: 0xb9c4d8, uiColor: '#b9c4d8',
    stats: { maxHp: 135, damage: 15, speed: 6.3, armor: 0.15, crit: 0.08 },
    resource: { name: 'Stamina', max: 100, regen: 12 },
    basic: { kind: 'melee', range: 2.3, arc: Math.PI * 0.65, cooldown: 0.45, basicCost: 9, sound: 'sword_swing', hitSound: 'sword_hit' },
    abilities: [
      {
        id: 'charge', name: 'Charge', icon: '🛡️', cd: 5, cost: 25,
        desc: 'Dash forward, damaging and knocking back everything in your path.',
        exec(game, p) {
          audio.play('charge');
          p.startDash(14, 0.22, { damageMult: 1.4, knockback: 9 });
        },
      },
      {
        id: 'whirlwind', name: 'Whirlwind', icon: '🌀', cd: 6, cost: 30,
        desc: 'Spin in a deadly circle, striking all nearby enemies.',
        exec(game, p) {
          audio.play('whirlwind');
          game.aoeDamage(p.pos.x, p.pos.z, 3.2, p.damage * 1.8, { knockback: 6, source: 'player' });
          game.particles.ring(p.pos.x, 0.6, p.pos.z, 3.2, 0xdadfff);
          p.spinTimer = 0.45;
        },
      },
      {
        id: 'shield_block', name: 'Iron Bulwark', icon: '🔰', cd: 10, cost: 20,
        desc: 'Raise your shield: 70% less damage taken for 3 seconds.',
        exec(game, p) {
          audio.play('shield_block');
          p.addBuff({ id: 'block', duration: 3, damageTakenMult: 0.3 });
          game.particles.burst(p.pos.x, 1, p.pos.z, 14, 0x8ab4ff, { speed: 2, life: 0.5 });
        },
      },
      {
        id: 'war_cry', name: 'War Cry', icon: '📣', cd: 14, cost: 35,
        desc: '+50% damage for 6 seconds and nearby enemies stagger in fear.',
        exec(game, p) {
          audio.play('war_cry');
          p.addBuff({ id: 'warcry', duration: 6, damageMult: 1.5 });
          game.stunEnemiesNear(p.pos.x, p.pos.z, 5, 1.2);
          game.particles.ring(p.pos.x, 1.2, p.pos.z, 5, 0xffb04a);
          game.shake(0.35);
        },
      },
    ],
  },

  mage: {
    id: 'mage',
    name: 'Mage',
    role: 'Ranged Caster',
    desc: 'A scholar of the arcane who bends fire, frost and space itself.',
    color: 0xa06ae8, uiColor: '#b98aff',
    stats: { maxHp: 92, damage: 12, speed: 6.0, armor: 0.0, crit: 0.12 },
    resource: { name: 'Mana', max: 120, regen: 11 },
    basic: { kind: 'bolt', speed: 17, cooldown: 0.42, basicCost: 10, color: 0xc08aff, sound: 'magic_bolt', hitSound: 'magic_bolt' },
    abilities: [
      {
        id: 'fireball', name: 'Fireball', icon: '🔥', cd: 4, cost: 25,
        desc: 'Hurl a blazing orb that explodes and sets enemies on fire.',
        exec(game, p) {
          audio.play('fireball_cast');
          game.spawnProjectile({
            x: p.pos.x, z: p.pos.z, dir: p.aimDir, speed: 13, radius: 0.4,
            damage: p.damage * 2.2, friendly: true, color: 0xff6a2a, size: 0.32,
            aoe: 2.4, status: { burn: { dps: p.damage * 0.5, duration: 3 } },
            hitSound: 'explosion', trail: 0xff8a3a,
          });
        },
      },
      {
        id: 'frost_nova', name: 'Frost Nova', icon: '❄️', cd: 8, cost: 35,
        desc: 'Icy shockwave: damages and drastically slows everything around you.',
        exec(game, p) {
          audio.play('frost_nova');
          game.aoeDamage(p.pos.x, p.pos.z, 4.2, p.damage * 1.3, {
            source: 'player', status: { slow: { mult: 0.35, duration: 3.5 } },
          });
          game.particles.ring(p.pos.x, 0.4, p.pos.z, 4.2, 0x9adfff);
        },
      },
      {
        id: 'blink', name: 'Blink', icon: '✨', cd: 6, cost: 20,
        desc: 'Teleport a short distance toward your cursor.',
        exec(game, p) {
          audio.play('blink');
          game.particles.burst(p.pos.x, 1, p.pos.z, 20, 0xc09aff, { speed: 3, life: 0.4 });
          p.blink(7, game);
          game.particles.burst(p.pos.x, 1, p.pos.z, 20, 0xc09aff, { speed: 3, life: 0.4 });
        },
      },
      {
        id: 'arcane_storm', name: 'Arcane Storm', icon: '🌩️', cd: 14, cost: 55,
        desc: 'Call down a crackling storm around you for 4 seconds.',
        exec(game, p) {
          audio.play('arcane_storm');
          // centered on the player — enemies path toward you, so this maximizes hits
          game.addZone({
            x: p.pos.x, z: p.pos.z, radius: 3.4, duration: 4, tick: 0.4,
            dps: p.damage * 2.4, friendly: true, color: 0xb45eff, spark: true,
          });
        },
      },
    ],
  },

  ranger: {
    id: 'ranger',
    name: 'Ranger',
    role: 'Agile Skirmisher',
    desc: 'A swift hunter striking from range with bow, traps and poison.',
    color: 0x6ac86a, uiColor: '#8ade8a',
    stats: { maxHp: 108, damage: 13, speed: 6.9, armor: 0.05, crit: 0.18 },
    resource: { name: 'Energy', max: 100, regen: 15 },
    basic: { kind: 'bolt', speed: 24, cooldown: 0.34, basicCost: 8, color: 0xd8c890, sound: 'bow_shot', hitSound: 'arrow_hit', arrow: true },
    abilities: [
      {
        id: 'multishot', name: 'Multishot', icon: '🏹', cd: 5, cost: 25,
        desc: 'Loose a fan of five arrows.',
        exec(game, p) {
          audio.play('multishot');
          for (let i = -2; i <= 2; i++) {
            const a = p.aimAngle + i * 0.16;
            game.spawnProjectile({
              x: p.pos.x, z: p.pos.z, dir: { x: Math.cos(a), z: Math.sin(a) },
              speed: 22, radius: 0.3, damage: p.damage * 1.1, friendly: true,
              color: 0xd8c890, size: 0.14, arrow: true, hitSound: 'arrow_hit',
            });
          }
        },
      },
      {
        id: 'dodge_roll', name: 'Dodge Roll', icon: '💨', cd: 4, cost: 15,
        desc: 'Roll quickly in your movement direction, evading all damage.',
        exec(game, p) {
          audio.play('dodge_roll');
          p.startDash(12, 0.28, { invulnerable: true });
        },
      },
      {
        id: 'poison_trap', name: 'Poison Trap', icon: '☠️', cd: 8, cost: 30,
        desc: 'Plant a trap that bursts into lingering poison when an enemy nears.',
        exec(game, p) {
          audio.play('trap_place');
          game.placeTrap({
            x: p.pos.x, z: p.pos.z, radius: 1.2, cloudRadius: 3,
            dps: p.damage * 0.9, duration: 4,
          });
        },
      },
      {
        id: 'rain_arrows', name: 'Rain of Arrows', icon: '🌧️', cd: 13, cost: 50,
        desc: 'After a beat, arrows hammer the area around you.',
        exec(game, p) {
          audio.play('rain_arrows');
          // centered on the player so it lands on the enemies converging on you
          game.addZone({
            x: p.pos.x, z: p.pos.z, radius: 3.6, duration: 2.6, tick: 0.35, delay: 0.6,
            dps: p.damage * 2.6, friendly: true, color: 0xa8e86a, arrows: true,
          });
        },
      },
    ],
  },
};

// ---- Low-poly hero mesh per class ----
export function buildHeroMesh(classDef) {
  const g = new THREE.Group();
  const color = classDef.color;
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2430, roughness: 0.9 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), bodyMat);
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), skinMat);
  head.position.y = 1.45;
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.4, 8), darkMat);
  legs.position.y = 0.2;
  g.add(body, head, legs);

  // Class-specific weapon, held forward on the right
  const weapon = new THREE.Group();
  if (classDef.id === 'knight') {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.85, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: 0.7, roughness: 0.3 }));
    blade.position.y = 0.5;
    const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xc8a03a, metalness: 0.5 }));
    hilt.position.y = 0.08;
    weapon.add(blade, hilt);
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12),
      new THREE.MeshStandardMaterial({ color: 0x4a5a7a, roughness: 0.5 }));
    shield.rotation.z = Math.PI / 2;
    shield.position.set(-0.45, 0.8, 0.1);
    g.add(shield);
  } else if (classDef.id === 'mage') {
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 }));
    staff.position.y = 0.55;
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xc08aff }));
    orb.position.y = 1.3;
    weapon.add(staff, orb);
    // hood
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 8), bodyMat);
    hood.position.y = 1.62;
    g.add(hood);
  } else {
    // ranger bow
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 6, 12, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 }));
    bow.rotation.z = Math.PI / 2;
    bow.position.y = 0.9;
    weapon.add(bow);
    const hoodR = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 8), bodyMat);
    hoodR.position.y = 1.6;
    g.add(hoodR);
  }
  weapon.position.set(0.42, 0.35, 0.15);
  g.add(weapon);
  g.userData.weapon = weapon;

  // simple fake shadow
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  g.add(shadow);

  return g;
}
