// Touch controls: virtual joystick (left half) + hold-to-attack aim (right half),
// tappable hotbar / potion / pause. Active on coarse-pointer devices, or force
// with ?touch in the URL for testing.
export class TouchControls {
  constructor(game) {
    this.game = game;
    this.enabled = matchMedia('(pointer: coarse)').matches
      || 'ontouchstart' in window
      || location.search.includes('touch');
    this.move = { x: 0, z: 0 };
    this.joyActive = false;
    this.attacking = false;
    this.rotDir = 0; // -1 / +1 while a rotate button is held
    this.fadeTimer = 4; // touch buttons dim after a few idle seconds
    this._joyId = null;
    this._aimId = null;

    if (!this.enabled) return;
    document.body.classList.add('touch-mode');

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
    bind('touch-potion', () => game.player?.drinkPotion(game));
    bind('touch-inv', () => game.toggleInventory());
    bind('touch-pause', () => game.togglePause(true));

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

    // hotbar taps
    document.getElementById('hotbar').addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.hotbar-slot');
      if (!slot || !game.player) return;
      const idx = [...slot.parentNode.children].indexOf(slot);
      game.player.tryAbility(idx, game);
    });
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
    } else if (this._aimId === null) {
      this._aimId = e.pointerId;
      this.attacking = true;
      this.game.input.mouse.x = e.clientX;
      this.game.input.mouse.y = e.clientY;
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
