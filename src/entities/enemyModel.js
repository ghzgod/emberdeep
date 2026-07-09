import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Modeled enemy visuals: CC0 GLB creatures (KayKit Skeletons + Quaternius
// creatures, see public/models/enemies/) replacing the old procedural boxes.
// Mirrors heroModel.js's load-once-cache + SkeletonUtils.clone-per-instance
// pattern, but lazy: nothing here is fetched until a floor actually spawns a
// type that needs it (Enemy's constructor kicks off the fetch right when a
// floor is generated with that type in its spawn list), so it never touches
// the boot bundle the way hero models intentionally do.
//
// The source GLBs are meshopt-compressed (they're reused as-is from an
// existing optimized asset pipeline, not compressed by this project), so the
// loader needs its meshopt extension wired up or every load fails outright.
// This ships in three's own examples (no extra dependency) and is a decode
// step, not an encoder we're choosing to add, same spirit as the project
// being told not to add Draco/KTX2 itself.

const MODEL_FILES = {
  skeleton: 'models/enemies/skeleton_minion.glb',
  spider: 'models/enemies/spider.glb',
  imp: 'models/enemies/imp.glb',
  golem: 'models/enemies/giant.glb',
  ghost: 'models/enemies/ghost.glb',
  ghoul: 'models/enemies/skeleton_rogue.glb',
  witch: 'models/enemies/skeleton_mage.glb',
  warlock: 'models/enemies/necromancer.glb',
  demon: 'models/enemies/demon.glb',
  // Boss base body (Boss extends Enemy as a 'golem' archetype) + one distinct,
  // imposing model per act lord (see ACT_BOSSES in enemies.js). Act bosses
  // resolve by act number via bossModelKeyForAct() below.
  boss: 'models/enemies/skeleton_golem.glb',
  bossAct1: 'models/enemies/skeleton_warrior.glb', // Gravewarden Malruk
  bossAct2: 'models/enemies/spider.glb',           // Broodqueen Sszarra
  bossAct3: 'models/enemies/demon.glb',            // Pyrarch Vexmal
  bossAct4: 'models/enemies/skeleton_golem.glb',   // The Obsidian Colossus
  bossAct5: 'models/enemies/dragon.glb',           // The Dungeon Lord
};

// Approximate world-unit height (ground to crown) each type's box mesh used
// to stand, so the modeled replacement occupies the same visual footprint
// (collision radius lives in ENEMY_TYPES and is untouched by any of this).
const TARGET_HEIGHT = {
  skeleton: 1.3, spider: 0.55, imp: 1.3, golem: 1.75, ghost: 1.4,
  ghoul: 1.15, witch: 1.55, warlock: 1.55, demon: 1.75,
  boss: 2.4, bossAct1: 2.4, bossAct2: 1.0, bossAct3: 2.4, bossAct4: 2.6, bossAct5: 3.6,
};

function bossModelKeyForAct(act) {
  const key = `bossAct${Math.min(5, Math.max(1, act || 1))}`;
  return MODEL_FILES[key] ? key : 'boss';
}

// ---- White bone for the skeleton family ----
// Every skeleton-family rig (KayKit: skeleton/ghoul/witch/warlock plus the
// skeleton boss rigs) shares one atlas material literally named "skeleton"
// whose bone regions are painted a warm cream; under the dungeon's warm
// torch lighting that cream reads parchment-YELLOW on screen. Fix it at the
// source: run the atlas through a one-time-per-file canvas pass that
// desaturates and slightly brightens only bone-toned pixels (bright, warm,
// mildly saturated), so bone reads clean white under torchlight while cloth,
// leather, gold trim (all darker or far more saturated) and the separate
// "Glow" eye material are untouched. Elite gilding (enemies.js) tints the
// material COLOR toward gold after this, so gilded elites still read gold.
const SKELETON_BONE_KEYS = new Set(['skeleton', 'ghoul', 'witch', 'warlock', 'boss', 'bossAct1', 'bossAct4']);
const whitenedAtlasTextures = new Map(); // model file -> THREE.CanvasTexture (one shared atlas per file)

function whitenedBoneTexture(file, srcTexture) {
  let tex = whitenedAtlasTextures.get(file);
  if (tex) return tex;
  const image = srcTexture.image;
  if (!image || !image.width) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b);
    const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    // bone tones only: bright-ish, warm-ordered (r >= g >= b), mildly
    // saturated. Gold trim is far more saturated, cloth/leather far darker,
    // so neither ever matches.
    if (max > 96 && sat < 0.42 && r >= g && g >= b) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // pull 80% of the way to neutral grey, then lift brightness a touch so
      // the bone stays white even in dim warm torchlight
      px[i] = Math.min(255, (r + (lum - r) * 0.8) * 1.12);
      px[i + 1] = Math.min(255, (g + (lum - g) * 0.8) * 1.12);
      px[i + 2] = Math.min(255, (b + (lum - b) * 0.8) * 1.12);
    }
  }
  ctx.putImageData(data, 0, 0);
  tex = new THREE.CanvasTexture(canvas);
  tex.flipY = srcTexture.flipY;
  tex.colorSpace = srcTexture.colorSpace;
  tex.wrapS = srcTexture.wrapS;
  tex.wrapT = srcTexture.wrapT;
  tex.minFilter = srcTexture.minFilter;
  tex.magFilter = srcTexture.magFilter;
  whitenedAtlasTextures.set(file, tex);
  return tex;
}

// Clip-name families across the source rigs (see CREDITS.md): KayKit skeleton
// rigs share one 40+ clip library; the Quaternius creature rigs each ship a
// small bespoke set keyed by exact clip name (verified against the GLBs).
// `attack` lists every clip this family should draw attack VARIETY from (1-3
// entries); attachEnemyModel registers whichever of these actually exist in
// the GLB as separate one-shot actions, and playAttack() below picks among
// them each swing so the same mob doesn't play one identical animation every
// time. Golem/skeletonGolem intentionally lists three (chop/2H chop/dualwield)
// since bosses should read as cycling through a small combat repertoire.
const CLIP_SETS = {
  skeleton: { idle: 'Idle_Combat', walk: 'Walking_A', run: 'Running_A', attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal'], death: 'Death_A', flourish: 'Skeletons_Awaken_Standing' },
  skeletonCaster: { idle: 'Idle_Combat', walk: 'Walking_A', run: 'Running_A', attack: ['2H_Melee_Attack_Chop', 'Spellcast_Shoot'], death: 'Death_A', flourish: 'Taunt' },
  skeletonGolem: { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack: ['1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Chop'], death: 'Death_A' },
  spider: { idle: 'Spider_Idle', walk: 'Spider_Walk', run: 'Spider_Walk', attack: ['Spider_Attack'], death: 'Spider_Death' },
  floating: { idle: 'Flying_Idle', walk: 'Fast_Flying', run: 'Fast_Flying', attack: ['Punch', 'Headbutt'], death: 'Death' },
  biped: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: ['Attack'], death: 'Death' },
  bipedPunch: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: ['Punch', 'Weapon'], death: 'Death' },
};

// Stride matching: natural horizontal speed (world units/sec) each rig's
// walk/run clip visually covers at THREE's default timescale of 1, tuned per
// clip family (not per exact type, since every type in a family shares the
// same clip). setLocomotion() below divides the creature's ACTUAL speed by
// whichever of these applies to pick a timescale, so fast movers (ghoul,
// spider, demon) get a genuinely quicker-cadence gait instead of the same
// clip just playing back faster than its legs can visually cover (the
// "gliding" the clip plays at a fixed-ish rate while ENEMY_TYPES speed varies
// far more, so the feet appear to slide across the ground on fast types).
// `crossover`: actual speed above which a family with a distinct run clip
// switches from walk to run (run's bigger per-cycle stride reads more
// natural than a walk clip cranked to a high timescale). Spider has no
// distinct run clip in this pack (CLIP_SETS.spider.run === its walk clip), so
// it always resolves to the same action and crossover never fires for it.
// Floating types (imp/ghost/dragon) are intentionally absent here: they hover
// rather than stride, so they're exempt and handled by a separate mild
// flap-rate scale in setLocomotion.
const STRIDE_TABLE = {
  skeleton: { walk: 1.6, run: 3.5, crossover: 2.4 },
  skeletonCaster: { walk: 1.6, run: 3.5, crossover: 2.4 },
  skeletonGolem: { walk: 1.6, run: 3.5, crossover: 2.4 },
  spider: { walk: 1.9, run: 1.9, crossover: 999 },
  biped: { walk: 1.8, run: 3.8, crossover: 2.7 },
  bipedPunch: { walk: 1.8, run: 3.8, crossover: 2.7 },
};
const STRIDE_TS_MIN = 0.5;
const STRIDE_TS_MAX = 2.5;
// Reference speed for the mild fly-anim scaling floating types get instead of
// full stride matching (roughly the mid-point of imp/ghost base speeds).
const HOVER_REFERENCE_SPEED = 4.3;

const TYPE_CLIP_SET = {
  skeleton: 'skeleton',
  spider: 'spider',
  imp: 'floating',
  golem: 'biped',
  ghost: 'floating',
  ghoul: 'skeleton',
  witch: 'skeletonCaster',
  warlock: 'skeletonCaster',
  demon: 'bipedPunch',
  boss: 'skeletonGolem',
  bossAct1: 'skeleton',
  bossAct2: 'spider',
  bossAct3: 'bipedPunch',
  bossAct4: 'skeletonGolem',
  bossAct5: 'floating',
};

// url -> Promise<GLTF>, shared across every instance so a type's GLB is only
// ever fetched+parsed once no matter how many of that mob spawn.
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// dragonevolved.glb (bossAct5, the Dungeon Lord) ships a 100x-scaled Armature
// root under its skin (common Blender-cm-export quirk, harmless on its own:
// three.js resolves it fine via the normal scene graph). But SkeletonUtils.clone
// on this specific rig produces a mesh that measures correctly (Box3 sees the
// right world-space size) yet renders nothing: the cloned SkinnedMesh's GPU
// bone texture never gets populated. Verified by A/B: the raw (non-cloned)
// gltf.scene renders correctly; every clone of it does not. There is exactly
// one Dungeon Lord on screen at a time (it's the act 5 boss, singleton by
// construction), so the fix is to skip cloning for model keys that can only
// ever have one live instance: they mount the pristine gltf.scene directly.
const SINGLETON_MODEL_KEYS = new Set(['bossAct5']);

// Per-INSTANCE parse instead of SkeletonUtils.clone. The dragon proved that
// cloning these meshopt/quantized skinned rigs can produce meshes that measure
// correctly but render NOTHING (GPU bone texture never populated) - and the
// same failure hits regular mob clones on some player GPUs: the overhead HP
// bar (a Sprite on the same group) draws while the creature body does not.
// A pristine parsed scene always renders, so each instance gets its own parse
// from a cached ArrayBuffer. Slightly more memory per live enemy; floors load
// behind the async loading screen, so the extra parse time is absorbed there.
const glbBufferCache = new Map(); // url -> Promise<ArrayBuffer>

function loadGlbBuffer(url) {
  let p = glbBufferCache.get(url);
  if (!p) {
    p = fetch(import.meta.env.BASE_URL + url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.arrayBuffer();
    });
    glbBufferCache.set(url, p);
  }
  return p;
}

function parseGltfInstance(url) {
  return loadGlbBuffer(url).then(
    (buf) => new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject))
  );
}

// Texture dedupe across per-instance parses. Each parse (the invisibility
// fix above; geometry/skeletons MUST stay per-instance) also decodes its own
// copy of the same atlas texture, so 45 live mobs meant 45 identical GPU
// uploads of one image. The first parse of a file donates its textures to
// this module-level cache; every later parse swaps its freshly decoded
// duplicates for the shared instances (keyed by file + material + slot,
// since per-parse image objects are distinct and can't key anything) and
// disposes the duplicates before they ever upload.
const sharedTextureCache = new Map(); // `${file}#${materialName}#${slot}` -> THREE.Texture
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];

function dedupeMaterialTextures(file, material) {
  for (const slot of TEXTURE_SLOTS) {
    const tex = material[slot];
    if (!tex) continue;
    const key = `${file}#${material.name || ''}#${slot}`;
    const cached = sharedTextureCache.get(key);
    if (!cached) {
      sharedTextureCache.set(key, tex);
    } else if (cached !== tex) {
      material[slot] = cached;
      tex.dispose();
      material.needsUpdate = true;
    }
  }
}

export function bossModelKey(act) {
  return bossModelKeyForAct(act);
}

// Swap a modeled creature into `group` (an already-scene-added THREE.Group,
// e.g. the box placeholder buildEnemyMesh returns) once its GLB resolves.
// Keeps the SAME group reference throughout so no caller (Enemy, game.js's
// guest mirrors) ever has to re-point e.mesh; the group's children are
// simply replaced. Returns an anim controller object once loading succeeds,
// or null if the model failed/was never mapped (caller keeps the fallback
// gait system running in that case).
export async function attachEnemyModel(group, modelKey, opts = {}) {
  const file = MODEL_FILES[modelKey];
  if (!file) return null;
  let gltf;
  try {
    // every instance is a pristine parse - never a SkeletonUtils.clone (see
    // parseGltfInstance above for why; the clone path rendered invisible
    // bodies on some GPUs). Covers the bossAct5 singleton case too.
    gltf = await parseGltfInstance(file);
  } catch (err) {
    console.warn(`Enemy model failed to load (${file}); box fallback stays.`, err);
    return null;
  }
  if (!gltf) return null;
  // The group may have been disposed (enemy died / floor unloaded) while the
  // fetch was in flight; userData.dead is set by the caller in that case.
  if (group.userData.detached) return null;

  const scene = gltf.scene;
  // Degenerate-scene guard: a GLB can resolve yet yield nothing renderable (no
  // mesh, empty geometry, or a zero-size bounding box, e.g. a bad export or a
  // clone that dropped its skinned geometry). If we cleared the box placeholder
  // for a scene like that, the enemy would be permanently invisible. Detect it
  // BEFORE touching the box children and bail (return null) so the caller keeps
  // the visible box fallback + its procedural gait, exactly as for a load error.
  let hasRenderableMesh = false;
  scene.traverse((o) => {
    if (!hasRenderableMesh && o.isMesh && o.geometry?.getAttribute?.('position')?.count > 0) hasRenderableMesh = true;
  });
  const box = new THREE.Box3().setFromObject(scene);
  const boxSize = new THREE.Vector3();
  box.getSize(boxSize);
  if (!hasRenderableMesh || boxSize.length() < 1e-4 || !Number.isFinite(boxSize.length())) {
    console.warn(`Enemy model produced no renderable geometry (${file}); box fallback stays.`);
    return null;
  }
  const rawHeight = box.max.y - box.min.y || 1;
  const targetHeight = TARGET_HEIGHT[modelKey] || 1.4;
  const scale = targetHeight / rawHeight;
  scene.scale.setScalar(scale);
  // re-center on X/Z (rig origins vary) and drop feet to y=0 within the group
  const box2 = new THREE.Box3().setFromObject(scene);
  scene.position.x -= (box2.min.x + box2.max.x) / 2;
  scene.position.z -= (box2.min.z + box2.max.z) / 2;
  scene.position.y -= box2.min.y;
  if (opts.yaw) scene.rotation.y = opts.yaw;
  // Real XZ footprint (half-extent of the post-scale bounding box, at the
  // group's base scale of 1; Enemy.update multiplies this by the same
  // miniboss/elite factor it applies to the mesh group's own scale) so the
  // separation/stand-off logic in enemies.js can keep modeled creatures from
  // visually overlapping each other or the player, independent of the
  // smaller gameplay hit-circle (ENEMY_TYPES radius) used for hitboxes.
  const footprintRadius = Math.max(box2.max.x - box2.min.x, box2.max.z - box2.min.z) / 2;

  // Every rig in this pack (KayKit skeletons + Quaternius creatures) ships a
  // bone literally named "head"/"Head" (verified against every GLB used
  // here), so a single case-insensitive lookup covers all of them for the
  // look-at-player tracking below, no per-family special-casing needed.
  //
  // EXCEPT the Dungeon Lord dragon (bossAct5): its head bone's rest
  // orientation and parent-space axes don't match the shared assumption the
  // yaw-only lookAt below is built on (its local forward isn't +Z, and the
  // 100x-scaled Armature root noted above further skews the parent world
  // matrix), so converting a pure-yaw world quaternion into that bone's parent
  // space yields a wildly off-axis local target and the head twists/clips as
  // it moves. The dragon already faces the player via the whole group's
  // rotation.y (Enemy.update), so per-frame head tracking buys nothing for it:
  // skip look-at entirely for this rig, keep it for every other creature.
  const allowLookAt = !SINGLETON_MODEL_KEYS.has(modelKey);
  let headBone = null;
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      if (o.material) {
        o.material = o.material.clone();
        // share texture instances across parses of the same file (see
        // dedupeMaterialTextures above) BEFORE any per-family map swap
        dedupeMaterialTextures(file, o.material);
        // skeleton-family rigs: swap the shared bone atlas for the whitened
        // one (see whitenedBoneTexture above) so bone reads white, not the
        // warm cream that torchlight pushes to yellow. Keyed to the material
        // actually named "skeleton" so the "Glow" eye material is untouched.
        if (SKELETON_BONE_KEYS.has(modelKey) && o.material.map && /skeleton/i.test(o.material.name || '')) {
          const white = whitenedBoneTexture(file, o.material.map);
          if (white) {
            o.material.map = white;
            o.material.needsUpdate = true;
          }
        }
        if (opts.tint != null && o.material.color) {
          o.material.color.lerp(new THREE.Color(opts.tint), opts.tintStrength ?? 0.35);
        }
      }
    }
    if (!headBone && /^head$/i.test(o.name)) headBone = o;
  });
  // Remember the bone's rest (bind-pose) local rotation so lookAt can apply
  // its aim as an OFFSET from rest each frame rather than an absolute
  // rotation. The walk/attack/idle clips already drive this bone's rotation
  // every frame via the AnimationMixer, so lookAt has to compose with that
  // (nudge toward the player) instead of fighting it (snapping to a fixed
  // world orientation, which would freeze the animation's own head motion).
  if (headBone) headBone.userData.restQuat = headBone.quaternion.clone();

  // Clear the box placeholder's children (EXCEPT the miniboss/elite glow crown,
  // which enemies.js parents directly on this group and which Enemy re-tints
  // for gilded elites, see attachEnemyModel's caller), then mount the modeled
  // creature as a child wrapper so the group's own transform
  // (position/scale/rotation.y, all driven by Enemy.update) still works
  // exactly as before.
  let crown = null;
  for (let i = group.children.length - 1; i >= 0; i--) {
    const c = group.children[i];
    if (c.name === 'MinibossCrown') { crown = c; continue; }
    // the overhead health bar sprite (enemies.js) also survives the swap; its
    // owner re-seats it above the modeled height via userData.modelHeight
    if (c.name === 'HpBar') continue;
    group.remove(c);
    c.geometry?.dispose?.();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose?.());
  }
  group.add(scene);
  if (crown) crown.position.y = targetHeight + 0.18; // sit just above the modeled creature's real crown
  group.userData.gait = null; // modeled creatures animate via mixer, not the box gait rig
  group.userData.modeled = true;
  group.userData.footprintRadius = footprintRadius;
  // real ground-to-crown height in group-local units, for the overhead health
  // bar (enemies.js) to seat itself above the modeled head
  group.userData.modelHeight = targetHeight;

  const mixer = new THREE.AnimationMixer(scene);
  const clipSetId = TYPE_CLIP_SET[modelKey] || 'biped';
  const clipNames = CLIP_SETS[clipSetId];
  const findClip = (name) => gltf.animations.find((a) => a.name === name) || null;
  const actions = {};
  const mk = (name, loopOnce = false) => {
    const clip = findClip(name);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    if (loopOnce) { action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; }
    return action;
  };
  actions.idle = mk(clipNames.idle);
  actions.walk = mk(clipNames.walk);
  // Distinct run clip for stride matching (see STRIDE_TABLE above). Some
  // families (spider) point walk and run at the same clip name, in which case
  // mixer.clipAction returns the SAME action for both and there is no real
  // "run" state to switch to; setLocomotion checks for that via hasRun below.
  actions.run = mk(clipNames.run);
  // Attack VARIETY: register every attack clip this family lists that the GLB
  // actually has (1-3), each as its own one-shot action, so playAttack() can
  // pick a different swing/spell each time instead of always the same one.
  // actions.attack stays as the first variant for any code that just wants
  // "an" attack action to check truthiness against.
  const attackActions = [];
  for (const name of clipNames.attack) {
    const clip = findClip(name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce);
    action.clampWhenFinished = true;
    attackActions.push(action);
  }
  actions.attackVariants = attackActions;
  actions.attack = attackActions[0] || null;
  actions.death = mk(clipNames.death, true);
  actions.flourish = clipNames.flourish ? mk(clipNames.flourish, true) : null;
  (actions.idle || actions.walk)?.play();

  // Stride-matching config for this instance (null for floating/hover types,
  // which are exempt - see STRIDE_TABLE above). `hasRun` is false when the
  // family has no distinct run clip (walk and run resolved to the same
  // THREE.AnimationAction), so setLocomotion never tries to switch to it.
  const strideCfg = STRIDE_TABLE[clipSetId] || null;
  const stride = strideCfg
    ? { ...strideCfg, hasRun: !!(actions.run && actions.run !== actions.walk) }
    : null;

  const anim = {
    mixer,
    actions,
    headBone,
    allowLookAt,
    stride,
    current: 'idle',
    _attackT: 0,
    _lookQuat: headBone ? new THREE.Quaternion() : null,
    // Crossfades from whatever's currently playing to `want` (idle/walk/run),
    // used by both the stride-matched and hover locomotion paths below.
    _goTo(want) {
      if (want === this.current || !this.actions[want]) return;
      const from = this.actions[this.current];
      const to = this.actions[want];
      to.reset().play();
      if (from && from !== to) from.crossFadeTo(to, 0.15, false);
      this.current = want;
    },
    // Called every animated frame from Enemy._animateGait's modeled path with
    // the creature's ACTUAL horizontal speed in world units/sec (not a 0..1
    // fraction of its own top speed) so the clip's timescale can be matched
    // against its real natural stride speed instead of drifting relative to
    // whatever that particular type's top speed happens to be.
    setLocomotion(actualSpeed) {
      if (this._attackT > 0) return; // let an in-flight attack clip finish
      const moving = actualSpeed > 0.12;
      if (!this.stride) {
        // Floating/hover types: exempt from stride matching (they don't
        // touch a stride to the ground), but still get a mild fly-anim rate
        // bump on top of speed so a sprinting dragon flaps a bit quicker
        // than an idle-chasing imp, without pretending it's ground contact.
        this._goTo(moving ? 'walk' : 'idle');
        if (this.actions.walk) {
          const ratio = actualSpeed / HOVER_REFERENCE_SPEED;
          this.actions.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(0.8 + ratio * 0.35, 0.75, 1.35));
        }
        return;
      }
      const useRun = this.stride.hasRun && actualSpeed > this.stride.crossover;
      const want = !moving ? 'idle' : useRun ? 'run' : 'walk';
      this._goTo(want);
      if (moving) {
        const natural = useRun ? this.stride.run : this.stride.walk;
        const ts = THREE.MathUtils.clamp(actualSpeed / natural, STRIDE_TS_MIN, STRIDE_TS_MAX);
        this.actions[want]?.setEffectiveTimeScale(ts);
      }
    },
    // Picks a random variant when the type has more than one attack clip (see
    // CLIP_SETS above), so the same mob doesn't play one identical swing every
    // time. Stops any other variant first so two attack poses never blend.
    playAttack() {
      const variants = this.actions.attackVariants;
      if (!variants || !variants.length) return;
      const a = variants.length > 1 ? variants[Math.floor(Math.random() * variants.length)] : variants[0];
      for (const other of variants) if (other !== a) other.stop();
      a.reset().play();
      this._attackT = a.getClip().duration / Math.max(0.1, a.getEffectiveTimeScale());
    },
    playDeath() {
      this.actions.death?.reset().play();
    },
    update(dt) {
      if (this._attackT > 0) this._attackT = Math.max(0, this._attackT - dt);
      this.mixer.update(dt);
    },
    // Eyes-on-you: nudge the head bone to face a world-space point (the
    // player), on top of whatever pose the mixer just set it to this frame.
    // Applied as a clamped slerp toward a look quaternion computed from the
    // bone's LOCAL frame (not a world-space snap), so it composes with the
    // running idle/walk/attack clip instead of overriding it outright, a
    // subtle tracking nudge, not a hard override. Cheap: one atan2 + one
    // slerp per call, and the caller (Enemy._animateGait) only invokes this
    // for near/aggroed enemies, never the whole floor at once.
    lookAtTarget(worldX, worldY, worldZ, maxAngle = 0.5) {
      const bone = this.headBone;
      if (!bone || !this.allowLookAt) return;
      bone.updateWorldMatrix(true, false);
      const headWorldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      const toTarget = new THREE.Vector3(worldX - headWorldPos.x, 0, worldZ - headWorldPos.z);
      if (toTarget.lengthSq() < 0.0001) return;
      toTarget.normalize();
      // Build the desired world-facing quaternion, then convert it into the
      // bone's PARENT space so it can be applied as a local quaternion the
      // same way the baked animation clip already drives this bone.
      const parent = bone.parent;
      parent.updateWorldMatrix(true, false);
      const parentQuatInv = new THREE.Quaternion().setFromRotationMatrix(parent.matrixWorld).invert();
      const worldLook = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), toTarget);
      const localLook = parentQuatInv.multiply(worldLook);
      // Clamp: blend only part-way from the animated pose toward the look
      // target, and only if the raw angular distance is within maxAngle, so
      // a creature already facing roughly the right way tracks smoothly and
      // one facing sharply away doesn't snap its head around unnaturally.
      const angle = bone.quaternion.angleTo(localLook);
      if (angle > maxAngle * 2.2) return; // too far off-axis to sell as a look, not a snap-turn
      bone.quaternion.slerp(localLook, Math.min(1, (maxAngle / Math.max(angle, 0.001)) * 0.35));
    },
  };
  group.userData.anim = anim;
  return anim;
}

export function typeModelKey(typeId) {
  return MODEL_FILES[typeId] ? typeId : null;
}
