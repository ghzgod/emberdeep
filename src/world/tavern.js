import * as THREE from 'three';
import { FLOOR, WALL } from './dungeon.js';
import { TILE, tileToWorld } from './meshbuilder.js';
import { makeWoodTexture } from './textures.js';

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

  // ceiling beams
  for (let i = 1; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W * TILE - 2, 0.18, 0.24), darkWood);
    beam.position.set((W * TILE) / 2, wallH - 0.1, i * (H * TILE) / 4);
    group.add(beam);
  }

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

  // ---- Barlow the barkeep: face, mustache, apron, towel ----
  const keeper = new THREE.Group();
  const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.85 }));
  kBody.position.y = 0.74;
  const kApron = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 1 }));
  kApron.position.set(0, 0.72, 0.3);
  const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), skinMat);
  kHead.position.y = 1.4;
  const kNose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), skinMat);
  kNose.position.set(0, 1.38, 0.21);
  const kEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), new THREE.MeshBasicMaterial({ color: 0x2a1e14 }));
  kEyeL.position.set(-0.08, 1.44, 0.19);
  const kEyeR = kEyeL.clone(); kEyeR.position.x = 0.08;
  const kBrowMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1 });
  const kMust = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.045, 0.04), kBrowMat);
  kMust.position.set(0, 1.31, 0.2);
  const kSideL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.1), kBrowMat);
  kSideL.position.set(-0.2, 1.36, 0.05);
  const kSideR = kSideL.clone(); kSideR.position.x = 0.2;
  const kArmL = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.34, 3, 6), skinMat);
  kArmL.position.set(-0.34, 0.98, 0.12);
  kArmL.rotation.z = 0.7;
  const kArmR = kArmL.clone(); kArmR.position.x = 0.34; kArmR.rotation.z = -0.7;
  const towel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 1 }));
  towel.position.set(-0.45, 0.85, 0.16);
  keeper.add(kBody, kApron, kHead, kNose, kEyeL, kEyeR, kMust, kSideL, kSideR, kArmL, kArmR, towel);
  const keeperPos = tileToWorld(5.5, 0.6);
  keeper.position.set(keeperPos.x + TILE / 2, 0, keeperPos.z);
  keeper.rotation.y = Math.PI;
  group.add(keeper);

  // shelves with bottles behind the bar
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 0.1, 0.4), darkWood);
  shelf.position.set(barCenter.x + TILE / 2, 1.8, TILE * 0.55);
  group.add(shelf);
  const bottleColors = [0xd93a3a, 0x3ad95a, 0x3a7ad9, 0xd9b03a, 0xb03ad9];
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.3, 6),
      new THREE.MeshStandardMaterial({ color: bottleColors[i % bottleColors.length], roughness: 0.3 }));
    b.position.set(barCenter.x - 4.6 + i * 1.05, 2.0, TILE * 0.55);
    group.add(b);
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
