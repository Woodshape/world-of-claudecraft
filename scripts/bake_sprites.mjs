// Procedural sprite atlas baker for the Phase 1 spike.
// Generates PNG atlases + manifest.generated.ts. When GLB baking lands in
// Phase 4, this script becomes the offline capture entry point.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TAU = Math.PI * 2;

const SPIKE_DEFS = {
  player_mage: {
    key: 'player_mage',
    url: '/sprites/chars/mage.png',
    out: 'sprites/chars/mage.png',
    dirs: 8,
    frameSize: [96, 96],
    anchor: [48, 84],
    worldHeight: 2.35,
    palette: { body: '#4a7fd4', trim: '#2a4f94', accent: '#9ed0ff' },
    states: {
      idle: { row: 0, frames: 4, fps: 6 },
      walk: { row: 8, frames: 6, fps: 10 },
      run: { row: 16, frames: 6, fps: 12 },
      walkBack: { row: 24, frames: 6, fps: 10 },
      attack: { row: 32, frames: 5, fps: 12, once: true },
      hit: { row: 40, frames: 3, fps: 12, once: true },
      cast: { row: 48, frames: 4, fps: 8 },
      death: { row: 56, frames: 6, fps: 10, once: true },
    },
  },
  mob_kobold: {
    key: 'mob_kobold',
    url: '/sprites/mobs/kobold.png',
    out: 'sprites/mobs/kobold.png',
    dirs: 8,
    frameSize: [96, 96],
    anchor: [48, 84],
    worldHeight: 2.1,
    palette: { body: '#5a9a42', trim: '#2f5a22', accent: '#c8e878' },
    states: {
      idle: { row: 0, frames: 4, fps: 6 },
      walk: { row: 8, frames: 6, fps: 10 },
      run: { row: 16, frames: 6, fps: 12 },
      attack: { row: 24, frames: 5, fps: 12, once: true },
      hit: { row: 32, frames: 3, fps: 12, once: true },
      death: { row: 40, frames: 6, fps: 10, once: true },
    },
  },
  skel_minion: {
    key: 'skel_minion',
    url: '/sprites/mobs/skel_minion.png',
    out: 'sprites/mobs/skel_minion.png',
    dirs: 8,
    frameSize: [96, 96],
    anchor: [48, 84],
    worldHeight: 2.2,
    palette: { body: '#c8c4b8', trim: '#6a6660', accent: '#f0ece0' },
    states: {
      idle: { row: 0, frames: 4, fps: 6 },
      walk: { row: 8, frames: 6, fps: 10 },
      run: { row: 16, frames: 6, fps: 12 },
      attack: { row: 24, frames: 5, fps: 12, once: true },
      hit: { row: 32, frames: 3, fps: 12, once: true },
      death: { row: 40, frames: 6, fps: 10, once: true },
    },
  },
};

function atlasDims(def) {
  let cols = 0;
  let rows = def.dirs;
  for (const st of Object.values(def.states)) {
    cols = Math.max(cols, st.frames);
    rows = Math.max(rows, st.row + def.dirs);
  }
  return { cols, rows };
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawFrame(rgba, w, h, fw, fh, x0, y0, dir, frame, palette) {
  const cx = x0 + fw * 0.5;
  const footY = y0 + Math.floor(fh * 0.88);
  const bob = Math.sin(frame * 1.4) * 2;
  const bodyH = Math.floor(fh * 0.42);
  const bodyW = Math.floor(fw * 0.34);
  const angle = (dir / 8) * TAU;

  const put = (px, py, rgb) => {
    if (px < x0 || py < y0 || px >= x0 + fw || py >= y0 + fh) return;
    const ix = px;
    const iy = py;
    const o = (iy * w + ix) * 4;
    rgba[o] = rgb[0];
    rgba[o + 1] = rgb[1];
    rgba[o + 2] = rgb[2];
    rgba[o + 3] = 255;
  };

  const fillRect = (rx, ry, rw, rh, rgb) => {
    for (let py = ry; py < ry + rh; py++) {
      for (let px = rx; px < rx + rw; px++) put(px, py, rgb);
    }
  };

  const accent = hexRgb(palette.accent);
  const body = hexRgb(palette.body);
  const trim = hexRgb(palette.trim);

  const wedgeLen = fw * 0.22;
  const apexX = cx;
  const apexY = footY - bodyH * 0.5 + bob;
  for (let t = 0; t <= 1; t += 0.05) {
    const x1 = apexX + Math.sin(angle) * wedgeLen * t;
    const y1 = apexY - Math.cos(angle) * wedgeLen * t;
    const x2 = apexX + Math.sin(angle + 0.35) * wedgeLen * 0.55 * t;
    const y2 = apexY - Math.cos(angle + 0.35) * wedgeLen * 0.55 * t;
    for (let s = 0; s <= 1; s += 0.2) {
      put(Math.round(x1 + (x2 - x1) * s), Math.round(y1 + (y2 - y1) * s), accent);
    }
  }

  fillRect(Math.round(cx - bodyW * 0.5), Math.round(footY - bodyH + bob), bodyW, bodyH, body);

  const headR = Math.floor(fw * 0.14);
  const hx = Math.round(cx);
  const hy = Math.round(footY - bodyH - headR + bob);
  for (let dy = -headR; dy <= headR; dy++) {
    for (let dx = -headR; dx <= headR; dx++) {
      if (dx * dx + dy * dy <= headR * headR) put(hx + dx, hy + dy, trim);
    }
  }

  const markX = Math.round(cx + Math.sin(angle) * bodyW * 0.35);
  const markY = Math.round(footY - bodyH * 0.55 + bob - Math.cos(angle) * bodyW * 0.2);
  fillRect(markX - 3, markY - 3, 6, 6, accent);

  const legSwing = Math.sin(frame * 1.8) * 4;
  fillRect(Math.round(cx - bodyW * 0.35), Math.round(footY - 10 + bob), 8, Math.round(10 + legSwing), trim);
  fillRect(Math.round(cx + bodyW * 0.15), Math.round(footY - 10 + bob), 8, Math.round(10 - legSwing), trim);
}

function bakeAtlas(def) {
  const [fw, fh] = def.frameSize;
  const { cols, rows } = atlasDims(def);
  const w = cols * fw;
  const h = rows * fh;
  const rgba = new Uint8Array(w * h * 4);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      drawFrame(rgba, w, h, fw, fh, col * fw, row * fh, row % def.dirs, col, def.palette);
    }
  }
  return { w, h, rgba };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function writePng(path, w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  const out = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
}

function emitManifest() {
  const entries = Object.values(SPIKE_DEFS).map((d) => {
    const states = Object.entries(d.states).map(([k, v]) => {
      const once = v.once ? ', once: true' : '';
      return `      ${k}: { row: ${v.row}, frames: ${v.frames}, fps: ${v.fps}${once} }`;
    }).join(',\n');
    return `  ${d.key}: {
    key: '${d.key}',
    url: '${d.url}',
    dirs: ${d.dirs},
    frameSize: [${d.frameSize.join(', ')}],
    anchor: [${d.anchor.join(', ')}],
    worldHeight: ${d.worldHeight},
    states: {
${states},
    },
  }`;
  }).join(',\n');

  const ts = `// Generated by scripts/bake_sprites.mjs — do not hand-edit.
import type { SpriteManifest } from './types';

export const SPRITE_MANIFESTS: Record<string, SpriteManifest> = {
${entries},
};
`;
  writeFileSync(join(ROOT, 'src/render/sprites/manifest.generated.ts'), ts);
}

for (const def of Object.values(SPIKE_DEFS)) {
  const { w, h, rgba } = bakeAtlas(def);
  const outPath = join(ROOT, def.out);
  writePng(outPath, w, h, Buffer.from(rgba));
  console.log(`baked ${def.key}: ${w}x${h} -> ${def.out}`);
}

emitManifest();
console.log('wrote src/render/sprites/manifest.generated.ts');
