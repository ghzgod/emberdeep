// Procedural item icons. Every item gets its own slot-appropriate picture drawn
// on a canvas, tinted by rarity and varied deterministically from its id/name so
// no two look alike and nothing relies on emoji. Cached by item signature.
const CACHE = new Map();

// base metal, bright edge highlight, and a gem/accent colour per rarity.
const TINT = {
  common:    { base: '#8f959d', edge: '#c6ccd4', gem: '#7c8794', glow: 'rgba(180,190,200,0.0)' },
  rare:      { base: '#3f6bc4', edge: '#8fbaff', gem: '#4fd0ff', glow: 'rgba(80,160,255,0.16)' },
  epic:      { base: '#8e46cf', edge: '#d29cff', gem: '#c07eff', glow: 'rgba(180,110,255,0.18)' },   // Super Rare (purple)
  legendary: { base: '#d9832a', edge: '#ffca74', gem: '#ff9a3a', glow: 'rgba(255,150,60,0.24)' },    // Epic (orange)
};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shift(hex, dh) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = hex; const m = c.fillStyle; // normalize
  const n = parseInt(m.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + dh)); g = Math.max(0, Math.min(255, g + dh)); b = Math.max(0, Math.min(255, b + dh));
  return `rgb(${r},${g},${b})`;
}

function metal(x, cx, cy, r, tint) {
  const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r * 1.3);
  g.addColorStop(0, tint.edge); g.addColorStop(0.5, tint.base); g.addColorStop(1, shift(tint.base, -55));
  return g;
}

// ---- per-slot silhouettes (drawn centered in a 64 box) ----
function drawHelmet(x, t, rnd) {
  x.fillStyle = metal(x, 32, 30, 20, t);
  x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  x.beginPath(); x.arc(32, 30, 18, Math.PI, 0); x.lineTo(50, 40); x.lineTo(14, 40); x.closePath(); x.fill(); x.stroke();
  // brow band + nasal guard
  x.fillStyle = t.edge; x.fillRect(15, 30, 34, 5);
  x.fillStyle = shift(t.base, -30); x.fillRect(30, 30, 4, 14);
  // a crest/plume, unique colour + height
  const ph = 8 + Math.floor(rnd() * 12);
  x.fillStyle = t.gem; x.beginPath(); x.moveTo(32, 12); x.lineTo(28, 12 - ph); x.lineTo(36, 12 - ph + 4); x.closePath(); x.fill();
}
function drawChest(x, t, rnd) {
  x.fillStyle = metal(x, 32, 34, 20, t);
  x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  x.beginPath(); x.moveTo(16, 20); x.lineTo(48, 20); x.lineTo(44, 50); x.lineTo(32, 56); x.lineTo(20, 50); x.closePath(); x.fill(); x.stroke();
  x.strokeStyle = t.edge; x.beginPath(); x.moveTo(32, 22); x.lineTo(32, 52); x.stroke(); // center seam
  // shoulder rivets + a chest gem
  x.fillStyle = t.gem; for (const rx of [22, 42]) { x.beginPath(); x.arc(rx, 24, 3, 0, 7); x.fill(); }
  x.beginPath(); x.arc(32, 34, 3 + rnd() * 2, 0, 7); x.fill();
}
function drawLegs(x, t) {
  x.fillStyle = metal(x, 32, 34, 18, t); x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  for (const lx of [22, 42]) { x.beginPath(); x.moveTo(lx - 6, 18); x.lineTo(lx + 6, 18); x.lineTo(lx + 5, 52); x.lineTo(lx - 5, 52); x.closePath(); x.fill(); x.stroke(); }
  x.fillStyle = t.edge; x.fillRect(14, 30, 36, 3); // knee band
}
function drawHands(x, t, rnd) {
  x.fillStyle = metal(x, 32, 34, 18, t); x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  x.beginPath(); x.moveTo(18, 22); x.lineTo(46, 22); x.lineTo(44, 46); x.lineTo(20, 46); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = shift(t.base, -20); for (let i = 0; i < 4; i++) x.fillRect(20 + i * 7, 44, 5, 12); // fingers
  x.fillStyle = t.gem; x.beginPath(); x.arc(32, 30, 3 + rnd() * 2, 0, 7); x.fill(); // knuckle gem
}
function drawTrinket(x, t, rnd) {
  x.lineWidth = 4; x.strokeStyle = metal(x, 32, 34, 16, t);
  x.beginPath(); x.arc(32, 36, 14, 0, 7); x.stroke(); // ring band
  const g = t.gem; x.fillStyle = g; x.strokeStyle = t.edge; x.lineWidth = 1.5;
  const gs = 6 + rnd() * 3; // faceted gem
  x.beginPath(); x.moveTo(32, 36 - 14 - gs); x.lineTo(32 - gs, 36 - 14); x.lineTo(32, 36 - 14 + gs * 0.6); x.lineTo(32 + gs, 36 - 14); x.closePath(); x.fill(); x.stroke();
}
// Offhand: a small shield-book hybrid silhouette (covers knight shields as
// well as mage tomes / ranger quivers/talismans that also live in this slot).
function drawOffhand(x, t, rnd) {
  x.fillStyle = metal(x, 30, 30, 18, t);
  x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  x.beginPath(); x.moveTo(30, 10); x.lineTo(44, 15); x.lineTo(44, 30); x.quadraticCurveTo(44, 42, 30, 50); x.quadraticCurveTo(16, 42, 16, 30); x.lineTo(16, 15); x.closePath();
  x.fill(); x.stroke();
  // small book plate overlay
  x.fillStyle = t.edge; x.fillRect(23, 24, 14, 16);
  x.strokeStyle = shift(t.base, -50); x.lineWidth = 1; x.beginPath(); x.moveTo(30, 24); x.lineTo(30, 40); x.stroke();
  x.fillStyle = t.gem; x.beginPath(); x.arc(30, 32, 2.6 + rnd() * 1.6, 0, 7); x.fill();
}
function drawWeapon(x, t, rnd, forClass) {
  x.strokeStyle = shift(t.base, -70); x.lineWidth = 2;
  if (forClass === 'mage') {
    x.fillStyle = metal(x, 32, 40, 6, t); x.fillRect(30, 20, 5, 36); x.strokeRect(30, 20, 5, 36); // rod
    const g = x.createRadialGradient(32, 16, 1, 32, 16, 10); g.addColorStop(0, t.edge); g.addColorStop(1, t.gem);
    x.fillStyle = g; x.beginPath(); x.arc(32, 15, 8 + rnd() * 2, 0, 7); x.fill(); // orb
  } else if (forClass === 'ranger') {
    x.strokeStyle = metal(x, 24, 32, 20, t); x.lineWidth = 4;
    x.beginPath(); x.arc(38, 32, 20, Math.PI * 0.6, Math.PI * 1.4); x.stroke(); // bow limb
    x.strokeStyle = t.edge; x.lineWidth = 1; x.beginPath(); x.moveTo(26, 15); x.lineTo(26, 49); x.stroke(); // string
  } else {
    // sword: blade + crossguard + hilt
    const bg = x.createLinearGradient(28, 8, 36, 44); bg.addColorStop(0, t.edge); bg.addColorStop(1, t.base);
    x.fillStyle = bg; x.beginPath(); x.moveTo(32, 6); x.lineTo(36, 12); x.lineTo(35, 42); x.lineTo(29, 42); x.lineTo(28, 12); x.closePath(); x.fill(); x.stroke();
    x.fillStyle = t.gem; x.fillRect(22, 42, 20, 5); // crossguard
    x.fillStyle = shift(t.base, -35); x.fillRect(30, 47, 4, 11); // grip
    x.fillStyle = t.edge; x.beginPath(); x.arc(32, 59, 3, 0, 7); x.fill(); // pommel
  }
}

export function makeItemIcon(item, size = 64) {
  if (!item) return '';
  const key = `${item.id}|${item.slot}|${item.rarity}|${item.forClass || ''}`;
  const hit = CACHE.get(key); if (hit) return hit;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const x = canvas.getContext('2d');
  x.scale(size / 64, size / 64);
  const baseTint = TINT[item.rarity] || TINT.common;
  const rnd = mulberry(hashStr((item.name || '') + '#' + item.id));
  // per-item hue nudge so same-slot items still differ
  const dh = Math.floor((rnd() - 0.5) * 30);
  const t = { base: shift(baseTint.base, dh), edge: shift(baseTint.edge, dh), gem: shift(baseTint.gem, dh), glow: baseTint.glow };

  // soft rarity glow behind the item
  if (item.rarity !== 'common') {
    const g = x.createRadialGradient(32, 32, 4, 32, 32, 22);
    g.addColorStop(0, t.glow); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  }
  switch (item.slot) {
    case 'helmet': drawHelmet(x, t, rnd); break;
    case 'chest': drawChest(x, t, rnd); break;
    case 'legs': drawLegs(x, t); break;
    case 'hands': drawHands(x, t, rnd); break;
    case 'trinket': drawTrinket(x, t, rnd); break;
    case 'weapon': drawWeapon(x, t, rnd, item.forClass); break;
    case 'offhand': drawOffhand(x, t, rnd); break;
    default: drawTrinket(x, t, rnd);
  }
  const url = canvas.toDataURL();
  CACHE.set(key, url);
  return url;
}
