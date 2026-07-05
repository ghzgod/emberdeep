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
class NeuralVoice {
  constructor() {
    this.status = 'off';   // off | loading | ready | error
    this.tts = null;
    this.progress = 0;
    this.onStatus = null;  // UI hook
    this.lastError = '';
    this._current = null;
    this._busy = false;
  }

  get ready() { return this.status === 'ready'; }

  _set(status) {
    this.status = status;
    this.onStatus?.(status, this.progress, this.lastError);
  }

  async load() {
    if (this.status === 'loading' || this.status === 'ready') return this.ready;
    this.lastError = '';
    this._set('loading');
    try {
      const { KokoroTTS, env } = await import('kokoro-js');

      // Single-threaded WASM: works everywhere, no SharedArrayBuffer needed.
      try {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      } catch { /* env shape changed; best-effort */ }

      // WASM q8 first: the most compatible path (WebGPU session-create can
      // hang indefinitely on some GPUs without ever rejecting). Each attempt
      // is time-boxed so a hang falls through instead of stalling forever.
      const attempts = [
        { device: 'wasm', dtype: 'q8', timeout: 120000 },
        ...(navigator.gpu ? [{ device: 'webgpu', dtype: 'fp32', timeout: 60000 }] : []),
      ];
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
          this._set('ready');
          return true;
        } catch (err) {
          lastErr = err;
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

  // Allow a manual retry after a failure.
  retry() {
    if (this.status === 'error' || this.status === 'off') {
      this.status = 'off';
      return this.load();
    }
    return Promise.resolve(this.ready);
  }

  async speak(text, { voice = 'af_heart', speed = 1 } = {}) {
    if (!this.ready || this._busy) return false;
    const clean = normalizeForTTS(text);
    if (!clean) return false;
    this._busy = true;
    try {
      const result = await this.tts.generate(clean, { voice, speed });
      this.stop();
      if (!audio.ctx) { this._busy = false; return false; }
      const buf = audio.ctx.createBuffer(1, result.audio.length, result.sampling_rate);
      buf.getChannelData(0).set(result.audio);
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
    } catch (err) {
      console.warn('[neural-tts] generate failed', err);
      return false;
    } finally {
      this._busy = false;
    }
  }

  stop() {
    try { this._current?.stop(); } catch {}
    this._current = null;
  }
}

export const neuralVoice = new NeuralVoice();
if (typeof window !== 'undefined') window.__neuralVoice = neuralVoice;
