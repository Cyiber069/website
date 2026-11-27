#!/usr/bin/env node
// Renders template preview cards to images so they can be checked by eye.
//   node templates/render.js 3        -> out/template-3.png plus close-up crops
//   node templates/render.js all      -> every template
//   node templates/render.js 3 zones  -> also out/template-3-zones.png with the HUD's reserved areas marked red
// Prints text that does not fit its box, script errors, and the files written.
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const which = process.argv[2] || 'all', zones = process.argv.includes('zones');
  const out = path.join(__dirname, 'out'); require('fs').mkdirSync(out, { recursive: true });
  const url = 'file://' + path.join(__dirname, 'previews.html');
  const b = await chromium.launch();
  const problems = [];
  const page = await b.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => problems.push('SCRIPT ERROR: ' + e.message));
  page.on('console', m => m.type() === 'error' && !/ERR_FILE_NOT_FOUND/.test(m.text()) && problems.push('CONSOLE: ' + m.text())); // other templates' files may not exist yet
  await page.goto(url + (which === 'all' ? '' : '?t=' + which));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const ids = await page.evaluate(() => [...document.querySelectorAll('.card')].map(c => c.id));
  if (!ids.length) problems.push('No card was drawn. Check that src/t' + which + '.js sets window.TEMPLATES[' + which + '].');
  problems.push(...await page.evaluate(() => [...(window.FRAME_ERRORS || []), ...window.checkFit()]));
  const fonts = await page.evaluate(() => document.fonts.check("700 20px Fredoka"));
  if (!fonts) problems.push('The Fredoka font did not load.');
  for (const id of ids) {
    const n = id.slice(1), card = page.locator('#' + id);
    await card.screenshot({ path: path.join(out, `template-${n}.png`) });
    // close-ups at 2x so small details can be checked
    const p2 = await b.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
    await p2.goto(url + '?t=' + n); await p2.evaluate(() => document.fonts.ready); await p2.waitForTimeout(200);
    await p2.locator('#' + id + ' .phone').screenshot({ path: path.join(out, `template-${n}-scene.png`) });
    await p2.locator('#' + id + ' .minis').screenshot({ path: path.join(out, `template-${n}-minis.png`) });
    const box = await p2.locator('#' + id).boundingBox();
    await p2.screenshot({ path: path.join(out, `template-${n}-lower.png`), clip: { x: box.x, y: box.y + 1300, width: box.width, height: box.height - 1300 }, fullPage: true });
    if (zones) { await p2.goto(url + '?t=' + n + '&zones=1'); await p2.waitForTimeout(200); await p2.locator('#' + id + ' .phone').screenshot({ path: path.join(out, `template-${n}-zones.png`) }); }
    await p2.close();
    console.log(`wrote out/template-${n}.png (whole card), -scene.png, -minis.png, -lower.png${zones ? ', -zones.png' : ''}`);
  }
  console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'No problems found by the automatic checks.');
  await b.close();
  process.exit(problems.length ? 1 : 0);
})();
