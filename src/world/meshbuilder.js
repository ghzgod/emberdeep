import * as THREE from 'three';
import { FLOOR, WALL, DOOR, PIT, BRIDGE, RUBBLE, CHASM } from './dungeon.js';
import { makeFloorTexture, makeWallTexture, makeWoodTexture, makeGrassTexture, makeCobbleTexture, makeCobwebTexture } from './textures.js';

// Built once, shared by every cobweb prop (cheap; avoids a canvas per web).
let _cobwebTex = null;
const cobwebTexture = () => (_cobwebTex ||= makeCobwebTexture());

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

  const town = !!dungeon.town;
  const floorTex = town ? makeGrassTexture() : makeFloorTexture(theme);
  const wallTex = makeWallTexture(theme);
  if (!woodTex) woodTex = makeWoodTexture();

  // --- Floors (instanced) ---
  const floorTiles = [];
  const wallTiles = [];
  const chasmT = [], bridgeT = [], rubbleT = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = grid[y][x];
      if (t === FLOOR || t === DOOR) floorTiles.push({ x, y });
      else if (t === BRIDGE) bridgeT.push({ x, y });
      else if (t === RUBBLE) { rubbleT.push({ x, y }); floorTiles.push({ x, y }); } // floor under rubble
      else if (t === CHASM) chasmT.push({ x, y });
      else if (t === WALL) {
        wallTiles.push({ x, y });
        if (town) floorTiles.push({ x, y }); // grass under trees/tavern/walls
      }
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

  // --- Chasms: a recessed dark abyss below the floor plane ---
  if (chasmT.length) {
    const abyss = new THREE.MeshStandardMaterial({ color: 0x05040a, roughness: 1, metalness: 0 });
    const abyssGeo = new THREE.BoxGeometry(TILE, 0.2, TILE);
    const abyssMesh = new THREE.InstancedMesh(abyssGeo, abyss, chasmT.length);
    chasmT.forEach((tp, i) => {
      const w = tileToWorld(tp.x, tp.y);
      m.setPosition(w.x, -2.4, w.z); // sunken far below
      abyssMesh.setMatrixAt(i, m);
    });
    abyssMesh.instanceMatrix.needsUpdate = true;
    group.add(abyssMesh);
    // dark side walls around the pit rim for depth
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x120e18, roughness: 1 });
    const rimGeo = new THREE.BoxGeometry(TILE, 2.6, 0.12);
    for (const tp of chasmT) {
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        const nt = grid[tp.y + dy]?.[tp.x + dx];
        if (nt === FLOOR || nt === BRIDGE || nt === DOOR) {
          const w = tileToWorld(tp.x, tp.y);
          const wall = new THREE.Mesh(rimGeo, rimMat);
          wall.position.set(w.x + dx * TILE / 2, -1.2, w.z + dy * TILE / 2);
          wall.rotation.y = rot;
          group.add(wall);
        }
      }
    }
  }

  // --- Bridges: raised wooden planks with side rails, over the chasm ---
  if (bridgeT.length) {
    if (!woodTex) woodTex = makeWoodTexture();
    const plankMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
    const plankGeo = new THREE.BoxGeometry(TILE, 0.16, TILE);
    const plankMesh = new THREE.InstancedMesh(plankGeo, plankMat, bridgeT.length);
    bridgeT.forEach((tp, i) => {
      const w = tileToWorld(tp.x, tp.y);
      m.setPosition(w.x, 0.02, w.z);
      plankMesh.setMatrixAt(i, m);
    });
    plankMesh.instanceMatrix.needsUpdate = true;
    group.add(plankMesh);
    // low rope rails along bridge edges that border a chasm
    const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
    const railGeo = new THREE.BoxGeometry(TILE, 0.4, 0.08);
    for (const tp of bridgeT) {
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        if (grid[tp.y + dy]?.[tp.x + dx] === CHASM) {
          const w = tileToWorld(tp.x, tp.y);
          const rail = new THREE.Mesh(railGeo, railMat);
          rail.position.set(w.x + dx * TILE / 2, 0.3, w.z + dy * TILE / 2);
          rail.rotation.y = rot;
          group.add(rail);
        }
      }
    }
  }

  // --- Broken walls: crumbled rubble piles instead of full masonry ---
  if (rubbleT.length) {
    const rubbleMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 });
    for (const tp of rubbleT) {
      const w = tileToWorld(tp.x, tp.y);
      // a low broken stub + scattered chunks
      const stub = new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.6 + Math.random() * 0.6, TILE), rubbleMat);
      stub.position.set(w.x, stub.geometry.parameters.height / 2, w.z);
      stub.rotation.y = (Math.random() - 0.5) * 0.3;
      group.add(stub);
      for (let c = 0; c < 4; c++) {
        const s = 0.18 + Math.random() * 0.24;
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rubbleMat);
        chunk.position.set(w.x + (Math.random() - 0.5) * 1.4, s * 0.3, w.z + (Math.random() - 0.5) * 1.4);
        chunk.rotation.set(Math.random(), Math.random(), Math.random());
        group.add(chunk);
      }
    }
  }

  // --- Walls (instanced) ---
  // In town: only the perimeter gets a low garden wall; interior solid tiles
  // are covered by trees/the tavern instead of dungeon masonry.
  let renderWalls = wallTiles;
  let wallH = WALL_HEIGHT;
  if (town) {
    wallH = 1.0;
    renderWalls = wallTiles.filter((tp) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = grid[tp.y + dy]?.[tp.x + dx];
        if (t === undefined || t === 0) return true; // touches the void edge
      }
      return false;
    });
  }
  const wallGeo = new THREE.BoxGeometry(TILE, wallH, TILE);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, flatShading: true });
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, renderWalls.length);
  renderWalls.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, wallH / 2, w.z);
    wallMesh.setMatrixAt(i, m);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  group.add(wallMesh);

  // Dungeon walls get an inset capstone course on top so the silhouette steps
  // instead of reading as one plain extruded cube.
  if (!town && renderWalls.length) {
    const capGeo = new THREE.BoxGeometry(TILE * 0.84, 0.34, TILE * 0.84);
    const capMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1, flatShading: true });
    const capMesh = new THREE.InstancedMesh(capGeo, capMat, renderWalls.length);
    renderWalls.forEach((tp, i) => {
      const w = tileToWorld(tp.x, tp.y);
      m.setPosition(w.x, wallH - 0.05, w.z);
      capMesh.setMatrixAt(i, m);
    });
    capMesh.instanceMatrix.needsUpdate = true;
    group.add(capMesh);
  }

  // --- Town: cobbled square + lane ---
  if (town && dungeon.cobbles?.length) {
    const cobbleGeo = new THREE.BoxGeometry(TILE, 0.06, TILE);
    const cobbleMat = new THREE.MeshStandardMaterial({ map: makeCobbleTexture(), roughness: 0.95 });
    const cobbleMesh = new THREE.InstancedMesh(cobbleGeo, cobbleMat, dungeon.cobbles.length);
    dungeon.cobbles.forEach((c, i) => {
      const w = tileToWorld(c.x, c.y);
      m.setPosition(w.x, 0.02, w.z);
      cobbleMesh.setMatrixAt(i, m);
    });
    cobbleMesh.instanceMatrix.needsUpdate = true;
    group.add(cobbleMesh);
  }

  // --- Town: trees, plants, well, tavern ---
  const smokePuffs = [];
  if (town) buildTownDecor(group, dungeon, smokePuffs);

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

  // --- Torches (dungeon) / lamp posts (town); lights are pooled by the game ---
  const torchPositions = [];
  if (town) {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.8 });
    for (const t of dungeon.torches) {
      const w = tileToWorld(t.fx, t.fy);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.2, 6), postMat);
      post.position.set(w.x, 1.1, w.z);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 6), postMat);
      cap.position.set(w.x, 2.36, w.z);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.26, 0.2),
        new THREE.MeshBasicMaterial({ color: 0xffc978 })
      );
      glass.position.set(w.x, 2.16, w.z);
      group.add(post, cap, glass);
      torchPositions.push({ x: w.x, y: 2.2, z: w.z, flame: glass });
    }
  } else {
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

  // --- Environmental variety: scuff decals, rubble piles, pit holes ---
  if (dungeon.scuffs?.length) {
    const scuffMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    for (const s of dungeon.scuffs) {
      const w = tileToWorld(s.x, s.y);
      const decal = new THREE.Mesh(new THREE.CircleGeometry(s.s, 10), scuffMat);
      decal.rotation.x = -Math.PI / 2;
      decal.rotation.z = s.r;
      decal.scale.x = 1.6; // elongated drag/scorch mark
      decal.position.set(w.x, 0.015, w.z);
      group.add(decal);
    }
  }
  if (dungeon.rubble?.length) {
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x55525c, roughness: 1 });
    for (const r of dungeon.rubble) {
      const w = tileToWorld(r.x, r.y);
      for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
        const s = 0.1 + Math.random() * 0.2;
        const rock = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rubbleMat);
        rock.position.set(w.x + (Math.random() - 0.5) * 1.2, s * 0.3, w.z + (Math.random() - 0.5) * 1.2);
        rock.rotation.y = Math.random() * Math.PI;
        group.add(rock);
      }
    }
  }
  if (dungeon.pits?.length) {
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a262f, roughness: 1 });
    for (const p of dungeon.pits) {
      const w = tileToWorld(p.x, p.y);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.85, 12), holeMat);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(w.x, 0.02, w.z);
      group.add(hole);
      // jagged rim stones
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const stone = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.3), rimMat);
        stone.position.set(w.x + Math.cos(a) * 0.9, 0.05, w.z + Math.sin(a) * 0.9);
        stone.rotation.y = a + Math.random() * 0.5;
        group.add(stone);
      }
    }
  }

  // --- Town features: vendor stalls + dungeon portal ---
  const vendorMeshes = [];
  if (dungeon.town) {
    // shared skin tone material reused across all three keepers
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.8 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1410 });
    for (const v of dungeon.vendors) {
      const w = tileToWorld(v.x, v.y);
      const stall = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.6), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 }));
      counter.position.y = 0.4;
      const poleL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0x5a4028 }));
      poleL.position.set(-0.75, 1.1, -0.25);
      const poleR = poleL.clone(); poleR.position.x = 0.75;
      const canopyColor = v.type === 'potions' ? 0xb03a4a : v.type === 'mystery' ? 0x6a2a9a : 0x3a5ab0;
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 1.0), new THREE.MeshStandardMaterial({ color: canopyColor, roughness: 0.7 }));
      canopy.position.set(0, 2.2, -0.1);
      stall.add(counter, poleL, poleR, canopy);

      // --- shopkeeper: readable face + real character per vendor, built to
      // read from the overhead camera (big eyes, head tipped up, hands on the
      // counter instead of arms splayed out like poles) ---
      const keeper = new THREE.Group();
      const bodyColor = v.type === 'potions' ? 0x8a5566 : v.type === 'gear' ? 0x5a4436 : 0x2a2038;
      const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.95 });
      const browMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1 });
      const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 5, 10), new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 }));
      kBody.position.y = 0.78;
      // head on a pivot tipped up so the face catches the top-down view
      const kHeadGrp = new THREE.Group();
      kHeadGrp.position.y = 1.42; kHeadGrp.rotation.x = -0.2;
      const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 14), skinMat);
      const eyeWL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), whiteMat); eyeWL.position.set(-0.1, 0.0, 0.2);
      const eyeWR = eyeWL.clone(); eyeWR.position.x = 0.1;
      const pupL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), eyeMat); pupL.position.set(-0.1, 0.0, 0.24);
      const pupR = pupL.clone(); pupR.position.x = 0.1;
      const browL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.06), browMat); browL.position.set(-0.1, 0.08, 0.21); browL.rotation.z = 0.12;
      const browR = browL.clone(); browR.position.x = 0.1; browR.rotation.z = -0.12;
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), skinMat); nose.position.set(0, -0.04, 0.24);
      kHeadGrp.add(kHead, eyeWL, eyeWR, pupL, pupR, browL, browR, nose);
      // arms resting forward with hands on the counter (not splayed outward)
      const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
      const armGeo = new THREE.CapsuleGeometry(0.085, 0.34, 4, 8);
      const armL = new THREE.Mesh(armGeo, armMat); armL.position.set(-0.24, 0.9, 0.26); armL.rotation.set(1.2, 0, 0.22);
      const armR = new THREE.Mesh(armGeo, armMat); armR.position.set(0.24, 0.9, 0.26); armR.rotation.set(1.2, 0, -0.22);
      const handMat = new THREE.MeshStandardMaterial({ color: 0xd8ab88, roughness: 0.85 });
      const handGeo = new THREE.SphereGeometry(0.07, 8, 8);
      const handL = new THREE.Mesh(handGeo, handMat); handL.position.set(-0.18, 0.94, 0.5);
      const handR = new THREE.Mesh(handGeo, handMat); handR.position.set(0.18, 0.94, 0.5);
      keeper.add(kBody, kHeadGrp, armL, armR, handL, handR);

      if (v.type === 'potions') {
        // Maribel: kindly herbalist — wide-brim hat, auburn hair, warm apron
        const hair = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 1 }));
        hair.position.set(0, 0.02, -0.02); kHeadGrp.add(hair);
        const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.05, 14), new THREE.MeshStandardMaterial({ color: 0x556038, roughness: 0.9 }));
        brim.position.y = 0.16; kHeadGrp.add(brim);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.34, 12), new THREE.MeshStandardMaterial({ color: 0x64703f, roughness: 0.9 }));
        cone.position.y = 0.34; kHeadGrp.add(cone);
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.08), new THREE.MeshStandardMaterial({ color: 0xd4a85a, roughness: 0.9 }));
        apron.position.set(0, 0.66, 0.24); keeper.add(apron);
        // braid hanging out from under the hat
        const braid = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 6), new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 1 }));
        braid.position.set(0, -0.13, -0.24); braid.rotation.x = 0.35; kHeadGrp.add(braid);
      } else if (v.type === 'gear') {
        // Torvald: burly bald smith — big black beard, red bandana, sooty apron
        kBody.scale.set(1.25, 1, 1.1); kBody.position.y = 0.74;
        armL.scale.setScalar(1.35); armR.scale.setScalar(1.35);
        const bald = new THREE.Mesh(new THREE.SphereGeometry(0.245, 14, 10), skinMat); bald.position.y = 0.01; kHeadGrp.add(bald);
        const bandana = new THREE.Mesh(new THREE.SphereGeometry(0.255, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), new THREE.MeshStandardMaterial({ color: 0x9a3a2a, roughness: 0.9 }));
        bandana.position.y = 0.05; kHeadGrp.add(bandana);
        const beard = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12, 0, Math.PI * 2, Math.PI * 0.44, Math.PI * 0.56), new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 }));
        beard.position.set(0, -0.13, 0.08); beard.scale.set(1, 1.3, 0.95); kHeadGrp.add(beard);
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.56, 0.09), new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.95 }));
        apron.position.set(0, 0.62, 0.24); keeper.add(apron);
        // soot-dark forearms — a life spent at the forge
        const sootMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.95 });
        const sootGeo = new THREE.CapsuleGeometry(0.075, 0.15, 3, 6);
        const sootL = new THREE.Mesh(sootGeo, sootMat); sootL.position.set(-0.2, 0.92, 0.4); sootL.rotation.set(1.2, 0, 0.22);
        const sootR = new THREE.Mesh(sootGeo, sootMat); sootR.position.set(0.2, 0.92, 0.4); sootR.rotation.set(1.2, 0, -0.22);
        keeper.add(sootL, sootR);
      } else {
        // Zoltan: hooded seer — face lost in shadow, glowing eyes, floating orb
        kHead.material = new THREE.MeshStandardMaterial({ color: 0x171320, roughness: 0.9 });
        const glowEye = new THREE.MeshBasicMaterial({ color: 0xb884ff });
        eyeWL.material = glowEye; eyeWR.material = glowEye; eyeWL.scale.setScalar(0.85); eyeWR.scale.setScalar(0.85);
        pupL.visible = pupR.visible = browL.visible = browR.visible = nose.visible = false;
        const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0x2a2038, roughness: 0.85 }));
        hood.position.y = 0.12; kHeadGrp.add(hood);
        const cowl = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.07, 8, 16), new THREE.MeshStandardMaterial({ color: 0x241c34, roughness: 0.85 }));
        cowl.rotation.x = Math.PI / 2 - 0.3; cowl.position.set(0, -0.02, 0.12); kHeadGrp.add(cowl);
        const robe = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.95, 10), new THREE.MeshStandardMaterial({ color: 0x241c34, roughness: 0.85, emissive: 0x3a1a55, emissiveIntensity: 0.18 }));
        robe.position.y = 0.5; keeper.add(robe);
        // star-speckled robe: small glowing flecks scattered over the cone,
        // riding along with it (children of the robe, so no extra transforms)
        const starMat = new THREE.MeshBasicMaterial({ color: 0xe8d8ff });
        const starGeo = new THREE.SphereGeometry(0.013, 4, 4);
        for (let i = 0; i < 9; i++) {
          const sy = -0.35 + Math.random() * 0.75;
          const rad = 0.34 * (0.475 - sy) / 0.95 * 0.9;
          const a = Math.random() * Math.PI * 2;
          const star = new THREE.Mesh(starGeo, starMat);
          star.position.set(Math.cos(a) * rad, sy, Math.sin(a) * rad);
          robe.add(star);
        }
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), new THREE.MeshBasicMaterial({ color: 0xc07eff, transparent: true, opacity: 0.85 }));
        orb.position.set(0.5, 1.2, 0.35); keeper.add(orb);
        const orbLight = new THREE.PointLight(0xb884ff, 6, 3, 2); orbLight.position.copy(orb.position); keeper.add(orbLight);
        smokePuffs.push({ mesh: orb, baseY: orb.position.y, phase: Math.random() * Math.PI * 2, speed: 0.8 + Math.random() * 0.3, kind: 'firefly' });
      }
      keeper.position.z = -0.62;
      stall.add(keeper);

      // hanging lantern on the stall front — lights the keeper's face at night
      const lantern = new THREE.Group();
      const lanternBody = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x2a2018, emissive: 0xffb44a, emissiveIntensity: 0.7 }));
      const lanternLight = new THREE.PointLight(0xffbf7a, 11, 5, 2);
      lantern.add(lanternBody, lanternLight);
      lantern.position.set(0.72, 1.85, 0.4);
      stall.add(lantern);

      // wares on the counter
      let ware;
      if (v.type === 'potions') {
        // row of potion bottles
        ware = new THREE.Group();
        const bottleColors = [0xd93a3a, 0x3a8ad9, 0x5ad93a];
        for (let i = 0; i < 3; i++) {
          const bottle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), new THREE.MeshStandardMaterial({ color: bottleColors[i], roughness: 0.3, transparent: true, opacity: 0.85 }));
          bottle.position.set(-0.3 + i * 0.3, 0.95, 0);
          bottle.scale.y = 1.3;
          const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
          cork.position.set(-0.3 + i * 0.3, 1.08, 0);
          ware.add(bottle, cork);
        }
      } else if (v.type === 'gear') {
        // sword rack
        ware = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.05), new THREE.MeshStandardMaterial({ color: 0xc8ccd8, metalness: 0.7, roughness: 0.3 }));
          blade.position.set(-0.4 + i * 0.35, 1.05, 0);
          blade.rotation.z = -0.15 + i * 0.15;
          ware.add(blade);
        }
        // a hammer resting on the counter beside the blades
        const hHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 6), new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 }));
        hHandle.position.set(0.5, 1.06, 0.1); hHandle.rotation.z = Math.PI / 2 - 0.2;
        const hHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.09), new THREE.MeshStandardMaterial({ color: 0x3a3a40, metalness: 0.6, roughness: 0.4 }));
        hHead.position.set(0.66, 1.09, 0.1);
        ware.add(hHandle, hHead);
      } else {
        // rune cards fanned on the counter
        ware = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const card = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.24), new THREE.MeshStandardMaterial({ color: 0x2a2038, emissive: 0xb35eff, emissiveIntensity: 0.4, side: THREE.DoubleSide }));
          card.position.set(-0.3 + i * 0.2, 0.86, 0.05);
          card.rotation.x = -Math.PI / 2 + 0.3;
          card.rotation.z = (i - 1.5) * 0.15;
          ware.add(card);
        }
      }
      stall.add(ware);

      // crates/barrels beside the stall for extra detail
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
      crate.position.set(-1.05, 0.2, 0.35);
      crate.rotation.y = 0.3;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
      barrel.position.set(1.05, 0.25, 0.35);
      stall.add(crate, barrel);

      // Torvald's small anvil beside the stall
      if (v.type === 'gear') {
        const anvil = new THREE.Group();
        const anvilBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.18), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.6, roughness: 0.4 }));
        anvilBody.position.y = 0.34;
        const anvilBase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.28, 8), new THREE.MeshStandardMaterial({ color: 0x1e1e22, metalness: 0.5, roughness: 0.5 }));
        anvilBase.position.y = 0.14;
        const anvilHorn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.6, roughness: 0.4 }));
        anvilHorn.position.set(-0.26, 0.34, 0);
        anvilHorn.rotation.z = Math.PI / 2;
        anvil.add(anvilBody, anvilBase, anvilHorn);
        anvil.position.set(-1.05, 0, -0.4);
        stall.add(anvil);
      }

      stall.position.set(w.x, 0, w.z);
      group.add(stall);
      // keeper + its home (local) pos so the game can wander it subtly on a tether
      vendorMeshes.push({ ...v, wx: w.x, wz: w.z, mesh: stall, keeper, keeperHome: keeper.position.clone() });
    }
  }

  // --- Return portal to town (dungeon floors, at the spawn point) ---
  let returnPortalMesh = null;
  if (!town && !dungeon.boss) {
    const w = tileToWorld(dungeon.spawn.x, dungeon.spawn.y);
    returnPortalMesh = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.07, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x4fa8d9 })
    );
    ring.position.y = 1.1;
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 20),
      new THREE.MeshBasicMaterial({ color: 0x123044, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
    );
    inner.position.y = 1.1;
    returnPortalMesh.add(ring, inner);
    // keep it clear of the arrival spot so nobody bounces straight back
    returnPortalMesh.position.set(w.x, 0, w.z - 2.4);
    group.add(returnPortalMesh);
  }

  let portalMesh = null;
  if (dungeon.portal) {
    const w = tileToWorld(dungeon.portal.x, dungeon.portal.y);
    portalMesh = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.12, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xb35eff })
    );
    ring.position.y = 1.4;
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(0.98, 24),
      new THREE.MeshBasicMaterial({ color: 0x3a1a55, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    );
    inner.position.y = 1.4;
    const baseStep = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.25, 8), new THREE.MeshStandardMaterial({ color: 0x333340, roughness: 0.9 }));
    baseStep.position.y = 0.12;
    portalMesh.add(ring, inner, baseStep);
    portalMesh.position.set(w.x, 0, w.z);
    group.add(portalMesh);
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

  // --- Dungeon decoration: wall-hugging themed props ---
  // (Room-center "rug" rings were removed — their faint ring outline read as a
  //  stray portal ring in every large room. The only ring is the real portal.)
  const breakables = (!town && dungeon.props?.length) ? buildDungeonProps(group, dungeon, theme, torchPositions, smokePuffs) : [];
  // atmospheric dust motes drifting through the dungeon air (themed, animated
  // by the smoke-puff loop) — cheap depth without external assets
  if (!town && floorTiles.length) {
    const moteGeo = new THREE.SphereGeometry(0.03, 4, 4);
    const moteMat = new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.22, depthWrite: false, fog: true });
    for (let i = 0; i < 26; i++) {
      const tp = floorTiles[Math.floor(Math.random() * floorTiles.length)];
      const w = tileToWorld(tp.x, tp.y);
      const m = new THREE.Mesh(moteGeo, moteMat);
      const baseY = 0.4 + Math.random() * 1.3;
      m.position.set(w.x + (Math.random() - 0.5) * TILE, baseY, w.z + (Math.random() - 0.5) * TILE);
      group.add(m);
      smokePuffs.push({ mesh: m, kind: 'mote', baseY, phase: Math.random() * 10, speed: 0.15 + Math.random() * 0.2, cx: m.position.x, cz: m.position.z, drift: Math.random() * Math.PI * 2 });
    }
  }
  // --- World beyond the town walls: forest ring, horizon, a wandering critter ---
  if (town) buildTownSurroundings(group, dungeon, smokePuffs);

  return { group, doorMeshes, chestMeshes, stairsMesh, torchPositions, vendorMeshes, portalMesh, returnPortalMesh, smokePuffs, breakables };
}

// ---------------- Embervale decor ----------------
function buildTownDecor(group, dungeon, smokePuffs) {
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });
  const greens = [0x3f6b34, 0x4a7a3c, 0x57883f, 0x35592c];

  // trees — oaks get 3-4 offset canopy blobs, pines get stacked cones
  for (const t of dungeon.trees || []) {
    const w = tileToWorld(t.x, t.y);
    const tree = new THREE.Group();
    if (t.kind === 'pine') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 1.0, 6), trunkMat);
      trunk.position.y = 0.5;
      tree.add(trunk);
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.9 - i * 0.22, 1.0, 8),
          new THREE.MeshStandardMaterial({ color: greens[(i + 2) % greens.length], roughness: 0.95 })
        );
        cone.position.y = 1.1 + i * 0.65;
        tree.add(cone);
      }
    } else {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 1.5, 7), trunkMat);
      trunk.position.y = 0.75;
      trunk.rotation.z = (Math.random() - 0.5) * 0.12;
      tree.add(trunk);
      const blobCount = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < blobCount; i++) {
        const r = 0.55 + Math.random() * 0.35;
        const blob = new THREE.Mesh(
          new THREE.SphereGeometry(r, 8, 7),
          new THREE.MeshStandardMaterial({ color: greens[Math.floor(Math.random() * greens.length)], roughness: 0.95 })
        );
        blob.position.set((Math.random() - 0.5) * 0.9, 1.7 + Math.random() * 0.7, (Math.random() - 0.5) * 0.9);
        blob.scale.y = 0.85;
        tree.add(blob);
      }
    }
    tree.scale.setScalar(t.s);
    tree.rotation.y = Math.random() * Math.PI * 2;
    tree.position.set(w.x, 0, w.z);
    group.add(tree);
  }

  // bushes and flowerbeds
  for (const p of dungeon.plants || []) {
    const w = tileToWorld(p.x, p.y);
    const spot = new THREE.Group();
    if (p.kind === 'bush') {
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(
          new THREE.SphereGeometry(0.22 + Math.random() * 0.14, 7, 6),
          new THREE.MeshStandardMaterial({ color: greens[Math.floor(Math.random() * greens.length)], roughness: 1 })
        );
        b.position.set((Math.random() - 0.5) * 0.7, 0.18, (Math.random() - 0.5) * 0.7);
        b.scale.y = 0.75;
        spot.add(b);
      }
    } else {
      const petals = [0xd8c95a, 0xc96a6a, 0xb98ad8, 0xe8e0d0, 0xe89a4a];
      for (let i = 0; i < 6; i++) {
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4),
          new THREE.MeshStandardMaterial({ color: 0x4a7a3c })
        );
        const px = (Math.random() - 0.5) * 1.1, pz = (Math.random() - 0.5) * 1.1;
        stem.position.set(px, 0.15, pz);
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 6, 5),
          new THREE.MeshStandardMaterial({ color: petals[Math.floor(Math.random() * petals.length)], roughness: 0.6 })
        );
        head.position.set(px, 0.33, pz);
        spot.add(stem, head);
      }
    }
    spot.position.set(w.x, 0, w.z);
    group.add(spot);
  }

  // the old stone well
  if (dungeon.well) {
    const w = tileToWorld(dungeon.well.x, dungeon.well.y);
    const well = new THREE.Group();
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.5, 10, 1, true), ringMat);
    ring.position.y = 0.25;
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10), new THREE.MeshBasicMaterial({ color: 0x1a3044 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.28;
    const postL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 5), trunkMat);
    postL.position.set(-0.55, 0.8, 0);
    const postR = postL.clone(); postR.position.x = 0.55;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0x7a4a2e, roughness: 0.9 }));
    roof.position.y = 1.55;
    roof.rotation.y = Math.PI / 4;
    well.add(ring, water, postL, postR, roof);
    well.position.set(w.x, 0, w.z);
    group.add(well);
  }

  // notice board near the square
  if (dungeon.noticeBoard) {
    const w = tileToWorld(dungeon.noticeBoard.x, dungeon.noticeBoard.y);
    const board = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.95 });
    const postL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6), postMat);
    postL.position.set(-0.45, 0.65, 0);
    const postR = postL.clone(); postR.position.x = 0.45;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.75, 0.06), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
    panel.position.y = 1.15;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.08, 0.3), postMat);
    roof.position.y = 1.58;
    roof.rotation.x = -0.15;
    // scraps of "paper" notices
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.32), paperMat);
      paper.position.set(-0.32 + i * 0.32, 1.15 + (i % 2) * 0.05, 0.04);
      paper.rotation.z = (i - 1) * 0.08;
      board.add(paper);
    }
    board.add(postL, postR, panel, roof);
    board.position.set(w.x, 0, w.z);
    group.add(board);
  }

  // market crates + sacks scattered near the square
  if (dungeon.crates?.length) {
    const crateGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const sackMat = new THREE.MeshStandardMaterial({ color: 0xa89468, roughness: 1 });
    const crateMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
    for (const c of dungeon.crates) {
      const w = tileToWorld(c.x, c.y);
      let mesh;
      if (c.kind === 'crate') {
        mesh = new THREE.Mesh(crateGeo, crateMat);
        mesh.position.y = 0.21;
      } else {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), sackMat);
        mesh.scale.y = 0.85;
        mesh.position.y = 0.22;
      }
      mesh.rotation.y = c.r;
      mesh.position.x = w.x;
      mesh.position.z = w.z;
      group.add(mesh);
    }
  }

  // small market cart with wheels
  if (dungeon.cart) {
    const w = tileToWorld(dungeon.cart.x, dungeon.cart.y);
    const cart = new THREE.Group();
    const bedMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.6), bedMat);
    bed.position.y = 0.45;
    cart.add(bed);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
    const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.08, 10);
    for (const wx of [-0.42, 0.42]) {
      for (const wz of [-0.35, 0.35]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.24, wz);
        cart.add(wheel);
      }
    }
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), wheelMat);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0.75, 0.42, 0);
    cart.add(handle);
    cart.rotation.y = dungeon.cart.r;
    cart.position.set(w.x, 0, w.z);
    group.add(cart);
  }

  // hedges: rounded shrub clusters, not slabs
  if (dungeon.hedges?.length) {
    const hedgeGreens = [0x3f6b34, 0x4a7a3c, 0x35592c, 0x578840];
    const blobGeo = new THREE.SphereGeometry(1, 8, 6);
    let hseed = 7;
    const hrand = () => { hseed = (hseed * 1664525 + 1013904223) >>> 0; return hseed / 0x100000000; };
    for (const h of dungeon.hedges) {
      const w = tileToWorld(h.x, h.y);
      for (let i = 0; i < 4; i++) {
        const blob = new THREE.Mesh(blobGeo, new THREE.MeshStandardMaterial({
          color: hedgeGreens[Math.floor(hrand() * hedgeGreens.length)], roughness: 1,
        }));
        const r = 0.3 + hrand() * 0.22;
        blob.scale.set(r * 1.25, r * 0.8, r * 1.1);
        blob.position.set(
          w.x + (hrand() - 0.5) * 1.4,
          r * 0.55,
          w.z + (hrand() - 0.5) * 1.0
        );
        blob.rotation.y = hrand() * Math.PI;
        group.add(blob);
      }
    }
  }

  // The Sleeping Golem tavern
  if (dungeon.tavern) {
    const t = dungeon.tavern;
    const cw = tileToWorld(t.x + t.w / 2 - 0.5, t.y + t.h / 2 - 0.5);
    const W = t.w * TILE, D = t.h * TILE;
    const tavern = new THREE.Group();
    const plaster = new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.95 });
    const timber = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 2.6, D - 0.4), plaster);
    body.position.y = 1.3;
    tavern.add(body);
    // timber frame lines
    for (let i = 0; i <= 3; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), timber);
      beam.position.set(-W / 2 + 0.25 + (i * (W - 0.5)) / 3, 1.3, D / 2 - 0.14);
      tavern.add(beam);
    }
    const beltBeam = new THREE.Mesh(new THREE.BoxGeometry(W - 0.3, 0.14, 0.12), timber);
    beltBeam.position.set(0, 1.75, D / 2 - 0.14);
    tavern.add(beltBeam);
    // pitched roof: two slopes computed to MEET exactly at the ridge and
    // overhang the eaves — no gaps, no clipping — plus closed gable ends
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x71402a, roughness: 0.85 });
    const wallTop = 2.6, ridgeY = 3.6;
    const halfSpan = D / 2 + 0.35;                       // eave overhang
    const pitch = Math.atan((ridgeY - wallTop) / halfSpan);
    const slopeLen = Math.hypot(halfSpan, ridgeY - wallTop) + 0.1;
    const slabL = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.12, slopeLen), roofMat);
    slabL.position.set(0, (wallTop + ridgeY) / 2 + 0.04, -halfSpan / 2);
    slabL.rotation.x = -pitch;
    const slabR = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.12, slopeLen), roofMat);
    slabR.position.set(0, (wallTop + ridgeY) / 2 + 0.04, halfSpan / 2);
    slabR.rotation.x = pitch;
    tavern.add(slabL, slabR);
    // gable end triangles close the roof so you can't see inside it
    const gableShape = new THREE.Shape();
    gableShape.moveTo(-(D / 2 - 0.2), 0);
    gableShape.lineTo(D / 2 - 0.2, 0);
    gableShape.lineTo(0, ridgeY - wallTop);
    gableShape.closePath();
    const gableGeo = new THREE.ShapeGeometry(gableShape);
    for (const sx of [-(W - 0.4) / 2, (W - 0.4) / 2]) {
      const gable = new THREE.Mesh(gableGeo, plaster);
      gable.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
      gable.position.set(sx, wallTop, 0);
      tavern.add(gable);
    }
    // ridge beam caps the peak
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, 0.14, 0.18), timber);
    ridge.position.set(0, ridgeY + 0.06, 0);
    tavern.add(ridge);
    // chimney + animated smoke puffs (data returned via smokePuffs for the game loop to drift/fade)
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.1, 0.35), new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 1 }));
    chimney.position.set(W * 0.28, 3.5, 0);
    tavern.add(chimney);
    const puffGeo = new THREE.SphereGeometry(1, 6, 5); // unit sphere, scaled per-puff below
    for (let i = 0; i < 5; i++) {
      const s = 0.14 + i * 0.05;
      const puff = new THREE.Mesh(
        puffGeo,
        new THREE.MeshBasicMaterial({ color: 0x9a95a0, transparent: true, opacity: 0.34 - i * 0.05 })
      );
      puff.scale.setScalar(s);
      const baseY = 4.05 + i * 0.3;
      puff.position.set(W * 0.28 + (Math.random() - 0.5) * 0.1, baseY, 0);
      tavern.add(puff);
      if (smokePuffs) {
        smokePuffs.push({ mesh: puff, baseY, phase: (i / 5) * Math.PI * 2, speed: 0.35 + i * 0.05, kind: 'smoke' });
      }
    }
    // warm windows: INSET into the plaster (behind the timber frame layer)
    // and sized to sit between the beams — facade layers never overlap:
    // plaster face < window (+0.01) < timber beams (+0.06)
    const glow = new THREE.MeshBasicMaterial({ color: 0xffb45e });
    const frontFace = D / 2 - 0.2; // plaster front plane
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.46), glow);
    win.position.set(-W * 0.28, 1.32, frontFace + 0.01);
    tavern.add(win);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.05), timber);
    winFrame.position.set(-W * 0.28, 1.08, frontFace + 0.02); // sill
    tavern.add(winFrame);
    // side window flush with the side wall
    const sideFace = (W - 0.4) / 2;
    const sideWin = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.46), glow);
    sideWin.position.set(-sideFace - 0.01, 1.32, 0);
    sideWin.rotation.y = -Math.PI / 2;
    tavern.add(sideWin);
    // door frame + door + step
    const frameMat = timber;
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.14), frameMat);
    frameTop.position.set(W * 0.28, 1.58, D / 2 - 0.1);
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.14), frameMat);
    frameL.position.set(W * 0.28 - 0.4, 0.78, D / 2 - 0.1);
    const frameR = frameL.clone();
    frameR.position.x = W * 0.28 + 0.4;
    tavern.add(frameTop, frameL, frameR);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.1), timber);
    door.position.set(W * 0.28, 0.75, D / 2 - 0.12);
    tavern.add(door);
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.4), new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.95 }));
    step.position.set(W * 0.28, 0.07, D / 2 + 0.25);
    tavern.add(step);
    // hanging sign with a golden mug
    const signArm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.06), timber);
    signArm.position.set(W * 0.28 + 0.85, 2.2, D / 2 + 0.15);
    const signBoard = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.05), new THREE.MeshStandardMaterial({ color: 0x5a4028 }));
    signBoard.position.set(W * 0.28 + 1.05, 1.9, D / 2 + 0.15);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 8), new THREE.MeshStandardMaterial({ color: 0xd8b04a, metalness: 0.6, roughness: 0.4 }));
    mug.position.set(W * 0.28 + 1.05, 1.9, D / 2 + 0.2);
    tavern.add(signArm, signBoard, mug);
    // barrel + bench outside, near the door
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6b4c30, roughness: 0.85 });
    const outsideBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.55, 10), barrelMat);
    outsideBarrel.position.set(-W * 0.4, 0.28, D / 2 + 0.35);
    tavern.add(outsideBarrel);
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 });
    const benchSeat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.3), benchMat);
    benchSeat.position.set(-W * 0.05, 0.32, D / 2 + 0.5);
    const benchLegGeo = new THREE.BoxGeometry(0.08, 0.32, 0.08);
    const legA = new THREE.Mesh(benchLegGeo, benchMat); legA.position.set(-W * 0.05 - 0.38, 0.16, D / 2 + 0.4);
    const legB = new THREE.Mesh(benchLegGeo, benchMat); legB.position.set(-W * 0.05 + 0.38, 0.16, D / 2 + 0.4);
    tavern.add(benchSeat, legA, legB);

    tavern.position.set(cw.x, 0, cw.z);
    group.add(tavern);
  }
}

// ---------------- Dungeon decoration ----------------

// Themed floor medallions in the larger rooms so they don't read as bare brick.
function buildRoomRugs(group, dungeon, theme) {
  const acc = new THREE.Color(theme.accent);
  for (const r of dungeon.rooms || []) {
    if (r.w < 5 || r.h < 5) continue;
    const w = tileToWorld(Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2));
    const rad = Math.min(r.w, r.h) * 0.3 * TILE;
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(rad, 24),
      new THREE.MeshStandardMaterial({ color: acc.clone().multiplyScalar(0.26), roughness: 1,
        polygonOffset: true, polygonOffsetFactor: -1, transparent: true, opacity: 0.55 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(w.x, 0.03, w.z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(rad * 0.58, rad * 0.68, 24),
      new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.2, side: THREE.DoubleSide, fog: true }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(w.x, 0.04, w.z);
    group.add(rug, ring);
  }
}

// Wall-hugging themed clutter. Braziers/candelabra register as torch lights so
// they glow and flicker via the game's pooled-light loop.
function buildDungeonProps(group, dungeon, theme, torchPositions, smokePuffs) {
  const SETS = {
    'The Old Halls':      ['barrel', 'crate', 'bones', 'cobweb', 'banner', 'pot'],
    'The Rotting Depths': ['mushroom', 'bones', 'pot', 'cobweb', 'barrel', 'skull'],
    'The Ember Vaults':   ['brazier', 'crate', 'skull', 'banner', 'pot', 'bones'],
    'The Sunless Court':  ['sarcophagus', 'candelabra', 'bones', 'banner', 'cobweb', 'skull'],
    'The Abyssal Throne': ['sarcophagus', 'skull', 'brazier', 'banner', 'bones', 'cobweb'],
  };
  const kinds = SETS[theme.name] || SETS['The Old Halls'];
  const accent = new THREE.Color(theme.accent);
  const C = { WOOD: 0x54402c, IRON: 0x3f3f47, BONE: 0xcfc6a6, STONE: 0x5e5766, TERRA: 0x8a4b33, accent };
  const breakables = [];
  for (const p of dungeon.props) {
    const kind = kinds[Math.min(kinds.length - 1, Math.floor((p.roll || 0) * kinds.length))];
    const w = tileToWorld(p.x, p.y);
    const px = w.x + (p.dx || 0) * (TILE * 0.32);
    const pz = w.z + (p.dy || 0) * (TILE * 0.32);
    const node = buildProp(kind, C, torchPositions, smokePuffs, px, pz);
    if (!node) continue;
    node.position.set(px, 0, pz);
    node.rotation.y = p.r || 0;
    group.add(node);
    // containers can be smashed by attacks that land near them
    if (kind === 'barrel' || kind === 'crate' || kind === 'pot') breakables.push({ mesh: node, x: px, z: pz, kind });
  }
  return breakables;
}

function buildProp(kind, C, torchPositions, smokePuffs, px, pz) {
  const g = new THREE.Group();
  const std = (color, rough = 1) => new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true });
  const glow = (color) => new THREE.MeshBasicMaterial({ color, fog: false });
  if (kind === 'barrel') {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.9, 9), std(C.WOOD));
    b.position.y = 0.45; g.add(b);
    for (const y of [0.2, 0.7]) { const h = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 12), std(C.IRON)); h.rotation.x = Math.PI / 2; h.position.y = y; g.add(h); }
  } else if (kind === 'crate') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), std(C.WOOD)); b.position.y = 0.35; g.add(b);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.1, 0.12), std(0x3c2c1c)); t.position.y = 0.35; g.add(t);
  } else if (kind === 'bones') {
    for (let i = 0; i < 4; i++) { const bn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 5), std(C.BONE)); bn.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI); bn.position.set((Math.random() - 0.5) * 0.4, 0.06, (Math.random() - 0.5) * 0.4); g.add(bn); }
    const sk = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), std(C.BONE)); sk.position.set(0.15, 0.12, 0.1); g.add(sk);
  } else if (kind === 'skull') {
    const sk = new THREE.Mesh(new THREE.SphereGeometry(0.18, 9, 7), std(C.BONE)); sk.position.y = 0.18; g.add(sk);
    for (const dx of [-0.06, 0.06]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), std(0x101014)); e.position.set(dx, 0.19, 0.15); g.add(e); }
  } else if (kind === 'pot') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.34, 8), std(C.TERRA)); base.position.y = 0.17; g.add(base);
    for (let i = 0; i < 3; i++) { const sh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.02), std(C.TERRA)); sh.position.set((Math.random() - 0.5) * 0.6, 0.05, (Math.random() - 0.5) * 0.6); sh.rotation.set(Math.PI / 2.3, Math.random(), 0); g.add(sh); }
  } else if (kind === 'cobweb') {
    // A textured web plane tucked into the ceiling corner — reads as a real
    // cobweb rather than the flat translucent triangle it used to be.
    const web = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95),
      new THREE.MeshBasicMaterial({ map: cobwebTexture(), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, fog: true }));
    web.position.set(0, 2.05, 0); web.rotation.set(0, Math.PI / 4, 0); g.add(web);
  } else if (kind === 'banner') {
    // A wall tapestry: horizontal rod across the top, a thin cloth "box" (so it
    // reads as hanging fabric from ANY angle instead of vanishing edge-on like
    // the old single plane), a notched hem, and a glowing themed emblem.
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), std(0x2a2a30));
    rod.rotation.z = Math.PI / 2; rod.position.set(0, 2.12, 0); g.add(rod);
    for (const dx of [-0.4, 0.4]) { const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), std(0xb8912e)); cap.position.set(dx, 2.12, 0); g.add(cap); }
    const clothMat = new THREE.MeshStandardMaterial({ color: C.accent.clone().multiplyScalar(0.6), roughness: 1 });
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.5, 0.04), clothMat);
    cloth.position.set(0, 1.33, 0); g.add(cloth);
    const hemL = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.28, 3), clothMat); hemL.rotation.x = Math.PI; hemL.position.set(-0.18, 0.53, 0); g.add(hemL);
    const hemR = hemL.clone(); hemR.position.x = 0.18; g.add(hemR);
    const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.17, 6), glow(C.accent)); emblem.position.set(0, 1.5, 0.03); g.add(emblem);
  } else if (kind === 'brazier') {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.9, 6), std(C.IRON)); leg.position.y = 0.45; g.add(leg);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.16, 0.24, 10), std(C.IRON)); bowl.position.y = 0.95; g.add(bowl);
    const localFlame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 8), glow(C.accent)); localFlame.position.y = 1.25; g.add(localFlame);
    if (torchPositions) torchPositions.push({ x: px, y: 1.25, z: pz, flame: localFlame });
  } else if (kind === 'candelabra') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.5, 6), std(C.IRON)); pole.position.y = 0.75; g.add(pole);
    for (const dx of [-0.28, 0, 0.28]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 6), std(0xd8cf9a)); c.position.set(dx, 1.5, 0); g.add(c); const fl = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), glow(0xffd27a)); fl.position.set(dx, 1.66, 0); g.add(fl); }
    if (torchPositions) torchPositions.push({ x: px, y: 1.5, z: pz, flame: g.children[g.children.length - 1] });
  } else if (kind === 'sarcophagus') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 1.9), std(C.STONE)); base.position.y = 0.25; g.add(base);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.16, 2.0), std(0x6b6474)); lid.position.y = 0.56; lid.rotation.y = 0.04; g.add(lid);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), new THREE.MeshStandardMaterial({ color: C.accent.clone().multiplyScalar(0.5), roughness: 1 })); face.rotation.x = -Math.PI / 2; face.position.set(0, 0.65, -0.5); g.add(face);
  } else if (kind === 'mushroom') {
    for (let i = 0; i < 3; i++) { const h = 0.2 + Math.random() * 0.3; const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 6), std(0xd8d0c0)); const ox = (Math.random() - 0.5) * 0.5, oz = (Math.random() - 0.5) * 0.5; stem.position.set(ox, h / 2, oz); g.add(stem); const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glow(C.accent)); cap.position.set(ox, h, oz); g.add(cap); }
  }
  return g;
}

// ---------------- World beyond the town walls ----------------
function buildTownSurroundings(group, dungeon, smokePuffs) {
  const GRID = dungeon.size || 30;
  const c = tileToWorld(Math.floor(GRID / 2), Math.floor(GRID / 2));
  const cx = c.x, cz = c.z, extent = GRID * TILE;
  // ground stretching to a fogged horizon so the world doesn't just end
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 4, extent * 4),
    new THREE.MeshStandardMaterial({ color: 0x2b3620, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.08, cz); group.add(ground);

  // forest ring outside the walls — two instanced meshes (trunks + foliage)
  const R0 = extent * 0.52, R1 = R0 + 34, N = 140;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1, flatShading: true }), N);
  const foliage = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 3.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x24401e, roughness: 1, flatShading: true }), N);
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.random() * 0.4;
    const r = R0 + Math.random() * (R1 - R0);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, sc = 0.8 + Math.random() * 1.0;
    sv.set(sc, sc, sc); q.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
    mm.compose(pv.set(x, 1.2 * sc, z), q, sv); trunks.setMatrixAt(i, mm);
    mm.compose(pv.set(x, 4.0 * sc, z), q, sv); foliage.setMatrixAt(i, mm);
  }
  trunks.instanceMatrix.needsUpdate = true; foliage.instanceMatrix.needsUpdate = true;
  group.add(trunks, foliage);

  // one shy forest critter ambling along a path just outside the walls
  const deer = buildCritter(); deer.position.set(cx + extent * 0.46, 0, cz); group.add(deer);
  if (smokePuffs) smokePuffs.push({ mesh: deer, kind: 'critter', cx, cz, radius: extent * 0.46, baseY: 0, phase: 0, speed: 0.5, angle: 0 });
}

function buildCritter() {
  const g = new THREE.Group();
  const hide = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 1, flatShading: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 1.0), hide); body.position.y = 0.72; g.add(body);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.22), hide); neck.position.set(0, 0.98, 0.5); neck.rotation.x = -0.5; g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.36), hide); head.position.set(0, 1.2, 0.66); g.add(head);
  for (const dx of [-0.14, 0.14]) { const ant = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.28, 4), new THREE.MeshStandardMaterial({ color: 0x4a3520, flatShading: true })); ant.position.set(dx, 1.42, 0.64); g.add(ant); }
  for (const [dx, dz] of [[-0.14, 0.38], [0.14, 0.38], [-0.14, -0.38], [0.14, -0.38]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), hide); leg.position.set(dx, 0.28, dz); g.add(leg); }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.18), hide); tail.position.set(0, 0.78, -0.56); g.add(tail);
  return g;
}
