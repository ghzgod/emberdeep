import * as THREE from 'three';
import { audio } from '../core/audio.js';

// Pooled projectiles for player bolts/arrows and enemy shots.
const POOL_SIZE = 80;

export class ProjectileSystem {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const arrowGeo = new THREE.ConeGeometry(0.5, 2.4, 6);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(geo, mat);
      const arrowMesh = new THREE.Mesh(arrowGeo, mat);
      mesh.visible = false;
      arrowMesh.visible = false;
      scene.add(mesh);
      scene.add(arrowMesh);
      this.pool.push({ mesh, arrowMesh, live: false });
    }
  }

  spawn(opts) {
    const p = this.pool.find((x) => !x.live);
    if (!p) return;
    p.live = true;
    p.x = opts.x; p.z = opts.z;
    p.dirX = opts.dir.x; p.dirZ = opts.dir.z;
    p.speed = opts.speed;
    p.radius = opts.radius ?? 0.3;
    p.damage = opts.damage;
    p.friendly = opts.friendly;
    p.aoe = opts.aoe || 0;
    p.status = opts.status || null;
    p.hitSound = opts.hitSound || null;
    p.trail = opts.trail || null;
    p.life = opts.life ?? 2.5;
    p.arrow = !!opts.arrow;

    const size = opts.size ?? 0.2;
    const m = p.arrow ? p.arrowMesh : p.mesh;
    m.visible = true;
    m.scale.setScalar(size);
    m.material.color.setHex(opts.color ?? 0xffffff);
    m.position.set(p.x, 0.9, p.z);
    if (p.arrow) {
      m.rotation.z = -Math.PI / 2;
      m.rotation.y = -Math.atan2(p.dirZ, p.dirX);
      m.rotation.order = 'YZX';
    }
    this.active.push(p);
  }

  update(dt, game) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.x += p.dirX * p.speed * dt;
      p.z += p.dirZ * p.speed * dt;
      p.life -= dt;

      const m = p.arrow ? p.arrowMesh : p.mesh;
      m.position.set(p.x, 0.9, p.z);
      if (p.trail && Math.random() < 0.5) {
        game.particles.burst(p.x, 0.9, p.z, 1, p.trail, { speed: 0.6, life: 0.3, size: 0.08 });
      }

      let hit = false;

      // wall collision
      if (!game.isWalkable(p.x, p.z, 0.1)) hit = true;

      if (!hit && p.friendly) {
        for (const e of game.enemies) {
          if (e.dead) continue;
          const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
          if (d < e.radius + p.radius) {
            hit = true;
            if (p.aoe) {
              game.aoeDamage(p.x, p.z, p.aoe, p.damage, { source: 'player', status: p.status });
              game.particles.burst(p.x, 0.9, p.z, 24, 0xff8a3a, { speed: 5, life: 0.5 });
              game.shake(0.2);
            } else {
              game.damageEnemy(e, p.damage, { status: p.status });
            }
            break;
          }
        }
      } else if (!hit && !p.friendly) {
        const pl = game.player;
        if (!pl.dead) {
          const d = Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z);
          if (d < 0.45 + p.radius) {
            hit = true;
            pl.takeDamage(p.damage, game);
          }
        }
      }

      if (hit || p.life <= 0) {
        if (hit && p.hitSound) audio.play(p.hitSound, { pos: { x: p.x, z: p.z }, volume: 0.8 });
        if (hit && p.aoe && !p.friendly) {
          game.particles.burst(p.x, 0.9, p.z, 18, 0xff6a3a, { speed: 4, life: 0.5 });
        }
        p.live = false;
        m.visible = false;
        this.active.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.active) {
      p.live = false;
      p.mesh.visible = false;
      p.arrowMesh.visible = false;
    }
    this.active.length = 0;
  }
}
