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
    // is male). Built via the shared load-once-cache + clone + idle-mixer
    // helper; his own update() ticks the mixer and turns his head toward the
    // hero. The bare rig reads as a young player mage, so applyOldWizardLook
    // below restores his original identity (see the old buildFenwick fallback:
    // tall, grey-bearded, bushy-browed, crooked hat, walking staff) on top of
    // the modeled rig. If the GLB isn't loaded the box buildFenwick() stays as
    // the fallback so he is never invisible.
    this.npc = buildNpcModel('mage', 'Old Fenwick', { gender: 'male', skinTone: 'fair' });
    if (this.npc) applyOldWizardLook(this.npc);
    this.mesh = this.npc ? this.npc.mesh : buildFenwick();
    // Fenwick ambles between waypoints, but the shared NPC helper only starts
    // the idle clip, so on the modeled rig he would slide across the square.
    // Grab the rig's idle and run actions off its mixer (buildAnimatedHero
    // already registered them; _actions is the mixer's action list) and
    // crossfade between them from his actual movement each frame (see
    // setWalking below). The run clip is slowed so it reads as an old amble.
    this._idleAction = null;
    this._walkAction = null;
    this._walking = false;
    if (this.npc && this.npc.mixer) {
      const acts = this.npc.mixer._actions || [];
      this._idleAction = acts.find((a) => /idle/i.test(a.getClip().name)) || null;
      this._walkAction = acts.find((a) => /walk/i.test(a.getClip().name))
        || acts.find((a) => /run/i.test(a.getClip().name)) || null;
      if (this._walkAction) this._walkAction.setEffectiveTimeScale(0.62);
    }
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

    let moved = false;
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
            moved = true;
          } else this.target = null;
        }
      }
      this.mesh.position.copy(this.pos);
      // gentle hobble
      this.mesh.position.y = Math.abs(Math.sin(performance.now() / 240)) * 0.04;
    }
    this.setWalking(moved);

    // Eyes-on-you: when the hero is close, nudge Fenwick's head toward them so
    // the mad prophet tracks the player; relax to rest otherwise. Composes on
    // top of the idle clip (see buildNpcModel.lookAt).
    if (this.npc) {
      if (dToPlayer < 7) this.npc.lookAt(p.pos.x, p.pos.z);
      else this.npc.lookAt(null);
    }
  }

  // Crossfade the rig between idle and the slowed walk from whether he
  // actually stepped this frame, so his feet move whenever he does. No-op on
  // the box fallback or if the GLB shipped without the expected clips.
  setWalking(moving) {
    if (!this._walkAction || !this._idleAction || moving === this._walking) return;
    this._walking = moving;
    const to = moving ? this._walkAction : this._idleAction;
    const from = moving ? this._idleAction : this._walkAction;
    to.reset().play();
    from.crossFadeTo(to, 0.25, false);
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

// ---- Old-wizard cosmetic overrides (Fenwick's original identity) ----
// The shared mage rig is a young player mage; Fenwick used to be a distinct
// tall old man (grey beard, bushy brows, hat, staff; see buildFenwick below).
// These overrides rebuild that identity ON TOP of the modeled rig, purely
// cosmetically: no bones, clips or interactions are touched.

// buildNpcModel seats townsfolk at 0.92x hero height; Fenwick was always the
// tall one, so cancel that and land ~1.15x hero height (0.92 * 1.25 = 1.15).
const FENWICK_SCALE = 1.25;

// All three KayKit rigs share one 8x8 atlas texture whose top-left tile is the
// skin swatch (same layout heroModel's skin tinting relies on). Repaint every
// NON-skin texel to a warm grey keyed off its own luminance so the cloth keeps
// its baked shading but loses its dyed color: Gandalf-the-Grey robes. Face and
// hands (skin tile) keep their tone. Returns a CanvasTexture or null if the
// source image is not decoded yet.
function makeGreyClothTexture(srcTex) {
  const img = srcTex && srcTex.image;
  if (!img || !img.width) return null;
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // Skin tile: UV x [0,0.125) y [0.875,1), which is the TOP-LEFT cell in image
  // space (image y grows downward).
  const tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < tw && y < th) continue; // keep the skin tile untouched
      const i = (y * w + x) * 4;
      const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      const shade = 0.25 + lum * 0.75; // keep the baked shading, lift the floor
      px[i] = Math.min(255, 224 * shade);
      px[i + 1] = Math.min(255, 220 * shade);
      px[i + 2] = Math.min(255, 210 * shade);
    }
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = srcTex.flipY;
  tex.colorSpace = srcTex.colorSpace;
  tex.wrapS = srcTex.wrapS;
  tex.wrapT = srcTex.wrapT;
  return tex;
}

// Whiten only the HAIR tile of the atlas so whatever hair shows under the hat
// brim reads grey-white instead of the mage's near-black. In image space the
// hair swatch is the second cell of the TOP row, right next to the skin tile
// (verified by pixel-sampling the atlas: that cell holds the dark hair color).
// The face and skin tiles stay untouched.
function makeWhiteHairTexture(srcTex) {
  const img = srcTex && srcTex.image;
  if (!img || !img.width) return null;
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
  const data = ctx.getImageData(tw, 0, tw, th);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    const shade = 0.75 + lum * 0.25; // hair source is near-black: mostly flat white-grey
    px[i] = Math.min(255, 232 * shade);
    px[i + 1] = Math.min(255, 230 * shade);
    px[i + 2] = Math.min(255, 224 * shade);
  }
  ctx.putImageData(data, tw, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = srcTex.flipY;
  tex.colorSpace = srcTex.colorSpace;
  tex.wrapS = srcTex.wrapS;
  tex.wrapT = srcTex.wrapT;
  return tex;
}

// Long tapered grey beard + moustache + bushy brows, parented to the HEAD BONE
// so the whole face follows the idle sway and the eyes-on-you look-at. The
// head bone's rest orientation is identity in this rig (verified in the GLB),
// so bone space here is simply Y up / Z forward. Constants below are measured
// against Mage.glb in head-bone space: the (chibi-proportioned) head spans
// roughly y -0.15..0.98 and reaches z 0.52 at the nose, so the face plane
// sits near z 0.45-0.52 with the chin around y 0.05.
function buildBeardGroup() {
  const g = new THREE.Group();
  // Near-white with a whisper of emissive so the beard still reads white-grey
  // against the grey robe after dusk (town runs a day/night clock).
  const hairMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 1, emissive: 0x323230 });
  // main beard: cone apex DOWN (tapers to a point), hanging from the chin in
  // front of the chest, tilted a touch forward like it flows off the jaw
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.85, 9), hairMat);
  beard.position.set(0, -0.3, 0.44);
  beard.rotation.x = Math.PI - 0.18;
  g.add(beard);
  // moustache: two drooping strands framing the mouth
  const mustL = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.24, 3, 6), hairMat);
  mustL.position.set(-0.12, 0.16, 0.5);
  mustL.rotation.z = 1.05;
  const mustR = mustL.clone();
  mustR.position.x = 0.12;
  mustR.rotation.z = -1.05;
  g.add(mustL, mustR);
  // bushy brows: chunky angled slabs above the eye line
  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.08), hairMat);
  browL.position.set(-0.18, 0.52, 0.5);
  browL.rotation.z = 0.25;
  const browR = browL.clone();
  browR.position.x = 0.18;
  browR.rotation.z = -0.25;
  g.add(browL, browR);
  return g;
}

// Applies every override to the freshly built npc rig. Clones materials per
// mesh before touching them: skeletonClone shares the source materials across
// every hero/NPC built from the same GLB, so tinting in place would repaint
// player mages too (heroModel's own cosmetics clone some, but not all, of
// them; cloning here again is cheap and safe either way).
function applyOldWizardLook(npc) {
  const mesh = npc.mesh;
  mesh.scale.multiplyScalar(FENWICK_SCALE);

  let headMesh = null, staffMesh = null, srcMap = null;
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    if (/Head/i.test(o.name)) headMesh = o;
    else if (/2H_Staff/i.test(o.name)) staffMesh = o;
    if (!srcMap && o.material && o.material.map) srcMap = o.material.map;
  });

  // wizard hat: the rig's own baked Mage_Hat, hidden by heroModel until a
  // helmet is equipped; Fenwick simply always wears his
  const hat = mesh.userData.bakedHat;
  if (hat) hat.visible = true;

  // grey robes: swap every cloth/gear mesh onto the greyed atlas
  const greyTex = makeGreyClothTexture(srcMap);
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.map) return;
    if (o === headMesh || o === staffMesh) return;
    o.material = o.material.clone();
    if (greyTex) o.material.map = greyTex;
    // reset the name-seeded shirt/pants tints to a plain muted grey multiplier
    // (kept a notch darker than the beard so the white beard pops against it)
    o.material.color.setHex(0xb4b1a9);
    o.material.needsUpdate = true;
  });

  // white hair under the hat brim; face/skin tiles stay as built
  if (headMesh && headMesh.material && headMesh.material.map) {
    const hairTex = makeWhiteHairTexture(headMesh.material.map);
    if (hairTex) {
      headMesh.material = headMesh.material.clone();
      headMesh.material.map = hairTex;
      headMesh.material.needsUpdate = true;
    }
  }

  // walking staff: keep the baked 2H_Staff in hand, tinted to weathered wood
  // so it reads as a walking stick rather than a mage weapon
  if (staffMesh && staffMesh.material) {
    staffMesh.material = staffMesh.material.clone();
    staffMesh.material.color.setHex(0xa08c72);
    staffMesh.material.needsUpdate = true;
  }

  // beard + brows on the head bone so they ride the idle/look-at motion
  if (npc.headBone) npc.headBone.add(buildBeardGroup());
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
