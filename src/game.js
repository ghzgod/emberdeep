import * as THREE from 'three';
import { Input } from './core/input.js';
import { SaveManager } from './core/save.js';
import { audio } from './core/audio.js';
import { generateDungeon, generateTown, FLOOR, WALL, DOOR, BRIDGE } from './world/dungeon.js';
import { buildDungeonMeshes, TILE, tileToWorld } from './world/meshbuilder.js';
import { themeForFloor, actOfFloor, actFloorOf } from './world/textures.js';
import { Player, xpForLevel } from './entities/player.js';
import { Enemy, Boss, ENEMY_TYPES, ACT_BOSSES, buildEnemyMesh, buildBossMesh } from './entities/enemies.js';
import { buildAnimatedHero } from './entities/heroModel.js';
import { CLASSES, buildHeroMesh } from './entities/classes.js';
import { ProjectileSystem } from './entities/projectiles.js';
import { LootSystem, generateGear, rollRarity, sellValue, gambleItem, dropLegendary, RARITIES, newItemId } from './entities/loot.js';

// Alchemist buff elixirs — consumables drunk from the inventory that grant a
// temporary boon via the existing buff system (damageMult / damageTakenMult).
const ELIXIRS = [
  { key: 'might',  icon: '⚗️', name: 'Elixir of Might',   rarity: 'rare', buff: { id: 'elixir-might', duration: 45, damageMult: 1.3 },      label: '+30% damage for 45s' },
  { key: 'iron',   icon: '🧴', name: 'Draught of Iron',    rarity: 'rare', buff: { id: 'elixir-iron', duration: 45, damageTakenMult: 0.7 },  label: '-30% damage taken for 45s' },
  { key: 'frenzy', icon: '🧪', name: 'Frenzy Tonic',       rarity: 'epic', buff: { id: 'elixir-frenzy', duration: 30, damageMult: 1.6 },     label: '+60% damage for 30s' },
];
import { net } from './net/net.js';
import { voice } from './net/voice.js';
import { ParticleSystem } from './combat/particles.js';
import { UI } from './ui/ui.js';
import { learner } from './ai/learner.js';
import { roaster } from './ai/roaster.js';
import { STORIES } from './story.js';
import { generateTavernInterior, buildTavernInterior } from './world/tavern.js';
import { Wanderer } from './entities/wanderer.js';
import { TouchControls } from './core/touch.js';

// Five acts × ten floors; the Dungeon Lord waits on floor 50. Beyond lies the endless abyss.
const MAX_FLOOR = 50;
const ROMAN = [null, 'I', 'II', 'III', 'IV', 'V'];

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
    this.camYaw = 0; // Q/E (or touch buttons) orbit the camera around the hero

    // lights
    this.ambient = new THREE.AmbientLight(0x8a7a9a, 0.55);
    this.scene.add(this.ambient);
    this.playerLight = new THREE.PointLight(0xffd8a0, 40, 14, 1.8);
    this.scene.add(this.playerLight);
    this.torchLights = [];

    this.input = new Input(this.canvas);
    const savedSettings = SaveManager.loadSettings();
    const firstVisit = !savedSettings;
    this.settings = Object.assign(
      { masterVolume: 0.8, musicVolume: 0.6, sfxVolume: 0.9, quality: 'medium', screenShake: true, voiceMode: 'ptt', voiceThreshold: 12, taunts: true, voiceChatVolume: 0.9, speechVolume: 0.9,
        keybinds: { interact: 'KeyF', potion: 'KeyR', talk: 'KeyV', inventory: 'Tab', quests: 'KeyJ', mastery: 'KeyK' } },
      savedSettings || {}
    );
    // first-ever visit: run the dialogue-forward auto-balance so the mix is
    // sane out of the box (speech reference, sfx -6dB, music -12dB)
    if (firstVisit) {
      const db = (d) => Math.pow(10, d / 20);
      Object.assign(this.settings, {
        speechVolume: 1.0, voiceChatVolume: 1.0,
        sfxVolume: +db(-6).toFixed(2), musicVolume: +db(-12).toFixed(2), masterVolume: 0.85,
      });
    }
    // ensure keybinds exist on older saves
    this.settings.keybinds = Object.assign({ interact: 'KeyF', potion: 'KeyR', talk: 'KeyV', inventory: 'Tab', quests: 'KeyJ', mastery: 'KeyK' }, this.settings.keybinds || {});
    // one-time migration: settings saved before push-to-talk became the
    // default carried voiceMode:'off' that the user never chose
    if (!this.settings._v2) {
      if (this.settings.voiceMode === 'off') this.settings.voiceMode = 'ptt';
      this.settings._v2 = true;
      SaveManager.saveSettings(this.settings);
    }
    audio.volumes = {
      master: this.settings.masterVolume,
      music: this.settings.musicVolume,
      sfx: this.settings.sfxVolume,
    };

    this.playerModule = { xpForLevel };
    roaster.enabled = this.settings.taunts !== false;
    this.applyAudioSettings();
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
    this.actsCleared = 0;
    this.elitesKilled = 0;
    this.storySeen = [];
    this.inTown = false;
    this.inTavern = false;
    this.slotId = null;
    this.shopCooldown = 0;
    this.activeVendor = null;
    // multiplayer
    this.remotePlayers = new Map();  // id -> { mesh, anim, target, cls }
    this.netEnemySeq = 0;
    this.netTickTimer = 0;
    this.posSendTimer = 0;
    this.touchPtt = false;
    this.localTown = false;   // guest: shopping in their OWN town, not the host's world
    this.lastWorldMsg = null; // guest: latest host world snapshot
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

  // ---------------- multiplayer session ----------------
  setMultiplayer(on) {
    if (!on) net.stop();
  }

  async startMultiplayer(room) {
    net.stop();
    this.wireNet();
    const result = await net.start(room);
    if (result.mode === 'error') { net.stop(); return result; }
    voice.attachToPeer(net.peer);
    if (this.settings.voiceMode !== 'off') {
      voice.enable(this.settings.voiceMode, this.settings.voiceThreshold);
    }
    voice.onTransmitChange = (on) => this.ui.setMicIndicator(on);
    this.ui.setMicAvailable(this.settings.voiceMode === 'ptt');
    if (net.isHost) net.broadcastRoster();
    return result;
  }

  leaveMultiplayerLobby() {
    net.stop();
  }

  async boot() {
    SaveManager.migrate();
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
      await audio.loadAll((f) => this.ui.setLoadingProgress(0.4 + f * 0.3, 'Summoning sounds…'));
    }
    // Enemy movement-learning net loads in the background (non-blocking).
    learner.init();

    // Neural character voices (Kokoro, ~90 MB) download as the FINAL loading
    // phase so their progress shows in the loading bar. Soft-capped at 30s: if
    // the download is slow we proceed to the title and it finishes in the
    // background (lines stay subtitle-only until it's ready). Cached on repeat
    // visits, so this is near-instant after the first load.
    this.ui.setLoadingProgress(0.7, 'Downloading natural voices…');
    try {
      const { neuralVoice } = await import('./ai/neuralVoice.js');
      neuralVoice.onStatus = (st, prog) => {
        if (st === 'loading') {
          const p = Math.max(0, prog || 0);
          this.ui.setLoadingProgress(0.7 + p * 0.3, p > 0 ? `Downloading natural voices… ${Math.round(p * 100)}%` : 'Downloading natural voices…');
        } else if (st === 'ready') {
          this.ui.setLoadingProgress(1, 'Ready');
        }
      };
      await Promise.race([neuralVoice.load(), new Promise((res) => setTimeout(res, 30000))]);
    } catch { /* voices are optional — never block boot on them */ }

    this.ui.setLoadingProgress(1, 'Ready');
    this.state = 'title';
    this.ui.showTitle();
  }

  // ---------------- state / flow ----------------
  startNewGame(classId) {
    this.slotId = SaveManager.newSlotId();
    this.player = new Player(classId);
    this.scene.add(this.player.mesh);
    this.floor = 1;
    this.kills = 0;
    this.deaths = 0;
    this.bossDefeated = false;
    this.actsCleared = 0;
    this.elitesKilled = 0;
    this.storySeen = [];
    this.ui.buildHotbar(this.player);
    this.enterWorld();
    this.showStory('prologue');
  }

  continueGame(slotId) {
    const data = SaveManager.loadSlot(slotId);
    if (!data) return;
    this.slotId = slotId;
    this.player = Player.fromSave(data.player);
    this.scene.add(this.player.mesh);
    this.floor = data.floor || 1;
    this.kills = data.kills || 0;
    this.deaths = data.deaths || 0;
    this.bossDefeated = data.bossDefeated || false;
    // saves from the single-act era: their "victory" was only Act I's boss
    if (this.bossDefeated && this.floor <= 11) this.bossDefeated = false;
    this.elitesKilled = data.elitesKilled || 0;
    this.actsCleared = data.actsCleared ?? (this.bossDefeated ? 5 : Math.min(4, Math.floor((this.floor - 1) / 10)));
    this.storySeen = data.storySeen || [];
    if (this.floor === MAX_FLOOR && this.bossDefeated) this.floor = MAX_FLOOR + 1;
    this.ui.buildHotbar(this.player);
    this.enterWorld();
  }

  // Everyone starts in their OWN town — guests included. A guest only joins
  // the host's world by stepping through the dungeon portal.
  enterWorld() {
    if (net.active && !net.isHost) {
      net.send({ t: 'hello', cls: this.player.classId, name: this.playerName() });
      this.localTown = true;
    }
    this.loadTown();
    this.enterPlaying();
  }

  playerName() {
    return (localStorage.getItem('emberdeep-name-v1') || 'Hero').slice(0, 14);
  }

  // 0 = dungeon, 1 = town square, 2 = tavern — heroes see zone-mates only
  myZone() {
    return this.inTavern ? 2 : this.inTown ? 1 : 0;
  }

  enterPlaying() {
    this.state = 'playing';
    this.ui.hideAll();
    this.ui.showHud(true);
    this.touch.setVisible(true);
    this.ui.showChatBar(net.active);
    audio.resume();
  }

  broadcastChat(text) {
    if (!net.active) return;
    const name = this.playerName();
    const ts = Date.now();
    this.ui.addChatMessage(name, text, ts, true);
    net.send({ t: 'chat', name, txt: text, ts });
  }

  quitToTitle() {
    this.requestSave(true);
    voice.disable();
    this.ui.setMicAvailable(false);
    this.ui.showChatBar(false);
    net.stop();
    this.clearRemotePlayers();
    this.teardownFloor();
    if (this.player) {
      this.scene.remove(this.player.mesh);
      this.player = null;
    }
    audio.stopMusic();
    this.state = 'title';
    this.ui.showHud(false);
    this.touch.setVisible(false);
    this.ui.showTitle();
  }

  toggleInventory() {
    if (this.state === 'playing') {
      this.state = 'inventory';
      this.ui.openInventory();
    } else if (this.state === 'inventory') {
      this.state = 'playing';
      this.ui.closeInventory();
    }
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
    roaster.onPlayerDeath(this, this.player.classDef.name);
    // leave a skeleton where you fell, and tell the room so co-op sees it too
    if (!this.inTown) {
      this.spawnDeathSkeleton(this.player.pos.x, this.player.pos.z);
      if (net.active) net.send({ t: 'death', x: +this.player.pos.x.toFixed(1), z: +this.player.pos.z.toFixed(1) });
    }
    this.player.gold = Math.floor(this.player.gold * 0.8);
    this.requestSave(true);
    setTimeout(() => {
      if (this.state === 'playing') {
        this.state = 'dead';
        this.ui.showGameOver(this.floor);
      }
    }, 900);
  }

  // A slain-hero skeleton at a death spot. Spaced (never within 20m of another)
  // and capped so the browser's RAM stays bounded; cleared with the floor.
  spawnDeathSkeleton(x, z) {
    if (!this.deathMarkers) this.deathMarkers = [];
    if (this.deathMarkers.length >= 20) return;
    for (const d of this.deathMarkers) if (Math.hypot(d.x - x, d.z - z) < 20) return;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 1 });
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mat);
    skull.position.set(0.22, 0.12, 0.08); skull.scale.set(1, 0.9, 1.05);
    g.add(skull);
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.4 + Math.random() * 0.2, 5), mat);
      b.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI);
      b.position.set((Math.random() - 0.5) * 0.6, 0.05, (Math.random() - 0.5) * 0.6);
      g.add(b);
    }
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 4, 8, Math.PI), mat);
    rib.rotation.x = Math.PI / 2; rib.position.set(-0.1, 0.06, 0);
    g.add(rib);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.deathMarkers.push({ mesh: g, x, z });
  }

  // Death sends you home to Embervale; your dungeon checkpoint is kept.
  respawn() {
    this.player.dead = false;
    this.player.hp = this.player.maxHp;
    this.player.resource = this.player.maxResource;
    this.player.statuses = [];
    this.player.buffs = [];
    // clear the death pose (leaning-back final frame) so the hero stands upright
    this.player.anim?.revive?.();
    this.player.mesh.rotation.x = 0;
    this.player.mesh.rotation.z = 0;
    // In multiplayer, respawning is a LOCAL trip to town — it must not reset the
    // shared dungeon or yank other players out of it. localTown keeps the zone
    // change to this client only.
    if (net.active) this.localTown = true;
    this.loadTown();
    // Respawn facing north (−Z) with the camera settled directly behind the
    // hero — otherwise we keep whatever orbit/facing we died with and spawn
    // looking backwards.
    this.player.aimAngle = -Math.PI / 2;
    this.player.visualAngle = -Math.PI / 2;
    this.player.faceAimTimer = 0;
    this.camYaw = 0;
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
    this.showStory('epilogue');
  }

  // ---------------- floor management ----------------
  // True while `pos` is inside the return-portal safe ring (pad extends the
  // radius, e.g. by an enemy's body radius so they stop at the edge).
  inSafeZone(pos, pad = 0) {
    const z = this.safeZone;
    if (!z || !pos) return false;
    return Math.hypot(pos.x - z.x, pos.z - z.z) < z.r + pad;
  }

  teardownFloor() {
    this.safeZone = null;
    if (this.dungeonMeshes) {
      this.scene.remove(this.dungeonMeshes.group);
      this.dungeonMeshes.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      this.dungeonMeshes = null;
    }
    for (const e of this.enemies) this.scene.remove(e.mesh);
    this.enemies = [];
    if (this.deathMarkers) { for (const d of this.deathMarkers) this.scene.remove(d.mesh); this.deathMarkers = []; }
    if (this.wallMarks) { for (const d of this.wallMarks) { this.scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose(); } this.wallMarks = []; }
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
    if (this.wanderer) { this.wanderer.dispose(); this.wanderer = null; }
    this.setInteractable(null);
  }

  // Step inside The Sleeping Golem.
  loadTavern() {
    this.teardownFloor();
    this.inTown = true;
    this.inTavern = true;
    this.dungeon = generateTavernInterior();
    this.dungeonMeshes = buildTavernInterior();
    this.scene.add(this.dungeonMeshes.group);
    this.openedDoors = new Set();
    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.setTownAtmosphere(true);
    this.scene.background = new THREE.Color(0x0d0a12);
    this.scene.fog = new THREE.Fog(0x0d0a12, 16, 34);
    const theme = themeForFloor(1);
    this.setupTorchLights({ ...theme, accent: 0xffa95e });
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner('THE SLEEPING GOLEM', 'Rest a while, hero', true);
    audio.playMusic('tavern');
    this.stairsCooldown = 1.5;
  }

  // ---------------- town ----------------
  loadTown(opts = {}) {
    this.teardownFloor();
    this.inTown = true;
    this.inTavern = false;
    const theme = themeForFloor(1);
    this.dungeon = generateTown();
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme);
    this.scene.add(this.dungeonMeshes.group);
    this.openedDoors = new Set();

    // returning from the dungeon puts you beside the portal you left through
    // (a few tiles south, so you don't step straight back in); leaving the
    // tavern puts you at its doorstep
    const spawnTile = opts.fromDungeon
      ? { x: this.dungeon.portal.x, y: this.dungeon.portal.y + 3 }
      : opts.fromTavern
        ? { x: this.dungeon.tavern.x + 4, y: this.dungeon.tavern.y + this.dungeon.tavern.h + 1 }
        : this.dungeon.spawn;
    const spawn = tileToWorld(spawnTile.x, spawnTile.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.player.dead = false;

    // fresh vendor stock each town visit
    for (const v of this.dungeonMeshes.vendorMeshes) {
      v.stock = this.makeVendorStock(v);
    }
    // Old Fenwick roams the square
    this.wanderer = new Wanderer(this.dungeon, this.scene);
    this.setTownAtmosphere(true);

    this.setupTorchLights(theme);
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(0, 'Embervale — rest, trade, prepare');
    audio.playMusic('tavern'); // town uses the calm tavern theme — no cave water drips
    this.shopCooldown = 1;
    this.requestSave(true);

    if (net.isHost) this.broadcastWorld();
  }

  // Vendors make subtle, tethered movements at their booth so they feel alive
  // without wandering off — a slow look-around, a gentle shuffle and bob.
  updateVendors(dt) {
    const vendors = this.dungeonMeshes?.vendorMeshes;
    if (!vendors) return;
    this._vt = (this._vt || 0) + dt;
    const t = this._vt;
    vendors.forEach((v, i) => {
      const k = v.keeper;
      if (!k || !v.keeperHome) return;
      const ph = i * 1.7;
      k.rotation.y = Math.sin(t * 0.5 + ph) * 0.35;
      k.position.x = v.keeperHome.x + Math.sin(t * 0.33 + ph) * 0.12;
      k.position.z = v.keeperHome.z + Math.sin(t * 0.27 + ph * 1.3) * 0.07;
      k.position.y = v.keeperHome.y + Math.abs(Math.sin(t * 0.9 + ph)) * 0.02;
    });
  }

  makeVendorStock(vendor) {
    const stock = [];
    if (vendor.type === 'potions') {
      // One stackable slot per consumable — click it repeatedly to buy more.
      stock.push({ kind: 'potion', icon: '🧪', label: 'Health Potion', price: 20 + this.floor * 4, qty: 20 });
      // A rotating pair of buff elixirs, plus the rare epic tonic sometimes.
      const shuffled = [...ELIXIRS].sort(() => Math.random() - 0.5);
      for (const e of shuffled.slice(0, 2)) {
        stock.push({ kind: 'elixir', icon: e.icon, label: e.name, price: 55 + this.floor * 7, qty: 3, elixir: e });
      }
      if (Math.random() < 0.35 && this.player.invSize < 24) {
        stock.push({ kind: 'bag', icon: '🎒', label: 'Traveler’s Satchel (+3 slots)', price: 400, qty: 1 });
      }
    } else if (vendor.type === 'mystery') {
      // Zoltan: pay dearly, roll the dice. Small chance of a legendary unique.
      stock.push({ kind: 'gamble', icon: '❓', label: 'Mystery Relic — fate decides', price: 150 + this.floor * 30, qty: 5 });
    } else {
      // The smith sells solid basics only — epics and better must be earned
      // in the dungeon (or gambled from Zoltan).
      for (let i = 0; i < 4; i++) {
        const rarity = Math.random() < 0.35 ? 'rare' : 'common';
        const item = generateGear(Math.min(MAX_FLOOR, this.floor + 1), rarity, this.player.classId);
        stock.push({ kind: 'gear', icon: item.icon, label: item.name, price: Math.round((item.value || 30) * 2.2), item, qty: 1 });
      }
    }
    return stock;
  }

  buyFromVendor(vendor, entry) {
    const p = this.player;
    const remaining = entry.qty != null ? entry.qty : (entry.sold ? 0 : 1);
    if (remaining <= 0 || p.gold < entry.price) return;
    // Zoltan's gamble has a short cooldown so it can't be spammed.
    if (entry.kind === 'gamble') {
      const left = Math.ceil(((this._gambleReadyAt || 0) - performance.now()) / 1000);
      if (left > 0) { this.ui.floaters.spawn(p.pos, `Fate must rest — ${left}s`, 'player-dmg'); return; }
    }
    // items that land in the pack need a free slot first
    if ((entry.kind === 'gear' || entry.kind === 'gamble' || entry.kind === 'elixir') && p.inventory.length >= p.invSize) {
      this.ui.floaters.spawn(p.pos, 'Inventory full!', 'player-dmg');
      return;
    }
    p.gold -= entry.price;
    if (entry.qty != null) entry.qty--; else entry.sold = true;
    audio.play('coin_pickup');
    if (entry.kind === 'potion') { p.potions++; audio.play('potion_pickup'); }
    else if (entry.kind === 'elixir') {
      const e = entry.elixir;
      p.inventory.push({ id: newItemId(), slot: 'consumable', consumable: true, icon: e.icon, name: e.name, rarity: e.rarity, buff: e.buff, effectLabel: e.label, stats: {} });
      audio.play('potion_pickup');
    } else if (entry.kind === 'bag') {
      p.invSize = Math.min(24, p.invSize + 3);
      this.ui.floaters.spawn(p.pos, '🎒 +3 inventory slots!', 'crit');
    } else if (entry.kind === 'gear') {
      p.inventory.push(entry.item);
      audio.play('gear_pickup');
    } else if (entry.kind === 'gamble') {
      const item = gambleItem(this.floor);
      p.inventory.push(item);
      audio.play('gear_pickup');
      if (item.rarity === 'legendary') { // the pinnacle EPIC — fate's rarest gift
        audio.play('level_up');
        this.particles.burst(p.pos.x, 1.2, p.pos.z, 60, 0xff8c1a, { speed: 6, life: 1.2 });
        this.shake(0.6);
        // Zoltan marvels at it aloud, by name (his own Kokoro voice)
        roaster.speakAs(`By fate's own hand… a ${item.name}! In all my years I have never drawn its like. Wow. Take it — quickly, before the cards change their minds.`,
          { female: false, vi: 3, pitch: 0.85, rate: 0.88, kokoro: 'bm_george', kSpeed: 0.88 });
      } else if (item.rarity === 'epic') { // Super Rare (purple)
        audio.play('level_up');
        this.particles.burst(p.pos.x, 1.2, p.pos.z, 40, 0xa03bd9, { speed: 5, life: 1 });
        this.shake(0.4);
      }
      this._gambleReadyAt = performance.now() + 6000; // fate must rest
      this.ui.showRelicReveal(item); // pop up what fate handed over
    }
    this.requestSave();
  }

  sellItem(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1) return;
    p.inventory.splice(idx, 1);
    p.gold += sellValue(item);
    audio.play('coin_pickup');
    this.requestSave();
  }

  // Heroes currently in the room (0 = single player, badge hidden).
  roomPlayerCount() {
    if (!net.active) return 0;
    return net.isHost ? 1 + net.conns.size : Math.max(2, (net.lastRoster?.length || 2));
  }

  // Quest log data: main quest chain (one act boss per act) + run stats.
  questState() {
    const themeNames = [null, 'The Old Halls', 'The Rotting Depths', 'The Ember Vaults', 'The Sunless Court', 'The Abyssal Throne'];
    const current = Math.min(5, this.actsCleared + 1);
    const acts = [];
    for (let a = 1; a <= 5; a++) {
      acts.push({
        act: a,
        title: `Act ${ROMAN[a]} — ${themeNames[a]}`,
        objective: `Slay ${ACT_BOSSES[a].name}`,
        cleared: this.actsCleared >= a,
        current: !this.bossDefeated && a === current,
      });
    }
    const p = this.player;
    const legendaries = p
      ? [...p.inventory, ...Object.values(p.equipped)].filter((i) => i && i.rarity === 'legendary').length
      : 0;
    return {
      acts,
      done: this.bossDefeated,
      stats: {
        Floor: this.inTown ? `Embervale (checkpoint ${this.floor})` : this.floorLabelText(),
        Level: p?.level ?? 1,
        'Monsters slain': this.kills,
        'Elites slain': this.elitesKilled,
        Deaths: this.deaths,
        Gold: p?.gold ?? 0,
        'Legendaries owned': legendaries,
        'Pack size': `${p?.invSize ?? 12} slots`,
      },
    };
  }

  // Short objective line for the HUD.
  currentObjectiveText() {
    if (this.bossDefeated) return 'Victory won — the endless abyss beckons';
    const act = Math.min(5, this.actsCleared + 1);
    const boss = ACT_BOSSES[act].name;
    if (!this.inTown && actFloorOf(this.floor) === 10 && actOfFloor(this.floor) === act) return `☠️ Slay ${boss}!`;
    return `Hunt ${boss} (Act ${ROMAN[act]})`;
  }

  // Story cards: shown once per save, at each act's threshold.
  showStory(key) {
    if (!STORIES[key] || this.storySeen.includes(key)) return;
    this.storySeen.push(key);
    this.requestSave();
    this._storyReturn = this.state === 'playing' ? 'playing' : this.state;
    this.state = 'story';
    this.ui.showStory(STORIES[key]);
  }

  toggleSkills() {
    if (this.state === 'playing') {
      this.state = 'skills';
      this.ui.openSkills();
    } else if (this.state === 'skills') {
      this.state = 'playing';
      this.ui.hideAll();
    }
  }

  buySkill(id) {
    if (!this.player) return;
    if (this.player.addSkillRank(id)) {
      audio.play('level_up', { volume: 0.35, rate: 1.6 });
      this.requestSave();
      this.ui.openSkills();
    }
  }

  toggleQuestLog() {
    if (this.state === 'playing') {
      this.state = 'quest';
      this.ui.openQuestLog();
    } else if (this.state === 'quest') {
      this.state = 'playing';
      this.ui.hideAll();
    }
  }

  // ---------------- tavern folk + notice board ----------------
  barkeepChat() {
    const p = this.player;
    const n = this.playerName();
    const lines = [];
    if (p.hp < p.maxHp * 0.6) lines.push(`${n}, rough night? Sit by the fire, the hearth mends what potions can't.`);
    if (this.deaths >= 3) lines.push('Heard the floor\'s been winning. It always brags. Ignore it.');
    if (this.actsCleared >= 1) lines.push(`Word travels — ${['', 'Malruk', 'Sszarra', 'Vexmal', 'the Colossus'][this.actsCleared] || 'the lords'} fell to you. First round's full price anyway.`);
    lines.push(
      'Welcome to the Sleeping Golem. He\'s out back. Still sleeping.',
      `${n}, Zoltan's dice are loaded. Course they are. Doesn't mean they won't love you.`,
      'The bard quit. Said the dungeon "hummed in the wrong key". So it\'s just the fire and me.',
    );
    const line = lines[Math.floor(Math.random() * lines.length)];
    const b = this.dungeonMeshes.barkeepPos;
    this.ui.showSubtitle('Barlow the Barkeep', line);
    roaster.speakAs(line, { female: false, vi: 5, pitch: 0.8, rate: 0.95, kokoro: 'am_liam', kSpeed: 0.95 });
  }

  patronChat(pm) {
    const drunkLines = [
      'I saw the Dungeon Lord once. *hic* Or a very tall barrel. One of those.',
      '*hic* You\'re my besht friend. Whoever you are.',
      'I found a legendary sword once. *hic* Then I sat on it. Long story.',
    ];
    const soberLines = [
      'Fenwick\'s mad, but he\'s never wrong. Worst combination.',
      'They say the elites wear crowns because the stairs obey them. Kill the crown, free the stairs.',
      'Maribel restocks whenever you come back through the portal. Handy woman.',
    ];
    const bank = pm.drunk ? drunkLines : soberLines;
    const line = bank[Math.floor(Math.random() * bank.length)];
    this.ui.showSubtitle(pm.drunk ? 'Tipsy Regular' : 'Tavern Patron', line);
    roaster.speakAs(line, pm.drunk
      ? { female: false, vi: 6, pitch: 1.05, rate: 0.8, kokoro: 'bm_daniel', kSpeed: 0.82 }
      : { female: true, vi: 3, pitch: 1.05, rate: 1.0, kokoro: 'af_sarah', kSpeed: 1.0 });
  }

  openNotices() {
    this.state = 'notices';
    this.ui.openNotices(this.buildNotices());
  }

  buildNotices() {
    const act = Math.min(5, this.actsCleared + 1);
    const boss = ACT_BOSSES[act].name;
    const flavor = [
      'LOST: one cat, answers to "Whiskers". Last seen entering the dungeon. Do NOT bring back whatever answers to Whiskers now.',
      'Zoltan\'s Mystery Relics: all sales final. Fate offers no refunds. — Z.',
      'RUMOR: travelers\' satchels seen on the strongest fiends below. Cut them open, carry more home.',
      'The well is NOT a portal. Stop jumping in. — the Town',
    ];
    return [
      { title: `⚔️ BOUNTY: ${boss}`, text: `By order of Embervale: the lord of Act ${['', 'I', 'II', 'III', 'IV', 'V'][act]} holds the deep seal. Slay it and the way below opens. Reward: the road onward, and whatever it drops.` },
      { title: '📜 DECREE OF THE STAIRS', text: 'The stair-seals hold until seven of every ten fiends on a floor are cut down AND the crowned elite falls. Pits are exempt. Fall at your own peril.' },
      { title: '📌 NOTICE', text: flavor[Math.floor(Math.random() * flavor.length)] },
    ];
  }

  restockFee(vendor) {
    return vendor.type === 'mystery' ? 60 : 25;
  }

  restockVendor(vendor) {
    const fee = this.restockFee(vendor);
    if (this.player.gold < fee) return;
    this.player.gold -= fee;
    vendor.stock = this.makeVendorStock(vendor);
    audio.play('coin_pickup');
    this.ui.renderShop(vendor);
    this.requestSave();
  }

  openShop(vendor) {
    this.activeVendor = vendor;
    this.state = 'shop';
    this.touch.setVisible(false); // touch buttons aren't needed at a counter
    this.ui.openShop(vendor);
    this.greetFromVendor(vendor);
  }

  // Vendors greet you by name, each in their own voice — and they READ you:
  // health, potions, gold, gear. No "you look wounded" at full health.
  greetFromVendor(vendor) {
    const n = this.playerName();
    const p = this.player;
    const hurt = p.hp < p.maxHp * 0.6;
    const rich = p.gold > 300;
    const lines = { potions: [], gear: [], mystery: [] };

    // Maribel — health/potion aware
    if (hurt) lines.potions.push(`Oh dear, ${n}, you're hurt. Sit, drink, live.`);
    else if (p.potions === 0) lines.potions.push(`${n}, an empty satchel? Never descend without a red bottle.`);
    else lines.potions.push('Potions, fresh from the still.', `Welcome back, ${n}, drink responsibly, dear.`, 'You look well! Let’s keep it that way.');

    // Torvald — gear aware
    const weapon = p.equipped.weapon;
    if (!weapon) lines.gear.push(`${n}, bare-handed?! By the forge, take a blade before the deep takes you.`);
    else if (weapon.rarity === 'common') lines.gear.push('That old iron of yours has seen better days. Browse a while.');
    else lines.gear.push(`${n}, steel for the worthy. Pick a blade.`, 'The forge burned all night for this.');

    // Zoltan — gold aware
    if (rich) lines.mystery.push(`${n}, that's ${p.gold} gold — fate can hear it jingling from here.`);
    else if (p.gold < 100) lines.mystery.push('Light pockets today… fate does not work on credit, friend.');
    else lines.mystery.push(`${n}, fate has been expecting you.`, 'Care to tempt destiny?');
    // unique voices: no vendor shares a voice with any enemy or each other
    const casts = {
      potions: { female: true, vi: 2, pitch: 1.2, rate: 1.02, kokoro: 'af_bella', kSpeed: 1.0 },
      gear: { female: false, vi: 2, pitch: 0.6, rate: 0.95, kokoro: 'am_michael', kSpeed: 0.92 },
      mystery: { female: false, vi: 3, pitch: 0.85, rate: 0.88, kokoro: 'bm_george', kSpeed: 0.88 },
    };
    const bank = lines[vendor.type] || lines.gear;
    const line = bank[Math.floor(Math.random() * bank.length)];
    this.ui.showSubtitle(vendor.name, line);
    roaster.speakAs(line, casts[vendor.type] || casts.gear);
  }

  closeShop() {
    this.activeVendor = null;
    this.state = 'playing';
    this.ui.hideAll();
    this.touch.setVisible(true);
    this.shopCooldown = 1.5;
    audio.play('ui_close');
  }

  // Town is an open evening square: brighter, bluer, softer fog than the dungeon.
  setTownAtmosphere(on) {
    if (on) {
      this.scene.background = new THREE.Color(0x151d30);
      this.scene.fog = new THREE.Fog(0x151d30, 24, 52);
      this.ambient.color.setHex(0x9aa4c8);
      this.ambient.intensity = 0.85;
      // no "flashlight" under the open sky — just a faint presence
      this.playerLight.intensity = 5;
      this.playerLight.distance = 6;
    } else {
      this.scene.background = new THREE.Color(0x08060c);
      this.scene.fog = new THREE.Fog(0x08060c, 18, 42);
      this.ambient.color.setHex(0x8a7a9a);
      this.ambient.intensity = 0.55;
      // underground the hero carries the light
      this.playerLight.intensity = 40;
      this.playerLight.distance = 14;
    }
  }

  loadFloor(floor) {
    this.teardownFloor();
    this.inTown = false;
    this.inTavern = false;
    this.setTownAtmosphere(false);
    this._floorLoadedAt = performance.now(); // for anti-cheat clear-speed checks
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

    // Safe zone: the ring around the return portal. Inside it the player takes
    // no damage and enemies won't path in — a breather beside the way home.
    // (Boss floors have no return portal, so no safe zone — you must fight.)
    this.safeZone = this.dungeonMeshes.returnPortalMesh ? { x: spawn.x, z: spawn.z, r: 3.2 } : null;

    // enemies — stats scale up with connected player count in multiplayer
    const mpMult = 1 + 0.5 * (net.playerCount - 1);
    for (const spec of this.dungeon.enemies) {
      const e = new Enemy(spec.type, floor > MAX_FLOOR ? floor + 2 : floor, { miniboss: spec.miniboss, elite: spec.elite });
      const w = tileToWorld(spec.x, spec.y);
      e.pos.set(w.x, 0, w.z);
      e.mesh.position.copy(e.pos);
      this.applyMpScaling(e, mpMult);
      e.netId = ++this.netEnemySeq;
      this.scene.add(e.mesh);
      this.enemies.push(e);
    }

    // act boss (the final one stays dead once slain)
    if (this.dungeon.boss && !(actOfFloor(floor) === 5 && this.bossDefeated)) {
      this.boss = new Boss(floor);
      const w = tileToWorld(this.dungeon.boss.x, this.dungeon.boss.y);
      this.boss.pos.set(w.x, 0, w.z);
      this.boss.mesh.position.copy(this.boss.pos);
      this.applyMpScaling(this.boss, mpMult);
      this.boss.netId = ++this.netEnemySeq;
      this.scene.add(this.boss.mesh);
      this.enemies.push(this.boss);
      audio.play('boss_roar', { volume: 0.9 });
    }

    // Stairs are sealed until 70% of the floor is culled AND the elite falls.
    this.floorEnemyTotal = this.enemies.filter((e) => !e.isBoss).length;
    this.floorKills = 0;
    this._stairsWasLocked = this.stairsLocked();
    this._sealNoticeT = 0;

    this.setupTorchLights(theme);
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(this.floorBannerTitle(), theme.name, true);
    audio.playMusic(this.dungeon.boss && this.boss ? 'boss' : 'dungeon');
    audio.play('stairs', { volume: 0.7 });
    this.stairsCooldown = 1.5;
    this.returnPortalArmed = false; // arms once you walk away from the entrance
    this.requestSave(true);

    if (net.isHost) this.broadcastWorld();

    // act-opening lore card, once per save
    if (floor <= MAX_FLOOR && actFloorOf(floor) === 1) {
      this.showStory('act' + actOfFloor(floor));
    }
  }

  currentAct() { return actOfFloor(Math.min(this.floor, MAX_FLOOR)); }

  floorBannerTitle() {
    if (this.floor > MAX_FLOOR) return `THE ENDLESS ABYSS — ${this.floor}`;
    const act = actOfFloor(this.floor), af = actFloorOf(this.floor);
    return af === 10 ? `ACT ${ROMAN[act]} — THE LORD'S ARENA` : `ACT ${ROMAN[act]} · FLOOR ${af}`;
  }

  floorLabelText() {
    if (this.inTavern) return '🍺 The Sleeping Golem';
    if (this.inTown) return '🏘️ Embervale';
    if (this.floor > MAX_FLOOR) return `🌀 Depths ${this.floor}`;
    const act = actOfFloor(this.floor), af = actFloorOf(this.floor);
    return af === 10 ? `Act ${ROMAN[act]} · ☠️ Boss` : `Act ${ROMAN[act]} · Floor ${af}`;
  }

  applyMpScaling(e, mult) {
    if (mult <= 1) return;
    e.maxHp = Math.round(e.maxHp * mult);
    e.hp = e.maxHp;
    e.damage *= 1 + (mult - 1) * 0.5;
  }

  setupTorchLights(theme) {
    // Per-act atmosphere: tint the fog + background to the theme's mood so each
    // act reads differently and corridor ends fade into colored murk.
    const atmo = {
      'The Old Halls':      { fog: 0x0b0910, near: 15, far: 38 },
      'The Rotting Depths': { fog: 0x0a1510, near: 14, far: 34 },
      'The Ember Vaults':   { fog: 0x180a07, near: 14, far: 33 },
      'The Sunless Court':  { fog: 0x0e0a1c, near: 15, far: 36 },
      'The Abyssal Throne': { fog: 0x07121a, near: 12, far: 30 },
    }[theme.name] || { fog: 0x08060c, near: 16, far: 36 };
    this.scene.background = new THREE.Color(atmo.fog);
    this.scene.fog = new THREE.Fog(atmo.fog, atmo.near, atmo.far);

    const maxLights = { low: 5, medium: 10, high: 18 }[this.settings.quality] || 10;
    const count = Math.min(maxLights, this.dungeonMeshes.torchPositions.length);
    for (let i = 0; i < count; i++) {
      // warmer, brighter, a touch longer reach so torch-lit rooms glow
      const l = new THREE.PointLight(theme.accent, 16, 11, 1.8);
      this.scene.add(l);
      this.torchLights.push(l);
    }
    this.torchAssignTimer = 0;
  }

  // ---------------- multiplayer wiring ----------------
  wireNet() {
    // --- host side ---
    net.on('guest_joined', ({ id }) => {
      if (this.player && this.dungeon) this.broadcastWorld(id);
    });
    net.on('guest_left', ({ id }) => {
      const rp = this.remotePlayers.get(id);
      if (this.player && rp?.name) this.ui.floaters.spawn(this.player.pos, `${rp.name} has left.`, 'xp');
      this.removeRemotePlayer(id);
    });
    net.on('hello', (msg, from) => {
      // Only announce a genuinely new hero; a guest re-sending `hello` for one we
      // already track must not spam join notices onto everyone's screen.
      const known = this.remotePlayers.has(from);
      this.ensureRemotePlayer(from, msg.cls, msg.name);
      this.sendLoadout(); // let the (re)joining hero see our gear
      if (known) return;
      if (this.player) this.ui.floaters.spawn(this.player.pos, `${msg.name || 'A hero'} has joined!`, 'crit');
      net.send({ t: 'notice', txt: `${msg.name || 'A hero'} has joined the room!` });
    });
    net.on('pos', (msg, from) => {
      const rp = this.ensureRemotePlayer(from, msg.cls);
      rp.target.set(msg.x, 0, msg.z);
      rp.aim = msg.aim;
      rp.moving = !!msg.mv;
      rp.dead = !!msg.dead;
      rp.zone = msg.aw | 0;
      rp.away = rp.zone !== 0;
      rp.level = msg.lvl || 1; rp.hp = msg.hp || 0; rp.maxHp = msg.mhp || 0;
      rp.aura = msg.au || 0; this.setHeroAura(rp.mesh, rp.aura);
    });
    net.on('dmg', (msg, from) => {
      if (!net.isHost) return; // only the authoritative host applies guest damage
      const e = this.enemies.find((en) => en.netId === msg.ei && !en.dead);
      if (!e) return;
      const rp = this.remotePlayers.get(from);
      // Guest-reported damage is a CLAIM, never trusted: clamp it so a tampered
      // client can't one-shot the host's encounter. Ceiling scales with the
      // sender's level; status/knockback are re-derived, not taken at face value.
      const cap = 50 + (rp?.level || 1) * 40;
      const amt = Math.min(Math.max(1, msg.a | 0), cap);
      const kb = Math.min(Math.max(0, msg.kb || 0), 6);
      this.damageEnemy(e, amt, {
        dot: true, // damage already rolled on the guest; no double crit
        status: this.sanitizeGuestStatus(msg.st, cap),
        knockback: kb || undefined,
        kbFrom: rp ? rp.target : e.pos,
      });
    });
    net.on('portal', (msg, from) => {
      if (!net.isHost || this.stairsCooldown > 0) return;
      // A guest can only descend the party if it's actually standing at the
      // stairs — verify its last known position so it can't yank everyone down
      // from across the floor. (Town has no stairs gate.)
      if (!this.inTown && this.dungeon?.stairs) {
        const rp = this.remotePlayers.get(from);
        const w = tileToWorld(this.dungeon.stairs.x, this.dungeon.stairs.y);
        const p = rp?.target;
        if (!p || Math.hypot(p.x - w.x, p.z - w.z) > 3.5) return;
      }
      if (!this.inTown && this.stairsLocked()) {
        net.send({
          t: 'notice',
          txt: `Sealed! Cull the horde (${this.floorKills}/${this.stairsClearNeed()})`,
        }, from);
        return;
      }
      this.stairsCooldown = 1.5;
      if (this.inTown) this.loadFloor(this.floor);
      else if (this.dungeon.stairs) this.loadFloor(this.floor + 1);
    });
    net.on('townportal', () => {
      if (!net.isHost || this.stairsCooldown > 0 || this.inTown) return;
      this.stairsCooldown = 1.5;
      this.loadTown({ fromDungeon: true });
    });

    // --- guest side ---
    net.on('world', (msg) => {
      this.lastWorldMsg = msg;
      if (!this.player) return;
      // guests browsing their own town are not dragged along
      if (this.localTown) return;
      this.applyWorld(msg);
    });
    net.on('roast', (msg) => {
      if (net.isHost || !this.player) return;
      // Don't hear dungeon enemies while you're in town/tavern, or when they're
      // too far away to matter — only taunts near you, in your zone.
      if (this.inTown || this.localTown || this.myZone() !== 0) return;
      const e = this.enemies.find((en) => en.netId === msg.ei && !en.dead);
      if (!e) return;
      const d = Math.hypot(e.pos.x - this.player.pos.x, e.pos.z - this.player.pos.z);
      if (d > 18) return;
      this.ui.floaters.spawn(e.pos, `“${msg.txt}”`, 'roast', 6);
      roaster.speak(msg.txt, msg.ty);
    });
    net.on('state', (msg) => {
      if (net.isHost || !this.player) return;
      const myId = net.peer?.id;
      for (const pl of msg.pl) {
        if (pl.id === myId) continue;
        const rp = this.ensureRemotePlayer(pl.id, pl.cls, pl.nm);
        rp.target.set(pl.x, 0, pl.z);
        rp.aim = pl.aim;
        rp.moving = !!pl.mv;
        rp.dead = !!pl.dead;
        rp.zone = pl.aw | 0;
        rp.away = rp.zone !== 0;
        rp.level = pl.lvl || 1; rp.hp = pl.hp || 0; rp.maxHp = pl.mhp || 0;
        rp.aura = pl.au || 0; this.setHeroAura(rp.mesh, rp.aura);
      }
      // town browsers still see fellow townsfolk, but not dungeon state
      if (this.localTown) return;
      const seen = new Set(msg.pl.map((p) => p.id));
      for (const id of [...this.remotePlayers.keys()]) {
        if (!seen.has(id) && id !== myId) this.removeRemotePlayer(id);
      }
      for (const en of msg.en) {
        const [id, x, z, hp] = en;
        const m = this.enemies.find((e) => e.netId === id);
        if (m && !m.dead) { m.targetPos.set(x, 0, z); m.hp = hp; }
      }
    });
    net.on('espawn', (msg) => {
      if (!net.isHost && this.player) this.addEnemyMirror(msg.e);
    });
    net.on('edead', (msg) => {
      if (net.isHost || !this.player) return;
      const m = this.enemies.find((e) => e.netId === msg.id);
      if (m && !m.dead) {
        m.dead = true;
        this.scene.remove(m.mesh);
        this.kills++;
        this.floorKills++;
        if (m.def) audio.play(m.def.sounds.death, { pos: m.pos, volume: 0.85 });
        this.particles.burst(msg.x, 0.8, msg.z, 22, 0xd8d4c8, { speed: 4, life: 0.7 });
      }
      this.player.gainXp(msg.xp, this);
      this.rollDeathLoot(msg.x, msg.z, { miniboss: msg.mb, isBoss: msg.boss });
      if (msg.boss) {
        this.actsCleared = Math.max(this.actsCleared, this.currentAct());
        if (this.currentAct() < 5 && this.floor <= MAX_FLOOR) {
          this.spawnActExit(msg.x, msg.z);
          this.ui.showFloorBanner(`ACT ${ROMAN[this.currentAct()]} CLEARED`, 'The way deeper opens…', true);
        } else {
          this.bossDefeated = true;
          this.onVictory();
        }
      }
    });
    net.on('ehit', (msg) => {
      if (!net.isHost && this.player && !this.player.dead) this.player.takeDamage(msg.dmg, this);
    });
    net.on('eproj', (msg) => {
      if (!net.isHost) {
        this.projectiles.spawn({
          x: msg.x, z: msg.z, dir: { x: msg.dx, z: msg.dz }, speed: msg.sp,
          radius: 0.35, damage: msg.dmg, friendly: false, color: msg.c, size: msg.s || 0.22,
        });
      }
    });
    net.on('host_left', () => this.onHostLost());
    net.on('peers', (msg) => {
      net.lastRoster = msg.ids;
      voice.syncPeers(msg.ids);
    });
    net.on('chat', (msg, from) => {
      // Identity is bound to the connection the host tracks, never to the
      // self-reported payload name — so a guest can't render chat under another
      // hero's name. Relayed messages (from === 'host') were already relabeled.
      const name = from === 'host'
        ? (msg.name || 'Hero')
        : (this.remotePlayers.get(from)?.name || 'Hero');
      // host relays a guest's chat to the OTHER guests (not the sender)
      if (net.isHost && from !== 'host') net.sendExcept({ t: 'chat', name, txt: msg.txt, ts: msg.ts }, from);
      this.ui.addChatMessage(name, msg.txt, msg.ts, false);
    });
    net.on('notice', (msg, from) => {
      if (from !== 'host') return; // only the host issues notices; ignore guest-crafted spam
      if (this.player) this.ui.floaters.spawn(this.player.pos, msg.txt, 'crit', 5);
    });
    net.on('death', (msg, from) => {
      // a hero fell somewhere in the shared dungeon — mark it for everyone
      if (!this.inTown) this.spawnDeathSkeleton(msg.x, msg.z);
      if (net.isHost && from !== 'host') net.sendExcept({ t: 'death', x: msg.x, z: msg.z }, from);
    });
    net.on('cheatlock', (msg, from) => {
      if (this.player) this.ui.floaters.spawn(this.player.pos, '⛔ A cheater was caught and frozen', 'crit', 4);
      if (net.isHost && from !== 'host') net.sendExcept({ t: 'cheatlock' }, from);
    });
    net.on('drop', (msg, from) => {
      // another hero dropped an item — show it on the ground for everyone
      if (msg.item && !this.inTown) this.loot.dropGear(msg.x, msg.z, msg.item, msg.did);
      if (net.isHost && from !== 'host') net.sendExcept(msg, from);
    });
    net.on('pickup', (msg, from) => {
      this.loot.removeByDid(msg.did); // someone took it — clear it from my ground
      if (net.isHost && from !== 'host') net.sendExcept(msg, from);
    });
    net.on('loadout', (msg, from) => {
      const id = msg.pid || from; // host relays carry the original owner's id
      const rp = this.remotePlayers.get(id);
      if (rp) rp.loadout = msg.eq;
      if (net.isHost && from !== 'host') net.sendExcept({ t: 'loadout', eq: msg.eq, pid: from }, from);
    });
    net.on('room_full', () => {
      net.stop();
      alert('That room already has 4 heroes.');
    });
  }

  // The simulating peer left. The room lives on: lowest surviving id takes
  // over the simulation; everyone else quietly reconnects.
  async onHostLost() {
    if (!this.player || this._migrating) { if (!this.player) net.stop(); return; }
    this._migrating = true;
    const myId = net.peer?.id;
    const survivors = (net.lastRoster || []).filter((id) => id !== net.roomId && id !== undefined);
    const shouldHost = survivors.length === 0 || myId === [...survivors].sort()[0];
    this.ui.floaters.spawn(this.player.pos, 'A hero departed — holding the room…', 'xp');
    const res = await net.migrate(shouldHost);
    this._migrating = false;
    if (res.mode === 'error') {
      alert('The room was lost. Returning to town in single player.');
      net.stop();
      this.clearRemotePlayers();
      this.localTown = false;
      if (!this.inTown) this.loadTown();
      return;
    }
    if (res.mode === 'host') {
      this.becomeSimulationOwner();
      voice.attachToPeer(net.peer);
      if (this.settings.voiceMode !== 'off') voice.enable(this.settings.voiceMode, this.settings.voiceThreshold);
      net.broadcastRoster();
    } else {
      net.send({ t: 'hello', cls: this.player.classId, name: this.playerName() });
      this.ui.floaters.spawn(this.player.pos, 'Room restored.', 'heal');
    }
  }

  // Promote guest mirrors into real simulated enemies (same ids, hp, spots).
  becomeSimulationOwner() {
    this.clearRemotePlayers();
    const mirrors = this.enemies.filter((e) => e.mirror && !e.dead);
    const real = [];
    let maxId = this.netEnemySeq;
    for (const mo of mirrors) {
      const e = mo.isBoss ? new Boss(this.floor) : new Enemy(mo.typeId, this.floor, { miniboss: mo.miniboss, elite: mo.elite });
      e.maxHp = mo.maxHp;
      e.hp = mo.hp;
      e.pos.copy(mo.pos);
      e.mesh.position.copy(mo.pos);
      e.netId = mo.netId;
      e.state = 'chase';
      maxId = Math.max(maxId, mo.netId);
      this.scene.remove(mo.mesh);
      this.scene.add(e.mesh);
      real.push(e);
      if (mo.isBoss) this.boss = e;
    }
    this.enemies = this.enemies.filter((e) => !e.mirror).concat(real);
    this.netEnemySeq = maxId;
    this.ui.floaters.spawn(this.player.pos, 'The room is yours to hold.', 'heal');
  }

  serializeEnemy(e) {
    return {
      id: e.netId, ty: e.typeId, x: e.pos.x, z: e.pos.z,
      hp: e.hp, mhp: e.maxHp, mb: e.miniboss, el: e.elite, boss: !!e.isBoss, name: e.name,
    };
  }

  broadcastWorld(toId = null) {
    net.send({
      t: 'world',
      floor: this.floor,
      inTown: this.inTown,
      dungeon: this.dungeon,
      enemies: this.enemies.filter((e) => !e.dead).map((e) => this.serializeEnemy(e)),
      fk: this.floorKills, fe: this.floorEnemyTotal,
    }, toId);
  }

  // Guest: rebuild the world from the shared snapshot.
  applyWorld(msg) {
    this.teardownFloor();
    this.inTown = !!msg.inTown;
    this.localTown = this.inTown; // arriving in a town = your own peaceful copy
    this.floor = msg.floor;
    this.dungeon = msg.dungeon;
    const theme = themeForFloor(this.inTown ? 1 : this.floor);
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme);
    this.scene.add(this.dungeonMeshes.group);
    this.openedDoors = new Set();
    this.setTownAtmosphere(this.inTown);
    if (this.inTown) {
      for (const v of this.dungeonMeshes.vendorMeshes) v.stock = this.makeVendorStock(v);
      this.wanderer = new Wanderer(this.dungeon, this.scene);
    }
    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.player.dead = false;
    for (const spec of msg.enemies || []) this.addEnemyMirror(spec);
    this.floorKills = msg.fk || 0;
    this.floorEnemyTotal = msg.fe || 0;
    this.setupTorchLights(theme);
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(
      this.inTown ? 0 : this.floorBannerTitle(),
      this.inTown ? 'Embervale — rest, trade, prepare' : theme.name,
      !this.inTown
    );
    audio.playMusic(this.inTown ? 'tavern' : (this.dungeon.boss ? 'boss' : 'dungeon'));
    this.stairsCooldown = 1.5;
  }

  // Guest-side lightweight enemy stand-in (host runs the real AI).
  addEnemyMirror(spec) {
    if (this.enemies.some((e) => e.netId === spec.id)) return;
    const mesh = spec.boss ? buildBossMesh() : buildEnemyMesh(spec.ty, spec.mb ? 1.5 : spec.el ? 1.25 : 1);
    mesh.position.set(spec.x, 0, spec.z);
    this.scene.add(mesh);
    this.enemies.push({
      netId: spec.id, typeId: spec.ty,
      def: ENEMY_TYPES[spec.ty] || ENEMY_TYPES.golem,
      pos: new THREE.Vector3(spec.x, 0, spec.z),
      targetPos: new THREE.Vector3(spec.x, 0, spec.z),
      radius: spec.boss ? 1.0 : (ENEMY_TYPES[spec.ty]?.radius || 0.4) * (spec.mb ? 1.4 : 1),
      hp: spec.hp, maxHp: spec.mhp,
      miniboss: spec.mb, elite: spec.el, isBoss: spec.boss, name: spec.name,
      dead: false, state: 'chase', hitFlash: 0, mesh,
      mirror: true,
    });
    if (spec.boss) this.boss = this.enemies[this.enemies.length - 1];
  }

  updateGuestMirrors(dt) {
    for (const m of this.enemies) {
      if (m.dead) continue;
      m.pos.lerp(m.targetPos, Math.min(1, 12 * dt));
      m.mesh.position.copy(m.pos);
      if (!this.player.dead) {
        m.mesh.rotation.y = Math.atan2(this.player.pos.x - m.pos.x, this.player.pos.z - m.pos.z);
      }
      // animate mirrored mobs on the guest too (they're always pursuing)
      if (typeof m._animateGait === 'function') { m.state = 'chase'; m._animateGait(dt); }
      m.hitFlash = Math.max(0, m.hitFlash - dt);
      m.mesh.traverse((o) => {
        if (o.isMesh && o.material?.emissive !== undefined) {
          o.material.emissive.setScalar(m.hitFlash > 0 ? 0.6 : 0);
        }
      });
    }
  }

  // Cosmetic aura tier from the best-equipped rarity: 2 = Epic (gold),
  // 1 = Super Rare (purple), 0 = none. Visible to the whole room.
  heroAuraTier(equipped = this.player?.equipped) {
    if (!equipped) return 0;
    let tier = 0;
    for (const it of Object.values(equipped)) {
      if (!it) continue;
      if (it.rarity === 'legendary') return 2;
      if (it.rarity === 'epic') tier = 1;
    }
    return tier;
  }

  // Attach/refresh a glowing ground ring + orbiting sparkles on a hero mesh.
  setHeroAura(mesh, tier) {
    if (!mesh || mesh.userData.auraTier === tier) return;
    mesh.userData.auraTier = tier;
    if (mesh.userData.auraGroup) { mesh.remove(mesh.userData.auraGroup); mesh.userData.auraGroup = null; }
    if (!tier) return;
    const color = tier >= 2 ? 0xffd24a : 0xb060ff;
    const grp = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.62, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    grp.add(ring);
    const sparkles = new THREE.Group();
    const n = tier >= 2 ? 6 : 4;
    const sMat = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 5), sMat);
      const a = (i / n) * Math.PI * 2;
      s.position.set(Math.cos(a) * 0.55, 0.6 + Math.sin(a * 2) * 0.3, Math.sin(a) * 0.55);
      sparkles.add(s);
    }
    grp.add(sparkles);
    grp.userData.sparkles = sparkles;
    mesh.add(grp);
    mesh.userData.auraGroup = grp;
  }

  // Keep the local hero's aura in sync and spin every hero's sparkles.
  animateAuras(dt) {
    if (this.player?.mesh) this.setHeroAura(this.player.mesh, this.heroAuraTier());
    const spin = (mesh) => { const g = mesh?.userData?.auraGroup; if (g) g.userData.sparkles.rotation.y += dt * 1.6; };
    spin(this.player?.mesh);
    for (const [, rp] of this.remotePlayers) spin(rp.mesh);
  }

  // A compact snapshot of the equipped gear, for co-op inspect panels.
  compactLoadout() {
    const out = {};
    for (const slot of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket']) {
      const it = this.player.equipped[slot];
      out[slot] = it ? { icon: it.icon, name: it.name, rarity: it.rarity, slot: it.slot, stats: it.stats, affinity: it.affinity || null } : null;
    }
    return out;
  }

  // Broadcast our loadout so others can inspect us (sent on equip changes + join).
  sendLoadout() {
    if (net.active) net.send({ t: 'loadout', eq: this.compactLoadout() });
  }

  // Click a co-op hero to inspect their gear (Diablo-style). Returns true if a
  // player was hit, so the click doesn't also trigger an attack.
  tryInspectClick() {
    const input = this.input;
    if (!net.active || !input.mouse.clicked || this.state !== 'playing' || !this.remotePlayers.size) return false;
    this._mouseNdc.set((input.mouse.x / window.innerWidth) * 2 - 1, -(input.mouse.y / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this._mouseNdc, this.camera);
    const visible = [...this.remotePlayers.values()].filter((rp) => rp.mesh && rp.mesh.visible);
    const hits = this.raycaster.intersectObjects(visible.map((rp) => rp.mesh), true);
    if (!hits.length) return false;
    const rp = visible.find((r) => {
      let o = hits[0].object;
      while (o) { if (o === r.mesh) return true; o = o.parent; }
      return false;
    });
    if (rp) { this.ui.showInspect(rp); return true; }
    return false;
  }

  ensureRemotePlayer(id, cls = 'knight', name = null) {
    let rp = this.remotePlayers.get(id);
    if (rp) {
      if (name && rp.name !== name) { rp.name = name; this.updateNametag(rp, false); }
      return rp;
    }
    const anim = buildAnimatedHero(cls);
    const mesh = anim ? anim.mesh : buildHeroMesh(CLASSES[cls] || CLASSES.knight);
    this.scene.add(mesh);
    rp = { mesh, anim, cls, name: name || 'Hero', target: new THREE.Vector3(), aim: 0, moving: false, dead: false, away: false, level: 1, hp: 0, maxHp: 0 };
    this.updateNametag(rp, false);
    this.remotePlayers.set(id, rp);
    return rp;
  }

  // Floating nameplate above a remote hero: NAME + Lv always, plus a health bar
  // while in the dungeon. Redraws only when the content actually changes.
  updateNametag(rp, showHealth) {
    const name = rp.name || 'Hero';
    const lvl = rp.level || 1;
    const hpFrac = rp.maxHp > 0 ? Math.max(0, Math.min(1, rp.hp / rp.maxHp)) : 0;
    const key = `${name}|${lvl}|${showHealth ? 1 : 0}|${Math.round(hpFrac * 40)}`;
    if (rp.tag && rp._tagKey === key) return;
    rp._tagKey = key;
    if (!rp.tag) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 96;
      rp._tagCanvas = canvas;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sprite.scale.set(2.7, 1.0, 1);
      this.scene.add(sprite);
      rp.tag = sprite;
    }
    const ctx = rp._tagCanvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 96);
    ctx.font = 'bold 30px Georgia';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = `${name}  Lv ${lvl}`;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(label, 128, 26);
    ctx.fillStyle = '#e8dcae'; ctx.fillText(label, 128, 26);
    if (showHealth && rp.maxHp > 0) {
      const bw = 200, bh = 16, bx = 28, by = 56;
      ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
      ctx.fillStyle = '#3a1416'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = hpFrac > 0.5 ? '#5fd06a' : hpFrac > 0.25 ? '#e0b64a' : '#e0564a';
      ctx.fillRect(bx, by, bw * hpFrac, bh);
    }
    rp.tag.material.map.needsUpdate = true;
  }

  removeRemotePlayer(id) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    this.scene.remove(rp.mesh);
    if (rp.tag) this.scene.remove(rp.tag);
    this.remotePlayers.delete(id);
  }

  clearRemotePlayers() {
    for (const id of [...this.remotePlayers.keys()]) this.removeRemotePlayer(id);
  }

  updateRemotePlayers(dt) {
    // A remote hero is visible when we're in the same zone: dungeon, town
    // square (every Embervale is the same place), or the tavern.
    const zone = this.myZone();
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.position.lerp(rp.target, Math.min(1, 10 * dt));
      rp.mesh.rotation.y = Math.PI / 2 - rp.aim;
      const visible = !rp.dead && (rp.zone || 0) === zone;
      rp.mesh.visible = visible;
      // name + level always; health bar only while in the dungeon (zone 0)
      this.updateNametag(rp, (rp.zone || 0) === 0);
      if (rp.tag) {
        rp.tag.visible = visible;
        rp.tag.position.set(rp.mesh.position.x, rp.mesh.position.y + 2.35, rp.mesh.position.z);
      }
      if (rp.anim) {
        rp.anim.mixer.update(dt);
        rp.anim.setLocomotion(rp.moving);
      }
    }
  }

  // Enemies pick the nearest living hero (host + remote guests).
  getNearestTarget(pos) {
    const candidates = [{ pos: this.player.pos, dead: this.player.dead, local: true, id: 'host' }];
    if (net.isHost) {
      for (const [id, rp] of this.remotePlayers) {
        if (rp.away) continue;
        candidates.push({ pos: rp.target, dead: rp.dead, local: false, id });
      }
    }
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      if (c.dead) continue;
      const d = Math.hypot(c.pos.x - pos.x, c.pos.z - pos.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best || candidates[0];
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
      // allowlist: only floor, plank bridges and OPEN doors are walkable —
      // walls, void, chasms and rubble all block movement
      if (t === DOOR) {
        const tx = Math.floor((x + dx) / TILE), ty = Math.floor((z + dz) / TILE);
        if (!this.openedDoors.has(`${tx},${ty}`)) return false;
      } else if (t !== FLOOR && t !== BRIDGE) {
        return false;
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
    // a swing also smashes any container it sweeps through
    this.breakNear(player.pos.x + (player.aimDir?.x || 0) * basic.range, player.pos.z + (player.aimDir?.z || 0) * basic.range, 1.0);
  }

  // Smash any breakable container (barrel/crate/pot) within radius of an impact.
  breakNear(x, z, radius = 1.3) {
    const list = this.dungeonMeshes?.breakables;
    if (!list || !list.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (Math.hypot(b.x - x, b.z - z) > radius) continue;
      b.mesh.removeFromParent();
      b.mesh.traverse?.((o) => o.geometry?.dispose?.());
      const col = b.kind === 'pot' ? 0x8a4b33 : 0x54402c;
      this.particles.burst(b.x, 0.45, b.z, 12, col, { speed: 3.5, life: 0.5, size: 0.12, up: 1 });
      this.addWallMark(b.x, b.z, { color: 0x1c150e, size: 0.42, opacity: 0.3 });
      audio.play('chest_open', { pos: { x: b.x, z: b.z }, volume: 0.45, rate: 1.35 });
      if (Math.random() < 0.4) this.loot.dropGold(b.x, b.z, 2 + Math.floor(Math.random() * 6));
      list.splice(i, 1);
    }
  }

  // Rebuild a guest-supplied status into a clean, clamped object. A tampered
  // client could otherwise send {burn:{dps:1e9,duration:9999}} to melt the
  // host's encounter, so we only keep known keys and clamp every field.
  sanitizeGuestStatus(st, cap) {
    if (!st || typeof st !== 'object') return undefined;
    const num = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
    };
    const out = {};
    if (st.burn) out.burn = { dps: num(st.burn.dps, 1, cap, 1), duration: num(st.burn.duration, 0.5, 6, 3) };
    if (st.poison) out.poison = { dps: num(st.poison.dps, 1, cap, 1), duration: num(st.poison.duration, 0.5, 6, 2) };
    if (st.slow) out.slow = { mult: num(st.slow.mult, 0.1, 1, 0.35), duration: num(st.slow.duration, 0.5, 6, 3.5) };
    return Object.keys(out).length ? out : undefined;
  }

  damageEnemy(e, amount, opts = {}) {
    if (e.dead) return;
    // Multiplayer guest: host is authoritative — send the damage event and
    // show optimistic local feedback.
    if (net.active && !net.isHost) {
      let dmg = amount;
      let crit = false;
      if (!opts.dot && this.player && Math.random() < this.player.crit) { dmg *= 1.8; crit = true; }
      dmg = Math.max(1, Math.round(dmg));
      e.hitFlash = 0.12;
      this.hitSparks(e.pos, crit, opts);
      this.ui.floaters.spawn(e.pos, `${dmg}`, crit ? 'crit' : '');
      if (!opts.silent && e.def) audio.play(e.def.sounds.hurt, { pos: e.pos, volume: 0.7, throttleMs: 90 });
      net.send({ t: 'dmg', ei: e.netId, a: dmg, kb: opts.knockback || 0, st: opts.status || null });
      return;
    }
    let dmg = amount;
    let crit = false;
    if (!opts.dot && this.player && Math.random() < this.player.crit) {
      dmg *= 1.8;
      crit = true;
    }
    dmg = Math.max(1, Math.round(dmg));
    e.hp -= dmg;
    if (!opts.noFlash) {
      e.hitFlash = 0.12;
      this.hitSparks(e.pos, crit, opts);
    }
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

  stairsClearNeed() {
    return Math.ceil((this.floorEnemyTotal || 0) * 0.7);
  }

  stairsLocked() {
    if (!this.dungeon?.stairs) return false;
    if (this.floorKills < this.stairsClearNeed()) return true;
    return this.enemies.some((en) => !en.dead && en.elite);
  }

  killEnemy(e) {
    e.dead = true;
    this.kills++;
    this.floorKills++;
    if (e.elite) {
      this.elitesKilled++;
      this.ui.floaters.spawn(e.pos, `${e.name} falls!`, 'crit');
    }
    // seal-break moment
    if (this._stairsWasLocked && !this.stairsLocked()) {
      this._stairsWasLocked = false;
      audio.play('door_open', { volume: 0.9 });
      audio.play('level_up', { volume: 0.4, rate: 1.3 });
      this.ui.floaters.spawn(this.player.pos, '⛓️ The seal breaks — the stairs open!', 'crit');
      this.setStairsRingColor(0x54e87a);
      if (net.isHost) net.send({ t: 'notice', txt: '⛓️ The seal breaks — the stairs open!' });
    }
    audio.play(e.def.sounds.death, { pos: e.pos, volume: 0.85 });
    this.particles.burst(e.pos.x, 0.8, e.pos.z, 22, e.def.color, { speed: 4, life: 0.7 });
    this.scene.remove(e.mesh);

    this.player.gainXp(e.xp, this);
    this.rollDeathLoot(e.pos.x, e.pos.z, { miniboss: e.miniboss, isBoss: e.isBoss, goldRange: e.goldRange });

    // In co-op every hero gets full XP and rolls their own personal loot.
    if (net.isHost) {
      net.send({ t: 'edead', id: e.netId, x: e.pos.x, z: e.pos.z, xp: e.xp, mb: e.miniboss, boss: !!e.isBoss });
    }

    if (e.isBoss) {
      this.actsCleared = Math.max(this.actsCleared, this.currentAct());
      if (this.currentAct() < 5 && this.floor <= MAX_FLOOR) {
        // act cleared: open the way down to the next act
        this.spawnActExit(e.pos.x, e.pos.z);
        this.ui.showFloorBanner(`ACT ${ROMAN[this.currentAct()]} CLEARED`, 'The way deeper opens…', true);
        audio.play('level_up');
        audio.playMusic('dungeon', 2);
      } else {
        this.onVictory();
      }
    }
    this.requestSave();
  }

  // Golden exit portal where the act boss fell → next act's first floor.
  spawnActExit(x, z) {
    const tx = Math.floor(x / TILE), ty = Math.floor(z / TILE);
    this.dungeon.stairs = { x: tx, y: ty };
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.0, 0.09, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd75e })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.15;
    g.add(ring);
    g.position.set(tx * TILE + TILE / 2, 0, ty * TILE + TILE / 2);
    this.scene.add(g);
    this.dungeonMeshes.group.add(g);
    g.position.set(tx * TILE + TILE / 2, 0, ty * TILE + TILE / 2);
    this.dungeonMeshes.stairsMesh = g;
    this.particles.ring(g.position.x, 0.3, g.position.z, 2.5, 0xffd75e);
  }

  // Impact feedback: sparks fly on every hit; crits explode bigger and shake.
  hitSparks(pos, crit, opts = {}) {
    const color = opts.status?.burn ? 0xff8a3a
      : opts.status?.poison ? 0x8ade5a
      : opts.status?.slow ? 0x9adfff
      : crit ? 0xffd75e : 0xffe9b0;
    this.particles.burst(pos.x, 0.9, pos.z, crit ? 18 : 8, color, {
      speed: crit ? 5.5 : 3.5, life: crit ? 0.5 : 0.32, size: crit ? 0.14 : 0.1, up: 0.5,
    });
    if (crit) this.shake(0.18);
  }

  rollDeathLoot(x, z, opts) {
    const [gMin, gMax] = opts.goldRange || (opts.isBoss ? [120, 200] : opts.miniboss ? [20, 40] : [2, 8]);
    const goldPiles = opts.isBoss ? 8 : opts.miniboss ? 4 : 1 + Math.floor(Math.random() * 2);
    const total = Math.round(gMin + Math.random() * (gMax - gMin));
    for (let i = 0; i < goldPiles; i++) {
      this.loot.dropGold(x, z, Math.max(1, Math.round(total / goldPiles)));
    }
    if (Math.random() < 0.10) this.loot.dropPotion(x + 0.5, z);
    const gearChance = opts.isBoss || opts.miniboss ? 1 : 0.09;
    if (Math.random() < gearChance) {
      const rarity = opts.isBoss || opts.miniboss ? 'epic' : null;
      this.loot.dropGear(x, z + 0.5, generateGear(this.floor, rarity, this.player.classId));
    }
    // The pinnacle EPIC is earned in a fight: the Dungeon Lord and minibosses
    // drop it meaningfully, and ANY kill has a ~0.001% shot at one.
    if ((opts.isBoss && Math.random() < 0.35) || (opts.miniboss && Math.random() < 0.05)) {
      this.loot.dropGear(x + 0.8, z - 0.5, dropLegendary(this.floor));
    } else if (!opts.isBoss && !opts.miniboss && Math.random() < 0.00001) {
      this.loot.dropGear(x + 0.8, z - 0.5, dropLegendary(this.floor));
    }
    // very rare bag drop: +3 inventory slots
    if (Math.random() < (opts.isBoss ? 0.5 : opts.miniboss ? 0.08 : 0.012)) {
      this.loot.dropBag(x - 0.5, z - 0.5);
    }
  }

  aoeDamage(x, z, radius, damage, opts = {}) {
    if (opts.source === 'player') {
      // scorch the ground where a power lands (darker for fire/burn)
      this.addWallMark(x, z, { color: opts.status?.burn ? 0x1a0f08 : 0x201a16, size: Math.min(radius * 0.7, 1.2), opacity: 0.3 });
      this.breakNear(x, z, radius); // powers shatter nearby containers
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
      if (e.dead || e.isBoss || !e.stun) continue;
      if (Math.hypot(e.pos.x - x, e.pos.z - z) < radius) e.stun(duration);
    }
  }

  // Enemy attack landing on whichever hero was targeted (local or remote).
  hitTarget(target, dmg) {
    if (!target) return;
    if (target.local) this.player.takeDamage(dmg, this);
    else net.send({ t: 'ehit', dmg: Math.round(dmg) }, target.id);
  }

  // AoE enemy attacks (golem slam) hit every hero in range.
  aoeHitPlayers(x, z, radius, dmg) {
    if (!this.player.dead && Math.hypot(this.player.pos.x - x, this.player.pos.z - z) < radius) {
      this.player.takeDamage(dmg, this);
    }
    if (net.isHost) {
      for (const [id, rp] of this.remotePlayers) {
        if (!rp.dead && !rp.away && Math.hypot(rp.target.x - x, rp.target.z - z) < radius) {
          net.send({ t: 'ehit', dmg: Math.round(dmg) }, id);
        }
      }
    }
  }

  spawnProjectile(opts) {
    this.projectiles.spawn(opts);
    // guests must see (and dodge) host-simulated enemy projectiles
    if (net.isHost && !opts.friendly) {
      net.send({
        t: 'eproj', x: opts.x, z: opts.z, dx: opts.dir.x, dz: opts.dir.z,
        sp: opts.speed, dmg: opts.damage, c: opts.color, s: opts.size,
      });
    }
  }

  addZone(opts) {
    const geo = new THREE.CircleGeometry(opts.radius, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: opts.color, transparent: true, opacity: 0.22, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    // Sit above the tallest walkable surface (chasm bridge planks top out at
    // ~0.10) and draw on top, so the AoE never sinks under the floor/bridge.
    mesh.position.set(opts.x, 0.14, opts.z);
    mesh.renderOrder = 3;
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
    const types = boss.summonTypes || ['skeleton', 'skeleton', 'spider'];
    for (const type of types) {
      const a = Math.random() * Math.PI * 2;
      const x = boss.pos.x + Math.cos(a) * 4;
      const z = boss.pos.z + Math.sin(a) * 4;
      if (!this.isWalkable(x, z, 0.4)) continue;
      const e = new Enemy(type, this.floor);
      e.pos.set(x, 0, z);
      e.state = 'chase';
      e.netId = ++this.netEnemySeq;
      this.applyMpScaling(e, 1 + 0.5 * (net.playerCount - 1));
      this.scene.add(e.mesh);
      this.enemies.push(e);
      this.particles.burst(x, 0.6, z, 16, 0xb35eff, { speed: 3, life: 0.5 });
      if (net.isHost) net.send({ t: 'espawn', e: this.serializeEnemy(e) });
    }
  }

  shake(amount) {
    if (!this.settings.screenShake) return;
    this.shakeAmount = Math.min(0.8, this.shakeAmount + amount);
  }

  // ---------------- inventory ----------------
  // Drink a buff elixir from the pack: apply its boon, then consume it.
  useConsumable(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1 || !item.consumable) return;
    p.inventory.splice(idx, 1);
    if (item.buff) p.addBuff({ ...item.buff });
    audio.play('potion_drink');
    this.ui.floaters.spawn(p.pos, `${item.icon} ${item.effectLabel || item.name}`, 'heal');
    this.requestSave();
  }

  equip(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1) return;
    if (item.consumable) { this.useConsumable(item); return; } // drinking, not wearing
    // a hero can only wield their own class's weapons
    if (item.forClass && item.forClass !== p.classId) {
      const names = { knight: 'Knights', mage: 'Mages', ranger: 'Rangers' };
      this.ui.floaters.spawn(p.pos, `Only ${names[item.forClass] || 'others'} can wield this`, 'player-dmg');
      audio.play('ui_close', { volume: 0.6 });
      return;
    }
    p.inventory.splice(idx, 1);
    const prev = p.equipped[item.slot];
    p.equipped[item.slot] = item;
    if (prev) p.inventory.push(prev);
    p.recompute();
    audio.play('equip');
    this.sendLoadout();
    this.requestSave();
  }

  unequip(slotName) {
    const p = this.player;
    const item = p.equipped[slotName];
    if (!item || p.inventory.length >= p.invSize) return;
    p.equipped[slotName] = null;
    p.inventory.push(item);
    p.recompute();
    audio.play('equip');
    this.sendLoadout();
    this.requestSave();
  }

  dropItem(item) {
    const p = this.player;
    const idx = p.inventory.indexOf(item);
    if (idx === -1) return;
    p.inventory.splice(idx, 1);
    const x = p.pos.x + 1, z = p.pos.z;
    // networked drop: tag it so the whole room sees it and its pickup syncs
    this._didSeq = (this._didSeq || 0) + 1;
    const did = net.active ? `${net.peer?.id || 'h'}:${this._didSeq}` : null;
    this.loot.dropGear(x, z, item, did);
    if (net.active) net.send({ t: 'drop', did, x: +x.toFixed(1), z: +z.toFixed(1), item });
    this.requestSave();
  }

  // A networked ground drop was picked up here — tell the room to remove it.
  onDropPickedUp(did) {
    if (net.active) net.send({ t: 'pickup', did });
  }

  // Permanently destroy a batch of inventory items (no ground drop).
  destroyItems(items) {
    const p = this.player;
    const set = new Set(items);
    if (!set.size) return;
    p.inventory = p.inventory.filter((it) => !set.has(it));
    audio.play('ui_close', { volume: 0.6 });
    this.requestSave();
  }

  // Quick declutter: drop every common-rarity item at once. Returns the count.
  dropAllCommons() {
    const p = this.player;
    const commons = p.inventory.filter((it) => it.rarity === 'common');
    if (!commons.length) return 0;
    p.inventory = p.inventory.filter((it) => it.rarity !== 'common');
    commons.forEach((it, i) => this.loot.dropGear(p.pos.x + 1 + (i % 3) * 0.5, p.pos.z + Math.floor(i / 3) * 0.5, it));
    this.requestSave();
    return commons.length;
  }

  // ---------------- saving ----------------
  requestSave(immediate = false) {
    if (!this.player) return;
    this.savePending = true;
    if (immediate) this.flushSave();
  }

  flushSave() {
    if (!this.player || !this.savePending || !this.slotId) return;
    this.savePending = false;
    SaveManager.saveSlot(this.slotId, {
      player: this.player.toSave(),
      floor: Math.max(1, this.floor),
      kills: this.kills,
      deaths: this.deaths,
      bossDefeated: this.bossDefeated,
      actsCleared: this.actsCleared,
      elitesKilled: this.elitesKilled,
      storySeen: this.storySeen,
    });
  }

  saveSettings() { SaveManager.saveSettings(this.settings); }

  // Push all mixer channels to their consumers.
  applyAudioSettings() {
    const s = this.settings;
    audio.setVolume('master', s.masterVolume);
    audio.setVolume('music', s.musicVolume);
    audio.setVolume('sfx', s.sfxVolume);
    roaster.volume = s.speechVolume;
    import('./ai/neuralVoice.js').then(({ neuralVoice }) => { neuralVoice.volume = s.speechVolume; }).catch(() => {});
    voice.setOutputVolume(s.voiceChatVolume);
  }

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

    // Tab backgrounded: browsers keep firing rAF at ~1fps, which would let
    // enemies keep attacking (and could kill/relocate the player) while you're
    // on another tab. Freeze ALL gameplay until the tab is visible again — the
    // clock delta above is still consumed so no giant step fires on return.
    if (document.hidden) return;

    if (this.state === 'playing') {
      this.updatePlaying(dt);
    } else if (['dead', 'victory', 'inventory', 'paused', 'shop', 'quest', 'skills', 'story', 'notices', 'chatlog'].includes(this.state)) {
      // world is frozen; still render + light flicker for life
      this.updateTorches(dt, true);
      if (net.active) this.netFrozenTick(dt);
      if (this.state === 'chatlog' && this.input.wasPressed('Escape')) { this.state = 'playing'; this.ui.hideAll(); }
      if (this.state === 'inventory' && (this.input.wasPressed('Tab') || this.input.wasPressed('Escape') || this.input.wasPressed('KeyI'))) {
        this.state = 'playing';
        this.ui.closeInventory();
      }
      if (this.state === 'shop' && this.input.wasPressed('Escape')) this.closeShop();
      if (this.state === 'quest' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyJ'))) this.toggleQuestLog();
      if (this.state === 'notices' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyF'))) { this.state = 'playing'; this.ui.hideAll(); }
      if (this.state === 'skills' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyK'))) this.toggleSkills();
      if (this.state === 'story' && (this.input.wasPressed('Escape') || this.input.wasPressed('Space') || this.input.wasPressed('Enter'))) {
        this.state = 'playing';
        this.ui.hideAll();
      }
      if (this.state === 'paused' && this.input.wasPressed('Escape')) this.togglePause(false);
    }

    // push-to-talk (V) works in every state while connected
    if (voice.active && voice.mode === 'ptt') voice.ptt = this.input.isDown(this.settings.keybinds.talk) || this.touchPtt;

    // idle touch buttons fade out to free up the screen; they only exist at
    // all during gameplay and the inventory (menus have their own buttons)
    this.touch.update(dt);
    const wantTouchUi = this.state === 'playing' || this.state === 'inventory';
    if (wantTouchUi !== this._touchUiVisible) {
      this._touchUiVisible = wantTouchUi;
      this.touch.setVisible(wantTouchUi);
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

    // one-time notice the first time you step into the portal safe zone this floor
    if (p && this.safeZone) {
      const inSafe = this.inSafeZone(p.pos);
      if (inSafe && !this._inSafeZone) {
        this._inSafeZone = true;
        this.ui.floaters?.spawn(p.pos, '🛡️ Safe zone — no harm can reach you', 'crit');
      } else if (!inSafe) this._inSafeZone = false;
    }

    // ---- input: camera rotation (Q/E or touch rotate buttons) ----
    if (input.isDown('KeyQ')) this.camYaw += 2.2 * dt;
    if (input.isDown('KeyE')) this.camYaw -= 2.2 * dt;
    if (this.touch.rotDir) this.camYaw += this.touch.rotDir * 2.0 * dt;

    // ---- input: movement (screen-space, rotated into the world by camYaw) ----
    let mx = 0, mz = 0;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz += 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, mz) || 1;
    mx /= len; mz /= len;
    // touch joystick overrides keyboard when engaged
    if (this.touch.joyActive) {
      mx = this.touch.move.x;
      mz = this.touch.move.z;
    }
    // rotate screen-relative input into world axes so "up" is always away
    // from the camera regardless of orbit angle
    const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    p.moveDir.x = mx * cy + mz * sy;
    p.moveDir.z = -mx * sy + mz * cy;
    // anti-cheat penalty: frozen in place until the lockout expires
    if (this.cheatLockUntil && performance.now() < this.cheatLockUntil) { p.moveDir.x = 0; p.moveDir.z = 0; }

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

    // facing rule: aim only counts while attack input is held
    p.aiming = !this.inTown && (input.mouse.down || this.touch.attacking);

    // mobile aim assist: while attacking by touch, snap aim to the nearest
    // living enemy in range — thumbs aren't mice
    if (this.touch.enabled && this.touch.attacking && !this.inTown) {
      let best = null, bestD = 9;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        const dx = best.pos.x - p.pos.x, dz = best.pos.z - p.pos.z;
        const alen = Math.hypot(dx, dz) || 1;
        p.aimAngle = Math.atan2(dz, dx);
        p.aimDir.x = dx / alen;
        p.aimDir.z = dz / alen;
      }
    }

    // ---- input: actions (Embervale is a place of peace — no weapons drawn) ----
    // clicking a co-op hero opens their inspect panel and eats the click
    const inspected = this.tryInspectClick();
    if (!this.inTown && !inspected) {
      if (input.mouse.down || this.touch.attacking) p.tryBasicAttack(this);
      if (input.wasPressed('Digit1')) p.tryAbility(0, this);
      if (input.wasPressed('Digit2')) p.tryAbility(1, this);
      if (input.wasPressed('Digit3')) p.tryAbility(2, this);
      if (input.wasPressed('Digit4')) p.tryAbility(3, this);
    }
    // (In town, attack input is simply ignored — no weapons drawn, no message.)
    if (input.wasPressed(this.settings.keybinds.potion)) p.drinkPotion(this);
    if (input.wasPressed(this.settings.keybinds.inventory) || input.wasPressed('KeyI')) {
      this.state = 'inventory';
      this.ui.openInventory();
      return;
    }
    if (input.wasPressed(this.settings.keybinds.quests)) { this.toggleQuestLog(); return; }
    if (input.wasPressed(this.settings.keybinds.mastery)) { this.toggleSkills(); return; }
    // Enter opens chat input in multiplayer
    if (net.active && input.wasPressed('Enter')) { this.ui.openChatInput(); return; }
    if (input.wasPressed(this.settings.keybinds.interact)) { this.doInteract(); return; }
    if (input.wasPressed('Escape')) { this.togglePause(true); return; }

    // ---- systems ----
    p.update(dt, this);
    // anti-cheat: impossible leveling (10+ levels within 5s can't come from kills)
    if (this._lastSeenLevel === undefined) this._lastSeenLevel = p.level;
    if (p.level > this._lastSeenLevel) {
      const now = performance.now();
      this._levelStamps = (this._levelStamps || []).filter((t) => now - t < 5000);
      for (let l = this._lastSeenLevel; l < p.level; l++) this._levelStamps.push(now);
      this._lastSeenLevel = p.level;
      if (this._levelStamps.length >= 10 && now > (this.cheatLockUntil || 0)) this.applyCheatLockout('impossible leveling');
    }
    if (net.active && !net.isHost) {
      this.updateGuestMirrors(dt);   // host runs the real enemy AI
    } else {
      for (const e of this.enemies) e.update(dt, this);
    }
    this.enemies = this.enemies.filter((e) => !e.dead || e.isBoss);
    this.animateAuras(dt);
    this.projectiles.update(dt, this);
    this.loot.update(dt, this);
    this.particles.update(dt);
    this.updateZones(dt);
    this.updateTraps(dt);
    this.updateDoors();
    this.updateChests();
    this.updateStairs(dt);
    this.updatePits();
    this.updateTownInteractions(dt);
    this.updateTorches(dt);
    roaster.update(dt, this);
    if (net.active) {
      this.updateRemotePlayers(dt);
      this.netPlayTick(dt);
    }

    // ---- camera follow + orbit + shake ----
    const target = p.pos;
    const camX = target.x + Math.sin(this.camYaw) * this.cameraOffset.z;
    const camZ = target.z + Math.cos(this.camYaw) * this.cameraOffset.z;
    this.camera.position.x += (camX - this.camera.position.x) * Math.min(1, 8 * dt);
    this.camera.position.y += (target.y + this.cameraOffset.y - this.camera.position.y) * Math.min(1, 8 * dt);
    this.camera.position.z += (camZ - this.camera.position.z) * Math.min(1, 8 * dt);
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

    // playstyle profile: how much of a runner is this hero? Elites use it to
    // lean harder into interception; Fenwick uses it to mock you.
    this._fleeSampleT = (this._fleeSampleT || 0) - dt;
    if (this._fleeSampleT <= 0) {
      this._fleeSampleT = 1;
      const pred = learner.predict(p);
      const mag = pred ? Math.min(1, Math.hypot(pred.dx, pred.dz) / 3) : 0;
      this.fleeTendency = (this.fleeTendency || 0) * 0.9 + mag * 0.1;
    }

    // ---- UI ----
    this.ui.minimap.revealAround(p.pos.x, p.pos.z);
    this.ui.minimap.draw(p, this.camYaw || 0);
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
        if (Math.random() < 0.65) this.loot.dropGear(c.x + 0.6, c.z, generateGear(this.floor, null, this.player.classId));
        if (Math.random() < 0.4) this.loot.dropPotion(c.x - 0.6, c.z);
        if (Math.random() < 0.03) this.loot.dropBag(c.x, c.z + 0.7);
      }
    }
  }

  // Just animates the descend-stairs ring; actual descent is an interact
  // prompt built in updateTownInteractions (so nothing triggers on contact).
  updateStairs(dt) {
    this.stairsCooldown = Math.max(0, this.stairsCooldown - dt);
    if (this.dungeonMeshes?.stairsMesh) {
      this.dungeonMeshes.stairsMesh.children.forEach((ch) => {
        if (ch.geometry?.type === 'TorusGeometry') ch.rotation.z += dt * 1.5;
      });
    }
  }

  // Portal: dungeon-floor exit back to Embervale (checkpoint kept).
  usePortalToTown() {
    audio.play('stairs', { volume: 0.8, rate: 1.2 });
    if (net.active && !net.isHost) { this.stairsCooldown = 2; this.localTown = true; }
    this.loadTown({ fromDungeon: true });
  }

  // Portal: town → the dungeon (or join the party's shared world).
  usePortalToDungeon() {
    audio.play('stairs', { volume: 0.8 });
    if (net.active && !net.isHost) {
      this.stairsCooldown = 2;
      if (this.lastWorldMsg) { this.localTown = false; this.applyWorld(this.lastWorldMsg); }
      else this.ui.floaters.spawn(this.player.pos, 'The dungeon has not been opened yet…', 'xp');
    } else if (this.actsCleared >= 1) {
      // cleared at least one act — let the hero choose which to travel into
      this.ui.showActSelect();
    } else {
      this.loadFloor(this.floor);
    }
  }

  // Travel to a chosen act: resume the current act at its checkpoint, or
  // revisit an earlier, already-cleared act from its first floor.
  travelToAct(a) {
    const cur = this.currentAct();
    this.floor = (a === cur) ? this.floor : (a - 1) * 10 + 1;
    this.loadFloor(this.floor);
  }

  // Player pressed F / tapped the prompt on the descend stairs.
  descendStairs() {
    if (this.stairsLocked()) {
      const eliteLeft = this.enemies.some((en) => !en.dead && en.elite);
      this.ui.floaters.spawn(this.player.pos,
        `Sealed! Cull the horde (${this.floorKills}/${this.stairsClearNeed()})${eliteLeft ? ' · slay the Elite' : ''}`,
        'player-dmg');
      audio.play('shield_block', { volume: 0.5, rate: 0.7 });
      return;
    }
    // Anti-cheat: the stairs only unlock after culling 70% of the floor AND the
    // elite, so unlocking within a few seconds of arriving is impossible legit.
    const onFloorMs = performance.now() - (this._floorLoadedAt || 0);
    if (onFloorMs < 4000 && this.floor > 1) {
      this._suspicion = (this._suspicion || 0) + 1;
      if (this._suspicion >= 2) { this.applyCheatLockout('impossible clear speed'); return; }
    }
    if (net.active && !net.isHost) {
      this.stairsCooldown = 2;
      net.send({ t: 'portal' });
    } else {
      this.loadFloor(this.floor + 1);
    }
  }

  // Punish detected cheating (console-injected progression): yank the offender
  // to town and freeze them for 5 minutes with a visible countdown. Also used
  // by the rapid-leveling check in update().
  applyCheatLockout(reason) {
    this.cheatLockUntil = performance.now() + 300000; // 5 minutes
    this._suspicion = 0;
    if (net.active) net.send({ t: 'cheatlock' }); // let the room see the offender is frozen
    if (!this.inTown) { this.localTown = net.active ? true : this.localTown; this.loadTown(); }
    this.player.aimAngle = -Math.PI / 2; this.player.visualAngle = -Math.PI / 2; this.camYaw = 0;
    this.enterPlaying();
    this.ui.floaters.spawn(this.player.pos, `⛔ Cheating detected — ${reason}`, 'player-dmg');
  }

  setStairsRingColor(hex) {
    this.dungeonMeshes?.stairsMesh?.children.forEach((ch) => {
      if (ch.geometry?.type === 'TorusGeometry') ch.material.color.setHex(hex);
    });
  }

  // Pit holes: fall through to the next floor (solo) — it hurts.
  updatePits() { /* pit-fall traps removed */ }

  // Bricks and dust burst off walls when projectiles strike them, and a
  // lasting chip/scuff is left behind.
  wallDebris(x, z) {
    this.particles.burst(x, 1.0, z, 7, 0x8a8590, { speed: 3, life: 0.4, size: 0.11, up: 0.9 });
    this.particles.burst(x, 1.0, z, 3, 0x5a5560, { speed: 1.6, life: 0.55, size: 0.18, up: 1.2 });
    this.addWallMark(x, z, { color: 0x241f1c, size: 0.22 + Math.random() * 0.14 });
    this.breakNear(x, z, 0.9); // a stray shot can smash a container too
  }

  // A persistent ground decal at an impact point (chip, scuff or scorch). The
  // pool is capped and recycles its oldest mark, so it can't leak RAM; cleared
  // with the floor.
  addWallMark(x, z, opts = {}) {
    if (!this.wallMarks) this.wallMarks = [];
    if (this.wallMarks.length >= 48) {
      const old = this.wallMarks.shift();
      this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose();
    }
    const size = opts.size ?? (0.3 + Math.random() * 0.25);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(size, 10),
      new THREE.MeshBasicMaterial({ color: opts.color ?? 0x000000, transparent: true, opacity: opts.opacity ?? 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI;
    mesh.position.set(x, 0.03, z);
    this.scene.add(mesh);
    this.wallMarks.push({ mesh });
  }

  // Town: vendors open their shop when you walk up; the portal descends.
  updateTownInteractions(dt) {
    this.shopCooldown = Math.max(0, this.shopCooldown - dt);
    if (!this.dungeonMeshes) return;
    const p = this.player;
    const near = (wx, wz, r = 1.8) => Math.hypot(p.pos.x - wx, p.pos.z - wz) < r;
    let candidate = null;

    // spin the portal rings for life
    if (this.dungeonMeshes.returnPortalMesh) this.dungeonMeshes.returnPortalMesh.rotation.y += dt * 1.2;
    if (this.dungeonMeshes.portalMesh) this.dungeonMeshes.portalMesh.rotation.y += dt * 0.6;

    // ---- DUNGEON: descend stairs (gold ring) + return-to-town portal ----
    if (!this.inTown) {
      if (this.dungeon.stairs && this.stairsCooldown <= 0) {
        const w = tileToWorld(this.dungeon.stairs.x, this.dungeon.stairs.y);
        if (near(w.x, w.z, 1.9)) {
          const locked = this.stairsLocked();
          candidate = locked
            ? { label: `Stairs sealed — ${this.floorKills}/${this.stairsClearNeed()} slain`, icon: '🔒', action: () => this.descendStairs() }
            : { label: 'Descend to the next floor', icon: '⬇️', action: () => this.descendStairs() };
        }
      }
      const rp = this.dungeonMeshes.returnPortalMesh;
      if (!candidate && rp && this.stairsCooldown <= 0 && near(rp.position.x, rp.position.z, 1.9)) {
        candidate = { label: 'Return to Embervale', icon: '🌀', action: () => this.usePortalToTown() };
      }
    }

    // ---- TOWN: dungeon portal + tavern door + townsfolk ----
    if (this.inTown && !this.inTavern) {
      const w = tileToWorld(this.dungeon.portal.x, this.dungeon.portal.y);
      if (this.stairsCooldown <= 0 && near(w.x, w.z, 1.9)) {
        candidate = { label: 'Enter the dungeon', icon: '🌀', action: () => this.usePortalToDungeon() };
      }
      if (!candidate && this.shopCooldown <= 0) {
        for (const v of this.dungeonMeshes.vendorMeshes) {
          if (near(v.wx, v.wz, 2.4)) { candidate = { label: `Talk to ${v.name}`, icon: '💬', action: () => this.openShop(v) }; break; }
        }
      }
      if (!candidate && this.wanderer && near(this.wanderer.pos.x, this.wanderer.pos.z, 2.6)) {
        candidate = { label: 'Talk to Old Fenwick', icon: '🧙', action: () => this.wanderer.speakTo(this) };
      }
      if (!candidate && this.dungeon.tavern && this.stairsCooldown <= 0) {
        const t = this.dungeon.tavern;
        const cx = (t.x + t.w / 2 - 0.5) * TILE + TILE / 2;
        const dx = cx + t.w * TILE * 0.28, dz = (t.y + t.h) * TILE + TILE * 0.4;
        if (near(dx, dz, 2.0)) candidate = { label: 'Enter The Sleeping Golem', icon: '🍺', action: () => { this.stairsCooldown = 1.5; audio.play('door_open'); this.loadTavern(); } };
      }
      if (!candidate && this.dungeon.noticeBoard) {
        const nb = tileToWorld(this.dungeon.noticeBoard.x, this.dungeon.noticeBoard.y);
        if (near(nb.x, nb.z, 2.2)) candidate = { label: 'Read the notice board', icon: '📌', action: () => this.openNotices() };
      }
    }

    // ---- TAVERN: exit + folk ----
    if (this.inTavern) {
      if (this.dungeon.exit && this.stairsCooldown <= 0) {
        const w = tileToWorld(this.dungeon.exit.x, this.dungeon.exit.y);
        if (near(w.x, w.z + 0.6, 1.6)) candidate = { label: 'Step outside', icon: '🚪', action: () => { this.stairsCooldown = 1.5; audio.play('door_open'); this.loadTown({ fromTavern: true }); } };
      }
      if (!candidate && this.dungeonMeshes.barkeepPos && near(this.dungeonMeshes.barkeepPos.x, this.dungeonMeshes.barkeepPos.z, 2.4)) {
        candidate = { label: 'Talk to Barlow', icon: '🍺', action: () => this.barkeepChat() };
      }
      if (!candidate) {
        for (const pm of this.dungeonMeshes.patronMeshes || []) {
          if (near(pm.x, pm.z, 1.8)) { candidate = { label: pm.drunk ? 'Nudge the drunk' : 'Chat with the patron', icon: '💬', action: () => this.patronChat(pm) }; break; }
        }
      }
    }

    this.setInteractable(candidate);
    if (this.wanderer && this.inTown && !this.inTavern) this.wanderer.update(dt, this);
    if (this.inTown && !this.inTavern) this.updateVendors(dt);

    // tavern smoke + hearth idle animation data from the mesh builder
    const puffs = this.dungeonMeshes.smokePuffs;
    if (puffs?.length) {
      for (const puff of puffs) {
        puff.phase = (puff.phase || 0) + dt * (puff.speed || 0.4);
        if (puff.kind === 'firefly') {
          // hovering glow — bob gently, never fades out
          puff.mesh.position.y = puff.baseY + Math.sin(puff.phase * 2.4) * 0.18;
          continue;
        }
        if (puff.kind === 'fire') {
          // living flame: fast asymmetric flicker in height and width
          const f = 1 + Math.sin(puff.phase * 7) * 0.18 + Math.sin(puff.phase * 13.7) * 0.1;
          puff.mesh.scale.set(2 - f, f, 2 - f);
          puff.mesh.position.y = puff.baseY + (f - 1) * 0.1;
          continue;
        }
        if (puff.kind === 'critter') {
          // a lone forest animal ambling along a slow circular path outside the walls
          puff.angle = (puff.angle || 0) + dt * (puff.speed || 0.3) * 0.14;
          const x = puff.cx + Math.cos(puff.angle) * puff.radius;
          const z = puff.cz + Math.sin(puff.angle) * puff.radius;
          puff.mesh.position.set(x, puff.baseY + Math.abs(Math.sin(puff.phase * 3)) * 0.1, z);
          puff.mesh.rotation.y = -puff.angle + Math.PI / 2;
          continue;
        }
        const cycle = puff.phase % 1;
        puff.mesh.position.y = puff.baseY + cycle * 1.6;
        puff.mesh.material.opacity = 0.38 * (1 - cycle);
        puff.mesh.position.x += Math.sin(puff.phase * 4) * dt * 0.15;
      }
    }
  }

  setInteractable(candidate) {
    this.interactable = candidate;
    this.ui.showInteract(candidate);
  }

  doInteract() {
    if (this.state === 'playing' && this.interactable) {
      const act = this.interactable.action;
      this.setInteractable(null);
      act();
    }
  }

  // ---------------- network ticks ----------------
  netPlayTick(dt) {
    if (net.isHost) {
      this.netTickTimer -= dt;
      if (this.netTickTimer <= 0) {
        this.netTickTimer = 0.1;
        this.sendHostState();
      }
    } else {
      this.posSendTimer -= dt;
      if (this.posSendTimer <= 0) {
        this.posSendTimer = 0.066;
        const p = this.player;
        net.send({
          t: 'pos', x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2),
          aim: +p.aimAngle.toFixed(2), mv: (p.moveDir.x || p.moveDir.z) ? 1 : 0,
          dead: p.dead ? 1 : 0, cls: p.classId, nm: this.playerName(),
          aw: this.myZone(), lvl: p.level, hp: Math.round(p.hp), mhp: p.maxHp,
          au: this.heroAuraTier(),
        });
      }
    }
  }

  // keep sending presence while in menus so others don't freeze
  netFrozenTick(dt) {
    this.netPlayTick(dt);
    if (net.active) this.updateRemotePlayers(dt);
  }

  sendHostState() {
    const p = this.player;
    const pl = [{
      id: 'host', x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2),
      aim: +p.aimAngle.toFixed(2), mv: (p.moveDir.x || p.moveDir.z) ? 1 : 0,
      dead: p.dead ? 1 : 0, cls: p.classId, nm: this.playerName(), aw: this.myZone(),
      lvl: p.level, hp: Math.round(p.hp), mhp: p.maxHp, au: this.heroAuraTier(),
    }];
    for (const [id, rp] of this.remotePlayers) {
      pl.push({
        id, x: +rp.target.x.toFixed(2), z: +rp.target.z.toFixed(2),
        aim: +(rp.aim || 0).toFixed(2), mv: rp.moving ? 1 : 0, dead: rp.dead ? 1 : 0,
        cls: rp.cls, nm: rp.name, aw: rp.zone || 0,
        lvl: rp.level || 1, hp: Math.round(rp.hp || 0), mhp: rp.maxHp || 0, au: rp.aura || 0,
      });
    }
    const en = this.enemies
      .filter((e) => !e.dead)
      .map((e) => [e.netId, +e.pos.x.toFixed(2), +e.pos.z.toFixed(2), e.hp]);
    net.send({ t: 'state', pl, en });
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
          if (t) { l.position.set(t.x, t.y, t.z); l._bx = t.x; l._bz = t.z; l.visible = true; }
          else l.visible = false;
        });
      }
    }
    // flicker — layered sines (not a random strobe) for a believable flame
    const now = performance.now() / 1000;
    this.torchLights.forEach((l, i) => {
      l.intensity = 14 + Math.sin(now * 9 + i * 1.7) * 2.4 + Math.sin(now * 23 + i * 3.1) * 1.4;
      // tiny positional jitter (around the assigned torch base) so shadows shiver
      if (l.visible && l._bx !== undefined) {
        l.position.x = l._bx + Math.sin(now * 17 + i) * 0.04;
        l.position.z = l._bz + Math.cos(now * 19 + i * 1.3) * 0.04;
      }
    });
    for (let i = 0; i < torches.length; i++) {
      const f = torches[i].flame;
      if (!f) continue;
      const s = 1 + Math.sin(now * 11 + i * 2.3) * 0.18;
      f.scale.set(s, 1 + Math.sin(now * 13 + i) * 0.25, s);
    }
  }
}
