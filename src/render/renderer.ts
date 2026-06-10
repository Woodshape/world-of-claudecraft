import * as THREE from 'three';
import { Entity, SimEvent } from '../sim/types';
import type { IWorld } from '../world_api';
import { terrainHeight, groundHeight, generateDecorations, roadDistance, WATER_LEVEL, zoneBiomeAt } from '../sim/world';
import {
  MOBS, ABILITIES, DUNGEON_X_THRESHOLD, DUNGEON_LIST,
  instanceOrigin, INSTANCE_SLOT_COUNT, ZONES,
  WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_Z,
} from '../sim/data';
import type { BiomeId } from '../sim/types';
import { buildBear, buildRigFor, buildSheep, Rig } from './models';
import { buildProps } from './props';
import { barkTexture, foliageTexture, grassTuftTexture, sparkleTexture } from './textures';
import { Vfx } from './vfx';
import { GFX, initGfxTier, sharedUniforms, urlForcedTier } from './gfx';
import { buildComposer, PostPipeline } from './post';
import { buildTerrain } from './terrain';
import { buildWater, WaterView } from './water';
import { buildClouds, buildSky, SkyView } from './sky';

const NAMEPLATE_RANGE = 55;
// Entities further than this from the player are hidden entirely: their rigs
// are a dozen draw calls each and read as sub-pixel specks long before this.
const ENTITY_DRAW_RANGE = 110;
// lighting rig (high/ultra) — IBL supplies ambient, sun carries the key
const HEMI_INTENSITY = 0.45;
const SUN_INTENSITY = 2.8;
const ENV_INTENSITY = 0.5;
// dungeon interiors: kill the daylight so torchlight carries the scene
const DUNGEON_SUN_INTENSITY = 0.3;
const DUNGEON_ENV_INTENSITY = 0.15;
const DUNGEON_HEMI_INTENSITY = 0.14;

interface EntityView {
  group: THREE.Group;
  rig: Rig;
  sheepRig: Rig | null; // polymorph form, built lazily
  bearRig: Rig | null; // druid bear form, built lazily
  walkPhase: number;
  attackAnim: number;
  nameplate: HTMLDivElement;
  nameEl: HTMLDivElement;
  hpBar: HTMLDivElement;
  hpFill: HTMLDivElement;
  markerEl: HTMLDivElement;
  sparkle?: THREE.Sprite; // ground objects
  objectMesh?: THREE.Object3D;
  portal?: THREE.Mesh; // dungeon door swirl
}

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  webgl: THREE.WebGLRenderer;
  views = new Map<number, EntityView>();
  nameplateLayer: HTMLDivElement;
  selectionRing: THREE.Mesh;
  raycaster = new THREE.Raycaster();
  clickTargets: THREE.Object3D[] = [];
  camYaw = Math.PI;
  camPitch = 0.32;
  camDist = 12;
  showNameplates = true;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private sun: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private sky!: THREE.Mesh;
  private skyView!: SkyView;
  private sunSprites: THREE.Sprite[] = [];
  private sunDir = new THREE.Vector3();
  private clouds: THREE.Sprite[] = [];
  private waterView: WaterView;
  private fogScratch = new THREE.Color();
  private flames: THREE.Mesh[];
  private fireLights: THREE.PointLight[];
  private time = 0;
  vfx: Vfx;

  private lowGfx: boolean;
  private post: PostPipeline | null = null;
  private godRays: THREE.Sprite[] = [];

  constructor(private sim: IWorld, canvas: HTMLCanvasElement, nameplateLayer: HTMLDivElement) {
    this.nameplateLayer = nameplateLayer;
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: urlForcedTier() !== 'low', powerPreference: 'high-performance' });
    initGfxTier(this.webgl); // software-GL autodetect needs the live context
    this.lowGfx = GFX.tier === 'low';
    const LOW_GFX = this.lowGfx;
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, GFX.pixelRatioCap));
    this.webgl.setSize(window.innerWidth, window.innerHeight);
    this.webgl.shadowMap.enabled = !LOW_GFX;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping; // OutputPass reads this on the composer path
    this.webgl.toneMappingExposure = 1.12;
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 950);

    this.scene.fog = new THREE.Fog(0xa6c6e0, 130, 470);

    // sky dome — follows the camera so the world strip never outruns it.
    // High tier: shader gradient + sun glow with biome-aware horizon tints;
    // low keeps the legacy canvas-gradient dome.
    this.skyView = buildSky(LOW_GFX, new THREE.Vector3(90, 140, 50));
    this.sky = this.skyView.dome;
    this.scene.add(this.sky);

    // IBL: prefilter the sky dome itself so PBR materials get sky-matched
    // ambient specular/diffuse (low keeps the flat Lambert look instead)
    if (!LOW_GFX) {
      const pmrem = new THREE.PMREMGenerator(this.webgl);
      const envScene = new THREE.Scene();
      envScene.add(this.sky.clone());
      const envRT = pmrem.fromScene(envScene, 0.04, 0.1, 1100); // far must cover the 560u dome
      this.scene.environment = envRT.texture;
      this.scene.environmentIntensity = ENV_INTENSITY;
      pmrem.dispose();
    }

    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x46603a, LOW_GFX ? 1.0 : HEMI_INTENSITY);
    this.scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(LOW_GFX ? 0xfff0cd : 0xffedd0, LOW_GFX ? 2.2 : SUN_INTENSITY);
    sun.position.set(90, 140, 50);
    sun.castShadow = !LOW_GFX;
    sun.shadow.mapSize.set(GFX.shadowMap, GFX.shadowMap);
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 480;
    const S = LOW_GFX ? 75 : 50; // tighter ortho = crisper shadows; follows the player
    sun.shadow.camera.left = -S;
    sun.shadow.camera.right = S;
    sun.shadow.camera.top = S;
    sun.shadow.camera.bottom = -S;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = LOW_GFX ? 0.02 : 0.05;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this.sunDir.copy(sun.position).normalize();

    // visible sun disc + bloom halo
    const sunCanvas = (core: boolean): THREE.CanvasTexture => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
      if (core) {
        g.addColorStop(0, 'rgba(255,252,238,1)');
        g.addColorStop(0.35, 'rgba(255,238,180,0.95)');
        g.addColorStop(1, 'rgba(255,220,140,0)');
      } else {
        g.addColorStop(0, 'rgba(255,236,180,0.55)');
        g.addColorStop(1, 'rgba(255,220,150,0)');
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    };
    for (const [tex, scale] of [[sunCanvas(true), 60], [sunCanvas(false), 190]] as const) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, fog: false, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending,
      }));
      sp.scale.set(scale, scale, 1);
      sp.renderOrder = -9;
      this.sunSprites.push(sp);
      this.scene.add(sp);
    }

    // god-ray shafts: elongated additive gradient sprites hanging sunward of
    // the camera; opacity follows how directly the camera faces the sun
    if (!LOW_GFX) {
      const shaft = document.createElement('canvas');
      shaft.width = 64;
      shaft.height = 256;
      const sctx = shaft.getContext('2d')!;
      const gh = sctx.createLinearGradient(0, 0, 0, 256);
      gh.addColorStop(0, 'rgba(255,240,200,0)');
      gh.addColorStop(0.45, 'rgba(255,240,200,0.55)');
      gh.addColorStop(0.6, 'rgba(255,240,200,0.5)');
      gh.addColorStop(1, 'rgba(255,240,200,0)');
      sctx.fillStyle = gh;
      sctx.fillRect(0, 0, 64, 256);
      const gw = sctx.createLinearGradient(0, 0, 64, 0);
      gw.addColorStop(0, 'rgba(0,0,0,1)');
      gw.addColorStop(0.5, 'rgba(0,0,0,0)');
      gw.addColorStop(1, 'rgba(0,0,0,1)');
      sctx.globalCompositeOperation = 'destination-out';
      sctx.fillStyle = gw;
      sctx.fillRect(0, 0, 64, 256);
      const shaftTex = new THREE.CanvasTexture(shaft);
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: shaftTex, transparent: true, opacity: 0, fog: false,
          depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
          rotation: 0.42 + i * 0.13,
        }));
        sp.scale.set(26 + i * 16, 150 + i * 35, 1);
        sp.renderOrder = -8;
        this.godRays.push(sp);
        this.scene.add(sp);
      }
    }

    // clouds, spread over the whole zone strip (3 sprite variants + a faint
    // high cirrus layer on the full pipeline)
    for (const cl of buildClouds(LOW_GFX).sprites) {
      this.clouds.push(cl);
      this.scene.add(cl);
    }

    this.scene.add(buildTerrain(this.sim.cfg.seed));
    this.waterView = buildWater(this.sim.cfg.seed);
    for (const mesh of this.waterView.meshes) this.scene.add(mesh);

    this.buildDecorations();
    this.buildGrass();
    const props = buildProps(this.sim.cfg.seed);
    this.scene.add(props.group);
    this.flames = props.flames;
    this.fireLights = props.fireLights;

    // selection ring
    const ringGeo = new THREE.RingGeometry(0.9, 1.15, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.selectionRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xd4af37, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    // particle system: projectiles, impacts, heal glows, ambience
    this.vfx = new Vfx(this.scene, (id, frac) => {
      const v = this.views.get(id);
      if (!v) return null;
      const e = this.sim.entities.get(id);
      const h = v.rig.height * (e?.scale ?? 1) * frac;
      return new THREE.Vector3(v.group.position.x, v.group.position.y + h, v.group.position.z);
    });
    this.vfx.setViewportScale(this.webgl.domElement.clientHeight * this.webgl.getPixelRatio(), 60);

    for (const e of sim.entities.values()) this.createView(e);

    // post chain (bloom + grade, GTAO on ultra); low renders direct
    if (GFX.composer) this.post = buildComposer(this.webgl, this.scene, this.camera);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.webgl.setSize(window.innerWidth, window.innerHeight);
      this.post?.setSize(window.innerWidth, window.innerHeight);
      this.vfx.setViewportScale(this.webgl.domElement.clientHeight * this.webgl.getPixelRatio(), 60);
    });
  }

  // Visual reactions to sim events (called by the HUD for every event,
  // including those between other players and mobs).
  handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'spellfx':
        if (ev.fx === 'projectile') this.vfx.projectile(ev.sourceId, ev.targetId, ev.school);
        else if (ev.fx === 'tick') this.vfx.tick(ev.targetId, ev.school);
        else this.vfx.nova(ev.targetId, ev.school);
        break;
      case 'damage':
        // every melee/ranged swing animates the attacker for all to see
        if (ev.school === 'physical' && ev.sourceId !== -1) this.triggerAttack(ev.sourceId);
        if (ev.kind === 'hit' && ev.amount > 0 && ev.school === 'physical') {
          this.vfx.meleeSpark(ev.targetId, ev.crit);
        }
        break;
      case 'heal2':
        if (ev.amount > 0 || ev.crit) this.vfx.healGlow(ev.targetId);
        break;
      case 'aura': {
        const tgt = this.sim.entities.get(ev.targetId);
        if (ev.gained && tgt?.kind === 'player') this.vfx.buffSwirl(ev.targetId);
        break;
      }
      case 'levelup':
        this.vfx.levelUpPillar(this.sim.playerId);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // World building
  // -------------------------------------------------------------------------

  private buildDecorations(): void {
    const decos = generateDecorations(this.sim.cfg.seed);
    const pines = decos.filter((d) => d.kind === 'tree');
    const oaks = decos.filter((d) => d.kind === 'tree2');
    const rocks = decos.filter((d) => d.kind === 'rock');
    const seed = this.sim.cfg.seed;

    const bark = barkTexture();
    const foliage = foliageTexture();
    const trunkMat = new THREE.MeshLambertMaterial({ map: bark });
    const pineMat = new THREE.MeshLambertMaterial({ map: foliage, color: 0xa8c898 });
    const pineMat2 = new THREE.MeshLambertMaterial({ map: foliage, color: 0xc2d8a8 });
    const oakMat = new THREE.MeshLambertMaterial({ map: foliage, color: 0xb8cc8e });

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    // pines: trunk + 3 stacked cones
    const pTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.42, 2.6, 6), trunkMat, pines.length);
    const pC1 = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 3.2, 7), pineMat, pines.length);
    const pC2 = new THREE.InstancedMesh(new THREE.ConeGeometry(1.85, 2.7, 7), pineMat2, pines.length);
    const pC3 = new THREE.InstancedMesh(new THREE.ConeGeometry(1.25, 2.2, 7), pineMat, pines.length);
    pines.forEach((t, i) => {
      const y = terrainHeight(t.x, t.z, seed);
      const s = t.scale * 1.5;
      q.setFromAxisAngle(up, t.variant * 2.1);
      const sv = new THREE.Vector3(s, s, s);
      m.compose(new THREE.Vector3(t.x, y + 1.3 * s, t.z), q, sv);
      pTrunk.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 3.6 * s, t.z), q, sv);
      pC1.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 5.3 * s, t.z), q, sv);
      pC2.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 6.8 * s, t.z), q, sv);
      pC3.setMatrixAt(i, m);
    });
    for (const im of [pTrunk, pC1, pC2, pC3]) {
      im.castShadow = true;
      this.scene.add(im);
    }

    // oaks: trunk + blobby foliage
    const oTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.5, 2.8, 6), trunkMat, oaks.length);
    const oFol = new THREE.InstancedMesh(new THREE.SphereGeometry(2.2, 7, 5), oakMat, oaks.length);
    const oFol2 = new THREE.InstancedMesh(new THREE.SphereGeometry(1.5, 6, 5), oakMat, oaks.length);
    oaks.forEach((t, i) => {
      const y = terrainHeight(t.x, t.z, seed);
      const s = t.scale * 1.3;
      q.setFromAxisAngle(up, t.variant * 2.1);
      m.compose(new THREE.Vector3(t.x, y + 1.4 * s, t.z), q, new THREE.Vector3(s, s, s));
      oTrunk.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 3.6 * s, t.z), q, new THREE.Vector3(s, s * 0.8, s));
      oFol.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x + 1.1 * s, y + 2.9 * s, t.z + 0.4 * s), q, new THREE.Vector3(s, s * 0.7, s));
      oFol2.setMatrixAt(i, m);
    });
    for (const im of [oTrunk, oFol, oFol2]) {
      im.castShadow = true;
      this.scene.add(im);
    }

    const rockMesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.9, 0),
      new THREE.MeshLambertMaterial({ color: 0x8d8d85, flatShading: true }),
      rocks.length,
    );
    rocks.forEach((r, i) => {
      const y = terrainHeight(r.x, r.z, seed);
      q.setFromAxisAngle(up, r.variant * 1.7);
      m.compose(new THREE.Vector3(r.x, y + 0.3 * r.scale, r.z), q, new THREE.Vector3(r.scale, r.scale * 0.7, r.scale));
      rockMesh.setMatrixAt(i, m);
    });
    rockMesh.castShadow = true;
    this.scene.add(rockMesh);
  }

  private buildGrass(): void {
    const seed = this.sim.cfg.seed;
    const positions: { x: number; z: number; s: number; r: number }[] = [];
    const step = this.lowGfx ? 4.5 : 3.4;
    const xHalf = WORLD_MAX_X - 16;
    let h1 = 0;
    for (let gx = -xHalf; gx < xHalf; gx += step) {
      for (let gz = WORLD_MIN_Z + 16; gz < WORLD_MAX_Z - 16; gz += step) {
        h1 = (Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453) % 1;
        const r = Math.abs(h1);
        if (r > 0.5) continue;
        const x = gx + (r - 0.25) * 8;
        const z = gz + ((r * 7) % 1 - 0.5) * 8;
        const h = terrainHeight(x, z, seed);
        if (h < WATER_LEVEL + 1.6) continue;
        let nearHub = false;
        for (const zn of ZONES) {
          if (Math.hypot(x - zn.hub.x, z - zn.hub.z) < 15) { nearHub = true; break; }
        }
        if (nearHub) continue;
        if (roadDistance(x, z) < 3.2) continue;
        positions.push({ x, z, s: 0.45 + r * 0.5, r: r * 6 });
      }
    }
    // crossed-quad geometry
    const quad = new THREE.PlaneGeometry(1.1, 0.7);
    quad.translate(0, 0.35, 0);
    const quad2 = quad.clone().rotateY(Math.PI / 2);
    const merged = mergeGeoms([quad, quad2]);
    const mat = new THREE.MeshLambertMaterial({
      map: grassTuftTexture(), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    });
    const im = new THREE.InstancedMesh(merged, mat, positions.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    positions.forEach((p, i) => {
      q.setFromAxisAngle(up, p.r);
      m.compose(new THREE.Vector3(p.x, terrainHeight(p.x, p.z, seed), p.z), q, new THREE.Vector3(p.s, p.s, p.s));
      im.setMatrixAt(i, m);
    });
    this.scene.add(im);
  }

  // -------------------------------------------------------------------------
  // Entity views
  // -------------------------------------------------------------------------

  private createView(e: Entity): void {
    const group = new THREE.Group();
    let rig: Rig;
    let sparkle: THREE.Sprite | undefined;
    let objectMesh: THREE.Object3D | undefined;

    let portal: THREE.Mesh | undefined;
    if (e.kind === 'object' && (e.templateId === 'dungeon_door' || e.templateId === 'dungeon_exit')) {
      // dungeon doorway: stone arch with a swirling portal
      const entering = e.templateId === 'dungeon_door';
      const tint = entering ? 0x9a5df0 : 0x6ab8ff;
      rig = { body: new THREE.Group(), parts: {}, kind: 'humanoid', height: 4.6 };
      const stone = new THREE.MeshLambertMaterial({ color: 0x6a6a72 });
      for (const sx of [-1.5, 1.5]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.4, 0.7), stone);
        pillar.position.set(sx, 2.2, 0);
        pillar.castShadow = true;
        rig.body.add(pillar);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.7, 0.9), stone);
      lintel.position.y = 4.55;
      lintel.castShadow = true;
      rig.body.add(lintel);
      portal = new THREE.Mesh(
        new THREE.CircleGeometry(1.55, 24),
        new THREE.MeshBasicMaterial({
          color: tint, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      portal.position.y = 2.15;
      portal.scale.set(1, 1.35, 1);
      rig.body.add(portal);
      const glow = new THREE.PointLight(tint, 9, 15, 2);
      glow.position.y = 2.4;
      rig.body.add(glow);
      objectMesh = rig.body;
    } else if (e.kind === 'object') {
      rig = { body: new THREE.Group(), parts: {}, kind: 'humanoid', height: 1.2 };
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshLambertMaterial({ color: 0x8a6537 }),
      );
      crate.position.y = 0.45;
      crate.castShadow = true;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.12, 0.96), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }));
      lid.position.y = 0.92;
      rig.body.add(crate, lid);
      objectMesh = rig.body;
      const sMat = new THREE.SpriteMaterial({ map: sparkleTexture(), transparent: true, depthWrite: false });
      sparkle = new THREE.Sprite(sMat);
      sparkle.scale.set(0.9, 0.9, 1);
      sparkle.position.y = 1.35;
      group.add(sparkle);
    } else {
      rig = buildRigFor(e);
    }
    rig.body.scale.multiplyScalar(e.scale);
    group.add(rig.body);

    group.position.set(e.pos.x, e.pos.y, e.pos.z);
    group.userData.entityId = e.id;
    rig.body.traverse((o) => { o.userData.entityId = e.id; });
    this.scene.add(group);
    this.clickTargets.push(rig.body);

    // nameplate
    const np = document.createElement('div');
    np.className = 'nameplate';
    const marker = document.createElement('div');
    marker.className = 'np-marker';
    const nameEl = document.createElement('div');
    nameEl.className = 'np-name';
    nameEl.textContent = e.name;
    const hpBar = document.createElement('div');
    hpBar.className = 'np-hpbar';
    const hpFill = document.createElement('div');
    hpFill.className = 'np-hpfill';
    hpBar.appendChild(hpFill);
    np.append(marker, nameEl, hpBar);
    this.nameplateLayer.appendChild(np);

    this.views.set(e.id, {
      group, rig, sheepRig: null, bearRig: null, walkPhase: 0, attackAnim: 0,
      nameplate: np, nameEl, hpBar, hpFill, markerEl: marker, sparkle, objectMesh, portal,
    });
  }

  triggerAttack(entityId: number): void {
    const v = this.views.get(entityId);
    if (v) v.attackAnim = 0.35;
  }

  // -------------------------------------------------------------------------
  // Per-frame sync
  // -------------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // The Hollow Crypt interior, built lazily per instance origin.
  // ---------------------------------------------------------------------

  private builtInteriors = new Set<string>();
  private fogState: 'outdoor' | 'dungeon' | 'underwater' = 'outdoor';

  private buildInterior(interior: string, ox: number, oz: number): void {
    // one builder per DungeonDef.interior key
    if (interior === 'sanctum') this.buildSanctum(ox, oz);
    else this.buildCrypt(ox, oz);
  }

  private buildCrypt(ox: number, oz: number): void {
    const g = new THREE.Group();
    const stone = new THREE.MeshLambertMaterial({ color: 0x6a6a72 });
    const stoneDark = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
    const bone = new THREE.MeshLambertMaterial({ color: 0xd8d4c0, flatShading: true });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(46, 0.5, 122), stoneDark);
    floor.position.set(0, -0.25, 52);
    floor.receiveShadow = true;
    g.add(floor);
    // walls
    for (const sx of [-23, 23]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 9, 122), stone);
      wall.position.set(sx, 4.5, 52);
      g.add(wall);
    }
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(48, 9, 2), stone);
    backWall.position.set(0, 4.5, 112);
    g.add(backWall);
    const frontWall = new THREE.Mesh(new THREE.BoxGeometry(48, 9, 2), stone);
    frontWall.position.set(0, 4.5, -9);
    g.add(frontWall);
    // pillars + torches
    for (let z = 10; z <= 100; z += 15) {
      for (const sx of [-14, 14]) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 8, 7), stone);
        pillar.position.set(sx, 4, z);
        pillar.castShadow = true;
        g.add(pillar);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 6), new THREE.MeshLambertMaterial({
          color: 0x7fd4ff, emissive: 0x2288cc, emissiveIntensity: 1.6, transparent: true, opacity: 0.92,
        }));
        flame.position.set(sx, 8.4, z);
        g.add(flame);
        this.flames.push(flame);
        const light = new THREE.PointLight(0x66bbff, 10, this.lowGfx ? 22 : 30, 2);
        // with daylight no longer leaking underground the torches carry the
        // scene — pump them on the lit tiers
        if (!this.lowGfx) light.userData.baseIntensity = 30;
        light.position.set(sx, 8.2, z);
        g.add(light);
        this.fireLights.push(light);
      }
    }
    // sarcophagi along the walls
    for (let z = 16; z <= 92; z += 19) {
      for (const sx of [-19, 19]) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 4.2), stoneDark);
        s.position.set(sx, 0.7, z);
        s.castShadow = true;
        g.add(s);
      }
    }
    // bone piles
    for (let i = 0; i < 10; i++) {
      const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5, 0), bone);
      b.position.set(Math.sin(i * 2.4) * 14, 0.3, 12 + i * 9.5);
      b.scale.set(1.2, 0.5, 1);
      g.add(b);
    }
    // boss dais
    const dais = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 1, 12), stone);
    dais.position.set(0, 0.5, 96);
    dais.receiveShadow = true;
    g.add(dais);

    g.position.set(ox, 0, oz);
    this.scene.add(g);
  }

  // Gravewyrm Sanctum: a stretched three-chamber crypt (z 0..158) — the
  // Boneworks, the Ritual Vault and the Wyrm's Hollow — separated by narrowed
  // waists, lit by green ritual fire. Wall/pillar geometry must stay in sync
  // with SANCTUM_COLLIDERS in sim/colliders.ts.
  private buildSanctum(ox: number, oz: number): void {
    const g = new THREE.Group();
    const stone = new THREE.MeshLambertMaterial({ color: 0x5e5a66 });
    const stoneDark = new THREE.MeshLambertMaterial({ color: 0x3f3b48 });
    const bone = new THREE.MeshLambertMaterial({ color: 0xd8d4c0, flatShading: true });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(46, 0.5, 168), stoneDark);
    floor.position.set(0, -0.25, 74.5);
    floor.receiveShadow = true;
    g.add(floor);
    // walls
    for (const sx of [-23, 23]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 9, 168), stone);
      wall.position.set(sx, 4.5, 74.5);
      g.add(wall);
    }
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(48, 9, 2), stone);
    backWall.position.set(0, 4.5, 158);
    g.add(backWall);
    const frontWall = new THREE.Mesh(new THREE.BoxGeometry(48, 9, 2), stone);
    frontWall.position.set(0, 4.5, -9);
    g.add(frontWall);
    // chamber waists: wall stubs leaving a ~10yd centre passage
    for (const sx of [-14, 14]) {
      const stub1 = new THREE.Mesh(new THREE.BoxGeometry(18, 9, 10), stone);
      stub1.position.set(sx, 4.5, 67); // Boneworks -> Korgath's Hall
      g.add(stub1);
      const stub2 = new THREE.Mesh(new THREE.BoxGeometry(18, 9, 6), stone);
      stub2.position.set(sx, 4.5, 115); // Ritual Vault -> Wyrm's Hollow
      g.add(stub2);
    }
    // pillars + green ritual torches (waist bands skipped)
    for (const z of [10, 25, 40, 55, 85, 100, 125, 140]) {
      for (const sx of [-14, 14]) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 8, 7), stone);
        pillar.position.set(sx, 4, z);
        pillar.castShadow = true;
        g.add(pillar);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 6), new THREE.MeshLambertMaterial({
          color: 0xa6ffb8, emissive: 0x22cc55, emissiveIntensity: 1.6, transparent: true, opacity: 0.92,
        }));
        flame.position.set(sx, 8.4, z);
        g.add(flame);
        this.flames.push(flame);
        const light = new THREE.PointLight(0x55e08a, 10, this.lowGfx ? 22 : 30, 2);
        if (!this.lowGfx) light.userData.baseIntensity = 30;
        light.position.set(sx, 8.2, z);
        g.add(light);
        this.fireLights.push(light);
      }
    }
    // bone piles strewn between the chambers (none inside the waist walls)
    for (let i = 0; i < 14; i++) {
      const z = 12 + i * 10;
      if ((z > 60 && z < 74) || (z > 110 && z < 120)) continue;
      const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5, 0), bone);
      b.position.set(Math.sin(i * 2.1) * 14, 0.3, z);
      b.scale.set(1.3, 0.5, 1.1);
      g.add(b);
    }
    // Korzul's great dais
    const dais = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 1.2, 14), stone);
    dais.position.set(0, 0.6, 146);
    dais.receiveShadow = true;
    g.add(dais);

    g.position.set(ox, 0, oz);
    this.scene.add(g);
  }

  // Outdoor fog presets per biome (high tier eases between them as the
  // player crosses zone bands; low keeps the legacy vale fog everywhere).
  private static BIOME_FOG: Record<BiomeId, { color: number; near: number; far: number }> = {
    vale: { color: 0xa6c6e0, near: 130, far: 470 },
    marsh: { color: 0xa3b294, near: 80, far: 330 },
    peaks: { color: 0xbdd3ec, near: 160, far: 560 },
  };

  private outdoorFogPreset(): { color: number; near: number; far: number } {
    if (this.lowGfx) return Renderer.BIOME_FOG.vale;
    return Renderer.BIOME_FOG[zoneBiomeAt(this.sim.player.pos.z)];
  }

  private updateAmbience(px: number, camY: number, dt: number): void {
    const inside = px > DUNGEON_X_THRESHOLD;
    if (inside) {
      // build the interior copy the player is standing in
      for (const dungeon of DUNGEON_LIST) {
        for (let i = 0; i < INSTANCE_SLOT_COUNT; i++) {
          const key = `${dungeon.id}:${i}`;
          if (this.builtInteriors.has(key)) continue;
          const o = instanceOrigin(dungeon.index, i);
          if (Math.abs(px - o.x) < 200 && Math.abs(this.sim.player.pos.z - o.z) < 250) {
            this.builtInteriors.add(key);
            this.buildInterior(dungeon.interior, o.x, o.z);
          }
        }
      }
    }
    const desired = inside ? 'dungeon' : camY < WATER_LEVEL - 0.05 ? 'underwater' : 'outdoor';
    const fog = this.scene.fog as THREE.Fog;
    if (desired !== this.fogState) {
      this.fogState = desired;
      if (desired === 'dungeon') {
        fog.color.setHex(0x05060a);
        fog.near = 18;
        fog.far = 90;
      } else if (desired === 'underwater') {
        fog.color.setHex(0x17506e);
        fog.near = 2;
        fog.far = 48;
      } else {
        const preset = this.outdoorFogPreset();
        fog.color.setHex(preset.color);
        fog.near = preset.near;
        fog.far = preset.far;
      }
      // interiors must not leak daylight: drop sun + sky ambient + IBL
      // underground so the torch point lights own the scene; restore outside
      if (!this.lowGfx) {
        const underground = desired === 'dungeon';
        this.sun.intensity = underground ? DUNGEON_SUN_INTENSITY : SUN_INTENSITY;
        this.hemi.intensity = underground ? DUNGEON_HEMI_INTENSITY : HEMI_INTENSITY;
        this.scene.environmentIntensity = underground ? DUNGEON_ENV_INTENSITY : ENV_INTENSITY;
      }
      return;
    }
    // outdoors: ease fog toward the current biome's preset (~2s)
    if (desired === 'outdoor' && !this.lowGfx) {
      const preset = this.outdoorFogPreset();
      const k = 1 - Math.exp(-dt * 1.5);
      fog.color.lerp(this.fogScratch.setHex(preset.color), k);
      fog.near += (preset.near - fog.near) * k;
      fog.far += (preset.far - fog.far) * k;
    }
  }

  // Drop the view of an entity that left the world / our interest area.
  private removeView(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    v.nameplate.remove();
    const idx = this.clickTargets.indexOf(v.rig.body);
    if (idx >= 0) this.clickTargets.splice(idx, 1);
    this.views.delete(id);
  }

  sync(alpha: number, dt: number, renderFacingOverride: number | null): void {
    this.time += dt;
    sharedUniforms.uTime.value = this.time;
    const sim = this.sim;
    const p = sim.player;

    // dynamic worlds: create views for newcomers, drop views for leavers
    for (const e of sim.entities.values()) {
      if (!this.views.has(e.id)) this.createView(e);
    }
    for (const id of [...this.views.keys()]) {
      if (!sim.entities.has(id)) this.removeView(id);
    }

    for (const e of sim.entities.values()) {
      const v = this.views.get(e.id);
      if (!v) continue;
      // distance cull: far rigs are invisible specks but cost real draw calls
      if (e.id !== p.id) {
        const cdx = e.pos.x - p.pos.x, cdz = e.pos.z - p.pos.z;
        if (cdx * cdx + cdz * cdz > ENTITY_DRAW_RANGE * ENTITY_DRAW_RANGE) {
          v.group.visible = false;
          continue;
        }
        v.group.visible = true; // the object branch below may re-hide loot
      }
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
      const z = e.prevPos.z + (e.pos.z - e.prevPos.z) * alpha;
      v.group.position.set(x, y, z);
      let facing = e.prevFacing + shortestAngle(e.prevFacing, e.facing) * alpha;
      if (e.id === p.id && renderFacingOverride !== null) facing = renderFacingOverride;
      v.group.rotation.y = facing;

      if (e.kind === 'object') {
        const vis = e.lootable;
        v.group.visible = vis;
        if (v.sparkle && vis) {
          const pulse = 0.75 + Math.sin(this.time * 3 + e.id) * 0.25;
          v.sparkle.scale.set(pulse, pulse, 1);
          v.sparkle.material.rotation = this.time * 0.8;
        }
        if (v.portal && vis) {
          v.portal.rotation.z = this.time * 1.4;
          (v.portal.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(this.time * 2.2 + e.id) * 0.15;
        }
        continue;
      }

      // swimming pose: prone at the surface, stroking arms
      const swimming = !e.dead
        && groundHeight(e.pos.x, e.pos.z, this.sim.cfg.seed) < WATER_LEVEL - 0.8
        && e.pos.y <= WATER_LEVEL - 0.5;

      // form swaps: polymorph sheep, druid bear
      const polyed = e.auras.some((a) => a.kind === 'polymorph');
      const bear = !polyed && e.auras.some((a) => a.kind === 'form_bear');
      if (polyed && !v.sheepRig) {
        v.sheepRig = buildSheep();
        v.sheepRig.body.scale.multiplyScalar(e.scale);
        v.group.add(v.sheepRig.body);
      }
      if (bear && !v.bearRig) {
        v.bearRig = buildBear();
        v.bearRig.body.scale.multiplyScalar(e.scale);
        v.group.add(v.bearRig.body);
      }
      if (v.sheepRig) v.sheepRig.body.visible = polyed;
      if (v.bearRig) v.bearRig.body.visible = bear;
      v.rig.body.visible = !polyed && !bear;
      const activeRig = polyed && v.sheepRig ? v.sheepRig : bear && v.bearRig ? v.bearRig : v.rig;
      const parts = activeRig.parts;

      // animation
      const speed = Math.hypot(e.pos.x - e.prevPos.x, e.pos.z - e.prevPos.z) / Math.max(dt, 1e-4) * 0.05;
      const moving = speed > 0.02;
      if (moving) v.walkPhase += dt * 9 * Math.min(2, speed * 6);
      const swing = moving ? Math.sin(v.walkPhase) * 0.55 : 0;

      if (parts.leftLeg || parts.rightLeg) {
        // biped
        if (parts.leftLeg) parts.leftLeg.rotation.x = swing;
        if (parts.rightLeg) parts.rightLeg.rotation.x = -swing;
        if (parts.leftArm) parts.leftArm.rotation.x = -swing * 0.65;
        if (parts.rightArm && v.attackAnim <= 0) parts.rightArm.rotation.x = swing * 0.65;
        if (v.attackAnim > 0) {
          v.attackAnim -= dt;
          const t = 1 - Math.max(0, v.attackAnim) / 0.35;
          if (parts.rightArm) parts.rightArm.rotation.x = -Math.sin(t * Math.PI) * 1.9;
        }
        // idle breathing
        if (!moving && parts.head) parts.head.position.y = (activeRig.kind === 'humanoid' ? 2.18 : parts.head.position.y) + Math.sin(this.time * 1.8 + e.id) * 0.012;
      } else if (parts.legs) {
        if (activeRig.kind === 'spider') {
          parts.legs.forEach((leg, i) => {
            const base = (i % 2 === 0 ? 1 : -1) * 0.18;
            leg.rotation.x = moving ? Math.sin(v.walkPhase * 1.6 + i * 0.9) * 0.35 : Math.sin(this.time * 2 + i) * 0.05;
            leg.rotation.z = base;
          });
        } else {
          parts.legs.forEach((leg, i) => {
            leg.rotation.x = moving ? Math.sin(v.walkPhase + (i % 2) * Math.PI) * 0.7 : 0;
          });
        }
        if (v.attackAnim > 0) {
          v.attackAnim -= dt;
          const t = 1 - Math.max(0, v.attackAnim) / 0.35;
          if (parts.head) parts.head.rotation.x = Math.sin(t * Math.PI) * 0.6;
        } else if (parts.head) {
          parts.head.rotation.x = 0;
        }
        if (parts.tail) parts.tail.rotation.x = 0.55 + Math.sin(this.time * 4 + e.id) * 0.15;
      }

      // death pose
      if (e.dead) {
        activeRig.body.rotation.z = Math.PI / 2;
        activeRig.body.rotation.x = 0;
        activeRig.body.position.y = 0.4;
      } else {
        activeRig.body.rotation.z = 0;
        activeRig.body.rotation.x = 0;
        activeRig.body.position.y = 0;
        if (e.castingAbility && parts.leftArm && parts.rightArm) {
          parts.leftArm.rotation.x = -2.4;
          parts.rightArm.rotation.x = -2.4;
          this.vfx.castSparkle(e.id, ABILITIES[e.castingAbility]?.school ?? 'arcane', dt);
        }
        // sitting pose
        if (e.kind === 'player' && (e.sitting || e.eating || e.drinking)) {
          activeRig.body.position.y = -0.8;
          if (parts.leftLeg) parts.leftLeg.rotation.x = -1.4;
          if (parts.rightLeg) parts.rightLeg.rotation.x = -1.4;
        }
        if (swimming) {
          // prone freestyle at the surface
          activeRig.body.rotation.x = 1.18;
          activeRig.body.position.y = 1.0 + Math.sin(this.time * 2 + e.id) * 0.08;
          const ph = moving ? v.walkPhase : this.time * 2.4;
          if (parts.leftArm) parts.leftArm.rotation.x = Math.sin(ph) * 1.25 - 1.5;
          if (parts.rightArm && v.attackAnim <= 0) parts.rightArm.rotation.x = Math.sin(ph + Math.PI) * 1.25 - 1.5;
          if (parts.leftLeg) parts.leftLeg.rotation.x = Math.sin(ph * 2) * 0.4;
          if (parts.rightLeg) parts.rightLeg.rotation.x = Math.sin(ph * 2 + Math.PI) * 0.4;
          if (moving) this.vfx.swimRipple(v.group.position, dt * 3);
          else this.vfx.swimRipple(v.group.position, dt);
        }
      }
    }

    // selection ring
    const target = p.targetId !== null ? sim.entities.get(p.targetId) : null;
    if (target) {
      const tv = this.views.get(target.id)!;
      this.selectionRing.position.copy(tv.group.position);
      this.selectionRing.position.y += 0.08;
      this.selectionRing.scale.setScalar(target.scale);
      (this.selectionRing.material as THREE.MeshBasicMaterial).color.setHex(
        target.hostile ? 0xcc2222 : 0xd4af37,
      );
      this.selectionRing.visible = true;
    } else {
      this.selectionRing.visible = false;
    }

    // fire flicker + rising embers
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      const fl = 0.85 + Math.sin(this.time * 9 + i * 2.4) * 0.12 + Math.sin(this.time * 23 + i) * 0.06;
      f.scale.set(fl, fl * (1 + Math.sin(this.time * 13 + i) * 0.12), fl);
      const mat = f.material as THREE.MeshLambertMaterial;
      if (mat.color.r > mat.color.b) {
        f.getWorldPosition(this.tmpV);
        this.vfx.campfireEmber(this.tmpV, dt);
      }
    }
    for (let i = 0; i < this.fireLights.length; i++) {
      const light = this.fireLights[i];
      const base = (light.userData.baseIntensity as number | undefined) ?? 11;
      light.intensity = base + Math.sin(this.time * 11 + i * 1.7) * 2.5 * (base / 11);
    }

    // clouds drift (the high cirrus layer crawls slower)
    for (const cl of this.clouds) {
      cl.position.x += dt * ((cl.userData.drift as number | undefined) ?? 1.6);
      if (cl.position.x > 320) cl.position.x = -320;
    }

    // water shimmer (low-tier texture scroll; shader water rides uTime)
    this.waterView.update(this.time);

    this.vfx.update(dt);

    this.updateCamera(alpha);
    this.updateAmbience(p.pos.x, this.camera.position.y, dt);
    // shadow frustum follows the player
    const pv = this.views.get(p.id);
    if (pv) {
      const pp = pv.group.position;
      this.sun.position.set(pp.x + 90, pp.y + 140, pp.z + 50);
      this.sun.target.position.set(pp.x, pp.y, pp.z);
    }
    // sky dome + sun disc ride along with the camera
    this.sky.position.set(this.camera.position.x, 0, this.camera.position.z);
    this.sky.visible = this.fogState === 'outdoor';
    if (this.sky.visible) this.skyView.setCameraZ(this.camera.position.z, dt);
    for (const sp of this.sunSprites) {
      sp.position.copy(this.camera.position).addScaledVector(this.sunDir, 760);
      sp.visible = this.fogState === 'outdoor';
    }
    this.updateGodRays();

    this.updateNameplates();
    if (this.post) this.post.render();
    else this.webgl.render(this.scene, this.camera);
  }

  // light shafts fade in as the camera turns toward the sun, outdoor only
  private updateGodRays(): void {
    if (this.godRays.length === 0) return;
    const outdoor = this.fogState === 'outdoor';
    // azimuth-only alignment — the chase cam always pitches down while the
    // sun sits high, so a full 3D dot product would never light the shafts
    this.camera.getWorldDirection(this.tmpV);
    this.tmpV.y = 0;
    this.tmpV.normalize();
    const sunAzimuth = this.tmpV2.set(this.sunDir.x, 0, this.sunDir.z).normalize();
    const facing = Math.max(0, this.tmpV.dot(sunAzimuth));
    const side = this.tmpV.set(sunAzimuth.z, 0, -sunAzimuth.x); // sunAzimuth x up
    for (let i = 0; i < this.godRays.length; i++) {
      const sp = this.godRays[i];
      sp.visible = outdoor;
      if (!outdoor) continue;
      const sway = Math.sin(this.time * 0.13 + i * 2.1) * 10;
      // hang the shafts sunward of the camera but near eye height so they
      // cross a third-person frame instead of floating 150u overhead
      sp.position.copy(this.camera.position)
        .addScaledVector(sunAzimuth, 48 + i * 26)
        .addScaledVector(side, (i - 1) * 30 + sway);
      sp.position.y = this.camera.position.y + 16 + i * 7;
      sp.material.opacity = facing * facing * facing * (0.30 - i * 0.05);
    }
  }

  private updateCamera(alpha: number): void {
    const p = this.sim.player;
    const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
    const py = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
    const pz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha;
    const eyeY = py + 2.0;
    const cx = px - Math.sin(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const cy = eyeY + Math.sin(this.camPitch) * this.camDist;
    const cz = pz - Math.cos(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const groundY = groundHeight(cx, cz, this.sim.cfg.seed) + 0.6;
    this.camera.position.set(cx, Math.max(cy, groundY), cz);
    this.camera.lookAt(px, eyeY, pz);
  }

  private updateNameplates(): void {
    const sim = this.sim;
    const p = sim.player;
    const w = window.innerWidth, h = window.innerHeight;
    for (const e of sim.entities.values()) {
      const v = this.views.get(e.id);
      if (!v) continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const isSelf = e.id === p.id;
      const isDoor = e.templateId === 'dungeon_door' || e.templateId === 'dungeon_exit';
      const hidden = isSelf || dist > NAMEPLATE_RANGE
        || (e.dead && !e.lootable && e.kind === 'mob')
        || (e.kind === 'object' && !isDoor)
        || (!this.showNameplates && e.kind === 'mob' && !e.dead);
      if (hidden) {
        v.nameplate.style.display = 'none';
        continue;
      }
      this.tmpV.copy(v.group.position);
      this.tmpV.y += v.rig.height * e.scale + 0.5;
      this.tmpV.project(this.camera);
      if (this.tmpV.z > 1) { v.nameplate.style.display = 'none'; continue; }
      const sx = (this.tmpV.x * 0.5 + 0.5) * w;
      const sy = (-this.tmpV.y * 0.5 + 0.5) * h;
      v.nameplate.style.display = '';
      v.nameplate.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;

      if (e.kind === 'object') {
        // dungeon doorways announce themselves
        v.nameEl.style.color = '#c084ff';
        v.nameEl.textContent = e.name;
        v.hpBar.style.display = 'none';
        v.markerEl.textContent = '';
      } else if (e.kind === 'player') {
        // other players: friendly blue with an hp bar
        v.nameEl.style.color = '#7fb8ff';
        v.nameEl.textContent = `${e.name}`;
        v.hpBar.style.display = e.dead ? 'none' : '';
        v.hpFill.style.width = `${(100 * e.hp / Math.max(1, e.maxHp)).toFixed(1)}%`;
        v.markerEl.textContent = '';
      } else if (e.kind === 'npc') {
        v.nameEl.style.color = '#9fdc7f';
        v.nameEl.textContent = e.name;
        v.hpBar.style.display = 'none';
        let marker = '';
        let cls = '';
        for (const qid of e.questIds) {
          const st = sim.questState(qid);
          if (st === 'ready') { marker = '?'; cls = 'ready'; break; }
          if (st === 'available') { marker = '!'; cls = 'avail'; }
          else if (st === 'active' && !marker) { marker = '?'; cls = 'active'; }
        }
        v.markerEl.textContent = marker;
        v.markerEl.className = 'np-marker ' + cls;
      } else {
        const diff = e.level - p.level;
        const template = MOBS[e.templateId];
        const elite = !!template?.elite;
        v.nameEl.style.color = e.dead ? '#999' : diff >= 3 ? '#ff4444' : diff >= 1 ? '#ffaa33' : diff >= -2 ? '#ffe97a' : diff >= -5 ? '#7fdc4f' : '#9d9d9d';
        v.nameEl.textContent = e.dead ? `${e.name} (corpse)` : `[${e.level}${elite ? '+' : ''}] ${e.name}`;
        v.hpBar.style.display = e.dead ? 'none' : '';
        v.hpFill.style.width = `${(100 * e.hp / Math.max(1, e.maxHp)).toFixed(1)}%`;
        v.markerEl.textContent = e.lootable ? '$' : elite && !e.dead ? '◆' : '';
        v.markerEl.className = 'np-marker loot';
      }
    }
  }

  pick(clientX: number, clientY: number): number | null {
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickTargets, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o.userData.entityId !== undefined && o.userData.entityId !== this.sim.playerId) {
          const e = this.sim.entities.get(o.userData.entityId as number);
          if (e?.kind === 'object' && !e.lootable) return null;
          return o.userData.entityId as number;
        }
        o = o.parent;
      }
    }
    return null;
  }

  worldToScreen(x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
    this.tmpV.set(x, y, z).project(this.camera);
    return {
      x: (this.tmpV.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this.tmpV.y * 0.5 + 0.5) * window.innerHeight,
      behind: this.tmpV.z > 1,
    };
  }
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// minimal geometry merge (positions/normals/uvs) to avoid pulling in examples/
function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0, totalIdx = 0;
  for (const g of geoms) {
    totalVerts += g.attributes.position.count;
    totalIdx += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  const idx = new Uint16Array(totalIdx);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array as Float32Array, vOff * 3);
    norm.set(g.attributes.normal.array as Float32Array, vOff * 3);
    uv.set(g.attributes.uv.array as Float32Array, vOff * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    }
    vOff += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
