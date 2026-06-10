import * as THREE from 'three';
import { WORLD_MAX_Z, WORLD_MIN_Z, WORLD_SIZE, ZONES } from '../sim/data';
import { terrainHeight, WATER_LEVEL } from '../sim/world';
import { GFX, sharedUniforms } from './gfx';
import { waterNormalish, waterNormalMaps } from './textures';

// Water for the whole zone strip.
//
// High tier: one ShaderMaterial plane per zone (so off-screen zones frustum
// cull away) with a CPU-precomputed per-vertex shore depth. Dual scrolling
// normal maps, fresnel sky tint, HDR sun glints (>1 so bloom catches them),
// a shoreline foam band and a subtle wave displacement.
//
// Low tier keeps the legacy scrolling Phong plane.

const SEGMENTS_PER_ZONE = 180; // ~2u vertex spacing — enough for the foam band
const DEEP_COLOR = new THREE.Color(0x0d3a52);
const SHALLOW_COLOR = new THREE.Color(0x2d8077);
const SKY_TINT = new THREE.Color(0x7fb2e0); // matches the sky horizon band
const SUN_COLOR = new THREE.Color(0xfff0d4);

export interface WaterView {
  meshes: THREE.Mesh[];
  /** advances the legacy texture scroll (low tier); high tier uses uTime */
  update(time: number): void;
}

const WATER_VERT = /* glsl */ `
  attribute float aShoreDepth;
  uniform float uTime;
  varying vec3 vWPos;
  varying float vShoreDepth;
  #include <fog_pars_vertex>
  void main() {
    vec3 pos = position;
    pos.y += (sin(uTime * 1.1 + pos.x * 0.35) + sin(uTime * 0.7 + pos.z * 0.28)) * 0.05;
    vShoreDepth = aShoreDepth;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform sampler2D uNorm1;
  uniform sampler2D uNorm2;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform float uTime;
  varying vec3 vWPos;
  varying float vShoreDepth;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec3 n1 = texture2D(uNorm1, vWPos.xz * 0.06 + uTime * vec2(0.013, 0.019)).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(uNorm2, vWPos.xz * 0.13 - uTime * vec2(0.021, 0.011)).xyz * 2.0 - 1.0;
    vec3 N = normalize(vec3(n1.xy * 1.5 + n2.xy, 2.0).xzy);
    vec3 V = normalize(cameraPosition - vWPos);
    float fresnel = 0.06 + 0.94 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
    float depth = clamp(vShoreDepth / 4.5, 0.0, 1.0);
    vec3 col = mix(uShallow, uDeep, depth);
    // dappled shimmer: the scrolling normals modulate brightness so the
    // surface reads as moving water from every angle
    col *= 0.88 + 0.45 * max(n1.x * 0.7 + n2.y * 0.55, 0.0);
    col = mix(col, uSkyColor, fresnel * 0.5);                        // cheap sky reflection
    float sunAlign = max(dot(reflect(-uSunDir, N), V), 0.0);
    col += uSunColor * pow(sunAlign, 90.0) * 2.6;                    // sun glints (>1 -> bloom)
    col += uSunColor * pow(sunAlign, 16.0) * 0.14;                   // broad warm sheen sunward
    // shoreline foam: wobbly, animated band hugging the waterline
    float foamBand = smoothstep(1.5, 0.0, vShoreDepth + n1.x * 0.5);
    foamBand *= foamBand;
    float foamWave = 0.65 + 0.35 * sin(uTime * 1.8 + vWPos.x * 1.4 + vWPos.z * 1.1 + n2.y * 5.0);
    float foam = foamBand * foamWave;
    col = mix(col, vec3(1.04), clamp(foam, 0.0, 0.95));
    float alpha = max(mix(0.82, 0.95, depth), foam * 0.95);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function buildShaderWater(seed: number): WaterView {
  const [norm1, norm2] = waterNormalMaps();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uNorm1: { value: norm1 },
      uNorm2: { value: norm2 },
      uSunDir: { value: new THREE.Vector3(90, 140, 50).normalize() },
      uSunColor: { value: SUN_COLOR },
      uSkyColor: { value: SKY_TINT },
      uDeep: { value: DEEP_COLOR },
      uShallow: { value: SHALLOW_COLOR },
      uTime: sharedUniforms.uTime,
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });

  const meshes: THREE.Mesh[] = [];
  for (const zone of ZONES) {
    const depth = zone.zMax - zone.zMin;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, depth, SEGMENTS_PER_ZONE, SEGMENTS_PER_ZONE)
      .rotateX(-Math.PI / 2);
    geo.translate(0, 0, (zone.zMin + zone.zMax) / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const shoreDepth = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      shoreDepth[i] = WATER_LEVEL - terrainHeight(pos.getX(i), pos.getZ(i), seed);
    }
    geo.setAttribute('aShoreDepth', new THREE.BufferAttribute(shoreDepth, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.y = WATER_LEVEL;
    meshes.push(mesh);
  }
  return { meshes, update: () => {} };
}

function buildPhongWater(): WaterView {
  const tex = waterNormalish();
  tex.repeat.set(30, 30);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x2a6a96, transparent: true, opacity: 0.8, shininess: 140,
    specular: 0xd8ecff, map: tex,
  });
  const worldDepth = WORLD_MAX_Z - WORLD_MIN_Z;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE, worldDepth).rotateX(-Math.PI / 2),
    mat,
  );
  mesh.position.set(0, WATER_LEVEL, (WORLD_MIN_Z + WORLD_MAX_Z) / 2);
  return {
    meshes: [mesh],
    update(time: number): void {
      tex.offset.x = time * 0.008;
      tex.offset.y = time * 0.011;
    },
  };
}

export function buildWater(seed: number): WaterView {
  return GFX.standardMaterials ? buildShaderWater(seed) : buildPhongWater();
}
