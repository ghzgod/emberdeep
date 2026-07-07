// TensorFlow.js movement learner - WORKER SIDE.
//
// This owns the model and does ALL tfjs work (predict + training) off the main
// thread so it never competes with rendering. The main thread (learner.js) sends
// observation samples via postMessage and receives a continuous stream of the
// LATEST predicted displacement {dx,dz} plus the learned dangerRange. Enemies on
// the main thread read that last value synchronously every frame - no tfjs on the
// main thread at all.
//
// Persistence lives HERE via IndexedDB (localStorage is not available in a
// worker; IndexedDB is). The model is saved/loaded under 'indexeddb://emberdeep-ml-v1'.
// The danger-range EMA is a plain number, so it is posted back to the main thread
// and saved to localStorage there (localStorage carries the pre-worker value).
//
// Everything degrades gracefully: if tfjs fails to load or import, we tell the
// main thread we are unavailable and it falls back to base AI (predict() null).

const HORIZON = 0.5;        // seconds ahead we learn to predict
const SAMPLE_EVERY = 0.25;  // seconds between recorded samples
const BUFFER_MAX = 400;     // rolling window of samples
const TRAIN_EVERY = 6;      // seconds between background training runs
const MIN_SAMPLES = 48;
const PRED_EVERY = 100;     // ms between prediction posts (~10Hz, matches old cache)

let tf = null;
let model = null;
let ready = false;          // model trained (or loaded) at least once
let training = false;
let buffer = [];
let pending = null;         // sample waiting for its future-position label
let sampleTimer = 0;
let trainTimer = TRAIN_EVERY;
let trainCount = 0;
let lastInput = null;       // most recent observation input vector (for prediction)
let lastPredPost = 0;

// combat-outcome learning: EMA of how far away the player lands hits. Seeded from
// the main thread (which read it from localStorage) so it carries across sessions.
let attackRangeEMA = null;
let hitCount = 0;

function post(msg) { self.postMessage(msg); }

async function init(seedDanger) {
  if (typeof seedDanger === 'number' && !Number.isNaN(seedDanger)) attackRangeEMA = seedDanger;
  try {
    tf = await import('@tensorflow/tfjs');
    // CPU backend: this net is ~350 params - WebGL adds shader-compile jank and
    // dataSync() GPU stalls. On the worker thread CPU is both simplest and fastest.
    await tf.setBackend('cpu');
    await tf.ready();
    // Resume the model learned in previous sessions, if any.
    try {
      model = await tf.loadLayersModel('indexeddb://emberdeep-ml-v1');
      ready = true;
    } catch {
      model = tf.sequential({
        layers: [
          tf.layers.dense({ inputShape: [6], units: 16, activation: 'relu' }),
          tf.layers.dense({ units: 12, activation: 'relu' }),
          tf.layers.dense({ units: 2 }),
        ],
      });
    }
    model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });
    post({ type: 'ready', backend: tf.getBackend(), resumed: ready });
  } catch (err) {
    tf = null;
    post({ type: 'failed', error: String(err && err.message ? err.message : err) });
  }
}

// A single observation tick, mirroring the old main-thread observe().
// `s` = { dt, input:[6], px, pz } where input is the current player feature
// vector and px/pz is the player position at sample time.
function observe(s) {
  if (!tf) return;
  const dt = s.dt;
  lastInput = s.input;

  // finish a pending sample once its horizon elapses
  if (pending) {
    pending.age += dt;
    if (pending.age >= HORIZON) {
      const dx = s.px - pending.px;
      const dz = s.pz - pending.pz;
      buffer.push({ x: pending.input, y: [dx, dz] });
      if (buffer.length > BUFFER_MAX) buffer.shift();
      pending = null;
    }
  }

  sampleTimer -= dt;
  if (sampleTimer <= 0 && !pending) {
    sampleTimer = SAMPLE_EVERY;
    pending = { input: s.input, px: s.px, pz: s.pz, age: 0 };
  }

  trainTimer -= dt;
  if (trainTimer <= 0) {
    trainTimer = TRAIN_EVERY;
    train();
  }

  // Post the latest prediction at ~10Hz. Enemies use the newest value we sent.
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (ready && lastInput && now - lastPredPost >= PRED_EVERY) {
    lastPredPost = now;
    predictAndPost(lastInput);
  }
}

function predictAndPost(input) {
  if (!tf || !ready) return;
  let out;
  try {
    out = tf.tidy(() => model.predict(tf.tensor2d([input])).dataSync());
  } catch { return; }
  const cl = (v) => Math.max(-6, Math.min(6, v));
  post({ type: 'pred', dx: cl(out[0]), dz: cl(out[1]) });
}

async function train() {
  if (!tf || training || buffer.length < MIN_SAMPLES) return;
  training = true;
  const xs = tf.tensor2d(buffer.map((s) => s.x));
  const ys = tf.tensor2d(buffer.map((s) => s.y));
  try {
    await model.fit(xs, ys, { epochs: 2, batchSize: 64, shuffle: true, verbose: 0 });
    trainCount++;
    ready = true;
    // persist every few training rounds so learning carries across sessions
    if (trainCount % 3 === 1) {
      model.save('indexeddb://emberdeep-ml-v1').catch(() => {});
    }
  } catch (err) {
    post({ type: 'trainError', error: String(err && err.message ? err.message : err) });
  } finally {
    xs.dispose();
    ys.dispose();
    training = false;
  }
}

// Player landed a hit at `dist`. Same EMA as before; the updated value is posted
// back so the main thread can persist it to localStorage and enemies can read it.
function recordPlayerHit(dist) {
  if (!(dist >= 0)) return;
  const d = Math.min(9, dist);
  attackRangeEMA = attackRangeEMA == null ? d : attackRangeEMA * 0.96 + d * 0.04;
  post({ type: 'danger', value: attackRangeEMA });
}

function reset() {
  buffer.length = 0;
  pending = null;
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': init(m.seedDanger); break;
    case 'observe': observe(m.sample); break;
    case 'hit': recordPlayerHit(m.dist); break;
    case 'reset': reset(); break;
    default: break;
  }
};
