import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

// KayKit Adventurers (CC0) animated hero models with per-class animation maps.
const MODEL_FILES = {
  knight: 'models/Knight.glb',
  mage: 'models/Mage.glb',
  ranger: 'models/Rogue_Hooded.glb',
  // Townsfolk-only bodies (never playable): vendors, barkeep and patrons draw
  // from these so an NPC can never look like the player's hero AND so the six
  // townsfolk don't all collapse onto the same one or two silhouettes. First
  // two are the original KayKit Adventurers pack bodies (same rig/atlas as the
  // hero classes above); the four Town* entries are a separate CC0 pack
  // (Quaternius "RPG Characters") with their own rig and baked-in outfit
  // textures - see the ATLAS_COSMETICS_CLASSES gate below for why they skip
  // the skin/hair tint step.
  barbarian: 'models/Barbarian.glb',
  villager: 'models/Rogue.glb',
  cleric: 'models/TownCleric.gltf',
  monk: 'models/TownMonk.gltf',
  scout: 'models/TownScout.gltf',
  drifter: 'models/TownDrifter.gltf',
};

// Only the original KayKit rigs share the 8x8 palette-atlas layout that
// tintAtlasTile (applySkinTone/applyHairColor below) assumes. The Quaternius
// Town* bodies bake their look into ordinary per-part textures with a
// different layout, so running the atlas tinter on them would recolor an
// arbitrary square of cloth/skin instead of the intended tile - skip the tone
// tint for those classes and let their own baked look stand (they already
// ship distinct skin tones/outfits per class, which is the whole point of
// using them).
const ATLAS_COSMETICS_CLASSES = new Set(['knight', 'mage', 'ranger', 'barbarian', 'villager']);

const TARGET_HEIGHT = 1.6; // world units

// Reused by the arm-driven swing in setLocomotion (no per-frame allocations).
const _swingQ = new THREE.Quaternion();
const _AXIS_X = new THREE.Vector3(1, 0, 0);
const _AXIS_Y = new THREE.Vector3(0, 1, 0);

const loaded = new Map(); // classId -> { scene, animations, scale }

// Mage hooded HEAD (Obsidian 714, replacing the extracted-hood-accessory
// approach of TODO 93/705/707/710 outright): every attempt to drape a hood
// mesh OVER the mage's own haired head leaked hair/skin somewhere - the
// authored hem is genuinely jagged, the mage bakes hair into its head mesh,
// and procedural hair styles add more geometry to escape, so sealing it was
// an unwinnable fit problem. ClaudeCraft never does this: its hooded
// characters use a complete authored hooded HEAD (rogue_hooded.glb), not a
// hood accessory over a haired head. Same move here: when a hood-named
// helmet + robe is worn, updateHeroGear (game.js) hides the mage's entire
// head mesh (and any procedural hair style) and shows this fitted clone of
// the KayKit rogue's authored Rogue_Head_Hooded mesh instead - hood,
// shadowed face mask, face and neck in ONE authored garment. No hair can
// escape a head that is not rendered. Loaded once from Rogue_Hooded.glb by
// preloadHeroModels; stays null (mage keeps the pointy-hat fallback) if the
// file is missing.
let mageHoodedHeadGeo = null;
let mageHoodedHeadMat = null; // the rogue's own atlas material, template for per-instance clones
// Bind-pose bbox anchor of Rogue_Head_Hooded, measured directly from
// Rogue_Hooded.glb's vertex data (same convention as headAnchor below:
// top = bbox top, cx/cz = bbox centre, r = max(width, depth)/2). Every mage
// instance rescales/repositions from this fixed source anchor onto its own
// real headAnchor at build time.
const MAGE_HOODED_HEAD_ANCHOR = { top: 2.2512, cx: 0, cz: 0.0108, r: 0.5783 };

// Atlas tiles the hooded head samples (verified by UV-bucketing its vertex
// data against the shared 8x8 palette grid): (col 0, row 1) is the rogue's
// own skin swatch (the visible face), (col 1, rows 2 and 3) are the
// hood-cloth greens, (col 2, row 0) is the near-black face-mask/hood-shadow
// and (col 1, rows 0 and 1) are leather trims (both left alone). Repaints
// face -> the player's chosen skin tone and cloth -> the equipped hood's
// rarity colour by chaining tintAtlasTile. IMPORTANT: always call this on
// the PRISTINE template map, never on its own previous output -
// tintAtlasTile derives shading from the current pixels, so re-tinting an
// already-tinted tile compounds darker on every equip change.
export function tintHoodedHeadMap(srcTex, skinHex, rarityHex) {
  let t = tintAtlasTile(srcTex, 0, 1, skinHex);
  if (!t) return null;
  t = tintAtlasTile(t, 1, 2, rarityHex) || t;
  t = tintAtlasTile(t, 1, 3, rarityHex) || t;
  return t;
}

// Roughly how much of a held weapon's length (measured outward from the
// hand-bone pivot, which is this mesh's local origin) belongs to the
// grip/hilt versus the blade/head - used by splitWeaponMesh below so
// updateHeroGear (game.js) can give each region its own real material
// (metal blade, wood/leather grip) instead of tinting the whole weapon
// one flat hue.
function weaponGripFraction(name) {
  if (/Staff|Wand/i.test(name)) return 0.62; // long wood shaft, ornamental head at the tip
  if (/Crossbow|Bow/i.test(name)) return 0.42; // stock/grip vs. bow arm + mechanism
  return 0.32; // sword/knife/dagger/axe/mace/hammer/spear: short grip, long blade/head
}

// Splits a held weapon's single baked mesh into two triangle-index groups -
// grip/hilt (material slot 0) and blade/head (material slot 1) - by each
// triangle's average distance from the hand-bone pivot (this mesh's local
// origin) along its longest axis. KayKit bakes one shared material per whole
// character model (not one per weapon part), so without this split a rarity
// tint multiplies the ENTIRE weapon one flat hue (the "orange sword" bug).
// Cheap and one-time per geometry: guarded by geo.userData.weaponSplit so
// re-running on a shared geometry (skeletonClone shares geometry across
// hero instances) is a no-op on the second+ call. Returns null (and leaves
// the geometry untouched) when there's no index buffer or the split would be
// degenerate (everything on one side) - callers then fall back to a single
// steel material for the whole mesh, which still reads as metal rather than
// a flat rarity-colored blob.
export function splitWeaponMesh(mesh) {
  const geo = mesh.geometry;
  if (!geo || !geo.index) return null;
  if (geo.userData.weaponSplit) return geo.userData.weaponSplit;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ext = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  const axis = ext.x >= ext.y && ext.x >= ext.z ? 'x' : ext.z >= ext.y ? 'z' : 'y';
  const pos = geo.attributes.position;
  const getA = axis === 'x' ? (i) => pos.getX(i) : axis === 'y' ? (i) => pos.getY(i) : (i) => pos.getZ(i);
  let maxAbs = 0;
  for (let i = 0; i < pos.count; i++) { const a = Math.abs(getA(i)); if (a > maxAbs) maxAbs = a; }
  if (maxAbs < 1e-6) return null;
  const threshold = maxAbs * weaponGripFraction(mesh.name);
  const idxArr = geo.index.array;
  const gripTris = [], headTris = [];
  for (let t = 0; t < idxArr.length; t += 3) {
    const a = idxArr[t], b = idxArr[t + 1], c = idxArr[t + 2];
    const avg = (Math.abs(getA(a)) + Math.abs(getA(b)) + Math.abs(getA(c))) / 3;
    (avg <= threshold ? gripTris : headTris).push(a, b, c);
  }
  if (!gripTris.length || !headTris.length) return null;
  const Ctor = idxArr.constructor;
  const newIndex = new Ctor(gripTris.length + headTris.length);
  newIndex.set(gripTris, 0);
  newIndex.set(headTris, gripTris.length);
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1));
  geo.clearGroups();
  geo.addGroup(0, gripTris.length, 0); // grip/hilt -> material[0]
  geo.addGroup(gripTris.length, headTris.length, 1); // blade/head -> material[1]
  geo.userData.weaponSplit = { grip: 0, head: 1 };
  return geo.userData.weaponSplit;
}

export async function preloadHeroModels(onProgress) {
  const loader = new GLTFLoader();
  const entries = Object.entries(MODEL_FILES);
  let done = 0;
  await Promise.all(entries.map(async ([classId, file]) => {
    try {
      const gltf = await loader.loadAsync(import.meta.env.BASE_URL + file);
      // Normalize by the BODY height, not the full scene (Obsidian 762): the
      // scene bbox includes every baked weapon variant (a tall 2H staff, a
      // raised crossbow) and hats/hoods, which get hidden at build time - so
      // dividing by the full height scaled classes with tall props DOWN,
      // leaving their actual bodies different sizes in the preview and world.
      // Measure only the character meshes (skip held weapons + headgear) so
      // all three classes stand at the same real height.
      const WEAPON_RE = /1H_|2H_|Knife|Throwable|Bow|Crossbow|Shield|Wand|Staff|Spellbook|\bBook\b|Dagger|Sword|Axe|Mace|Hammer|Spear|Quiver/i;
      const HAT_RE = /_(Hat|Helmet)\b|Hat$|Helmet$/i;
      const bodyBox = new THREE.Box3();
      let anyBody = false;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (WEAPON_RE.test(o.name) || HAT_RE.test(o.name)) return;
        bodyBox.expandByObject(o);
        anyBody = true;
      });
      const box = anyBody ? bodyBox : new THREE.Box3().setFromObject(gltf.scene);
      const height = box.max.y - box.min.y || 1;
      // Strip bone-SCALE tracks from every clip (Obsidian 760/809): the KayKit
      // exports key a constant 1.0 scale on each bone, which made the mixer
      // stomp the female silhouette's static bone scales every frame. Dropping
      // the (visually inert) scale tracks changes nothing for males and lets
      // the reshaped female skeleton survive animation.
      for (const clip of gltf.animations) {
        clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale'));
      }
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
  // Mage hooded head (see mageHoodedHeadGeo above) - the complete authored
  // hooded head lifted from the rogue's hooded rig variant, loaded alongside
  // the class rigs so it is ready before any buildAnimatedHero('mage', ...)
  // call. Failure just leaves it null; the mage still gets its baked
  // pointy-hat fallback (see updateHeroGear in game.js), never a blank slot.
  try {
    const gltf = await loader.loadAsync(import.meta.env.BASE_URL + 'models/Rogue_Hooded.glb');
    let found = null;
    gltf.scene.traverse((o) => { if (!found && o.isMesh && /Rogue_Head_Hooded/i.test(o.name)) found = o; });
    if (found) { mageHoodedHeadGeo = found.geometry; mageHoodedHeadMat = found.material; }
    else console.warn('Rogue_Hooded.glb loaded but no Rogue_Head_Hooded mesh found; mage keeps its pointy hat.');
  } catch (err) {
    console.warn('Hooded head asset failed to load; the mage will keep its baked pointy hat.', err);
  }
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

// Player-chosen hair colors for character creation. Same 8x8 atlas grid as
// SKIN_TONES above; the hair tile (see tintAtlasTile's col:1/row:0 below) gets
// the same treatment. A null/missing id means "leave the rig's own baked hair
// alone" (old saves, peers who haven't picked one yet).
export const HAIR_TONES = [
  { id: 'black', label: 'Black', hex: 0x1b1712 },
  { id: 'darkbrown', label: 'Dark Brown', hex: 0x3b2a1a },
  { id: 'chestnut', label: 'Chestnut', hex: 0x6b3d22 },
  { id: 'auburn', label: 'Auburn', hex: 0x8a3220 },
  { id: 'blonde', label: 'Blonde', hex: 0xd8b26a },
  { id: 'platinum', label: 'Platinum', hex: 0xe8e2d0 },
  { id: 'grey', label: 'Grey', hex: 0xb0aca4 },
  { id: 'blue', label: 'Blue', hex: 0x3a6ea8 },
];

export function hairToneById(id) {
  return HAIR_TONES.find((t) => t.id === id) || null;
}

// Player-chosen eye colors for character creation. Unlike SKIN_TONES/HAIR_TONES
// above, the KayKit atlas has no dedicated flat-color eye tile - the iris/pupil
// detail is painted directly into the head texture at the eyes' fixed UV spot,
// so tintAtlasTile can't retint just that (it would also recolor the skin
// pixels sharing the same tile). See addEyeDiscs below for how this is applied
// instead. Brown is the default so an untouched/old save still shows a normal
// eye colour rather than nothing.
export const EYE_COLORS = [
  { id: 'brown', label: 'Brown', hex: 0x4a2f1a },
  { id: 'blue', label: 'Blue', hex: 0x3a6ea8 },
  { id: 'green', label: 'Green', hex: 0x3a8a52 },
  { id: 'amber', label: 'Amber', hex: 0xc08a2a },
  { id: 'violet', label: 'Violet', hex: 0x6a4a9a },
  { id: 'grey', label: 'Grey', hex: 0x8a8a90 },
];

export function eyeColorById(id) {
  return EYE_COLORS.find((t) => t.id === id) || null;
}

// Player-chosen face shape for character creation. Honest limit: these KayKit
// rigs ship no morph targets, so a real jaw/cheekbone reshape isn't possible.
// Instead each option is a subtle non-uniform scale applied to the HEAD MESH
// NODE only (never the skeleton/bones), so every animation keeps working
// completely untouched. 'standard' is a no-op (stock proportions).
// Face shape scales the head node (Obsidian 810). The old deltas (~6%) were so
// small the selector looked like it did nothing; widened to ~15% so Narrow
// (taller + slimmer) and Round (broader + shorter) read clearly distinct from
// Standard without distorting the eyes/features.
export const FACE_SHAPES = [
  { id: 'standard', label: 'Standard', sx: 1, sy: 1 },
  { id: 'narrow', label: 'Narrow', sx: 0.85, sy: 1.1 },
  { id: 'round', label: 'Round', sx: 1.16, sy: 0.92 },
];

export function faceShapeById(id) {
  return FACE_SHAPES.find((t) => t.id === id) || FACE_SHAPES[0];
}

// Player-chosen hair style for character creation. Doubles as hair LENGTH
// (Short/Ponytail/Bun/Long). 'short' is a no-op: the rig's own baked hair,
// unchanged (for the female mage this IS a ponytail already - see the
// stripMagePonytail wiring in buildAnimatedHero, which strips that baked tail
// for 'short' the same way it always has for male mages). The other three
// options add small procedural meshes anchored to the head (see addHairMesh
// below) so they work uniformly across classes whose rigs have no baked
// long-hair geometry of their own.
export const HAIR_STYLES = [
  { id: 'short', label: 'Short' },
  { id: 'ponytail', label: 'Ponytail' },
  { id: 'bun', label: 'Bun' },
  { id: 'long', label: 'Long' },
];

export function hairStyleById(id) {
  return HAIR_STYLES.find((t) => t.id === id) || HAIR_STYLES[0];
}

// Lays two small unlit discs over the head mesh's baked-eye position to stand
// in for a real eye-colour retint (see EYE_COLORS comment above for why the
// atlas-tile route doesn't work here). Positions are estimated from the head
// mesh's own local geometry bounding box (the same box buildAnimatedHero
// measures for the helmet headAnchor) rather than a fixed constant, since the
// three playable rigs (Knight/Mage/Rogue_Hooded) are each a different height
// and head size.
//
// Positioned in bind-pose model space (the space the head geometry/bbox is
// authored in), then re-parented onto the HEAD BONE via anchorToHeadBone so
// the discs ride the walk/idle head animation. The first version left them
// parented to the root: the head bobbed away mid-walk while the static discs
// stayed at the bind pose - "brown circles float off my eyes when I move"
// (user bug report). Object3D.attach() does the world-transform-preserving
// reparent, so none of the bind-space numbers here change.
// Re-parents `obj` (placed in bind-pose root space as a child of `mesh`)
// onto the rig's head bone WITHOUT moving it: attach() preserves the world
// transform across the reparent, converting position/rotation/scale into
// bone-local terms. After this the object follows every head-bone animation
// (walk bob, glance, attack squash) exactly like the baked hats do. No-ops
// (leaves root parenting) when the rig has no named head bone.
function anchorToHeadBone(mesh, obj) {
  let bone = null;
  mesh.traverse((o) => { if (!bone && o.isBone && /^head$/i.test(o.name)) bone = o; });
  if (!bone) return;
  mesh.updateMatrixWorld(true);
  bone.attach(obj);
}

// Same attach() move for BODY-worn gear (Obsidian 725): the procedural gear
// visuals (robe skirt, breastplate, tabard...) were parented to the hero
// ROOT, so they sat frozen in rig space while the skinned body bobbed and
// leaned through the walk cycle - the robe waist band visibly "not moving
// with the player". Riding the hips/spine bone gives them the body's own
// bounce/turn. Exported for updateHeroGear (game.js).
export function anchorToBodyBone(mesh, obj) {
  let bone = null;
  mesh.traverse((o) => { if (!bone && o.isBone && /hips|pelvis|spine|torso|body/i.test(o.name)) bone = o; });
  if (!bone) return false;
  mesh.updateMatrixWorld(true);
  bone.attach(obj);
  return true;
}

function addEyeDiscs(mesh, headMesh, hex) {
  if (!headMesh) return;
  headMesh.geometry.computeBoundingBox();
  const bb = headMesh.geometry.boundingBox;
  const w = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  const d = bb.max.z - bb.min.z;
  // Eyes sit a bit above the head's vertical middle (below the crown, above
  // the chin) and toward the front face (the rig faces +Z). Pushed slightly
  // PAST the geometry's own max-Z (rather than just short of it) because the
  // face surface at eye height/width is not as far forward as the bounding
  // box's overall max (that peak belongs to the nose/chin) - sitting exactly
  // at or under that surface let the baked face z-fight/occlude the discs.
  const eyeY = bb.max.y - h * 0.56; // ON the baked eye line (0.5 sat at the brow)
  const eyeZ = bb.max.z + d * 0.03;
  const eyeX = w * 0.15; // centered ON the baked pupils (0.22 sat at the outer corners)
  // ~35% smaller than the first pass: at w*0.06 the discs read as stickers
  // pasted over the whole eye socket rather than irises inside it.
  const geo = new THREE.CircleGeometry(Math.max(0.012, w * 0.05), 10);
  const mat = new THREE.MeshBasicMaterial({ color: hex });
  for (const side of [-1, 1]) {
    const disc = new THREE.Mesh(geo, mat);
    disc.position.set(side * eyeX, eyeY, eyeZ);
    disc.renderOrder = 2;
    disc.frustumCulled = false;
    mesh.add(disc);
    anchorToHeadBone(mesh, disc); // ride the head animation (see helper above)
  }
}

// The Quaternius Town* rigs (cleric/monk/scout/drifter) have no separate
// "Head" MESH the way the KayKit rigs do (addEyeDiscs above needs
// headMesh.geometry.boundingBox to place discs) - their entire body,
// including the head, is one single skinned mesh with generic Blender export
// names (Cube.003, _ncl1_29.004, etc), and that mesh's shared baked texture
// has no painted eyes/mouth anywhere on it (verified by rendering all four
// GLTFs standalone and inspecting the atlas image directly - this is the true
// root cause of TODO 690's "faceless Maribel/Zoltan/patrons" bug, not
// anything buildAnimatedHero strips). So instead of measuring a dedicated
// head mesh, this walks the skinned mesh's own POSITION/skinIndex/skinWeight
// buffers to find the subset of vertices predominantly weighted to the
// "Head" bone (>50% weight) and takes THEIR bounding box - the equivalent of
// headMesh.geometry.boundingBox but for a rig that never separated the head
// into its own mesh. Works for any of the four Town* rigs without needing
// per-class hardcoded numbers.
function computeSkinnedHeadBBox(mesh) {
  let skinned = null;
  mesh.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
  if (!skinned) return null;
  let headBone = null;
  mesh.traverse((o) => { if (!headBone && o.isBone && /^head$/i.test(o.name)) headBone = o; });
  if (!headBone) return null;
  const boneIdx = skinned.skeleton.bones.indexOf(headBone);
  if (boneIdx < 0) return null;
  const geo = skinned.geometry;
  const pos = geo.attributes.position;
  const skinIndex = geo.attributes.skinIndex;
  const skinWeight = geo.attributes.skinWeight;
  if (!pos || !skinIndex || !skinWeight) return null;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (skinIndex.getComponent(i, k) === boneIdx) w += skinWeight.getComponent(i, k);
    }
    if (w > 0.5) {
      v.fromBufferAttribute(pos, i);
      box.expandByPoint(v);
    }
  }
  return box.isEmpty() ? null : box;
}

// Gives the faceless Quaternius townsfolk (TODO 690) simple painted-on eyes:
// two small dark discs over the head-vertex bounding box computed above,
// anchored to the same head bone the KayKit addEyeDiscs rides (see
// anchorToHeadBone). A fixed dark hex (not a player-facing EYE_COLORS choice
// - these classes have no character-creation UI) so every townsfolk reads as
// having eyes regardless of their random per-name skin jitter.
const TOWNSFOLK_EYE_HEX = 0x241a12;
function addTownEyeDiscs(mesh) {
  const box = computeSkinnedHeadBBox(mesh);
  if (!box) return;
  const w = box.max.x - box.min.x;
  const h = box.max.y - box.min.y;
  const d = box.max.z - box.min.z;
  const eyeY = box.max.y - h * 0.54; // mid-face: 0.42 sat at the hairline (bbox includes hood/hair volume above the face)
  // Pushed well past the head's own frontmost vertex (unlike KayKit's
  // addEyeDiscs above, which only needs a d*0.03 nudge because it measures a
  // SEPARATE, tightly-fit head mesh) - this bbox comes from ALL vertices
  // skinned to the Head bone, which includes geometry that recedes behind the
  // actual face surface at eye height/width (the rounded Quaternius head is
  // widest partway back, not exactly at eye level), so a small nudge still
  // left the discs depth-occluded by the face surface in testing (invisible
  // even though their world position was correct). The d*0.18 standoff alone
  // is enough clearance; depthTest stays ON so the eyes never shine through
  // hoods, helmets or walls.
  const eyeZ = box.max.z + d * 0.18;
  const eyeX = w * 0.24;
  const geo = new THREE.CircleGeometry(Math.max(0.012, w * 0.09), 10);
  const mat = new THREE.MeshBasicMaterial({ color: TOWNSFOLK_EYE_HEX }); // depthTest stays ON: depthTest:false made eyes shine through hoods/walls
  for (const side of [-1, 1]) {
    const disc = new THREE.Mesh(geo, mat);
    disc.position.set(side * eyeX, eyeY, eyeZ);
    disc.renderOrder = 2;
    disc.frustumCulled = false;
    mesh.add(disc);
    anchorToHeadBone(mesh, disc);
  }
}

// Builds the procedural mesh for a chosen hair STYLE (see HAIR_STYLES above),
// tinted to match the chosen hair colour exactly (same hex the baked hair
// tile gets - see applyHairColor). Same measurement approach and same
// rationale as addEyeDiscs directly above: offsets are derived proportionally
// from the head mesh's own local geometry bounding box (bind-pose model
// space) rather than a fixed constant, and the resulting group is parented to
// the hero ROOT (not the head bone) for the identical reason addEyeDiscs is -
// reusing these numbers as a bone-local offset would double-count the
// neck-to-crown distance. Returns the built THREE.Group (already added to
// `mesh`), or null for 'short' (no-op, handled by the caller before this is
// even invoked) or if there's no head geometry to measure.
function addHairMesh(mesh, headMesh, style, hex) {
  if (!headMesh || style === 'short') return null;
  headMesh.geometry.computeBoundingBox();
  const bb = headMesh.geometry.boundingBox;
  const w = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  const d = bb.max.z - bb.min.z;
  const cx = (bb.min.x + bb.max.x) / 2;
  const mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0.05 });
  const group = new THREE.Group();
  // These rigs are stylized "chibi" proportions (an oversized head - the
  // Knight_Head bounding box alone measures roughly half the character's
  // total height), so a real anatomical "hair reaches the shoulder" length
  // works out to about ONE head-height (h) below the crown, not several -
  // tuned against actual screenshots rather than assumed from a normal
  // human head/body ratio. Offsets are pushed a visible distance behind the
  // head's own back surface (bb.min.z, since the rig faces +Z) so the hair
  // reads as a separate volume floating just off the skull rather than a
  // seam painted flush onto the baked head texture.
  if (style === 'ponytail') {
    // ONE smooth ponytail (Obsidian 811): the old three separate capsules read
    // as "three lumps hanging off the neck". Now a gathered TIE knot at the
    // back crown feeds a single continuous tapered tail (a lathe profile - thick
    // at the tie, tapering smoothly to a point) that sweeps down and back.
    // Fix (image 120): the tie used to FLOAT just off the crown and the tail's
    // top ring - wider than the tie - swept outward at -0.34, so from the side
    // an ugly flat wedge "connector" showed between the ball and the skull.
    // The tie is now half-EMBEDDED in the back of the skull (no gap at any
    // angle) and the tail emerges from INSIDE the tie (top radius < tie radius)
    // hanging close to the head with only a slight sweep.
    const tieR = w * 0.15;
    const tie = new THREE.Mesh(new THREE.SphereGeometry(tieR, 12, 10), mat);
    tie.scale.set(1, 0.9, 1.05);
    tie.position.set(cx, bb.max.y - h * 0.16, bb.min.z + d * 0.02);
    tie.castShadow = false; tie.receiveShadow = false; tie.frustumCulled = false;
    group.add(tie);
    const tailPts = [
      [w * 0.10, 0],
      [w * 0.14, -h * 0.25],
      [w * 0.115, -h * 0.55],
      [w * 0.07, -h * 0.85],
      [w * 0.02, -h * 1.0],
      [w * 0.008, -h * 1.05],
    ].map(([r, y]) => new THREE.Vector2(Math.max(0.008, r), y));
    const tail = new THREE.Mesh(new THREE.LatheGeometry(tailPts, 12), mat);
    tail.position.copy(tie.position);
    tail.rotation.x = -0.12; // hangs close behind the head, slight outward sweep
    tail.castShadow = false; tail.receiveShadow = false; tail.frustumCulled = false;
    group.add(tail);
  } else if (style === 'bun') {
    // A single squashed sphere sitting high at the back crown.
    const bun = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.025, w * 0.2), 12, 10), mat);
    bun.scale.set(1, 0.66, 0.9);
    bun.position.set(cx, bb.max.y - h * 0.08, bb.min.z + d * 0.03); // embedded - no gap at any angle
    bun.castShadow = false; bun.receiveShadow = false; bun.frustumCulled = false;
    group.add(bun);
  } else if (style === 'long') {
    // A draped back-SHELL swept around the rear half of the skull (lathe
    // profile, same technique as the mage hood): crown-hugging at the top,
    // bulging just past the skull's back, then tapering to a soft rounded
    // tip about one head-height below (chibi shoulder length - see note
    // above). The earlier flattened-cylinder panel rendered as a hard-edged
    // rectangular SLAB from behind; a revolved profile drapes around the
    // sides like real hair instead. LatheGeometry's phi=0 sits at +Z (the
    // face), so sweeping [PI/2, 3PI/2] covers exactly the back half.
    const cz = (bb.min.z + bb.max.z) / 2;
    // Draped back-shell that now falls LONGER, past the neck and OVER the collar
    // (Obsidian 811): stays wide down to ~1.3 head-heights so it rests on the
    // shoulders instead of stopping at the neck, then tapers to a soft tip.
    // Slimmed + tucked (image 124: the old profile bulged past the skull with a
    // visible top rim and a flat mid-section - it read as a SHIELD/turtle shell
    // strapped to the back, not hair). The rim now starts against the skull's
    // own radius just below the crown and the curve tapers continuously.
    const pts = [
      [d * 0.46, -h * 0.02],  // tucked against the skull - no exposed rim
      [d * 0.54, -h * 0.35],
      [d * 0.52, -h * 0.75],
      [d * 0.44, -h * 1.1],
      [d * 0.26, -h * 1.45],  // drapes onto the collar, tapering the whole way
      [d * 0.06, -h * 1.6],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const shell = new THREE.Mesh(
      new THREE.LatheGeometry(pts, 16, Math.PI / 2, Math.PI),
      new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide }));
    shell.position.set(cx, bb.max.y - h * 0.05, cz);
    shell.castShadow = false; shell.receiveShadow = false; shell.frustumCulled = false;
    group.add(shell);
  }
  if (!group.children.length) return null;
  group.frustumCulled = false;
  mesh.add(group);
  anchorToHeadBone(mesh, group); // hair rides the head animation too
  return group;
}

// All three KayKit rigs share one texture atlas laid out as an 8-column palette
// grid. The top-left tile (UV x:[0,0.125) y:[0.875,1)) is the skin swatch (head
// + hands sample only that tile) and the tile immediately to its right (col 1,
// same row) is the hair swatch (verified in wanderer.js's makeWhiteHairTexture).
// Recoloring either tile clones the shared texture onto a canvas, repaints just
// that one cell to the chosen tone (preserving the tile's baked light-to-dark
// shading via luminance), and hands the clone back as a fresh material map -
// every other tile (cloth/armor/etc.) is untouched. `srcTex` may itself already
// be a previously-tinted CanvasTexture (e.g. skin tint applied first, then hair)
// so chained calls extend the same canvas lineage instead of re-deriving from
// scratch twice. Returns a new THREE.Texture or null if the source image isn't
// decoded yet.
function tintAtlasTile(srcTex, col, row, hex) {
  const img = srcTex && srcTex.image;
  if (!img || !img.width) return null;
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
  const tx = col * tw, ty = row * th;
  const data = ctx.getImageData(tx, ty, tw, th);
  const px = data.data;
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    const shade = 0.55 + lum * 0.6; // keep some floor so deep tones don't crush to black
    px[i] = Math.min(255, r * shade);
    px[i + 1] = Math.min(255, g * shade);
    px[i + 2] = Math.min(255, b * shade);
  }
  ctx.putImageData(data, tx, ty);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = srcTex.flipY;
  tex.colorSpace = srcTex.colorSpace;
  tex.wrapS = srcTex.wrapS;
  tex.wrapT = srcTex.wrapT;
  // No mipmaps (Obsidian 713): auto-generated mips average this repainted
  // tile with its untouched (light) neighbor tiles across the 8x8 grid, so a
  // DARK skin/hair tint sampled at smaller mip levels grows white seam lines
  // exactly at the UV island borders (hairline, neck). The atlas is flat toon
  // color, so plain bilinear sampling of the full-res canvas loses nothing.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Repaint the skin tile (grid cell 0,0) on every mesh that uses the model's
// shared atlas material. One tinted texture is built once and shared across
// the hero's meshes (cloned material per mesh so it never bleeds to other
// characters).
// The KayKit atlas holds skin in MORE THAN ONE tile (Obsidian 761): the face
// samples (0,0), but the neck/chin/hairline sample additional skin swatches at
// (0,1) and (1,1). Tinting only (0,0) recoloured the face but left a light
// "white" neck under a dark face. We tint ALL skin swatches - but NOT the hair
// tile (1,0), which is also a warm tan and is coloured separately by
// applyHairColor. (col, row) pairs below match tintAtlasTile's argument order.
// The KayKit atlas holds skin across SIX swatches (Obsidian 823): the FACE is
// the light set (0,0)/(0,1)/(1,1), but the NECK / chin / wrist skin - the parts
// the user saw stay "white/wrong" under a tinted face - sample the darker skin-
// shadow set (5,0)/(6,0)/(5,1). A magenta-probe confirmed these three carry the
// neck+wrist skin and NOT leather/armour (those live on other tiles and stayed
// untinted), so tinting all six recolours the whole skin without touching gear.
const SKIN_TILES = [[0, 0], [0, 1], [1, 1], [5, 0], [6, 0], [5, 1]];
function applySkinTone(mesh, hex) {
  let tinted = null, srcMat = null;
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.map) return;
    if (!srcMat) {
      srcMat = o.material;
      tinted = srcMat.map;
      for (const [c, r] of SKIN_TILES) tinted = tintAtlasTile(tinted, c, r, hex) || tinted;
      if (tinted === srcMat.map) tinted = null; // nothing tinted (image not decoded)
    }
    if (!tinted) return;
    o.material = o.material.clone();
    o.material.map = tinted;
    o.material.needsUpdate = true;
  });
}

// Repaint the hair tile (grid cell 1,0) on every mesh that uses the model's
// shared atlas material - this is the same tile the head mesh's hair/ponytail
// geometry samples (including the female mage's baked-in ponytail, which lives
// on the same Head mesh/material as the rest of the hair), so one recolor
// covers both. If a mesh's map is already a tinted CanvasTexture (skin tone
// applied earlier in applyCosmetics), that becomes the source here, so the
// hair tint layers onto the same canvas lineage rather than starting a second,
// unrelated copy of the atlas.
export function applyHairColor(mesh, hex) {
  let tinted = null, srcMat = null;
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.map) return;
    if (!srcMat) {
      srcMat = o.material;
      tinted = tintAtlasTile(srcMat.map, 1, 0, hex);
    }
    if (!tinted) return;
    o.material = o.material.clone();
    o.material.map = tinted;
    o.material.needsUpdate = true;
  });
}

// Rarity-dye the mage's BAKED robe (Obsidian 732): atlas tiles (0,2) - the
// light-purple robe cloth the user flagged - and (0,3), its dark trim/shadow,
// are what the Mage_Body AND both sleeve meshes sample (verified by UV
// bucketing the GLB), so repainting them dyes the whole authored robe. The
// baked robe is fully SKINNED - sleeves move with the arms, the skirt with
// the legs - which is the entire point: it replaces the old rigid procedural
// skirt/torso overlay that floated over the animating body. hex null
// restores the undyed look (chest slot emptied). Always re-chains from the
// pristine post-cosmetics map (userData.robeBaseMap) because tintAtlasTile
// derives shading from current pixels and re-tinting its own output
// compounds darker each equip. Skips the hooded-head mesh, whose map is its
// own separately-tinted lineage (see tintHoodedHeadMap).
export function applyRobeTint(mesh, hex) {
  if (!mesh.userData.robeBaseMap) {
    mesh.traverse((o) => {
      if (mesh.userData.robeBaseMap || !o.isMesh || o === mesh.userData.mageHoodedHead) return;
      if (o.material && !Array.isArray(o.material) && o.material.map) mesh.userData.robeBaseMap = o.material.map;
    });
  }
  const base = mesh.userData.robeBaseMap;
  if (!base) return;
  let out = base;
  if (hex != null) {
    const darker = (((hex >> 16) & 255) * 0.5 << 16) | (((hex >> 8) & 255) * 0.5 << 8) | ((hex & 255) * 0.5);
    out = tintAtlasTile(base, 0, 2, hex);
    if (!out) return;
    out = tintAtlasTile(out, 0, 3, darker) || out;
  }
  if (mesh.userData.robeTintedMap && mesh.userData.robeTintedMap !== out) mesh.userData.robeTintedMap.dispose();
  mesh.userData.robeTintedMap = hex != null ? out : null;
  mesh.traverse((o) => {
    if (!o.isMesh || o === mesh.userData.mageHoodedHead) return;
    if (!o.material || Array.isArray(o.material) || !o.material.map) return;
    if (o.material.map === out) return;
    o.material = o.material.clone();
    o.material.map = out;
    o.material.needsUpdate = true;
  });
}

function applyCosmetics(mesh, name, skinToneHex = null, hairColorHex = null) {
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
  // A player-chosen hair color (character creation), same "explicit choice wins,
  // null falls back to the rig's own baked hair" pattern as skin tone above.
  // Applied after skin tone so it extends that same tinted canvas lineage
  // (see tintAtlasTile) rather than starting a second copy of the atlas.
  if (hairColorHex != null) {
    applyHairColor(mesh, hairColorHex);
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

// The KayKit mage bakes a ponytail INTO the single skinned Mage_Head mesh:
// a hair bun (with a bead) plus a purple tie band, hanging from the back of
// the skull down the neck. There is no separate hair node to toggle, so a
// male mage needs the tail removed at geometry level. Luckily the tail is
// authored as two self-contained triangle islands that merely intersect the
// skull surface from outside, so index-buffer connectivity finds them cleanly:
// drop every triangle of any island whose bounding box sits entirely in the
// tail region (behind the skull, below the crown, near the center line - the
// bounds below are measured from Mage.glb in the head's local space, where
// the rig faces +Z and the head spans y 1.07..2.20, z -0.75..0.52).
// One catch: the skull surface has a small authored hole where the tail
// attached (hidden-face-removed under the bun), a closed 8-vertex rim at
// roughly y 1.30..1.46, z -0.47..-0.35. Removing the tail exposes it, showing
// the inside of the face through the nape. So after stripping we cap that rim
// with a triangle fan: new vertices reuse the rim's positions, normals and
// skin weights, but all get one constant UV inside the hair atlas tile so the
// cap renders as flat hair color instead of interpolating across the atlas.
const MAGE_TAIL_MAX_Z = -0.3;
const MAGE_TAIL_MAX_Y = 1.5;
const MAGE_TAIL_MAX_ABS_X = 0.25;
// Hole-rim search window, slightly wider than the measured rim so small asset
// tweaks stay covered. Kept clear of the neck opening (which is lower and
// further forward) so the cap can never seal the neck.
const MAGE_HOLE_MAX_Z = -0.2;
const MAGE_HOLE_MAX_Y = 1.62;
const MAGE_HOLE_MAX_ABS_X = 0.3;
// Center of the hair color tile in the shared 8x8 atlas (tile x=1, y=0).
const MAGE_HAIR_UV = [0.1875, 0.0625];

let maleMageHeadGeo = null; // built once; shared by every male mage instance

function stripMagePonytail(srcGeo) {
  const pos = srcGeo.getAttribute('position');
  const idx = srcGeo.getIndex();
  if (!pos || !idx) return null;
  const vCount = pos.count;
  // 1. Triangle-connectivity islands (union-find over the index buffer).
  const parent = new Uint32Array(vCount);
  for (let i = 0; i < vCount; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.count; t += 3) {
    const ra = find(idx.getX(t)), rb = find(idx.getX(t + 1)), rc = find(idx.getX(t + 2));
    parent[rb] = ra; parent[rc] = ra;
  }
  // 2. Per-island bounds; islands fully inside the tail region are doomed.
  const boxes = new Map();
  for (let t = 0; t < idx.count; t++) {
    const vi = idx.getX(t);
    const r = find(vi);
    let b = boxes.get(r);
    if (!b) { b = { maxY: -Infinity, maxZ: -Infinity, maxAbsX: 0 }; boxes.set(r, b); }
    if (pos.getY(vi) > b.maxY) b.maxY = pos.getY(vi);
    if (pos.getZ(vi) > b.maxZ) b.maxZ = pos.getZ(vi);
    const ax = Math.abs(pos.getX(vi));
    if (ax > b.maxAbsX) b.maxAbsX = ax;
  }
  const doomed = new Set();
  for (const [r, b] of boxes) {
    if (b.maxZ < MAGE_TAIL_MAX_Z && b.maxY < MAGE_TAIL_MAX_Y && b.maxAbsX < MAGE_TAIL_MAX_ABS_X) doomed.add(r);
  }
  if (!doomed.size) return null; // nothing matched: unexpected asset, leave stock
  // 3. Drop doomed triangles; find the exposed hole rim among what is kept.
  // Boundary edges (used by exactly one kept triangle) are collected with
  // position-welded endpoints so duplicated seam vertices do not read as fake
  // boundaries, and each edge remembers its kept-triangle winding (a -> b) so
  // the cap fan below can match the surrounding surface orientation.
  const weld = new Map();
  const canon = new Uint32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const key = pos.getX(i).toFixed(5) + ',' + pos.getY(i).toFixed(5) + ',' + pos.getZ(i).toFixed(5);
    const c = weld.get(key);
    if (c === undefined) { weld.set(key, i); canon[i] = i; } else canon[i] = c;
  }
  const kept = [];
  const edges = new Map(); // canonKey -> { a, b, count }
  const noteEdge = (a, b) => {
    const ca = canon[a], cb = canon[b];
    const key = ca < cb ? ca + '_' + cb : cb + '_' + ca;
    const e = edges.get(key);
    if (e) e.count++;
    else edges.set(key, { a, b, count: 1 });
  };
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    if (doomed.has(find(a))) continue;
    kept.push(a, b, c);
    noteEdge(a, b); noteEdge(b, c); noteEdge(c, a);
  }
  const inHole = (vi) => pos.getZ(vi) < MAGE_HOLE_MAX_Z && pos.getY(vi) < MAGE_HOLE_MAX_Y
    && Math.abs(pos.getX(vi)) < MAGE_HOLE_MAX_ABS_X;
  const rim = [];
  for (const e of edges.values()) {
    if (e.count === 1 && inHole(e.a) && inHole(e.b)) rim.push(e);
  }
  // 4. Rebuild the geometry with the doomed triangles gone and, if a rim was
  // exposed, a cap fan over it: per rim edge two duplicated edge vertices plus
  // one shared center vertex, all with the constant hair UV.
  const nrm = srcGeo.getAttribute('normal');
  const newVerts = rim.length ? rim.length * 2 + 1 : 0;
  const out = new THREE.BufferGeometry();
  const attrNames = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
  const outAttrs = {};
  for (const name of attrNames) {
    const src = srcGeo.getAttribute(name);
    if (!src) continue;
    const arr = new src.array.constructor((vCount + newVerts) * src.itemSize);
    arr.set(src.array);
    outAttrs[name] = new THREE.BufferAttribute(arr, src.itemSize, src.normalized);
    out.setAttribute(name, outAttrs[name]);
  }
  if (rim.length) {
    const copyVert = (dst, srcIdx) => {
      for (const name of attrNames) {
        const at = outAttrs[name];
        if (!at) continue;
        for (let k = 0; k < at.itemSize; k++) at.array[dst * at.itemSize + k] = at.array[srcIdx * at.itemSize + k];
      }
      outAttrs.uv.array[dst * 2] = MAGE_HAIR_UV[0];
      outAttrs.uv.array[dst * 2 + 1] = MAGE_HAIR_UV[1];
    };
    const center = vCount + rim.length * 2;
    const cp = new THREE.Vector3(), cn = new THREE.Vector3();
    rim.forEach((e, i) => {
      copyVert(vCount + i * 2, e.a);
      copyVert(vCount + i * 2 + 1, e.b);
      cp.x += pos.getX(e.a) + pos.getX(e.b); cp.y += pos.getY(e.a) + pos.getY(e.b); cp.z += pos.getZ(e.a) + pos.getZ(e.b);
      if (nrm) { cn.x += nrm.getX(e.a) + nrm.getX(e.b); cn.y += nrm.getY(e.a) + nrm.getY(e.b); cn.z += nrm.getZ(e.a) + nrm.getZ(e.b); }
    });
    cp.divideScalar(rim.length * 2);
    cn.normalize();
    copyVert(center, rim[0].a); // seed skin weights from a rim vertex, then overwrite pos/normal
    outAttrs.position.array[center * 3] = cp.x;
    outAttrs.position.array[center * 3 + 1] = cp.y;
    outAttrs.position.array[center * 3 + 2] = cp.z;
    if (outAttrs.normal) {
      outAttrs.normal.array[center * 3] = cn.x;
      outAttrs.normal.array[center * 3 + 1] = cn.y;
      outAttrs.normal.array[center * 3 + 2] = cn.z;
    }
    // The kept triangle walks the rim edge a -> b, so the missing neighbor
    // (our cap) must walk it b -> a to keep the same outward winding.
    rim.forEach((e, i) => {
      kept.push(vCount + i * 2 + 1, vCount + i * 2, center);
    });
  }
  const IndexArr = vCount + newVerts > 65535 ? Uint32Array : Uint16Array;
  out.setIndex(new THREE.BufferAttribute(new IndexArr(kept), 1));
  return out;
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
// creation choices: { gender: 'male'|'female', skinTone: <SKIN_TONES id>,
// hairColor: <HAIR_TONES id>, eyeColor: <EYE_COLORS id>, faceShape: <FACE_SHAPES
// id>, hairStyle: <HAIR_STYLES id> }. Skin tone and hair color are the clearly
// visible ones (repaint the head/hands and hair tile respectively); gender is
// a subtle silhouette hint only (the base rigs have no gendered geometry).
// hairColor defaults to null (no opts.hairColor / unrecognized id), which
// keeps the rig's own baked hair untouched. eyeColor defaults to brown
// (EYE_COLORS[0]) rather than null since every head has visible eyes;
// faceShape defaults to 'standard' (no scale); hairStyle defaults to 'short'
// (rig's own baked hair/length, unchanged).
export function buildAnimatedHero(classId, name = '', opts = {}) {
  const data = loaded.get(classId);
  if (!data) return null;

  const gender = opts.gender === 'female' ? 'female' : 'male';
  const skinTone = skinToneById(opts.skinTone);
  const hairTone = hairToneById(opts.hairColor);
  const eyeTone = eyeColorById(opts.eyeColor) || EYE_COLORS[0];
  const faceShape = faceShapeById(opts.faceShape);
  const hairStyle = hairStyleById(opts.hairStyle).id;

  const mesh = skeletonClone(data.scene);
  mesh.scale.setScalar(data.scale);
  // REAL female silhouette via bone-level shaping (Obsidian 760/809): the old
  // whole-mesh squish literally rendered "the male body squished". Instead the
  // skeleton itself is reshaped - wider hips/glutes, a narrower waist, a bust
  // hint at the chest - with counter-scales down the chain so the head, legs
  // and arms keep near-true proportions (the head's slight narrowing doubles
  // as the softer female face). Values are LOCAL per bone; each row's comment
  // is the NET effect after the parent chain. Composes safely with animation:
  // the KayKit clips key rotation/position, not scale.
  if (gender === 'female') {
    mesh.scale.y *= 1.02; // a touch taller overall
    const shape = {
      hips: [1.14, 1, 1.10],        // net 1.14 wide, 1.10 deep - hips + glutes
      spine: [0.79, 1, 0.855],      // net 0.90 x 0.94 - waist
      chest: [1.156, 1, 1.213],     // net 1.04 x 1.14 - bust
      head: [0.96, 1, 0.877],       // net ~1.0 - slightly slimmer female face
      upperlegl: [0.895, 1, 0.927], // net ~1.02 - legs stay true
      upperlegr: [0.895, 1, 0.927],
      upperarml: [0.923, 1, 0.842], // net ~0.96 - shoulders/arms stay slim
      upperarmr: [0.923, 1, 0.842],
    };
    mesh.traverse((o) => {
      if (!o.isBone) return;
      const s = shape[o.name.toLowerCase().replace(/\./g, '')];
      if (s) o.scale.set(o.scale.x * s[0], o.scale.y * s[1], o.scale.z * s[2]);
    });
  }
  let hoodedHead = null, headMesh = null, bakedHat = null;
  const spellbookMeshes = []; // mage's baked Spellbook/Spellbook_open - reused as the real Tome offhand mesh below
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
      // blocky brick clipping at the hip and adds nothing by default (the mage
      // already reads by its wand/staff in the main hand for attacks). Hidden
      // by default, mage only - same treatment as the baked hat above - but
      // NOT abandoned: updateHeroGear (game.js) reuses this exact mesh as the
      // real held prop for an equipped Tome/Grimoire/Codex offhand item (see
      // heldVariants below), so a bare mage has no book but a tome-wielding one
      // shows this authored asset instead of a procedural stand-in.
      if (classId === 'mage' && /Spellbook|Book/i.test(o.name)) { o.visible = false; spellbookMeshes.push(o); }
      // Track the head so we can (a) anchor equipped helmets to its actual top
      // and (b) split the rogue's welded-in hood off below.
      if (/Head/i.test(o.name)) headMesh = o;
      if (o.isSkinnedMesh && /Head.*Hood|Hood.*Head|Hooded/i.test(o.name)) hoodedHead = o;
    }
  });
  // Male mages always get the stripped head (see stripMagePonytail above).
  // Female mages keep the baked-in ponytail ONLY when 'ponytail' is the chosen
  // hair style (their baked hair already IS a ponytail, so there is nothing to
  // add); any other style (including the default 'short') strips it the same
  // way, since the stripped-and-capped head (see stripMagePonytail's hole cap)
  // is the correct bald-crown base for Short/Bun/Long alike. Built once and
  // cached - skeletonClone hands every hero the SAME shared geometry instance,
  // so swapping in a separate stripped instance is what keeps
  // female/male/style-varied heroes independent of each other.
  const mageFemaleKeepsBakedTail = classId === 'mage' && gender === 'female' && hairStyle === 'ponytail';
  if (classId === 'mage' && headMesh && !mageFemaleKeepsBakedTail) {
    if (!maleMageHeadGeo) maleMageHeadGeo = stripMagePonytail(headMesh.geometry);
    if (maleMageHeadGeo) headMesh.geometry = maleMageHeadGeo;
  }
  // The KayKit rigs bake EVERY weapon/shield variant for a class into the
  // hand bones at once (e.g. the knight ships 1H_Sword, 2H_Sword AND
  // 1H_Sword_Offhand plus four different shields, all simultaneously
  // visible), so a fresh hero shows several overlapping blades/shields
  // clipping through each other. Show exactly one sensible held-loadout per
  // class by default and hide the rest - the kept default is baked to fit the
  // hand pose, so with the duplicates hidden there is nothing left to clip.
  // The hidden variants are NOT discarded though (see heldVariants below):
  // updateHeroGear swaps which one is visible based on the equipped item.
  const HELD_LOADOUT = {
    knight: ['1H_Sword', 'Round_Shield'],
    mage: ['2H_Staff'],
    ranger: ['2H_Crossbow'],
    barbarian: [], // townsfolk keep empty hands - every baked weapon hidden
    villager: [],
    cleric: [],
    monk: [],
    scout: [],
    drifter: [],
  };
  const keepHeld = new Set(HELD_LOADOUT[classId] || []);
  const HELD_PATTERN = /Sword|Shield|Wand|Staff|Crossbow|Bow|Knife|Axe|Hammer|Mace|Dagger|Spear|Throwable/i;
  // Every matched mesh (not just the kept default) is kept alive on
  // mesh.userData.heldVariants, keyed by its own KayKit mesh name (e.g.
  // '1H_Sword', '2H_Sword', 'Round_Shield', 'Spike_Shield'...), so
  // updateHeroGear (game.js) can show whichever variant matches the equipped
  // item's name and hide the rest - real distinct weapon/shield SILHOUETTES
  // per item family instead of one baked shape retinted. The kept default
  // loadout mesh starts visible (unchanged bare-hero look); every other
  // variant starts hidden until an equipped item's name picks it.
  const heldVariants = {};
  const heldMeshes = [];
  mesh.traverse((o) => {
    if (o.isMesh && HELD_PATTERN.test(o.name)) {
      heldVariants[o.name] = o;
      heldMeshes.push(o); // ground-clearance measured for every variant, not just the visible one
      // Shields tint as a single flat rarity color already (see
      // updateHeroGear); only actual weapons need the grip/blade split. Split
      // every weapon variant up front (not only the kept default) so any of
      // them can be shown+tinted later without a first-frame flash of the
      // un-split single-material fallback.
      if (!/Shield/i.test(o.name)) splitWeaponMesh(o);
      o.visible = keepHeld.has(o.name);
    }
  });
  // The mage's baked Spellbook/Spellbook_open (hidden above, see the
  // Spellbook detection block) are not weapon-shaped so they skip the split,
  // but they DO need the same ground-clearance treatment and a heldVariants
  // entry so updateHeroGear can show one as a real Tome/Grimoire/Codex offhand.
  for (const o of spellbookMeshes) {
    heldVariants[o.name] = o;
    heldMeshes.push(o);
  }
  mesh.userData.heldVariants = heldVariants;
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
  // Mage hooded HEAD (Obsidian 714, ClaudeCraft-style - see the
  // mageHoodedHeadGeo comment near the top of this file): a fitted instance
  // of the rogue's complete authored hooded head, rescaled/repositioned from
  // its measured source anchor (MAGE_HOODED_HEAD_ANCHOR) onto THIS mage
  // instance's own real headAnchor. When updateHeroGear (game.js) shows it,
  // it hides the mage's OWN head mesh entirely (stashed on
  // userData.mageHeadMesh below) - the hooded head replaces the head, hair
  // and all, instead of trying to cover it. Built here rather than in
  // game.js so it can be parented under headMesh.parent - the SAME space
  // headAnchor itself was measured in. Hidden by default; shown only when a
  // hood-named helmet is worn with a chest robe (same gating as before).
  if (classId === 'mage' && mageHoodedHeadGeo && mageHoodedHeadMat && headMesh && mesh.userData.headAnchor) {
    const anchor = mesh.userData.headAnchor;
    const scale = anchor.r / MAGE_HOODED_HEAD_ANCHOR.r;
    // Plain (non-skinned) mesh from the skinned source's bind-pose geometry:
    // a head is rigid, so riding the head BONE via anchorToHeadBone below
    // gives identical motion to real skinning for these head-only vertices.
    const hoodedHead = new THREE.Mesh(mageHoodedHeadGeo, mageHoodedHeadMat.clone());
    hoodedHead.castShadow = false; hoodedHead.receiveShadow = false; hoodedHead.frustumCulled = false;
    // Shift the source's own baked-in coordinates so its anchor point lands
    // at this group's local origin - the group's scale/position below then
    // re-seats that origin onto the mage's real head in one transform.
    hoodedHead.position.set(-MAGE_HOODED_HEAD_ANCHOR.cx, -MAGE_HOODED_HEAD_ANCHOR.top, -MAGE_HOODED_HEAD_ANCHOR.cz);
    const hoodGroup = new THREE.Group();
    hoodGroup.add(hoodedHead);
    hoodGroup.scale.setScalar(scale);
    hoodGroup.position.set(anchor.cx, anchor.top, anchor.cz);
    hoodGroup.visible = false; // shown by updateHeroGear only for hood-named helmet + robe
    headMesh.parent.add(hoodGroup);
    // Ride the head animation: positioned in bind space above, then reparented
    // onto the head BONE preserving world transform (attach()) - without this
    // the hood floated static while the head tilted mid-walk (TODO 701, the
    // same defect the eye discs had).
    anchorToHeadBone(mesh, hoodGroup);
    mesh.userData.mageHood = hoodGroup;
    mesh.userData.mageHoodedHead = hoodedHead;
    mesh.userData.mageHeadMesh = headMesh; // so updateHeroGear can hide/restore the real head
  }
  const useAtlasTones = ATLAS_COSMETICS_CLASSES.has(classId);
  // Face shape (TODO 97): scale the HEAD MESH NODE only, after headAnchor is
  // measured (so the helmet-fit anchor above stays the real, unscaled head)
  // and before the eye discs below (their bone-parented position is derived
  // straight from the unscaled geometry, so scaling here doesn't move them
  // relative to the head - see addEyeDiscs). Gated the same as skin/hair tone
  // (ATLAS_COSMETICS_CLASSES) since the townsfolk-only Quaternius bodies don't
  // share this rig's head node naming/layout.
  if (headMesh && useAtlasTones && (faceShape.sx !== 1 || faceShape.sy !== 1)) {
    headMesh.scale.x *= faceShape.sx;
    headMesh.scale.y *= faceShape.sy;
  }
  // Eye colour (TODO 97): see addEyeDiscs above for why this is two small
  // overlay discs rather than an atlas tile retint.
  if (headMesh && useAtlasTones) {
    // Eye-colour discs REMOVED (TODO 698): the user rejected colored discs
    // over the KayKit rigs' painted eyes ("brown dots on everyone's eyes").
    // eyeColor persists in saves but has no visual until a texture-level
    // recolor exists. (Quaternius townsfolk keep their DARK discs below -
    // those rigs ship with NO painted eyes at all, so the discs ARE the eyes.)
  }
  // TODO 690: the four Quaternius townsfolk (cleric/monk/scout/drifter) have
  // no headMesh by this rig's naming convention (see the useAtlasTones gate
  // above) AND their shared baked texture has no painted eyes at all - give
  // them the same simple painted-eye treatment via a bone-skin-weight-derived
  // head bbox instead of the headMesh-geometry one (see
  // computeSkinnedHeadBBox/addTownEyeDiscs above for why).
  if (!useAtlasTones) {
    addTownEyeDiscs(mesh);
  }
  // Hair style (TODO 97): procedural ponytail/bun/long meshes anchored to the
  // head (see addHairMesh above). 'short' is always a no-op here (the rig's
  // own baked hair, already handled by the strip-vs-keep logic above for the
  // mage); the female-mage-keeps-its-baked-ponytail case is skipped for the
  // same reason - there is nothing to add on top of it. Gated to
  // useAtlasTones same as face shape/eye colour (the Quaternius townsfolk
  // rigs share none of this head-node layout and are never playable anyway).
  // Tinted to the SAME hex the baked hair gets so it matches exactly; when no
  // hair colour has been chosen (hairTone null - old saves/peers, or a player
  // who never opened the hair swatch) it falls back to a dark-brown default
  // close to the rigs' own baked hair tone, since an untinted procedural mesh
  // has no baked texture of its own to fall back to.
  if (headMesh && useAtlasTones && hairStyle !== 'short' && !mageFemaleKeepsBakedTail) {
    const hairHex = hairTone ? hairTone.hex : HAIR_TONES[1].hex;
    const hairGroup = addHairMesh(mesh, headMesh, hairStyle, hairHex);
    if (hairGroup) mesh.userData.hairStyleMesh = { style: hairStyle, group: hairGroup };
  }
  applyCosmetics(mesh, name, useAtlasTones && skinTone ? skinTone.hex : null, useAtlasTones && hairTone ? hairTone.hex : null);
  // Stashed for updateHeroGear (game.js): the hooded-head face tile is
  // repainted to this same tone so a hooded mage keeps their chosen skin.
  mesh.userData.skinToneHex = useAtlasTones && skinTone ? skinTone.hex : null;

  // fake blob shadow
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.45 / data.scale, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02 / data.scale;
  shadow.name = 'BlobShadow'; // named so lie-down can hide it (it would tip with the body)
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
      // ARM-driven swing (owner spec: a real human swing moves the ARM across
      // the body and out for horizontal cuts, and raises it higher for the
      // overhead - the whole knight must NOT rotate). Applied post-mixer as
      // additive bone rotations (setLocomotion runs after mixer.update in
      // player.js, so premultiplying here composes with this frame's clip
      // pose). Only knight variant swings set _armSwing.
      if (this._armSwing) {
        const s = this._armSwing;
        s.t += dt;
        const p = Math.min(1, s.t / s.dur);
        // envelope: wind back 22%, drive through 48%, recover 30%
        let off;
        if (p < 0.22) off = -0.6 * (p / 0.22);
        else if (p < 0.7) off = -0.6 + 1.6 * ((p - 0.22) / 0.48);
        else off = 1.0 * (1 - (p - 0.7) / 0.3);
        if (!this._armBones) {
          this._armBones = { arm: null, chest: null };
          this.mesh.traverse((o) => {
            if (/^upperarm\.r$/i.test(o.name)) this._armBones.arm = o;
            else if (/^chest$/i.test(o.name)) this._armBones.chest = o;
          });
        }
        const { arm, chest } = this._armBones;
        if (arm) {
          if (s.kind === 'slice') {
            // sweep the arm across the body then extended out to the far side
            arm.quaternion.premultiply(_swingQ.setFromAxisAngle(_AXIS_Y, off * 0.95 * s.dir));
          } else if (s.kind === 'chop') {
            // raise the arm higher through the overhead
            arm.quaternion.premultiply(_swingQ.setFromAxisAngle(_AXIS_X, -Math.abs(off) * 0.7));
          } else { // stab: modest forward extension
            arm.quaternion.premultiply(_swingQ.setFromAxisAngle(_AXIS_X, -Math.abs(off) * 0.35));
          }
        }
        // a touch of chest twist sells the horizontal cut without turning the knight
        if (chest && s.kind === 'slice') {
          chest.quaternion.premultiply(_swingQ.setFromAxisAngle(_AXIS_Y, off * 0.3 * s.dir));
        }
        if (p >= 1) this._armSwing = null;
      }
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
      let key = null;
      if (variant) {
        const keys = Object.keys(this.attackCombo);
        if (keys.length) { key = keys[Math.floor(Math.random() * keys.length)]; a = this.attackCombo[key]; }
      }
      if (!a) return;
      for (const other of Object.values(this.attackCombo)) {
        if (other !== a) other.stop();
      }
      a.reset();
      // Small per-swing timescale jitter so the arc's speed/range of motion is
      // never identical twice; centered on the previous fixed 1.8 so DPS pacing
      // (driven by player.js cooldowns, not clip length) is unaffected.
      // Slower playback on the combo swings so the full arm arc actually READS
      // as a big swing instead of a blur; DPS pacing is cooldown-driven so this
      // only changes the visual. Random jitter keeps repeats varied.
      a.setEffectiveTimeScale(variant ? 1.15 + Math.random() * 0.35 : 1.8);
      a.setEffectiveWeight(1);
      a.play();
      if (variant) {
        // ARM-driven swing (see setLocomotion): the arm crosses the body and
        // extends for horizontal cuts, raises higher for the overhead, extends
        // forward for the stab. The knight's body does not rotate.
        const kind = key === 'chop' ? 'chop' : key === 'stab' ? 'stab' : 'slice';
        const dir = key === 'slice_diagonal' ? -1 : (this._swingAlt = !this._swingAlt) ? 1 : -1;
        this._armSwing = { t: 0, dur: 0.34, kind, dir };
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
