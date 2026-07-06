// Procedural dungeon: room-scatter + L-corridors on a tile grid.
// Tile values:
export const VOID = 0, FLOOR = 1, WALL = 2, DOOR = 3, PIT = 4, CHASM = 5, BRIDGE = 6, RUBBLE = 7;
// CHASM = impassable dark abyss; BRIDGE = walkable plank over a chasm;
// RUBBLE = a broken/crumbled wall (still blocks, rendered as debris).

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

// Five acts of ten floors; every act's 10th floor is a boss arena.
export function generateDungeon(floor) {
  const actFloor = floor <= 50 ? ((floor - 1) % 10) + 1 : 0;
  if (actFloor === 10) return generateBossFloor(floor);

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

  // Carve chasms with plank BRIDGES across a couple of large rooms — a dark
  // abyss below, crossed by a plus-shaped walkway so the room stays passable.
  const chasmRooms = rooms.filter((r) =>
    r !== spawnRoom && r !== stairsRoom && r.w >= 7 && r.h >= 7);
  shuffle(chasmRooms);
  const chasmTiles = [], bridgeTiles = [];
  for (const r of chasmRooms.slice(0, floor >= 2 ? 2 : 1)) {
    const cxr = Math.floor(r.x + r.w / 2), cyr = Math.floor(r.y + r.h / 2);
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        if (grid[y][x] !== FLOOR) continue;
        // keep a 2-wide plus-shaped bridge through the room centre
        const onBridge = Math.abs(x - cxr) <= 1 || Math.abs(y - cyr) <= 1;
        if (onBridge) { grid[y][x] = BRIDGE; bridgeTiles.push({ x, y }); }
        else { grid[y][x] = CHASM; chasmTiles.push({ x, y }); }
      }
    }
  }

  // Broken walls: crumble a fraction of walls into rubble piles (still solid).
  const rubbleWalls = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      if (grid[y][x] === WALL && rand(0, 1) < 0.06) {
        // only crumble walls that border floor, for visible destruction
        const bordersFloor = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => grid[y+dy]?.[x+dx] === FLOOR || grid[y+dy]?.[x+dx] === BRIDGE);
        if (bordersFloor) { grid[y][x] = RUBBLE; rubbleWalls.push({ x, y }); }
      }
    }
  }

  const isOpen = (t) => t === FLOOR || t === BRIDGE || t === DOOR;
  // nudge a tile onto solid ground if it landed on a chasm
  const solidNear = (x, y) => {
    if (isOpen(grid[y]?.[x])) return { x, y };
    for (let rad = 1; rad <= 3; rad++)
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++)
          if (isOpen(grid[y + dy]?.[x + dx])) return { x: x + dx, y: y + dy };
    return { x, y };
  };

  // Torches on wall tiles that face floor, spaced out.
  const torches = placeTorches(grid);

  // Chests: 2-4, in rooms that aren't spawn/stairs, not blocking centers.
  const chests = [];
  const chestRooms = rooms.filter((r) => r !== spawnRoom && r !== stairsRoom);
  const chestCount = Math.min(chestRooms.length, randInt(2, 4));
  shuffle(chestRooms);
  for (let i = 0; i < chestCount; i++) {
    const r = chestRooms[i];
    chests.push(solidNear(r.x + randInt(1, r.w - 2), r.y + randInt(1, r.h - 2)));
  }

  // Enemy spawns: every non-spawn room, count scaled by depth.
  const enemies = [];
  const af = ((floor - 1) % 10) + 1;
  const minibossFloor = af === 3 || af === 6 || af === 9;
  let minibossPlaced = false;
  for (const r of rooms) {
    if (r === spawnRoom) continue;
    const c = roomCenter(r);
    const distFromSpawn = Math.hypot(c.x - spawn.x, c.y - spawn.y);
    let count = Math.min(8, randInt(2, 4) + Math.floor(Math.min(floor, 12) / 2));
    if (r === stairsRoom) count += 2;
    for (let i = 0; i < count; i++) {
      const sp = solidNear(r.x + randInt(1, r.w - 2), r.y + randInt(1, r.h - 2));
      enemies.push({ x: sp.x, y: sp.y, type: pickEnemyType(floor), miniboss: false });
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

  // Every floor: an ELITE guards the stairs. It must die (and 70% of the
  // floor must be culled) before the way down unlocks.
  const sc = roomCenter(stairsRoom);
  enemies.push({ x: sc.x + 1, y: sc.y, type: pickEnemyType(Math.min(10, floor + 1)), elite: true });

  // Environmental variety: scuff/scorch decals, rubble piles, and (floor 2+)
  // treacherous pit holes that drop you to the next floor.
  const scuffs = [];
  const rubble = [];
  const pits = [];
  const floorTiles = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y][x] === FLOOR) floorTiles.push({ x, y });
    }
  }
  shuffle(floorTiles);
  const farFrom = (t, p, d) => !p || Math.hypot(t.x - p.x, t.y - p.y) > d;
  let idx = 0;
  const take = (count, minDist) => {
    const out = [];
    while (out.length < count && idx < floorTiles.length) {
      const t = floorTiles[idx++];
      if (farFrom(t, spawn, minDist) && farFrom(t, stairs, minDist)) out.push(t);
    }
    return out;
  };
  // (scuff/scorch decals removed — the black ovals read as random floor
  //  "shadows" not cast by anything. Floor variety comes from the texture,
  //  room rugs and props instead.)
  rubble.push(...take(8, 3));
  // (pit-fall traps removed — they yanked you to the next floor)

  // Decorative props that HUG the walls: themed clutter so rooms feel lived-in.
  // Only on FLOOR tiles bordering a WALL; kept off spawn/stairs/chests/doors and
  // spaced out so 1-wide corridors never get clogged. The renderer picks the
  // actual themed mesh from `roll`; here we just choose good wall-hugging slots.
  const props = [];
  const isBlockedProp = (x, y) =>
    (spawn && Math.abs(x - spawn.x) + Math.abs(y - spawn.y) < 2) ||
    (stairs && Math.abs(x - stairs.x) + Math.abs(y - stairs.y) < 2) ||
    chests.some((c) => c.x === x && c.y === y) ||
    doors.some((d) => d.x === x && d.y === y);
  const wallDirOf = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (grid[y + dy]?.[x + dx] === WALL) return { dx, dy };
    return null;
  };
  // per-floor density within the act: floor 1 sparser, floor 10 denser
  const propCap = 12 + ((floor - 1) % 10);
  for (const t of floorTiles) {
    if (props.length >= propCap) break;
    if (isBlockedProp(t.x, t.y)) continue;
    if (props.some((p) => Math.abs(p.x - t.x) + Math.abs(p.y - t.y) < 2)) continue;
    const dir = wallDirOf(t.x, t.y);
    if (!dir) continue;
    props.push({ x: t.x, y: t.y, dx: dir.dx, dy: dir.dy, r: Math.random() * Math.PI * 2, roll: Math.random() });
  }

  return { grid, size: GRID, rooms, spawn, stairs, torches, chests, doors, enemies, boss: null,
    scuffs, rubble, pits, props, chasmTiles, bridgeTiles, rubbleWalls };
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
        if (grid[y + dy][x + dx] === FLOOR && Math.random() < 0.16) {
          // keep spacing (denser than before so corridors aren't pitch black)
          if (!torches.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < 4)) {
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
  // Weighted pools shift with depth within act 1, then all types roam.
  const af = floor > 10 ? 10 : floor;
  const pools = [
    { type: 'skeleton', w: 4 },
    { type: 'spider', w: af >= 2 ? 3 : 0 },
    { type: 'imp', w: af >= 3 ? 3 : 0 },
    { type: 'golem', w: af >= 5 ? 2 : 0 },
    { type: 'ghost', w: floor >= 25 ? 3 : 0 }, // wraiths haunt the deeper acts
    { type: 'ghoul', w: floor >= 12 ? 3 : 0 }, // ghouls prowl from act 2 on
    { type: 'witch', w: floor >= 15 ? 2 : 0 },
    { type: 'warlock', w: floor >= 22 ? 2 : 0 },
    { type: 'demon', w: floor >= 30 ? 2 : 0 },
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

// Embervale: the safe hometown hub. No enemies — vendors, a healer's fountain
// feel, and the dungeon portal.
export function generateTown() {
  // Deterministic cosmetic randomness: every player's Embervale is identical,
  // so heroes standing in town see each other in the same place.
  let seed = 0x1234abcd;
  const srand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const n = 28;
  const grid = Array.from({ length: n }, () => new Array(n).fill(VOID));
  // village green with rounded corners
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      const dx = Math.min(x - 2, n - 3 - x);
      const dy = Math.min(y - 2, n - 3 - y);
      if (dx + dy >= 2) grid[y][x] = FLOOR;
    }
  }
  addWalls(grid);

  const spawn = { x: 14, y: 21 };
  const portal = { x: 14, y: 5 };
  const vendors = [
    { type: 'potions', name: 'Maribel the Alchemist', x: 8, y: 11 },
    { type: 'gear', name: 'Torvald the Smith', x: 20, y: 11 },
    { type: 'mystery', name: 'Zoltan the Mysterious', x: 20, y: 17 },
  ];

  // cobbled market square + a lane running spawn -> portal
  const cobbles = [];
  for (let y = 9; y <= 19; y++)
    for (let x = 11; x <= 17; x++) cobbles.push({ x, y });
  for (let y = 5; y <= 21; y++) { cobbles.push({ x: 13, y }, { x: 14, y }, { x: 15, y }); }

  // tavern "The Sleeping Golem": 5x4 footprint, west side; tiles solid
  const tavern = { x: 4, y: 15, w: 5, h: 4 };
  for (let y = tavern.y; y < tavern.y + tavern.h; y++)
    for (let x = tavern.x; x < tavern.x + tavern.w; x++)
      grid[y][x] = WALL;

  // trees ring the green (solid), never on cobbles or near features
  const trees = [];
  const treeSpots = [
    [4, 4], [7, 3], [11, 3], [18, 3], [22, 4], [24, 7], [24, 12], [24, 20],
    [21, 23], [16, 24], [10, 24], [6, 23], [3, 19], [3, 10], [3, 7], [18, 21],
  ];
  for (const [x, y] of treeSpots) {
    if (grid[y]?.[x] === FLOOR) {
      grid[y][x] = WALL;
      trees.push({ x, y, s: 0.8 + srand() * 0.5, kind: srand() < 0.3 ? 'pine' : 'oak' });
    }
  }

  // bushes + flowerbeds (walk-through decor)
  const plants = [];
  const plantSpots = [
    [6, 8], [9, 6], [17, 6], [21, 8], [22, 15], [19, 20], [11, 21], [7, 19],
    [5, 12], [16, 8], [12, 7], [23, 10], [9, 17], [17, 19],
  ];
  for (const [x, y] of plantSpots) {
    if (grid[y]?.[x] === FLOOR) {
      plants.push({ x, y, kind: srand() < 0.5 ? 'bush' : 'flowers' });
    }
  }

  const well = { x: 10, y: 14 };
  // solid props: you can't walk through the well, the stalls, or their keepers
  grid[well.y][well.x] = WALL;
  for (const v of vendors) grid[v.y][v.x] = WALL;

  // extra decor: notice board, crates/sacks, cart, hedges (kept off cobbles/lane/vendor/tavern/well tiles)
  const noticeBoard = { x: 9, y: 9 };
  if (grid[noticeBoard.y]?.[noticeBoard.x] === FLOOR) grid[noticeBoard.y][noticeBoard.x] = WALL;

  const crates = [];
  const crateSpots = [[7, 10], [21, 9], [22, 17], [22, 19], [9, 20]];
  // small clutter (crates, sacks, cart) stays walkable — brushing past a sack
  // shouldn't stop a hero; only substantial objects block movement
  for (const [x, y] of crateSpots) {
    if (grid[y]?.[x] === FLOOR) {
      crates.push({ x, y, kind: srand() < 0.5 ? 'crate' : 'sack', r: srand() * Math.PI * 2 });
    }
  }

  const cartSpots = [[9, 18], [22, 21]];
  let cart = null;
  for (const [x, y] of cartSpots) {
    if (grid[y]?.[x] === FLOOR) { cart = { x, y, r: srand() * Math.PI * 2 }; break; }
  }

  const hedges = [];
  const hedgeSpots = [
    [6, 6], [7, 6], [8, 6], [20, 6], [21, 6], [22, 6],
    [6, 21], [7, 21], [8, 21], [19, 22], [20, 22], [21, 22],
  ];
  for (const [x, y] of hedgeSpots) {
    if (grid[y]?.[x] === FLOOR) hedges.push({ x, y }); // shrubs: walk-through
  }

  const extraFlowerSpots = [[21, 11], [21, 13], [6, 9], [24, 16]];
  for (const [x, y] of extraFlowerSpots) {
    if (grid[y]?.[x] === FLOOR) plants.push({ x, y, kind: 'flowers' });
  }

  // lamp posts light the lane and square (reuse the torch light pool)
  const torches = [
    { x: 13, y: 8, fx: 12.6, fy: 8 }, { x: 15, y: 8, fx: 15.4, fy: 8 },
    { x: 13, y: 13, fx: 12.6, fy: 13 }, { x: 15, y: 13, fx: 15.4, fy: 13 },
    { x: 13, y: 18, fx: 12.6, fy: 18 }, { x: 15, y: 18, fx: 15.4, fy: 18 },
    { x: 8, y: 12, fx: 8, fy: 12.4 }, { x: 20, y: 12, fx: 20, fy: 12.4 },
  ];

  return {
    grid, size: n, rooms: [], spawn, stairs: null,
    torches, chests: [], doors: [], enemies: [],
    boss: null, town: true, portal, vendors,
    cobbles, tavern, trees, plants, well,
    noticeBoard, crates, cart, hedges,
  };
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
