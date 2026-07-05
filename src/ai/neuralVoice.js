import { audio } from '../core/audio.js';

// Neural TTS via Kokoro-82M (kokoro-js / transformers.js, Apache 2.0).
// Opt-in: the quantized model is a ~90 MB one-time download, cached by the
// browser afterwards. WebGPU when available, WASM otherwise. Falls back to
// the standard Web Speech voices whenever it isn't ready.
class NeuralVoice {
  constructor() {
    this.status = 'off';   // off | loading | ready | error
    this.tts = null;
    this.progress = 0;
    this.onStatus = null;  // UI hook
    this._current = null;  // currently playing source
    this._busy = false;
  }

  get ready() { return this.status === 'ready'; }

  _set(status) {
    this.status = status;
    this.onStatus?.(status, this.progress);
  }

  async load() {
    if (this.status === 'loading' || this.status === 'ready') return this.ready;
    this._set('loading');
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const hasWebGPU = !!navigator.gpu;
      this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: hasWebGPU ? 'fp32' : 'q8',
        device: hasWebGPU ? 'webgpu' : 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            this.progress = p.loaded / p.total;
            this.onStatus?.('loading', this.progress);
          }
        },
      });
      this._set('ready');
      return true;
    } catch (err) {
      console.warn('[neural-tts] load failed; using standard voices', err);
      this._set('error');
      return false;
    }
  }

  // Generate and play. Drops the request if a line is already generating —
  // characters shouldn't stack chatter.
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
