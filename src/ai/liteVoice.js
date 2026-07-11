// Lightweight supplemental TTS (Obsidian 738): KittenTTS Nano - a 15M-param,
// ~23MB int8 ONNX voice model that runs entirely on CPU (onnxruntime-web
// WASM, SIMD). It SUPPLEMENTS Kokoro, never replaces it: Kokoro (82M, GPU)
// stays the voice of direct player<->NPC interactions, while ambient tavern
// table-talk routes here (see roaster.speakAs's cast.lite path) so idle
// chatter costs a fraction of the compute and never touches the GPU.
//
// The whole pipeline is one ONNX graph: phonemized text (the same
// `phonemizer` package kokoro-js already ships) -> char token ids from
// tokenizer.json -> { input_ids, style (per-voice embedding from
// voices.json), speed } -> raw 24kHz waveform. Assets are served from
// public/models/kitten/ (vendored from the CC0/Apache-2 KittenML release via
// clowerweb's browser port) so nothing is fetched from third parties at
// runtime.
//
// Everything degrades gracefully: if the model, runtime or phonemizer fails
// to load, speak() returns false and the caller falls back to Kokoro.

const SAMPLE_RATE = 24000; // KittenTTS Nano's native output rate
const CACHE_MAX = 64;      // synthesized-line LRU cap (~short lines, small)

class LiteVoice {
  constructor() {
    this.status = 'off'; // off | loading | ready | error
    this.session = null;
    this.vocab = null;
    this.voices = null;
    this.ort = null;
    this._loading = null;
    this._cache = new Map(); // voice|speed|text -> { pcm, sr }
    this._ctx = null;
    this._current = null;    // playing AudioBufferSourceNode
  }

  get ready() { return this.status === 'ready'; }
  // Mirrors neuralVoice's "is a line audibly playing / in flight" surface so
  // game.npcSpeechActive() can include this engine in its speech signal.
  get speaking() { return !!this._current; }

  // Load the model + tokenizer + voice embeddings once; safe to call often.
  // Resolves true when usable, false when this engine is unavailable.
  load() {
    if (this.status === 'ready') return Promise.resolve(true);
    if (this.status === 'error') return Promise.resolve(false);
    if (this._loading) return this._loading;
    this.status = 'loading';
    this._loading = (async () => {
      const ort = await import('onnxruntime-web');
      const base = import.meta.env.BASE_URL + 'models/kitten/';
      const [modelBuf, tok, voices] = await Promise.all([
        fetch(base + 'model_quantized.onnx').then((r) => { if (!r.ok) throw new Error('model ' + r.status); return r.arrayBuffer(); }),
        fetch(base + 'tokenizer.json').then((r) => r.json()),
        fetch(base + 'voices.json').then((r) => r.json()),
      ]);
      // proxy=true runs ORT's WASM inference in its own worker (Obsidian 745):
      // without it each ~1s KittenTTS synth blocked the main thread and the
      // game hitched during ambient tavern lines.
      try { ort.env.wasm.proxy = true; ort.env.wasm.numThreads = 1; } catch { /* env shape changed */ }
      this.session = await ort.InferenceSession.create(modelBuf, {
        executionProviders: [{ name: 'wasm', simd: true }],
      });
      this.vocab = tok.model.vocab;
      this.voices = voices;
      this.ort = ort;
      this.status = 'ready';
      console.info('[lite-tts] KittenTTS Nano ready (CPU/WASM)');
      return true;
    })().catch((err) => {
      console.warn('[lite-tts] unavailable; lines fall back to Kokoro.', err);
      this.status = 'error';
      return false;
    });
    return this._loading;
  }

  async _synth(text, voice, speed) {
    const key = `${voice}|${speed}|${text}`;
    const hit = this._cache.get(key);
    if (hit) return hit;
    const { phonemize } = await import('phonemizer');
    const ph = await phonemize(text, 'en-us');
    const phStr = Array.isArray(ph) ? ph.join(' ') : String(ph);
    const tokens = `$${phStr}$`.split('').map((c) => this.vocab[c] ?? 0);
    const emb = this.voices[voice]?.[0] || this.voices[Object.keys(this.voices)[0]][0];
    const inputs = {
      input_ids: new this.ort.Tensor('int64', new BigInt64Array(tokens.map(BigInt)), [1, tokens.length]),
      style: new this.ort.Tensor('float32', new Float32Array(emb), [1, emb.length]),
      speed: new this.ort.Tensor('float32', new Float32Array([speed]), [1]),
    };
    const results = await this.session.run(inputs);
    const out = { pcm: Float32Array.from(results.waveform.data), sr: SAMPLE_RATE };
    if (this._cache.size >= CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
    this._cache.set(key, out);
    return out;
  }

  // Synthesize + play one line. onStart fires the moment audible playback
  // begins (same contract as neuralVoice.speak, so the caption gate works).
  // Returns true if the line played, false if the caller should fall back.
  async speak(text, { voice = 'expr-voice-3-f', speed = 1, volume = 0.9, rate = 1, onStart = null } = {}) {
    try {
      if (this.status !== 'ready') return false;
      const { pcm, sr } = await this._synth(text, voice, speed);
      if (!pcm || !pcm.length) return false;
      if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this._ctx.state === 'suspended') await this._ctx.resume().catch(() => {});
      const buf = this._ctx.createBuffer(1, pcm.length, sr);
      buf.copyToChannel(pcm, 0);
      try { this._current?.stop(); } catch { /* already ended */ }
      const src = this._ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = this._ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, volume));
      src.connect(g); g.connect(this._ctx.destination);
      src.start();
      this._current = src;
      try { onStart?.(); } catch { /* caption hook is best-effort */ }
      await new Promise((res) => { src.onended = res; });
      if (this._current === src) this._current = null;
      return true;
    } catch (err) {
      console.warn('[lite-tts] speak failed; falling back.', err);
      this._current = null;
      return false;
    }
  }
}

export const liteVoice = new LiteVoice();
