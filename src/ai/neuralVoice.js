import { audio } from '../core/audio.js';

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
    this._busy = true;
    try {
      const result = await this.tts.generate(text, { voice, speed });
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
