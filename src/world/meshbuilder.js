import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR, WALL, DOOR, PIT, BRIDGE, RUBBLE, CHASM, TOWN_PLAZA_HEIGHT } from './dungeon.js';
import { makeFloorTexture, makeWallTexture, makeWoodTexture, makeGrassTexture, makeCobbleTexture, makeCobwebTexture, makeBannerTexture, makeGlowTexture, makeRuneTexture, makeExteriorSignTexture, floorRng, jitterAccentHue } from './textures.js';
import { buildPortal } from './portal.js';
import { buildAnimatedHero } from '../entities/heroModel.js';

// ---------------- Modeled human NPCs ----------------
// Town/tavern NPCs (vendors, barkeep, patrons, Fenwick) are drawn with the
// same KayKit adventurer GLBs the heroes use, via heroModel.buildAnimatedHero:
// the models are loaded-once + SkeletonUtils.clone-per-instance and each gets
// its own idle-playing AnimationMixer (heroModel plays the idle clip on
// build). We pick a class body per NPC so each reads as a distinct person and
// pass the hero gender/skinTone cosmetic hooks to match the NPC's voice.
//
// buildAnimatedHero returns null when the GLB isn't loaded (or the class has
// no model), so every caller keeps its original primitive box-build as a
// fallback and no NPC is ever left invisible.

// The KayKit rigs stand ~1.6 world units tall (heroModel's TARGET_HEIGHT).
// Townsfolk (vendors, barkeep, patrons) read at full hero height beside the
// player. Old Fenwick applies his own FENWICK_SCALE (wanderer.js) on top of
// this, landing taller (1.0 * 1.25 = 1.25x hero height) so he still reads
// clearly above every other townsperson.
const NPC_SCALE = 1.0;

// Wrap buildAnimatedHero for a stationary, idling townsperson that can glance
// at the player. Returns { mesh, mixer, headBone, restQuat, tick(dt),
// lookAt(x,z) } or null so the caller can fall back to its box build. `opts`
// forwards { gender, skinTone } to the hero cosmetic system so the body's
// apparent gender matches the NPC's voice.
export function buildNpcModel(classId, name, opts = {}) {
  const hero = buildAnimatedHero(classId, name || 'Townsfolk', opts);
  if (!hero) return null;
  const mesh = hero.mesh;
  // Mark the rig as a townsperson so the shared hero lookup below can tell
  // NPC bodies apart from actual player heroes (both come from the same
  // KayKit builder and otherwise look identical to a scene query).
  mesh.userData.townNpc = true;
  mesh.scale.multiplyScalar(NPC_SCALE);
  // Find the rig's head bone once so we can nudge it toward the player. Every
  // KayKit adventurer rig names it "head" (verified against the GLBs), same as
  // the enemy rigs, so one case-insensitive lookup covers all three classes.
  let headBone = null;
  mesh.traverse((o) => { if (!headBone && /^head$/i.test(o.name)) headBone = o; });
  const restQuat = headBone ? headBone.quaternion.clone() : null;

  return {
    mesh,
    mixer: hero.mixer,
    headBone,
    restQuat,
    _t: Math.random() * 10,
    // Advance the idle animation. Call every frame the NPC is on screen.
    tick(dt) { this.mixer.update(dt); },
    // Cheap eyes-on-you: slerp the head bone a little toward a world point,
    // composed on top of the idle clip (same approach as enemyModel's
    // lookAtTarget - a subtle tracking nudge, never a hard snap). Restores
    // toward the rest pose when no target is given so the head doesn't stick.
    lookAt(worldX, worldZ, maxAngle = 0.55) {
      const bone = this.headBone;
      if (!bone || !this.restQuat) return;
      if (worldX == null) { bone.quaternion.slerp(this.restQuat, 0.2); return; }
      bone.updateWorldMatrix(true, false);
      const hp = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      const to = new THREE.Vector3(worldX - hp.x, 0, worldZ - hp.z);
      if (to.lengthSq() < 1e-4) return;
      to.normalize();
      const parent = bone.parent;
      parent.updateWorldMatrix(true, false);
      // normalize(): the rig is uniformly scaled (NPC_SCALE etc.), which makes
      // setFromRotationMatrix return a non-unit quaternion; left unnormalized
      // it inflates angleTo below past the bail-out gate and the head never
      // turns at all.
      const parentInv = new THREE.Quaternion().setFromRotationMatrix(parent.matrixWorld).normalize().invert();
      const worldLook = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), to);
      const localLook = parentInv.multiply(worldLook);
      const angle = bone.quaternion.angleTo(localLook);
      if (angle > maxAngle * 2.2) { bone.quaternion.slerp(this.restQuat, 0.2); return; }
      bone.quaternion.slerp(localLook, Math.min(1, (maxAngle / Math.max(angle, 0.001)) * 0.3));
    },
  };
}

// Eyes-on-you for the stationary townsfolk (vendors, barkeep, patrons): find
// the nearest player hero within glance range of an NPC without any game.js
// plumbing. Hero meshes are located by scene query from the NPC's own scene
// root: every buildAnimatedHero rig carries userData.headAnchor (heroModel.js
// sets it for helmet seating), and buildNpcModel marks its own rigs with
// userData.townNpc above, so "headAnchor and not townNpc" is exactly the set
// of player heroes (local + co-op remotes; tracking whichever is nearest is
// the right read in co-op anyway). The list is re-collected at most once a
// second, or immediately when a cached hero left the scene (the player mesh
// is rebuilt on gear swaps), so the per-frame cost is a few distance checks.
const NPC_LOOK_RANGE = 6;
const _heroLookup = { root: null, heroes: [], nextScanAt: 0 };
const _npcWorldPos = new THREE.Vector3();
const _heroWorldPos = new THREE.Vector3();
function nearestHeroTarget(npcMesh) {
  let root = npcMesh;
  while (root.parent) root = root.parent;
  const now = performance.now();
  if (root !== _heroLookup.root || now >= _heroLookup.nextScanAt || _heroLookup.heroes.some((h) => !h.parent)) {
    _heroLookup.root = root;
    _heroLookup.nextScanAt = now + 1000;
    _heroLookup.heroes.length = 0;
    root.traverse((o) => { if (o.userData.headAnchor && !o.userData.townNpc) _heroLookup.heroes.push(o); });
  }
  if (!_heroLookup.heroes.length) return null;
  npcMesh.getWorldPosition(_npcWorldPos);
  let best = null;
  let bestD = NPC_LOOK_RANGE;
  for (const h of _heroLookup.heroes) {
    h.getWorldPosition(_heroWorldPos);
    const d = Math.hypot(_heroWorldPos.x - _npcWorldPos.x, _heroWorldPos.z - _npcWorldPos.z);
    if (d < bestD) { bestD = d; best = [_heroWorldPos.x, _heroWorldPos.z]; }
  }
  return best;
}

// Register an NPC anim controller so its mixer advances every frame WITHOUT
// touching game.js: game.js iterates dungeonMeshes.smokePuffs each frame and,
// for every entry, evaluates `puff.phase = (puff.phase||0) + dt*(puff.speed)`
// before dispatching on `puff.kind`. We expose `phase` as an accessor: the
// assignment hands us the new phase, from which (knowing speed) we recover dt
// and drive mixer.update + the look-at. `kind:'firefly'` then makes game.js's
// loop hit an early `continue` after only writing position.y on our throwaway
// dummy Object3D (never added to any scene), so nothing else is disturbed.
// `getTarget()` returns [x,z] to glance at or null to relax; when the caller
// passes no getTarget the driver defaults to tracking the nearest player hero
// within NPC_LOOK_RANGE (see nearestHeroTarget above), which is what every
// stationary townsperson wants.
export function pushNpcAnimDriver(smokePuffs, npc, getTarget) {
  if (!smokePuffs) return;
  const SPEED = 1;
  const driver = {
    kind: 'firefly',
    mesh: new THREE.Object3D(), // dummy: firefly branch only sets its position.y
    baseY: 0,
    speed: SPEED,
    _phase: 0,
    get phase() { return this._phase; },
    set phase(v) {
      const dt = Math.min(0.1, Math.max(0, (v - this._phase) / SPEED));
      this._phase = v;
      npc.tick(dt);
      const t = getTarget ? getTarget() : nearestHeroTarget(npc.mesh);
      if (t) npc.lookAt(t[0], t[1]); else npc.lookAt(null);
    },
  };
  smokePuffs.push(driver);
}

// ---------------- Modeled world assets (CC0 packs via poly.pizza) ----------------
// Static nature/prop GLBs (Quaternius nature packs, see CREDITS.md) replacing
// the procedural primitive trees, grass, bushes and market props. Same
// load-once cache idea as heroModel/enemyModel, but for UNskinned meshes: each
// GLB is parsed once into a lightweight template (world-baked geometry merged
// per material, normalized to unit height with its base at y=0), and every use
// site draws it through InstancedMesh (many placements, one draw call per
// material) or a couple of shared-geometry Meshes for one-off props. Nothing
// here is skinned, so no SkeletonUtils cloning is involved anywhere (skinned
// clones render invisible on some GPUs; static geometry has no such problem).
//
// Every REPLACED placement keeps its procedural primitive build as the
// fallback: the swap only happens after a GLB resolves and yields renderable
// geometry, so a failed or missing model never leaves a gap in the town.
// Purely ADDITIVE dressing (grass tufts, meadow rocks) simply does not appear
// if its model fails, which leaves the town exactly as it was before.
const WORLD_MODEL_FILES = {
  treeBirch: 'models/world/tree_birch.glb',
  treeOak: 'models/world/tree_oak.glb',
  treeWillow: 'models/world/tree_willow.glb',
  pine: 'models/world/pine_tree.glb',
  grassA: 'models/world/grass_a.glb',
  grassB: 'models/world/grass_b.glb',
  bush: 'models/world/bush.glb',
  rockA: 'models/world/rock_a.glb',
  rockB: 'models/world/rock_b.glb',
  barrel: 'models/world/barrel.glb',
  crate: 'models/world/crate.glb',
  stall: 'models/world/stall.glb',
  inn: 'models/world/inn.glb',
};

const worldLoader = new GLTFLoader();
// key -> Promise<template|null>; a failed load caches null so the procedural
// fallback stays and the file is never re-fetched in a loop.
const _worldTplCache = new Map();

// Parse a loaded GLB into { pieces: [{ geometry, material }] }: every mesh's
// world transform is baked into a cloned geometry, geometries sharing a
// material are merged into one, and the whole model is normalized so its base
// sits at y=0, its XZ center at the origin, and its height is exactly 1 world
// unit. A per-instance scale is therefore simply the desired world height.
function gltfToTemplate(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!Number.isFinite(size.y) || size.y < 1e-5) return null;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const s = 1 / size.y;
  const norm = new THREE.Matrix4().makeScale(s, s, s)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  const byMat = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !(o.geometry?.getAttribute?.('position')?.count > 0)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, o.matrixWorld));
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  });
  if (!byMat.size) return null;
  const pieces = [];
  for (const [mat, geos] of byMat) {
    const merged = geos.length > 1 ? (mergeGeometries(geos) || geos[0]) : geos[0];
    // The source packs export metalness ~0.4, which renders as dark glass
    // under the game's point lights (metals need an environment map to read
    // right). Clamp to a plain matte look matching the town's own materials.
    const m = mat.clone();
    if ('metalness' in m) m.metalness = 0;
    if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 1, 0.9);
    pieces.push({ geometry: merged, material: m });
  }
  return { pieces };
}

function loadWorldTemplate(key) {
  let p = _worldTplCache.get(key);
  if (!p) {
    const file = WORLD_MODEL_FILES[key];
    p = worldLoader.loadAsync(import.meta.env.BASE_URL + file)
      .then((gltf) => gltfToTemplate(gltf))
      .catch((err) => {
        console.warn(`World model failed to load (${file}); procedural build stays.`, err);
        return null;
      });
    _worldTplCache.set(key, p);
  }
  return p;
}

// One InstancedMesh per template piece, so N placements of a model cost one
// draw call per material no matter how large N is. `transforms` entries are
// { x, z, s, ry, y? }: world position, uniform scale (world height, thanks to
// the unit-height normalization above), yaw, optional base height.
function buildModelInstances(tpl, transforms) {
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sv = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (const piece of tpl.pieces) {
    const im = new THREE.InstancedMesh(piece.geometry, piece.material, transforms.length);
    transforms.forEach((t, i) => {
      q.setFromAxisAngle(up, t.ry || 0);
      sv.setScalar(t.s || 1);
      p.set(t.x, t.y || 0, t.z);
      m.compose(p, q, sv);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    // The shared geometry's bounds cover one unit-height model, not the whole
    // spread of instances, so default frustum culling would wrongly hide the
    // set whenever the origin instance leaves the view.
    im.frustumCulled = false;
    group.add(im);
  }
  return group;
}

// A one-off (non-instanced) placement: plain Meshes sharing the template's
// geometry and material, scaled to the given world height. `tints` optionally
// maps a source material NAME to a color: those pieces get a cloned material
// lerped toward the color (used to color-code the vendor stall canopies).
function buildModelMesh(tpl, height, tints) {
  const g = new THREE.Group();
  for (const piece of tpl.pieces) {
    let mat = piece.material;
    const tint = tints && tints[mat.name];
    if (tint != null && mat.color) {
      mat = mat.clone();
      mat.color.lerp(new THREE.Color(tint), 0.85);
    }
    g.add(new THREE.Mesh(piece.geometry, mat));
  }
  g.scale.setScalar(height);
  return g;
}

// Swap a procedural fallback for its modeled build once the GLB templates
// resolve. `build(tpls)` receives the templates (entries may be null on load
// failure) and returns the replacement node or null to keep the fallback.
// Passing fallback=null makes it purely additive dressing. Only geometries of
// the removed fallback are disposed; materials may be shared with props that
// stay (wood/trunk materials), so they are left alone.
function swapInModel(parent, fallback, keys, build) {
  Promise.all(keys.map(loadWorldTemplate)).then((tpls) => {
    if (fallback && fallback.parent !== parent) return; // town was rebuilt/unloaded meanwhile
    if (tpls.every((t) => !t)) return;
    const node = build(tpls);
    if (!node) return;
    if (fallback) {
      parent.remove(fallback);
      fallback.traverse((o) => o.geometry?.dispose?.());
    }
    parent.add(node);
  });
}

// Seeded LCG for model placement/rotation, mirroring the srand pattern town
// generation uses (dungeon.js) so co-op guests scatter identical grass.
function worldRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------- Modeled dungeon architecture (KayKit Dungeon Remastered, CC0) ----------------
// Floor/wall/pillar/door-arch/torch/rubble GLBs replace the old box-primitive
// dungeon geometry built by buildDungeonMeshes above. That box geometry is
// built first and kept as the permanent, silent fallback: this swap only
// removes it once the matching GLB actually resolves to renderable geometry.
// Every cell's variant + 90-degree rotation is derived purely from
// (floor, cellX, cellY) via cellSeed(), never from array order or Math.random,
// so a revisited floor renders an identical layout+variant mix every time.
const DUNGEON_MODEL_FILES = {
  floorLarge: 'models/dungeon/floor_tile_large.gltf.glb',
  floorRocky: 'models/dungeon/floor_tile_large_rocks.gltf.glb',
  floorBrokenA: 'models/dungeon/floor_tile_small_broken_A.gltf.glb',
  floorBrokenB: 'models/dungeon/floor_tile_small_broken_B.gltf.glb',
  wall: 'models/dungeon/wall.gltf.glb',
  wallCracked: 'models/dungeon/wall_cracked.gltf.glb',
  wallBroken: 'models/dungeon/wall_broken.gltf.glb',
  pillar: 'models/dungeon/pillar.gltf.glb',
  doorArch: 'models/dungeon/wall_doorway.glb',
  torch: 'models/dungeon/torch_mounted.gltf.glb',
  rubbleHalf: 'models/dungeon/rubble_half.gltf.glb',
  rubbleLarge: 'models/dungeon/rubble_large.gltf.glb',
};
const dungeonLoader = new GLTFLoader();
const _dungeonTplCache = new Map();

// Like gltfToTemplate above, but keeps the model's AUTHORED proportions
// instead of renormalizing to unit height: floor tiles are wide and nearly
// flat, and wall panels are wide/tall/thin, so a height-based unit scale would
// blow either of those up absurdly. Callers scale each axis explicitly to fit
// TILE / WALL_HEIGHT. Only recenters XZ at the origin and drops the base to y=0.
function gltfToArchTemplate(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!Number.isFinite(size.x) || size.x < 1e-5) return null;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const norm = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
  const byMat = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !(o.geometry?.getAttribute?.('position')?.count > 0)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, o.matrixWorld));
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  });
  if (!byMat.size) return null;
  const pieces = [];
  for (const [mat, geos] of byMat) {
    const merged = geos.length > 1 ? (mergeGeometries(geos) || geos[0]) : geos[0];
    const m = mat.clone();
    if ('metalness' in m) m.metalness = 0;
    if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 1, 0.9);
    pieces.push({ geometry: merged, material: m });
  }
  return { pieces, size: { x: size.x, y: size.y, z: size.z } };
}

function loadDungeonTemplate(key) {
  let p = _dungeonTplCache.get(key);
  if (!p) {
    const file = DUNGEON_MODEL_FILES[key];
    p = dungeonLoader.loadAsync(import.meta.env.BASE_URL + file)
      .then((gltf) => gltfToArchTemplate(gltf))
      .catch((err) => {
        console.warn(`Dungeon model failed to load (${file}); box fallback stays.`, err);
        return null;
      });
    _dungeonTplCache.set(key, p);
  }
  return p;
}

// Deterministic seed in [0,1) from (floor, cellX, cellY, salt). Pure function
// of the cell's own coordinates, so revisiting a floor (or a co-op guest
// generating the same floor independently) always picks the same variant and
// rotation per cell, with no dependency on iteration order or Math.random.
function cellSeed(floor, x, y, salt = 0) {
  let h = ((floor * 374761393) ^ (x * 668265263) ^ (y * 2246822519) ^ (salt * 3266489917)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

// Clones a template's materials and lerps each toward `color` by `amt`, so the
// shared cached template's original materials stay untouched (per-theme tint).
function tintTemplate(tpl, color, amt) {
  return { pieces: tpl.pieces.map((p) => {
    const mat = p.material.clone();
    if (mat.color) mat.color.lerp(color, amt);
    return { geometry: p.geometry, material: mat };
  }) };
}

// One InstancedMesh per template piece from placements of
// { x, y, z, ry, sx, sy, sz } (world position, yaw, per-axis scale).
function buildArchInstances(tpl, placements) {
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sv = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (const piece of tpl.pieces) {
    const im = new THREE.InstancedMesh(piece.geometry, piece.material, placements.length);
    placements.forEach((pl, i) => {
      q.setFromAxisAngle(up, pl.ry || 0);
      sv.set(pl.sx ?? 1, pl.sy ?? 1, pl.sz ?? 1);
      p.set(pl.x, pl.y || 0, pl.z);
      m.compose(p, q, sv);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
  }
  return group;
}

// Swaps the box-primitive floor/wall/torch geometry for modeled KayKit pieces
// once their GLBs resolve, and adds purely-additive corner pillars, door
// archways, and scattered rubble/debris. Dungeon-only (town keeps its
// procedural grass/garden-wall look, per design). Fully async: nothing here
// blocks or delays the box fallback already visible in `group`.
function dressDungeonArchitecture(group, dungeon, theme, floor, ctx) {
  const { grid } = dungeon;
  const { floorMesh, floorRenderTiles, wallMesh, wallDecorMeshes, renderWalls, sconceMeshes, torchPositions } = ctx;
  const wallColor = new THREE.Color(theme.wall);
  const floorColor = new THREE.Color(theme.floor);

  const keys = ['floorLarge', 'floorRocky', 'floorBrokenA', 'floorBrokenB', 'wall', 'wallCracked', 'wallBroken', 'pillar', 'doorArch', 'torch', 'rubbleHalf', 'rubbleLarge'];
  Promise.all(keys.map(loadDungeonTemplate)).then(([floorLarge, floorRocky, floorBrokenA, floorBrokenB, wallT, wallCracked, wallBroken, pillarT, doorArchT, torchT, rubbleHalf, rubbleLarge]) => {
    if (floorMesh.parent !== group) return; // dungeon torn down/rebuilt meanwhile

    // --- Floors: variant + 90-degree rotation per cell ---
    const bigVariants = [floorLarge, floorRocky].filter(Boolean);
    const brokenVariants = [floorBrokenA, floorBrokenB].filter(Boolean);
    if (bigVariants.length || brokenVariants.length) {
      const byTpl = new Map();
      for (const tp of floorRenderTiles) {
        const isRubbleFloor = grid[tp.y]?.[tp.x] === RUBBLE;
        const pool = isRubbleFloor && brokenVariants.length ? brokenVariants : (bigVariants.length ? bigVariants : brokenVariants);
        if (!pool.length) continue;
        const tpl = pool[Math.floor(cellSeed(floor, tp.x, tp.y, 1) * pool.length) % pool.length];
        const scale = pool === brokenVariants ? TILE / 2 : TILE / 4;
        const rot = Math.floor(cellSeed(floor, tp.x, tp.y, 2) * 4) * (Math.PI / 2);
        const w = tileToWorld(tp.x, tp.y);
        if (!byTpl.has(tpl)) byTpl.set(tpl, []);
        byTpl.get(tpl).push({ x: w.x, y: 0, z: w.z, ry: rot, sx: scale, sy: scale, sz: scale });
      }
      const floorGroup = new THREE.Group();
      for (const [tpl, placements] of byTpl) floorGroup.add(buildArchInstances(tintTemplate(tpl, floorColor, 0.3), placements));
      if (floorGroup.children.length) {
        group.remove(floorMesh);
        floorMesh.geometry.dispose();
        group.add(floorGroup);
      }
    }

    // --- Walls: variant (mostly intact, some cracked, fewer broken) + rotation ---
    const wallVariants = [
      { tpl: wallT, w: 0.55 },
      { tpl: wallCracked, w: 0.30 },
      { tpl: wallBroken, w: 0.15 },
    ].filter((v) => v.tpl);
    if (wallVariants.length && renderWalls.length) {
      const byTpl = new Map();
      for (const tp of renderWalls) {
        const roll = cellSeed(floor, tp.x, tp.y, 3);
        let acc = 0, chosen = wallVariants[0].tpl;
        for (const v of wallVariants) { acc += v.w; if (roll < acc) { chosen = v.tpl; break; } }
        const rot = Math.floor(cellSeed(floor, tp.x, tp.y, 4) * 4) * (Math.PI / 2);
        const w = tileToWorld(tp.x, tp.y);
        if (!byTpl.has(chosen)) byTpl.set(chosen, []);
        // native wall footprint is 4 wide x 4 tall x 1 thick: scale each axis
        // to exactly fill one TILE x WALL_HEIGHT x TILE cell (thickness
        // stretched to TILE too) so the cell is fully solid no matter the yaw.
        byTpl.get(chosen).push({ x: w.x, y: 0, z: w.z, ry: rot, sx: TILE / 4, sy: WALL_HEIGHT / 4, sz: TILE / 1 });
      }
      const wallGroup = new THREE.Group();
      for (const [tpl, placements] of byTpl) wallGroup.add(buildArchInstances(tintTemplate(tpl, wallColor, 0.3), placements));
      if (wallGroup.children.length) {
        group.remove(wallMesh);
        wallMesh.geometry.dispose();
        for (const dm of wallDecorMeshes) { group.remove(dm); dm.geometry?.dispose?.(); }
        group.add(wallGroup);
      }
    }

    // --- Pillars: additive, at outward wall corners bordering open floor ---
    if (pillarT && wallVariants.length) {
      const placements = [];
      for (const tp of renderWalls) {
        const n = grid[tp.y - 1]?.[tp.x] === WALL, s = grid[tp.y + 1]?.[tp.x] === WALL;
        const e = grid[tp.y]?.[tp.x + 1] === WALL, w2 = grid[tp.y]?.[tp.x - 1] === WALL;
        const vertPair = (n && !s) || (!n && s), horizPair = (e && !w2) || (!e && w2);
        if (!(vertPair && horizPair)) continue; // needs exactly one wall neighbor each axis (an L corner)
        if (cellSeed(floor, tp.x, tp.y, 5) > 0.45) continue; // sparse, not every corner
        const w = tileToWorld(tp.x, tp.y);
        placements.push({ x: w.x, y: 0, z: w.z, ry: cellSeed(floor, tp.x, tp.y, 6) * Math.PI * 2, sx: WALL_HEIGHT / 4, sy: WALL_HEIGHT / 4, sz: WALL_HEIGHT / 4 });
      }
      if (placements.length) group.add(buildArchInstances(tintTemplate(pillarT, wallColor, 0.25), placements));
    }

    // --- Door archways: additive stone frame around the existing wood door ---
    if (doorArchT && dungeon.doors?.length) {
      const placements = dungeon.doors.map((d) => {
        const w = tileToWorld(d.x, d.y);
        return { x: w.x, y: 0, z: w.z, ry: d.vertical ? 0 : Math.PI / 2, sx: TILE / 4, sy: WALL_HEIGHT / 4, sz: TILE / 1 };
      });
      group.add(buildArchInstances(tintTemplate(doorArchT, wallColor, 0.3), placements));
    }

    // --- Torches: modeled sconce body, swapped in behind the untouched flame/glow/light ---
    if (torchT && sconceMeshes.length) {
      const s = TILE * 0.28;
      const placements = torchPositions.map((tp, i) => ({ x: tp.x, y: (tp.y ?? 2) - 0.4, z: tp.z, ry: cellSeed(floor, i, 0, 7) * Math.PI * 2, sx: s, sy: s, sz: s }));
      if (placements.length) {
        group.add(buildArchInstances(tintTemplate(torchT, wallColor, 0.15), placements));
        for (const sc of sconceMeshes) { group.remove(sc); sc.geometry?.dispose?.(); }
      }
    }

    // --- Decay dressing: scattered rubble/debris piles near walls (additive) ---
    const rubbleVariants = [rubbleHalf, rubbleLarge].filter(Boolean);
    if (rubbleVariants.length) {
      const byTpl = new Map();
      for (const tp of floorRenderTiles) {
        if (cellSeed(floor, tp.x, tp.y, 8) > 0.1) continue; // sparse scatter
        const nearWall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => grid[tp.y + dy]?.[tp.x + dx] === WALL);
        if (!nearWall) continue;
        const tpl = rubbleVariants[Math.floor(cellSeed(floor, tp.x, tp.y, 9) * rubbleVariants.length) % rubbleVariants.length];
        const scale = 0.16 + cellSeed(floor, tp.x, tp.y, 10) * 0.14;
        const jx = (cellSeed(floor, tp.x, tp.y, 11) - 0.5) * TILE * 0.5;
        const jz = (cellSeed(floor, tp.x, tp.y, 12) - 0.5) * TILE * 0.5;
        const rot = cellSeed(floor, tp.x, tp.y, 13) * Math.PI * 2;
        const w = tileToWorld(tp.x, tp.y);
        if (!byTpl.has(tpl)) byTpl.set(tpl, []);
        byTpl.get(tpl).push({ x: w.x + jx, y: 0, z: w.z + jz, ry: rot, sx: scale, sy: scale, sz: scale });
      }
      for (const [tpl, placements] of byTpl) group.add(buildArchInstances(tintTemplate(tpl, wallColor, 0.2), placements));
    }
  });
}

// ---------------- Destructible interior walls ----------------
// A broken/fallen stone stub + a few loose chunks, textured with the wall's
// own stone map so it reads as "this wall came down" rather than generic
// gravel. Purely decorative and never blocks movement (the grid cell is
// FLOOR the moment this is placed) — distinct from the RUBBLE tile type
// (dungeon.js), which is a still-SOLID crumbled wall used for ruin dressing.
function spawnWallRubblePile(group, wallTex, x, z) {
  const rubbleMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 });
  const stub = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.85, 0.45 + Math.random() * 0.35, TILE * 0.85), rubbleMat);
  stub.position.set(x, stub.geometry.parameters.height / 2, z);
  stub.rotation.y = (Math.random() - 0.5) * 0.3;
  group.add(stub);
  for (let c = 0; c < 4; c++) {
    const s = 0.16 + Math.random() * 0.22;
    const chunk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rubbleMat);
    chunk.position.set(x + (Math.random() - 0.5) * 1.3, s * 0.3, z + (Math.random() - 0.5) * 1.3);
    chunk.rotation.set(Math.random(), Math.random(), Math.random());
    group.add(chunk);
  }
}

// Swaps every still-intact destructible cell's plain box (the fallback built
// alongside it in buildDungeonMeshes) for the same modeled "wall" GLB the
// bulk wall batch uses, once it resolves — so a fresh, unhit floor reads
// consistently with its neighbors instead of a handful of plain boxes.
// Skipped for any cell that has already taken damage or broken by the time
// the GLB resolves (setWallCellStage owns those from that point on).
function dressDestructibleWallsIntact(states, group, theme) {
  if (!states.size) return;
  loadDungeonTemplate('wall').then((tpl) => {
    if (!tpl) return;
    const wallColor = new THREE.Color(theme.wall);
    for (const st of states.values()) {
      if (st.gone || st.stage !== 0 || !st.mesh?.parent) continue;
      const placement = [{ x: st.worldX, y: 0, z: st.worldZ, ry: 0, sx: TILE / 4, sy: WALL_HEIGHT / 4, sz: TILE / 1 }];
      const node = buildArchInstances(tintTemplate(tpl, wallColor, 0.3), placement);
      st.mesh.parent.remove(st.mesh);
      st.mesh.geometry?.dispose?.();
      group.add(node);
      st.mesh = node;
    }
  });
}

// Advances one destructible wall cell to `stage` (0 intact, 1 cracked, 2 =
// final hit -> the wall is gone). Called from game.js's wall-impact path
// (wallDebris) once a destructible cell has taken enough hits; game.js owns
// the per-cell hit-count and the session-persistence record, this just drives
// the visual + grid/pathing side of a single cell. Stages 0/1 show an
// immediately-visible tinted box (readable the same frame the hit lands) that
// gets swapped for the modeled wall/wall_cracked GLB the instant it resolves
// (already loading — dressDungeonArchitecture kicks off the same templates
// for the bulk walls). Stage 2 removes the wall mesh outright, patches the
// grid cell to FLOOR (the single isWalkable/PATHING source of truth in
// game.js, so enemies and the minimap see the opening immediately) and drops
// a rubble pile in its place.
// `stage` is the number of hits landed so far: 1 = cracked (wall_cracked),
// 2 = broken (wall_broken), 3 = the final hit — the cell is gone.
const WALL_STAGE_TEMPLATE = { 1: 'wallCracked', 2: 'wallBroken' };
const WALL_STAGE_TINT = { 1: 0x8a7060, 2: 0x5a4c40 };
export function setWallCellStage(dungeonMeshes, dungeon, x, y, stage) {
  const key = `${x},${y}`;
  const states = dungeonMeshes?.destructibleWalls;
  const st = states?.get(key);
  if (!st || st.gone) return;
  const group = dungeonMeshes.group;
  if (st.mesh?.parent) { st.mesh.parent.remove(st.mesh); st.mesh.geometry?.dispose?.(); }
  st.stage = stage;
  if (stage >= 3) {
    st.gone = true;
    st.mesh = null;
    if (dungeon?.grid?.[y]) dungeon.grid[y][x] = FLOOR;
    spawnWallRubblePile(group, dungeonMeshes.wallTex, st.worldX, st.worldZ);
    return;
  }
  const theme = dungeonMeshes.theme;
  const wallColor = new THREE.Color(theme.wall);
  // Immediately-visible tinted-box fallback (readable the instant the hit
  // lands), swapped for the modeled cracked/broken GLB the moment it resolves.
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(TILE, WALL_HEIGHT, TILE),
    new THREE.MeshStandardMaterial({ map: dungeonMeshes.wallTex, roughness: 0.95, flatShading: true, color: WALL_STAGE_TINT[stage] ?? 0xffffff }),
  );
  box.position.set(st.worldX, WALL_HEIGHT / 2, st.worldZ);
  group.add(box);
  st.mesh = box;
  loadDungeonTemplate(WALL_STAGE_TEMPLATE[stage] ?? 'wall').then((tpl) => {
    if (!tpl || st.gone || st.stage !== stage) return;
    const placement = [{ x: st.worldX, y: 0, z: st.worldZ, ry: 0, sx: TILE / 4, sy: WALL_HEIGHT / 4, sz: TILE / 1 }];
    const node = buildArchInstances(tintTemplate(tpl, wallColor, 0.3), placement);
    if (st.mesh?.parent) { st.mesh.parent.remove(st.mesh); st.mesh.geometry?.dispose?.(); }
    group.add(node);
    st.mesh = node;
  });
}

// Built once per theme (cheap; avoids regenerating the canvas per banner prop).
const _bannerTexCache = new Map();
const bannerTexture = (theme) => {
  if (!_bannerTexCache.has(theme.name)) _bannerTexCache.set(theme.name, makeBannerTexture(theme));
  return _bannerTexCache.get(theme.name);
};

// Built once per theme; the occasional glowing floor rune reuses one texture.
const _runeTexCache = new Map();
const runeTexture = (theme) => {
  if (!_runeTexCache.has(theme.name)) _runeTexCache.set(theme.name, makeRuneTexture(theme));
  return _runeTexCache.get(theme.name);
};

// Built once, shared by every cobweb prop (cheap; avoids a canvas per web).
let _cobwebTex = null;
const cobwebTexture = () => (_cobwebTex ||= makeCobwebTexture());

// Built once, shared by every flame (torch/brazier/candelabra) and used by
// the projectile system too, so every "glow" in the game reuses one texture.
let _glowTex = null;
const glowTexture = () => (_glowTex ||= makeGlowTexture());

// Builds the gold light-puddle decal that pools on the floor around a descend
// hatch. It is a flat additive disc whose fragment shader carves an irregular,
// soft-edged blob out of a radial glow, with a slow shimmer. The blob shape,
// size and rotation are all derived from `seed` so each hatch's pool is unique.
// game.js drives uColor + uBright each frame (dim greyish-gold while sealed,
// bright gold once the stairs unlock); userData.hatchPuddleUpdate advances the
// shimmer. Returns a Mesh laid flat on the floor plane.
const HATCH_PUDDLE_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const HATCH_PUDDLE_FRAG = `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uBright;   // 0 sealed-dim .. 1 unlocked-bright
  uniform vec3 uColor;
  uniform float uSeed;
  void main() {
    // radial coords from the disc centre
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    // irregular blob edge: a few sine lobes (seeded phases/freqs) wobble the
    // radius so the pool is a soft splatter, not a clean circle.
    float wob =
      sin(ang * 3.0 + uSeed * 6.28) * 0.14 +
      sin(ang * 5.0 - uSeed * 3.14 + 1.7) * 0.09 +
      sin(ang * 2.0 + uSeed * 12.9 + 0.5) * 0.11;
    float edge = 0.62 + wob;
    // slow shimmer breathing the whole pool
    float shimmer = 0.86 + 0.14 * sin(uTime * 1.3 + uSeed * 20.0);
    // soft radial falloff, feathered right at the wobbly edge
    float glow = smoothstep(edge, edge - 0.55, r);
    glow *= glow;                       // tighten the core, feather the rim
    float a = glow * shimmer * (0.28 + uBright * 0.72);
    gl_FragColor = vec4(uColor * (0.6 + uBright * 0.9), a);
  }
`;
function buildHatchPuddle(seed) {
  const uniforms = {
    uTime: { value: (seed % 100) * 0.1 },
    uBright: { value: 0.25 },
    uColor: { value: new THREE.Color(0xd8a83a) },
    uSeed: { value: (seed % 1000) / 1000 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: HATCH_PUDDLE_VERT,
    fragmentShader: HATCH_PUDDLE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // seeded footprint: a slightly non-square, rotated plane so the blob's own
  // asymmetry reads differently per hatch. Sized to spill a bit past the tile.
  const rr = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const size = 3.2 + rr(1) * 1.4;
  const geo = new THREE.PlaneGeometry(size * (0.9 + rr(2) * 0.25), size * (0.9 + rr(3) * 0.25));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;      // lay flat on the floor
  mesh.rotation.z = rr(4) * Math.PI * 2; // seeded rotation
  mesh.userData.hatchPuddle = true;
  mesh.userData.hatchPuddleUpdate = (dt) => { uniforms.uTime.value += dt; };
  mesh.userData.setHatchBright = (b) => { uniforms.uBright.value = b; };
  mesh.userData.setHatchColor = (hex) => { uniforms.uColor.value.setHex(hex); };
  return mesh;
}

export const TILE = 2;          // world units per grid tile
export const WALL_HEIGHT = 3;

export function tileToWorld(tx, ty) {
  return { x: tx * TILE + TILE / 2, z: ty * TILE + TILE / 2 };
}
export function worldToTile(x, z) {
  return { tx: Math.floor(x / TILE), ty: Math.floor(z / TILE) };
}

let woodTex = null;

export function buildDungeonMeshes(dungeon, theme, floor = 1) {
  const group = new THREE.Group();
  const { grid, size } = dungeon;

  const town = !!dungeon.town;
  // Per-floor seed: nudges texture tint / torch hue / prop mix / particle
  // density so floors within the same act read as distinct places, while the
  // act's palette and identity (from `theme`) stay obvious. Deterministic
  // from the floor number alone, so it needs no network sync in multiplayer.
  const frng = floorRng(floor);
  const floorTex = town ? makeGrassTexture() : makeFloorTexture(theme, frng());
  const wallTex = makeWallTexture(theme, frng());
  const floorAccent = town ? theme.accent : jitterAccentHue(theme.accent, frng);
  if (!woodTex) woodTex = makeWoodTexture();

  // --- Floors (instanced) ---
  const floorTiles = [];
  const wallTiles = [];
  const chasmT = [], bridgeT = [], rubbleT = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = grid[y][x];
      if (t === FLOOR || t === DOOR) floorTiles.push({ x, y });
      else if (t === BRIDGE) bridgeT.push({ x, y });
      else if (t === RUBBLE) { rubbleT.push({ x, y }); floorTiles.push({ x, y }); } // floor under rubble
      else if (t === CHASM) chasmT.push({ x, y });
      else if (t === WALL) {
        wallTiles.push({ x, y });
        if (town) floorTiles.push({ x, y }); // grass under trees/tavern/walls
      }
    }
  }

  // --- Destructible interior walls: pulled OUT of the bulk instanced wall
  // batch below so a single cell's stage (intact/cracked/gone) can be swapped
  // independently at hit-time, without rebuilding the shared draw call every
  // other wall tile rides on. Town/boss floors never populate
  // dungeon.destructibleWalls (generateDungeon-only), so this is a no-op there.
  const destructibleTiles = [];
  if (!town && dungeon.destructibleWalls?.size) {
    for (let i = wallTiles.length - 1; i >= 0; i--) {
      const tp = wallTiles[i];
      if (dungeon.destructibleWalls.has(`${tp.x},${tp.y}`)) {
        destructibleTiles.push(tp);
        wallTiles.splice(i, 1);
      }
    }
  }

  const floorGeo = new THREE.BoxGeometry(TILE, 0.2, TILE);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 });
  // The descend-stairs tile has its own recessed stairwell built below, so the
  // solid floor tile there is omitted -> the hatch actually opens into the well
  // instead of a floor plane sitting over it. Dais/sunken tiles get their own
  // offset-Y floor box below (buildDungeonMeshes's height-field pass), so the
  // flat 0-height tile here is skipped for them too, or the two boxes would
  // z-fight (raised) or the flat tile would paper over the sunken one.
  // (floorTiles itself is left intact; motes/runes may still pepper the
  // surrounding tiles.)
  const patchKeys = new Set([...(dungeon.daisTiles || []), ...(dungeon.sunkTiles || [])].map((p) => `${p.x},${p.y}`));
  const floorRenderTiles = (!town && (dungeon.stairs || patchKeys.size))
    ? floorTiles.filter((tp) => !(dungeon.stairs && tp.x === dungeon.stairs.x && tp.y === dungeon.stairs.y) && !patchKeys.has(`${tp.x},${tp.y}`))
    : floorTiles;
  const floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, floorRenderTiles.length);
  const m = new THREE.Matrix4();
  floorRenderTiles.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, -0.1, w.z);
    floorMesh.setMatrixAt(i, m);
  });
  floorMesh.instanceMatrix.needsUpdate = true;
  floorMesh.receiveShadow = false;
  group.add(floorMesh);

  // --- Chasms: a recessed dark abyss below the floor plane ---
  if (chasmT.length) {
    const abyss = new THREE.MeshStandardMaterial({ color: 0x05040a, roughness: 1, metalness: 0 });
    const abyssGeo = new THREE.BoxGeometry(TILE, 0.2, TILE);
    const abyssMesh = new THREE.InstancedMesh(abyssGeo, abyss, chasmT.length);
    chasmT.forEach((tp, i) => {
      const w = tileToWorld(tp.x, tp.y);
      m.setPosition(w.x, -2.4, w.z); // sunken far below
      abyssMesh.setMatrixAt(i, m);
    });
    abyssMesh.instanceMatrix.needsUpdate = true;
    group.add(abyssMesh);
    // dark side walls around the pit rim for depth
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x120e18, roughness: 1 });
    const rimGeo = new THREE.BoxGeometry(TILE, 2.6, 0.12);
    for (const tp of chasmT) {
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        const nt = grid[tp.y + dy]?.[tp.x + dx];
        if (nt === FLOOR || nt === BRIDGE || nt === DOOR) {
          const w = tileToWorld(tp.x, tp.y);
          const wall = new THREE.Mesh(rimGeo, rimMat);
          wall.position.set(w.x + dx * TILE / 2, -1.2, w.z + dy * TILE / 2);
          wall.rotation.y = rot;
          group.add(wall);
        }
      }
    }
  }

  // --- Bridges: raised stone slabs with side rails, over the chasm ---
  // (Used to be a wood-plank texture; that read as a rainbow-striped wood
  // floor dropped into a stone dungeon. Reusing the dungeon's own floor
  // texture keeps the crossing gothic and consistent with the room floor.)
  if (bridgeT.length) {
    const plankMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 });
    const plankGeo = new THREE.BoxGeometry(TILE, 0.16, TILE);
    const plankMesh = new THREE.InstancedMesh(plankGeo, plankMat, bridgeT.length);
    bridgeT.forEach((tp, i) => {
      const w = tileToWorld(tp.x, tp.y);
      m.setPosition(w.x, 0.02, w.z);
      plankMesh.setMatrixAt(i, m);
    });
    plankMesh.instanceMatrix.needsUpdate = true;
    group.add(plankMesh);
    // low rope rails along bridge edges that border a chasm
    const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
    const railGeo = new THREE.BoxGeometry(TILE, 0.4, 0.08);
    for (const tp of bridgeT) {
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        if (grid[tp.y + dy]?.[tp.x + dx] === CHASM) {
          const w = tileToWorld(tp.x, tp.y);
          const rail = new THREE.Mesh(railGeo, railMat);
          rail.position.set(w.x + dx * TILE / 2, 0.3, w.z + dy * TILE / 2);
          rail.rotation.y = rot;
          group.add(rail);
        }
      }
    }
  }

  // --- Broken walls: crumbled rubble piles instead of full masonry ---
  if (rubbleT.length) {
    const rubbleMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 });
    for (const tp of rubbleT) {
      const w = tileToWorld(tp.x, tp.y);
      // a low broken stub + scattered chunks
      const stub = new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.6 + Math.random() * 0.6, TILE), rubbleMat);
      stub.position.set(w.x, stub.geometry.parameters.height / 2, w.z);
      stub.rotation.y = (Math.random() - 0.5) * 0.3;
      group.add(stub);
      for (let c = 0; c < 4; c++) {
        const s = 0.18 + Math.random() * 0.24;
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rubbleMat);
        chunk.position.set(w.x + (Math.random() - 0.5) * 1.4, s * 0.3, w.z + (Math.random() - 0.5) * 1.4);
        chunk.rotation.set(Math.random(), Math.random(), Math.random());
        group.add(chunk);
      }
    }
  }

  // --- Walls (instanced) ---
  // In town: only the perimeter gets a low garden wall; interior solid tiles
  // are covered by trees/the tavern instead of dungeon masonry.
  let renderWalls = wallTiles;
  let wallH = WALL_HEIGHT;
  if (town) {
    wallH = 1.0;
    renderWalls = wallTiles.filter((tp) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = grid[tp.y + dy]?.[tp.x + dx];
        if (t === undefined || t === 0) return true; // touches the void edge
      }
      return false;
    });
  }
  const wallGeo = new THREE.BoxGeometry(TILE, wallH, TILE);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, flatShading: true });
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, renderWalls.length);
  renderWalls.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, wallH / 2, w.z);
    wallMesh.setMatrixAt(i, m);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  group.add(wallMesh);

  // Dungeon walls get a weathered stone coping course on top so the
  // silhouette steps instead of reading as one plain extruded cube. A plain
  // solid-colour slab (not the wall's own brick texture, which stretched
  // into a "framed tile roof" look at this smaller scale) with a slim
  // overhang. Varied per floor via the shared seed: most segments intact,
  // some missing outright, some broken with a U-shaped notch and a bit of
  // rubble, so a wall run reads as crumbling battlements rather than a
  // uniform row of caps.
  const wallDecorMeshes = [];
  if (!town && renderWalls.length) {
    const copingMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.wall).multiplyScalar(0.72), roughness: 1, flatShading: true });
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x3a3730, roughness: 1, flatShading: true });
    const intactGeo = new THREE.BoxGeometry(TILE * 0.96, 0.16, TILE * 0.96);
    const halfW = TILE * 0.34, gap = TILE * 0.28, halfOffset = halfW / 2 + gap / 2;
    const halfGeo = new THREE.BoxGeometry(halfW, 0.16, TILE * 0.96);
    const rubbleGeo = new THREE.BoxGeometry(0.14, 0.12, 0.14);

    const intact = [], broken = [], rubblePos = [];
    for (const tp of renderWalls) {
      const roll = frng();
      if (roll < 0.14) continue; // coping missing entirely
      if (roll < 0.32) {
        broken.push(tp);
        rubblePos.push({ tp, dx: -0.1, dz: 0.05 }, { tp, dx: 0.12, dz: -0.08 });
      } else {
        intact.push(tp);
      }
    }
    if (intact.length) {
      const capMesh = new THREE.InstancedMesh(intactGeo, copingMat, intact.length);
      intact.forEach((tp, i) => {
        const w = tileToWorld(tp.x, tp.y);
        m.setPosition(w.x, wallH - 0.03, w.z);
        capMesh.setMatrixAt(i, m);
      });
      capMesh.instanceMatrix.needsUpdate = true;
      group.add(capMesh);
      wallDecorMeshes.push(capMesh);
    }
    if (broken.length) {
      // two shorter caps with a gap between them: a broken/crumbled section
      const leftMesh = new THREE.InstancedMesh(halfGeo, copingMat, broken.length);
      const rightMesh = new THREE.InstancedMesh(halfGeo, copingMat, broken.length);
      broken.forEach((tp, i) => {
        const w = tileToWorld(tp.x, tp.y);
        m.setPosition(w.x - halfOffset, wallH - 0.03, w.z);
        leftMesh.setMatrixAt(i, m);
        m.setPosition(w.x + halfOffset, wallH - 0.03, w.z);
        rightMesh.setMatrixAt(i, m);
      });
      leftMesh.instanceMatrix.needsUpdate = true;
      rightMesh.instanceMatrix.needsUpdate = true;
      group.add(leftMesh, rightMesh);
      wallDecorMeshes.push(leftMesh, rightMesh);
    }
    if (rubblePos.length) {
      // a couple of small fallen chunks sitting in/near each notch
      const rubbleMesh = new THREE.InstancedMesh(rubbleGeo, rubbleMat, rubblePos.length);
      const rm = new THREE.Matrix4(), rq = new THREE.Quaternion(), rv = new THREE.Vector3(), rs = new THREE.Vector3(1, 1, 1);
      rubblePos.forEach((r, i) => {
        const w = tileToWorld(r.tp.x, r.tp.y);
        rq.setFromEuler(new THREE.Euler(Math.random() * 0.6, Math.random() * Math.PI, Math.random() * 0.6));
        rv.set(w.x + r.dx, wallH - 0.1, w.z + r.dz);
        rm.compose(rv, rq, rs);
        rubbleMesh.setMatrixAt(i, rm);
      });
      rubbleMesh.instanceMatrix.needsUpdate = true;
      group.add(rubbleMesh);
      wallDecorMeshes.push(rubbleMesh);
    }
  }

  // --- Destructible interior walls: individually-swappable cell meshes ---
  // Each starts as a plain box sharing the bulk wall's own texture/material
  // (so it's visually identical to its neighbors this frame); once the
  // modeled GLB variants resolve, dressDestructibleWallsIntact swaps still-
  // untouched cells for the same "wall" model the bulk batch uses.
  // setWallCellStage (game.js's wall-impact path) later swaps/removes exactly
  // one cell here per hit without touching the shared InstancedMesh batch.
  const destructibleWallStates = new Map();
  for (const tp of destructibleTiles) {
    const w = tileToWorld(tp.x, tp.y);
    const mesh = new THREE.Mesh(wallGeo, wallMat);
    mesh.position.set(w.x, wallH / 2, w.z);
    group.add(mesh);
    destructibleWallStates.set(`${tp.x},${tp.y}`, { x: tp.x, y: tp.y, mesh, stage: 0, gone: false, worldX: w.x, worldZ: w.z });
  }
  if (!town) dressDestructibleWallsIntact(destructibleWallStates, group, theme);

  // Session revisit: cells this character already broke down earlier in the
  // same session arrive with dungeon.grid already patched back to FLOOR by
  // game.js's loadFloor (applied AFTER the seeded generation above, so the
  // seeded room layout itself never changes) — they never entered wallTiles/
  // destructibleTiles, so they already render as ordinary floor. All that's
  // missing is the rubble the earlier break left behind.
  if (dungeon.preOpenedWalls?.size) {
    for (const key of dungeon.preOpenedWalls) {
      const [hx, hy] = key.split(',').map(Number);
      const w = tileToWorld(hx, hy);
      spawnWallRubblePile(group, wallTex, w.x, w.z);
    }
  }

  // --- Town: cobbled square + lane ---
  if (town && dungeon.cobbles?.length) {
    const cobbleGeo = new THREE.BoxGeometry(TILE, 0.06, TILE);
    const cobbleMat = new THREE.MeshStandardMaterial({ map: makeCobbleTexture(), roughness: 0.95 });
    const cobbleMesh = new THREE.InstancedMesh(cobbleGeo, cobbleMat, dungeon.cobbles.length);
    const cobbleY = TOWN_PLAZA_HEIGHT - 0.03; // box centre so its top = TOWN_PLAZA_HEIGHT
    dungeon.cobbles.forEach((c, i) => {
      const w = tileToWorld(c.x, c.y);
      m.setPosition(w.x, cobbleY, w.z);
      cobbleMesh.setMatrixAt(i, m);
    });
    cobbleMesh.instanceMatrix.needsUpdate = true;
    group.add(cobbleMesh);

    // Step-up skirt: a thin stone lip around the plaza's edge so the raised
    // flagstone doesn't read as a floating slab where it meets the grass.
    const cobbleSet = new Set(dungeon.cobbles.map((c) => `${c.x},${c.y}`));
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9 });
    const skirtGeo = new THREE.BoxGeometry(TILE, TOWN_PLAZA_HEIGHT, 0.1);
    for (const c of dungeon.cobbles) {
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        if (cobbleSet.has(`${c.x + dx},${c.y + dy}`)) continue;
        const w = tileToWorld(c.x, c.y);
        const skirt = new THREE.Mesh(skirtGeo, skirtMat);
        skirt.position.set(w.x + dx * TILE / 2, TOWN_PLAZA_HEIGHT / 2, w.z + dy * TILE / 2);
        skirt.rotation.y = rot;
        group.add(skirt);
      }
    }
  }

  // --- Dungeon: seeded raised daises / sunken patches (dungeon.heights) ---
  // Renders the same modeled floor tile at an offset Y for each stamped tile,
  // plus a simple stone side skirt on any edge bordering a tile that is NOT
  // part of the same patch, so a dais/sunken tile never reads as a floating
  // or gapped floor plane. Purely cosmetic: XZ collision is untouched.
  if (!town && (dungeon.daisTiles?.length || dungeon.sunkTiles?.length)) {
    const bumpMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 });
    const skirtMat2 = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.wall).multiplyScalar(0.7), roughness: 0.9 });
    const patches = [...(dungeon.daisTiles || []), ...(dungeon.sunkTiles || [])];
    const patchByKey = new Map(patches.map((p) => [`${p.x},${p.y}`, p]));
    for (const p of patches) {
      const w = tileToWorld(p.x, p.y);
      const bump = new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.2, TILE), bumpMat);
      bump.position.set(w.x, p.h - 0.1, w.z);
      group.add(bump);
      const skirtH = Math.abs(p.h);
      const skirtGeo2 = new THREE.BoxGeometry(TILE, skirtH, 0.1);
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        if (patchByKey.has(`${p.x + dx},${p.y + dy}`)) continue;
        const skirt = new THREE.Mesh(skirtGeo2, skirtMat2);
        const skirtY = p.h > 0 ? p.h - skirtH / 2 : p.h + skirtH / 2;
        skirt.position.set(w.x + dx * TILE / 2, skirtY, w.z + dy * TILE / 2);
        skirt.rotation.y = rot;
        group.add(skirt);
      }
    }
  }

  // --- Town: trees, plants, well, tavern ---
  const smokePuffs = [];
  // Emissive/glow meshes that the town day/night cycle drives (lamp glass,
  // tavern windows, vendor lanterns): each entry records its base colour +
  // night emissive strength so game.js can fade it on at night, off by day.
  const townGlows = [];
  // Shared breakables list: town market crates/tavern barrel (pushed inside
  // buildTownDecor) and dungeon barrels/crates/pots/pews (pushed below) both
  // land here, so game.js's single breakNear() sweep covers either context.
  const breakables = [];
  if (town) buildTownDecor(group, dungeon, smokePuffs, townGlows, breakables);

  // --- Doors ---
  const doorMeshes = new Map();
  const doorMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 });
  for (const d of dungeon.doors) {
    const w = tileToWorld(d.x, d.y);
    const geo = d.vertical
      ? new THREE.BoxGeometry(TILE * 0.9, 2.4, 0.3)
      : new THREE.BoxGeometry(0.3, 2.4, TILE * 0.9);
    const mesh = new THREE.Mesh(geo, doorMat);
    mesh.position.set(w.x, 1.2, w.z);
    group.add(mesh);
    doorMeshes.set(`${d.x},${d.y}`, mesh);
  }

  // --- Torches (dungeon) / lamp posts (town); lights are pooled by the game ---
  const torchPositions = [];
  const sconceMeshes = []; // dungeon-only: the static box sconce Meshes, kept so
  // dressDungeonArchitecture can swap them for a modeled torch body once its GLB
  // resolves. flame/glowSprite/the pooled light are never touched by that swap.
  if (town) {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.8 });
    for (const t of dungeon.torches) {
      const w = tileToWorld(t.fx, t.fy);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.2, 6), postMat);
      post.position.set(w.x, 1.1, w.z);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 6), postMat);
      cap.position.set(w.x, 2.36, w.z);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.26, 0.2),
        new THREE.MeshBasicMaterial({ color: 0xffc978 })
      );
      glass.position.set(w.x, 2.16, w.z);
      group.add(post, cap, glass);
      torchPositions.push({ x: w.x, y: 2.2, z: w.z, flame: glass });
      // lamp glass glows at night, near-dark by day (basic material, so tint it)
      townGlows.push({ mesh: glass, base: new THREE.Color(0xffc978), kind: 'basic' });
    }
  } else {
    const sconceGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 6);
    const sconceMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1 });
    const flameGeo = new THREE.SphereGeometry(0.13, 8, 6);
    const flameMat = new THREE.MeshBasicMaterial({ color: floorAccent });
    for (const t of dungeon.torches) {
      // Clamp the sconce to the ROOM side of the wall face: the generator's
      // 0.6-tile offset from the floor tile put the flame center about 0.2
      // world units inside the masonry, burying sconce and flame (only the
      // pooled point light survived). 0.42 tiles keeps it wall-hugging but
      // clear of the face, flame fully visible.
      const ox = t.fx - t.x, oy = t.fy - t.y;
      const olen = Math.hypot(ox, oy);
      const k = olen > 1e-6 ? Math.min(1, 0.42 / olen) : 1;
      const w = tileToWorld(t.x + ox * k, t.y + oy * k);
      const sconce = new THREE.Mesh(sconceGeo, sconceMat);
      sconce.position.set(w.x, 1.6, w.z);
      group.add(sconce);
      sconceMeshes.push(sconce);
      const flame = new THREE.Mesh(flameGeo, flameMat);
      flame.position.set(w.x, 1.95, w.z);
      group.add(flame);
      // additive glow sprite behind the flame core so it blooms like a real
      // ember instead of reading as a flat lit sphere
      const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: floorAccent, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity: 0.6,
      }));
      glowSprite.scale.setScalar(0.55);
      glowSprite.position.copy(flame.position);
      group.add(glowSprite);
      torchPositions.push({ x: w.x, y: 2.0, z: w.z, flame, glow: glowSprite });
    }
  }

  // --- Chests ---
  const chestMeshes = [];
  const chestBodyGeo = new THREE.BoxGeometry(0.9, 0.55, 0.6);
  const chestLidGeo = new THREE.BoxGeometry(0.9, 0.25, 0.6);
  const chestMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.7 });
  const chestTrimMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.4 });
  for (const c of dungeon.chests) {
    const w = tileToWorld(c.x, c.y);
    const chest = new THREE.Group();
    const body = new THREE.Mesh(chestBodyGeo, chestMat);
    body.position.y = 0.28;
    const lid = new THREE.Mesh(chestLidGeo, chestMat);
    lid.position.set(0, 0.62, 0);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.1, 0.64), chestTrimMat);
    trim.position.y = 0.5;
    chest.add(body, lid, trim);
    // Sit the chest on whatever height the floor under it sampled to (a dais
    // is deliberately stamped under dungeon.chests[0] in dungeon.js).
    const chestH = dungeon.heights?.[c.y]?.[c.x] || 0;
    chest.position.set(w.x, chestH, w.z);
    chest.rotation.y = Math.random() * Math.PI * 2;
    group.add(chest);
    chestMeshes.push({ mesh: chest, lid, tile: c, opened: false, x: w.x, z: w.z });
  }

  // --- Environmental variety: scuff decals, rubble piles, pit holes ---
  if (dungeon.scuffs?.length) {
    const scuffMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    for (const s of dungeon.scuffs) {
      const w = tileToWorld(s.x, s.y);
      const decal = new THREE.Mesh(new THREE.CircleGeometry(s.s, 10), scuffMat);
      decal.rotation.x = -Math.PI / 2;
      decal.rotation.z = s.r;
      decal.scale.x = 1.6; // elongated drag/scorch mark
      decal.position.set(w.x, 0.015, w.z);
      group.add(decal);
    }
  }
  if (dungeon.rubble?.length) {
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x55525c, roughness: 1 });
    for (const r of dungeon.rubble) {
      const w = tileToWorld(r.x, r.y);
      for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
        const s = 0.1 + Math.random() * 0.2;
        const rock = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rubbleMat);
        rock.position.set(w.x + (Math.random() - 0.5) * 1.2, s * 0.3, w.z + (Math.random() - 0.5) * 1.2);
        rock.rotation.y = Math.random() * Math.PI;
        group.add(rock);
      }
    }
  }
  if (dungeon.pits?.length) {
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a262f, roughness: 1 });
    for (const p of dungeon.pits) {
      const w = tileToWorld(p.x, p.y);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.85, 12), holeMat);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(w.x, 0.02, w.z);
      group.add(hole);
      // jagged rim stones
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const stone = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.3), rimMat);
        stone.position.set(w.x + Math.cos(a) * 0.9, 0.05, w.z + Math.sin(a) * 0.9);
        stone.rotation.y = a + Math.random() * 0.5;
        group.add(stone);
      }
    }
  }

  // --- Town features: vendor stalls + dungeon portal ---
  const vendorMeshes = [];
  if (dungeon.town) {
    // shared skin tone material reused across all three keepers
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.8 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1410 });
    for (const v of dungeon.vendors) {
      const w = tileToWorld(v.x, v.y);
      const stall = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.6), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 }));
      counter.position.y = 0.4;
      const poleL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0x5a4028 }));
      poleL.position.set(-0.75, 1.1, -0.25);
      const poleR = poleL.clone(); poleR.position.x = 0.75;
      const canopyColor = v.type === 'potions' ? 0xb03a4a : v.type === 'mystery' ? 0x6a2a9a : 0x3a5ab0;
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 1.0), new THREE.MeshStandardMaterial({ color: canopyColor, roughness: 0.7 }));
      canopy.position.set(0, 2.2, -0.1);
      // stall structure lives in its own subgroup so the modeled CC0 market
      // stand can swap in for JUST the architecture (counter/poles/canopy),
      // leaving keeper, lantern, wares and side props exactly where they are.
      // The stand's roof-tile canopy is tinted to the vendor's color so the
      // three shops stay tellable apart at a glance.
      const structure = new THREE.Group();
      structure.add(counter, poleL, poleR, canopy);
      stall.add(structure);
      swapInModel(stall, structure, ['stall'], ([tpl]) => {
        if (!tpl) return null;
        // 2.25 left only ~1.6 units of headroom under the canopy: exactly the
        // hero's own height with no clearance, so a player walking up to the
        // counter could clip the underside of the roof. 2.6 keeps the canopy
        // clearly overhead.
        const node = buildModelMesh(tpl, 2.6, { RoofTiles_Red: canopyColor });
        node.position.set(0, 0, -0.15);
        return node;
      });

      // --- shopkeeper: readable face + real character per vendor, built to
      // read from the overhead camera (big eyes, head tipped up, hands on the
      // counter instead of arms splayed out like poles) ---
      const keeper = new THREE.Group();
      const bodyColor = v.type === 'potions' ? 0x8a5566 : v.type === 'gear' ? 0x5a4436 : 0x2a2038;
      const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.95 });
      const browMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1 });
      const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 5, 10), new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 }));
      kBody.position.y = 0.78;
      // head on a pivot tipped up so the face catches the top-down view
      const kHeadGrp = new THREE.Group();
      kHeadGrp.position.y = 1.42; kHeadGrp.rotation.x = -0.2;
      const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 14), skinMat);
      const eyeWL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), whiteMat); eyeWL.position.set(-0.1, 0.0, 0.2);
      const eyeWR = eyeWL.clone(); eyeWR.position.x = 0.1;
      const pupL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), eyeMat); pupL.position.set(-0.1, 0.0, 0.24);
      const pupR = pupL.clone(); pupR.position.x = 0.1;
      const browL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.06), browMat); browL.position.set(-0.1, 0.08, 0.21); browL.rotation.z = 0.12;
      const browR = browL.clone(); browR.position.x = 0.1; browR.rotation.z = -0.12;
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), skinMat); nose.position.set(0, -0.04, 0.24);
      kHeadGrp.add(kHead, eyeWL, eyeWR, pupL, pupR, browL, browR, nose);
      // arms resting forward with hands on the counter (not splayed outward)
      const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
      const armGeo = new THREE.CapsuleGeometry(0.085, 0.34, 4, 8);
      const armL = new THREE.Mesh(armGeo, armMat); armL.position.set(-0.24, 0.9, 0.26); armL.rotation.set(1.2, 0, 0.22);
      const armR = new THREE.Mesh(armGeo, armMat); armR.position.set(0.24, 0.9, 0.26); armR.rotation.set(1.2, 0, -0.22);
      const handMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.85 });
      const handGeo = new THREE.SphereGeometry(0.07, 8, 8);
      const handL = new THREE.Mesh(handGeo, handMat); handL.position.set(-0.18, 0.94, 0.5);
      const handR = new THREE.Mesh(handGeo, handMat); handR.position.set(0.18, 0.94, 0.5);
      keeper.add(kBody, kHeadGrp, armL, armR, handL, handR);

      if (v.type === 'potions') {
        // Maribel: kindly herbalist — wide-brim hat, auburn hair, warm apron
        const hair = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 1 }));
        hair.position.set(0, 0.02, -0.02); kHeadGrp.add(hair);
        const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.05, 14), new THREE.MeshStandardMaterial({ color: 0x556038, roughness: 0.9 }));
        brim.position.y = 0.16; kHeadGrp.add(brim);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.34, 12), new THREE.MeshStandardMaterial({ color: 0x64703f, roughness: 0.9 }));
        cone.position.y = 0.34; kHeadGrp.add(cone);
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.08), new THREE.MeshStandardMaterial({ color: 0xd4a85a, roughness: 0.9 }));
        apron.position.set(0, 0.66, 0.24); keeper.add(apron);
        // braid hanging out from under the hat
        const braid = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 6), new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 1 }));
        braid.position.set(0, -0.13, -0.24); braid.rotation.x = 0.35; kHeadGrp.add(braid);
      } else if (v.type === 'gear') {
        // Torvald: burly bald smith — big black beard, red bandana, sooty apron
        kBody.scale.set(1.25, 1, 1.1); kBody.position.y = 0.74;
        armL.scale.setScalar(1.35); armR.scale.setScalar(1.35);
        const bald = new THREE.Mesh(new THREE.SphereGeometry(0.245, 14, 10), skinMat); bald.position.y = 0.01; kHeadGrp.add(bald);
        const bandana = new THREE.Mesh(new THREE.SphereGeometry(0.255, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), new THREE.MeshStandardMaterial({ color: 0x9a3a2a, roughness: 0.9 }));
        bandana.position.y = 0.05; kHeadGrp.add(bandana);
        const beard = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12, 0, Math.PI * 2, Math.PI * 0.44, Math.PI * 0.56), new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 }));
        beard.position.set(0, -0.13, 0.08); beard.scale.set(1, 1.3, 0.95); kHeadGrp.add(beard);
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.56, 0.09), new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.95 }));
        apron.position.set(0, 0.62, 0.24); keeper.add(apron);
        // soot-dark forearms — a life spent at the forge
        const sootMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.95 });
        const sootGeo = new THREE.CapsuleGeometry(0.075, 0.15, 3, 6);
        const sootL = new THREE.Mesh(sootGeo, sootMat); sootL.position.set(-0.2, 0.92, 0.4); sootL.rotation.set(1.2, 0, 0.22);
        const sootR = new THREE.Mesh(sootGeo, sootMat); sootR.position.set(0.2, 0.92, 0.4); sootR.rotation.set(1.2, 0, -0.22);
        keeper.add(sootL, sootR);
      } else {
        // Zoltan: hooded seer — face lost in shadow, glowing eyes, floating orb
        kHead.material = new THREE.MeshStandardMaterial({ color: 0x171320, roughness: 0.9 });
        const glowEye = new THREE.MeshBasicMaterial({ color: 0xb884ff });
        eyeWL.material = glowEye; eyeWR.material = glowEye; eyeWL.scale.setScalar(0.85); eyeWR.scale.setScalar(0.85);
        pupL.visible = pupR.visible = browL.visible = browR.visible = nose.visible = false;
        const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0x2a2038, roughness: 0.85 }));
        hood.position.y = 0.12; kHeadGrp.add(hood);
        const cowl = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.07, 8, 16), new THREE.MeshStandardMaterial({ color: 0x241c34, roughness: 0.85 }));
        cowl.rotation.x = Math.PI / 2 - 0.3; cowl.position.set(0, -0.02, 0.12); kHeadGrp.add(cowl);
        const robe = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.95, 10), new THREE.MeshStandardMaterial({ color: 0x241c34, roughness: 0.85, emissive: 0x3a1a55, emissiveIntensity: 0.18 }));
        robe.position.y = 0.5; keeper.add(robe);
        // star-speckled robe: small glowing flecks scattered over the cone,
        // riding along with it (children of the robe, so no extra transforms)
        const starMat = new THREE.MeshBasicMaterial({ color: 0xe8d8ff });
        const starGeo = new THREE.SphereGeometry(0.013, 4, 4);
        for (let i = 0; i < 9; i++) {
          const sy = -0.35 + Math.random() * 0.75;
          const rad = 0.34 * (0.475 - sy) / 0.95 * 0.9;
          const a = Math.random() * Math.PI * 2;
          const star = new THREE.Mesh(starGeo, starMat);
          star.position.set(Math.cos(a) * rad, sy, Math.sin(a) * rad);
          robe.add(star);
        }
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), new THREE.MeshBasicMaterial({ color: 0xc07eff, transparent: true, opacity: 0.85 }));
        orb.position.set(0.5, 1.2, 0.35); keeper.add(orb);
        const orbLight = new THREE.PointLight(0xb884ff, 6, 3, 2); orbLight.position.copy(orb.position); keeper.add(orbLight);
        smokePuffs.push({ mesh: orb, baseY: orb.position.y, phase: Math.random() * Math.PI * 2, speed: 0.8 + Math.random() * 0.3, kind: 'firefly' });
      }
      // --- Modeled human shopkeeper (preferred) ---
      // Swap the procedural box keeper's VISUALS for a KayKit adventurer model
      // matched to the vendor's voice/character: Maribel a robed mage-body
      // (female), Torvald a burly knight-body smith (male), Zoltan a
      // hooded rogue-body seer (male). The `keeper` Group stays the transform
      // anchor updateVendors drives (position/rotation), so the swap changes
      // only the look. If the GLB isn't loaded, buildNpcModel returns null and
      // the box keeper built above stays visible as the fallback.
      const VENDOR_NPC = {
        potions: { cls: 'mage', gender: 'female', skin: 'fair', name: v.name || 'Maribel' },
        gear: { cls: 'knight', gender: 'male', skin: 'tan', name: v.name || 'Torvald' },
        mystery: { cls: 'ranger', gender: 'male', skin: 'deep', name: v.name || 'Zoltan' },
      };
      const vcfg = VENDOR_NPC[v.type] || VENDOR_NPC.gear;
      const npc = buildNpcModel(vcfg.cls, vcfg.name, { gender: vcfg.gender, skinTone: vcfg.skin });
      if (npc) {
        // clear the box shopkeeper's own body meshes, but KEEP the atmospheric
        // extras (Zoltan's floating orb + its point light) on the keeper at
        // their original transform so the seer still has his glowing orb.
        for (let i = keeper.children.length - 1; i >= 0; i--) {
          const c = keeper.children[i];
          if (c.isPointLight || c.material?.transparent) continue; // orb + orb light
          keeper.remove(c); c.geometry?.dispose?.();
        }
        // model feet sit at the keeper's local origin (ground), same as the
        // box keeper stood; the counter (0.8 tall) is in front of it.
        keeper.add(npc.mesh);
        // Drive the model's idle mixer every frame through the smokePuffs tick
        // (no game.js changes). With no explicit target the driver defaults to
        // the nearest-hero glance (nearestHeroTarget), so the keeper's head
        // tracks a close-by player on top of the body yaw updateVendors does.
        pushNpcAnimDriver(smokePuffs, npc, null);
      }

      // Pushed back from -0.62: the modeled CC0 stall's frame runs much
      // deeper (front-to-back) than the old procedural counter did, and at
      // -0.62 the keeper stood mid-frame with the stall's own corner/roof
      // struts passing straight through their body. -1.25 clears the whole
      // strut band and plants the keeper at the back of the stand, still
      // under the canopy, with the counter and wares between them and the
      // player.
      keeper.position.z = -1.25;
      stall.add(keeper);

      // hanging lantern on the stall front — lights the keeper's face at night
      const lantern = new THREE.Group();
      const lanternBody = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x2a2018, emissive: 0xffb44a, emissiveIntensity: 0.7 }));
      const lanternLight = new THREE.PointLight(0xffbf7a, 11, 5, 2);
      lantern.add(lanternBody, lanternLight);
      lantern.position.set(0.72, 1.85, 0.4);
      stall.add(lantern);
      // vendor lantern glows at night: fade its emissive + its little light
      townGlows.push({ mesh: lanternBody, kind: 'emissive', nightEmissive: 0.9 });
      townGlows.push({ light: lanternLight, kind: 'light', nightIntensity: 11 });

      // wares on the counter
      let ware;
      if (v.type === 'potions') {
        // row of potion bottles
        ware = new THREE.Group();
        const bottleColors = [0xd93a3a, 0x3a8ad9, 0x5ad93a];
        for (let i = 0; i < 3; i++) {
          const bottle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), new THREE.MeshStandardMaterial({ color: bottleColors[i], roughness: 0.3, transparent: true, opacity: 0.85 }));
          bottle.position.set(-0.3 + i * 0.3, 0.95, 0);
          bottle.scale.y = 1.3;
          const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
          cork.position.set(-0.3 + i * 0.3, 1.08, 0);
          ware.add(bottle, cork);
        }
      } else if (v.type === 'gear') {
        // sword rack
        ware = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.05), new THREE.MeshStandardMaterial({ color: 0xc8ccd8, metalness: 0.7, roughness: 0.3 }));
          blade.position.set(-0.4 + i * 0.35, 1.05, 0);
          blade.rotation.z = -0.15 + i * 0.15;
          ware.add(blade);
        }
        // a hammer resting on the counter beside the blades
        const hHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 6), new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 }));
        hHandle.position.set(0.5, 1.06, 0.1); hHandle.rotation.z = Math.PI / 2 - 0.2;
        const hHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.09), new THREE.MeshStandardMaterial({ color: 0x3a3a40, metalness: 0.6, roughness: 0.4 }));
        hHead.position.set(0.66, 1.09, 0.1);
        ware.add(hHandle, hHead);
      } else {
        // rune cards fanned on the counter
        ware = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const card = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.24), new THREE.MeshStandardMaterial({ color: 0x2a2038, emissive: 0xb35eff, emissiveIntensity: 0.4, side: THREE.DoubleSide }));
          card.position.set(-0.3 + i * 0.2, 0.86, 0.05);
          card.rotation.x = -Math.PI / 2 + 0.3;
          card.rotation.z = (i - 1.5) * 0.15;
          ware.add(card);
        }
      }
      stall.add(ware);

      // crates/barrels beside the stall for extra detail; each swaps to its
      // modeled CC0 version once the GLB loads (same spot, visual only)
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
      crate.position.set(-1.05, 0.2, 0.35);
      crate.rotation.y = 0.3;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
      barrel.position.set(1.05, 0.25, 0.35);
      stall.add(crate, barrel);
      swapInModel(stall, crate, ['crate'], ([tpl]) => {
        if (!tpl) return null;
        const node = buildModelMesh(tpl, 0.44);
        node.position.set(-1.05, 0, 0.35);
        node.rotation.y = 0.3;
        return node;
      });
      swapInModel(stall, barrel, ['barrel'], ([tpl]) => {
        if (!tpl) return null;
        const node = buildModelMesh(tpl, 0.56);
        node.position.set(1.05, 0, 0.35);
        return node;
      });

      // Torvald's small anvil beside the stall
      if (v.type === 'gear') {
        const anvil = new THREE.Group();
        const anvilBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.18), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.6, roughness: 0.4 }));
        anvilBody.position.y = 0.34;
        const anvilBase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.28, 8), new THREE.MeshStandardMaterial({ color: 0x1e1e22, metalness: 0.5, roughness: 0.5 }));
        anvilBase.position.y = 0.14;
        const anvilHorn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.6, roughness: 0.4 }));
        anvilHorn.position.set(-0.26, 0.34, 0);
        anvilHorn.rotation.z = Math.PI / 2;
        anvil.add(anvilBody, anvilBase, anvilHorn);
        anvil.position.set(-1.05, 0, -0.4);
        stall.add(anvil);
      }

      stall.position.set(w.x, 0, w.z);
      group.add(stall);
      // keeper + its home (local) pos so the game can wander it subtly on a tether
      vendorMeshes.push({ ...v, wx: w.x, wz: w.z, mesh: stall, keeper, keeperHome: keeper.position.clone() });
    }
  }

  // --- Return portal to town (dungeon floors, at the spawn point) ---
  // A glowing swirling sphere (blue tint) that looks identical from every
  // angle, with a swarm of particles orbiting it.
  let returnPortalMesh = null;
  if (!town && !dungeon.boss) {
    const w = tileToWorld(dungeon.spawn.x, dungeon.spawn.y);
    const portal = buildPortal({ radius: 0.75, colorA: 0x0a2a44, colorB: 0x4fa8d9, particleCount: 60 });
    returnPortalMesh = portal.object;
    returnPortalMesh.position.set(w.x, 1.1, w.z - 2.4); // clear of the arrival spot so nobody bounces straight back
    returnPortalMesh.userData.portalUpdate = portal.update;
    group.add(returnPortalMesh);
  }

  // --- Dungeon portal (town square, or town-in-dungeon-view) ---
  // Same sphere treatment in an arcane purple tint, plus a small stone base.
  let portalMesh = null;
  if (dungeon.portal) {
    const w = tileToWorld(dungeon.portal.x, dungeon.portal.y);
    portalMesh = new THREE.Group();
    const portal = buildPortal({ radius: 1.1, colorA: 0x2a0f55, colorB: 0xb35eff, particleCount: 84 });
    portal.object.position.y = 1.4;
    const baseStep = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.25, 8), new THREE.MeshStandardMaterial({ color: 0x333340, roughness: 0.9 }));
    baseStep.position.y = 0.12;
    portalMesh.add(portal.object, baseStep);
    portalMesh.position.set(w.x, 0, w.z);
    portalMesh.userData.portalUpdate = portal.update;
    group.add(portalMesh);
  }

  // --- Stairs down: a SQUARE floor hatch over a dark stairwell recess ---
  // Closed while the floor objective holds; the lid tilts UP to reveal the
  // steps descending into darkness once the seal breaks. Everything is tagged
  // in userData so game.js can drive the open animation + glow colour.
  let stairsMesh = null;
  if (dungeon.stairs) {
    const w = tileToWorld(dungeon.stairs.x, dungeon.stairs.y);
    stairsMesh = new THREE.Group();
    const HATCH = 1.6;                 // square hatch side (sits inside the 2-unit tile)
    const half = HATCH / 2;

    // Dark stairwell recess: a sunken square well, walled on all four sides and
    // capped with a solid black bottom so nothing behind or below shows through.
    // The whole well is inset just BELOW the floor plane (top of the walls at
    // WELL_TOP < 0) so no face is coplanar with the floor -> no z-fighting.
    const WELL_TOP = -0.05;            // wall tops sit just under the floor
    const WELL_DEPTH = 2.0;            // how far the well sinks
    const WELL_BOT = WELL_TOP - WELL_DEPTH;
    // The solid floor tile at this spot is omitted (see floorRenderTiles), so
    // the well must fill the whole 2-unit tile hole. The shaft spans the tile;
    // a dark coping rim frames the smaller hatch opening flush with the floor.
    const OUTER = TILE;                 // well footprint == the removed floor tile
    const outerHalf = OUTER / 2;
    // Solid black bottom cap: a thick slab well below the opening so the floor
    // beneath the level can never be seen through the hole.
    const bottomMat = new THREE.MeshStandardMaterial({ color: 0x020204, roughness: 1, metalness: 0 });
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(OUTER, 0.3, OUTER), bottomMat);
    bottom.position.y = WELL_BOT - 0.15;
    stairsMesh.add(bottom);
    // Four dark inner walls lining the shaft, spanning the full tile so no gap
    // between the well and the surrounding floor can reveal the void below. Box
    // faces point outward, so looking down the camera always meets a solid wall.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a0a10, roughness: 1, metalness: 0 });
    const wallH = WELL_DEPTH + 0.1;
    const wallY = (WELL_TOP + WELL_BOT) / 2;
    const wallLong = new THREE.BoxGeometry(OUTER, wallH, 0.14);
    const wallSide = new THREE.BoxGeometry(0.14, wallH, OUTER);
    const wN = new THREE.Mesh(wallLong, wallMat); wN.position.set(0, wallY, -outerHalf + 0.07);
    const wS = new THREE.Mesh(wallLong, wallMat); wS.position.set(0, wallY, outerHalf - 0.07);
    const wW = new THREE.Mesh(wallSide, wallMat); wW.position.set(-outerHalf + 0.07, wallY, 0);
    const wE = new THREE.Mesh(wallSide, wallMat); wE.position.set(outerHalf - 0.07, wallY, 0);
    stairsMesh.add(wN, wS, wW, wE);
    // Dark coping rim: a thin square frame from the floor plane down to the well
    // top, filling the ring between the 2-unit tile edge and the hatch opening
    // so the floor meets solid stone, never a see-through seam. Its top sits a
    // hair below y=0 so it is not coplanar with the surrounding floor tiles.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 1, metalness: 0 });
    const rimTop = -0.02, rimBot = WELL_TOP, rimH = rimTop - rimBot;
    const rimY = (rimTop + rimBot) / 2;
    const rimBand = (outerHalf - half + 0.02);
    const rimLong = new THREE.BoxGeometry(OUTER, rimH, rimBand);
    const rimSide = new THREE.BoxGeometry(rimBand, rimH, HATCH);
    const rimZ = half + rimBand / 2 - 0.01;
    const rimX = half + rimBand / 2 - 0.01;
    const rN = new THREE.Mesh(rimLong, rimMat); rN.position.set(0, rimY, -rimZ);
    const rS = new THREE.Mesh(rimLong, rimMat); rS.position.set(0, rimY, rimZ);
    const rW = new THREE.Mesh(rimSide, rimMat); rW.position.set(-rimX, rimY, 0);
    const rE = new THREE.Mesh(rimSide, rimMat); rE.position.set(rimX, rimY, 0);
    stairsMesh.add(rN, rS, rW, rE);

    // Wooden plank steps descending into the dark. Each step is a little lower
    // and a little darker than the last, so the lower steps fade toward black
    // and the bottom of the flight melts into the shadow of the well.
    const STEP_COUNT = 6;
    for (let i = 0; i < STEP_COUNT; i++) {
      // 1 (top) -> 0 (bottom): steps dim from warm wood to near-black.
      const t = 1 - i / (STEP_COUNT - 1);
      const shade = 0.12 + 0.88 * t;   // brightness multiplier down the flight
      const stepMat = new THREE.MeshStandardMaterial({
        map: woodTex,
        color: new THREE.Color(0x6b4a2b).multiplyScalar(shade),
        roughness: 0.9,
        metalness: 0,
      });
      const step = new THREE.Mesh(new THREE.BoxGeometry(HATCH - 0.12, 0.14, 0.3), stepMat);
      // Top tread starts below the floor plane (never coplanar with it).
      step.position.set(0, WELL_TOP - 0.12 - i * 0.24, half - 0.22 - i * 0.26);
      stairsMesh.add(step);
    }

    // Square hatch lid on a hinge pivot at the far edge, so it swings up-and-back.
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.06, -half);
    lidPivot.userData.stairsLid = true;
    const lidMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.85 });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(HATCH, 0.12, HATCH), lidMat);
    lid.position.set(0, 0, half); // offset so the pivot edge is the hinge
    lidPivot.add(lid);
    stairsMesh.add(lidPivot);

    // Glowing GOLD light puddle pooled on the floor around the hatch: an
    // irregular, soft-edged radial glow (additive) that reads as enticing gold
    // light spilling from the exit, drawing the eye there. Randomised per hatch
    // via a seed derived from the stairs tile so every floor's pool has its own
    // blob shape / size / rotation. game.js drives its colour + brightness
    // (dim greyish-gold while sealed, bright gold once the stairs unlock).
    const puddleSeed = (dungeon.stairs.x * 73856093) ^ (dungeon.stairs.y * 19349663) ^ (floor * 83492791);
    const puddle = buildHatchPuddle(puddleSeed);
    puddle.position.y = 0.03; // just above the floor plane, flat
    stairsMesh.add(puddle);

    stairsMesh.position.set(w.x, 0, w.z);
    group.add(stairsMesh);
  }

  // --- Dungeon decoration: wall-hugging themed props ---
  // (Room-center "rug" rings were removed — their faint ring outline read as a
  //  stray portal ring in every large room. The only ring is the real portal.)
  if (!town && dungeon.props?.length) buildDungeonProps(group, dungeon, theme, torchPositions, smokePuffs, floorAccent, frng, breakables);
  // --- Cathedral archetype dressing: pew benches (breakable) + altar ---
  if (!town && dungeon.archetype === 'cathedral' && dungeon.naveRoom) {
    buildCathedralDressing(group, dungeon, theme, torchPositions, breakables);
  }
  // atmospheric particles drifting through the dungeon air — kind and motion
  // themed per act (dust/spores/embers/wisps/bubbles), density per floor.
  // Still driven entirely by the existing puff.kind === 'mote' update path in
  // game.js; only the per-mote `style` differs.
  if (!town && floorTiles.length) {
    const MOTE_STYLES = {
      'The Old Halls':      { key: 'dust',   opacity: 0.22, blend: THREE.NormalBlending,   size: 0.03 },
      'The Rotting Depths': { key: 'spore',  opacity: 0.28, blend: THREE.NormalBlending,   size: 0.035 },
      'The Ember Vaults':   { key: 'ember',  opacity: 0.55, blend: THREE.AdditiveBlending, size: 0.026 },
      'The Sunless Court':  { key: 'wisp',   opacity: 0.3,  blend: THREE.NormalBlending,   size: 0.05 },
      'The Abyssal Throne': { key: 'bubble', opacity: 0.26, blend: THREE.NormalBlending,   size: 0.045 },
    };
    const style = MOTE_STYLES[theme.name] || MOTE_STYLES['The Old Halls'];
    const moteGeo = new THREE.SphereGeometry(style.size, 4, 4);
    const moteCount = 16 + Math.floor(frng() * 12); // per-floor density, always a small count
    for (let i = 0; i < moteCount; i++) {
      const tp = floorTiles[Math.floor(Math.random() * floorTiles.length)];
      const w = tileToWorld(tp.x, tp.y);
      // each mote gets its own (cheap) material so ember/wisp fades and
      // pulses don't affect every other mote sharing a single material
      const mat = new THREE.MeshBasicMaterial({ color: floorAccent, transparent: true, opacity: style.opacity, depthWrite: false, fog: true, blending: style.blend });
      const m = new THREE.Mesh(moteGeo, mat);
      const baseY = 0.4 + Math.random() * 1.3;
      m.position.set(w.x + (Math.random() - 0.5) * TILE, baseY, w.z + (Math.random() - 0.5) * TILE);
      group.add(m);
      smokePuffs.push({
        mesh: m, kind: 'mote', style: style.key, baseY, baseOpacity: style.opacity,
        phase: Math.random() * 10, speed: 0.15 + Math.random() * 0.2,
        cx: m.position.x, cz: m.position.z, drift: Math.random() * Math.PI * 2,
      });
    }
  }
  // --- Occasional glowing rune floor tile: a rare inlaid glyph that reads as
  // faintly magical (unlit, so it glows regardless of local lighting).
  if (!town && floorTiles.length) {
    const runeCount = 2 + Math.floor(frng() * 3); // 2-4 per floor
    const runeMat = new THREE.MeshBasicMaterial({
      map: runeTexture(theme), transparent: true, opacity: 0.7, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, fog: true,
    });
    const runeGeo = new THREE.PlaneGeometry(TILE * 0.62, TILE * 0.62);
    for (let i = 0; i < runeCount; i++) {
      const tp = floorTiles[Math.floor(Math.random() * floorTiles.length)];
      const w = tileToWorld(tp.x, tp.y);
      const rune = new THREE.Mesh(runeGeo, runeMat);
      rune.rotation.x = -Math.PI / 2;
      rune.position.set(w.x, 0.025, w.z);
      group.add(rune);
    }
  }
  // --- World beyond the town walls: forest ring + horizon ground ---
  if (town) buildTownSurroundings(group, dungeon, smokePuffs);

  // --- Modeled dungeon architecture: async swap-in over the box fallback above ---
  if (!town) {
    dressDungeonArchitecture(group, dungeon, theme, floor, {
      floorMesh, floorRenderTiles, wallMesh, wallDecorMeshes, renderWalls, sconceMeshes, torchPositions,
    });
  }

  return { group, doorMeshes, chestMeshes, stairsMesh, torchPositions, vendorMeshes, portalMesh, returnPortalMesh, smokePuffs, breakables, townGlows,
    destructibleWalls: destructibleWallStates, theme, floor, wallTex };
}

// ---------------- Embervale decor ----------------
function buildTownDecor(group, dungeon, smokePuffs, townGlows = [], breakables = []) {
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });
  const greens = [0x3f6b34, 0x4a7a3c, 0x57883f, 0x35592c];

  // trees: the procedural cone/blob build goes up first and STAYS if the
  // modeled trees fail to load; otherwise the modeled CC0 trees (three leafy
  // variants + a pine) swap in as instanced sets, one bucket per model kind,
  // at exactly the same positions and per-tree scales. Yaw and variant choice
  // are seeded so co-op towns match.
  const treeRng = worldRng(0x51f7a3 ^ (dungeon.size || 0));
  const oakT = [], pineT = [];
  const proceduralOaks = new THREE.Group();
  const proceduralPines = new THREE.Group();
  for (const t of dungeon.trees || []) {
    const w = tileToWorld(t.x, t.y);
    const ry = treeRng() * Math.PI * 2;
    const variant = Math.floor(treeRng() * 3);
    const tree = new THREE.Group();
    if (t.kind === 'pine') {
      pineT.push({ x: w.x, z: w.z, ry, s: 3.1 * t.s });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 1.0, 6), trunkMat);
      trunk.position.y = 0.5;
      tree.add(trunk);
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.9 - i * 0.22, 1.0, 8),
          new THREE.MeshStandardMaterial({ color: greens[(i + 2) % greens.length], roughness: 0.95 })
        );
        cone.position.y = 1.1 + i * 0.65;
        tree.add(cone);
      }
    } else {
      oakT.push({ x: w.x, z: w.z, ry, s: 2.9 * t.s, variant });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 1.5, 7), trunkMat);
      trunk.position.y = 0.75;
      trunk.rotation.z = (Math.random() - 0.5) * 0.12;
      tree.add(trunk);
      const blobCount = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < blobCount; i++) {
        const r = 0.55 + Math.random() * 0.35;
        const blob = new THREE.Mesh(
          new THREE.SphereGeometry(r, 8, 7),
          new THREE.MeshStandardMaterial({ color: greens[Math.floor(Math.random() * greens.length)], roughness: 0.95 })
        );
        blob.position.set((Math.random() - 0.5) * 0.9, 1.7 + Math.random() * 0.7, (Math.random() - 0.5) * 0.9);
        blob.scale.y = 0.85;
        tree.add(blob);
      }
    }
    tree.scale.setScalar(t.s);
    tree.rotation.y = ry;
    tree.position.set(w.x, 0, w.z);
    (t.kind === 'pine' ? proceduralPines : proceduralOaks).add(tree);
  }
  group.add(proceduralOaks, proceduralPines);
  if (oakT.length) {
    swapInModel(group, proceduralOaks, ['treeBirch', 'treeOak', 'treeWillow'], (tpls) => {
      const avail = tpls.filter(Boolean);
      if (!avail.length) return null;
      const g = new THREE.Group();
      const buckets = avail.map(() => []);
      for (const t of oakT) buckets[t.variant % avail.length].push(t);
      avail.forEach((tpl, k) => { if (buckets[k].length) g.add(buildModelInstances(tpl, buckets[k])); });
      return g;
    });
  }
  if (pineT.length) {
    swapInModel(group, proceduralPines, ['pine'], ([tpl]) => (tpl ? buildModelInstances(tpl, pineT) : null));
  }

  // bushes and flowerbeds. Bush spots record transforms so the modeled bush
  // can swap in (two offset instances per spot read as a natural cluster);
  // flowers stay procedural, they already read well from the top-down camera.
  const bushRng = worldRng(0x2b45c1);
  const bushT = [];
  const proceduralBushes = new THREE.Group();
  for (const p of dungeon.plants || []) {
    const w = tileToWorld(p.x, p.y);
    const spot = new THREE.Group();
    if (p.kind === 'bush') {
      bushT.push(
        { x: w.x + (bushRng() - 0.5) * 0.4, z: w.z + (bushRng() - 0.5) * 0.4, ry: bushRng() * Math.PI * 2, s: 0.5 + bushRng() * 0.2 },
        { x: w.x + (bushRng() - 0.5) * 0.9, z: w.z + (bushRng() - 0.5) * 0.9, ry: bushRng() * Math.PI * 2, s: 0.3 + bushRng() * 0.15 }
      );
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(
          new THREE.SphereGeometry(0.22 + Math.random() * 0.14, 7, 6),
          new THREE.MeshStandardMaterial({ color: greens[Math.floor(Math.random() * greens.length)], roughness: 1 })
        );
        b.position.set((Math.random() - 0.5) * 0.7, 0.18, (Math.random() - 0.5) * 0.7);
        b.scale.y = 0.75;
        spot.add(b);
      }
    } else {
      const petals = [0xd8c95a, 0xc96a6a, 0xb98ad8, 0xe8e0d0, 0xe89a4a];
      for (let i = 0; i < 6; i++) {
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4),
          new THREE.MeshStandardMaterial({ color: 0x4a7a3c })
        );
        const px = (Math.random() - 0.5) * 1.1, pz = (Math.random() - 0.5) * 1.1;
        stem.position.set(px, 0.15, pz);
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 6, 5),
          new THREE.MeshStandardMaterial({ color: petals[Math.floor(Math.random() * petals.length)], roughness: 0.6 })
        );
        head.position.set(px, 0.33, pz);
        spot.add(stem, head);
      }
    }
    spot.position.set(w.x, 0, w.z);
    if (p.kind === 'bush') proceduralBushes.add(spot);
    else group.add(spot);
  }
  group.add(proceduralBushes);
  if (bushT.length) {
    swapInModel(group, proceduralBushes, ['bush'], ([tpl]) => (tpl ? buildModelInstances(tpl, bushT) : null));
  }

  // seeded grass tufts across the town green: modeled clumps scattered over
  // the open grass tiles (never on cobbles or under buildings/props), purely
  // additive dressing with no collision. One instanced draw per grass kind,
  // and the same srand-style seed on every client so co-op towns match.
  if (dungeon.grid) {
    const gRng = worldRng(0x6e24d9);
    const occupied = new Set();
    const mark = (x, y) => occupied.add(x + ',' + y);
    for (const c of dungeon.cobbles || []) mark(c.x, c.y);
    for (const t of dungeon.trees || []) mark(t.x, t.y);
    for (const p of dungeon.plants || []) mark(p.x, p.y);
    for (const h of dungeon.hedges || []) mark(h.x, h.y);
    for (const c of dungeon.crates || []) mark(c.x, c.y);
    for (const v of dungeon.vendors || []) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark(v.x + dx, v.y + dy);
    }
    for (const spot of [dungeon.well, dungeon.noticeBoard, dungeon.cart, dungeon.portal]) {
      if (spot) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark(spot.x + dx, spot.y + dy); }
    }
    if (dungeon.tavern) {
      const t = dungeon.tavern;
      for (let y = t.y - 1; y <= t.y + t.h; y++) for (let x = t.x - 1; x <= t.x + t.w; x++) mark(x, y);
    }
    const grassT = [[], []];
    for (let y = 0; y < dungeon.size; y++) {
      for (let x = 0; x < dungeon.size; x++) {
        if (dungeon.grid[y][x] !== FLOOR || occupied.has(x + ',' + y)) continue;
        const tufts = gRng() < 0.55 ? (gRng() < 0.25 ? 2 : 1) : 0;
        for (let i = 0; i < tufts; i++) {
          const w = tileToWorld(x, y);
          grassT[gRng() < 0.5 ? 0 : 1].push({
            x: w.x + (gRng() - 0.5) * 1.5,
            z: w.z + (gRng() - 0.5) * 1.5,
            ry: gRng() * Math.PI * 2,
            s: 0.2 + gRng() * 0.22,
          });
        }
      }
    }
    swapInModel(group, null, ['grassA', 'grassB'], (tpls) => {
      const g = new THREE.Group();
      grassT.forEach((set, k) => {
        // if one grass kind failed to load, the other covers both sets
        const tpl = tpls[k] || tpls[1 - k];
        if (tpl && set.length) g.add(buildModelInstances(tpl, set));
      });
      return g.children.length ? g : null;
    });
  }

  // the old stone well
  if (dungeon.well) {
    const w = tileToWorld(dungeon.well.x, dungeon.well.y);
    const well = new THREE.Group();
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.5, 10, 1, true), ringMat);
    ring.position.y = 0.25;
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10), new THREE.MeshBasicMaterial({ color: 0x1a3044 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.28;
    const postL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 5), trunkMat);
    postL.position.set(-0.55, 0.8, 0);
    const postR = postL.clone(); postR.position.x = 0.55;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0x7a4a2e, roughness: 0.9 }));
    roof.position.y = 1.55;
    roof.rotation.y = Math.PI / 4;
    well.add(ring, water, postL, postR, roof);
    well.position.set(w.x, 0, w.z);
    group.add(well);
  }

  // notice board near the square
  if (dungeon.noticeBoard) {
    const w = tileToWorld(dungeon.noticeBoard.x, dungeon.noticeBoard.y);
    const board = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.95 });
    const postL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6), postMat);
    postL.position.set(-0.45, 0.65, 0);
    const postR = postL.clone(); postR.position.x = 0.45;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.75, 0.06), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
    panel.position.y = 1.15;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.08, 0.3), postMat);
    roof.position.y = 1.58;
    roof.rotation.x = -0.15;
    // scraps of "paper" notices
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.32), paperMat);
      paper.position.set(-0.32 + i * 0.32, 1.15 + (i % 2) * 0.05, 0.04);
      paper.rotation.z = (i - 1) * 0.08;
      board.add(paper);
    }
    board.add(postL, postR, panel, roof);
    board.position.set(w.x, 0, w.z);
    group.add(board);
  }

  // market crates + sacks scattered near the square. Each crate gets its own
  // holder group (not a shared InstancedMesh) so it can swap to the modeled
  // CC0 crate AND still be smashed individually by breakNear(); sacks stay
  // procedural decoration (not breakable, same as the dungeon's own sacks).
  if (dungeon.crates?.length) {
    const crateGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const sackMat = new THREE.MeshStandardMaterial({ color: 0xa89468, roughness: 1 });
    const crateMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
    for (const c of dungeon.crates) {
      const w = tileToWorld(c.x, c.y);
      if (c.kind === 'crate') {
        const holder = new THREE.Group();
        const mesh = new THREE.Mesh(crateGeo, crateMat);
        mesh.position.y = 0.21;
        holder.add(mesh);
        holder.position.set(w.x, 0, w.z);
        holder.rotation.y = c.r;
        group.add(holder);
        swapInModel(holder, mesh, ['crate'], ([tpl]) => (tpl ? buildModelMesh(tpl, 0.44) : null));
        breakables.push({ mesh: holder, x: w.x, z: w.z, kind: 'crate' });
      } else {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), sackMat);
        mesh.scale.y = 0.85;
        mesh.rotation.y = c.r;
        mesh.position.set(w.x, 0.22, w.z);
        group.add(mesh);
      }
    }
  }

  // small market cart with wheels
  if (dungeon.cart) {
    const w = tileToWorld(dungeon.cart.x, dungeon.cart.y);
    const cart = new THREE.Group();
    const bedMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.6), bedMat);
    bed.position.y = 0.45;
    cart.add(bed);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
    const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.08, 10);
    for (const wx of [-0.42, 0.42]) {
      for (const wz of [-0.35, 0.35]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.24, wz);
        cart.add(wheel);
      }
    }
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), wheelMat);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0.75, 0.42, 0);
    cart.add(handle);
    cart.rotation.y = dungeon.cart.r;
    cart.position.set(w.x, 0, w.z);
    group.add(cart);
  }

  // hedges: rounded shrub clusters, not slabs
  if (dungeon.hedges?.length) {
    const hedgeGreens = [0x3f6b34, 0x4a7a3c, 0x35592c, 0x578840];
    const blobGeo = new THREE.SphereGeometry(1, 8, 6);
    let hseed = 7;
    const hrand = () => { hseed = (hseed * 1664525 + 1013904223) >>> 0; return hseed / 0x100000000; };
    for (const h of dungeon.hedges) {
      const w = tileToWorld(h.x, h.y);
      for (let i = 0; i < 4; i++) {
        const blob = new THREE.Mesh(blobGeo, new THREE.MeshStandardMaterial({
          color: hedgeGreens[Math.floor(hrand() * hedgeGreens.length)], roughness: 1,
        }));
        const r = 0.3 + hrand() * 0.22;
        blob.scale.set(r * 1.25, r * 0.8, r * 1.1);
        blob.position.set(
          w.x + (hrand() - 0.5) * 1.4,
          r * 0.55,
          w.z + (hrand() - 0.5) * 1.0
        );
        blob.rotation.y = hrand() * Math.PI;
        group.add(blob);
      }
    }
  }

  // The Sleeping Golem tavern
  if (dungeon.tavern) {
    const t = dungeon.tavern;
    const cw = tileToWorld(t.x + t.w / 2 - 0.5, t.y + t.h / 2 - 0.5);
    const W = t.w * TILE, D = t.h * TILE;
    const tavern = new THREE.Group();
    const plaster = new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.95 });
    const timber = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });

    // The whole procedural building shell (walls, beams, roof, gables, door,
    // windows) lives in one subgroup: it is the fallback that the modeled CC0
    // inn swaps out in a single replacement below. Chimney + smoke, the step,
    // the hanging sign and the outside barrel/bench stay either way.
    const shell = new THREE.Group();
    tavern.add(shell);
    const body = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 2.6, D - 0.4), plaster);
    body.position.y = 1.3;
    shell.add(body);
    // timber frame lines
    for (let i = 0; i <= 3; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), timber);
      beam.position.set(-W / 2 + 0.25 + (i * (W - 0.5)) / 3, 1.3, D / 2 - 0.14);
      shell.add(beam);
    }
    const beltBeam = new THREE.Mesh(new THREE.BoxGeometry(W - 0.3, 0.14, 0.12), timber);
    beltBeam.position.set(0, 1.75, D / 2 - 0.14);
    shell.add(beltBeam);
    // pitched roof: two slopes computed to MEET exactly at the ridge and
    // overhang the eaves — no gaps, no clipping — plus closed gable ends
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x71402a, roughness: 0.85 });
    const wallTop = 2.6, ridgeY = 3.6;
    const halfSpan = D / 2 + 0.35;                       // eave overhang
    const pitch = Math.atan((ridgeY - wallTop) / halfSpan);
    const slopeLen = Math.hypot(halfSpan, ridgeY - wallTop) + 0.1;
    const slabL = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.12, slopeLen), roofMat);
    slabL.position.set(0, (wallTop + ridgeY) / 2 + 0.04, -halfSpan / 2);
    slabL.rotation.x = -pitch;
    const slabR = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.12, slopeLen), roofMat);
    slabR.position.set(0, (wallTop + ridgeY) / 2 + 0.04, halfSpan / 2);
    slabR.rotation.x = pitch;
    shell.add(slabL, slabR);
    // gable end triangles close the roof so you can't see inside it
    const gableShape = new THREE.Shape();
    gableShape.moveTo(-(D / 2 - 0.2), 0);
    gableShape.lineTo(D / 2 - 0.2, 0);
    gableShape.lineTo(0, ridgeY - wallTop);
    gableShape.closePath();
    const gableGeo = new THREE.ShapeGeometry(gableShape);
    for (const sx of [-(W - 0.4) / 2, (W - 0.4) / 2]) {
      const gable = new THREE.Mesh(gableGeo, plaster);
      gable.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
      gable.position.set(sx, wallTop, 0);
      shell.add(gable);
    }
    // ridge beam caps the peak
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, 0.14, 0.18), timber);
    ridge.position.set(0, ridgeY + 0.06, 0);
    shell.add(ridge);
    // chimney + animated smoke puffs (data returned via smokePuffs for the game loop to drift/fade)
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.1, 0.35), new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 }));
    chimney.position.set(W * 0.28, 3.5, 0);
    tavern.add(chimney);
    const puffGeo = new THREE.SphereGeometry(1, 6, 5); // unit sphere, scaled per-puff below
    for (let i = 0; i < 5; i++) {
      const s = 0.14 + i * 0.05;
      const puff = new THREE.Mesh(
        puffGeo,
        new THREE.MeshBasicMaterial({ color: 0x9a95a0, transparent: true, opacity: 0.34 - i * 0.05 })
      );
      puff.scale.setScalar(s);
      const baseY = 4.05 + i * 0.3;
      puff.position.set(W * 0.28 + (Math.random() - 0.5) * 0.1, baseY, 0);
      tavern.add(puff);
      if (smokePuffs) {
        smokePuffs.push({ mesh: puff, baseY, phase: (i / 5) * Math.PI * 2, speed: 0.35 + i * 0.05, kind: 'smoke' });
      }
    }
    // warm windows: framed + mullioned, INSET into the plaster (behind the
    // timber frame layer) and sized to sit between the beams — facade layers
    // never overlap: plaster face < window (+0.01) < mullions/frame (+0.02+).
    // Added directly to `tavern` (not `shell`) so they survive the modeled
    // CC0 inn swap too — the model's own baked windows are unlit glass, so
    // these glowing panes are what actually gives the facade a lived-in,
    // warm-at-night look either way.
    const glow = new THREE.MeshBasicMaterial({ color: 0xffb45e });
    const frontFace = D / 2 - 0.2; // plaster front plane
    const mkWindow = (x, z, roty) => {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.46), glow.clone());
      win.position.set(x, 1.32, z);
      win.rotation.y = roty;
      tavern.add(win);
      // wood frame around the pane
      const frame = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.05), timber); top.position.y = 0.26;
      const bot = top.clone(); bot.position.y = -0.26;
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.58, 0.05), timber); l.position.x = -0.27;
      const r = l.clone(); r.position.x = 0.27;
      frame.add(top, bot, l, r);
      frame.position.copy(win.position);
      frame.rotation.y = roty;
      tavern.add(frame);
      // mullions: a cross dividing the pane into four small lights
      const mV = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.46, 0.03), timber);
      const mH = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.03), timber);
      mV.position.copy(win.position); mV.rotation.y = roty;
      mH.position.copy(win.position); mH.rotation.y = roty;
      tavern.add(mV, mH);
      // each pane has its own cloned material, so each needs its own
      // townGlows entry — the day/night driver walks the list per-mesh.
      townGlows.push({ mesh: win, base: new THREE.Color(0xffb45e), kind: 'basic' });
      return win;
    };
    mkWindow(-W * 0.28, frontFace + 0.01, 0);
    const sideFace = (W - 0.4) / 2;
    mkWindow(-sideFace - 0.01, 0, -Math.PI / 2);
    // door frame + door + step
    const frameMat = timber;
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.14), frameMat);
    frameTop.position.set(W * 0.28, 1.58, D / 2 - 0.1);
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.14), frameMat);
    frameL.position.set(W * 0.28 - 0.4, 0.78, D / 2 - 0.1);
    const frameR = frameL.clone();
    frameR.position.x = W * 0.28 + 0.4;
    shell.add(frameTop, frameL, frameR);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.1), timber);
    door.position.set(W * 0.28, 0.75, D / 2 - 0.12);
    shell.add(door);
    // door handle/knob — on the procedural fallback door AND, since the
    // modeled inn's own baked door has no handle at all, a second one added
    // directly to `tavern` at the same doorstep-aligned spot so a real
    // handle reads on the door either way.
    const handleMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.35 });
    const doorHandle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), handleMat);
    doorHandle.position.set(W * 0.28 + 0.22, 0.85, D / 2 - 0.06);
    shell.add(doorHandle);
    const modelDoorHandle = doorHandle.clone();
    modelDoorHandle.position.set(W * 0.28 + 0.22, 0.85, D / 2 + 0.02);
    tavern.add(modelDoorHandle);
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.4), new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.95 }));
    step.position.set(W * 0.28, 0.07, D / 2 + 0.25);
    tavern.add(step);
    // hanging sign: an iron bracket bolted above the door, two chains, and a
    // real wooden board reading "Emberville Tavern" (was a blank plank with
    // a stray mug and a bare beam floating against the wall — replaced with
    // a proper hung sign).
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.55, roughness: 0.5 });
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.7), ironMat);
    bracket.position.set(W * 0.28 + 0.85, 2.35, D / 2 + 0.15);
    const chainL = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 5), ironMat);
    chainL.position.set(W * 0.28 + 0.85, 2.18, D / 2 - 0.1);
    const chainR = chainL.clone();
    chainR.position.z = D / 2 + 0.4;
    const signBoard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.9),
      new THREE.MeshStandardMaterial({ map: makeExteriorSignTexture(), roughness: 0.85 }));
    signBoard.position.set(W * 0.28 + 0.85, 1.95, D / 2 + 0.15);
    tavern.add(bracket, chainL, chainR, signBoard);
    // barrel + bench outside, near the door (barrel swaps to the modeled one).
    // Held in its own subgroup (not loose in `tavern`) so breakNear() can
    // smash just the barrel without touching the rest of the building.
    const barrelHolder = new THREE.Group();
    barrelHolder.position.set(-W * 0.4, 0, D / 2 + 0.35);
    tavern.add(barrelHolder);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6b4c30, roughness: 0.85 });
    const outsideBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.55, 10), barrelMat);
    outsideBarrel.position.y = 0.28;
    barrelHolder.add(outsideBarrel);
    swapInModel(barrelHolder, outsideBarrel, ['barrel'], ([tpl]) => (tpl ? buildModelMesh(tpl, 0.6) : null));
    breakables.push({ mesh: barrelHolder, x: cw.x + barrelHolder.position.x, z: cw.z + barrelHolder.position.z, kind: 'barrel' });
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 });
    const benchSeat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.3), benchMat);
    benchSeat.position.set(-W * 0.05, 0.32, D / 2 + 0.5);
    const benchLegGeo = new THREE.BoxGeometry(0.08, 0.32, 0.08);
    const legA = new THREE.Mesh(benchLegGeo, benchMat); legA.position.set(-W * 0.05 - 0.38, 0.16, D / 2 + 0.4);
    const legB = new THREE.Mesh(benchLegGeo, benchMat); legB.position.set(-W * 0.05 + 0.38, 0.16, D / 2 + 0.4);
    tavern.add(benchSeat, legA, legB);

    // Modeled CC0 inn replaces the box-and-slab shell once its GLB loads.
    // Slightly non-uniform scale fills the tavern's wide plot without making
    // the building tower over the square; the enter-trigger world point in
    // game.js (doorstep on the south face) is untouched.
    // The Y scale is taller than the original (4.6 -> 5.8): measured against a
    // 1.6-unit hero marker, the model's own door opening is a small fraction of
    // its total height, so at 4.6 the door read as barely half the hero's
    // height (a doll-house door next to the player). Scaling Y further still
    // doesn't fully clear 1.6 at the door without stretching the whole
    // building unnaturally tall and gaunt, so this is the tallest Y that still
    // reads as a cottage rather than a tower; the door is now much closer to
    // hero height instead of roughly half of it.
    swapInModel(tavern, shell, ['inn'], ([tpl]) => {
      if (!tpl) return null;
      const node = buildModelMesh(tpl, 1);
      node.scale.set(6.2, 5.8, 5.4);
      return node;
    });

    tavern.position.set(cw.x, 0, cw.z);
    group.add(tavern);
  }
}

// ---------------- Dungeon decoration ----------------

// Themed floor medallions in the larger rooms so they don't read as bare brick.
function buildRoomRugs(group, dungeon, theme) {
  const acc = new THREE.Color(theme.accent);
  for (const r of dungeon.rooms || []) {
    if (r.w < 5 || r.h < 5) continue;
    const w = tileToWorld(Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2));
    const rad = Math.min(r.w, r.h) * 0.3 * TILE;
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(rad, 24),
      new THREE.MeshStandardMaterial({ color: acc.clone().multiplyScalar(0.26), roughness: 1,
        polygonOffset: true, polygonOffsetFactor: -1, transparent: true, opacity: 0.55 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(w.x, 0.03, w.z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(rad * 0.58, rad * 0.68, 24),
      new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.2, side: THREE.DoubleSide, fog: true }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(w.x, 0.04, w.z);
    group.add(rug, ring);
  }
}

// Gothic cathedral archetype dressing: breakable pew benches down the nave
// and an altar (dais + candle flames + a glowing arch window on the far
// wall) at the far end. Columns/colonnades are just isolated WALL tiles the
// generator carved, so they render for free through the normal wall mesh.
function buildCathedralDressing(group, dungeon, theme, torchPositions, breakables) {
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
  const benchSeatGeo = new THREE.BoxGeometry(0.9, 0.12, 0.4);
  const benchBackGeo = new THREE.BoxGeometry(0.9, 0.5, 0.08);
  const legGeo = new THREE.BoxGeometry(0.06, 0.28, 0.06);
  for (const p of dungeon.pews) {
    const w = tileToWorld(p.x, p.y);
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(benchSeatGeo, woodMat); seat.position.y = 0.28; bench.add(seat);
    const back = new THREE.Mesh(benchBackGeo, woodMat); back.position.set(0, 0.5, -0.16); bench.add(back);
    for (const lx of [-0.38, 0.38]) { const leg = new THREE.Mesh(legGeo, woodMat); leg.position.set(lx, 0.14, 0.1); bench.add(leg); }
    bench.position.set(w.x, 0, w.z);
    bench.rotation.y = p.r;
    group.add(bench);
    breakables.push({ mesh: bench, x: w.x, z: w.z, kind: 'pew' });
  }

  // altar: raised stone dais + a pair of candle flames (registered as real
  // torch lights so they flicker/glow through the existing pooled system)
  const altarW = tileToWorld(dungeon.altar.x, dungeon.altar.y);
  const daisMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.wall).multiplyScalar(0.85), roughness: 0.9 });
  const dais = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 1.0), daisMat);
  dais.position.set(altarW.x, 0.15, altarW.z);
  group.add(dais);
  const altarTop = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.7), daisMat);
  altarTop.position.set(altarW.x, 0.55, altarW.z);
  group.add(altarTop);
  const flameGeo = new THREE.SphereGeometry(0.09, 8, 6);
  const flameMat = new THREE.MeshBasicMaterial({ color: theme.accent });
  for (const dx of [-0.45, 0.45]) {
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 6), daisMat);
    holder.position.set(altarW.x + dx, 0.95, altarW.z);
    group.add(holder);
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(altarW.x + dx, 1.14, altarW.z);
    group.add(flame);
    const flameGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: theme.accent, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.6,
    }));
    flameGlow.scale.setScalar(0.5); flameGlow.position.copy(flame.position); group.add(flameGlow);
    torchPositions.push({ x: flame.position.x, y: flame.position.y, z: flame.position.z, flame, glow: flameGlow });
  }

  // a large glowing pointed-arch window on the wall behind the altar
  const naveRoom = dungeon.naveRoom;
  const wallTile = tileToWorld(dungeon.altar.x, naveRoom.y - 1);
  const winShape = new THREE.Shape();
  winShape.moveTo(-0.7, 0);
  winShape.lineTo(-0.7, 1.6);
  winShape.quadraticCurveTo(0, 2.6, 0.7, 1.6);
  winShape.lineTo(0.7, 0);
  winShape.closePath();
  const winGeo = new THREE.ShapeGeometry(winShape);
  const winMat = new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false });
  const windowMesh = new THREE.Mesh(winGeo, winMat);
  windowMesh.position.set(wallTile.x, 1.0, wallTile.z + 0.95);
  group.add(windowMesh);
  const winLight = new THREE.PointLight(theme.accent, 8, 6, 2);
  winLight.position.set(wallTile.x, 2.0, wallTile.z + 0.5);
  group.add(winLight);
}

// Wall-hugging themed clutter. Braziers/candelabra register as torch lights so
// they glow and flicker via the game's pooled-light loop.
function buildDungeonProps(group, dungeon, theme, torchPositions, smokePuffs, floorAccent, frng, breakables) {
  const SETS = {
    'The Old Halls':      ['barrel', 'crate', 'bones', 'cobweb', 'banner', 'pot'],
    'The Rotting Depths': ['thicket', 'bones', 'pot', 'cobweb', 'barrel', 'skull'],
    'The Ember Vaults':   ['brazier', 'crate', 'skull', 'banner', 'pot', 'bones'],
    'The Sunless Court':  ['sarcophagus', 'candelabra', 'bones', 'banner', 'cobweb', 'skull'],
    'The Abyssal Throne': ['sarcophagus', 'skull', 'brazier', 'banner', 'bones', 'cobweb'],
  };
  const kinds = SETS[theme.name] || SETS['The Old Halls'];
  // Per-floor weighting over the SAME kind set: one floor might lean
  // skull-heavy, the next banner-heavy, keeping the act's prop set intact
  // while the mix varies floor to floor.
  const weights = kinds.map(() => 0.55 + frng() * 0.9);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pickKind = (roll) => {
    let r = (roll || 0) * totalWeight;
    for (let i = 0; i < kinds.length; i++) {
      r -= weights[i];
      if (r <= 0) return kinds[i];
    }
    return kinds[kinds.length - 1];
  };
  const accent = new THREE.Color(floorAccent);
  const C = { WOOD: 0x54402c, IRON: 0x3f3f47, BONE: 0xcfc6a6, STONE: 0x5e5766, TERRA: 0x8a4b33, accent };
  for (const p of dungeon.props) {
    const kind = pickKind(p.roll);
    const w = tileToWorld(p.x, p.y);
    if (kind === 'cobweb') {
      // Webs anchor to real geometry (they used to float mid-air at a random
      // yaw with the fan pointing away from anything). See buildCobwebProp.
      group.add(buildCobwebProp(dungeon.grid, p, w));
      continue;
    }
    // Banners are flat wall hangings and need to sit flush against the wall;
    // freestanding clutter keeps a bit of clearance from it. Sarcophagi are
    // nearly two tiles long, so they hug a little looser to clear the wall.
    const hug = kind === 'banner' ? 0.46 : kind === 'sarcophagus' ? 0.24 : 0.32;
    const px = w.x + (p.dx || 0) * (TILE * hug);
    const pz = w.z + (p.dy || 0) * (TILE * hug);
    const node = buildProp(kind, C, torchPositions, smokePuffs, px, pz, theme);
    if (!node) continue;
    node.position.set(px, 0, pz);
    if (kind === 'banner' && (p.dx || p.dy)) {
      // Face away from the wall and into the room instead of spinning to a
      // random yaw — a flat hanging needs to actually face the viewer, unlike
      // barrels/bones/etc which read fine from any angle.
      node.rotation.y = Math.atan2(-(p.dx || 0), -(p.dy || 0));
    } else if (kind === 'sarcophagus' && (p.dx || p.dy)) {
      // Long axis parallel to the wall it hugs: a random yaw drove the 1.9
      // unit box straight through the masonry about half the time. The box
      // is long along local Z, so a wall on +-X (running along Z) wants yaw
      // 0 and a wall on +-Z wants yaw PI/2, plus a small seeded jitter.
      node.rotation.y = (p.dx !== 0 ? 0 : Math.PI / 2) + ((p.roll || 0.5) - 0.5) * 0.12;
    } else {
      node.rotation.y = p.r || 0;
    }
    group.add(node);
    // containers can be smashed by attacks that land near them
    if (kind === 'barrel' || kind === 'crate' || kind === 'pot') breakables.push({ mesh: node, x: px, z: pz, kind });
  }
}

// A cobweb anchored to real surfaces. The quarter circle fan texture's radial
// center sits in its top-left corner (see makeCobwebTexture), so the plane is
// laid flat and yawed until that corner sits exactly at the anchoring
// junction, with the fan spreading into the room:
// - Corner web: the prop tile has walls on two perpendicular sides. The fan
//   center goes at the vertical wall-wall junction, hung high, with the
//   plane's edges running flush along both wall faces.
// - Wall-run web: no perpendicular wall. The web lies at the base of the
//   wall, fan center against the wall-floor junction, spreading onto the
//   floor like drifted webbing.
function buildCobwebProp(grid, p, w) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ map: cobwebTexture(), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, fog: true });
  const web = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), mat);
  // Laid flat at yaw 0, the fan-center corner offsets toward (-1, -1); this
  // yaw spins that corner around to point at the chosen junction instead.
  const yawFor = (cx, cz) => (cx < 0 ? (cz < 0 ? 0 : Math.PI / 2) : (cz < 0 ? -Math.PI / 2 : Math.PI));
  web.rotation.order = 'YXZ';
  web.rotation.x = -Math.PI / 2;
  const HALF = 0.475; // half the plane, distance from its center to the fan corner per axis
  const perp = p.dx !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  let pd = null;
  for (const [qx, qy] of perp) if (grid[p.y + qy]?.[p.x + qx] === WALL) { pd = [qx, qy]; break; }
  if (pd) {
    const cdx = p.dx + pd[0], cdz = p.dy + pd[1]; // diagonal pointing at the corner junction
    const jx = w.x + cdx * (TILE / 2 - 0.02);
    const jz = w.z + cdz * (TILE / 2 - 0.02);
    web.rotation.y = yawFor(cdx, cdz);
    web.position.set(jx - cdx * HALF, 2.35, jz - cdz * HALF);
  } else {
    const sign = (p.r || 0) > Math.PI ? 1 : -1; // seeded pick of which way it fans along the wall
    const cdx = p.dx !== 0 ? p.dx : sign;
    const cdz = p.dy !== 0 ? p.dy : sign;
    const jx = p.dx !== 0 ? w.x + p.dx * (TILE / 2 - 0.02) : w.x + cdx * 0.4;
    const jz = p.dy !== 0 ? w.z + p.dy * (TILE / 2 - 0.02) : w.z + cdz * 0.4;
    web.rotation.y = yawFor(cdx, cdz);
    web.position.set(jx - cdx * HALF, 0.04, jz - cdz * HALF);
  }
  g.add(web);
  return g;
}

function buildProp(kind, C, torchPositions, smokePuffs, px, pz, theme) {
  const g = new THREE.Group();
  const std = (color, rough = 1) => new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true });
  const glow = (color) => new THREE.MeshBasicMaterial({ color, fog: false });
  if (kind === 'barrel') {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.9, 9), std(C.WOOD));
    b.position.y = 0.45; g.add(b);
    for (const y of [0.2, 0.7]) { const h = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 12), std(C.IRON)); h.rotation.x = Math.PI / 2; h.position.y = y; g.add(h); }
  } else if (kind === 'crate') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), std(C.WOOD)); b.position.y = 0.35; g.add(b);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.1, 0.12), std(0x3c2c1c)); t.position.y = 0.35; g.add(t);
  } else if (kind === 'bones') {
    for (let i = 0; i < 4; i++) { const bn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 5), std(C.BONE)); bn.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI); bn.position.set((Math.random() - 0.5) * 0.4, 0.06, (Math.random() - 0.5) * 0.4); g.add(bn); }
    const sk = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), std(C.BONE)); sk.position.set(0.15, 0.12, 0.1); g.add(sk);
  } else if (kind === 'skull') {
    const sk = new THREE.Mesh(new THREE.SphereGeometry(0.18, 9, 7), std(C.BONE)); sk.position.y = 0.18; g.add(sk);
    for (const dx of [-0.06, 0.06]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), std(0x101014)); e.position.set(dx, 0.19, 0.15); g.add(e); }
  } else if (kind === 'pot') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.34, 8), std(C.TERRA)); base.position.y = 0.17; g.add(base);
    for (let i = 0; i < 3; i++) { const sh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.02), std(C.TERRA)); sh.position.set((Math.random() - 0.5) * 0.6, 0.05, (Math.random() - 0.5) * 0.6); sh.rotation.set(Math.PI / 2.3, Math.random(), 0); g.add(sh); }
  } else if (kind === 'banner') {
    // A wall tapestry: horizontal rod across the top, a double-sided cloth
    // panel carrying a real woven motif (see makeBannerTexture), and a
    // notched hem. Hangs flush against the wall — buildDungeonProps computes
    // the yaw so it always faces into the room instead of a random angle.
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), std(0x2a2a30));
    rod.rotation.z = Math.PI / 2; rod.position.set(0, 2.12, 0); g.add(rod);
    for (const dx of [-0.4, 0.4]) { const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), std(0xb8912e)); cap.position.set(dx, 2.12, 0); g.add(cap); }
    const clothMat = new THREE.MeshStandardMaterial({ map: bannerTexture(theme), roughness: 1, side: THREE.DoubleSide });
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.5), clothMat);
    cloth.position.set(0, 1.33, 0.02); g.add(cloth);
    const hemMat = new THREE.MeshStandardMaterial({ color: C.accent.clone().multiplyScalar(0.5), roughness: 1 });
    const hemL = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.28, 3), hemMat); hemL.rotation.x = Math.PI; hemL.position.set(-0.18, 0.53, 0.02); g.add(hemL);
    const hemR = hemL.clone(); hemR.position.x = 0.18; g.add(hemR);
  } else if (kind === 'brazier') {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.9, 6), std(C.IRON)); leg.position.y = 0.45; g.add(leg);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.16, 0.24, 10), std(C.IRON)); bowl.position.y = 0.95; g.add(bowl);
    const localFlame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 8), glow(C.accent)); localFlame.position.y = 1.25; g.add(localFlame);
    // glowing-orb bloom behind the flame core
    const braGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: C.accent, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.65,
    }));
    braGlow.scale.setScalar(0.75); braGlow.position.copy(localFlame.position); g.add(braGlow);
    if (torchPositions) torchPositions.push({ x: px, y: 1.25, z: pz, flame: localFlame, glow: braGlow });
  } else if (kind === 'candelabra') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.5, 6), std(C.IRON)); pole.position.y = 0.75; g.add(pole);
    let lastFlame = null, lastGlow = null;
    for (const dx of [-0.28, 0, 0.28]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 6), std(0xd8cf9a)); c.position.set(dx, 1.5, 0); g.add(c);
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), glow(0xffd27a)); fl.position.set(dx, 1.66, 0); g.add(fl);
      const flGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0xffd27a, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity: 0.55,
      }));
      flGlow.scale.setScalar(0.32); flGlow.position.copy(fl.position); g.add(flGlow);
      lastFlame = fl; lastGlow = flGlow;
    }
    if (torchPositions) torchPositions.push({ x: px, y: 1.5, z: pz, flame: lastFlame, glow: lastGlow });
  } else if (kind === 'sarcophagus') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 1.9), std(C.STONE)); base.position.y = 0.25; g.add(base);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.16, 2.0), std(0x6b6474)); lid.position.y = 0.56; lid.rotation.y = 0.04; g.add(lid);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), new THREE.MeshStandardMaterial({ color: C.accent.clone().multiplyScalar(0.5), roughness: 1 })); face.rotation.x = -Math.PI / 2; face.position.set(0, 0.65, -0.5); g.add(face);
  } else if (kind === 'thicket') {
    // A small clump of rocks tucked against the wall (the old glowing
    // toadstool prop — an orange cap on curved stems that read as a stray
    // mushroom/spider — is gone). Procedural pebbles are the fallback; the
    // modeled CC0 rock swaps in once its GLB loads, same pattern as the
    // town's meadow rocks.
    const rockMat = std(0x5e5a52);
    const fallback = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const s = 0.14 + Math.random() * 0.12;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
      rock.position.set((Math.random() - 0.5) * 0.5, s * 0.5, (Math.random() - 0.5) * 0.5);
      rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      fallback.add(rock);
    }
    g.add(fallback);
    swapInModel(g, fallback, ['rockA', 'rockB'], ([a, b]) => {
      const tpl = a || b;
      return tpl ? buildModelMesh(tpl, 0.42 + Math.random() * 0.18) : null;
    });
  }
  return g;
}

// ---------------- World beyond the town walls ----------------
function buildTownSurroundings(group, dungeon, smokePuffs) {
  const GRID = dungeon.size || 30;
  const c = tileToWorld(Math.floor(GRID / 2), Math.floor(GRID / 2));
  const cx = c.x, cz = c.z, extent = GRID * TILE;
  // ground stretching to a fogged horizon so the world doesn't just end
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 4, extent * 4),
    new THREE.MeshStandardMaterial({ color: 0x2b3620, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.08, cz); group.add(ground);

  // forest ring outside the walls: the procedural trunk+cone pair goes up
  // first (and stays as the fallback), recording every placement so the
  // modeled trees can swap in as instanced sets at the exact same spots.
  // Mostly pines with a scattering of leafy trees for a natural treeline.
  const R0 = extent * 0.52, R1 = R0 + 34, N = 140;
  const ringT = [];
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1, flatShading: true }), N);
  const foliage = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 3.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x24401e, roughness: 1, flatShading: true }), N);
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.random() * 0.4;
    const r = R0 + Math.random() * (R1 - R0);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, sc = 0.8 + Math.random() * 1.0;
    const ry = Math.random() * Math.PI;
    ringT.push({ x, z, sc, ry });
    sv.set(sc, sc, sc); q.setFromEuler(new THREE.Euler(0, ry, 0));
    mm.compose(pv.set(x, 1.2 * sc, z), q, sv); trunks.setMatrixAt(i, mm);
    mm.compose(pv.set(x, 4.0 * sc, z), q, sv); foliage.setMatrixAt(i, mm);
  }
  trunks.instanceMatrix.needsUpdate = true; foliage.instanceMatrix.needsUpdate = true;
  const proceduralRing = new THREE.Group();
  proceduralRing.add(trunks, foliage);
  group.add(proceduralRing);
  swapInModel(group, proceduralRing, ['pine', 'treeBirch', 'treeOak'], (tpls) => {
    const pineTpl = tpls[0];
    const broad = tpls.slice(1).filter(Boolean);
    if (!pineTpl && !broad.length) return null;
    const g = new THREE.Group();
    const pines = [];
    const leafy = broad.map(() => []);
    ringT.forEach((t, i) => {
      const wantPine = !broad.length || (pineTpl && i % 10 < 7);
      if (wantPine) pines.push({ x: t.x, z: t.z, ry: t.ry, s: 5.7 * t.sc });
      else leafy[i % broad.length].push({ x: t.x, z: t.z, ry: t.ry, s: 4.8 * t.sc });
    });
    if (pineTpl && pines.length) g.add(buildModelInstances(pineTpl, pines));
    broad.forEach((tpl, k) => { if (leafy[k].length) g.add(buildModelInstances(tpl, leafy[k])); });
    return g.children.length ? g : null;
  });

  // meadow dressing between the wall and the treeline: seeded grass tufts and
  // a few rocks (modeled only, additive; nothing appears if the GLBs fail)
  const meadowRng = worldRng(0x7c31e5);
  const meadowGrass = [[], []];
  for (let i = 0; i < 170; i++) {
    const a = meadowRng() * Math.PI * 2;
    const r = extent * 0.51 + meadowRng() * extent * 0.13;
    meadowGrass[meadowRng() < 0.5 ? 0 : 1].push({
      x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
      ry: meadowRng() * Math.PI * 2, s: 0.25 + meadowRng() * 0.3,
    });
  }
  const meadowRocks = [[], []];
  for (let i = 0; i < 22; i++) {
    const a = meadowRng() * Math.PI * 2;
    const r = extent * 0.51 + meadowRng() * extent * 0.14;
    meadowRocks[meadowRng() < 0.7 ? 0 : 1].push({
      x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
      ry: meadowRng() * Math.PI * 2, s: 0.25 + meadowRng() * 0.55,
    });
  }
  swapInModel(group, null, ['grassA', 'grassB', 'rockA', 'rockB'], (tpls) => {
    const g = new THREE.Group();
    meadowGrass.forEach((set, k) => {
      const tpl = tpls[k] || tpls[1 - k];
      if (tpl && set.length) g.add(buildModelInstances(tpl, set));
    });
    meadowRocks.forEach((set, k) => {
      const tpl = tpls[2 + k] || tpls[3 - k];
      if (tpl && set.length) g.add(buildModelInstances(tpl, set));
    });
    return g.children.length ? g : null;
  });

  // (The old lone "forest critter" that ambled a circle here is gone: it was a
  // rigid box deer with no walk animation, read as a floating dog and had no
  // modeled/animated replacement available locally, so it was cut outright.)
}
