// In-browser machine learning for enemy AI (TensorFlow.js).
//
// A small MLP learns the player's movement habits online, during play:
//   input  (6): current move dir (x,z), aim dir (x,z), speed norm, "was dashing"
//   output (2): the player's actual displacement over the next 0.5 s
//
// Enemies query the net to LEAD their shots and INTERCEPT instead of tail-chasing.
// Everything degrades gracefully: if tfjs fails to load or training hasn't
// produced a model yet, predict() returns null and enemies use base AI.

const HORIZON = 0.5;        // seconds ahead we learn to predict
const SAMPLE_EVERY = 0.25;  // seconds between recorded samples
const BUFFER_MAX = 400;     // rolling window of samples
const TRAIN_EVERY = 6;      // seconds between background training runs
const MIN_SAMPLES = 48;

export class MovementLearner {
  constructor() {
    this.tf = null;
    this.model = null;
    this.ready = false;      // model trained at least once
    this.training = false;
    this.buffer = [];
    this.pending = null;     // sample waiting for its future-position label
    this.sampleTimer = 0;
    this.trainTimer = TRAIN_EVERY;
    this.trainCount = 0;
    this._predCache = { t: 0, dx: 0, dz: 0 };
  }

  async init() {
    try {
      this.tf = await import('@tensorflow/tfjs');
      // CPU backend: this net is ~350 params — WebGL adds shader-compile jank
      // and dataSync() GPU stalls that hitch the frame loop. CPU is faster here.
      await this.tf.setBackend('cpu');
      await this.tf.ready();
      const tf = this.tf;
      // Resume the model learned in previous sessions, if any — the enemies
      // remember your habits across visits.
      try {
        this.model = await tf.loadLayersModel('localstorage://emberdeep-ml-v1');
        this.ready = true;
        console.info('[ML] Loaded learned movement model from previous sessions.');
      } catch {
        this.model = tf.sequential({
          layers: [
            tf.layers.dense({ inputShape: [6], units: 16, activation: 'relu' }),
            tf.layers.dense({ units: 12, activation: 'relu' }),
            tf.layers.dense({ units: 2 }),
          ],
        });
      }
      this.model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });
      console.info(`[ML] TensorFlow.js ready (backend: ${tf.getBackend()}) — enemies will learn your movement.`);
    } catch (err) {
      console.warn('[ML] TensorFlow.js unavailable; enemies use base AI.', err);
      this.tf = null;
    }
  }

  // Called every frame while playing.
  observe(dt, player) {
    if (!this.tf || player.dead) return;

    // finish a pending sample once its horizon elapses
    if (this.pending) {
      this.pending.age += dt;
      if (this.pending.age >= HORIZON) {
        const dx = player.pos.x - this.pending.px;
        const dz = player.pos.z - this.pending.pz;
        this.buffer.push({ x: this.pending.input, y: [dx, dz] });
        if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
        this.pending = null;
      }
    }

    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0 && !this.pending) {
      this.sampleTimer = SAMPLE_EVERY;
      this.pending = {
        input: [
          player.moveDir.x, player.moveDir.z,
          player.aimDir.x, player.aimDir.z,
          Math.min(1, player.moveSpeed / 10),
          player.dash ? 1 : 0,
        ],
        px: player.pos.x, pz: player.pos.z,
        age: 0,
      };
    }

    this.trainTimer -= dt;
    if (this.trainTimer <= 0) {
      this.trainTimer = TRAIN_EVERY;
      this.train();
    }
  }

  async train() {
    if (!this.tf || this.training || this.buffer.length < MIN_SAMPLES) return;
    this.training = true;
    const tf = this.tf;
    const xs = tf.tensor2d(this.buffer.map((s) => s.x));
    const ys = tf.tensor2d(this.buffer.map((s) => s.y));
    try {
      await this.model.fit(xs, ys, { epochs: 2, batchSize: 64, shuffle: true, verbose: 0 });
      this.trainCount++;
      this.ready = true;
      // persist every few training rounds so learning carries across sessions
      if (this.trainCount % 3 === 1) {
        this.model.save('localstorage://emberdeep-ml-v1').catch(() => {});
      }
    } catch (err) {
      console.warn('[ML] training failed', err);
    } finally {
      xs.dispose();
      ys.dispose();
      this.training = false;
    }
  }

  // Predicted player displacement over the next 0.5 s, or null.
  // Cached for 100 ms so many enemies can share one inference.
  predict(player) {
    if (!this.tf || !this.ready || player.dead) return null;
    const now = performance.now();
    if (now - this._predCache.t < 100) return this._predCache;
    const tf = this.tf;
    const out = tf.tidy(() => {
      const input = tf.tensor2d([[
        player.moveDir.x, player.moveDir.z,
        player.aimDir.x, player.aimDir.z,
        Math.min(1, player.moveSpeed / 10),
        player.dash ? 1 : 0,
      ]]);
      return this.model.predict(input).dataSync();
    });
    // clamp to plausible displacement
    const cl = (v) => Math.max(-6, Math.min(6, v));
    this._predCache = { t: now, dx: cl(out[0]), dz: cl(out[1]) };
    return this._predCache;
  }

  reset() {
    this.buffer.length = 0;
    this.pending = null;
    this.ready = this.ready && true;
  }
}

export const learner = new MovementLearner();
