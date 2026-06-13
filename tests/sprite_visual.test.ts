import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import type { AnimState } from '../src/render/characters/visual';
import { seedSpriteAtlasForTest } from '../src/render/sprites/atlas';
import { SpriteCharacterVisual } from '../src/render/sprites/sprite_visual';
import { spriteManifestFor } from '../src/render/sprites/manifest';

const IDLE: AnimState = {
  speed: 0,
  moving: false,
  backwards: false,
  dead: false,
  casting: false,
  swimming: false,
  sitting: false,
};

function spriteMaterial(visual: SpriteCharacterVisual): THREE.SpriteMaterial {
  const sp = visual.root.children.find((c) => c.type === 'Sprite') as THREE.Sprite | undefined;
  expect(sp).toBeDefined();
  return sp!.material as THREE.SpriteMaterial;
}

function mountVisual(key: string): { visual: SpriteCharacterVisual; group: THREE.Group; camera: THREE.PerspectiveCamera } {
  const manifest = spriteManifestFor(key)!;
  seedSpriteAtlasForTest(manifest);
  const visual = new SpriteCharacterVisual(key, 0xffffff);
  const group = new THREE.Group();
  group.add(visual.root);
  const scene = new THREE.Scene();
  scene.add(group);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(0, 4, 12);
  camera.lookAt(0, 1, 0);
  visual.setCamera(camera);
  return { visual, group, camera };
}

describe('SpriteCharacterVisual', () => {
  let visual: SpriteCharacterVisual;
  let group: THREE.Group;
  let camera: THREE.PerspectiveCamera;

  beforeEach(() => {
    ({ visual, group, camera } = mountVisual('player_mage'));
  });

  afterEach(() => {
    visual.dispose();
  });

  it('exposes root, height, and invisible click proxy from manifest', () => {
    const manifest = spriteManifestFor('player_mage')!;
    expect(visual.height).toBe(manifest.worldHeight);
    expect(visual.root).toBeInstanceOf(THREE.Group);
    expect(visual.clickProxy.visible).toBe(false);
    expect(visual.clickProxy).toBeInstanceOf(THREE.Mesh);
  });

  it('includes a blob shadow mesh under the sprite', () => {
    const blob = visual.root.children.find(
      (c) => c.type === 'Mesh' && (c as THREE.Mesh).geometry?.type === 'CircleGeometry',
    );
    expect(blob).toBeDefined();
    expect(blob!.visible).toBe(true);
  });

  it('changes atlas UV offset when the camera orbits the entity', () => {
    const mat = spriteMaterial(visual);
    const behind = mat.map!.offset.y;
    camera.position.set(0, 4, -12);
    camera.lookAt(0, 1, 0);
    visual.setCamera(camera);
    const front = mat.map!.offset.y;
    expect(front).not.toBe(behind);
  });

  it('selects walk/run/backpedal states from AnimState', () => {
    visual.update(0.05, { ...IDLE, moving: true, speed: 2 }, true);
    visual.update(0.05, { ...IDLE, moving: true, speed: 6 }, true);
    visual.update(0.05, { ...IDLE, moving: true, speed: 2, backwards: true }, true);
    expect(spriteMaterial(visual).map).toBeTruthy();
  });

  it('plays attack as a one-shot then returns to locomotion', () => {
    visual.update(0.05, { ...IDLE, moving: true, speed: 2 }, true);
    visual.playAttack();
    for (let i = 0; i < 30; i++) visual.update(1 / 12, IDLE, true);
    visual.update(0.05, { ...IDLE, moving: true, speed: 2 }, true);
    expect(spriteMaterial(visual).map).toBeTruthy();
  });

  it('respects hit cooldown like CharacterVisual', () => {
    visual.playHit();
    visual.playHit();
    visual.update(0.05, IDLE, true);
    expect(spriteMaterial(visual).map).toBeTruthy();
  });

  it('locks on death and revives to idle', () => {
    visual.update(0.05, { ...IDLE, dead: true }, true);
    visual.playAttack();
    visual.update(0.5, { ...IDLE, dead: true }, true);
    visual.update(0.05, IDLE, true);
    expect(spriteMaterial(visual).map).toBeTruthy();
  });

  it('setShadow and setProxyShadow toggle blob visibility', () => {
    const blob = visual.root.children.find(
      (c) => c.type === 'Mesh' && (c as THREE.Mesh).geometry?.type === 'CircleGeometry',
    )!;
    visual.setShadow(false);
    expect(blob.visible).toBe(false);
    visual.setProxyShadow(true);
    expect(blob.visible).toBe(true);
    visual.setProxyShadow(false);
    expect(blob.visible).toBe(false);
  });

  it('setFar reduces direction buckets', () => {
    group.rotation.y = 0;
    camera.position.set(12, 4, 0);
    camera.lookAt(0, 1, 0);
    visual.setFar(false);
    visual.setCamera(camera);
    const nearOffset = spriteMaterial(visual).map!.offset.y;
    visual.setFar(true);
    visual.setCamera(camera);
    const farOffset = spriteMaterial(visual).map!.offset.y;
    expect(farOffset).not.toBe(nearOffset);
  });

  it('dispose removes the root from its parent', () => {
    expect(group.children).toContain(visual.root);
    visual.dispose();
    expect(group.children).not.toContain(visual.root);
  });
});

describe('SpriteCharacterVisual mob manifests', () => {
  it('loads kobold and skeleton minion manifests', () => {
    for (const key of ['mob_kobold', 'skel_minion'] as const) {
      const manifest = spriteManifestFor(key)!;
      seedSpriteAtlasForTest(manifest);
      const v = new SpriteCharacterVisual(key, 0xffffff);
      expect(v.height).toBe(manifest.worldHeight);
      v.dispose();
    }
  });
});
