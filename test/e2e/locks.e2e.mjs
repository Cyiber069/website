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

  // ---- 5. Change PIN from the unlock dialog ---------------------------------------------------------------------
  const NEW_PIN = '1357';
  await page.locator('#sec-pacing .lockctl__btn').click();
  await dlg.waitFor();
  await dlg.locator('[data-lk="change"]').click();
  await page.locator('dialog.lockdlg h2', { hasText: /change your pin/i }).waitFor();
  assert.equal(await page.locator('dialog.lockdlg').count(), 1, 'one dialog at a time');
  await dlg.locator('input[name=old_pin]').fill(PIN);
  await dlg.locator('input[name=new_pin]').fill(NEW_PIN);
  await dlg.locator('input[name=again]').fill(NEW_PIN);
  await dlg.locator('button[type=submit]').click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('.toast', { hasText: 'PIN changed.' }).first().waitFor();
  await api('/api/locks/sections/sales', { body: { locked: true, pin: NEW_PIN } });
  await api('/api/locks/sections/sales', { body: { locked: false, pin: NEW_PIN } });
  pass('Change PIN opens from the dialog and the new PIN works');

  // ---- 6. the lock row was cleared by hand but the PIN was not: Set a PIN turns into "enter it" ------------------
  await api('/api/test/sql', { body: { sql: `DELETE FROM settings WHERE key = 'state:locks'` } });
  await page.locator('#sec-pacing .lockctl__btn').click();
  await dlg.waitFor();
  assert.equal((await dlg.locator('h2').innerText()).trim().toLowerCase(), 'set a pin', 'the page was told no PIN is set');
  await dlg.locator('input[name=new_pin]').fill('2222');
  await dlg.locator('input[name=again]').fill('2222');
  await dlg.locator('button[type=submit]').click();
  await page.locator('dialog.lockdlg h2', { hasText: /lock pacing\?/i }).waitFor();
  assert.match(await page.locator('dialog.lockdlg .form-error').innerText(), /A PIN is already set/);
  await dlg.locator('input[name=pin]').fill(NEW_PIN);
  await dlg.locator('button[type=submit]').click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('#sec-pacing .lockctl__pill:not([hidden])').waitFor();
  pass('a PIN that exists turns the Set a PIN dialog into the Lock dialog, and it locks');

  // ---- 7. the PIN was cleared but not the lock row: Lock turns into Set a PIN ------------------------------------
  const LAST_PIN = '4444';
  await api('/api/test/sql', { body: { sql: `DELETE FROM settings WHERE key = 'state:lock_pin'` } });
  await page.locator('#sec-channels > .lockctl .lockctl__btn').click();
  await dlg.waitFor();
  assert.equal((await dlg.locator('h2').innerText()).trim().toLowerCase(), 'lock channel modes?');
  await dlg.locator('input[name=pin]').fill(LAST_PIN);
  await dlg.locator('button[type=submit]').click();
  await page.locator('dialog.lockdlg h2', { hasText: /set a pin/i }).waitFor();
  assert.match(await page.locator('dialog.lockdlg .form-error').innerText(), /no PIN yet/);
  await dlg.locator('input[name=new_pin]').fill(LAST_PIN);
  await dlg.locator('input[name=again]').fill(LAST_PIN);
  await dlg.locator('button[type=submit]').click();
  await dlg.waitFor({ state: 'detached' });
  await page.locator('#sec-channels > .lockctl .lockctl__pill:not([hidden])').waitFor();
  assert.deepEqual((await api('/api/locks')).locked, ['channels', 'pacing']);
  pass('no PIN on the server turns the Lock dialog into Set a PIN, and it locks');

  // ---- 8. narrow phones: a locked box never pushes sideways or covers its title or first row ----------------------
  await api('/api/locks/sections/alerts', { body: { locked: true, pin: LAST_PIN } });
  await api('/api/locks/sections/recovery_settings', { body: { locked: true, pin: LAST_PIN } });
  const overlap = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`${base}/?w=${width}#/connections`); // a real load, not only a new hash
    const notify = page.locator('#sec-notify');
    await notify.locator('.lockctl[data-state="locked"]').waitFor({ timeout: 15_000 });
    await notify.locator('#h-notify').waitFor();
    await noSideScroll(`Connections at ${width} px`);
    const ctlBox = await notify.locator('.lockctl').boundingBox();
    assert.ok(!overlap(await notify.locator('#h-notify').boundingBox(), ctlBox), `the notifications title is clear of the lock at ${width} px`);
    const pillBox = await notify.locator('.lockctl__pill').boundingBox();
    if (width < 360) assert.ok(!pillBox || pillBox.width <= 1, 'below 360 px the lit lock button stands in for the pill');
    else assert.ok(pillBox.width > 30, 'the Locked pill shows at 390 px');
    assert.equal((await notify.locator('.lockctl__pill').textContent()).trim(), 'Locked', 'screen readers still hear Locked');
    await shot(`8-notify-${width}.png`);

    await page.goto(`${base}/?w=${width}#/recovery`);
    const rs = page.locator('#rec-settings');
    await rs.locator('.lockctl[data-state="locked"]').waitFor({ timeout: 15_000 });
    await noSideScroll(`Recovery at ${width} px`);
    const rsCtl = await rs.locator('.lockctl').boundingBox();
    assert.ok(!overlap(await rs.locator('.switch').first().boundingBox(), rsCtl), `the first switch is clear of the lock at ${width} px`);
    // The title is the padded first line itself: measure its words, not its box.
    const words = await rs.locator('h2').evaluate((h) => { const r = document.createRange(); r.selectNodeContents(h); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
    assert.ok(!overlap(words, rsCtl), `the Settings title is clear of the lock at ${width} px`);
    await shot(`8-recovery-${width}.png`);
  }
  pass('at 320 and 390 px a locked box keeps its title and first row clear and nothing scrolls sideways');

  // ---- 9. every confirm dialog stacks its buttons on a phone (the shared rule) -------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#/live`);
  await page.locator('#panic').click();
  const confirm = page.locator('dialog.dialog:not(.lockdlg)');
  await confirm.waitFor();
  const actions = await confirm.locator('.dialog__actions').boundingBox();
  const [b1, b2] = await Promise.all([0, 1].map((i) => confirm.locator('.dialog__actions .btn').nth(i).boundingBox()));
  for (const b of [b1, b2]) {
    assert.ok(b.height <= 56, `confirm buttons are one line high (${b.height})`);
    assert.ok(b.width >= actions.width - 1, 'confirm buttons are full width');
  }
  assert.ok(Math.abs(b1.y - b2.y) >= b1.height, 'confirm buttons are stacked');
  await shot('9-confirm.png');
  await confirm.locator('button', { hasText: 'Keep going' }).click();
  await confirm.waitFor({ state: 'detached' });
  pass('a confirm dialog stacks two full width buttons at 390 px');

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
