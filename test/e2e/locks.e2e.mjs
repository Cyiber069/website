// Settings locks in the dashboard at phone width: node test/e2e/locks.e2e.mjs   (exit code 0 = pass)
//
// One local Worker (mock brain) and one Chromium at 390 x 844 with touch. A box locked on "another device" (the
// API) shows the Locked pill with everything in it disabled; unlocking in the PIN dialog gives it back; a lock made
// elsewhere while the page is open turns the next save into a 423, and the box locks itself with a toast.
// SHOTS=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startServer } from '../helpers/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PIN = '2468';
const started = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
const pass = (msg) => log(`PASS  ${msg}`);

let server;
let browser;

async function main() {
  server = await startServer();
  const base = server.url;
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(setup.status, 200, 'owner setup');
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
  const api = async (path, { method, body } = {}) => {
    const headers = { cookie, origin: base };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  // "Another device" sets the PIN and locks the Voice style.
  await api('/api/locks/pin', { body: { pin: PIN } });
  await api('/api/locks/sections/voice', { body: { locked: true, pin: PIN } });
  log(`backend up at ${base}`);

  browser = await chromium.launch({ channel: 'chromium', headless: !process.env.HEADED });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: base }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const shot = async (file) => { if (process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.SHOTS, file), fullPage: true }); } };
  const noSideScroll = async (where) => {
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    assert.ok(sw <= w, `${where}: no sideways scroll at phone width (${sw} > ${w})`);
  };
  /** Controls in a box that still work, leaving out the lock button and what a locked box keeps (Test, Copy, Try again). */
  const liveControls = (sel) => page.evaluate((s) => {
    const box = document.querySelector(s);
    return [...box.querySelectorAll('input, select, textarea, button')]
      .filter((c) => !c.closest('.lockctl') && c.closest('[data-lock], [data-lock-part]') === box && !c.disabled)
      .map((c) => c.name || c.id || c.textContent.trim());
  }, sel);

  // ---- 1. a box locked on another device shows locked here -------------------------------------------------
  await page.goto(`${base}/#/voice`);
  const box = page.locator('#voice-form');
  await box.locator('.lockctl__pill:not([hidden])').waitFor({ timeout: 15_000 });
  assert.equal((await box.locator('.lockctl__pill').innerText()).trim(), 'Locked');
  assert.ok(await box.evaluate((b) => b.classList.contains('is-locked')), 'the box is marked locked');
  assert.deepEqual(await liveControls('#voice-form'), [], 'every input, switch and save button in the locked box is disabled');
  const btn = box.locator('.lockctl__btn');
  assert.equal(await btn.getAttribute('aria-label'), 'Unlock Voice style', 'the lock button says what it does');
  assert.ok(await page.locator('#play-in').isEnabled(), 'the playground next to it is not locked');
  // The pill and the button sit inside the box, at its top right, and leave the title readable.
  const card = await box.boundingBox();
  const ctl = await box.locator('.lockctl').boundingBox();
  const title = await box.locator('h2').boundingBox();
  assert.ok(ctl.x >= card.x && ctl.x + ctl.width <= card.x + card.width + 0.5 && ctl.y - card.y < 24, 'the lock sits at the top right of the box');
  assert.ok(title.x + title.width <= ctl.x + 1 || title.y > ctl.y + ctl.height, 'the title is not under the lock');
  assert.ok((await btn.boundingBox()).width >= 44, 'the lock button is big enough to tap');
  await noSideScroll('Voice');
  await shot('1-voice-locked.png');
  pass('a box locked on another device shows the Locked pill and every control in it is disabled');

  // ---- 2. unlock it with the PIN in the dialog ------------------------------------------------------------------
  await btn.click();
  const dlg = page.locator('dialog.lockdlg');
  await dlg.waitFor();
  assert.equal((await dlg.locator('h2').innerText()).trim().toLowerCase(), 'unlock voice style');
  assert.match(await dlg.innerText(), /Forgot your PIN\?/, 'the dialog says what to do about a forgotten PIN');
  await shot('2-dialog.png');
  await dlg.locator('input[name=pin]').fill('0000');
  await dlg.locator('button[type=submit]').click();
  await dlg.locator('.form-error:not([hidden])').waitFor();
  assert.match(await dlg.locator('.form-error').innerText(), /Wrong PIN\. 4 tries left\./);
  await dlg.locator('input[name=pin]').fill(PIN);
  await dlg.locator('button[type=submit]').click();
  await dlg.waitFor({ state: 'detached' });
  await box.locator('.lockctl__pill[hidden]').waitFor({ state: 'attached' });
  assert.ok(await page.locator('#voice-form textarea[name=extra_rules]').isEnabled(), 'the box works again');
  assert.ok(await page.locator('#voice-form [type=submit]').isDisabled(), 'the save button is back to how the screen had it (nothing changed yet)');
  assert.equal(await btn.getAttribute('aria-label'), 'Lock Voice style');
  pass('the PIN dialog counts a wrong PIN and unlocks with the right one');

  // ---- 3. locked elsewhere while this page is open: the save is refused (423) and the box locks itself ---------
  await api('/api/locks/sections/voice', { body: { locked: true, pin: PIN } });
  await page.locator('#voice-form textarea[name=extra_rules]').fill('never promise a date');
  await page.locator('#voice-form [type=submit]').click();
  await page.locator('.toast', { hasText: 'This is locked. Unlock it with your PIN.' }).first().waitFor({ timeout: 10_000 });
  await box.locator('.lockctl__pill:not([hidden])').waitFor();
  assert.ok(await page.locator('#voice-form textarea[name=extra_rules]').isDisabled(), 'the refused box is locked now');
  assert.notEqual((await api('/api/settings')).settings.voice.extra_rules, 'never promise a date', 'nothing was saved');
  await shot('3-refused.png');
  pass('a change refused with 423 re-renders the box as locked, with a toast');

  // ---- 4. Connections at phone width: every box has its lock, and locking one with the PIN works ---------------
  await page.goto(`${base}/#/connections`);
  await page.locator('#gmail-form > .lockctl').waitFor({ timeout: 15_000 });
  await page.locator('#sec-brain #brain-form').waitFor({ timeout: 15_000 });
  const marked = await page.evaluate(() => [...document.querySelectorAll('[data-lock]')].filter((b) => b.querySelector(':scope > .lockctl')).map((b) => b.dataset.lock));
  assert.deepEqual(marked.sort(), ['alerts', 'brain', 'channels', 'gmail', 'laptops', 'pacing', 'shopify', 'vision']);
  await noSideScroll('Connections');
  await page.locator('#sec-pacing .lockctl__btn').click();
  await dlg.waitFor();
  assert.equal((await dlg.locator('h2').innerText()).trim().toLowerCase(), 'lock pacing?');
  await dlg.locator('input[name=pin]').fill(PIN);
  await dlg.locator('button[type=submit]').click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('#sec-pacing .lockctl__pill:not([hidden])').waitFor();
  assert.deepEqual(await liveControls('#sec-pacing'), [], 'the pacing box is locked');
  assert.ok((await liveControls('#sec-channels')).length > 0, 'the box next to it is not');
  await noSideScroll('Connections, a box locked');
  await shot('4-connections.png');
  assert.deepEqual((await api('/api/locks')).locked, ['voice', 'pacing']);
  pass('every Connections box has its lock at phone width, and the dialog locks one on the server');

  assert.deepEqual(pageErrors, [], 'no errors on the page');
  log('ALL PASSED');
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  console.error(`\nFAIL  ${err?.stack || err}`);
  if (server && process.env.SERVER_LOG) console.error(server.logs().slice(-4000));
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }
}
process.exit(code);
