import { FLOOR, WALL, DOOR } from '../world/dungeon.js';
import { TILE } from '../world/meshbuilder.js';

// Fog-of-war minimap on a small canvas, revealed as the player explores.
export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas.getContext('2d');
    this.dungeon = null;
    this.explored = null;
  }

  setDungeon(dungeon) {
    this.dungeon = dungeon;
    this.explored = Array.from({ length: dungeon.size }, () => new Array(dungeon.size).fill(false));
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

  draw(player) {
    if (!this.dungeon) return;
    const { ctx, canvas } = this;
    const n = this.dungeon.size;
    const s = canvas.width / n;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!this.explored[y][x]) continue;
        const t = this.dungeon.grid[y][x];
        if (t === FLOOR) ctx.fillStyle = '#5a5568';
        else if (t === WALL) ctx.fillStyle = '#28242f';
        else if (t === DOOR) ctx.fillStyle = '#8a6a3a';
        else continue;
        ctx.fillRect(x * s, y * s, s + 0.5, s + 0.5);
      }
    }

    // stairs (if discovered)
    if (this.dungeon.stairs) {
      const st = this.dungeon.stairs;
      if (this.explored[st.y]?.[st.x]) {
        ctx.fillStyle = '#e8c05a';
        ctx.fillRect(st.x * s - 1, st.y * s - 1, s + 2, s + 2);
      }
    }

    // player dot
    const px = (player.pos.x / TILE) * s;
    const pz = (player.pos.z / TILE) * s;
    ctx.fillStyle = '#7ce87c';
    ctx.beginPath();
    ctx.arc(px, pz, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
