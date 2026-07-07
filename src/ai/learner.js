// In-browser machine learning for enemy AI (TensorFlow.js) - MAIN-THREAD SHIM.
//
// A small MLP learns the player's movement habits online, during play:
//   input  (6): current move dir (x,z), aim dir (x,z), speed norm, "was dashing"
//   output (2): the player's actual displacement over the next 0.5 s
//
// Enemies query the net to LEAD their shots and INTERCEPT instead of tail-chasing.
//
// The tfjs model + training + inference now live in a Web Worker (learner.worker.js)
// so they never compete with rendering on the main thread. This class is a thin
// shim: observe() posts observation samples to the worker; predict() returns the
// LAST displacement the worker sent us (no main-thread tfjs). The worker posts a
// fresh prediction ~10Hz, which matches the old 100ms cache the callers relied on.
//
// Persistence: the worker owns the model and saves/loads it via IndexedDB
// ('indexeddb://emberdeep-ml-v1'), because localStorage is unavailable in a worker.
// The danger-range EMA is a plain number, so it round-trips through this shim and
// is saved to localStorage HERE (the same key as before, so the old value loads).
//
// Everything degrades gracefully: if the worker or tfjs fails to load, predict()
// returns null and enemies use base AI.

export class MovementLearner {
  constructor() {
    this.worker = null;
    this.available = false;  // worker + tfjs up
    this.ready = false;      // model has produced predictions
    this._pred = { dx: 0, dz: 0, has: false };
    // combat-outcome learning: the learned distance at which the player is
    // dangerous. Mirrored here from the worker so enemies read it synchronously.
    this.attackRangeEMA = null;
    this._hitCount = 0;
    try { const d = parseFloat(localStorage.getItem('emberdeep-danger-v1')); if (!Number.isNaN(d)) this.attackRangeEMA = d; } catch { /* ignore */ }
  }

  // Called whenever the PLAYER lands a hit, with the player->target distance. The
  // worker keeps the EMA and posts the updated value back; we persist it here (the
  // worker cannot touch localStorage).
  recordPlayerHit(dist) {
    if (!this.worker || !(dist >= 0)) return;
    this.worker.postMessage({ type: 'hit', dist });
  }

  // The learned distance at which the player is dangerous (or null if unlearned).
  dangerRange() { return this.attackRangeEMA; }

  init() {
    try {
      // Vite bundles this worker; { type: 'module' } lets it use dynamic import().
      this.worker = new Worker(new URL('./learner.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (err) => {
        console.warn('[ML] learner worker error; enemies use base AI.', err.message || err);
        this.available = false;
        this.ready = false;
      };
      this.worker.postMessage({ type: 'init', seedDanger: this.attackRangeEMA });
    } catch (err) {
      console.warn('[ML] could not start learner worker; enemies use base AI.', err);
      this.worker = null;
    }
  }

  _onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.available = true;
        console.info(`[ML] TensorFlow.js ready in worker (backend: ${m.backend})${m.resumed ? ' - resumed learned model' : ''}. Enemies will learn your movement.`);
        break;
      case 'failed':
        this.available = false;
        this.ready = false;
        console.warn('[ML] TensorFlow.js unavailable in worker; enemies use base AI.', m.error);
        break;
      case 'pred':
        this._pred = { dx: m.dx, dz: m.dz, has: true };
        this.ready = true;
        break;
      case 'danger':
        this.attackRangeEMA = m.value;
        if ((++this._hitCount % 20) === 0) {
          try { localStorage.setItem('emberdeep-danger-v1', String(this.attackRangeEMA.toFixed(2))); } catch { /* ignore */ }
        }
        break;
      case 'trainError':
        console.warn('[ML] training failed', m.error);
        break;
      default: break;
    }
  }

  // Called every frame while playing. Posts an observation sample to the worker,
  // which does all sampling/labelling/training on its own thread.
  observe(dt, player) {
    if (!this.worker || player.dead) return;
    this.worker.postMessage({
      type: 'observe',
      sample: {
        dt,
        input: [
          player.moveDir.x, player.moveDir.z,
          player.aimDir.x, player.aimDir.z,
          Math.min(1, player.moveSpeed / 10),
          player.dash ? 1 : 0,
        ],
        px: player.pos.x, pz: player.pos.z,
      },
    });
  }

  // Predicted player displacement over the next 0.5 s, or null. Returns the last
  // value the worker sent (posted ~10Hz), so callers can read it synchronously
  // every frame exactly as before.
  predict(player) {
    if (!this.available || !this.ready || !this._pred.has || player.dead) return null;
    return this._pred;
  }

  reset() {
    if (this.worker) this.worker.postMessage({ type: 'reset' });
  }
}

export const learner = new MovementLearner();
