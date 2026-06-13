import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import {
  frameOpaqueExtents,
  framePixelRect,
  idleDirectionHeightRatio,
  spriteAtlasLayout,
  validateSpriteManifest,
} from '../src/render/sprites/atlas';
import { SPRITE_MANIFESTS } from '../src/render/sprites/manifest.generated';

const ROOT = join(import.meta.dirname, '..');

function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${path}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readPngRgba(path: string): { width: number; height: number; rgba: Uint8Array } {
  const buf = readFileSync(path);
  let width = 0;
  let height = 0;
  const idats: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buf.length;) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idats.push(Buffer.from(data));
    }
    offset += 12 + len;
  }
  const inflated = inflateSync(Buffer.concat(idats));
  const rgba = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      const si = rowStart + x * 4;
      const oi = (y * width + x) * 4;
      rgba[oi] = inflated[si];
      rgba[oi + 1] = inflated[si + 1];
      rgba[oi + 2] = inflated[si + 2];
      rgba[oi + 3] = inflated[si + 3];
    }
  }
  return { width, height, rgba };
}

describe('sprite bake pipeline outputs', () => {
  for (const manifest of Object.values(SPRITE_MANIFESTS)) {
    it(`validates generated manifest for ${manifest.key}`, () => {
      expect(validateSpriteManifest(manifest)).toBeNull();
    });

    it(`PNG atlas matches manifest layout for ${manifest.key}`, () => {
      const rel = manifest.url.replace(/^\/+/, '');
      const path = join(ROOT, rel);
      expect(existsSync(path), `${rel} missing — run npm run bake:sprites`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(256);
      const layout = spriteAtlasLayout(manifest);
      const png = pngSize(path);
      expect(png).toEqual({ width: layout.width, height: layout.height });
    });
  }

  it('baked atlases have valid PNG headers', () => {
    for (const manifest of Object.values(SPRITE_MANIFESTS)) {
      const path = join(ROOT, manifest.url.replace(/^\/+/, ''));
      if (!existsSync(path)) continue;
      const buf = readFileSync(path);
      expect(buf.readUInt32BE(0)).toBe(0x89504e47);
      expect(buf[1]).toBe(0x50); // P
    }
  });

  it('rejects quick-mode row packing when dirs still claims the full count', () => {
    const bad = {
      key: 'mob_kobold',
      url: '/sprites/mobs/kobold.png',
      dirs: 8,
      frameSize: [96, 96] as [number, number],
      anchor: [48, 90] as [number, number],
      worldHeight: 2.1,
      states: {
        idle: { row: 0, frames: 1, fps: 6 },
        walk: { row: 2, frames: 1, fps: 10 },
      },
    };
    expect(validateSpriteManifest(bad)).toMatch(/align/);
  });

  it('rejects manifests whose dirs exceeds baked direction rows', () => {
    const bad = {
      key: 'mob_kobold',
      url: '/sprites/mobs/kobold.png',
      dirs: 8,
      frameSize: [96, 96] as [number, number],
      anchor: [48, 90] as [number, number],
      worldHeight: 2.1,
      states: {
        idle: { row: 0, frames: 1, fps: 6 },
        walk: { row: 2, frames: 1, fps: 10 },
        run: { row: 4, frames: 1, fps: 12 },
      },
    };
    // walk row 2 + dirs 8 would need rows 2..9 but atlas only has 2 dir rows per state block
    expect(validateSpriteManifest(bad)).toMatch(/align/);
  });

  it('accepts quick-mode manifests when dirs matches baked direction rows', () => {
    const quick = {
      key: 'mob_kobold',
      url: '/sprites/mobs/kobold.png',
      dirs: 2,
      frameSize: [96, 96] as [number, number],
      anchor: [48, 90] as [number, number],
      worldHeight: 2.1,
      states: {
        idle: { row: 0, frames: 1, fps: 6 },
        walk: { row: 2, frames: 1, fps: 10 },
      },
    };
    expect(validateSpriteManifest(quick)).toBeNull();
  });

  it('idle direction rows have consistent opaque height (no side-view shrink)', () => {
    const MAX_RATIO = 1.12;
    const QUADRUPED_MAX_RATIO = 2.0;
    for (const manifest of Object.values(SPRITE_MANIFESTS)) {
      if (!manifest.states.idle || manifest.dirs < 4) continue;
      const path = join(ROOT, manifest.url.replace(/^\/+/, ''));
      if (!existsSync(path)) continue;
      const { width, rgba } = readPngRgba(path);
      const ratio = idleDirectionHeightRatio(rgba, width, manifest);
      expect(ratio, `${manifest.key} idle direction height ratio`).not.toBeNull();
      const cap = manifest.key === 'mob_wolf' ? QUADRUPED_MAX_RATIO : MAX_RATIO;
      expect(ratio!, `${manifest.key} side vs front/back`).toBeLessThanOrEqual(cap);
    }
  });

  it('frameOpaqueExtents finds painted pixels in idle frame 0', () => {
    const manifest = SPRITE_MANIFESTS.player_mage;
    const path = join(ROOT, manifest.url.replace(/^\/+/, ''));
    if (!existsSync(path)) return;
    const { width, rgba } = readPngRgba(path);
    const ext = frameOpaqueExtents(rgba, width, 0, 0, 96, 96);
    expect(ext?.height ?? 0).toBeGreaterThan(24);
  });

  it('wolf side idle frames keep horizontal margin (no nose/tail clip)', () => {
    const manifest = SPRITE_MANIFESTS.mob_wolf;
    const path = join(ROOT, manifest.url.replace(/^\/+/, ''));
    if (!existsSync(path)) return;
    const { width, rgba } = readPngRgba(path);
    const [fw, fh] = manifest.frameSize;
    const idle = manifest.states.idle;
    const MIN_MARGIN = 4;
    for (let d = 0; d < manifest.dirs; d++) {
      const rect = framePixelRect(manifest, idle.row + d, 0);
      const ext = frameOpaqueExtents(rgba, width, rect.x, rect.y, fw, fh);
      if (!ext) continue;
      if (ext.width < fw * 0.55) continue; // front/back are narrow — side rows are wide
      expect(ext.minX, `dir ${d} minX`).toBeGreaterThanOrEqual(MIN_MARGIN);
      expect(ext.maxX, `dir ${d} maxX`).toBeLessThanOrEqual(fw - 1 - MIN_MARGIN);
    }
  });
});
