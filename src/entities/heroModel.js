import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

// KayKit Adventurers (CC0) animated hero models with per-class animation maps.
const MODEL_FILES = {
  knight: 'models/Knight.glb',
  mage: 'models/Mage.glb',
  ranger: 'models/Rogue_Hooded.glb',
};

const TARGET_HEIGHT = 1.6; // world units

const loaded = new Map(); // classId -> { scene, animations, scale }

export async function preloadHeroModels(onProgress) {
  const loader = new GLTFLoader();
  const entries = Object.entries(MODEL_FILES);
  let done = 0;
  await Promise.all(entries.map(async ([classId, file]) => {
    try {
      const gltf = await loader.loadAsync(import.meta.env.BASE_URL + file);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const height = box.max.y - box.min.y || 1;
      loaded.set(classId, {
        scene: gltf.scene,
        animations: gltf.animations,
        scale: TARGET_HEIGHT / height,
      });
    } catch (err) {
      console.warn(`Hero model failed to load (${file}); primitive fallback will be used.`, err);
    }
    done++;
    if (onProgress) onProgress(done / entries.length);
  }));
}

export function hasHeroModel(classId) {
  return loaded.has(classId);
}

function findClip(animations, patterns) {
  for (const pattern of patterns) {
    const clip = animations.find((a) => pattern.test(a.name));
    if (clip) return clip;
  }
  return null;
}

// ---- deterministic per-name cosmetics ----
// Same hero name always hashes to the same seed, so a multiplayer peer's look
// is consistent for everyone who sees them (and reloading doesn't reshuffle
// your own look either). Exported so classes.js's primitive fallback mesh can
// reuse the same seeding instead of rolling its own.
export function hashSeed(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shifts a material's color by a small per-channel amount so the result reads
// as "a variant of the same color" rather than a random new one. This is a
// multiplicative RGB jitter rather than an HSL hue rotation: several of these
// materials carry a plain white color factor (all the actual color comes from
// the baked texture), and rotating hue on a saturation-0 white is a no-op -
// per-channel jitter still shows up as a visible tint either way.
export function jitterColor(mat, rng, amount = 0.12) {
  const c = mat.color;
  c.r = Math.min(1, Math.max(0.3, c.r * (1 + (rng() - 0.5) * 2 * amount)));
  c.g = Math.min(1, Math.max(0.3, c.g * (1 + (rng() - 0.5) * 2 * amount)));
  c.b = Math.min(1, Math.max(0.3, c.b * (1 + (rng() - 0.5) * 2 * amount)));
}

// Small, cheap per-hero variation seeded from the player's name: a cloth/cape
// tint (always), then a couple of independent rolls for a trim (helmet/hat)
// tint, a subtle skin-tone shift and a scar decal, so most heroes end up with
// 2-3 distinguishing touches. The KayKit rigs fully cover the head with a
// helmet/hood in normal play, so the skin tint and scar are mostly a "looks
// right up close" detail; the cape/trim tints are the visible ones at the
// game's overhead camera distance.
// Muted, readable clothing palettes so a bare hero still looks distinct and
// dressed. Same name always picks the same outfit, so it is consistent on
// reload and identical for every peer who sees that hero in co-op.
const SHIRT_COLORS = [0x9a3b3b, 0x35548f, 0x3a7048, 0x8a6a2a, 0x6a3b7a, 0x2a6a72, 0x7a4632, 0x4a4a5a, 0x8a4a5c, 0x556a34, 0x3b6a6a, 0x8a5a2a];
const PANTS_COLORS = [0x35353f, 0x463628, 0x2a3636, 0x413228, 0x30303a, 0x3a2a2a, 0x2f3a2c, 0x2a2f3a];

// Player-chosen skin tones for character creation. Keep it a short, readable
// spread from very light to deep so each pick reads clearly at the game's
// overhead camera distance. Exported so the char-select UI can render the same
// swatches it will store, keeping picker and model in sync.
export const SKIN_TONES = [
  { id: 'light', label: 'Light', hex: 0xf3c9a6 },
  { id: 'fair', label: 'Fair', hex: 0xe4a878 },
  { id: 'tan', label: 'Tan', hex: 0xc68642 },
  { id: 'brown', label: 'Brown', hex: 0x8d5524 },
  { id: 'deep', label: 'Deep', hex: 0x5a3720 },
];

export const GENDERS = [
  { id: 'male', label: 'Male' },
  { id: 'female', label: 'Female' },
];

export function skinToneById(id) {
  return SKIN_TONES.find((t) => t.id === id) || null;
}

// All three KayKit rigs share one texture atlas laid out as an 8-column palette
// grid, and the top-left tile (UV x:[0,0.125) y:[0.875,1)) is always the skin
// swatch (head + hands sample only that tile; everything else lives in other
// tiles). So to recolor ONLY the skin, we clone the shared texture, repaint
// just that one tile to the chosen tone, and hand the clone back as a fresh
// material map. Cloth/armor tiles are untouched, so a dark-skinned hero still
// wears the same bright tunic. Returns a new THREE.Texture or null if the
// source image is not yet decoded.
function makeSkinTintedTexture(srcTex, hex) {
  const img = srcTex.image;
  if (!img || !img.width) return null;
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  // Skin tile: top-left cell of the 8x8 grid. Image space y grows downward, so
  // UV y:[0.875,1] is the TOP row of pixels.
  const tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
  const data = ctx.getImageData(0, 0, tw, th);
  const px = data.data;
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  // Preserve the tile's baked shading (its light-to-dark gradient) by using each
  // source pixel's luminance to modulate the target tone, so the recolored skin
  // keeps its form instead of going flat.
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    const shade = 0.55 + lum * 0.6; // keep some floor so deep tones don't crush to black
    px[i] = Math.min(255, r * shade);
    px[i + 1] = Math.min(255, g * shade);
    px[i + 2] = Math.min(255, b * shade);
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = srcTex.flipY;
  tex.colorSpace = srcTex.colorSpace;
  tex.wrapS = srcTex.wrapS;
  tex.wrapT = srcTex.wrapT;
  tex.needsUpdate = true;
  return tex;
}

// Repaint the skin tile on every mesh that uses the model's shared atlas
// material. One tinted texture is built once and shared across the hero's
// meshes (cloned material per mesh so it never bleeds to other characters).
function applySkinTone(mesh, hex) {
  let tinted = null, srcMat = null;
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.map) return;
    if (!srcMat) {
      srcMat = o.material;
      tinted = makeSkinTintedTexture(srcMat.map, hex);
    }
    if (!tinted) return;
    o.material = o.material.clone();
    o.material.map = tinted;
    o.material.needsUpdate = true;
  });
}

function applyCosmetics(mesh, name, skinToneHex = null) {
  const rng = mulberry32(hashSeed(name || 'Hero'));
  let headMesh = null, capeMesh = null, trimMesh = null;
  // Base outfit: a name-seeded shirt (torso) and pants (legs) colour so a
  // no-gear hero is clothed and unique rather than the flat default. Tinting
  // multiplies the model's texture (its base colour is white), so it reads as
  // dyed cloth. Cloned per hero so it never bleeds across characters.
  const shirt = SHIRT_COLORS[Math.floor(rng() * SHIRT_COLORS.length)];
  const pants = PANTS_COLORS[Math.floor(rng() * PANTS_COLORS.length)];
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (/_Body$/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(shirt); }
    else if (/_Leg/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(pants); }
  });
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (/Head/i.test(o.name)) headMesh = o;
    else if (/Cape/i.test(o.name)) capeMesh = o;
    else if (/Helmet|Hat/i.test(o.name)) trimMesh = o;
  });

  if (capeMesh) {
    capeMesh.material = capeMesh.material.clone();
    jitterColor(capeMesh.material, rng, 0.22);
    // The baked cape (Mage_Cape/Rogue_Cape/Knight_Cape) is cut wide/long
    // enough that it swings into the forearms and the held weapon at the
    // game's action poses. Narrow it and pull it in toward the back (local
    // -Z, since the rig faces +Z) so it hangs down the back only and stays
    // clear of the front-held weapon and arms, without deleting or hiding it.
    capeMesh.scale.x *= 0.72;
    capeMesh.scale.y *= 0.94;
    capeMesh.position.z -= 0.06;
  }
  if (trimMesh && rng() < 0.7) {
    trimMesh.material = trimMesh.material.clone();
    jitterColor(trimMesh.material, rng, 0.16);
  }
  // A player-chosen skin tone (character creation) wins over the old subtle
  // name-seeded skin jitter: repaint the atlas skin tile so head + hands read
  // as the chosen tone. When no tone is chosen (older saves / peers), fall back
  // to the previous tiny per-name head tint so nothing regresses.
  if (skinToneHex != null) {
    applySkinTone(mesh, skinToneHex);
  } else if (headMesh && rng() < 0.6) {
    headMesh.material = headMesh.material.clone();
    jitterColor(headMesh.material, rng, 0.08);
  }
}

// The rogue model ships with its hood welded into the head mesh (one skinned
// primitive, one texture atlas, no material seam), so there is no scalp geometry
// underneath: the crown and back of the skull exist ONLY as hood cloth. To let a
// helmet visibly replace the hood, we split that cloth off into its own skinned
// mesh at load time so it can be toggled independently. The cloth lives in a
// single tile of the atlas (UV cell x:[0.125,0.25) y:[0.25,0.375)); every skin
// tile is elsewhere, so a per-triangle UV test separates them cleanly. The
// removed triangles leave a gap at the crown, which is why the hood is the
// rogue's DEFAULT head covering and is only hidden when a helmet (which covers
// the same area) is equipped - it is never removed to bare skin, since none
// exists there. Returns the new hood SkinnedMesh (already parented + bound) or
// null if this model has no separable hood.
function splitRogueHood(headMesh) {
  if (!headMesh?.isSkinnedMesh) return null;
  const geo = headMesh.geometry;
  const src = geo.index ? geo.toNonIndexed() : geo.clone();
  const uv = src.getAttribute('uv');
  if (!uv) return null;
  const names = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'tangent', 'color']
    .filter((n) => src.getAttribute(n));
  const headArr = {}, hoodArr = {};
  for (const n of names) { headArr[n] = []; hoodArr[n] = []; }
  const isHood = (i) => Math.floor(uv.getX(i) * 8) === 1 && Math.floor(uv.getY(i) * 8) === 2;
  const triCount = src.getAttribute('position').count / 3;
  let hoodTris = 0;
  for (let t = 0; t < triCount; t++) {
    const a = t * 3, b = a + 1, c = a + 2;
    const votes = (isHood(a) ? 1 : 0) + (isHood(b) ? 1 : 0) + (isHood(c) ? 1 : 0);
    const dst = votes >= 2 ? (hoodTris++, hoodArr) : headArr;
    for (const vi of [a, b, c]) {
      for (const n of names) {
        const at = src.getAttribute(n);
        for (let k = 0; k < at.itemSize; k++) dst[n].push(at.array[vi * at.itemSize + k]);
      }
    }
  }
  if (!hoodTris) return null; // nothing matched: not a hooded model, leave as-is
  const build = (arrs) => {
    const g = new THREE.BufferGeometry();
    for (const n of names) {
      const at = src.getAttribute(n);
      g.setAttribute(n, new THREE.BufferAttribute(new at.array.constructor(arrs[n]), at.itemSize, at.normalized));
    }
    return g;
  };
  const headGeo = build(headArr);
  const hoodGeo = build(hoodArr);
  geo.dispose();
  headMesh.geometry = headGeo;
  const hood = new THREE.SkinnedMesh(hoodGeo, headMesh.material);
  hood.name = 'Rogue_Hood';
  hood.frustumCulled = false;
  hood.castShadow = false;
  hood.receiveShadow = false;
  headMesh.parent.add(hood);
  hood.position.copy(headMesh.position);
  hood.quaternion.copy(headMesh.quaternion);
  hood.scale.copy(headMesh.scale);
  hood.bind(headMesh.skeleton, headMesh.bindMatrix);
  return hood;
}

const CLIP_PATTERNS = {
  idle: [/^idle$/i, /idle_?a/i, /idle/i],
  run: [/^running_a$/i, /run/i, /walk/i],
  attackKnight: [/1h_melee_attack_slice_diagonal/i, /melee_attack_slice/i, /melee_attack_chop/i, /melee_attack/i, /attack/i],
  attackMage: [/spellcast_shoot/i, /spellcast/i, /cast/i, /attack/i],
  attackRanger: [/1h_ranged_shoot/i, /2h_ranged_shoot/i, /ranged_shoot/i, /shoot/i, /attack/i],
  death: [/death_a$/i, /death/i],
};

// Knight-only basic-attack combo: the KayKit rig ships several distinct 1H
// melee clips. player.js still cycles classes.js's variations[] deterministically
// for damage/reach, but the VISUAL swing is picked at random from these clips in
// playAttack (so consecutive swings vary between left-right, right-left and
// up-down arcs instead of a rigid 4-cycle). Falls back to whatever attackKnight
// resolves to if a specific clip isn't present in the GLB. Keys match classes.js's
// knight.basic.variations[].clip.
const KNIGHT_COMBO_PATTERNS = {
  slice_horizontal: [/1h_melee_attack_slice_horizontal/i],
  slice_diagonal: [/1h_melee_attack_slice_diagonal/i],
  chop: [/1h_melee_attack_chop/i],
  stab: [/1h_melee_attack_stab/i],
};

// Returns { mesh, mixer, actions, playing } or null if the model isn't loaded.
// `name` seeds the small deterministic cosmetic variations (see applyCosmetics
// above) so the same hero name always looks the same, for the local player
// and for every peer who sees them in co-op. `opts` carries the character's
// creation choices: { gender: 'male'|'female', skinTone: <SKIN_TONES id> }.
// Skin tone is the clearly visible one (repaints the head/hands); gender is a
// subtle silhouette hint only (the base rigs have no gendered geometry).
export function buildAnimatedHero(classId, name = '', opts = {}) {
  const data = loaded.get(classId);
  if (!data) return null;

  const gender = opts.gender === 'female' ? 'female' : 'male';
  const skinTone = skinToneById(opts.skinTone);

  const mesh = skeletonClone(data.scene);
  mesh.scale.setScalar(data.scale);
  // The KayKit base rigs ship a single body shape with no separate male/female
  // meshes, so gender can only be reflected as a silhouette hint, not real
  // anatomy. A female hero gets a slightly narrower, slightly taller build via a
  // non-uniform scale on the shared scale; a male keeps the stock proportions.
  // This is deliberately subtle so it never distorts the animations.
  if (gender === 'female') {
    mesh.scale.x *= 0.94;
    mesh.scale.z *= 0.94;
    mesh.scale.y *= 1.03;
  }
  let hoodedHead = null, headMesh = null, bakedHat = null;
  mesh.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
      // Headgear is gear-driven: the model's baked-on hat/helmet (KayKit's
      // own authored geometry - e.g. Mage_Hat, Knight_Helmet - fitted to that
      // model's own head/hair) starts hidden and is shown+rarity-tinted by
      // updateHeroGear only when a helmet is actually equipped, so a bare
      // head has no hat and an equipped helmet is the ONLY hat. Kept on
      // userData.bakedHat (rather than only hiding it) so updateHeroGear can
      // toggle and tint the SAME mesh instead of drawing a procedural stand-in
      // - this is the authored asset, already sized/seated to fit the head
      // with no clipping.
      if (/_(Hat|Helmet)$/.test(o.name)) { o.visible = false; bakedHat = o; }
      // The mage rig ships a baked offhand Spellbook mesh that renders as a
      // blocky brick clipping at the hip and adds nothing (the mage already
      // reads by its wand/staff in the main hand for attacks). Hide it, mage
      // only, same treatment as the baked hat above.
      if (classId === 'mage' && /Spellbook|Book/i.test(o.name)) o.visible = false;
      // Track the head so we can (a) anchor equipped helmets to its actual top
      // and (b) split the rogue's welded-in hood off below.
      if (/Head/i.test(o.name)) headMesh = o;
      if (o.isSkinnedMesh && /Head.*Hood|Hood.*Head|Hooded/i.test(o.name)) hoodedHead = o;
    }
  });
  // The KayKit rigs bake EVERY weapon/shield variant for a class into the
  // hand bones at once (e.g. the knight ships 1H_Sword, 2H_Sword AND
  // 1H_Sword_Offhand plus four different shields, all simultaneously
  // visible), so a fresh hero shows several overlapping blades/shields
  // clipping through each other. Keep exactly one sensible held-loadout per
  // class and hide the rest - the kept pieces are baked to fit the hand pose
  // together, so once the duplicates are gone there is nothing left to clip.
  const HELD_LOADOUT = {
    knight: ['1H_Sword', 'Round_Shield'],
    mage: ['2H_Staff'],
    ranger: ['2H_Crossbow'],
  };
  const keepHeld = new Set(HELD_LOADOUT[classId] || []);
  const HELD_PATTERN = /Sword|Shield|Wand|Staff|Crossbow|Bow|Knife|Axe|Hammer|Mace|Dagger|Spear|Throwable/i;
  const heldMeshes = [];
  mesh.traverse((o) => {
    if (o.isMesh && HELD_PATTERN.test(o.name)) {
      if (keepHeld.has(o.name)) heldMeshes.push(o);
      else o.visible = false;
    }
  });
  // Ground-clearance for the kept held weapons. KayKit bakes each weapon at a
  // fixed hand-bone transform authored for a T-pose, so a long piece (the
  // ranger's 2H_Crossbow especially, plus a staff butt or sword tip) can dip
  // below the floor plane (world y=0) at the game's standing/idle pose. We
  // measure each kept weapon's lowest point in the hero root's local space
  // (world matrices updated once for the freshly-cloned rig, still at the
  // origin so root-local == world here) and, if it sits below a small clearance
  // margin, lift the weapon along the hero's up axis by exactly that shortfall.
  // Lifting the mesh's own local position offsets it within its hand bone, so
  // it still tracks the hand through every animation, just seated a touch
  // higher so no end scrapes the ground during idle/movement.
  if (heldMeshes.length) {
    mesh.updateWorldMatrix(true, true);
    const rootInv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const CLEARANCE = 0.02 / data.scale; // small gap above the floor, in local units
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const w of heldMeshes) {
      w.updateWorldMatrix(true, false);
      box.setFromObject(w);
      if (box.isEmpty()) continue;
      // Lowest corner of the world AABB, expressed in hero-root-local space.
      let minLocalY = Infinity;
      for (const cx of [box.min.x, box.max.x]) {
        for (const cy of [box.min.y, box.max.y]) {
          for (const cz of [box.min.z, box.max.z]) {
            v.set(cx, cy, cz).applyMatrix4(rootInv);
            if (v.y < minLocalY) minLocalY = v.y;
          }
        }
      }
      const shortfall = CLEARANCE - minLocalY;
      if (shortfall > 0) {
        // Convert the root-local lift into the weapon's own parent space so the
        // offset moves it straight up in the world regardless of how the hand
        // bone is rotated.
        const up = new THREE.Vector3(0, shortfall, 0);
        const parentInv = new THREE.Matrix4().copy(w.parent.matrixWorld).invert();
        const origin = new THREE.Vector3().applyMatrix4(parentInv);
        const lifted = up.applyMatrix4(mesh.matrixWorld).applyMatrix4(parentInv);
        w.position.add(lifted.sub(origin));
      }
    }
  }
  // Separate the rogue hood so a helmet can replace it (see splitRogueHood).
  // Stored on userData so updateHeroGear can toggle it with the head slot.
  // Its show/hide semantics are its own (default ON, hidden when a helmet
  // is equipped - see updateHeroGear) and stay separate from bakedHat below,
  // which is KayKit's proper Mage_Hat/Knight_Helmet mesh: default OFF, shown
  // only when a helmet is actually equipped. The ranger has no baked hat
  // asset of its own, so its "equipped helmet" look stays the hood toggle.
  if (hoodedHead) mesh.userData.hood = splitRogueHood(hoodedHead);
  mesh.userData.bakedHat = bakedHat;
  // Record where the top of the VISIBLE head sits in the model's local space so
  // updateHeroGear can seat a helmet on the crown. Each class model is a
  // different height (head tops range ~1.9 to 2.3 local units), so a fixed
  // offset buried the helmet inside taller heads. Measured AFTER the hood split
  // so the rogue anchor is the real (uncovered) head top rather than the old
  // hood crown, which would leave the helmet floating above the head.
  if (headMesh) {
    headMesh.geometry.computeBoundingBox();
    const bb = headMesh.geometry.boundingBox;
    mesh.userData.headAnchor = {
      top: bb.max.y,
      cx: (bb.min.x + bb.max.x) / 2,
      cz: (bb.min.z + bb.max.z) / 2,
      r: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2,
    };
  }
  applyCosmetics(mesh, name, skinTone ? skinTone.hex : null);

  // fake blob shadow
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.45 / data.scale, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02 / data.scale;
  mesh.add(shadow);

  const mixer = new THREE.AnimationMixer(mesh);
  const anims = data.animations;
  const attackKey = classId === 'knight' ? 'attackKnight' : classId === 'mage' ? 'attackMage' : 'attackRanger';
  const clips = {
    idle: findClip(anims, CLIP_PATTERNS.idle),
    run: findClip(anims, CLIP_PATTERNS.run),
    attack: findClip(anims, CLIP_PATTERNS[attackKey]),
    death: findClip(anims, CLIP_PATTERNS.death),
  };
  const actions = {};
  for (const [key, clip] of Object.entries(clips)) {
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (key === 'attack' || key === 'death') {
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    }
    actions[key] = action;
  }
  // Knight combo variants: register any of the four 1H melee clips that exist
  // in this GLB as separate one-shot actions under actions.attackCombo[key],
  // so playAttack(variant) can swap which swing plays without touching the
  // default `attack` action other classes/abilities rely on.
  const attackCombo = {};
  if (classId === 'knight') {
    for (const [key, patterns] of Object.entries(KNIGHT_COMBO_PATTERNS)) {
      const clip = findClip(anims, patterns);
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
      attackCombo[key] = action;
    }
  }
  if (actions.idle) actions.idle.play();

  return {
    mesh,
    mixer,
    actions,
    attackCombo,
    current: 'idle',
    _idleT: Math.random() * 10, // desyncs idle sway across multiple heroes on screen
    // Crossfade helper driven from Player.update (and from remote-peer sync in
    // game.js). `speed` is either a 0-1 fraction of full sprint/dash speed, or
    // (for older/remote callers) a plain boolean. `dt` drives the idle
    // breathing sway below and is optional - omit it to just crossfade like
    // before. `attacking` gates the idle sway off so it never fights playAttack.
    setLocomotion(speed, dt, attacking = false) {
      const speed01 = typeof speed === 'number' ? Math.min(1, Math.max(0, speed)) : (speed ? 1 : 0);
      const moving = speed01 > 0.02;
      const want = moving ? 'run' : 'idle';
      // Leaving the frozen whirl pose: stop and un-pause the held attack clip so
      // it stops contributing weight, and restore the run clip's timescale (it
      // was zeroed if there was no attack clip to freeze).
      if (this.current === 'whirl') {
        if (this.actions.attack) { this.actions.attack.paused = false; this.actions.attack.stop(); }
        if (this.actions.run) this.actions.run.setEffectiveTimeScale(1);
        this.current = 'idle';
        if (this.actions.idle) this.actions.idle.reset().play();
      }
      if (want !== this.current && this.actions[want]) {
        const from = this.actions[this.current];
        const to = this.actions[want];
        to.reset().play();
        if (from) from.crossFadeTo(to, 0.18, false);
        this.current = want;
      }
      // Frequency (not amplitude, since these are baked clips) scales with
      // actual speed so a walk and a dash/sprint read as different strides.
      if (this.actions.run) this.actions.run.setEffectiveTimeScale(0.75 + speed01 * 0.9);

      if (!dt) return;
      // Idle breathing sway + occasional weight shift, applied to the rig's
      // root transform rather than individual bones so it never fights the
      // baked idle/run/attack clips. Skipped while moving or mid-attack.
      if (!moving && !attacking) {
        this._idleT += dt;
        this.mesh.position.y = Math.sin(this._idleT * 1.6) * 0.012;
        this.mesh.rotation.z = Math.sin(this._idleT * 0.35) * 0.05;
      } else {
        this.mesh.position.y += (0 - this.mesh.position.y) * Math.min(1, 10 * dt);
        this.mesh.rotation.z += (0 - this.mesh.rotation.z) * Math.min(1, 10 * dt);
      }
      // Per-swing random root lean (set in playAttack): hold it while attacking,
      // ease it back to neutral once the swing ends so it never fights the walk.
      const targetTilt = attacking ? (this._swingTilt || 0) : 0;
      this.mesh.rotation.x += (targetTilt - this.mesh.rotation.x) * Math.min(1, 12 * dt);
    },
    // `variant` picks one of the knight's combo clips (see KNIGHT_COMBO_PATTERNS)
    // for a varied swing; omit it (abilities, other classes) to play the
    // class's single default attack clip as before. Stops whichever combo
    // clip played last so two swing poses never blend together.
    //
    // Swing variety: player.js advances comboIndex deterministically (a rigid
    // 4-cycle), but the caller only passes us the chosen clip NAME - the visual
    // swing is entirely ours to decide. So when a variant is requested we IGNORE
    // the fixed pick and instead roll a random combo clip from whatever this GLB
    // ships, so consecutive swings vary between left-right, right-left and up-down
    // arcs instead of marching through the same order. This is purely cosmetic:
    // damage/timing/reach stay driven by player.js's variation, unchanged. On top
    // of that we jitter the clip's playback speed and add a small random root
    // rotation offset for the duration of the swing, so even repeats of the same
    // clip read as a slightly different range of motion.
    playAttack(variant) {
      let a = this.actions.attack;
      if (variant) {
        const pool = Object.values(this.attackCombo);
        if (pool.length) a = pool[Math.floor(Math.random() * pool.length)];
      }
      if (!a) return;
      for (const other of Object.values(this.attackCombo)) {
        if (other !== a) other.stop();
      }
      a.reset();
      // Small per-swing timescale jitter so the arc's speed/range of motion is
      // never identical twice; centered on the previous fixed 1.8 so DPS pacing
      // (driven by player.js cooldowns, not clip length) is unaffected.
      a.setEffectiveTimeScale(variant ? 1.6 + Math.random() * 0.5 : 1.8);
      a.setEffectiveWeight(1);
      a.play();
      // Tiny random root lean for the swing: a left/right/forward tilt that reads
      // as the hero committing to that particular cut. Cleared as soon as the
      // hero moves or idles (setLocomotion resets rotation.z; _swingTilt below
      // eases rotation.x back). Only for the randomized (knight) swings.
      if (variant) {
        this._swingTilt = (Math.random() - 0.5) * 0.14;
      }
    },
    // Whirlwind pose: freeze the attack clip near mid-swing, where the sword
    // arm is extended out to the side, and hold it there (paused, no time
    // advance) so the blade reads as held out horizontally while the root
    // spins. This is the most convincing static option on a baked skeletal rig
    // without authoring a new clip. Falls back to the run clip if there is no
    // attack action. Call every frame during the whirl; setLocomotion restores
    // normal blending as soon as it stops being called.
    holdWhirlPose() {
      const a = this.actions.attack;
      if (a) {
        const clip = a.getClip();
        if (this.current !== 'whirl') {
          for (const act of Object.values(this.actions)) {
            if (act !== a) act.stop();
          }
          a.reset();
          a.setEffectiveWeight(1);
          a.setEffectiveTimeScale(0); // freeze on the held frame
          a.paused = true;
          a.play();
          this.current = 'whirl';
        }
        // Mid-swing frame: arms/weapon swept out to the side.
        a.time = clip.duration * 0.45;
      } else if (this.actions.run) {
        // no attack clip: at least keep legs planted with the run pose frozen
        const r = this.actions.run;
        if (this.current !== 'whirl') { r.reset().play(); this.current = 'whirl'; }
        r.setEffectiveTimeScale(0);
      }
      // keep the rig root level (no idle sway) during the spin
      this.mesh.position.y = 0;
      this.mesh.rotation.z = 0;
    },
    playDeath() {
      const d = this.actions.death;
      if (!d) return;
      d.reset().play();
    },
    // Undo the death pose on respawn: stop the death clip (which holds its
    // leaning-back final frame) and snap back to idle.
    revive() {
      if (this.actions.death) this.actions.death.stop();
      this.current = 'idle';
      if (this.actions.idle) this.actions.idle.reset().play();
      this.mesh.rotation.x = 0;
      this.mesh.rotation.z = 0;
      this.mesh.position.y = 0;
    },
  };
}
