# Sprite-Impostor MMO Rework Plan

## Goal

Move World of Claudecraft toward a Wizordum-like retro fantasy presentation while preserving the current MMO base:

- Authoritative sim, combat, quests, networking, persistence, targeting, and collision stay intact.
- The world remains spatially 3D so the player can rotate the camera, navigate terrain, and inspect buildings/dungeons from different angles.
- Characters, mobs, NPCs, foliage, pickups, many small props, and VFX move toward directional pixel-art sprites.
- Major world structure, terrain, dungeon walls, roads, cliffs, doors, and buildings remain 3D geometry with pixel-art materials.

The core rule is: **world geometry stays 3D; actors become directional impostors.**

## Visual Model

The sprite-impostor approach should not use one front-facing cardboard sprite for player characters and monsters. It should use view-dependent directional art.

- Players, mobs, and NPCs use 8-direction or 16-direction animated sprite sheets.
- The render plane faces the camera, but the displayed frame changes based on the camera angle relative to the entity facing.
- Small props, pickups, quest sparkles, loot glints, grass tufts, and spell effects can use single camera-facing billboards.
- Buildings, terrain, dungeon walls, roads, cliffs, bridges, and doors stay geometric.
- Large bosses use 16-direction sprites or remain stylized 3D until proper sprite sheets exist.

Direction selection:

```ts
viewAngle = atan2(camera.x - entity.x, camera.z - entity.z)
relative = normalizeAngle(viewAngle - entityFacing)
directionIndex = round(relative / (TAU / directionCount)) % directionCount
```

Recommended direction counts:

- Player character: 16 directions near, 8 directions mid, 4 directions far.
- Common mobs/NPCs: 8 directions near/mid, 4 directions far.
- Bosses/large mobs: 16 directions near, 8 directions mid.
- Small pickups/particles: 1 direction.

## Existing Codebase Fit

The current renderer is already modular enough for a parallel sprite path.

- Renderer orchestration: `src/render/renderer.ts`
- Graphics tiers/material helpers: `src/render/gfx.ts`
- Post chain: `src/render/post.ts`
- Terrain: `src/render/terrain.ts`
- Props: `src/render/props.ts`
- Foliage: `src/render/foliage.ts`
- Dungeons: `src/render/dungeon.ts`
- VFX: `src/render/vfx.ts`
- Character manifest: `src/render/characters/manifest.ts`
- Character runtime visual: `src/render/characters/visual.ts`

The best path is to add a parallel sprite visual implementation that mirrors `CharacterVisual`'s public behavior, then switch selected entity visual keys to the sprite path under a style flag.

## Phase 1: Style Spike

Build a narrow vertical slice before converting the whole game.

Scope:

- One player class.
- One common mob family, preferably kobold or skeleton.
- One dungeon room.
- One outdoor area near Eastbrook.
- One spell projectile and hit effect.
- Pixelated postprocess.

Implementation:

- Add a style flag such as `?style=sprite`.
- Keep current GLB rendering as the default path.
- Route only selected visual keys through the sprite runtime.
- Leave networking, sim, input, HUD behavior, targeting, and collision untouched.

Expected result:

- Camera rotation shows directional sprites, not single cardboard fronts.
- World still feels spatially 3D.
- The slice is enough to judge whether the MMO camera supports the target style.

## Phase 2: Sprite Runtime

Create a parallel character visual class with the same practical API as the current `CharacterVisual`.

New modules:

- `src/render/sprites/sprite_visual.ts`
- `src/render/sprites/atlas.ts`
- `src/render/sprites/manifest.ts`
- `src/render/sprites/types.ts`

Runtime API:

```ts
class SpriteCharacterVisual {
  readonly root: THREE.Group;
  readonly height: number;
  readonly clickProxy: THREE.Mesh;

  update(dt: number, state: AnimState, animate: boolean): void;
  playAttack(): void;
  playHit(): void;
  setShadow(on: boolean): void;
  setProxyShadow(on: boolean): void;
  setFar(far: boolean): void;
  dispose(): void;
}
```

The renderer should be able to call this the same way it calls `CharacterVisual`.

Animation states:

- `idle`
- `walk`
- `run`
- `walkBack`
- `attack`
- `hit`
- `cast`
- `death`
- `swim`
- `sit`

Important behavior:

- Direction is chosen from camera angle relative to entity facing.
- Animation state is chosen from existing `AnimState`.
- Attack/hit/death remain event-driven where the current renderer already triggers them.
- Click proxy remains a simple invisible capsule, so interaction logic does not change.

## Phase 3: Sprite Atlas Format

Use packed atlases and generated manifests, not loose frame files.

Example manifest shape:

```ts
{
  key: "mob_kobold",
  url: "/sprites/mobs/kobold.png",
  dirs: 8,
  frameSize: [96, 96],
  anchor: [48, 84],
  worldHeight: 2.1,
  states: {
    idle: { row: 0, frames: 4, fps: 6 },
    walk: { row: 8, frames: 6, fps: 10 },
    attack: { row: 16, frames: 5, fps: 12, once: true },
    hit: { row: 24, frames: 3, fps: 12, once: true },
    death: { row: 32, frames: 6, fps: 10, once: true }
  }
}
```

Atlas layout:

- Rows are grouped by state and direction.
- Columns are animation frames.
- One texture per actor family/class where possible.
- Use `NearestFilter` in sprite mode.
- Disable mipmaps for close actors.
- Consider a separate mipped/linear far texture if shimmer is excessive.

Coordinate conventions:

- Actor faces +Z at direction 0, matching the current renderer convention.
- Anchor is the sprite's foot point in pixel coordinates.
- `worldHeight` controls scale in scene units.
- Frame rects should be generated from the manifest rather than hardcoded.

## Phase 4: Sprite Baking Pipeline

For the first implementation, bake sprites from existing GLB rigs. This gives coverage before any hand-authored pixel art exists.

New script:

- `scripts/bake_sprites.mjs`

Pipeline:

1. Load the current GLB visual definition from the character manifest.
2. Assemble the same model accessories, attachments, tint, and normalization used in runtime.
3. Render each animation from 8 or 16 yaw angles.
4. Render to low resolution, for example 96x96, 128x128, or 160x160.
5. Apply pixel-art treatment:
   - nearest scaling,
   - limited palette or quantization,
   - optional ordered dithering,
   - optional outline/rim.
6. Pack frames into PNG atlases.
7. Emit generated sprite manifest data.

Generated output:

- `public/sprites/chars/*.png`
- `public/sprites/mobs/*.png`
- `src/render/sprites/manifest.generated.ts`

Recommended initial bakes:

- One player class, likely mage or warrior.
- Kobold/goblin.
- Skeleton minion.
- Wolf or boar for quadruped validation.

Long-term:

- Keep baked sprites as a baseline.
- Paint over hero actors and common mobs where the baked result feels too much like downscaled 3D.

## Phase 5: Pixel Presentation Mode

Add a dedicated presentation path for `?style=sprite`.

Renderer/post changes:

- Render the scene to a lower internal resolution.
- Upscale with nearest-neighbor sampling.
- Add optional palette quantization or dither pass.
- Reduce physically realistic lighting influence.
- Use sharper contrast and stronger local color.
- Reduce photographic HDRI feel.
- Keep bloom, but make it chunkier and less soft.

Implementation targets:

- `src/render/post.ts`
- `src/render/gfx.ts`
- `src/render/renderer.ts`

This should be style-gated. The current PBR/low-poly presentation should remain available while the sprite style is developed.

## Phase 6: Actor Grounding And Shadows

Flat sprite quads should not cast normal geometric shadows.

Recommended first implementation:

- Add a blob shadow plane under every sprite actor.
- Scale blob shadow by actor radius and height.
- Tint/darken based on biome or dungeon state.
- Outdoors: slightly elongated and softer.
- Dungeons: tighter and darker.

Avoid:

- Shadow casting from the sprite quad itself.
- Per-pixel alpha shadows from sprite sheets in the first pass.

Transition option:

- For actors still backed by GLB source assets, keep existing static far-LOD mesh as a shadow proxy during the prototype.
- Once sprite grounding is good enough, remove shadow proxy dependence.

## Phase 7: World Conversion

The world remains 3D, but its materials and smaller content shift toward pixel art.

### Terrain

Current terrain uses PBR splat textures and biome palettes in `src/render/terrain.ts`.

Sprite style terrain should:

- Replace realistic PBR splats with chunky pixel-art grass/dirt/rock/snow/mud textures.
- Use sharper, more graphic biome color ramps.
- Reduce or remove detailed normal maps.
- Prefer large readable patches over subtle photoreal texture blending.
- Keep chunking, LOD, road distance, shoreline, and biome logic intact.

### Dungeons

Current dungeons use modular GLB kits in `src/render/dungeon.ts`.

Sprite style dungeons should:

- Keep grid/module layout and collision alignment.
- Replace kit atlas materials with pixel-art stone, moss, lava, metal, banners, skulls, and ritual surfaces.
- Push high-contrast wall/floor readability.
- Preserve instancing and batching.

### Props

Current props use GLB kits in `src/render/props.ts`.

Conversion priority:

1. Pickups, lootable quest objects, sparkles.
2. Crates, barrels, signs, small clutter, lamps.
3. Campfires and torches.
4. Trees and shrubs.
5. Buildings and major props.

Buildings can remain 3D for a long time if their textures are restyled.

### Foliage

Current foliage already uses instancing and billboarding concepts in parts.

Sprite style foliage should:

- Convert grass tufts early.
- Use crossed billboards or directional tree sprites.
- Keep deterministic placement.
- Keep fog culling and bucketed instancing.
- Avoid high-frequency shimmer through proper far LOD/mip strategy.

## Phase 8: UI And HUD Skin

The current UI is WoW-like: ornate fantasy panels, serif title font, gradients, rounded action buttons.

Sprite style UI should:

- Keep MMO information density.
- Use a pixel or bitmap-style font.
- Use square panels and hard pixel borders.
- Replace smooth gradients with flat ramps.
- Use lower-resolution icons with strong silhouettes.
- Keep tooltips, bags, quest log, party frames, minimap, cast bar, and action bar behavior.

Files:

- `index.html`
- `src/ui/hud.ts`
- `src/ui/icons.ts`
- `src/ui/meters.ts`

This should come after the first rendering slice so the UI can be matched to actual in-world screenshots.

## Phase 9: LOD And Performance Strategy

Use sprite-specific LOD.

Near:

- 16 directions for players and important mobs.
- Full animation frames.
- Full frame rate.
- Optional direction crossfade.

Mid:

- 8 directions.
- Reduced animation FPS.
- Reduced frame count.

Far:

- 4 directions or single idle billboard.
- No animation, or very low animation FPS.
- Continue using existing entity draw/nameplate range policies.

Memory considerations:

- Avoid one huge atlas for everything.
- Group by family/class.
- Use generated LOD sheets for common mobs.
- Keep player-class atlases separate so unused classes can be lazy-loaded later if needed.

## Phase 10: Verification

Manual checks:

- Rotate camera around player at close range; direction changes should feel acceptable.
- Rotate around a targeted mob while it walks, attacks, dies, and respawns.
- Verify strafing/backpedaling does not show nonsensical frames.
- Verify click target remains stable despite sprite visual changes.
- Verify nameplates still anchor above sprite height.
- Verify dungeons and outdoor areas both ground actors well.

Automated/probe checks:

- Build succeeds.
- Existing tests still pass.
- Screenshot probes in current style remain unchanged unless `?style=sprite`.
- Sprite style screenshots cover:
  - Eastbrook outdoor hub,
  - one wilderness combat scene,
  - Hollow Crypt room,
  - one boss or elite pack,
  - low/medium/high camera pitch.

Useful commands:

```bash
npm test
npm run build
npm run dev
```

## Risk Areas

### Camera Direction Popping

8 directions can pop during camera rotation.

Mitigations:

- Use 16 directions for players and bosses.
- Crossfade adjacent directions near angle boundaries.
- Add a small angular hysteresis so direction does not flicker.

### Backpedal And Strafe Readability

Movement animation cannot depend only on speed.

Mitigations:

- Track velocity relative to entity facing.
- Use walk-back frames for player backpedal.
- Use side-step frames only if they exist; otherwise let lower-body mismatch slide for first pass.

### Large Boss Flatness

Large sprite actors can feel obviously flat.

Mitigations:

- Use 16 directions.
- Add layered sprite parts for boss effects.
- Keep some bosses 3D until final art exists.

### Atlas Memory

16 directions times many states times many classes can grow quickly.

Mitigations:

- Bake lower resolution first.
- Use separate atlases by visual family.
- Generate 8-dir and 4-dir LOD sheets.
- Only ship full 16-dir sheets for players, bosses, and common close-range mobs.

### Art Consistency

Baked GLB sprites may look like downscaled 3D, not hand-authored pixel art.

Mitigations:

- Treat baked output as a coverage baseline.
- Paint over the most visible sheets.
- Use palette limits, outlines, and hand-tuned color ramps.
- Restyle world materials at the same time so actors do not feel pasted into the old PBR scene.

## Recommended Milestones

1. Add `?style=sprite` flag and pixelated postprocess.
2. Implement `SpriteCharacterVisual` for one mob with 8-direction idle/walk/attack/death.
3. Add sprite atlas manifest and loader.
4. Build `scripts/bake_sprites.mjs` for one current GLB actor.
5. Render one player class as 16-direction sprite.
6. Add blob shadows and validate grounding.
7. Restyle one dungeon room with pixel textures.
8. Restyle one outdoor Eastbrook patch with pixel terrain/foliage/props.
9. Convert all common mobs and NPCs.
10. Convert all player classes.
11. Add sprite-specific LOD sheets.
12. Skin the HUD/UI.
13. Convert or restyle remaining props/foliage/dungeon materials.
14. Run full screenshot/performance pass across all zones and dungeons.

## Suggested First Implementation Cut

The first real branch should only aim for:

- `?style=sprite`
- Pixelated render upscale
- One sprite mob
- One sprite player class
- Blob shadows
- One baked sprite pipeline path
- One dungeon screenshot and one outdoor screenshot

That proves the camera, entity-facing math, atlas layout, animation API, and visual direction before committing to the full content conversion.
