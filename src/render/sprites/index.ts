// Sprite visual system — directional impostors for the ?style=sprite spike.
import { STYLE } from '../gfx';
import { loadSpriteAtlas } from './atlas';
import { isSpriteSpikeKey, spriteManifestFor, SPRITE_SPIKE_KEYS } from './manifest';

if (STYLE.spriteMode) {
  for (const key of SPRITE_SPIKE_KEYS) {
    const m = spriteManifestFor(key);
    if (m) void loadSpriteAtlas(m);
  }
}

export { SpriteCharacterVisual } from './sprite_visual';
export { directionIndex } from './atlas';
export { isSpriteSpikeKey, SPRITE_SPIKE_KEYS } from './manifest';
