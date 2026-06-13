import type { SpriteManifest } from './types';
import { SPRITE_MANIFESTS } from './manifest.generated';

export { SPRITE_MANIFESTS };

/** Phase 1 spike: only these visual keys route through the sprite runtime. */
export const SPRITE_SPIKE_KEYS = new Set([
  'player_mage',
  'mob_kobold',
  'skel_minion',
]);

export function isSpriteSpikeKey(key: string): boolean {
  return SPRITE_SPIKE_KEYS.has(key);
}

export function spriteManifestFor(key: string): SpriteManifest | null {
  return SPRITE_MANIFESTS[key] ?? null;
}

export function spriteManifestUrls(): string[] {
  return [...SPRITE_SPIKE_KEYS]
    .map((k) => SPRITE_MANIFESTS[k]?.url)
    .filter((u): u is string => !!u);
}
