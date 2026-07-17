import * as THREE from 'three';
import { FLOOR, WALL } from './dungeon.js';
import { TILE, tileToWorld, buildNpcModel } from './meshbuilder.js';
import { makeWoodTexture, makePlankTexture, makeHearthStoneTexture, makeTavernSignTexture } from './textures.js';
import { audio } from '../core/audio.js';

// ---- shared "where's the nearest player" lookup for the tavern's own NPC
// drivers (Magda's amble, patrons' body-turn) — mirrors meshbuilder.js's
// internal nearestHeroTarget (same headAnchor/townNpc marker convention) but
// lives here since tavern.js owns its own smokePuffs driver entries and
// can't reach into meshbuilder's private cache. Re-scanned at most 2x/sec.
const _heroCache = { root: null, heroes: [], nextScanAt: 0 };
const _hcWp = new THREE.Vector3(), _hcWp2 = new THREE.Vector3();
function findHeroes(anyMesh) {
  let root = anyMesh;
  while (root.parent) root = root.parent;
  const now = performance.now();
  if (root !== _heroCache.root || now >= _heroCache.nextScanAt || _heroCache.heroes.some((h) => !h.parent)) {
    _heroCache.root = root;
    _heroCache.nextScanAt = now + 500;
    _heroCache.heroes = [];
    root.traverse((o) => { if (o.userData.headAnchor && !o.userData.townNpc) _heroCache.heroes.push(o); });
  }
  return _heroCache.heroes;
}
function nearestHero(mesh, range = 6) {
  const heroes = findHeroes(mesh);
  if (!heroes.length) return null;
  mesh.getWorldPosition(_hcWp);
  let best = null, bestD = range;
  for (const h of heroes) {
    h.getWorldPosition(_hcWp2);
    const d = Math.hypot(_hcWp2.x - _hcWp.x, _hcWp2.z - _hcWp.z);
    if (d < bestD) { bestD = d; best = { x: _hcWp2.x, z: _hcWp2.z, d }; }
  }
  return best;
}
function wrapAngle(a) { return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; }

// "The Sleeping Golem" — the tavern interior. Warm, safe, and populated.
// 16 x 12 tiles (enlarged from 12x9 - the owner found the room cramped and
// the two walled-in tables senseless). Furniture occupies solid (WALL) tiles so you can't walk
// through the bar; patrons and the barkeep can be chatted with.
const W = 16, H = 12;

// solid furniture tiles (collision): bar row, two tables, the hearth.
// Bar row moved y1 -> y2 (Obsidian 720): against the wall row the service
// aisle between counter and back-bar shelves was ~0.36 units - nobody fits;
// one row south gives Magda a real ~2.3-unit aisle to work and walk.
// Aligned to the counter MESH footprint (898): the counter spans world x 8-22
// (barX 15 ± barW/2 = 7*TILE/2), i.e. tiles x=4..10. The old list included tile
// x=3 (world 6-8), which had NO counter over it - an INVISIBLE WALL on the left
// exactly where the user tried to walk around to the back. Dropping it (and
// widening the mesh to 7*TILE) makes collision match what's drawn.
const BAR_TILES = [[4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2]];
// x=8 sits directly on the spawn(8,9)->exit(8,10)->bar walking lane, so the
// two right-side tables are mirrored to x=12 (16-wide room, center 7.5) —
// clear of the entrance lane, symmetric with the x=3 tables on the other side.
const TABLE_TILES = [[3, 4], [12, 4], [3, 8], [12, 8]];
const HEARTH_TILES = [[14, 6]];
// The fireside settle sits on this tile (built at hw.x-3.6 = tile 12, row 6);
// mark it solid so the player can't walk THROUGH the couch (Obsidian 797). The
// sit interaction still works - the player approaches from the fire side (tile
// 13) and the sit action teleports them onto the seat.
const COUCH_TILES = [[12, 6]];
// Cellar stairwell hole (Obsidian 971): east of the bar, roughly centred
// between the duckboard platform Magda works (row y=1, x4-10) and the
// east-side window (world x=31, z~3.2/6.8) - clear of the bar, tables,
// hearth, couch and the up-stairs (SE corner, tiles x=14 y7-9). Blocked so
// the hero can't walk INTO the shaft; the real hole + flight is built in
// buildTavernInterior below.
const CELLAR_HOLE = { x: 13, y: 3 };

export function generateTavernInterior() {
  const grid = Array.from({ length: H }, (_, y) =>
    new Array(W).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? WALL : FLOOR));
  for (const [x, y] of [...BAR_TILES, ...TABLE_TILES, ...HEARTH_TILES, ...COUCH_TILES]) grid[y][x] = WALL;
  // Staircase footprint (Obsidian 800): the flight occupies tiles (14,7..9);
  // block them so the hero can't walk through the steps, leaving (14,10) as the
  // approach/interact tile at the base.
  for (const [x, y] of [[14, 7], [14, 8], [14, 9]]) grid[y][x] = WALL;
  grid[CELLAR_HOLE.y][CELLAR_HOLE.x] = WALL;
  // Per-tile floor HEIGHTS (898): the back-bar duckboard is a real 0.24-tall
  // platform, but the tavern never returned a heights grid so game.heightAt()
  // fell back to 0 everywhere and the hero CLIPPED THROUGH it. Row y=1 (the
  // service aisle behind the counter, where the duckboard mesh sits, world x
  // 7.2-22.8 = tiles 3..11) is raised so the player eases UP onto it - the same
  // step-up mechanism dungeons/town use, matching Magda's own 0.24 stand height.
  // 942/952: the raised tiles must match the VISIBLE duckboard footprint - the
  // board mesh spans world x 7.2..22.8 (measured). 942 trimmed the EAST end
  // (dropped tile 11, x 22..24). 952: the WEST end had the same fault mirrored -
  // tile 3 (x 6..8) was raised but the board only starts at x 7.2, so the strip
  // world x 6..7.2 was a raised cell with NO board beneath it: the "invisible
  // ramp on the left" the player hit stepping onto the platform. Raise only
  // tiles 4..10 (world x 8..22) so both ends sit under real board.
  const heights = Array.from({ length: H }, () => new Array(W).fill(0));
  for (let x = 4; x <= 10; x++) heights[1][x] = 0.24;
  return {
    grid, heights, size: Math.max(W, H), rooms: [],
    spawn: { x: 8, y: 9 },
    stairsUp: { x: 14, y: 10 }, // interact tile at the stair base -> upstairs (800)
    // TODO 703: collision here is tile-granularity (isWalkable() in game.js
    // checks dungeon.grid, not the wall mesh), and this exit tile is the
    // ONLY floor cell in the south border row — narrowing the visual gap in
    // the wall mesh above (DOOR_GAP_W) doesn't change this single-tile
    // walk-to-and-interact point, so there's no separate grid width to widen
    // or narrow to match it.
    exit: { x: 8, y: 10 },
    barkeep: { x: 6, y: 1 },     // the service aisle between back-bar and counter (720)
    patrons: [
      { x: 3, y: 4, seatAngle: 0.8, drunk: false },
      { x: 8, y: 4, seatAngle: -2.2, drunk: true },
    ],
    stairs: null, torches: [], chests: [], doors: [], enemies: [],
    boss: null, town: true, tavernInterior: true, pits: [],
  };
}

export function buildTavernInterior() {
  const group = new THREE.Group();
  const woodTex = makeWoodTexture();
  const floorTex = makePlankTexture('#6a4a2c');
  floorTex.repeat.set(6, 4);
  const boardTex = makePlankTexture('#7a5636'); // lighter boards for bar + wainscot
  boardTex.repeat.set(3, 1);
  const stoneTex = makeHearthStoneTexture();
  const plankMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 });
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.85 });
  const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.95 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.6, roughness: 0.55 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.85 });
  const smokePuffs = [];

  // floor planks (real plank texture: fitted boards, not the vertical staves),
  // built as four bands around the cellar stairwell hole (971) instead of one
  // solid slab - the same "cut a real hole" technique buildTavernUpstairsInterior
  // uses for its own down-stairwell, so the flight below is genuinely visible
  // through an opening rather than implied. Each band gets its OWN cloned
  // texture with the repeat scaled to its size so the plank density matches
  // the original single-slab look (no seam where tiling frequency jumps).
  const cellarHw = tileToWorld(CELLAR_HOLE.x, CELLAR_HOLE.y);
  const CHX0 = cellarHw.x - TILE / 2, CHX1 = cellarHw.x + TILE / 2;
  const CHZ0 = cellarHw.z - TILE / 2, CHZ1 = cellarHw.z + TILE / 2;
  const floorDensX = 6 / (W * TILE), floorDensZ = 4 / (H * TILE);
  const addFloorSlab = (cx, cz, w, d) => {
    if (w <= 0 || d <= 0) return;
    const t = floorTex.clone(); t.needsUpdate = true; t.repeat.set(floorDensX * w, floorDensZ * d);
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), m);
    s.position.set(cx, -0.1, cz); s.receiveShadow = true; group.add(s);
  };
  addFloorSlab((W * TILE) / 2, CHZ0 / 2, W * TILE, CHZ0);                                 // north of hole
  addFloorSlab((W * TILE) / 2, (CHZ1 + H * TILE) / 2, W * TILE, H * TILE - CHZ1);         // south of hole
  addFloorSlab(CHX0 / 2, (CHZ0 + CHZ1) / 2, CHX0, CHZ1 - CHZ0);                           // west band
  addFloorSlab((CHX1 + W * TILE) / 2, (CHZ0 + CHZ1) / 2, W * TILE - CHX1, CHZ1 - CHZ0);   // east band

  // perimeter walls with a south door gap. Plaster above, a dark wooden wainscot
  // rail below so the room reads as timber-and-plaster, not bare stucco.
  // +0.7 from the original 2.6: the back-bar shelves (see shelfYs below) were
  // raised by the same amount to clear Magda's head, so the wall is raised
  // to match and keep the same clearance the shelves/trophy always had
  // against its top edge.
  const wallH = 3.3;
  const wainH = 1.0;
  // Window opening dims for cut-through walls (Obsidian 824-followup): a real
  // hole in the wall at each window centre so the recessed 3D view behind it is
  // visible. Collision is grid-based (isWalkable reads dungeon.grid, not this
  // mesh), so cutting the mesh never lets the hero walk out. `wins` = the along-
  // wall centre coordinates of the windows in this segment (empty = solid wall).
  const WIN_HW = 0.66, WIN_YB = 1.16, WIN_YT = 2.24;
  const mkWall = (w, d, x, z, horizontal, wins = null) => {
    if (!wins || !wins.length) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), plasterMat);
      m.position.set(x, wallH / 2, z);
      group.add(m);
    } else {
      // Frame of boxes around each hole: full-height pillars in the gaps between
      // windows, plus a sill strip below and a header strip above each opening.
      const longLen = horizontal ? w : d, thick = horizontal ? d : w;
      const longCtr = horizontal ? x : z, start = longCtr - longLen / 2, end = longCtr + longLen / 2;
      const addSeg = (a, b, yb, yh) => {
        if (b - a < 0.02 || yh < 0.02) return;
        const geo = horizontal ? new THREE.BoxGeometry(b - a, yh, thick) : new THREE.BoxGeometry(thick, yh, b - a);
        const m = new THREE.Mesh(geo, plasterMat);
        if (horizontal) m.position.set((a + b) / 2, yb + yh / 2, z); else m.position.set(x, yb + yh / 2, (a + b) / 2);
        m.castShadow = m.receiveShadow = true; group.add(m);
      };
      const holes = wins.map((c) => [c - WIN_HW, c + WIN_HW]).sort((p, q) => p[0] - q[0]);
      let cursor = start;
      for (const [ha, hb] of holes) {
        addSeg(cursor, ha, 0, wallH);           // pillar up to the opening
        addSeg(ha, hb, 0, WIN_YB);              // sill below the opening
        addSeg(ha, hb, WIN_YT, wallH - WIN_YT); // header above the opening
        cursor = hb;
      }
      addSeg(cursor, end, 0, wallH);            // final pillar
    }
    // wainscot: a thin waist-high board panel on the inner face of the wall
    const wt = boardTex.clone(); wt.needsUpdate = true;
    wt.repeat.set((horizontal ? w : d) / TILE, 1);
    const wainMat = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.85 });
    const panelT = 0.08; // panel thickness (along the wall's short axis)
    // Clearance off the wall's inner face: without this the panel's outer
    // face and the wall's inner face land on the exact same plane, which
    // z-fights (shimmers/moires when the camera zooms in) wherever a
    // wainscot backs onto the wall — most visibly behind the bar. A few cm
    // of real standoff (not a coplanar polygon-offset trick) fixes it for
    // good at any zoom/angle.
    const WALL_GAP = 0.03;
    // Corner inset (Obsidian 751): full-length wainscot runs ended exactly
    // ON the wall's own end planes and CROSSED the perpendicular wall's
    // wainscot at room corners - both coplanar/overlap cases z-fought as a
    // glitchy shimmer right at the corner tips (worst by the door gap).
    // Every run now stops 1.05 short of each end, clear of any corner.
    const wainLen = (horizontal ? w : d) - 2.1;
    if (wainLen < 0.5) return;
    const wain = new THREE.Mesh(
      new THREE.BoxGeometry(horizontal ? wainLen : panelT, wainH, horizontal ? panelT : wainLen), wainMat);
    // seat the panel just proud of the wall's inner face, toward room center
    const dir = horizontal ? Math.sign((H * TILE) / 2 - z) : Math.sign((W * TILE) / 2 - x);
    // Standoff uses the wall's THICKNESS along its short axis (d for
    // horizontal walls, w for vertical ones). The old code used d/2 for BOTH,
    // which for the 24-long west/east walls shoved their wainscot panels 12
    // units into the room - the two full-length "planks splitting the bar
    // left from right" the user kept reporting (TODO 693).
    if (horizontal) wain.position.set(x, wainH / 2, z + dir * (d / 2 - panelT / 2 + WALL_GAP));
    else wain.position.set(x + dir * (w / 2 - panelT / 2 + WALL_GAP), wainH / 2, z);
    group.add(wain);
  };
  mkWall(W * TILE, TILE, (W * TILE) / 2, TILE / 2, true);              // north (no windows)
  mkWall(TILE, H * TILE, TILE / 2, (H * TILE) / 2, false, [2.2 * TILE, 5.4 * TILE]);           // west: 2 windows
  mkWall(TILE, H * TILE, W * TILE - TILE / 2, (H * TILE) / 2, false, [1.6 * TILE, 3.4 * TILE]); // east: 2 windows
  // South wall, split around the exit gap. DOOR_GAP_W/gapCenterX are declared
  // here (rather than down by the rest of the door dressing) so both this
  // split and the jamb/leaf/threshold-glow below share one definition. Was a
  // flat 4-unit gap (garage-door wide, TODO 703) — narrowed to real door
  // width; each segment's OUTER edge (against the west/east walls, at x=1
  // and x=W*TILE-1) stays fixed, only the inner edge moves to close in on
  // the narrower gap.
  const DOOR_GAP_W = 2.2, gapCenterX = 8 * TILE + TILE / 2; // matches exit tile (8, 10)
  const westSegR = gapCenterX - DOOR_GAP_W / 2, eastSegL = gapCenterX + DOOR_GAP_W / 2;
  mkWall(westSegR - 1, TILE, (1 + westSegR) / 2, H * TILE - TILE / 2, true, [6.5 * TILE]);  // south-west: 1 window
  mkWall((W * TILE - 1) - eastSegL, TILE, (eastSegL + W * TILE - 1) / 2, H * TILE - TILE / 2, true, [10 * TILE]); // south-east: 1 window
  // Ceiling beams REMOVED (user report): at gameplay camera angles the
  // y=2.55 rafters sliced across the view and read as mid-room walls that
  // blocked sight of the table areas.

  // Window openings you can SEE OUTSIDE through (Obsidian 721, replacing the
  // opaque amber panes): the tavern interior is its own scene - there is no
  // real town geometry beyond these walls to cut a hole to - so each larger
  // opening holds a small painted daylight diorama (sky, meadow, tree line)
  // recessed behind the frame. Self-lit (MeshBasic) so it reads as bright
  // outdoors against the firelit room; each window's view is seeded so
  // neighbouring windows don't show the identical postcard. Layout still
  // matches the exterior facade's fenestration (2 flanking the front door,
  // 2 per long side).
  const makeWindowViewTexture = (seed) => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 96);
    sky.addColorStop(0, '#8fb2dd'); sky.addColorStop(1, '#cfdcea');
    g.fillStyle = sky; g.fillRect(0, 0, 128, 96);
    g.fillStyle = '#5d8a48'; g.fillRect(0, 88, 128, 40); // meadow
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    for (let i = 0; i < 3; i++) { // distant tree line
      const tx = 10 + rnd() * 108, th = 18 + rnd() * 16, tw = 14 + rnd() * 10;
      g.fillStyle = '#3a5c30';
      g.beginPath(); g.ellipse(tx, 88 - th * 0.5, tw * 0.5, th * 0.5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4a3826'; g.fillRect(tx - 1.5, 88 - th * 0.25, 3, th * 0.3);
    }
    g.fillStyle = 'rgba(255,255,255,0.65)'; // a soft cloud
    g.beginPath(); g.ellipse(30 + rnd() * 70, 22 + rnd() * 18, 16, 6, 0, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const mkWindow = (x, z, roty) => {
    const grp = new THREE.Group();
    // Genuinely see-through (Obsidian 852): the walls are CUT at each window
    // (mkWall `wins`) and the REAL town is built around the interior (see
    // loadTavern's _tavernOutside), so the opening needs NO diorama any more -
    // just the frame + muntins, and you look straight out at actual Embervale
    // (the same houses/lamps/trees you walk between outside).
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.09, 0.14), darkWood); top.position.set(0, 0.6, 0.06);
    const bot = top.clone(); bot.position.set(0, -0.6, 0.06);
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.3, 0.14), darkWood); l.position.set(-0.69, 0, 0.06);
    const r = l.clone(); r.position.x = 0.69;
    grp.add(top, bot, l, r);
    const mV = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.1, 0.045), darkWood); mV.position.z = 0.08;
    const mH = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.045, 0.045), darkWood); mH.position.z = 0.08;
    grp.add(mV, mH);
    grp.position.set(x, 1.7, z); grp.rotation.y = roty;
    group.add(grp);
  };
  // west wall (2, spaced away from the lantern at 3.5*TILE)
  mkWindow(TILE + 0.04, 2.2 * TILE, Math.PI / 2);
  mkWindow(TILE + 0.04, 5.4 * TILE, Math.PI / 2);
  // east wall (2, spaced away from the lantern at 5.0*TILE and the hearth)
  mkWindow(W * TILE - TILE - 0.04, 1.6 * TILE, -Math.PI / 2);
  mkWindow(W * TILE - TILE - 0.04, 3.4 * TILE, -Math.PI / 2);
  // entry wall (2, flanking the south exit gap — same wall the exterior door sits on)
  mkWindow(6.5 * TILE, (H * TILE - TILE) - 0.04, Math.PI);
  mkWindow(10 * TILE, (H * TILE - TILE) - 0.04, Math.PI);

  // 940: OCCLUDING SOFFIT. The real town is built AROUND the interior (see
  // loadTavern's _tavernOutside) so windows peek at genuine 3D outside - but
  // zooming the top-down camera out let you see the whole town OVER the 3.3-high
  // walls, breaking the "you're indoors" feel. Cap the EXTERIOR (everything
  // outside the room footprint) with a flat opaque roof flush at wall height:
  // sightlines that clear the wall-top now hit this dark plane instead of the
  // town, while window sightlines (below WIN_YT=2.24, well under the soffit)
  // still pass under it to the real outside. Coloured like the tavern's own
  // background/fog (0x1a1109) and unlit so it just reads as dark void past the
  // walls - the sealed-box look the player asked to get back.
  {
    const EXT = 70;                       // reach far past anything the camera can see
    const roofMat = new THREE.MeshBasicMaterial({ color: 0x1a1109, side: THREE.DoubleSide, fog: true });
    // 974: the soffit used to be a THIN horizontal cap flush at wall height. A
    // flat plane can't hide a TALL object that pokes up THROUGH it - trees just
    // outside the wall rose above wallH and their crowns showed over/through the
    // "black" (user: "trees clipping through the black" by the exit). Make each
    // exterior panel a TALL solid box rising from the wall top far into the sky,
    // so the whole volume above the walls (outside the room) is sealed black and
    // no exterior geometry above wallH can ever be seen. Windows sit BELOW wallH,
    // so their outward sightlines still pass under the box to the real town.
    const TALL = 80;
    const roofY = wallH - 0.1;             // bottom overlaps the wall top slightly (no seam)
    const boxCY = roofY + TALL / 2;        // centre so the bottom sits at ~wallH
    const rw = W * TILE, rh = H * TILE;    // interior footprint (32 x 24)
    const strip = (w, d, cx, cz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, TALL, d), roofMat);
      m.position.set(cx, boxCY, cz); m.name = 'TavernSoffit'; group.add(m);
    };
    strip(rw + 2 * EXT, EXT, rw / 2, -EXT / 2);            // north of the room
    strip(rw + 2 * EXT, EXT, rw / 2, rh + EXT / 2);        // south of the room
    strip(EXT, rh, -EXT / 2, rh / 2);                      // west of the room
    strip(EXT, rh, rw + EXT / 2, rh / 2);                  // east of the room
  }

  // ---- exit door: a real timber frame + a leaf propped open against the
  // inner wall at the south gap (matches the exterior KayKit arch style),
  // so "stepping outside" reads as leaving through an actual doorway rather
  // than walking through a bare hole in the wall (user report: "the door to
  // leave doesn't even make sense"). The gap itself (its walkable width) is
  // untouched — this only dresses its edges.
  const gapWidth = DOOR_GAP_W; // matches exit tile (8, 10) — see DOOR_GAP_W above
  const gapZ = H * TILE - TILE / 2;
  // Coplanarity rule (Obsidian 739): every frame piece keeps its top a
  // visible margin BELOW the wall top - the old jambs/header ended exactly
  // AT wallH, coplanar with the wall's own top face, which z-fought as a
  // stuttering line from the overhead leaving angle.
  const jambH = wallH - 0.06;
  const jambGeo = new THREE.BoxGeometry(0.16, jambH, 0.3);
  const jambL = new THREE.Mesh(jambGeo, darkWood); jambL.position.set(gapCenterX - gapWidth / 2, jambH / 2, gapZ);
  const jambR = jambL.clone(); jambR.position.x = gapCenterX + gapWidth / 2;
  const header = new THREE.Mesh(new THREE.BoxGeometry(gapWidth + 0.32, 0.2, 0.3), darkWood);
  header.position.set(gapCenterX, wallH - 0.24, gapZ);
  group.add(jambL, jambR, header);
  // CLOSED door leaf filling the gap at the wall's outer side (739: the old
  // folded-open leaf left the doorway showing raw void from above - the
  // "transparent door"). It sits ~2 units beyond the exit tile the player
  // stands on, so nothing ever clips it, and the leave-interaction plays its
  // door_open sound as before - the door just reads shut until you use it.
  const leafH = wallH - 0.35;
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(gapWidth - 0.06, leafH, 0.1), darkWood);
  leaf.position.set(gapCenterX, leafH / 2, gapZ + 0.8);
  // plank lines: two vertical grooves so it reads as boards, not a slab
  for (const gx of [-gapWidth / 6, gapWidth / 6]) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.03, leafH - 0.1, 0.11),
      new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 1 }));
    groove.position.set(gapCenterX + gx, leafH / 2, gapZ + 0.8);
    group.add(groove);
  }
  const leafHandle = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.35 }));
  leafHandle.position.set(gapCenterX + gapWidth / 2 - 0.3, 1.1, gapZ + 0.72);
  group.add(leaf, leafHandle);

  // ---- amber threshold glow just outside the gap: from inside, the exit
  // was a plain dark opening with nothing lit beyond it — a black hole (user
  // report). A soft amber floor-glow + a warm point light sit just past the
  // wall's outer face so stepping toward the door reads as leaving into
  // lamplit night air, not a void. Purely visual - the walkable gap itself
  // (its collision width) is untouched.
  const outerZ = H * TILE - TILE / 2 + TILE / 2 + 0.35; // just past the wall's outer face
  const thresholdGlow = new THREE.Mesh(new THREE.PlaneGeometry(gapWidth + 1.6, 2.4),
    new THREE.MeshBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0.32, side: THREE.DoubleSide }));
  thresholdGlow.rotation.x = -Math.PI / 2;
  thresholdGlow.position.set(gapCenterX, 0.03, outerZ);
  group.add(thresholdGlow);
  const thresholdLight = new THREE.PointLight(0xffb060, 15, 8, 2);
  thresholdLight.position.set(gapCenterX, 1.6, outerZ);
  group.add(thresholdLight);

  // ---- the bar (on BAR_TILES row) ----
  // Customer side is +z (the aisle in front of the counter); the barkeep works
  // the -z side against the back-bar. The base is RECESSED toward the wall and
  // the counter top OVERHANGS the customer side, leaving a footwell so a patron
  // on a bar stool can tuck their feet/knees under the bar (Obsidian 788). A
  // brass footrail runs along the kick for the same read.
  const barCenter = tileToWorld(6.5, 2);
  const barX = barCenter.x + TILE / 2;
  const barZ = barCenter.z;
  const barW = 7 * TILE; // widened 6->7 tiles so the mesh covers the full BAR_TILES collision footprint (898)
  // recessed base: shifted 0.18 toward the wall, shallower depth 0.9 -> its
  // customer face sits back at barZ+0.27, well inside the counter's front edge.
  const bar = new THREE.Mesh(new THREE.BoxGeometry(barW, 1.05, 0.9), boardMat);
  bar.position.set(barX, 0.52, barZ - 0.18);
  group.add(bar);
  // counter top: extended depth 1.55, nudged 0.12 toward the room so its front
  // edge overhangs to ~barZ+0.66 — the overhang the footwell lives under.
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(barW + 0.2, 0.09, 1.55), plankMat);
  barTop.position.set(barX, 1.09, barZ + 0.12);
  group.add(barTop);
  const barFrontEdge = barZ + 0.12 + 1.55 / 2; // ~barZ+0.9, room-facing lip of the counter
  // brass footrail along the kick, a little in front of the recessed base
  const railMat = new THREE.MeshStandardMaterial({ color: 0xb8912e, metalness: 0.7, roughness: 0.35 });
  const footRail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, barW - 0.2, 8), railMat);
  footRail.rotation.z = Math.PI / 2;
  footRail.position.set(barX, 0.16, barZ + 0.34);
  group.add(footRail);
  for (const rx of [barX - barW / 2 + 0.3, barX, barX + barW / 2 - 0.3]) {
    const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 6), railMat);
    bracket.position.set(rx, 0.08, barZ + 0.34);
    group.add(bracket);
  }
  // taps + mugs on the bar
  for (let i = 0; i < 3; i++) {
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.5, roughness: 0.5 }));
    mug.position.set(barX - 3 + i * 3, 1.2, barZ - 0.05);
    group.add(mug);
  }
  // ---- bar stools along the counter (Obsidian 788): tall stools with a seat
  // pad + a footring, set just in front of the overhang so a seated patron's
  // feet reach into the footwell. Their world slots are collected for the
  // seat-picking AI below so patrons can actually choose to sit here. ----
  const barStoolSlots = [];
  // Seat centre set well PAST the counter's front lip (Obsidian 804, re-fix):
  // a seated body is a capsule ~0.26 in radius, so at +0.12 its FRONT half
  // (~barFrontEdge-0.14) still tucked under the overhang and the counter slab
  // clipped through the torso. Pushed to +0.4 so the whole body clears the lip;
  // arms still reach the counter and the footrail keeps the bar read.
  const stoolZ = barFrontEdge + 0.4;
  const nStools = 5;
  for (let i = 0; i < nStools; i++) {
    const sx = barX + (i - (nStools - 1) / 2) * 1.7;
    const stoolGrp = new THREE.Group();
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.62, 8), darkWood);
    legs.position.y = 0.31;
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 10), plankMat);
    seat.position.y = 0.64;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 6, 12), railMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.2;
    stoolGrp.add(legs, seat, ring);
    stoolGrp.position.set(sx, 0, stoolZ);
    group.add(stoolGrp);
    // a seated patron faces -z (toward the counter); feet fall into the footwell
    barStoolSlots.push({ x: sx, z: stoolZ, yaw: Math.PI, seat: 'bar', seatY: 0.64 });
  }

  // ---- Magda the barkeep: a warm, ruddy innkeeper, built to READ from the
  // overhead camera — she faces the customer (+z) and her head tips up so the
  // face catches the top-down view (the old one faced the wall). ----
  const keeper = new THREE.Group();
  const shirtMat = new THREE.MeshStandardMaterial({ color: 0x9a5a38, roughness: 0.85 });
  const ruddyMat = new THREE.MeshStandardMaterial({ color: 0xe6a476, roughness: 0.78 }); // warm skin
  const hairMat = new THREE.MeshStandardMaterial({ color: 0xa89c8e, roughness: 1 });      // greying
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.95 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x171009 });
  // barrel-chested body + white shirt + belly + apron
  const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.44, 5, 10), shirtMat);
  kBody.position.y = 0.74; kBody.scale.set(1, 1, 0.92);
  const kBelly = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), shirtMat);
  kBelly.position.set(0, 0.7, 0.16); kBelly.scale.set(1, 0.88, 0.7);
  const kApron = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.66, 0.12), whiteMat);
  kApron.position.set(0, 0.64, 0.32);
  const kApronBib = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.1), whiteMat);
  kApronBib.position.set(0, 1.0, 0.34);
  // head on a pivot tilted slightly back so the face aims up at the camera
  const head = new THREE.Group();
  head.position.y = 1.4; head.rotation.x = -0.22;
  const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 14), ruddyMat);
  kHead.scale.set(1, 0.98, 1);
  // bald pate ringed by a horseshoe of hair (so the top isn't a blank dome)
  const kHair = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.09, 8, 18), hairMat);
  kHair.rotation.x = Math.PI / 2; kHair.position.set(0, 0.04, -0.03);
  // bushy brows
  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.055, 0.07), hairMat);
  browL.position.set(-0.11, 0.09, 0.24); browL.rotation.z = 0.18;
  const browR = browL.clone(); browR.position.x = 0.11; browR.rotation.z = -0.18;
  // eyes (white + dark pupil) — big enough to read from above
  const eyeWL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), whiteMat); eyeWL.position.set(-0.11, 0.02, 0.23);
  const eyeWR = eyeWL.clone(); eyeWR.position.x = 0.11;
  const pupL = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), eyeMat); pupL.position.set(-0.11, 0.02, 0.28);
  const pupR = pupL.clone(); pupR.position.x = 0.11;
  // bulbous ruddy nose + rosy cheeks
  const kNose = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 10), new THREE.MeshStandardMaterial({ color: 0xcf7150, roughness: 0.8 }));
  kNose.position.set(0, -0.05, 0.29);
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0xd97e5e, roughness: 0.85 });
  const cheekL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), cheekMat); cheekL.position.set(-0.17, -0.07, 0.19); cheekL.scale.set(1, 0.8, 0.7);
  const cheekR = cheekL.clone(); cheekR.position.x = 0.17;
  // big handlebar mustache + full beard
  const mustache = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.075, 0.09, 3, 1, 1), hairMat);
  mustache.position.set(0, -0.11, 0.25);
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), hairMat);
  beard.position.set(0, -0.14, 0.1); beard.scale.set(1, 1.35, 0.95);
  head.add(kHead, kHair, browL, browR, eyeWL, eyeWR, pupL, pupR, kNose, cheekL, cheekR, mustache, beard);
  // arms: one resting on the bar, one holding a mug he's polishing
  const kArmL = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.38, 4, 8), shirtMat);
  kArmL.position.set(-0.44, 0.9, 0.2); kArmL.rotation.set(0.55, 0, 0.6);
  const kArmR = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.38, 4, 8), shirtMat);
  kArmR.position.set(0.46, 0.92, 0.22); kArmR.rotation.set(0.7, 0, -0.5);
  const heldMug = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: 0xdcb24e, metalness: 0.55, roughness: 0.45 }));
  heldMug.position.set(0.6, 1.08, 0.36);
  keeper.add(kBody, kBelly, kApron, kApronBib, head, kArmL, kArmR, heldMug);
  // Mid-aisle (Obsidian 720): the keeper works the ~2.3-unit lane between
  // the back-bar shelves (z~2.04) and the counter's back face (z~4.4).
  const keeperPos = tileToWorld(6.5, 1.05);
  // Duckboard platform behind the bar: lifts Magda 0.24 so her head and
  // shoulders clear the 1.1-high bar top from the game's overhead camera
  // (user report: "can't even see the bartender... shorter than the counter").
  // Runs the SAME length as the back-bar shelves (720: it used to be 9 wide
  // under 16-wide shelves - the "plank of wood shorter than the shelves"
  // report) and fills the widened aisle without touching wall or counter.
  const duckboard = new THREE.Mesh(new THREE.BoxGeometry(8 * TILE - 0.4, 0.24, 1.5), darkWood);
  duckboard.position.set(keeperPos.x + TILE / 2, 0.12, keeperPos.z);
  group.add(duckboard);
  keeper.position.set(keeperPos.x + TILE / 2, 0.24, keeperPos.z);
  keeper.rotation.y = 0; // face the customer side (+z), not the back wall
  group.add(keeper);
  // Interaction gate (Obsidian 735): tavern NPCs face/eye-track the player
  // ONLY while a conversation with them is active. game.js stamps these
  // timestamps (performance.now()-based) from barkeepChat/patronChat.
  const talkGate = { magdaUntil: 0 };

  // --- Modeled human Magda (preferred) ---
  // Replace the box barkeep's visuals with the KayKit unhooded-Rogue "villager"
  // body (Magda's voice is female, af_kore) - kept distinct from Torvald and the
  // Tipsy Regular, who use other townsfolk-only bodies. The `keeper` Group stays the transform
  // anchor (position + the +z facing), so only the look changes. If the GLB
  // isn't loaded, buildNpcModel returns null and the box barkeep above stays
  // visible as the fallback. She keeps her held mug in hand.
  const barlow = buildNpcModel('mage', 'Magda', { gender: 'female', skinTone: 'tan' });
  if (barlow) {
    for (let i = keeper.children.length - 1; i >= 0; i--) {
      const c = keeper.children[i];
      if (c === heldMug) {
        keeper.remove(c);
        // IN HER HAND (Obsidian 737): parent the tankard to the rig's left
        // hand slot bone so she visibly carries it on her rounds - root-
        // parenting left it hovering beside her shoulder. handslot is
        // KayKit's authored held-item mount; falls back to the old float
        // only if the rig is missing the bone entirely.
        let hand = null;
        barlow.mesh.traverse((o) => { if (!hand && o.isBone && /handslot\.?l$/i.test(o.name)) hand = o; });
        if (!hand) barlow.mesh.traverse((o) => { if (!hand && o.isBone && /^hand\.?l$/i.test(o.name)) hand = o; });
        if (hand) { c.position.set(0, 0.06, 0); c.rotation.set(0, 0, 0); hand.add(c); }
        else { barlow.mesh.add(c); c.position.set(0.28, 1.12, 0.34); }
      } else { keeper.remove(c); c.geometry?.dispose?.(); }
    }
    keeper.add(barlow.mesh);

    // ---- Magda's amble: paces the duckboard lane behind the bar, pausing
    // at random spots, and every 30-60s walks out around the bar's left end
    // to visit the [3,4] table before returning. Waypoints are hand-picked
    // against the room's real geometry: the pace lane is kept clear of the
    // serving cask/kegs behind the bar (x~10.4 and x~19.1/19.9), the "round
    // the end" point sits past the bar's actual left edge (x=9), and the
    // table-visit spot stands 1.6 units off the table center - outside the
    // stool ring (radius 1.25) so she never clips the table, its stools, or
    // the patron already seated there. Mirrors game.js's vendor-amble style
    // (roam a tether, stop and turn to face a nearby player) entirely inside
    // this file's own smokePuffs driver list, since game.js is off-limits.
    const barZ = keeperPos.z;
    const paceLeftX = barCenter.x + TILE / 2 - 3.2;   // 11.8 — clear of the cask at ~10.4
    const paceRightX = barCenter.x + TILE / 2 + 3.0;  // 18.0 — clear of the kegs at ~19.1/19.9
    const roundX = barCenter.x + TILE / 2 - 6.9;      // 0.9 clear of the bar's left edge (x=9) so her body never clips the corner (719)
    const visitTable = tileToWorld(3, 4);
    const path = [
      { x: roundX, z: barZ, y: 0.24 },            // walk to the bar's end, still on the duckboard
      { x: roundX, z: barZ + 1.6, y: 0 },          // step off the platform onto open floor
      { x: roundX, z: visitTable.z, y: 0 },        // down the open floor to the table's row
      { x: visitTable.x + 1.6, z: visitTable.z, y: 0 }, // stand beside the table
    ];
    const randPace = () => ({ x: paceLeftX + Math.random() * (paceRightX - paceLeftX), z: barZ });
    // 1.3 u/s (was 0.6): at the old crawl her stride barely covered ground so
    // the walk read as gliding-in-place (896). A brisker travel speed makes the
    // stride length match her movement so the leg cycle reads as real walking.
    const SPEED = 1.3;
    const st = {
      mode: 'bar', wp: 0, waitT: 1 + Math.random() * 2,
      paceTarget: randPace(),
      nextVisitAt: performance.now() + (30 + Math.random() * 30) * 1000,
    };
    const magdaDriver = {
      kind: 'firefly', mesh: new THREE.Object3D(), baseY: 0, speed: 1, _phase: 0,
      get phase() { return this._phase; },
      set phase(v) {
        const dt = Math.min(0.1, Math.max(0, v - this._phase));
        this._phase = v;
        // Real WALK animation (Obsidian 719): tick the rig with the speed she
        // actually covered this update - the locomotion blender plays the
        // walk clip while she moves and idle when she stands, so she never
        // glides with frozen legs again. Runs on every path out of this
        // setter (tickWalk before each return / at the end).
        const prevX = keeper.position.x, prevZ = keeper.position.z;
        const tickWalk = () => {
          const moved = Math.hypot(keeper.position.x - prevX, keeper.position.z - prevZ);
          barlow.tick(dt, dt > 0 ? moved / dt : 0);
        };
        // Attentive ONLY while the player is actually talking to her
        // (Obsidian 735, same rule as the town vendors in 726): barkeepChat
        // stamps talkGate.magdaUntil; outside that window she never eye-
        // tracks or swivels at mere proximity.
        const talking = performance.now() < talkGate.magdaUntil;
        const hero = talking ? nearestHero(keeper, 6) : null;
        if (hero) barlow.lookAt(hero.x, hero.z); else barlow.lookAt(null);
        if (hero) {
          const faceYaw = Math.atan2(hero.x - keeper.position.x, hero.z - keeper.position.z);
          keeper.rotation.y += wrapAngle(faceYaw - keeper.rotation.y) * Math.min(1, dt * 4);
          tickWalk();
          return;
        }
        // Table-talk (Obsidian 750): while an ambient exchange is running,
        // face whoever she's trading lines with instead of chatting into
        // the air. game.js stamps talkGate.magdaLook per turn.
        const look = talkGate.magdaLook;
        if (look && performance.now() < look.until) {
          const faceYaw = Math.atan2(look.x - keeper.position.x, look.z - keeper.position.z);
          keeper.rotation.y += wrapAngle(faceYaw - keeper.rotation.y) * Math.min(1, dt * 4);
          barlow.lookAt(look.x, look.z);
          tickWalk();
          return;
        }
        const now = performance.now();
        // 943: Magda must not walk THROUGH the hero. Grab the player's position
        // (if near) and refuse any step that would close inside her body radius;
        // in the pace lane she instead turns and paces the OTHER way, so a
        // player standing behind the bar makes her go around rather than clip.
        const BODY = 0.78;
        const heroBlock = nearestHero(keeper, 6);
        const wouldHit = (nx, nz) => heroBlock && Math.hypot(nx - heroBlock.x, nz - heroBlock.z) < BODY;
        // 902: the served ale DRAINS over ~40s as the patron drinks it - the mug
        // shrinks from full toward the dregs and its base stays on the table, so
        // the round reads as actually being consumed rather than a static prop.
        // A fresh full mug + pour cue on each visit is the "another?" loop.
        if (st.servedMug) {
          st.mugFill = Math.max(0.14, (st.mugFill == null ? 1 : st.mugFill) - dt / 40);
          st.servedMug.scale.y = st.mugFill;
          st.servedMug.position.y = 0.955 + 0.065 * st.mugFill; // base pinned to the table top
        }
        if (st.mode === 'bar') {
          if (now >= st.nextVisitAt) { st.mode = 'toTable'; st.wp = 0; st.nextVisitAt = Infinity; }
          else {
            const dx = st.paceTarget.x - keeper.position.x, dz = st.paceTarget.z - keeper.position.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.05) {
              st.waitT -= dt;
              // 916: bartender BUSYWORK instead of just standing. For the last
              // stretch of each idle pause she turns to the back-bar (north) to
              // wipe/restock the shelves, with an occasional pour cue, then faces
              // the customers again as she moves on - so she reads as working the
              // bar rather than idling. Pure facing (no bone rig needed).
              const restock = st.waitT < 1.4;
              const targetYaw = restock ? Math.PI : 0; // PI = back-bar, 0 = room
              keeper.rotation.y += wrapAngle(targetYaw - keeper.rotation.y) * Math.min(1, dt * 5);
              if (restock && !st.pouredThisWait) { st.pouredThisWait = true; if (Math.random() < 0.4) audio.pour(); }
              if (st.waitT <= 0) { st.paceTarget = randPace(); st.waitT = 2 + Math.random() * 2; st.pouredThisWait = false; }
            } else {
              const step = Math.min(dist, SPEED * dt);
              const ang = Math.atan2(dx, dz);
              const nx = keeper.position.x + Math.sin(ang) * step;
              const nz = keeper.position.z + Math.cos(ang) * step;
              if (wouldHit(nx, nz)) {
                // player is blocking this way — pace to the FAR end instead (go
                // around the other direction), and pause a beat before setting off
                st.paceTarget = { x: Math.abs(paceLeftX - heroBlock.x) > Math.abs(paceRightX - heroBlock.x) ? paceLeftX : paceRightX, z: barZ };
                st.waitT = 0.4;
              } else {
                keeper.position.x = nx; keeper.position.z = nz; keeper.rotation.y = ang;
              }
            }
            keeper.position.y = 0.24;
          }
        } else if (st.mode === 'toTable' || st.mode === 'toBar') {
          const idx = st.mode === 'toTable' ? st.wp : path.length - 1 - st.wp;
          const target = path[idx];
          const dx = target.x - keeper.position.x, dz = target.z - keeper.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.08) {
            keeper.position.x = target.x; keeper.position.z = target.z; keeper.position.y = target.y;
            st.wp++;
            if (st.wp >= path.length) {
              if (st.mode === 'toTable') {
                st.mode = 'atTable'; st.waitT = 3 + Math.random() * 2;
                // 945: real table service - if a previous (drained) round is
                // still on the table, GRAB the empty cup first, then pour and set
                // a fresh full one. So the loop reads as: bring a round -> patron
                // drinks it down -> she returns, clears the empty, brings another.
                if (st.servedMug) { group.remove(st.servedMug); st.servedMug.geometry.dispose(); st.servedMug = null; }
                audio.pour();
                const mug = new THREE.Mesh(
                  new THREE.CylinderGeometry(0.07, 0.07, 0.13, 8),
                  new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.4, roughness: 0.5 }));
                mug.position.set(visitTable.x, 1.02, visitTable.z);
                group.add(mug); st.servedMug = mug; st.mugFill = 1; // fresh full round (902)
              } else {
                st.mode = 'bar'; st.paceTarget = randPace(); st.waitT = 2 + Math.random() * 2;
                st.nextVisitAt = now + (30 + Math.random() * 30) * 1000;
                // 945: LEAVE the drained mug on the table between rounds (she
                // clears it on her next visit) so the table shows a used cup, not
                // an instantly-vanishing one.
              }
            }
          } else {
            const step = Math.min(dist, SPEED * dt);
            const ang = Math.atan2(dx, dz);
            const nx = keeper.position.x + Math.sin(ang) * step;
            const nz = keeper.position.z + Math.cos(ang) * step;
            // 943: hold at the waypoint rather than clip through the hero; she
            // resumes the moment the player steps out of her path.
            if (!wouldHit(nx, nz)) {
              keeper.position.x = nx; keeper.position.z = nz; keeper.rotation.y = ang;
              // ease across the small duckboard-height step rather than popping
              keeper.position.y += (target.y - keeper.position.y) * Math.min(1, dt * 2);
            }
          }
        } else if (st.mode === 'atTable') {
          const faceYaw = Math.atan2(visitTable.x - keeper.position.x, visitTable.z - keeper.position.z);
          keeper.rotation.y += wrapAngle(faceYaw - keeper.rotation.y) * Math.min(1, dt * 4);
          st.waitT -= dt;
          if (st.waitT <= 0) { st.mode = 'toBar'; st.wp = 0; }
        }
        tickWalk();
      },
    };
    smokePuffs.push(magdaDriver);
  }

  // ---- back-bar: three stocked shelves with bracket supports, plus jugs,
  // stacked tankards, kegs and casks so the wall behind Magda reads as a
  // working, well-supplied bar. ----
  const glassMat = (c, o = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.1, transparent: true, opacity: o });
  const corkMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 1 });
  const pewterMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.55, roughness: 0.45 });
  const potteryMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
  // Shelves ride just proud of the north wall's inner face (the wall box spans
  // z 0..2), so the bottles sit ON the wall behind Magda rather than buried
  // inside the wall as they were before.
  const shelfZ = 2.04;
  const shelfW = 8 * TILE;
  // 971: lowered 0.3 back toward reachable height (from [2.02,2.44,2.86]) so the
  // shelves read as something Magda can actually take a bottle from / set one
  // back on, not a display rail above her reach. The bottom board sits at 1.72 -
  // still just BELOW her ~1.84 head so it doesn't reslice her from the overhead
  // camera (the reason 720 raised them), but low enough that her restock reach
  // lands on it.
  const shelfYs = [1.72, 2.14, 2.56];
  for (const sy of shelfYs) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(shelfW, 0.07, 0.28), boardMat);
    shelf.position.set(barCenter.x + TILE / 2, sy, shelfZ);
    group.add(shelf);
    // small iron brackets under each shelf
    for (let b = 0; b < 5; b++) {
      const brk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.22), ironMat);
      brk.position.set(barCenter.x + TILE / 2 - shelfW / 2 + 0.6 + b * (shelfW - 1.2) / 4, sy - 0.1, shelfZ - 0.04);
      group.add(brk);
    }
  }
  const wineReds = [0x5a0f1a, 0x7a1420, 0x461426];
  const spiritCols = [0xcaa14a, 0x3a6ad9, 0x2a8a4a, 0x8a3ad9, 0xb05a2a, 0x1c8a8a];
  const jugCols = [0x8a6a44, 0x6a5238, 0x94724a, 0x5a4a55];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  // a small clay/pewter drinking jug or tankard for the shelves
  const placeJug = (x, y, tankard) => {
    const j = new THREE.Group();
    if (tankard) {
      j.add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.075, 0.2, 9), Math.random() < 0.5 ? pewterMat : brassMat));
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 5, 9, Math.PI), pewterMat);
      handle.position.set(0.09, 0, 0); handle.rotation.z = Math.PI / 2; j.add(handle);
    } else {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.11, 9, 8), potteryMat(pick(jugCols))); body.scale.y = 1.1; j.add(body);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.09, 8), potteryMat(pick(jugCols))); neck.position.y = 0.14; j.add(neck);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.016, 5, 9, Math.PI), potteryMat(pick(jugCols)));
      handle.position.set(0.1, 0.03, 0); handle.rotation.z = -0.4; j.add(handle);
    }
    j.position.set(x, y, shelfZ);
    group.add(j);
  };
  const placeBottle = (x, y, kind) => {
    const b = new THREE.Group();
    if (kind === 'wine') {
      b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.26, 8), glassMat(pick(wineReds), 0.9)));
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.14, 6), glassMat(0x24361c, 0.95)); neck.position.y = 0.2; b.add(neck);
    } else if (kind === 'flask') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), glassMat(pick(spiritCols))); body.scale.y = 0.92; b.add(body);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.12, 6), corkMat); neck.position.y = 0.13; b.add(neck);
    } else if (kind === 'jug') {
      placeBottle._jug = true; // marker unused; real jug handled by placeJug
    } else {
      b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.32, 8), glassMat(pick(spiritCols))));
      const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 6), corkMat); cork.position.y = 0.185; b.add(cork);
    }
    b.position.set(x, y, shelfZ);
    group.add(b);
  };
  // lower shelf: mostly jugs and stacked tankards (the mugs the tavern serves)
  for (let i = 0; i < 12; i++) {
    const x = barCenter.x - 5.2 + i * 0.95;
    if (i % 3 === 0) placeJug(x, shelfYs[0] + 0.08, false);
    else placeJug(x, shelfYs[0] + 0.08, true);
  }
  // middle + top shelves: bottles, flasks, wine
  const kinds = ['wine', 'tall', 'flask'];
  for (let i = 0; i < 11; i++) placeBottle(barCenter.x - 4.7 + i * 0.95, shelfYs[1] + 0.09, kinds[i % 3]);
  for (let i = 0; i < 9; i++) {
    const x = barCenter.x - 4.2 + i * 1.05;
    if (i % 4 === 2) placeJug(x, shelfYs[2] + 0.08, false);
    else placeBottle(x, shelfYs[2] + 0.09, kinds[(i + 1) % 3]);
  }
  // filled wine glasses tucked among the top-shelf bottles
  for (let i = 0; i < 4; i++) {
    const glass = new THREE.Group();
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 0.09, 8), glassMat(0xdddddd, 0.35));
    const wine = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.02, 0.05, 8), glassMat(0x6a0f1a, 0.9)); wine.position.y = -0.015;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 5), glassMat(0xdddddd, 0.35)); stem.position.y = -0.085;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.008, 8), glassMat(0xdddddd, 0.35)); foot.position.y = -0.13;
    glass.add(bowl, wine, stem, foot);
    glass.position.set(barCenter.x - 3.5 + i * 2.0, shelfYs[2] + 0.2, shelfZ + 0.02);
    group.add(glass);
  }
  // a stack of clean pewter tankards on the bar top, ready to pour
  for (let s = 0; s < 3; s++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.07, 0.17, 9), pewterMat);
    t.position.set(barCenter.x - 4.3, 1.2 + s * 0.001, barCenter.z + 0.35);
    t.position.x += s * 0.02; t.position.z -= s * 0.16; t.position.y = 1.2;
    group.add(t);
  }

  // ---- kegs and casks in the narrow strip behind the bar, kept to the ends
  // so they never overlap Magda (who stands at bar center). ----
  const mkKeg = (x, z, r, len, horizontal, tint) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), new THREE.MeshStandardMaterial({ map: woodTex, color: tint, roughness: 0.9 }));
    g.add(body);
    for (const hy of [-len * 0.34, 0, len * 0.34]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.022, 6, 16), ironMat);
      hoop.position.y = hy; hoop.rotation.x = Math.PI / 2; g.add(hoop);
    }
    if (horizontal) { g.rotation.z = Math.PI / 2; }
    g.position.set(x, horizontal ? r : len / 2, z);
    group.add(g);
    return g;
  };
  // Back-bar kegs REMOVED (Obsidian 813 - user "the floor is clipping through
  // the barrels behind the bar"): they sat in the narrow aisle between the wall
  // (z=2.0) and the counter back (z=4.4), so from the overhead camera the bar
  // counter (up to y~1.05) always sliced off their lower half - it read as the
  // floor clipping through them. Nothing behind the counter can avoid that
  // occlusion, so the kegs are gone; the SW-corner barrel stack + the stocked
  // back-bar shelves still carry the storage flavour, fully in the open.
  // Iron candle-ring chandelier REMOVED (user report): the room has no
  // ceiling, so anything hung mid-air over open floor visually lands ON the
  // floor from the game's top-down camera — the chandelier at y=2.3 read as
  // a metal ring lying on the boards. The room is already lit by the wall
  // lanterns, the hearth, and the warm fill lights below, so nothing is lost.

  // ---- warm interior lighting: the room should glow, not sit in shadow ----
  const warmLight = (color, intensity, dist, x, y, z) => {
    const l = new THREE.PointLight(color, intensity, dist, 2);
    l.position.set(x, y, z);
    group.add(l);
  };
  warmLight(0xffb464, 26, 14, (W * TILE) / 2, 2.1, (H * TILE) / 2);          // central room fill (was under the chandelier)
  // Raised + slid off Magda's axis + dimmed: at (keeper x, 1.9) this light
  // sat exactly at his head and blew him out into a white blob.
  warmLight(0xffc884, 12, 9, barCenter.x - TILE, shelfYs[1] + 0.2, shelfZ + 0.45); // behind the bar (lights shelves, grazes Magda)
  warmLight(0xffa860, 16, 8, 3.5 * TILE, 1.9, 6 * TILE);                     // near the entrance

  // ---- glowing back-bar panel so the bottles silhouette and read ----
  // Raised by the same +0.7 as the shelves below it (see shelfYs above) so
  // it keeps the exact backdrop coverage and wall-top clearance it always had.
  const backPanel = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 1.7, 0.08),
    new THREE.MeshStandardMaterial({ map: boardTex.clone(), color: 0x8a6038, roughness: 0.7, emissive: 0x3a1c0a, emissiveIntensity: 0.45 }));
  backPanel.material.map.repeat.set(4, 1);
  backPanel.position.set(barCenter.x + TILE / 2, 2.4, shelfZ - 0.07);
  group.add(backPanel);
  // a carved stone golem head mounted over the bar — the tavern's namesake.
  // Raised with the shelves below it (same +0.7 offset) so it stays clear
  // above the now-taller stocked shelf run instead of sinking into it.
  // (Obsidian 795) It read as a creepy floating box-face: it sat ABOVE the
  // wall top (y=3.2 vs WALL_HEIGHT 3) with bright glowing eyes, which also
  // contradicted the name "The Sleeping Golem". Now a proper mounted trophy:
  // a wooden plaque behind it, recessed DARK carved (sleeping) eyes instead of
  // glowing ones, lowered to sit on the back wall above the shelves.
  const trophy = new THREE.Group();
  const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.9, 0.06),
    new THREE.MeshStandardMaterial({ map: boardTex.clone(), color: 0x6a4a2c, roughness: 0.85 }));
  plaque.position.set(0, -0.03, -0.26);
  const gHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.42), new THREE.MeshStandardMaterial({ color: 0x6b6660, roughness: 1 }));
  const gBrow = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 }));
  gBrow.position.set(0, 0.12, 0.2);
  const eyeStone = new THREE.MeshStandardMaterial({ color: 0x2c2925, roughness: 1 });
  const gEyeL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.045, 0.05), eyeStone); gEyeL.position.set(-0.13, 0.0, 0.21);
  const gEyeR = gEyeL.clone(); gEyeR.position.x = 0.13;
  const gJaw = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.36), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 })); gJaw.position.set(0, -0.24, 0.02);
  trophy.add(plaque, gHead, gBrow, gEyeL, gEyeR, gJaw);
  trophy.position.set(barCenter.x + TILE / 2, 2.7, shelfZ - 0.2);
  group.add(trophy);

  // ---- wall lanterns: little iron-and-glass lamps with a warm glowing pane,
  // mounted on the side walls so the room is lit by fixtures, not just the air.
  const mkLantern = (x, z, roty) => {
    const lan = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.05), ironMat); back.position.z = -0.12; lan.add(back);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.18, 5), ironMat); arm.rotation.x = Math.PI / 2; arm.position.set(0, 0.05, -0.05); lan.add(arm);
    const cage = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xffcf7a, emissive: 0xffa040, emissiveIntensity: 0.8, roughness: 0.4, transparent: true, opacity: 0.85 }));
    lan.add(cage);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.1, 4), ironMat); cap.position.y = 0.15; cap.rotation.y = Math.PI / 4; lan.add(cap);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    lan.add(flame);
    smokePuffs.push({ mesh: flame, baseY: 0, phase: Math.random() * 6, speed: 5, kind: 'fire' });
    lan.position.set(x, 1.55, z); lan.rotation.y = roty;
    group.add(lan);
    const ll = new THREE.PointLight(0xffb060, 8, 5, 2); ll.position.set(x, 1.55, z); group.add(ll);
  };
  mkLantern(TILE + 0.12, 3.5 * TILE, Math.PI / 2);
  mkLantern(W * TILE - TILE - 0.12, 5.0 * TILE, -Math.PI / 2);

  // ---- a stack of storage barrels and a crate in the SW corner (clear of the
  // exit lane, which runs down the middle at x=6). ----
  const cornerX = TILE * 1.35, cornerZ = TILE * 6.5;
  mkKeg(cornerX, cornerZ, 0.36, 0.78, false, 0xe4d4bd);
  mkKeg(cornerX + 0.8, cornerZ, 0.36, 0.78, false, 0xd6c4a8);
  mkKeg(cornerX + 0.4, cornerZ - 0.1, 0.3, 0.62, false, 0xf0e2cc).position.y += 0.78; // one stacked on top
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), plankMat);
  crate.position.set(cornerX + 0.05, 0.35, cornerZ + 0.85);
  group.add(crate);
  // iron banding on the crate
  for (const cy of [-0.22, 0.22]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.72), ironMat);
    band.position.set(cornerX + 0.05, 0.35 + cy, cornerZ + 0.85); group.add(band);
  }
  // a burlap sack leaning on the crate
  const sack = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 7), new THREE.MeshStandardMaterial({ color: 0xb8a074, roughness: 1 }));
  sack.scale.set(0.9, 1.2, 0.9); sack.position.set(cornerX + 0.7, 0.3, cornerZ + 0.85); group.add(sack);

  // ---- wall-mounted tavern sign: previously hung on chains in open air
  // over the entrance floor (there's no ceiling to hang it from), so it read
  // as a carved board lying flat on the floor from the game's top-down
  // camera (user report). Mounted flush to the entry wall's interior face on
  // two iron brackets instead, beside the door, the way a real inn hangs its
  // house sign inside the taproom.
  const signWallZ = (H * TILE - TILE) - 0.06; // just proud of the entry wall's inner face
  const signX = 4.5 * TILE;
  // Bigger board to carry the painted golem art (799): 1.9 x 1.19 keeps the
  // 512x320 texture's aspect, mounted a touch higher so it clears heads.
  const signBoard = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.19, 0.06),
    new THREE.MeshStandardMaterial({ map: makeTavernSignTexture(), roughness: 0.9 }));
  signBoard.position.set(signX, 2.1, signWallZ);
  group.add(signBoard);
  for (const bx of [-0.75, 0.75]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.14), ironMat);
    bracket.position.set(signX + bx, 2.1, signWallZ + 0.1);
    group.add(bracket);
  }

  // ---- tables (on TABLE_TILES) with stools, mugs, candles ----
  const patronMeshes = [];
  for (const [tx, ty] of TABLE_TILES) {
    const w = tileToWorld(tx, ty);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.82, 6), darkWood);
    leg.position.set(w.x, 0.41, w.z);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.09, 12), plankMat);
    top.position.set(w.x, 0.86, w.z);
    group.add(leg, top);
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.12, 6),
      new THREE.MeshStandardMaterial({ color: 0xe8e0c8 }));
    candle.position.set(w.x + 0.2, 0.97, w.z);
    const cflame = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffc45e }));
    cflame.position.set(w.x + 0.2, 1.07, w.z);
    group.add(candle, cflame);
    smokePuffs.push({ mesh: cflame, baseY: 1.07, phase: Math.random() * 6, speed: 3, kind: 'fire' });
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + tx;
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 8), darkWood);
      stool.position.set(w.x + Math.cos(a) * 1.25, 0.25, w.z + Math.sin(a) * 1.25);
      group.add(stool);
    }
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.5, roughness: 0.5 }));
    mug.position.set(w.x - 0.25, 0.98, w.z);
    group.add(mug);
    // a second pewter tankard + a wooden trencher with a candle-lit meal
    const mug2 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.16, 9),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }));
    mug2.position.set(w.x + 0.3, 0.99, w.z - 0.28);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.03, 12), darkWood);
    plate.position.set(w.x - 0.05, 0.92, w.z + 0.28);
    const loaf = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 7),
      new THREE.MeshStandardMaterial({ color: 0xc8a05a, roughness: 0.95 }));
    loaf.scale.set(1.2, 0.7, 0.9); loaf.position.set(w.x - 0.05, 0.95, w.z + 0.28);
    const jugT = new THREE.Mesh(new THREE.SphereGeometry(0.11, 9, 8),
      new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }));
    jugT.scale.y = 1.2; jugT.position.set(w.x + 0.05, 0.98, w.z - 0.25);
    group.add(mug2, plate, loaf, jugT);
  }

  // ---- patrons: regulars with faces and drinks ----
  // Gender per patron matches its chat voice (see game.js patronChat): the
  // sober regular speaks with af_sarah (female), the tipsy one with bm_daniel
  // (male). Each is a distinct townsfolk-only body (see MODEL_FILES/
  // ATLAS_COSMETICS_CLASSES in heroModel.js) so neither patron doubles up
  // with Maribel/Torvald/Zoltan/Magda or each other. Each gets a modeled
  // GLB/glTF body when it's loaded, and keeps its box build as the fallback
  // so a patron is never invisible.
  const patronDefs = [
    // Not every patron is friendly (Obsidian 782): the drifter is a gruff
    // regular who brushes strangers off. mood drives which line bank patronChat
    // draws from; the tavern staff (Magda) are always civil, only these
    // non-worker patrons carry a mood.
    // Distinct looks off the SHARED hero library (Obsidian 789 rev): different
    // class rig + skin/hair/style/face per patron so no two read the same, the
    // same variety the char-creator exposes.
    { tile: [3, 4], angle: 0.9, name: 'patron', cls: 'knight', gender: 'female', skin: 'tan', hairColor: 'darkbrown', hairStyle: 'bun', faceShape: 'round', eyeColor: 'green', npcName: 'Tavern Patron', mood: 'rude' },
    { tile: [12, 4], angle: -2.0, name: 'drunk', cls: 'barbarian', gender: 'male', skin: 'brown', hairColor: 'grey', hairStyle: 'short', faceShape: 'standard', eyeColor: 'brown', npcName: 'Tipsy Regular', mood: 'friendly' },
    // Rosalind (Obsidian 783/808): the tavern flirt. A named regular the player
    // can chat up through a branching, affinity-driven dialogue; her tone warms
    // or cools with the player's replies and turns overtly sexual only in 18+
    // mode (793). `slutty` post-tints her shared-rig outfit to a crimson bodice
    // + bare legs so she reads as the alluring one (808) without a bespoke mesh.
    { tile: [8, 8], angle: 1.4, name: 'flirt', cls: 'mage', gender: 'female', skin: 'light', hairColor: 'auburn', hairStyle: 'long', faceShape: 'narrow', eyeColor: 'violet', npcName: 'Rosalind', given: 'Rosalind', mood: 'friendly', flirty: true, slutty: true },
  ];
  // A living CROWD (Obsidian 781): five more generated patrons with varied
  // shared-library looks fill the seat pools so the room reads busy. They
  // prefer tables/standing (seatPref) so a pair of adjacent bar stools stays
  // free for the buy-her-a-drink beat.
  {
    const CL = ['knight', 'mage', 'barbarian'];
    const GEN = ['male', 'female'];
    const SK = ['light', 'fair', 'tan', 'brown', 'deep'];
    const HC = ['black', 'darkbrown', 'chestnut', 'auburn', 'blonde', 'platinum', 'grey'];
    const HS = ['short', 'ponytail', 'bun', 'long'];
    const FA = ['standard', 'narrow', 'round'];
    const EY = ['brown', 'blue', 'green', 'amber', 'violet', 'grey'];
    for (let i = 0; i < 5; i++) {
      patronDefs.push({
        tile: [6, 6], angle: (i * 1.7) % (Math.PI * 2), name: 'patron', seatPref: 'table',
        cls: CL[i % 3], gender: GEN[i % 2], skin: SK[i % 5],
        hairColor: HC[(i * 2) % 7], hairStyle: HS[i % 4],
        faceShape: FA[(i + 1) % 3], eyeColor: EY[(i * 3) % 6],
        npcName: 'Tavern Patron', mood: i % 3 === 0 ? 'rude' : 'friendly',
      });
    }
  }
  // ---- seat picking (Obsidian 788): each patron's "AI" decides whether to
  // STAND, sit at a TABLE, or sit at the BAR, then claims a free slot of that
  // kind. The choice is a weighted stochastic decision (bar-leaning so the new
  // stools stay in use, tables next, standing as the spare) rather than a fixed
  // seat, so the room fills differently each visit. Pools are built here so the
  // future crowd (781) can draw from the same set. ----
  // 951: table seats now align with the ACTUAL stools built around each table
  // (same radius 1.25 + same three angles as the stool loop below) so a patron
  // who picks a table seat perches ON a stool instead of standing 1.5u behind
  // it at ground level ("why do NPCs stand next to the table instead of sitting
  // in the chairs"). perchY is raised for these seats (see the patron loop).
  const tableSeatSlots = [];
  for (const [tx, ty] of TABLE_TILES) {
    const tw = tileToWorld(tx, ty);
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + tx; // MATCHES the stool angles below
      const sx = tw.x + Math.cos(a) * 1.25, sz = tw.z + Math.sin(a) * 1.25;
      tableSeatSlots.push({ x: sx, z: sz, yaw: Math.atan2(tw.x - sx, tw.z - sz), seat: 'table' });
    }
  }
  const standSlots = [
    { ...tileToWorld(7, 6), yaw: 0.4, seat: 'stand' },
    { ...tileToWorld(10, 7), yaw: -1.8, seat: 'stand' },
    { ...tileToWorld(5, 7), yaw: 2.4, seat: 'stand' },
  ];
  const seatPools = { bar: barStoolSlots.slice(), table: tableSeatSlots, stand: standSlots };
  const chooseSeat = (pref) => {
    const r = Math.random();
    const order = pref === 'table'
      ? (r < 0.6 ? ['table', 'stand', 'bar'] : ['stand', 'table', 'bar'])
      : r < 0.45 ? ['bar', 'table', 'stand']
        : r < 0.78 ? ['table', 'bar', 'stand']
          : ['stand', 'bar', 'table'];
    for (const kind of order) { if (seatPools[kind] && seatPools[kind].length) return seatPools[kind].shift(); }
    return { ...tileToWorld(8, 6), yaw: 0, seat: 'stand' };
  };

  for (const def of patronDefs) {
    const slot = chooseSeat(def.seatPref);
    const px = slot.x, pz = slot.z;
    const patron = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.4, 4, 8),
      new THREE.MeshStandardMaterial({ color: def.robe, roughness: 0.9 }));
    body.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), skinMat);
    head.position.y = 1.24;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.185, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: def.hair, roughness: 1 }));
    hair.position.y = 1.28;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 6), new THREE.MeshBasicMaterial({ color: 0x2a1e14 }));
    eyeL.position.set(-0.06, 1.26, 0.16);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.06;
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), skinMat);
    nose.position.set(0, 1.22, 0.17);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.26, 3, 6), skinMat);
    arm.position.set(0.2, 0.95, 0.14);
    arm.rotation.z = -1.0;
    const pMug = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.11, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.5, roughness: 0.5 }));
    pMug.position.set(0.33, 1.05, 0.16);
    patron.add(body, head, hair, eyeL, eyeR, nose, arm, pMug);
    // Bar patrons sit UP on the stool (pelvis at the seat, feet dangling toward
    // the footrail/footwell under the overhang); table + standing patrons keep
    // the ground-level lean (Obsidian 788).
    // 951: table patrons now perch ON the stool (like bar patrons) instead of
    // leaning at ground level. Bar stool seat sits a touch higher than a table
    // stool, so table perch is a hair lower.
    const perchY = slot.seat === 'bar' ? 0.46 : slot.seat === 'table' ? 0.4 : 0.18;
    patron.position.set(px, perchY, pz);
    patron.rotation.y = slot.yaw; // face the table, the bar counter, or the chosen standing angle

    // Modeled human patron (preferred): swap the box visuals for a KayKit
    // adventurer standing at the stool, keeping the mug in hand. The `patron`
    // Group stays the transform anchor (position + table-facing yaw).
    // pmEntry is created up-front so the driver below and patronChat
    // (game.js) share it: patronChat stamps pmEntry.talkUntil when the
    // player actually opens a conversation.
    const pmEntry = { mesh: patron, x: px, z: pz, drunk: def.name === 'drunk', gender: def.gender || 'female', mood: def.mood || 'friendly', seat: slot.seat, name: def.given || null, flirty: !!def.flirty, affinity: 0, talkUntil: 0 };
    const pnpc = buildNpcModel(def.cls, def.npcName, {
      gender: def.gender, skinTone: def.skin,
      hairColor: def.hairColor, hairStyle: def.hairStyle,
      faceShape: def.faceShape, eyeColor: def.eyeColor,
    });
    // Rosalind's skimpy look (Obsidian 808): recolour the shared rig's torso to
    // a crimson bodice and her legs to her skin tone so she reads as bare-legged
    // - the most "revealing" the KayKit chibi allows without new geometry.
    if (pnpc && def.slutty) {
      const skinHex = 0xf3c9a6; // 'light' skin tone, matches def.skin
      pnpc.mesh.traverse((o) => {
        if (!o.isMesh || !o.material || !o.name) return;
        if (/_Body$/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(0x8a1f3a); }
        else if (/_Leg/i.test(o.name)) { o.material = o.material.clone(); o.material.color.setHex(skinHex); }
      });
    }
    let drinkArm = null, drinkForearm = null;
    if (pnpc) {
      // Mug IN the hand, not floating (Obsidian 843): parent it to the rig's
      // right hand-slot bone (KayKit's authored held-item mount), and grab the
      // right upper-arm + forearm bones so the drunk can raise the cup to drink.
      // NB the rig names bones WITHOUT dots ("handslotr", "upperarmr") - the old
      // "handslot\.r" regexes never matched, so the mug used to fall back to the
      // shoulder float (same bug hit Magda's tankard below).
      let heldHand = null;
      pnpc.mesh.traverse((o) => {
        if (!o.isBone) return;
        if (!heldHand && /handslot\.?r$/i.test(o.name)) heldHand = o;
        if (!drinkArm && /^upperarm\.?r$/i.test(o.name)) drinkArm = o;
        if (!drinkForearm && /^lowerarm\.?r$/i.test(o.name)) drinkForearm = o;
      });
      if (!heldHand) pnpc.mesh.traverse((o) => { if (!heldHand && o.isBone && /^hand\.?r$/i.test(o.name)) heldHand = o; });
      for (let i = patron.children.length - 1; i >= 0; i--) {
        const c = patron.children[i];
        if (c === pMug) {
          patron.remove(c);
          if (heldHand) { heldHand.add(c); c.position.set(0, 0.06, 0.02); c.rotation.set(0, 0, 0); }
          else { pnpc.mesh.add(c); c.position.set(0.24, 1.05, 0.28); }
        } else { patron.remove(c); c.geometry?.dispose?.(); }
      }
      pnpc.mesh.position.y = -0.18; // undo the stool-perch lift so feet reach the floor
      patron.add(pnpc.mesh);

      // NOTE (Obsidian 789/808): the Quaternius body swap was reverted here. The
      // skinned peasant rig, re-bound under the seated/perched patron group,
      // corrupted its bind-inverse (the qmodel carries its own uniform scale, so
      // binding with the world matrix flung the arm vertices across the room -
      // the "long arms spanning the whole tavern" bug). The stable procedural
      // KayKit body (pnpc) is kept; a distinct human rig needs to be added at
      // its own unscaled world anchor, not rebound under a transformed parent.

      // Body turn ONLY while the player is talking to this patron (Obsidian
      // 735, matching the vendor rule from 726): patronChat stamps
      // pmEntry.talkUntil; outside that window they keep facing their table
      // - no proximity eye-tracking, no stool-swivel stalking.
      const seatYaw = patron.rotation.y;
      // Track the patron's world position so a scripted walk (Rosalind's approach
      // 828 / the buy-a-drink beat 822) plays the WALK blend instead of gliding.
      const _prevWp = new THREE.Vector3(), _curWp = new THREE.Vector3();
      let _havePrevWp = false;
      const patronDriver = {
        kind: 'firefly', mesh: new THREE.Object3D(), baseY: 0, speed: 1, _phase: 0,
        get phase() { return this._phase; },
        set phase(v) {
          const dt = Math.min(0.1, Math.max(0, v - this._phase));
          this._phase = v;
          patron.updateWorldMatrix(true, false);
          _curWp.setFromMatrixPosition(patron.matrixWorld);
          let moveSpeed = 0;
          if (_havePrevWp && dt > 0) moveSpeed = Math.hypot(_curWp.x - _prevWp.x, _curWp.z - _prevWp.z) / dt;
          _prevWp.copy(_curWp); _havePrevWp = true;
          pnpc.tick(dt, moveSpeed);
          // The drunk keeps his mug hand raised toward his face (Obsidian 843):
          // re-applied AFTER the mixer so the idle clip doesn't drop the arm.
          if (pmEntry.drunk) {
            if (drinkArm) drinkArm.rotation.set(-0.5, 0.2, 1.15);
            if (drinkForearm) drinkForearm.rotation.set(0, -0.4, 1.5);
          }
          const talking = performance.now() < pmEntry.talkUntil;
          const hero = talking ? nearestHero(pnpc.mesh, 6) : null;
          // Table-talk look target (750): stamped by game.js per exchange
          // turn so patrons visibly converse WITH someone, not at the air.
          const lookTo = (pmEntry.lookTo && performance.now() < pmEntry.lookTo.until) ? pmEntry.lookTo : null;
          if (hero) pnpc.lookAt(hero.x, hero.z);
          else if (lookTo) pnpc.lookAt(lookTo.x, lookTo.z);
          else pnpc.lookAt(null);
          const targetYaw = hero
            ? Math.atan2(hero.x - patron.position.x, hero.z - patron.position.z)
            : lookTo
              ? Math.atan2(lookTo.x - patron.position.x, lookTo.z - patron.position.z)
              : seatYaw;
          patron.rotation.y += wrapAngle(targetYaw - patron.rotation.y) * Math.min(1, dt * 4);
        },
      };
      smokePuffs.push(patronDriver);
    }

    group.add(patron);
    patronMeshes.push(pmEntry);
  }

  // ---- rotating visitors (Obsidian 722): every minute or two a different
  // townsperson WALKS IN through the door, lingers at the bar or a table
  // for a while (glancing at anyone nearby), then walks back out and leaves.
  // One visitor at a time, purely client-side ambience (shows identically in
  // single player and multiplayer), self-contained in a smokePuffs driver
  // like Magda's amble. Bodies come from the same townsfolk builder, with a
  // look rotation so consecutive visitors differ. ----
  {
    // A wide look rotation (Obsidian 839): every visitor is a distinct variation
    // off the SHARED hero library - different class rig + skin/hair-colour/hair-
    // style/face/eyes - so the room never shows two of the same person.
    const VISITOR_LOOKS = [
      { cls: 'knight', gender: 'male', skin: 'tan', hairColor: 'darkbrown', hairStyle: 'short', faceShape: 'standard', eyeColor: 'brown' },
      { cls: 'mage', gender: 'female', skin: 'light', hairColor: 'blonde', hairStyle: 'ponytail', faceShape: 'narrow', eyeColor: 'blue' },
      { cls: 'barbarian', gender: 'male', skin: 'fair', hairColor: 'chestnut', hairStyle: 'short', faceShape: 'round', eyeColor: 'green' },
      { cls: 'knight', gender: 'female', skin: 'brown', hairColor: 'black', hairStyle: 'bun', faceShape: 'standard', eyeColor: 'amber' },
      { cls: 'knight', gender: 'male', skin: 'deep', hairColor: 'black', hairStyle: 'short', faceShape: 'standard', eyeColor: 'brown' },
      { cls: 'ranger', gender: 'female', skin: 'tan', hairColor: 'auburn', hairStyle: 'long', faceShape: 'round', eyeColor: 'green' },
      { cls: 'mage', gender: 'male', skin: 'light', hairColor: 'grey', hairStyle: 'short', faceShape: 'narrow', eyeColor: 'violet' },
      { cls: 'barbarian', gender: 'male', skin: 'brown', hairColor: 'darkbrown', hairStyle: 'short', faceShape: 'standard', eyeColor: 'amber' },
    ];
    const doorSpot = tileToWorld(8, 9.4);
    const LINGER_SPOTS = [
      { x: tileToWorld(12, 8).x - 1.3, z: tileToWorld(12, 8).z + 0.7, faceX: tileToWorld(12, 8).x, faceZ: tileToWorld(12, 8).z }, // beside the right table
      { x: tileToWorld(6.5, 2).x + 1, z: tileToWorld(6.5, 2).z + 1.9, faceX: tileToWorld(6.5, 2).x + 1, faceZ: tileToWorld(6.5, 2).z }, // at the bar front
      { x: tileToWorld(3, 8).x + 1.4, z: tileToWorld(3, 8).z - 0.6, faceX: tileToWorld(3, 8).x, faceZ: tileToWorld(3, 8).z }, // beside the left table
      { x: tileToWorld(14, 6).x - 2.5, z: tileToWorld(14, 6).z + 0.8, faceX: tileToWorld(14, 6).x, faceZ: tileToWorld(14, 6).z }, // warming by the hearth (723)
    ];
    const vs = { mode: 'idle', waitT: 35 + Math.random() * 40, npc: null, group: null, spot: null, lookIdx: Math.floor(Math.random() * VISITOR_LOOKS.length) };
    const VSPEED = 1.1;
    const walkToward = (grp, tx, tz, dt) => {
      const dx = tx - grp.position.x, dz = tz - grp.position.z;
      const dist = Math.hypot(dx, dz);
      const step = Math.min(dist, VSPEED * dt);
      if (dist > 1e-4) {
        grp.position.x += (dx / dist) * step;
        grp.position.z += (dz / dist) * step;
        grp.rotation.y = Math.atan2(dx, dz);
      }
      return dist - step;
    };
    const visitorDriver = {
      kind: 'firefly', mesh: new THREE.Object3D(), baseY: 0, speed: 1, _phase: 0,
      get phase() { return this._phase; },
      set phase(v) {
        const dt = Math.min(0.1, Math.max(0, v - this._phase));
        this._phase = v;
        if (vs.mode === 'idle') {
          vs.waitT -= dt;
          if (vs.waitT <= 0) {
            const look = VISITOR_LOOKS[vs.lookIdx = (vs.lookIdx + 1) % VISITOR_LOOKS.length];
            const npc = buildNpcModel(look.cls, 'Visitor', {
              gender: look.gender, skinTone: look.skin,
              hairColor: look.hairColor, hairStyle: look.hairStyle,
              faceShape: look.faceShape, eyeColor: look.eyeColor,
            });
            if (!npc) { vs.waitT = 30; return; } // model not loaded yet; try later
            vs.npc = npc;
            vs.group = npc.mesh;
            vs.group.position.set(doorSpot.x, 0, doorSpot.z + 0.6);
            group.add(vs.group);
            vs.spot = LINGER_SPOTS[Math.floor(Math.random() * LINGER_SPOTS.length)];
            vs._greeted = false; // fresh visitor gets a fresh hello (750)
            audio.play('door_open', { volume: 0.5 }); // you HEAR them come in (798)
            vs.mode = 'in';
          }
          return;
        }
        const prevX = vs.group.position.x, prevZ = vs.group.position.z;
        // NPCs never clip THROUGH the hero (user report): after any walk step,
        // resolve a circle push-out against the nearest player so the visitor
        // bumps and slides around instead of phasing through.
        const bumpHero = () => {
          const h = nearestHero(vs.group, 0.6);
          if (!h) return;
          const dx = vs.group.position.x - h.x, dz = vs.group.position.z - h.z;
          const d = Math.hypot(dx, dz);
          const ux = d > 0.001 ? dx / d : 0, uz = d > 0.001 ? dz / d : 1;
          const push = 0.6 - d;
          if (push > 0) { vs.group.position.x += ux * push; vs.group.position.z += uz * push; }
        };
        if (vs.mode === 'in') {
          bumpHero();
          if (walkToward(vs.group, vs.spot.x, vs.spot.z, dt) < 0.05) {
            vs.mode = 'linger';
            vs.waitT = 25 + Math.random() * 30;
            vs.group.rotation.y = Math.atan2(vs.spot.faceX - vs.spot.x, vs.spot.faceZ - vs.spot.z);
          }
        } else if (vs.mode === 'linger') {
          vs.waitT -= dt;
          // no player eye-tracking (735): visitors mind their drink; they
          // aren't interactable, so they never have a reason to stare.
          if (vs.waitT <= 0) vs.mode = 'out';
        } else if (vs.mode === 'out') {
          bumpHero();
          if (walkToward(vs.group, doorSpot.x, doorSpot.z + 0.8, dt) < 0.05) {
            group.remove(vs.group);
            // materials are per-instance clones; geometry is shared with the
            // preloaded rigs and must NOT be disposed (same rule as the
            // char-select preview teardown)
            vs.group.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material)) o.material.dispose(); });
            vs.npc = null; vs.group = null;
            vs.mode = 'idle';
            vs.waitT = 50 + Math.random() * 60;
            return;
          }
        }
        const moved = Math.hypot(vs.group.position.x - prevX, vs.group.position.z - prevZ);
        vs.npc.tick(dt, dt > 0 ? moved / dt : 0);
      },
    };
    visitorDriver._vs = vs; // exposed for headless verification probes
    smokePuffs.push(visitorDriver);
  }

  // ---- stone hearth with living fire, a mantel and a chimney breast ----
  const hearth = new THREE.Group();
  const stoneTexV = stoneTex.clone(); stoneTexV.needsUpdate = true; stoneTexV.repeat.set(1, 2);
  const hearthMat = new THREE.MeshStandardMaterial({ map: stoneTexV, roughness: 1 });
  const surround = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.9, 2.4), hearthMat);
  surround.position.y = 0.95;
  // chimney breast tapering up toward the beams
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 1.5), hearthMat);
  chimney.position.set(0.02, 2.15, 0);
  // heavy timber mantel shelf across the fire opening
  const mantel = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 2.0), darkWood);
  mantel.position.set(-0.05, 1.55, 0);
  // a couple of candlesticks and a tankard resting on the mantel
  const mCandle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.16, 6), new THREE.MeshStandardMaterial({ color: 0xe8e0c8 }));
  mCandle.position.set(-0.15, 1.71, -0.6);
  const mFlame = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffc45e }));
  mFlame.position.set(-0.15, 1.83, -0.6);
  smokePuffs.push({ mesh: mFlame, baseY: 1.83, phase: 2.4, speed: 4.5, kind: 'fire' });
  const mTankard = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.065, 0.15, 9), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }));
  mTankard.position.set(-0.1, 1.7, 0.55);
  // Real inset firebox (Obsidian: "make the fire inset ... a black box for the
  // fire to be within like a real fireplace"). A dark cavity BACKDROP box whose
  // front face sits a touch proud of the stone (-0.40 vs the -0.35 face, so it
  // never gets occluded like the old flush panel), with the flames burning just
  // in front of it and a proud stone frame (jambs + lintel + hearthstone) around
  // the opening so you look INTO the black box past the frame - the recessed
  // "inside a fireplace" read.
  const firebox = new THREE.Mesh(new THREE.BoxGeometry(0.30, 1.15, 1.45),
    new THREE.MeshBasicMaterial({ color: 0x0b0603 }));
  firebox.position.set(-0.25, 0.55, 0); // front face at x -0.40
  // stone frame proud of the flames (x -0.50) that turns the opening into a recess
  const frameMat = hearthMat;
  const fbTop = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 1.5), frameMat);
  fbTop.position.set(-0.46, 1.12, 0);
  const fbBase = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 1.5), frameMat);
  fbBase.position.set(-0.44, 0.06, 0);
  const fbJambL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 0.16), frameMat);
  fbJambL.position.set(-0.46, 0.6, -0.62);
  const fbJambR = fbJambL.clone(); fbJambR.position.z = 0.62;
  const logs = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x2e1c10, roughness: 1 }));
  logs.rotation.x = Math.PI / 2;
  logs.position.set(-0.3, 0.25, 0);
  const logs2 = logs.clone(); logs2.position.set(-0.3, 0.38, 0.12); logs2.rotation.set(Math.PI / 2, 0, 0.2);
  hearth.add(surround, chimney, mantel, mCandle, mFlame, mTankard, firebox, fbTop, fbBase, fbJambL, fbJambR, logs, logs2);
  // Living fire (Obsidian 717, replacing the three solid cones that read as
  // plastic party hats): a cluster of additive billboard flame sprites - the
  // standard Three.js real-time fire treatment (soft radial-gradient
  // teardrops, additive blending, no depth write, per-sprite asymmetric
  // flicker) - plus rising ember motes that fade out and respawn at the
  // logs. All driven by one custom smokePuffs driver (same phase-setter
  // pattern as Magda's amble) so game.js needs no new hooks.
  const makeFlameTexture = () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 40, 2, 32, 36, 30);
    grad.addColorStop(0, 'rgba(255,240,190,1)');
    grad.addColorStop(0.35, 'rgba(255,170,60,0.85)');
    grad.addColorStop(0.7, 'rgba(255,90,25,0.4)');
    grad.addColorStop(1, 'rgba(255,60,10,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const flameTex = makeFlameTexture();
  const flames = [];
  const FLAME_COLS = [0xffc45e, 0xff9a3a, 0xff7a2a, 0xffd88a, 0xff8a3a];
  // FLUSH quads, not billboards (Obsidian 748): camera-facing sprites swung
  // out of the hearth and floated in front of the stone at side-on angles.
  // These planes live IN the firebox-opening plane (a hair proud of the dark
  // panel at x -0.39, still behind the stone face at -0.35), so the fire can
  // never leave the fireplace no matter the camera - edge-on it thins away
  // exactly like a real opening foreshortens.
  // Flames sit clearly IN FRONT of the stone surround's front face (Obsidian 796
  // re-fix: at -0.345 the flames were coplanar with the solid brick face at
  // -0.35, so the opaque brick depth-occluded them and the firebox looked empty
  // - "no real fire inside it"). Pushed to -0.5 so they're ~0.15 proud of the
  // face, unmistakably burning in the opening from the overhead camera.
  // Just proud of the black firebox backdrop's front face (-0.40) so the flames
  // read as burning INSIDE the recessed box, framed by the proud stone jambs.
  const FLAME_X = -0.46;
  const flameQuadGeo = new THREE.PlaneGeometry(1, 1);
  // Fuller fire (Obsidian 796): the old 5 thin quads read as a faint glow, not
  // flames. Now 8 broader, taller tongues fill the firebox opening so real
  // fire reads from the room.
  const N_FLAMES = 8;
  for (let i = 0; i < N_FLAMES; i++) {
    const sp = new THREE.Mesh(flameQuadGeo, new THREE.MeshBasicMaterial({
      map: flameTex, color: FLAME_COLS[i % FLAME_COLS.length], transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
    }));
    const bz = (i - (N_FLAMES - 1) / 2) * 0.15;
    sp.position.set(FLAME_X - i * 0.0008, 0.44, bz); // tiny per-flame x stagger so the quads never coplane
    sp.rotation.y = -Math.PI / 2; // face out of the hearth (-x)
    sp.scale.set(0.42 + (i % 2) * 0.12, 0.66 + (i % 3) * 0.18, 1);
    hearth.add(sp);
    flames.push({ sp, bz, baseY: 0.44, baseSx: sp.scale.x, baseSy: sp.scale.y, ph: i * 1.7 });
  }
  const embers = [];
  for (let i = 0; i < 6; i++) {
    const em = new THREE.Mesh(flameQuadGeo, new THREE.MeshBasicMaterial({
      map: flameTex, color: 0xffb050, transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    }));
    em.scale.set(0.05, 0.05, 1);
    em.rotation.y = -Math.PI / 2;
    em.position.set(FLAME_X, 0.3, 0);
    hearth.add(em);
    embers.push({ em, t: Math.random() * 2, life: 1.2 + Math.random() * 1.2, dx: 0, dz: 0 });
  }
  const fireDriver = {
    kind: 'firefly', mesh: new THREE.Object3D(), baseY: 0, speed: 1, _phase: 0,
    get phase() { return this._phase; },
    set phase(v) {
      const dt = Math.min(0.1, Math.max(0, v - this._phase));
      this._phase = v;
      const now = v;
      for (const f of flames) {
        // asymmetric flicker: layered sines at co-prime rates read as flame,
        // not metronome; height leads, width follows inversely (a flame that
        // stretches up thins out)
        const k = 0.75 + Math.sin(now * 9 + f.ph) * 0.14 + Math.sin(now * 23 + f.ph * 2.3) * 0.1;
        f.sp.scale.y = f.baseSy * (0.8 + k * 0.5);
        f.sp.scale.x = f.baseSx * (1.25 - k * 0.35);
        f.sp.position.y = f.baseY + f.sp.scale.y * 0.28;
        f.sp.position.z = f.bz + Math.sin(now * 6 + f.ph) * 0.02;
        f.sp.material.opacity = 0.65 + k * 0.3;
      }
      for (const e of embers) {
        e.t += dt;
        if (e.t >= e.life) { // respawn at the logs with a fresh drift
          e.t = 0; e.life = 1.2 + Math.random() * 1.4;
          e.dx = (Math.random() - 0.5) * 0.12; e.dz = (Math.random() - 0.5) * 0.3;
        }
        const p = e.t / e.life;
        // embers rise IN the opening plane (748): x pinned at the quad plane,
        // capped rise so they fade before the opening's top edge
        e.em.position.set(FLAME_X + e.dx * p * 0.05, 0.32 + p * 0.55, e.dz * (0.4 + p));
        e.em.material.opacity = p < 0.15 ? p / 0.15 * 0.85 : 0.85 * (1 - (p - 0.15) / 0.85);
        const s = 0.05 * (1 - p * 0.5);
        e.em.scale.set(s, s, 1);
      }
    },
  };
  smokePuffs.push(fireDriver);
  const hw = tileToWorld(HEARTH_TILES[0][0], HEARTH_TILES[0][1]);
  hearth.position.set(hw.x + 0.5, 0, hw.z);
  group.add(hearth);
  const hearthLight = new THREE.PointLight(0xff7a38, 22, 10, 2);
  hearthLight.position.set(hw.x - 0.1, 0.9, hw.z);
  group.add(hearthLight);

  // rug + exit doormat
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.4, 16),
    new THREE.MeshStandardMaterial({ color: 0x7a2e2e, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(hw.x - 2.2, 0.02, hw.z);
  group.add(rug);

  // ---- fireside couch (Obsidian 716): a timber settle with red cushions
  // facing the hearth across the rug; the player can SIT on it (interact
  // prompt in game.js reads couchPos below) and just listen to the fire. ----
  const couch = new THREE.Group();
  const fabricMat = new THREE.MeshStandardMaterial({ color: 0x8a3030, roughness: 0.95 });
  const couchWood = new THREE.MeshStandardMaterial({ color: 0x3e2f1e, roughness: 0.9 });
  const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.42, 2.0), couchWood);
  seatBase.position.y = 0.21;
  const backRest = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 2.0), couchWood);
  backRest.position.set(-0.36, 0.72, 0);
  const backCushion = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 1.8), fabricMat);
  backCushion.position.set(-0.24, 0.7, 0);
  for (const sz of [-0.46, 0.46]) {
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.86), fabricMat);
    cushion.position.set(0.02, 0.5, sz);
    couch.add(cushion);
  }
  for (const az of [-1.0, 1.0]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, 0.14), couchWood);
    arm.position.set(0, 0.72, az);
    couch.add(arm);
  }
  for (const [lx, lz] of [[-0.32, -0.9], [-0.32, 0.9], [0.32, -0.9], [0.32, 0.9]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.1), couchWood);
    leg.position.set(lx, 0.09, lz);
    couch.add(leg);
  }
  couch.add(seatBase, backRest, backCushion);
  // west of the rug, seat opening toward the fire (+x)
  couch.position.set(hw.x - 3.6, 0, hw.z);
  group.add(couch);
  const couchPos = { x: hw.x - 3.55, z: hw.z, seatY: 0.6, faceX: hw.x, faceZ: hw.z };
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x5a4a30, roughness: 1 }));
  const exitW = tileToWorld(8, 10);
  mat.position.set(exitW.x, 0.02, exitW.z + 0.6);
  group.add(mat);

  // ---- staircase to the upstairs rooms (Obsidian 800) ----
  // A real wooden flight in the clear SE corner (east of the hearth at world
  // ~29,13; south of it), rising NORTH (-z) against the east wall up to a
  // landing + a dark doorway that reads as "the rooms are up here". The base
  // sits at the interact tile the flirty "somewhere quieter" payoff points to.
  const stairGrp = new THREE.Group();
  // stepW widened 1.6 -> 2.1 (Obsidian: "stairs too skinny"); still clears the
  // east interior wall (base x 30.4 + half-width 1.05 = 31.45 < ~31.5).
  const STEPS = 9, riseY = 0.32, runZ = 0.44, stepW = 2.1;
  for (let i = 0; i < STEPS; i++) {
    const tread = new THREE.Mesh(new THREE.BoxGeometry(stepW, riseY, runZ + 0.03), plankMat);
    tread.position.set(0, i * riseY + riseY / 2, -i * runZ);
    tread.castShadow = tread.receiveShadow = true;
    stairGrp.add(tread);
    const riser = new THREE.Mesh(new THREE.BoxGeometry(stepW, riseY, 0.04), darkWood);
    riser.position.set(0, i * riseY + riseY / 2, -i * runZ + runZ / 2);
    stairGrp.add(riser);
  }
  const topY = STEPS * riseY;               // 2.88
  // top landing platform
  const landing = new THREE.Mesh(new THREE.BoxGeometry(stepW, 0.14, 1.5), plankMat);
  landing.position.set(0, topY - 0.07, -STEPS * runZ - 0.6);
  landing.castShadow = landing.receiveShadow = true;
  stairGrp.add(landing);
  // outer stringer along the WALL side (east, +x): hidden against the east wall,
  // closes the underside so the flight isn't floating boxes.
  const stringerBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, topY, STEPS * runZ), darkWood);
  stringerBox.position.set(stepW / 2 + 0.06, topY / 2, -(STEPS * runZ) / 2 + runZ / 2);
  stairGrp.add(stringerBox);
  // Banister on the OPEN (west, -x) side (Obsidian 836/837): the old rail sat on
  // the +x WALL side, so its posts drove through the east wall and the top one
  // poked into the black void above it - the "floating post / weird shape". Now
  // posts rise with the flight on the room side, joined by a raked handrail.
  const railX = -(stepW / 2 + 0.06);
  for (let i = 0; i <= STEPS; i += 2) {
    const treadTop = (i < STEPS ? i * riseY + riseY : topY);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), darkWood);
    post.position.set(railX, treadTop + 0.45, -i * runZ);
    stairGrp.add(post);
  }
  const railLen = Math.hypot(topY, STEPS * runZ);
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, railLen * 1.02, 8), darkWood);
  rail.rotation.x = Math.atan2(topY, STEPS * runZ) + Math.PI / 2;
  rail.position.set(railX, (riseY + topY) / 2 + 0.9, -(STEPS * runZ) / 2);
  stairGrp.add(rail);
  // (the dark recessed "upVoid" box at the top is removed - Obsidian 837)
  // base at the SE clear tile, rising north
  stairGrp.position.set(30.4, 0, 20.6);
  group.add(stairGrp);

  // The flight rises up THROUGH a hole in the floor above (Obsidian 844): a small
  // patch of the upstairs floor sits over the stairwell top with an opening the
  // steps pass into, plus dark shaft walls above it - so the top reads as "going
  // up" into the floor above instead of a landing floating in mid-air. World
  // coords: the flight tops out around x[29.3,31.5] z~16.
  const soffitY = 3.35;
  const addSoffit = (cx, cz, sw, sd) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.14, sd), plankMat);
    s.position.set(cx, soffitY, cz); group.add(s);
  };
  addSoffit(30.3, 14.4, 2.9, 1.1);   // north of the opening
  addSoffit(30.3, 17.7, 2.9, 0.8);   // south of the opening
  addSoffit(29.0, 16.2, 0.5, 2.4);   // west of the opening
  const upShaftMat = new THREE.MeshStandardMaterial({ color: 0x140c06, roughness: 1 });
  const addShaft = (cx, cz, sw, sd) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(sw, 1.4, sd), upShaftMat);
    s.position.set(cx, soffitY + 0.7, cz); group.add(s);
  };
  addShaft(30.3, 15.0, 2.5, 0.12);   // north edge of the opening
  addShaft(30.3, 17.3, 2.5, 0.12);   // south edge
  addShaft(29.25, 16.15, 0.12, 2.3); // west edge (east is the building wall)

  // ---- cellar stairwell (Obsidian 971): a real flight dropping SOUTH through
  // the CELLAR_HOLE opening east of the bar, mirroring the upstairs down-
  // stairwell technique (a lit well you look down into, not a teleport hole).
  // headDownToCellar/_updateCellarDescendScene in game.js walk the hero down
  // these exact steps before the scene swaps to the cellar.
  const cDN = 7, cRise = 0.3, cRun = 0.34, cStepW = 1.7;
  for (let i = 0; i < cDN; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(cStepW, 0.14, cRun + 0.04), plankMat);
    step.position.set(cellarHw.x, -cRise * (i + 1) + 0.07, CHZ0 + 0.25 + i * cRun);
    step.receiveShadow = true; group.add(step);
  }
  const cWellBottomY = -cRise * cDN;
  const cShaftMat = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 1 });
  const cShaftH = -cWellBottomY + 0.2, cWellDepth = CHZ1 - CHZ0 + 1.0;
  for (const sx of [CHX0 - 0.02, CHX1 + 0.02]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.12, cShaftH, cWellDepth), cShaftMat);
    sw.position.set(sx, cWellBottomY / 2, (CHZ0 + CHZ1) / 2 + 0.3); group.add(sw);
  }
  const cBackW = new THREE.Mesh(new THREE.BoxGeometry(CHX1 - CHX0 + 0.3, cShaftH, 0.12), cShaftMat);
  cBackW.position.set(cellarHw.x, cWellBottomY / 2, CHZ1 + 0.55); group.add(cBackW);
  // a warm lit floor + glow at the bottom so the opening reads as "cellar
  // below", not a black pit
  const cWellFloor = new THREE.Mesh(new THREE.BoxGeometry(CHX1 - CHX0 + 0.4, 0.12, cWellDepth), floorMat);
  cWellFloor.position.set(cellarHw.x, cWellBottomY - 0.06, (CHZ0 + CHZ1) / 2 + 0.3); group.add(cWellFloor);
  const cWellGlow = new THREE.PointLight(0xffb877, 7, 6, 1.8);
  cWellGlow.position.set(cellarHw.x, cWellBottomY + 0.9, (CHZ0 + CHZ1) / 2 + 0.2); group.add(cWellGlow);
  // newel posts flank the opening (964-style: framing, not blocking, the descent)
  for (const px of [-0.9, 0.9]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), darkWood);
    post.position.set(cellarHw.x + px, 0.45, CHZ0 - 0.06); group.add(post);
  }
  // interact anchor: the solid-floor lip just north of the hole
  const stairsCellarPos = { x: cellarHw.x, z: CHZ0 - 1.0 };

  // flame refs removed (717): the sprite fire animates itself via its own
  // driver above; updateTorches only needs the light positions.
  const torchPositions = [
    { x: hw.x - 0.4, y: 1.2, z: hw.z, flame: null },
    { x: (W * TILE) / 2, y: 1.7, z: TILE * 1.6, flame: null },
  ];

  // Seats the PLAYER can sit at too (Obsidian 792): every bar stool + table
  // stool as a {x,z, faceX,faceZ, perchY, kind} the interact prompt in game.js
  // offers "Sit here" for. Bar stools face the counter (-z); table stools face
  // their table centre.
  const seats = [];
  for (const s of barStoolSlots) seats.push({ x: s.x, z: s.z, faceX: s.x, faceZ: s.z - 1, perchY: 0.44, kind: 'bar' });
  for (const [tx, ty] of TABLE_TILES) {
    const w = tileToWorld(tx, ty);
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + tx;
      seats.push({ x: w.x + Math.cos(a) * 1.25, z: w.z + Math.sin(a) * 1.25, faceX: w.x, faceZ: w.z, perchY: 0.3, kind: 'table' });
    }
  }

  return {
    group,
    doorMeshes: new Map(),
    chestMeshes: [],
    stairsMesh: null,
    torchPositions,
    vendorMeshes: [],
    portalMesh: null,
    returnPortalMesh: null,
    smokePuffs,
    seats,
    // LIVE position (Obsidian 734): the keeper group's own Vector3, so the
    // talk prompt, chat anchor and thinking pill all track her as she
    // ambles instead of pointing at where she stood when the tavern built.
    barkeepPos: keeper.position,
    talkGate, // game.js stamps magdaUntil when the player talks to her (735)
    patronMeshes,
    hearthPos: { x: hw.x, z: hw.z }, // crackle-loop distance anchor (717)
    couchPos, // fireside sit spot (716)
    stairsCellarPos, // 971: "Down to the cellar" interact anchor, north lip of the hole
  };
}

// ============================================================================
// Upstairs rooms (Obsidian 800). The staircase in the main room leads up here:
// a lamplit landing/hallway with four guest-room doorways off it, the rightmost
// being Rosalind's. A separate interior (the movement grid is single-plane, so
// "up" is a scene transition, mirroring town<->tavern) reached from the stair
// base and left again by the stairwell back down.
// ============================================================================
// Footprint MATCHES the tavern's own (Obsidian 830): the upstairs reuses W,H
// (16x12), so the guest floor is exactly the building's exterior footprint, the
// same discipline as the ground floor. Four EQUAL 6-wide x 3-deep rooms (834)
// sit two north / two south of a central east-west hallway, split by a 2-tile
// partition so both sides are the same width; each opens onto the hall through
// a real door. The rightmost-south room is Rosalind's.
const U_PART_COLS = [7, 8];             // 2-tile central partition -> equal rooms
const U_DOOR_COLS = new Set([3, 11]);   // doorway gaps in the y=4 and y=7 walls
// Down-stairwell on the EAST end of the hall (Obsidian 840): the tavern's UP
// staircase is on the east side, so going up and coming back down sit on the
// same side of the building and read the same.
const U_HOLE = { x: 13, y: 6 };
const U_ROOMS = [
  { name: 'guest',    cxW: 8,  czW: 5,  doorX: 3,  doorRow: 4 }, // NW
  { name: 'guest',    cxW: 24, czW: 5,  doorX: 11, doorRow: 4 }, // NE
  { name: 'guest',    cxW: 8,  czW: 19, doorX: 3,  doorRow: 7 }, // SW
  { name: 'rosalind', cxW: 24, czW: 19, doorX: 11, doorRow: 7 }, // SE
];

// The bed footprints (Obsidian 842): tiles the hero must NOT walk through. Kept
// in one place so generate marks them solid and the builder both places the bed
// there and skips drawing a wall pillar on them. Must match the bed placement in
// buildTavernUpstairsInterior (bedX/bedZ) exactly.
function upstairsBedTiles() {
  const tiles = [];
  for (const r of U_ROOMS) {
    const north = r.czW < 12;
    const bedX = r.cxW - 2.6, bedZ = north ? 3.5 : (H * TILE - 3.5);
    // The bed mesh is only ~1.4 wide x 2.1 deep against the wall, but the old
    // 4-corner spread marked a full 2x2 tile block (4x4 world units) as solid -
    // so the hero clipped on ~2.5 units of INVISIBLE space and couldn't walk up
    // to the bed (924). Mark ONLY the bed's real footprint: its two DEPTH tiles
    // in the single x-column its centre sits in, freeing the open side so you
    // can stand right next to it while still not walking through it.
    const tx = Math.floor(bedX / TILE);
    const seen = new Set();
    for (const dz of [-1.0, 0, 1.0]) {
      const tz = Math.floor((bedZ + dz) / TILE);
      const key = tx + ',' + tz;
      if (!seen.has(key)) { seen.add(key); tiles.push([tx, tz]); }
    }
  }
  return tiles;
}

export function generateTavernUpstairs(opts = {}) {
  const grid = Array.from({ length: H }, (_, y) =>
    new Array(W).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? WALL : FLOOR));
  // walls separating the rooms (north y1-3, south y8-10) from the central
  // hallway (y5-6), with a doorway gap per room
  for (let x = 1; x < W - 1; x++) if (!U_DOOR_COLS.has(x)) { grid[4][x] = WALL; grid[7][x] = WALL; }
  // 968: seal Rosalind's doorway (SE room, door col 11 / row 7) when you're
  // NOT with her, so her locked shut door actually keeps you out - collision is
  // grid-based, so blocking the tile is what makes the closed door solid.
  if (!opts.withRosalind) { const rr = U_ROOMS.find((r) => r.name === 'rosalind'); if (rr) grid[rr.doorRow][rr.doorX] = WALL; }
  // 968: an occupied guest room is likewise sealed - you eavesdrop from the hall.
  if (opts.occupiedRoom != null && U_ROOMS[opts.occupiedRoom]) {
    const or = U_ROOMS[opts.occupiedRoom]; grid[or.doorRow][or.doorX] = WALL;
  }
  // central partition splitting the west/east rooms
  for (const py of [1, 2, 3, 8, 9, 10]) for (const px of U_PART_COLS) grid[py][px] = WALL;
  // down-stairwell tile: collision-blocked (hero can't walk into the shaft) but
  // the mesh builder skips a wall pillar here - it's an open hole (833).
  grid[U_HOLE.y][U_HOLE.x] = WALL;
  // beds are solid too (842: no more clipping through them) - no pillar drawn.
  for (const [bx, by] of upstairsBedTiles()) if (grid[by] && grid[by][bx] !== undefined) grid[by][bx] = WALL;
  return {
    grid, size: Math.max(W, H), rooms: [],
    spawn: { x: 12, y: 5 },       // hallway, at the east-end stairwell
    stairsDown: { x: 13, y: 5 },  // solid-floor lip north of the hole
    torches: [], chests: [], doors: [], enemies: [], boss: null,
    town: true, tavernUpstairs: true, pits: [], stairs: null,
  };
}

// a real doorway: two jambs + lintel with an open plank leaf hinged at one side
// (Obsidian 831). Sits in an east-west wall, the leaf swung into the hallway.
function makeUpstairsDoor(cx, cz, darkWood, plankMat, north, shut = false) {
  const g = new THREE.Group();
  const doorH = 2.2;
  for (const jx of [-1.0, 1.0]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.16, doorH, 0.3), darkWood);
    jamb.position.set(jx, doorH / 2, 0); g.add(jamb);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.16, 0.2, 0.3), darkWood);
  lintel.position.set(0, doorH + 0.1, 0); g.add(lintel);
  const hinge = new THREE.Group();
  hinge.position.set(-0.92, 0, 0.02);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.7, doorH - 0.12, 0.08), plankMat);
  leaf.position.set(0.85, (doorH - 0.12) / 2, 0); hinge.add(leaf);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xcaa04a, metalness: 0.6, roughness: 0.4 }));
  handle.position.set(1.55, (doorH - 0.12) / 2, 0.06); hinge.add(handle);
  // 938: doors open INWARD (into the bedroom), not out into the hallway - the
  // old -1.05 swung the leaf into the central hall where you'd walk through it.
  // Rows increase with +z, so north rooms sit at -z of the hall and south rooms
  // at +z; a +z swing (-1.05) goes into the room for SOUTH rooms and into the
  // hall for NORTH rooms, so flip the sign for north. Swung wide (~78 deg) so
  // the leaf tucks alongside the room wall, clear of both the doorway and hall.
  // 968: a SHUT door (occupied / Rosalind's locked room) sits flat across the
  // opening (rotation 0) instead of swung open.
  hinge.rotation.y = shut ? 0 : (north ? 1.36 : -1.36);
  g.add(hinge);
  g.position.set(cx, 0, cz);
  return g;
}

// a ceiling-hung lantern on a visible cord (Obsidian 835/105): mounts to a
// ceiling joist (so the cord attaches to wood, not thin air) and holds a real
// glowing flame that lights the room.
function makeHangingLantern(cx, cz, group, darkWood) {
  const CEIL = 2.95;                                   // joist height
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.26), darkWood);
  mount.position.set(cx, CEIL - 0.05, cz); group.add(mount);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 1 }));
  cord.position.set(cx, CEIL - 0.35, cz); group.add(cord);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.14, 8), darkWood);
  cap.position.set(cx, 2.44, cz); group.add(cap);
  // open lantern cage (four thin posts) so the flame shows through
  for (const [ox, oz] of [[-0.09, -0.09], [0.09, -0.09], [-0.09, 0.09], [0.09, 0.09]]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 5), darkWood);
    bar.position.set(cx + ox, 2.24, cz + oz); group.add(bar);
  }
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.2), darkWood);
  base.position.set(cx, 2.1, cz); group.add(base);
  // the flame: a bright emissive teardrop the point light sits inside
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a }));
  flame.scale.y = 1.5; flame.position.set(cx, 2.22, cz); group.add(flame);
  const light = new THREE.PointLight(0xffb877, 10, 9, 1.6);
  light.position.set(cx, 2.22, cz); group.add(light);
}

// a bedside nightstand with a stub candle
function makeNightstand(cx, cz, group, darkWood) {
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.5), darkWood);
  stand.position.set(cx, 0.3, cz); group.add(stand);
  const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 1 }));
  candle.position.set(cx, 0.68, cz); group.add(candle);
  const fl = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
  fl.position.set(cx, 0.8, cz); group.add(fl);
}

// a simple guest bed; fancy=true dresses Rosalind's (crimson bedding, extra
// pillow) and returns the mattress-centre so the flirty payoff can place her.
function makeUpstairsBed(x, z, plankMat, darkWood, fancy) {
  const grp = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 2.2), darkWood);
  frame.position.y = 0.28; grp.add(frame);
  const mattress = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.22, 2.05),
    new THREE.MeshStandardMaterial({ color: fancy ? 0x7a1f38 : 0xb8a888, roughness: 0.95 }));
  mattress.position.y = 0.5; grp.add(mattress);
  const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.1, 1.25),
    new THREE.MeshStandardMaterial({ color: fancy ? 0xa8324f : 0x6a5f4a, roughness: 1 }));
  blanket.position.set(0, 0.6, 0.35); grp.add(blanket);
  const headboard = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.12), darkWood);
  headboard.position.set(0, 0.65, -1.1); grp.add(headboard);
  const pillow = new THREE.Mesh(new THREE.BoxGeometry(fancy ? 1.2 : 0.7, 0.16, 0.4),
    new THREE.MeshStandardMaterial({ color: fancy ? 0xe6c8d2 : 0xe8e2d2, roughness: 1 }));
  pillow.position.set(0, 0.63, -0.72); grp.add(pillow);
  grp.position.set(x, 0, z);
  return grp;
}

export function buildTavernUpstairsInterior(opts = {}) {
  const group = new THREE.Group();
  const woodTex = makeWoodTexture();
  const plankTex = makePlankTexture();
  const floorMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.95 });
  const plankMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });

  // Baked lighting: the shared torch-light pool favours the hallway and leaves
  // the enclosed rooms black, so light this interior itself. A warm hemisphere
  // fill lifts the whole landing; a point light per room + the hallway makes the
  // beds and doorways read. Children of `group`, so teardownFloor removes them.
  const hemi = new THREE.HemisphereLight(0xffdcb0, 0x2c2018, 1.5);
  group.add(hemi);
  const ambient = new THREE.AmbientLight(0xffe6c0, 0.35);
  group.add(ambient);

  // floor with a real opening at the east-end stairwell tile U_HOLE (13,6) ->
  // world square x[26,28] z[12,14] (833/840): four slabs around the hole so you
  // can look down the flight to the lit floor below.
  const hw2 = tileToWorld(U_HOLE.x, U_HOLE.y);
  const HX0 = hw2.x - TILE / 2, HX1 = hw2.x + TILE / 2, HZ0 = hw2.z - TILE / 2, HZ1 = hw2.z + TILE / 2;
  const addFloorSlab = (cx, cz, w, d) => {
    if (w <= 0 || d <= 0) return;
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), floorMat);
    s.position.set(cx, -0.1, cz); s.receiveShadow = true; group.add(s);
  };
  addFloorSlab((W * TILE) / 2, HZ0 / 2, W * TILE, HZ0);                                 // north of hole
  addFloorSlab((W * TILE) / 2, (HZ1 + H * TILE) / 2, W * TILE, H * TILE - HZ1);         // south of hole
  addFloorSlab(HX0 / 2, (HZ0 + HZ1) / 2, HX0, HZ1 - HZ0);                               // west of hole (band)
  addFloorSlab((HX1 + W * TILE) / 2, (HZ0 + HZ1) / 2, W * TILE - HX1, HZ1 - HZ0);       // east of hole (band)

  // walls derived from the collision grid so visuals and walkability can't drift.
  const wallH = 3.0;
  const grid = generateTavernUpstairs().grid;
  const noPillar = new Set([`${U_HOLE.x},${U_HOLE.y}`]);
  for (const [bx, by] of upstairsBedTiles()) noPillar.add(`${bx},${by}`);
  const wallGeo = new THREE.BoxGeometry(TILE, wallH, TILE);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (grid[y][x] !== WALL) continue;
    if (noPillar.has(`${x},${y}`)) continue; // stairwell hole + bed footprints - no pillar (833/842)
    const w = tileToWorld(x, y);
    const seg = new THREE.Mesh(wallGeo, wallMat);
    seg.position.set(w.x, wallH / 2, w.z);
    seg.castShadow = seg.receiveShadow = true;
    group.add(seg);
  }

  // four EQUAL decorated rooms + a real door on each (831/834). The bed's
  // HEADBOARD sits flush to the room's outer (building-edge) wall with the foot
  // pointing at the door - never floating mid-room facing away (the user's gripe).
  let rosalindBedPos = null;
  const bedPositions = []; // for the lie-down interaction (842b)
  for (let ri = 0; ri < U_ROOMS.length; ri++) {
    const r = U_ROOMS[ri];
    const fancy = r.name === 'rosalind';
    const north = r.czW < 12;                        // outer wall is north (else south)
    const bedX = r.cxW - 2.6;                         // set to one side, clear of the door lane
    const bedZ = north ? 3.5 : (H * TILE - 3.5);      // headboard ~0.4 off the outer wall
    const bed = makeUpstairsBed(bedX, bedZ, plankMat, darkWood, fancy);
    if (!north) bed.rotation.y = Math.PI;            // south rooms: headboard to the south wall
    group.add(bed);
    // lie-down anchor: mattress centre + the foot->head direction (so the hero
    // lies flat along the bed with the head at the headboard)
    bedPositions.push({ x: bedX, z: bedZ, headAngle: north ? -Math.PI / 2 : Math.PI / 2, standZ: north ? bedZ + 1.6 : bedZ - 1.6, fancy });
    // nightstand at the head of the bed
    makeNightstand(bedX + 1.35, north ? bedZ - 0.9 : bedZ + 0.9, group, darkWood);
    // rug in front of the bed (toward the door / room centre)
    const rug = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.03, 1.8),
      new THREE.MeshStandardMaterial({ color: fancy ? 0x5a1226 : 0x4a3a52, roughness: 1 }));
    rug.position.set(bedX, 0.015, north ? bedZ + 2.4 : bedZ - 2.4); group.add(rug);
    // chest against the inner side wall
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.6), darkWood);
    chest.position.set(r.cxW + 3.4, 0.3, bedZ); group.add(chest);
    // real door seated in the wall opening. 968: Rosalind's room is LOCKED
    // (shut) unless you arrived WITH her (the follow scene) - "I cannot go in
    // her room without her, so that door should be shut". Empty guest rooms
    // stay open so you can wander in and sleep.
    const dw = tileToWorld(r.doorX, r.doorRow);
    // 968: shut for Rosalind's locked room (no withRosalind) OR an OCCUPIED
    // guest room (a couple's inside - eavesdrop from the hall, don't barge in).
    const shut = (fancy && !opts.withRosalind) || ri === opts.occupiedRoom;
    group.add(makeUpstairsDoor(dw.x, dw.z, darkWood, plankMat, north, shut));
    // corded hanging lantern above the room
    makeHangingLantern(r.cxW, r.czW, group, darkWood);
    if (fancy) {
      rosalindBedPos = { x: bedX, z: north ? bedZ + 1.3 : bedZ - 1.3 };
      for (const cxp of [-1.2, 1.2]) {
        const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.3, 8),
          new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 1 }));
        candle.position.set(bedX + cxp, 0.15, north ? bedZ + 2.4 : bedZ - 2.4); group.add(candle);
        const flame = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6),
          new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
        flame.position.set(bedX + cxp, 0.34, north ? bedZ + 2.4 : bedZ - 2.4); group.add(flame);
      }
    }
  }
  // two more corded lanterns down the hallway
  makeHangingLantern(10, 11, group, darkWood);
  makeHangingLantern(22, 11, group, darkWood);
  // thin ceiling joists the lantern mounts hang from (so nothing floats, 105);
  // kept slim + high so the overhead camera still sees the rooms between them.
  const joistMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 1 });
  for (const jz of [5, 11, 19]) {
    const joist = new THREE.Mesh(new THREE.BoxGeometry(W * TILE - 0.4, 0.14, 0.2), joistMat);
    joist.position.set((W * TILE) / 2, 3.0, jz); group.add(joist);
  }

  // east-side descending stairwell (833/840): a real flight dropping SOUTH into a
  // lit lower well so, standing at the north lip, you look down the steps and see
  // the warm floor below - the mirror of the tavern's east-side up-staircase.
  const down = hw2;                          // hole centre (27,13)
  const DN = 7, dnRise = 0.3, dnRun = 0.34;
  for (let i = 0; i < DN; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, dnRun + 0.04), plankMat);
    step.position.set(down.x, -dnRise * (i + 1) + 0.07, HZ0 + 0.25 + i * dnRun);
    step.receiveShadow = true; group.add(step);
  }
  const wellBottomY = -dnRise * DN;
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 1 });
  const shaftH = -wellBottomY + 0.2, wellDepth = HZ1 - HZ0 + 1.0;
  for (const sx of [HX0 - 0.02, HX1 + 0.02]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.12, shaftH, wellDepth), shaftMat);
    sw.position.set(sx, wellBottomY / 2, (HZ0 + HZ1) / 2 + 0.3); group.add(sw);
  }
  const backW = new THREE.Mesh(new THREE.BoxGeometry(HX1 - HX0 + 0.3, shaftH, 0.12), shaftMat);
  backW.position.set(down.x, wellBottomY / 2, HZ1 + 0.55); group.add(backW);
  // warm plank floor at the bottom + a light so the "downstairs" reads as lit
  const wellFloor = new THREE.Mesh(new THREE.BoxGeometry(HX1 - HX0 + 0.4, 0.12, wellDepth),
    new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 }));
  wellFloor.position.set(down.x, wellBottomY - 0.06, (HZ0 + HZ1) / 2 + 0.3); group.add(wellFloor);
  const wellGlow = new THREE.PointLight(0xffb877, 8, 7, 1.8);
  wellGlow.position.set(down.x, wellBottomY + 0.9, (HZ0 + HZ1) / 2 + 0.2); group.add(wellGlow);
  // Newel posts FLANK the descent opening (Obsidian 964): the old horizontal
  // hand-rail ran straight across the north lip at waist height - right where
  // you step in to go down - so it read as a "wooden bar blocking the stairs".
  // Dropped the cross-rail; the two corner posts sit outside the 1.7-wide
  // treads (x = down.x ± 0.95) and frame the opening without obstructing it.
  for (const px of [-0.95, 0.95]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), darkWood);
    post.position.set(down.x + px, 0.45, HZ0 - 0.06); group.add(post);
  }

  // torch anchors for the shared light pool (room centres + hallway).
  const torchPositions = [
    { x: 8, z: 5 }, { x: 24, z: 5 }, { x: 8, z: 19 }, { x: 24, z: 19 },
    { x: 10, z: 11 }, { x: 22, z: 11 },
  ];

  return {
    group,
    torchPositions,
    stairsDownPos: { x: down.x, z: HZ0 - 1.0 }, // north lip of the stairwell (solid floor)
    bedPositions,
    rosalindBedPos,
    // guard-friendly empties so the shared tavern per-frame code no-ops up here
    doorMeshes: new Map(), chestMeshes: [], stairsMesh: null,
    vendorMeshes: [], portalMesh: null, returnPortalMesh: null,
    smokePuffs: [], seats: [], patronMeshes: [],
  };
}

// ---------------- tavern cellar (Obsidian 971) ----------------
// The regulars tell Magda to "check the cellar" - a small stone storage room
// below the ground floor, reached by walking DOWN the real stairwell built
// into buildTavernInterior above (CELLAR_HOLE), not a teleport. Mirrors the
// upstairs generate+build split exactly, including the guard-friendly empty
// dungeonMeshes shape so the shared tavern per-frame code no-ops safely here.
const CW = 10, CH = 10;
// the flight itself (solid - no walking through the steps); the open tile at
// (5,7) just south of it is the spawn + "Back up" interact anchor.
const CELLAR_STAIR_TILES = [[5, 4], [5, 5], [5, 6]];
// dressed prop clusters (wine rack, barrel stacks, crates) - solid so the
// hero can't walk through them, same convention as the tavern's own furniture.
const CELLAR_PROP_TILES = [[2, 2], [2, 3], [7, 2], [8, 2], [2, 7], [3, 7], [7, 7], [8, 7]];

export function generateTavernCellar() {
  const grid = Array.from({ length: CH }, (_, y) =>
    new Array(CW).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === CW - 1 || y === CH - 1) ? WALL : FLOOR));
  for (const [x, y] of [...CELLAR_STAIR_TILES, ...CELLAR_PROP_TILES]) grid[y][x] = WALL;
  return {
    grid, size: Math.max(CW, CH), rooms: [],
    spawn: { x: 5, y: 7 },      // open floor at the foot of the stairs
    stairsUp: { x: 5, y: 7 },   // interact tile -> back up to the tavern
    torches: [], chests: [], doors: [], enemies: [], boss: null,
    town: true, tavernCellar: true, pits: [], stairs: null,
  };
}

// a squat barrel (cask/keg) - the cellar's main dressing
function makeBarrel(x, z, group, mat, bandMat, scale = 1) {
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * scale, 0.4 * scale, 0.75 * scale, 12), mat);
  barrel.position.set(x, 0.375 * scale, z);
  barrel.castShadow = barrel.receiveShadow = true;
  group.add(barrel);
  for (const by of [0.16, 0.59]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.455 * scale, 0.455 * scale, 0.06 * scale, 12), bandMat);
    band.position.set(x, by * scale, z);
    group.add(band);
  }
}

// a stacked pair of shipping crates
function makeCrateStack(x, z, group, mat, darkWood) {
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), mat);
  base.position.set(x, 0.3, z); base.castShadow = base.receiveShadow = true; group.add(base);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
  top.position.set(x + 0.05, 0.85, z - 0.05); top.rotation.y = 0.3; top.castShadow = true; group.add(top);
  for (const yy of [0.3, 0.85]) {
    for (const rot of [0, Math.PI / 2]) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(yy === 0.3 ? 0.74 : 0.54, 0.05, 0.05), darkWood);
      slat.position.set(x, yy + (yy === 0.3 ? 0.32 : 0.27), z);
      slat.rotation.y = rot; group.add(slat);
    }
  }
}

// a wine rack: a dark wood frame holding rows of bottles on their sides
function makeWineRack(x, z, group, darkWood) {
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 0.5), darkWood);
  frame.position.set(x, 0.7, z); group.add(frame);
  const bottleMat = new THREE.MeshStandardMaterial({ color: 0x1c3a24, roughness: 0.4, metalness: 0.1 });
  for (let row = 0; row < 3; row++) {
    for (let col = -1; col <= 1; col++) {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.4, 8), bottleMat);
      bottle.rotation.z = Math.PI / 2;
      bottle.position.set(x + col * 0.28, 0.35 + row * 0.42, z);
      group.add(bottle);
    }
  }
}

export function buildTavernCellarInterior() {
  const group = new THREE.Group();
  const stoneTex = makeHearthStoneTexture();
  stoneTex.repeat.set(3, 2);
  const plankTex = makePlankTexture('#4a3624'); // darker, aged boards down here
  const floorMat = new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.95 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2c, roughness: 0.9 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, metalness: 0.3, roughness: 0.7 });
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a4530, roughness: 0.9 });

  // Baked lighting (mirrors buildTavernUpstairsInterior): dim + close so the
  // cellar reads as genuinely buried, with the hanging lantern doing the
  // actual work of lighting the room.
  group.add(new THREE.HemisphereLight(0x8a7050, 0x100c08, 0.5));
  group.add(new THREE.AmbientLight(0xffcf9a, 0.22));

  // plank floor laid over the packed earth
  const floor = new THREE.Mesh(new THREE.BoxGeometry(CW * TILE, 0.2, CH * TILE), floorMat);
  floor.position.set((CW * TILE) / 2, -0.1, (CH * TILE) / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // stone + earth perimeter walls
  const wallH = 2.6;
  const wallGeo = new THREE.BoxGeometry(TILE, wallH, TILE);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    if (!(x === 0 || x === CW - 1 || y === 0 || y === CH - 1)) continue;
    const w = tileToWorld(x, y);
    const seg = new THREE.Mesh(wallGeo, wallMat);
    seg.position.set(w.x, wallH / 2, w.z);
    seg.castShadow = seg.receiveShadow = true;
    group.add(seg);
  }

  // dressing: wine rack (west), barrel cluster (NE), crates (SW), kegs (SE) -
  // matching CELLAR_PROP_TILES so the collision grid lines up with what's drawn.
  const wr = tileToWorld(2, 2), wr2 = tileToWorld(2, 3);
  makeWineRack(wr.x, (wr.z + wr2.z) / 2, group, darkWood);
  makeBarrel(tileToWorld(7, 2).x, tileToWorld(7, 2).z, group, barrelMat, bandMat);
  makeBarrel(tileToWorld(8, 2).x, tileToWorld(8, 2).z, group, barrelMat, bandMat, 0.85);
  makeCrateStack(tileToWorld(2, 7).x, tileToWorld(2, 7).z, group, crateMat, darkWood);
  makeCrateStack(tileToWorld(3, 7).x, tileToWorld(3, 7).z, group, crateMat, darkWood);
  makeBarrel(tileToWorld(7, 7).x, tileToWorld(7, 7).z, group, barrelMat, bandMat);
  makeBarrel(tileToWorld(8, 7).x, tileToWorld(8, 7).z, group, barrelMat, bandMat, 0.85);
  // a few loose, non-blocking barrels for clutter
  makeBarrel(tileToWorld(4, 1).x + 0.6, tileToWorld(4, 1).z, group, barrelMat, bandMat, 0.8);
  makeBarrel(tileToWorld(6, 8).x, tileToWorld(6, 8).z, group, barrelMat, bandMat, 0.9);

  // ---- the stairs back up (foot at the open tile (5,7), rising north) ----
  const cSteps = 7, cRise = 0.3, cRun = 0.34, cStepW = 1.7;
  const stairX = tileToWorld(5, 5).x;   // flight column centre
  const baseZ = tileToWorld(5, 6).z + TILE / 2; // boundary between the open foot tile and the first step
  const stairGrp = new THREE.Group();
  for (let i = 0; i < cSteps; i++) {
    const tread = new THREE.Mesh(new THREE.BoxGeometry(cStepW, cRise, cRun + 0.03), floorMat);
    tread.position.set(0, i * cRise + cRise / 2, -i * cRun);
    tread.castShadow = tread.receiveShadow = true;
    stairGrp.add(tread);
    const riser = new THREE.Mesh(new THREE.BoxGeometry(cStepW, cRise, 0.04), darkWood);
    riser.position.set(0, i * cRise + cRise / 2, -i * cRun + cRun / 2);
    stairGrp.add(riser);
  }
  stairGrp.position.set(stairX, 0, baseZ);
  group.add(stairGrp);
  // banister on the open (west) side
  const railX = -(cStepW / 2 + 0.06);
  for (let i = 0; i <= cSteps; i += 2) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8), darkWood);
    post.position.set(stairX + railX, i * cRise + 0.35, baseZ - i * cRun);
    group.add(post);
  }

  // the hanging lantern - the room's real light source
  makeHangingLantern(tileToWorld(5, 3).x, tileToWorld(5, 3).z, group, darkWood);
  makeHangingLantern(tileToWorld(7, 6).x, tileToWorld(7, 6).z, group, darkWood);

  const stairsUpPos = tileToWorld(5, 7); // interact anchor: foot of the stairs

  return {
    group,
    torchPositions: [],
    stairsDownPos: null,
    bedPositions: [],
    // guard-friendly empties so the shared tavern per-frame code no-ops down here
    doorMeshes: new Map(), chestMeshes: [], stairsMesh: null,
    vendorMeshes: [], portalMesh: null, returnPortalMesh: null,
    smokePuffs: [], seats: [], patronMeshes: [],
    stairsUpPos, // 971: "Back up" interact anchor
  };
}
