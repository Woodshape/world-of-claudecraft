// Phase 2 sprite runtime smoke test: ?style=sprite, directional sprites,
// animation API, blob shadows, and baked atlas loading.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

import { BROWSER_PATH as EDGE } from './browser_path.mjs';

const URL = process.env.GAME_URL ?? 'http://localhost:5173/?style=sprite&gfx=high';
fs.mkdirSync('tmp', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--window-size=1600,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text());
});

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 45000 });
await page.click('#btn-offline');
await new Promise((r) => setTimeout(r, 200));
await page.click('.class-card[data-class="mage"]');
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: 'tmp/sprite_01_spawn.png' });

// Eastbrook outdoor — kobold camp near mine
await page.evaluate(() => {
  const g = window.__game;
  g.sim.player.pos.x = -82;
  g.sim.player.pos.z = -62;
  g.sim.player.facing = 0;
  g.input.camYaw = Math.PI;
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: 'tmp/sprite_02_kobold_camp.png' });

const koboldCheck = await page.evaluate(() => {
  const g = window.__game;
  for (const e of g.sim.entities.values()) {
    if (e.kind !== 'mob' || e.templateId !== 'tunnel_rat') continue;
    const view = g.renderer.views.get(e.id);
    return view?.visual?.constructor?.name ?? null;
  }
  return null;
});
console.log('kobold visual:', koboldCheck);

// Forest wolf pack — quadruped sprite validation
await page.evaluate(() => {
  const g = window.__game;
  g.sim.player.pos.x = -15;
  g.sim.player.pos.z = 55;
  g.sim.player.facing = 0;
  g.input.camYaw = Math.PI;
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: 'tmp/sprite_02b_wolf_pack.png' });

const wolfCheck = await page.evaluate(() => {
  const g = window.__game;
  for (const e of g.sim.entities.values()) {
    if (e.kind !== 'mob' || e.templateId !== 'forest_wolf') continue;
    const view = g.renderer.views.get(e.id);
    return view?.visual?.constructor?.name ?? null;
  }
  return null;
});
console.log('wolf visual:', wolfCheck);

// Rotate camera to verify directional sprites and consistent on-screen size
const rotationCheck = await page.evaluate(() => {
  const g = window.__game;
  const p = g.sim.player;
  const pv = g.renderer.views.get(g.sim.playerId);
  const visual = pv?.visual;
  const sprite = visual?.root?.children?.find((c) => c.type === 'Sprite');
  const map = sprite?.material?.map;
  if (!visual?.setCamera || !sprite || !map?.image) {
    return { ok: false, reason: 'missing sprite setup' };
  }

  const img = map.image;
  const atlasW = img.width;
  const atlasH = img.height;
  const fw = Math.max(1, Math.round(map.repeat.x * atlasW));
  const fh = Math.max(1, Math.round(map.repeat.y * atlasH));
  const canvas = document.createElement('canvas');
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext('2d');

  function frameOpaqueHeight() {
    const offset = sprite.material.map.offset;
    const repeat = sprite.material.map.repeat;
    const sx = Math.round(offset.x * atlasW);
    const sy = Math.round((1 - offset.y - repeat.y) * atlasH);
    ctx.clearRect(0, 0, fw, fh);
    ctx.drawImage(img, sx, sy, fw, fh, 0, 0, fw, fh);
    const data = ctx.getImageData(0, 0, fw, fh).data;
    let minY = fh;
    let maxY = -1;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (data[(y * fw + x) * 4 + 3] > 12) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return maxY >= minY ? maxY - minY + 1 : 0;
  }

  const heights = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.renderer.camera.position.set(
      p.pos.x + Math.sin(a) * 10,
      p.pos.y + 4,
      p.pos.z + Math.cos(a) * 10,
    );
    g.renderer.camera.lookAt(p.pos.x, p.pos.y + 1.5, p.pos.z);
    visual.setCamera(g.renderer.camera);
    heights.push(frameOpaqueHeight());
  }
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  return {
    ok: min > 0 && max / min <= 1.12,
    heights,
    ratio: min > 0 ? max / min : null,
  };
});
console.log('rotation size check:', JSON.stringify(rotationCheck));

for (let i = 0; i < 4; i++) {
  await page.evaluate(() => { window.__game.input.camYaw += Math.PI / 2; });
  await new Promise((r) => setTimeout(r, 600));
}
await page.screenshot({ path: 'tmp/sprite_03_camera_rotation.png' });

// Hollow Crypt — skeleton minion
await page.evaluate(() => {
  const g = window.__game;
  const sim = g.sim;
  const p = sim.player;
  p.pos.x = 520;
  p.pos.z = 40;
  p.pos.y = 0;
});
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: 'tmp/sprite_04_crypt.png' });

const skelCheck = await page.evaluate(() => {
  const g = window.__game;
  for (const e of g.sim.entities.values()) {
    if (e.kind !== 'mob' || e.templateId !== 'restless_bones') continue;
    const view = g.renderer.views.get(e.id);
    return view?.visual?.constructor?.name ?? null;
  }
  return null;
});
console.log('skeleton visual:', skelCheck);

// Cast fireball at nearest mob
const cast = await page.evaluate(() => {
  const g = window.__game;
  const sim = g.sim;
  const p = sim.player;
  let mob = null;
  let d = 1e9;
  for (const e of sim.entities.values()) {
    if (e.kind === 'mob' && !e.dead) {
      const dd = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (dd < d) { d = dd; mob = e; }
    }
  }
  if (!mob) return { ok: false, reason: 'no mob' };
  sim.targetEntity(mob.id);
  p.facing = Math.atan2(mob.pos.x - p.pos.x, mob.pos.z - p.pos.z);
  sim.castAbility('fireball');
  return { ok: true, mobId: mob.id, template: mob.templateId };
});
console.log('fireball cast:', JSON.stringify(cast));
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'tmp/sprite_05_fireball.png' });

const spriteCheck = await page.evaluate(() => {
  const g = window.__game;
  const p = g.sim.player;
  const pv = g.renderer.views.get(g.sim.playerId);
  const visual = pv?.visual;
  const sprite = visual?.root?.children?.find((c) => c.type === 'Sprite');
  const blob = visual?.root?.children?.find((c) => c.type === 'Mesh' && c.geometry?.type === 'CircleGeometry');
  const offsets = [];
  if (visual?.setCamera) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.renderer.camera.position.set(
        p.pos.x + Math.sin(a) * 10,
        p.pos.y + 4,
        p.pos.z + Math.cos(a) * 10,
      );
      g.renderer.camera.lookAt(p.pos.x, p.pos.y + 1.5, p.pos.z);
      visual.setCamera(g.renderer.camera);
      offsets.push(sprite?.material?.map?.offset?.y ?? null);
    }
  }
  const uniqueOffsets = new Set(offsets.filter((v) => v !== null));
  return {
    style: new URLSearchParams(location.search).get('style'),
    playerVisual: visual?.constructor?.name ?? null,
    hasBlobShadow: !!blob,
    hasSprite: !!sprite,
    atlasLoaded: !!sprite?.material?.map,
    directionBuckets: uniqueOffsets.size,
  };
});
console.log('sprite check:', JSON.stringify(spriteCheck));

const ok = spriteCheck.style === 'sprite'
  && spriteCheck.playerVisual === 'SpriteCharacterVisual'
  && koboldCheck === 'SpriteCharacterVisual'
  && wolfCheck === 'SpriteCharacterVisual'
  && skelCheck === 'SpriteCharacterVisual'
  && spriteCheck.hasBlobShadow
  && spriteCheck.hasSprite
  && spriteCheck.atlasLoaded
  && spriteCheck.directionBuckets >= 3
  && rotationCheck.ok
  && cast.ok;
console.log(ok ? 'SPRITE RUNTIME: OK' : 'SPRITE RUNTIME: FAIL');
console.log(errors.length ? 'ERRORS: ' + errors.join('; ') : 'no page errors');

await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
