import * as THREE from 'three';

// Lightweight particle bursts + expanding rings, disposed when expired.
export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.systems = [];
    this.rings = [];
    this.ringGeo = new THREE.TorusGeometry(1, 0.05, 6, 32);
  }

  burst(x, y, z, count, color, opts = {}) {
    const speed = opts.speed ?? 3;
    const life = opts.life ?? 0.6;
    const size = opts.size ?? 0.14;
    const positions = new Float32Array(count * 3);
    const velocities = [];
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
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 1, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.systems.push({ points, velocities, life, maxLife: life });
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
    const colors = new Float32Array(count * 3);
    const hot = new THREE.Color(0xfff2a8);
    const mid = new THREE.Color(0xff9a2a);
    const cool = new THREE.Color(0xff3a1a);
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
      const c = Math.random() < 0.4 ? hot : Math.random() < 0.7 ? mid : cool;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: opts.size ?? 0.32, transparent: true, opacity: 1, depthWrite: false,
      vertexColors: true, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.systems.push({ points, velocities, life, maxLife: life, noGravity: true });
  }

  ring(x, y, z, radius, color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.2);
    this.scene.add(mesh);
    this.rings.push({ mesh, targetRadius: radius, life: 0.45, maxLife: 0.45 });
  }

  update(dt) {
    for (let i = this.systems.length - 1; i >= 0; i--) {
      const s = this.systems[i];
      s.life -= dt;
      const pos = s.points.geometry.attributes.position;
      for (let j = 0; j < s.velocities.length; j++) {
        const v = s.velocities[j];
        if (!s.noGravity) v.y -= 6 * dt; // fire breath rises/drifts instead of falling
        pos.array[j * 3] += v.x * dt;
        pos.array[j * 3 + 1] += v.y * dt;
        pos.array[j * 3 + 2] += v.z * dt;
      }
      pos.needsUpdate = true;
      s.points.material.opacity = Math.max(0, s.life / s.maxLife);
      if (s.life <= 0) {
        this.scene.remove(s.points);
        s.points.geometry.dispose();
        s.points.material.dispose();
        this.systems.splice(i, 1);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const t = 1 - r.life / r.maxLife;
      r.mesh.scale.setScalar(Math.max(0.01, r.targetRadius * t));
      r.mesh.material.opacity = 0.8 * (1 - t);
      if (r.life <= 0) {
        this.scene.remove(r.mesh);
        r.mesh.material.dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  clear() {
    for (const s of this.systems) {
      this.scene.remove(s.points);
      s.points.geometry.dispose();
      s.points.material.dispose();
    }
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      r.mesh.material.dispose();
    }
    this.systems.length = 0;
    this.rings.length = 0;
  }
}
