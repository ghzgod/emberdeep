import * as THREE from 'three';

// Floating combat text: HTML divs projected from world space. Messages that
// land in the same spot STACK (newest at the bottom, older pushed up) so they
// never overlap, and each holds readable then fades over ~3s.
const LIFE = 3.0;          // seconds a message lives (hold + fade)
const FADE = 1.0;          // last seconds spent fading out
const LINE = 22;           // px between stacked lines
const MAX = 40;            // hard cap on live floaters

export class Floaters {
  constructor(camera) {
    this.camera = camera;
    this.container = document.getElementById('floaters');
    this.active = [];
    this._v = new THREE.Vector3();
    this._seq = 0;
  }

  spawn(worldPos, text, cssClass = '', dur = LIFE) {
    // Collapse an exact-duplicate that just appeared at the same spot (e.g. a
    // chest firing gold + loot on the same frame doubling a line).
    const now = this._seq++;
    for (const f of this.active) {
      if (f.text === text && f.cssClass === cssClass && now - f.seq < 3) return;
    }
    if (this.active.length >= MAX) { const old = this.active.shift(); old.el.remove(); }
    const el = document.createElement('div');
    el.className = `floater ${cssClass}`;
    el.textContent = text;
    el.style.animation = 'none';      // we drive opacity/position ourselves
    el.style.willChange = 'transform, opacity';
    this.container.appendChild(el);
    // Each floater locks to a FIXED world anchor captured here by value, so it
    // stays put in the world as the camera moves. baseY is a fixed spawn offset
    // that keeps messages landing on the same world spot from overlapping.
    let baseY = 0;
    for (const o of this.active) {
      if (o.x === worldPos.x && o.z === worldPos.z) baseY += LINE;
    }
    const f = {
      el, text, cssClass, seq: now,
      x: worldPos.x, y: (worldPos.y ?? 0) + 1.6, z: worldPos.z,
      t: Math.max(LIFE, dur), life: Math.max(LIFE, dur), baseY,
    };
    this.active.push(f);
    this.place(f);
  }

  place(f) {
    // Project the fixed world anchor to screen every frame. The vertical offset
    // (baseY + age-based rise) is screen-space only and never touches the anchor,
    // so the floater tracks its world point as the camera pans.
    this._v.set(f.x, f.y, f.z).project(this.camera);
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth;
    const age = f.life - f.t;
    const rise = Math.min(age, 1.2) * 24;   // gentle upward drift over ~1.2s, then holds
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight - f.baseY - rise;
    f.el.style.left = `${sx}px`;
    f.el.style.top = `${sy}px`;
  }

  update(dt) {
    // Every floater is anchored to its own fixed world point and rises/fades on
    // its own timeline. No camera-dependent clustering, so panning the camera
    // never shuffles a floater's screen slot: it just tracks its world anchor.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.remove(); this.active.splice(i, 1); continue; }
      f.el.style.opacity = f.t < FADE ? (f.t / FADE).toFixed(2) : '1';
      this.place(f);
    }
  }

  clear() {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
  }
}
