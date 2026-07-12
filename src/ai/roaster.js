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

// Foul one-time greetings the moment the player first approaches a mob LEADER
// (elite / miniboss / boss). The name always leads — never a trailing pause.
const GREETINGS = [
  '{name}. I have been picking the last hero out of my teeth. You will taste better.',
  'Ah, {name} — fresh meat and half a brain. My favorite.',
  '{name}, you reek of the surface. Hold still, I will fix that. Permanently.',
  '{name}! Come closer. It only hurts until you stop breathing.',
  '{name}, the floor already knows your name. Soon it wears your face.',
  '{name} — running would be the clever move. You will not, of course.',
  '{name}, so the little morsel finally waddles into my hall.',
  '{name}, kneel or bleed. I am flexible. You are not.',
];

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

// Per-boss voices + personalities. Every act lord (and the Dungeon Lord) speaks
// through the shared golem cast by default because Boss extends Enemy('golem');
// these give each a DISTINCT voice (pitch/rate/gender + neural id) and a small
// personality line bank so they feel like different characters. Keyed by the
// boss's `act` (1..5), matching ACT_BOSSES in enemies.js.
const BOSS_CAST = {
  1: { female: false, vi: 2, pitch: 0.4,  rate: 0.82, kokoro: 'am_michael', kSpeed: 0.85 }, // Gravewarden Malruk — grim, grave
  2: { female: true,  vi: 2, pitch: 1.25, rate: 1.0,  kokoro: 'af_bella',   kSpeed: 1.0 },  // Broodqueen Sszarra — hissing, regal
  3: { female: false, vi: 3, pitch: 0.7,  rate: 1.05, kokoro: 'am_adam',    kSpeed: 1.05 }, // Pyrarch Vexmal — fiery, manic
  4: { female: false, vi: 1, pitch: 0.2,  rate: 0.7,  kokoro: 'am_onyx',    kSpeed: 0.72 }, // Obsidian Colossus — vast, slow
  5: { female: false, vi: 4, pitch: 0.32, rate: 0.8,  kokoro: 'bm_george',  kSpeed: 0.9 },  // The Dungeon Lord (final-act dragon) — cold, sovereign, demonic
};

const BOSS_LINES = {
  1: [
    '{name}. The grave I dug was meant for you.',
    'My skeletons rise faster than you fall, {name}.',
    'Kneel in the dirt where you belong.',
  ],
  2: [
    'My children are already spinning your shroud, {name}.',
    'Struggle, little fly. The web only tightens.',
    'I have laid ten thousand eggs. You will feed but a few.',
  ],
  3: [
    'BURN, {name}! Everything burns in the end!',
    'You bring steel to my forge? How thoughtful.',
    'Ash and cinder. That is all you will leave behind.',
  ],
  4: [
    'You. Are. Nothing before the mountain, {name}.',
    'Stone remembers. Stone does not forgive.',
    'I have stood since before your kind crawled. I will stand after.',
  ],
  5: [
    'You have come far, {name}. Far enough to die properly.',
    'This whole dungeon is my body. You are already inside me.',
    'Every hero before you knelt. You will simply kneel sooner.',
  ],
};

// Vendor/NPC greeting openers, in-voice, first-meeting vs "welcome back".
// The name is NEVER baked into these — composeVendorLine() weaves it in on a
// random chance so it never lands at the end of the sentence.
const VENDOR_OPENERS = {
  potions: {
    first: ['Ah, welcome in', 'Come in, come in', 'Well met, traveler', 'Oh, hello there', 'Step inside, dear', 'There you are'],
    back: ['Welcome back', 'Back again, good', 'There\'s a face I know', 'Ah, you again', 'Good to see you again'],
  },
  gear: {
    first: ['Well met', 'Come in, come in', 'Hah, a new face', 'State your business', 'Forge\'s hot, what do you need', 'Ah, a customer'],
    back: ['Back again', 'You again, good', 'Welcome back', 'Still in one piece, I see', 'Good, you\'re alive'],
  },
  mystery: {
    first: ['Ahh, a new thread in the weave', 'The cards whispered you\'d come', 'Well met, wanderer', 'Fate brings another', 'Come closer, seeker', 'The stars stir'],
    back: ['Welcome back, seeker', 'The weave brings you again', 'Ah, you return', 'Fate again, hm', 'Back for more, are we'],
  },
  barkeep: {
    first: ['Ah, welcome in', 'Well met, traveler', 'Come in, sit by the fire', 'Evening to you'],
    back: ['Welcome back', 'Good to see you again', 'Back again, eh', 'Ah, you again'],
  },
};

// Purchase callbacks: only used when the player has bought something from
// this vendor before, and only some of the time (see composeVendorLine).
const VENDOR_CALLBACKS = {
  potions: ['How did that {item} treat you?', 'Still stocking up after that {item}?', 'That {item} keep you standing, I hope?'],
  gear: ['That {item} still holding an edge?', 'Still swinging that {item}?', 'How\'s that {item} treating you out there?'],
  mystery: ['Did that {item} reveal its secrets yet?', 'Fate still smiling on that {item}?', 'That {item} worth what you paid, I trust?'],
};

const FEMALE_HINT = /female|samantha|victoria|karen|moira|tessa|fiona|kate|serena|susan|allison|ava|zira|jenny/i;
const MALE_HINT = /male|daniel|alex|fred|arthur|george|aaron|guy|david|mark|james|oliver/i;

// The browser's built-in speechSynthesis (Web Speech) has no game-tuned G2P:
// unlike Kokoro (see neuralVoice.js normalizeForTTS) it gets no normalization
// at all today, so it reads written vocalizations letter-by-letter or with
// the wrong vowel, spells out ALL-CAPS emphasis words, and stumbles on
// em-dashes/ellipses. This maps those patterns to forms system voices read
// naturally. Audited against every bank below (LINES, GREETINGS, BOSS_LINES,
// onBigHit) -- the only unpronounceables actually present today are ALL-CAPS
// emphasis words (MINE, TWO, BURN, STAY, THAT, DARE) and em-dashes in
// GREETINGS; the interjection table exists for any line added later.
const VOCALIZATIONS = [
  [/\bh+m+\b/gi, 'hum'],        // hmm, hmmm, hm -> "hum" (bare "hmm" gets spelled out on several system voices)
  [/\bm{2,}h?m*\b/gi, 'hum'],   // mm, mmm, mhm -> "hum" (743: same initialism problem as hm)
  [/\bheh+\b/gi, 'heh'],        // heh, hehe -> unchanged; reads fine as a real word on tested system voices
  [/\bgr+\b/gi, 'gurr'],        // grr, grrr -> "gurr" (no vowel for the synth to grab onto otherwise)
  [/\b(?:tsk)+\b/gi, 'tisk'],   // tsk, tsktsk -> "tisk"
  [/\bpf+t+\b/gi, 'pft'],       // pfft, pft -> "pft"
];

// Web-speech-only text cleanup. Captions/subtitles always keep the original
// `text` -- only the utterance handed to speechSynthesis runs through this.
export function normalizeForSpeech(text) {
  let t = String(text || '');
  // strip *action* asides (*sighs*, *sword clangs*) entirely -- web-speech has
  // no stage-direction concept and would otherwise read the asterisks aloud
  t = t.replace(/\*[^*]+\*/g, ' ');
  for (const [re, rep] of VOCALIZATIONS) t = t.replace(re, rep);
  // em/en dashes + ellipses -> a comma pause (same fix Kokoro needs)
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\.{2,}|…/g, ', ');
  // ALL-CAPS emphasis words -> lowercase (web-speech spells some caps out letter by letter)
  t = t.replace(/\b[A-Z]{2,}\b/g, (m) => m.toLowerCase());
  // collapse leftover whitespace / stray punctuation runs
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/(,){2,}/g, ',').trim();
  return t;
}

export class Roaster {
  constructor() {
    this.enabled = true;
    // When true, never touch Kokoro: speak through the browser's built-in
    // speechSynthesis (distinct male/female system voices per cast). Set from
    // the game's Battery Saver setting; default reflects mobile/low-memory.
    this.batterySaver = false;
    this.timer = 5;
    this.voices = [];
    this.lastCategory = null;
    // Approach-preload bookkeeping: enemy -> { text, voice, speed } for the
    // opening line we've asked neuralVoice to pre-synthesize while un-aggroed.
    // One entry per boss/elite; wiped on floor change or death (see
    // _cancelActivePreloads) so it never grows unbounded.
    this._activePreloads = new Map();
    this._preloadFloor = null;
    // The single in-flight "ellipsis -> caption" gate (see sayGated below).
    // Only one line is ever gated at a time (speaking is single-voice), so a
    // new line simply supersedes whatever gate was pending.
    this._activeGate = null;
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

  // anchor: optional { x, y, z } world pos of the speaker, forwarded to the
  // neural voice so a "speaking soon" bubble can float over their head.
  speak(text, typeId, anchor) {
    this.speakAs(text, this.pickVoice(typeId), anchor);
  }

  // Compose a greeting-first NPC line: opener, then (~35% chance) the
  // player's name woven in early (never trailing), then a period, then the
  // body. If the player bought something here before, the body sometimes
  // becomes a personal callback about that item instead of the plain body
  // the caller supplied. `memory` is { met, lastItem } or undefined/empty.
  composeVendorLine(type, { playerName, memory, body } = {}) {
    const pool = VENDOR_OPENERS[type] || VENDOR_OPENERS.gear;
    const opener = memory?.met
      ? pool.back[Math.floor(Math.random() * pool.back.length)]
      : pool.first[Math.floor(Math.random() * pool.first.length)];
    const nameBit = playerName && Math.random() < 0.35 ? `, ${playerName}` : '';
    const callbacks = VENDOR_CALLBACKS[type];
    let line2 = body;
    if (memory?.lastItem && callbacks && Math.random() < 0.4) {
      {
        // Grammar: plural gear nouns (Leggings, Gauntlets, Greaves...) take
        // "those/They", singular takes "that/It" - "still swinging that
        // Dragonhide Leggings?" read wrong (TODO 711). Templates are written
        // with the singular forms; swap them when the item's base noun is
        // plural. Word-boundary replaces keep 'That' at sentence starts right.
        const PLURAL_NOUN = /\b(leggings|gauntlets|gloves|greaves|tassets|faulds|fists|grips|vestments|boots|bracers)\b/i; // word-boundary, not end-anchored: names carry suffixes ('Leggings of Swiftness')
        const plural = PLURAL_NOUN.test(memory.lastItem);
        let tpl = callbacks[Math.floor(Math.random() * callbacks.length)];
        if (plural) {
          tpl = tpl
            .replace(/\bthat \{item\}/g, 'those {item}')
            .replace(/\bThat \{item\}/g, 'Those {item}')
            .replace(/\{item\} treat you/g, '{item} treat you') // verbs already number-agnostic
            .replace(/\bDid those \{item\} reveal its secrets/g, 'Did those {item} reveal their secrets')
            .replace(/\{item\} worth what you paid/g, '{item} worth what you paid')
            .replace(/\{item\} still holding an edge\?/g, '{item} still holding their edge?')
            .replace(/\{item\} keep you standing/g, '{item} keep you standing');
        }
        line2 = tpl.replaceAll('{item}', memory.lastItem);
      }
    }
    return `${opener}${nameBit}. ${line2}`;
  }

  // Speak with an explicit voice cast — vendors, narrators, anyone.
  // Prefers the neural Kokoro engine when it's loaded; Web Speech otherwise.
  // anchor: optional world pos of the speaker for the "speaking soon" bubble.
  // hooks: { onStart, onCancel } -- onStart fires the instant audible output
  // actually begins (Kokoro's AudioBufferSourceNode.start(), or the Web Speech
  // utterance's `onstart`); onCancel fires if this line will never produce
  // audio (Kokoro silently skipped mid-download, speech unavailable, etc.) so
  // the caller can drop a pending caption cleanly. Callers that don't care
  // about the exact instant can omit hooks entirely — the line still speaks.
  speakAs(text, cast, anchor, hooks = {}) {
    if (!this.enabled) { hooks.onCancel?.(); return; }
    // Battery saver: skip Kokoro completely (no heavy import, no main-thread
    // inference) and use the built-in voices, cast male vs female per `cast`.
    if (this.batterySaver) { this._speakWebSpeech(text, cast, hooks); return; }
    // Lite engine (Obsidian 738): casts tagged with a KittenTTS voice id
    // (ambient tavern chatter) synthesize on the tiny CPU model instead of
    // Kokoro - cheap enough to run while the player idles. Any failure
    // falls straight through to the normal Kokoro path below.
    if (cast.lite) {
      import('./liteVoice.js').then(async ({ liteVoice }) => {
        if (liteVoice.ready) {
          const ok = await liteVoice.speak(text, {
            voice: cast.lite, speed: cast.kSpeed || cast.rate || 1,
            volume: this.volume ?? 0.9, rate: 1, onStart: hooks.onStart,
          });
          if (ok) return;
        } else liteVoice.load(); // warm it for the next line
        this._speakNeural(text, cast, anchor, hooks);
      }).catch(() => this._speakNeural(text, cast, anchor, hooks));
      return;
    }
    this._speakNeural(text, cast, anchor, hooks);
  }

  _speakNeural(text, cast, anchor, hooks = {}) {
    import('./neuralVoice.js').then(async ({ neuralVoice }) => {
      if (neuralVoice.ready) {
        const ok = await neuralVoice.speak(text, { voice: cast.kokoro || 'af_heart', speed: cast.kSpeed || cast.rate || 1, anchor, rate: cast.rate || 1, onStart: hooks.onStart });
        if (ok) return;
      }
      // Kokoro is the only voice. While it's still downloading we stay SILENT
      // (the subtitle already conveys the line) rather than fall back to the
      // robotic Web Speech synth. Only use Web Speech if Kokoro truly failed to
      // load on this device, so a broken model doesn't mute every character.
      if (neuralVoice.status === 'error') { this._speakWebSpeech(text, cast, hooks); return; }
      hooks.onCancel?.();
    }).catch(() => this._speakWebSpeech(text, cast, hooks));
  }

  _speakWebSpeech(text, cast, hooks = {}) {
    if (!this.enabled || !('speechSynthesis' in window)) { hooks.onCancel?.(); return; }
    try {
      speechSynthesis.cancel(); // characters don't talk over each other
      const u = new SpeechSynthesisUtterance(normalizeForSpeech(text));
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
      // Gate the caption on the utterance actually starting to speak. Headless/
      // voiceless browsers (and some system configs) never fire `onstart`; the
      // caller's own timeout fallback (see sayGated) covers that so the line is
      // never lost.
      if (hooks.onStart) u.onstart = () => hooks.onStart();
      speechSynthesis.speak(u);
    } catch { hooks.onCancel?.(); }
  }

  // ---- tavern table-talk (Obsidian 718) ----
  // The three regulars hold short exchanges WITH EACH OTHER, each with a
  // fixed personality: Magda the warm, teasing innkeeper; the Tavern Patron,
  // a sharp-tongued traveling herbalist with an ear for gossip; and the
  // Tipsy Regular, a cheerfully drunk teller of tall tales. Each turn offers
  // line VARIANTS (same template-variation approach as composeVendorLine) so
  // a replayed exchange doesn't repeat verbatim. In full-AI mode the turns
  // play through each speaker's own Kokoro voice; battery saver runs the
  // same conversation trees through the gendered Web Speech voices instead.
  composeTavernConvo() {
    const C = [
      [['drunk', ["I swear the golem on the sign winked at me.", "That sign golem just winked. I saw it."]],
       ['patron', ["That's the ale winking, dear.", "Sure it did. And my herbs sing lullabies."]],
       ['magda', ["If the sign starts buying rounds, I'll worry.", "Long as it doesn't ask for a tab, we're fine."]]],
      [['patron', ["Roads past the mill are crawling with imps again.", "Imps by the mill road again - thick as flies."]],
       ['magda', ["Third traveler to say so this week.", "Aye, everyone's saying it. Bad season."]],
       ['drunk', ["Imps? Wrestled one once. Tiny arms. Strong opinions.", "I fought an imp once. We're friends now. Sort of."]]],
      [['magda', ["That's your third since noon, love.", "Your mug's emptier than my cellar again."]],
       ['drunk', ["Counting's for tax men, Magda!", "A wizard told me ale counts as bread."]],
       ['patron', ["He'll be singing by sundown.", "Somebody hide the lute before he finds it."]]],
      [['magda', ["Hearth's drawing nice tonight.", "Fire's behaving itself for once."]],
       ['patron', ["Best seat in Embervale, that couch.", "I'd trade my cart for an evening on that couch."]],
       ['drunk', ["I called it first! ...where's my mug.", "That couch and I have an understanding."]]],
      [['patron', ["Fenwick was shouting at the well again.", "Old Fenwick's arguing with the well. Again."]],
       ['magda', ["He shouts at everything. Last week it was a chicken.", "The well never answers back. That's why he likes it."]],
       ['drunk', ["The chicken started it.", "In his defense, that chicken had a look."]]],
      [['drunk', ["One more floor, then I retire. I always say that.", "Someday I'll clear a floor myself. Someday."]],
       ['magda', ["You've never set foot below, Bram.", "The closest you've been to the dungeon is the cellar."]],
       ['patron', ["The stairs don't count, love.", "Falling down the cellar steps isn't delving."]]],
    ];
    const convo = C[Math.floor(Math.random() * C.length)];
    return convo.map(([who, variants]) => ({ who, text: variants[Math.floor(Math.random() * variants.length)] }));
  }

  // Pick and PRE-SYNTHESIZE this visit's ambient exchanges (Obsidian 736):
  // two exchanges are chosen once at tavern ENTRY and their lines pushed
  // through neuralVoice.preload in a single burst, so the table-talk that
  // plays while the player idles comes entirely from cache - zero periodic
  // Kokoro inference while "just chilling in the tavern". Battery saver
  // (Web Speech) has nothing to prewarm; a not-yet-loaded model is never
  // force-loaded for ambience (the lines would just fall back to captions).
  prepareTavernConvo() {
    const plans = [this.composeTavernConvo(), this.composeTavernConvo()];
    if (!this.batterySaver) {
      // Preferred: warm the KittenTTS lite engine (738) - tavern lines then
      // synthesize on CPU for pennies. Only if it's unavailable do we fall
      // back to prewarming the lines through Kokoro (736's one-burst rule).
      import('./liteVoice.js').then(({ liteVoice }) => liteVoice.load()).then((ok) => {
        if (ok) return;
        const VOICE = {
          magda: { voice: 'af_kore', speed: 0.95 },
          patron: { voice: 'af_sarah', speed: 1.0 },
          drunk: { voice: 'bm_daniel', speed: 0.82 },
        };
        return import('./neuralVoice.js').then(({ neuralVoice }) => {
          if (!neuralVoice.ready) return;
          for (const plan of plans) {
            for (const t of plan) neuralVoice.preload(t.text, VOICE[t.who])?.catch?.(() => {});
          }
        });
      }).catch(() => {});
    }
    return plans;
  }

  // Show an animated ellipsis above the speaker (anchor) the instant a line is
  // queued, then swap it for the real caption the moment audio actually starts
  // playing -- never both at once, and never the caption before the voice.
  // `show` defaults to the standard subtitle bar; callers with a different
  // caption presentation (e.g. the multiplayer roast floater) can override it.
  // A 1.5s safety-net timeout shows the caption regardless if no onStart ever
  // fires (headless/voiceless browsers, a failed generate(), etc.) so a line
  // is never silently lost.
  sayGated(game, speaker, line, cast, anchor, { durationMs = 4200, show } = {}) {
    if (!this.enabled) return;
    this._clearGate(); // a new line supersedes whatever was pending; no stacked ellipses
    const hasBubble = !!(anchor && game?.ui?.floaters);
    if (hasBubble) game.ui.floaters.showThinking(anchor);
    // Caption ABOVE the speaker's head (Obsidian 780, comic-bubble style)
    // when we have a world anchor; the fixed bottom bar is the fallback for
    // anchorless lines (system notices, the co-op roast floater overrides via
    // `show`).
    const doShow = show || (() => {
      if (hasBubble) game.ui.floaters.showSpeech(anchor, speaker, line, durationMs);
      else game.ui.showSubtitle(speaker, line, durationMs);
    });
    let started = false;
    const gate = { fallback: null };
    const finish = () => {
      if (started) return;
      started = true;
      clearTimeout(gate.fallback);
      if (hasBubble) game.ui.floaters.hideThinking();
      doShow();
      if (this._activeGate === gate) this._activeGate = null;
    };
    const cancel = () => {
      if (started) return;
      started = true;
      clearTimeout(gate.fallback);
      if (hasBubble) game.ui.floaters.hideThinking();
      if (this._activeGate === gate) this._activeGate = null;
    };
    gate.cancel = cancel;
    // TRUE safety net only (Obsidian 728): 1.5s raced fresh Kokoro synthesis
    // (several seconds for an uncached line), so the caption regularly beat
    // the audio - the exact defect the gate exists to prevent. Every path
    // that will never produce audio already calls onCancel explicitly
    // (disabled, Kokoro skipped mid-download, Web Speech unavailable/threw),
    // so this timer only catches the no-callback corners (e.g. a queued
    // utterance whose onstart never fires on voiceless configs).
    gate.fallback = setTimeout(finish, 10000);
    this._activeGate = gate;
    this.speakAs(line, cast, anchor, { onStart: finish, onCancel: cancel });
  }

  // Drop the pending ellipsis->caption gate (if any) WITHOUT ever showing the
  // caption -- used when the speaker is cut off before audio starts (dies,
  // gets superseded by a new line, etc.).
  _clearGate() {
    if (this._activeGate) this._activeGate.cancel();
    this._activeGate = null;
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
    // Tell the neural voice how hot the fight is: it skips a fresh (expensive)
    // TTS generation while a big melee is underway, deferring to a calm moment.
    if (game.player) {
      const pp = game.player.pos;
      const near = game.enemies.reduce((n, e) => (!e.dead && Math.hypot(e.pos.x - pp.x, e.pos.z - pp.z) <= 12 ? n + 1 : n), 0);
      import('./neuralVoice.js').then(({ neuralVoice }) => {
        neuralVoice.reportCombatLoad?.(near);
        this._preloadApproach(game, neuralVoice);
      }).catch(() => {});
    }
    // One-time foul greeting the moment you get near a mob leader (host talks).
    if (!net.active || net.isHost) {
      const p = game.player;
      for (const e of game.enemies) {
        if (e.dead || e._greeted || !(e.elite || e.miniboss || e.isBoss)) continue;
        if (Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) > 11) continue;
        e._greeted = true;
        // Use the line we already pre-synthesized on approach, if any, so
        // speakAs() below hits the neural cache and plays back instantly
        // instead of hitching on a fresh generate() mid-aggro.
        const line = e._pendingLine || GREETINGS[Math.floor(Math.random() * GREETINGS.length)].replaceAll('{name}', game.playerName());
        this._activePreloads.delete(e);
        this.deliver(game, e, line);
        if (net.isHost) net.send({ t: 'roast', txt: line, ty: e.typeId, ei: e.netId });
        this.timer = Math.max(this.timer, 6); // don't immediately double up with periodic chatter
        return;
      }
    }
    // Bosses also banter periodically (they don't carry the `elite` flag), so
    // an act lord in a fight speaks in its own voice with its own lines.
    const elite = game.enemies.find((e) => !e.dead && (e.elite || e.isBoss) && e.state && e.state !== 'idle');
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

    // Bosses sometimes drop one of their OWN personality lines instead of the
    // shared elite banter, so each act lord feels distinct in a fight.
    if (elite.isBoss && BOSS_LINES[elite.act] && elite._introDone && Math.random() < 0.5) {
      const bank = BOSS_LINES[elite.act];
      let bl = bank[Math.floor(Math.random() * bank.length)];
      const who = target.name || (target.cls ? String(target.cls) : 'hero');
      bl = bl.replaceAll('{name}', who);
      this.lastCategory = 'boss';
      this.deliver(game, elite, bl);
      if (net.isHost) net.send({ t: 'roast', txt: bl, ty: elite.typeId, ei: elite.netId });
      return;
    }

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
    // Act bosses + the Dungeon Lord get their OWN voice (they all share the
    // golem typeId otherwise). Everyone else speaks in their type cast.
    const cast = (elite.isBoss && BOSS_CAST[elite.act]) ? BOSS_CAST[elite.act] : this.pickVoice(elite.typeId);
    // Slower/deeper casts (dragons, golems) get a longer caption window so the
    // subtitle stays up for the full pitched-down, slowed-down line.
    const dur = Math.round(Math.min(7000, Math.max(2200, 3600 / (cast.rate || 1))));
    this.sayGated(game, elite.name || 'Elite', line, cast, elite.pos, { durationMs: dur });
  }

  // While the player is on a boss floor but a boss/elite/miniboss hasn't been
  // aggroed yet (_greeted still false), pre-synthesize its opening line once
  // it's within a generous radius, so aggro plays it back instantly instead of
  // hitching on a mid-fight generate(). Battery-saver skips this entirely: its
  // Web Speech fallback is already instant, no synth to hide. Guests never
  // preload (they don't drive combat/greeting logic; only the host talks).
  _preloadApproach(game, neuralVoice) {
    if (this.batterySaver || !neuralVoice.ready) return;
    if (net.active && !net.isHost) return;
    // Floor change (or leaving/re-entering a boss floor): the old preload no
    // longer applies to anything on screen, so drop it rather than let it
    // accumulate across floors.
    if (this._preloadFloor !== game.floor) {
      this._preloadFloor = game.floor;
      this._cancelActivePreloads(neuralVoice);
    }
    const p = game.player;
    for (const e of game.enemies) {
      if (e.dead || e._greeted || !(e.elite || e.miniboss || e.isBoss)) continue;
      if (Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) > 18) continue;
      // Pick (and pin) the line once so every subsequent preload tick and the
      // eventual aggro delivery all refer to the exact same synthesized audio.
      if (!e._pendingLine) {
        e._pendingLine = GREETINGS[Math.floor(Math.random() * GREETINGS.length)].replaceAll('{name}', game.playerName());
      }
      const cast = (e.isBoss && BOSS_CAST[e.act]) ? BOSS_CAST[e.act] : this.pickVoice(e.typeId);
      const voice = cast.kokoro || 'af_heart';
      const speed = cast.kSpeed || cast.rate || 1;
      this._activePreloads.set(e, { text: e._pendingLine, voice, speed });
      neuralVoice.preload(e._pendingLine, { voice, speed });
    }
  }

  // Discard every in-flight/finished-but-unplayed preload (cancels generation
  // still running and evicts any cached-but-unspoken buffer). Used on floor
  // change and on death, so a killed boss can never speak posthumously and the
  // preload cache never grows unbounded (one line per boss, then gone).
  _cancelActivePreloads(neuralVoice) {
    for (const info of this._activePreloads.values()) {
      neuralVoice.cancelPreload?.(info.text, { voice: info.voice, speed: info.speed });
    }
    this._activePreloads.clear();
  }

  // Immediately silence a speaker (used when a talking elite/boss is killed so a
  // dying voice cuts off at once). Cancels Web Speech, asks the neural voice to
  // stop any playback, AND cancels/discards any in-flight or preloaded-but-
  // unplayed opening line so a boss that dies mid-synthesis never speaks after
  // death. Safe to call even if nothing is speaking or preloading.
  stopSpeaking() {
    // A pending ellipsis for a line that hasn't started playing yet must
    // vanish with nothing shown -- the speaker is being cut off (death, etc.).
    this._clearGate();
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* */ }
    import('./neuralVoice.js').then(({ neuralVoice }) => {
      neuralVoice.stop?.();
      this._cancelActivePreloads(neuralVoice);
    }).catch(() => {});
  }

  // Damage-event taunt: fires when the player lands a MAJOR blow on an elite/boss
  // (`dealt` = fraction of that enemy's max HP) or takes a major hit from one
  // (`taken` = fraction of the player's max HP). Rate-limited so it never machine
  // guns: at least 6s since the last line, and only some of the time. Gated by
  // the same enabled setting as periodic chatter; host-authoritative in co-op.
  onBigHit(game, { dealt = 0, taken = 0, enemy } = {}) {
    if (!this.enabled || !game.player || game.inTown) return;
    if (net.active && !net.isHost) return;
    const now = performance.now();
    if (now - (this._lastBigHitAt || 0) < 6000) return;
    // Only react to genuinely big swings, and only sometimes.
    const big = dealt >= 0.18 || taken >= 0.22;
    if (!big || Math.random() > 0.5) return;
    // The speaker is the involved boss/elite if given, else the nearest engaged one.
    let sp = enemy && !enemy.dead && (enemy.elite || enemy.isBoss) ? enemy : null;
    if (!sp) {
      const p = game.player.pos;
      sp = game.enemies.find((e) => !e.dead && (e.elite || e.isBoss)
        && Math.hypot(e.pos.x - p.x, e.pos.z - p.z) <= 12);
    }
    if (!sp) return;
    this._lastBigHitAt = now;

    const name = game.playerName();
    let line;
    if (taken >= 0.22) {
      // the boss/elite just crunched the player
      const bank = ['Feel THAT, {name}?', 'That is what it costs to face me, {name}.', 'Still standing? Not for long.'];
      line = bank[Math.floor(Math.random() * bank.length)];
    } else {
      // the player just chunked the boss/elite: grudging or furious
      const bank = ['A scratch, {name}. Nothing more.', 'You DARE wound me?!', 'That one stung. You will pay it back in blood.'];
      line = bank[Math.floor(Math.random() * bank.length)];
    }
    line = line.replaceAll('{name}', name);
    this.deliver(game, sp, line);
    if (net.isHost) net.send({ t: 'roast', txt: line, ty: sp.typeId, ei: sp.netId });
    this.timer = Math.max(this.timer, 6); // don't double up with periodic chatter
  }
}

export const roaster = new Roaster();
