import { svgIcon } from '../ui/icons.js';

// Single source of truth for INPUT capability: "can this device touch". Gates
// the virtual joystick, hold-to-aim gestures and tap hints - never the layout.
export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches
    || 'ontouchstart' in window
    || location.search.includes('touch');
}

// Single source of truth for LAYOUT: compact (corner ability cluster, utility
// row, arc vitals) vs desktop (flat hotbar row, top-left bars, action bar).
// This is a VIEWPORT decision, not a device one - a narrow desktop window gets
// the compact layout live as it resizes, and a coarse-pointer device gets it
// at any size. Re-evaluated on resize/orientationchange (see _reevaluate), and
// it is what drives body.touch-mode and buildHotbar's row-vs-cluster choice,
// so the JS layout pick and the CSS can never disagree.
export function isCompactLayout() {
  return window.innerWidth <= 940
    || window.innerWidth < window.innerHeight // portrait aspect at any width
    || matchMedia('(pointer: coarse)').matches
    || location.search.includes('touch');
}

// Touch controls: virtual joystick (left half) + hold-to-attack aim (right half)
// on touch-capable devices, plus the compact layout's always-visible utility
// row and tutorial hints on ANY compact viewport (mouse included). Force touch
// input with ?touch in the URL for testing.
export class TouchControls {
  constructor(game) {
    this.game = game;
    // INPUT capability (joystick, aim gestures) and LAYOUT (cluster, utility
    // row) are independent: touchInput follows the device, compact follows the
    // viewport. this.enabled keeps its historical meaning ("touch input is
    // live") for the game-loop reads in game.js.
    this.touchInput = isTouchDevice();
    this.compact = isCompactLayout();
    this.enabled = this.touchInput;
    // real-touch marker for CSS: joystick + ghost tutorial are touch-only
    document.body.classList.toggle('touch-input', this.touchInput);
    this.move = { x: 0, z: 0 };
    this.joyActive = false;
    this.attacking = false;
    this.rotDir = 0; // legacy field read by game.js's camera-rotate check; always 0 now that rotation is twist-gesture only
    this.fadeTimer = 4; // touch buttons dim after a few idle seconds
    this._joyId = null;
    this._aimId = null;

    // body.touch-mode is the flag both CSS and JS key off; re-evaluated below
    // on resize/orientationchange so a mid-session viewport change (tablet
    // rotation, a desktop window dragged narrow, devtools device toggle)
    // always lands on the matching layout.
    document.body.classList.toggle('touch-mode', this.compact);

    // Re-check on resize/orientationchange: if the compact/desktop verdict
    // flips, flip the body class and rebuild the hotbar so the ability
    // layout (row vs cluster) and the utility row's visibility (CSS reads
    // body.touch-mode) always agree with each other.
    window.addEventListener('resize', () => this._reevaluate());
    window.addEventListener('orientationchange', () => this._reevaluate());

    const canvas = game.canvas;
    // Canvas gestures (joystick / hold-to-aim) need real touch; everything
    // below them (utility row, tutorial, hotbar taps) works with a mouse too
    // and the compact layout needs it on any device.
    if (this.touchInput) {
      canvas.style.touchAction = 'none';
      canvas.addEventListener('pointerdown', (e) => this.onDown(e));
      canvas.addEventListener('pointermove', (e) => this.onMove(e));
      canvas.addEventListener('pointerup', (e) => this.onUp(e));
      canvas.addEventListener('pointercancel', (e) => this.onUp(e));
      // failsafe: a blur mid-gesture must never leave attack/joystick latched
      window.addEventListener('blur', () => {
        this._joyId = null; this._aimId = null;
        this.joyActive = false; this.attacking = false;
        this.move.x = 0; this.move.z = 0;
        if (this.joyBase) this.joyBase.style.display = 'none';
      });
    }

    // any pointer anywhere wakes the utility row back to full opacity
    window.addEventListener('pointerdown', () => this.wake(), { capture: true });

    this.joyBase = document.getElementById('joystick-base');
    this.joyKnob = document.getElementById('joystick-knob');

    // Colorful hand-drawn icons for the utility inner-arc bubbles (inventory/
    // mic/settings), matching the ability-icon art style (see icons.js) -
    // injected here rather than baked into index.html so icons.js stays the
    // single source of truth for every glyph in the game.
    const utilIcons = { 'touch-inv': 'bag_color', 'touch-mic': 'mic_color', 'touch-pause': 'gear_color' };
    for (const [id, key] of Object.entries(utilIcons)) {
      const slot = document.getElementById(id)?.querySelector('.util-icon');
      if (slot) slot.innerHTML = svgIcon(key);
    }

    // touch buttons
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    };
    // Utility row (inventory/settings/mic/potion) is always visible now -
    // no drawer/toggle to open or auto-close (see index.html + style.css).
    bind('touch-inv', () => { game.toggleInventory(); });
    bind('touch-pause', () => { game.togglePause(true); });

    // First-time 3-step contextual tutorial, first Embervale visit only:
    // move -> attack -> ability, each a small subtle hint that auto-advances
    // to the next step the moment the player performs that action. Replaces
    // the old "Got it" wall-of-text modal entirely - nothing to read, nothing
    // to tap through, just do the thing and it gets out of the way. Fully
    // non-blocking: every step is pointer-events:none in CSS.
    const tutRoot = document.getElementById('touch-tut');
    const tutSteps = {
      move: document.getElementById('touch-tut-move'),
      attack: document.getElementById('touch-tut-attack'),
      ability: document.getElementById('touch-tut-ability'),
    };
    const TUT_ORDER = ['move', 'attack', 'ability'];
    this._tutStep = null;
    const showTutStep = (step) => {
      this._tutStep = step;
      for (const [k, el] of Object.entries(tutSteps)) {
        el?.classList.toggle('visible', k === step);
        el?.classList.remove('fading');
      }
    };
    // advance from `step` to whatever comes next, or finish the tutorial for
    // good once the last step is cleared.
    const advanceTut = (step) => {
      if (this._tutStep !== step) return; // already moved on / not this step
      const el = tutSteps[step];
      el?.classList.add('fading');
      setTimeout(() => el?.classList.remove('visible', 'fading'), 650);
      const next = TUT_ORDER[TUT_ORDER.indexOf(step) + 1];
      if (next) {
        this._tutStep = next;
        setTimeout(() => showTutStep(next), 650);
      } else {
        this._tutStep = null;
        localStorage.setItem('emberdeep-move-hint', '1');
        setTimeout(() => tutRoot?.classList.add('hidden'), 650);
      }
    };
    this._advanceTut = advanceTut;
    this._ghost = document.getElementById('joy-ghost');
    this._ghostShown = false;
    this._ghostTimer = null;
    this._movedEver = false;
    this.maybeShowHint = () => {
      if (!this.touchInput) return; // teaches touch gestures only
      if (!localStorage.getItem('emberdeep-move-hint')) {
        tutRoot?.classList.remove('hidden');
        showTutStep('move');
      }
      this.scheduleJoyGhost();
    };

    // hold-to-talk mic button
    const mic = document.getElementById('touch-mic');
    if (mic) {
      mic.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); game.touchPtt = true; });
      mic.addEventListener('pointerup', () => { game.touchPtt = false; });
      mic.addEventListener('pointercancel', () => { game.touchPtt = false; });
      mic.addEventListener('pointerleave', () => { game.touchPtt = false; });
    }
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && !location.search.includes('touch')) return;
    if (e.clientX < window.innerWidth * 0.42 && this._joyId === null) {
      this._joyId = e.pointerId;
      this.joyActive = true;
      this._joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyBase.style.display = 'block';
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyKnob.style.transform = 'translate(-50%,-50%)';
      this._advanceTut?.('move');
      this.dismissJoyGhost(true);
    } else if (this._aimId === null && !this.gestureLock) {
      // gestureLock: two idle-joystick fingers are a twist/pinch gesture, so
      // the second thumb must not start an attack (set/cleared in game.js's
      // touchstart/touchend gesture tracking).
      this._aimId = e.pointerId;
      this.attacking = true;
      this.game.input.mouse.x = e.clientX;
      this.game.input.mouse.y = e.clientY;
      this._advanceTut?.('attack');
    }
  }

  onMove(e) {
    if (e.pointerId === this._joyId) {
      const dx = e.clientX - this._joyOrigin.x;
      const dy = e.clientY - this._joyOrigin.y;
      const len = Math.hypot(dx, dy);
      const max = 52;
      const cl = Math.min(len, max);
      const nx = len > 4 ? (dx / len) : 0;
      const ny = len > 4 ? (dy / len) : 0;
      // screen up = world -z, screen right = world +x (camera sits behind on +z)
      this.move.x = nx * (cl / max);
      this.move.z = ny * (cl / max);
      this.joyKnob.style.transform = `translate(calc(-50% + ${nx * cl}px), calc(-50% + ${ny * cl}px))`;
    } else if (e.pointerId === this._aimId) {
      this.game.input.mouse.x = e.clientX;
      this.game.input.mouse.y = e.clientY;
    }
  }

  onUp(e) {
    if (e.pointerId === this._joyId) {
      this._joyId = null;
      this.joyActive = false;
      this.move.x = 0; this.move.z = 0;
      this.joyBase.style.display = 'none';
    } else if (e.pointerId === this._aimId) {
      this._aimId = null;
      this.attacking = false;
    }
  }

  // Re-run both checks. Input capability rarely flips, but the LAYOUT verdict
  // flips whenever the window crosses the compact breakpoint (a desktop
  // browser dragged narrow, a tablet rotation, devtools device toggle): flip
  // body.touch-mode and rebuild the ability bar so it swaps between the row
  // and the cluster live to match the viewport.
  _reevaluate() {
    this.touchInput = isTouchDevice();
    this.enabled = this.touchInput;
    // touch-input marks REAL touch capability: CSS uses it to hide the virtual
    // joystick + its ghost tutorial on mouse machines, even in compact layout.
    document.body.classList.toggle('touch-input', this.touchInput);
    const nowCompact = isCompactLayout();
    if (nowCompact === this.compact) return;
    this.compact = nowCompact;
    document.body.classList.toggle('touch-mode', this.compact);
    if (this.game.player) this.game.ui.buildHotbar(this.game.player);
  }

  // First-time joystick ghost: a few seconds after entering the world without
  // moving, fade in a ghost joystick on the left with an animated thumb that
  // slides up on repeat and a "Hold and swipe to walk" hint. Shows on the
  // first three world entries at most (localStorage counter); the moment the
  // player moves it is dismissed for good. Touch input only - it teaches a
  // touch gesture.
  scheduleJoyGhost() {
    if (!this.touchInput || !this._ghost) return;
    const KEY = 'emberdeep-joy-ghost-v1';
    const seen = localStorage.getItem(KEY);
    if (seen === 'done' || (+seen || 0) >= 3) return;
    clearTimeout(this._ghostTimer);
    this._ghostTimer = setTimeout(() => {
      if (this._movedEver || this.joyActive) return;
      localStorage.setItem(KEY, String((+seen || 0) + 1));
      this._ghostShown = true;
      this._ghost.classList.remove('hidden', 'fading');
      document.getElementById('touch-ui')?.classList.add('ghost-active');
    }, 2500);
  }

  // moved: true when the player actually walked - that proves the lesson
  // landed, so the ghost never comes back.
  dismissJoyGhost(moved) {
    clearTimeout(this._ghostTimer);
    if (moved) {
      this._movedEver = true;
      if (this._ghostShown) localStorage.setItem('emberdeep-joy-ghost-v1', 'done');
    }
    if (!this._ghostShown) return;
    this._ghostShown = false;
    document.getElementById('touch-ui')?.classList.remove('ghost-active');
    const g = this._ghost;
    g.classList.add('fading');
    setTimeout(() => { g.classList.add('hidden'); g.classList.remove('fading'); }, 650);
  }

  setVisible(v) {
    if (!this.touchInput && !this.compact) return;
    document.getElementById('touch-ui').classList.toggle('hidden', !v);
    if (v) this.wake();
  }

  wake() {
    this.fadeTimer = 4;
    document.getElementById('touch-ui')?.classList.remove('ui-faded');
  }

  // called from the game loop: dim the utility row after idle time
  update(dt) {
    if (!this.touchInput && !this.compact) return;
    // any real movement proves walking is understood - retire the ghost
    if (this._ghostShown && (this.move.x || this.move.z)) this.dismissJoyGhost(true);
    if (this.fadeTimer > 0) {
      this.fadeTimer -= dt;
      if (this.fadeTimer <= 0) {
        document.getElementById('touch-ui')?.classList.add('ui-faded');
      }
    }
  }
}
