import { FLOOR, WALL, DOOR, PIT, BRIDGE } from '../world/dungeon.js';
import { TILE } from '../world/meshbuilder.js';

// Fog-of-war minimap on a small canvas, revealed as the player explores.
export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas.getContext('2d');
    this.dungeon = null;
    this.explored = null;
  }

  setDungeon(dungeon, theme = null) {
    this.dungeon = dungeon;
    this.theme = theme;
    // fast lookup for cobbled tiles so town paths read as stone, not grass
    this.cobbleSet = new Set((dungeon.cobbles || []).map((c) => `${c.x},${c.y}`));
    // town is small and safe — reveal the whole map immediately
    this.explored = Array.from({ length: dungeon.size }, () =>
      new Array(dungeon.size).fill(!!dungeon.town));
    this._orient = undefined; // re-seed the smoothed map orientation next draw
  }

  // colors mirror the actual ground: grass/cobble in town, themed stone below
  tileColor(t, x, y) {
    const d = this.dungeon;
    if (d.town) {
      if (t === FLOOR || t === DOOR) {
        return this.cobbleSet.has(`${x},${y}`) ? '#8d8272' : '#3f5a35';
      }
      if (t === WALL) {
        const tv = d.tavern;
        if (tv && x >= tv.x && x < tv.x + tv.w && y >= tv.y && y < tv.y + tv.h) return '#6b4c30';
        return '#2c4023'; // trees, hedges, props
      }
      return null;
    }
    if (t === FLOOR) return this.theme?.floor || '#5a5568';
    if (t === WALL) return this.theme?.mortar || '#28242f';
    if (t === DOOR) return '#8a6a3a';
    if (t === PIT) return '#000000';
    return null;
  }

  revealAround(px, pz, radius = 6) {
    if (!this.dungeon) return;
    const tx = Math.floor(px / TILE), ty = Math.floor(pz / TILE);
    const n = this.dungeon.size;
    for (let y = Math.max(0, ty - radius); y < Math.min(n, ty + radius + 1); y++) {
      for (let x = Math.max(0, tx - radius); x < Math.min(n, tx + radius + 1); x++) {
        if ((x - tx) ** 2 + (y - ty) ** 2 <= radius * radius) this.explored[y][x] = true;
      }
    }
  }

  // Is the tile at (tx,ty) walkable (open) for corridor detection?
  walkable(tx, ty) {
    const t = this.dungeon.grid[ty]?.[tx];
    return t === FLOOR || t === DOOR || t === BRIDGE;
  }

  // Detects whether the player stands in a 1-wide corridor and, if so, returns
  // the extra map rotation that aligns that corridor vertically (camera N/S) on
  // the minimap. A corridor along an axis has walls on both sides of the
  // perpendicular axis and open tiles along it. Returns null when not clearly
  // in a corridor (rooms/junctions), so the caller falls back to camYaw.
  corridorAlign(player, camYaw) {
    const tx = Math.floor(player.pos.x / TILE);
    const ty = Math.floor(player.pos.z / TILE);
    if (!this.walkable(tx, ty)) return null;
    const open = (dx, dy) => this.walkable(tx + dx, ty + dy);
    const openW = open(-1, 0), openE = open(1, 0);
    const openN = open(0, -1), openS = open(0, 1);
    // horizontal corridor: open left/right, walled above/below
    const horiz = openW && openE && !openN && !openS;
    // vertical corridor: open up/down, walled left/right
    const vert = openN && openS && !openW && !openE;
    if (horiz === vert) return null; // neither, or an ambiguous junction
    // World +x (grid east/west) maps to the minimap's horizontal axis. A
    // horizontal corridor should be turned a quarter turn so it runs vertical;
    // a vertical corridor is already vertical. Snap to whichever quarter-turn
    // of camYaw keeps the arrow's up/down feel closest to the camera heading.
    const base = horiz ? Math.PI / 2 : 0;
    // choose base or base+PI, whichever is nearest camYaw, so forward stays "up"
    let target = base;
    if (Math.abs(this.angDiff(base + Math.PI, camYaw)) < Math.abs(this.angDiff(base, camYaw))) {
      target = base + Math.PI;
    }
    return target;
  }

  // shortest signed difference a-b wrapped to (-PI, PI]
  angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Player-centered and rotated so the camera's forward is always "up" (or, in
  // a 1-wide corridor, so the hallway runs vertically). The chosen orientation
  // is smoothed (lerp) so it never snaps.
  draw(player, camYaw = 0) {
    if (!this.dungeon) return;
    const { ctx, canvas } = this;
    const n = this.dungeon.size;
    const s = canvas.width / n;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const px = (player.pos.x / TILE) * s;
    const pz = (player.pos.z / TILE) * s;

    // Corridor auto-orient: in a 1-wide hallway, align it vertically; otherwise
    // fall back to camYaw. Smoothly rotate the map orientation toward the target
    // (lerp along the shortest arc) so it eases rather than snapping.
    const align = this.dungeon.town ? null : this.corridorAlign(player, camYaw);
    const targetOrient = align ?? camYaw;
    if (this._orient === undefined) this._orient = targetOrient;
    this._orient += this.angDiff(targetOrient, this._orient) * 0.12;
    const orient = this._orient;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // rotate the whole map about the player by the smoothed orientation
    ctx.translate(cx, cy);
    ctx.rotate(orient);
    ctx.translate(-px, -pz);

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!this.explored[y]?.[x]) continue;
        const t = this.dungeon.grid[y]?.[x];
        const color = this.tileColor(t, x, y);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x * s, y * s, s + 0.6, s + 0.6);
      }
    }

    if (this.dungeon.stairs) {
      const st = this.dungeon.stairs;
      if (this.explored[st.y]?.[st.x]) {
        ctx.fillStyle = '#e8c05a';
        ctx.fillRect(st.x * s - 1, st.y * s - 1, s + 2, s + 2);
      }
    }

    if (this.dungeon.town) {
      const colors = { potions: '#e05a6a', gear: '#5a8ae0', mystery: '#b45aff' };
      for (const v of this.dungeon.vendors || []) {
        ctx.fillStyle = colors[v.type] || '#fff';
        ctx.fillRect(v.x * s - 2, v.y * s - 2, s + 4, s + 4);
      }
      if (this.dungeon.portal) {
        ctx.fillStyle = '#c77aff';
        ctx.beginPath();
        ctx.arc(this.dungeon.portal.x * s + s / 2, this.dungeon.portal.y * s + s / 2, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // player arrow at the fixed centre, pointing where the player actually FACES
    // (the map rotates by camYaw, so project the world facing vector through it)
    const face = player.visualAngle ?? 0;
    const fx = Math.cos(face), fz = Math.sin(face);
    const sx = fx * Math.cos(orient) - fz * Math.sin(orient);
    const sy = fx * Math.sin(orient) + fz * Math.cos(orient);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(sy, sx) + Math.PI / 2); // arrow art points up by default
    ctx.fillStyle = '#7ce87c';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // subtle compass "N" so rotation is legible
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(orient);
    ctx.fillStyle = 'rgba(232,192,90,0.7)';
    ctx.font = 'bold 10px Georgia';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -cy + 10);
    ctx.restore();
  }
}
