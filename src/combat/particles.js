import * as THREE from 'three';

// Lightweight particle bursts + expanding rings, disposed when expired.
// Visuals are small low-poly shards (tetrahedra/octahedra) rendered via one
// InstancedMesh per burst/stream/ring-spike-set, so each call is still a
// single draw call (same cost class as the old Points-based version) while
// reading as stylized 3D motes instead of flat point sprites. All geometry is
// module-level and shared - only materials (colour varies per call) and the
// small per-call instance-matrix buffer are created per burst.
const SHARD_GEO = new THREE.OctahedronGeometry(0.5, 0);
const SPIKE_GEO = new THREE.TetrahedronGeometry(0.4, 0);
const RING_GEO = new THREE.TorusGeometry(1, 0.09, 4, 12); // low-poly facets, not a smooth torus
const _dummy = new THREE.Object3D();

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.systems = [];
    this.rings = [];
  }

  burst(x, y, z, count, color, opts = {}) {
    const speed = opts.speed ?? 3;
    const life = opts.life ?? 0.6;
    const size = opts.size ?? 0.14;
    const positions = new Float32Array(count * 3);
    const velocities = [];
    const rotSpeeds = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      velocities.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * s,
        Math.abs(Math.cos(phi)) * s * (opts.up ?? 0.8),
        Math.sin(phi) * Math.sin(theta) * s
      ));
      rotSpeeds.push(new THREE.Vector3(
        (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12
      ));
    }
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.7, flatShading: true,
      transparent: true, opacity: 1, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(SHARD_GEO, mat, count);
    mesh.frustumCulled = false;
    const scale = size / 0.5; // SHARD_GEO's base radius is 0.5
    for (let i = 0; i < count; i++) {
      _dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      _dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this.systems.push({ mesh, positions, velocities, rotSpeeds, scale, life, maxLife: life });
  }

  // Gore burst (Obsidian 757): wet blood spray + chunky tumbling gib bits.
  // Unlike burst(), this is NON-emissive (blood is wet meat, not glowing
  // magic), mixes droplet and chunk sizes, and falls hard (gravity ~1.6x) so
  // the bits arc out and hit the floor. Two colors: a bright arterial spray
  // and darker meat chunks. One InstancedMesh, so one draw call.
  gore(x, y, z, opts = {}) {
    const count = opts.count ?? 26;
    const speed = opts.speed ?? 5;
    const life = opts.life ?? 0.8;
    const spray = new THREE.Color(opts.spray ?? 0xd42020);   // bright arterial red
    const chunk = new THREE.Color(opts.chunk ?? 0x8a1010);   // dark meat
    const positions = new Float32Array(count * 3);
    const velocities = [];
    const rotSpeeds = [];
    const scales = [];
    const colorArr = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.35 + Math.random() * 0.7);
      velocities.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * s,
        Math.abs(Math.cos(phi)) * s * (opts.up ?? 1.0) + 1.2, // pop up then arc down
        Math.sin(phi) * Math.sin(theta) * s
      ));
      rotSpeeds.push(new THREE.Vector3(
        (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14
      ));
      // ~1/3 are big meat chunks, the rest fine spray droplets
      const isChunk = Math.random() < 0.34;
      scales.push((isChunk ? 0.14 + Math.random() * 0.12 : 0.05 + Math.random() * 0.05) / 0.5);
      colorArr.push(isChunk ? chunk : spray);
    }
    // slight self-illumination so blood reads as vivid red even in the dim
    // dungeon (real MeshStandard bits go muddy-dark under low light); per
    // profile so bone/stone don't glow red (passed in by the caller)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.5, metalness: 0.0, flatShading: true,
      transparent: true, opacity: 1, depthWrite: false, vertexColors: true,
      emissive: opts.emissive ?? 0x330000, emissiveIntensity: opts.emissiveIntensity ?? 0.5,
    });
    const mesh = new THREE.InstancedMesh(SHARD_GEO, mat, count);
    mesh.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      _dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      _dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      _dummy.scale.setScalar(scales[i]);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      mesh.setColorAt(i, colorArr[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    // per-instance scales so the update loop keeps each bit's own size
    this.systems.push({ mesh, positions, velocities, rotSpeeds, scale: 1, perScale: scales, life, maxLife: life, gravity: 10 });
  }

  // Directional cone stream (the Dungeon Lord's fire breath): particles spawn
  // along a forward-biased cone from (x,y,z) toward dir, warm-colored and
  // additive-blended so overlapping flame reads bright/hot rather than muddy.
  // Reuses the same per-particle velocity/gravity/fade update loop as burst()
  // (they're pushed into the same this.systems list); only the initial spawn
  // shape differs, so no new update path is needed.
  breath(x, y, z, dirX, dirZ, opts = {}) {
    const count = opts.count ?? 40;
    const range = opts.range ?? 8;
    const spread = opts.spread ?? 0.35; // radians half-angle of the cone
    const speed = opts.speed ?? 9;
    const life = opts.life ?? 0.55;
    const dlen = Math.hypot(dirX, dirZ) || 1;
    dirX /= dlen; dirZ /= dlen;
    const positions = new Float32Array(count * 3);
    const velocities = [];
    const rotSpeeds = [];
    const hot = new THREE.Color(0xfff2a8);
    const mid = new THREE.Color(0xff9a2a);
    const cool = new THREE.Color(0xff3a1a);
    const colorArr = [];
    for (let i = 0; i < count; i++) {
      // stagger spawn along the cone's length so it reads as a continuous
      // stream rather than one puff, biased toward the origin (denser near
      // the mouth, thinner further out, like a real flame jet)
      const t = Math.pow(Math.random(), 1.6);
      const dist = t * range * 0.3;
      const ang = (Math.random() - 0.5) * spread * 2;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const px = dirX * cos - dirZ * sin;
      const pz = dirX * sin + dirZ * cos;
      positions[i * 3] = x + px * dist;
      positions[i * 3 + 1] = y + (Math.random() - 0.3) * 0.3;
      positions[i * 3 + 2] = z + pz * dist;
      const s = speed * (0.6 + Math.random() * 0.7);
      velocities.push(new THREE.Vector3(px * s, (Math.random() - 0.3) * 1.2, pz * s));
      rotSpeeds.push(new THREE.Vector3(
        (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16
      ));
      colorArr.push(Math.random() < 0.4 ? hot : Math.random() < 0.7 ? mid : cool);
    }
    const size = opts.size ?? 0.32;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xff8a2a, emissiveIntensity: 1,
      flatShading: true, transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true,
    });
    const mesh = new THREE.InstancedMesh(SPIKE_GEO, mat, count);
    mesh.frustumCulled = false;
    const scale = size / 0.4; // SPIKE_GEO's base radius is 0.4
    for (let i = 0; i < count; i++) {
      _dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      _dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      mesh.setColorAt(i, colorArr[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.systems.push({ mesh, positions, velocities, rotSpeeds, scale, life, maxLife: life, noGravity: true });
  }

  ring(x, y, z, radius, color) {
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.6, flatShading: true,
      transparent: true, opacity: 0.85, depthWrite: false,
    });
    const mesh = new THREE.Mesh(RING_GEO, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.2);
    this.scene.add(mesh);

    // A handful of crystal spikes riding the ring's rim, so it reads as a
    // shattering crystalline shockwave rather than a plain faceted band.
    const spikeCount = 10;
    const spikeMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.9, flatShading: true,
      transparent: true, opacity: 0.9, depthWrite: false,
    });
    const spikes = new THREE.InstancedMesh(SPIKE_GEO, spikeMat, spikeCount);
    spikes.frustumCulled = false;
    for (let i = 0; i < spikeCount; i++) {
      const a = (i / spikeCount) * Math.PI * 2;
      _dummy.position.set(Math.cos(a), 0, Math.sin(a));
      _dummy.rotation.set(Math.random() * Math.PI, a, Math.random() * Math.PI);
      _dummy.scale.setScalar(0.3);
      _dummy.updateMatrix();
      spikes.setMatrixAt(i, _dummy.matrix);
    }
    spikes.instanceMatrix.needsUpdate = true;
    spikes.rotation.x = Math.PI / 2;
    spikes.position.set(x, y, z);
    spikes.scale.setScalar(0.2);
    this.scene.add(spikes);

    this.rings.push({ mesh, spikes, spikeCount, targetRadius: radius, life: 0.45, maxLife: 0.45 });
  }

  update(dt) {
    for (let i = this.systems.length - 1; i >= 0; i--) {
      const s = this.systems[i];
      s.life -= dt;
      const pos = s.positions;
      const grav = s.gravity ?? 6;
      for (let j = 0; j < s.velocities.length; j++) {
        const v = s.velocities[j];
        if (!s.noGravity) v.y -= grav * dt; // fire breath rises/drifts instead of falling
        pos[j * 3] += v.x * dt;
        pos[j * 3 + 1] += v.y * dt;
        pos[j * 3 + 2] += v.z * dt;
        // gore bits settle onto the floor instead of sinking through it
        if (s.perScale && pos[j * 3 + 1] < 0.04) { pos[j * 3 + 1] = 0.04; v.set(0, 0, 0); }
        const rv = s.rotSpeeds[j];
        _dummy.position.set(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
        _dummy.rotation.set(rv.x * s.life, rv.y * s.life, rv.z * s.life);
        _dummy.scale.setScalar(s.perScale ? s.perScale[j] : s.scale);
        _dummy.updateMatrix();
        s.mesh.setMatrixAt(j, _dummy.matrix);
      }
      s.mesh.instanceMatrix.needsUpdate = true;
      s.mesh.material.opacity = Math.max(0, s.life / s.maxLife);
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
        this.systems.splice(i, 1);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const t = 1 - r.life / r.maxLife;
      const scale = Math.max(0.01, r.targetRadius * t);
      r.mesh.scale.setScalar(scale);
      r.mesh.material.opacity = 0.85 * (1 - t);
      r.spikes.scale.setScalar(scale);
      r.spikes.material.opacity = 0.9 * (1 - t);
      if (r.life <= 0) {
        this.scene.remove(r.mesh);
        this.scene.remove(r.spikes);
        r.mesh.material.dispose();
        r.spikes.material.dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  clear() {
    for (const s of this.systems) {
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
    }
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      this.scene.remove(r.spikes);
      r.mesh.material.dispose();
      r.spikes.material.dispose();
    }
    this.systems.length = 0;
    this.rings.length = 0;
  }
}
