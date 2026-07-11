// Kokoro inference WORKER (Obsidian 745). The onnxruntime-web `wasm.proxy`
// flag only offloads the WASM backend - on WebGPU (the desktop fast path)
// session-create and every generate() ran on the MAIN thread, so a line
// being synthesized visibly hitched gameplay while the thinking pill was up.
// This worker hosts the whole kokoro-js pipeline instead (WebGPU is
// available inside workers on Chromium); the main thread just posts text and
// receives a transferred Float32Array back. neuralVoice.js falls back to the
// old in-page pipeline automatically if this worker fails to boot.
let tts = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const { KokoroTTS, env } = await import('kokoro-js');
      try { env.backends.onnx.wasm.numThreads = 1; } catch { /* env shape changed */ }
      tts = await KokoroTTS.from_pretrained(m.model, {
        device: m.device,
        dtype: m.dtype,
        progress_callback: (p) => {
          if ((p.status === 'progress' || p.status === 'download') && p.total) {
            self.postMessage({ type: 'progress', loaded: p.loaded || 0, total: p.total });
          }
        },
      });
      self.postMessage({ type: 'loaded', id: m.id });
    } else if (m.type === 'generate') {
      if (!tts) throw new Error('model not loaded');
      const result = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      // copy into a fresh buffer so the transfer can never detach a view the
      // pipeline still owns
      const audio = new Float32Array(result.audio);
      self.postMessage({ type: 'result', id: m.id, audio, sr: result.sampling_rate }, [audio.buffer]);
    } else if (m.type === 'dispose') {
      try { tts?.dispose?.(); } catch { /* best-effort */ }
      tts = null;
      self.postMessage({ type: 'disposed', id: m.id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String(err && err.message ? err.message : err) });
  }
};
