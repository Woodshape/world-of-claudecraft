import * as THREE from 'three';
import { loadTexture } from '../assets/loader';
import { registerPreload } from '../assets/preload';
import { STYLE } from '../gfx';
import type { SpriteManifest } from './types';

const TAU = Math.PI * 2;

/** Camera-relative direction bucket (0 = entity faces camera). */
export function directionIndex(
  camX: number,
  camZ: number,
  entX: number,
  entZ: number,
  facing: number,
  dirCount: number,
): number {
  const viewAngle = Math.atan2(camX - entX, camZ - entZ);
  let relative = viewAngle - facing;
  while (relative > Math.PI) relative -= TAU;
  while (relative < -Math.PI) relative += TAU;
  const idx = Math.round(relative / (TAU / dirCount));
  return ((idx % dirCount) + dirCount) % dirCount;
}

const atlasCache = new Map<string, THREE.Texture>();
const atlasPromises = new Map<string, Promise<THREE.Texture>>();

const SPIKE_PALETTES: Record<string, { body: string; trim: string; accent: string }> = {
  player_mage: { body: '#4a7fd4', trim: '#2a4f94', accent: '#9ed0ff' },
  mob_kobold: { body: '#5a9a42', trim: '#2f5a22', accent: '#c8e878' },
  skel_minion: { body: '#c8c4b8', trim: '#6a6660', accent: '#f0ece0' },
};

export interface SpriteAtlasLayout {
  cols: number;
  rows: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
}

/** Packed atlas grid size derived from manifest state rows and frame counts. */
export function spriteAtlasLayout(manifest: SpriteManifest): SpriteAtlasLayout {
  let maxCol = 0;
  let maxRow = manifest.dirs;
  for (const st of Object.values(manifest.states)) {
    maxCol = Math.max(maxCol, st.frames);
    maxRow = Math.max(maxRow, st.row + manifest.dirs);
  }
  const [frameWidth, frameHeight] = manifest.frameSize;
  return {
    cols: maxCol,
    rows: maxRow,
    width: maxCol * frameWidth,
    height: maxRow * frameHeight,
    frameWidth,
    frameHeight,
  };
}

export interface SpriteFrameRect {
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Validate manifest row grouping (state blocks × direction rows). */
export function validateSpriteManifest(manifest: SpriteManifest): string | null {
  if (manifest.dirs < 1) return 'dirs must be >= 1';
  const [fw, fh] = manifest.frameSize;
  if (fw <= 0 || fh <= 0) return 'frameSize must be positive';
  const [ax, ay] = manifest.anchor;
  if (ax < 0 || ax > fw || ay < 0 || ay > fh) return 'anchor outside frame';
  if (manifest.worldHeight <= 0) return 'worldHeight must be positive';

  const entries = Object.entries(manifest.states);
  if (entries.length === 0) return 'states must not be empty';

  const blocks = entries.map(([key, st]) => {
    if (st.frames < 1) return `${key}: frames must be >= 1`;
    if (st.fps <= 0) return `${key}: fps must be > 0`;
    if (st.row < 0) return `${key}: row must be >= 0`;
    if (st.row % manifest.dirs !== 0) {
      return `${key}: row ${st.row} must align to direction blocks (multiple of ${manifest.dirs})`;
    }
    return null;
  });
  const blockErr = blocks.find((e) => e !== null);
  if (blockErr) return blockErr;

  const sorted = entries
    .map(([key, st]) => ({ key, start: st.row, end: st.row + manifest.dirs }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return `overlapping state rows: ${sorted[i - 1].key} and ${sorted[i].key}`;
    }
  }
  return null;
}

function textureImageSize(tex: THREE.Texture): { width: number; height: number } | null {
  const img = tex.image as { width?: number; height?: number } | undefined;
  if (!img?.width || !img?.height) return null;
  return { width: img.width, height: img.height };
}

function assertAtlasTextureSize(tex: THREE.Texture, manifest: SpriteManifest): void {
  const expected = spriteAtlasLayout(manifest);
  const got = textureImageSize(tex);
  if (!got) return;
  if (got.width !== expected.width || got.height !== expected.height) {
    console.warn(
      `sprite atlas size mismatch for ${manifest.key}: expected ${expected.width}x${expected.height}, got ${got.width}x${got.height}`,
    );
  }
}

/** Procedural pixel-art atlas for the Phase 1 spike when baked PNGs are absent. */
function buildProceduralAtlas(manifest: SpriteManifest): THREE.CanvasTexture {
  const [fw, fh] = manifest.frameSize;
  const { cols, rows } = spriteAtlasLayout(manifest);
  const palette = SPIKE_PALETTES[manifest.key] ?? { body: '#888', trim: '#444', accent: '#ccc' };

  const canvas = document.createElement('canvas');
  canvas.width = cols * fw;
  canvas.height = rows * fh;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * fw;
      const y = row * fh;
      const dir = row % manifest.dirs;
      const frame = col;
      drawSpikeFrame(ctx, x, y, fw, fh, dir, frame, palette);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function drawSpikeFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fw: number,
  fh: number,
  dir: number,
  frame: number,
  palette: { body: string; trim: string; accent: string },
): void {
  ctx.fillStyle = '#0000';
  ctx.clearRect(x, y, fw, fh);

  const cx = x + fw * 0.5;
  const footY = y + fh * 0.88;
  const bob = Math.sin(frame * 1.4) * 2;
  const bodyH = fh * 0.42;
  const bodyW = fw * 0.34;

  // Direction wedge behind the figure — makes camera rotation obvious in the spike.
  const angle = (dir / 8) * TAU;
  const wedgeLen = fw * 0.22;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.moveTo(cx, footY - bodyH * 0.5 + bob);
  ctx.lineTo(
    cx + Math.sin(angle) * wedgeLen,
    footY - bodyH * 0.5 + bob - Math.cos(angle) * wedgeLen,
  );
  ctx.lineTo(
    cx + Math.sin(angle + 0.35) * wedgeLen * 0.55,
    footY - bodyH * 0.5 + bob - Math.cos(angle + 0.35) * wedgeLen * 0.55,
  );
  ctx.closePath();
  ctx.fill();

  // Body block
  ctx.fillStyle = palette.body;
  ctx.fillRect(cx - bodyW * 0.5, footY - bodyH + bob, bodyW, bodyH);

  // Head
  const headR = fw * 0.14;
  ctx.fillStyle = palette.trim;
  ctx.beginPath();
  ctx.arc(cx, footY - bodyH - headR + bob, headR, 0, TAU);
  ctx.fill();

  // Facing marker on the chest (points +Z at dir 0)
  const markX = cx + Math.sin(angle) * bodyW * 0.35;
  const markY = footY - bodyH * 0.55 + bob - Math.cos(angle) * bodyW * 0.2;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(markX - 3, markY - 3, 6, 6);

  // Legs (walk cycle)
  const legSwing = Math.sin(frame * 1.8) * 4;
  ctx.fillStyle = palette.trim;
  ctx.fillRect(cx - bodyW * 0.35, footY - 10 + bob, 8, 10 + legSwing);
  ctx.fillRect(cx + bodyW * 0.15, footY - 10 + bob, 8, 10 - legSwing);

  // Outline
  ctx.strokeStyle = '#1a1420';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - bodyW * 0.5, footY - bodyH + bob, bodyW, bodyH);
}

function configureAtlasTexture(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = STYLE.spriteMode ? THREE.NearestFilter : THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function loadSpriteAtlas(manifest: SpriteManifest): Promise<THREE.Texture> {
  const cached = atlasCache.get(manifest.key);
  if (cached) return Promise.resolve(cached);

  let pending = atlasPromises.get(manifest.key);
  if (!pending) {
    const manifestErr = validateSpriteManifest(manifest);
    if (manifestErr) {
      pending = Promise.reject(new Error(`invalid sprite manifest ${manifest.key}: ${manifestErr}`));
    } else {
      pending = loadTexture(manifest.url, { srgb: true })
        .then((tex) => {
          configureAtlasTexture(tex);
          assertAtlasTextureSize(tex, manifest);
          return tex;
        })
        .catch(() => buildProceduralAtlas(manifest))
        .then((tex) => {
          atlasCache.set(manifest.key, tex);
          return tex;
        });
    }
    atlasPromises.set(manifest.key, pending);
    registerPreload(pending);
  }
  return pending;
}

export function spriteAtlasReady(manifest: SpriteManifest): THREE.Texture | null {
  return atlasCache.get(manifest.key) ?? null;
}

/** Per-visual atlas copy — repeat/offset are mutated per sprite instance. */
export function spriteAtlasInstance(tex: THREE.Texture): THREE.Texture {
  return tex.clone();
}

/** Test hook: install a minimal atlas texture without loading PNGs or canvas. */
export function seedSpriteAtlasForTest(manifest: SpriteManifest): THREE.Texture {
  const { cols, rows } = spriteAtlasLayout(manifest);
  const [fw, fh] = manifest.frameSize;
  const data = new Uint8Array(cols * fw * rows * fh * 4);
  const tex = new THREE.DataTexture(data, cols * fw, rows * fh);
  tex.needsUpdate = true;
  configureAtlasTexture(tex);
  atlasCache.set(manifest.key, tex);
  atlasPromises.set(manifest.key, Promise.resolve(tex));
  return tex;
}

export function uvRect(
  manifest: SpriteManifest,
  row: number,
  col: number,
): { u0: number; v0: number; u1: number; v1: number } {
  const { width: texW, height: texH, frameWidth: fw, frameHeight: fh } = spriteAtlasLayout(manifest);
  const u0 = (col * fw) / texW;
  const u1 = ((col + 1) * fw) / texW;
  const v1 = 1 - (row * fh) / texH;
  const v0 = 1 - ((row + 1) * fh) / texH;
  return { u0, v0, u1, v1 };
}

/** Pixel-space frame rect within the packed atlas (top-left origin). */
export function framePixelRect(manifest: SpriteManifest, row: number, col: number): SpriteFrameRect {
  const { frameWidth: fw, frameHeight: fh } = spriteAtlasLayout(manifest);
  const uv = uvRect(manifest, row, col);
  return {
    row,
    col,
    x: col * fw,
    y: row * fh,
    w: fw,
    h: fh,
    ...uv,
  };
}

/** Resolve state + direction + frame into atlas coordinates and UVs. */
export function resolveSpriteFrame(
  manifest: SpriteManifest,
  state: { row: number; frames: number },
  dirIdx: number,
  frameIdx: number,
): SpriteFrameRect {
  const row = state.row + dirIdx;
  const col = Math.min(Math.max(0, frameIdx), state.frames - 1);
  return framePixelRect(manifest, row, col);
}
