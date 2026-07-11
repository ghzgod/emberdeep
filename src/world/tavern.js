import * as THREE from 'three';
import { FLOOR, WALL } from './dungeon.js';
import { TILE, tileToWorld, buildNpcModel } from './meshbuilder.js';
import { makeWoodTexture, makePlankTexture, makeHearthStoneTexture, makeTavernSignTexture } from './textures.js';

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
const BAR_TILES = [[3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2]];
// x=8 sits directly on the spawn(8,9)->exit(8,10)->bar walking lane, so the
// two right-side tables are mirrored to x=12 (16-wide room, center 7.5) —
// clear of the entrance lane, symmetric with the x=3 tables on the other side.
const TABLE_TILES = [[3, 4], [12, 4], [3, 8], [12, 8]];
const HEARTH_TILES = [[14, 6]];

export function generateTavernInterior() {
  const grid = Array.from({ length: H }, (_, y) =>
    new Array(W).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? WALL : FLOOR));
  for (const [x, y] of [...BAR_TILES, ...TABLE_TILES, ...HEARTH_TILES]) grid[y][x] = WALL;
  return {
    grid, size: Math.max(W, H), rooms: [],
    spawn: { x: 8, y: 9 },
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

  // floor planks (real plank texture: fitted boards, not the vertical staves)
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W * TILE, 0.2, H * TILE), floorMat);
  floor.position.set((W * TILE) / 2, -0.1, (H * TILE) / 2);
  group.add(floor);

  // perimeter walls with a south door gap. Plaster above, a dark wooden wainscot
  // rail below so the room reads as timber-and-plaster, not bare stucco.
  // +0.7 from the original 2.6: the back-bar shelves (see shelfYs below) were
  // raised by the same amount to clear Magda's head, so the wall is raised
  // to match and keep the same clearance the shelves/trophy always had
  // against its top edge.
  const wallH = 3.3;
  const wainH = 1.0;
  const mkWall = (w, d, x, z, horizontal) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), plasterMat);
    m.position.set(x, wallH / 2, z);
    group.add(m);
    // wainscot: a thin waist-high board panel on the inner face of the wall
    const wt = boardTex.clone(); wt.needsUpdate = true;
    wt.repeat.set(horizontal ? w / TILE : d / TILE, 1);
    const wainMat = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.85 });
    const panelT = 0.08; // panel thickness (along the wall's short axis)
    // Clearance off the wall's inner face: without this the panel's outer
    // face and the wall's inner face land on the exact same plane, which
    // z-fights (shimmers/moires when the camera zooms in) wherever a
    // wainscot backs onto the wall — most visibly behind the bar. A few cm
    // of real standoff (not a coplanar polygon-offset trick) fixes it for
    // good at any zoom/angle.
    const WALL_GAP = 0.03;
    const wain = new THREE.Mesh(
      new THREE.BoxGeometry(horizontal ? w : panelT, wainH, horizontal ? panelT : d), wainMat);
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
  mkWall(W * TILE, TILE, (W * TILE) / 2, TILE / 2, true);
  mkWall(TILE, H * TILE, TILE / 2, (H * TILE) / 2, false);
  mkWall(TILE, H * TILE, W * TILE - TILE / 2, (H * TILE) / 2, false);
  // South wall, split around the exit gap. DOOR_GAP_W/gapCenterX are declared
  // here (rather than down by the rest of the door dressing) so both this
  // split and the jamb/leaf/threshold-glow below share one definition. Was a
  // flat 4-unit gap (garage-door wide, TODO 703) — narrowed to real door
  // width; each segment's OUTER edge (against the west/east walls, at x=1
  // and x=W*TILE-1) stays fixed, only the inner edge moves to close in on
  // the narrower gap.
  const DOOR_GAP_W = 2.2, gapCenterX = 8 * TILE + TILE / 2; // matches exit tile (8, 10)
  const westSegR = gapCenterX - DOOR_GAP_W / 2, eastSegL = gapCenterX + DOOR_GAP_W / 2;
  mkWall(westSegR - 1, TILE, (1 + westSegR) / 2, H * TILE - TILE / 2, true);
  mkWall((W * TILE - 1) - eastSegL, TILE, (eastSegL + W * TILE - 1) / 2, H * TILE - TILE / 2, true);
  // Ceiling beams REMOVED (user report): at gameplay camera angles the
  // y=2.55 rafters sliced across the view and read as mid-room walls that
  // blocked sight of the table areas.

  // Recessed window openings on the side + entry walls, matching the
  // exterior facade's fenestration (2 flanking the front door, 2 per long
  // side) so the room isn't the solid, windowless box the user reported —
  // rotating the camera to where an outside window sits now finds a real
  // framed opening in here too, instead of a blank wall.
  const mkWindow = (x, z, roty) => {
    const grp = new THREE.Group();
    // a darker recessed reveal set back into the wall gives the opening real
    // depth instead of reading as a flat decal
    const reveal = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.86, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 1 }));
    reveal.position.z = -0.04;
    grp.add(reveal);
    // warm amber pane (reads as the firelit room's glow reflected back, or a
    // warm night sky outside — either way, alive, not a black hole)
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xffb45e, emissive: 0xff8a2a, emissiveIntensity: 0.55, roughness: 0.6 }));
    pane.position.z = 0.005;
    grp.add(pane);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.08, 0.12), darkWood); top.position.y = 0.35;
    const bot = top.clone(); bot.position.y = -0.35;
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.12), darkWood); l.position.x = -0.35;
    const r = l.clone(); r.position.x = 0.35;
    grp.add(top, bot, l, r);
    const mV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), darkWood); mV.position.z = 0.02;
    const mH = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 0.04), darkWood); mH.position.z = 0.02;
    grp.add(mV, mH);
    grp.position.set(x, 1.55, z); grp.rotation.y = roty;
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

  // ---- exit door: a real timber frame + a leaf propped open against the
  // inner wall at the south gap (matches the exterior KayKit arch style),
  // so "stepping outside" reads as leaving through an actual doorway rather
  // than walking through a bare hole in the wall (user report: "the door to
  // leave doesn't even make sense"). The gap itself (its walkable width) is
  // untouched — this only dresses its edges.
  const gapWidth = DOOR_GAP_W; // matches exit tile (8, 10) — see DOOR_GAP_W above
  const gapZ = H * TILE - TILE / 2;
  const jambGeo = new THREE.BoxGeometry(0.16, wallH, 0.3);
  const jambL = new THREE.Mesh(jambGeo, darkWood); jambL.position.set(gapCenterX - gapWidth / 2, wallH / 2, gapZ);
  const jambR = jambL.clone(); jambR.position.x = gapCenterX + gapWidth / 2;
  const header = new THREE.Mesh(new THREE.BoxGeometry(gapWidth + 0.32, 0.2, 0.3), darkWood);
  header.position.set(gapCenterX, wallH - 0.1, gapZ);
  group.add(jambL, jambR, header);
  // door leaf, hinged at the west jamb and swung open into the room so it
  // reads as a real door without blocking the walkway
  const leafH = wallH - 0.3, leafW = gapWidth / 2 - 0.1;
  const leafPivot = new THREE.Group();
  leafPivot.position.set(gapCenterX - gapWidth / 2, 0, gapZ - 0.14);
  // folded back against the inner wall (was -1.3, which swung the leaf out
  // into the entrance walkway - the "glitchy plank by the entrance" report)
  leafPivot.rotation.y = -2.95;
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, 0.08), darkWood);
  leaf.position.set(leafW / 2, leafH / 2, 0);
  const leafHandle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.35 }));
  leafHandle.position.set(leafW - 0.15, leafH / 2, 0.06);
  leafPivot.add(leaf, leafHandle);
  group.add(leafPivot);

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
  const barCenter = tileToWorld(6.5, 2);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 1.05, 1.2), boardMat);
  bar.position.set(barCenter.x + TILE / 2, 0.52, barCenter.z);
  group.add(bar);
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE + 0.2, 0.08, 1.35), plankMat);
  barTop.position.set(barCenter.x + TILE / 2, 1.09, barCenter.z);
  group.add(barTop);
  // taps + mugs on the bar
  for (let i = 0; i < 3; i++) {
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.5, roughness: 0.5 }));
    mug.position.set(barCenter.x - 3 + i * 3, 1.2, barCenter.z + 0.3);
    group.add(mug);
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

  // --- Modeled human Magda (preferred) ---
  // Replace the box barkeep's visuals with the KayKit unhooded-Rogue "villager"
  // body (Magda's voice is female, af_kore) - kept distinct from Torvald and the
  // Tipsy Regular, who use other townsfolk-only bodies. The `keeper` Group stays the transform
  // anchor (position + the +z facing), so only the look changes. If the GLB
  // isn't loaded, buildNpcModel returns null and the box barkeep above stays
  // visible as the fallback. She keeps her held mug in hand.
  const barlow = buildNpcModel('villager', 'Magda', { gender: 'female', skinTone: 'tan' });
  if (barlow) {
    for (let i = keeper.children.length - 1; i >= 0; i--) {
      const c = keeper.children[i];
      if (c === heldMug) { keeper.remove(c); barlow.mesh.add(c); c.position.set(0.28, 1.12, 0.34); }
      else { keeper.remove(c); c.geometry?.dispose?.(); }
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
    const roundX = barCenter.x + TILE / 2 - 6.3;      // past the bar's real left edge (x=9)
    const visitTable = tileToWorld(3, 4);
    const path = [
      { x: roundX, z: barZ, y: 0.24 },            // walk to the bar's end, still on the duckboard
      { x: roundX, z: barZ + 1.6, y: 0 },          // step off the platform onto open floor
      { x: roundX, z: visitTable.z, y: 0 },        // down the open floor to the table's row
      { x: visitTable.x + 1.6, z: visitTable.z, y: 0 }, // stand beside the table
    ];
    const randPace = () => ({ x: paceLeftX + Math.random() * (paceRightX - paceLeftX), z: barZ });
    const SPEED = 0.6; // slow amble, world units/sec — matches the vendor amble's feel
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
        barlow.tick(dt);
        const hero = nearestHero(keeper, 6);
        if (hero) barlow.lookAt(hero.x, hero.z); else barlow.lookAt(null);
        // Attentive: stop ambling and turn the whole body to face a nearby
        // player, exactly like the vendor amble does (task e's body-turn).
        if (hero && hero.d < 2.6) {
          const faceYaw = Math.atan2(hero.x - keeper.position.x, hero.z - keeper.position.z);
          keeper.rotation.y += wrapAngle(faceYaw - keeper.rotation.y) * Math.min(1, dt * 4);
          return;
        }
        const now = performance.now();
        if (st.mode === 'bar') {
          if (now >= st.nextVisitAt) { st.mode = 'toTable'; st.wp = 0; st.nextVisitAt = Infinity; }
          else {
            const dx = st.paceTarget.x - keeper.position.x, dz = st.paceTarget.z - keeper.position.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.05) {
              st.waitT -= dt;
              if (st.waitT <= 0) { st.paceTarget = randPace(); st.waitT = 2 + Math.random() * 2; }
            } else {
              const step = Math.min(dist, SPEED * dt);
              const ang = Math.atan2(dx, dz);
              keeper.position.x += Math.sin(ang) * step;
              keeper.position.z += Math.cos(ang) * step;
              keeper.rotation.y = ang;
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
              if (st.mode === 'toTable') { st.mode = 'atTable'; st.waitT = 3 + Math.random() * 2; }
              else {
                st.mode = 'bar'; st.paceTarget = randPace(); st.waitT = 2 + Math.random() * 2;
                st.nextVisitAt = now + (30 + Math.random() * 30) * 1000;
              }
            }
          } else {
            const step = Math.min(dist, SPEED * dt);
            const ang = Math.atan2(dx, dz);
            keeper.position.x += Math.sin(ang) * step;
            keeper.position.z += Math.cos(ang) * step;
            keeper.rotation.y = ang;
            // ease across the small duckboard-height step rather than popping
            keeper.position.y += (target.y - keeper.position.y) * Math.min(1, dt * 2);
          }
        } else if (st.mode === 'atTable') {
          const faceYaw = Math.atan2(visitTable.x - keeper.position.x, visitTable.z - keeper.position.z);
          keeper.rotation.y += wrapAngle(faceYaw - keeper.rotation.y) * Math.min(1, dt * 4);
          st.waitT -= dt;
          if (st.waitT <= 0) { st.mode = 'toBar'; st.wp = 0; }
        }
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
  // Raised 0.7 units from the original [1.32, 1.74, 2.16] (same spacing, so
  // stock items keep their clearance from the shelf above): Magda's modeled
  // body + the duckboard boost put her head at ~1.84, which the bottom two
  // rows used to slice straight through from the overhead camera (user
  // report). All three boards now clear y=2.0.
  const shelfYs = [2.02, 2.44, 2.86];
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
  const backStripZ = 2.28; // between the wall face (2.0) and the bar back (2.4)
  // a tapped serving cask lying on its side at the left end behind the bar
  mkKeg(barCenter.x - 4.6, backStripZ, 0.3, 0.66, true, 0xe8dccb);
  const spigot = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.12, 6), ironMat);
  spigot.rotation.x = Math.PI / 2; spigot.position.set(barCenter.x - 4.6, 0.22, backStripZ + 0.34);
  group.add(spigot);
  // upright kegs lined along the right end behind the bar
  mkKeg(barCenter.x + 4.1, backStripZ, 0.28, 0.66, false, 0xd8c8b0);
  mkKeg(barCenter.x + 4.9, backStripZ, 0.28, 0.66, false, 0xf0e4d0);
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
  const trophy = new THREE.Group();
  const gHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.42), new THREE.MeshStandardMaterial({ color: 0x6b6660, roughness: 1 }));
  const gBrow = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 }));
  gBrow.position.set(0, 0.12, 0.2);
  const gEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffb24a })); gEyeL.position.set(-0.13, 0.02, 0.22);
  const gEyeR = gEyeL.clone(); gEyeR.position.x = 0.13;
  const gJaw = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.36), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 })); gJaw.position.set(0, -0.24, 0.02);
  trophy.add(gHead, gBrow, gEyeL, gEyeR, gJaw);
  trophy.position.set(barCenter.x + TILE / 2, 3.2, shelfZ - 0.18);
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
  const signBoard = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.44, 0.06),
    new THREE.MeshStandardMaterial({ map: makeTavernSignTexture(), roughness: 0.9 }));
  signBoard.position.set(signX, 1.85, signWallZ);
  group.add(signBoard);
  for (const bx of [-0.34, 0.34]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.14), ironMat);
    bracket.position.set(signX + bx, 1.85, signWallZ + 0.1);
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
    { tile: [3, 4], angle: 0.9, robe: 0x5a4a6a, hair: 0x3a2a1a, name: 'patron', cls: 'drifter', gender: 'female', skin: 'light', npcName: 'Tavern Patron' },
    { tile: [12, 4], angle: -2.0, robe: 0x4a5a3a, hair: 0x999999, name: 'drunk', cls: 'cleric', gender: 'male', skin: 'fair', npcName: 'Tipsy Regular' },
  ];
  for (const def of patronDefs) {
    const w = tileToWorld(def.tile[0], def.tile[1]);
    const px = w.x + Math.cos(def.angle) * 1.25;
    const pz = w.z + Math.sin(def.angle) * 1.25;
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
    patron.position.set(px, 0.18, pz); // perched on the stool
    patron.rotation.y = Math.atan2(w.x - px, w.z - pz); // face the table

    // Modeled human patron (preferred): swap the box visuals for a KayKit
    // adventurer standing at the stool, keeping the mug in hand. The `patron`
    // Group stays the transform anchor (position + table-facing yaw).
    const pnpc = buildNpcModel(def.cls, def.npcName, { gender: def.gender, skinTone: def.skin });
    if (pnpc) {
      for (let i = patron.children.length - 1; i >= 0; i--) {
        const c = patron.children[i];
        if (c === pMug) { patron.remove(c); pnpc.mesh.add(c); c.position.set(0.24, 1.05, 0.28); }
        else { patron.remove(c); c.geometry?.dispose?.(); }
      }
      pnpc.mesh.position.y = -0.18; // undo the stool-perch lift so feet reach the floor
      patron.add(pnpc.mesh);

      // Body turn (task e): when a player is close, smoothly swivel the
      // whole seated group (as if turning on the stool) to face them, on
      // top of the existing head-glance; ease back to the table-facing
      // "seat" yaw once they step away. seatYaw is captured now, before
      // anything mutates patron.rotation.y.
      const seatYaw = patron.rotation.y;
      const patronDriver = {
        kind: 'firefly', mesh: new THREE.Object3D(), baseY: 0, speed: 1, _phase: 0,
        get phase() { return this._phase; },
        set phase(v) {
          const dt = Math.min(0.1, Math.max(0, v - this._phase));
          this._phase = v;
          pnpc.tick(dt);
          const hero = nearestHero(pnpc.mesh, 6);
          if (hero) pnpc.lookAt(hero.x, hero.z); else pnpc.lookAt(null);
          const targetYaw = (hero && hero.d < 2.5)
            ? Math.atan2(hero.x - patron.position.x, hero.z - patron.position.z)
            : seatYaw;
          patron.rotation.y += wrapAngle(targetYaw - patron.rotation.y) * Math.min(1, dt * 4);
        },
      };
      smokePuffs.push(patronDriver);
    }

    group.add(patron);
    patronMeshes.push({ mesh: patron, x: px, z: pz, drunk: def.name === 'drunk' });
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
  const firebox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 1.3),
    new THREE.MeshBasicMaterial({ color: 0x180c06 }));
  firebox.position.set(-0.22, 0.55, 0);
  const logs = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x2e1c10, roughness: 1 }));
  logs.rotation.x = Math.PI / 2;
  logs.position.set(-0.3, 0.25, 0);
  const logs2 = logs.clone(); logs2.position.set(-0.3, 0.38, 0.12); logs2.rotation.set(Math.PI / 2, 0, 0.2);
  hearth.add(surround, chimney, mantel, mCandle, mFlame, mTankard, firebox, logs, logs2);
  // layered flames that the game loop makes dance
  const flameColors = [0xff6a2a, 0xff9a3a, 0xffc45e];
  let mainFlame = null;
  flameColors.forEach((c, i) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.16 - i * 0.04, 0.42 - i * 0.08, 7),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.95 - i * 0.15 }));
    f.position.set(-0.3, 0.42 + i * 0.1, (i - 1) * 0.16);
    hearth.add(f);
    smokePuffs.push({ mesh: f, baseY: f.position.y, phase: i * 2.1, speed: 4 + i, kind: 'fire' });
    if (i === 0) mainFlame = f;
  });
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
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x5a4a30, roughness: 1 }));
  const exitW = tileToWorld(8, 10);
  mat.position.set(exitW.x, 0.02, exitW.z + 0.6);
  group.add(mat);

  const torchPositions = [
    { x: hw.x - 0.4, y: 1.2, z: hw.z, flame: mainFlame },
    { x: (W * TILE) / 2, y: 1.7, z: TILE * 1.6, flame: mainFlame },
  ];

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
    barkeepPos: { x: keeperPos.x + TILE / 2, z: keeperPos.z + 1.4 },
    patronMeshes,
  };
}
