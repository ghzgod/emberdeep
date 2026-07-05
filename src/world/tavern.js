import * as THREE from 'three';
import { FLOOR, WALL } from './dungeon.js';
import { TILE, tileToWorld } from './meshbuilder.js';
import { makeWoodTexture } from './textures.js';

// "The Sleeping Golem" — the tavern interior. A small, warm, safe room.
// Fixed layout: 12 x 9 tiles, door at the south, hearth on the east wall.
const W = 12, H = 9;

export function generateTavernInterior() {
  const grid = Array.from({ length: H }, (_, y) =>
    new Array(W).fill(0).map((_, x) =>
      (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? WALL : FLOOR));
  return {
    grid, size: Math.max(W, H), rooms: [],
    spawn: { x: 6, y: 6 },
    exit: { x: 6, y: 7 },          // stand here to leave
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

  // floor planks
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W * TILE, 0.2, H * TILE), plankMat);
  floor.position.set((W * TILE) / 2, -0.1, (H * TILE) / 2);
  group.add(floor);

  // perimeter walls
  const wallH = 2.6;
  const mkWall = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), plasterMat);
    m.position.set(x, wallH / 2, z);
    group.add(m);
  };
  mkWall(W * TILE, TILE, (W * TILE) / 2, TILE / 2);                 // north
  mkWall(TILE, H * TILE, TILE / 2, (H * TILE) / 2);                 // west
  mkWall(TILE, H * TILE, W * TILE - TILE / 2, (H * TILE) / 2);      // east
  // south wall with a door gap at x tile 6
  mkWall(5 * TILE, TILE, 2.5 * TILE + TILE / 2, H * TILE - TILE / 2);
  mkWall(4.5 * TILE, TILE, W * TILE - 2.25 * TILE, H * TILE - TILE / 2);

  // ceiling beams (visible at our camera angle near walls)
  for (let i = 1; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W * TILE - 2, 0.18, 0.24), darkWood);
    beam.position.set((W * TILE) / 2, wallH - 0.1, i * (H * TILE) / 4);
    group.add(beam);
  }

  // bar counter along the north wall + innkeeper
  const bar = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 1.0, 0.8), darkWood);
  bar.position.set((W * TILE) / 2, 0.5, TILE * 1.6);
  group.add(bar);
  const keeper = new THREE.Group();
  const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.5, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.85 }));
  kBody.position.y = 0.72;
  const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8ab88 }));
  kHead.position.y = 1.36;
  const kEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), new THREE.MeshBasicMaterial({ color: 0x1a1a1a }));
  kEyeL.position.set(-0.07, 1.4, 0.19);
  const kEyeR = kEyeL.clone(); kEyeR.position.x = 0.07;
  const apron = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 1 }));
  apron.position.set(0, 0.7, 0.28);
  keeper.add(kBody, kHead, kEyeL, kEyeR, apron);
  keeper.position.set((W * TILE) / 2, 0, TILE * 1.0);
  keeper.rotation.y = Math.PI; // faces the room
  group.add(keeper);

  // shelves with bottles behind the bar
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(6 * TILE, 0.1, 0.4), darkWood);
  shelf.position.set((W * TILE) / 2, 1.7, TILE * 0.65);
  group.add(shelf);
  const bottleColors = [0xd93a3a, 0x3ad95a, 0x3a7ad9, 0xd9b03a, 0xb03ad9];
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.3, 6),
      new THREE.MeshStandardMaterial({ color: bottleColors[i % bottleColors.length], roughness: 0.3 }));
    b.position.set((W * TILE) / 2 - 5 + i * 1.05, 1.9, TILE * 0.65);
    group.add(b);
  }

  // round tables with stools
  const tableSpots = [[3.2, 4.6], [8.6, 4.4], [5.8, 5.9]];
  for (const [tx, tz] of tableSpots) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.8, 6), darkWood);
    leg.position.set(tx * TILE / 2 + 2, 0.4, tz * TILE / 2 + 2);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.09, 12), plankMat);
    top.position.set(leg.position.x, 0.85, leg.position.z);
    group.add(leg, top);
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + tx;
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 8), darkWood);
      stool.position.set(leg.position.x + Math.cos(a) * 1.15, 0.25, leg.position.z + Math.sin(a) * 1.15);
      group.add(stool);
    }
    // a mug on the table
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.5, roughness: 0.5 }));
    mug.position.set(top.position.x + 0.2, 0.97, top.position.z);
    group.add(mug);
  }

  // hearth on the east wall
  const hearth = new THREE.Group();
  const surround = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 }));
  surround.position.y = 0.9;
  const firebox = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 1.2),
    new THREE.MeshBasicMaterial({ color: 0x180c06 }));
  firebox.position.set(-0.2, 0.5, 0);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff9a3a }));
  flame.position.set(-0.25, 0.45, 0);
  hearth.add(surround, firebox, flame);
  hearth.position.set(W * TILE - TILE - 0.3, 0, (H * TILE) / 2);
  group.add(hearth);

  // rug in front of the hearth
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.4, 16),
    new THREE.MeshStandardMaterial({ color: 0x7a2e2e, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(W * TILE - TILE * 2.6, 0.02, (H * TILE) / 2);
  group.add(rug);

  // exit doormat at the south gap
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x5a4a30, roughness: 1 }));
  const exitW = tileToWorld(6, 7);
  mat.position.set(exitW.x, 0.02, exitW.z + 0.6);
  group.add(mat);

  // warm hearth + candle light positions (game's torch light pool)
  const torchPositions = [
    { x: W * TILE - TILE - 0.6, y: 1.2, z: (H * TILE) / 2, flame },
    { x: (W * TILE) / 2, y: 1.6, z: TILE * 1.6, flame: null },
  ].map((t) => ({ ...t, flame: t.flame || flame }));

  return {
    group,
    doorMeshes: new Map(),
    chestMeshes: [],
    stairsMesh: null,
    torchPositions,
    vendorMeshes: [],
    portalMesh: null,
    returnPortalMesh: null,
    smokePuffs: [],
  };
}
