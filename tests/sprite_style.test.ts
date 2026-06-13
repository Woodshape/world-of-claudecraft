import { describe, expect, it } from 'vitest';
import { directionIndex } from '../src/render/sprites/atlas';
import { isSpriteSpikeKey, SPRITE_SPIKE_KEYS } from '../src/render/sprites/manifest';

describe('sprite directionIndex', () => {
  it('returns 0 when camera is behind entity facing +Z', () => {
    // Entity at origin facing +Z (0 rad); camera south (+Z) looks north at entity back
    expect(directionIndex(0, 10, 0, 0, 0, 8)).toBe(0);
  });

  it('returns 4 when camera is in front of entity facing +Z', () => {
    expect(directionIndex(0, -10, 0, 0, 0, 8)).toBe(4);
  });

  it('wraps for all 8 directions', () => {
    const indices = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const cx = Math.sin(angle) * 20;
      const cz = Math.cos(angle) * 20;
      indices.add(directionIndex(cx, cz, 0, 0, 0, 8));
    }
    expect(indices.size).toBeGreaterThan(4);
  });
});

describe('sprite spike keys', () => {
  it('includes mage, kobold, and skeleton minion', () => {
    expect(SPRITE_SPIKE_KEYS.has('player_mage')).toBe(true);
    expect(SPRITE_SPIKE_KEYS.has('mob_kobold')).toBe(true);
    expect(SPRITE_SPIKE_KEYS.has('skel_minion')).toBe(true);
    expect(isSpriteSpikeKey('player_warrior')).toBe(false);
  });
});
