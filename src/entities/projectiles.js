import * as THREE from 'three';
import { audio } from '../core/audio.js';
import { makeGlowTexture } from '../world/textures.js';

// Pooled projectiles for player bolts/arrows and enemy shots. Each projectile
// is a small low-poly 3D core (styled to match the modeled-asset world)
// wrapped in an additive glow sprite, plus a coloured sparkle trail. Three
// core "kinds" share one pool slot each and are toggled visible/invisible
// per-spawn instead of allocating new meshes per shot:
//   - "shard": a spinning low-poly crystal (default - magic bolts, enemy bolts)
//   - "fireball": a faceted flickering orb with a shrinking-tetrahedra flame trail
//   - "arrow": a low-poly shaft + head + fletching group (ranger shots)
const POOL_SIZE = 80;
const FLAME_POOL_SIZE = 28;

// Module-level geometry caches - created once, shared by every pool slot and
// every ProjectileSystem instance. Never allocated per-shot.
const SHARD_GEO = new THREE.OctahedronGeometry(1, 0);
const FIREBALL_GEO = new THREE.IcosahedronGeometry(1, 0);
const FLAME_GEO = new THREE.TetrahedronGeometry(1, 0);
const ARROW_SHAFT_GEO = new THREE.CylinderGeometry(0.045, 0.06, 1, 5);
const ARROW_HEAD_GEO = new THREE.ConeGeometry(0.12, 0.32, 5);
const ARROW_FLETCH_GEO = new THREE.ConeGeometry(0.1, 0.26, 3);

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

    for (let i = 0; i < POOL_SIZE; i++) {
      // crystal shard core (default: magic bolts, enemy bolts)
      const shard = new THREE.Mesh(SHARD_GEO, new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.7,
        flatShading: true, roughness: 0.35, metalness: 0.1,
      }));
      // faceted fireball core (fireball-style: any friendly shot with an aoe)
      const fireball = new THREE.Mesh(FIREBALL_GEO, new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.1,
        flatShading: true, roughness: 0.5, metalness: 0,
      }));
      // arrow: shaft + head + fletching, one shared material so setting the
      // colour once tints the whole arrow
      const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, flatShading: true });
      const shaft = new THREE.Mesh(ARROW_SHAFT_GEO, arrowMat);
      const head = new THREE.Mesh(ARROW_HEAD_GEO, arrowMat);
      const fletch = new THREE.Mesh(ARROW_FLETCH_GEO, arrowMat);
      shaft.rotation.z = Math.PI / 2;
      head.rotation.z = Math.PI / 2;
      head.position.x = 0.65;
      fletch.rotation.z = -Math.PI / 2;
      fletch.scale.set(1, 1, 0.35);
      fletch.position.x = -0.6;
      const arrowGroup = new THREE.Group();
      arrowGroup.add(shaft, head, fletch);

      const mkGlow = () => new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: 0xffffff, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false,
      }));
      const glow = mkGlow();
      const arrowGlow = mkGlow();
      shard.visible = fireball.visible = arrowGroup.visible = glow.visible = arrowGlow.visible = false;
      scene.add(shard, fireball, arrowGroup, glow, arrowGlow);
      this.pool.push({ shard, fireball, arrowGroup, arrowMat, glow, arrowGlow, live: false });
    }

    // Shared flame-trail pool (fireball's shrinking tetrahedra). Fixed-size
    // ring buffer reused by every active fireball, so trailing never
    // allocates new geometry/meshes at runtime.
    this.flamePool = [];
    for (let i = 0; i < FLAME_POOL_SIZE; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xff6a2a, emissive: 0xff6a2a, emissiveIntensity: 1,
        flatShading: true, transparent: true, opacity: 0, depthWrite: false,
      });
      const mesh = new THREE.Mesh(FLAME_GEO, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.flamePool.push({ mesh, life: 0, maxLife: 0.28 });
    }
    this.flameCursor = 0;
  }

  spawnFlame(x, y, z, color) {
    this.flameCursor = (this.flameCursor + 1) % FLAME_POOL_SIZE;
    const f = this.flamePool[this.flameCursor];
    f.mesh.visible = true;
    f.mesh.position.set(x + (Math.random() - 0.5) * 0.15, y + (Math.random() - 0.5) * 0.15, z + (Math.random() - 0.5) * 0.15);
    f.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    f.mesh.material.color.setHex(color);
    f.mesh.material.emissive.setHex(color);
    f.mesh.material.opacity = 0.85;
    f.life = f.maxLife = 0.24 + Math.random() * 0.1;
    f.mesh.scale.setScalar(0.24);
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
    // Fireball-style core: faceted flickering orb + flame trail. Triggered by
    // aoe (only the mage's Fireball spawns with one), never overridden by an
    // explicit option so callers don't need to change.
    p.kind = p.arrow ? 'arrow' : (p.aoe > 0 ? 'fireball' : 'shard');
    p.t = 0;
    p.flameTimer = 0;
    p.spin = 3 + Math.random() * 2;

    const color = opts.color ?? 0xffffff;
    const glowColor = opts.glow ?? lighten(color, 0.5);
    // Sparkle trail defaults to the projectile's own colour so casters/arrows
    // always leave a coloured streak, even if the caller didn't ask for one.
    p.trail = opts.trail ?? color;
    p.trailY = opts.trailY ?? 0.9;

    const size = opts.size ?? 0.2;
    p.size = size;

    p.shard.visible = false; p.fireball.visible = false; p.arrowGroup.visible = false;
    const core = p.kind === 'arrow' ? p.arrowGroup : (p.kind === 'fireball' ? p.fireball : p.shard);
    const glow = p.arrow ? p.arrowGlow : p.glow;
    p.core = core; p.aglow = glow; // active refs (don't clobber the pool's .glow)
    core.visible = true; glow.visible = true;

    if (p.kind === 'arrow') {
      core.scale.setScalar(size * 4.5);
      p.arrowMat.color.setHex(color);
    } else if (p.kind === 'fireball') {
      core.scale.setScalar(size);
      core.material.color.setHex(color);
      core.material.emissive.setHex(color);
      core.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    } else {
      // crystal shard: elongated octahedron reads as a faceted spike
      core.scale.set(size * 0.65, size * 1.7, size * 0.65);
      core.material.color.setHex(color);
      core.material.emissive.setHex(color);
      core.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    }

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
    // shrinking flame trail (fireball only)
    for (let i = 0; i < FLAME_POOL_SIZE; i++) {
      const f = this.flamePool[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = Math.max(0, f.life / f.maxLife);
      f.mesh.scale.setScalar(0.24 * t);
      f.mesh.material.opacity = 0.85 * t;
      if (f.life <= 0) f.mesh.visible = false;
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.x += p.dirX * p.speed * dt;
      p.z += p.dirZ * p.speed * dt;
      p.life -= dt;
      p.t += dt;

      const core = p.core, glow = p.aglow;
      core.position.set(p.x, p.trailY, p.z);
      glow.position.copy(core.position);
      if (p.kind === 'shard') {
        core.rotation.x += dt * p.spin;
        core.rotation.y += dt * p.spin * 1.6;
      } else if (p.kind === 'fireball') {
        core.rotation.y += dt * 3;
        core.rotation.x += dt * 1.4;
        // flicker: emissive intensity pulses so the faceted orb reads as burning
        core.material.emissiveIntensity = 0.9 + Math.sin(p.t * 26) * 0.35 + Math.random() * 0.12;
        p.flameTimer -= dt;
        if (p.flameTimer <= 0) {
          p.flameTimer = 0.045;
          this.spawnFlame(p.x, p.trailY, p.z, core.material.color.getHex());
        }
      }
      // shimmer: the halo pulses so the mote looks like it's burning/charged
      const pulse = 1 + Math.sin(p.t * 30) * 0.14;
      glow.scale.setScalar(p.size * (p.arrow ? 2.4 : 3.4) * pulse);
      glow.material.opacity = 0.7 + Math.sin(p.t * 22) * 0.2;
      // coloured sparkle trail
      if (p.trail && Math.random() < 0.8) {
        game.particles.burst(p.x, p.trailY, p.z, 1, p.trail, { speed: 0.7, life: 0.32, size: 0.07 });
      }

      let hit = false;
      const coreColor = p.arrow ? p.arrowMat.color.getHex() : core.material.color.getHex();

      // wall collision — knock chips off the masonry + a coloured spark splash
      if (!game.isWalkable(p.x, p.z, 0.1)) {
        hit = true;
        game.wallDebris(p.x, p.z, { dirX: p.dirX, dirZ: p.dirZ, tint: coreColor, y: p.trailY });
        game.particles.burst(p.x, p.trailY, p.z, 8, lighten(coreColor, 0.3), { speed: 3.2, life: 0.3, size: 0.08 });
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
              game.particles.burst(p.x, 0.9, p.z, 14, lighten(coreColor, 0.5), { speed: 3, life: 0.4, size: 0.1 });
              game.shake(0.2);
            } else {
              game.damageEnemy(e, p.damage, { status: p.status });
              // bright impact burst in the projectile's palette + hot flash
              game.particles.burst(p.x, 0.9, p.z, 10, coreColor, { speed: 3.4, life: 0.3, size: 0.09 });
              game.particles.burst(p.x, 0.9, p.z, 5, lighten(coreColor, 0.6), { speed: 1.6, life: 0.22, size: 0.13 });
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
      p.shard.visible = false;
      p.fireball.visible = false;
      p.arrowGroup.visible = false;
      p.glow.visible = false;
      p.arrowGlow.visible = false;
    }
    this.active.length = 0;
    for (const f of this.flamePool) {
      f.life = 0;
      f.mesh.visible = false;
    }
  }
}
