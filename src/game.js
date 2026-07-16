import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Input } from './core/input.js';
import { SaveManager } from './core/save.js';
import { audio } from './core/audio.js';
import { generateDungeon, generateTown, FLOOR, WALL, DOOR, BRIDGE } from './world/dungeon.js';
import { buildDungeonMeshes, TILE, tileToWorld, worldToTile, setWallCellStage, buildNpcModel } from './world/meshbuilder.js';
import { themeForFloor, actOfFloor, actFloorOf, makeGlowTexture } from './world/textures.js';
import { Player, xpForLevel } from './entities/player.js';
import { Enemy, Boss, ENEMY_TYPES, ACT_BOSSES, buildEnemyMesh, buildBossMesh, resetEnemyAnimBudget } from './entities/enemies.js';
import { attachEnemyModel, typeModelKey, bossModelKey } from './entities/enemyModel.js';
import { buildAnimatedHero, tintHoodedHeadMap, anchorToBodyBone, applyRobeTint } from './entities/heroModel.js';
import { CLASSES, buildHeroMesh } from './entities/classes.js';
import { ProjectileSystem } from './entities/projectiles.js';
import { LootSystem, generateGear, rollRarity, sellValue, gambleItem, dropLegendary, RARITIES, newItemId, WEAPON_ELEMENTS } from './entities/loot.js';

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
import { llm } from './ai/llm.js';
import { STORIES } from './story.js';
import { generateTavernInterior, buildTavernInterior, generateTavernUpstairs, buildTavernUpstairsInterior } from './world/tavern.js';
import { Wanderer } from './entities/wanderer.js';
import { TouchControls } from './core/touch.js';

// Five acts × ten floors; the Dungeon Lord waits on floor 50. Beyond lies the endless abyss.
const MAX_FLOOR = 50;
const ROMAN = [null, 'I', 'II', 'III', 'IV', 'V'];


export class Game {
  // Town day/night cycle: one full day + one full night takes DAY_NIGHT_PERIOD
  // seconds, so day is ~1 hour and night is ~1 hour (7200s total). Tunable here.
  static DAY_NIGHT_PERIOD = 7200;

  constructor() {
    this.canvas = document.getElementById('game-canvas');
    // powerPreference 'low-power' (Obsidian 755, per three.js power guidance):
    // on dual-GPU laptops the default can spin up the DISCRETE GPU for a
    // scene this simple - the reported "laptop heats up just standing there".
    // The integrated GPU renders Emberdeep's low-poly style comfortably.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'low-power' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08060c);
    this.scene.fog = new THREE.Fog(0x08060c, 18, 42);
    // A procedural PMREM environment so metal-ish materials (rarity-tinted
    // gear, most notably the knight's baked helmet - see updateHeroGear)
    // have something to reflect: without this, a metalness>0
    // MeshStandardMaterial renders flat/near-black, since PBR metal reflects
    // its surroundings rather than showing a diffuse colour. This generic
    // room is only the fallback used before any real scene exists (title
    // screen, char select); refreshEnvironmentReflection() below swaps it
    // for a snapshot of the actual town/dungeon once one is loaded, so the
    // reflection tracks the real torches/lighting instead of a generic room.
    this._pmremGen = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this._pmremGen.fromScene(new RoomEnvironment(), 0.04).texture;

    // baseFov is the field of view along the screen's SHORTER dimension
    // (min-dimension / "hor+" style scaling). Vertical FOV is derived from
    // it below and recomputed on every resize so that rotating the device
    // between portrait and landscape keeps the same amount of world in
    // view along the shorter axis, instead of the sudden zoom in/out that
    // a fixed vertical FOV causes when the aspect ratio flips.
    this.baseFov = 55;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, window.innerWidth / window.innerHeight, 0.1, 100);
    this._applyFovForAspect(window.innerWidth / window.innerHeight);
    this.cameraOffset = new THREE.Vector3(0, 11, 9.5);
    this.camYaw = 0; // Q/E (or touch buttons) orbit the camera around the hero
    this.camZoom = 1; // wheel / pinch zoom, clamped; restored from settings below

    // Zoom: mouse wheel (desktop) and two-finger pinch (touch) scale the camera
    // offset. Gated to gameplay so menus keep native scrolling.
    // Lower bound is small enough to push the camera right up to the hero's
    // face (full zoom-in) in any mode; upper bound keeps a sane pulled-back view.
    const clampZoom = (z) => Math.min(1.5, Math.max(0.12, z));
    window.addEventListener('wheel', (e) => {
      if (this.state !== 'playing') return;
      this.camZoom = clampZoom(this.camZoom * (1 + e.deltaY * 0.0011));
      this.settings.camZoom = +this.camZoom.toFixed(3);
      clearTimeout(this._zoomSaveT); // debounced write, not one per wheel tick
      this._zoomSaveT = setTimeout(() => this.saveSettings(), 800);
    }, { passive: true });
    this._pinch = null;
    window.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) this._pinch = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (this.state !== 'playing' || e.touches.length !== 2 || !this._pinch) return;
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      this.camZoom = clampZoom(this.camZoom * (this._pinch / d));
      this.settings.camZoom = +this.camZoom.toFixed(3);
      this._pinch = d;
    }, { passive: true });
    window.addEventListener('touchend', () => { this._pinch = null; }, { passive: true });

    // Two-thumb twist rotation (TODO 706) is now computed in touch.js
    // (TouchControls._syncTwist), which tracks every active CANVAS pointer
    // purely for this gesture - including the joystick's own finger - so a
    // real two-finger twist always registers even when one thumb starts
    // inside the joystick's capture zone. See this.touch.twistPending, drained
    // by the camera input block in updatePlaying below.

    // lights
    this.ambient = new THREE.AmbientLight(0x8a7a9a, 0.55);
    this.scene.add(this.ambient);
    this.playerLight = new THREE.PointLight(0xffd8a0, 40, 14, 1.8);
    this.scene.add(this.playerLight);
    // Town "sun": a directional light only used during the town day/night cycle
    // (off in the dungeon, which is torch-lit). Driven by updateDayNight().
    this.sunLight = new THREE.DirectionalLight(0xffe0b0, 0.0);
    this.sunLight.position.set(20, 40, 12);
    this.sunLight.visible = false;
    this.scene.add(this.sunLight);
    this.torchLights = [];
    // Continuous town clock (seconds). Time-of-day is derived from it so the
    // cycle is smooth and continuous; it does not need to survive reload.
    this.townClock = Math.random() * Game.DAY_NIGHT_PERIOD;

    this.input = new Input(this.canvas);
    const savedSettings = SaveManager.loadSettings();
    const firstVisit = !savedSettings;
    this.settings = Object.assign(
      { masterVolume: 0.8, musicVolume: 0.6, sfxVolume: 0.9, quality: 'medium', screenShake: true, voiceMode: 'ptt', voiceThreshold: 12, taunts: true, voiceChatVolume: 0.9, speechVolume: 0.9, camZoom: 1,
        // 18+ mode (Obsidian 793): OFF by default and behind an age agreement.
        // Gates ALL vulgar/NSFW dialogue - the rude patrons' crude brush-offs
        // (782) and the flirty tavern NPC's sexual lines (783). With it off,
        // rude NPCs are still dismissive but clean.
        adult18: false,
        keybinds: { interact: 'KeyF', potion: 'KeyR', talk: 'KeyV', inventory: 'Tab', quests: 'KeyJ', mastery: 'KeyK' } },
      savedSettings || {}
    );
    // first-ever visit: run the dialogue-forward auto-balance so the mix is
    // sane out of the box (speech reference, sfx -6dB, music pulled well down
    // to ~0.15 so it stays a background bed and never buries dialogue)
    if (firstVisit) {
      const db = (d) => Math.pow(10, d / 20);
      Object.assign(this.settings, {
        speechVolume: 1.0, voiceChatVolume: 1.0,
        sfxVolume: +db(-6).toFixed(2), musicVolume: 0.15, masterVolume: 0.85,
      });
    }
    // Battery saver: skip the heavy in-browser ML (TensorFlow.js movement net)
    // and the neural Kokoro TTS, using the browser's built-in speechSynthesis
    // instead. Default ON for everyone when the player has never chosen a
    // value; the first-launch modal (shown once from boot()) lets them opt
    // into full AI. this.firstBatteryChoice flags that one-time prompt.
    this.firstBatteryChoice = typeof this.settings.batterySaver !== 'boolean';
    if (this.firstBatteryChoice) {
      this.settings.batterySaver = true;
    }
    // ensure keybinds exist on older saves
    this.settings.keybinds = Object.assign({ interact: 'KeyF', potion: 'KeyR', talk: 'KeyV', inventory: 'Tab', quests: 'KeyJ', mastery: 'KeyK' }, this.settings.keybinds || {});
    // restore the last camera zoom (clamped in case of a hand-edited value)
    this.camZoom = Math.min(1.5, Math.max(0.12, this.settings.camZoom || 1));
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
    roaster.batterySaver = this.settings.batterySaver === true;
    this.applyAudioSettings();
    this.particles = new ParticleSystem(this.scene);
    this._glowTex = makeGlowTexture(); // shared additive glow sprite (impact flashes, flames)
    this.projectiles = new ProjectileSystem(this.scene);
    this.loot = new LootSystem(this.scene);
    this.ui = new UI(this);
    this.touch = new TouchControls(this);

    // Movement fail-safe: input.js already clears keys/mouse.down on blur and
    // touch.js already clears its joystick latch on blur, but neither knows
    // about the player's OWN transient movement state - a dash/whirl in
    // flight, a live drag-to-aim override, or moveDir itself - so a focus loss
    // mid-gesture (alt-tab, a native dialog stealing focus, etc.) could leave
    // the hero still holding a movement vector with nothing left pressed to
    // clear it. Zero everything movement-related here too, from both signals
    // (blur fires on focus loss even when the tab stays "visible"; hidden
    // covers tab-switch/minimize) so whichever fires first wins.
    const failsafeStopMovement = () => {
      this.input.keys.clear();
      this.input.mouse.down = false;
      this.input.mouse.rightDown = false;
      this.touch.joyActive = false;
      this.touch.move.x = 0; this.touch.move.z = 0;
      this.touch.rotDir = 0;
      const p = this.player;
      if (p) {
        p.moveDir.x = 0; p.moveDir.z = 0;
        p.dash = null;
        if (p.whirl) { p.whirl = null; audio.stopWhirl(); }
        if (p.glideVel) { p.glideVel.x = 0; p.glideVel.z = 0; }
        p.aimOverride = null;
      }
    };
    window.addEventListener('blur', failsafeStopMovement);
    document.addEventListener('visibilitychange', () => { if (document.hidden) failsafeStopMovement(); });

    // Flush an up-to-date save (incl. exact position) right before the page
    // goes away, so a REFRESH resumes exactly where you were (Obsidian 791).
    // pagehide covers mobile/bfcache where beforeunload is unreliable.
    const saveOnHide = () => {
      if (this.player && this.state !== 'title' && this.slotId) { this.savePending = true; this.flushSave(); }
    };
    window.addEventListener('pagehide', saveOnHide);
    window.addEventListener('beforeunload', saveOnHide);

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
    this.clearedFloors = {}; // { floor: true } once every enemy on that floor is slain
    // Destructible interior walls: SESSION-ONLY state (never written to the
    // save file). destroyedWallsSession[floor] is a Set of "x,y" cell keys
    // this character has broken open on that floor THIS session; loadFloor
    // re-applies it after every (re)generation so a revisit keeps its holes.
    // destructibleWallHits tracks in-progress damage ("floor:x,y" -> hit
    // count, 1 or 2; the 3rd hit finalizes the break and the key is dropped).
    // Both reset to empty on startNewGame/continueGame (a fresh session).
    this.destroyedWallsSession = {};
    this.destructibleWallHits = {};
    this.inTown = false;
    this.inTavern = false;
    this.inUpstairs = false; // tavern upstairs rooms (800)
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
    this._buildAimIndicator();

    window.addEventListener('resize', () => this.onResize());
    this.applyQuality();

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop((t) => this.frame(t));
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
    voice.attachToRoom(net.room);
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
    // capture: true so the unlock still fires when the first tap lands on a
    // UI button that calls stopPropagation() (touch cluster, drawer, potion) -
    // capture listeners on window run before the target can swallow the event.
    const unlock = () => { audio.init(); audio.resume(); };
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });

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
    // Battery saver skips TensorFlow.js entirely; enemies fall back to base AI.
    if (!this.settings.batterySaver) learner.init();

    // Neural character voices (Kokoro, ~90 MB) download as the FINAL loading
    // phase so their progress shows in the loading bar. Soft-capped at 30s: if
    // the download is slow we proceed to the title and it finishes in the
    // background (lines stay subtitle-only until it's ready). Cached on repeat
    // visits, so this is near-instant after the first load.
    // If a backend was pinned on a prior visit the model is already in the
    // browser cache, so this is a fast local LOAD, not a fresh download — say so
    // instead of alarming the player with "Downloading" on every refresh.
    // Battery saver never touches Kokoro: no download, no main-thread inference,
    // so the dungeon TTS freeze cannot happen. Characters speak via the built-in
    // speechSynthesis path in roaster.js instead.
    try {
      if (this.settings.batterySaver) throw new Error('battery-saver');
      const { neuralVoice } = await import('./ai/neuralVoice.js');
      // On phones the heavy model is skipped to avoid an out-of-memory crash,
      // so don't flash a misleading "Downloading" step there.
      const voiceVerb = localStorage.getItem('emberdeep-tts-backend') ? 'Loading' : 'Downloading';
      if (!neuralVoice.memoryConstrained) this.ui.setLoadingProgress(0.7, `${voiceVerb} natural voices…`);
      // Float a "speaking soon" bubble over the speaker's head while their line
      // is being synthesized (before audio starts). anchor is the world pos the
      // caller passed to speak(); no anchor (e.g. a title-screen line) = no bubble.
      neuralVoice.onGenerating = (active, anchor) => {
        if (active && anchor) this.ui.floaters.showThinking(anchor);
        else this.ui.floaters.hideThinking();
      };
      neuralVoice.onStatus = (st, prog) => {
        if (st === 'loading') {
          const p = Math.max(0, prog || 0);
          this.ui.setLoadingProgress(0.7 + p * 0.3, p > 0 ? `${voiceVerb} natural voices… ${Math.round(p * 100)}%` : `${voiceVerb} natural voices…`);
        } else if (st === 'ready') {
          this.ui.setLoadingProgress(1, 'Ready');
        }
      };
      await Promise.race([neuralVoice.load(), new Promise((res) => setTimeout(res, 30000))]);
    } catch { /* voices are optional — never block boot on them */ }

    this.ui.setLoadingProgress(1, 'Ready');
    this.state = 'title';
    this.ui.showTitle();

    // Post-update auto-resume (Obsidian 730): the "Update ready" toast stamps
    // this sessionStorage flag right before reloading. Land the player back
    // in their most recent session instead of at the title menu. Multiplayer
    // guests resume their hero in single player (a room can't be silently
    // rejoined after a reload); a first-ever visit has no saves, so this can
    // never race the battery-saver modal below.
    // Auto-resume on reload. Two triggers:
    //  - emberdeep-resume-v1: one-shot stamp from the update toast (730/779).
    //  - emberdeep-in-game: set for the whole time the player is in a session
    //    and CLEARED on quit-to-title, so it survives a plain page REFRESH but
    //    not a fresh tab or a deliberate return to the menu. This is what makes
    //    "refresh -> land exactly where I was" work (Obsidian 791).
    try {
      if (sessionStorage.getItem('emberdeep-resume-v1') || sessionStorage.getItem('emberdeep-in-game')) {
        sessionStorage.removeItem('emberdeep-resume-v1');
        const recent = SaveManager.listSaves()[0];
        if (recent) { this.continueGame(recent.id); return; }
      }
    } catch { /* storage unavailable - fall through to the title */ }

    // First-ever visit: battery saver defaulted ON above without asking.
    // Offer the same explanatory modal used for later re-toggles so the
    // player can opt into full AI (smarter bosses, neural voices) right away.
    if (this.firstBatteryChoice) {
      this.firstBatteryChoice = false;
      this.ui.promptBatterySaverChoice(true);
    }
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
    this.vendorMemory = {}; // per-vendor { met, lastItem } for greeting-first dialogue
    if (this._tavernKeep) { this._tavernKeep.meshes.group.traverse((o) => o.geometry?.dispose?.()); this._tavernKeep = null; }
    this._rosalindMet = false; // fresh character: she'll walk up to you once
    this._npcMem = null; // fresh character: the regulars know nothing yet (884)
    this.clearedFloors = {}; // fresh character, nothing culled yet
    this.destroyedWallsSession = {}; // fresh session: every wall whole again
    this.destructibleWallHits = {};
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
    this.vendorMemory = data.vendorMemory || {};
    this._rosalindMet = !!data.rosalindMet; // persist "she's already approached you once" (828)
    this._usedBanter = Array.isArray(data.usedBanter) ? data.usedBanter : [];
    this._npcMem = data.npcMem && typeof data.npcMem === 'object' ? data.npcMem : null; // per-NPC memory files (884)
    this.clearedFloors = data.clearedFloors || {}; // absent on pre-feature saves
    this.destroyedWallsSession = {}; // session-only: never persisted, always fresh
    this.destructibleWallHits = {};
    if (this.floor === MAX_FLOOR && this.bossDefeated) this.floor = MAX_FLOOR + 1;
    this.ui.buildHotbar(this.player);
    // A mid-dungeon refresh drops you back onto the floor you were fighting on,
    // not town. Enemies respawn for that floor (exact combat state isn't saved).
    // MP guests always rejoin through the host's world instead.
    // Resume EXACTLY where the hero stood (Obsidian 791): the floor/town layout
    // is deterministic for this slot, so the same map regenerates. loadFloor/
    // loadTown position the player at the spawn from a DEFERRED loading stage,
    // which would clobber a position set here - so stash it and let the spawn
    // code apply it right after it sets the spawn (enemies still respawn; exact
    // combat state isn't saved). Guarded against missing/old saves.
    this._resumePos = (typeof data.px === 'number' && typeof data.pz === 'number') ? { x: data.px, z: data.pz } : null;
    if (data.inDungeon && this.floor >= 1 && !(net.active && !net.isHost)) {
      this.loadFloor(this.floor);
      this.enterPlaying();
    } else {
      this.enterWorld();
      // resume back inside the tavern if that's where the refresh happened (791)
      if (data.inTavern && this.inTown && this.loadTavern) { try { this.loadTavern(); } catch { /* fall back to town */ } }
    }
  }

  // Everyone starts in their OWN town — guests included. A guest only joins
  // the host's world by stepping through the dungeon portal.
  // Tracks whether the player is in an actual game session (vs the title/menu)
  // so the update toast (main.js, Obsidian 779) only auto-resumes into the
  // game when they were IN a game - clicking update from the menu returns to
  // the menu, not into a session.
  _markInSession(on) { try { if (on) sessionStorage.setItem('emberdeep-in-game', '1'); else sessionStorage.removeItem('emberdeep-in-game'); } catch { /* private mode */ } }

  enterWorld() {
    this._markInSession(true);
    if (net.active && !net.isHost) {
      net.send({ t: 'hello', cls: this.player.classId, name: this.playerName(), gn: this.player.gender, sk: this.player.skinTone, hc: this.player.hairColor, ec: this.player.eyeColor, fs: this.player.faceShape, hs: this.player.hairStyle });
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
    this.touch.maybeShowHint?.();
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
    this._bossMusicOn = false;
    this.state = 'title';
    this._markInSession(false); // back at the menu (779)
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
    this._bossMusicOn = false;
    audio.playMusic(audio.dungeonTrack(this.currentAct()), 2);
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
    audio.stopFireCrackle(); // hearth loop is tavern-only (717); no-op elsewhere
    if (this._tavernOutside) { this.scene.remove(this._tavernOutside); this._tavernOutside = null; this._cullTavernOutside = null; } // 852 surround
    if (this.dungeonMeshes) {
      this.scene.remove(this.dungeonMeshes.group);
      this.dungeonMeshes.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      this.dungeonMeshes = null;
    }
    for (const e of this.enemies) { e.mesh.userData.detached = true; this.scene.remove(e.mesh); }
    this.enemies = [];
    if (this.deathMarkers) { for (const d of this.deathMarkers) this.scene.remove(d.mesh); this.deathMarkers = []; }
    if (this.wallMarks) { for (const d of this.wallMarks) this.disposeMarkEntry(d); this.wallMarks = []; }
    // flash sprites are a persistent pool (753): remove them from the scene
    // on teardown and drop the pool so the next floor rebuilds it fresh
    if (this._flashPool) { for (const s of this._flashPool) this.scene.remove(s); this._flashPool = null; }
    if (this.impactFlashes) this.impactFlashes = [];
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
  // Quick-return tavern cache (Obsidian 763): leaving the tavern stashes the
  // LIVE interior (meshes + NPC positions + conversation timers) instead of
  // destroying it, so stepping out and back in within a minute resumes the room
  // exactly - nobody teleports back to their seat, the banter doesn't reset.
  _stashTavern() {
    if (!this.inTavern || this.inUpstairs || !this.dungeonMeshes || !this.dungeonMeshes.patronMeshes?.length) return;
    if (this._tavernKeep) this._tavernKeep.meshes.group.traverse((o) => o.geometry?.dispose?.());
    this.scene.remove(this.dungeonMeshes.group);
    this._tavernKeep = {
      dungeon: this.dungeon, meshes: this.dungeonMeshes, at: performance.now(),
      convoT: this._convoT, convo: this._tavernConvo, convoIdx: this._convoIdx,
      convoPlans: this._tavernConvoPlans, planIdx: this._tavernPlanIdx,
    };
    this.dungeonMeshes = null; // teardownFloor skips disposal of a stashed room
  }

  loadTavern() {
    // resume the stashed room if we left it moments ago (763)
    const keep = this._tavernKeep;
    const resume = keep && performance.now() - keep.at < 60000;
    if (keep && !resume) {
      // expired: free the old room's geometry before rebuilding fresh
      keep.meshes.group.traverse((o) => o.geometry?.dispose?.());
      this._tavernKeep = null;
    }
    this._stashTavern(); // (coming DOWN from upstairs never stashes - guard above)
    this.teardownFloor();
    this.inTown = true;
    this.inTavern = true;
    this.inUpstairs = false;
    if (this._lyingBed) { this._lyingBed = null; if (this.player?.mesh) this.player.mesh.rotation.x = 0; }
    this._followScene = null; // coming back down cancels any in-flight walk (873)
    this._sceneLock = false;  // re-arm the stuck-failsafe off the scripted floor (874)
    if (resume) {
      this._tavernKeep = null;
      this.dungeon = keep.dungeon;
      this.dungeonMeshes = keep.meshes;
      this.scene.add(this.dungeonMeshes.group);
      this._convoT = keep.convoT; this._tavernConvo = keep.convo; this._convoIdx = keep.convoIdx;
      this._tavernConvoPlans = keep.convoPlans; this._tavernPlanIdx = keep.planIdx;
    } else {
      this.dungeon = generateTavernInterior();
      this.dungeonMeshes = buildTavernInterior();
      this.scene.add(this.dungeonMeshes.group);
    }
    // The REAL town outside the windows (Obsidian 852): Embervale is fully
    // deterministic (fixed seed), so build the actual town meshes around the
    // interior, aligned so the tavern's own plot centre sits at the interior's
    // centre - looking through the cut windows shows the REAL village (the same
    // houses/trees/lanes you walk outside), with true depth and parallax.
    // Anything that would intrude INSIDE the room's footprint is culled per
    // top-level child (bounding-box test); town-spanning ground/roads stay.
    try {
      const town = generateTown();
      const outside = buildDungeonMeshes(town, themeForFloor(1));
      const t = town.tavern; // 7x5-tile plot on the west side
      const plotCx = (t.x + t.w / 2) * TILE, plotCz = (t.y + t.h / 2) * TILE;
      // Sunk 0.35 below the interior: the town's own ground plane is at y=0,
      // exactly the interior floor's top - coplanar, it z-fought THROUGH the
      // wood (grass stripes inside the room). Sinking the whole outside world
      // puts its ground + grass tufts safely under the room's floor slab, and
      // through a window at eye level a 0.35 drop is imperceptible.
      outside.group.position.set((16 * TILE) / 2 - plotCx, -0.35, (12 * TILE) / 2 - plotCz);
      // Cull anything that would intrude into the room. Runs at load AND again
      // shortly after, because the nature props (trees etc.) stream in from
      // async GLB loads and land in the group later; instanced meshes (town
      // floor/wall tiles) get their in-room INSTANCES zero-scaled instead.
      const roomRect = new THREE.Box3(
        new THREE.Vector3(-1.5, -5, -1.5),
        new THREE.Vector3(16 * TILE + 1.5, 99, 12 * TILE + 1.5));
      const cullOutside = () => {
        const grp = this._tavernOutside;
        if (!grp) return;
        grp.updateMatrixWorld(true);
        const _bb = new THREE.Box3(), _sz = new THREE.Vector3();
        const _m = new THREE.Matrix4(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);
        for (const child of [...grp.children]) {
          if (child.isLight) continue;
          if (child.isInstancedMesh) {
            let dirty = false;
            for (let i = 0; i < child.count; i++) {
              child.getMatrixAt(i, _m);
              const wx = _m.elements[12] + grp.position.x, wz = _m.elements[14] + grp.position.z;
              if (wx > roomRect.min.x && wx < roomRect.max.x && wz > roomRect.min.z && wz < roomRect.max.z) {
                child.setMatrixAt(i, _zero); dirty = true;
              }
            }
            if (dirty) child.instanceMatrix.needsUpdate = true;
            continue;
          }
          _bb.setFromObject(child); _bb.getSize(_sz);
          const groundLike = _sz.x > 40 || _sz.z > 40; // spans the town: ground/roads
          if (!groundLike && _bb.intersectsBox(roomRect)) grp.remove(child);
        }
      };
      // moonlit-dusk fill so the village reads through the panes at night
      outside.group.add(new THREE.HemisphereLight(0x8fa0c8, 0x0c0c14, 0.4));
      this.scene.add(outside.group);
      this._tavernOutside = outside.group;
      cullOutside();
      // Nature props stream in from async GLB loads at unpredictable times, so
      // a fixed schedule of passes always left a window for a late bush to pop
      // through the floor (864). Keep the fn and re-sweep every 2.5s from the
      // tavern tick for the whole stay - it only walks the surround group's
      // direct children, so it's cheap.
      this._cullTavernOutside = cullOutside;
      for (const ms of [1000, 2000, 3500]) setTimeout(cullOutside, ms);
    } catch { this._tavernOutside = null; this._cullTavernOutside = null; /* windows fall back to their diorama */ }
    this.openedDoors = new Set();
    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.setTownAtmosphere(true); // warm lamplit tavern (see setTownAtmosphere)
    const theme = themeForFloor(1);
    this.setupTorchLights({ ...theme, accent: 0xffb877 });
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner('THE SLEEPING GOLEM', 'Rest a while, hero', true);
    audio.playMusic('tavern');
    audio.startAmbience('tavern'); // room tone + occasional pops
    // Positional hearth crackle (Obsidian 717): a dedicated loop whose level
    // tracks the player's distance to the fire each frame (see updatePlaying),
    // so standing at the hearth is unmistakably crackly and the far corner
    // barely murmurs. Torn down in teardownFloor.
    audio.startFireCrackle();
    // Ambient table-talk lines are pre-synthesized ONCE here (736): the
    // exchanges then replay from cache while the player idles - no periodic
    // Kokoro inference while chilling in the room.
    if (!resume) {
      this._tavernConvoPlans = roaster.prepareTavernConvo();
      this._tavernPlanIdx = 0;
    }
    // Warm the LLM banter pool the moment the door opens (884): two fetches in
    // flight so the very first audible exchange is LLM-written when reachable.
    this._fetchFreshConvo(); this._fetchFreshConvo();
    this.stairsCooldown = 1.5;
  }

  // ---------------- tavern upstairs rooms (Obsidian 800) ----------------
  // A separate lamplit interior above the tavern: a hallway landing with four
  // guest-room doorways, the rightmost being Rosalind's. Reached from the stair
  // base on the tavern floor; left again via the stairwell back down. Shares the
  // tavern flag (inTavern) so the guarded per-frame tavern code no-ops safely,
  // plus inUpstairs to swap the stair interacts and the floor label.
  loadTavernUpstairs(opts = {}) {
    this._stashTavern(); // the ground floor resumes exactly when you come back down (763)
    this.teardownFloor();
    this.inTown = true;
    this.inTavern = true;
    this.inUpstairs = true;
    this.dungeon = generateTavernUpstairs();
    this.dungeonMeshes = buildTavernUpstairsInterior();
    this.scene.add(this.dungeonMeshes.group);
    this.openedDoors = new Set();
    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    this.setTownAtmosphere(true);
    const theme = themeForFloor(1);
    this.setupTorchLights({ ...theme, accent: 0xffb877 });
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner('THE SLEEPING GOLEM', 'Upstairs — guest rooms', true);
    audio.playMusic('tavern');
    audio.startAmbience('tavern');
    // no ambient table-talk up here (no patrons) - keep the shared driver a no-op
    this._tavernConvoPlans = [];
    this._tavernPlanIdx = 0;
    this.stairsCooldown = 1.5;
  }

  // ---------------- town ----------------
  loadTown(opts = {}) {
    this._stashTavern(); // quick re-entry resumes the same room (763)
    this.teardownFloor();
    this.inTown = true;
    this.inTavern = false;
    this.inUpstairs = false;
    this._followScene = null; this._sceneLock = false; // off the scripted floor (873/874)
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
        // doorstep tile: same W*0.28 door-offset rule the facade and the
        // enter-trigger use, so this stays aligned however the plot resizes
        ? { x: Math.round(this.dungeon.tavern.x + this.dungeon.tavern.w / 2 - 0.5 + this.dungeon.tavern.w * 0.28), y: this.dungeon.tavern.y + this.dungeon.tavern.h + 1 }
        : this.dungeon.spawn;
    const spawn = tileToWorld(spawnTile.x, spawnTile.y);
    this.player.pos.set(spawn.x, 0, spawn.z);
    // Resume-exact override (791): a refresh in town lands the hero where they
    // stood. Safe to apply unconditionally - _resumePos is only ever set by
    // continueGame and cleared on first use, so normal town arrivals never see it.
    if (this._resumePos) { this.player.pos.set(this._resumePos.x, 0, this._resumePos.z); this._resumePos = null; }
    this.player.dead = false;
    // Reaching town resets combat cooldowns so the hero starts a fresh delve
    // with everything ready (no leftover ability/attack timers from the fight
    // that ended the last floor).
    this.player.abilityCds = this.player.abilityCds.map(() => 0);
    this.player.attackCd = 0;

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
    audio.startAmbience('town'); // open-square wind + birdsong
    this.shopCooldown = 1;
    this.requestSave(true);
    this.refreshEnvironmentReflection();

    if (net.isHost) this.broadcastWorld();
  }

  // Rebuilds scene.environment from an actual snapshot of the CURRENT
  // town/dungeon (via a throwaway CubeCamera near the spawn point) instead
  // of the generic fallback room, so metal gear (see updateHeroGear's knight
  // helmet) reflects a faded impression of the real nearby torches/walls
  // rather than a made-up interior. Called once per town/floor load (a
  // handful of times per session) - NOT per frame, so the CubeCamera's six
  // renders + PMREM convolution cost is a one-off scene-transition expense,
  // not an ongoing one.
  refreshEnvironmentReflection() {
    if (!this.dungeonMeshes) return;
    const spawn = this.player?.mesh?.position ?? new THREE.Vector3(0, 1.6, 0);
    const rt = new THREE.WebGLCubeRenderTarget(128);
    const cubeCam = new THREE.CubeCamera(0.1, 60, rt);
    cubeCam.position.set(spawn.x, 1.7, spawn.z);
    cubeCam.update(this.renderer, this.scene);
    const oldEnv = this.scene.environment;
    this.scene.environment = this._pmremGen.fromCubemap(rt.texture).texture;
    if (oldEnv && oldEnv !== this.scene.environment) oldEnv.dispose();
    rt.dispose();
  }

  // Vendors roam a small tether around their booth: amble to a nearby point
  // behind the counter, idle a while, pick another. When the local player
  // gets close they stop wandering and turn to face them instead.
  updateVendors(dt) {
    const vendors = this.dungeonMeshes?.vendorMeshes;
    if (!vendors) return;
    this._vt = (this._vt || 0) + dt;
    const p = this.player;
    const TETHER = 1.2;   // max wander radius around the booth anchor
    const SPEED = 0.6;    // slow amble, world units/sec
    const wrapAngle = (a) => { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };
    vendors.forEach((v) => {
      const k = v.keeper;
      const home = v.keeperHome;
      if (!k || !home) return;
      // never wander past the counter toward the customer side
      const keeperSideZ = home.z + 0.28;
      const roam = v._roam || (v._roam = { target: home.clone(), idle: 1 + Math.random() * 2 });

      const dx = p.pos.x - (v.wx + k.position.x), dz = p.pos.z - (v.wz + k.position.z);
      // Face the player ONLY while their shop is actually open (Obsidian 726:
      // town NPCs must not swivel at mere proximity - they turn when the
      // interaction button is clicked, i.e. openShop sets activeVendor).
      if (this.activeVendor === v && this.state === 'shop') {
        const faceYaw = Math.atan2(dx, dz);
        k.rotation.y += wrapAngle(faceYaw - k.rotation.y) * Math.min(1, dt * 4);
        k.position.y = home.y + Math.abs(Math.sin(this._vt * 1.1)) * 0.02;
        return;
      }

      const distToTarget = Math.hypot(k.position.x - roam.target.x, k.position.z - roam.target.z);
      if (distToTarget < 0.05) {
        roam.idle -= dt;
        if (roam.idle <= 0) {
          const a = Math.random() * Math.PI * 2;
          const rad = 0.3 + Math.random() * (TETHER - 0.3);
          // clamp inside the rebuilt booth shell: side panels at local x +/-1.2,
          // back wall at z=-0.9, counter at z=+0.3 (keeperSideZ handles that
          // side) - so the amble never walks the keeper through the booth.
          // z floor -0.45 (was -0.68): stay clear of the back-wall shelf's
          // front edge so goods never intersect the keeper's head (726).
          roam.target.set(
            Math.max(-0.95, Math.min(0.95, home.x + Math.cos(a) * rad)),
            home.y,
            Math.max(-0.45, Math.min(home.z + Math.sin(a) * rad, keeperSideZ)));
          roam.idle = 1.5 + Math.random() * 2.5;
        }
      } else {
        const step = Math.min(distToTarget, SPEED * dt);
        const ang = Math.atan2(roam.target.x - k.position.x, roam.target.z - k.position.z);
        k.position.x += Math.sin(ang) * step;
        k.position.z += Math.cos(ang) * step;
        k.rotation.y = ang;
      }
      k.position.y = home.y + Math.abs(Math.sin(this._vt * 0.9)) * 0.02;
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

  // Zoltan: at most 3 gamble purchases per rolling window (10 minutes,
  // session-only - not saved/persisted, resets on reload). Returns the epoch
  // ms (performance.now() scale) the NEXT purchase becomes legal, or 0 if
  // one is allowed right now. this._gambleWindowMs defaults to 10 minutes
  // but can be overridden (e.g. by a test) to shrink the window.
  gambleReadyAt() {
    const windowMs = this._gambleWindowMs ?? 10 * 60 * 1000;
    const buys = (this._gambleBuys || []).filter((t) => performance.now() - t < windowMs);
    this._gambleBuys = buys;
    const windowReadyAt = buys.length >= 3 ? buys[0] + windowMs : 0;
    return Math.max(this._gambleReadyAt || 0, windowReadyAt);
  }

  buyFromVendor(vendor, entry) {
    const p = this.player;
    const remaining = entry.qty != null ? entry.qty : (entry.sold ? 0 : 1);
    if (remaining <= 0 || p.gold < entry.price) return;
    // Zoltan's gamble has a short spam-guard (6s) AND a 3-per-10-minute cap;
    // whichever is stricter blocks the buy.
    if (entry.kind === 'gamble') {
      const left = Math.ceil((this.gambleReadyAt() - performance.now()) / 1000);
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
      this._gambleReadyAt = performance.now() + 6000; // fate must rest (spam guard)
      (this._gambleBuys ||= []).push(performance.now()); // 3-per-10-min tracker
      this.ui.showRelicReveal(item); // pop up what fate handed over
    }
    // remember what the player bought here so a later greeting can ask about it
    if (vendor?.name) {
      const mem = this.vendorMemory[vendor.name] || {};
      this.vendorMemory[vendor.name] = { ...mem, met: true, lastItem: entry.label.replace(/\s*\(.*?\)\s*$/, '') };
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

  // Human-readable room name for the HUD (empty when solo). Strips the
  // internal 'emberdeep-room-' prefix and shows what the player typed.
  roomName() {
    if (!net.active || !net.roomId) return '';
    return net.roomId.replace(/^emberdeep-room-/, '').toUpperCase();
  }

  // Quest log data: main quest chain (one act boss per act) + run stats.
  questState() {
    const themeNames = [null, 'The Old Halls', 'The Rotting Depths', 'The Ember Vaults', 'The Sunless Court', 'The Abyssal Throne'];
    const current = Math.min(5, this.actsCleared + 1);
    const acts = [];
    const capped = Math.min(this.floor, MAX_FLOOR);
    for (let a = 1; a <= 5; a++) {
      const cleared = this.actsCleared >= a;
      // Real floor progress within the act: 10 floors each, the boss waits on
      // the 10th. Uses the hero's current/checkpoint floor while it is inside
      // this act; cleared acts read full, unvisited ones 0.
      const progress = cleared ? 10
        : (actOfFloor(capped) === a ? Math.max(0, Math.min(10, actFloorOf(capped))) : 0);
      acts.push({
        act: a,
        title: `Act ${ROMAN[a]} — ${themeNames[a]}`,
        objective: `Slay ${ACT_BOSSES[a].name}`,
        cleared,
        current: !this.bossDefeated && a === current,
        progress,
        total: 10,
        reward: this.actBossRewardText(a),
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

  // What slaying an act's boss ACTUALLY pays (quest log reward line + the
  // quest-complete toast). Mirrors Boss's xp/goldRange in enemies.js and the
  // guaranteed-epic branch of rollDeathLoot, so the promise matches the drop.
  actBossRewardText(act) {
    return `${220 + act * 160} XP · ${60 + act * 25}-${120 + act * 40} gold · Epic gear`;
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
    this._conversationZoom();
    const p = this.player;
    const n = this.playerName();
    const bodies = [];
    if (p.hp < p.maxHp * 0.6) bodies.push('Rough night? Sit by the fire, the hearth mends what potions can\'t.');
    if (this.deaths >= 3) bodies.push('Heard the floor\'s been winning. It always brags. Ignore it.');
    if (this.actsCleared >= 1) bodies.push(`Word travels fast. ${['', 'Malruk', 'Sszarra', 'Vexmal', 'the Colossus'][this.actsCleared] || 'The lords'} fell to you, and the first round's still full price.`);
    bodies.push(
      'Welcome to the Sleeping Golem. He\'s out back. Still sleeping.',
      'Zoltan\'s dice are loaded. Course they are. Doesn\'t mean they won\'t love you.',
      'The bard quit. Said the dungeon "hummed in the wrong key". So it\'s just the fire and me.',
    );
    const body = bodies[Math.floor(Math.random() * bodies.length)];
    const memory = this.vendorMemory['Magda the Barkeep'] || {};
    const line = roaster.composeVendorLine('barkeep', { playerName: n, memory, body });
    if (!memory.met) { this.vendorMemory['Magda the Barkeep'] = { met: true }; this.requestSave(); }
    const b = this.dungeonMeshes.barkeepPos;
    // She faces the player only for the duration of this exchange (735).
    if (this.dungeonMeshes.talkGate) this.dungeonMeshes.talkGate.magdaUntil = performance.now() + 7000;
    // Female voice, unused elsewhere: af_kore (not shared with Maribel/af_bella,
    // the sober patron/af_sarah, or any enemy/boss cast in roaster.js).
    roaster.sayGated(this, 'Magda the Barkeep', line,
      { female: true, vi: 3, pitch: 1.15, rate: 0.95, kokoro: 'af_kore', kSpeed: 0.95 }, b, { priority: true });
  }

  patronChat(pm) {
    this._conversationZoom();
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
    // Rude patrons (Obsidian 782): non-worker regulars who don't want to talk.
    // Curt, dismissive brush-offs instead of helpful tavern gossip. The CRUDE
    // versions are gated behind 18+ mode (Obsidian 793); with it off the same
    // patron is still dismissive but keeps it clean.
    const rudeCleanLines = [
      'Not now. I\'m drinking.',
      'Do I look like I want company? Leave me be.',
      'Move along, hero. Bother someone who cares.',
      'I didn\'t ask for a chat. Away with you.',
      'Not interested. Off you go.',
    ];
    const rudeVulgarLines = [
      'Fuck off. I\'m drinking.',
      'Piss off, hero. Go bother someone who gives a shit.',
      'Do I look like I want company? Fuck off.',
      'Shut your mouth and fuck off before I break your teeth.',
      'Not interested. Now fuck off.',
      'Christ, another cocky prick. Fuck off.',
    ];
    const rudeLines = this.settings.adult18 ? rudeVulgarLines : rudeCleanLines;
    const rude = pm.mood === 'rude';
    const bank = rude ? rudeLines : pm.drunk ? drunkLines : soberLines;
    const line = bank[Math.floor(Math.random() * bank.length)];
    // A rude patron gets a flatter, colder delivery than the chatty regulars.
    const cast = pm.drunk
      ? { female: false, vi: 6, pitch: 1.05, rate: 0.8, kokoro: 'bm_daniel', kSpeed: 0.82 }
      : rude
        ? { female: true, vi: 2, pitch: 0.92, rate: 1.05, kokoro: 'af_sarah', kSpeed: 1.05 }
        : { female: true, vi: 3, pitch: 1.05, rate: 1.0, kokoro: 'af_sarah', kSpeed: 1.0 };
    pm.talkUntil = performance.now() + 7000; // stool-swivel toward the player only mid-conversation (735)
    // Bubble label = the patron's own NAME once they have one (other NPCs will
    // refer to them by it - 781/787), else a descriptive stand-in. Read live
    // each utterance, so the moment a patron is named the label updates itself
    // (Obsidian 790).
    const speaker = pm.name || (pm.drunk ? 'Tipsy Regular' : rude ? 'Surly Patron' : 'Tavern Patron');
    roaster.sayGated(this, speaker, line, cast, pm, { priority: true });
  }

  // ---- Rosalind, the tavern flirt (Obsidian 783) ----------------------------
  // A branching, affinity-driven chat. Four replies each turn span a range from
  // cold to forward; warm/forward replies raise her affinity and she flirts
  // harder, cold ones cool her until she gives up on you. Overtly sexual/NSFW
  // lines appear ONLY in 18+ mode (793); with it off she stays suggestive but
  // clean. If the PLAYER is female she reads as into women (a lesbian flirt).
  // A distinct, sultry voice for Rosalind (not af_sarah, which the ambient
  // patrons use): af_nicole is Kokoro's soft/breathy timbre; a lower pitch and
  // slower cadence read as sexy rather than chirpy.
  _flirtVoice() { return { female: true, vi: 3, pitch: 0.96, rate: 0.9, kokoro: 'af_nicole', kSpeed: 0.9 }; }
  _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Stand the player up from a tavern stool (Obsidian 792). Bar seats step the
  // hero off into the room so they don't stand up inside the counter overhang.
  _standFromSeat() {
    const s = this.seatedAt;
    this.seatedAt = null;
    this._seatCd = performance.now() + 600; // block an immediate re-sit (805)
    if (s && s.kind === 'bar') this.player.pos.z = s.z + 0.7;
  }

  // Get up from a bed (Obsidian 842b/846): un-tip the hero, restore the weapon,
  // step off toward the room.
  _standFromBed() {
    const b = this._lyingBed;
    this._lyingBed = null;
    if (this.player.mesh) {
      this.player.mesh.rotation.order = 'XYZ'; // back to the walk/aim convention
      this.player.mesh.rotation.set(0, 0, 0);  // player.js re-sets y next frame
    }
    (this._lyWeaponHidden || []).forEach((o) => { o.visible = true; });
    this._lyWeaponHidden = null;
    // Step OFF the bed to a guaranteed-walkable spot (874): the pinned lie
    // position sits on a WALL-flagged bed tile, so just restoring standZ could
    // still land on solid ground and trip the stuck-failsafe the moment you
    // stand ("freed from the stone" on get-up). Walk outward until clear.
    const p = this.player;
    if (b && b.standZ != null) p.pos.z = b.standZ;
    if (!this.isWalkable(p.pos.x, p.pos.z, 0.3)) {
      outer: for (let r = 1; r <= 4; r++) {
        for (const [ox, oz] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const x = p.pos.x + ox * r * (TILE / 2), z = p.pos.z + oz * r * (TILE / 2);
          if (this.isWalkable(x, z, 0.3)) { p.pos.set(x, 0, z); break outer; }
        }
      }
    }
    // brief failsafe grace so a one-frame overlap during the step-off can't fire
    this._stuckT = -0.5;
    this._seatCd = performance.now() + 500;
  }

  // If the camera is zoomed right in, ease it back out when a conversation
  // starts so the speech bubble over the NPC's head is actually readable (858).
  _conversationZoom() {
    if ((this.camZoom || 1) < 0.85) this.camZoom = 0.85;
  }

  flirtChat(pm) {
    this._conversationZoom();
    if (pm.affinity == null) pm.affinity = 0;
    // Any conversation counts as "met" (828): once you've talked to her, she
    // never walks up to you again - you approach her from then on. Persisted.
    if (pm.flirty && !this._rosalindMet) { this._rosalindMet = true; this.requestSave(); }
    // The picker is an OVERLAY, not a modal state: the world keeps running and
    // you can still move with WASD/touch while it's up (user request); walking
    // away just closes it (see the distance check in updatePlaying).
    this._flirtActive = pm;
    pm.talkUntil = performance.now() + 15000;
    const female = this.player.gender === 'female';
    // Re-engagements get their OWN varied bank (Obsidian 856: leaving and talking
    // again 20s later replayed the exact first-meeting "*hic* Well hello, hero"
    // intro). The introduction lines only ever play on the true first exchange.
    const talkedBefore = (pm._flirtEx || 0) > 0 || pm._greeted;
    pm._greeted = true;
    const cannedOpener = () => {
      if (pm.affinity <= -3) return this._pick(['Oh. You again. Thought I made myself clear.', 'Back for more? I already lost interest, sweetheart.']);
      if (pm._hadDrink && !pm._toasted) {
        pm._toasted = true;
        return this._pick(['*clinks your mug* To bad decisions and better company.', 'Mmm, honeyed ale. You spoil me, hero. *sips*']);
      }
      if (talkedBefore) {
        return pm.affinity >= 3
          ? this._pick(['Miss me already? Good.', 'Mmm, I was hoping you\'d come back to me.', female ? 'Back so soon, gorgeous? Sit.' : 'Back so soon, handsome? Sit.', '*smiles over her mug* Go on then, say it.'])
          : this._pick(['Back again? I\'m starting to think you like me.', '*raises an eyebrow* Yes?', 'Couldn\'t stay away, could you?', 'Still here, still thirsty. What is it, love?']);
      }
      return this._pick([
        female ? '*hic* Well aren\'t YOU a sight. Buy a girl a drink, gorgeous?' : '*hic* Well hello, hero. Come to keep a lonely girl company?',
        'You\'ve got a look about you. Sit with me a while?',
      ]);
    };
    // LLM-FIRST (Obsidian 853: "stop hardcoding - use the AI"): the free keyless
    // LLM generates BOTH her opener and your reply options from the running
    // conversation; the canned banks above are only the offline fallback. The
    // thinking pill covers the round-trip; she still SPEAKS first and the
    // choices reveal only after her line (848/121).
    (async () => {
      this.ui.floaters?.showThinking(pm);
      const turn = await this._flirtLLMTurn(pm, null);
      if (this._flirtActive !== pm) return; // player walked off while she "thought"
      let opener;
      if (turn) { opener = turn.line; pm._llmOptions = turn.options; }
      else { pm._llmOptions = null; opener = cannedOpener(); }
      this._openFlirtAfterSpeaking(pm, opener, female);
    })();
  }

  // The player's current reply options: LLM-generated when available (853),
  // otherwise the canned contextual bank; the scripted buy-a-drink beat is
  // appended as an extra action either way (once, until she's had her drink).
  _currentChoices(pm, female) {
    const adult = this.settings.adult18;
    let list;
    if (pm._llmOptions && pm._llmOptions.length) {
      const tierOf = (w) => (w <= -1 ? 0 : w === 0 ? 1 : w === 1 ? 2 : 3);
      const earned = adult && (pm.affinity || 0) >= 5 && (pm._flirtEx || 0) >= 4;
      list = pm._llmOptions.map((o) => ({ tier: tierOf(o.warmth), label: o.label, upstairs: !!o.upstairs && earned }));
    } else {
      list = this._flirtChoices(pm, female).filter((c) => !c.buyDrink);
    }
    if ((pm.affinity || 0) >= 1 && !pm._hadDrink) list.push({ tier: 2, label: '🍺 Buy her a drink at the bar', buyDrink: true });
    // She asked your name? The first option ANSWERS it with the character's
    // actual creation name (885) - no more dodging into unrelated choices.
    if (!pm._knowsName && /your name|what.*call you|who are you|name, (love|hero|stranger)/i.test(pm._lastLine || '')) {
      list.unshift({ tier: 2, label: `I'm ${this.playerName()}.` });
    }
    return list;
  }

  // Speak a Rosalind line, then reveal the reply choices only once she's DONE
  // saying it (image 121: they used to pop up while she was mid-sentence). The
  // reveal timer runs from the moment her bubble actually appears (onShown) for
  // most of the caption window, so you read/hear the line first.
  _openFlirtAfterSpeaking(pm, line, female) {
    const DUR = 4800;
    clearTimeout(this._flirtOpenTimer);
    const reveal = () => {
      clearTimeout(this._flirtOpenTimer);
      this._flirtOpenTimer = setTimeout(() => {
        if (this._flirtActive === pm && this.ui._flirtPm !== null) {
          this.ui.openFlirtDialog(pm, line, this._currentChoices(pm, female));
        }
      }, Math.max(1400, DUR - 1200));
    };
    this.ui._flirtPm = pm; // claim the conversation so a stray close doesn't race
    pm._lastLine = line; // so the next option set can answer her question (885)
    roaster.sayGated(this, pm.name || 'Rosalind', line, this._flirtVoice(), pm, { durationMs: DUR, onShown: reveal, priority: true });
    // Safety net: if onShown never fires (no speech path at all), still reveal.
    this._flirtOpenTimer = setTimeout(reveal, 4500);
  }

  // Reply options, CONTEXTUAL to how well she knows you (Obsidian 853): you don't
  // proposition someone you just met, so the boldest move escalates with affinity
  // - light banter early, a drink offer once warming, and the overt "somewhere
  // quieter" only once she's smitten. (A fully LLM-generated option set is the
  // larger 853 rework.)
  // Canned option banks now PROGRESS with the conversation (870): the cold
  // "leave me be" brush-offs only make sense on the FIRST exchange - once
  // you've toasted and bought her a drink, showing them again reads absurd.
  // Stage = how far in you are: opening -> warming -> after the drink.
  _flirtChoices(pm, female) {
    const adult = this.settings.adult18;
    const a = pm.affinity || 0, ex = pm._flirtEx || 0;
    const choices = [];
    if (ex === 0) {
      // first words ever this conversation: full range incl. the brush-off
      choices.push({ tier: 0, label: 'Not interested. Leave me be.' });
      choices.push({ tier: 1, label: 'Just here for a quiet drink, thanks.' });
      choices.push({ tier: 2, label: female ? 'You\'re trouble, aren\'t you? *smile*' : 'You\'re bold. I like that.' });
      choices.push({ tier: 3, label: female ? 'You\'ve certainly got my attention.' : 'I could get used to your company.' });
    } else if (!pm._hadDrink) {
      // warming up, pre-drink: banter, curiosity, a polite out - no brush-off
      choices.push({ tier: 1, label: 'Careful, I might start enjoying this. *grins*' });
      choices.push({ tier: 2, label: 'So what\'s your story, Rosalind?' });
      choices.push({ tier: 2, label: female ? 'You\'ve got a wicked smile, you know that?' : 'That smile of yours is dangerous.' });
      choices.push({ tier: 0, label: 'I should get going. Another time.' });
    } else {
      // drinks in hand: companionable + flirtier, the toast beat first
      if (!pm._toasted) choices.push({ tier: 2, label: 'To us, then. *raises mug*', toast: true });
      else choices.push({ tier: 2, label: 'Tell me something no one here knows about you.' });
      choices.push({ tier: 2, label: 'Good ale, better company. *drinks*' });
      choices.push({ tier: 3, label: female ? 'I could sit here with you all night, gorgeous.' : 'I could sit here with you all night.' });
      choices.push({ tier: 0, label: 'It\'s getting late for me. *stands*' });
    }
    // the earned forward move replaces the boldest line once she's smitten
    if (adult && a >= 5 && ex >= 4) {
      const i = choices.findIndex((c) => c.tier === 3);
      const quiet = { tier: 3, label: 'Maybe we take this somewhere quieter…' };
      if (i >= 0) choices[i] = quiet; else choices.push(quiet);
    }
    // The walk-to-bar beat is offered ONCE - after she's had her drink the
    // choices move on instead of nagging "buy her a drink" forever (847).
    if (a >= 1 && !pm._hadDrink) choices.push({ tier: 2, label: '🍺 Buy her a drink at the bar', buyDrink: true });
    return choices;
  }

  // Apply a chosen reply; returns her reaction + the next choices (or ends).
  async flirtSelect(pm, tier, playerLabel = null) {
    const adult = this.settings.adult18;
    const female = this.player.gender === 'female';
    // She's MORE into you than you are into her (Obsidian 807): even a lukewarm
    // reply nudges her up, and warm/forward ones swing hard - so her attraction
    // outpaces your investment. Only an outright cold shoulder cools her.
    // She should NOT get smitten in two clicks (feedback: "takes time, not so
    // easy"). Forward replies nudge her only +1, a lukewarm one holds steady, and
    // a cold shoulder still cools her; combined with the raised smitten threshold
    // (aff>=6) below it now takes ~6 warm exchanges to win her over.
    pm.affinity = Math.max(-4, Math.min(8, (pm.affinity || 0) + [-2, 0, 1, 1][tier]));
    pm._flirtEx = (pm._flirtEx || 0) + 1; // exchanges so far - gates the payoff
    // LLM-FIRST (853): the free LLM writes her reaction AND your next options
    // from the running conversation (the player's actual chosen line goes into
    // the history). The thinking pill covers the round-trip; the canned banks
    // are only the offline fallback. One line, spoken once (801).
    this.ui.floaters?.showThinking(pm);
    // A toast is a scripted BEAT, not a generic tier-3 line (867): "To us,
    // *raises mug*" used to fall through to the canned tier-3 bank and she'd
    // answer with the upstairs tease ("the room upstairs isn't ready") - a
    // total non-sequitur. Detect it, clink, and give it its own replies.
    const toast = /raises mug|to us|cheers|\bclink/i.test(playerLabel || '');
    // Player introduced themselves (885): she knows the name from here on -
    // the LLM prompt gets it and the room's memory records it.
    if (!pm._knowsName && /^I'?m /.test(playerLabel || '')) {
      pm._knowsName = true;
      const mem = this._npcMemory();
      mem.rosalind = [...(mem.rosalind || []), `the adventurer is called ${this.playerName()}`].slice(-8);
      this.requestSave();
    }
    if (toast && !pm._toasted) {
      pm._toasted = true;
      this._npcWitness('raised a toast with Rosalind');
      audio.play('ui_click', { volume: 0.7 });
      this.ui.floaters?.spawn(this.player.pos, '🍺 Clink!', 'crit');
    }
    let line;
    const turn = await this._flirtLLMTurn(pm, playerLabel);
    if (turn) { line = turn.line; pm._llmOptions = turn.options; }
    else {
      pm._llmOptions = null;
      if (toast) {
        line = this._pick([
          '*clinks mugs* To us, love. May the ale stay cold and the night stay young.',
          'To us! *drinks deep* Mmm — you\'re better company than half this room put together.',
          '*taps her mug to yours* To handsome strangers and honeyed ale.',
        ]);
      } else {
        // Don't route a non-forward line into the tier-3 upstairs-tease bank:
        // only lines that actually SAY "somewhere quieter" earn that reply.
        const forwardish = /quieter|upstairs|room|somewhere|all night|take me|your place/i.test(playerLabel || '');
        const replyTier = tier === 3 && !forwardish ? 2 : tier;
        line = (await this._flirtLLMLine(pm, replyTier, adult, female)) || this._flirtReply(pm, replyTier, adult, female);
      }
    }
    pm.talkUntil = performance.now() + 12000;
    const end = pm.affinity <= -3; // she's had enough of a cold shoulder
    // The EARNED payoff (Obsidian 829): once she's genuinely into you (smitten,
    // built up over several exchanges) in 18+ mode and you make the forward move,
    // she invites you to her room upstairs.
    // The invite requires the player's line to actually BE the forward move
    // (872): an LLM-generated warm option ("My name's...") maps to tier 3 too,
    // and used to trigger "Follow her upstairs" out of nowhere mid-question.
    const madeForwardMove = /quieter|upstairs|room|somewhere|all night|take me|your place|kiss/i.test(playerLabel || '');
    const invitedUpstairs = adult && tier === 3 && madeForwardMove && pm.affinity >= 5 && (pm._flirtEx || 0) >= 4;
    if (invitedUpstairs) pm._invitedUpstairs = true;
    // Speak the reply, then reveal the next step ONLY after her bubble shows
    // (Obsidian 848) - end / follow-upstairs / the next choices.
    this.ui._flirtPm = pm;
    clearTimeout(this._flirtOpenTimer);
    const reveal = () => {
      clearTimeout(this._flirtOpenTimer);
      this._flirtOpenTimer = setTimeout(() => {
        if (this._flirtActive !== pm || this.ui._flirtPm !== pm) return;
        if (end) { this.ui.closeFlirt(); return; }
        const choices = invitedUpstairs
          ? [{ tier: 3, label: '💋 Follow her upstairs', followUp: true }]
          : this._currentChoices(pm, female);
        this.ui.openFlirtDialog(pm, line, choices);
      }, 4000); // she finishes her reply before your next options show (121)
    };
    pm._lastLine = line; // so the next option set can answer her question (885)
    roaster.sayGated(this, pm.name || 'Rosalind', line, this._flirtVoice(), pm, { durationMs: 5200, onShown: reveal, priority: true });
    this._flirtOpenTimer = setTimeout(reveal, 5200); // safety net if onShown never fires
    return { line, affinity: pm.affinity, disliked: end, invitedUpstairs };
  }

  // "Buy her a drink" (Obsidian 822): close the flirt and kick off the walk-to-
  // bar beat; updatePlaying walks you both over, buys the drink and resumes.
  buyRosalindDrink(pm) {
    this.ui.closeFlirt?.();
    this._buyScene = { pm, done: false };
  }

  // The "follow her upstairs" payoff (Obsidian 829): close the flirt, go up to
  // the guest floor and drop the hero in Rosalind's room (SE). Only reachable
  // once she's invited you (18+, earned) - the UI gates the button on that.
  followRosalindUpstairs() {
    this.ui.closeFlirt?.();
    this._npcWitness('went upstairs with Rosalind'); // the whole room saw it (884)
    this._sceneLock = true; // suppress the stuck-failsafe for the WHOLE scripted scene (874)
    audio.play('door_open');
    this.loadTavernUpstairs();
    const bp = this.dungeonMeshes.rosalindBedPos || { x: 21.4, z: 20.5 };
    // Build Rosalind and drop her NEXT TO the player at the top of the stairs
    // (the hall spawn) - then she LEADS you down the hall to her room on foot
    // (873: it used to teleport you straight to the bed with her missing). The
    // _followScene tick walks you both there with footsteps + walk animation.
    const npc = buildNpcModel('mage', 'Rosalind', {
      gender: 'female', skinTone: 'light', hairColor: 'auburn', hairStyle: 'long', faceShape: 'narrow', eyeColor: 'violet',
    });
    const p = this.player;
    if (npc) {
      npc.mesh.position.set(p.pos.x + 0.9, 0, p.pos.z);
      npc.mesh.rotation.y = 0;
      npc.mesh.traverse((o) => {
        if (!o.isMesh || !o.material || !o.name) return;
        if (/_Body$/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(0x8a1f3a); }
        else if (/_Leg/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(0xf3c9a6); }
      });
      this.dungeonMeshes.group.add(npc.mesh);
    }
    roaster.sayGated(this, 'Rosalind', 'This way, hero — my room\'s just down the hall. *takes your hand*', this._flirtVoice(), { x: p.pos.x, z: p.pos.z }, { durationMs: 3600, priority: true });
    const bedC = (this.dungeonMeshes.bedPositions || []).find((bb) => bb.fancy) || { x: bp.x, z: bp.z, headAngle: 0, standZ: bp.z };
    // walk targets: she leads to the far side of the bed, you stop on the near side
    this._followScene = {
      npc, bedC,
      herTarget: { x: bp.x - 0.7, z: bp.z },
      myTarget: { x: bp.x + 1.2, z: bp.z },
      pStep: 0, hStep: 0, arrived: false,
    };
  }

  // The implied 18+ payoff once you've WALKED into her room (873): a couple of
  // flirty/giggly beats, then you both lie in the bed together, she kisses you,
  // and the lantern goes out (fade-to-black). No on-screen explicit content.
  _upstairsBeats(npc, bedC) {
    const adult = this.settings.adult18;
    const anchor = { x: bedC.x, z: bedC.z };
    roaster.sayGated(this, 'Rosalind', adult ? 'Mmm, finally alone. Door\'s locked, hero.' : 'Finally, a little privacy.', this._flirtVoice(), anchor, { durationMs: 3600, priority: true });
    clearTimeout(this._roomFadeTimer);
    const T = (ms, fn) => { const id = setTimeout(() => { if (this.inUpstairs) fn(); }, ms); return id; };
    if (!adult || !npc) return;
    // 1) a giggle/flirt beat before anything happens (foreplay, tasteful)
    T(3200, () => {
      roaster.sayGated(this, 'Rosalind', '*laughs softly* Come here, then. Don\'t be shy.', this._flirtVoice(), anchor, { durationMs: 3000, priority: true });
      this.ui.floaters?.spawn({ x: bedC.x, y: 1.2, z: bedC.z }, '💕', 'crit');
    });
    // 2) both lie down together (same YXZ lie the player uses; her south bed -> yaw PI)
    T(6000, () => {
      npc.mesh.rotation.order = 'YXZ';
      npc.mesh.rotation.set(-Math.PI / 2, Math.PI, 0);
      npc.mesh.position.set(bedC.x - 0.34, 0.58, bedC.z - 0.85);
      npc.mesh.traverse((o) => { if (o.name === 'BlobShadow') o.visible = false; });
      this._lyingBed = { x: bedC.x + 0.34, z: bedC.z, headAngle: bedC.headAngle, standZ: bedC.standZ, _scene: true };
    });
    // 3) the kiss
    T(8000, () => {
      roaster.sayGated(this, 'Rosalind', '*kisses you* C\'mere, you…', this._flirtVoice(), anchor, { durationMs: 2400, priority: true });
      this.ui.floaters?.spawn({ x: bedC.x, y: 1.2, z: bedC.z }, '💋', 'crit');
    });
    // 4) lights out (fade to black, implied)
    this._roomFadeTimer = T(10400, () => this._fadeScene());
  }

  // A tasteful fade-to-black for the implied 18+ upstairs encounter (851): the
  // screen fades out, holds on a discreet caption, and fades back to a morning-
  // after beat. Deliberately NO on-screen sexual content.
  _fadeScene() {
    if (!this._flirtActive && !this.inUpstairs) return;
    let ov = document.getElementById('scene-fade');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'scene-fade';
      ov.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;z-index:9999;transition:opacity 1.2s ease;pointer-events:none;display:flex;align-items:center;justify-content:center;color:#e8c8d2;font:italic 22px Georgia,serif;text-align:center;';
      document.body.appendChild(ov);
    }
    ov.textContent = 'The lantern winks out…';
    ov.style.pointerEvents = 'auto';
    requestAnimationFrame(() => { ov.style.opacity = '1'; });
    setTimeout(() => { ov.textContent = '— some time later —'; }, 2200);
    setTimeout(() => {
      ov.style.opacity = '0';
      const bp = this.dungeonMeshes?.rosalindBedPos;
      if (bp) roaster.sayGated(this, 'Rosalind', this.settings.adult18 ? 'Mmm… you\'re trouble, you know that? Stay a while.' : 'That was nice. Stay a while?', this._flirtVoice(), { x: bp.x - 0.7, z: bp.z }, { durationMs: 4000, priority: true });
    }, 4200);
    setTimeout(() => { if (ov) ov.style.pointerEvents = 'none'; }, 5600);
  }

  // Ask the keyless LLM (Pollinations) for Rosalind's next line, in character
  // and gated to the current 18+ mode. Short timeout; returns null on any
  // slowness/failure so flirtSelect falls back to the canned bank (801).
  // FRESH ambient banter from the free LLM (Obsidian 781-stretch): once the
  // prewarmed canned exchanges have each played, ask for a new 3-turn exchange
  // between the regulars - fire-and-forget, lands in the plan pool for the next
  // cycle. Used opening lines are remembered (and persisted in the save) so the
  // room never repeats itself across visits; the canned trees remain the
  // offline fallback.
  // The LLM is usable for free-text conversation right now (868): reachable
  // (not muted by the circuit breaker). Deliberately NOT gated on the AI/
  // battery toggles - those only govern voice (884a).
  llmAvailable() { return llm.ready; }

  // Per-NPC persistent memory (884d): tiny fact files the regulars accumulate -
  // what they've learned about EACH OTHER through their own conversations, and
  // what they've seen the PLAYER do. Persisted in the save, fed back into every
  // prompt so the room's stories build on themselves across visits.
  _npcMemory() {
    if (!this._npcMem) this._npcMem = { magda: [], drunk: [], patron: [], rosalind: [], player: [] };
    if (!Array.isArray(this._npcMem.player)) this._npcMem.player = [];
    return this._npcMem;
  }

  // Stamp something the regulars just watched the adventurer do ("bought
  // Rosalind a drink", "went upstairs with Rosalind"). Future banter and flirt
  // prompts see it, so the room remembers - and gossips about - you.
  _npcWitness(text) {
    const mem = this._npcMemory();
    mem.player = [...mem.player, text].slice(-5);
    this.requestSave();
  }

  async _fetchFreshConvo() {
    // Up to 2 fetches in flight (884: entering the tavern warms a small pool so
    // the first audible exchange is already LLM-written, not canned). The LLM
    // is used regardless of the AI/voice/battery toggles - those gate TTS only.
    if ((this._freshConvoBusy || 0) >= 2 || !llm.ready) return;
    this._freshConvoBusy = (this._freshConvoBusy || 0) + 1;
    try {
      const used = (this._usedBanter || []).slice(-12).join(' | ');
      const mem = this._npcMemory();
      const memLine = ['magda', 'drunk', 'patron', 'rosalind']
        .filter((k) => mem[k]?.length)
        .map((k) => `${k} is known for: ${mem[k].slice(-4).join('; ')}`).join('. ');
      const playerLine = mem.player.length ? ` They last saw the adventurer: ${mem.player.slice(-2).join('; ')}.` : '';
      const tone = this.settings.adult18
        ? 'Tone: 18+ - the banter may be DARK, crazy or bawdy (grim war stories, black humor, filthy jokes, profanity fine) but above all genuinely FUNNY.'
        : 'Tone: clean but genuinely FUNNY - dry wit, absurd gripes, running jokes.';
      const sys = `Write ambient background banter for a fantasy tavern. Speakers: "magda" (no-nonsense barkeep), "drunk" (Bram, tipsy regular), "patron" (dry-witted regular), "rosalind" (playful flirt). ${tone}${memLine ? ` Shared memory to build on (weave a callback in when it fits): ${memLine}.` : ''}${playerLine} Reply ONLY JSON: {"turns":[{"who":"<magda|drunk|patron|rosalind>","text":"<one short spoken line, max 16 words, natural pronounceable words only - no Hmm/Mmm/Hmph/Pfft murmur sounds>"}],"learned":[{"who":"<speaker>","fact":"<optional: one SHORT new thing this exchange revealed about them>"}]} with EXACTLY 3 turns by different speakers. Do NOT reuse these earlier openers: ${used || '(none)'}`;
      const out = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: 'Next exchange. Remember: top-level JSON key MUST be "turns".' }], { timeout: 8000, temperature: 1.1, maxTokens: 300 });
      if (!out) return;
      const obj = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out.match(/\[[\s\S]*\]/)[0]);
      let rawTurns = Array.isArray(obj) ? obj : obj.turns;
      let rawLearned = Array.isArray(obj) ? null : obj.learned;
      // codestral schema drift, worst case observed live: a SPEAKER-KEYED object
      // {"magda":{"line":"...","reveal":"..."},"bram":{...}} - unfold it.
      if (!Array.isArray(rawTurns) && obj && typeof obj === 'object') {
        rawTurns = Object.entries(obj).map(([who, v]) => (v && typeof v === 'object')
          ? { who, text: v.line || v.text, _fact: v.reveal || v.fact || v.learned }
          : { who, text: v });
        rawLearned = rawTurns.filter((t) => t._fact).map((t) => ({ who: t.who, fact: t._fact }));
      }
      // milder drifts ("speaker"/"bram"/"line") - normalize
      const WHO = { magda: 'magda', barkeep: 'magda', drunk: 'drunk', bram: 'drunk', patron: 'patron', regular: 'patron', rosalind: 'rosalind', ros: 'rosalind', flirt: 'rosalind' };
      const turns = (Array.isArray(rawTurns) ? rawTurns : []).map((t) => {
        if (!t) return null;
        const who = WHO[String(t.who || t.speaker || t.name || '').toLowerCase().trim()];
        const text = typeof t.text === 'string' ? t.text : (typeof t.line === 'string' ? t.line : null);
        return who && text ? { who, text: String(text).slice(0, 140) } : null;
      }).filter(Boolean).slice(0, 3);
      if (turns.length >= 2) {
        (this._llmConvoPool = this._llmConvoPool || []).push(turns);
        this._usedBanter = [...(this._usedBanter || []), turns[0].text].slice(-30);
        // bank what the room just learned about its own people (cap 8 facts each)
        if (Array.isArray(rawLearned)) {
          for (const l of rawLearned.slice(0, 3)) {
            const who = WHO[String(l?.who || '').toLowerCase().trim()];
            const fact = typeof l?.fact === 'string' ? l.fact.slice(0, 90) : null;
            if (who && fact && who !== 'player') mem[who] = [...(mem[who] || []), fact].slice(-8);
          }
        }
        this.requestSave();
      }
    } catch { /* canned trees remain the fallback */ }
    finally { this._freshConvoBusy = (this._freshConvoBusy || 1) - 1; }
  }

  // LLM-DRIVEN flirt turn (Obsidian 853): the free keyless LLM generates BOTH
  // Rosalind's spoken line AND the player's next reply options as JSON, from the
  // running conversation + her mood - so the dialogue and its branches are
  // dynamic/emergent instead of hardcoded. Returns { line, options:[{label,
  // warmth,upstairs}] } or null (caller falls back to the canned bank).
  async _flirtLLMTurn(pm, playerLine) {
    if (!llm.ready) return null;
    const adult = this.settings.adult18;
    const female = this.player.gender === 'female';
    const a = pm.affinity || 0;
    const mood = a <= -3 ? 'fed up and dismissive' : a >= 6 ? 'smitten' : a >= 3 ? 'warming up' : a >= 1 ? 'curious' : 'cool but intrigued';
    pm._flirtHistory = pm._flirtHistory || [];
    if (playerLine) pm._flirtHistory.push({ role: 'user', content: `Adventurer: ${playerLine}` });
    const mem = this._npcMemory();
    const remembers = [...(mem.rosalind || []).slice(-3), ...(mem.player.length ? [`you saw the adventurer ${mem.player.slice(-2).join(' and ')}`] : [])].join('; ');
    const sys = `You are Rosalind, a tipsy, flirtatious regular at a fantasy tavern, talking with an adventurer${female ? ' (a woman - you are into women)' : ''}. Your mood right now: ${mood} (affinity ${a} on a -4..8 scale).${pm._knowsName ? ` The adventurer told you their name: ${this.playerName()} - greet and use it naturally.` : ' You do NOT know their name yet.'}${remembers ? ` You remember: ${remembers}.` : ''} ${adult ? '18+ MODE IS ON: be crude, vulgar and explicitly sexual with profanity when your mood is warm.' : 'Keep it suggestive and playful but CLEAN - no profanity or explicit content.'} You do NOT jump to bed with someone you just met - escalate naturally over the conversation. Write ONLY natural pronounceable words (text-to-speech reads your line aloud): NO murmur/interjection sounds at all - no "Hmm", "Mmm", "Hmph", "Pfft", "Tsk", "Ugh" - use real words only. Reply with ONLY a JSON object, no prose:\n{"line":"<your ONE short spoken line, max 22 words, in character>","options":[<EXACTLY 4 objects>{"text":"<a short line the ADVENTURER could say back, max 11 words>","warmth":<integer -2..2, how forward/warm it is>${adult ? ',"upstairs":<true ONLY if this option is you being invited to her room and she is smitten>' : ''}}]}\nThe 4 options MUST be varied and fit THIS moment: one cold/dismissive (warmth -2 or -1), one neutral (0), one warm (1), one bold (2).`;
    const msgs = [{ role: 'system', content: sys }, ...pm._flirtHistory.slice(-8)];
    const out = await llm.chat(msgs, { timeout: 6000, temperature: 1.05, maxTokens: 240 });
    if (!out) return null;
    let obj;
    try { obj = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { return null; }
    if (!obj || typeof obj.line !== 'string' || !Array.isArray(obj.options) || !obj.options.length) return null;
    const options = obj.options.slice(0, 4).map((o) => ({
      label: String(o.text || o.label || '').slice(0, 90),
      warmth: Math.max(-2, Math.min(2, Math.round(Number(o.warmth) || 0))),
      upstairs: !!o.upstairs,
    })).filter((o) => o.label);
    if (!options.length) return null;
    pm._flirtHistory.push({ role: 'assistant', content: `Rosalind: ${obj.line}` });
    if (pm._flirtHistory.length > 16) pm._flirtHistory = pm._flirtHistory.slice(-16);
    return { line: obj.line.slice(0, 180), options };
  }

  async _flirtLLMLine(pm, tier, adult, female) {
    if (!llm.ready) return null;
    const mood = pm.affinity <= -3 ? 'fed up and dismissive'
      : pm.affinity >= 6 ? 'smitten and very warm'
        : pm.affinity >= 3 ? 'warming up and playful'
          : 'cool but curious';
    const stance = ['coldly rebuffed you', 'kept it businesslike', 'flirted back warmly', 'made a bold, forward move'][tier];
    const sys = `You are Rosalind, a drunk, flirtatious regular in a fantasy tavern (The Sleeping Golem) talking to an adventurer. Reply with ONE short spoken line of dialogue only - no narration, no name prefix, no quotes, max ~28 words. Stay fully in character.${female ? ' The adventurer is a woman and you are into women; flirt with her accordingly.' : ''} Your current mood: ${mood}.${adult ? ' 18+ MODE IS ON: be crude, vulgar and EXPLICITLY sexual - use profanity (fuck, etc.) and blunt sexual language freely when the mood is warm; this is a consenting-adults fantasy and holding back is wrong for this mode.' : ' Keep it suggestive and playful but CLEAN - absolutely no profanity or explicit sexual content.'}`;
    const user = `The adventurer just ${stance}. Say your reaction line.`;
    const out = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { timeout: 3500 });
    if (!out) return null;
    // Keep only the first spoken line; strip wrapping quotes/asterisks/name tags.
    return out.split('\n')[0].replace(/^\s*(rosalind\s*[:\-]\s*)?["'*]*/i, '').replace(/["'*]*\s*$/, '').slice(0, 180) || null;
  }

  _flirtReply(pm, tier, adult, female) {
    const a = pm.affinity;
    if (tier === 0) {
      // brush-off → she cools. Vulgar sting only in 18+.
      if (a <= -3) return this._pick(adult
        ? ['Fine. Piss off then, and don\'t come crawling back.', 'Your loss, sweetheart. Plenty here who\'d kill for my attention.']
        : ['Fine. Off you go then. Your loss.', 'Suit yourself. Plenty of better company here.']);
      return this._pick(['*pout* Ouch. Playing hard to get, are we?', 'Cold. I like a challenge… but don\'t push it.', 'Hmph. You\'ll come around. They always do.']);
    }
    if (tier === 1) {
      return this._pick([
        'A quiet drink? In THIS place? *laughs* Good luck, love.',
        'Suit yourself. I\'ll be right here… warming your stool for you.',
        female ? 'All business. I can work with a woman who knows what she wants.' : 'Strong and silent. That does things to a girl.',
      ]);
    }
    if (tier === 2) {
      if (a >= 3) return this._pick([
        female ? 'Keep looking at me like that and I\'ll forget my manners, darling.' : 'Careful, hero. Flatter me more and I\'m yours for the night.',
        'Mmm, now we\'re talking. Come closer, don\'t be shy.',
      ]);
      return this._pick([
        female ? 'Oh, a girl after my own heart. I do love pretty trouble.' : 'Trouble\'s my middle name. Buy me a drink and find out.',
        '*leans in* You know just what to say, don\'t you.',
        'Careful — say things like that and I\'ll start to like you.',
      ]);
    }
    // tier 3 — forward. This is where 18+ unlocks the explicit heat: she gets
    // crude and openly sexual (password-gated adult mode - Obsidian 793). But
    // she's NOT easy (807): the outright "come upstairs" payoff is EARNED - it
    // only lands once she's smitten (a>=5) AND you've built up (>=4 exchanges);
    // before that she's hungry but deflects and makes you work for it. (The
    // upstairs room itself is 800.)
    if (adult) {
      const earned = a >= 5 && (pm._flirtEx || 0) >= 4;
      if (earned) return this._pick([
        female ? 'Fuck it — my room\'s upstairs, my bed\'s cold, and I want your mouth on me. Get up there, gorgeous.' : 'My room\'s upstairs. Get up there, get that armor off, and I\'ll ride you till you forget your own damn name.',
        'Mmm, finally. Hands on my hips, mouth on my neck, and don\'t you dare be gentle. Follow me up.',
        female ? 'I\'ve been picturing you naked and under me all night. Come upstairs and let me have you.' : 'I\'m soaked just looking at you, hero. Take me upstairs and fuck me properly.',
      ]);
      if (a >= 3) return this._pick([
        female ? 'Mmm, patience, gorgeous — you\'ve got me aching, but I don\'t come THAT easy. Keep at it.' : 'Careful, hero — you\'ve got me wet already, but I don\'t just spread for anyone. Work for it.',
        'Not yet, love. The room upstairs isn\'t ready and I\'m not done teasing you. Buy me another.',
        female ? 'Slow down, darling — I\'ll be yours before long, but make me want it first.' : 'Easy, tiger. I\'ll take you apart soon enough. Earn it a little more.',
      ]);
      return this._pick([
        'Bold little thing, aren\'t you. Keep buying and we\'ll see how far this goes.',
        '*bites lip* You\'re getting to me — but I don\'t give it up on the first round.',
      ]);
    }
    // clean suggestive (no 18+)
    if (a >= 3) return this._pick([
      female ? 'A drink and your company? Best offer I\'ve had all night, gorgeous.' : 'Now you\'re spoiling me. Stay close and keep them coming.',
      'Mmm. I could get used to you.',
    ]);
    return this._pick([
      'A drink? Now you\'re speaking my language. *winks*',
      'Smooth. Keep that up and you\'ll turn my head.',
    ]);
  }

  openNotices() {
    this.state = 'notices';
    this.ui.openNotices(this.buildNotices());
  }

  // Builds exactly three notices for the board, in priority order: real-world
  // holiday notices first, then a gameplay event derived from actual save
  // progress ({playerName} defeated the latest act lord the character has
  // actually cleared), then the evergreen static notices as filler so the
  // board always shows three even on a brand-new character with no events.
  buildNotices() {
    const act = Math.min(5, this.actsCleared + 1);
    const boss = ACT_BOSSES[act].name;
    const romanAct = ['', 'I', 'II', 'III', 'IV', 'V'];
    const flavor = [
      'LOST: one cat, answers to "Whiskers". Last seen entering the dungeon. Do NOT bring back whatever answers to Whiskers now.',
      'Zoltan\'s Mystery Relics: all sales final. Fate offers no refunds. — Z.',
      'RUMOR: travelers\' satchels seen on the strongest fiends below. Cut them open, carry more home.',
      'The well is NOT a portal. Stop jumping in. — the Town',
    ];

    const dynamic = [];

    // Real calendar holidays (month/day windows, wraps year boundary for NYE).
    const now = new Date();
    const md = (now.getMonth() + 1) * 100 + now.getDate(); // MMDD, e.g. 1231, 101
    if (md >= 1231 || md <= 102) {
      dynamic.push({ title: 'HAPPY NEW YEAR', icon: 'star', text: 'Embervale raises a cup to the turning year. Every tavern in town pours the first round free, hero — go collect it.' });
    } else if (md >= 1224 && md <= 1226) {
      dynamic.push({ title: 'MERRY CHRISTMAS', icon: 'star', text: 'Wreaths on the gate, holly on the notice board itself. Even the dungeon seems to echo a little quieter tonight.' });
    } else if (md >= 1025 && md <= 1101) {
      dynamic.push({ title: 'HALLOWS EVE', icon: 'spiral', text: 'The dead walk a little louder this week, and not just the ones downstairs. Mind the fog past the well after dark.' });
    }

    // Gameplay event: the character's own progress. Boss floors are 10/20/30/
    // 40/50 (act N clears on floor N*10); clearedFloors marks a full clear, so
    // the highest cleared boss floor is real, save-derived news, not flavor.
    const bossFloors = [10, 20, 30, 40, 50];
    let latestClearedAct = 0;
    for (const f of bossFloors) if (this.clearedFloors[f]) latestClearedAct = f / 10;
    if (latestClearedAct > 0) {
      const fallenName = ACT_BOSSES[latestClearedAct].name;
      dynamic.push({
        title: 'VICTORY', icon: 'swords',
        text: `${this.playerName()} has defeated ${fallenName}, lord of Act ${romanAct[latestClearedAct]}. The seal breaks a little further below.`,
      });
    }

    const staticNotices = [
      { title: `BOUNTY: ${boss}`, icon: 'swords', text: `By order of Embervale: the lord of Act ${romanAct[act]} holds the deep seal. Slay it and the way below opens. Reward: the road onward, and whatever it drops.` },
      { title: 'DECREE OF THE STAIRS', icon: 'scroll', text: 'The stair-seals hold until seven of every ten fiends on a floor are cut down AND the crowned elite falls. Pits are exempt. Fall at your own peril.' },
      { title: 'NOTICE', icon: 'scroll', text: flavor[Math.floor(Math.random() * flavor.length)] },
    ];

    return [...dynamic, ...staticNotices].slice(0, 3);
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
    vendor._shopOpen = true; // keeper head-glance gate (740, read in meshbuilder)
    this.state = 'shop';
    // Camera stays put on shop open (Obsidian 765): the old vendor-facing
    // yaw ease swung the whole background to frame the keeper, which the
    // player found jarring - the keeper still turns to face you (740), that's
    // enough. No _yawEase, so nothing to restore on close either.
    this.touch.setVisible(false); // touch buttons aren't needed at a counter
    this.ui.openShop(vendor);
    this.greetFromVendor(vendor);
  }

  // Vendors greet you by name, each in their own voice — and they READ you:
  // health, potions, gold, gear. No "you look wounded" at full health.
  // The greeting itself always leads with an opener, the player's name is
  // woven in only sometimes (roaster.composeVendorLine), and returning
  // customers who bought something before sometimes get asked about it.
  greetFromVendor(vendor) {
    const n = this.playerName();
    const p = this.player;
    const hurt = p.hp < p.maxHp * 0.6;
    const rich = p.gold > 300;
    const bodies = { potions: [], gear: [], mystery: [] };

    // Maribel — health/potion aware
    if (hurt) bodies.potions.push('You\'re hurt. Sit, drink, live.');
    else if (p.potions === 0) bodies.potions.push('An empty satchel? Never descend without a red bottle.');
    else bodies.potions.push('Potions, fresh from the still.', 'Drink responsibly, dear.', 'You look well! Let’s keep it that way.');

    // Torvald — gear aware
    const weapon = p.equipped.weapon;
    if (!weapon) bodies.gear.push('Bare-handed?! By the forge, take a blade before the deep takes you.');
    else if (weapon.rarity === 'common') bodies.gear.push('That old iron of yours has seen better days. Browse a while.');
    else bodies.gear.push('Steel for the worthy. Pick a blade.', 'The forge burned all night for this.');

    // Zoltan — gold aware
    if (rich) bodies.mystery.push(`That's ${p.gold} gold — fate can hear it jingling from here.`);
    else if (p.gold < 100) bodies.mystery.push('Light pockets today… fate does not work on credit, friend.');
    else bodies.mystery.push('Fate has been expecting you.', 'Care to tempt destiny?');
    // unique voices: no vendor shares a voice with any enemy or each other
    const casts = {
      potions: { female: true, vi: 2, pitch: 1.2, rate: 1.02, kokoro: 'af_bella', kSpeed: 1.0 },
      gear: { female: false, vi: 2, pitch: 0.6, rate: 0.95, kokoro: 'am_michael', kSpeed: 0.92 },
      mystery: { female: false, vi: 3, pitch: 0.85, rate: 0.88, kokoro: 'bm_george', kSpeed: 0.88 },
    };
    const bank = bodies[vendor.type] || bodies.gear;
    const body = bank[Math.floor(Math.random() * bank.length)];
    const memory = this.vendorMemory[vendor.name] || {};
    const line = roaster.composeVendorLine(vendor.type, { playerName: n, memory, body });
    if (!memory.met) { this.vendorMemory[vendor.name] = { ...memory, met: true }; this.requestSave(); }
    const anchor = vendor.wx !== undefined ? { x: vendor.wx, z: vendor.wz } : null;
    roaster.sayGated(this, vendor.name, line, casts[vendor.type] || casts.gear, anchor);
  }

  closeShop() {
    if (this.activeVendor) this.activeVendor._shopOpen = false; // release the glance gate (740)
    this.activeVendor = null;
    // (no camera restore needed - the shop no longer swings the camera, 765)
    this.state = 'playing';
    this.ui.hideAll();
    this.touch.setVisible(true);
    this.shopCooldown = 1.5;
    audio.play('ui_close');
  }

  // Town is an open evening square: brighter, bluer, softer fog than the dungeon.
  setTownAtmosphere(on) {
    if (on && this.inTavern) {
      // Warm, lamplit tavern: amber ambient so the wood and back-bar glow, and
      // a soft hearth-coloured glow that follows the player through the room.
      this.scene.background = new THREE.Color(0x1a1109);
      this.scene.fog = new THREE.Fog(0x1a1109, 22, 46);
      this.ambient.color.setHex(0xffb066);
      this.ambient.intensity = 0.82;
      this.playerLight.color.setHex(0xffcf9a);
      this.playerLight.intensity = 16;
      this.playerLight.distance = 11;
    } else if (on) {
      this.scene.background = new THREE.Color(0x151d30);
      this.scene.fog = new THREE.Fog(0x151d30, 24, 52);
      this.ambient.color.setHex(0x9aa4c8);
      this.ambient.intensity = 0.85;
      // no "flashlight" under the open sky — just a faint presence
      this.playerLight.color.setHex(0xffd8a0);
      this.playerLight.intensity = 5;
      this.playerLight.distance = 6;
    } else {
      this.scene.background = new THREE.Color(0x08060c);
      this.scene.fog = new THREE.Fog(0x08060c, 18, 42);
      this.ambient.color.setHex(0x8a7a9a);
      this.ambient.intensity = 0.55;
      // underground the hero carries the light
      this.playerLight.color.setHex(0xffd8a0);
      this.playerLight.intensity = 40;
      this.playerLight.distance = 14;
    }
  }

  // Real-time day/night cycle, TOWN ONLY (the dungeon has its own torch
  // lighting and the tavern its own hearth mood, so both are skipped). Advances
  // a continuous clock and lerps sun/ambient colour+intensity, sky background +
  // fog tint, and turns the town lamp/window glows (dungeonMeshes.townGlows) +
  // the pooled lamp lights on at night, off/dim by day. Smoothly fades between
  // phases so dusk/dawn read as gradual transitions, not switches.
  updateDayNight(dt) {
    if (!this.inTown || this.inTavern || !this.dungeonMeshes) {
      if (this.sunLight.visible) this.sunLight.visible = false;
      return;
    }
    this.sunLight.visible = true;
    this.townClock += dt;
    const period = Game.DAY_NIGHT_PERIOD;
    // phase 0..1 over one full day+night. day = 0..0.5, night = 0.5..1.
    const phase = (this.townClock % period) / period;
    // `dayAmt` 1 at high noon, 0 at deep night, with smooth dusk/dawn ramps.
    // cosine over the phase gives a natural sunrise/sunset easing.
    const dayAmt = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2 + Math.PI);
    const nightAmt = 1 - dayAmt;
    const lerp = (a, b, t) => a + (b - a) * t;

    // --- sky background + fog tint: warm slate-blue day -> deep indigo night ---
    const dayBg = { r: 0x5a / 255, g: 0x74 / 255, b: 0x9c / 255 };
    const nightBg = { r: 0x0e / 255, g: 0x12 / 255, b: 0x24 / 255 };
    const bgR = lerp(nightBg.r, dayBg.r, dayAmt);
    const bgG = lerp(nightBg.g, dayBg.g, dayAmt);
    const bgB = lerp(nightBg.b, dayBg.b, dayAmt);
    this.scene.background.setRGB(bgR, bgG, bgB);
    if (this.scene.fog) {
      this.scene.fog.color.setRGB(bgR, bgG, bgB);
      this.scene.fog.near = lerp(20, 24, dayAmt);
      this.scene.fog.far = lerp(46, 58, dayAmt);
    }

    // --- sun (directional): bright warm white by day, near-off cool at night ---
    this.sunLight.color.setRGB(
      lerp(0.36, 1.0, dayAmt), lerp(0.42, 0.88, dayAmt), lerp(0.62, 0.70, dayAmt));
    this.sunLight.intensity = lerp(0.05, 1.35, dayAmt);

    // --- ambient/hemisphere fill: cool moonlight at night, soft daylight by day ---
    this.ambient.color.setRGB(
      lerp(0.30, 0.66, dayAmt), lerp(0.34, 0.70, dayAmt), lerp(0.52, 0.82, dayAmt));
    this.ambient.intensity = lerp(0.42, 0.9, dayAmt);

    // --- lamp/window glows: on at night, dim/off by day ---
    for (const g of this.dungeonMeshes.townGlows) {
      if (g.kind === 'basic') {
        // basic (unlit) material: scale its colour toward black by day
        g.mesh.material.color.copy(g.base).multiplyScalar(lerp(0.12, 1.0, nightAmt));
      } else if (g.kind === 'emissive') {
        g.mesh.material.emissiveIntensity = lerp(0.05, g.nightEmissive, nightAmt);
      } else if (g.kind === 'light') {
        g.light.intensity = lerp(0.0, g.nightIntensity, nightAmt);
      }
    }
    // pooled lamp-post lights (from setupTorchLights) fade with night too
    this._townLampNight = nightAmt;
  }

  // Yields to the browser so the loading-screen progress bar actually paints
  // between the heavy synchronous stages of loadFloor below.
  _yieldFrame() {
    return new Promise((res) => requestAnimationFrame(() => res()));
  }

  // A floor's layout must be identical every time this character walks it, so
  // a cleared floor revisits the exact halls it was cleared in. generateDungeon
  // rolls its layout with Math.random, so for the duration of the call it is
  // swapped for a deterministic LCG seeded from (save slot, floor). The
  // generator is fully synchronous, so nothing else can observe the seeded
  // Math.random; the native one is restored in finally.
  generateDungeonSeeded(floor) {
    const native = Math.random;
    // FNV-1a over the slot id, then the floor number mixed in
    let s = 2166136261 >>> 0;
    const key = String(this.slotId || 'ember');
    for (let i = 0; i < key.length; i++) s = Math.imul(s ^ key.charCodeAt(i), 16777619) >>> 0;
    s = Math.imul(s ^ floor, 16777619) >>> 0;
    Math.random = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    try {
      return generateDungeon(floor);
    } finally {
      Math.random = native;
    }
  }

  // Loads a dungeon floor, driving the loading screen from the REAL stages of
  // the work (generation -> mesh build -> entities -> lighting/reflection) so
  // the bar reflects genuine progress rather than a fake timer. Async only so
  // the bar can paint between stages; callers fire-and-forget it.
  async loadFloor(floor) {
    this._loading = true;
    this.ui.showLoading(0.04, 'Shaping the depths…');
    await this._yieldFrame();

    this.teardownFloor();
    this.inTown = false;
    this.inTavern = false;
    this.setTownAtmosphere(false);
    this._floorLoadedAt = performance.now(); // for anti-cheat clear-speed checks
    this.floor = floor;
    const theme = themeForFloor(floor);

    // stage 1: dungeon layout generation. (showLoading re-asserts the overlay's
    // visibility: a caller may run enterPlaying() -> ui.hideAll() synchronously
    // right after invoking this fire-and-forget load, which would otherwise hide
    // the loading screen we opened above.)
    this.dungeon = this.generateDungeonSeeded(floor);

    // Destructible walls: re-apply any holes THIS character already broke
    // open on THIS floor earlier in the same session. Deliberately done AFTER
    // the seeded generation above (never before) so the seeded room layout
    // stays revisit-stable; only these specific cells get patched back to
    // FLOOR on top of it. dungeon.preOpenedWalls is handed to
    // buildDungeonMeshes so it can drop a rubble pile back in each hole
    // (grid.js/meshbuilder.js are the only files touched here; the session
    // map itself lives on the Game instance and is never saved).
    const holes = this.destroyedWallsSession[floor];
    if (holes?.size && this.dungeon.grid) {
      for (const key of holes) {
        const [hx, hy] = key.split(',').map(Number);
        if (this.dungeon.grid[hy]?.[hx] === WALL) this.dungeon.grid[hy][hx] = FLOOR;
      }
      this.dungeon.preOpenedWalls = holes;
    }
    this.ui.showLoading(0.3, 'Carving halls…');
    await this._yieldFrame();

    // stage 2: build the floor meshes (walls/props/lighting geometry)
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme, floor);
    this.scene.add(this.dungeonMeshes.group);
    this.ui.showLoading(0.6, 'Raising the stone…');
    await this._yieldFrame();

    // grid copy for door state
    this.openedDoors = new Set();

    const spawn = tileToWorld(this.dungeon.spawn.x, this.dungeon.spawn.y);
    // loadFloor is async and fire-and-forget: quitting to the title (which
    // nulls the player) while the earlier yields are pending must not crash
    // the in-flight load. Bail out - the world is being torn down anyway.
    if (!this.player) { this._loading = false; return; }
    this.player.pos.set(spawn.x, 0, spawn.z);
    // Resume-exact override (Obsidian 791): a refresh mid-dungeon drops the hero
    // back on the very tile they were standing on, not the floor entrance.
    if (this._resumePos) { this.player.pos.set(this._resumePos.x, 0, this._resumePos.z); this._resumePos = null; }
    this.player.dead = false;

    // Safe zone: the ring around the return portal. Inside it the player takes
    // no damage and enemies won't path in — a breather beside the way home.
    // (Boss floors have no return portal, so no safe zone — you must fight.)
    this.safeZone = this.dungeonMeshes.returnPortalMesh ? { x: spawn.x, z: spawn.z, r: 3.2 } : null;

    // stage 3: place enemies (stats scale up with connected player count in mp).
    // A floor this character fully cleared stays cleared: nothing respawns on a
    // revisit (chests and breakables are part of the layout and DO come back).
    const cleared = !!this.clearedFloors[floor];
    const mpMult = 1 + 0.5 * (net.playerCount - 1);
    if (!cleared) for (const spec of this.dungeon.enemies) {
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
    if (!cleared && this.dungeon.boss && !(actOfFloor(floor) === 5 && this.bossDefeated)) {
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

    // Revisited cleared arena: the lord is long dead, and boss floors have no
    // return portal, so restore the golden act exit or the run would soft-lock.
    // (Act 5's arena never reloads cleared: victory bumps the save past it.)
    if (cleared && this.dungeon.boss && actOfFloor(floor) < 5) {
      const bw = tileToWorld(this.dungeon.boss.x, this.dungeon.boss.y);
      this.spawnActExit(bw.x, bw.z);
    }

    // Stairs are sealed until 70% of the floor is culled AND the elite falls.
    this.floorEnemyTotal = this.enemies.filter((e) => !e.isBoss).length;
    this.floorKills = 0;
    this._stairsWasLocked = this.stairsLocked();
    this._sealNoticeT = 0;
    // Sealed hatch pools a dim greyish-gold light on the floor; once the stairs
    // unlock it glows bright, enticing gold to draw the eye to the exit.
    this.setStairsGlow(this._stairsWasLocked);

    // stage 4: lighting, minimap, environment reflection
    this.ui.showLoading(0.85, 'Lighting the torches…');
    await this._yieldFrame();
    this.setupTorchLights(theme);
    this.ui.minimap.setDungeon(this.dungeon);
    this.ui.showFloorBanner(this.floorBannerTitle(), theme.name, true);
    // Every floor opens on its act's themed exploration bed. On a boss floor
    // the lord's own battle music crossfades in only once it wakes (see
    // updateBossMusic), so the arena keeps its dread until the fight starts.
    this._bossMusicOn = false;
    audio.playMusic(audio.dungeonTrack(actOfFloor(floor)));
    audio.startAmbience(actOfFloor(floor) <= 2 ? 'dungeon-wet' : 'dungeon-dry'); // drips only in the wet acts
    audio.play('stairs', { volume: 0.7 });
    this.stairsCooldown = 1.5;
    this.returnPortalArmed = false; // arms once you walk away from the entrance
    this.requestSave(true);
    this.refreshEnvironmentReflection();

    if (net.isHost) this.broadcastWorld();

    // Pre-compile every shader program the freshly-built floor needs
    // (Obsidian 753): without this, WebGL compiles each material variant the
    // first frame it becomes visible - enemies stepping into view, the first
    // fireball, the first loot beam - and each compile is a visible mid-
    // combat hitch. Doing it here folds the cost into the loading screen.
    try { this.renderer.compile(this.scene, this.camera); } catch { /* best-effort */ }

    // floor ready + player placed: drop the loading screen.
    this.ui.setLoadingProgress(1, 'Ready');
    this.ui.hideLoading();
    this._loading = false;

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
    if (this.inUpstairs) return '🍺 The Sleeping Golem — Upstairs';
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
      this.ensureRemotePlayer(from, msg.cls, msg.name, { gender: msg.gn, skinTone: msg.sk, hairColor: msg.hc, eyeColor: msg.ec, faceShape: msg.fs, hairStyle: msg.hs });
      this.sendLoadout(); // let the (re)joining hero see our gear
      if (known) return;
      if (this.player) this.ui.floaters.spawn(this.player.pos, `${msg.name || 'A hero'} has joined!`, 'crit');
      net.send({ t: 'notice', txt: `${msg.name || 'A hero'} has joined the room!` });
    });
    net.on('pos', (msg, from) => {
      const rp = this.ensureRemotePlayer(from, msg.cls, null, { gender: msg.gn, skinTone: msg.sk, hairColor: msg.hc, eyeColor: msg.ec, faceShape: msg.fs, hairStyle: msg.hs });
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
      // Gate the floating roast bubble the same way as every other AI line:
      // ellipsis while this guest's own voice engine is loading/generating,
      // then the actual line the instant audio starts.
      roaster.sayGated(this, null, msg.txt, roaster.pickVoice(msg.ty), e.pos, {
        show: () => this.ui.floaters.spawn(e.pos, `“${msg.txt}”`, 'roast', 6),
      });
    });
    net.on('state', (msg) => {
      if (net.isHost || !this.player) return;
      const myId = net.peer?.id;
      for (const pl of msg.pl) {
        if (pl.id === myId) continue;
        const rp = this.ensureRemotePlayer(pl.id, pl.cls, pl.nm, { gender: pl.gn, skinTone: pl.sk, hairColor: pl.hc, eyeColor: pl.ec, faceShape: pl.fs, hairStyle: pl.hs });
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
      this.rollDeathLoot(msg.x, msg.z, { miniboss: msg.mb, isBoss: msg.boss, elite: msg.el });
      if (msg.boss) {
        this.actsCleared = Math.max(this.actsCleared, this.currentAct());
        if (this.currentAct() < 5 && this.floor <= MAX_FLOOR) {
          this.spawnActExit(msg.x, msg.z);
          this.ui.showFloorBanner(`ACT ${ROMAN[this.currentAct()]} CLEARED`, 'The way deeper opens…', true);
          this.showQuestCompleteToast(this.currentAct());
          this._bossMusicOn = false;
          audio.playMusic(audio.dungeonTrack(this.currentAct()), 2);
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
      voice.attachToRoom(net.room);
      if (this.settings.voiceMode !== 'off') voice.enable(this.settings.voiceMode, this.settings.voiceThreshold);
      net.broadcastRoster();
    } else {
      net.send({ t: 'hello', cls: this.player.classId, name: this.playerName(), gn: this.player.gender, sk: this.player.skinTone, hc: this.player.hairColor, ec: this.player.eyeColor, fs: this.player.faceShape, hs: this.player.hairStyle });
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
    this.dungeonMeshes = buildDungeonMeshes(this.dungeon, theme, this.inTown ? 1 : this.floor);
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
    // Same music rules as the host's loadFloor: the act's exploration bed
    // now, the lord's own battle loop later when updateBossMusic sees aggro.
    this._bossMusicOn = false;
    audio.playMusic(this.inTown ? 'tavern' : audio.dungeonTrack(actOfFloor(this.floor)));
    audio.startAmbience(this.inTown ? 'town' : (actOfFloor(this.floor) <= 2 ? 'dungeon-wet' : 'dungeon-dry'));
    this.stairsCooldown = 1.5;
  }

  // Guest-side lightweight enemy stand-in (host runs the real AI).
  addEnemyMirror(spec) {
    if (this.enemies.some((e) => e.netId === spec.id)) return;
    const mesh = spec.boss ? buildBossMesh() : buildEnemyMesh(spec.ty, spec.mb ? 1.5 : spec.el ? 1.25 : 1);
    mesh.position.set(spec.x, 0, spec.z);
    this.scene.add(mesh);
    // Same lazy GLB swap as the host-side Enemy class (see enemies.js's
    // constructor): guests see the same modeled creatures, not boxes.
    const modelKey = spec.boss ? bossModelKey(actOfFloor(this.floor)) : typeModelKey(spec.ty);
    if (modelKey) attachEnemyModel(mesh, modelKey);
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
      // Animate mirrored mobs on the guest too. Mirror enemies are plain object
      // literals (not Enemy instances), so Enemy._animateGait isn't on them.
      // Modeled (GLB) mobs drive their AnimationMixer directly (mirrors are
      // always "moving" from the guest's POV, so just run the walk clip);
      // box-fallback mobs get the same inline limb oscillation as before.
      const anim = m.mesh.userData?.anim;
      if (anim) {
        anim.setLocomotion(1);
        anim.update(dt);
      } else {
        const gait = m.mesh.userData?.gait;
        if (gait && gait.length) {
          if (m._gt === undefined) m._gt = m.pos.x + m.pos.z; // deterministic-ish phase offset
          m._gt += dt * 9; // chasing cadence
          const t = m._gt;
          for (const p of gait) {
            if (p.kind === 'leg') p.mesh.rotation.x = p.bx + Math.sin(t + p.phase) * p.amp;
            else if (p.kind === 'arm') p.mesh.rotation.x = p.bx + Math.sin(t + p.phase) * p.amp * 0.85;
            else if (p.kind === 'wing') p.mesh.rotation.z = p.bz + Math.sin(t * 1.9 + p.phase) * p.amp;
            else if (p.kind === 'tail') p.mesh.rotation.x = p.bx + Math.sin(t * 1.2 + p.phase) * p.amp;
          }
        }
      }
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

  // Attach/refresh an on-body aura of drifting motes on a hero mesh. (The old
  // ground ring-glow was removed - it read as a "weird ring on the floor"; the
  // aura now lives entirely on the body as a swarm of sparkles + a companion.)
  setHeroAura(mesh, tier) {
    if (!mesh || mesh.userData.auraTier === tier) return;
    mesh.userData.auraTier = tier;
    if (mesh.userData.auraGroup) { mesh.remove(mesh.userData.auraGroup); mesh.userData.auraGroup = null; }
    if (!tier) return;
    const color = tier >= 2 ? 0xffd24a : 0xb060ff;
    const grp = new THREE.Group();
    // Sparkle swarm: a small pool of motes, each with its own random size, orbit
    // radius/height/tilt and speed (some fast, some slow), continuously fading in
    // and out on independent life cycles so the aura shimmers and churns rather
    // than spinning as one rigid ring. One shared geometry + additive material
    // keeps it cheap; per-mote scale/opacity is driven in animateAuras from the
    // seed values stashed here (see spawnMote / animateAuras). Modeled on the
    // portal swarm's per-particle random orbits (src/world/portal.js).
    const sparkles = new THREE.Group();
    const n = tier >= 2 ? 10 : 7;
    const sGeo = new THREE.SphereGeometry(1, 6, 6); // unit sphere, scaled per-mote
    const spawnMote = (m, phaseOffset = 0) => {
      m.userData.orbit = {
        radius: 0.34 + Math.random() * 0.34,
        baseY: 0.35 + Math.random() * 1.0,
        bob: 0.05 + Math.random() * 0.18,
        angle: Math.random() * Math.PI * 2,
        speed: (0.5 + Math.random() * 1.7) * (Math.random() < 0.5 ? -1 : 1), // varied, both directions
        tilt: (Math.random() - 0.5) * 0.5,
        size: 0.022 + Math.random() * 0.05, // different-sized balls
        life: 1.4 + Math.random() * 1.8,
        // Start the life clock spread out so they don't all pop in together on
        // the first frame; phaseOffset seeds the initial staggering.
        age: phaseOffset,
      };
    };
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      spawnMote(s, Math.random() * 2.4);
      sparkles.add(s);
    }
    grp.add(sparkles);
    grp.userData.sparkles = sparkles;
    grp.userData.spawnMote = spawnMote;
    // Epic tier also gets a little glowing winged companion flitting around.
    if (tier >= 2) {
      const comp = new THREE.Group();
      comp.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff2c0 })));
      comp.add(new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.35 })));
      const wingMat = new THREE.MeshBasicMaterial({ color: 0xffe680, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
      const wl = new THREE.Mesh(new THREE.CircleGeometry(0.1, 3), wingMat); wl.position.x = -0.05;
      const wr = new THREE.Mesh(new THREE.CircleGeometry(0.1, 3), wingMat); wr.position.x = 0.05;
      comp.add(wl, wr);
      comp.userData.wings = [wl, wr];
      grp.add(comp);
      grp.userData.companion = comp;
    }
    mesh.add(grp);
    mesh.userData.auraGroup = grp;
  }

  // Show equipped gear on a hero: a rarity-tinted helmet, shoulder pauldrons and
  // chest plate that only rebuild when the loadout's rarities change. Works for
  // the local hero (full items) and remotes (compact synced loadout) alike.
  updateHeroGear(mesh, equipped, classId = 'knight') {
    if (!mesh || !equipped) return;
    const slots = ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket', 'offhand'];
    // Key the rebuild on each item's ID (not just rarity) so swapping to a
    // different helmet of the same rarity actually changes the look.
    const sig = classId + '|' + slots.map((s) => equipped[s]?.id ?? '-').join(',');
    if (mesh.userData.gearSig === sig) return;
    mesh.userData.gearSig = sig;
    // Remove via the ACTUAL parent: since Obsidian 725 the gear group rides a
    // body bone (anchorToBodyBone below), so mesh.remove() would miss it.
    if (mesh.userData.gearVisual) { mesh.userData.gearVisual.parent?.remove(mesh.userData.gearVisual); mesh.userData.gearVisual = null; }
    // The rogue's hood is its default headgear (split off from the head mesh so
    // it can toggle). A helmet covers the same crown, so hide the hood when one
    // is equipped and show it again when it comes off - but ONLY for classes
    // that actually have a baked replacement (mesh.userData.bakedHat). The
    // ranger model has no baked hat/helmet mesh of its own (see bakedHat
    // detection in heroModel.js), so hiding its hood on "helmet" equip would
    // leave a bare head with nothing shown; instead its hood stays up and gets
    // a feathered decoration below (see the ranger block after the helmet/hat
    // branch).
    if (mesh.userData.hood) mesh.userData.hood.visible = !(equipped.helmet && mesh.userData.bakedHat);
    // Hair style (TODO 97): the procedural Bun (heroModel.js's addHairMesh)
    // sits right where a helmet seats, so hide it while one is equipped -
    // same gate as the hood above (only classes with an actual baked helmet
    // replacement hide anything). Ponytail/Long hang below the crown/behind
    // the head and clear equipped headgear fine, so they stay visible.
    if (mesh.userData.hairStyleMesh?.style === 'bun') {
      mesh.userData.hairStyleMesh.group.visible = !(equipped.helmet && mesh.userData.bakedHat);
    }
    const grp = new THREE.Group();
    const mat = (rarity) => {
      const c = RARITIES[rarity]?.color ?? 0x8a8a8a;
      const hot = rarity === 'legendary' || rarity === 'epic';
      return new THREE.MeshStandardMaterial({ color: c, metalness: 0.5, roughness: 0.45, emissive: hot ? c : 0x000000, emissiveIntensity: rarity === 'legendary' ? 0.4 : rarity === 'epic' ? 0.22 : 0 });
    };
    // deterministic 0..1 from an item id, so each item's piece differs a little
    const rof = (item) => { let h = 2166136261; const s = String(item.id); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
    // A second independent 0..1 roll from the same id (mix the hash differently)
    // so shape-branching decisions don't all key off the same number as size/height.
    const rof2 = (item) => { let h = 84696351; const s = String(item.id); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 2654435761); h ^= h >>> 13; } return (h >>> 0) / 4294967296; };
    // A third independent roll (yet another hash mix) reserved for headgear
    // SILHOUETTE branching (mage hood-vs-hat, knight horns/crest/faceguard
    // choice) so those style picks don't correlate with the size/height (r)
    // or palette/robe-style (r2) rolls above.
    const rof3 = (item) => { let h = 738813; const s = String(item.id) + '#shape'; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 2246822519); h ^= h >>> 15; } return (h >>> 0) / 4294967296; };
    const elaborate = (rarity) => rarity === 'legendary' || rarity === 'epic'; // extra trim/gems/layers at high rarity
    // Physics refs collected below: hat tips / robe hems / cloak corners that
    // get a subtle per-frame sway in animateAuras. Reset each rebuild.
    const sway = { hat: null, hem: [], cloak: [] };
    // Real distinct weapon/shield/tome GLB variants, keyed by their own KayKit
    // mesh name (see heldVariants in heroModel.js's buildAnimatedHero - every
    // baked weapon/shield the class's model ships is kept alive, hidden,
    // rather than discarded). Below we pick exactly one weapon variant and
    // (knight) one shield variant / (mage) one tome variant from the equipped
    // item's NAME, show that one and hide its siblings - so a "Greatsword"
    // shows the model's actual 2H_Sword mesh while a "Rusty Sword" shows the
    // 1H_Sword, instead of the same baked shape retinted regardless of what
    // was picked up. A variant that doesn't exist in this class's GLB (e.g.
    // no true "Bow" mesh - KayKit only ships crossbows) falls back to
    // whichever variant IS present, so a hero is never left empty-handed.
    const variants = mesh.userData.heldVariants || {};
    const KNIGHT_2H_SWORD_NAMES = /Greatsword|Warblade|Cleaver/i;
    const MAGE_WAND_NAMES = /Wand|Scepter/i;
    const RANGER_1H_BOW_NAMES = /Shortbow|Recurve/i;
    let activeWeaponName = null;
    if (classId === 'knight') {
      activeWeaponName = (equipped.weapon && KNIGHT_2H_SWORD_NAMES.test(equipped.weapon.name) && variants['2H_Sword'])
        ? '2H_Sword' : (variants['1H_Sword'] ? '1H_Sword' : (variants['2H_Sword'] ? '2H_Sword' : null));
    } else if (classId === 'mage') {
      activeWeaponName = (equipped.weapon && MAGE_WAND_NAMES.test(equipped.weapon.name) && variants['1H_Wand'])
        ? '1H_Wand' : (variants['2H_Staff'] ? '2H_Staff' : (variants['1H_Wand'] ? '1H_Wand' : null));
    } else if (classId === 'ranger') {
      activeWeaponName = (equipped.weapon && RANGER_1H_BOW_NAMES.test(equipped.weapon.name) && variants['1H_Crossbow'])
        ? '1H_Crossbow' : (variants['2H_Crossbow'] ? '2H_Crossbow' : (variants['1H_Crossbow'] ? '1H_Crossbow' : null));
    }
    const WEAPON_VARIANT_NAMES = ['1H_Sword', '2H_Sword', '1H_Wand', '2H_Staff', '1H_Crossbow', '2H_Crossbow'];
    for (const n of WEAPON_VARIANT_NAMES) { const v = variants[n]; if (v) v.visible = (n === activeWeaponName); }
    // Knight offhand shield: a per-item seeded pick among whichever shield
    // variants this GLB ships (Round/Spike/Badge/Rectangle), so different
    // shield items read as different shield SHAPES, not just different tints
    // of the same round shield. No offhand equipped still shows the default
    // Round_Shield (knights are never bare-handed on the off-side).
    const SHIELD_NAMES = ['Round_Shield', 'Spike_Shield', 'Badge_Shield', 'Rectangle_Shield'];
    let activeShieldName = null;
    if (classId === 'knight') {
      const avail = SHIELD_NAMES.filter((n) => variants[n]);
      if (avail.length) {
        activeShieldName = equipped.offhand ? avail[Math.floor(rof(equipped.offhand) * avail.length)]
          : (variants['Round_Shield'] ? 'Round_Shield' : avail[0]);
      }
    }
    for (const n of SHIELD_NAMES) { const v = variants[n]; if (v) v.visible = (n === activeShieldName); }
    // Mage offhand tome: reuse the model's own baked Spellbook/Spellbook_open
    // mesh (force-hidden by default in heroModel.js) as the real prop for a
    // Tome/Grimoire/Codex offhand item, instead of the small procedural book
    // stand-in used for the other mage offhand names (Orb/Focus Stone, which
    // have no baked mesh to reuse - see the procedural fallback below).
    const TOME_NAMES = ['Spellbook', 'Spellbook_open'];
    let activeTomeName = null;
    if (classId === 'mage' && equipped.offhand && /Tome|Grimoire|Codex/i.test(equipped.offhand.name)) {
      const avail = TOME_NAMES.filter((n) => variants[n]);
      if (avail.length) activeTomeName = avail[Math.floor(rof(equipped.offhand) * avail.length)];
    }
    for (const n of TOME_NAMES) { const v = variants[n]; if (v) v.visible = (n === activeTomeName); }
    if (equipped.helmet && mesh.userData.bakedHat) {
      // Show the model's OWN authored headgear mesh (KayKit's Mage_Hat /
      // Knight_Helmet - see heroModel.js bakedHat) instead of a procedural
      // stand-in. It is already sized and seated to fit this exact head and
      // hair with no clipping, since it is the asset the hair was modelled
      // around. We just recolour it (clone its material once per rebuild)
      // and add a small per-item scale/tilt variance so different helmet
      // items still read as slightly different, without ever risking clip.
      const it = equipped.helmet, r = rof(it), r2 = rof2(it), r3 = rof3(it);
      const hat = mesh.userData.bakedHat;
      hat.visible = true;
      if (!hat.userData.origMat) hat.userData.origMat = hat.material;
      hat.material = hat.userData.origMat.clone();
      // Clear any band/buckle/star ornaments added by a PREVIOUS helmet
      // (this only runs when the loadout signature actually changes, e.g.
      // swapping to a different helmet item - but without this, each swap
      // would leave the last helmet's ornaments as stale ghost children).
      for (let i = hat.children.length - 1; i >= 0; i--) hat.remove(hat.children[i]);
      // This is a static mesh rigidly parented to the head bone, not a
      // SkinnedMesh - it tracks the head's bone transform exactly, but the
      // head mesh itself has its own baked animation deformation (idle
      // breathing/run/attack squash) that can momentarily poke past a
      // helmet sized to the bind pose. A small uniform margin (always >=1,
      // never smaller than the authored asset) keeps the head fully
      // contained through the whole animation range at every frame.
      const s = 1.04 + r * 0.05;
      hat.scale.set(s, s, s);
      hat.rotation.z = (r - 0.5) * 0.1; // tiny per-item tilt variance
      if (classId === 'mage') {
        // Mage cloaked hood: when BOTH a helmet-slot item and the chest robe
        // are worn, hood-flavored helmet items (seeded on r3, independent of
        // the hat's own height/palette rolls below) render a cloth hood
        // instead of the baked pointy hat, so the mage reads as a hooded
        // robe rather than a hat sitting awkwardly over a robe collar. If no
        // robe is worn, always fall back to the hat (a floating cloth cone
        // with no robe collar to meet would look like a mistake, not a
        // style). The hooded HEAD carries its own authored neck/scarf, and
        // the robe is now the dyed baked body (732), so no shared collar
        // seam constant is needed anymore. It is
        // two-tone by design: the hood tints from the HELMET item's own
        // rarity colour while the robe keeps its own tint from the chest
        // item - a real hooded-robe often uses a contrast lining, not the
        // exact same dye lot as the robe body.
        const anchor = mesh.userData.headAnchor;
        // Hood style (TODO 93): only for hood-flavored helmet items (name
        // matches the same /hood|visage|coif/i test itemIcon.js's ICON_RULES
        // uses to pick the hood icon), and only when a chest robe is worn -
        // a floating cloth cowl with no robe collar to meet would look like a
        // mistake, not a style. A prior attempt (TODO 671) built this as a
        // single procedural sphere-dome and it read as "a turban", not a
        // hood, from most angles - a featureless ball is a ball no matter how
        // wide the face cutout is. This version is instead built from THREE
        // distinct pieces so the silhouette can never collapse into a ball:
        // a small crown CAP (top-of-skull only, not the whole head), an
        // open-fronted cowl WALL hanging from the cap down to the collar
        // (a real cylinder has depth at its cut edges, unlike a paper-thin
        // dome), and a draped back POINT hanging past the collar toward the
        // shoulders (see the isHoodStyle block below).
        const isHoodStyle = !!(anchor && equipped.chest && /hood|visage|coif/i.test(it.name));
        // Hooded HEAD swap (Obsidian 714, replacing every hood-over-the-head
        // attempt - procedural cowl, extracted hood accessory, liner - all
        // of which leaked hair or hem artifacts somewhere): userData.mageHood
        // is now a fitted clone of the rogue's COMPLETE authored hooded head
        // (hood + shadowed mask + face + neck in one garment, see
        // heroModel.js). Showing it hides the mage's entire own head mesh,
        // so there is no hair left to escape. This block only
        // shows/hides/retints, it builds nothing.
        const mageHood = mesh.userData.mageHood;
        if (isHoodStyle && mageHood) {
          hat.visible = false; // baked pointy-hat mesh stays hidden for this style
          mageHood.visible = true;
          if (mesh.userData.mageHeadMesh) mesh.userData.mageHeadMesh.visible = false;
          if (mesh.userData.hairStyleMesh) mesh.userData.hairStyleMesh.group.visible = false;
          // Two-tone via the atlas, not material.color: the hooded head's one
          // material also renders the FACE, so a whole-material tint would
          // dye the skin. tintHoodedHeadMap repaints only the hood-cloth
          // tiles to the helmet item's rarity colour and the face tile to
          // the player's chosen skin tone. Tinted from the PRISTINE template
          // map every time (see its comment) and cached per rarity+skin so
          // repeat updateHeroGear calls don't rebuild canvases.
          const hoodColor = RARITIES[it.rarity]?.color ?? 0x8a8a8a;
          const hh = mesh.userData.mageHoodedHead;
          const skinHex = mesh.userData.skinToneHex ?? 0xf3b189; // rogue's own face tone fallback
          const tintKey = `${hoodColor}_${skinHex}`;
          if (hh.userData.tintKey !== tintKey) {
            const tinted = tintHoodedHeadMap(hh.material.userData.pristineMap || (hh.material.userData.pristineMap = hh.material.map), skinHex, hoodColor);
            if (tinted) {
              if (hh.userData.tintedMap) hh.userData.tintedMap.dispose();
              hh.userData.tintedMap = tinted;
              hh.userData.tintKey = tintKey;
              hh.material.map = tinted;
              hh.material.needsUpdate = true;
            }
          }
          hh.material.metalness = 0.05;
          hh.material.roughness = 0.85;
          // No emissive rarity glow here (unlike the retired hood accessory):
          // the one material also lights the FACE, and a glowing face reads
          // as a bug, not a legendary. Rarity shows through the cloth tint.
          if (hh.material.emissive) { hh.material.emissive.set(0x000000); hh.material.emissiveIntensity = 0; }
          // no sway: this IS the head now - it must track the head bone
          // rigidly, not breeze independently of the face inside it.
          sway.hat = null;
        } else {
          if (mageHood) mageHood.visible = false; // no robe, or the authored asset failed to load - fall back to the hat below
          if (mesh.userData.mageHeadMesh) mesh.userData.mageHeadMesh.visible = true;
          // hair-style visibility is re-derived every pass by the bun/helmet
          // rule earlier in this function, so nothing to restore here.
        // The authored Mage_Hat brim is wide enough to curtain the whole face at
        // the game's slightly-zoomed camera. Squash ONLY the brim radius (local
        // X/Z) so at least the lower half of the face clears it, while keeping
        // the crown's height (Y) so the hat still reads as a tall wizard hat and
        // not a flat cap. Knight helmets never enter this branch, so this cannot
        // touch them.
        hat.scale.x = s * 0.68;
        hat.scale.z = s * 0.68;
        // Height variance: seeded per item so the same item always renders the
        // same silhouette, but different items read as genuinely taller/shorter
        // pointed hats rather than only differing by colour. Scaling the whole
        // hat's Y (crown + brim together) keeps the brim seated on the head.
        const heightMul = 0.78 + r * 0.55; // ~0.78 (short, stubby) .. 1.33 (tall, pointed)
        hat.scale.y = s * heightMul;
        // Cloth hat: pick from a real colour palette (seeded per item, not
        // always the rarity colour) so hats vary hue instead of every
        // legendary being flat orange. Rarity nudges richness/saturation.
        const HAT_PALETTE = [0x5a3a8f, 0x2e5f6b, 0x7a2e3a, 0x2f5c33, 0x6b3f1f, 0x3b3f7a, 0x8a4a2e, 0x4a4a7a];
        const hue = HAT_PALETTE[Math.floor(r2 * HAT_PALETTE.length)];
        const hot = it.rarity === 'legendary' || it.rarity === 'epic';
        // Multiply-tint (not a flat colour replace) so the atlas's own baked
        // light-to-dark shading still reads through as cloth folds, not a
        // single flat plastic colour.
        hat.material.color.set(hue);
        if (hat.material.emissive) { hat.material.emissive.set(hot ? hue : 0x000000); hat.material.emissiveIntensity = it.rarity === 'legendary' ? 0.28 : it.rarity === 'epic' ? 0.16 : 0; }
        hat.material.metalness = 0.03; hat.material.roughness = 0.9; // matte cloth
        // Overlay hat band + buckle in a leather colour that is ALWAYS
        // distinct from the cloth (the shared atlas tints uniformly, so a
        // separate small mesh is the reliable way to guarantee contrast).
        // Positioned at the hat's own local band height (KayKit's Mage_Hat
        // has its brim near local y=0 and tapers up from there).
        const bandColor = 0x3a2a1a; // dark leather
        const hatR = mesh.userData.headAnchor ? Math.max(0.22, mesh.userData.headAnchor.r) : 0.4;
        const band = new THREE.Mesh(new THREE.TorusGeometry(hatR * 0.42, hatR * 0.06, 8, 16), new THREE.MeshStandardMaterial({ color: bandColor, roughness: 0.75, metalness: 0.05 }));
        band.rotation.x = Math.PI / 2; band.position.y = hatR * 0.28;
        hat.add(band);
        const buckle = new THREE.Mesh(new THREE.BoxGeometry(hatR * 0.1, hatR * 0.07, hatR * 0.03), new THREE.MeshStandardMaterial({ color: 0xc9c2a8, roughness: 0.35, metalness: 0.6 }));
        buckle.position.set(0, hatR * 0.28, hatR * 0.42);
        hat.add(buckle);
        // Curled tip: for roughly half of items (seeded on r3, independent of
        // height/palette) bend the very point of the hat over to one side with
        // a small extra cone, so hats vary in STYLE (curled vs. straight
        // point), not only height/colour. Parented to the hat mesh itself so
        // it inherits the hat's own existing sway physics (see
        // animateGearSway/sway.hat) for free, without a second sway target.
        if (r3 > 0.5) {
          if (!hat.userData._bbox) { hat.geometry.computeBoundingBox(); hat.userData._bbox = hat.geometry.boundingBox.clone(); }
          const tipY = hat.userData._bbox.max.y;
          const side = r3 > 0.75 ? 1 : -1;
          const curl = new THREE.Mesh(new THREE.ConeGeometry(hatR * 0.16, tipY * (0.35 + r * 0.25), 7), hat.material);
          curl.position.set(side * hatR * 0.12, tipY * 0.9, 0);
          curl.rotation.z = side * (0.85 + r * 0.5); // bend the point over sideways
          hat.add(curl);
        }
        }
      } else {
        // Metal helmet (knight): the base colour stays STEEL/GUNMETAL GREY -
        // real metal reads by reflection/specular, not a saturated diffuse
        // hue, so a "purple helmet" would just look like purple plastic.
        // Rarity instead layers a subtle SHEEN (a gentle multiply toward a
        // tint, not a hue replace) over that steel base: near-neutral grey
        // (common), a cool blue-steel sheen (rare), a faint violet-steel
        // sheen (epic), a warm gold-steel sheen (legendary). metalness is
        // near-1 and roughness low so it actually reflects the scene's PMREM
        // environment (see this.scene.environment in the constructor) -
        // that reflection, not a flat diffuse hue, is what reads as "metal".
        const STEEL = new THREE.Color(0xaeb4bc);
        const SHEEN = { common: 0xaeb4bc, rare: 0x8fa8c2, epic: 0xa898c2, legendary: 0xc9ad78 };
        const c = STEEL.clone().lerp(new THREE.Color(SHEEN[it.rarity] ?? SHEEN.common), 0.35);
        const hot = it.rarity === 'legendary' || it.rarity === 'epic';
        hat.material.color.copy(c);
        hat.material.metalness = 0.95;
        hat.material.roughness = 0.22;
        // Subtle, not a mirror: a faded impression of the actual nearby
        // scene (see refreshEnvironmentReflection, which snapshots the real
        // town/dungeon into scene.environment) rather than a strong reflection.
        hat.material.envMapIntensity = 0.55;
        if (hat.material.emissive) { hat.material.emissive.set(hot ? SHEEN[it.rarity] : 0x000000); hat.material.emissiveIntensity = it.rarity === 'legendary' ? 0.14 : it.rarity === 'epic' ? 0.08 : 0; }
        // Procedural embellishments layered on the baked helmet mesh so
        // different knight helmets read as distinct SHAPES (domed / horned /
        // crested / great-helm), not just a flat colour swap. Seeded on r3
        // (independent of the sheen/tilt rolls above) so the same item always
        // gets the same silhouette; rarity raises how many embellishments
        // stack, so a plain domed look is the common-rarity baseline and
        // legendaries can carry horns + crest + faceguard together. All
        // pieces share the helmet's own freshly-tinted material so they read
        // as part of the same steel, and are parented to the hat mesh so
        // they inherit its existing sway (see sway.hat below) for free.
        // Measured from the helmet's OWN local geometry bounding box (cached
        // once) rather than guessed proportions - the baked Knight_Helmet's
        // real local height/width are unknown ahead of time, and guessing
        // wrong buries add-ons inside the dome or floats them off in space.
        if (!hat.userData._bbox) { hat.geometry.computeBoundingBox(); hat.userData._bbox = hat.geometry.boundingBox.clone(); }
        const hbb = hat.userData._bbox;
        const hTop = hbb.max.y, hMidY = (hbb.min.y + hbb.max.y) / 2, hMidZ = (hbb.min.z + hbb.max.z) / 2;
        const hW = (hbb.max.x - hbb.min.x) / 2;
        const fancy = elaborate(it.rarity);
        const wantsHorns = fancy || r3 > 0.72;
        const wantsCrest = it.rarity !== 'common' && (r3 < 0.35 || fancy);
        const wantsFaceGuard = fancy && r3 > 0.4 && r3 < 0.85;
        // Sizes/positions come from the helmet's EXTENT (max-min), never from
        // absolute local-Y multiples: the baked geometry's local origin is the
        // model root, so max.y alone includes the whole head-height offset and
        // scaling by it produced comically oversized add-ons (giant slab
        // crests twice the helmet - the exact bug seen in the preview).
        const hH = hbb.max.y - hbb.min.y;
        if (wantsHorns) {
          for (const sx of [-1, 1]) {
            const horn = new THREE.Mesh(new THREE.ConeGeometry(hW * 0.14, hH * (0.35 + r2 * 0.3), 6), hat.material);
            horn.position.set(sx * hW * 0.55, hbb.max.y - hH * 0.22, hMidZ);
            horn.rotation.z = sx * (0.4 + r2 * 0.3);
            horn.rotation.x = -0.2;
            hat.add(horn);
          }
        }
        if (wantsCrest) {
          const crestLen = hbb.max.z - hbb.min.z;
          const crestH = hH * (0.28 + r2 * 0.22);
          const crest = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.16, crestH, crestLen * 0.9), hat.material);
          crest.position.set(0, hbb.max.y - crestH * 0.15, hMidZ);
          hat.add(crest);
        }
        if (wantsFaceGuard) {
          const guard = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.14, hH * 0.5, hW * 0.14), hat.material);
          guard.position.set(0, hbb.min.y + hH * 0.25, hbb.max.z * 0.95);
          hat.add(guard);
        }
      }
      // Gentle sway target: the baked hat mesh itself (its own pivot is
      // already at the head/seat, authored by KayKit), so oscillating it
      // reads as the point/brim swaying without any separate piece. Skipped
      // if the mage hood branch above already claimed sway.hat for the
      // procedural hood instead (the hat itself stays hidden in that case).
      if (!sway.hat) sway.hat = { obj: hat, baseZ: hat.rotation.z, baseX: 0, amp: 0.035 + r * 0.02 };
    } else if (mesh.userData.bakedHat) {
      // No helmet equipped: keep the baked hat hidden (bare head / default
      // hood, per each class's own default-look logic above).
      mesh.userData.bakedHat.visible = false;
      if (mesh.userData.mageHood) mesh.userData.mageHood.visible = false;
      // ...and bring the mage's real head back if a hooded head was swapped in
      if (mesh.userData.mageHeadMesh) mesh.userData.mageHeadMesh.visible = true;
    }
    // Ranger: this class has no baked hat/helmet mesh of its own (the
    // Rogue_Hooded model ships no _Hat/_Helmet-suffixed mesh, so bakedHat is
    // always null - see heroModel.js), so it never enters the
    // equipped.helmet && bakedHat branch above at all. Its hood therefore
    // stays up regardless of the helmet slot (see the hood-visibility line
    // near the top of this method) and an equipped "helmet" item instead
    // decorates that SAME hood with a seeded feather (or a small cluster at
    // higher rarity) tucked into the hood's band, varying feather
    // count/length/tilt per item so rangers read as feathered hoods rather
    // than only a colour change.
    if (classId === 'ranger' && mesh.userData.hood) {
      const hood = mesh.userData.hood;
      for (let i = hood.children.length - 1; i >= 0; i--) hood.remove(hood.children[i]);
      if (equipped.helmet) {
        const it = equipped.helmet, r = rof(it), r2 = rof2(it), fancy = elaborate(it.rarity);
        const anchor = mesh.userData.headAnchor;
        const hR = anchor ? Math.max(0.18, anchor.r) : 0.3;
        const featherColor = RARITIES[it.rarity]?.color ?? 0x8a8a8a;
        const hot = it.rarity === 'legendary' || it.rarity === 'epic';
        const featherMat = new THREE.MeshStandardMaterial({ color: featherColor, roughness: 0.65, metalness: 0.05, emissive: hot ? featherColor : 0x000000, emissiveIntensity: it.rarity === 'legendary' ? 0.25 : it.rarity === 'epic' ? 0.14 : 0, side: THREE.DoubleSide });
        const count = fancy ? (it.rarity === 'legendary' ? 3 : 2) : 1;
        const baseX = (anchor ? anchor.cx : 0) + hR * 0.4;
        const baseY = (anchor ? anchor.top : 0.6) * 0.62;
        const baseZ = (anchor ? anchor.cz : 0) - hR * 0.3;
        for (let i = 0; i < count; i++) {
          const len = hR * (1.1 + r * 0.7) * (1 - i * 0.16);
          // A flattened, tapered cone reads as a slim feather/quill blade
          // rather than a round spike (scale.z squashes it into a plane).
          const feather = new THREE.Mesh(new THREE.ConeGeometry(hR * 0.14, len, 3, 1, false), featherMat);
          feather.scale.z = 0.14;
          const spread = (i - (count - 1) / 2) * 0.4;
          feather.position.set(baseX + spread * 0.12, baseY + len * 0.35, baseZ);
          feather.rotation.z = 0.55 + r2 * 0.4 + spread;
          feather.rotation.x = -0.3;
          hood.add(feather);
        }
      }
    }
    if (equipped.chest) {
      const it = equipped.chest, m = mat(it.rarity), r = rof(it), r2 = rof2(it), fancy = elaborate(it.rarity);
      if (classId === 'mage') {
        // Robe = the BAKED, fully-skinned KayKit robe, DYED to the item's
        // rarity (Obsidian 732, replacing the rigid procedural skirt/torso/
        // collar overlay that floated over the animating body): sleeves move
        // with the arms and the robe skirt with the legs because they ARE the
        // skinned body mesh. applyRobeTint repaints only the robe-cloth atlas
        // tiles, so skin/hair/leather/armor regions keep their own colors.
        const hot = fancy;
        applyRobeTint(mesh, RARITIES[it.rarity]?.color ?? 0x8a8a8a);
        // A drifting cloak-cape swatch off the back shoulders for elaborate robes.
        const robeMat = new THREE.MeshStandardMaterial({ color: m.color.clone(), metalness: 0.15, roughness: 0.55, emissive: hot ? m.color.clone() : 0x000000, emissiveIntensity: hot ? 0.16 : 0 });
        const waistY = 0.92, hemY = 0.3 + r * 0.04;
        if (fancy) {
          const drape = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 8, 1, true), robeMat);
          drape.position.set(0, waistY, -0.08); drape.rotation.x = Math.PI;
          grp.add(drape);
          sway.cloak.push({ obj: drape, baseRotZ: 0, baseRotX: drape.rotation.x, amp: 0.05 + r * 0.03 });
          // A few small drifting sparkle motes around the robe for Epic/Legendary.
          const sparkleColor = RARITIES[it.rarity].color;
          const sparkles = new THREE.Group();
          const n = it.rarity === 'legendary' ? 5 : 3;
          for (let i = 0; i < n; i++) {
            const sp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 5, 5), new THREE.MeshBasicMaterial({ color: sparkleColor }));
            const a = (i / n) * Math.PI * 2 + r * 6.28;
            sp.position.set(Math.cos(a) * (0.3 + r * 0.1), hemY + 0.15 + (i % 3) * 0.22, Math.sin(a) * (0.3 + r * 0.1));
            sp.userData.orbit = { a, speed: 0.6 + (i % 3) * 0.3, radius: 0.3 + r * 0.1, baseY: sp.position.y };
            sparkles.add(sp);
          }
          grp.add(sparkles);
          grp.userData.robeSparkles = sparkles;
        }
      } else if (classId === 'knight') {
        // Layered plate + tabard: pauldrons, a breastplate, and a cloth tabard
        // strip hanging over it (tabard length/width vary, sways faintly).
        const pL = new THREE.Mesh(new THREE.SphereGeometry(0.15 + r * 0.05, 8, 6), m); pL.position.set(-0.34, 1.02, 0); pL.scale.y = 0.7;
        const pR = pL.clone(); pR.position.x = 0.34;
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.4, 0.14), m); plate.position.set(0, 0.92, 0.24);
        const trim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.16), mat(it.rarity)); trim.position.set(0, 0.72 + r * 0.06, 0.24);
        grp.add(pL, pR, plate, trim);
        const tabardMat = new THREE.MeshStandardMaterial({ color: mat(it.rarity).color, metalness: 0.1, roughness: 0.7 });
        const tabard = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.34 + r2 * 0.14), tabardMat);
        tabard.position.set(0, 0.6, 0.32); grp.add(tabard);
        sway.hem.push({ obj: tabard, basePos: tabard.position.clone(), amp: 0.03 + r * 0.02, kind: 'plane' });
        if (fancy) { const gorget = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 10), mat(it.rarity)); gorget.rotation.x = Math.PI / 2; gorget.position.set(0, 1.18, 0.05); grp.add(gorget); }
      } else {
        // Ranger: leather jerkin + a swaying cloak (style varies collar/length).
        const style = r2 < 0.5 ? 'short' : 'long';
        const vestMat = new THREE.MeshStandardMaterial({ color: m.color.clone(), metalness: 0.1, roughness: 0.75 });
        const vest = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 8), vestMat); vest.position.set(0, 0.92, 0); grp.add(vest);
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.04), mat(it.rarity)); strap.position.set(0.14, 0.92, 0.2); strap.rotation.z = 0.3; grp.add(strap);
        const cloakLen = style === 'long' ? 0.75 + r * 0.2 : 0.42 + r * 0.15;
        const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.24, cloakLen, 8, 1, true), vestMat);
        cloak.position.set(0, 0.92 - cloakLen / 2 + 0.15, -0.14); cloak.rotation.x = Math.PI;
        grp.add(cloak);
        sway.cloak.push({ obj: cloak, baseRotZ: 0, baseRotX: cloak.rotation.x, amp: 0.06 + r * 0.04 });
        if (fancy) { const clasp = new THREE.Mesh(new THREE.OctahedronGeometry(0.04), mat(it.rarity)); clasp.position.set(0, 1.14, 0.18); grp.add(clasp); }
      }
    } else if (classId === 'mage') {
      // Chest slot emptied: restore the robe's own undyed cloth (732).
      applyRobeTint(mesh, null);
    }
    if (equipped.legs) {
      const m = mat(equipped.legs.rarity);
      for (const sx of [-0.12, 0.12]) { const greave = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.16), m); greave.position.set(sx, 0.42, 0.02); grp.add(greave); }
    }
    if (equipped.hands) {
      const m = mat(equipped.hands.rarity);
      for (const sx of [-0.36, 0.36]) { const gaunt = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.14), m); gaunt.position.set(sx, 0.86, 0.06); grp.add(gaunt); }
    }
    if (equipped.trinket) {
      const it = equipped.trinket, m = mat(it.rarity);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), m); gem.position.set(0, 1.14, 0.26); grp.add(gem);
      if (it.rarity === 'legendary' || it.rarity === 'epic') { const glow = new THREE.PointLight(RARITIES[it.rarity].color, 3, 2, 2); glow.position.set(0, 1.14, 0.3); grp.add(glow); }
    }
    // Offhand: the knight shows whichever baked shield variant was picked
    // above (activeShieldName) and just rarity-tints THAT real mesh; a mage
    // with a Tome/Grimoire/Codex offhand shows the baked Spellbook variant
    // (activeTomeName) the same way. Everything else with no matching baked
    // mesh (mage Orb/Focus Stone, ranger's Quiver/Talisman/etc — no baked
    // offhand prop exists for the ranger model at all) falls back to a small
    // procedural stand-in attached at a fixed off-hand local position — the
    // same static-offset approach used for the gauntlets/pauldrons above,
    // since this codebase doesn't do true bone-parented procedural attachments.
    const oh = equipped.offhand;
    const OFFHAND_POS = { x: -0.36, y: 0.86, z: 0.1 }; // off-hand side, mirrors the hands slot
    const tintBakedOffhand = (baked) => {
      if (!baked.userData.origMat) baked.userData.origMat = baked.material;
      if (oh) {
        baked.material = baked.userData.origMat.clone();
        const c = new THREE.Color(RARITIES[oh.rarity]?.color ?? 0x8a8a8a);
        const hot = oh.rarity === 'legendary' || oh.rarity === 'epic';
        baked.material.color.lerp(c, oh.rarity === 'common' ? 0.15 : 0.55);
        if (baked.material.emissive) {
          baked.material.emissive.copy(c);
          baked.material.emissiveIntensity = oh.rarity === 'legendary' ? 0.5 : oh.rarity === 'epic' ? 0.3 : oh.rarity === 'rare' ? 0.12 : 0;
        }
        if (hot) {
          const motes = new THREE.Group();
          const n = oh.rarity === 'legendary' ? 5 : 3;
          const mMat = new THREE.MeshBasicMaterial({ color: c });
          for (let i = 0; i < n; i++) {
            const sp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 5, 5), mMat);
            const a = (i / n) * Math.PI * 2;
            sp.position.set(-0.45 + Math.cos(a) * 0.16, 0.8 + Math.sin(a * 1.4) * 0.12, 0.1 + Math.sin(a) * 0.16);
            sp.userData.orbit = { a, speed: 0.7 + (i % 3) * 0.3, radius: 0.16, baseY: 0.8, cx: -0.45, cz: 0.1 };
            motes.add(sp);
          }
          grp.add(motes);
          grp.userData.offhandMotes = motes;
        }
      } else {
        baked.material = baked.userData.origMat;
      }
    };
    if (classId === 'knight' && activeShieldName) {
      tintBakedOffhand(variants[activeShieldName]);
    } else if (classId === 'mage' && activeTomeName) {
      tintBakedOffhand(variants[activeTomeName]);
    } else if (oh) {
      const m = mat(oh.rarity);
      let prop;
      if (classId === 'mage') {
        const cover = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.045), m);
        const pages = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.19, 0.03), new THREE.MeshStandardMaterial({ color: 0xe8dcb8, roughness: 0.9 }));
        pages.position.z = -0.005;
        prop = new THREE.Group(); prop.add(cover, pages);
        prop.rotation.x = -0.3;
      } else {
        prop = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.34, 8), m);
        prop.rotation.x = 0.2;
      }
      prop.position.set(OFFHAND_POS.x, OFFHAND_POS.y, OFFHAND_POS.z);
      grp.add(prop);
      if (oh.rarity === 'legendary' || oh.rarity === 'epic') {
        const glow = new THREE.PointLight(RARITIES[oh.rarity].color, 2.4, 1.6, 2);
        glow.position.copy(prop.position);
        grp.add(glow);
        const motes = new THREE.Group();
        const n = oh.rarity === 'legendary' ? 5 : 3;
        const mMat = new THREE.MeshBasicMaterial({ color: RARITIES[oh.rarity].color });
        for (let i = 0; i < n; i++) {
          const sp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 5, 5), mMat);
          const a = (i / n) * Math.PI * 2;
          sp.position.set(OFFHAND_POS.x + Math.cos(a) * 0.16, OFFHAND_POS.y + Math.sin(a * 1.4) * 0.12, OFFHAND_POS.z + Math.sin(a) * 0.16);
          sp.userData.orbit = { a, speed: 0.7 + (i % 3) * 0.3, radius: 0.16, baseY: OFFHAND_POS.y, cx: OFFHAND_POS.x, cz: OFFHAND_POS.z };
          motes.add(sp);
        }
        grp.add(motes);
        grp.userData.offhandMotes = motes;
      }
    }
    // The held weapon is skinned to the hand (animated), so we tint it in
    // place rather than replace it. Real swords are a metal blade + a wood-or-
    // leather hilt, never one flat tinted color - see splitWeaponMesh
    // (heroModel.js), which pre-splits each held weapon's baked mesh into a
    // grip/hilt triangle group (material slot 0) and a blade/head group
    // (material slot 1) by distance from the hand-bone pivot. The blade stays
    // genuinely metallic (high metalness/low roughness, reflecting the
    // scene's PMREM env - see envMapIntensity below) at every rarity; the
    // grip stays wood/leather. Rarity only layers a subtle accent on top:
    // rare = a cool blued-steel sheen on the blade, epic = a gold-encrusted
    // grip/pommel (the closest stand-in for "guard" this two-region split
    // affords) with a faint gold emissive edge, legendary = a full elemental
    // identity (flame/frost - WEAPON_ELEMENTS in loot.js) with emissive edges
    // on blade AND grip plus a few drifting ember/frost motes (same cheap
    // orbiting-mote pattern as the offhand rarity motes above). A weapon mesh
    // that couldn't be split (no index buffer / degenerate geometry) falls
    // back to a single steel material carrying the same accent - it never
    // becomes a flat rarity-colored blob either way.
    // Built once per hero mesh, across EVERY weapon-shaped mesh the class's GLB
    // ships (not just the currently-visible variant) - since updateHeroGear
    // now toggles visibility between several real weapon variants (see
    // activeWeaponName above), a cache scoped to only the mesh that happened
    // to be visible on the FIRST call would go stale the moment a different
    // variant is shown. Tinting the hidden variants too is free (they don't
    // render) and keeps every variant ready to look correct the instant it
    // becomes visible.
    if (!mesh.userData.weaponMats) {
      mesh.userData.weaponMats = [];
      mesh.traverse((o) => {
        if (o.isMesh && /Sword|Staff|Wand|Crossbow|Knife|Bow|Axe|Hammer|Mace|Dagger|Spear/i.test(o.name)) {
          const split = Array.isArray(o.geometry?.groups) && o.geometry.groups.length === 2 && o.geometry.userData?.weaponSplit;
          const bladeMat = new THREE.MeshStandardMaterial({ metalness: 0.95, roughness: 0.22, envMapIntensity: 0.55 });
          if (split) {
            const gripMat = new THREE.MeshStandardMaterial({ metalness: 0.05, roughness: 0.85 });
            o.material = [gripMat, bladeMat];
            mesh.userData.weaponMats.push({ blade: bladeMat, grip: gripMat });
          } else {
            o.material = bladeMat;
            mesh.userData.weaponMats.push({ blade: bladeMat, grip: null });
          }
        }
      });
    }
    const wItem = equipped.weapon;
    const wr = wItem?.rarity;
    const element = wr === 'legendary' && wItem.element ? WEAPON_ELEMENTS[wItem.element] : null;
    const STEEL = new THREE.Color(0xaeb4bc);
    const WOOD = new THREE.Color(0x5a3d22);
    const BLADE_SHEEN = { rare: 0x8fa8c2, epic: 0xc9b568 };
    for (const w of mesh.userData.weaponMats) {
      let bladeColor = STEEL, bladeEmissive = 0x000000, bladeEmissiveI = 0;
      if (element) { bladeColor = STEEL.clone().lerp(new THREE.Color(element.color), 0.45); bladeEmissive = element.color; bladeEmissiveI = 0.55; }
      else if (BLADE_SHEEN[wr]) { bladeColor = STEEL.clone().lerp(new THREE.Color(BLADE_SHEEN[wr]), 0.35); }
      w.blade.color.copy(bladeColor);
      w.blade.emissive.set(bladeEmissive);
      w.blade.emissiveIntensity = bladeEmissiveI;
      if (w.grip) {
        let gripColor = WOOD, gripEmissive = 0x000000, gripEmissiveI = 0;
        if (element) { gripColor = WOOD.clone().lerp(new THREE.Color(element.color), 0.3); gripEmissive = element.color; gripEmissiveI = 0.3; }
        else if (wr === 'epic') { gripColor = WOOD.clone().lerp(new THREE.Color(0xc9a227), 0.55); gripEmissive = 0xc9a227; gripEmissiveI = 0.16; }
        w.grip.color.copy(gripColor);
        w.grip.emissive.set(gripEmissive);
        w.grip.emissiveIntensity = gripEmissiveI;
      }
    }
    if (element) {
      // Approximate main-hand position (mirrors OFFHAND_POS above) - the
      // weapon mesh itself is bone-skinned mid-swing, so like the offhand
      // motes these sit at a fixed rest-hand spot rather than truly tracking
      // the blade through the swing animation.
      const WEAPON_POS = { x: 0.36, y: 0.86, z: 0.1 };
      const motes = new THREE.Group();
      const mMat = new THREE.MeshBasicMaterial({ color: element.particleColor });
      const n = 5;
      for (let i = 0; i < n; i++) {
        const sp = new THREE.Mesh(new THREE.SphereGeometry(0.02, 5, 5), mMat);
        const a = (i / n) * Math.PI * 2;
        sp.userData.orbit = { a, speed: 0.9 + (i % 3) * 0.4, radius: 0.05 + (i % 2) * 0.03, baseY: WEAPON_POS.y + (i % 3) * 0.06, cx: WEAPON_POS.x, cz: WEAPON_POS.z };
        motes.add(sp);
      }
      grp.add(motes);
      grp.userData.weaponMotes = motes;
      const glow = new THREE.PointLight(element.color, 1.6, 1.2, 2);
      glow.position.set(WEAPON_POS.x, WEAPON_POS.y, WEAPON_POS.z);
      grp.add(glow);
    }
    mesh.add(grp);
    // Ride the body animation (Obsidian 725): root-parented gear sat frozen
    // while the skinned body bobbed through the walk cycle - the mage robe's
    // waist band was the visible offender. attach() preserves the world
    // placement, so all the rig-space positions above stay correct.
    anchorToBodyBone(mesh, grp);
    mesh.userData.gearVisual = grp;
    // Hand the collected hat-tip/hem/cloak refs to the per-frame sway animator
    // (see animateGearSway). Discarded and rebuilt whenever gear changes.
    mesh.userData.gearSway = sway;
  }

  // Keep the local hero's aura in sync, spin sparkles, and fly the companion.
  animateAuras(dt) {
    if (this.player?.mesh) { this.setHeroAura(this.player.mesh, this.heroAuraTier()); this.updateHeroGear(this.player.mesh, this.player.equipped, this.player.classId); }
    for (const [, rp] of this.remotePlayers) if (rp.loadout) this.updateHeroGear(rp.mesh, rp.loadout, rp.cls);
    this._auraT = (this._auraT || 0) + dt;
    const t = this._auraT;
    const anim = (mesh) => {
      const g = mesh?.userData?.auraGroup;
      if (!g) return;
      // Per-mote drift + continuous fade in/out. Each mote advances its own
      // angle at its own (signed) speed, bobs on its own sine, and runs an
      // independent life clock: opacity ramps up over the first fifth of its
      // life and back down over the last fifth, and when a life ends the mote
      // respawns with fresh random orbit/size (via the stashed spawnMote), so
      // the swarm keeps churning instead of spinning as one rigid group.
      const spawnMote = g.userData.spawnMote;
      for (const m of g.userData.sparkles.children) {
        const o = m.userData.orbit;
        if (!o) continue;
        o.age += dt;
        if (o.age >= o.life && spawnMote) { spawnMote(m); continue; }
        o.angle += dt * o.speed;
        const x = Math.cos(o.angle) * o.radius;
        const z = Math.sin(o.angle) * o.radius;
        const y = o.baseY + Math.sin(o.age * 2.2 + o.angle) * o.bob + z * o.tilt;
        m.position.set(x, y, z);
        m.scale.setScalar(o.size);
        // Trapezoidal fade: in over first 20%, hold, out over last 20%.
        const f = o.age / o.life;
        const fade = f < 0.2 ? f / 0.2 : f > 0.8 ? (1 - f) / 0.2 : 1;
        m.material.opacity = Math.max(0, Math.min(1, fade)) * 0.9;
      }
      const c = g.userData.companion;
      if (c) {
        c.position.set(Math.cos(t * 1.6) * 0.85, 1.55 + Math.sin(t * 3) * 0.18, Math.sin(t * 1.6) * 0.85);
        c.rotation.y = -t * 1.6 + Math.PI / 2;
        const flap = 0.5 + Math.sin(t * 22) * 0.5;
        c.userData.wings[0].rotation.y = flap;
        c.userData.wings[1].rotation.y = -flap;
      }
    };
    anim(this.player?.mesh);
    for (const [, rp] of this.remotePlayers) anim(rp.mesh);
    this.animateGearSway(this.player?.mesh, dt, t);
    for (const [, rp] of this.remotePlayers) this.animateGearSway(rp.mesh, dt, t);
  }

  // Subtle secondary motion on equipped-gear cosmetics: wizard-hat tips, robe
  // hems, and cloaks sway as if in a light wind (sine idle motion) and swing
  // extra when the hero turns (driven by the mesh's actual per-frame turn
  // rate). This never touches the skeleton/animation mixer, so it layers on
  // top of the base walk/idle/attack clips instead of fighting them.
  animateGearSway(mesh, dt, t) {
    const sway = mesh?.userData?.gearSway;
    if (!sway) return;
    // Turn-rate from the hero root's actual rotation delta this frame (rad/s),
    // shortest-path-wrapped so a spin near +-PI doesn't spike. Reused for hat,
    // hem and cloak alike so they all swing together on a turn.
    const prevY = mesh.userData._swayPrevRotY ?? mesh.rotation.y;
    let dRot = mesh.rotation.y - prevY;
    while (dRot > Math.PI) dRot -= Math.PI * 2;
    while (dRot < -Math.PI) dRot += Math.PI * 2;
    const turnRate = dt > 0 ? dRot / dt : 0;
    mesh.userData._swayPrevRotY = mesh.rotation.y;
    const wind = Math.sin(t * 2.1) * 0.6 + Math.sin(t * 3.7 + 1.3) * 0.4; // -1..1 breeze
    const turnKick = Math.max(-1.4, Math.min(1.4, turnRate * 0.12)); // clamp so a fast spin doesn't fling gear
    if (sway.hat) {
      const h = sway.hat;
      const swing = wind * h.amp + turnKick * h.amp * 0.8;
      if (h.axis === 'x') {
        h.obj.rotation.x = h.baseX + swing;
      } else if (h.pivot) { // curled-tip style: orbit the tip sphere around its base cone
        h.obj.position.x = h.basePos.x + swing;
        h.obj.position.z = h.basePos.z + Math.abs(swing) * 0.3;
      } else {
        h.obj.rotation.z = h.baseZ + swing;
        h.obj.rotation.x = (h.baseX || 0) + swing * 0.4;
      }
    }
    for (const hem of sway.hem) {
      const swing = wind * hem.amp + turnKick * hem.amp * 0.9;
      if (hem.kind === 'ring') {
        hem.obj.position.x = hem.basePos.x + swing;
        hem.obj.position.z = hem.basePos.z + swing * 0.5;
        hem.obj.rotation.z = swing * 0.5;
      } else { // plane (tabard): flap around its top edge
        hem.obj.rotation.x = swing * 0.6;
        hem.obj.position.x = hem.basePos.x + swing * 0.3;
      }
    }
    for (const cl of sway.cloak) {
      const swing = wind * cl.amp + turnKick * cl.amp;
      cl.obj.rotation.x = cl.baseRotX + swing * 0.5;
      cl.obj.rotation.z = cl.baseRotZ + swing;
    }
    // Robe sparkle motes: slow independent orbit + bob, Epic/Legendary mage chest only.
    const sparkles = mesh.userData.gearVisual?.userData?.robeSparkles;
    if (sparkles) {
      for (const sp of sparkles.children) {
        const o = sp.userData.orbit;
        if (!o) continue;
        const a = o.a + t * o.speed;
        sp.position.set(Math.cos(a) * o.radius, o.baseY + Math.sin(t * 1.4 + o.a) * 0.05, Math.sin(a) * o.radius);
      }
    }
    // Offhand rarity mote cosmetic (Epic/Legendary only) — same slow orbit/bob,
    // centered on the shield (knight) or procedural prop (mage/ranger).
    const ohMotes = mesh.userData.gearVisual?.userData?.offhandMotes;
    if (ohMotes) {
      for (const sp of ohMotes.children) {
        const o = sp.userData.orbit;
        if (!o) continue;
        const a = o.a + t * o.speed;
        sp.position.set(o.cx + Math.cos(a) * o.radius, o.baseY + Math.sin(t * 1.4 + o.a) * 0.05, o.cz + Math.sin(a) * o.radius);
      }
    }
    // Legendary weapon elemental motes (flame/frost) - same slow orbit/bob,
    // centered on the approximate main-hand position (see updateHeroGear).
    const wpnMotes = mesh.userData.gearVisual?.userData?.weaponMotes;
    if (wpnMotes) {
      for (const sp of wpnMotes.children) {
        const o = sp.userData.orbit;
        if (!o) continue;
        const a = o.a + t * o.speed;
        sp.position.set(o.cx + Math.cos(a) * o.radius, o.baseY + Math.sin(t * 1.4 + o.a) * 0.05, o.cz + Math.sin(a) * o.radius);
      }
    }
  }

  // A compact snapshot of the equipped gear, for co-op inspect panels.
  compactLoadout() {
    const out = {};
    for (const slot of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket', 'offhand']) {
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

  ensureRemotePlayer(id, cls = 'knight', name = null, appearance = null) {
    let rp = this.remotePlayers.get(id);
    if (rp) {
      if (name && rp.name !== name) { rp.name = name; this.updateNametag(rp, false); }
      return rp;
    }
    // thread the peer's name AND their creation choices (gender + skin tone +
    // hair color + eye color + face shape + hair style) so the hero we render
    // for them matches what they see on their own screen.
    const opts = {
      gender: appearance?.gender, skinTone: appearance?.skinTone, hairColor: appearance?.hairColor || null,
      eyeColor: appearance?.eyeColor || 'brown', faceShape: appearance?.faceShape || 'standard',
      hairStyle: appearance?.hairStyle || 'short',
    };
    const anim = buildAnimatedHero(cls, name || 'Hero', opts);
    const mesh = anim ? anim.mesh : buildHeroMesh(CLASSES[cls] || CLASSES.knight, name || 'Hero');
    this.scene.add(mesh);
    rp = {
      mesh, anim, cls, name: name || 'Hero', gender: opts.gender || 'male', skinTone: opts.skinTone || 'light',
      hairColor: opts.hairColor || null, eyeColor: opts.eyeColor, faceShape: opts.faceShape, hairStyle: opts.hairStyle,
      target: new THREE.Vector3(), aim: 0, moving: false, dead: false, away: false, level: 1, hp: 0, maxHp: 0,
    };
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

  // Cosmetic floor height sampler: single source of truth for how high a
  // walker's feet should sit at a given world (x, z). Nearest-tile lookup
  // into dungeon.heights (seeded daises/sunken patches in dungeon.js, or the
  // town flagstone plaza) -- entities ease their pos.y toward this over time
  // (see Player.update / Enemy.update), which is what gives the actual smooth
  // rise/fall as they cross a tile boundary; the sampler itself stays a cheap
  // step lookup. Returns 0 (unraised) for boss floors / out-of-range tiles,
  // which have no heights field.
  heightAt(x, z) {
    const h = this.dungeon?.heights;
    if (!h) return 0;
    const tx = Math.floor(x / TILE), ty = Math.floor(z / TILE);
    return h[ty]?.[tx] ?? 0;
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

  // Teleport a trapped hero to the nearest genuinely open spot: spiral outward
  // tile by tile and take the first centre that is walkable with clearance.
  unstickPlayer() {
    const p = this.player;
    for (let r = 1; r <= 8; r++) {
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue; // ring only
          const x = p.pos.x + ox * TILE, z = p.pos.z + oz * TILE;
          if (!this.isWalkable(x, z, 0.35)) continue;
          p.pos.set(x, 0, z);
          // Plain wording (874): the old 'Freed from the stone' read as a
          // status effect that doesn't exist and confused players when it fired.
          this.ui.floaters?.spawn(p.pos, 'Pulled you free', 'crit');
          audio.play('blink', { volume: 0.5 });
          return true;
        }
      }
    }
    return false;
  }

  // ---------------- combat API ----------------
  // Is the local hero mid-swing / holding attack? Enemies use this to juke.
  playerIsAttacking() { return !!(this.player && (this.player.aiming || this.player.attackAnim > 0.05)); }

  // Point the player's aim (aimAngle/aimDir) at the nearest living enemy.
  // The single source of aim-assist for a TAP on any corner-cluster action
  // button (tap = auto-aim nearest, see clusterTap). Returns the chosen
  // enemy, or null if none is in range.
  aimAtNearestEnemy(p, maxDist = 9) {
    let best = null, bestD = maxDist;
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
    return best;
  }

  // Point the player's aim along an explicit world-space direction. Used when
  // a cluster button is HELD-and-SWIPED: the ability fires the way the thumb
  // dragged, not at the nearest enemy. dx/dz need not be normalized.
  aimInDirection(p, dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    p.aimAngle = Math.atan2(dz, dx);
    p.aimDir.x = dx / len;
    p.aimDir.z = dz / len;
  }

  // ---- corner action cluster: cast routing ----
  // TAP on a cluster button: auto-aim the nearest enemy, then fire through the
  // SAME code path the keys/hotbar use. slot -1 is the big basic-attack button.
  // Ability taps search a RANGED radius (Obsidian 733: a clicked Fireball must
  // auto-aim without a drag - the old 9-unit default was melee reach, so any
  // farther enemy left the shot flying wherever the cursor last pointed);
  // the basic-attack button keeps the tighter melee-scale assist.
  clusterTap(slot) {
    const p = this.player;
    if (!p || this.inTown || this.state !== 'playing') return;
    this.aimAtNearestEnemy(p, slot >= 0 ? 22 : 9);
    p.faceAimTimer = Math.max(p.faceAimTimer, 0.25);
    if (slot < 0) { p.tryBasicAttack(this); this.touch?._advanceTut?.('attack'); }
    else p.tryAbility(slot, this);
  }

  // HELD-SWIPE release on a cluster button: aim along the drag direction (world
  // space), then fire through the same code path. dirX/dirZ come from the drag
  // vector already rotated into world axes by the UI.
  clusterSwipe(slot, dirX, dirZ) {
    const p = this.player;
    if (!p || this.inTown || this.state !== 'playing') return;
    this.aimInDirection(p, dirX, dirZ);
    p.faceAimTimer = Math.max(p.faceAimTimer, 0.25);
    if (slot < 0) { p.tryBasicAttack(this); this.touch?._advanceTut?.('attack'); }
    else p.tryAbility(slot, this);
  }

  // A screen-space drag vector (px) rotated into the world ground plane, so a
  // swipe "up the screen" always casts away from the camera regardless of the
  // current orbit yaw - matching how movement input is rotated. Screen up =
  // world -z. Returns a normalized {x, z} (or null for a tiny drag).
  dragToWorldDir(dxPx, dyPx) {
    const len = Math.hypot(dxPx, dyPx);
    if (len < 1e-3) return null;
    const sx = dxPx / len, sy = dyPx / len; // screen right / down
    const cy = Math.cos(this.camYaw || 0), sYaw = Math.sin(this.camYaw || 0);
    // mirror the movement mapping: screen (right, up) -> world axes
    return { x: sx * cy + sy * sYaw, z: -sx * sYaw + sy * cy };
  }

  // ---- directional aim indicator (a ground arrow the player drags to aim) ----
  _buildAimIndicator() {
    const g = new THREE.Group();
    const goldMat = new THREE.MeshBasicMaterial({
      color: 0xe8c05a, transparent: true, opacity: 0.72,
      depthWrite: false, side: THREE.DoubleSide,
    });
    // One flat arrow (shaft + head) as a SINGLE shape authored in the XY plane
    // pointing +x, laid onto the ground by one -90deg X rotation. The group's
    // yaw is then the ONLY orientation ever applied, so the arrow stays a
    // clean straight line on the XZ plane - no skew, no per-part rotations
    // that can disagree (the old two-mesh build's triangle head did).
    const s = new THREE.Shape();
    s.moveTo(0.65, -0.17);
    s.lineTo(3.25, -0.17);
    s.lineTo(3.25, -0.55);
    s.lineTo(4.35, 0);      // tip
    s.lineTo(3.25, 0.55);
    s.lineTo(3.25, 0.17);
    s.lineTo(0.65, 0.17);
    s.closePath();
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(s), goldMat);
    arrow.rotation.x = -Math.PI / 2; // XY shape -> flat on the XZ ground plane
    arrow.position.y = 0.06;
    g.add(arrow);
    g.visible = false;
    this.aimIndicator = g;
    this.aimIndicatorMat = goldMat;
    this._aimIndicatorActive = false;
    this.scene.add(g);
  }

  // Called by the UI while a cluster button is held-and-swiped. dirX/dirZ is the
  // live world-space drag direction. Shows and orients the ground arrow at the
  // player. Passing null hides it.
  setAimIndicator(dir) {
    this._aimIndicatorDir = dir;
    this._aimIndicatorActive = !!dir;
    // Wild Rift feel: the hero turns to face the drag live while aiming.
    // player.js honors aimOverride in its facing block; release clears it and
    // normal facing rules resume.
    if (this.player) this.player.aimOverride = dir ? Math.atan2(dir.z, dir.x) : null;
  }

  updateAimIndicator() {
    const g = this.aimIndicator;
    if (!g) return;
    const active = this._aimIndicatorActive && this.player && !this.inTown;
    g.visible = active;
    if (!active) return;
    const p = this.player;
    g.position.set(p.pos.x, p.pos.y, p.pos.z);
    const d = this._aimIndicatorDir;
    g.rotation.y = -Math.atan2(d.z, d.x); // three-space yaw for a +x-facing arrow
    // gentle pulse so it reads as "aiming, not fired yet"
    this.aimIndicatorMat.opacity = 0.55 + 0.2 * Math.sin(performance.now() / 120);
  }

  // `variation` (optional) is the current combo-cycle entry from classes.js's
  // basic.variations — carries this swing's range/arc/dmgMult so left/right
  // slices, the overhead chop and the lunging stab each hit a slightly
  // different shape instead of one identical swing every time.
  // A legendary weapon's element rides along on the wielder's own basic
  // attacks (melee here, ranged/bolt in spawnProjectile below) - modest
  // magnitudes so a legendary feels special without breaking balance: burn
  // ticks for ~30% of the hit's base damage over 2s, frost slows to half
  // speed for 1.5s. Old-save legendaries without an `element` (see loot.js
  // makeLegendary) simply produce no status, same as any mundane weapon.
  weaponElementStatus(player) {
    const el = player.equipped?.weapon?.element;
    if (!el) return null;
    if (el === 'flame') return { burn: { dps: Math.max(1, player.damage * 0.3), duration: 2 } };
    if (el === 'frost') return { slow: { mult: 0.5, duration: 1.5 } };
    return null;
  }

  meleeAttack(player, basic, variation) {
    const range = variation?.range ?? basic.range;
    const arc = variation?.arc ?? basic.arc;
    const dmgMult = variation?.dmgMult ?? 1;
    const status = this.weaponElementStatus(player);
    let hitAny = false;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range + e.radius) continue;
      const angleTo = Math.atan2(dz, dx);
      let diff = angleTo - player.aimAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < arc / 2) {
        this.damageEnemy(e, player.damage * dmgMult, { knockback: 3, kbFrom: player.pos, status });
        learner.recordPlayerHit(dist); // learn your engagement range
        hitAny = true;
      }
    }
    const hitX = player.pos.x + (player.aimDir?.x || 0) * range;
    const hitZ = player.pos.z + (player.aimDir?.z || 0) * range;
    if (hitAny) audio.play(basic.hitSound);
    else if (!this.isWalkable(hitX, hitZ, 0.1)) {
      // a whiffed swing that lands on stone strikes sparks and chips the wall
      this.wallDebris(hitX, hitZ, { dirX: player.aimDir?.x, dirZ: player.aimDir?.z, tint: 0xffd27a });
      this.particles.burst(hitX, 1.0, hitZ, 5, 0xffd27a, { speed: 3.2, life: 0.24, size: 0.07 });
      audio.play('shield_block', { pos: { x: hitX, z: hitZ }, volume: 0.32, rate: 1.4 });
    }
    // a swing also smashes any container it sweeps through
    this.breakNear(hitX, hitZ, 1.0);
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
      // Modest break-loot: mostly a little gold, sometimes a potion, rarely a
      // common item — barrels/crates are minor clutter, not chests.
      if (Math.random() < 0.4) this.loot.dropGold(b.x, b.z, 2 + Math.floor(Math.random() * 6));
      if (Math.random() < 0.10) this.loot.dropPotion(b.x + 0.4, b.z);
      if (Math.random() < 0.05) this.loot.dropGear(b.x - 0.4, b.z, generateGear(this.floor, 'common', this.player.classId));
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
    this._lastCombatT = performance.now(); // learner trains only near real combat
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
    // Major-blow taunt: a big chunk out of an elite/boss provokes a reaction.
    if (e.hp > 0 && (e.elite || e.isBoss) && e.maxHp > 0) {
      roaster.onBigHit(this, { dealt: dmg / e.maxHp, enemy: e });
    }
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

  // Death VFX by material (Obsidian 757): fleshy things spray blood + gibs and
  // leave a pool on the floor; undead throw bone chips; constructs shed stone
  // rubble; wraiths just dissipate. Bosses are classified by act (their def is
  // always 'golem' via the Boss ctor). Pools use the shared, capped, fading
  // wall-mark decal pool so they can't leak draw calls or RAM.
  goreDeath(e) {
    const bossGore = [null, 'bone', 'ichor', 'blood', 'stone', 'blood'];
    const profile = e.isBoss ? (bossGore[e.act] || 'blood') : (e.def.gore || 'blood');
    const x = e.pos.x, z = e.pos.z;
    const big = e.isBoss || e.miniboss ? 1.8 : e.elite ? 1.3 : 1;
    const pool = (color, size, opacity, n = 1) => {
      for (let i = 0; i < n; i++) {
        const ox = i === 0 ? 0 : (Math.random() - 0.5) * size * 1.6;
        const oz = i === 0 ? 0 : (Math.random() - 0.5) * size * 1.6;
        this.addWallMark(x + ox, z + oz, {
          size: (i === 0 ? size : size * 0.55) * (0.85 + Math.random() * 0.35),
          opacity: i === 0 ? opacity : opacity * 0.7, color, fadeAfter: 50,
        });
      }
    };
    if (profile === 'blood') {
      // Way gorier (757): a heavy gib burst + a wide multi-blob blood pool that
      // reads clearly on the floor and lingers.
      this.particles.gore(x, 0.8, z, { count: Math.round(46 * big) });
      pool(0x9c1414, 0.9 * big, 0.82, e.isBoss ? 9 : 6); // bright, wet, splattered
    } else if (profile === 'ichor') {
      this.particles.gore(x, 0.8, z, { count: Math.round(38 * big), spray: 0x5a7a1a, chunk: 0x38520f, emissive: 0x0a1a00, emissiveIntensity: 0.4 });
      pool(0x3a5210, 0.78 * big, 0.7, 5);
    } else if (profile === 'bone') {
      this.particles.gore(x, 0.8, z, { count: Math.round(18 * big), spray: 0xf0ece0, chunk: 0xc8c2b0, life: 0.6, up: 0.8, emissive: 0x1a1815, emissiveIntensity: 0.35 });
      // faint pale dust smear, no wet pool
      this.addWallMark(x, z, { size: 0.42 * big, opacity: 0.24, color: 0x9a9488, fadeAfter: 14 });
    } else if (profile === 'stone') {
      this.particles.gore(x, 0.8, z, { count: Math.round(20 * big), spray: 0x9a9aa4, chunk: 0x606069, life: 0.65, up: 0.7, emissive: 0x101014, emissiveIntensity: 0.3 });
      this.addWallMark(x, z, { size: 0.52 * big, opacity: 0.3, color: 0x52525a, fadeAfter: 16 });
    } else { // ether: wispy cool dissipation, incorporeal — no floor pool
      this.particles.burst(x, 0.9, z, Math.round(22 * big), e.def.color, { speed: 3, life: 0.75, up: 1.5 });
    }
  }

  killEnemy(e) {
    e.dead = true;
    this.kills++;
    this.floorKills++;
    // Event-driven learning (Obsidian 724): one quick training burst per
    // kill instead of a background every-6s timer - see learner.worker.js.
    learner.notifyEnemyDeath();
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
      this.ui.showFloorBanner('The stairs have opened', 'The way below is unsealed', true);
      this.setStairsGlow(false);
      if (net.isHost) net.send({ t: 'notice', txt: '⛓️ The seal breaks — the stairs open!' });
    }
    // Pitch/gain-varied death scream so repeated kills of a type sound different.
    audio.deathScream(e.def.sounds.death, { pos: e.pos, volume: 0.85 });
    // A speaking elite/boss goes silent AT ONCE when it dies (cut in-flight TTS).
    if (e.elite || e.miniboss || e.isBoss) roaster.stopSpeaking();
    this.goreDeath(e); // blood + guts (or bone/stone/ether) burst + a floor pool (757)
    e.mesh.userData.detached = true; // no-ops any still-in-flight GLB swap (enemyModel.js)
    this.scene.remove(e.mesh);

    this.player.gainXp(e.xp, this);
    // Offhand kill-heal proc: a small heal each kill (see player.js recompute).
    if (this.player.killHealPct) this.player.heal(Math.round(this.player.maxHp * this.player.killHealPct), this);
    this.rollDeathLoot(e.pos.x, e.pos.z, { miniboss: e.miniboss, isBoss: e.isBoss, elite: e.elite, goldRange: e.goldRange });

    // In co-op every hero gets full XP and rolls their own personal loot.
    if (net.isHost) {
      net.send({ t: 'edead', id: e.netId, x: e.pos.x, z: e.pos.z, xp: e.xp, mb: e.miniboss, el: !!e.elite, boss: !!e.isBoss });
    }

    if (e.isBoss) {
      this.actsCleared = Math.max(this.actsCleared, this.currentAct());
      if (this.currentAct() < 5 && this.floor <= MAX_FLOOR) {
        // act cleared: open the way down to the next act
        this.spawnActExit(e.pos.x, e.pos.z);
        this.ui.showFloorBanner(`ACT ${ROMAN[this.currentAct()]} CLEARED`, 'The way deeper opens…', true);
        this.showQuestCompleteToast(this.currentAct());
        audio.play('level_up');
        this._bossMusicOn = false;
        audio.playMusic(audio.dungeonTrack(this.currentAct()), 2);
      } else {
        this.onVictory();
      }
    }
    // Full clear: every spawn on this floor is down (boss included), so record
    // it and never respawn the horde here again, even across exit/resume.
    // Host authority in mp (guests only mirror); partial clears are NOT
    // persisted, and endless floors (51+) always respawn for the infinite grind.
    if ((!net.active || net.isHost) && !this.inTown && this.floor <= MAX_FLOOR
        && this.enemies.every((en) => en.dead)) {
      this.clearedFloors[this.floor] = true;
    }
    this.requestSave();
  }

  // Crossfade to the act lord's own battle music the moment it wakes. Hosts
  // and solo players read the boss AI state directly; guests run mirror
  // stand-ins whose state field is meaningless, so they infer the wake-up
  // from first blood or proximity (the lords' aggro range is 9 to 12).
  // The fade back down happens where the boss actually dies (killEnemy,
  // the guest 'edead' handler, and onVictory), never here.
  updateBossMusic() {
    if (this._bossMusicOn || this.inTown) return;
    const b = this.boss;
    if (!b || b.dead) return;
    const aggro = b.mirror
      ? (b.hp < b.maxHp || Math.hypot(this.player.pos.x - b.pos.x, this.player.pos.z - b.pos.z) < 13)
      : b.state !== 'idle';
    if (!aggro) return;
    this._bossMusicOn = true;
    audio.playMusic(audio.bossTrack(this.currentAct()), 1.2);
  }

  // Quest-complete toast for a slain act boss, delayed until the big
  // "ACT X CLEARED" banner (2.7s) has faded so the two never stack.
  showQuestCompleteToast(act) {
    const title = `${ACT_BOSSES[act].name} slain`;
    const reward = this.actBossRewardText(act);
    setTimeout(() => this.ui.showQuestComplete(title, reward), 2800);
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
      // smart loot: bias the roll by MY equipped slots (personal per player)
      this.loot.dropGear(x, z + 0.5, generateGear(this.floor, rarity, this.player.classId, { equipped: this.player.equipped, elite: opts.elite }));
    }
    // The pinnacle EPIC is earned in a fight: the Dungeon Lord and minibosses
    // drop it meaningfully, and ANY kill has a ~0.001% shot at one. Act boss
    // legendaries carry a 12% perfect-roll shot (~4.2% of boss kills).
    if ((opts.isBoss && Math.random() < 0.35) || (opts.miniboss && Math.random() < 0.05)) {
      this.loot.dropGear(x + 0.8, z - 0.5, dropLegendary(this.floor, opts.isBoss ? { perfectChance: 0.12 } : {}));
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
      learner.recordPlayerHit(Math.hypot(x - this.player.pos.x, z - this.player.pos.z));
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
    if (target.local) {
      this._lastCombatT = performance.now(); // learner trains only near real combat
      this.player.takeDamage(dmg, this);
      // A big hit on the local hero provokes a taunt from a nearby elite/boss.
      if (!this.player.dead && this.player.maxHp > 0) roaster.onBigHit(this, { taken: dmg / this.player.maxHp });
    } else net.send({ t: 'ehit', dmg: Math.round(dmg) }, target.id);
  }

  // AoE enemy attacks (golem slam) hit every hero in range.
  aoeHitPlayers(x, z, radius, dmg) {
    if (!this.player.dead && Math.hypot(this.player.pos.x - x, this.player.pos.z - z) < radius) {
      this.player.takeDamage(dmg, this);
      // A big AoE hit on the local hero provokes a taunt from a nearby elite/boss.
      if (!this.player.dead && this.player.maxHp > 0) roaster.onBigHit(this, { taken: dmg / this.player.maxHp });
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
    // A legendary weapon's element rides along on any friendly projectile that
    // doesn't already carry its own status - this is what makes the ranged/
    // bolt basic attack (player.js tryBasicAttack, which has no status param
    // of its own) apply burn/slow on hit, same as meleeAttack above. Ability
    // shots that roll their own status (Fireball's burn, Frost Nova's slow)
    // are untouched since they already set opts.status.
    if (opts.friendly && !opts.status && this.player) {
      const st = this.weaponElementStatus(this.player);
      if (st) opts = { ...opts, status: st };
    }
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
    // AoE locks its targets at CAST (Obsidian 774): whoever stands in the
    // telegraph when it's placed is committed - the ML-juking bats used to
    // scatter during the windup delay and "dodge" the mage's AoE entirely.
    const locked = opts.friendly
      ? this.enemies.filter((e) => !e.dead && Math.hypot(e.pos.x - opts.x, e.pos.z - opts.z) < opts.radius + e.radius)
      : null;
    this.zones.push({ ...opts, mesh, t: opts.duration, delay: opts.delay || 0, tickT: 0, _locked: locked });
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
      inDungeon: !this.inTown, // were we mid-dungeon (vs town/tavern) when saved?
      inTavern: !!this.inTavern, // resume back INTO the tavern, not just town (791)
      // Exact position (Obsidian 791): floors/town are deterministically seeded
      // from the slot id, so storing where the hero stood lets a refresh drop
      // them back on the identical layout at the very same spot.
      px: this.player.pos.x, pz: this.player.pos.z,
      kills: this.kills,
      deaths: this.deaths,
      bossDefeated: this.bossDefeated,
      actsCleared: this.actsCleared,
      elitesKilled: this.elitesKilled,
      storySeen: this.storySeen,
      vendorMemory: this.vendorMemory,
      clearedFloors: this.clearedFloors, // { floor: true } full clears only
      rosalindMet: !!this._rosalindMet, // she only ever walks up to you ONCE (828)
      usedBanter: (this._usedBanter || []).slice(-30), // the room never repeats itself (781)
      npcMem: this._npcMem || null, // what the regulars know about each other + the player (884)
    });
  }

  saveSettings() { SaveManager.saveSettings(this.settings); }

  // Push all mixer channels to their consumers.
  applyAudioSettings() {
    const s = this.settings;
    audio.setVolume('master', s.masterVolume);
    audio.setVolume('music', s.musicVolume);
    audio.setVolume('sfx', s.sfxVolume);
    // Speech scales by MASTER too: Web Speech goes through the OS voice
    // engine and Kokoro through its own context, so neither inherits the
    // master gain - muting the game must actually silence the voices.
    const speechVol = (s.speechVolume ?? 1) * (s.masterVolume ?? 1);
    roaster.volume = speechVol;
    import('./ai/neuralVoice.js').then(({ neuralVoice }) => { neuralVoice.volume = speechVol; }).catch(() => {});
    voice.setOutputVolume(s.voiceChatVolume);
  }

  applyQuality() {
    const q = this.settings.quality;
    const ratio = { low: 0.75, medium: 1, high: Math.min(window.devicePixelRatio, 2) }[q] || 1;
    this.renderer.setPixelRatio(ratio);
  }

  // Derives the vertical FOV so that this.baseFov is held constant along
  // the screen's SHORTER dimension (min-dimension scaling): in portrait
  // that's the width, so vFov is widened to compensate; in landscape (or
  // square) the shorter dimension is already the height, so vFov stays at
  // baseFov. This keeps the world reading at the same scale whichever way
  // the device is held, since a plain aspect-only update leaves the
  // vertical FOV fixed and lets the visible world grow/shrink with aspect.
  _applyFovForAspect(aspect) {
    if (aspect <= 1) {
      const halfBase = THREE.MathUtils.degToRad(this.baseFov) / 2;
      const vFov = 2 * Math.atan(Math.tan(halfBase) / aspect);
      this.camera.fov = THREE.MathUtils.radToDeg(vFov);
    } else {
      this.camera.fov = this.baseFov;
    }
  }

  onResize() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera.aspect = aspect;
    this._applyFovForAspect(aspect);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------------- per-frame ----------------
  // Choose the min gap (ms) between rendered frames: ~16.6ms (60fps) during
  // active combat, ~33.3ms (30fps) when idle. Idle = in town, OR no living enemy
  // near the player, OR no recent input. A short "active" window after any input
  // or combat keeps the snap-back smooth: one input bumps us to 60fps for ~600ms
  // so a switch from idle to action never shows a stutter.
  _minFrameInterval(now) {
    const FPS60 = 15;    // matches the historical ~60fps cap
    const FPS30 = 33;    // ~30fps idle cap
    // Only gameplay is throttled; menus/loading/title render at the smooth cap so
    // scrolling and animations there stay crisp.
    if (this.state !== 'playing') return FPS60;

    // Any live input marks us active (checked cheaply, no new listeners).
    const i = this.input;
    const inputActive = i && (
      i.mouse.down || i.mouse.clicked || i.mouse.rightDown ||
      (i.keys && i.keys.size > 0) ||
      this.touch?.joyActive || this.touch?.rotDir
    );
    if (inputActive) this._lastActiveT = now;

    // Combat proximity: any living, non-idle-boss enemy within ~14 units of the
    // player counts as engaged. Recomputed at ~5Hz to keep the per-frame cost tiny.
    if (this._combatCheckT === undefined || now - this._combatCheckT > 200) {
      this._combatCheckT = now;
      this._enemyNear = this._livingEnemyNear();
    }
    if (this._enemyNear) this._lastActiveT = now;

    const idle = !this._enemyNear && (this._lastActiveT === undefined || now - this._lastActiveT > 600);
    return idle ? FPS30 : FPS60;
  }

  // True if a living enemy (not a still-idle one) is within combat range of the
  // player. Also drives whether the learner keeps observing/training.
  _livingEnemyNear() {
    const p = this.player;
    if (!p || p.dead || !this.enemies || this.enemies.length === 0) return false;
    const R2 = 14 * 14;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.isBoss && e.state === 'idle') continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz <= R2) return true;
    }
    return false;
  }

  // True if any living enemy exists on the floor (used to pause the learner).
  _anyLivingEnemy() {
    if (!this.enemies) return false;
    for (const e of this.enemies) if (!e.dead) return true;
    return false;
  }

  frame(now = 0) {
    // Cap frames adaptively. setAnimationLoop renders at the display refresh rate,
    // so on a 120Hz/ProMotion display it would draw 120fps for no visible benefit.
    // We hold ~60fps during active combat and drop to ~30fps when idle (in town,
    // no living enemy near, or no recent input) to cut CPU/battery drain. Skipped
    // vsyncs do not consume clock.getDelta(), so dt below stays sane.
    const minGap = this._minFrameInterval(now);
    if (this._lastFrameT !== undefined && now - this._lastFrameT < minGap) return;
    // Phase-locked cap: advance the frame clock by whole steps of minGap
    // instead of snapping to `now`. Snapping drifts against vsync on high
    // refresh displays, so accepted frames land at uneven intervals (e.g.
    // 8/25/8/25ms on 120Hz) - an uneven dt the camera lerp renders as the
    // world visibly juddering while moving or rotating. The max() guard
    // resyncs after long stalls (tab hidden) so we never fast-forward.
    this._lastFrameT = this._lastFrameT === undefined ? now : Math.max(this._lastFrameT + minGap, now - minGap);
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
      // the vendor-facing camera ease keeps moving while the shop is open,
      // and so does the KEEPER's own turn toward the customer (Obsidian 726:
      // vendors only face the player once the shop is open, and that facing
      // is driven by updateVendors, which the frozen world would otherwise
      // stop right when it matters).
      if (this.state === 'shop' && this.player) { this.updateCameraFollow(dt); if (this.inTown && !this.inTavern) this.updateVendors(dt); }
      if (net.active) this.netFrozenTick(dt);
      if (this.state === 'chatlog' && this.input.wasPressed('Escape')) { this.state = 'playing'; this.ui.hideAll(); }
      if (this.state === 'inventory' && this.input.wasPressed('Escape') && this.ui.selectedItem) {
        // an item's stats/actions card is open on top of the inventory - the
        // first Escape dismisses just that card, the inventory stays open;
        // a second Escape (falling to the branch below) then closes it.
        this.ui.closeItemActions();
      } else if (this.state === 'inventory' && (this.input.wasPressed('Tab') || this.input.wasPressed('Escape') || this.input.wasPressed('KeyI'))) {
        this.state = 'playing';
        this.ui.closeInventory();
      }
      if (this.state === 'shop' && this.input.wasPressed('Escape')) this.closeShop();
      if (this.state === 'quest' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyJ'))) this.toggleQuestLog();
      if (this.state === 'notices' && (this.input.wasPressed('Escape') || this.input.wasPressed('KeyF'))) { this.state = 'playing'; this.ui.hideAll(); }
      if (this._flirtActive && this.input.wasPressed('Escape')) this.ui.closeFlirt();
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
    // Idle render throttle (Obsidian 741): standing in town/tavern doing
    // nothing renders every OTHER frame - the scene is near-static, so this
    // halves steady-state GPU while "just chilling". Any input, movement,
    // camera drag or ease snaps back to full rate the very next frame (the
    // throttle only ever inserts a single skipped frame at a time, which is
    // imperceptible even for the hearth fire).
    const p_ = this.player;
    const noInput = this.state === 'playing' && p_
      && Math.abs(p_.moveDir.x) < 0.01 && Math.abs(p_.moveDir.z) < 0.01
      && !this.input.mouse.down && !this.touch.joyActive && !this._yawEase;
    // Dungeon idling counts too (Obsidian 755): standing still with nothing
    // hunting you nearby and nothing in flight is just as static as town.
    let idleEligible = false;
    if (noInput) {
      if (this.inTown) idleEligible = true;
      else {
        const nearEnemy = this.enemies.some((e) => !e.dead
          && Math.hypot(e.pos.x - p_.pos.x, e.pos.z - p_.pos.z) < 16);
        idleEligible = !nearEnemy && !(this.projectiles?.active?.length) && p_.attackAnim <= 0;
      }
    }
    this._idleT = idleEligible ? (this._idleT || 0) + dt : 0;
    this._frameNo = (this._frameNo || 0) + 1;
    // Render-rate policy (741 + 755, per the three.js power guidance:
    // "render on demand / cap the rate" is the #1 battery-and-heat lever):
    //   - long idle (12s+): render 1 frame in 3 (user report: GPU high while
    //     "just sitting in the tavern doing nothing" - engage sooner)
    //   - idle (3s+): render 1 frame in 2
    //   - battery saver, any time in gameplay: render 1 frame in 2 (the
    //     mode's whole point; sim still runs every frame so nothing skips)
    // Any input/combat resets to full rate on the very next frame.
    const skipMod = this._idleT > 12 ? 3
      : this._idleT > 3 ? 2
        : (this.settings.batterySaver && this.state === 'playing') ? 2 : 0;
    if (!(skipMod && this._frameNo % skipMod !== 0)) {
      this.renderer.render(this.scene, this.camera);
    }
    this.input.endFrame();
  }

  updatePlaying(dt) {
    // While a floor/act is loading (loadFloor yields across a few frames so its
    // progress bar can paint), the world is half-built — dungeon/meshes/enemies
    // are being torn down and replaced. Skip all world simulation for those
    // frames and just render, so nothing runs against a partial state.
    if (this._loading) { this.renderer.render(this.scene, this.camera); this.input.endFrame(); return; }
    const p = this.player;
    const input = this.input;

    // Stuck failsafe (1x/sec): if the hero is embedded in geometry or boxed in
    // on every side (knockback can shove you into a door gap that then seals),
    // snap to the nearest open tile instead of leaving the player trapped.
    this._stuckT = (this._stuckT || 0) + dt;
    // Skip the failsafe whenever the hero is DELIBERATELY pinned (874): lying in
    // a bed, sitting on a bar stool or the couch parks p.pos on a tile that is
    // flagged solid for collision (beds are WALL tiles so you can't walk through
    // them). Without this guard the failsafe read that as "embedded in geometry"
    // and ejected the player every second with the 'Freed from the stone' toast.
    if (this._stuckT >= 1 && p && !p.dead && !this._lyingBed && !this.seatedAt && !this.sittingOnCouch && !this._buyScene && !this._followScene && !this._sceneLock) {
      this._stuckT = 0;
      const embedded = !this.isWalkable(p.pos.x, p.pos.z, 0.25);
      let freedom = 0;
      if (!embedded) {
        for (let a = 0; a < 8; a++) {
          const ang = (a * Math.PI) / 4;
          if (this.isWalkable(p.pos.x + Math.cos(ang) * 0.6, p.pos.z + Math.sin(ang) * 0.6, 0.28)) { freedom++; break; }
        }
      }
      if (embedded || freedom === 0) this.unstickPlayer();
    }

    // one-time notice the first time you step into the portal safe zone this floor
    if (p && this.safeZone) {
      const inSafe = this.inSafeZone(p.pos);
      if (inSafe && !this._inSafeZone) {
        this._inSafeZone = true;
        this.ui.floaters?.spawn(p.pos, '🛡️ Safe zone: no harm can reach you', 'crit');
      } else if (!inSafe) this._inSafeZone = false;
    }

    // ---- input: camera rotation (Q/E or touch rotate buttons) ----
    if (input.isDown('KeyQ')) this.camYaw += 2.2 * dt;
    if (input.isDown('KeyE')) this.camYaw -= 2.2 * dt;
    if (this.touch.rotDir) this.camYaw += this.touch.rotDir * 2.0 * dt;
    // two-thumb twist gesture (accumulated in touch.js): drain the rotation
    // smoothly, with the per-frame step clamped so the camera never whips around
    const twisting = this.touch.twistPending !== 0;
    if (twisting) {
      const maxStep = 2.4 * dt;
      let step = this.touch.twistPending * Math.min(1, 10 * dt);
      step = Math.max(-maxStep, Math.min(maxStep, step));
      this.camYaw += step;
      this.touch.twistPending -= step;
      if (Math.abs(this.touch.twistPending) < 0.002) this.touch.twistPending = 0;
    }
    // any manual rotation suspends the hallway auto-rotate for a few seconds
    // (and cancels a pending vendor/restore ease) so the camera never fights
    const manualRot = input.isDown('KeyQ') || input.isDown('KeyE') || this.touch.rotDir !== 0 || twisting;
    if (manualRot) { this._yawManualT = 3; this._yawEase = null; }
    else if (this._yawManualT > 0) this._yawManualT -= dt;

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
    // belt-and-braces: if the window isn't focused this frame, no input source
    // should be driving movement, blur listener or not (races between focus
    // loss and the events that are supposed to clear key/joystick state are
    // exactly how "walking into a wall with nothing held" bugs happen).
    if (!document.hasFocus()) { p.moveDir.x = 0; p.moveDir.z = 0; }

    // ---- input: aim via mouse raycast to ground (desktop only) ----
    // Touch devices never fire mousemove, so input.mouse.x/y sits frozen at
    // its (0,0) default. Running this raycast unconditionally overwrote the
    // aimAngle/aimDir a tap on the corner cluster had just set (auto-aim at
    // the nearest enemy) on the very next frame, snapping facing back toward
    // that stale top-left ground point before the hero could turn to face
    // its target - the tapped melee swing landed (meleeAttack reads aimAngle
    // synchronously at cast time) but visually never faced/tracked the enemy.
    // Gate this to desktop so touch aim stays whatever clusterTap/clusterSwipe
    // last set it to.
    // ...and never while seated on the fireside couch (Obsidian 747): the
    // per-frame mouse raycast was overriding the seated stare-at-the-fire
    // facing, so the hero's head chased the cursor from the couch.
    if (!this.touch.enabled && !this.sittingOnCouch) {
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
    }

    // facing rule: hover/hold only steers facing, it never fires an attack -
    // attacks are button/cluster-only now (TODO 684).
    p.aiming = !this.inTown && input.mouse.down;

    // live directional aim indicator: while a cluster button is held and
    // dragged (see ui.js), keep the ground arrow/cone pointing where the drag
    // points so the player can see where the cast will go before releasing.
    this.updateAimIndicator();

    // ---- input: actions (Embervale is a place of peace — no weapons drawn) ----
    // clicking a co-op hero opens their inspect panel and eats the click
    const inspected = this.tryInspectClick();
    if (!this.inTown && !inspected) {
      // Desktop click-to-attack (Obsidian 769, reversing the strict
      // button-only rule of 684 by user request): a left-click IN THE WORLD
      // fires the basic attack toward the cursor (the desktop raycast above
      // already keeps aimDir on the cursor). On by default; the Mouse Attack
      // setting disables it. Touch is unaffected (no mouse), and clicks on UI
      // buttons never reach the canvas mousedown listener, so the cluster
      // buttons still work independently. tryInspectClick already ate clicks
      // on co-op heroes.
      if (!this.touch.enabled && this.settings.mouseAttack !== false && input.mouse.clicked) {
        p.tryBasicAttack(this);
      }
      // Digit1-4 remain keyboard shortcuts for the four ability slots.
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
    resetEnemyAnimBudget(); // per-frame modeled-enemy mixer.update() cap (see enemies.js)
    if (net.active && !net.isHost) {
      this.updateGuestMirrors(dt);   // host runs the real enemy AI
    } else {
      for (const e of this.enemies) e.update(dt, this);
    }
    this.enemies = this.enemies.filter((e) => !e.dead || e.isBoss);
    this.updateBossMusic();
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
    this.updateWallMarks(dt);
    this.updateImpactFlashes(dt);
    this.updateTownInteractions(dt);
    this.updateDayNight(dt);
    this.updateTorches(dt);
    roaster.update(dt, this);
    if (net.active) {
      this.updateRemotePlayers(dt);
      this.netPlayTick(dt);
    }

    // ---- camera follow + orbit + zoom + shake ----
    // hallway auto-rotate: inside a 1- or 2-wide corridor, latch and complete
    // the quarter-turn that runs the hallway vertically on screen
    this.updateCorridorYaw(dt, p);
    this.updateCameraFollow(dt);

    // player light follows. In town it rides at torso height so walking up to
    // a building never paints a glow blob on its ROOF (at 3.2 the light sat at
    // roof level); underground the higher carry position lights the room.
    // Outdoor town is lit by the day/night sky + ambient, so the hero needs no
    // personal point light there. Carrying one caused artifacts: high (3.2) it
    // painted a glow blob on building ROOFS; low (1.5) it blew out a hotspot on
    // the character's own HEAD. Disable it outdoors; keep it for the dungeon and
    // the tavern interior where the hero genuinely carries the light.
    const outdoorTown = this.inTown && !this.inTavern;
    this.playerLight.visible = !outdoorTown;
    this.playerLight.position.set(p.pos.x, 3.2, p.pos.z);

    // audio listener
    audio.setListener(p.pos.x, p.pos.z);

    // enemy ML observes player movement for online training, but only while
    // living enemies exist to use it AND the player is actually fighting.
    // Standing idle in a dungeon used to keep the worker training every 6s
    // forever - a constant CPU burn (laptop fans) for zero learning value,
    // since an idle player generates no movement worth predicting. Gate on
    // recent combat: any damage dealt or taken in the last 20s.
    const fighting = this._lastCombatT !== undefined && performance.now() - this._lastCombatT < 20000;
    if (!this.inTown && fighting && this._anyLivingEnemy()) learner.observe(dt, p);

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

  // shortest signed difference a-b wrapped to (-PI, PI]
  _angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Is the tile at (tx,ty) inside a straight 1- or 2-wide passage, and along
  // which world axis does it run? Same walkable-grid sampling idea as the
  // minimap's corridorAlign, widened: the cross-section perpendicular to the
  // axis must be 1 or 2 walkable tiles bounded by walls on both sides, and the
  // whole cross-section must stay open one tile ahead AND behind along the
  // axis. Rooms (3+ wide), junctions and ambiguous crossings return null.
  _corridorAxisAt(tx, ty) {
    const mm = this.ui.minimap;
    if (!mm?.dungeon || mm.dungeon !== this.dungeon) return null;
    const w = (x, y) => mm.walkable(x, y);
    if (!w(tx, ty)) return null;
    const runs = (horizontal) => {
      // cross-section: perpendicular to the corridor axis through the player
      const open = (o) => (horizontal ? w(tx, ty + o) : w(tx + o, ty));
      let lo = 0, hi = 0;
      while (hi - lo + 1 < 3 && open(lo - 1)) lo--;
      while (hi - lo + 1 < 3 && open(hi + 1)) hi++;
      if (hi - lo + 1 > 2) return false;               // 3+ wide: a room
      if (open(lo - 1) || open(hi + 1)) return false;  // not wall-bounded
      // the full cross-section must continue one tile each way along the axis
      for (const d of [-1, 1]) {
        for (let r = lo; r <= hi; r++) {
          if (!(horizontal ? w(tx + d, ty + r) : w(tx + r, ty + d))) return false;
        }
      }
      return true;
    };
    const h = runs(true), v = runs(false);
    if (h && !v) return 'x'; // passage runs along world x
    if (v && !h) return 'z'; // passage runs along world z
    return null;
  }

  // Picks which of the two axis-aligned quarter-turns (base or base+PI) puts
  // the camera BEHIND the given travel direction, i.e. looking the same way
  // the hero is walking (dot(cameraForward, dir) > 0), so the player sees the
  // hero's back, never their face. Camera position is target + (sin,cos)*dist
  // with lookAt(target), so cameraForward (camera->target) is (-sin,-cos).
  _behindYawFor(base, dirX, dirZ) {
    const fwdBase = { x: -Math.sin(base), z: -Math.cos(base) };
    const dot = fwdBase.x * dirX + fwdBase.z * dirZ;
    return dot >= 0 ? base : base + Math.PI;
  }

  // Corridor-entry yaw pick, least-travel edition (user feedback: "rotations
  // should take the path of least travel so the user doesn't get dizzy").
  // Of the two axis-aligned quarter-turns, prefer whichever is CLOSER to the
  // current camera yaw - unless that nearest option would show the hero
  // face-on while they're clearly walking into the camera (dot well below 0),
  // in which case the behind-view still wins. Walking away or entering
  // sideways never triggers a long 180 spin anymore.
  _pickCorridorYaw(base, dirX, dirZ) {
    const a = base, b = base + Math.PI;
    const behind = this._behindYawFor(base, dirX, dirZ);
    const nearest = Math.abs(this._angDiff(a, this.camYaw)) <= Math.abs(this._angDiff(b, this.camYaw)) ? a : b;
    if (nearest === behind) return nearest;
    const fwd = { x: -Math.sin(nearest), z: -Math.cos(nearest) };
    const dot = fwd.x * dirX + fwd.z * dirZ;
    return dot < -0.35 ? behind : nearest;
  }

  // Hallway camera auto-rotate. Standing in or entering a 1- or 2-wide
  // straight passage LATCHES a quarter-turn: the camera commits to easing all
  // the way to the axis-aligned yaw (hallway vertical on screen) and lands on
  // it EXACTLY - once latched, only manual rotation or leaving the corridor
  // cancels the turn (a momentary drop of the corridor gate never half-turns
  // it back). Of the two 180-degree-apart quarter-turns that both run the
  // hallway vertically, the latch picks by LEAST TRAVEL (see _pickCorridorYaw),
  // falling back to the behind-view only when the nearest turn would leave the
  // hero walking face-on into the camera. If the player reverses and walks the
  // other way for more than a moment, the latch re-picks the behind-view for
  // the new direction. Leaving the corridor keeps the corridor yaw (no restore
  // ease - it caused re-rotations in rooms where the camera was already fine).
  // Manual rotation (Q/E, twist) kills the latch until the corridor is left.
  // Dungeon floors only.
  updateCorridorYaw(dt, p) {
    if (this.inTown || this.inTavern) { this._hallway = null; return; }
    const tx = Math.floor(p.pos.x / TILE), tz = Math.floor(p.pos.z / TILE);
    const axis = this._corridorAxisAt(tx, tz);
    let hw = this._hallway;
    const moving = !!(p.moveDir.x || p.moveDir.z);
    if (!axis) {
      // Left the corridor: keep whatever yaw we have. The old "restore the
      // room's yaw" ease is gone - it re-rotated a camera that was already
      // fine behind the hero, and hovering near the corridor mouth made it
      // ping-pong (user feedback in TODO 675).
      this._hallway = null;
      this._corrT = 0;
      return;
    }
    // Entry debounce: a single frame's toe over the corridor threshold must
    // not latch a turn - that's the "sporadic rotate if I move a little near
    // the hallway I just left" complaint. Require a firm dwell first.
    if (!hw) {
      this._corrT = (this._corrT || 0) + dt;
      if (this._corrT < 0.22) return;
    }
    if ((this._yawManualT || 0) > 0) {
      if (hw) hw.dead = true; // the player rotated: hands off until they leave
      return;
    }
    const base = axis === 'x' ? Math.PI / 2 : 0;
    // travel direction used for the behind-view check: current movement while
    // moving, otherwise the last direction the hero was walking (falls back
    // to the entry direction so standing still right after entering still
    // resolves to the correct side)
    let dirX = p.moveDir.x, dirZ = p.moveDir.z;
    if (moving) { hw && (hw.lastDirX = dirX, hw.lastDirZ = dirZ); }
    else if (hw && (hw.lastDirX || hw.lastDirZ)) { dirX = hw.lastDirX; dirZ = hw.lastDirZ; }
    if (!hw || hw.axis !== axis) {
      // entering (or turning a corner into a crossing passage): pick the
      // quarter-turn that puts the camera behind the hero's current heading
      // (facingDir if standing still) and remember where the camera was so
      // the room can get it back
      if (!dirX && !dirZ) { dirX = p.facingDir ? p.facingDir().x : 0; dirZ = p.facingDir ? p.facingDir().z : -1; }
      const target = this._pickCorridorYaw(base, dirX, dirZ);
      hw = this._hallway = {
        axis, target,
        lastDirX: dirX, lastDirZ: dirZ,
        reverseT: 0,
      };
      this._yawEase = null; // the latch supersedes any pending restore ease
    } else if (moving) {
      // mid-corridor reversal: if the hero has been walking opposite the
      // latched behind-direction for more than a moment, re-latch to face
      // the new direction of travel instead of riding along facing them
      const fwd = { x: -Math.sin(hw.target), z: -Math.cos(hw.target) };
      const dot = fwd.x * dirX + fwd.z * dirZ;
      if (dot < -0.3) {
        hw.reverseT = (hw.reverseT || 0) + dt;
        if (hw.reverseT > 0.35) {
          hw.target = this._behindYawFor(base, dirX, dirZ);
          hw.reverseT = 0;
        }
      } else {
        hw.reverseT = 0;
      }
    }
    if (hw.dead) return;
    // committed ease along the shortest arc; snap the last hundredth so the
    // hallway ends up EXACTLY vertical, never approximately. Keeps easing to
    // the latched target even if the corridor gate above returned early on a
    // prior frame (hw persists across those drops), so movement never stalls
    // the turn half-way.
    const d = this._angDiff(hw.target, this.camYaw);
    if (Math.abs(d) < 0.01) { this.camYaw += d; return; }
    this.camYaw += d * Math.min(1, 2.2 * dt);
  }

  // Camera follow + orbit + zoom + shake. Extracted from updatePlaying so the
  // shop state can keep easing the camera (vendor-facing turn) while the rest
  // of the world is frozen.
  updateCameraFollow(dt) {
    const p = this.player;
    if (!p) return;
    // pending yaw ease (vendor-facing turn on shop open, restore on close);
    // eases along the shortest arc and retires itself on arrival
    if (this._yawEase) {
      const d = this._angDiff(this._yawEase.target, this.camYaw);
      // land on the target exactly via the wrapped diff (never a 2*PI jump)
      if (Math.abs(d) < 0.01) { this.camYaw += d; this._yawEase = null; }
      else this.camYaw += d * Math.min(1, 3.5 * dt);
    }
    const target = p.pos;
    const zoom = this.camZoom || 1; // wheel / pinch scales the whole offset
    // Zoomed in close: bring the camera DOWN to eye level and aim straight at
    // the eyes, so the line of sight is level (parallel) with the eyes rather
    // than tilting down onto the face. Both the camera height and the look
    // target converge on EYE_Y as you zoom fully in, giving a horizontal view
    // that also peeks under a hat brim. EYE_Y is the eye height of the
    // 1.6-unit hero (eyes sit a little below the head top).
    const closeIn = Math.min(1, Math.max(0, (0.6 - zoom) / 0.48)); // 0 far, 1 fully in
    const eyeBlend = closeIn * closeIn * (3 - 2 * closeIn); // smoothstep
    // Fully zoomed in: the camera arcs DOWN from overhead to eye level (EYE_Y)
    // and backs off to a standoff so the whole face plus about half the body
    // stays in frame. The look target sits a little BELOW the eyes so the eyes
    // land in the upper third of the screen (and a hat brim never hides them).
    const EYE_Y = 1.18;        // settle just BELOW the hero's eye line (under a hat brim)
    const LOOK_CLOSE_Y = 0.8;  // aim at the chest so the whole body + feet fit in frame
    const MIN_CLOSE_DIST = 3.6; // standoff at full zoom: full body, feet on the ground
    const lookY = 0.5 + (LOOK_CLOSE_Y - 0.5) * eyeBlend;
    const normalCamY = target.y + this.cameraOffset.y * zoom;
    const camYTarget = normalCamY + (target.y + EYE_Y - normalCamY) * eyeBlend;
    const rawDist = this.cameraOffset.z * zoom;
    const camDist = rawDist + Math.max(0, MIN_CLOSE_DIST - rawDist) * eyeBlend;
    const camX = target.x + Math.sin(this.camYaw) * camDist;
    const camZ = target.z + Math.cos(this.camYaw) * camDist;
    // Frame-rate-independent smoothing (1 - e^-kt), applied IDENTICALLY to the
    // camera position and the look target. The old scheme eased position with
    // a linear min(1, 8*dt) factor but aimed lookAt at the player's EXACT spot
    // every frame - so any dt variance stepped the position unevenly while the
    // orientation stayed pinned, converting frame-time noise into camera
    // ROTATION noise around the hero: the hero looked smooth (lookAt pins them
    // on screen) while the whole world jittered left/right - the exact TODO-8
    // symptom, worst while moving or rotating with Q/E. Easing both ends with
    // the same coefficient makes them lag coherently, so dt noise cancels out
    // of the camera-to-target direction instead of shaking the view.
    const k = 1 - Math.exp(-8 * dt);
    this.camera.position.x += (camX - this.camera.position.x) * k;
    this.camera.position.y += (camYTarget - this.camera.position.y) * k;
    this.camera.position.z += (camZ - this.camera.position.z) * k;
    if (!this._camLook) this._camLook = new THREE.Vector3(target.x, lookY, target.z);
    this._camLook.x += (target.x - this._camLook.x) * k;
    this._camLook.y += (lookY - this._camLook.y) * k;
    this._camLook.z += (target.z - this._camLook.z) * k;
    if (this.shakeAmount > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmount;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmount * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * this.shakeAmount;
      this.shakeAmount *= 1 - 7 * dt;
    }
    this.camera.lookAt(this._camLook.x, this._camLook.y, this._camLook.z);
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
          // First tick also lands on cast-locked targets that fled the circle
          // during the windup (774: AoE is undodgeable once you're caught in
          // the telegraph). Only those OUTSIDE now - insiders were just hit.
          if (z._locked) {
            for (const e of z._locked) {
              if (e.dead) continue;
              if (Math.hypot(e.pos.x - z.x, e.pos.z - z.z) >= z.radius + e.radius) {
                this.damageEnemy(e, dmg, { status: z.status });
              }
            }
            z._locked = null;
          }
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
    // A door opens on player proximity, and ALSO when the boss reaches it, so a
    // boss chasing the hero can pass through a door the player already went
    // through instead of getting walled off. Normal mobs never trigger this
    // (only the player and the boss do), so ordinary door-gating is unchanged.
    const boss = (this.boss && !this.boss.dead) ? this.boss : null;
    for (const d of this.dungeon.doors) {
      const key = `${d.x},${d.y}`;
      if (this.openedDoors.has(key)) continue;
      const w = tileToWorld(d.x, d.y);
      const nearBoss = boss && Math.hypot(boss.pos.x - w.x, boss.pos.z - w.z) < TILE * 1.1;
      if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < TILE * 1.1 || nearBoss) {
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
        // Open the lid on the side nearest the player. The chest body stays put;
        // only the lid tilts. The chest Group carries a random world yaw, so the
        // player->chest direction is rotated into the chest's LOCAL frame and
        // snapped to the nearest of the four edges (±X / ±Z), then the lid hinges
        // up and slides back over that edge.
        const yaw = c.mesh.rotation.y;
        const wx = p.pos.x - c.x, wz = p.pos.z - c.z;
        const cos = Math.cos(-yaw), sin = Math.sin(-yaw);
        const lx = wx * cos - wz * sin; // player offset in the chest's local axes
        const lz = wx * sin + wz * cos;
        const open = 1.1; // hinge angle
        const slide = 0.18, lift = 0.12;
        if (Math.abs(lx) > Math.abs(lz)) {
          // nearest side is along local X: hinge about Z so the lid leans back
          // away from the player, exposing the opening toward them.
          c.lid.rotation.z = lx > 0 ? open : -open;
          c.lid.position.x += lx > 0 ? -slide : slide;
        } else {
          // nearest side is along local Z: hinge about X toward the player.
          c.lid.rotation.x = lz > 0 ? open : -open;
          c.lid.position.z += lz > 0 ? -slide : slide;
        }
        c.lid.position.y += lift;
        this.particles.burst(c.x, 0.8, c.z, 16, 0xe8c05a, { speed: 2.5, life: 0.6 });
        // chest loot: gold + high gear chance + potion chance
        const gold = 8 + Math.round(Math.random() * 10 * this.floor);
        for (let i = 0; i < 3; i++) this.loot.dropGold(c.x, c.z, Math.round(gold / 3));
        if (Math.random() < 0.65) this.loot.dropGear(c.x + 0.6, c.z, generateGear(this.floor, null, this.player.classId, { equipped: this.player.equipped }));
        if (Math.random() < 0.4) this.loot.dropPotion(c.x - 0.6, c.z);
        if (Math.random() < 0.03) this.loot.dropBag(c.x, c.z + 0.7);
      }
    }
  }

  // Animates the descend-stairs hatch: the square lid tilts UP to reveal the
  // dark stairwell once the seal breaks. Actual descent is an interact prompt
  // built in updateTownInteractions (so nothing triggers on contact).
  updateStairs(dt) {
    this.stairsCooldown = Math.max(0, this.stairsCooldown - dt);
    const sm = this.dungeonMeshes?.stairsMesh;
    if (!sm) return;
    const lid = sm.children.find((ch) => ch.userData?.stairsLid);
    if (lid) {
      // Sealed: lid lies flat (0). Open: hinges up and back (~120°).
      const target = (this.inTown || !this.stairsLocked()) ? -Math.PI * 0.66 : 0;
      lid.rotation.x += (target - lid.rotation.x) * Math.min(1, dt * 4);
    }
    // advance the gold light-puddle shimmer
    const puddle = sm.children.find((ch) => ch.userData?.hatchPuddle);
    if (puddle) puddle.userData.hatchPuddleUpdate(dt);
  }

  // Portal: dungeon-floor exit back to Embervale (checkpoint kept).
  usePortalToTown() {
    audio.play('stairs', { volume: 0.8, rate: 1.2 });
    if (net.active && !net.isHost) { this.stairsCooldown = 2; this.localTown = true; }
    this.loadTown({ fromDungeon: true });
  }

  // Portal: town → the dungeon (or join the party's shared world).
  usePortalToDungeon() {
    // The town portal has a 10s reuse cooldown so it can't be spammed to
    // rapidly re-roll floors. Blocked uses show a floater in the same style as
    // Zoltan's "Fate must rest" gamble cooldown.
    const left = Math.ceil(((this._portalReadyAt || 0) - performance.now()) / 1000);
    if (left > 0) { this.ui.floaters.spawn(this.player.pos, `The way must settle — ${left}s`, 'player-dmg'); return; }
    this._portalReadyAt = performance.now() + 10000;
    // First-ever trip through the portal: one device-appropriate hint on how
    // to attack (the touch tutorial teaches move/attack/ability in town, so
    // this mainly serves desktop, where no tutorial exists). Shown once.
    if (!localStorage.getItem('emberdeep-attack-tip')) {
      localStorage.setItem('emberdeep-attack-tip', '1');
      setTimeout(() => this.ui.showFloorBanner?.('Tap the attack button to fight', 'Slay your way to the stairs', true), 1600);
    }
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

  // Gold light-puddle on the floor around the descend hatch: greyish and dim
  // while the floor is sealed, bright enticing gold once the stairs unlock.
  setStairsGlow(sealed) {
    const puddle = this.dungeonMeshes?.stairsMesh?.children.find((ch) => ch.userData?.hatchPuddle);
    if (!puddle) return;
    puddle.userData.setHatchColor(sealed ? 0x6a6250 : 0xf0b83a);
    puddle.userData.setHatchBright(sealed ? 0.22 : 1);
  }

  // Pit holes: fall through to the next floor (solo) — it hurts.
  updatePits() { /* pit-fall traps removed */ }

  // Bricks and dust burst off a WALL when a projectile or melee swing strikes
  // it, plus a scorch decal on the wall face itself. `opts.dirX/dirZ` is the
  // impact's travel direction (so the decal can face back the way it came);
  // `opts.tint` lets the caller's own colour (a bolt, a blade flash) bleed
  // into the scorch instead of every impact looking identically sooty.
  wallDebris(x, z, opts = {}) {
    const y = opts.y ?? 1.0;
    this.particles.burst(x, y, z, 10, 0x8a8590, { speed: 3.4, life: 0.4, size: 0.12, up: 0.9 });
    this.particles.burst(x, y, z, 4, 0x5a5560, { speed: 1.7, life: 0.55, size: 0.19, up: 1.2 });
    if (opts.tint) this.particles.burst(x, y, z, 4, opts.tint, { speed: 2.6, life: 0.3, size: 0.08 });
    this.spawnImpactFlash(x, y, z, opts.tint ?? 0xfff0d0);
    this.addWallImpactMark(x, z, { dirX: opts.dirX, dirZ: opts.dirZ, tint: opts.tint, y });
    this.breakNear(x, z, 0.9); // a stray shot can smash a container too
    this.damageDestructibleWall(x, z);
  }

  // Every wallDebris impact (melee whiff or a projectile hitting stone, both
  // already routed here) also checks whether it landed on a destructible
  // interior wall cell (dungeon.destructibleWalls, computed at floor-build in
  // dungeon.js: a wall separating two open areas, never a perimeter/boss cell).
  // 3 hits break it: hits 1-2 stage the visual (intact -> cracked), the 3rd
  // removes the wall outright — patches dungeon.grid to FLOOR (the single
  // isWalkable/pathing source of truth, so enemies and the minimap see the
  // opening immediately), drops a rubble pile, and records the break in this
  // character's in-memory session map so revisiting the floor keeps the hole.
  damageDestructibleWall(x, z) {
    const { tx, ty } = worldToTile(x, z);
    if (this.dungeon?.grid?.[ty]?.[tx] !== WALL) return;
    if (!this.dungeon.destructibleWalls?.has(`${tx},${ty}`)) return;
    const cellKey = `${tx},${ty}`;
    const hitKey = `${this.floor}:${cellKey}`;
    const hits = (this.destructibleWallHits[hitKey] || 0) + 1;
    if (hits >= 3) {
      delete this.destructibleWallHits[hitKey];
      setWallCellStage(this.dungeonMeshes, this.dungeon, tx, ty, 3); // final hit: gone
      (this.destroyedWallsSession[this.floor] ||= new Set()).add(cellKey);
      const w = tileToWorld(tx, ty);
      this.particles.burst(w.x, 1.0, w.z, 16, 0x8a8590, { speed: 4.2, life: 0.5, size: 0.14, up: 1.1 });
      this.particles.burst(w.x, 0.3, w.z, 10, 0x5a5560, { speed: 2.2, life: 0.6, size: 0.2 });
      audio.play('golem_slam', { pos: { x: w.x, z: w.z }, volume: 0.8, rate: 0.85 }); // solid thunk
      this.shake(0.15);
    } else {
      this.destructibleWallHits[hitKey] = hits;
      setWallCellStage(this.dungeonMeshes, this.dungeon, tx, ty, hits); // 1 = cracked, 2 = broken
    }
  }

  // A persistent GROUND decal (chip/scuff/scorch) for things that happen at
  // floor level: a smashed container, an AoE scorching the ground it landed
  // on. Shares the same capped, fading pool as wall-impact marks.
  addWallMark(x, z, opts = {}) {
    const size = opts.size ?? (0.3 + Math.random() * 0.25);
    const opacity = opts.opacity ?? 0.4;
    // shared unit circle scaled per-decal (753) - same churn fix as the
    // wall-impact marks
    this._markCircleGeo ||= new THREE.CircleGeometry(1, 10);
    const mesh = new THREE.Mesh(
      this._markCircleGeo,
      new THREE.MeshBasicMaterial({ color: opts.color ?? 0x000000, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
    );
    mesh.scale.setScalar(size);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI;
    // Ground decals sit at 0.15, NOT ~0.03 (757 re-fix): the dungeon floor is
    // relief hex tiles + rubble that rise well above the 0-height base plane,
    // so a decal at 0.03 was buried under the tile surface and invisible in
    // play. Verified with a pixel A/B: 0.05 clipped almost entirely, 0.12+
    // read as a flat pool on the ground. 0.15 clears the hex rims and light
    // rubble while still lying flush from the top-down camera.
    mesh.position.set(x, 0.15, z);
    // add to the scene (pre-existing bug found via 757: pushMarkEntry only
    // TRACKS meshes for fade/cap - it never added them, so every ground
    // decal from addWallMark (AoE scorches, burn marks, blood pools) was
    // silently invisible; addWallImpactMark added its own meshes explicitly).
    this.scene.add(mesh);
    this.pushMarkEntry([mesh], [opacity], opts.fadeAfter ?? 20);
  }

  // A WALL-FACE decal: a vertical scorch plane at impact height facing back
  // along the travel direction, plus a few small chipped-stone flecks stuck
  // to the wall beside it. This is what makes a projectile/melee miss into a
  // wall actually readable from the overhead game camera (a flat circle on
  // the floor below the wall was invisible in practice).
  addWallImpactMark(x, z, opts = {}) {
    const y = opts.y ?? 1.0;
    // face back the way the impact travelled; a 0 component (e.g. straight
    // along an axis) is a legitimate direction, so use ?? not || here
    const dx = opts.dirX ?? 0, dz = opts.dirZ ?? 0;
    const dlen = Math.hypot(dx, dz) || 1e-6;
    const nx = dx / dlen, nz = dz / dlen;
    const rotY = Math.atan2(-nx, -nz);
    // nudge the decal back toward the attacker so it sits proud of the wall
    // face instead of z-fighting with it
    const px = x - nx * 0.05, pz = z - nz * 0.05;
    // Read as a dark scorch scuff, not a bright coloured card: mostly charcoal
    // with only a hint of the projectile colour, subtle, and quick to fade so a
    // long fight does not paper the walls with litter.
    const baseColor = new THREE.Color(0x18120d);
    if (opts.tint) baseColor.lerp(new THREE.Color(opts.tint), 0.12);
    const size = 0.26 + Math.random() * 0.1;
    // shared UNIT geometries scaled per-mesh (753): every impact used to
    // upload a fresh plane + box geometry then dispose them seconds later -
    // pure GPU churn in the hottest combat path
    this._markPlaneGeo ||= new THREE.PlaneGeometry(1, 1.1);
    this._markChipGeo ||= new THREE.BoxGeometry(1, 1, 0.6);
    const plane = new THREE.Mesh(
      this._markPlaneGeo,
      new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide })
    );
    plane.scale.setScalar(size);
    plane.position.set(px, y, pz);
    plane.rotation.y = rotY;
    this.scene.add(plane);
    const meshes = [plane];
    const opacities = [0.45];
    // one or two small dark stone-chip flecks scattered around the impact
    const chipCount = 1 + Math.floor(Math.random() * 2);
    const chipMat = new THREE.MeshBasicMaterial({ color: 0x18120f, transparent: true, opacity: 0.85 });
    for (let i = 0; i < chipCount; i++) {
      const s = 0.05 + Math.random() * 0.05;
      const chip = new THREE.Mesh(this._markChipGeo, chipMat.clone());
      chip.scale.setScalar(s);
      chip.position.set(
        px + (Math.random() - 0.5) * 0.3 - nx * 0.02,
        y + (Math.random() - 0.5) * 0.3,
        pz + (Math.random() - 0.5) * 0.3 - nz * 0.02,
      );
      chip.rotation.set(Math.random(), Math.random(), Math.random());
      this.scene.add(chip);
      meshes.push(chip);
      opacities.push(0.85);
    }
    this.pushMarkEntry(meshes, opacities, opts.fadeAfter ?? 8);
  }

  // Shared pool bookkeeping for both ground decals and wall-impact marks:
  // capped (oldest removed first) so it can't leak RAM or draw calls, and
  // each entry fades out over ~fadeAfter seconds via updateWallMarks().
  pushMarkEntry(meshes, baseOpacities, fadeAfter) {
    if (!this.wallMarks) this.wallMarks = [];
    if (this.wallMarks.length >= 48) this.disposeMarkEntry(this.wallMarks.shift());
    this.wallMarks.push({ meshes, baseOpacities, age: 0, fadeAfter });
  }

  disposeMarkEntry(d) {
    // geometry is SHARED across all marks since 753 - dispose materials only
    for (const mesh of d.meshes) {
      this.scene.remove(mesh);
      if (mesh.geometry !== this._markPlaneGeo && mesh.geometry !== this._markChipGeo && mesh.geometry !== this._markCircleGeo) mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  // Ages out wall marks over their fadeAfter window (last third of life fades
  // to 0) so old scars don't linger forever; the cap in pushMarkEntry keeps
  // the pool itself bounded independently of this.
  updateWallMarks(dt) {
    if (!this.wallMarks?.length) return;
    for (let i = this.wallMarks.length - 1; i >= 0; i--) {
      const d = this.wallMarks[i];
      d.age += dt;
      const t = d.age / d.fadeAfter;
      if (t >= 1) {
        this.disposeMarkEntry(d);
        this.wallMarks.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, (1 - t) / 0.34);
      for (let m = 0; m < d.meshes.length; m++) d.meshes[m].material.opacity = d.baseOpacities[m] * fade;
    }
  }

  // A brief additive glow-sprite flash at an impact point, on top of the
  // particle burst, so the hit reads as a punchy flash and not just sparks.
  // POOLED (Obsidian 753): impacts fire many times per second in combat and
  // each used to allocate a fresh Sprite+SpriteMaterial - constant GC churn
  // and first-variant shader work, i.e. stutter. A fixed pool of 14 sprites
  // is recycled instead; overflow steals the oldest live flash.
  spawnImpactFlash(x, y, z, color = 0xfff0d0) {
    if (!this.impactFlashes) this.impactFlashes = [];
    if (!this._flashPool) {
      this._flashPool = [];
      for (let i = 0; i < 14; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this._glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0,
        }));
        s.visible = false;
        this.scene.add(s);
        this._flashPool.push(s);
      }
    }
    let sprite = this._flashPool.find((s) => !s.visible);
    if (!sprite) { // steal the oldest live flash
      const oldest = this.impactFlashes.shift();
      sprite = oldest ? oldest.sprite : this._flashPool[0];
      const idx = this.impactFlashes.findIndex((f) => f.sprite === sprite);
      if (idx >= 0) this.impactFlashes.splice(idx, 1);
    }
    sprite.material.color.set(color);
    sprite.material.opacity = 0.9;
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(0.5);
    sprite.visible = true;
    this.impactFlashes.push({ sprite, life: 0.18, maxLife: 0.18 });
  }

  updateImpactFlashes(dt) {
    if (!this.impactFlashes?.length) return;
    for (let i = this.impactFlashes.length - 1; i >= 0; i--) {
      const f = this.impactFlashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        // pooled (753): hide for reuse - never remove/dispose pool sprites
        f.sprite.visible = false;
        f.sprite.material.opacity = 0;
        this.impactFlashes.splice(i, 1);
        continue;
      }
      const t = 1 - f.life / f.maxLife;
      f.sprite.scale.setScalar(0.5 + t * 0.9);
      f.sprite.material.opacity = 0.9 * (1 - t);
    }
  }

  // Desktop hover + click-to-teleport for the town dungeon portal. Raycasts the
  // mouse against the portal mesh (reusing the same raycaster/NDC vector as the
  // remote-player inspect click). While hovering, drives the portal's hover ramp
  // (faster swirl + brighter shader, lerped smoothly in portal.js); a click
  // while hovering teleports via the same usePortalToDungeon the prompt calls.
  updatePortalHover() {
    const pm = (this.inTown && !this.inTavern) ? this.dungeonMeshes?.portalMesh : null;
    const setHover = pm?.userData.portalUpdate?.setHover;
    if (!pm || !setHover) return;
    // Touch has no meaningful cursor; leave the portal at rest for touch play.
    if (this.touch?.enabled) { setHover(false); return; }
    const input = this.input;
    this._mouseNdc.set(
      (input.mouse.x / window.innerWidth) * 2 - 1,
      -(input.mouse.y / window.innerHeight) * 2 + 1
    );
    this.raycaster.setFromCamera(this._mouseNdc, this.camera);
    const hovering = this.raycaster.intersectObject(pm, true).length > 0;
    setHover(hovering);
    if (hovering && input.mouse.clicked && this.stairsCooldown <= 0) {
      this.usePortalToDungeon();
    }
  }

  // Town: vendors open their shop when you walk up; the portal descends.
  // True while any character line is audibly playing: the Web Speech synth
  // (battery-saver voices) or the neural Kokoro engine (a live buffer source,
  // or a generation in flight about to play). Roaster routes every character
  // line through one of those two engines, so together they are the whole
  // "someone is speaking" signal - read-only, no roaster changes needed. The
  // neuralVoice module reference is cached from a one-time dynamic import
  // (same lazy-load pattern roaster/ui use); until it resolves the neural
  // half simply reads as silent.
  npcSpeechActive() {
    try {
      if ('speechSynthesis' in window && speechSynthesis.speaking) return true;
    } catch { /* no synth on this browser */ }
    if (!this._neuralVoiceRef) {
      this._neuralVoiceRef = {};
      import('./ai/neuralVoice.js')
        .then(({ neuralVoice }) => { this._neuralVoiceRef = neuralVoice; })
        .catch(() => { /* stays the empty stub: neural half reads silent */ });
    }
    if (!this._liteVoiceRef) {
      this._liteVoiceRef = {};
      import('./ai/liteVoice.js')
        .then(({ liteVoice }) => { this._liteVoiceRef = liteVoice; })
        .catch(() => { /* stays the empty stub: lite half reads silent */ });
    }
    // A visible caption bubble counts as active speech even with no audio
    // (Obsidian 838), so ambient turns wait for it instead of flashing.
    if (performance.now() < (this._speechCaptionUntil || 0)) return true;
    return !!(this._neuralVoiceRef._current || this._neuralVoiceRef._busy || this._liteVoiceRef.speaking);
  }

  updateTownInteractions(dt) {
    this.shopCooldown = Math.max(0, this.shopCooldown - dt);
    if (!this.dungeonMeshes) return;
    const p = this.player;
    const near = (wx, wz, r = 1.8) => Math.hypot(p.pos.x - wx, p.pos.z - wz) < r;
    let candidate = null;

    // advance the portal spheres' swirl shader + orbiting particles
    if (this.dungeonMeshes.returnPortalMesh) this.dungeonMeshes.returnPortalMesh.userData.portalUpdate?.(dt);
    if (this.dungeonMeshes.portalMesh) this.dungeonMeshes.portalMesh.userData.portalUpdate?.(dt);

    // desktop: mouse-hover the town dungeon portal to spin it up + brighten it,
    // and click while hovering to teleport (same action as the interact prompt)
    this.updatePortalHover();

    // ---- DUNGEON: descend stairs (gold ring) + return-to-town portal ----
    if (!this.inTown) {
      if (this.dungeon.stairs && this.stairsCooldown <= 0) {
        const w = tileToWorld(this.dungeon.stairs.x, this.dungeon.stairs.y);
        if (near(w.x, w.z, 1.9)) {
          const locked = this.stairsLocked();
          candidate = locked
            ? { label: `Stairs sealed: ${this.floorKills}/${this.stairsClearNeed()} slain`, icon: '🔒', action: () => this.descendStairs() }
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
          if (near(v.wx, v.wz, 2.4)) { candidate = { label: `Talk to ${v.name}`, icon: '💬', talk: true, action: () => this.openShop(v) }; break; }
        }
      }
      if (!candidate && this.wanderer && near(this.wanderer.pos.x, this.wanderer.pos.z, 2.6)) {
        candidate = { label: 'Talk to Old Fenwick', icon: '🧙', talk: true, action: () => this.wanderer.speakTo(this) };
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
      // Staircase to the upstairs rooms (Obsidian 800): ascend from the base on
      // the tavern floor, descend from the stairwell up top.
      if (!candidate && !this.inUpstairs && this.dungeon.stairsUp && this.stairsCooldown <= 0
        && near(30.4, 20.6, 2.2)) {
        candidate = { label: 'Head upstairs', icon: '🪜', action: () => { this.stairsCooldown = 1.5; audio.play('door_open'); this.loadTavernUpstairs(); } };
      }
      if (!candidate && this.inUpstairs && this.dungeonMeshes.stairsDownPos && this.stairsCooldown <= 0
        && near(this.dungeonMeshes.stairsDownPos.x, this.dungeonMeshes.stairsDownPos.z, 2.0)) {
        candidate = { label: 'Head downstairs', icon: '🪜', action: () => { this.stairsCooldown = 1.5; audio.play('door_open'); this.loadTavern(); } };
      }
      // Lie down in a bed (Obsidian 842b): near any upstairs bed, offer to rest;
      // once lying the prompt is "Get up" (any movement also gets you up).
      if (!candidate && this.inUpstairs && !this._lyingBed && this.dungeonMeshes.bedPositions) {
        for (const bp of this.dungeonMeshes.bedPositions) {
          if (near(bp.standZ != null ? bp.x : bp.x, bp.standZ != null ? bp.standZ : bp.z, 1.7)) {
            candidate = { label: 'Lie down', icon: '🛏️', action: () => {
              this._lyingBed = bp;
              audio.play('ui_click', { volume: 0.5 });
            } };
            break;
          }
        }
      }
      if (!candidate && this.inUpstairs && this._lyingBed) {
        candidate = { label: 'Get up', icon: '🧍', action: () => this._standFromBed() };
      }
      // 3.8 (was 2.4, Obsidian 746): the bar rework (720) put Magda a full
      // aisle + counter away from a customer standing at the bar front, past
      // the old radius - across-the-counter talking must always reach her.
      if (!candidate && this.dungeonMeshes.barkeepPos && near(this.dungeonMeshes.barkeepPos.x, this.dungeonMeshes.barkeepPos.z, 3.8)) {
        candidate = { label: 'Talk to Magda', icon: '🍺', talk: true, action: () => this.barkeepChat() };
      }
      if (!candidate) {
        for (const pm of this.dungeonMeshes.patronMeshes || []) {
          // No re-interact prompt mid-conversation (878): while her turn is in
          // flight (thinking pill up / choices pending) the pill would offer
          // "Chat up Rosalind" AGAIN over the active conversation.
          if (this._flirtActive === pm || this.ui._flirtPm === pm) continue;
          if (near(pm.x, pm.z, 1.8)) {
            candidate = pm.flirty
              ? { label: `Chat up ${pm.name || 'her'}`, icon: '💋', talk: true, action: () => this.flirtChat(pm) }
              : { label: pm.drunk ? 'Nudge the drunk' : 'Chat with the patron', icon: '💬', talk: true, action: () => this.patronChat(pm) };
            break;
          }
        }
      }
      // fireside couch (Obsidian 716): sit and listen to the fire
      const cp = this.dungeonMeshes.couchPos;
      if (!candidate && cp && !this.sittingOnCouch && near(cp.x, cp.z, 1.7)) {
        candidate = {
          label: 'Sit by the fire', icon: '🔥', action: () => {
            this.sittingOnCouch = true;
            this.player.pos.x = cp.x; this.player.pos.z = cp.z;
            this.player.visualAngle = Math.atan2(cp.faceX - cp.x, cp.faceZ - cp.z) - Math.PI / 2;
            audio.play('ui_click', { volume: 0.5 });
          },
        };
      }
      // Sit at any tavern stool (Obsidian 792): a sit/stand toggle on the
      // interact prompt. Offers the nearest EMPTY seat (no patron on it); once
      // seated, the same prompt becomes "Stand up" (and any movement also
      // stands - see the pinning block below).
      // A short cooldown between sit<->stand transitions so a held interact
      // button or residual joystick input can't rapidly oscillate the two
      // (Obsidian 805: "chirps and glitches me out of the chair every second").
      const seatReady = performance.now() >= (this._seatCd || 0);
      if (!candidate && this.seatedAt) {
        candidate = { label: 'Stand up', icon: '🧍', action: () => { if (performance.now() >= (this._seatCd || 0)) this._standFromSeat(); } };
      } else if (!candidate && seatReady && !this.sittingOnCouch && this.dungeonMeshes.seats) {
        let best = null, bestD = 1.4;
        for (const s of this.dungeonMeshes.seats) {
          const d = Math.hypot(s.x - this.player.pos.x, s.z - this.player.pos.z);
          if (d < bestD && !(this.dungeonMeshes.patronMeshes || []).some((pm) => Math.hypot(pm.x - s.x, pm.z - s.z) < 0.7)) { best = s; bestD = d; }
        }
        if (best) candidate = {
          label: best.kind === 'bar' ? 'Sit at the bar' : 'Sit down', icon: '🪑', action: () => {
            if (performance.now() < (this._seatCd || 0)) return;
            this.seatedAt = best;
            this._seatCd = performance.now() + 600; // block an immediate auto-stand / re-sit
            this.player.pos.x = best.x; this.player.pos.z = best.z;
            audio.play('ui_click', { volume: 0.5 });
          },
        };
      }
    }

    // While an NPC line is still audibly playing, hold every TALK prompt back
    // so "Talk to Old Fenwick" never floats over someone mid-sentence; the
    // next poll after the speech finishes brings it straight back. Portals,
    // stairs and doors are unaffected.
    if (candidate?.talk && this.npcSpeechActive()) candidate = null;

    this.setInteractable(candidate);
    if (this.wanderer && this.inTown && !this.inTavern) this.wanderer.update(dt, this);
    if (this.inTown && !this.inTavern) this.updateVendors(dt);

    // The reply overlay is NOT a modal (user request: keep moving with WASD /
    // touch while it's up) - wandering off from Rosalind simply closes it.
    if (this._flirtActive && this._flirtActive.mesh) {
      const fa = this._flirtActive;
      if (Math.hypot(this.player.pos.x - fa.x, this.player.pos.z - fa.z) > 5) this.ui.closeFlirt();
    }

    // Solid NPCs (Obsidian 849): the hero can't walk THROUGH tavern folk - a
    // cheap circle push-out against each patron. Skipped while seated/lying or
    // during scripted beats, whose position pins own the hero.
    if (this.inTavern && !this.inUpstairs && !this.seatedAt && !this.sittingOnCouch && !this._buyScene && this.state === 'playing') {
      const pp = this.player;
      for (const pmc of (this.dungeonMeshes.patronMeshes || [])) {
        const dx = pp.pos.x - pmc.x, dz = pp.pos.z - pmc.z;
        const d = Math.hypot(dx, dz);
        if (d >= 0.6) continue;
        // unit push direction; if exactly overlapping, default to south
        const ux = d > 0.001 ? dx / d : 0, uz = d > 0.001 ? dz / d : 1;
        const push = 0.6 - d;
        pp.pos.x += ux * push; pp.pos.z += uz * push;
      }
    }

    // Buy-her-a-drink scripted beat (Obsidian 822/847 rework): you and Rosalind
    // walk to two adjacent BAR STOOLS (room side - never through the counter),
    // both SIT, Magda serves two visible mugs on the counter, then the chat
    // resumes warmer with CHANGED choices (pm._hadDrink). player.pos is
    // overridden per-frame (couch pin trick) so input can't fight the walk.
    // Exhaustive outside-world sweep (864): async-loaded town props (bushes!)
    // can land inside the tavern volume at ANY time, so keep culling for the
    // whole stay instead of only during the first seconds after load.
    if (this.inTavern && !this.inUpstairs && this._cullTavernOutside && performance.now() > (this._cullNextAt || 0)) {
      this._cullNextAt = performance.now() + 2500;
      this._cullTavernOutside();
    }

    // Follow-upstairs walk (873): once upstairs, Rosalind LEADS the hero down
    // the hall to her room on foot (walk anim + footsteps for both), then the
    // implied beats play. A full position pin like the buy-drink beat so live
    // input can't fight the scripted walk.
    if (this._followScene && this.inUpstairs) {
      const fs = this._followScene, p = this.player, npc = fs.npc;
      if (!fs.arrived) {
        if (!fs.pWalk) fs.pWalk = { x: p.pos.x, z: p.pos.z };
        // player walks to the near side of the bed
        const pdx = fs.myTarget.x - fs.pWalk.x, pdz = fs.myTarget.z - fs.pWalk.z, pd = Math.hypot(pdx, pdz) || 1;
        let pMoving = false;
        if (pd > 0.14) {
          const s = Math.min(pd, 2.4 * dt);
          fs.pWalk.x += pdx / pd * s; fs.pWalk.z += pdz / pd * s;
          p.aimAngle = Math.atan2(pdz, pdx); p.faceAimTimer = 0.2;
          p.anim?.setLocomotion(1, dt);
          pMoving = true;
          fs.pStep -= dt; if (fs.pStep <= 0) { fs.pStep = 0.34; audio.play('footstep', { volume: 0.4 }); }
        }
        p.pos.x = fs.pWalk.x; p.pos.z = fs.pWalk.z;
        // Rosalind LEADS - she walks a touch faster to the far side
        let hMoving = false;
        if (npc) {
          const hdx = fs.herTarget.x - npc.mesh.position.x, hdz = fs.herTarget.z - npc.mesh.position.z, hd = Math.hypot(hdx, hdz) || 1;
          if (hd > 0.14) {
            const s = Math.min(hd, 2.7 * dt);
            npc.mesh.position.x += hdx / hd * s; npc.mesh.position.z += hdz / hd * s;
            npc.mesh.position.y = 0;
            npc.mesh.rotation.y = Math.atan2(hdx, hdz);
            npc.tick(dt, 2.7);
            hMoving = true;
            fs.hStep -= dt; if (fs.hStep <= 0) { fs.hStep = 0.36; audio.play('footstep', { volume: 0.25 }); }
          } else { npc.tick(dt, 0); }
        }
        if (!pMoving && !hMoving) {
          fs.arrived = true;
          if (npc) npc.mesh.rotation.y = Math.atan2(p.pos.x - npc.mesh.position.x, p.pos.z - npc.mesh.position.z);
          this._upstairsBeats(npc, fs.bedC);
          this._followScene = null;
        }
      }
    }

    if (this._buyScene && this.inTavern && !this.inUpstairs) {
      const bs = this._buyScene, pm = bs.pm, p = this.player;
      if (!bs.seats) {
        // choose two adjacent free stools once (skip stools other patrons occupy)
        const bar = (this.dungeonMeshes.seats || []).filter((s) => s.kind === 'bar')
          .filter((s) => !(this.dungeonMeshes.patronMeshes || []).some((o) => o !== pm && Math.hypot(o.x - s.x, o.z - s.z) < 0.7))
          .sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z));
        for (let i = 0; i < bar.length && !bs.seats; i++) {
          for (let j = i + 1; j < bar.length; j++) {
            if (Math.abs(bar[i].x - bar[j].x) < 1.8 && Math.abs(bar[i].z - bar[j].z) < 0.3) { bs.seats = [bar[i], bar[j]]; break; }
          }
        }
        if (!bs.seats && bar.length >= 2) bs.seats = [bar[0], bar[1]];
        // Packed bar (879): no two free stools at all -> they stand together at
        // the counter instead of the beat silently fizzling back into chat.
        if (!bs.seats) {
          const bk = this.dungeonMeshes.barkeepPos;
          if (bk) {
            bs.seats = [{ x: bk.x - 0.55, z: bk.z + 1.15, stand: true }, { x: bk.x + 0.55, z: bk.z + 1.15, stand: true }];
            roaster.sayGated(this, pm.name || 'Rosalind', 'Packed tonight! Squeeze in at the counter with me, love.', this._flirtVoice(), pm, { durationMs: 3200, priority: true });
          } else { this._buyScene = null; this.flirtChat(pm); }
        }
      }
      if (bs.seats) {
        const [sMine, sHers] = bs.seats;
        // player walks to their stool, then SITS via the normal seat pin.
        // bs.pWalk is the scripted position and p.pos is OVERWRITTEN with it
        // each frame (full pin, like the couch): if the walk merely stepped
        // p.pos, live input kept moving it too - the "rubber-banding into the
        // bar" the user saw.
        if (!bs.meSeated) {
          if (!bs.pWalk) bs.pWalk = { x: p.pos.x, z: p.pos.z };
          const pdx = sMine.x - bs.pWalk.x, pdz = sMine.z - bs.pWalk.z, pd = Math.hypot(pdx, pdz) || 1;
          if (pd > 0.12) {
            const s = Math.min(pd, 2.6 * dt);
            bs.pWalk.x += pdx / pd * s; bs.pWalk.z += pdz / pd * s;
            p.aimAngle = Math.atan2(pdz, pdx); p.faceAimTimer = 0.2;
            // A real WALK, not a glide (866): player.update already ran with no
            // input this frame (setLocomotion(0)), so re-drive the rig at walk
            // speed and play the same footstep loop normal movement uses.
            p.anim?.setLocomotion(1, dt);
            bs._stepT = (bs._stepT ?? 0) - dt;
            if (bs._stepT <= 0) { bs._stepT = 0.34; audio.play('footstep', { volume: 0.4 }); }
          } else {
            bs.meSeated = true; bs.pWalk = { x: sMine.x, z: sMine.z };
            // standing-at-the-counter fallback (879) skips the stool sit-pin
            if (!sMine.stand) { this.seatedAt = sMine; this._seatCd = performance.now() + 1200; }
          }
          p.pos.x = bs.pWalk.x; p.pos.z = bs.pWalk.z;
        }
        // Rosalind walks to hers, then perches on it
        if (!bs.herSeated) {
          const rdx = sHers.x - pm.mesh.position.x, rdz = sHers.z - pm.mesh.position.z, rd = Math.hypot(rdx, rdz) || 1;
          if (rd > 0.25) {
            const s = Math.min(rd, 2.4 * dt);
            pm.mesh.position.x += rdx / rd * s; pm.mesh.position.z += rdz / rd * s;
            // Feet ON the floor while she walks (866): if the chat started while
            // she was still perched on a seat, her group kept the perch height
            // and she floated to the bar mid-air. Ground her for the walk (the
            // arrival branch re-perches at stool height); face the direction
            // she's walking; and give her audible footsteps too.
            pm.mesh.position.y = 0;
            pm.mesh.rotation.y = Math.atan2(rdx, rdz);
            bs._herStepT = (bs._herStepT ?? 0) - dt;
            if (bs._herStepT <= 0) { bs._herStepT = 0.36; audio.play('footstep', { volume: 0.25 }); }
            pm.x = pm.mesh.position.x; pm.z = pm.mesh.position.z;
          } else {
            bs.herSeated = true;
            // stool perch height (788) - or feet on the floor when standing (879)
            pm.mesh.position.set(sHers.x, sHers.stand ? 0 : 0.46, sHers.z);
            pm.mesh.rotation.y = Math.PI; // face the counter like the other bar patrons
            pm.x = sHers.x; pm.z = sHers.z; pm.seat = sHers.stand ? null : 'bar';
          }
        }
        // both seated -> Magda serves two visible mugs, then the chat resumes
        if (bs.meSeated && bs.herSeated && !bs.served) {
          bs.served = true;
          if (this.dungeonMeshes.talkGate) {
            this.dungeonMeshes.talkGate.magdaUntil = performance.now() + 5000;
            this.dungeonMeshes.talkGate.magdaLook = { x: sMine.x, z: sMine.z, until: performance.now() + 5000 };
          }
          setTimeout(() => {
            if (!this.inTavern || this.inUpstairs) return;
            const mugGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.13, 8);
            const mugMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.4, roughness: 0.5 });
            for (const s of [sMine, sHers]) {
              const mug = new THREE.Mesh(mugGeo, mugMat);
              mug.position.set(s.x, 1.18, s.z - 0.62); // on the counter in front of the stool
              this.dungeonMeshes.group.add(mug);
            }
            audio.play('ui_click', { volume: 0.6 });
            roaster.sayGated(this, 'Magda', 'Two honeyed ales, loves. On the counter.', { female: true, vi: 3, pitch: 1.15, rate: 0.95, kokoro: 'af_kore', kSpeed: 0.95 }, this.dungeonMeshes.barkeepPos, { durationMs: 3600, priority: true });
            pm.affinity = Math.min(8, (pm.affinity || 0) + 1); // a drink warms her up
            pm._hadDrink = true;                               // choices change (847)
            this._npcWitness('bought Rosalind a drink at the bar');
            this.ui.floaters?.spawn(p.pos, '🍺 You buy Rosalind a drink', 'crit');
          }, 900);
          setTimeout(() => { this._buyScene = null; if (this.inTavern && !this.inUpstairs) this.flirtChat(pm); }, 5200);
        }
      }
    }

    // Lying in a bed upstairs (Obsidian 842b): pin onto the mattress, tip the
    // hero flat with the head at the headboard; deliberate movement gets up.
    if (this.inUpstairs && this._lyingBed) {
      const b = this._lyingBed, p = this.player;
      if (Math.abs(p.moveDir.x) > 0.25 || Math.abs(p.moveDir.z) > 0.25) {
        this._standFromBed();
      } else if (p.mesh) {
        // FULL transform lock (Obsidian 846). Two geometry facts drive this:
        // 1) Euler order: with the default XYZ, a yaw composes BEFORE the -90deg
        //    X tip, so it only spun the body around its own spine (the "facing
        //    backwards" flip) and the head pointed north no matter what. YXZ
        //    applies the yaw AFTER the tip, steering where the head points:
        //    yaw 0 -> head -Z (north pillow), yaw PI -> head +Z (south pillow).
        //    Face stays UP in both.
        // 2) The rig's origin is at the FEET. Centring the origin on the bed
        //    pushed the head a full body-length past the pillow ("head hanging
        //    off the bed"). Put the feet at the FOOT end instead so the body
        //    lies centred with the head ON the pillow.
        const northBed = (b.headAngle || 0) < 0; // north rooms: pillow at -Z
        p.pos.x = b.x; p.pos.z = b.z;
        p.mesh.rotation.order = 'YXZ';
        p.mesh.rotation.set(-Math.PI / 2, northBed ? 0 : Math.PI, 0);
        p.mesh.position.set(b.x, 0.58, northBed ? b.z + 0.85 : b.z - 0.85);
        p.visualAngle = b.headAngle || 0; // so it doesn't snap on stand
        // Hide held gear AND worn armour/hood while lying (874: "take my hoodie
        // off my head, my armor off") - and RE-ASSERT every frame, since the
        // anim/gear systems can re-show them (the "weapon still in the hand"
        // report). The regex is overlay-only: it never matches the base
        // Body/Head/Leg/skin meshes, so the hero still reads as themselves,
        // just undressed down to the underlayer.
        if (!this._lyWeaponHidden) {
          this._lyWeaponHidden = [];
          p.mesh.traverse((o) => {
            if (o.isMesh && /sword|mace|axe|bow|crossbow|wand|staff|hammer|dagger|blade|weapon|shield|spear|helmet|hat|hood|cape|cloak|pauldron|shoulder|bracer|belt|scabbard|quiver|blobshadow/i.test(o.name || '') && o.visible) {
              this._lyWeaponHidden.push(o);
            }
          });
        }
        for (const o of this._lyWeaponHidden) o.visible = false;
      }
    }

    // Seated on the fireside couch (716): pin to the seat, face the fire,
    // perch at cushion height; ANY movement input stands back up (stepping
    // off toward the rug so you don't stand up inside the couch).
    if (this.inTavern && this.sittingOnCouch) {
      const cp = this.dungeonMeshes.couchPos;
      const p = this.player;
      if (!cp) { this.sittingOnCouch = false; }
      else if (Math.abs(p.moveDir.x) > 0.01 || Math.abs(p.moveDir.z) > 0.01) {
        this.sittingOnCouch = false;
        p.pos.x = cp.x + 0.9; p.pos.z = cp.z;
      } else {
        p.pos.x = cp.x; p.pos.z = cp.z;
        p.aimAngle = Math.atan2(cp.faceZ - cp.z, cp.faceX - cp.x);
        p.faceAimTimer = Math.max(p.faceAimTimer, 0.3); // keep facing the fire
        p.mesh.position.y += 0.34; // perched on the cushion, not standing in it
      }
    } else if (this.sittingOnCouch) this.sittingOnCouch = false;

    // Seated on a tavern stool (Obsidian 792): pin to the seat, face the bar
    // or table, perch at seat height. DELIBERATE movement stands back up, but
    // only past the sit cooldown and above a real threshold - tiny residual
    // input / joystick drift must not eject the player (Obsidian 805).
    if (this.inTavern && this.seatedAt) {
      const s = this.seatedAt;
      const p = this.player;
      const moving = Math.hypot(p.moveDir.x, p.moveDir.z) > 0.4;
      if (moving && performance.now() >= (this._seatCd || 0)) {
        this._standFromSeat();
      } else {
        p.pos.x = s.x; p.pos.z = s.z;
        p.aimAngle = Math.atan2(s.faceZ - s.z, s.faceX - s.x);
        p.faceAimTimer = Math.max(p.faceAimTimer, 0.3);
        p.mesh.position.y += s.perchY; // perched on the stool, not standing through it
      }
    } else if (this.seatedAt) this.seatedAt = null;

    // hearth crackle loudness tracks distance to the fire (717). If the loop
    // never started (Obsidian 749: the AudioContext was suspended at tavern
    // entry, so startFireCrackle bailed silently and there was NO crackle at
    // all), keep retrying here - the context resumes on the next user
    // gesture and the fire starts talking.
    if (this.inTavern && this.dungeonMeshes.hearthPos) {
      if (!audio._fire) audio.startFireCrackle();
      const h = this.dungeonMeshes.hearthPos;
      const d = Math.hypot(this.player.pos.x - h.x, this.player.pos.z - h.z);
      audio.setFireCrackleLevel(Math.max(0.06, Math.min(1, 2.2 / Math.max(1, d - 0.5))));
    }

    // Rosalind approaches YOU the first time (Obsidian 828): the very first time
    // you linger near her in the tavern she leaves her spot, walks over and opens
    // the conversation herself (she speaks first) - you never have to approach her
    // that first time. Once met, she stays put and you talk to her normally.
    if (this.inTavern && !this.inUpstairs && !this._rosalindMet && this.state === 'playing' && !this.npcSpeechActive()) {
      const rp = (this.dungeonMeshes.patronMeshes || []).find((p) => p.flirty);
      if (rp && rp.mesh) {
        const dx = this.player.pos.x - rp.mesh.position.x, dz = this.player.pos.z - rp.mesh.position.z;
        const dist = Math.hypot(dx, dz) || 1;
        this._tavernDwell = (this._tavernDwell || 0) + dt;
        if (this._rosalindApproaching || (this._tavernDwell > 2.5 && dist < 9)) {
          this._rosalindApproaching = true;
          rp.talkUntil = performance.now() + 1500; // face you as she comes over
          if (dist > 2.0) {
            const step = Math.min(dist - 1.9, 1.7 * dt);
            rp.mesh.position.x += (dx / dist) * step;
            rp.mesh.position.z += (dz / dist) * step;
            rp.x = rp.mesh.position.x; rp.z = rp.mesh.position.z; // keep interact/anchor in sync
          } else {
            this._rosalindMet = true;
            this._rosalindApproaching = false;
            this.flirtChat(rp); // she opens the conversation herself
          }
        }
      }
    }

    // Ambient table-talk (Obsidian 718): every so often the regulars hold a
    // short exchange with each other - three distinct voices, one turn at a
    // time, each line anchored (bubble + caption) at its actual speaker.
    // Turns wait for the previous line's audio to finish (npcSpeechActive)
    // plus a small beat, and the whole thing yields instantly to any player
    // conversation (talk prompts already gate on npcSpeechActive too).
    if (this.inTavern && !this.inUpstairs && roaster.enabled) {
      // cast.lite = KittenTTS voice id (738): ambient chatter synthesizes on
      // the tiny CPU engine; kokoro ids remain the fallback voices.
      const speakerOf = (who) => {
        if (who === 'magda') return { name: 'Magda', cast: { female: true, vi: 3, pitch: 1.15, rate: 0.95, kokoro: 'af_kore', kSpeed: 0.95, lite: 'expr-voice-5-f' }, pos: this.dungeonMeshes.barkeepPos };
        // Rosalind takes part in the room's banter too (857), in her own voice.
        if (who === 'rosalind') {
          const rp = (this.dungeonMeshes.patronMeshes || []).find((p) => p.flirty);
          return rp ? { name: 'Rosalind', cast: { ...this._flirtVoice(), lite: 'expr-voice-4-f' }, pos: rp } : null;
        }
        const pm = (this.dungeonMeshes.patronMeshes || []).find((p) => !p.flirty && (who === 'drunk') === !!p.drunk);
        if (!pm) return null;
        return who === 'drunk'
          ? { name: 'Tipsy Regular', cast: { female: false, vi: 6, pitch: 1.05, rate: 0.8, kokoro: 'bm_daniel', kSpeed: 0.82, lite: 'expr-voice-2-m' }, pos: pm }
          : { name: 'Tavern Patron', cast: { female: true, vi: 3, pitch: 1.05, rate: 1.0, kokoro: 'af_sarah', kSpeed: 1.0, lite: 'expr-voice-3-f' }, pos: pm };
      };
      // visitor speaker (750): resolved from the rotating-visitor driver so a
      // fresh arrival can trade a greeting with the nearest patron
      const visitorState = this.dungeonMeshes.smokePuffs?.find((p) => p._vs)?._vs;
      const speakerOfAny = (who) => (who === '_visitor' && visitorState?.group)
        ? { name: 'Traveler', cast: { female: false, vi: 5, pitch: 1.0, rate: 0.95, kokoro: 'am_adam', kSpeed: 0.95, lite: 'expr-voice-4-m' }, pos: visitorState.group.position }
        : speakerOf(who);
      if (this._tavernConvo) {
        this._convoGap -= dt;
        if (this._convoGap <= 0 && !this.npcSpeechActive()) {
          const turn = this._tavernConvo[this._convoIdx++];
          if (!turn) { this._tavernConvo = null; this._convoT = 25 + Math.random() * 25; }
          else {
            // Social memory (Obsidian 787): the regulars NOTICE repeats. If this
            // exact line was said within the last 5 minutes, another participant
            // calls it out right after ("you said that already") and their
            // relationship sours a notch - at rel <= -3 the callouts turn openly
            // hostile, so rivalries develop organically from the room's own
            // banter loops. Callouts themselves are never called out.
            if (!turn._callout) {
              const nowMs = performance.now();
              this._tavernSaid = this._tavernSaid || new Map();
              const saidKey = turn.who + '|' + turn.text;
              const lastSaid = this._tavernSaid.get(saidKey);
              this._tavernSaid.set(saidKey, nowMs);
              if (lastSaid !== undefined && nowMs - lastSaid < 300000) {
                const others = ['magda', 'drunk', 'patron', 'rosalind'].filter((w) => w !== turn.who && speakerOfAny(w));
                if (others.length) {
                  const caller = others[Math.floor(Math.random() * others.length)];
                  this._npcRel = this._npcRel || {};
                  const pairKey = [turn.who, caller].sort().join('|');
                  this._npcRel[pairKey] = (this._npcRel[pairKey] || 0) - 1;
                  const hostile = this._npcRel[pairKey] <= -3;
                  const callout = hostile
                    ? this._pick(['Stars above, not this AGAIN.', 'Say it a third time and I\'m moving tables.', 'Someone drown him in his own mug, please.'])
                    : this._pick(['You said that already, love.', 'Aye, you\'ve told us. Twice now.', 'We heard you the first time, dear.']);
                  this._tavernConvo.splice(this._convoIdx, 0, { who: caller, text: callout, _callout: true });
                }
              }
            }
            const spk = speakerOfAny(turn.who);
            if (spk) {
              roaster.sayGated(this, spk.name, turn.text, spk.cast, spk.pos, { durationMs: 3400 });
              // Everyone in the exchange looks at whoever is talking, and
              // the speaker looks back at the nearest other participant
              // (Obsidian 750: they were chatting into the air).
              const until = performance.now() + 5200;
              const parts = [...new Set(this._tavernConvo.map((t) => t.who))];
              const others = parts.filter((w) => w !== turn.who).map(speakerOfAny).filter(Boolean);
              const nearestOther = others.sort((a, b) =>
                Math.hypot(a.pos.x - spk.pos.x, a.pos.z - spk.pos.z) - Math.hypot(b.pos.x - spk.pos.x, b.pos.z - spk.pos.z))[0];
              for (const who of parts) {
                const part = speakerOfAny(who);
                if (!part) continue;
                const target = who === turn.who ? nearestOther?.pos : spk.pos;
                if (!target) continue;
                if (who === 'magda') {
                  if (this.dungeonMeshes.talkGate) this.dungeonMeshes.talkGate.magdaLook = { x: target.x, z: target.z, until };
                } else if (who !== '_visitor') {
                  part.pos.lookTo = { x: target.x, z: target.z, until }; // pmEntry
                } else if (visitorState?.group) {
                  visitorState.group.rotation.y = Math.atan2(target.x - part.pos.x, target.z - part.pos.z);
                }
              }
            }
            this._convoGap = 1.2 + Math.random() * 0.8;
          }
        }
      } else if (visitorState?.mode === 'linger' && visitorState.group && !visitorState._greeted && !this.npcSpeechActive()) {
        // A fresh visitor greets the room and the nearest patron answers (750)
        visitorState._greeted = true;
        const pms = this.dungeonMeshes.patronMeshes || [];
        const nearestPm = pms.slice().sort((a, b) =>
          Math.hypot(a.x - visitorState.group.position.x, a.z - visitorState.group.position.z)
          - Math.hypot(b.x - visitorState.group.position.x, b.z - visitorState.group.position.z))[0];
        const G = [
          ['Evening, all. Any room by the fire?', 'Always room, traveler. Mind your boots.'],
          ['Long road behind me. Is the ale as good as they say?', 'Better. Magda pours honest.'],
          ['Cold out there tonight.', 'Then you found the right door. Sit.'],
        ];
        const pick = G[Math.floor(Math.random() * G.length)];
        this._tavernConvo = [
          { who: '_visitor', text: pick[0] },
          { who: nearestPm?.drunk ? 'drunk' : 'patron', text: pick[1] },
        ];
        this._convoIdx = 0;
        this._convoGap = 0.6;
      } else {
        this._convoT = (this._convoT ?? 14) - dt;
        if (this._convoT <= 0 && !this.npcSpeechActive()) {
          // LLM-FIRST (884): the room's banter is written by the LLM whenever
          // it's reachable - a small pool is kept topped up ahead of need so
          // every exchange is already generated when its turn comes. The
          // prewarmed canned trees are strictly the can't-reach-LLM fallback.
          this._llmConvoPool = this._llmConvoPool || [];
          if (this._llmConvoPool.length < 2) this._fetchFreshConvo();
          const plans = this._tavernConvoPlans;
          this._tavernConvo = this._llmConvoPool.length
            ? this._llmConvoPool.shift()
            : (plans?.length ? plans[(this._tavernPlanIdx++) % plans.length] : roaster.composeTavernConvo());
          this._convoIdx = 0;
          this._convoGap = 0;
        }
      }
    } else if (this._tavernConvo) { this._tavernConvo = null; }

    // tavern smoke + hearth idle animation data from the mesh builder
    const puffs = this.dungeonMeshes.smokePuffs;
    if (puffs?.length) {
      for (const puff of puffs) {
        puff.phase = (puff.phase || 0) + dt * (puff.speed || 0.4);
        if (puff.kind === 'mote') {
          // Per-act ambience: same drifting-particle system, different motion
          // per theme (dust/spores/embers/wisps/bubbles).
          const style = puff.style || 'dust';
          if (style === 'ember') {
            // rising embers: drift up, fading out, then reset to the ground
            puff.rise = ((puff.rise || 0) + dt * 0.4) % 1.7;
            puff.mesh.position.set(
              puff.cx + Math.cos(puff.drift + puff.phase * 0.6) * 0.2,
              puff.baseY + puff.rise,
              puff.cz + Math.sin(puff.drift + puff.phase * 0.5) * 0.2,
            );
            puff.mesh.material.opacity = puff.baseOpacity * (1 - puff.rise / 1.7);
          } else if (style === 'bubble') {
            // slow rising bubbles with a lazy wobble
            puff.rise = ((puff.rise || 0) + dt * 0.15) % 1.5;
            puff.mesh.position.set(
              puff.cx + Math.cos(puff.drift + puff.phase * 0.35) * 0.2,
              puff.baseY + puff.rise,
              puff.cz + Math.sin(puff.drift + puff.phase * 0.3) * 0.2,
            );
          } else if (style === 'spore') {
            // spores sink slowly as they drift, like falling dust
            puff.rise = ((puff.rise || 0) - dt * 0.12) % 0.9;
            puff.mesh.position.set(
              puff.cx + Math.cos(puff.drift + puff.phase * 0.45) * 0.3,
              puff.baseY + puff.rise + Math.sin(puff.phase * 0.6) * 0.15,
              puff.cz + Math.sin(puff.drift + puff.phase * 0.35) * 0.3,
            );
          } else if (style === 'wisp') {
            // faint wisps wander wide and pulse in and out of visibility
            puff.mesh.position.set(
              puff.cx + Math.cos(puff.drift + puff.phase * 0.25) * 0.5,
              puff.baseY + Math.sin(puff.phase * 0.6) * 0.35,
              puff.cz + Math.sin(puff.drift + puff.phase * 0.2) * 0.5,
            );
            puff.mesh.material.opacity = puff.baseOpacity * (0.5 + Math.sin(puff.phase * 1.3) * 0.5);
          } else {
            // dust: gentle lissajous wander around its home point
            puff.mesh.position.set(
              puff.cx + Math.cos(puff.drift + puff.phase * 0.5) * 0.32,
              puff.baseY + Math.sin(puff.phase * 0.8) * 0.25,
              puff.cz + Math.sin(puff.drift + puff.phase * 0.4) * 0.32,
            );
          }
          continue;
        }
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
          gn: p.gender, sk: p.skinTone, hc: p.hairColor, ec: p.eyeColor, fs: p.faceShape, hs: p.hairStyle,
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
      gn: p.gender, sk: p.skinTone, hc: p.hairColor, ec: p.eyeColor, fs: p.faceShape, hs: p.hairStyle,
      lvl: p.level, hp: Math.round(p.hp), mhp: p.maxHp, au: this.heroAuraTier(),
    }];
    for (const [id, rp] of this.remotePlayers) {
      pl.push({
        id, x: +rp.target.x.toFixed(2), z: +rp.target.z.toFixed(2),
        aim: +(rp.aim || 0).toFixed(2), mv: rp.moving ? 1 : 0, dead: rp.dead ? 1 : 0,
        cls: rp.cls, nm: rp.name, aw: rp.zone || 0,
        gn: rp.gender, sk: rp.skinTone, hc: rp.hairColor, ec: rp.eyeColor, fs: rp.faceShape, hs: rp.hairStyle,
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
    // flicker — layered sines (not a random strobe) for a believable flame.
    // TOWN LAMP POSTS ARE STEADY (Obsidian 729): they're oil/glass lamps, not
    // open flames - no intensity flicker, no positional jitter, no pulsing
    // glass - just a constant pool of light scaled by the day/night cycle.
    // Dungeon torches and the tavern hearth keep the living-flame treatment.
    const now = performance.now() / 1000;
    const steadyLamps = this.inTown && !this.inTavern;
    // In town the lamp-post lights follow the day/night cycle: full at night,
    // near-off by day. In the dungeon they always burn (nightScale stays 1).
    const nightScale = steadyLamps ? (this._townLampNight ?? 1) : 1;
    this.torchLights.forEach((l, i) => {
      l.intensity = steadyLamps ? 14 * nightScale
        : (14 + Math.sin(now * 9 + i * 1.7) * 2.4 + Math.sin(now * 23 + i * 3.1) * 1.4) * nightScale;
      // tiny positional jitter (around the assigned torch base) so shadows shiver
      if (!steadyLamps && l.visible && l._bx !== undefined) {
        l.position.x = l._bx + Math.sin(now * 17 + i) * 0.04;
        l.position.z = l._bz + Math.cos(now * 19 + i * 1.3) * 0.04;
      } else if (steadyLamps && l.visible && l._bx !== undefined) {
        l.position.x = l._bx; l.position.z = l._bz;
      }
    });
    if (steadyLamps) return; // no flame/glow pulse on lamp glass either
    for (let i = 0; i < torches.length; i++) {
      const f = torches[i].flame;
      if (f) {
        const s = 1 + Math.sin(now * 11 + i * 2.3) * 0.18;
        f.scale.set(s, 1 + Math.sin(now * 13 + i) * 0.25, s);
      }
      // the glow-orb bloom pulses in sync with the flame core so it reads as
      // one living flame instead of two independently animated pieces
      const gl = torches[i].glow;
      if (gl) {
        const gs = 0.85 + Math.sin(now * 9 + i * 1.9) * 0.15;
        gl.scale.setScalar((gl.userData.baseScale ??= gl.scale.x) * gs);
        gl.material.opacity = 0.55 + Math.sin(now * 15 + i * 2.1) * 0.15;
      }
    }
  }
}
