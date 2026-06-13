// Directional sprite impostor — mirrors CharacterVisual's public API so the
// renderer can swap selected visual keys under ?style=sprite without touching
// sim, networking, or interaction logic.
import * as THREE from 'three';
import type { AnimState } from '../characters/visual';
import {
  directionIndex, loadSpriteAtlas, resolveSpriteFrame, spriteAtlasInstance, spriteAtlasReady,
} from './atlas';
import { spriteManifestFor } from './manifest';
import type { SpriteAnimState, SpriteManifest, SpriteStateDef } from './types';

const TAU = Math.PI * 2;
const RUN_SPEED_THRESHOLD = 4.5;
const HIT_REACT_COOLDOWN = 0.9;
const ONESHOT_FADE = 0.1;

let clickGeoSingleton: THREE.CylinderGeometry | null = null;
function clickGeo(): THREE.CylinderGeometry {
  if (!clickGeoSingleton) {
    clickGeoSingleton = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    clickGeoSingleton.translate(0, 0.5, 0);
  }
  return clickGeoSingleton;
}
let clickMatSingleton: THREE.Material | null = null;
function clickMat(): THREE.Material {
  clickMatSingleton ??= new THREE.MeshBasicMaterial();
  return clickMatSingleton;
}

export class SpriteCharacterVisual {
  readonly root = new THREE.Group();
  readonly height: number;
  readonly clickProxy: THREE.Mesh;

  private manifest: SpriteManifest;
  private material: THREE.SpriteMaterial;
  private sprite: THREE.Sprite;
  private blobShadow: THREE.Mesh;
  private camera: THREE.Camera | null = null;

  private baseState: SpriteAnimState = 'idle';
  private currentState: SpriteStateDef;
  private stateKey: SpriteAnimState = 'idle';
  private frameIdx = 0;
  private frameTime = 0;
  private oneShot = false;
  private oneShotDone = false;
  private deadLock = false;
  private wasDead = false;
  private hitCooldown = 0;
  private attackIdx = 0;
  private dirIdx = 0;
  private dirCount: number;
  private far = false;
  private shadowOn = true;

  constructor(key: string, entityColor: number) {
    const manifest = spriteManifestFor(key);
    if (!manifest) throw new Error(`sprite manifest missing: ${key}`);
    this.manifest = manifest;
    this.height = manifest.worldHeight;
    this.dirCount = manifest.dirs;
    this.currentState = manifest.states.idle;

    const atlas = spriteAtlasReady(manifest);
    this.material = new THREE.SpriteMaterial({
      map: atlas ? spriteAtlasInstance(atlas) : undefined,
      transparent: true,
      alphaTest: 0.08,
      depthWrite: false,
    });
    if (entityColor !== 0xffffff) {
      this.material.color = new THREE.Color(entityColor);
    }

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.center.set(
      manifest.anchor[0] / manifest.frameSize[0],
      1 - manifest.anchor[1] / manifest.frameSize[1],
    );
    const scale = manifest.worldHeight / manifest.frameSize[1];
    this.sprite.scale.set(manifest.frameSize[0] * scale, manifest.frameSize[1] * scale, 1);
    this.root.add(this.sprite);

    const blobGeo = new THREE.CircleGeometry(0.55, 16);
    blobGeo.rotateX(-Math.PI / 2);
    this.blobShadow = new THREE.Mesh(
      blobGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.blobShadow.position.y = 0.02;
    this.root.add(this.blobShadow);

    const r = Math.max(0.45, manifest.worldHeight * 0.22);
    this.clickProxy = new THREE.Mesh(clickGeo(), clickMat());
    this.clickProxy.scale.set(r * 2, this.height, r * 2);
    this.clickProxy.visible = false;
    this.root.add(this.clickProxy);

    void loadSpriteAtlas(manifest).then((tex) => {
      this.material.map = spriteAtlasInstance(tex);
      this.material.needsUpdate = true;
      this.applyFrame();
    });

    this.applyFrame();
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    this.refreshDirection();
  }

  update(dt: number, s: AnimState, animate: boolean): void {
    if (this.camera) this.refreshDirection();
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);

    if (s.dead && !this.wasDead) this.enterDeath();
    else if (!s.dead && this.wasDead) this.revive();
    this.wasDead = s.dead;

    if (!this.deadLock && !this.oneShot) {
      const desired = this.desiredState(s);
      if (desired !== this.baseState) {
        this.baseState = desired;
        this.beginState(desired);
      }
    }

    if (animate && (!this.deadLock || this.oneShot)) {
      const fps = this.currentState.fps;
      this.frameTime += dt;
      const frameDur = 1 / fps;
      while (this.frameTime >= frameDur) {
        this.frameTime -= frameDur;
        if (this.oneShot) {
          if (this.frameIdx < this.currentState.frames - 1) this.frameIdx++;
          else this.oneShotDone = true;
        } else {
          this.frameIdx = (this.frameIdx + 1) % this.currentState.frames;
        }
      }
      if (this.oneShotDone) {
        this.oneShot = false;
        this.oneShotDone = false;
        if (!this.deadLock) this.beginState(this.baseState);
      }
    }

    this.applyFrame();
  }

  playAttack(): void {
    if (this.deadLock || !this.manifest.states.attack) return;
    this.attackIdx++;
    this.playOneShot('attack');
  }

  playHit(): void {
    if (this.deadLock || this.oneShot || this.hitCooldown > 0 || !this.manifest.states.hit) return;
    this.hitCooldown = HIT_REACT_COOLDOWN;
    this.playOneShot('hit');
  }

  setShadow(on: boolean): void {
    if (on === this.shadowOn) return;
    this.shadowOn = on;
    this.blobShadow.visible = on;
  }

  setProxyShadow(on: boolean): void {
    this.blobShadow.visible = on || this.shadowOn;
  }

  setFar(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    if (this.camera) this.setCamera(this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.blobShadow.geometry.dispose();
    (this.blobShadow.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }

  private tmpCam = new THREE.Vector3();
  private tmpEnt = new THREE.Vector3();

  private refreshDirection(): void {
    if (!this.camera) return;
    this.camera.getWorldPosition(this.tmpCam);
    this.root.getWorldPosition(this.tmpEnt);
    const parent = this.root.parent as THREE.Object3D | null;
    const facing = parent ? parent.rotation.y : this.root.rotation.y;
    const dirs = this.far ? Math.max(4, Math.floor(this.dirCount / 2)) : this.dirCount;
    const next = directionIndex(
      this.tmpCam.x, this.tmpCam.z, this.tmpEnt.x, this.tmpEnt.z, facing, dirs,
    );
    if (next === this.dirIdx) return;
    this.dirIdx = next;
    this.applyFrame();
  }

  private desiredState(s: AnimState): SpriteAnimState {
    if (s.swimming && this.manifest.states.swim) return 'swim';
    if (s.casting && this.manifest.states.cast) return 'cast';
    if (s.sitting && this.manifest.states.idle) return 'sit';
    if (s.moving) {
      if (s.backwards && this.manifest.states.walkBack) return 'walkBack';
      return s.speed >= RUN_SPEED_THRESHOLD && this.manifest.states.run ? 'run' : 'walk';
    }
    return 'idle';
  }

  private beginState(key: SpriteAnimState): void {
    const mapKey = key === 'sit' ? 'idle' : key;
    const st = this.manifest.states[mapKey];
    if (!st) return;
    this.stateKey = key;
    this.currentState = st;
    this.frameIdx = 0;
    this.frameTime = 0;
    this.oneShot = false;
    this.oneShotDone = false;
  }

  private playOneShot(key: SpriteAnimState): void {
    const st = this.manifest.states[key];
    if (!st) return;
    this.stateKey = key;
    this.currentState = st;
    this.frameIdx = 0;
    this.frameTime = 0;
    this.oneShot = !!st.once;
    this.oneShotDone = false;
  }

  private enterDeath(): void {
    this.deadLock = true;
    if (this.manifest.states.death) this.playOneShot('death');
  }

  private revive(): void {
    this.deadLock = false;
    this.beginState('idle');
  }

  private applyFrame(): void {
    const frame = resolveSpriteFrame(
      this.manifest, this.currentState, this.dirIdx, this.frameIdx,
    );
    if (this.material.map) {
      this.material.map.repeat.set(frame.u1 - frame.u0, frame.v1 - frame.v0);
      this.material.map.offset.set(frame.u0, frame.v0);
      this.material.needsUpdate = true;
    }
  }
}
