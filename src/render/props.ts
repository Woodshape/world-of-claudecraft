import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { terrainHeight } from '../sim/world';
import { PROPS, WORLD_MIN_Z } from '../sim/data';
import { roofTexture, wallTexture, stoneTexture } from './textures';

// Static world props: buildings, tents, campfires, mines, ruins, docks, fences.
// Placement comes from the per-zone content modules (merged into PROPS by
// sim/data.ts) — the collider grid uses the same defs, so rendering and
// collision agree.
//
// After building, every static mesh is baked into world space and merged per
// (material, z-band) — hundreds of little box/cylinder draws collapse into a
// few dozen, and the z-bands keep off-screen settlements frustum-cullable.
// Animated flames and the fire PointLights stay live objects.

export interface PropsResult {
  group: THREE.Group;
  flames: THREE.Mesh[]; // animated campfire flames
  fireLights: THREE.PointLight[];
}

const MERGE_BAND_DEPTH = 180;

export function buildProps(seed: number): PropsResult {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [];
  const fireLights: THREE.PointLight[] = [];

  const roofTex = roofTexture();
  const wallTex = wallTexture();
  const stoneTex = stoneTexture();
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
  const roofMat = new THREE.MeshLambertMaterial({ map: roofTex });
  const stoneMat = new THREE.MeshLambertMaterial({ map: stoneTex });
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const woodDarkMat = new THREE.MeshLambertMaterial({ color: 0x4a3320 });
  const canvasMat = new THREE.MeshLambertMaterial({ color: 0xc9b48a, side: THREE.DoubleSide });
  const windowMat = new THREE.MeshLambertMaterial({ color: 0x35506b, emissive: 0x1a2c40, emissiveIntensity: 0.7 });
  const awningMat = new THREE.MeshLambertMaterial({ color: 0x1e8449 });
  const breadMat = new THREE.MeshLambertMaterial({ color: 0xc8954a });
  const jugMat = new THREE.MeshLambertMaterial({ color: 0x7a9cc6 });
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const oreMat = new THREE.MeshLambertMaterial({ color: 0xb87333 });
  const mudMat = new THREE.MeshLambertMaterial({ color: 0x6e7f4e, flatShading: true });

  const ground = (x: number, z: number) => terrainHeight(x, z, seed);

  function shadowed<T extends THREE.Object3D>(o: T): T {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        (c as THREE.Mesh).castShadow = true;
        (c as THREE.Mesh).receiveShadow = true;
      }
    });
    return o;
  }

  // ---- houses ----
  function house(x: number, z: number, w: number, d: number, rot: number, tall = false): void {
    const g = new THREE.Group();
    const hWall = tall ? 4.2 : 3.2;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, hWall, d), wallMat);
    walls.position.y = hWall / 2;
    g.add(walls);
    // gabled roof: stretched cone with 4 sides looks tent-like; use prism via cylinder 3-sided? Use box rotated 45° trick:
    const roofH = 2.2;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.8, roofH, 4), roofMat);
    roof.position.y = hWall + roofH / 2;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2, 0.16), woodDarkMat);
    door.position.set(0, 1, d / 2 + 0.06);
    g.add(door);
    // windows
    for (const sx of [-w / 3, w / 3]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.1), windowMat);
      win.position.set(sx, 1.9, d / 2 + 0.06);
      g.add(win);
    }
    // chimney
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.6, hWall + roofH + 0.6, 0.6), stoneMat);
    chim.position.set(w / 3, (hWall + roofH + 0.6) / 2, -d / 4);
    g.add(chim);
    g.position.set(x, ground(x, z), z);
    g.rotation.y = rot;
    group.add(shadowed(g));
  }

  function chapel(x: number, z: number, w: number, d: number, rot: number): void {
    const g = new THREE.Group();
    const nave = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), wallMat);
    nave.position.y = 2;
    g.add(nave);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.66, 2.6, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = 5.3;
    g.add(roof);
    const steeple = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3, 1.4), wallMat);
    steeple.position.set(0, 5.5, 2.2);
    g.add(steeple);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.8, 4), roofMat);
    spire.rotation.y = Math.PI / 4;
    spire.position.set(0, 7.9, 2.2);
    g.add(spire);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.16), woodDarkMat);
    door.position.set(0, 1.1, d / 2 + 0.05);
    g.add(door);
    g.position.set(x, ground(x, z), z);
    g.rotation.y = rot;
    group.add(shadowed(g));
  }

  for (const b of PROPS.buildings) {
    if (b.kind === 'chapel') chapel(b.x, b.z, b.w, b.d, b.rot);
    else house(b.x, b.z, b.w, b.d, b.rot, b.kind === 'inn');
  }

  // ---- market stalls ----
  function stall(sx0: number, sz0: number, srot: number): void {
    const g = new THREE.Group();
    for (const [sx, sz] of [[-1.4, -0.8], [1.4, -0.8], [-1.4, 0.8], [1.4, 0.8]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.4, 0.14), woodMat);
      post.position.set(sx, 1.2, sz);
      g.add(post);
    }
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3, 0.9, 1.4), woodMat);
    counter.position.y = 0.45;
    g.add(counter);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 2.2), awningMat);
    awning.position.y = 2.45;
    awning.rotation.x = 0.12;
    g.add(awning);
    // goods
    const bread = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), breadMat);
    bread.scale.set(1.4, 0.8, 0.9);
    bread.position.set(-0.6, 1.0, 0);
    g.add(bread);
    const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.4, 8), jugMat);
    jug.position.set(0.5, 1.1, 0.2);
    g.add(jug);
    g.position.set(sx0, ground(sx0, sz0), sz0);
    g.rotation.y = srot;
    group.add(shadowed(g));
  }
  for (const s of PROPS.stalls) stall(s.x, s.z, s.rot);

  // ---- wells ----
  function well(wx: number, wz: number): void {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.3, 1, 10), stoneMat);
    ring.position.y = 0.5;
    g.add(ring);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.8, 0.12), woodMat);
      post.position.set(sx * 1.0, 1.6, 0);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), woodMat);
    beam.position.y = 2.4;
    g.add(beam);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.9, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = 2.95;
    g.add(roof);
    g.position.set(wx, ground(wx, wz), wz);
    group.add(shadowed(g));
  }
  for (const w of PROPS.wells) well(w.x, w.z);

  // ---- graveyards ----
  for (const gy of PROPS.graveyards) {
    for (let i = 0; i < 6; i++) {
      const gx = gy.x + (i % 3) * 2.2, gz = gy.z + Math.floor(i / 3) * 2.6;
      const stone = new THREE.Mesh(
        i % 2 === 0 ? new THREE.BoxGeometry(0.8, 1.2, 0.22) : new THREE.CylinderGeometry(0.45, 0.45, 1.1, 8, 1, false, 0, Math.PI),
        stoneMat,
      );
      stone.position.set(gx, ground(gx, gz) + 0.55, gz);
      stone.rotation.y = i * 0.4;
      group.add(shadowed(stone));
    }
  }

  // ---- town fences & lamp posts ----
  function fenceRun(x1: number, z1: number, x2: number, z2: number): void {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const n = Math.floor(len / 2.4);
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      const x = x1 + (x2 - x1) * t, z = z1 + (z2 - z1) * t;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.1, 0.15), woodMat);
      post.position.set(x, ground(x, z) + 0.55, z);
      group.add(shadowed(post));
      if (i < n) {
        const nx = x1 + (x2 - x1) * ((i + 0.5) / n), nz = z1 + (z2 - z1) * ((i + 0.5) / n);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 2.4), woodMat);
        rail.position.set(nx, ground(nx, nz) + 0.85, nz);
        rail.lookAt(x2, rail.position.y, z2);
        group.add(shadowed(rail));
        const rail2 = rail.clone();
        rail2.position.y -= 0.4;
        group.add(rail2);
      }
    }
  }
  for (const f of PROPS.fences) fenceRun(f.x1, f.z1, f.x2, f.z2);

  // ---- campfires (town + bandit camp + mine camp + lake hut) ----
  function campfire(x: number, z: number): void {
    const g = new THREE.Group();
    const y = ground(x, z);
    for (let i = 0; i < 5; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.1, 5), woodDarkMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i / 5) * Math.PI;
      log.position.y = 0.1;
      g.add(log);
    }
    const stoneRing = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.12, 5, 9), stoneMat);
    stoneRing.rotation.x = Math.PI / 2;
    stoneRing.position.y = 0.08;
    g.add(stoneRing);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 6), new THREE.MeshLambertMaterial({
      color: 0xffaa33, emissive: 0xff6600, emissiveIntensity: 1.4, transparent: true, opacity: 0.92,
    }));
    flame.position.y = 0.55;
    g.add(flame);
    flames.push(flame);
    const light = new THREE.PointLight(0xff8830, 12, 16, 2);
    light.position.y = 1.2;
    g.add(light);
    fireLights.push(light);
    g.position.set(x, y, z);
    group.add(g);
  }
  for (const [x, z] of PROPS.campfires) campfire(x, z);

  // ---- bandit tents ----
  function tent(x: number, z: number, rot: number, scale = 1): void {
    const g = new THREE.Group();
    const tentGeo = new THREE.ConeGeometry(1.8 * scale, 2.2 * scale, 4);
    const t = new THREE.Mesh(tentGeo, canvasMat);
    t.rotation.y = Math.PI / 4;
    t.position.y = 1.1 * scale;
    g.add(t);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.6 * scale, 0.08), woodMat);
    pole.position.y = 1.3 * scale;
    g.add(pole);
    g.position.set(x, ground(x, z), z);
    g.rotation.y = rot;
    group.add(shadowed(g));
  }
  for (const t of PROPS.tents) tent(t.x, t.z, t.rot, t.scale);

  // crates & barrels
  for (const [x, z] of PROPS.crates) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), woodMat);
    crate.position.set(x, ground(x, z) + 0.45, z);
    crate.rotation.y = (x * 13 + z * 7) % 1;
    group.add(shadowed(crate));
  }

  // ---- mine entrances ----
  function mine(x: number, z: number, rot: number): void {
    const g = new THREE.Group();
    // timber portal
    for (const sx of [-1.4, 1.4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.4, 0.5), woodMat);
      post.position.set(sx, 1.7, 0);
      g.add(post);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.55, 0.6), woodMat);
    lintel.position.y = 3.3;
    g.add(lintel);
    // dark hole
    const hole = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3), holeMat);
    hole.position.set(0, 1.5, -0.2);
    g.add(hole);
    // mound above
    const mound = new THREE.Mesh(new THREE.SphereGeometry(4.5, 8, 6), stoneMat);
    mound.scale.set(1.4, 0.7, 1);
    mound.position.set(0, 1.6, -3.4);
    g.add(mound);
    // cart and ore pile
    const cart = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.9), woodDarkMat);
    cart.position.set(2.8, 0.55, 1.6);
    g.add(cart);
    const ore = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5, 0), oreMat);
    ore.position.set(2.8, 1.05, 1.6);
    g.add(ore);
    g.position.set(x, ground(x, z), z);
    g.rotation.y = rot;
    group.add(shadowed(g));
  }
  for (const m of PROPS.mines) mine(m.x, m.z, m.rot);

  // ---- ruin rings ----
  function ruins(cx: number, cz: number, ringR: number, columns: number): void {
    for (let i = 0; i < columns; i++) {
      const ang = (i / columns) * Math.PI * 2;
      const x = cx + Math.sin(ang) * ringR, z = cz + Math.cos(ang) * ringR;
      const h = i % 3 === 0 ? 1.2 : 2.6 + (i % 2) * 1.2;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, h, 7), stoneMat);
      col.position.set(x, ground(x, z) + h / 2, z);
      col.rotation.z = (i % 3 === 0 ? 0.5 : 0.04) * (i % 2 ? 1 : -1);
      group.add(shadowed(col));
    }
    // fallen column
    const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3.4, 7), stoneMat);
    fallen.rotation.z = Math.PI / 2;
    fallen.rotation.y = 0.6;
    fallen.position.set(cx - 2, ground(cx - 2, cz - 3) + 0.5, cz - 3);
    group.add(shadowed(fallen));
    // broken arch
    const arch1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 3.6, 0.8), stoneMat);
    arch1.position.set(cx, ground(cx, cz + 8) + 1.8, cz + 8);
    group.add(shadowed(arch1));
    const arch2 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 0.8), stoneMat);
    arch2.position.set(cx + 1, ground(cx, cz + 8) + 3.6, cz + 8);
    arch2.rotation.z = -0.18;
    group.add(shadowed(arch2));
  }
  for (const r of PROPS.ruinRings) ruins(r.x, r.z, r.ringR, r.columns);

  // ---- fishing docks ----
  function dock(x: number, z: number, rot: number, hutLocal: { x: number; z: number; hw: number; hd: number }): void {
    const y = ground(x, z);
    const g = new THREE.Group();
    const planks = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.16, 7), woodMat);
    planks.position.set(0, 0.4, -3);
    g.add(planks);
    for (const [px, pz] of [[-0.7, -1], [0.7, -1], [-0.7, -4.5], [0.7, -4.5]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.6, 0.16), woodDarkMat);
      post.position.set(px, -0.2, pz);
      g.add(post);
    }
    // hut
    const hut = new THREE.Mesh(new THREE.BoxGeometry(hutLocal.hw * 2, 2.4, hutLocal.hd * 2), wallMat);
    hut.position.set(hutLocal.x, 1.2, hutLocal.z);
    g.add(hut);
    const hutRoof = new THREE.Mesh(new THREE.ConeGeometry(2.8, 1.6, 4), roofMat);
    hutRoof.rotation.y = Math.PI / 4;
    hutRoof.position.set(hutLocal.x, 3.2, hutLocal.z);
    g.add(hutRoof);
    // barrels
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.8, 8), woodDarkMat);
    barrel.position.set(1, 0.4, 0.5);
    g.add(barrel);
    g.position.set(x, y, z);
    g.rotation.y = rot;
    group.add(shadowed(g));
  }
  for (const d of PROPS.docks) dock(d.x, d.z, d.rot, d.hutLocal);

  // ---- murloc mud huts ----
  for (const [x, z] of PROPS.mudHuts) {
    const hut = new THREE.Mesh(new THREE.SphereGeometry(1.2, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2), mudMat);
    hut.position.set(x, ground(x, z), z);
    group.add(shadowed(hut));
  }

  mergeStaticMeshes(group, new Set(flames));
  return { group, flames, fireLights };
}

// Bake every static prop mesh into world space and merge per
// (material, castShadow, z-band). Flames (animated) survive untouched, as do
// the PointLights (not meshes). The merged meshes replace the originals on
// the same group; emptied sub-groups are left in place (they carry lights).
function mergeStaticMeshes(group: THREE.Group, keep: Set<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  interface Bucket { material: THREE.Material; castShadow: boolean; geoms: THREE.BufferGeometry[] }
  const buckets = new Map<string, Bucket>();
  const merged: THREE.Mesh[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || keep.has(mesh)) return;
    const material = mesh.material as THREE.Material;
    const worldZ = mesh.matrixWorld.elements[14];
    const band = Math.floor((worldZ - WORLD_MIN_Z) / MERGE_BAND_DEPTH);
    const key = `${material.uuid}:${mesh.castShadow ? 1 : 0}:${band}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material, castShadow: mesh.castShadow, geoms: [] };
      buckets.set(key, bucket);
    }
    bucket.geoms.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    merged.push(mesh);
  });
  for (const mesh of merged) {
    mesh.removeFromParent();
    mesh.geometry.dispose(); // never uploaded — merge runs before first render
  }
  for (const bucket of buckets.values()) {
    const geo = mergeGeometries(bucket.geoms, false);
    if (!geo) continue;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}
