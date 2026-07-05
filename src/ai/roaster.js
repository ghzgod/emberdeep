import { learner } from './learner.js';
import { net } from '../net/net.js';
import { CLASSES as CLASSES_BY_NAME } from '../entities/classes.js';

// Elite enemies read your playstyle and ROAST you for it, out loud.
// Behavior detection combines live combat telemetry with the TensorFlow.js
// movement predictor (a big predicted displacement away from the elite = a
// runner). Speech uses the browser's speech-synthesis voices, cast per enemy:
// deep male voices for golems/skeletons, higher/female voices for the
// Broodmother's spiders and cackling imps.

const LINES = {
  intro: [
    'Fresh meat wanders into my hall.',
    'Another {name} for my collection.',
    'Little {name}, you reek of fear.',
    '{name}, the stairs are MINE.',
  ],
  flee: [
    'Running already, {name}? The exit is sealed, coward.',
    'Look at those little legs go! Pathetic.',
    'You run like the last {name} I ate.',
    'Flee all you like. I already know where you are going.',
    '{name}, cardio will not save you.',
  ],
  hide: [
    '{name}, I see you skulking behind that wall.',
    'Hiding? In MY room? Adorable.',
    'Come out, come out. The floor already told me where you stand.',
    'Is the brave {name} playing hide and seek?',
  ],
  idle: [
    'Standing still, {name}? Bold strategy.',
    'Did you fall asleep, {name}? I can fix that. Permanently.',
    'Statues die too, you know.',
  ],
  chug: [
    'Another potion, {name}?! Leave some for the alchemist.',
    'Drink up, {name}. You will bleed it right back out.',
    '{name}, the bottle will not love you back.',
  ],
  kite: [
    '{name}, poke and run, poke and run. Fight me properly!',
    'All that dancing and barely a scratch on me.',
    '{name}, you fight like a nervous chicken.',
  ],
  lowhp: [
    '{name}, I hear your heartbeat stuttering.',
    'One more hit, {name}. Just one.',
    'You are leaking, {name}. Everywhere.',
  ],
  duo: [
    'TWO of you? Good. I was still hungry.',
    'Bring your whole party. Bring a healer. Bring a priest for the funeral.',
    'Which of you dies first? I am flexible.',
    'A {name} AND a {name2}? The {name2} dies first. Nothing personal.',
  ],
  playerDeath: [
    'And STAY down.',
    'Was that it? Truly?',
    '{name}, tell the town I said hello.',
  ],
  generic: [
    'My grandmother swings harder, and she is a skeleton.',
    'Is this the hero the depths were warned about?',
    '{name}, is that your hardest swing? Yawn.',
  ],
  ability: [
    '{name}, your precious {ability} will not save you.',
    'Oh no. Not {ability}. Anything but {ability}. I am so scared.',
    '{name}, I have eaten heroes who used {ability} better than you.',
    'Spamming {ability} again, {name}? Predictable.',
  ],
};

// Voice casting per enemy type. `kokoro` picks the neural voice when the
// Kokoro engine is enabled; pitch/rate shape the Web Speech fallback.
// Every speaking character gets a UNIQUE voice: distinct kokoro ids for the
// neural engine, and distinct system-voice indexes (vi) + pitch/rate shaping
// for the Web Speech fallback.
const VOICE_CAST = {
  skeleton: { female: false, vi: 0, pitch: 0.5, rate: 0.92, kokoro: 'bm_lewis', kSpeed: 0.92 },
  golem: { female: false, vi: 1, pitch: 0.25, rate: 0.78, kokoro: 'am_onyx', kSpeed: 0.8 },
  imp: { female: true, vi: 0, pitch: 1.6, rate: 1.18, kokoro: 'af_nicole', kSpeed: 1.15 },
  spider: { female: true, vi: 1, pitch: 1.35, rate: 1.05, kokoro: 'af_sky', kSpeed: 1.05 },
};

const FEMALE_HINT = /female|samantha|victoria|karen|moira|tessa|fiona|kate|serena|susan|allison|ava|zira|jenny/i;
const MALE_HINT = /male|daniel|alex|fred|arthur|george|aaron|guy|david|mark|james|oliver/i;

export class Roaster {
  constructor() {
    this.enabled = true;
    this.timer = 5;
    this.voices = [];
    this.lastCategory = null;
    if ('speechSynthesis' in window) {
      const load = () => { this.voices = speechSynthesis.getVoices(); };
      load();
      speechSynthesis.onvoiceschanged = load;
    }
  }

  pickVoice(typeId) {
    const cast = VOICE_CAST[typeId] || VOICE_CAST.skeleton;
    const en = this.voices.filter((v) => v.lang.startsWith('en'));
    const pool = en.length ? en : this.voices;
    if (!pool.length) return { voice: null, ...cast };
    const gendered = pool.filter((v) => (cast.female ? FEMALE_HINT : MALE_HINT).test(v.name));
    const source = gendered.length ? gendered : pool;
    const voice = source[(cast.vi || 0) % source.length];
    return { voice, ...cast };
  }

  speak(text, typeId) {
    this.speakAs(text, this.pickVoice(typeId));
  }

  // Speak with an explicit voice cast — vendors, narrators, anyone.
  // Prefers the neural Kokoro engine when it's loaded; Web Speech otherwise.
  speakAs(text, cast) {
    if (!this.enabled) return;
    import('./neuralVoice.js').then(async ({ neuralVoice }) => {
      if (neuralVoice.ready) {
        const ok = await neuralVoice.speak(text, { voice: cast.kokoro || 'af_heart', speed: cast.kSpeed || cast.rate || 1 });
        if (ok) return;
      }
      // Kokoro is the only voice. While it's still downloading we stay SILENT
      // (the subtitle already conveys the line) rather than fall back to the
      // robotic Web Speech synth. Only use Web Speech if Kokoro truly failed to
      // load on this device, so a broken model doesn't mute every character.
      if (neuralVoice.status === 'error') this._speakWebSpeech(text, cast);
    }).catch(() => this._speakWebSpeech(text, cast));
  }

  _speakWebSpeech(text, cast) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel(); // characters don't talk over each other
      const u = new SpeechSynthesisUtterance(text);
      let voice = cast.voice;
      if (!voice) {
        const en = this.voices.filter((v) => v.lang.startsWith('en'));
        const pool = en.length ? en : this.voices;
        const gendered = pool.filter((v) => (cast.female ? FEMALE_HINT : MALE_HINT).test(v.name));
        const source = gendered.length ? gendered : pool;
        voice = source[(cast.vi || 0) % source.length];
      }
      if (voice) u.voice = voice;
      u.pitch = cast.pitch ?? 1;
      u.rate = cast.rate ?? 1;
      u.volume = this.volume ?? 0.9;
      speechSynthesis.speak(u);
    } catch { /* speech not available */ }
  }

  // Figure out what the target deserves to be mocked for.
  analyze(game, elite, target) {
    const now = performance.now();
    if (target.local) {
      const p = game.player;
      const d = Math.hypot(p.pos.x - elite.pos.x, p.pos.z - elite.pos.z);
      if (p.hp / p.maxHp < 0.25) return 'lowhp';
      if (now - (p._lastPotionAt || 0) < 4000) return 'chug';
      const moving = p.moveDir.x || p.moveDir.z;
      if (!moving && now - (p._lastAttackAt || 0) > 5000) return 'idle';
      // TF movement prediction: big displacement pointing away = runner
      const pred = learner.predict(p);
      if (pred) {
        const mag = Math.hypot(pred.dx, pred.dz);
        if (mag > 1.6) {
          const ax = elite.pos.x - p.pos.x, az = elite.pos.z - p.pos.z;
          const dot = pred.dx * ax + pred.dz * az;
          if (dot < 0) return 'flee';
        }
      }
      if (d > 9 && !game.hasLineOfSight(elite.pos, p.pos)) return 'hide';
      if (d > 6 && now - (p._lastAttackAt || 0) < 2500) return 'kite';
      return 'generic';
    }
    // remote players: position-based reads only
    const d = Math.hypot(target.pos.x - elite.pos.x, target.pos.z - elite.pos.z);
    if (d > 9 && !game.hasLineOfSight(elite.pos, target.pos)) return 'hide';
    if (d > 7) return 'flee';
    return 'generic';
  }

  update(dt, game) {
    if (!this.enabled || !game.player || game.inTown) return;
    const elite = game.enemies.find((e) => !e.dead && e.elite && e.state && e.state !== 'idle');
    if (!elite) { this.timer = Math.min(this.timer, 4); return; }
    // guests just listen; the host does the talking
    if (net.active && !net.isHost) return;

    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 9 + Math.random() * 6;

    // pick a victim: local player or a connected guest. Elites know your NAME.
    const targets = [{ local: true, cls: game.player.classDef.name, name: game.playerName() }];
    if (net.isHost) {
      for (const rp of game.remotePlayers.values()) {
        if (!rp.dead && !rp.away) targets.push({ local: false, pos: rp.target, cls: (rp.cls || 'hero'), name: rp.name });
      }
    }
    const target = targets[Math.floor(Math.random() * targets.length)];

    let category;
    if (!elite._introDone) { category = targets.length > 1 ? 'duo' : 'intro'; elite._introDone = true; }
    else category = this.analyze(game, elite, target);
    if (category === 'generic' && Math.random() < 0.4) category = 'ability';
    if (category === this.lastCategory && Math.random() < 0.5) category = 'generic';
    this.lastCategory = category;

    const pretty = (c) => { const s = String(c || 'hero'); return s.charAt(0).toUpperCase() + s.slice(1); };
    // address by real name most of the time, class as an insult otherwise
    const address = target.name && Math.random() < 0.7 ? target.name : pretty(target.cls);
    const bank = LINES[category] || LINES.generic;
    let line = bank[Math.floor(Math.random() * bank.length)];
    const name2 = targets.length > 1 ? targets[(targets.indexOf(target) + 1) % targets.length].name || 'friend' : 'friend';
    // they know your kit: mock one of the target class's actual abilities
    const clsDef = Object.values(CLASSES_BY_NAME).find((c) => c.name === pretty(target.cls));
    const ability = clsDef ? clsDef.abilities[Math.floor(Math.random() * clsDef.abilities.length)].name : 'flailing';
    // The player's NAME must never be the last word — a trailing name reads as an
    // awkward tacked-on pause. If the template ends with {name}, swap that final
    // one for an epithet; the name still lands earlier in other lines.
    if (/\{name\}[^A-Za-z0-9]*$/.test(line)) {
      const epithets = [pretty(target.cls), 'coward', 'fool', 'worm', 'wretch', 'little one'];
      const ep = epithets[Math.floor(Math.random() * epithets.length)];
      line = line.replace(/\{name\}([^A-Za-z0-9]*)$/, ep + '$1');
    }
    line = line.replaceAll('{name}', address).replaceAll('{name2}', pretty(name2)).replaceAll('{ability}', ability);

    this.deliver(game, elite, line);
    if (net.isHost) net.send({ t: 'roast', txt: line, ty: elite.typeId, ei: elite.netId });
  }

  onPlayerDeath(game, cls) {
    if (!this.enabled) return;
    const elite = game.enemies.find((e) => !e.dead && e.elite);
    if (!elite) return;
    const line = LINES.playerDeath[Math.floor(Math.random() * LINES.playerDeath.length)].replaceAll('{name}', cls);
    this.deliver(game, elite, line);
    if (net.isHost) net.send({ t: 'roast', txt: line, ty: elite.typeId, ei: elite.netId });
  }

  deliver(game, elite, line) {
    game.ui.showSubtitle(elite.name || 'Elite', line, 3600);
    this.speak(line, elite.typeId);
  }
}

export const roaster = new Roaster();
