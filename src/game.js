import * as THREE from 'three';
import { Input } from './core/input.js';
import { SaveManager } from './core/save.js';
import { audio } from './core/audio.js';
import { generateDungeon, generateTown, FLOOR, WALL, DOOR } from './world/dungeon.js';
import { buildDungeonMeshes, TILE, tileToWorld } from './world/meshbuilder.js';
import { themeForFloor, actOfFloor, actFloorOf } from './world/textures.js';
import { Player, xpForLevel } from './entities/player.js';
import { Enemy, Boss, ENEMY_TYPES, ACT_BOSSES, buildEnemyMesh, buildBossMesh } from './entities/enemies.js';
import { buildAnimatedHero } from './entities/heroModel.js';
import { CLASSES, buildHeroMesh } from './entities/classes.js';
import { ProjectileSystem } from './entities/projectiles.js';
import { LootSystem, generateGear, rollRarity, sellValue, gambleItem, dropLegendary, RARITIES } from './entities/loot.js';
import { net } from './net/net.js';
import { voice } from './net/voice.js';
import { ParticleSystem } from './combat/particles.js';
import { UI } from './ui/ui.js';
import { learner } from './ai/learner.js';
import { roaster } from './ai/roaster.js';
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
    this.settings = Object.assign(
      { masterVolume: 0.8, musicVolume: 0.6, sfxVolume: 0.9, quality: 'medium', screenShake: true, voiceMode: 'ptt', voiceThreshold: 12, taunts: true },
      SaveManager.loadSettings() || {}
    );
    audio.volumes = {
      master: this.settings.masterVolume,
      music: this.settings.musicVolume,
      sfx: this.settings.sfxVolume,
    };

    this.playerModule = { xpForLevel };
    roaster.enabled = this.settings.taunts !== false;
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
    this.inTown = false;
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
      await audio.loadAll((f) => this.ui.setLoadingProgress(0.4 + f * 0.55, 'Summoning sounds…'));
    }
    this.ui.setLoadingProgress(1, 'Ready');
    // Enemy movement-learning net loads in the background (non-blocking).
    learner.init();
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
    this.ui.buildHotbar(this.player);
    this.enterWorld();
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

  enterPlaying() {
    this.state = 'playing';
    this.ui.hideAll();
    this.ui.showHud(true);
    this.touch.setVisible(true);
    audio.resume();
  }

  quitToTitle() {
    this.requestSave(true);
    voice.disable();
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
    this.player.gold = Math.floor(this.player.gold * 0.8);
    this.requestSave(true);
    setTimeout(() => {
      if (this.state === 'playing') {
        this.state = 'dead';
        this.ui.showGameOver(this.floor);
      }
    }, 900);
  }

  // Death sends you home to Embervale; your dungeon checkpoint is kept.
  respawn() {
    this.player.dead = false;
    this.player.hp = this.player.maxHp;
    this.player.resource = this.player.maxResource;
    this.player.statuses = [];
    this.player.buffs = [];
    if (net.active && !net.isHost) this.localTown = true;
    this.loadTown();
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

  // ---------------- town ----------------
  loadTown() {
    this.teardownFloor();
    this.inTown = true;
    const theme = themeForFloor(1);
    this.dungeon = generateTown();
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme);
    this.scene.add(this.dungeonMeshes.group);
    this.openedDoors = new Set();

    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.player.dead = false;

    // fresh vendor stock each town visit
    for (const v of this.dungeonMeshes.vendorMeshes) {
      v.stock = this.makeVendorStock(v);
    }
    this.setTownAtmosphere(true);

    this.setupTorchLights(theme);
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(0, 'Embervale — rest, trade, prepare');
    audio.playMusic('dungeon');
    this.shopCooldown = 1;
    this.requestSave(true);

    if (net.isHost) this.broadcastWorld();
  }

  makeVendorStock(vendor) {
    const stock = [];
    if (vendor.type === 'potions') {
      for (let i = 0; i < 3; i++) {
        stock.push({ kind: 'potion', icon: '🧪', label: 'Health Potion', price: 20 + this.floor * 4 });
      }
      if (Math.random() < 0.35 && this.player.invSize < 24) {
        stock.push({ kind: 'bag', icon: '🎒', label: 'Traveler’s Satchel (+3 slots)', price: 400 });
      }
    } else if (vendor.type === 'mystery') {
      // Zoltan: pay dearly, roll the dice. Small chance of a legendary unique.
      const price = 150 + this.floor * 30;
      for (let i = 0; i < 3; i++) {
        stock.push({ kind: 'gamble', icon: '❓', label: 'Mystery Relic — fate decides', price });
      }
    } else {
      // The smith sells solid basics only — epics and better must be earned
      // in the dungeon (or gambled from Zoltan).
      for (let i = 0; i < 4; i++) {
        const rarity = Math.random() < 0.35 ? 'rare' : 'common';
        const item = generateGear(Math.min(MAX_FLOOR, this.floor + 1), rarity);
        stock.push({ kind: 'gear', icon: item.icon, label: item.name, price: Math.round((item.value || 30) * 2.2), item });
      }
    }
    return stock;
  }

  buyFromVendor(vendor, entry) {
    const p = this.player;
    if (entry.sold || p.gold < entry.price) return;
    if ((entry.kind === 'gear' || entry.kind === 'gamble') && p.inventory.length >= p.invSize) {
      this.ui.floaters.spawn(p.pos, 'Inventory full!', 'player-dmg');
      return;
    }
    p.gold -= entry.price;
    entry.sold = true;
    audio.play('coin_pickup');
    if (entry.kind === 'potion') { p.potions++; audio.play('potion_pickup'); }
    else if (entry.kind === 'bag') {
      p.invSize = Math.min(24, p.invSize + 3);
      this.ui.floaters.spawn(p.pos, '🎒 +3 inventory slots!', 'crit');
    } else if (entry.kind === 'gear') {
      p.inventory.push(entry.item);
      audio.play('gear_pickup');
    } else if (entry.kind === 'gamble') {
      const item = gambleItem(this.floor);
      p.inventory.push(item);
      audio.play('gear_pickup');
      if (item.rarity === 'legendary') {
        audio.play('level_up');
        this.ui.floaters.spawn(p.pos, `🌟 LEGENDARY: ${item.name}!`, 'crit');
        this.particles.burst(p.pos.x, 1.2, p.pos.z, 40, 0xff8c1a, { speed: 5, life: 1 });
        this.shake(0.4);
      } else {
        this.ui.floaters.spawn(p.pos, `${item.icon} ${item.name}`, item.rarity === 'common' ? '' : 'crit');
      }
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

  toggleQuestLog() {
    if (this.state === 'playing') {
      this.state = 'quest';
      this.ui.openQuestLog();
    } else if (this.state === 'quest') {
      this.state = 'playing';
      this.ui.hideAll();
    }
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
    } else {
      this.scene.background = new THREE.Color(0x08060c);
      this.scene.fog = new THREE.Fog(0x08060c, 18, 42);
      this.ambient.color.setHex(0x8a7a9a);
      this.ambient.intensity = 0.55;
    }
  }

  loadFloor(floor) {
    this.teardownFloor();
    this.inTown = false;
    this.setTownAtmosphere(false);
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
  }

  currentAct() { return actOfFloor(Math.min(this.floor, MAX_FLOOR)); }

  floorBannerTitle() {
    if (this.floor > MAX_FLOOR) return `THE ENDLESS ABYSS — ${this.floor}`;
    const act = actOfFloor(this.floor), af = actFloorOf(this.floor);
    return af === 10 ? `ACT ${ROMAN[act]} — THE LORD'S ARENA` : `ACT ${ROMAN[act]} · FLOOR ${af}`;
  }

  floorLabelText() {
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
    const maxLights = { low: 4, medium: 8, high: 14 }[this.settings.quality] || 8;
    const count = Math.min(maxLights, this.dungeonMeshes.torchPositions.length);
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(theme.accent, 12, 9, 1.9);
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
      this.ensureRemotePlayer(from, msg.cls, msg.name);
      if (this.player) this.ui.floaters.spawn(this.player.pos, `${msg.name || 'A hero'} has joined!`, 'crit');
      net.send({ t: 'notice', txt: `${msg.name || 'A hero'} has joined the room!` });
    });
    net.on('pos', (msg, from) => {
      const rp = this.ensureRemotePlayer(from, msg.cls);
      rp.target.set(msg.x, 0, msg.z);
      rp.aim = msg.aim;
      rp.moving = !!msg.mv;
      rp.dead = !!msg.dead;
      rp.away = !!msg.aw;
    });
    net.on('dmg', (msg, from) => {
      const e = this.enemies.find((en) => en.netId === msg.ei && !en.dead);
      if (!e) return;
      const rp = this.remotePlayers.get(from);
      this.damageEnemy(e, msg.a, {
        dot: true, // damage already rolled on the guest; no double crit
        status: msg.st || undefined,
        knockback: msg.kb || undefined,
        kbFrom: rp ? rp.target : e.pos,
      });
    });
    net.on('portal', (msg, from) => {
      if (!net.isHost || this.stairsCooldown > 0) return;
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
      this.loadTown();
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
      const e = this.enemies.find((en) => en.netId === msg.ei && !en.dead);
      if (e) this.ui.floaters.spawn(e.pos, `“${msg.txt}”`, 'roast', 3.2);
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
        rp.away = !!pl.aw;
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
    net.on('notice', (msg) => {
      if (this.player) this.ui.floaters.spawn(this.player.pos, msg.txt, 'crit');
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
    audio.playMusic(!this.inTown && this.dungeon.boss ? 'boss' : 'dungeon');
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
      m.hitFlash = Math.max(0, m.hitFlash - dt);
      m.mesh.traverse((o) => {
        if (o.isMesh && o.material?.emissive !== undefined) {
          o.material.emissive.setScalar(m.hitFlash > 0 ? 0.6 : 0);
        }
      });
    }
  }

  ensureRemotePlayer(id, cls = 'knight', name = null) {
    let rp = this.remotePlayers.get(id);
    if (rp) {
      if (name && rp.name !== name) { rp.name = name; this.setNametag(rp, name); }
      return rp;
    }
    const anim = buildAnimatedHero(cls);
    const mesh = anim ? anim.mesh : buildHeroMesh(CLASSES[cls] || CLASSES.knight);
    this.scene.add(mesh);
    rp = { mesh, anim, cls, name: name || 'Hero', target: new THREE.Vector3(), aim: 0, moving: false, dead: false, away: false };
    this.setNametag(rp, rp.name);
    this.remotePlayers.set(id, rp);
    return rp;
  }

  // Floating nametag sprite above a remote hero.
  setNametag(rp, name) {
    if (rp.tag) { this.scene.remove(rp.tag); rp.tag.material.map?.dispose(); }
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 34px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeText(name, 128, 32);
    ctx.fillStyle = '#e8dcae';
    ctx.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set(2.2, 0.55, 1);
    this.scene.add(sprite);
    rp.tag = sprite;
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
    // A remote hero is visible when we're in the same zone: both in town
    // (every Embervale is the same place) or both in the dungeon.
    const myAway = !!this.inTown;
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.position.lerp(rp.target, Math.min(1, 10 * dt));
      rp.mesh.rotation.y = Math.PI / 2 - rp.aim;
      const visible = !rp.dead && !!rp.away === myAway;
      rp.mesh.visible = visible;
      if (rp.tag) {
        rp.tag.visible = visible;
        rp.tag.position.set(rp.mesh.position.x, rp.mesh.position.y + 2.15, rp.mesh.position.z);
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
      this.loot.dropGear(x, z + 0.5, generateGear(this.floor, rarity));
    }
    // fight-only legendaries: the Dungeon Lord and minibosses alone drop these
    if ((opts.isBoss && Math.random() < 0.35) || (opts.miniboss && Math.random() < 0.05)) {
      this.loot.dropGear(x + 0.8, z - 0.5, dropLegendary(this.floor));
    }
    // very rare bag drop: +3 inventory slots
    if (Math.random() < (opts.isBoss ? 0.5 : opts.miniboss ? 0.08 : 0.012)) {
      this.loot.dropBag(x - 0.5, z - 0.5);
    }
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
    if (!item || p.inventory.length >= p.invSize) return;
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
    } else if (['dead', 'victory', 'inventory', 'paused', 'shop', 'quest'].includes(this.state)) {
      // world is frozen; still render + light flicker for life
      this.updateTorches(dt, true);
      if (net.active) this.netFrozenTick(dt);
      if (this.state === 'inventory' && (this.input.wasPressed('Tab') || this.input.wasPressed('Escape') || this.input.wasPressed('KeyI'))) {
        this.state = 'playing';
        this.ui.closeInventory();
      }
      if (this.state === 'shop' && this.input.wasPressed('Escape')) this.closeShop();
      if (this.state === 'quest' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyJ'))) this.toggleQuestLog();
      if (this.state === 'paused' && this.input.wasPressed('Escape')) this.togglePause(false);
    }

    // push-to-talk (V) works in every state while connected
    if (voice.active && voice.mode === 'ptt') voice.ptt = this.input.isDown('KeyV') || this.touchPtt;

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

    // ---- input: actions (Embervale is a place of peace — no weapons drawn) ----
    if (!this.inTown) {
      if (input.mouse.down || this.touch.attacking) p.tryBasicAttack(this);
      if (input.wasPressed('Digit1')) p.tryAbility(0, this);
      if (input.wasPressed('Digit2')) p.tryAbility(1, this);
      if (input.wasPressed('Digit3')) p.tryAbility(2, this);
      if (input.wasPressed('Digit4')) p.tryAbility(3, this);
    } else if (input.mouse.clicked || input.wasPressed('Digit1')) {
      this.ui.floaters.spawn(p.pos, 'Peace reigns in Embervale.', 'heal');
    }
    if (input.wasPressed('KeyR')) p.drinkPotion(this);
    if (input.wasPressed('Tab') || input.wasPressed('KeyI')) {
      this.state = 'inventory';
      this.ui.openInventory();
      return;
    }
    if (input.wasPressed('KeyJ')) { this.toggleQuestLog(); return; }
    if (input.wasPressed('Escape')) { this.togglePause(true); return; }

    // ---- systems ----
    p.update(dt, this);
    if (net.active && !net.isHost) {
      this.updateGuestMirrors(dt);   // host runs the real enemy AI
    } else {
      for (const e of this.enemies) e.update(dt, this);
    }
    this.enemies = this.enemies.filter((e) => !e.dead || e.isBoss);
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
        if (Math.random() < 0.03) this.loot.dropBag(c.x, c.z + 0.7);
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
    if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 1.4) {
      if (this.stairsLocked() && (!net.active || net.isHost)) {
        this._sealNoticeT -= dt;
        if (this._sealNoticeT <= 0) {
          this._sealNoticeT = 2.5;
          const eliteLeft = this.enemies.some((en) => !en.dead && en.elite);
          this.ui.floaters.spawn(p.pos,
            `Sealed! Cull the horde (${this.floorKills}/${this.stairsClearNeed()})${eliteLeft ? ' · slay the Elite' : ''}`,
            'player-dmg');
          audio.play('shield_block', { volume: 0.5, rate: 0.7 });
        }
        return;
      }
      if (net.active && !net.isHost) {
        this.stairsCooldown = 2;
        net.send({ t: 'portal' });
      } else if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 1.1) {
        this.loadFloor(this.floor + 1);
      }
    }
  }

  setStairsRingColor(hex) {
    this.dungeonMeshes?.stairsMesh?.children.forEach((ch) => {
      if (ch.geometry?.type === 'TorusGeometry') ch.material.color.setHex(hex);
    });
  }

  // Pit holes: fall through to the next floor (solo) — it hurts.
  updatePits() {
    if (!this.dungeon?.pits?.length || this.stairsCooldown > 0 || this.player.dead) return;
    const p = this.player;
    for (const pit of this.dungeon.pits) {
      const w = tileToWorld(pit.x, pit.y);
      if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 0.7) {
        this.stairsCooldown = 2;
        this.shake(0.5);
        audio.play('player_hurt');
        const dmg = Math.round(p.maxHp * 0.15);
        if (net.active) {
          // co-op: don't split the party — just take the fall damage and climb out
          p.takeDamage(dmg, this);
          p.pos.set(p.pos.x + 1.6, 0, p.pos.z + 1.6);
          this.ui.floaters.spawn(p.pos, 'You clamber out of the pit!', 'player-dmg');
        } else {
          p.hp = Math.max(1, p.hp - dmg);
          audio.play('stairs', { volume: 0.9, rate: 0.8 });
          this.loadFloor(this.floor + 1);
          this.ui.floaters.spawn(p.pos, `You fell! -${dmg}`, 'player-dmg');
        }
        return;
      }
    }
  }

  // Bricks and dust burst off walls when projectiles strike them.
  wallDebris(x, z) {
    this.particles.burst(x, 1.0, z, 7, 0x8a8590, { speed: 3, life: 0.4, size: 0.11, up: 0.9 });
    this.particles.burst(x, 1.0, z, 3, 0x5a5560, { speed: 1.6, life: 0.55, size: 0.18, up: 1.2 });
  }

  // Town: vendors open their shop when you walk up; the portal descends.
  updateTownInteractions(dt) {
    this.shopCooldown = Math.max(0, this.shopCooldown - dt);
    if (!this.dungeonMeshes) return;
    const p = this.player;

    // dungeon-side return portal → back to Embervale (checkpoint kept)
    const rp = this.dungeonMeshes.returnPortalMesh;
    if (!this.inTown && rp) {
      rp.rotation.y += dt * 1.2;
      const d = Math.hypot(p.pos.x - rp.position.x, p.pos.z - rp.position.z);
      if (!this.returnPortalArmed) {
        if (d > 3.0) this.returnPortalArmed = true;
      } else if (d < 1.7 && this.stairsCooldown <= 0) {
        audio.play('stairs', { volume: 0.8, rate: 1.2 });
        if (net.active && !net.isHost) {
          // slip back to your own town; the others keep fighting
          this.stairsCooldown = 2;
          this.localTown = true;
          this.loadTown();
        } else {
          this.loadTown();
        }
        return;
      }
    }

    if (!this.inTown) return;

    if (this.dungeonMeshes.portalMesh) {
      this.dungeonMeshes.portalMesh.rotation.y += dt * 0.6;
      const w = tileToWorld(this.dungeon.portal.x, this.dungeon.portal.y);
      if (this.stairsCooldown <= 0 && Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 1.5) {
        audio.play('stairs', { volume: 0.8 });
        if (net.active && !net.isHost) {
          // join the shared world wherever it currently is
          this.stairsCooldown = 2;
          if (this.lastWorldMsg && !this.lastWorldMsg.inTown) {
            this.localTown = false;
            this.applyWorld(this.lastWorldMsg);
          } else if (this.lastWorldMsg) {
            this.localTown = false;
            this.applyWorld(this.lastWorldMsg); // party is gathered in town
          } else {
            this.ui.floaters.spawn(p.pos, 'The dungeon has not been opened yet…', 'xp');
          }
        } else {
          this.loadFloor(this.floor);
        }
      }
    }

    if (this.shopCooldown <= 0) {
      for (const v of this.dungeonMeshes.vendorMeshes) {
        if (Math.hypot(p.pos.x - v.wx, p.pos.z - v.wz) < 1.9) {
          this.openShop(v);
          return;
        }
      }
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
          aw: this.inTown ? 1 : 0, // "away" = visiting town
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
      dead: p.dead ? 1 : 0, cls: p.classId, nm: this.playerName(), aw: this.inTown ? 1 : 0,
    }];
    for (const [id, rp] of this.remotePlayers) {
      pl.push({
        id, x: +rp.target.x.toFixed(2), z: +rp.target.z.toFixed(2),
        aim: +(rp.aim || 0).toFixed(2), mv: rp.moving ? 1 : 0, dead: rp.dead ? 1 : 0,
        cls: rp.cls, nm: rp.name, aw: rp.away ? 1 : 0,
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
