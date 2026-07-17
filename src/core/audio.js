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
  // blink is SYNTHESIZED in blinkSound() (a quick shimmer/whoosh teleport):
  // the old sampled clip sounded wrong. No manifest entry so it isn't fetched;
  // play('blink') is routed to the synth in play().
  arcane_storm:  ['audio/arcane_storm.mp3'],
  charge:        ['audio/charge.mp3'],
  whirlwind:     ['audio/whirlwind.mp3'],
  shield_block:  ['audio/shield_block.mp3'],
  // war_cry is SYNTHESIZED in warCrySound() (a scary gendered battle yell): the
  // old sampled clip was a weak grunt. No manifest entry so it isn't fetched;
  // play('war_cry', { gender }) is routed to the synth in play().
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
  // generic fallbacks (kept: they cover any act track that fails to load)
  dungeon: 'audio/music_dungeon.mp3',
  boss:    'audio/music_boss.mp3',
  tavern:  'audio/music_tavern.mp3',
  // One themed exploration bed per act (see CREDITS.md for sources; all CC0):
  // 1 old halls / crypt, 2 rotting damp depths, 3 ember vaults, 4 sunless
  // court, 5 abyssal throne (also used for the endless post-victory floors).
  dungeon1: 'audio/music_act1.mp3',
  dungeon2: 'audio/music_act2.mp3',
  dungeon3: 'audio/music_act3.mp3',
  dungeon4: 'audio/music_act4.mp3',
  dungeon5: 'audio/music_act5.mp3',
  // One battle loop per act lord; boss5 (The Dungeon Lord) is the most epic.
  boss1: 'audio/music_boss1.mp3',
  boss2: 'audio/music_boss2.mp3',
  boss3: 'audio/music_boss3.mp3',
  boss4: 'audio/music_boss4.mp3',
  boss5: 'audio/music_boss5.mp3',
};

const AUDIBLE_RANGE = 26; // world units; beyond this SFX are silent

// Per-enemy-type attack voice: every type gets its OWN swing/cast identity
// instead of witch/warlock parroting the imp's shoot clip and melee types
// lunging silently. `clip` entries reuse an existing manifest sound at a
// FIXED per-type pitch (the deathScream pitch-shift approach, but a stable
// signature per type rather than a random step); `synth` entries are short
// procedural one-shots (see _attackSynth) built from the same noise and
// oscillator helpers the ghost moans use, so no new assets are fetched.
// The golem is intentionally absent: its slam (golem_slam, played directly
// by enemies.js at windup + impact) is already a unique identity. Bosses and
// the dragon likewise keep their own sounds in their own code paths.
const ENEMY_ATTACK_SOUNDS = {
  skeleton: { clip: 'sword_swing', rate: 0.82, volume: 0.85 }, // slow bony sword swipe
  spider:   { synth: 'hiss' },                                  // chitinous lunge hiss
  imp:      { clip: 'imp_shoot', rate: 1.0 },                   // its original fireball spit
  ghost:    { synth: 'chill' },                                  // icy exhaled swipe
  ghoul:    { synth: 'bite' },                                   // wet snapping bite
  witch:    { clip: 'magic_bolt', rate: 1.35, volume: 0.85 },   // sharp crackling hex
  warlock:  { clip: 'fireball_cast', rate: 0.68, volume: 0.9 }, // low shadow surge
  demon:    { synth: 'claw' },                                   // heavy claw whoosh
};

// Ghost ambient one-shots (see ghostMoan() below) -- an assortment so wraiths
// don't repeat the same clip every time.
const GHOST_MOAN_VARIANTS = ['moan', 'wail', 'keen', 'rattle'];

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
    this._reverbIR = null;      // lazily-built cavern impulse response (shared)
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

  // Quick teleport shimmer/whoosh (synthesized, no asset). A short filtered
  // noise whoosh sweeping upward for the "leave", a bright tri chime sweeping
  // down for the "arrive", plus a faint high shimmer so it sparkles. ~0.34s,
  // routed through sfxGain with the same distance attenuation as play().
  blinkSound(opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    let vol = opts.volume ?? 1;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return;
    const out = this.sfxGain || this.ctx.destination;

    // (1) whoosh: bandpassed noise sweeping up as the caster blurs away
    const dur = 0.2;
    const nz = this.ctx.createBufferSource(); nz.buffer = this._noise();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(3600, t + dur);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.12 * vol, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    nz.connect(bp); bp.connect(ng); ng.connect(out);
    nz.start(t, Math.random() * 1.5); nz.stop(t + dur + 0.02);

    // (2) arrive chime: bright triangle sweeping down, snappy attack
    const ct = t + 0.06, cdur = 0.28;
    const osc = this.ctx.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(1760, ct);
    osc.frequency.exponentialRampToValueAtTime(660, ct + cdur);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, ct);
    og.gain.exponentialRampToValueAtTime(0.16 * vol, ct + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, ct + cdur);
    osc.connect(og); og.connect(out);
    osc.start(ct); osc.stop(ct + cdur + 0.02);

    // (3) shimmer: faint high sine an octave up with quick vibrato, sparkles
    const sh = this.ctx.createOscillator(); sh.type = 'sine';
    sh.frequency.setValueAtTime(3520, ct);
    sh.frequency.linearRampToValueAtTime(2640, ct + cdur);
    const vib = this.ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 22;
    const vibG = this.ctx.createGain(); vibG.gain.value = 90;
    vib.connect(vibG); vibG.connect(sh.frequency);
    const shg = this.ctx.createGain();
    shg.gain.setValueAtTime(0.0001, ct);
    shg.gain.exponentialRampToValueAtTime(0.05 * vol, ct + 0.015);
    shg.gain.exponentialRampToValueAtTime(0.0001, ct + cdur * 0.9);
    sh.connect(shg); shg.connect(out);
    sh.start(ct); vib.start(ct);
    sh.stop(ct + cdur + 0.02); vib.stop(ct + cdur + 0.02);
  }

  // Paper/parchment rustle (notice board opening, synthesized, no asset): a
  // handful of quick high-passed noise bursts with staggered random timing and
  // shifting corner frequencies, mimicking a stiff sheet being unrolled and
  // smoothed flat. Additive-only (does not touch MUSIC/ambience). Routed
  // through sfxGain like any other one-shot SFX.
  parchmentSound(opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const vol = (opts.volume ?? 1) * 0.55;
    const out = this.sfxGain || this.ctx.destination;
    const bursts = 6;
    for (let i = 0; i < bursts; i++) {
      const start = t + i * 0.045 + Math.random() * 0.02;
      const dur = 0.04 + Math.random() * 0.05;
      const nz = this.ctx.createBufferSource(); nz.buffer = this._noise();
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2000 + Math.random() * 2200;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18 * vol, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      nz.connect(hp); hp.connect(g); g.connect(out);
      nz.start(start, Math.random() * 1.5); nz.stop(start + dur + 0.02);
    }
  }

  // Lazily-built cavern reverb: a ConvolverNode fed a procedurally-synthesized
  // impulse response (exponentially-decaying stereo noise, ~2s) so big moments
  // ring out down the halls. The IR is generated in code (no asset) and cached,
  // and the convolver itself is shared so repeated calls reuse one node. Returns
  // the convolver, or null if the context isn't up. Reusable by any big cue;
  // only the war cry is wired to it for now.
  _reverb() {
    if (!this.ctx) return null;
    if (this._reverbNode) return this._reverbNode;
    if (!this._reverbIR) {
      const dur = 2.0;
      const len = Math.floor(this.ctx.sampleRate * dur);
      const ir = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          // decaying noise: early bloom then a long exponential tail
          const decay = Math.pow(1 - i / len, 2.4);
          d[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      this._reverbIR = ir;
    }
    const conv = this.ctx.createConvolver();
    conv.buffer = this._reverbIR;
    this._reverbNode = conv;
    return conv;
  }

  // Scary battle yell for War Cry (synthesized, no asset): a shouted, distorted
  // vowel with a hard pitch drop, formant filtering so it reads as a human
  // shout rather than a tone, and layered breath/rasp noise for grit. Gendered:
  // a man's roar sits an octave-plus lower with heavier distortion and chestier
  // formants; a woman's yell is higher, sharper, and more piercing/fierce.
  // Routed through sfxGain with the same distance attenuation as play().
  warCrySound(gender, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    let vol = opts.volume ?? 1;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return;
    const out = this.sfxGain || this.ctx.destination;

    const male = gender !== 'female';
    // Male: deep roar (~140Hz->75Hz), sawtooth, heavy distortion, chest formants.
    // Female: fierce shout (~330Hz->220Hz), sawtooth, brighter/sharper formants,
    // lighter but still gritty distortion.
    const cfg = male
      ? { f0: 145, f1: 72, dur: 0.85, drive: 14, formants: [700, 1150, 2600], peak: 0.82, noiseHz: 1200, noiseAmt: 0.35 }
      : { f0: 340, f1: 220, dur: 0.72, drive: 9, formants: [1000, 1700, 3200], peak: 0.78, noiseHz: 2200, noiseAmt: 0.3 };
    const dur = cfg.dur;

    // Cavernous echo: a shared wet bus feeds the reverb convolver so the yell
    // rings out down the halls. Both the voiced core and the breath noise below
    // route dry (straight to out) AND wet (through this send). If the convolver
    // fails to build we simply skip the wet path and stay dry.
    let wet = null;
    const conv = this._reverb();
    if (conv) {
      wet = this.ctx.createGain();
      wet.gain.value = 0.85 * vol; // strong tail so it reads as a big battle yell
      wet.connect(conv);
      conv.connect(out);
    }

    // (1) voiced shout core: sawtooth with a sharp pitch fall (roar/yell contour)
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(cfg.f0, t);
    osc.frequency.exponentialRampToValueAtTime(cfg.f1, t + dur * 0.75);

    // (2) waveshaper distortion for vocal grit/rasp
    const shaper = this.ctx.createWaveShaper();
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(cfg.drive * x) / Math.tanh(cfg.drive);
    }
    shaper.curve = curve;
    shaper.oversample = '4x';

    // (3) vowel formant bank (three parallel bandpasses = open "AA"-ish shout)
    const formantGain = this.ctx.createGain();
    const bands = cfg.formants.map((freq, i) => {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = i === 0 ? 3.5 : 5;
      const bg = this.ctx.createGain();
      bg.gain.value = i === 0 ? 1 : 0.55;
      shaper.connect(bp); bp.connect(bg); bg.connect(formantGain);
      return bp;
    });

    const peak = cfg.peak * vol;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.035); // snappy shout attack
    env.gain.setValueAtTime(peak, t + dur * 0.45);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(shaper);
    formantGain.connect(env);
    env.connect(out);
    if (wet) env.connect(wet);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    // (4) breath/rasp noise layer riding under the shout for texture
    const nbuf = this.ctx.createBuffer(1, Math.ceil((dur + 0.05) * this.ctx.sampleRate), this.ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const nsrc = this.ctx.createBufferSource(); nsrc.buffer = nbuf;
    const nbp = this.ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.frequency.value = cfg.noiseHz; nbp.Q.value = 0.7;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(peak * cfg.noiseAmt, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    nsrc.connect(nbp); nbp.connect(ng); ng.connect(out);
    if (wet) ng.connect(wet);
    nsrc.start(t); nsrc.stop(t + dur + 0.05);
  }

  // Continuous whirlwind whoosh: bandpassed brown noise (blade-through-air)
  // with a gentle amplitude tremolo so it reads as a spinning blade rather than
  // a flat hiss. Loops until stopWhirl() tears it down. Routed through sfxGain
  // so the SFX slider/mute applies. Returns a handle to pass to stopWhirl();
  // also stashed on `this._whirl` so callers that lose the handle can still
  // stop it via stopWhirl() with no argument.
  startWhirl(opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    this.stopWhirl(); // never let two loops stack
    const t = this.ctx.currentTime;
    const vol = Math.max(0, Math.min(1, opts.volume ?? 0.5));
    const out = this.sfxGain || this.ctx.destination;

    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 0.9;

    const g = this.ctx.createGain();
    const peak = 0.11 * vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.12); // quick fade-in on spin-up

    // amplitude tremolo (blade passing) riding on the same gain node
    const lfo = this.ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5.5;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = peak * 0.5;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);

    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(t, Math.random() * 1.5);
    lfo.start(t);

    const handle = { src, g, lfo, peak };
    this._whirl = handle;
    return handle;
  }

  // Stops a whirl loop started by startWhirl(). Accepts the handle returned by
  // startWhirl(), or no argument to stop whatever is currently looping. Fades
  // out quickly then tears down the nodes; safe to call repeatedly / when
  // nothing is playing.
  stopWhirl(handle) {
    const h = handle || this._whirl;
    if (!h) return;
    if (this._whirl === h) this._whirl = null;
    try {
      const t = this.ctx.currentTime;
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setValueAtTime(h.g.gain.value, t);
      h.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    } catch { /* context gone */ }
    setTimeout(() => {
      try { h.src.stop(); } catch {}
      try { h.lfo.stop(); } catch {}
    }, 160);
  }

  // Low-health warning: a soft, low "lub-dub" heartbeat that loops while the
  // player's HP stays under the HUD's low-health threshold. Two dull
  // low-frequency thumps per beat at ~62bpm, quiet and routed through sfxGain
  // (respects the SFX slider/mute, and simply won't fire if the context is
  // suspended). Never stacks — calling start again while already looping is
  // a no-op; stopHeartbeat() tears the schedule down cleanly.
  startHeartbeat() {
    if (this._heartbeat || !this.ctx) return;
    const beatMs = 968; // ~62bpm
    const thump = (delaySec, gainMul) => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const t = this.ctx.currentTime + delaySec;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(60, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15 * gainMul, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g);
      g.connect(this.sfxGain || this.ctx.destination);
      o.start(t); o.stop(t + 0.22);
    };
    const beat = () => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      thump(0, 1);       // "lub"
      thump(0.16, 0.65); // "dub" - softer, close behind
    };
    beat();
    this._heartbeat = setInterval(beat, beatMs);
  }

  stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  // Fireplace crackle (Obsidian 717): a soft lowpassed noise bed (the fire's
  // steady breath) plus randomly-timed short bright noise bursts (the pops
  // and snaps). Fully synthesized like startWhirl/startHeartbeat - no asset -
  // and routed through sfxGain so the SFX slider/mute applies. The caller
  // scales it with distance via setFireCrackleLevel(0..1) each frame-ish.
  startFireCrackle() {
    if (this._fire || !this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const out = this.sfxGain || this.ctx.destination;
    const level = this.ctx.createGain(); // distance-driven master for the whole fire
    level.gain.setValueAtTime(0.0001, t);
    level.connect(out);
    // noise bed
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.5;
    const bedG = this.ctx.createGain(); bedG.gain.value = 0.05;
    src.connect(lp); lp.connect(bedG); bedG.connect(level);
    src.start(t, Math.random() * 1.5);
    // random pops: short bright bandpassed bursts on a self-rescheduling timer
    const handle = { src, level, popT: null, dead: false };
    const pop = () => {
      if (handle.dead || !this.ctx || this.ctx.state !== 'running') return;
      const pt = this.ctx.currentTime;
      const n = this.ctx.createBufferSource(); n.buffer = this._noise();
      // 970: a fire crackle is a BROADBAND wood SNAP, not a narrow ringing tone -
      // the old Q=6 bandpass at 1.1-3.3kHz rang like tonal water drips. A wide
      // band (low Q) centred lower, through a lowpass, gives a dry woody pop;
      // a very sharp attack + fast decay reads as a snap, not a drip.
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 500 + Math.random() * 1200; bp.Q.value = 0.9 + Math.random() * 0.6;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.4;
      const pg = this.ctx.createGain();
      pg.gain.setValueAtTime(0.0001, pt);
      pg.gain.exponentialRampToValueAtTime(0.3 + Math.random() * 0.35, pt + 0.002); // sharp snap attack
      pg.gain.exponentialRampToValueAtTime(0.0001, pt + 0.025 + Math.random() * 0.05); // quick dry decay
      n.connect(bp); bp.connect(lp); lp.connect(pg); pg.connect(level);
      n.start(pt, Math.random() * 2); n.stop(pt + 0.12);
      // clustered, irregular timing - fire crackles in bursts, not a steady drip
      const next = Math.random() < 0.35 ? 20 + Math.random() * 80 : 120 + Math.random() * 520;
      handle.popT = setTimeout(pop, next);
    };
    handle.popT = setTimeout(pop, 200);
    this._fire = handle;
  }

  // 0..1; eased slightly so walking toward the hearth swells rather than steps.
  setFireCrackleLevel(v) {
    const h = this._fire;
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = Math.max(0.0001, Math.min(1, v)) * 0.9;
    try { h.level.gain.setTargetAtTime(target, t, 0.15); } catch { /* context gone */ }
  }

  stopFireCrackle() {
    const h = this._fire;
    if (!h) return;
    this._fire = null;
    h.dead = true;
    if (h.popT) clearTimeout(h.popT);
    try {
      const t = this.ctx.currentTime;
      h.level.gain.cancelScheduledValues(t);
      h.level.gain.setTargetAtTime(0.0001, t, 0.08);
    } catch { /* context gone */ }
    setTimeout(() => { try { h.src.stop(); } catch {} }, 300);
  }

  play(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    // UI blips are synthesized, not sampled — softer and more pleasant.
    if (UI_SYNTH[name]) { this._playUI(name); return; }
    // Blink is synthesized (shimmer/whoosh teleport) rather than sampled.
    if (name === 'blink') { this.blinkSound(opts); return; }
    // War Cry is synthesized (scary gendered battle yell) rather than sampled.
    if (name === 'war_cry') { this.warCrySound(opts.gender, opts); return; }
    // Parchment rustle (notice board open) is synthesized, no asset.
    if (name === 'parchment_rustle') { this.parchmentSound(opts); return; }
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

  // Death scream with VARIATION: plays the enemy-type death clip but pitch- and
  // gain-shifts it per call so repeated deaths of the same type never sound
  // identical. `type` is a manifest key like 'skeleton_death'. Picks one of a
  // spread of perceptible pitch steps (roughly a fifth down to a third up) plus
  // a slight gain wobble. Falls back to the plain clip if it isn't loaded.
  // opts: { pos, volume }. Same distance attenuation as play().
  deathScream(type, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const buf = this.buffers.get(`${type}#0`) || this.buffers.get(`${type}#1`);
    if (!buf) return;

    let vol = opts.volume ?? 0.85;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return;

    // 8 perceptible pitch steps so back-to-back kills read as different deaths.
    const steps = [0.7, 0.8, 0.88, 0.95, 1.05, 1.15, 1.28, 1.42];
    const rate = steps[Math.floor(Math.random() * steps.length)];
    const gain = vol * (0.85 + Math.random() * 0.3);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.sfxGain);
    src.start();
  }

  // Per-type enemy attack sound (see ENEMY_ATTACK_SOUNDS above). Types with a
  // `clip` play the sampled sound at their fixed signature pitch; types with
  // a `synth` get a short procedural one-shot. opts: { pos, volume }, same
  // distance attenuation as play().
  enemyAttack(typeId, opts = {}) {
    const def = ENEMY_ATTACK_SOUNDS[typeId];
    if (!def || !this.ctx || this.ctx.state !== 'running') return;
    if (def.clip) {
      this.play(def.clip, { ...opts, rate: def.rate ?? 1, volume: (def.volume ?? 1) * (opts.volume ?? 1) });
      return;
    }
    let vol = opts.volume ?? 1;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return;
    this._attackSynth(def.synth, vol);
  }

  // Short procedural attack one-shots for enemy types that have no fitting
  // sampled clip: a bandpass-swept noise burst (reusing the shared _noise
  // buffer, like the ghost rattle) with an optional pitched tone underneath.
  _attackSynth(kind, vol) {
    const P = {
      hiss:  { f0: 3400, f1: 1500, q: 2.5, dur: 0.18, gain: 0.30 },
      bite:  { f0: 700, f1: 240, q: 3.5, dur: 0.13, gain: 0.34, tone: { type: 'square', tf0: 170, tf1: 90, tg: 0.10 } },
      chill: { f0: 1500, f1: 480, q: 1.1, dur: 0.34, gain: 0.22, tone: { type: 'sine', tf0: 540, tf1: 240, tg: 0.07 } },
      claw:  { f0: 1000, f1: 260, q: 0.9, dur: 0.24, gain: 0.42, tone: { type: 'sawtooth', tf0: 120, tf1: 65, tg: 0.08 } },
    }[kind];
    if (!P) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = P.q;
    f.frequency.setValueAtTime(P.f0, t);
    f.frequency.exponentialRampToValueAtTime(P.f1, t + P.dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(P.gain * vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + P.dur);
    src.connect(f); f.connect(g); g.connect(this.sfxGain);
    src.start(t, Math.random() * 2, P.dur + 0.05);
    if (P.tone) {
      const o = this.ctx.createOscillator();
      o.type = P.tone.type;
      o.frequency.setValueAtTime(P.tone.tf0, t);
      o.frequency.exponentialRampToValueAtTime(P.tone.tf1, t + P.dur);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(P.tone.tg * vol, t + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t + P.dur);
      o.connect(og); og.connect(this.sfxGain);
      o.start(t); o.stop(t + P.dur + 0.1);
    }
  }

  // ---------- Ghost ambience one-shots (procedural, no assets) ----------
  // An assortment of eerie moans so wraiths don't loop the same clip. Kept
  // LOW volume with long attack/release so nothing startles the player --
  // these are atmosphere, not combat stingers. Routed through sfxGain so the
  // SFX slider/mute applies. `variant` picks one of GHOST_MOAN_VARIANTS; an
  // unrecognized/omitted variant rolls a random one. opts: { pos, volume }.
  ghostMoan(variant, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    const v = GHOST_MOAN_VARIANTS.includes(variant) ? variant : GHOST_MOAN_VARIANTS[Math.floor(Math.random() * GHOST_MOAN_VARIANTS.length)];

    let vol = opts.volume ?? 1;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AUDIBLE_RANGE) return null;
      vol *= Math.max(0, 1 - dist / AUDIBLE_RANGE) ** 1.5;
    }
    if (vol <= 0.01) return null;

    if (v === 'moan') this._ghostMoanLow(vol);
    else if (v === 'wail') this._ghostWhisperWail(vol);
    else if (v === 'keen') this._ghostKeen(vol);
    else if (v === 'rattle') this._ghostRattle(vol);
    return v;
  }

  // A short vocal grunt when the hero is hit, synthesized so each class sounds
  // like a different character: knight low and chesty, mage higher and breathy,
  // ranger mid and terse. Routed through the SFX bus, throttled so rapid multi
  // hits do not machine-gun the grunt.
  classHurt(classId, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (nowMs - (this._lastGruntAt || 0) < 150) return null;
    this._lastGruntAt = nowMs;
    const vol = opts.volume ?? 0.7;
    const cfg = ({
      knight: { f0: [110, 140], f1: [66, 88], dur: [0.24, 0.32], type: 'sawtooth', noise: 0.45, nHz: 480, peak: 0.32 },
      mage:   { f0: [225, 285], f1: [175, 210], dur: [0.18, 0.25], type: 'triangle', noise: 0.75, nHz: 1500, peak: 0.24 },
      ranger: { f0: [180, 215], f1: [120, 150], dur: [0.13, 0.19], type: 'square', noise: 0.55, nHz: 950, peak: 0.26 },
    })[classId] || { f0: [150, 190], f1: [100, 130], dur: [0.2, 0.27], type: 'triangle', noise: 0.55, nHz: 820, peak: 0.28 };
    const t = this.ctx.currentTime;
    const rnd = (a) => a[0] + Math.random() * (a[1] - a[0]);
    const dur = rnd(cfg.dur), f0 = rnd(cfg.f0), f1 = rnd(cfg.f1), peak = cfg.peak * vol;
    // voiced tone with a downward pitch fall
    const osc = this.ctx.createOscillator(); osc.type = cfg.type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = f0 * 6;
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp); lp.connect(og); og.connect(this.sfxGain);
    osc.start(t); osc.stop(t + dur + 0.05);
    // breath/exhale noise band on top
    const nbuf = this.ctx.createBuffer(1, Math.ceil((dur + 0.05) * this.ctx.sampleRate), this.ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const nb = this.ctx.createBufferSource(); nb.buffer = nbuf;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = cfg.nHz; bp.Q.value = 0.8;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(peak * cfg.noise, t + 0.015);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.85);
    nb.connect(bp); bp.connect(ng); ng.connect(this.sfxGain);
    nb.start(t); nb.stop(t + dur + 0.05);
    return classId;
  }

  // (a) low hollow moan: sine/triangle sweeping slowly down ~180->90Hz with a
  // slow tremolo riding on the gain. ~2.2-2.8s, soft attack/release.
  _ghostMoanLow(vol) {
    const t = this.ctx.currentTime;
    const dur = 2.2 + Math.random() * 0.6;
    const osc = this.ctx.createOscillator();
    osc.type = Math.random() < 0.5 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(170 + Math.random() * 20, t);
    osc.frequency.exponentialRampToValueAtTime(85 + Math.random() * 15, t + dur);
    const g = this.ctx.createGain();
    const peak = 0.07 * vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // slow tremolo: a quiet LFO summed into the same gain param
    const lfo = this.ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 3.5 + Math.random();
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = peak * 0.35;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    osc.connect(g); g.connect(this.sfxGain);
    osc.start(t); lfo.start(t);
    osc.stop(t + dur + 0.1); lfo.stop(t + dur + 0.1);
  }

  // (b) breathy whisper-wail: bandpassed noise swelling and fading, with the
  // filter drifting slowly upward. ~1.8-2.7s.
  _ghostWhisperWail(vol) {
    const t = this.ctx.currentTime;
    const dur = 1.8 + Math.random() * 0.9;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass'; filt.Q.value = 0.9;
    const f0 = 350 + Math.random() * 150, f1 = f0 + 250 + Math.random() * 200;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.linearRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    const peak = 0.05 * vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.sfxGain);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.1);
  }

  // (c) faint keening: high soft sine ~600-900Hz with vibrato, quick fade.
  // ~1.3-1.7s.
  _ghostKeen(vol) {
    const t = this.ctx.currentTime;
    const dur = 1.3 + Math.random() * 0.4;
    const osc = this.ctx.createOscillator(); osc.type = 'sine';
    const f0 = 620 + Math.random() * 120;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f0 + 180 + Math.random() * 100, t + dur * 0.7);
    const vib = this.ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 5.5 + Math.random() * 1.5;
    const vibGain = this.ctx.createGain(); vibGain.gain.value = 12;
    vib.connect(vibGain); vibGain.connect(osc.frequency);
    const g = this.ctx.createGain();
    const peak = 0.04 * vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.sfxGain);
    osc.start(t); vib.start(t);
    osc.stop(t + dur + 0.1); vib.stop(t + dur + 0.1);
  }

  // (d) faint chains/rattle: a handful of short bandpassed noise clinks
  // scattered across ~1.6-2.2s.
  _ghostRattle(vol) {
    const t = this.ctx.currentTime;
    const clinks = 4 + Math.floor(Math.random() * 4);
    const dur = 1.6 + Math.random() * 0.6;
    const peak = 0.045 * vol;
    for (let i = 0; i < clinks; i++) {
      const tt = t + Math.random() * dur;
      const src = this.ctx.createBufferSource(); src.buffer = this._noise();
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 2000; f.Q.value = 3;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(peak * (0.6 + Math.random() * 0.4), tt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.12);
      src.connect(f); f.connect(g); g.connect(this.sfxGain);
      src.start(tt, Math.random() * 2, 0.14);
    }
  }

  hasMusic(name) { return this.musicBuffers.has(name); }

  // Themed track pickers. Each act has its own exploration bed and its own
  // act-lord battle loop; if a per-act file failed to load we fall back to
  // the original generic dungeon/boss tracks so music never goes silent.
  dungeonTrack(act) {
    const name = 'dungeon' + Math.min(5, Math.max(1, act || 1));
    return this.hasMusic(name) ? name : 'dungeon';
  }

  bossTrack(act) {
    const name = 'boss' + Math.min(5, Math.max(1, act || 1));
    return this.hasMusic(name) ? name : 'boss';
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
    // Live-lute state (Obsidian 880): a wandering minstrel plays a slow medieval
    // phrase in the corner - synthesized plucks, NOT an mp3, so it reads as
    // someone actually playing in the room rather than a recording.
    let luteBeat = 0;
    const timer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      if (P.crackle && Math.random() < P.crackle) this._crackle();
      if (P.chirp && Math.random() < P.chirp) this._chirp();
      if (P.drip && Math.random() < P.drip) this._drip();
      if (P.murmur && Math.random() < P.murmur) this._murmur();
      // step the lute melody every ~680ms (2 ambience ticks) at a relaxed tempo
      if (P.lute) { if (luteBeat % 2 === 0) this._luteStep(); luteBeat++; }
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

  // Procedural LUTE (Obsidian 880): a plucked-string note - fast attack, long
  // string-like decay, a couple of detuned voices + a soft harmonic for body,
  // through a lowpass so it sits warm under the room tone. Synthesized, so the
  // tavern has LIVE music instead of an anachronistic recording.
  _lute(freq) {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.05, t + 0.01);   // quick pluck attack
    out.gain.exponentialRampToValueAtTime(0.012, t + 0.35);  // body
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);  // string decay
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.9); // brightness fades as it rings
    for (const [type, mult, gain, detune] of [['triangle', 1, 1, 0], ['sawtooth', 1, 0.35, 4], ['sine', 2, 0.25, 0]]) {
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = freq * mult; o.detune.value = detune;
      const vg = this.ctx.createGain(); vg.gain.value = gain;
      o.connect(vg); vg.connect(lp);
      o.start(t); o.stop(t + 1.2);
    }
    lp.connect(out); out.connect(this.ambGain);
  }

  // Step through a gentle D-Dorian medieval phrase (0 = a rest/breath), looping.
  _luteStep() {
    // D4 E4 F4 G4 A4 C5 D5, plus A3/C4 lower - a lilting tune resolving to D.
    const N = { D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, C5: 523.25, D5: 587.33, A3: 220.0, C4: 261.63 };
    const M = ['A3', 'D4', 'F4', 'A4', 0, 'G4', 'F4', 'E4', 'D4', 0, 'F4', 'E4', 'D4', 'C4', 'D4', 0];
    this._luteIdx = ((this._luteIdx || 0) + 1) % M.length;
    const note = M[this._luteIdx];
    if (note && N[note]) this._lute(N[note]);
  }

  // Play a base64 data-URI clip THROUGH THE SFX CHAIN (Obsidian 911): decodes
  // the audio and routes it BufferSource -> per-clip gain -> sfxGain -> master,
  // so the SFX volume slider controls it (raw HTMLAudio bypassed the chain).
  // Returns a handle with stop() and fadeOut(sec). Async decode; the handle's
  // node fields populate once decoded. Loudness of the clips is already
  // normalized (loudnorm) so their levels are consistent.
  playData(dataUri, { loop = false, volume = 1 } = {}) {
    // Returns the handle SYNCHRONOUSLY (so callers can stopData it right away);
    // the decode + wiring happens async and populates handle.src when ready.
    const handle = { src: null, gain: null, stopped: false, volume };
    if (!this.ctx) return handle;
    (async () => {
      try {
        const b64 = dataUri.split(',')[1] || dataUri;
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const audioBuf = await this.ctx.decodeAudioData(buf.buffer);
        if (handle.stopped) return; // stopped before decode finished
        const src = this.ctx.createBufferSource();
        src.buffer = audioBuf; src.loop = loop;
        const g = this.ctx.createGain(); g.gain.value = handle.volume;
        src.connect(g); g.connect(this.sfxGain); // <- the SFX volume chain
        src.start();
        handle.src = src; handle.gain = g;
      } catch { /* decode/format failure - stay silent */ }
    })();
    return handle;
  }

  // Stop / fade a handle from playData (911).
  stopData(handle, fadeSec = 0) {
    if (!handle) return;
    handle.stopped = true;
    const { src, gain } = handle;
    if (!src) return;
    try {
      if (fadeSec > 0 && gain) {
        const t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0.0001, t + fadeSec);
        src.stop(t + fadeSec + 0.05);
      } else { src.stop(); }
    } catch { /* already stopped */ }
  }

  // Rooster crow on waking (Obsidian 930): a stylized "cock-a-doodle-doo"
  // synthesized (no downloaded file) - a bright sawtooth through a vocal-ish
  // bandpass formant with vibrato, shaped into the 4-syllable crow contour
  // (cock-a-doodle-dooooo) by a pitch + amplitude envelope. Routed through the
  // SFX chain so the SFX slider controls it; consistent level by construction.
  rooster() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator(); osc.type = 'sawtooth';
    const vib = this.ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 14;
    const vibGain = this.ctx.createGain(); vibGain.gain.value = 22; // vibrato depth
    vib.connect(vibGain); vibGain.connect(osc.frequency);
    // pitch contour: cock (620) - a (560) - doodle (760, held) - dooo (700->500 fall)
    const f = osc.frequency;
    f.setValueAtTime(620, t);
    f.setValueAtTime(560, t + 0.16);
    f.setValueAtTime(760, t + 0.34);
    f.linearRampToValueAtTime(760, t + 0.72);
    f.linearRampToValueAtTime(500, t + 1.05);
    // 966: the old single narrow bandpass on a bare sawtooth read as a harsh
    // buzz. A real crow is a VOWELY, slightly breathy squawk. Two parallel
    // formant bands (a vowel pair) + a lowpass to tame the buzzy top + a touch
    // of noise breath make it organic instead of a synth rasp.
    const f1 = this.ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 780; f1.Q.value = 4;
    const f2 = this.ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1250; f2.Q.value = 5;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.5;
    const f2g = this.ctx.createGain(); f2g.gain.value = 0.6;
    // breath: quiet noise gated with the syllables for an airy squawk
    const breath = this.ctx.createBufferSource(); breath.buffer = this._noise(); breath.loop = true;
    const bhp = this.ctx.createBiquadFilter(); bhp.type = 'highpass'; bhp.frequency.value = 1400;
    const bg = this.ctx.createGain(); bg.gain.value = 0.0001;
    breath.connect(bhp); bhp.connect(bg);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // 4 syllable amplitude bumps
    const bumps = [[0.02, 0.14], [0.18, 0.10], [0.36, 0.16], [0.56, 0.16]];
    for (const [start, len] of bumps) {
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(0.13, t + start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.02, t + start + len);
      bg.gain.setValueAtTime(0.0001, t + start);
      bg.gain.exponentialRampToValueAtTime(0.03, t + start + 0.02);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + start + len * 0.7);
    }
    g.gain.setValueAtTime(0.085, t + 0.72);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    osc.connect(f1); osc.connect(f2); f2.connect(f2g);
    f1.connect(lp); f2g.connect(lp);
    lp.connect(g); bg.connect(g); g.connect(this.sfxGain);
    osc.start(t); vib.start(t); breath.start(t, Math.random());
    osc.stop(t + 1.2); vib.stop(t + 1.2); breath.stop(t + 1.2);
  }

  // Pouring a drink (Obsidian 902): filtered noise whose bandpass pitch RISES
  // as the vessel fills (the classic "pouring liquid" cue), with a little
  // amplitude wobble for the glug. ~1.1s. Public so Magda's serve can call it.
  pour() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this._noise(); src.loop = true;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3.5;
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + 1.0); // pitch rises as it fills
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.08);
    // gentle glug wobble
    for (let i = 0; i < 6; i++) g.gain.linearRampToValueAtTime(0.03 + Math.random() * 0.03, t + 0.15 + i * 0.14);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    src.connect(bp); bp.connect(g); g.connect(this.ambGain);
    src.start(t); src.stop(t + 1.2);
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

  // One distant half-heard phrase in the room hubbub (781): a band-passed
  // noise burst in the voice register with syllabic amplitude bumps. Fired
  // often enough that phrases overlap into a low crowd murmur; peaks are tiny
  // so real NPC speech always reads clearly OVER the chatter.
  _murmur() {
    const t = this.ctx.currentTime;
    const dur = 0.5 + Math.random() * 0.9;
    const src = this.ctx.createBufferSource(); src.buffer = this._noise(); src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = 220 + Math.random() * 480; // a different "voice" each phrase
    f.Q.value = 6;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    const syl = 3 + Math.floor(Math.random() * 5);
    const peak = 0.012 + Math.random() * 0.014;
    for (let i = 0; i < syl; i++) {
      const ts = t + (i / syl) * dur;
      g.gain.exponentialRampToValueAtTime(peak * (0.6 + Math.random() * 0.4), ts + 0.04);
      g.gain.exponentialRampToValueAtTime(0.002, ts + (dur / syl) * 0.9);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    src.connect(f); f.connect(g); g.connect(this.ambGain);
    src.start(t, Math.random() * 2, dur + 0.2);
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
  tavern:        { freq: 700, bed: 0.045, crackle: 0.5, murmur: 0.55, lute: true },  // room tone + hearth + crowd murmur (781) + live lute (880)
  'dungeon-wet': { freq: 300, bed: 0.05, drone: 62, droneGain: 0.05, drip: 0.05 }, // stone/moss caves
  'dungeon-dry': { freq: 260, bed: 0.045, drone: 55, droneGain: 0.06 },           // ember/cursed/abyss drone
};

export const audio = new AudioEngine();
