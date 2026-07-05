import * as THREE from 'three';
import { FLOOR, WALL, DOOR, PIT } from './dungeon.js';
import { makeFloorTexture, makeWallTexture, makeWoodTexture, makeGrassTexture, makeCobbleTexture } from './textures.js';

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
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = grid[y][x];
      if (t === FLOOR || t === DOOR) floorTiles.push({ x, y });
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
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, renderWalls.length);
  renderWalls.forEach((tp, i) => {
    const w = tileToWorld(tp.x, tp.y);
    m.setPosition(w.x, wallH / 2, w.z);
    wallMesh.setMatrixAt(i, m);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  group.add(wallMesh);

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

      // --- shopkeeper with face, arms, and per-type character ---
      const keeper = new THREE.Group();
      const bodyColor = v.type === 'potions' ? 0x7a4a5a : v.type === 'gear' ? 0x3a3a40 : 0x2a2038;
      const kBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 8), new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 }));
      kBody.position.y = 0.72;
      const kHead = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), skinMat);
      kHead.position.y = 1.34;
      // face: two eyes + nose nub (reused geo/mat across keepers, orientation varies little so cheap clones are fine)
      const eyeGeo = new THREE.SphereGeometry(0.028, 6, 6);
      const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.08, 1.36, 0.17);
      const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.08, 1.36, 0.17);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 6), skinMat);
      nose.position.set(0, 1.3, 0.2);
      nose.rotation.x = Math.PI / 2;
      keeper.add(kBody, kHead, eyeL, eyeR, nose);

      // arms (shared capsule geo, tinted per body color)
      const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
      const armGeo = new THREE.CapsuleGeometry(0.07, 0.32, 3, 6);
      const armL = new THREE.Mesh(armGeo, armMat); armL.position.set(-0.28, 0.78, 0.05); armL.rotation.z = 0.5;
      const armR = new THREE.Mesh(armGeo, armMat); armR.position.set(0.28, 0.78, 0.05); armR.rotation.z = -0.5;
      keeper.add(armL, armR);

      if (v.type === 'potions') {
        // Maribel: wide-brim herbalist hat + apron, warm colors
        const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0x6b3a2a, roughness: 0.9 }));
        brim.position.y = 1.48;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.32, 10), new THREE.MeshStandardMaterial({ color: 0x8a4a2e, roughness: 0.9 }));
        cone.position.y = 1.68;
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.06), new THREE.MeshStandardMaterial({ color: 0xc99a4a, roughness: 0.9 }));
        apron.position.set(0, 0.62, 0.2);
        keeper.add(brim, cone, apron);
      } else if (v.type === 'gear') {
        // Torvald: blacksmith — bandana, thick arms (scaled up), dark leather apron
        armL.scale.set(1.5, 1.2, 1.5); armR.scale.set(1.5, 1.2, 1.5);
        const bandana = new THREE.Mesh(new THREE.SphereGeometry(0.205, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: 0xa8342a, roughness: 0.9 }));
        bandana.position.y = 1.36;
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.07), new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.95 }));
        apron.position.set(0, 0.58, 0.2);
        keeper.add(bandana, apron);
      } else {
        // Zoltan: deep hood with glowing eyes, star-speckled robe, floating orb
        kHead.material = new THREE.MeshStandardMaterial({ color: 0x1a1622, roughness: 0.9 }); // face lost in shadow
        eyeL.material = new THREE.MeshBasicMaterial({ color: 0x9a5eff });
        eyeR.material = new THREE.MeshBasicMaterial({ color: 0x9a5eff });
        eyeL.scale.setScalar(1.6); eyeR.scale.setScalar(1.6);
        const hood = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x2a2038, roughness: 0.85 }));
        hood.position.y = 1.5;
        const robe = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 8), new THREE.MeshStandardMaterial({ color: 0x241c34, roughness: 0.85, emissive: 0x3a1a55, emissiveIntensity: 0.15 }));
        robe.position.y = 0.5;
        keeper.add(hood, robe);
        // floating glowing orb beside Zoltan
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0xb35eff, transparent: true, opacity: 0.85 }));
        orb.position.set(0.42, 1.15, -0.15);
        keeper.add(orb);
        smokePuffs.push({ mesh: orb, baseY: orb.position.y, phase: Math.random() * Math.PI * 2, speed: 0.8 + Math.random() * 0.3, kind: 'firefly' });
      }
      keeper.position.z = -0.7;
      stall.add(keeper);

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
      vendorMeshes.push({ ...v, wx: w.x, wz: w.z, mesh: stall });
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
    returnPortalMesh.position.set(w.x, 0, w.z - 1.2);
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

  return { group, doorMeshes, chestMeshes, stairsMesh, torchPositions, vendorMeshes, portalMesh, returnPortalMesh, smokePuffs };
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

  // low hedge segments ringing garden corners
  if (dungeon.hedges?.length) {
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x3a5a30, roughness: 1 });
    const hedgeGeo = new THREE.BoxGeometry(1.8, 0.5, 0.5);
    for (const h of dungeon.hedges) {
      const w = tileToWorld(h.x, h.y);
      const hedge = new THREE.Mesh(hedgeGeo, hedgeMat);
      hedge.position.set(w.x, 0.25, w.z);
      group.add(hedge);
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
    // pitched roof: two slabs
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x71402a, roughness: 0.85 });
    const slabL = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.12, D * 0.62), roofMat);
    slabL.position.set(0, 3.15, -D * 0.24);
    slabL.rotation.x = 0.62;
    const slabR = slabL.clone();
    slabR.position.z = D * 0.24;
    slabR.rotation.x = -0.62;
    tavern.add(slabL, slabR);
    // ridge beam along the roof peak for a cleaner silhouette from above
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.1, 0.1), timber);
    ridge.position.set(0, 3.42, 0);
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
    // warm windows + door on the square-facing side
    const glow = new THREE.MeshBasicMaterial({ color: 0xffb45e });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.6), glow);
    win.position.set(-W * 0.28, 1.5, D / 2 - 0.07);
    tavern.add(win);
    // side window (extra detail requested — breaks up the blank side wall)
    const sideWin = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.55), glow);
    sideWin.position.set(-W / 2 + 0.02, 1.5, 0);
    sideWin.rotation.y = Math.PI / 2;
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
