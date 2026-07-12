import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { hashSeed, mulberry32, jitterColor } from './heroModel.js';

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
    // range/arc below are the fallback/base values (used if variations is absent);
    // the knight always has variations, so meleeAttack actually reads per-swing
    // range/arc/dmgMult off basic.variations[comboIndex] instead. Base range was
    // 2.3; every variation's range sits at 2.8-3.3 (roughly 1.2x-1.4x that) for
    // noticeably better reach on every swing.
    basic: {
      kind: 'melee', range: 2.3, arc: Math.PI * 0.95, cooldown: 0.45, basicCost: 9,
      sound: 'sword_swing', hitSound: 'sword_hit',
      // Combo cycle: 4 swings, each with a different clip + hit shape. The two
      // horizontal cuts are WIDE cleaves - a near-half-circle sweep that carves
      // through a whole cluster in front of the knight - matched by a wide body
      // sweep in heroModel.playAttack so the blade visibly travels that arc.
      // dmgMult keeps per-target damage near 1x (a wide cleave already gains
      // reach by hitting more of the pack, so we do not also pump per-hit).
      // idleResetMs matches the ~1.2s read used by tryBasicAttack to drop the
      // combo back to swing 1 after a pause.
      idleResetMs: 1200,
      variations: [
        { clip: 'slice_horizontal', range: 3.1, arc: Math.PI * 1.15, dmgMult: 0.9 }, // wide left-to-right cleave
        { clip: 'slice_diagonal',   range: 3.1, arc: Math.PI * 1.15, dmgMult: 0.9 }, // wide right-to-left cleave
        { clip: 'chop',             range: 2.9, arc: Math.PI * 0.8,  dmgMult: 1.0 }, // overhead, still broad
        { clip: 'stab',             range: 3.4, arc: Math.PI * 0.5,  dmgMult: 1.15 }, // heavier lunge, narrower but long
      ],
    },
    // AoE (whirlwind) sits LAST, since slot 4 is the "ultimate" slot every class
    // reserves for its area ability, and the cdr4 gear stat only reduces
    // whatever ability currently occupies slot 4.
    // `icon` is a key into src/ui/icons.js (flat-stroke SVG set); the UI
    // renderers inject the SVG markup - no emoji strings here any more.
    abilities: [
      {
        id: 'charge', name: 'Charge', icon: 'charge', cd: 5, cost: 25,
        desc: 'Dash forward, damaging and knocking back everything in your path.',
        exec(game, p) {
          audio.play('charge');
          p.startDash(14, 0.22, { damageMult: 1.4, knockback: 9 });
        },
      },
      {
        id: 'shield_block', name: 'Iron Bulwark', icon: 'shield_block', cd: 10, cost: 20,
        desc: 'Raise your shield: 70% less damage taken for 3 seconds.',
        exec(game, p) {
          audio.play('shield_block');
          p.addBuff({ id: 'block', duration: 3, damageTakenMult: 0.3 });
          game.particles.burst(p.pos.x, 1, p.pos.z, 14, 0x8ab4ff, { speed: 2, life: 0.5 });
        },
      },
      {
        id: 'war_cry', name: 'War Cry', icon: 'war_cry', cd: 14, cost: 35,
        desc: '+50% damage for 6 seconds and nearby enemies stagger in fear.',
        exec(game, p) {
          audio.play('war_cry', { pos: p.pos, gender: p.gender });
          p.addBuff({ id: 'warcry', duration: 6, damageMult: 1.5 });
          game.stunEnemiesNear(p.pos.x, p.pos.z, 5, 1.2);
          game.particles.ring(p.pos.x, 1.2, p.pos.z, 5, 0xffb04a);
          game.shake(0.35);
        },
      },
      {
        id: 'whirlwind', name: 'Whirlwind', icon: 'whirlwind', cd: 8, cost: 35,
        desc: 'Spin for 3 seconds, gliding as if on ice and shredding all nearby enemies.',
        exec(game, p) {
          audio.play('whirlwind');
          // A sustained spin instead of a single burst: the whirl state (player.js)
          // ticks AoE damage around the moving hero, spins the mesh, and puts the
          // player on low-friction "ice" movement for the duration. Per-tick damage
          // is the old one-shot value spread across the ticks, so total damage over
          // the full spin lands near the previous single hit, not a nuke.
          const duration = 3.0;
          const tick = 0.2;
          const perTick = p.damage * 1.8 * (tick / duration) * 3; // ~total 3x the old burst over 3s
          p.startWhirl({ duration, tick, radius: 3.2, perTick, knockback: 3 });
          game.particles.ring(p.pos.x, 0.6, p.pos.z, 3.2, 0xdadfff);
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
        id: 'fireball', name: 'Fireball', icon: 'fireball', cd: 4, cost: 25,
        desc: 'Hurl a blazing orb that explodes and sets enemies on fire.',
        exec(game, p) {
          audio.play('fireball_cast');
          game.spawnProjectile({
            // aimDir, not facingDir (Obsidian 754): cluster-tap auto-aim sets
            // the AIM instantly, but the body only eases toward it - firing
            // along the body's current facing threw the orb wherever the hero
            // happened to be turned, which read as "auto-aim doesn't work".
            x: p.pos.x, z: p.pos.z, dir: { x: p.aimDir.x, z: p.aimDir.z }, speed: 13, radius: 0.4,
            damage: p.damage * 2.2, friendly: true, color: 0xff6a2a, size: 0.32,
            aoe: 2.4, status: { burn: { dps: p.damage * 0.5, duration: 3 } },
            hitSound: 'explosion', trail: 0xff8a3a,
          });
        },
      },
      {
        id: 'frost_nova', name: 'Frost Nova', icon: 'frost_nova', cd: 8, cost: 35,
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
        id: 'blink', name: 'Blink', icon: 'blink', cd: 6, cost: 20,
        desc: 'Teleport a short distance in the direction you face.',
        exec(game, p) {
          audio.play('blink');
          game.particles.burst(p.pos.x, 1, p.pos.z, 20, 0xc09aff, { speed: 3, life: 0.4 });
          p.blink(7, game);
          game.particles.burst(p.pos.x, 1, p.pos.z, 20, 0xc09aff, { speed: 3, life: 0.4 });
        },
      },
      {
        id: 'arcane_storm', name: 'Arcane Storm', icon: 'arcane_storm', cd: 14, cost: 55,
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
        id: 'multishot', name: 'Multishot', icon: 'multishot', cd: 5, cost: 25,
        desc: 'Loose a fan of five arrows.',
        exec(game, p) {
          audio.play('multishot');
          for (let i = -2; i <= 2; i++) {
            const a = p.aimAngle + i * 0.16; // fan centres on the AIM, not the easing body facing (754)
            game.spawnProjectile({
              x: p.pos.x, z: p.pos.z, dir: { x: Math.cos(a), z: Math.sin(a) },
              speed: 22, radius: 0.3, damage: p.damage * 1.1, friendly: true,
              color: 0xd8c890, size: 0.14, arrow: true, hitSound: 'arrow_hit',
            });
          }
        },
      },
      {
        id: 'dodge_roll', name: 'Dodge Roll', icon: 'dodge_roll', cd: 4, cost: 15,
        desc: 'Roll quickly in your movement direction, evading all damage.',
        exec(game, p) {
          audio.play('dodge_roll');
          p.startDash(12, 0.28, { invulnerable: true });
        },
      },
      {
        id: 'poison_trap', name: 'Poison Trap', icon: 'poison_trap', cd: 8, cost: 30,
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
        id: 'rain_arrows', name: 'Rain of Arrows', icon: 'rain_arrows', cd: 13, cost: 50,
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
// `name` seeds the same deterministic cosmetic variation as the animated
// KayKit path (heroModel.js's applyCosmetics) so a hero looks consistent
// whichever path builds it. This mesh is only used if the GLTF model failed
// to load, which in practice basically never happens, but it's kept alive
// (real leg gait, not just a static cylinder) so it doesn't look broken.
export function buildHeroMesh(classDef, name = '') {
  const g = new THREE.Group();
  const color = classDef.color;
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2430, roughness: 0.9 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), bodyMat);
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), skinMat);
  head.position.y = 1.45;
  // two separate legs (was one static cylinder) so they can swing alternately
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.42, 8), darkMat);
  legL.position.set(-0.12, 0.21, 0);
  const legR = legL.clone();
  legR.position.x = 0.12;
  g.add(body, head, legL, legR);

  // Deterministic per-name variation: subtle skin tone + a chance of a
  // cloth/trim tint and a small scar, mirroring heroModel.js's applyCosmetics.
  const rng = mulberry32(hashSeed(name || 'Hero'));
  jitterColor(skinMat, rng, 0.08);
  if (rng() < 0.6) jitterColor(bodyMat, rng, 0.18);
  if (rng() < 0.5) {
    const scar = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.015, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3a1c18, roughness: 0.9 })
    );
    scar.position.set(0.08, 0.02, 0.2);
    scar.rotation.z = 0.4;
    head.add(scar);
  }

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

  // Lightweight procedural gait for this fallback mesh, in the same spirit as
  // enemies.js's limb registry: legs swing alternately while moving (faster
  // swing at higher speed01), and a small idle breathing sway/weight shift
  // otherwise. Driven from Player.update via g.userData.updateGait(dt, speed01, attacking).
  let gaitT = Math.random() * 6; // desyncs multiple heroes on screen
  g.userData.updateGait = (dt, speed01, attacking) => {
    const moving = speed01 > 0.02;
    if (moving) {
      gaitT += dt * (3 + speed01 * 6);
      const amp = 0.32 + speed01 * 0.18;
      legL.rotation.x = Math.sin(gaitT) * amp;
      legR.rotation.x = Math.sin(gaitT + Math.PI) * amp;
      g.position.y = 0;
      g.rotation.z = 0;
    } else {
      legL.rotation.x += (0 - legL.rotation.x) * Math.min(1, 8 * dt);
      legR.rotation.x += (0 - legR.rotation.x) * Math.min(1, 8 * dt);
      if (!attacking) {
        gaitT += dt;
        g.position.y = Math.sin(gaitT * 1.6) * 0.012;
        g.rotation.z = Math.sin(gaitT * 0.35) * 0.05;
      }
    }
  };

  return g;
}
