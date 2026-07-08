import * as THREE from 'three';
import { makeGlowTexture } from './textures.js';

// Magical sphere portal: a glowing swirling orb (isotropic shader, identical
// from every camera angle since it only reads world-space normal + time, no
// view vector) plus a ring of particles drifting around it on elliptical
// orbits. Replaces the old spinning-ring portal mesh.

// Shared by every portal instance (cheap; avoids a canvas per portal).
let _particleTex = null;
const particleTexture = () => (_particleTex ||= makeGlowTexture());

const VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Layered value-noise (sin lattice) sampled purely by the sphere's own world
// normal + time, so the swirl pattern is baked onto the sphere's surface and
// reads the same no matter where the camera stands. No dot(normal, viewDir)
// anywhere here on purpose.
const FRAGMENT_SHADER = `
  varying vec3 vWorldNormal;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec3(1.0, 0.0, 0.0));
    float c = hash(i + vec3(0.0, 1.0, 0.0));
    float d = hash(i + vec3(1.0, 1.0, 0.0));
    float e = hash(i + vec3(0.0, 0.0, 1.0));
    float g = hash(i + vec3(1.0, 0.0, 1.0));
    float h = hash(i + vec3(0.0, 1.0, 1.0));
    float k = hash(i + vec3(1.0, 1.0, 1.0));
    float x1 = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    float x2 = mix(mix(e, g, f.x), mix(h, k, f.x), f.y);
    return mix(x1, x2, f.z);
  }

  float fbm(vec3 p) {
    float total = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      total += noise(p) * amp;
      p *= 2.02;
      amp *= 0.55;
    }
    return total;
  }

  void main() {
    vec3 n = vWorldNormal;
    // Two swirl layers drifting opposite directions on the sphere's surface.
    vec3 p1 = n * 3.2 + vec3(uTime * 0.25, uTime * -0.18, uTime * 0.12);
    vec3 p2 = n * 5.0 + vec3(uTime * -0.32, uTime * 0.2, uTime * -0.15);
    float swirl = fbm(p1) * 0.6 + fbm(p2) * 0.4;

    vec3 col = mix(uColorA, uColorB, clamp(swirl, 0.0, 1.0));

    // Camera-independent rim band: brighter near the poles of the sphere in
    // world space, based only on vWorldNormal.y (no view vector).
    float band = smoothstep(0.15, 0.95, abs(n.y));
    col += band * uColorB * 0.4;

    float glow = 0.55 + swirl * 0.5;
    gl_FragColor = vec4(col * glow, 0.85);
  }
`;

// Builds one portal Object3D (sphere + orbiting particles). radius controls
// the sphere size; colorA/colorB tint the swirl. Returns { object, update }.
export function buildPortal({ radius = 1.1, colorA = 0x2a0f55, colorB = 0xb35eff, particleCount = 72 } = {}) {
  const object = new THREE.Group();

  const uniforms = {
    uTime: { value: Math.random() * 100 },
    uColorA: { value: new THREE.Color(colorA) },
    uColorB: { value: new THREE.Color(colorB) },
  };

  const sphereGeo = new THREE.SphereGeometry(radius, 32, 24);
  const sphereMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  object.add(sphere);

  // Orbiting particle swarm: each point drifts around the sphere on its own
  // elliptical path with a slight radius jitter, advanced each frame in JS
  // and written back into the position buffer (cheap for this point count).
  const positions = new Float32Array(particleCount * 3);
  const orbits = [];
  for (let i = 0; i < particleCount; i++) {
    const baseR = radius * (1.25 + Math.random() * 0.55);
    orbits.push({
      angle: Math.random() * Math.PI * 2,
      speed: 0.35 + Math.random() * 0.55,
      tilt: Math.random() * Math.PI,
      rx: baseR * (0.85 + Math.random() * 0.3),
      ry: baseR * (0.85 + Math.random() * 0.3),
      rz: baseR * (0.85 + Math.random() * 0.3),
      jitterPhase: Math.random() * Math.PI * 2,
      jitterSpeed: 0.6 + Math.random() * 1.2,
    });
  }

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.14,
    map: particleTexture(),
    color: colorB,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(particleGeo, particleMat);
  points.position.y = radius; // orbit centered on the sphere's middle
  object.add(points);

  function update(dt) {
    uniforms.uTime.value += dt;

    const posAttr = particleGeo.attributes.position;
    for (let i = 0; i < particleCount; i++) {
      const o = orbits[i];
      o.angle += dt * o.speed;
      const jitter = 1 + Math.sin(o.jitterPhase + uniforms.uTime.value * o.jitterSpeed) * 0.12;
      // Elliptical path around the sphere, offset per-particle so the swarm
      // fills a 3D shell rather than a single flat ring.
      posAttr.array[i * 3] = Math.cos(o.angle) * o.rx * jitter;
      posAttr.array[i * 3 + 1] = Math.sin(o.angle * 0.7 + o.tilt) * o.ry * 0.5;
      posAttr.array[i * 3 + 2] = Math.sin(o.angle) * o.rz * jitter;
    }
    posAttr.needsUpdate = true;
  }

  return { object, update };
}
