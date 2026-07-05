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

function speckle(ctx, size, count, alpha) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * alpha})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * alpha * 0.5})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

export function makeFloorTexture(theme) {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const tiles = 4, ts = size / tiles;
  ctx.fillStyle = theme.mortar;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      ctx.fillStyle = shadeColor(theme.floor, 10); // brightness only — keeps stone hue
      ctx.fillRect(x * ts + 2, y * ts + 2, ts - 4, ts - 4);
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
    }
  }
  speckle(ctx, size, 600, 0.16);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeWallTexture(theme) {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = theme.mortar;
  ctx.fillRect(0, 0, size, size);
  const rows = 6, bh = size / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * 0.5;
    const cols = 3;
    const bw = size / cols;
    for (let c = -1; c < cols + 1; c++) {
      const x = (c + offset) * bw;
      ctx.fillStyle = jitterColor(theme.wall, 12);
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

export function makeWoodTexture() {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#5a4028';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = jitterColor('#6b4c30', 16);
    ctx.fillRect(i * (size / 6) + 1, 0, size / 6 - 2, size);
  }
  speckle(ctx, size, 200, 0.2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
