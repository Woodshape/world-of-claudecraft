// Phase 1 sprite style spike smoke test: ?style=sprite, mage player, kobold
// outdoor camp, Hollow Crypt skeleton, fireball projectile.
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

// Rotate camera to verify directional sprites
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
  const pv = g.renderer.views.get(g.sim.playerId);
  const visual = pv?.visual;
  return {
    style: new URLSearchParams(location.search).get('style'),
    playerVisual: visual?.constructor?.name ?? null,
    hasBlobShadow: !!visual?.root?.children?.some((c) => c.type === 'Mesh' && c.geometry?.type === 'CircleGeometry'),
  };
});
console.log('sprite check:', JSON.stringify(spriteCheck));

const ok = spriteCheck.style === 'sprite'
  && spriteCheck.playerVisual === 'SpriteCharacterVisual'
  && spriteCheck.hasBlobShadow
  && cast.ok;
console.log(ok ? 'SPRITE SPIKE: OK' : 'SPRITE SPIKE: FAIL');
console.log(errors.length ? 'ERRORS: ' + errors.join('; ') : 'no page errors');

await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
