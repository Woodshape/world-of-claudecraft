import * as THREE from 'three';
import { WORLD_MAX_Z, WORLD_MIN_Z, ZONES } from '../sim/data';
import type { BiomeId } from '../sim/types';
import { cloudTexture, skyTexture } from './textures';

// Shader sky dome + cloud sprites.
//
// High tier: zenith/horizon/haze gradient with a warm glow around the sun
// direction; horizon and haze tint lerp by camera z across the zone bands so
// each biome's sky feels different. The dome rides with the camera (the
// renderer sets its position every frame) and feeds the PMREM environment
// capture.
//
// Low tier keeps the legacy 4x256 canvas-gradient dome.

const DOME_RADIUS = 560;

interface SkyPalette {
  zenith: number;
  horizon: number;
  haze: number;
}

// per-biome sky colors (hex are display-ish sRGB; THREE.Color converts to
// the linear working space)
const BIOME_SKY: Record<BiomeId, SkyPalette> = {
  vale: { zenith: 0x3d71b8, horizon: 0xa8cae6, haze: 0xd2dee2 },
  marsh: { zenith: 0x49708c, horizon: 0xaabd9e, haze: 0xc6ccab },
  peaks: { zenith: 0x2d5ba8, horizon: 0x9cc0ea, haze: 0xcadcf2 },
};

export interface SkyView {
  dome: THREE.Mesh;
  /** lerps horizon/haze tint toward the biome band the camera is over */
  setCameraZ(z: number, dt: number): void;
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position; // dome is camera-centred; object space = view direction
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    vec3 c = mix(uHorizon, uZenith, smoothstep(0.02, 0.42, h));
    c = mix(uHaze, c, smoothstep(-0.02, 0.09, h));                 // horizon haze band
    float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 8.0);
    c += vec3(1.0, 0.85, 0.6) * sunAmt * 0.35;                     // warm glow around the sun
    float sunCore = pow(max(dot(dir, uSunDir), 0.0), 90.0);
    c += vec3(1.0, 0.92, 0.75) * sunCore * 0.55;                   // tighter bright core
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Blend the biome sky palettes across the same ±30/35u windows the terrain
// palette uses, keyed by camera z.
function paletteForZ(z: number, zenith: THREE.Color, horizon: THREE.Color, haze: THREE.Color): void {
  const first = BIOME_SKY[ZONES[0].biome];
  zenith.setHex(first.zenith);
  horizon.setHex(first.horizon);
  haze.setHex(first.haze);
  for (let i = 0; i + 1 < ZONES.length; i++) {
    const b = ZONES[i].zMax;
    const t = Math.max(0, Math.min(1, (z - (b - 30)) / 65));
    const tt = t * t * (3 - 2 * t);
    if (tt <= 0) break;
    const next = BIOME_SKY[ZONES[i + 1].biome];
    zenith.lerp(new THREE.Color(next.zenith), tt);
    horizon.lerp(new THREE.Color(next.horizon), tt);
    haze.lerp(new THREE.Color(next.haze), tt);
  }
}

export function buildSky(lowGfx: boolean, sunDir: THREE.Vector3): SkyView {
  if (lowGfx) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    dome.renderOrder = -10;
    return { dome, setCameraZ: () => {} };
  }

  const uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uHaze: { value: new THREE.Color() },
    uSunDir: { value: sunDir.clone().normalize() },
  };
  paletteForZ(0, uniforms.uZenith.value, uniforms.uHorizon.value, uniforms.uHaze.value);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), material);
  dome.renderOrder = -10;

  const target = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    haze: new THREE.Color(),
  };
  return {
    dome,
    setCameraZ(z: number, dt: number): void {
      paletteForZ(z, target.zenith, target.horizon, target.haze);
      // gentle chase — biome boundaries fade in over ~2s
      const k = 1 - Math.exp(-dt * 1.5);
      uniforms.uZenith.value.lerp(target.zenith, k);
      uniforms.uHorizon.value.lerp(target.horizon, k);
      uniforms.uHaze.value.lerp(target.haze, k);
    },
  };
}

export interface CloudLayer {
  sprites: THREE.Sprite[];
}

// Cloud sprites over the whole strip: 3 canvas variants, opacity scaled by
// altitude, plus (high tier) a slow, faint cirrus layer well above the first.
export function buildClouds(lowGfx: boolean): CloudLayer {
  const variants = lowGfx
    ? [cloudTexture()]
    : [cloudTexture(14, 0.5), cloudTexture(8, 0.7), cloudTexture(20, 0.42)];
  const sprites: THREE.Sprite[] = [];
  const span = (WORLD_MAX_Z - WORLD_MIN_Z) + 240;

  const spawn = (count: number, yMin: number, yMax: number, baseOpacity: number, drift: number, scaleMin: number, scaleMax: number): void => {
    for (let i = 0; i < count; i++) {
      const y = yMin + Math.random() * (yMax - yMin);
      // higher clouds thin out
      const altFade = 1 - 0.35 * ((y - yMin) / Math.max(1, yMax - yMin));
      const mat = new THREE.SpriteMaterial({
        map: variants[i % variants.length],
        transparent: true,
        opacity: baseOpacity * altFade,
        fog: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const sc = scaleMin + Math.random() * (scaleMax - scaleMin);
      sprite.scale.set(sc, sc * 0.45, 1);
      sprite.position.set(
        (Math.random() - 0.5) * 600,
        y,
        WORLD_MIN_Z - 120 + Math.random() * span,
      );
      sprite.userData.drift = drift;
      sprites.push(sprite);
    }
  };

  if (lowGfx) {
    spawn(14, 95, 150, 0.85, 1.6, 60, 150);
  } else {
    spawn(30, 95, 150, 0.85, 1.6, 60, 150);
    spawn(10, 165, 195, 0.35, 0.55, 130, 230); // high slow cirrus layer
  }
  return { sprites };
}
