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
    // procedural ambience bed rides on the music channel (respects that slider)
    this.ambGain = this.ctx.createGain();
    this.ambGain.gain.value = 0.9;
    this.ambGain.connect(this.musicGain);
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

  // ---------- Procedural ambience beds (per area, no audio assets) ----------
  _noise(seconds = 3) {
    if (this._noiseBuf) return this._noiseBuf;
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } // brownish
    this._noiseBuf = buf;
    return buf;
  }

  // profile: town | tavern | dungeon-wet | dungeon-dry
  startAmbience(profile) {
    if (!this.ctx) return;
    if (this._amb?.profile === profile) return;
    this.stopAmbience();
    const P = AMBIENCE[profile];
    if (!P) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = P.freq; filt.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001; g.gain.linearRampToValueAtTime(P.bed, t + 1.5);
    src.connect(filt); filt.connect(g); g.connect(this.ambGain);
    src.start();
    let drone = null;
    if (P.drone) {
      drone = this.ctx.createOscillator(); drone.type = 'sine'; drone.frequency.value = P.drone;
      const dg = this.ctx.createGain(); dg.gain.value = P.droneGain || 0.05;
      drone.connect(dg); dg.connect(this.ambGain); drone.start();
    }
    const timer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      if (P.crackle && Math.random() < P.crackle) this._crackle();
      if (P.chirp && Math.random() < P.chirp) this._chirp();
      if (P.drip && Math.random() < P.drip) this._drip();
    }, 340);
    this._amb = { profile, src, g, drone, timer };
  }

  stopAmbience() {
    const a = this._amb;
    if (!a) return;
    clearInterval(a.timer);
    try { a.g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.6); } catch { /* */ }
    setTimeout(() => { try { a.src.stop(); } catch {} try { a.drone?.stop(); } catch {} }, 700);
    this._amb = null;
  }

  _crackle() { // a short fire pop
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200 + Math.random() * 2200; f.Q.value = 2;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 + Math.random() * 0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(f); f.connect(g); g.connect(this.ambGain);
    src.start(t, Math.random() * 2, 0.09);
  }

  _chirp() { // a couple of quick bird notes
    const t = this.ctx.currentTime; const base = 2000 + Math.random() * 1600;
    const notes = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < notes; i++) {
      const tt = t + i * 0.08; const o = this.ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(base * (1 + i * 0.12), tt);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.03, tt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.08);
      o.connect(g); g.connect(this.ambGain); o.start(tt); o.stop(tt + 0.1);
    }
  }

  _drip() { // a single cave water drop (wet acts only)
    const t = this.ctx.currentTime; const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(this.ambGain); o.start(t); o.stop(t + 0.2);
  }
}

// Per-area ambience recipes. Drips live ONLY in the wet-cave acts.
const AMBIENCE = {
  town:          { freq: 480, bed: 0.05, chirp: 0.05 },                          // open square: wind + birds
  tavern:        { freq: 700, bed: 0.045, crackle: 0.5 },                         // room tone + hearth crackle
  'dungeon-wet': { freq: 300, bed: 0.05, drone: 62, droneGain: 0.05, drip: 0.05 }, // stone/moss caves
  'dungeon-dry': { freq: 260, bed: 0.045, drone: 55, droneGain: 0.06 },           // ember/cursed/abyss drone
};

export const audio = new AudioEngine();
