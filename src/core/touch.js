// Single source of truth for "is this a touch device" so the JS ability-bar
// choice (buildHotbar) and the CSS layout (body.touch-mode) can never
// disagree. Anyone needing the touch/non-touch decision should call this
// instead of re-checking matchMedia/ontouchstart themselves.
export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches
    || 'ontouchstart' in window
    || location.search.includes('touch');
}

// Touch controls: virtual joystick (left half) + hold-to-attack aim (right half),
// tappable hotbar / potion / pause. Active on coarse-pointer devices, or force
// with ?touch in the URL for testing.
export class TouchControls {
  constructor(game) {
    this.game = game;
    this.enabled = isTouchDevice();
    this.move = { x: 0, z: 0 };
    this.joyActive = false;
    this.attacking = false;
    this.rotDir = 0; // -1 / +1 while a rotate button is held
    this.fadeTimer = 4; // touch buttons dim after a few idle seconds
    this._joyId = null;
    this._aimId = null;
    this._menuAutoCloseTimer = null; // auto-collapses the utility drawer after ~3s idle

    // body.touch-mode is the flag both CSS and JS key off; re-evaluated below
    // on resize/orientationchange so a mid-session pointer/viewport change
    // (tablet rotation, devtools device toggle) never leaves the wheel and
    // the row-plus-toggle hybrid both on screen at once.
    document.body.classList.toggle('touch-mode', this.enabled);

    // Re-check on resize/orientationchange: if the touch/non-touch verdict
    // flips, flip the body class and rebuild the hotbar so the ability
    // layout (row vs wheel) and the menu toggle's visibility (CSS reads
    // body.touch-mode) always agree with each other.
    window.addEventListener('resize', () => this._reevaluate());
    window.addEventListener('orientationchange', () => this._reevaluate());

    if (!this.enabled) return;

    const canvas = game.canvas;
    canvas.style.touchAction = 'none';

    // any touch anywhere wakes the button drawer back to full opacity
    window.addEventListener('pointerdown', () => this.wake(), { capture: true });

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));

    this.joyBase = document.getElementById('joystick-base');
    this.joyKnob = document.getElementById('joystick-knob');

    // touch buttons
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    };
    const closeMenu = () => {
      document.getElementById('touch-ui')?.classList.remove('menu-open');
      clearTimeout(this._menuAutoCloseTimer);
    };
    // any interaction with the drawer while it's open pushes the auto-close
    // out another ~3s, so it doesn't vanish mid-fumble but still tidies
    // itself up once the player stops touching it.
    const bumpMenuTimer = () => {
      clearTimeout(this._menuAutoCloseTimer);
      const ui = document.getElementById('touch-ui');
      if (!ui?.classList.contains('menu-open')) return;
      this._menuAutoCloseTimer = setTimeout(closeMenu, 3000);
    };
    bind('touch-potion', () => {
      if (document.getElementById('touch-potion')?.classList.contains('disabled')) return;
      game.player?.drinkPotion(game); closeMenu();
    });
    bind('touch-inv', () => { game.toggleInventory(); closeMenu(); });
    bind('touch-pause', () => { game.togglePause(true); closeMenu(); });

    // the utility menu toggle collapses potion/bag/pause/mic/rotate out of the
    // way so they never overlap the abilities or the status banner. Opening
    // direction is width-aware (see chooseMenuDirection): fan sideways along
    // the bottom when there's room to clear the ability bar/wheel, otherwise
    // stack straight up so it can never overlap it.
    bind('touch-menu-toggle', () => {
      const ui = document.getElementById('touch-ui');
      if (!ui) return;
      const opening = !ui.classList.contains('menu-open');
      if (opening) this.chooseMenuDirection(ui);
      ui.classList.toggle('menu-open', opening);
      if (opening) bumpMenuTimer(); else clearTimeout(this._menuAutoCloseTimer);
    });
    // rotate/mic buttons are held, not tapped, but touching them should still
    // count as "using the drawer" and push the auto-close timer out.
    for (const id of ['touch-rotl', 'touch-rotr', 'touch-mic']) {
      document.getElementById(id)?.addEventListener('pointerdown', bumpMenuTimer);
    }
    this._closeDrawer = closeMenu;

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
    this.maybeShowHint = () => {
      if (!this.enabled || localStorage.getItem('emberdeep-move-hint')) return;
      tutRoot?.classList.remove('hidden');
      showTutStep('move');
    };

    // hold-to-rotate camera buttons
    const bindRotate = (id, dir) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.rotDir = dir; });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
        el.addEventListener(ev, () => { if (this.rotDir === dir) this.rotDir = 0; });
      }
    };
    bindRotate('touch-rotl', 1);
    bindRotate('touch-rotr', -1);

    // hold-to-talk mic button
    const mic = document.getElementById('touch-mic');
    if (mic) {
      mic.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); game.touchPtt = true; });
      mic.addEventListener('pointerup', () => { game.touchPtt = false; });
      mic.addEventListener('pointercancel', () => { game.touchPtt = false; });
      mic.addEventListener('pointerleave', () => { game.touchPtt = false; });
    }

    // Desktop-row hotbar taps (the flat .hotbar-slot row on non-touch layouts):
    // casting closes the drawer immediately, same as moving/attacking. The
    // touch corner cluster's circular buttons handle their own pointer events
    // (see ui.js wireActionButton) and stop propagation, so they never reach
    // this listener - it is the desktop row's tap path only.
    document.getElementById('hotbar').addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.hotbar-slot');
      if (!slot || !game.player) return;
      closeMenu();
      this._advanceTut?.('ability');
      const idx = [...slot.parentNode.children].indexOf(slot);
      game.player.tryAbility(idx, game);
    });
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && !location.search.includes('touch')) return;
    // moving or attacking means the player is done with the drawer - close it
    // immediately instead of waiting out the idle timer.
    this._closeDrawer?.();
    if (e.clientX < window.innerWidth * 0.42 && this._joyId === null) {
      this._joyId = e.pointerId;
      this.joyActive = true;
      this._joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyBase.style.display = 'block';
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyKnob.style.transform = 'translate(-50%,-50%)';
      this._advanceTut?.('move');
    } else if (this._aimId === null) {
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

  // Re-run the touch/non-touch check and, if the verdict changed since
  // construction (or since the last check), flip body.touch-mode and rebuild
  // the ability bar so it swaps between the row and the wheel to match. This
  // is what stops a tablet from getting stuck in the row-plus-kebab hybrid
  // after an orientation change or viewport resize.
  _reevaluate() {
    const nowEnabled = isTouchDevice();
    if (nowEnabled === this.enabled) return;
    this.enabled = nowEnabled;
    document.body.classList.toggle('touch-mode', this.enabled);
    if (this.game.player) this.game.ui.buildHotbar(this.game.player);
  }

  // Decide whether the utility drawer fans out SIDEWAYS along the bottom
  // (.menu-side) or stacks straight UP from the toggle (.menu-up).
  //
  // The portrait layout (style.css, the plain body.touch-mode block) always
  // rises in a flush-right vertical column above the toggle - that motion
  // never reaches into the wheel's horizontal space, so it is safe at any
  // width and ignores these classes entirely.
  //
  // The landscape/short-screen layout puts the toggle in the bottom-LEFT
  // corner and fans the drawer to the right along the bottom edge, straight
  // toward the ability wheel that owns the bottom-right corner. THAT is the
  // direction that can overlap the wheel on a narrow width, so this is where
  // .menu-side vs .menu-up actually matters: fan sideways only if the row of
  // buttons has room to fully clear the wheel, otherwise stack upward from
  // the corner instead (which stays clear at any width).
  chooseMenuDirection(ui) {
    const toggle = document.getElementById('touch-menu-toggle');
    const hotbar = document.getElementById('hotbar');
    if (!toggle || !hotbar) { ui.classList.add('menu-side'); ui.classList.remove('menu-up'); return; }
    const tRect = toggle.getBoundingClientRect();
    const hRect = hotbar.getBoundingClientRect();
    // Portrait: toggle sits on the right, same side as the wheel, and the
    // drawer only ever moves vertically - always safe, always sideways-class
    // (no-op for that layout, but keeps the class state consistent).
    const toggleOnRight = tRect.left > window.innerWidth / 2;
    if (toggleOnRight) {
      ui.classList.add('menu-side'); ui.classList.remove('menu-up');
      return;
    }
    // Landscape short-screen: toggle bottom-left, drawer fans right toward
    // the wheel. Measure whether 5 more button-widths (+ gaps) actually fit
    // in the gap between the toggle and the wheel's left edge.
    const btnSpan = tRect.width + 10;
    const fanReach = btnSpan * 5;
    const clearance = hRect.left - tRect.right;
    const fitsSideways = hRect.width === 0 || clearance >= fanReach;
    ui.classList.toggle('menu-side', fitsSideways);
    ui.classList.toggle('menu-up', !fitsSideways);
  }

  setVisible(v) {
    if (!this.enabled) return;
    document.getElementById('touch-ui').classList.toggle('hidden', !v);
    if (v) this.wake();
  }

  wake() {
    this.fadeTimer = 4;
    document.getElementById('touch-ui')?.classList.remove('ui-faded');
  }

  // called from the game loop: dim the drawer after idle time
  update(dt) {
    if (!this.enabled) return;
    if (this.fadeTimer > 0) {
      this.fadeTimer -= dt;
      if (this.fadeTimer <= 0) {
        document.getElementById('touch-ui')?.classList.add('ui-faded');
      }
    }
  }
}
