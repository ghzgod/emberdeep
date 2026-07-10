// Item icons: real game-icons.net silhouettes (CC-BY 3.0 - Lorc/Delapouite/
// Willdabeast, see CREDITS.md) picked by slot + item-name keywords (a Wand
// shows a wand, a Tome a book, a Quiver a quiver...), rendered on canvas with
// the rarity metal gradient + glow so rarity still reads at a glance.
// Cached by item signature.
import { ICON_PATHS } from './itemIconPaths.js';

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

// slot -> ordered [regex, iconKey] keyword table; first match wins, the last
// entry is the slot fallback. Keyed off the item NAME so the icon always
// matches what the item says it is (the "wand shows a sword" complaint).
const ICON_RULES = {
  weapon: [
    [/staff|rod/i, 'staff'],
    [/wand|scepter|focus/i, 'wand'],
    [/bow|recurve/i, 'bow'],
    [/.*/, 'sword'],
  ],
  helmet: [
    [/hood|visage|coif/i, 'hood'],
    [/.*/, 'helm'],
  ],
  chest: [
    [/mail|hauberk|vestments/i, 'mail'],
    [/.*/, 'breastplate'],
  ],
  legs: [[/.*/, 'greaves']],
  hands: [
    [/glove|grip/i, 'gloves'],
    [/.*/, 'gauntlet'],
  ],
  trinket: [
    [/ring/i, 'ring'],
    [/crown/i, 'crown'],
    [/\bdie\b|dice/i, 'die'],
    [/heart/i, 'heart'],
    [/.*/, 'pendant'],
  ],
  offhand: [
    [/shield|bulwark|aegis|wardplate/i, 'shield'],
    [/tome|grimoire|codex|book/i, 'tome'],
    [/orb|stone/i, 'orb'],
    [/quiver/i, 'quiver'],
    [/lantern/i, 'lantern'],
    [/.*/, 'totem'],
  ],
};

function pickIconKey(item) {
  const rules = ICON_RULES[item.slot] || ICON_RULES.trinket;
  const name = item.name || '';
  for (const [re, key] of rules) if (re.test(name)) return key;
  return rules[rules.length - 1][1];
}

export function makeItemIcon(item, size = 64) {
  if (!item) return '';
  const key = `${item.id}|${item.slot}|${item.rarity}|${item.name || ''}|${size}`;
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
    const g = x.createRadialGradient(32, 32, 4, 32, 32, 26);
    g.addColorStop(0, t.glow); g.addColorStop(0.6, t.glow); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  }

  const path = new Path2D(ICON_PATHS[pickIconKey(item)] || ICON_PATHS.pendant);
  // The library paths live in a 512x512 box - scale into a 56px stage with a
  // 4px margin, then fill with the rarity metal gradient and rim-light the
  // top-left edge so the silhouette reads as a lit object, not a flat stamp.
  x.save();
  x.translate(4, 4); x.scale(56 / 512, 56 / 512);
  x.fillStyle = metal(x, 256, 256, 230, t);
  x.fill(path);
  x.lineWidth = 10; x.strokeStyle = shift(t.base, -70); x.globalAlpha = 0.55;
  x.stroke(path);
  x.globalAlpha = 1;
  // rim light: same path nudged down-right, clipped to show only a sliver
  x.save();
  x.clip(path);
  x.translate(7, 9);
  x.globalAlpha = 0.5; x.fillStyle = shift(t.base, -60);
  x.fill(path);
  x.restore();
  x.restore();

  const url = canvas.toDataURL();
  CACHE.set(key, url);
  return url;
}
