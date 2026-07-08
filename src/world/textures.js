import * as THREE from 'three';

// Procedural canvas textures: stone floors, brick walls, wood.
// Themed per floor band so deeper floors feel different.

// One theme per act. Five acts, ten floors each.
export const THEMES = {
  stone:    { floor: '#5a5a60', wall: '#6b6b72', mortar: '#3a3a40', accent: 0xffa95e, name: 'The Old Halls' },
  moss:     { floor: '#4e5a48', wall: '#5c6b55', mortar: '#333d2e', accent: 0x8ee87a, name: 'The Rotting Depths' },
  obsidian: { floor: '#4a3540', wall: '#553a45', mortar: '#2a1a22', accent: 0xff5e4a, name: 'The Ember Vaults' },
  cursed:   { floor: '#3d3450', wall: '#463b5c', mortar: '#221c30', accent: 0xb35eff, name: 'The Sunless Court' },
  abyss:    { floor: '#2e3a48', wall: '#37465a', mortar: '#1a2230', accent: 0x4ae8d8, name: 'The Abyssal Throne' },
};

const ACT_THEMES = [null, THEMES.stone, THEMES.moss, THEMES.obsidian, THEMES.cursed, THEMES.abyss];

export function actOfFloor(floor) {
  return Math.min(5, Math.ceil(floor / 10));
}
export function actFloorOf(floor) {
  return ((floor - 1) % 10) + 1;
}

export function themeForFloor(floor) {
  if (floor > 50) return THEMES.abyss; // endless post-victory depths
  return ACT_THEMES[actOfFloor(floor)];
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

// A corner cobweb: faint radial spokes + concentric threads on a transparent
// canvas, so the prop reads as a spiderweb instead of a stray flat triangle.
export function makeCobwebTexture() {
  const [c, x] = makeCanvas(128);
  x.clearRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(222,218,232,0.55)';
  x.lineWidth = 1;
  const cx = 6, cy = 6, R = 118, spokes = 7;
  for (let i = 0; i <= spokes; i++) {
    const a = (i / spokes) * (Math.PI / 2);
    x.beginPath();
    x.moveTo(cx, cy);
    x.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    x.stroke();
  }
  for (let r = 16; r < R; r += 19) {
    x.beginPath();
    for (let i = 0; i <= spokes; i++) {
      const a = (i / spokes) * (Math.PI / 2);
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      i === 0 ? x.moveTo(px, py) : x.lineTo(px, py);
    }
    x.stroke();
  }
  return new THREE.CanvasTexture(c);
}

// A small framed "oil painting": a dusk landscape with a moon and layered
// hills, procedurally generated so each tavern painting differs. No image asset.
export function makePaintingTexture() {
  const [c, x] = makeCanvas(128);
  const g = x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#33456a'); g.addColorStop(0.6, '#7a5a6a'); g.addColorStop(1, '#c88a5a');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  x.fillStyle = 'rgba(240,224,170,0.9)';
  x.beginPath(); x.arc(30 + Math.random() * 70, 28 + Math.random() * 20, 10 + Math.random() * 6, 0, Math.PI * 2); x.fill();
  const cols = ['#2c3a2a', '#213021', '#172417'];
  for (let layer = 0; layer < 3; layer++) {
    x.fillStyle = cols[layer];
    x.beginPath(); x.moveTo(0, 128);
    const base = 74 + layer * 16, ph = Math.random() * 6;
    for (let px = 0; px <= 128; px += 12) x.lineTo(px, base + Math.sin(px * 0.08 + layer + ph) * 9 - Math.random() * 5);
    x.lineTo(128, 128); x.closePath(); x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// Deterministic per-floor RNG (simple LCG) so floor-to-floor variation (tint,
// torch hue, prop mix, particle density) is stable across reloads and stays
// in sync between host and guest in multiplayer without transmitting anything
// extra — both sides derive it from the same floor number.
export function floorRng(floor) {
  let seed = (Math.imul((floor || 0) + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

// Nudges an accent color's hue/saturation a small deterministic amount, so
// each floor within an act carries a slightly different torchlight/particle
// mood without straying from the act's palette.
export function jitterAccentHue(hex, rng) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hsl.h = (hsl.h + (rng() - 0.5) * 0.05 + 1) % 1;
  hsl.s = Math.min(1, Math.max(0, hsl.s * (0.85 + rng() * 0.3)));
  c.setHSL(hsl.h, hsl.s, hsl.l);
  return c.getHex();
}

// Deterministic brightness shift (seed in [0,1)) applied to a base color
// before the existing random per-tile jitter/speckle — gives floor textures
// within an act a subtle per-floor lightness difference.
function seededTint(hex, seed, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const d = Math.round((seed - 0.5) * 2 * amount);
  const c = (v) => Math.min(255, Math.max(0, v + d));
  const h = (v) => v.toString(16).padStart(2, '0');
  return `#${h(c(r))}${h(c(g))}${h(c(b))}`;
}

function jitterColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const j = () => Math.floor((Math.random() - 0.5) * 2 * amount);
  r = Math.min(255, Math.max(0, r + j()));
  g = Math.min(255, Math.max(0, g + j()));
  b = Math.min(255, Math.max(0, b + j()));
  return `rgb(${r},${g},${b})`;
}

// Brightness-only variation: applies the SAME delta to every channel so the hue
// is preserved. Using independent-channel jitter on a near-gray stone produced
// distinctly coloured tiles (pink/green/orange) that tiled into rainbow stripes.
function shadeColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const d = Math.floor((Math.random() - 0.5) * 2 * amount);
  const c = (v) => Math.min(255, Math.max(0, v + d));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// Soft radial glow: bright core fading to transparent. Shared by projectiles
// and every dungeon flame (torches/braziers/candelabra) so a flame reads as a
// glowing orb instead of a flat lit blob, without any postfx.
export function makeGlowTexture() {
  const [c, x] = makeCanvas(64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// A small glowing rune glyph (ring + crossing shards) in the act's accent,
// transparent elsewhere, drawn on an unlit sprite so an occasional floor tile
// reads as a faintly magical inlay rather than a painted symbol.
export function makeRuneTexture(theme) {
  const size = 128;
  const [c, x] = makeCanvas(size);
  x.clearRect(0, 0, size, size);
  const accentHex = '#' + theme.accent.toString(16).padStart(6, '0');
  const cx = size / 2, cy = size / 2, r = size * 0.34;
  const haze = x.createRadialGradient(cx, cy, 0, cx, cy, r * 1.4);
  haze.addColorStop(0, accentHex);
  haze.addColorStop(1, 'rgba(0,0,0,0)');
  x.globalAlpha = 0.5;
  x.fillStyle = haze;
  x.beginPath(); x.arc(cx, cy, r * 1.4, 0, Math.PI * 2); x.fill();
  x.globalAlpha = 1;
  x.strokeStyle = accentHex;
  x.lineWidth = 3;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
  const spokes = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + Math.random() * 0.4;
    x.beginPath();
    x.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3);
    x.lineTo(cx + Math.cos(a) * r * 1.05, cy + Math.sin(a) * r * 1.05);
    x.stroke();
  }
  return new THREE.CanvasTexture(c);
}

function speckle(ctx, size, count, alpha) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * alpha})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * alpha * 0.5})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

export function makeFloorTexture(theme, floorSeed = 0.5) {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const tiles = 4, ts = size / tiles;
  const floorBase = seededTint(theme.floor, floorSeed, 10); // per-floor lightness within the act
  ctx.fillStyle = theme.mortar;
  ctx.fillRect(0, 0, size, size);
  const checkered = theme.name === 'The Sunless Court'; // dark checkered stone, cursed act only
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      ctx.fillStyle = shadeColor(floorBase, 10); // brightness only — keeps stone hue
      ctx.fillRect(x * ts + 2, y * ts + 2, ts - 4, ts - 4);
      if (checkered && (x + y) % 2 === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x * ts + 2, y * ts + 2, ts - 4, ts - 4);
      }
      // cracked corner detail
      if (Math.random() < 0.3) {
        ctx.strokeStyle = theme.mortar;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const cx = x * ts + Math.random() * ts, cy = y * ts + Math.random() * ts;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (Math.random() - 0.5) * 24, cy + (Math.random() - 0.5) * 24);
        ctx.stroke();
      }
      // chipped/worn corner: a small notch cut from a tile edge
      if (Math.random() < 0.22) {
        const cornerX = x * ts + (Math.random() < 0.5 ? 3 : ts - 3);
        const cornerY = y * ts + (Math.random() < 0.5 ? 3 : ts - 3);
        ctx.fillStyle = theme.mortar;
        ctx.beginPath();
        ctx.moveTo(cornerX, cornerY);
        ctx.lineTo(cornerX + (Math.random() - 0.5) * 14, cornerY);
        ctx.lineTo(cornerX, cornerY + (Math.random() - 0.5) * 14);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  speckle(ctx, size, 600, 0.16);
  // per-act staining so the gothic stone reads distinctly per act
  if (theme.name === 'The Rotting Depths') {
    // moss staining: irregular green-tinted blotches creeping across the stone
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = `rgba(70,110,50,${0.12 + Math.random() * 0.1})`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * size, Math.random() * size, 20 + Math.random() * 30, 14 + Math.random() * 20, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (theme.name === 'The Ember Vaults') {
    // ember scorch: dark charred patches with tiny warm flecks
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(20,8,4,${0.25 + Math.random() * 0.15})`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * size, Math.random() * size, 16 + Math.random() * 22, 12 + Math.random() * 16, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,150,60,0.5)';
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
  } else if (theme.name === 'The Abyssal Throne') {
    // abyssal sheen: a cool diagonal glossy streak
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, 'rgba(120,200,220,0)');
    grad.addColorStop(0.5, 'rgba(120,200,220,0.08)');
    grad.addColorStop(1, 'rgba(120,200,220,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeWallTexture(theme, floorSeed = 0.5) {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const wallBase = seededTint(theme.wall, floorSeed, 9); // per-floor lightness within the act
  ctx.fillStyle = theme.mortar;
  ctx.fillRect(0, 0, size, size);
  const rows = 6, bh = size / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * 0.5;
    const cols = 3;
    const bw = size / cols;
    for (let c = -1; c < cols + 1; c++) {
      const x = (c + offset) * bw;
      ctx.fillStyle = jitterColor(wallBase, 12);
      ctx.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
  }
  speckle(ctx, size, 500, 0.18);
  // subtle top-down shading
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeGrassTexture() {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#3d5a33';
  ctx.fillRect(0, 0, size, size);
  // mottled patches
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = jitterColor(Math.random() < 0.5 ? '#46653a' : '#35502c', 10);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(Math.random() * size, Math.random() * size, 14 + Math.random() * 26, 10 + Math.random() * 18, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // grass blade strokes
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    ctx.strokeStyle = jitterColor(Math.random() < 0.7 ? '#4e7040' : '#5d8148', 14);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 3);
    ctx.stroke();
  }
  // scattered tiny wildflowers
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = ['#d8c95a', '#c96a6a', '#b98ad8', '#e8e0d0'][Math.floor(Math.random() * 4)];
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeCobbleTexture() {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#4b4740';
  ctx.fillRect(0, 0, size, size);
  // irregular flagstones: offset rows, varied sizes, tight joints
  const rows = 5;
  const ch = size / rows;
  for (let r = -1; r <= rows; r++) {
    let x = (r % 2) * -18;
    while (x < size + 20) {
      const w = 34 + Math.random() * 34;
      const cy = r * ch + ch / 2 + (Math.random() - 0.5) * 4;
      const b = 88 + Math.floor(Math.random() * 14);
      ctx.fillStyle = `rgb(${b},${b - 3},${b - 8})`;
      ctx.beginPath();
      // rounded-rectangle slab
      const sw = w - 4, sh = ch - 5;
      ctx.roundRect(x + 2, cy - sh / 2, sw, sh, 7);
      ctx.fill();
      // subtle worn top edge
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x + 5, cy - sh / 2 + 2, sw - 6, 3);
      x += w;
    }
  }
  speckle(ctx, size, 500, 0.12);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A wall tapestry motif: dyed cloth with a border and a diamond emblem in the
// theme's accent, so a hung banner reads as a real decoration rather than a
// bare colored quad. One texture per theme (cached by the caller).
export function makeBannerTexture(theme) {
  const w = 128, h = 240;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const accentHex = '#' + theme.accent.toString(16).padStart(6, '0');
  ctx.fillStyle = theme.mortar;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = jitterColor(theme.wall, 8);
  ctx.fillRect(6, 6, w - 12, h - 12);
  // vertical fabric folds
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.05})`;
    const fx = 10 + (i / 7) * (w - 20);
    ctx.fillRect(fx, 6, 3, h - 12);
  }
  // accent border frame
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  // diamond emblem with a punched-out center
  const cx = w / 2, cy = h * 0.4;
  ctx.fillStyle = accentHex;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 34); ctx.lineTo(cx + 30, cy); ctx.lineTo(cx, cy + 34); ctx.lineTo(cx - 30, cy);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = theme.mortar;
  ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill();
  // lower trim bar
  ctx.fillStyle = accentHex;
  ctx.fillRect(w * 0.2, h - 34, w * 0.6, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeWoodTexture() {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#5a4028';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 6; i++) {
    // brightness-only jitter (not independent-channel) so planks stay brown
    // instead of tiling into the rainbow-striped look independent RGB jitter
    // produces on a mid-tone base.
    ctx.fillStyle = shadeColor('#6b4c30', 16);
    ctx.fillRect(i * (size / 6) + 1, 0, size / 6 - 2, size);
  }
  speckle(ctx, size, 200, 0.2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Horizontal wooden planks with dark seams and drawn grain, for tavern walls
// and the bar front. Reads as fitted board panelling rather than the vertical
// staves in makeWoodTexture, so a wall and a barrel don't share one look.
export function makePlankTexture(base = '#6a4a2c') {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#2a1a0e';
  ctx.fillRect(0, 0, size, size);
  const rows = 5, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = shadeColor(base, 14);
    ctx.fillRect(0, r * rh + 2, size, rh - 3);
    // long grain streaks running along each board
    for (let g = 0; g < 5; g++) {
      ctx.strokeStyle = `rgba(40,24,12,${0.12 + Math.random() * 0.14})`;
      ctx.lineWidth = 1;
      const gy = r * rh + 4 + Math.random() * (rh - 8);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let px = 0; px <= size; px += 16) ctx.lineTo(px, gy + (Math.random() - 0.5) * 3);
      ctx.stroke();
    }
    // occasional peg/knot
    if (Math.random() < 0.7) {
      ctx.fillStyle = 'rgba(30,18,8,0.5)';
      ctx.beginPath();
      ctx.arc(20 + Math.random() * (size - 40), r * rh + rh / 2, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  speckle(ctx, size, 160, 0.16);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Rough grey fieldstone for the hearth surround and mantel: irregular mortared
// blocks so the fireplace reads as stone masonry against the wooden walls.
export function makeHearthStoneTexture() {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#33302b';
  ctx.fillRect(0, 0, size, size);
  const rows = 5, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * 0.5;
    let x = -offset * 40;
    while (x < size) {
      const w = 22 + Math.random() * 20;
      const b = 96 + Math.floor(Math.random() * 20);
      ctx.fillStyle = `rgb(${b},${b - 4},${b - 9})`;
      ctx.beginPath();
      ctx.roundRect(x + 2, r * rh + 2, w - 3, rh - 3, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x + 4, r * rh + 3, w - 7, 2);
      x += w;
    }
  }
  speckle(ctx, size, 300, 0.14);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The hanging tavern sign face: a plank board with a painted golden golem
// silhouette and "THE SLEEPING GOLEM" lettering, so the swinging sign actually
// names the inn instead of being a blank board.
export function makeTavernSignTexture() {
  const w = 256, h = 160;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  // weathered board
  x.fillStyle = '#5a3c22';
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    x.fillStyle = `rgba(30,18,8,${0.1 + Math.random() * 0.12})`;
    x.fillRect(0, (i / 6) * h, w, 2);
  }
  // gilt border
  x.strokeStyle = '#d8b04a';
  x.lineWidth = 6;
  x.strokeRect(8, 8, w - 16, h - 16);
  // sleeping golem: a slumped stone head with closed eyes
  x.fillStyle = '#c8a24a';
  x.beginPath();
  x.arc(w / 2, h * 0.42, 30, 0, Math.PI * 2);
  x.fill();
  x.strokeStyle = '#3a2a12';
  x.lineWidth = 3;
  x.beginPath(); x.moveTo(w / 2 - 16, h * 0.4); x.lineTo(w / 2 - 4, h * 0.4); x.stroke();
  x.beginPath(); x.moveTo(w / 2 + 4, h * 0.4); x.lineTo(w / 2 + 16, h * 0.4); x.stroke();
  // little "Z" of sleep
  x.fillStyle = '#d8b04a';
  x.font = 'bold 22px serif';
  x.fillText('z', w / 2 + 30, h * 0.28);
  // lettering
  x.fillStyle = '#e8d08a';
  x.font = 'bold 20px serif';
  x.textAlign = 'center';
  x.fillText('THE SLEEPING GOLEM', w / 2, h - 22);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
