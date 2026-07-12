// Quaternius modular-character NPCs (Obsidian 789/808/760).
//
// The tavern's distinct human NPCs (starting with Rosalind, 808) use the
// web-optimised Quaternius "Modular Character Outfits" models vendored under
// public/models/quaternius/ - a real female-bodied mesh, not the squished-male
// silhouette of the shared KayKit rig. The pack ships a T-pose with NO baked
// animations, so we pose the arms down to a natural rest and let the caller add
// a gentle idle; the exact arm rotations below were dialled in on-screen.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const MODEL_URL = { femalePeasant: 'models/quaternius/Female_Peasant.gltf' };

// Loads a FRESH instance each call. SkeletonUtils.clone left the posed bones
// un-bound to the skinned mesh here (the clone rendered in T-pose even with the
// arm rotations set), so we parse a fresh scene per NPC instead - cheap enough
// for the tavern's handful of distinct NPCs, and the pose then drives the mesh.
function loadFresh(key) {
  const url = (import.meta.env.BASE_URL || '/') + MODEL_URL[key];
  return new Promise((resolve) => {
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, () => resolve(null));
  });
}

// Resolve to a posed, scaled Quaternius character, or null if it isn't available
// (the caller keeps its procedural fallback). targetHeight is the desired world
// height (KayKit heroes are ~1.6).
export async function buildQuaterniusFemale(key = 'femalePeasant', targetHeight = 1.6) {
  const model = await loadFresh(key);
  if (!model) return null;
  const bones = {};
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  // Arms down from the T-pose to a natural rest (verified on-screen).
  if (bones.upperarm_l) bones.upperarm_l.rotation.z = 1.35;
  if (bones.upperarm_r) bones.upperarm_r.rotation.z = -1.35;
  if (bones.lowerarm_l) bones.lowerarm_l.rotation.z = 0.2;
  if (bones.lowerarm_r) bones.lowerarm_r.rotation.z = -0.2;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
  // Uniform scale to the target height.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  model.scale.setScalar(targetHeight / (size.y || 1.5));
  model.userData.quaternius = true;

  // Gentle procedural IDLE (the pack has no baked anims): sway the spine/neck a
  // few degrees around their rest pose so she breathes and shifts weight instead
  // of standing like a statue. Caller ticks model.userData.idle(elapsedSeconds).
  const idle = [];
  for (const [b, ax, amp, freq, ph] of [
    [bones.spine_02, 'x', 0.028, 1.1, 0],   // slow breathing lean
    [bones.spine_03, 'z', 0.03, 0.65, 0.5], // subtle side-to-side weight shift
    [bones.neck_01, 'z', 0.022, 0.65, 1.1], // head follows the sway a touch
    [bones.upperarm_l, 'z', 0.02, 0.9, 0.3],
    [bones.upperarm_r, 'z', 0.02, 0.9, 1.7],
  ]) {
    if (b) idle.push({ b, ax, base: b.rotation[ax], amp, freq, ph });
  }
  model.userData.idle = (t) => { for (const it of idle) it.b.rotation[it.ax] = it.base + Math.sin(t * it.freq + it.ph) * it.amp; };
  return model;
}
