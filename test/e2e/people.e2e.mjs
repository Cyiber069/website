// End to end test of people, failover and the blue dot on Live: node test/e2e/people.e2e.mjs   (exit code 0 = pass)
//
// One Chromium with the unpacked extension is "Sam's laptop" with the three mock sites. A second laptop,
// "Adrian's", is played through the API with its own token (it says its WhatsApp is ready on the same
// number). The phone is a second browser with no extension. Checked:
//  1. Pairing asks whose laptop it is. The chips next to the logo show Sam and Adrian, and the People
//     panel shows this laptop, each channel and its account (the WhatsApp number from the page itself).
//  2. While Adrian's laptop answers WhatsApp, this one stands by: it never opens a new chat, and the
//     page changing all the time does not make it sync every few seconds.
//  3. The blue dot on this laptop opens and pins the tab at once (a closed tab is opened, an unpinned
//     one is pinned).
//  4. From the phone, the dot sends a command to the laptop picked: it opens there on its next sync and
//     the phone says so.
//  5. Adrian's laptop goes offline: this one takes WhatsApp over and answers the waiting customer, once.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { createGmailMock } from './mocks/gmail/server.mjs';

// Lets context.route() see the requests the extension's service worker makes (the sync count).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const WA_MOCK = join(here, 'mocks', 'whatsapp');
const TIKTOK_HTML = readFileSync(join(here, 'mocks', 'tiktok', 'index.html'), 'utf8');
const TIKTOK_URL = 'https://www.tiktok.com/messages?lang=en';
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const SHOP_NUMBER = '447700900123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
const pass = (msg) => log(`PASS  ${msg}`);

let server;
let context;
let phoneBrowser;
let adrianTimer = null;
const tmp = [];

function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'acx-people-ext-'));
  cpSync(join(root, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  for (const cs of manifest.content_scripts) for (const f of cs.js) if (!existsSync(join(dir, f))) writeFileSync(join(dir, f), '// not built yet\n');
  for (const f of Object.values(manifest.icons ?? {})) if (!existsSync(join(dir, f))) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), dot); }
  return dir;
}

async function main() {
  // ---- backend ----------------------------------------------------------------------------------------
  server = await startServer();
  const base = server.url;
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(setup.status, 200, 'owner setup');
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
  const [cookieName, cookieValue] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
  const api = async (path, { method, body, token } = {}) => {
    const headers = token ? { authorization: `Bearer ${token}` } : { cookie, origin: base };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const sql = async (query, params = []) => (await api('/api/test/sql', { body: { sql: query, params } })).results;
  // The dashboard answers are kept in memory for 20 s: dropped so each look is current.
  const bust = () => api('/api/test/bust', { body: {} });
  await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 2, min_reply_delay_s: 0, max_reply_delay_s: 0, typing_cps: 0, max_auto_replies_per_thread_per_hour: 60 } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' }, gmail: { mode: 'auto' }, tiktok: { mode: 'auto' } } });
  await api('/api/selectors', { method: 'PUT', body: { override: { gmail: { timing: { afterSendMs: 250, waitVisibleMs: 6000, waitHiddenMs: 6000 } } } } });

  // Adrian's laptop: paired first, it answers WhatsApp on the shop's number. It checks in every 15 s.
  const adrianCode = await api('/api/devices/pair-code', { body: { person: 'Adrian' } });
  const adrian = await fetch(`${base}/api/agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: adrianCode.code, name: 'Adrian MacBook' }) }).then((r) => r.json());
  assert.equal(adrian.person, 'Adrian');
  const adrianSync = () => api('/api/agent/sync', { token: adrian.token, body: { version: '0.6.0', status: { channels: { whatsapp: { state: 'ready', account: `${SHOP_NUMBER}@c.us`, unread: 0, busy: false, sending: false, sending_id: null, last_ok_at: Date.now() - 1000, ok_age_ms: 1000 } } } } });
  const first = await adrianSync();
  assert.equal(first.lanes['whatsapp:inbox'].role, 'active', 'Adrian’s laptop answers WhatsApp');
  adrianTimer = setInterval(() => { adrianSync().catch(() => {}); }, 15_000);
  const { pairing_string: pairing } = await api('/api/devices/pair-code', { body: {} });
  log(`backend up at ${base}; Adrian’s laptop answers WhatsApp`);

  // ---- Sam's laptop: Chromium with the extension and the three mock sites ---------------------------------
  const ext = stageExtension();
  const profile = mkdtempSync(join(tmpdir(), 'acx-people-profile-'));
  tmp.push(ext, profile);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: !process.env.HEADED, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await context.route('https://web.whatsapp.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app.bundle.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(WA_MOCK, 'app.bundle.js')) });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: readFileSync(join(WA_MOCK, 'index.html')) });
  });
  const gmail = createGmailMock();
  await context.route('https://mail.google.com/**', gmail.handle);
  await context.route('https://www.tiktok.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/messages')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: TIKTOK_HTML });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>TikTok (mock)</title>' });
  });
  await context.route(`${base}/api/agent/pair`, async (route) => {
    let res = await route.fetch();
    if (res.status() === 403) { const headers = { ...route.request().headers() }; delete headers.origin; res = await route.fetch({ headers }); }
    await route.fulfill({ response: res });
  });
  // Every sync this laptop makes is counted (a laptop that stands by must not sync on each page change).
  const syncs = [];
  await context.route(`${base}/api/agent/sync`, async (route) => { syncs.push(Date.now()); await route.continue(); });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false }));
  const tabsOf = (pattern) => sw.evaluate((p) => chrome.tabs.query({ url: p }).then((ts) => ts.map((t) => ({ id: t.id, pinned: t.pinned, active: t.active, url: t.url || t.pendingUrl }))), pattern);

  // Start TikTok from a quiet inbox (the seed's chats are dated two hours ago, as in tiktok.e2e.mjs).
  const prep = await context.newPage();
  await prep.goto(TIKTOK_URL);
  await prep.waitForFunction(() => window.mock && window.mock.ready);
  await prep.evaluate(() => {
    const st = window.mock.state();
    const old = new Date(Date.now() - 2 * 3600_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    for (const c of st.convs) c.time = old;
    localStorage.setItem('mock_tiktok_state_v1', JSON.stringify(st));
  });
  await prep.close();

  const wa = await context.newPage();
  await wa.goto('https://web.whatsapp.com/');
  await wa.waitForFunction(() => document.body.dataset.mockReady === '1');
  // The phone this WhatsApp Web is linked to, where WhatsApp keeps it (extension/content/whatsapp.js ownNumber).
  await wa.evaluate((n) => localStorage.setItem('last-wid-md', JSON.stringify(`${n}:7@c.us`)), SHOP_NUMBER);
  const gm = await context.newPage();
  await gm.goto(GMAIL_URL);
  await gm.waitForFunction(() => document.body.dataset.mockReady === '1');
  let tt = await context.newPage();
  await tt.goto(TIKTOK_URL);
  await tt.waitForFunction(() => window.mock && window.mock.ready);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#pairing', pairing);
  await popup.fill('#person', 'Sam');
  await popup.fill('#device-name', 'Shop laptop');
  await popup.click('#pair-btn');
  await popup.waitForSelector('#main-view:not([hidden])', { timeout: 20_000 });

  const kick = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'tick' }, () => { void chrome.runtime.lastError; r(); }))).catch(() => {});
  async function until(what, fn, { timeout = 60_000, poke = false } = {}) {
    const end = Date.now() + timeout;
    let last = 0;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}\n  people: ${JSON.stringify(await api('/api/people').catch(() => '?')).slice(0, 2500)}`);
      if (poke && Date.now() - last > 1500) { last = Date.now(); await kick(); }
      await sleep(250);
    }
  }
  const waMock = (fn, ...args) => wa.evaluate(([f, a]) => window.mock[f](...a), [fn, args]);
  const lanes = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'lanes' }, (res) => r(res?.lanes || []))));
  const samDevice = async () => { await bust(); return (await api('/api/people')).people.find((p) => p.name === 'Sam')?.devices?.[0] || null; };

  // ---- 1. whose laptop, the chips next to the logo, the People panel ----------------------------------------
  const sam = await until('Sam’s laptop ready on all three, standing by on WhatsApp', async () => {
    const d = await samDevice();
    return d && ['whatsapp', 'gmail', 'tiktok'].every((c) => d.channels[c].state === 'ready') && d.channels.whatsapp.role === 'standby' ? d : null;
  }, { poke: true });
  assert.equal(sam.label, 'Sam’s laptop');
  assert.equal(sam.version, '0.6.0');
  assert.equal(sam.channels.whatsapp.account_shown, `+${SHOP_NUMBER}`, 'the WhatsApp number comes from the page');
  assert.equal(sam.channels.gmail.role, 'active');
  assert.equal(sam.channels.tiktok.role, 'active');
  const grants = await sw.evaluate(() => chrome.storage.local.get('lanes').then((o) => o.lanes));
  assert.equal(grants['whatsapp:inbox'].role, 'standby', 'the extension knows it stands by on WhatsApp');
  assert.equal(grants['whatsapp:inbox'].leader.person, 'Adrian');
  assert.match(await popup.textContent('#sub'), /Sam’s laptop/, 'the popup says whose laptop it is');

  await context.addCookies([{ name: cookieName, value: cookieValue, url: base }]);
  await bust();
  const dash = await context.newPage();
  const pageErrors = [];
  dash.on('pageerror', (e) => pageErrors.push(String(e)));
  await dash.goto(`${base}/#/live`);
  await dash.waitForSelector('.side [data-person]');
  await until('both people next to the logo', async () => (await dash.$$eval('.side [data-person] .pchip__name', (els) => els.map((e) => e.textContent))).sort().join() === 'Adrian,Sam');
  await dash.click('.side [data-person]:has-text("Sam")');
  await dash.waitForSelector('.dialog--people[open] .pcard');
  const panelText = await dash.textContent('.dialog--people');
  for (const want of ['Sam’s laptop', 'This laptop', 'Laptop connected', `+${SHOP_NUMBER}`, 'Standing by for Adrian’s laptop', 'Answering']) assert.ok(panelText.includes(want), `the People panel says "${want}"`);
  assert.doesNotMatch(panelText, /[–—]/, 'no dashes in the panel');
  await dash.click('.dialog--people [data-switch]:has-text("Adrian")');
  await dash.waitForFunction(() => document.querySelector('.dialog--people .dialog__title')?.textContent === 'Adrian');
  assert.ok((await dash.textContent('.dialog--people')).includes('Adrian’s laptop'), 'the other person shows their own laptop');
  await dash.click('.dialog--people [data-close].btn--primary');
  pass('pairing asked whose laptop it is; Sam and Adrian next to the logo; the panel shows each laptop, its channels and the WhatsApp number');

  // ---- 2. standing by: no reading, no sync on every page change -------------------------------------------------
  // The first look at Gmail and TikTok (which this laptop answers) is over first: the seeds hold mail it reads once.
  await until('lanes idle after the first look', async () => (await lanes()).every((l) => !l.queued && !l.inbound && !l.sending), { poke: true });
  await sleep(4000);
  const waiting = '447700901500';
  await waMock('receive', `+${waiting}`, 'do you ship to ireland');
  const quietFrom = Date.now();
  const before = syncs.length;
  // The page keeps changing (other chats come in), as WhatsApp does all day.
  for (let i = 0; i < 16; i++) { await waMock('receive', `+4477009016${String(i).padStart(2, '0')}`, `noise ${i}`); await sleep(1000); }
  const made = syncs.filter((t) => t >= quietFrom).length;
  assert.ok(made <= 2, `a laptop that stands by syncs on its own timer only (${made} syncs in 16 s, ${syncs.length - before} counted)`);
  const conv = await sql('SELECT id FROM conversations WHERE external_thread_id = ?', [`${waiting}@c.us`]);
  assert.equal(conv.length, 0, 'the standby never read the waiting chat');
  const chat = (await waMock('chats')).find((c) => c.jid === `${waiting}@c.us`);
  assert.ok(chat && chat.unread > 0 && !chat.open, 'the chat is still unread for the laptop that answers');
  pass(`standing by on WhatsApp: the new chat was left alone, ${made} syncs in 16 s of page changes`);

  // ---- 3. the blue dot on this laptop: opens and pins at once --------------------------------------------------
  await tt.close();
  assert.equal((await tabsOf('https://www.tiktok.com/*')).length, 0, 'no TikTok tab before the dot');
  await dash.bringToFront();
  const ttToast = dash.waitForSelector('.toast:has-text("TikTok is open and pinned on this laptop.")', { timeout: 15_000 });
  await dash.click('[data-open-tab="tiktok"]');
  await ttToast;
  const ttTab = await until('a pinned TikTok tab', async () => (await tabsOf('https://www.tiktok.com/*')).find((t) => t.pinned && t.active) || null, { timeout: 15_000 });
  assert.match(ttTab.url, /\/messages/);
  assert.equal((await tabsOf('https://web.whatsapp.com/*'))[0].pinned, false, 'the WhatsApp tab starts unpinned');
  await dash.bringToFront();
  await dash.click('[data-open-tab="whatsapp"]');
  const waTab = await until('the WhatsApp tab pinned and shown', async () => { const [t] = await tabsOf('https://web.whatsapp.com/*'); return t && t.pinned && t.active ? t : null; }, { timeout: 15_000 });
  assert.equal((await tabsOf('https://web.whatsapp.com/*')).length, 1, 'the same tab, not a new one');
  pass(`the dot on this laptop opened a closed TikTok tab and pinned it, and pinned the open WhatsApp tab (tab ${waTab.id})`);
  tt = context.pages().find((p) => p.url().startsWith('https://www.tiktok.com/')) || null;

  // ---- 4. from the phone: a command to the laptop picked --------------------------------------------------------
  phoneBrowser = await chromium.launch({ headless: !process.env.HEADED });
  const phoneCtx = await phoneBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phoneCtx.addCookies([{ name: cookieName, value: cookieValue, url: base }]);
  await bust();
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => pageErrors.push(`phone: ${e}`));
  await phone.goto(`${base}/#/live`);
  await phone.waitForSelector('.people--top [data-person]');
  assert.equal(await phone.isVisible('.people--top'), true, 'the phone shows the people in its top bar');
  assert.equal((await tabsOf('https://mail.google.com/*'))[0].pinned, false, 'the Gmail tab starts unpinned');
  await phone.click('[data-open-tab="gmail"]');
  await phone.waitForSelector('dialog[open] .pick');
  const sentToast = phone.waitForSelector('.toast:has-text("It opens on Sam’s laptop in a few seconds.")', { timeout: 15_000 });
  const doneToast = phone.waitForSelector('.toast:has-text("Gmail is open and pinned on Sam’s laptop.")', { timeout: 75_000 });
  await phone.click('dialog[open] .pick:has-text("Sam’s laptop")');
  await sentToast;
  const sentAt = Date.now();
  const gmTab = await until('the Gmail tab pinned on Sam’s laptop', async () => (await tabsOf('https://mail.google.com/*')).find((t) => t.pinned) || null, { timeout: 45_000 });
  const opened = Date.now() - sentAt;
  await doneToast;
  pass(`from the phone: the dot asked which laptop, the command reached Sam’s laptop on its next sync (${(opened / 1000).toFixed(1)} s), pinned tab ${gmTab.id}, and the phone said so`);

  // ---- 5. Adrian's laptop goes offline: this one takes over and answers, once ----------------------------------------
  clearInterval(adrianTimer); adrianTimer = null;
  await sql('UPDATE devices SET last_seen_at = ? WHERE id = ?', [Date.now() - 95_000, adrian.device_id]);
  await until('Sam’s laptop to answer WhatsApp', async () => (await samDevice())?.channels?.whatsapp?.role === 'active', { poke: true, timeout: 60_000 });
  const reply = await until('the waiting customer answered', async () => (await waMock('sent')).filter((s) => s.jid === `${waiting}@c.us`)[0], { timeout: 60_000, poke: true });
  assert.equal(reply.text, 'Mock reply to: do you ship to ireland');
  await sleep(6000);
  assert.equal((await waMock('sent')).filter((s) => s.jid === `${waiting}@c.us`).length, 1, 'answered once');
  const [ev] = await sql(`SELECT message FROM events WHERE type = 'failover' AND channel = 'whatsapp' ORDER BY id DESC LIMIT 1`);
  assert.equal(ev.message, 'Sam’s laptop took over WhatsApp. Adrian’s laptop is offline.');
  pass('Adrian’s laptop went offline: Sam’s laptop took WhatsApp over and answered the waiting customer once');

  assert.deepEqual(pageErrors, [], 'no errors on the dashboard pages');
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
  if (adrianTimer) clearInterval(adrianTimer);
  try { if (phoneBrowser) await phoneBrowser.close(); } catch { /* ignore */ }
  try { if (context) await context.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }
  for (const dir of tmp) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.exit(code);
