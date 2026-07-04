import * as THREE from 'three';
import { FLOOR, WALL, DOOR } from './dungeon.js';
import { makeFloorTexture, makeWallTexture, makeWoodTexture } from './textures.js';

export const TILE = 2;          // world units per grid tile
export const WALL_HEIGHT = 3;

export function tileToWorld(tx, ty) {
  return { x: tx * TILE + TILE / 2, z: ty * TILE + TILE / 2 };
}
export function worldToTile(x, z) {
  return { tx: Math.floor(x / TILE), ty: Math.floor(z / TILE) };
}

let woodTex = null;

export function buildDungeonMeshes(dungeon, theme) {
  const group = new THREE.Group();
  const { grid, size } = dungeon;

  const floorTex = makeFloorTexture(theme);
  const wallTex = makeWallTexture(theme);
  if (!woodTex) woodTex = makeWoodTexture();

  // --- Floors (instanced) ---
  const floorTiles = [];
  const wallTiles = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = grid[y][x];
      if (t === FLOOR || t === DOOR) floorTiles.push({ x, y });
      else if (t === WALL) wallTiles.push({ x, y });
    }
  }

  const floorGeo = new THREE.BoxGeometry(TILE, 0.2, TILE);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 });
  const floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, floorTiles.length);
  const m = new THREE.Matrix4();
  floorTiles.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, -0.1, w.z);
    floorMesh.setMatrixAt(i, m);
  });
  floorMesh.instanceMatrix.needsUpdate = true;
  floorMesh.receiveShadow = false;
  group.add(floorMesh);

  // --- Walls (instanced) ---
  const wallGeo = new THREE.BoxGeometry(TILE, WALL_HEIGHT, TILE);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, wallTiles.length);
  wallTiles.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, WALL_HEIGHT / 2, w.z);
    wallMesh.setMatrixAt(i, m);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  group.add(wallMesh);

  // --- Doors ---
  const doorMeshes = new Map();
  const doorMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 });
  for (const d of dungeon.doors) {
    const w = tileToWorld(d.x, d.y);
    const geo = d.vertical
      ? new THREE.BoxGeometry(TILE * 0.9, 2.4, 0.3)
      : new THREE.BoxGeometry(0.3, 2.4, TILE * 0.9);
    const mesh = new THREE.Mesh(geo, doorMat);
    mesh.position.set(w.x, 1.2, w.z);
    group.add(mesh);
    doorMeshes.set(`${d.x},${d.y}`, mesh);
  }

  // --- Torches (sconce + flame; lights are pooled by the game) ---
  const torchPositions = [];
  const sconceGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 6);
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1 });
  const flameGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const flameMat = new THREE.MeshBasicMaterial({ color: theme.accent });
  for (const t of dungeon.torches) {
    const w = tileToWorld(t.fx, t.fy);
    const sconce = new THREE.Mesh(sconceGeo, sconceMat);
    sconce.position.set(w.x, 1.6, w.z);
    group.add(sconce);
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(w.x, 1.95, w.z);
    group.add(flame);
    torchPositions.push({ x: w.x, y: 2.0, z: w.z, flame });
  }

  // --- Chests ---
  const chestMeshes = [];
  const chestBodyGeo = new THREE.BoxGeometry(0.9, 0.55, 0.6);
  const chestLidGeo = new THREE.BoxGeometry(0.9, 0.25, 0.6);
  const chestMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.7 });
  const chestTrimMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.4 });
  for (const c of dungeon.chests) {
    const w = tileToWorld(c.x, c.y);
    const chest = new THREE.Group();
    const body = new THREE.Mesh(chestBodyGeo, chestMat);
    body.position.y = 0.28;
    const lid = new THREE.Mesh(chestLidGeo, chestMat);
    lid.position.set(0, 0.62, 0);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.1, 0.64), chestTrimMat);
    trim.position.y = 0.5;
    chest.add(body, lid, trim);
    chest.position.set(w.x, 0, w.z);
    chest.rotation.y = Math.random() * Math.PI * 2;
    group.add(chest);
    chestMeshes.push({ mesh: chest, lid, tile: c, opened: false, x: w.x, z: w.z });
  }

  // --- Stairs down ---
  let stairsMesh = null;
  if (dungeon.stairs) {
    const w = tileToWorld(dungeon.stairs.x, dungeon.stairs.y);
    stairsMesh = new THREE.Group();
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.35), stepMat);
      step.position.set(0, -i * 0.14, -0.5 + i * 0.35);
      stairsMesh.add(step);
    }
    // glowing portal ring to make it unmissable
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.06, 8, 24),
      new THREE.MeshBasicMaterial({ color: theme.accent })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    stairsMesh.add(ring);
    stairsMesh.position.set(w.x, 0, w.z);
    group.add(stairsMesh);
  }

  return { group, doorMeshes, chestMeshes, stairsMesh, torchPositions };
}
