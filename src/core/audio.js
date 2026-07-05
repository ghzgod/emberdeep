// WebAudio engine: loads a manifest of real sound files, plays SFX with
// pitch variation + distance attenuation, and crossfades music tracks.
// Missing files fail gracefully (logged once, game keeps running).

// Logical sound name -> one or more files (random pick = natural variation).
const MANIFEST = {
  // Player weapons
  sword_swing:   ['audio/sword_swing1.mp3', 'audio/sword_swing2.mp3', 'audio/sword_swing3.mp3'],
  sword_hit:     ['audio/sword_hit1.mp3', 'audio/sword_hit2.mp3'],
  bow_shot:      ['audio/bow_shot1.mp3', 'audio/bow_shot2.mp3'],
  arrow_hit:     ['audio/arrow_hit1.mp3'],
  magic_bolt:    ['audio/magic_bolt1.mp3', 'audio/magic_bolt2.mp3'],
  // Spells / abilities
  fireball_cast: ['audio/fireball_cast.mp3'],
  explosion:     ['audio/explosion.mp3'],
  frost_nova:    ['audio/frost_nova.mp3'],
  blink:         ['audio/blink.mp3'],
  arcane_storm:  ['audio/arcane_storm.mp3'],
  charge:        ['audio/charge.mp3'],
  whirlwind:     ['audio/whirlwind.mp3'],
  shield_block:  ['audio/shield_block.mp3'],
  war_cry:       ['audio/war_cry.mp3'],
  multishot:     ['audio/multishot.mp3'],
  dodge_roll:    ['audio/dodge_roll.mp3'],
  trap_place:    ['audio/trap_place.mp3'],
  trap_trigger:  ['audio/trap_trigger.mp3'],
  rain_arrows:   ['audio/rain_arrows.mp3'],
  // Enemies
  skeleton_hurt:  ['audio/skeleton_hurt1.mp3', 'audio/skeleton_hurt2.mp3'],
  skeleton_death: ['audio/skeleton_death.mp3'],
  imp_hurt:       ['audio/imp_hurt.mp3'],
  imp_death:      ['audio/imp_death.mp3'],
  imp_shoot:      ['audio/imp_shoot.mp3'],
  spider_hurt:    ['audio/spider_hurt.mp3'],
  spider_death:   ['audio/spider_death.mp3'],
  golem_hurt:     ['audio/golem_hurt.mp3'],
  golem_death:    ['audio/golem_death.mp3'],
  golem_slam:     ['audio/golem_slam.mp3'],
  boss_roar:      ['audio/boss_roar.mp3'],
  boss_death:     ['audio/boss_death.mp3'],
  // Player state
  player_hurt:  ['audio/player_hurt1.mp3', 'audio/player_hurt2.mp3'],
  player_death: ['audio/player_death.mp3'],
  footstep:     ['audio/footstep1.mp3', 'audio/footstep2.mp3', 'audio/footstep3.mp3', 'audio/footstep4.mp3'],
  level_up:     ['audio/level_up.mp3'],
  // World / loot
  chest_open:   ['audio/chest_open.mp3'],
  coin_pickup:  ['audio/coin_pickup1.mp3', 'audio/coin_pickup2.mp3'],
  potion_pickup:['audio/potion_pickup.mp3'],
  potion_drink: ['audio/potion_drink.mp3'],
  gear_pickup:  ['audio/gear_pickup.mp3'],
  equip:        ['audio/equip.mp3'],
  door_open:    ['audio/door_open.mp3'],
  stairs:       ['audio/stairs.mp3'],
  // NOTE: UI sounds (ui_hover/click/open/close) are SYNTHESIZED procedurally in
  // _playUI() — the old mp3s sounded harsh. They intentionally have no manifest
  // entry so they aren't fetched.
};

// Soft procedural UI blips (WebAudio) — gentle sine/triangle tones with a quick
// attack + exponential decay. Far more pleasant than the old sampled clicks.
const UI_SYNTH = {
  ui_hover: { type: 'sine',     f0: 680, f1: 680, dur: 0.05, gain: 0.045 },
  ui_click: { type: 'triangle', f0: 540, f1: 680, dur: 0.08, gain: 0.10 },
  ui_open:  { type: 'sine',     f0: 440, f1: 680, dur: 0.15, gain: 0.09 },
  ui_close: { type: 'sine',     f0: 640, f1: 400, dur: 0.15, gain: 0.09 },
};

const MUSIC = {
  dungeon: 'audio/music_dungeon.mp3',
  boss:    'audio/music_boss.mp3',
  tavern:  'audio/music_tavern.mp3',
};

const AUDIBLE_RANGE = 26; // world units; beyond this SFX are silent

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.musicBuffers = new Map();
    this.currentMusic = null;   // { source, gain, name }
    this.warned = new Set();
    this.listener = { x: 0, z: 0 };
    this.volumes = { master: 0.8, music: 0.6, sfx: 0.9 };
    this._lastPlay = new Map(); // throttle spammy sounds
  }

  // Must be called after a user gesture (browser autoplay policy).
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.connect(this.masterGain);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.masterGain);
    this.applyVolumes();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.masterGain.gain.value = this.volumes.master;
    this.musicGain.gain.value = this.volumes.music;
    this.sfxGain.gain.value = this.volumes.sfx;
  }

  setVolume(channel, value01) {
    this.volumes[channel] = value01;
    this.applyVolumes();
  }

  async loadAll(onProgress) {
    this.init();
    const jobs = [];
    for (const [name, files] of Object.entries(MANIFEST)) {
      files.forEach((file, i) => jobs.push({ key: `${name}#${i}`, file }));
    }
    for (const [name, file] of Object.entries(MUSIC)) {
      jobs.push({ key: `music:${name}`, file, music: true });
    }
    let done = 0;
    await Promise.all(jobs.map(async (job) => {
      try {
        const res = await fetch(import.meta.env.BASE_URL + job.file);
        if (!res.ok) throw new Error(res.status);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        if (job.music) this.musicBuffers.set(job.key.slice(6), buf);
        else this.buffers.set(job.key, buf);
      } catch {
        if (!this.warned.has(job.file)) {
          this.warned.add(job.file);
          console.warn(`Audio missing: ${job.file}`);
        }
      }
      done++;
      if (onProgress) onProgress(done / jobs.length);
    }));
  }

  setListener(x, z) { this.listener.x = x; this.listener.z = z; }

  // play('sword_swing', { pos: {x, z}, volume, rate, throttleMs })
  // Procedural UI blip: soft osc tone with a quick attack + exponential decay.
  _playUI(name) {
    const s = UI_SYNTH[name];
    if (!this.ctx || this.ctx.state !== 'running' || !s) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.f0, t);
    if (s.f1 !== s.f0) osc.frequency.exponentialRampToValueAtTime(s.f1, t + s.dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(s.gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
    osc.connect(g);
    g.connect(this.sfxGain || this.ctx.destination);
    osc.start(t);
    osc.stop(t + s.dur + 0.03);
  }

  play(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    // UI blips are synthesized, not sampled — softer and more pleasant.
    if (UI_SYNTH[name]) { this._playUI(name); return; }
    const variants = MANIFEST[name];
    if (!variants) return;

    if (opts.throttleMs) {
      const last = this._lastPlay.get(name) || 0;
      if (performance.now() - last < opts.throttleMs) return;
      this._lastPlay.set(name, performance.now());
    }

    const idx = Math.floor(Math.random() * variants.length);
    const buf = this.buffers.get(`${name}#${idx}`) || this.buffers.get(`${name}#0`);
    if (!buf) return;

    let vol = opts.volume ?? 1;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = vol;
    src.connect(gain);
    gain.connect(this.sfxGain);
    src.start();
  }

  playMusic(name, fadeSec = 1.5) {
    if (!this.ctx) return;
    if (this.currentMusic?.name === name) return;
    const buf = this.musicBuffers.get(name);

    // Fade out whatever is playing.
    if (this.currentMusic) {
      const old = this.currentMusic;
      old.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fadeSec);
      setTimeout(() => { try { old.source.stop(); } catch {} }, fadeSec * 1000 + 100);
      this.currentMusic = null;
    }
    if (!buf) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + fadeSec);
    source.connect(gain);
    gain.connect(this.musicGain);
    source.start();
    this.currentMusic = { source, gain, name };
  }

  stopMusic(fadeSec = 1) {
    if (!this.ctx || !this.currentMusic) return;
    const old = this.currentMusic;
    old.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fadeSec);
    setTimeout(() => { try { old.source.stop(); } catch {} }, fadeSec * 1000 + 100);
    this.currentMusic = null;
  }
}

export const audio = new AudioEngine();
