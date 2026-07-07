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
    const f = {
      el, text, cssClass, seq: now,
      x: worldPos.x, y: (worldPos.y ?? 0) + 1.6, z: worldPos.z,
      t: Math.max(LIFE, dur), life: Math.max(LIFE, dur), stackY: 0,
    };
    this.active.push(f);
    this.place(f);
  }

  place(f) {
    this._v.set(f.x, f.y, f.z).project(this.camera);
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight - f.stackY;
    f.el.style.left = `${sx}px`;
    f.el.style.top = `${sy}px`;
  }

  update(dt) {
    // Assign non-overlapping vertical slots per screen-column cluster: newest
    // sits at the base, older ones are pushed upward by one line each.
    const clusters = new Map();
    for (const f of this.active) {
      this._v.set(f.x, f.y, f.z).project(this.camera);
      const bucket = Math.round(((this._v.x * 0.5 + 0.5) * window.innerWidth) / 70);
      (clusters.get(bucket) || clusters.set(bucket, []).get(bucket)).push(f);
    }
    for (const group of clusters.values()) {
      group.sort((a, b) => a.seq - b.seq);          // oldest first
      const n = group.length;
      group.forEach((f, i) => { f.stackY = (n - 1 - i) * LINE; }); // newest -> 0
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.remove(); this.active.splice(i, 1); continue; }
      const age = f.life - f.t;
      f.el.style.opacity = f.t < FADE ? (f.t / FADE).toFixed(2) : '1';
      // a small rise over the whole life, on top of the stack offset
      f.stackY += Math.min(age, 1.2) * 6;
      this.place(f);
    }
  }

  clear() {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
  }
}
