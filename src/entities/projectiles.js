import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { makeGlowTexture } from '../world/textures.js';

// Pooled projectiles for player bolts/arrows and enemy shots. Each projectile
// is a bright core + an additive glow sprite (so it reads as a glowing mote,
// not a flat ball) and leaves a sparkle trail in its own colour.
const POOL_SIZE = 80;

// Lighten a hex colour toward white for the glow halo / default trail, so the
// halo reads as a hotter version of the core rather than the same flat tone.
function lighten(hex, amt = 0.45) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), amt);
  return c.getHex();
}

export class ProjectileSystem {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.glowTex = makeGlowTexture();
    const geo = new THREE.SphereGeometry(1, 10, 8);
    const arrowGeo = new THREE.ConeGeometry(0.5, 2.4, 7);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const arrowMesh = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const mkGlow = () => new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: 0xffffff, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false,
      }));
      const glow = mkGlow();
      const arrowGlow = mkGlow();
      mesh.visible = arrowMesh.visible = glow.visible = arrowGlow.visible = false;
      scene.add(mesh, arrowMesh, glow, arrowGlow);
      this.pool.push({ mesh, arrowMesh, glow, arrowGlow, live: false });
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
    p.life = opts.life ?? 2.5;
    p.arrow = !!opts.arrow;
    p.t = 0;

    const color = opts.color ?? 0xffffff;
    const glowColor = opts.glow ?? lighten(color, 0.5);
    // Sparkle trail defaults to the projectile's own colour so casters/arrows
    // always leave a coloured streak, even if the caller didn't ask for one.
    p.trail = opts.trail ?? color;
    p.trailY = opts.trailY ?? 0.9;

    const size = opts.size ?? 0.2;
    p.size = size;
    const core = p.arrow ? p.arrowMesh : p.mesh;
    const glow = p.arrow ? p.arrowGlow : p.glow;
    p.core = core; p.aglow = glow; // active refs (don't clobber the pool's .glow)
    core.visible = true; glow.visible = true;
    core.scale.setScalar(size);
    core.material.color.setHex(color);
    glow.material.color.setHex(glowColor);
    glow.scale.setScalar(size * (p.arrow ? 2.4 : 3.4));
    glow.material.opacity = 0.9;
    core.position.set(p.x, p.trailY, p.z);
    glow.position.copy(core.position);
    if (p.arrow) {
      core.rotation.z = -Math.PI / 2;
      core.rotation.y = -Math.atan2(p.dirZ, p.dirX);
      core.rotation.order = 'YZX';
    }
    this.active.push(p);
  }

  update(dt, game) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.x += p.dirX * p.speed * dt;
      p.z += p.dirZ * p.speed * dt;
      p.life -= dt;
      p.t += dt;

      const core = p.core, glow = p.aglow;
      core.position.set(p.x, p.trailY, p.z);
      glow.position.copy(core.position);
      // shimmer: the halo pulses so the mote looks like it's burning/charged
      const pulse = 1 + Math.sin(p.t * 30) * 0.14;
      glow.scale.setScalar(p.size * (p.arrow ? 2.4 : 3.4) * pulse);
      glow.material.opacity = 0.7 + Math.sin(p.t * 22) * 0.2;
      // coloured sparkle trail
      if (p.trail && Math.random() < 0.8) {
        game.particles.burst(p.x, p.trailY, p.z, 1, p.trail, { speed: 0.7, life: 0.32, size: 0.07 });
      }

      let hit = false;

      // wall collision — knock chips off the masonry + a coloured spark splash
      if (!game.isWalkable(p.x, p.z, 0.1)) {
        hit = true;
        game.wallDebris(p.x, p.z, { dirX: p.dirX, dirZ: p.dirZ, tint: core.material.color.getHex(), y: p.trailY });
        game.particles.burst(p.x, p.trailY, p.z, 8, lighten(core.material.color.getHex(), 0.3), { speed: 3.2, life: 0.3, size: 0.08 });
      }

      if (!hit && p.friendly) {
        for (const e of game.enemies) {
          if (e.dead) continue;
          const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
          if (d < e.radius + p.radius) {
            hit = true;
            if (p.aoe) {
              game.aoeDamage(p.x, p.z, p.aoe, p.damage, { source: 'player', status: p.status });
              game.particles.burst(p.x, 0.9, p.z, 26, 0xff8a3a, { speed: 5, life: 0.5 });
              game.particles.burst(p.x, 0.9, p.z, 14, lighten(core.material.color.getHex(), 0.5), { speed: 3, life: 0.4, size: 0.1 });
              game.shake(0.2);
            } else {
              game.damageEnemy(e, p.damage, { status: p.status });
              // bright impact burst in the projectile's palette + hot flash
              const c = core.material.color.getHex();
              game.particles.burst(p.x, 0.9, p.z, 10, c, { speed: 3.4, life: 0.3, size: 0.09 });
              game.particles.burst(p.x, 0.9, p.z, 5, lighten(c, 0.6), { speed: 1.6, life: 0.22, size: 0.13 });
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
        core.visible = false;
        glow.visible = false;
        this.active.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.active) {
      p.live = false;
      p.mesh.visible = false;
      p.arrowMesh.visible = false;
      p.glow.visible = false;
      p.arrowGlow.visible = false;
    }
    this.active.length = 0;
  }
}
