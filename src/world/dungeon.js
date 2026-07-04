// Procedural dungeon: room-scatter + L-corridors on a tile grid.
// Tile values:
export const VOID = 0, FLOOR = 1, WALL = 2, DOOR = 3;

const GRID = 48;

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

function roomsOverlap(a, b, pad = 2) {
  return a.x - pad < b.x + b.w + pad && a.x + a.w + pad > b.x - pad &&
         a.y - pad < b.y + b.h + pad && a.y + a.h + pad > b.y - pad;
}

function roomCenter(r) {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

export function generateDungeon(floor) {
  if (floor === 10) return generateBossFloor(floor);

  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(VOID));
  const rooms = [];
  const roomCount = randInt(8, 14);
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 300) {
    attempts++;
    const w = randInt(5, 9), h = randInt(5, 9);
    const room = { x: randInt(2, GRID - w - 3), y: randInt(2, GRID - h - 3), w, h };
    if (rooms.some((r) => roomsOverlap(room, r))) continue;
    rooms.push(room);
  }

  // Carve rooms
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        grid[y][x] = FLOOR;
  }

  // Connect each room to the next (sorted for locality) with L corridors.
  const sorted = [...rooms].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const doorSpots = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = roomCenter(sorted[i - 1]);
    const b = roomCenter(sorted[i]);
    const horizFirst = Math.random() < 0.5;
    carveCorridor(grid, a, b, horizFirst, doorSpots);
  }
  // A couple of extra loops so it isn't a pure chain.
  for (let i = 0; i < 2 && sorted.length > 4; i++) {
    const a = roomCenter(sorted[randInt(0, sorted.length - 1)]);
    const b = roomCenter(sorted[randInt(0, sorted.length - 1)]);
    carveCorridor(grid, a, b, Math.random() < 0.5, doorSpots);
  }

  // Walls: any VOID adjacent (8-way) to FLOOR becomes WALL.
  addWalls(grid);

  // Spawn room and stairs room: pick the farthest-apart pair.
  let best = { d: -1, a: rooms[0], b: rooms[rooms.length - 1] };
  for (const r1 of rooms) for (const r2 of rooms) {
    const c1 = roomCenter(r1), c2 = roomCenter(r2);
    const d = (c1.x - c2.x) ** 2 + (c1.y - c2.y) ** 2;
    if (d > best.d) best = { d, a: r1, b: r2 };
  }
  const spawnRoom = best.a, stairsRoom = best.b;
  const spawn = roomCenter(spawnRoom);
  const stairs = roomCenter(stairsRoom);

  // Doors: narrow corridor tiles adjacent to a room edge (subset, for flavor).
  const doors = pickDoors(grid, doorSpots, spawn, stairs);
  for (const d of doors) grid[d.y][d.x] = DOOR;

  // Torches on wall tiles that face floor, spaced out.
  const torches = placeTorches(grid);

  // Chests: 2-4, in rooms that aren't spawn/stairs, not blocking centers.
  const chests = [];
  const chestRooms = rooms.filter((r) => r !== spawnRoom && r !== stairsRoom);
  const chestCount = Math.min(chestRooms.length, randInt(2, 4));
  shuffle(chestRooms);
  for (let i = 0; i < chestCount; i++) {
    const r = chestRooms[i];
    chests.push({ x: r.x + randInt(1, r.w - 2), y: r.y + randInt(1, r.h - 2) });
  }

  // Enemy spawns: every non-spawn room, count scaled by depth.
  const enemies = [];
  const minibossFloor = floor === 3 || floor === 6 || floor === 9;
  let minibossPlaced = false;
  for (const r of rooms) {
    if (r === spawnRoom) continue;
    const c = roomCenter(r);
    const distFromSpawn = Math.hypot(c.x - spawn.x, c.y - spawn.y);
    let count = randInt(2, 4) + Math.floor(floor / 2);
    if (r === stairsRoom) count += 2;
    for (let i = 0; i < count; i++) {
      enemies.push({
        x: r.x + randInt(1, r.w - 2),
        y: r.y + randInt(1, r.h - 2),
        type: pickEnemyType(floor),
        miniboss: false,
      });
    }
    if (minibossFloor && !minibossPlaced && r === stairsRoom && distFromSpawn > 10) {
      enemies.push({ x: c.x, y: c.y, type: pickEnemyType(floor), miniboss: true });
      minibossPlaced = true;
    }
  }
  if (minibossFloor && !minibossPlaced) {
    const c = roomCenter(stairsRoom);
    enemies.push({ x: c.x, y: c.y, type: pickEnemyType(floor), miniboss: true });
  }

  return { grid, size: GRID, rooms, spawn, stairs, torches, chests, doors, enemies, boss: null };
}

function carveCorridor(grid, a, b, horizFirst, doorSpots) {
  const carve = (x, y) => {
    if (grid[y][x] === VOID) {
      grid[y][x] = FLOOR;
      doorSpots.push({ x, y });
    }
  };
  if (horizFirst) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, a.y);
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(b.x, y);
  } else {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(a.x, y);
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, b.y);
  }
}

function addWalls(grid) {
  const n = grid.length;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (grid[y][x] !== VOID) continue;
      outer:
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= n || nx >= n) continue;
          if (grid[ny][nx] === FLOOR) { grid[y][x] = WALL; break outer; }
        }
      }
    }
  }
}

// Corridor tiles flanked by walls on both sides (N/S or E/W) make good doors.
function pickDoors(grid, doorSpots, spawn, stairs) {
  const doors = [];
  const used = new Set();
  for (const s of doorSpots) {
    if (doors.length >= 5) break;
    const { x, y } = s;
    if (grid[y][x] !== FLOOR) continue;
    if (Math.hypot(x - spawn.x, y - spawn.y) < 4) continue;
    if (Math.hypot(x - stairs.x, y - stairs.y) < 4) continue;
    const key = `${x},${y}`;
    if (used.has(key)) continue;
    const nsWalls = grid[y - 1]?.[x] === WALL && grid[y + 1]?.[x] === WALL;
    const ewWalls = grid[y]?.[x - 1] === WALL && grid[y]?.[x + 1] === WALL;
    if ((nsWalls || ewWalls) && Math.random() < 0.35) {
      // avoid adjacent doors
      let nearDoor = false;
      for (const d of doors) if (Math.abs(d.x - x) + Math.abs(d.y - y) < 3) nearDoor = true;
      if (nearDoor) continue;
      doors.push({ x, y, vertical: nsWalls });
      used.add(key);
    }
  }
  return doors;
}

function placeTorches(grid) {
  const torches = [];
  const n = grid.length;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      if (grid[y][x] !== WALL) continue;
      // faces floor?
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dx, dy] of dirs) {
        if (grid[y + dy][x + dx] === FLOOR && Math.random() < 0.10) {
          // keep spacing
          if (!torches.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < 5)) {
            torches.push({ x, y, fx: x + dx * 0.6, fy: y + dy * 0.6 });
          }
          break;
        }
      }
    }
  }
  return torches;
}

function pickEnemyType(floor) {
  // Weighted pools shift with depth.
  const pools = [
    { type: 'skeleton', w: 4 },
    { type: 'spider', w: floor >= 2 ? 3 : 0 },
    { type: 'imp', w: floor >= 3 ? 3 : 0 },
    { type: 'golem', w: floor >= 5 ? 2 : 0 },
  ];
  const total = pools.reduce((s, p) => s + p.w, 0);
  let roll = Math.random() * total;
  for (const p of pools) {
    roll -= p.w;
    if (roll <= 0) return p.type;
  }
  return 'skeleton';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Floor 10: hand-shaped arena — entry corridor into a large octagonal hall.
function generateBossFloor(floor) {
  const n = 40;
  const grid = Array.from({ length: n }, () => new Array(n).fill(VOID));
  const cx = 20, cy = 16, radius = 11;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < radius) grid[y][x] = FLOOR;
    }
  }
  // Entry corridor from the south.
  for (let y = cy + radius - 1; y < n - 3; y++) {
    grid[y][cx - 1] = FLOOR; grid[y][cx] = FLOOR; grid[y][cx + 1] = FLOOR;
  }
  // Small antechamber at the bottom.
  for (let y = n - 7; y < n - 2; y++)
    for (let x = cx - 3; x <= cx + 3; x++)
      grid[y][x] = FLOOR;

  addWalls(grid);

  const spawn = { x: cx, y: n - 4 };
  const torches = placeTorchesArena(grid, cx, cy, radius);
  return {
    grid, size: n, rooms: [],
    spawn,
    stairs: null, // no way down — this is the end
    torches, chests: [{ x: cx - 5, y: cy - 5 }], doors: [],
    enemies: [],
    boss: { x: cx, y: cy - 3 },
  };
}

function placeTorchesArena(grid, cx, cy, radius) {
  const torches = [];
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
    const x = Math.round(cx + Math.cos(angle) * (radius + 0.5));
    const y = Math.round(cy + Math.sin(angle) * (radius + 0.5));
    if (grid[y]?.[x] === WALL) {
      torches.push({ x, y, fx: cx + Math.cos(angle) * (radius - 0.8), fy: cy + Math.sin(angle) * (radius - 0.8) });
    }
  }
  return torches;
}
