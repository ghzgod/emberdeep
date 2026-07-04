import * as THREE from 'three';
import { Input } from './core/input.js';
import { SaveManager } from './core/save.js';
import { audio } from './core/audio.js';
import { generateDungeon, FLOOR, WALL, DOOR } from './world/dungeon.js';
import { buildDungeonMeshes, TILE, tileToWorld } from './world/meshbuilder.js';
import { themeForFloor } from './world/textures.js';
import { Player, xpForLevel } from './entities/player.js';
import { Enemy, Boss } from './entities/enemies.js';
import { ProjectileSystem } from './entities/projectiles.js';
import { LootSystem, generateGear, rollRarity } from './entities/loot.js';
import { ParticleSystem } from './combat/particles.js';
import { UI } from './ui/ui.js';
import { learner } from './ai/learner.js';
import { TouchControls } from './core/touch.js';

const MAX_FLOOR = 10;

export class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08060c);
    this.scene.fog = new THREE.Fog(0x08060c, 18, 42);

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    this.cameraOffset = new THREE.Vector3(0, 11, 9.5);

    // lights
    this.ambient = new THREE.AmbientLight(0x8a7a9a, 0.55);
    this.scene.add(this.ambient);
    this.playerLight = new THREE.PointLight(0xffd8a0, 40, 14, 1.8);
    this.scene.add(this.playerLight);
    this.torchLights = [];

    this.input = new Input(this.canvas);
    this.settings = Object.assign(
      { masterVolume: 0.8, musicVolume: 0.6, sfxVolume: 0.9, quality: 'medium', screenShake: true },
      SaveManager.loadSettings() || {}
    );
    audio.volumes = {
      master: this.settings.masterVolume,
      music: this.settings.musicVolume,
      sfx: this.settings.sfxVolume,
    };

    this.playerModule = { xpForLevel };
    this.particles = new ParticleSystem(this.scene);
    this.projectiles = new ProjectileSystem(this.scene);
    this.loot = new LootSystem(this.scene);
    this.ui = new UI(this);
    this.touch = new TouchControls(this);

    this.state = 'loading';
    this.player = null;
    this.enemies = [];
    this.boss = null;
    this.zones = [];
    this.traps = [];
    this.dungeon = null;
    this.dungeonMeshes = null;
    this.floor = 1;
    this.kills = 0;
    this.deaths = 0;
    this.bossDefeated = false;
    this.shakeAmount = 0;
    this.saveTimer = 0;
    this.savePending = false;
    this.stairsCooldown = 0;

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._mouseNdc = new THREE.Vector2();
    this._aimTarget = new THREE.Vector3();

    window.addEventListener('resize', () => this.onResize());
    this.applyQuality();

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  async boot() {
    // Audio decode requires a user gesture in most browsers: init lazily too.
    const unlock = () => { audio.init(); audio.resume(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    this.ui.setLoadingProgress(0.05, 'Waking heroes…');
    const { preloadHeroModels } = await import('./entities/heroModel.js');
    await preloadHeroModels((f) => this.ui.setLoadingProgress(0.05 + f * 0.35, 'Waking heroes…'));

    this.ui.setLoadingProgress(0.4, 'Summoning sounds…');
    try {
      audio.init();
    } catch { /* will init on first gesture */ }
    if (audio.ctx) {
      await audio.loadAll((f) => this.ui.setLoadingProgress(0.4 + f * 0.55, 'Summoning sounds…'));
    }
    this.ui.setLoadingProgress(1, 'Ready');
    // Enemy movement-learning net loads in the background (non-blocking).
    learner.init();
    this.state = 'title';
    this.ui.showTitle(SaveManager.hasSave());
  }

  // ---------------- state / flow ----------------
  startNewGame(classId) {
    SaveManager.clear();
    this.player = new Player(classId);
    this.scene.add(this.player.mesh);
    this.floor = 1;
    this.kills = 0;
    this.deaths = 0;
    this.bossDefeated = false;
    this.ui.buildHotbar(this.player);
    this.loadFloor(1);
    this.enterPlaying();
  }

  continueGame() {
    const data = SaveManager.load();
    if (!data) return;
    this.player = Player.fromSave(data.player);
    this.scene.add(this.player.mesh);
    this.floor = data.floor || 1;
    this.kills = data.kills || 0;
    this.deaths = data.deaths || 0;
    this.bossDefeated = data.bossDefeated || false;
    if (this.floor === MAX_FLOOR && this.bossDefeated) this.floor = MAX_FLOOR + 1;
    this.ui.buildHotbar(this.player);
    this.loadFloor(this.floor);
    this.enterPlaying();
  }

  enterPlaying() {
    this.state = 'playing';
    this.ui.hideAll();
    this.ui.showHud(true);
    this.touch.setVisible(true);
    audio.resume();
  }

  quitToTitle() {
    this.requestSave(true);
    this.teardownFloor();
    if (this.player) {
      this.scene.remove(this.player.mesh);
      this.player = null;
    }
    audio.playMusic(null);
    audio.stopMusic();
    this.state = 'title';
    this.ui.showHud(false);
    this.touch.setVisible(false);
    this.ui.showTitle(SaveManager.hasSave());
  }

  togglePause(paused) {
    if (!this.player) return;
    if (paused === undefined) paused = this.state === 'playing';
    if (paused && this.state === 'playing') {
      this.state = 'paused';
      this.ui.show('pause');
    } else if (!paused && this.state === 'paused') {
      this.state = 'playing';
      this.ui.hideAll();
    }
  }

  onPlayerDeath() {
    this.deaths++;
    this.player.gold = Math.floor(this.player.gold * 0.8);
    this.requestSave(true);
    setTimeout(() => {
      if (this.state === 'playing') {
        this.state = 'dead';
        this.ui.showGameOver(this.floor);
      }
    }, 900);
  }

  respawn() {
    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.dead = false;
    this.player.hp = this.player.maxHp;
    this.player.resource = this.player.maxResource;
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.player.statuses = [];
    this.player.buffs = [];
    // reset enemies aggro
    for (const e of this.enemies) if (!e.dead) e.state = 'idle';
    if (this.boss && !this.boss.dead) {
      this.boss.state = 'idle';
      this.boss.hp = Math.min(this.boss.maxHp, this.boss.hp + this.boss.maxHp * 0.3);
    }
    this.enterPlaying();
  }

  onVictory() {
    this.bossDefeated = true;
    this.requestSave(true);
    audio.play('boss_death');
    audio.playMusic('dungeon', 2);
    setTimeout(() => {
      this.state = 'victory';
      this.ui.showVictory({
        className: this.player.classDef.name,
        level: this.player.level,
        kills: this.kills,
        gold: this.player.gold,
        deaths: this.deaths,
      });
    }, 1400);
  }

  continueAfterVictory() {
    this.floor = MAX_FLOOR + 1;
    this.loadFloor(this.floor);
    this.enterPlaying();
  }

  // ---------------- floor management ----------------
  teardownFloor() {
    if (this.dungeonMeshes) {
      this.scene.remove(this.dungeonMeshes.group);
      this.dungeonMeshes.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      this.dungeonMeshes = null;
    }
    for (const e of this.enemies) this.scene.remove(e.mesh);
    this.enemies = [];
    if (this.boss) { this.scene.remove(this.boss.mesh); this.boss = null; }
    for (const z of this.zones) if (z.mesh) this.scene.remove(z.mesh);
    this.zones = [];
    for (const t of this.traps) this.scene.remove(t.mesh);
    this.traps = [];
    this.projectiles.clear();
    this.loot.clear();
    this.particles.clear();
    this.ui.floaters.clear();
    for (const l of this.torchLights) this.scene.remove(l);
    this.torchLights = [];
  }

  loadFloor(floor) {
    this.teardownFloor();
    this.floor = floor;
    const theme = themeForFloor(floor);
    this.dungeon = generateDungeon(floor);
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme);
    this.scene.add(this.dungeonMeshes.group);

    // grid copy for door state
    this.openedDoors = new Set();

    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.player.dead = false;

    // enemies
    for (const spec of this.dungeon.enemies) {
      const e = new Enemy(spec.type, floor > MAX_FLOOR ? floor + 2 : floor, { miniboss: spec.miniboss });
      const w = tileToWorld(spec.x, spec.y);
      e.pos.set(w.x, 0, w.z);
      e.mesh.position.copy(e.pos);
      this.scene.add(e.mesh);
      this.enemies.push(e);
    }

    // boss
    if (this.dungeon.boss && !this.bossDefeated) {
      this.boss = new Boss(floor);
      const w = tileToWorld(this.dungeon.boss.x, this.dungeon.boss.y);
      this.boss.pos.set(w.x, 0, w.z);
      this.boss.mesh.position.copy(this.boss.pos);
      this.scene.add(this.boss.mesh);
      this.enemies.push(this.boss);
      audio.play('boss_roar', { volume: 0.9 });
    }

    // torch light pool
    const maxLights = { low: 4, medium: 8, high: 14 }[this.settings.quality] || 8;
    const count = Math.min(maxLights, this.dungeonMeshes.torchPositions.length);
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(theme.accent, 12, 9, 1.9);
      this.scene.add(l);
      this.torchLights.push(l);
    }
    this.torchAssignTimer = 0;

    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(floor, theme.name);
    audio.playMusic(floor === MAX_FLOOR && !this.bossDefeated ? 'boss' : 'dungeon');
    audio.play('stairs', { volume: 0.7 });
    this.stairsCooldown = 1.5;
    this.requestSave(true);
  }

  // ---------------- collision / queries ----------------
  tileAt(x, z) {
    const tx = Math.floor(x / TILE), ty = Math.floor(z / TILE);
    const row = this.dungeon?.grid[ty];
    return row ? row[tx] : WALL;
  }

  isWalkable(x, z, radius = 0.3) {
    for (const [dx, dz] of [[-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]]) {
      const t = this.tileAt(x + dx, z + dz);
      if (t === WALL || t === 0) return false;
      if (t === DOOR) {
        const tx = Math.floor((x + dx) / TILE), ty = Math.floor((z + dz) / TILE);
        if (!this.openedDoors.has(`${tx},${ty}`)) return false;
      }
    }
    return true;
  }

  hasLineOfSight(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / 0.8);
    for (let i = 1; i < steps; i++) {
      const t = this.tileAt(a.x + (dx * i) / steps, a.z + (dz * i) / steps);
      if (t === WALL) return false;
    }
    return true;
  }

  // ---------------- combat API ----------------
  meleeAttack(player, basic) {
    let hitAny = false;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > basic.range + e.radius) continue;
      const angleTo = Math.atan2(dz, dx);
      let diff = angleTo - player.aimAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < basic.arc / 2) {
        this.damageEnemy(e, player.damage, { knockback: 3, kbFrom: player.pos });
        hitAny = true;
      }
    }
    if (hitAny) audio.play(basic.hitSound);
  }

  damageEnemy(e, amount, opts = {}) {
    if (e.dead) return;
    let dmg = amount;
    let crit = false;
    if (!opts.dot && this.player && Math.random() < this.player.crit) {
      dmg *= 1.8;
      crit = true;
    }
    dmg = Math.max(1, Math.round(dmg));
    e.hp -= dmg;
    if (!opts.noFlash) e.hitFlash = 0.12;
    const cls = opts.color === 'burn' ? 'crit' : opts.color === 'poison' ? 'heal' : crit ? 'crit' : '';
    this.ui.floaters.spawn(e.pos, `${dmg}`, cls);
    if (!opts.silent) audio.play(e.def.sounds.hurt, { pos: e.pos, volume: 0.7, throttleMs: 90 });
    if (opts.status) e.addStatus(opts.status, this);
    if (opts.knockback && !e.isBoss) {
      const from = opts.kbFrom || this.player.pos;
      const dx = e.pos.x - from.x, dz = e.pos.z - from.z;
      const len = Math.hypot(dx, dz) || 1;
      e.knockback = { x: (dx / len) * opts.knockback, z: (dz / len) * opts.knockback };
    }
    if (e.state === 'idle') e.state = 'chase';
    if (e.hp <= 0) this.killEnemy(e);
  }

  killEnemy(e) {
    e.dead = true;
    this.kills++;
    audio.play(e.def.sounds.death, { pos: e.pos, volume: 0.85 });
    this.particles.burst(e.pos.x, 0.8, e.pos.z, 22, e.def.color, { speed: 4, life: 0.7 });
    this.scene.remove(e.mesh);

    // rewards
    this.player.gainXp(e.xp, this);
    const [gMin, gMax] = e.goldRange;
    const goldPiles = e.isBoss ? 8 : e.miniboss ? 4 : 1 + Math.floor(Math.random() * 2);
    const total = Math.round(gMin + Math.random() * (gMax - gMin));
    for (let i = 0; i < goldPiles; i++) {
      this.loot.dropGold(e.pos.x, e.pos.z, Math.max(1, Math.round(total / goldPiles)));
    }
    if (Math.random() < 0.10) this.loot.dropPotion(e.pos.x + 0.5, e.pos.z);
    const gearChance = e.isBoss ? 1 : e.miniboss ? 1 : 0.09;
    if (Math.random() < gearChance) {
      const rarity = e.isBoss || e.miniboss ? 'epic' : null;
      this.loot.dropGear(e.pos.x, e.pos.z + 0.5, generateGear(this.floor, rarity));
    }

    if (e.isBoss) this.onVictory();
    this.requestSave();
  }

  aoeDamage(x, z, radius, damage, opts = {}) {
    if (opts.source === 'player') {
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.pos.x - x, e.pos.z - z);
        if (d < radius + e.radius) {
          this.damageEnemy(e, damage, { status: opts.status, knockback: opts.knockback, kbFrom: { x, z } });
        }
      }
    } else {
      const p = this.player;
      if (!p.dead && Math.hypot(p.pos.x - x, p.pos.z - z) < radius) p.takeDamage(damage, this);
    }
  }

  stunEnemiesNear(x, z, radius, duration) {
    for (const e of this.enemies) {
      if (e.dead || e.isBoss) continue;
      if (Math.hypot(e.pos.x - x, e.pos.z - z) < radius) e.stun(duration);
    }
  }

  spawnProjectile(opts) { this.projectiles.spawn(opts); }

  addZone(opts) {
    const geo = new THREE.CircleGeometry(opts.radius, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: opts.color, transparent: true, opacity: 0.22, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(opts.x, 0.06, opts.z);
    this.scene.add(mesh);
    this.zones.push({ ...opts, mesh, t: opts.duration, delay: opts.delay || 0, tickT: 0 });
  }

  placeTrap(opts) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.35, 0.08, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a6a2a, roughness: 0.6 })
    );
    mesh.position.set(opts.x, 0.05, opts.z);
    this.scene.add(mesh);
    this.traps.push({ ...opts, mesh, armTimer: 0.5 });
  }

  bossSummon(boss) {
    audio.play('boss_roar', { volume: 0.7, rate: 1.3 });
    const types = ['skeleton', 'skeleton', 'spider'];
    for (const type of types) {
      const a = Math.random() * Math.PI * 2;
      const x = boss.pos.x + Math.cos(a) * 4;
      const z = boss.pos.z + Math.sin(a) * 4;
      if (!this.isWalkable(x, z, 0.4)) continue;
      const e = new Enemy(type, this.floor);
      e.pos.set(x, 0, z);
      e.state = 'chase';
      this.scene.add(e.mesh);
      this.enemies.push(e);
      this.particles.burst(x, 0.6, z, 16, 0xb35eff, { speed: 3, life: 0.5 });
    }
  }

  shake(amount) {
    if (!this.settings.screenShake) return;
    this.shakeAmount = Math.min(0.8, this.shakeAmount + amount);
  }

  // ---------------- inventory ----------------
  equip(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1) return;
    p.inventory.splice(idx, 1);
    const prev = p.equipped[item.slot];
    p.equipped[item.slot] = item;
    if (prev) p.inventory.push(prev);
    p.recompute();
    audio.play('equip');
    this.requestSave();
  }

  unequip(slotName) {
    const p = this.player;
    const item = p.equipped[slotName];
    if (!item || p.inventory.length >= 12) return;
    p.equipped[slotName] = null;
    p.inventory.push(item);
    p.recompute();
    audio.play('equip');
    this.requestSave();
  }

  dropItem(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1) return;
    p.inventory.splice(idx, 1);
    this.loot.dropGear(p.pos.x + 1, p.pos.z, item);
    this.requestSave();
  }

  // ---------------- saving ----------------
  requestSave(immediate = false) {
    if (!this.player) return;
    this.savePending = true;
    if (immediate) this.flushSave();
  }

  flushSave() {
    if (!this.player || !this.savePending) return;
    this.savePending = false;
    SaveManager.save({
      player: this.player.toSave(),
      floor: this.floor,
      kills: this.kills,
      deaths: this.deaths,
      bossDefeated: this.bossDefeated,
    });
  }

  saveSettings() { SaveManager.saveSettings(this.settings); }

  applyQuality() {
    const q = this.settings.quality;
    const ratio = { low: 0.75, medium: 1, high: Math.min(window.devicePixelRatio, 2) }[q] || 1;
    this.renderer.setPixelRatio(ratio);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------------- per-frame ----------------
  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.state === 'playing') {
      this.updatePlaying(dt);
    } else if (this.state === 'dead' || this.state === 'victory' || this.state === 'inventory' || this.state === 'paused') {
      // world is frozen; still render + light flicker for life
      this.updateTorches(dt, true);
      if (this.state === 'inventory' && (this.input.wasPressed('Tab') || this.input.wasPressed('Escape') || this.input.wasPressed('KeyI'))) {
        this.state = 'playing';
        this.ui.closeInventory();
      }
      if (this.state === 'paused' && this.input.wasPressed('Escape')) this.togglePause(false);
    }

    // debounced save
    this.saveTimer -= dt;
    if (this.savePending && this.saveTimer <= 0) {
      this.saveTimer = 2;
      this.flushSave();
    }

    this.ui.floaters.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  updatePlaying(dt) {
    const p = this.player;
    const input = this.input;

    // ---- input: movement ----
    let mx = 0, mz = 0;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz += 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, mz) || 1;
    p.moveDir.x = mx / len;
    p.moveDir.z = mz / len;
    // touch joystick overrides keyboard when engaged
    if (this.touch.joyActive) {
      p.moveDir.x = this.touch.move.x;
      p.moveDir.z = this.touch.move.z;
    }

    // ---- input: aim via mouse raycast to ground ----
    this._mouseNdc.set(
      (input.mouse.x / window.innerWidth) * 2 - 1,
      -(input.mouse.y / window.innerHeight) * 2 + 1
    );
    this.raycaster.setFromCamera(this._mouseNdc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.groundPlane, this._aimTarget)) {
      p.cursor.x = this._aimTarget.x;
      p.cursor.z = this._aimTarget.z;
      const dx = this._aimTarget.x - p.pos.x;
      const dz = this._aimTarget.z - p.pos.z;
      const alen = Math.hypot(dx, dz) || 1;
      p.aimAngle = Math.atan2(dz, dx);
      p.aimDir.x = dx / alen;
      p.aimDir.z = dz / alen;
    }

    // ---- input: actions ----
    if (input.mouse.down || this.touch.attacking) p.tryBasicAttack(this);
    if (input.wasPressed('Digit1')) p.tryAbility(0, this);
    if (input.wasPressed('Digit2')) p.tryAbility(1, this);
    if (input.wasPressed('Digit3')) p.tryAbility(2, this);
    if (input.wasPressed('Digit4')) p.tryAbility(3, this);
    if (input.wasPressed('KeyQ')) p.drinkPotion(this);
    if (input.wasPressed('Tab') || input.wasPressed('KeyI')) {
      this.state = 'inventory';
      this.ui.openInventory();
      return;
    }
    if (input.wasPressed('Escape')) { this.togglePause(true); return; }

    // ---- systems ----
    p.update(dt, this);
    for (const e of this.enemies) e.update(dt, this);
    this.enemies = this.enemies.filter((e) => !e.dead || e.isBoss);
    this.projectiles.update(dt, this);
    this.loot.update(dt, this);
    this.particles.update(dt);
    this.updateZones(dt);
    this.updateTraps(dt);
    this.updateDoors();
    this.updateChests();
    this.updateStairs(dt);
    this.updateTorches(dt);

    // ---- camera follow + shake ----
    const target = p.pos;
    this.camera.position.x += (target.x + this.cameraOffset.x - this.camera.position.x) * Math.min(1, 8 * dt);
    this.camera.position.y += (target.y + this.cameraOffset.y - this.camera.position.y) * Math.min(1, 8 * dt);
    this.camera.position.z += (target.z + this.cameraOffset.z - this.camera.position.z) * Math.min(1, 8 * dt);
    if (this.shakeAmount > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmount;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmount * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * this.shakeAmount;
      this.shakeAmount *= 1 - 7 * dt;
    }
    this.camera.lookAt(target.x, 0.5, target.z);

    // player light follows
    this.playerLight.position.set(p.pos.x, 3.2, p.pos.z);

    // audio listener
    audio.setListener(p.pos.x, p.pos.z);

    // enemy ML observes player movement for online training
    learner.observe(dt, p);

    // ---- UI ----
    this.ui.minimap.revealAround(p.pos.x, p.pos.z);
    this.ui.minimap.draw(p);
    const bossOnFloor = this.boss && !this.boss.dead && this.boss.state !== 'idle' ? this.boss : null;
    this.ui.updateHud(p, this.floor, bossOnFloor);
  }

  updateZones(dt) {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      if (z.delay > 0) {
        z.delay -= dt;
        z.mesh.material.opacity = 0.1 + 0.1 * Math.sin(performance.now() / 60);
        continue;
      }
      z.t -= dt;
      z.tickT -= dt;
      z.mesh.material.opacity = 0.22;
      if (z.tickT <= 0) {
        z.tickT = z.tick;
        const dmg = z.dps * z.tick;
        if (z.friendly) {
          this.aoeDamage(z.x, z.z, z.radius, dmg, { source: 'player', status: z.status });
        } else {
          this.aoeDamage(z.x, z.z, z.radius, dmg, {});
        }
        if (z.spark) {
          this.particles.burst(
            z.x + (Math.random() - 0.5) * z.radius * 1.4, 1.5,
            z.z + (Math.random() - 0.5) * z.radius * 1.4,
            6, z.color, { speed: 2, life: 0.35, up: 0.2 }
          );
        }
        if (z.arrows) {
          this.particles.burst(
            z.x + (Math.random() - 0.5) * z.radius * 1.6, 2.5,
            z.z + (Math.random() - 0.5) * z.radius * 1.6,
            4, 0xd8c890, { speed: 1, life: 0.3, up: -2 }
          );
        }
      }
      if (z.t <= 0) {
        this.scene.remove(z.mesh);
        z.mesh.geometry.dispose();
        z.mesh.material.dispose();
        this.zones.splice(i, 1);
      }
    }
  }

  updateTraps(dt) {
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const t = this.traps[i];
      if (t.armTimer > 0) { t.armTimer -= dt; continue; }
      let triggered = false;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.pos.x - t.x, e.pos.z - t.z) < t.radius + e.radius) { triggered = true; break; }
      }
      if (triggered) {
        audio.play('trap_trigger', { pos: t });
        this.addZone({
          x: t.x, z: t.z, radius: t.cloudRadius, duration: t.duration, tick: 0.5,
          dps: t.dps, friendly: true, color: 0x6ad83a,
          status: { poison: { dps: t.dps * 0.4, duration: 2 } },
        });
        this.scene.remove(t.mesh);
        this.traps.splice(i, 1);
      }
    }
  }

  updateDoors() {
    const p = this.player;
    for (const d of this.dungeon.doors) {
      const key = `${d.x},${d.y}`;
      if (this.openedDoors.has(key)) continue;
      const w = tileToWorld(d.x, d.y);
      if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < TILE * 1.1) {
        this.openedDoors.add(key);
        audio.play('door_open', { pos: { x: w.x, z: w.z } });
        const mesh = this.dungeonMeshes.doorMeshes.get(key);
        if (mesh) {
          // sink the door into the floor
          const sink = setInterval(() => {
            mesh.position.y -= 0.08;
            if (mesh.position.y < -1.4) { clearInterval(sink); mesh.visible = false; }
          }, 16);
        }
      }
    }
  }

  updateChests() {
    const p = this.player;
    for (const c of this.dungeonMeshes.chestMeshes) {
      if (c.opened) continue;
      if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < 1.3) {
        c.opened = true;
        audio.play('chest_open', { pos: { x: c.x, z: c.z } });
        c.lid.rotation.x = -1.1;
        c.lid.position.z -= 0.18;
        c.lid.position.y += 0.12;
        this.particles.burst(c.x, 0.8, c.z, 16, 0xe8c05a, { speed: 2.5, life: 0.6 });
        // chest loot: gold + high gear chance + potion chance
        const gold = 8 + Math.round(Math.random() * 10 * this.floor);
        for (let i = 0; i < 3; i++) this.loot.dropGold(c.x, c.z, Math.round(gold / 3));
        if (Math.random() < 0.65) this.loot.dropGear(c.x + 0.6, c.z, generateGear(this.floor, null));
        if (Math.random() < 0.4) this.loot.dropPotion(c.x - 0.6, c.z);
      }
    }
  }

  updateStairs(dt) {
    this.stairsCooldown = Math.max(0, this.stairsCooldown - dt);
    if (!this.dungeon.stairs || this.stairsCooldown > 0) return;
    const p = this.player;
    const w = tileToWorld(this.dungeon.stairs.x, this.dungeon.stairs.y);
    // spin the portal ring
    if (this.dungeonMeshes.stairsMesh) {
      this.dungeonMeshes.stairsMesh.children.forEach((ch) => {
        if (ch.geometry?.type === 'TorusGeometry') ch.rotation.z += dt * 1.5;
      });
    }
    if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 1.1) {
      this.loadFloor(this.floor + 1);
    }
  }

  updateTorches(dt, flickerOnly = false) {
    if (!this.dungeonMeshes) return;
    const torches = this.dungeonMeshes.torchPositions;
    if (!flickerOnly) {
      this.torchAssignTimer -= dt;
      if (this.torchAssignTimer <= 0) {
        this.torchAssignTimer = 0.3;
        const p = this.player;
        const sorted = [...torches].sort((a, b) => {
          const da = (a.x - p.pos.x) ** 2 + (a.z - p.pos.z) ** 2;
          const db = (b.x - p.pos.x) ** 2 + (b.z - p.pos.z) ** 2;
          return da - db;
        });
        this.torchLights.forEach((l, i) => {
          const t = sorted[i];
          if (t) { l.position.set(t.x, t.y, t.z); l.visible = true; }
          else l.visible = false;
        });
      }
    }
    // flicker
    const now = performance.now() / 1000;
    this.torchLights.forEach((l, i) => {
      l.intensity = 10 + Math.sin(now * 9 + i * 1.7) * 2 + Math.sin(now * 23 + i * 3.1) * 1.2;
    });
    for (let i = 0; i < torches.length; i++) {
      const f = torches[i].flame;
      const s = 1 + Math.sin(now * 11 + i * 2.3) * 0.18;
      f.scale.set(s, 1 + Math.sin(now * 13 + i) * 0.25, s);
    }
  }
}
