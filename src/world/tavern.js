import * as THREE from 'three';
import { FLOOR, WALL } from './dungeon.js';
import { TILE, tileToWorld } from './meshbuilder.js';
import { makeWoodTexture, makePaintingTexture } from './textures.js';

// "The Sleeping Golem" — the tavern interior. Warm, safe, and populated.
// 12 x 9 tiles. Furniture occupies solid (WALL) tiles so you can't walk
// through the bar; patrons and the barkeep can be chatted with.
const W = 12, H = 9;

// solid furniture tiles (collision): bar row, two tables, the hearth
const BAR_TILES = [[3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]];
const TABLE_TILES = [[3, 4], [8, 4]];
const HEARTH_TILES = [[10, 4]];

export function generateTavernInterior() {
  const grid = Array.from({ length: H }, (_, y) =>
    new Array(W).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? WALL : FLOOR));
  for (const [x, y] of [...BAR_TILES, ...TABLE_TILES, ...HEARTH_TILES]) grid[y][x] = WALL;
  return {
    grid, size: Math.max(W, H), rooms: [],
    spawn: { x: 6, y: 6 },
    exit: { x: 6, y: 7 },
    barkeep: { x: 5, y: 2 },     // stands in front of the bar's left side? no — behind: see mesh
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
  const plankMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.95 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.85 });
  const smokePuffs = [];

  // floor planks
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W * TILE, 0.2, H * TILE), plankMat);
  floor.position.set((W * TILE) / 2, -0.1, (H * TILE) / 2);
  group.add(floor);

  // perimeter walls with a south door gap
  const wallH = 2.6;
  const mkWall = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), plasterMat);
    m.position.set(x, wallH / 2, z);
    group.add(m);
  };
  mkWall(W * TILE, TILE, (W * TILE) / 2, TILE / 2);
  mkWall(TILE, H * TILE, TILE / 2, (H * TILE) / 2);
  mkWall(TILE, H * TILE, W * TILE - TILE / 2, (H * TILE) / 2);
  mkWall(5 * TILE, TILE, 2.5 * TILE + TILE / 2, H * TILE - TILE / 2);
  mkWall(4.5 * TILE, TILE, W * TILE - 2.25 * TILE, H * TILE - TILE / 2);

  // framed procedural paintings on the side walls (each is a unique dusk scene)
  const mkPainting = (x, z, roty) => {
    const p = new THREE.Group();
    p.add(new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.72, 0.05), darkWood));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.58), new THREE.MeshStandardMaterial({ map: makePaintingTexture(), roughness: 0.9 }));
    art.position.z = 0.03;
    p.add(art);
    p.position.set(x, 1.55, z); p.rotation.y = roty;
    group.add(p);
  };
  mkPainting(TILE + 0.04, 2.2 * TILE, Math.PI / 2);          // west wall
  mkPainting(TILE + 0.04, 5.4 * TILE, Math.PI / 2);
  mkPainting(W * TILE - TILE - 0.04, 3.4 * TILE, -Math.PI / 2); // east wall

  // ---- the bar (on BAR_TILES row) ----
  const barCenter = tileToWorld(5.5, 1);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 1.05, 1.2), darkWood);
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

  // ---- Barlow the barkeep: a jolly, ruddy, big-bearded innkeeper, built to
  // READ from the overhead camera — he faces the customer (+z) and his head
  // tips up so the face catches the top-down view (the old one faced the wall). ----
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
  const keeperPos = tileToWorld(5.5, 0.55);
  keeper.position.set(keeperPos.x + TILE / 2, 0, keeperPos.z);
  keeper.rotation.y = 0; // face the customer side (+z), not the back wall
  group.add(keeper);

  // ---- back-bar: two shelves stocked with bottles, spirits, wine + glasses ----
  const glassMat = (c, o = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.1, transparent: true, opacity: o });
  const corkMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 1 });
  const shelfZ = TILE * 0.55;
  for (const sy of [1.55, 1.98]) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 0.08, 0.42), darkWood);
    shelf.position.set(barCenter.x + TILE / 2, sy, shelfZ);
    group.add(shelf);
  }
  const wineReds = [0x5a0f1a, 0x7a1420];
  const spiritCols = [0xcaa14a, 0x3a6ad9, 0x2a8a4a, 0x8a3ad9, 0xb05a2a];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const placeBottle = (x, y, kind) => {
    const b = new THREE.Group();
    if (kind === 'wine') {
      b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.26, 8), glassMat(pick(wineReds), 0.9)));
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.14, 6), glassMat(0x24361c, 0.95)); neck.position.y = 0.2; b.add(neck);
    } else if (kind === 'flask') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), glassMat(pick(spiritCols))); body.scale.y = 0.92; b.add(body);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.12, 6), corkMat); neck.position.y = 0.13; b.add(neck);
    } else {
      b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.32, 8), glassMat(pick(spiritCols))));
      const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 6), corkMat); cork.position.y = 0.185; b.add(cork);
    }
    b.position.set(x, y, shelfZ);
    group.add(b);
  };
  const kinds = ['wine', 'tall', 'flask'];
  for (let i = 0; i < 11; i++) placeBottle(barCenter.x - 4.7 + i * 0.95, 1.78, kinds[i % 3]);
  for (let i = 0; i < 9; i++) placeBottle(barCenter.x - 4.2 + i * 1.05, 2.2, kinds[(i + 1) % 3]);
  // filled wine glasses on the top shelf
  for (let i = 0; i < 4; i++) {
    const glass = new THREE.Group();
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 0.09, 8), glassMat(0xdddddd, 0.35));
    const wine = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.02, 0.05, 8), glassMat(0x6a0f1a, 0.9)); wine.position.y = -0.015;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 5), glassMat(0xdddddd, 0.35)); stem.position.y = -0.085;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.008, 8), glassMat(0xdddddd, 0.35)); foot.position.y = -0.13;
    glass.add(bowl, wine, stem, foot);
    glass.position.set(barCenter.x - 3.5 + i * 2.0, 2.3, shelfZ + 0.02);
    group.add(glass);
  }
  // a wooden cask resting on the floor behind the bar
  const cask = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.7, 12), plankMat);
  cask.rotation.z = Math.PI / 2; cask.position.set(barCenter.x - 2.2, 0.34, shelfZ + 0.1);
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.02, 6, 14), new THREE.MeshStandardMaterial({ color: 0x3a3a40, metalness: 0.5, roughness: 0.5 }));
  hoop.position.copy(cask.position); hoop.rotation.y = Math.PI / 2;
  group.add(cask, hoop);
  // iron chandelier with flickering candles over the room
  const chand = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 6, 16), new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.5, roughness: 0.6 }));
  ring.rotation.x = Math.PI / 2; chand.add(ring);
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0x2a2a30 }));
  chain.position.y = 0.2; chand.add(chain);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.12, 6), new THREE.MeshStandardMaterial({ color: 0xe8e0c8 }));
    candle.position.set(Math.cos(a) * 0.5, 0.08, Math.sin(a) * 0.5); chand.add(candle);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffc45e }));
    flame.position.set(Math.cos(a) * 0.5, 0.18, Math.sin(a) * 0.5); chand.add(flame);
    smokePuffs.push({ mesh: flame, baseY: 0.18, phase: i * 1.3, speed: 3.5, kind: 'fire' });
  }
  chand.position.set((W * TILE) / 2, 2.3, (H * TILE) / 2);
  group.add(chand);

  // ---- warm interior lighting: the room should glow, not sit in shadow ----
  const warmLight = (color, intensity, dist, x, y, z) => {
    const l = new THREE.PointLight(color, intensity, dist, 2);
    l.position.set(x, y, z);
    group.add(l);
  };
  warmLight(0xffb464, 26, 14, (W * TILE) / 2, 2.1, (H * TILE) / 2);          // under the chandelier
  warmLight(0xffc884, 22, 9, barCenter.x + TILE / 2, 1.9, shelfZ + 0.45);    // behind the bar (lights Barlow + shelves)
  warmLight(0xffa860, 16, 8, 3.5 * TILE, 1.9, 6 * TILE);                     // near the entrance

  // ---- glowing back-bar panel so the bottles silhouette and read ----
  const backPanel = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 1.3, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.7, emissive: 0x3a1c0a, emissiveIntensity: 0.5 }));
  backPanel.position.set(barCenter.x + TILE / 2, 1.85, shelfZ - 0.28);
  group.add(backPanel);
  // a carved stone golem head mounted over the bar — the tavern's namesake
  const trophy = new THREE.Group();
  const gHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.42), new THREE.MeshStandardMaterial({ color: 0x6b6660, roughness: 1 }));
  const gBrow = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 }));
  gBrow.position.set(0, 0.12, 0.2);
  const gEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffb24a })); gEyeL.position.set(-0.13, 0.02, 0.22);
  const gEyeR = gEyeL.clone(); gEyeR.position.x = 0.13;
  const gJaw = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.36), new THREE.MeshStandardMaterial({ color: 0x565049, roughness: 1 })); gJaw.position.set(0, -0.24, 0.02);
  trophy.add(gHead, gBrow, gEyeL, gEyeR, gJaw);
  trophy.position.set(barCenter.x + TILE / 2, 2.5, shelfZ - 0.2);
  group.add(trophy);

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
  }

  // ---- patrons: seated regulars with faces and drinks ----
  const patronDefs = [
    { tile: [3, 4], angle: 0.9, robe: 0x5a4a6a, hair: 0x3a2a1a, name: 'patron' },
    { tile: [8, 4], angle: -2.0, robe: 0x4a5a3a, hair: 0x999999, name: 'drunk' },
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
    group.add(patron);
    patronMeshes.push({ mesh: patron, x: px, z: pz, drunk: def.name === 'drunk' });
  }

  // ---- hearth with living fire ----
  const hearth = new THREE.Group();
  const surround = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.9, 2.4),
    new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 }));
  surround.position.y = 0.95;
  const firebox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 1.3),
    new THREE.MeshBasicMaterial({ color: 0x180c06 }));
  firebox.position.set(-0.22, 0.55, 0);
  const logs = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x2e1c10, roughness: 1 }));
  logs.rotation.x = Math.PI / 2;
  logs.position.set(-0.3, 0.25, 0);
  hearth.add(surround, firebox, logs);
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
  const exitW = tileToWorld(6, 7);
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
