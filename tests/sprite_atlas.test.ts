import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  framePixelRect,
  resolveSpriteFrame,
  seedSpriteAtlasForTest,
  spriteAtlasLayout,
  uvRect,
  validateSpriteManifest,
} from '../src/render/sprites/atlas';
import { SPRITE_MANIFESTS } from '../src/render/sprites/manifest.generated';
import type { SpriteManifest } from '../src/render/sprites/types';

describe('sprite atlas layout', () => {
  it('derives packed atlas dimensions from generated manifests', () => {
    expect(spriteAtlasLayout(SPRITE_MANIFESTS.mob_kobold)).toEqual({
      cols: 6,
      rows: 48,
      width: 576,
      height: 4608,
      frameWidth: 96,
      frameHeight: 96,
    });
    expect(spriteAtlasLayout(SPRITE_MANIFESTS.player_mage)).toEqual({
      cols: 6,
      rows: 64,
      width: 576,
      height: 6144,
      frameWidth: 96,
      frameHeight: 96,
    });
  });

  it('validates all generated manifests', () => {
    for (const manifest of Object.values(SPRITE_MANIFESTS)) {
      expect(validateSpriteManifest(manifest)).toBeNull();
    }
  });

  it('rejects overlapping state row blocks', () => {
    const bad: SpriteManifest = {
      key: 'bad',
      url: '/sprites/bad.png',
      dirs: 4,
      frameSize: [96, 96],
      anchor: [48, 84],
      worldHeight: 2,
      states: {
        idle: { row: 0, frames: 4, fps: 6 },
        walk: { row: 0, frames: 6, fps: 10 },
      },
    };
    expect(validateSpriteManifest(bad)).toMatch(/overlapping state rows/);
  });

  it('generates UV rects from manifest rows/cols, not hardcoded coords', () => {
    const manifest = SPRITE_MANIFESTS.mob_kobold;
    const idle = uvRect(manifest, 0, 0);
    const walkFront = uvRect(manifest, manifest.states.walk.row, 0);
    const walkSide = uvRect(manifest, manifest.states.walk.row + 2, 3);

    expect(idle.u0).toBe(0);
    expect(idle.v1).toBe(1);
    expect(walkFront.v0).toBeLessThan(idle.v0);
    expect(walkSide.u0).toBeCloseTo(3 / 6, 5);
    expect(walkSide.u1 - walkSide.u0).toBeCloseTo(1 / 6, 5);
  });

  it('maps state + direction + frame through resolveSpriteFrame', () => {
    const manifest = SPRITE_MANIFESTS.mob_kobold;
    const walk = manifest.states.walk;
    const frame = resolveSpriteFrame(manifest, walk, 3, 2);
    expect(frame).toEqual({
      row: walk.row + 3,
      col: 2,
      x: 192,
      y: (walk.row + 3) * 96,
      w: 96,
      h: 96,
      ...uvRect(manifest, walk.row + 3, 2),
    });
    expect(framePixelRect(manifest, frame.row, frame.col)).toEqual(frame);
  });

  it('seeds test atlases at manifest layout size with nearest filtering', () => {
    const manifest = SPRITE_MANIFESTS.skel_minion;
    const layout = spriteAtlasLayout(manifest);
    const tex = seedSpriteAtlasForTest(manifest);
    expect(tex.image.width).toBe(layout.width);
    expect(tex.image.height).toBe(layout.height);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
  });
});
