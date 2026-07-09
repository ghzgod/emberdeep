// Keyboard + mouse input, polled by the game loop.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();      // keys pressed this frame (cleared each frame)
    this.mouse = { x: 0, y: 0, down: false, rightDown: false, clicked: false };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // A missed mouseup (window blur, pointer canceled, synthetic event streams)
    // must never leave mouse.down latched - a stuck true here makes the hero
    // auto-attack forever with no input.
    const clearAll = () => { this.keys.clear(); this.mouse.down = false; this.mouse.rightDown = false; };
    window.addEventListener('blur', clearAll);
    window.addEventListener('pointercancel', clearAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll(); });

    canvas.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouse.down = true; this.mouse.clicked = true; }
      if (e.button === 2) this.mouse.rightDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2) this.mouse.rightDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  endFrame() {
    this.pressed.clear();
    this.mouse.clicked = false;
  }
}
