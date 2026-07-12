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
    // "Speaking soon" bubble: a single reused element floated above the head of
    // whoever is currently generating a voice line (Kokoro inference in flight).
    this._think = null;      // { el, x, y, z } | null
  }

  // Show an animated ellipsis pill above a character while their line is
  // queued/synthesizing (before audio starts). worldPos is kept as a LIVE
  // reference and re-read every frame (Obsidian 734): speakers move while
  // their line synthesizes (Magda ambles, elites chase), and a by-value
  // anchor left the pill hanging over empty floor. Pass a live position
  // object (Vector3 / mesh.position / any {x,z} the mover mutates) and the
  // pill follows the head; call hideThinking() once audio starts or the
  // line is cancelled. Three dots pulse in sequence (CSS-driven, staggered
  // delays) -- this element itself never changes text, so no per-frame
  // textContent churn.
  showThinking(worldPos) {
    if (!worldPos) { this.hideThinking(); return; }
    if (!this._think) {
      const el = document.createElement('div');
      el.className = 'floater speak-soon';
      el.innerHTML = '<span></span><span></span><span></span>';
      this.container.appendChild(el);
      this._think = { el };
    }
    this._think.anchor = worldPos;
    this.placeThink();
  }

  hideThinking() {
    if (this._think) { this._think.el.remove(); this._think = null; }
  }

  // Comic-style speech bubble ABOVE the speaker's head (Obsidian 780),
  // replacing the fixed bottom subtitle bar for world NPCs. anchor is a LIVE
  // position object (re-read every frame) so the bubble follows a moving
  // speaker. Auto-expires after durationMs. One bubble at a time (speech is
  // single-voice), so a new line supersedes the old.
  showSpeech(anchor, speaker, text, durationMs = 4200) {
    if (!anchor) return;
    if (!this._speech) {
      const el = document.createElement('div');
      el.className = 'floater speech-bubble';
      el.innerHTML = '<span class="sb-speaker"></span><span class="sb-text"></span>';
      this.container.appendChild(el);
      this._speech = { el, sp: el.querySelector('.sb-speaker'), tx: el.querySelector('.sb-text') };
    }
    this._speech.anchor = anchor;
    this._speech.sp.textContent = speaker || '';
    this._speech.tx.textContent = text || '';
    this._speech.until = (this._now || 0) + durationMs / 1000;
    this._speech.el.classList.remove('fading');
    this.placeSpeech();
  }

  hideSpeech() {
    if (this._speech) { this._speech.el.remove(); this._speech = null; }
  }

  placeSpeech() {
    const s = this._speech;
    if (!s || !s.anchor) return;
    // ~2.4 units above the anchor origin - clears the head and any hat
    this._v.set(s.anchor.x, (s.anchor.y ?? 0) + 2.4, s.anchor.z).project(this.camera);
    if (this._v.z > 1) { s.el.style.opacity = '0'; return; }
    s.el.style.opacity = '';
    s.el.style.left = `${(this._v.x * 0.5 + 0.5) * window.innerWidth}px`;
    s.el.style.top = `${(-this._v.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  placeThink() {
    const t = this._think;
    if (!t || !t.anchor) return;
    // live re-read: the anchor object's x/y/z are whatever the speaker's
    // driver has moved them to THIS frame
    this._v.set(t.anchor.x, (t.anchor.y ?? 0) + 2.0, t.anchor.z).project(this.camera);
    // Hide when the anchor is behind the camera (project z > 1) so the bubble
    // doesn't flip to the wrong side of the screen.
    if (this._v.z > 1) { t.el.style.opacity = '0'; return; }
    t.el.style.opacity = '1';
    t.el.style.left = `${(this._v.x * 0.5 + 0.5) * window.innerWidth}px`;
    t.el.style.top = `${(-this._v.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // Project a world point to screen pixels, reusing the same math the floaters
  // use. Returns { x, y, onScreen }: onScreen is false when the point is behind
  // the camera (project z > 1), so callers can hide their overlay in that case.
  // x/y are still valid-ish when behind camera but should not be trusted.
  worldToScreen(x, y, z) {
    this._v.set(x, y, z).project(this.camera);
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight;
    return { x: sx, y: sy, onScreen: this._v.z <= 1 };
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
    // The "speaking soon" pill's dots pulse via CSS keyframes (staggered
    // delays); just keep it pinned to its world anchor as the camera moves.
    if (this._think) this.placeThink();
    // Speech bubble (780): track the head, expire after its duration.
    this._now = (this._now || 0) + dt;
    if (this._speech) {
      if (this._now >= this._speech.until) this.hideSpeech();
      else this.placeSpeech();
    }
  }

  clear() {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
    this.hideThinking();
    this.hideSpeech();
  }
}
