import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
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
});
