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

const CLIP_PATTERNS = {
  idle: [/^idle$/i, /idle_?a/i, /idle/i],
  run: [/^running_a$/i, /run/i, /walk/i],
  attackKnight: [/1h_melee_attack_slice_diagonal/i, /melee_attack_slice/i, /melee_attack_chop/i, /melee_attack/i, /attack/i],
  attackMage: [/spellcast_shoot/i, /spellcast/i, /cast/i, /attack/i],
  attackRanger: [/1h_ranged_shoot/i, /2h_ranged_shoot/i, /ranged_shoot/i, /shoot/i, /attack/i],
  death: [/death_a$/i, /death/i],
};

// Returns { mesh, mixer, actions, playing } or null if the model isn't loaded.
export function buildAnimatedHero(classId) {
  const data = loaded.get(classId);
  if (!data) return null;

  const mesh = skeletonClone(data.scene);
  mesh.scale.setScalar(data.scale);
  mesh.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
  });

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
  for (const [name, clip] of Object.entries(clips)) {
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (name === 'attack' || name === 'death') {
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    }
    actions[name] = action;
  }
  if (actions.idle) actions.idle.play();

  return {
    mesh,
    mixer,
    actions,
    current: 'idle',
    // Crossfade helper driven from Player.update
    setLocomotion(moving) {
      const want = moving ? 'run' : 'idle';
      if (want === this.current || !this.actions[want]) return;
      const from = this.actions[this.current];
      const to = this.actions[want];
      to.reset().play();
      if (from) from.crossFadeTo(to, 0.18, false);
      this.current = want;
    },
    playAttack() {
      const a = this.actions.attack;
      if (!a) return;
      a.reset();
      a.setEffectiveTimeScale(1.8);
      a.setEffectiveWeight(1);
      a.play();
    },
    playDeath() {
      const d = this.actions.death;
      if (!d) return;
      d.reset().play();
    },
  };
}
