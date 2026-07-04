import { learner } from './learner.js';
import { net } from '../net/net.js';

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
    'You smell of fear, little {name}.',
    'The stairs are MINE, {name}.',
  ],
  flee: [
    'Running already, {name}? The exit is sealed, coward.',
    'Look at those little legs go! Pathetic.',
    'You run like the last {name} I ate.',
    'Flee all you like — I already know where you are going.',
    'Cardio will not save you, {name}.',
  ],
  hide: [
    'I can see you skulking behind the wall, {name}.',
    'Hiding? In MY room? Adorable.',
    'Come out, come out… the floor already told me where you stand.',
    'Is the brave {name} playing hide and seek?',
  ],
  idle: [
    'Are you… standing still? Bold strategy, {name}.',
    'Did you fall asleep, {name}? I can fix that. Permanently.',
    'Statues die too, you know.',
  ],
  chug: [
    'Another potion?! Leave some for the alchemist, {name}.',
    'Drink up, {name} — you will bleed it right back out.',
    'The bottle will not love you back, {name}.',
  ],
  kite: [
    'Poke and run, poke and run. Fight me properly, {name}!',
    'All that dancing and barely a scratch on me.',
    'You fight like a nervous chicken, {name}.',
  ],
  lowhp: [
    'I can hear your heartbeat stuttering, {name}.',
    'One more hit, {name}. Just one.',
    'You are leaking, {name}. Everywhere.',
  ],
  duo: [
    'TWO of you? Good — I was still hungry.',
    'Bring your whole party. Bring a healer. Bring a priest for the funeral.',
    'Which of you dies first? I am flexible.',
    'A {name} AND a {name2}? The {name2} dies first. Nothing personal.',
  ],
  playerDeath: [
    'And STAY down.',
    'Was that it? Truly?',
    'Tell the town I said hello, {name}.',
  ],
  generic: [
    'My grandmother swings harder, and she is a skeleton.',
    'Is this the hero the depths were warned about?',
    'Yawn. Swing harder, {name}.',
  ],
};

// Voice casting per enemy type: [preferFemale, pitch, rate]
const VOICE_CAST = {
  skeleton: { female: false, pitch: 0.5, rate: 0.92 },
  golem: { female: false, pitch: 0.25, rate: 0.78 },
  imp: { female: true, pitch: 1.6, rate: 1.18 },
  spider: { female: true, pitch: 1.35, rate: 1.05 },
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
    const voice = (gendered.length ? gendered : pool)[0];
    return { voice, ...cast };
  }

  speak(text, typeId) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel(); // elites don't talk over themselves
      const u = new SpeechSynthesisUtterance(text);
      const { voice, pitch, rate } = this.pickVoice(typeId);
      if (voice) u.voice = voice;
      u.pitch = pitch;
      u.rate = rate;
      u.volume = 0.9;
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

    // pick a victim: local player or a connected guest
    const targets = [{ local: true, cls: game.player.classDef.name }];
    if (net.isHost) {
      for (const rp of game.remotePlayers.values()) {
        if (!rp.dead && !rp.away) targets.push({ local: false, pos: rp.target, cls: (rp.cls || 'hero') });
      }
    }
    const target = targets[Math.floor(Math.random() * targets.length)];

    let category;
    if (!elite._introDone) { category = targets.length > 1 ? 'duo' : 'intro'; elite._introDone = true; }
    else category = this.analyze(game, elite, target);
    if (category === this.lastCategory && Math.random() < 0.5) category = 'generic';
    this.lastCategory = category;

    const pretty = (c) => { const s = String(c || 'hero'); return s.charAt(0).toUpperCase() + s.slice(1); };
    const bank = LINES[category] || LINES.generic;
    let line = bank[Math.floor(Math.random() * bank.length)];
    const name2 = targets.length > 1 ? targets[(targets.indexOf(target) + 1) % targets.length].cls : 'friend';
    line = line.replaceAll('{name}', pretty(target.cls)).replaceAll('{name2}', pretty(name2));

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
    game.ui.floaters.spawn(elite.pos, `“${line}”`, 'roast', 3.2);
    this.speak(line, elite.typeId);
  }
}

export const roaster = new Roaster();
