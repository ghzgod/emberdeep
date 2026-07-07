import { audio } from '../core/audio.js';

// Kokoro (Misaki G2P) mispronounces raw game text: it reads emoji/symbols aloud,
// pauses awkwardly on em-dashes and ellipses, spells out ALL-CAPS words letter by
// letter, and voices bare digits inconsistently. Normalize before generate().
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numToWords(n) {
  n = parseInt(n, 10);
  if (isNaN(n)) return '';
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numToWords(n % 100) : '');
  if (n < 1000000) return numToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numToWords(n % 1000) : '');
  return String(n);
}
const ABBR = { HP: 'hit points', XP: 'experience', AoE: 'area', Lvl: 'level', Lv: 'level', vs: 'versus', NPC: 'character' };
export function normalizeForTTS(text) {
  let t = String(text || '');
  // strip emoji / pictographs / symbols (and their variation selectors / ZWJ)
  // that Kokoro would otherwise read aloud
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, ' ');
  // dashes + ellipses → a plain comma pause (Kokoro stumbles on the glyphs)
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\.{2,}|…/g, ', ');
  // whole-word abbreviations → spoken form
  t = t.replace(/\b([A-Za-z]+)\b/g, (w) => (ABBR[w] ? ABBR[w] : w));
  // ALL-CAPS emphasis words → title case so they aren't spelled out letter by letter
  t = t.replace(/\b[A-Z]{2,}\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase());
  // standalone numbers (incl. simple currency) → words
  t = t.replace(/\$?\d[\d,]*/g, (m) => numToWords(m.replace(/[$,]/g, '')) || m);
  // collapse leftover whitespace / stray punctuation runs
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/([,]){2,}/g, ',').trim();
  return t;
}

// Neural TTS via Kokoro-82M (kokoro-js / transformers.js, Apache 2.0).
// Opt-in: the quantized model is a ~90 MB one-time download, cached by the
// browser afterwards. Falls back to the standard Web Speech voices whenever
// it isn't ready.
//
// IMPORTANT: GitHub Pages (and any host without COOP/COEP headers) is NOT
// cross-origin isolated, so SharedArrayBuffer is unavailable. The default
// onnxruntime-web build is the *threaded* WASM, which needs SharedArrayBuffer
// and silently stalls without it. We therefore force numThreads = 1 so ORT
// loads the single-threaded WASM, and prefer WebGPU when present.
//
// proxy = true moves WASM inference (session create + every generate() run)
// onto a dedicated Web Worker instead of the main thread. This does NOT need
// SharedArrayBuffer -- that's only required for numThreads > 1 (real pthreads
// sharing memory); the proxy worker just gets messages posted to it, same as
// any other Worker. Verified against the real kokoro-js/onnxruntime-web build
// in both `vite dev` and a `vite build` + `vite preview` bundle: the worker
// loads and runs fine in both, and a multi-hundred-ms WASM inference that used
// to freeze every rendered frame no longer drops a single one. Without this,
// a single generate() call blocks the whole game for as long as it takes to
// synthesize the line (multi-second on WASM q8 on slower machines).
// The Kokoro model plus the onnxruntime-web WASM is a ~90 MB download that then
// has to be instantiated into memory. Mobile Safari (and low-memory phones in
// general) cannot hold that: instantiation OOMs the tab and Safari shows
// "A problem repeatedly occurred", killing/reloading the whole game. So on
// phones we never even attempt it: we degrade to the browser's built-in
// speechSynthesis, which roaster.js already uses when status === 'error'.
export function isMemoryConstrainedDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPhone / iPod, and iPadOS Safari (which reports as "Macintosh" but has touch)
  const iOS = /iPhone|iPod/.test(ua) || (/iPad/.test(ua))
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  // Android phones and any coarse-pointer (touch-first) device
  const android = /Android/i.test(ua);
  const coarse = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches
    && matchMedia('(max-width: 1024px)').matches;
  // Explicitly small device memory (Chrome/Android expose navigator.deviceMemory)
  const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  return iOS || android || coarse || lowMem;
}

// Seconds of silence after which the resident Kokoro model is disposed to stop
// keeping the GPU/WASM session (and ~90 MB of weights) warm the whole session.
// The next speak() lazily reloads it, accepting a short first-line delay.
const IDLE_RELEASE_MS = 90000;

class NeuralVoice {
  constructor() {
    this.status = 'off';   // off | loading | ready | error
    this.skipped = false;  // true when we deliberately skipped the heavy download
    this.tts = null;
    this.progress = 0;
    this.onStatus = null;  // UI hook
    this.onGenerating = null; // (active, anchor) hook: a fresh line is being synthesized
    this.lastError = '';
    this._current = null;
    this._busy = false;
    this._cache = new Map(); // key: voice|speed|text -> { audio, sr }
    this._combatBusy = false; // set via reportCombatLoad(); gates fresh generation only
    this._idleTimer = null;   // disposes the model after IDLE_RELEASE_MS of silence
    this._released = false;   // true when we freed the model and must lazily reload
    this._loadOpts = null;    // remembers device/dtype so a lazy reload is exact + silent
  }

  get ready() { return this.status === 'ready'; }

  _set(status) {
    this.status = status;
    this.onStatus?.(status, this.progress, this.lastError);
  }

  async load() {
    if (this.status === 'loading' || this.status === 'ready') return this.ready;
    this.lastError = '';
    // Never download/instantiate the heavy model on a phone: it OOM-crashes
    // mobile Safari. Fall back to built-in speechSynthesis via the 'error'
    // path. Requires an explicit opt-in (forceNeural) to try anyway.
    if (isMemoryConstrainedDevice() && !this._optIn) {
      this.skipped = true;
      this.lastError = 'skipped on mobile to avoid an out-of-memory crash';
      console.warn('[neural-tts] skipping neural voice download on this device; using standard voices');
      this._set('error');
      return false;
    }
    this._set('loading');
    try {
      const { KokoroTTS, env } = await import('kokoro-js');

      // Single-threaded WASM, proxied to a Worker: works everywhere (no
      // SharedArrayBuffer needed) and keeps generate() off the main thread.
      try {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = true;
      } catch { /* env shape changed; best-effort */ }

      // WebGPU FIRST when available: generation is ~10x faster than WASM q8
      // (sub-second vs ~6s per line), which is what makes the reference impl feel
      // instant. WebGPU session-create can occasionally hang on some GPUs, so it's
      // time-boxed — if it stalls we fall through to the universally-compatible
      // single-threaded WASM q8 path instead of stalling forever.
      //
      // On battery (a laptop running unplugged), prefer the lighter WASM q8 path
      // over WebGPU: keeping the GPU spun up for TTS is a real power draw. When
      // plugged in, on a desktop, or when the Battery Status API is unavailable,
      // keep the fast WebGPU-first order.
      const onBattery = await this._onBattery();
      let attempts = navigator.gpu && !onBattery
        ? [{ device: 'webgpu', dtype: 'fp32', timeout: 30000 }, { device: 'wasm', dtype: 'q8', timeout: 120000 }]
        : [{ device: 'wasm', dtype: 'q8', timeout: 120000 },
          ...(navigator.gpu ? [{ device: 'webgpu', dtype: 'fp32', timeout: 30000 }] : [])];
      // Go straight to whichever backend worked last time. This is what stops the
      // "it re-downloads the voices it already has" bug: transformers.js caches
      // model weights in the Cache Storage API keyed by file URL, and a given
      // dtype maps to a DIFFERENT set of weight files (q8 -> model_quantized.onnx
      // ~90 MB, fp32 -> model.onnx ~330 MB). A second load of the SAME dtype is a
      // pure cache hit (verified: zero network requests). A re-download only
      // happens when the backend FLIPS dtype between loads and pulls the other
      // dtype's uncached files. The battery heuristic and WebGPU-first ordering
      // above can both flip that order, so the pin must win outright: once a
      // dtype has succeeded (and thus cached its weights), every later load uses
      // exactly it, ignoring GPU/battery reordering, until it truly stops working.
      const pinned = localStorage.getItem('emberdeep-tts-backend');
      if (pinned) {
        const hit = attempts.find((a) => `${a.device}|${a.dtype}` === pinned);
        // Put the pinned backend first AND drop any other-dtype attempt ahead of
        // it, so a pinned q8 never falls through to an uncached fp32 download
        // (and vice versa) just because the GPU/battery order preferred it.
        if (hit) attempts = [hit, ...attempts.filter((a) => a !== hit && a.dtype === hit.dtype)];
      }
      const progress_callback = (p) => {
        if ((p.status === 'progress' || p.status === 'download') && p.total) {
          this.progress = Math.min(1, (p.loaded || 0) / p.total);
          this.onStatus?.('loading', this.progress, '');
        }
      };

      let lastErr = null;
      for (const opt of attempts) {
        try {
          this.tts = await Promise.race([
            KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',
              { device: opt.device, dtype: opt.dtype, progress_callback }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`${opt.device} timed out`)), opt.timeout)),
          ]);
          localStorage.setItem('emberdeep-tts-backend', `${opt.device}|${opt.dtype}`);
          this._loadOpts = { device: opt.device, dtype: opt.dtype };
          this._released = false;
          this._set('ready');
          return true;
        } catch (err) {
          lastErr = err;
          // Only forget the pin when the PINNED backend itself failed (it truly
          // stopped working). Clearing it on any probe failure (e.g. a WebGPU
          // timeout while a q8 pin is what actually works) would let the next
          // refresh re-order to the other dtype and re-download uncached weights.
          if (pinned === `${opt.device}|${opt.dtype}`) localStorage.removeItem('emberdeep-tts-backend');
          console.warn(`[neural-tts] ${opt.device} attempt failed`, err);
        }
      }
      throw lastErr || new Error('all backends failed');
    } catch (err) {
      this.lastError = (err && err.message) ? err.message : String(err);
      console.warn('[neural-tts] load failed; using standard voices', err);
      this._set('error');
      return false;
    }
  }

  // True when this device would OOM on the neural model, so the UI can warn
  // before offering an explicit opt-in.
  get memoryConstrained() { return isMemoryConstrainedDevice(); }

  // Prefer the lighter WASM backend when running on battery (laptop unplugged),
  // to spare the GPU. Degrades gracefully to false (keep WebGPU) whenever the
  // Battery Status API is missing, throws, or reports charging/plugged-in.
  async _onBattery() {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return false;
      const b = await navigator.getBattery();
      // charging === true means plugged in; only treat "discharging" as battery.
      return b && b.charging === false;
    } catch { return false; }
  }

  // Reload the model after an idle release, using the exact device/dtype that
  // worked before so it's silent (cached weights, no UI status churn) and
  // idempotent (a concurrent call just awaits the same load()). Returns ready.
  async _ensureLoaded() {
    if (this.ready && this.tts) return true;
    // Only silently reload a model we previously released. A never-loaded /
    // errored engine goes through the normal load() path (with its UI status).
    if (!this._released || !this._loadOpts) return this.ready;
    if (this.status === 'loading') return this.load(); // dedupe an in-flight reload
    this.status = 'loading';
    try {
      const { KokoroTTS, env } = await import('kokoro-js');
      try {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = true;
      } catch { /* env shape changed; best-effort */ }
      this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',
        { device: this._loadOpts.device, dtype: this._loadOpts.dtype });
      this._released = false;
      this.status = 'ready';
      return true;
    } catch (err) {
      console.warn('[neural-tts] lazy reload failed', err);
      this.status = 'ready'; // keep prior semantics; caller falls back if tts null
      return !!this.tts;
    }
  }

  // Free the resident model after a spell of silence. Safe to call while a
  // generate() is in flight: we only drop it once the current line settles.
  _armIdleRelease() {
    if (typeof setTimeout !== 'function') return;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._releaseIdle(), IDLE_RELEASE_MS);
  }

  _releaseIdle() {
    // Don't yank the model out from under an in-flight generate(); the finally
    // in speak() re-arms the timer, so we'll get another chance once it settles.
    if (this._busy || !this.tts || this._released) return;
    try { this.tts?.dispose?.(); } catch { /* best-effort free */ }
    this.tts = null;
    this._released = true;
    console.info('[neural-tts] released idle model; will reload on next line');
  }

  // Allow a manual retry after a failure. force = true is the explicit user
  // opt-in that overrides the mobile skip (the caller must warn about the risk).
  retry(force = false) {
    if (this.status === 'error' || this.status === 'off') {
      this.status = 'off';
      this.skipped = false;
      if (force) this._optIn = true;
      return this.load();
    }
    return Promise.resolve(this.ready);
  }

  // Called by whoever tracks the fight (enemy count near the player) so speak()
  // can defer fresh generation to a calmer moment instead of piling worker/tensor
  // overhead onto an already-busy frame. Cached lines still play instantly either
  // way -- only the (slow) model call is deferred.
  reportCombatLoad(nearbyEnemyCount) {
    this._combatBusy = nearbyEnemyCount > 8;
  }

  // anchor: optional { x, y, z } world position of the speaking character, passed
  // straight to onGenerating so the UI can float a "speaking soon" bubble on them.
  async speak(text, { voice = 'af_heart', speed = 1, anchor = null } = {}) {
    // ready === status 'ready' even after an idle release (tts is null then), so
    // gate on the status, not on tts: a released model is reloaded below.
    if (!this.ready) return false;
    const clean = normalizeForTTS(text);
    if (!clean) return false;
    const key = `${voice}|${speed}|${clean}`;

    // Cached line → play instantly, skipping the (slow) model call entirely.
    // This is what makes repeated barks/vendor lines feel snappy. Re-arm the
    // idle timer so a steady stream of cached lines still counts as activity.
    const cached = this._cache.get(key);
    if (cached) { this._armIdleRelease(); return this._playPcm(cached.audio, cached.sr); }

    // A fresh line needs a real generate() call. Skip it (rather than pile onto
    // an already-heavy fight) if the fight is heavy right now; the next calm
    // moment will pick it back up for whatever line comes next.
    if (this._combatBusy) return false;

    if (this._busy) return false; // a generation is already in flight
    this._busy = true;
    let signaled = false;
    try {
      // Lazily reload the model if it was released while idle. This adds the
      // first-line delay we accept in exchange for not keeping it resident.
      if (this._released || !this.tts) await this._ensureLoaded();
      if (!this.tts) return false;
      // Signal "generating" so the UI can float a bubble on the speaker's head.
      signaled = true;
      try { this.onGenerating?.(true, anchor); } catch { /* UI hook is best-effort */ }
      // Yield one full frame before kicking off generate(). The WASM backend is
      // proxied to a Worker (env...wasm.proxy = true) so its inference never
      // blocks the main thread, but the JS G2P/phonemize step and (on the
      // WebGPU backend) the GPU dispatch still run on the main thread. Deferring
      // to the next animation frame lets the in-flight render frame finish and
      // paint first, so a fresh line can't stall the frame that requested it.
      await new Promise((r) => (typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
      const result = await this.tts.generate(clean, { voice, speed });
      this._cache.set(key, { audio: result.audio, sr: result.sampling_rate });
      if (this._cache.size > 80) this._cache.delete(this._cache.keys().next().value);
      return this._playPcm(result.audio, result.sampling_rate);
    } catch (err) {
      console.warn('[neural-tts] generate failed', err);
      return false;
    } finally {
      this._busy = false;
      // Clear the bubble once audio has started (or generation failed), and
      // re-arm the idle-release countdown from this moment of activity.
      if (signaled) { try { this.onGenerating?.(false, anchor); } catch { /* best-effort */ } }
      this._armIdleRelease();
    }
  }

  // Play raw PCM (Float32) through the SFX bus. Reused by fresh + cached lines.
  _playPcm(audioData, sr) {
    this.stop();
    if (!audio.ctx) return false;
    const buf = audio.ctx.createBuffer(1, audioData.length, sr);
    buf.getChannelData(0).set(audioData);
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    const gain = audio.ctx.createGain();
    gain.gain.value = this.volume ?? 0.9;
    src.connect(gain);
    gain.connect(audio.sfxGain);
    src.start();
    this._current = src;
    src.onended = () => { if (this._current === src) this._current = null; };
    return true;
  }

  stop() {
    try { this._current?.stop(); } catch {}
    this._current = null;
  }
}

export const neuralVoice = new NeuralVoice();
if (import.meta.env.DEV && typeof window !== 'undefined') window.__neuralVoice = neuralVoice;
