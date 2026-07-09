import * as THREE from 'three';
import { FLOOR } from '../world/dungeon.js';
import { TILE, tileToWorld, buildNpcModel } from '../world/meshbuilder.js';
import { roaster } from '../ai/roaster.js';
import { ACT_BOSSES } from './enemies.js';

// Old Fenwick, the Mad Prophet of Embervale. Wanders the square on his own,
// and when you come close he reads YOU — your name, class, wounds, wallet,
// habits (via the movement-learning net) — and hands out quest direction.
// am_fenrir: a deep, characterful male Kokoro voice (higher-graded than am_adam
// in Kokoro's VOICES table) — fitting for a wandering wizard, and unused elsewhere.
const CAST = { female: false, vi: 5, pitch: 0.9, rate: 0.9, kokoro: 'am_fenrir', kSpeed: 0.92 };

export class Wanderer {
  constructor(dungeon, scene) {
    this.scene = scene;
    this.dungeon = dungeon;
    this.pos = new THREE.Vector3();
    this.target = null;
    this.idle = 2;
    this.speakCooldown = 4;
    // Old Fenwick is drawn with a KayKit mage-body model (his voice, am_fenrir,
    // is male; a robed mage reads as a wandering wizard). Built via the shared
    // load-once-cache + clone + idle-mixer helper; his own update() ticks the
    // mixer and turns his head toward the hero. If the GLB isn't loaded the box
    // buildFenwick() below stays as the fallback so he is never invisible.
    this.npc = buildNpcModel('mage', 'Old Fenwick', { gender: 'male', skinTone: 'fair' });
    this.mesh = this.npc ? this.npc.mesh : buildFenwick();
    // start near the notice board if it exists, else mid-green
    const start = dungeon.noticeBoard || { x: 9, y: 12 };
    const w = tileToWorld(start.x + 1, start.y + 1);
    this.pos.set(w.x, 0, w.z);
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
  }

  pickTarget() {
    const g = this.dungeon.grid;
    for (let tries = 0; tries < 30; tries++) {
      const x = 3 + Math.floor(Math.random() * (this.dungeon.size - 6));
      const y = 3 + Math.floor(Math.random() * (this.dungeon.size - 6));
      if (g[y]?.[x] === FLOOR) {
        const w = tileToWorld(x, y);
        if (Math.hypot(w.x - this.pos.x, w.z - this.pos.z) > 4) return new THREE.Vector3(w.x, 0, w.z);
      }
    }
    return null;
  }

  update(dt, game) {
    this.speakCooldown = Math.max(0, this.speakCooldown - dt);
    const p = game.player;
    const dToPlayer = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);

    // advance the modeled rig's idle animation (no-op for the box fallback)
    if (this.npc) this.npc.tick(dt);

    if (dToPlayer < 3) {
      // stop and face the hero — he only speaks when spoken to (interact prompt)
      this.target = null;
      this.mesh.rotation.y = Math.atan2(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
    } else {
      // amble between waypoints
      if (!this.target) {
        this.idle -= dt;
        if (this.idle <= 0) { this.target = this.pickTarget(); this.idle = 1.5 + Math.random() * 3; }
      } else {
        const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4) { this.target = null; }
        else {
          const step = 1.5 * dt;
          const nx = this.pos.x + (dx / d) * step;
          const nz = this.pos.z + (dz / d) * step;
          if (game.isWalkable(nx, nz, 0.3)) {
            this.pos.set(nx, 0, nz);
            this.mesh.rotation.y = Math.atan2(dx, dz);
          } else this.target = null;
        }
      }
      this.mesh.position.copy(this.pos);
      // gentle hobble
      this.mesh.position.y = Math.abs(Math.sin(performance.now() / 240)) * 0.04;
    }

    // Eyes-on-you: when the hero is close, nudge Fenwick's head toward them so
    // the mad prophet tracks the player; relax to rest otherwise. Composes on
    // top of the idle clip (see buildNpcModel.lookAt).
    if (this.npc) {
      if (dToPlayer < 7) this.npc.lookAt(p.pos.x, p.pos.z);
      else this.npc.lookAt(null);
    }
  }

  // Invoked through the interact prompt.
  speakTo(game) {
    if (this.speakCooldown > 0) return;
    this.speakCooldown = 2.5;
    const line = this.composeLine(game);
    game.ui.showSubtitle('Old Fenwick', line, 5000);
    roaster.speakAs(line, CAST, this.pos);
  }

  // Dynamic dialogue built from the player's actual state and habits.
  composeLine(game) {
    const p = game.player;
    const name = game.playerName();
    const cls = p.classDef.name;
    const act = Math.min(5, game.actsCleared + 1);
    const boss = ACT_BOSSES[act].name;
    const options = [];

    // quest direction — Fenwick is the quest giver, this always has weight
    options.push(
      `The seal of Act ${['', 'One', 'Two', 'Three', 'Four', 'Five'][act]} thins. ${boss} holds it. The portal remembers your floor. Go now.`,
      `The stairs below hunger. Cull seven of every ten that walk a floor, and slay the crowned elite. Only then do they open.`,
    );
    if (game.actsCleared === 0 && p.level < 3) {
      options.push(`New boots? Buy a potion from Maribel before you meet the dead. They bite.`);
    }
    // context reads
    if (p.hp < p.maxHp * 0.5) options.push(`You are leaking. Maribel keeps red bottles for exactly this shade of foolish.`);
    if (p.gold > 400) options.push(`${p.gold} gold sings in your pockets. Zoltan hears it too. He always hears it.`);
    if (game.deaths >= 3) options.push(`I have watched you die ${game.deaths} times. The floor grows fond of your face.`);
    if (p.skillPoints() > 0) options.push(`Power sleeps unspent in you. You hold ${p.skillPoints()} mastery point${p.skillPoints() === 1 ? '' : 's'}. Wake it. (Press K, the voices say.)`);
    if (p.potions === 0) options.push(`No potions? Brave. Stupid, but brave.`);
    const legendaries = [...p.inventory, ...Object.values(p.equipped)].filter((i) => i && i.rarity === 'legendary').length;
    if (legendaries > 0) options.push(`That relic you carry hums in my teeth. The deep will want it back.`);
    // class-specific tip
    const classTips = {
      Knight: `Your War Cry frightens even the walls. Shout before you swing.`,
      Mage: `Blink through what you cannot outrun. Space is a suggestion.`,
      Ranger: `Lay the trap FIRST. Then be somewhere else. That is the whole art.`,
    };
    options.push(classTips[cls] || `Swing well, hero.`);
    // habits (movement-learning net)
    if (game.fleeTendency > 0.4) options.push(`You run in circles when frightened. The imps have noticed. I have noticed. Everyone has noticed.`);

    // Greeting-first, like the vendors: an opener, the name woven in only some
    // of the time (never leading, never trailing), then the actual counsel.
    const body = options[Math.floor(Math.random() * options.length)];
    const openers = ['Ah', 'Hm', 'Come closer', 'Listen well', 'There you are', 'The bones stir', 'Well now', 'Mm, good'];
    const opener = openers[Math.floor(Math.random() * openers.length)];
    const nameBit = name && Math.random() < 0.4 ? `, ${name}` : '';
    return `${opener}${nameBit}. ${body}`;
  }

  dispose() {
    this.scene.remove(this.mesh);
  }
}

function buildFenwick() {
  const g = new THREE.Group();
  const robeMat = new THREE.MeshStandardMaterial({ color: 0x4e4862, roughness: 0.95 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x8a7aa8, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8b898, roughness: 0.85 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });

  // layered robe with a belt and hem trim
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.25, 10), robeMat);
  robe.position.y = 0.62;
  const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.45, 0.08, 10), trimMat);
  hem.position.y = 0.06;
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.29, 0.07, 10),
    new THREE.MeshStandardMaterial({ color: 0x6a542e, roughness: 0.7 }));
  belt.position.y = 0.78;
  const chest = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 10), robeMat);
  chest.position.y = 1.15;
  g.add(robe, hem, belt, chest);

  // arms: one resting, one gripping the staff
  const armMat = robeMat;
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.34, 3, 6), armMat);
  armL.position.set(-0.24, 1.05, 0.05);
  armL.rotation.z = 0.5;
  const armR = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.34, 3, 6), armMat);
  armR.position.set(0.3, 1.1, 0.08);
  armR.rotation.z = -0.9;
  const handR = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), skinMat);
  handR.position.set(0.42, 1.05, 0.08);
  g.add(armL, armR, handR);

  // head with face: eyes, brows, nose, big beard
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), skinMat);
  head.position.y = 1.46;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 6), skinMat);
  nose.position.set(0, 1.44, 0.2);
  nose.rotation.x = Math.PI / 2;
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), new THREE.MeshBasicMaterial({ color: 0x9adfff }));
  eyeL.position.set(-0.075, 1.5, 0.17);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.075;
  const browMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 1 });
  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.03), browMat);
  browL.position.set(-0.075, 1.56, 0.18);
  browL.rotation.z = 0.25;
  const browR = browL.clone(); browR.position.x = 0.075; browR.rotation.z = -0.25;
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.55, 8), browMat);
  beard.position.set(0, 1.16, 0.13);
  beard.rotation.x = 0.22;
  const mustL = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.1, 3, 5), browMat);
  mustL.position.set(-0.07, 1.36, 0.18);
  mustL.rotation.z = 1.1;
  const mustR = mustL.clone(); mustR.position.x = 0.07; mustR.rotation.z = -1.1;
  g.add(head, nose, eyeL, eyeR, browL, browR, beard, mustL, mustR);

  // crooked wizard hat with a band
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.045, 12), robeMat);
  brim.position.y = 1.62;
  const hatBand = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.19, 0.07, 10), trimMat);
  hatBand.position.y = 1.67;
  const hatCone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.55, 10), robeMat);
  hatCone.position.set(0.045, 1.9, 0);
  hatCone.rotation.z = -0.22; // bent, like its owner
  const hatTip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), trimMat);
  hatTip.position.set(0.15, 2.13, 0);
  g.add(brim, hatBand, hatCone, hatTip);

  // gnarled staff with a hanging lantern
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.048, 1.75, 6), woodMat);
  staff.position.set(0.44, 0.88, 0.08);
  staff.rotation.z = -0.06;
  const staffTop = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 5, 10), woodMat);
  staffTop.position.set(0.47, 1.78, 0.08);
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12),
    new THREE.MeshBasicMaterial({ color: 0x9adfff }));
  lantern.position.set(0.47, 1.62, 0.08);
  const lanternCap = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.07, 6), woodMat);
  lanternCap.position.set(0.47, 1.73, 0.08);
  g.add(staff, staffTop, lantern, lanternCap);

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  g.add(shadow);
  return g;
}
