import * as THREE from 'three';

// Floating combat text: HTML divs projected from world space.
export class Floaters {
  constructor(camera) {
    this.camera = camera;
    this.container = document.getElementById('floaters');
    this.active = [];
    this._v = new THREE.Vector3();
  }

  spawn(worldPos, text, cssClass = '') {
    const el = document.createElement('div');
    el.className = `floater ${cssClass}`;
    el.textContent = text;
    this.container.appendChild(el);
    const jx = (Math.random() - 0.5) * 30;
    this.active.push({ el, x: worldPos.x, y: (worldPos.y ?? 0) + 1.6, z: worldPos.z, t: 0.9, jx });
    // place immediately so it doesn't flash at 0,0
    this.place(this.active[this.active.length - 1]);
  }

  place(f) {
    this._v.set(f.x, f.y, f.z).project(this.camera);
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth + f.jx;
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight;
    f.el.style.left = `${sx}px`;
    f.el.style.top = `${sy}px`;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      f.t -= dt;
      if (f.t <= 0) {
        f.el.remove();
        this.active.splice(i, 1);
      } else {
        this.place(f);
      }
    }
  }

  clear() {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
  }
}
