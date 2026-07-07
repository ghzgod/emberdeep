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

function applyCosmetics(mesh, name) {
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
  }
  if (trimMesh && rng() < 0.7) {
    trimMesh.material = trimMesh.material.clone();
    jitterColor(trimMesh.material, rng, 0.16);
  }
  if (headMesh && rng() < 0.6) {
    headMesh.material = headMesh.material.clone();
    jitterColor(headMesh.material, rng, 0.08);
  }
  if (headMesh && rng() < 0.5) {
    headMesh.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    headMesh.geometry.boundingBox.getSize(size);
    const center = new THREE.Vector3();
    headMesh.geometry.boundingBox.getCenter(center);
    const scar = new THREE.Mesh(
      new THREE.BoxGeometry(size.x * 0.35, size.y * 0.06, size.z * 0.08),
      new THREE.MeshStandardMaterial({ color: 0x3a1c18, roughness: 0.9 })
    );
    scar.position.set(center.x + size.x * 0.18, center.y, center.z + size.z * 0.4);
    scar.rotation.z = 0.5;
    headMesh.add(scar);
  }
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
// `name` seeds the small deterministic cosmetic variations (see applyCosmetics
// above) so the same hero name always looks the same, for the local player
// and for every peer who sees them in co-op.
export function buildAnimatedHero(classId, name = '') {
  const data = loaded.get(classId);
  if (!data) return null;

  const mesh = skeletonClone(data.scene);
  mesh.scale.setScalar(data.scale);
  mesh.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
      // Headgear is gear-driven: hide the model's baked-on hat/helmet so an
      // equipped helmet is the ONLY hat, and taking it off leaves a bare head.
      // (The rogue's hood is fused into its head mesh, so it stays.)
      if (/_(Hat|Helmet)$/.test(o.name)) o.visible = false;
    }
  });
  applyCosmetics(mesh, name);

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
  if (actions.idle) actions.idle.play();

  return {
    mesh,
    mixer,
    actions,
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
