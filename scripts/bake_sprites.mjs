// Phase 4: GLB sprite baking pipeline.
// Bundles a Three.js capture pass (scripts/bake/glb_bake.ts), runs it in
// headless Chromium via puppeteer, applies pixel-art post-processing, writes
// PNG atlases + src/render/sprites/manifest.generated.ts.
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { BROWSER_PATH } from './browser_path.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'tmp/glb_bake.bundle.js');
const QUICK = process.argv.includes('--quick');

function mime(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.glb')) return 'model/gltf-binary';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function resolveFile(url) {
  const rel = url.replace(/^\/+/, '');
  const candidates = [
    join(ROOT, 'public', rel),
    join(ROOT, rel),
  ];
  for (const file of candidates) {
    if (file.startsWith(ROOT) && existsSync(file)) return file;
  }
  return null;
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const file = resolveFile(url);
      if (!file) {
        res.writeHead(404).end('not found');
        return;
      }
      try {
        const data = readFileSync(file);
        res.writeHead(200, { 'Content-Type': mime(file) });
        res.end(data);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function bundleBakeScript() {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  await esbuild.build({
    entryPoints: [join(ROOT, 'scripts/bake/glb_bake.ts')],
    bundle: true,
    format: 'esm',
    outfile: BUNDLE,
    platform: 'browser',
    target: ['es2022'],
    logLevel: 'silent',
  });
}

function b64ToRgba(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function nearestDownscale(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x / dstW) * srcW));
      const sy = Math.min(srcH - 1, Math.floor((y / dstH) * srcH));
      const si = (sy * srcW + sx) * 4;
      const oi = (y * dstW + x) * 4;
      out[oi] = src[si];
      out[oi + 1] = src[si + 1];
      out[oi + 2] = src[si + 2];
      out[oi + 3] = src[si + 3];
    }
  }
  return out;
}

function quantizeChannel(v, levels) {
  const step = 255 / (levels - 1);
  return Math.round(Math.round(v / step) * step);
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function applyPixelTreatment(rgba, w, h, { paletteBits = 6, dither = true, outline = true } = {}) {
  const out = new Uint8Array(rgba.length);
  const levels = 1 << paletteBits;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      if (a < 12) {
        out[i + 3] = 0;
        continue;
      }
      const threshold = dither ? ((BAYER4[y & 3][x & 3] / 16) - 0.5) * (256 / levels) : 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.min(255, Math.max(0, rgba[i + c] * 1.28 + 22 + threshold));
        out[i + c] = quantizeChannel(v, levels);
      }
      out[i + 3] = 255;
    }
  }

  if (!outline) return out;

  const lined = new Uint8Array(out);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (out[i + 3] === 0) continue;
      let edge = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ni = ((y + dy) * w + (x + dx)) * 4;
        if (out[ni + 3] === 0) { edge = true; break; }
      }
      if (edge) {
        lined[i] = 26;
        lined[i + 1] = 20;
        lined[i + 2] = 32;
      }
    }
  }
  return lined;
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
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

function relOutPath(url) {
  return join(ROOT, url.replace(/^\/+/, ''));
}

function emitManifest(results) {
  validateBakedManifests(results);
  const entries = results.map((r) => {
    const states = Object.entries(r.states).map(([k, v]) => {
      const once = v.once ? ', once: true' : '';
      return `      ${k}: { row: ${v.row}, frames: ${v.frames}, fps: ${v.fps}${once} }`;
    }).join(',\n');
    return `  ${r.key}: {
    key: '${r.key}',
    url: '${r.url}',
    dirs: ${r.dirs},
    frameSize: [${r.frameSize.join(', ')}],
    anchor: [${r.anchor.join(', ')}],
    worldHeight: ${r.worldHeight},
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

function validateBakedManifests(results) {
  for (const r of results) {
    if (r.dirs < 1) throw new Error(`${r.key}: dirs must be >= 1`);
    const blocks = Object.entries(r.states).map(([name, st]) => {
      if (st.frames < 1) throw new Error(`${r.key}.${name}: frames must be >= 1`);
      if (st.row % r.dirs !== 0) {
        throw new Error(`${r.key}.${name}: row ${st.row} not aligned to dirs ${r.dirs}`);
      }
      return { name, start: st.row, end: st.row + r.dirs };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].start < blocks[i - 1].end) {
        throw new Error(`${r.key}: overlapping state rows ${blocks[i - 1].name} and ${blocks[i].name}`);
      }
    }
  }
}

async function runBrowserBake(base, quick) {
  const browser = await puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const url = `${base}/scripts/bake/bake.html?quick=${quick ? '1' : '0'}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    const results = await page.evaluate(() => window.__bakeResults);
    if (errors.length) throw new Error(`browser bake errors: ${errors.join('; ')}`);
    if (!results?.length) throw new Error('no bake results from browser');
    return results;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`sprite bake: bundling${QUICK ? ' (quick mode)' : ''}...`);
  await bundleBakeScript();
  const { server, port, base } = await startStaticServer();
  console.log(`sprite bake: static server on :${port}`);
  try {
    const rawResults = await runBrowserBake(base, QUICK);
    const processed = rawResults.map((r) => {
      const rgba = b64ToRgba(r.rgbaB64);
      const treated = applyPixelTreatment(rgba, r.width, r.height);
      const outPath = relOutPath(r.url);
      writePng(outPath, r.width, r.height, treated);
      console.log(`baked ${r.key}: ${r.width}x${r.height} -> ${r.url.replace(/^\//, '')}`);
      return {
        key: r.key,
        url: r.url,
        dirs: r.dirs,
        frameSize: r.frameSize,
        anchor: r.anchor,
        worldHeight: r.worldHeight,
        states: r.states,
      };
    });
    emitManifest(processed);
    console.log('wrote src/render/sprites/manifest.generated.ts');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
