// Browser-side GLB sprite capture for scripts/bake_sprites.mjs.
// Loads manifest visuals, renders animation frames from multiple yaw angles,
// and returns raw RGBA atlases for Node-side pixel treatment.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VISUALS, type ClipMap, type VisualDef } from '../../src/render/characters/manifest';

const TAU = Math.PI * 2;

export interface BakeStateSpec {
  name: string;
  clip: string;
  fps: number;
  maxFrames: number;
  once?: boolean;
}

export interface BakeTargetSpec {
  key: string;
  visualKey: string;
  dirs: number;
  frameSize: [number, number];
  /** Internal render resolution multiplier (nearest-downscaled in Node). */
  renderScale: number;
  url: string;
  states: BakeStateSpec[];
}

export interface BakedStateManifest {
  row: number;
  frames: number;
  fps: number;
  once?: boolean;
}

export interface BakeAtlasResult {
  key: string;
  url: string;
  width: number;
  height: number;
  /** Base64-encoded raw RGBA (no compression). */
  rgbaB64: string;
  dirs: number;
  frameSize: [number, number];
  anchor: [number, number];
  worldHeight: number;
  states: Record<string, BakedStateManifest>;
}

const gltfCache = new Map<string, GLTF>();
let loader: GLTFLoader | null = null;

function gltfLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

async function loadGltf(url: string): Promise<GLTF> {
  const hit = gltfCache.get(url);
  if (hit) return hit;
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    gltfLoader().load(url, resolve, undefined, () => reject(new Error(`GLB load failed: ${url}`)));
  });
  gltfCache.set(url, gltf);
  return gltf;
}

async function preloadVisual(def: VisualDef): Promise<void> {
  await loadGltf(`/${def.url}`);
  for (const att of def.attach ?? []) await loadGltf(`/${att.url}`);
}

/** Baked atlases are untinted source art; all color grading happens at runtime via applySpriteMaterialTint. */
function applyBakeMaterials(root: THREE.Object3D, _def: VisualDef): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshBasicMaterial({
      map: src.map ?? null,
      transparent: src.transparent,
      opacity: src.opacity,
      side: src.side,
      alphaTest: 0.04,
    });
    if (src.map) src.map.colorSpace = THREE.SRGBColorSpace;
    mesh.material = mat;
  });
}

function initTextures(renderer: THREE.WebGLRenderer, root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const map = (m as THREE.MeshBasicMaterial).map;
      if (map) renderer.initTexture(map);
    }
  });
}

function assembleModel(def: VisualDef): THREE.Object3D {
  const root = cloneSkinned(loadGltfSync(def.url).scene);
  if (def.show) {
    const keep = new Set(def.show);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && !keep.has(o.name)) {
        o.visible = false;
      }
    });
  }
  for (const att of def.attach ?? []) {
    const bone = root.getObjectByName(att.bone)
      ?? root.getObjectByName(att.bone.replace(/[[\].:/]/g, ''));
    if (!bone) continue;
    const prop = cloneSkinned(loadGltfSync(att.url).scene);
    if (att.position) prop.position.set(...att.position);
    if (att.rotationY) prop.rotation.y = att.rotationY;
    bone.add(prop);
  }
  return root;
}

function loadGltfSync(url: string): GLTF {
  const g = gltfCache.get(url.startsWith('/') ? url : `/${url}`);
  if (!g) throw new Error(`GLB not preloaded: ${url}`);
  return g;
}

function meshChainVisible(o: THREE.Object3D, stopAt: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    if (cur === stopAt) return true;
    cur = cur.parent;
  }
  return false;
}

interface NormalizedRig {
  root: THREE.Group;
  /** Skinned model root — AnimationMixer target (matches CharacterVisual). */
  model: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  normScale: number;
  yOffset: number;
  height: number;
}

function prepareRig(def: VisualDef): NormalizedRig {
  const gltf = loadGltfSync(`/${def.url}`);
  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) clips.set(clip.name, clip);

  const temp = assembleModel(def);
  applyBakeMaterials(temp, def);

  const idle = clips.get(def.clips.idle);
  if (idle) {
    const mixer = new THREE.AnimationMixer(temp);
    mixer.clipAction(idle).play();
    mixer.update(Math.min(0.5, idle.duration * 0.5));
    temp.updateMatrixWorld(true);
    temp.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) sm.skeleton.update();
    });
    mixer.stopAllAction();
  } else {
    temp.updateMatrixWorld(true);
  }

  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  temp.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !meshChainVisible(sm, temp)) return;
    const pos = sm.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      sm.applyBoneTransform(i, v);
      v.applyMatrix4(sm.matrixWorld);
      bounds.expandByPoint(v);
    }
  });

  const rawHeight = Math.max(1e-3, bounds.max.y - bounds.min.y);
  const normScale = def.height / rawHeight;
  const yOffset = (def.hover ?? 0) - bounds.min.y * normScale;

  const root = new THREE.Group();
  const modelWrap = new THREE.Group();
  modelWrap.rotation.y = def.yaw ?? 0;
  modelWrap.scale.setScalar(normScale);
  modelWrap.position.y = yOffset;
  modelWrap.add(temp);
  root.add(modelWrap);

  return { root, model: temp, clips, normScale, yOffset, height: def.height };
}

function poseRig(rig: NormalizedRig, clipName: string, time: number): void {
  const clip = rig.clips.get(clipName);
  if (!clip) return;
  const mixer = new THREE.AnimationMixer(rig.model);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(Math.min(Math.max(0, time), clip.duration - 1e-4));
  rig.root.updateMatrixWorld(true);
  rig.root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) sm.skeleton.update();
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(rig.model);
}

function frameCountForClip(clip: THREE.AnimationClip | undefined, fps: number, maxFrames: number): number {
  if (!clip) return 1;
  return Math.min(maxFrames, Math.max(1, Math.round(clip.duration * fps)));
}

function buildStates(def: VisualDef, dirs: number): BakeStateSpec[] {
  const specs: BakeStateSpec[] = [];
  const add = (name: string, clip: string | undefined, fps: number, maxFrames: number, once?: boolean) => {
    if (!clip) return;
    specs.push({ name, clip, fps, maxFrames, once });
  };
  const c = def.clips;
  add('idle', c.idle, 6, 4);
  add('walk', c.walk, 10, 6);
  add('run', c.run, 12, 6);
  add('walkBack', c.walkBack, 10, 6);
  add('attack', c.attack[0], 12, 5, true);
  add('hit', c.hit?.[0], 12, 3, true);
  add('cast', c.cast, 8, 4);
  add('death', c.death, 10, 6, true);
  return specs;
}

export function bakeTargetsFromManifest(): BakeTargetSpec[] {
  const entries: Array<{ key: string; visualKey: string; dirs: number; out: string }> = [
    { key: 'player_mage', visualKey: 'player_mage', dirs: 8, out: '/sprites/chars/mage.png' },
    { key: 'mob_kobold', visualKey: 'mob_kobold', dirs: 8, out: '/sprites/mobs/kobold.png' },
    { key: 'skel_minion', visualKey: 'skel_minion', dirs: 8, out: '/sprites/mobs/skel_minion.png' },
    { key: 'mob_wolf', visualKey: 'mob_wolf', dirs: 8, out: '/sprites/mobs/wolf.png' },
  ];
  return entries.map(({ key, visualKey, dirs, out }) => {
    const def = VISUALS[visualKey];
    if (!def) throw new Error(`unknown visual: ${visualKey}`);
    return {
      key,
      visualKey,
      dirs,
      frameSize: [96, 96],
      renderScale: visualKey === 'mob_wolf' ? 2.75 : 2.0,
      url: out,
      states: buildStates(def, dirs),
    };
  });
}

const BOX_CORNERS = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];

function fillBoxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  BOX_CORNERS[0].set(min.x, min.y, min.z);
  BOX_CORNERS[1].set(min.x, min.y, max.z);
  BOX_CORNERS[2].set(min.x, max.y, min.z);
  BOX_CORNERS[3].set(min.x, max.y, max.z);
  BOX_CORNERS[4].set(max.x, min.y, min.z);
  BOX_CORNERS[5].set(max.x, min.y, max.z);
  BOX_CORNERS[6].set(max.x, max.y, min.z);
  BOX_CORNERS[7].set(max.x, max.y, max.z);
  return BOX_CORNERS;
}

function boundsFocus(box: THREE.Box3): { center: THREE.Vector3; centerY: number } {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const headroomMaxY = box.max.y + size.y * 0.1;
  center.y = (box.min.y + headroomMaxY) * 0.5;
  return { center, centerY: center.y };
}

/** Screen-space half-extents of an AABB in camera view space. */
function screenExtentsInCamera(box: THREE.Box3, camera: THREE.Camera): { halfW: number; halfH: number } {
  camera.updateMatrixWorld(true);
  const inv = camera.matrixWorldInverse;
  const v = new THREE.Vector3();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const corner of fillBoxCorners(box)) {
    v.copy(corner).applyMatrix4(inv);
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  return { halfW: (maxX - minX) * 0.5, halfH: (maxY - minY) * 0.5 };
}

/** One ortho half-size for every yaw — side views no longer shrink vs front/back. */
function computeCaptureHalf(
  box: THREE.Box3,
  dirCount: number,
  padding = 1.18,
  capturePadXZ = 0.08,
): number {
  const size = box.getSize(new THREE.Vector3());
  const captureBox = box.clone();
  const padXZ = Math.max(size.x, size.z) * capturePadXZ;
  captureBox.min.x -= padXZ;
  captureBox.max.x += padXZ;
  captureBox.min.z -= padXZ;
  captureBox.max.z += padXZ;
  captureBox.max.y += size.y * 0.05;
  const { center } = boundsFocus(captureBox);
  let maxHalf = 0;
  for (let d = 0; d < dirCount; d++) {
    const probe = cameraForCapture(1, center, d, dirCount);
    const { halfW, halfH } = screenExtentsInCamera(captureBox, probe);
    maxHalf = Math.max(maxHalf, halfW, halfH);
  }
  return Math.max(maxHalf * padding, 0.3);
}

function cameraForCapture(
  half: number,
  center: THREE.Vector3,
  dir: number,
  dirCount: number,
): THREE.OrthographicCamera {
  const angle = (dir / dirCount) * TAU;
  const dist = half * 8;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, half * 24);
  cam.position.set(
    center.x + Math.sin(angle) * dist,
    center.y,
    center.z + Math.cos(angle) * dist,
  );
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  return cam;
}

interface AlphaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  contentW: number;
  contentH: number;
}

function alphaBounds(src: Uint8Array, srcSize: number): AlphaBounds {
  let minX = srcSize;
  let minY = srcSize;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < srcSize; y++) {
    for (let x = 0; x < srcSize; x++) {
      const a = src[(y * srcSize + x) * 4 + 3];
      if (a < 12) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX <= minX) {
    return { minX: 0, minY: 0, maxX: srcSize - 1, maxY: srcSize - 1, contentW: srcSize, contentH: srcSize };
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    contentW: maxX - minX + 1,
    contentH: maxY - minY + 1,
  };
}

function projectedScale(
  contentW: number,
  contentH: number,
  frameW: number,
  frameH: number,
): number {
  const topReserve = Math.round(frameH * 0.16);
  const bottomReserve = Math.round(frameH * 0.05);
  const availH = frameH - topReserve - bottomReserve;
  return Math.min((frameW * 0.90) / contentW, availH / contentH);
}

function projectedDrawH(
  contentW: number,
  contentH: number,
  frameW: number,
  frameH: number,
): number {
  return Math.max(1, Math.round(contentH * projectedScale(contentW, contentH, frameW, frameH)));
}

function frameBounds(rig: NormalizedRig): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  rig.root.updateMatrixWorld(true);
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return;
    const sm = mesh as THREE.SkinnedMesh;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (sm.isSkinnedMesh) {
        sm.applyBoneTransform(i, v);
        v.applyMatrix4(sm.matrixWorld);
      } else {
        v.applyMatrix4(mesh.matrixWorld);
      }
      box.expandByPoint(v);
    }
  });
  if (box.isEmpty()) {
    box.setFromCenterAndSize(
      new THREE.Vector3(0, rig.height * 0.5, 0),
      new THREE.Vector3(1, rig.height, 1),
    );
  }
  return box;
}

function renderFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: number,
): Uint8Array {
  renderer.setSize(size, size, false);
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const out = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, out);
  renderer.setRenderTarget(null);
  rt.dispose();
  return out;
}

function blitFrame(
  atlas: Uint8Array,
  atlasW: number,
  atlasH: number,
  row: number,
  col: number,
  frameW: number,
  frameH: number,
  src: Uint8Array,
  srcSize: number,
  fixedDrawH?: number,
): [number, number] {
  // Nearest downscale + alpha-aware crop with feet anchored near frame bottom center.
  const { minX, minY, maxX, maxY, contentW, contentH } = alphaBounds(src, srcSize);
  const topReserve = Math.round(frameH * 0.16);
  const bottomReserve = Math.round(frameH * 0.05);
  const maxDrawW = frameW * 0.90;
  let scale = fixedDrawH !== undefined
    ? fixedDrawH / contentH
    : projectedScale(contentW, contentH, frameW, frameH);
  if (contentW * scale > maxDrawW) scale = maxDrawW / contentW;
  const drawH = Math.max(1, Math.round(contentH * scale));
  const drawW = Math.max(1, Math.round(contentW * scale));
  const destX0 = Math.round((frameW - drawW) * 0.5);
  const destY0 = frameH - bottomReserve - drawH;

  const dx = col * frameW;
  const dy = row * frameH;

  for (let fy = 0; fy < frameH; fy++) {
    for (let fx = 0; fx < frameW; fx++) {
      const o = ((dy + fy) * atlasW + (dx + fx)) * 4;
      atlas[o] = 0;
      atlas[o + 1] = 0;
      atlas[o + 2] = 0;
      atlas[o + 3] = 0;
    }
  }

  for (let fy = 0; fy < drawH; fy++) {
    for (let fx = 0; fx < drawW; fx++) {
      const sx = minX + Math.floor((fx / drawW) * contentW);
      // readRenderTargetPixels is bottom-left origin; atlas PNG rows are top-left.
      const sy = maxY - Math.floor((fy / drawH) * contentH);
      const si = (sy * srcSize + sx) * 4;
      const px = destX0 + fx;
      const py = destY0 + fy;
      if (px < 0 || py < 0 || px >= frameW || py >= frameH) continue;
      const o = ((dy + py) * atlasW + (dx + px)) * 4;
      atlas[o] = src[si];
      atlas[o + 1] = src[si + 1];
      atlas[o + 2] = src[si + 2];
      atlas[o + 3] = src[si + 3];
    }
  }

  const footX = dx + destX0 + Math.floor(drawW * 0.5);
  let footY = dy + destY0 + drawH - 1;
  for (let y = destY0 + drawH - 1; y >= destY0; y--) {
    let found = false;
    for (let x = destX0; x < destX0 + drawW; x++) {
      if (atlas[((dy + y) * atlasW + (dx + x)) * 4 + 3] > 12) {
        footY = dy + y;
        found = true;
        break;
      }
    }
    if (found) break;
  }
  return [footX - dx, footY - dy];
}

function rgbaToB64(rgba: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < rgba.length; i += chunk) {
    bin += String.fromCharCode(...rgba.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function bakeAll(targets: BakeTargetSpec[], quick = false): Promise<BakeAtlasResult[]> {
  for (const t of targets) await preloadVisual(VISUALS[t.visualKey]);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 0.45);
  key.position.set(2, 4, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d8ff, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const results: BakeAtlasResult[] = [];

  for (const target of targets) {
    const def = VISUALS[target.visualKey];
    const rig = prepareRig(def);
    initTextures(renderer, rig.root);
    scene.add(rig.root);

    const [frameW, frameH] = target.frameSize;
    const renderSize = Math.round(Math.max(frameW, frameH) * target.renderScale);
    const dirs = quick ? 2 : target.dirs;

    let maxCols = 0;
    let rowCursor = 0;
    const bakedStates: Record<string, BakedStateManifest> = {};
    const statePlans: Array<{ spec: BakeStateSpec; row: number; frames: number }> = [];

    for (const spec of target.states) {
      const clip = rig.clips.get(spec.clip);
      const frames = quick ? 1 : frameCountForClip(clip, spec.fps, spec.maxFrames);
      bakedStates[spec.name] = { row: rowCursor, frames, fps: spec.fps, once: spec.once };
      statePlans.push({ spec, row: rowCursor, frames });
      maxCols = Math.max(maxCols, frames);
      rowCursor += dirs;
    }

    const atlasW = maxCols * frameW;
    const atlasH = rowCursor * frameH;
    const atlas = new Uint8Array(atlasW * atlasH * 4);

    let anchor: [number, number] = [Math.round(frameW * 0.5), Math.round(frameH * 0.875)];

    for (const plan of statePlans) {
      const clip = rig.clips.get(plan.spec.clip);
      const stateDrawH: number[] = [];

      for (let f = 0; f < plan.frames; f++) {
        const t = plan.frames <= 1
          ? 0
          : (f / (plan.frames - 1)) * ((clip?.duration ?? 0.5) - 1e-4);
        poseRig(rig, plan.spec.clip, t);
        const bounds = frameBounds(rig);
        const { center } = boundsFocus(bounds);
        const captureHalf = computeCaptureHalf(
          bounds,
          dirs,
          target.visualKey === 'mob_wolf' ? 1.32 : 1.18,
          target.visualKey === 'mob_wolf' ? 0.16 : 0.08,
        );
        let maxDrawH = 0;
        for (let d = 0; d < dirs; d++) {
          const camera = cameraForCapture(captureHalf, center, d, dirs);
          const raw = renderFrame(renderer, scene, camera, renderSize);
          const ab = alphaBounds(raw, renderSize);
          maxDrawH = Math.max(maxDrawH, projectedDrawH(ab.contentW, ab.contentH, frameW, frameH));
        }
        stateDrawH[f] = maxDrawH;
      }

      for (let f = 0; f < plan.frames; f++) {
        const t = plan.frames <= 1
          ? 0
          : (f / (plan.frames - 1)) * ((clip?.duration ?? 0.5) - 1e-4);
        poseRig(rig, plan.spec.clip, t);
        const bounds = frameBounds(rig);
        const { center } = boundsFocus(bounds);
        const captureHalf = computeCaptureHalf(
          bounds,
          dirs,
          target.visualKey === 'mob_wolf' ? 1.32 : 1.18,
          target.visualKey === 'mob_wolf' ? 0.16 : 0.08,
        );
        const uniformDrawH = stateDrawH[f];
        for (let d = 0; d < dirs; d++) {
          const camera = cameraForCapture(captureHalf, center, d, dirs);
          const raw = renderFrame(renderer, scene, camera, renderSize);
          const foot = blitFrame(
            atlas,
            atlasW,
            atlasH,
            plan.row + d,
            f,
            frameW,
            frameH,
            raw,
            renderSize,
            uniformDrawH,
          );
          if (plan.spec.name === 'idle' && d === 0 && f === 0) anchor = foot;
        }
      }
    }

    scene.remove(rig.root);

    results.push({
      key: target.key,
      url: target.url,
      width: atlasW,
      height: atlasH,
      rgbaB64: rgbaToB64(atlas),
      dirs, // actual baked direction rows (2 in quick mode, target.dirs otherwise)
      frameSize: target.frameSize,
      anchor,
      worldHeight: def.height,
      states: bakedStates,
    });
  }

  renderer.dispose();
  return results;
}

declare global {
  interface Window {
    __bakeAll?: typeof bakeAll;
    __bakeTargetsFromManifest?: typeof bakeTargetsFromManifest;
  }
}

window.__bakeAll = bakeAll;
window.__bakeTargetsFromManifest = bakeTargetsFromManifest;
