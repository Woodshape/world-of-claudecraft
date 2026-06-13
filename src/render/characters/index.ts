// Character visual system — rigged glTF replacements for the old procedural
// rigs. Asset fetches start at module import (see assets.ts) and register
// with the preload gate, so createCharacterVisual is synchronous by the time
// the Renderer constructs views.
import type { Entity } from '../../sim/types';
import { STYLE } from '../gfx';
import { CharacterVisual } from './visual';
import { visualKeyFor } from './manifest';
import { isSpriteSpikeKey } from '../sprites/manifest';
import { SpriteCharacterVisual } from '../sprites/sprite_visual';
import '../sprites';

export { CharacterVisual } from './visual';
export type { AnimState } from './visual';

export type ICharacterVisual = CharacterVisual | SpriteCharacterVisual;

/** Build the visual for an entity (or an explicit form key: polymorph/bear). */
export function createCharacterVisual(e: Entity, formKey?: 'form_sheep' | 'form_bear'): ICharacterVisual {
  const key = formKey ?? visualKeyFor(e);
  if (STYLE.spriteMode && isSpriteSpikeKey(key)) {
    return new SpriteCharacterVisual(key, e.color);
  }
  return new CharacterVisual(key, e.color);
}
