// End to end test of the lanes ("reply as fast as possible"): node test/e2e/lanes.e2e.mjs   (exit code 0 = pass)
//
// One Chromium with the unpacked extension and all three mock sites (WhatsApp, Gmail, TikTok), one
// local Worker from this checkout (mock brain). The server here is today's: no `final`, no
// `retry_after_ms`, no `jobs_pending`. The pacing is set the way the new server sends it (no delay,
// typing_cps 0: each part pasted whole), so these checks hold for both.
//
// Most waits below do NOT poke the extension: detection must come from the pages' own nudges and the
// lanes' timers, as it does on the owner's laptop. Reply times are printed.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { runChecks } from './lanes.check.mjs';
import { createGmailMock } from './mocks/gmail/server.mjs';

// Lets context.route() see the requests the extension's service worker makes (the cut stream check).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const WA_MOCK = join(here, 'mocks', 'whatsapp');
const TIKTOK_HTML = readFileSync(join(here, 'mocks', 'tiktok', 'index.html'), 'utf8');
const TIKTOK_URL = 'https://www.tiktok.com/messages?lang=en';
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
const pass = (msg) => log(`PASS  ${msg}`);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

let server;
let context;
const tmp = [];
const times = []; // [label, ms] for the summary

function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'acx-lanes-ext-'));
  cpSync(join(root, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  for (const cs of manifest.content_scripts) for (const f of cs.js) if (!existsSync(join(dir, f))) writeFileSync(join(dir, f), '// not built yet\n');
  for (const f of Object.values(manifest.icons ?? {})) if (!existsSync(join(dir, f))) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), dot); }
  return dir;
}

async function main() {
  // ---- pure rules first (no browser) ----------------------------------------------------------------
  await runChecks();

  // ---- backend ----------------------------------------------------------------------------------------
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
  const sql = async (query, params = []) => (await api('/api/test/sql', { body: { sql: query, params } })).results;
  // What the new server sends: no reply delay, typing_cps 0 (paste whole). Settle short for the test.
  const pacing = (p) => api('/api/settings/pacing', { method: 'PUT', body: p });
  await pacing({ settle_seconds: 2, min_reply_delay_s: 0, max_reply_delay_s: 0, typing_cps: 0, max_auto_replies_per_thread_per_hour: 60 });
  await api('/api/settings/channels', { method: 'PUT', body: { gmail: { mode: 'auto' }, tiktok: { mode: 'auto' } } });
  await api('/api/selectors', { method: 'PUT', body: { override: { gmail: { timing: { afterSendMs: 250, waitVisibleMs: 6000, waitHiddenMs: 6000 } } } } });
  const { pairing_string: pairing } = await api('/api/devices/pair-code', { body: {} });
  log(`backend up at ${base}`);

  // ---- browser with the extension and the three mock sites ---------------------------------------------
  const ext = stageExtension();
  const profile = mkdtempSync(join(tmpdir(), 'acx-lanes-profile-'));
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
  // TikTok: the messages page is the mock. Business Suite is a separate app whose chat sits in a frame
  // (where the agent cannot work): a shell like that is served, so the lane has to bring the tab back.
  const BUSINESS_SHELL = '<!doctype html><title>TikTok Business Suite (mock)</title><div data-testid="sider-menu-messages">Messages</div><iframe src="/messages?scene=business&u=1&lang=en&allow_label=true" style="width:900px;height:600px"></iframe>';
  await context.route('https://www.tiktok.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/messages')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: TIKTOK_HTML });
    if (path.startsWith('/business-suite/')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: BUSINESS_SHELL });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>TikTok (mock)</title>' });
  });
  // The server answers 403 to the extension's Origin on POST /api/agent/pair (see the other tests): retry without it.
  await context.route(`${base}/api/agent/pair`, async (route) => {
    let res = await route.fetch();
    if (res.status() === 403) { const headers = { ...route.request().headers() }; delete headers.origin; res = await route.fetch({ headers }); }
    await route.fulfill({ response: res });
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false }));

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
  const gm = await context.newPage();
  await gm.goto(GMAIL_URL);
  await gm.waitForFunction(() => document.body.dataset.mockReady === '1');
  const tt = await context.newPage();
  await tt.goto(TIKTOK_URL);
  await tt.waitForFunction(() => window.mock && window.mock.ready);
  const pageErrors = [];
  for (const p of [wa, gm, tt]) p.on('pageerror', (e) => pageErrors.push(String(e)));

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#pairing', pairing);
  await popup.fill('#device-name', 'E2E laptop');
  await popup.click('#pair-btn');
  await popup.waitForSelector('#main-view:not([hidden])', { timeout: 20_000 });
  pass('paired through the popup, three mock sites open');

  // ---- helpers ---------------------------------------------------------------------------------------------
  const kick = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'tick' }, () => { void chrome.runtime.lastError; r(); }))).catch(() => {});
  const lanes = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'lanes' }, (res) => r(res?.lanes || []))));
  /** Wait for `fn`. With `poke` the extension is asked to sync and scan every 1.5 s; without, it is left alone. */
  async function until(what, fn, { timeout = 60_000, poke = false } = {}) {
    const end = Date.now() + timeout;
    let last = 0;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) {
        const outbox = await sql('SELECT id, channel, status, source, last_error, parts FROM outbox ORDER BY created_at DESC LIMIT 6').catch(() => []);
        throw new Error(`timed out waiting for: ${what}\n  lanes: ${JSON.stringify(await lanes().catch(() => '?'))}\n  outbox: ${JSON.stringify(outbox).slice(0, 1500)}`);
      }
      if (poke && Date.now() - last > 1500) { last = Date.now(); await kick(); }
      await sleep(250);
    }
  }
  const waMock = (fn, ...args) => wa.evaluate(([f, a]) => window.mock[f](...a), [fn, args]);
  const waSent = () => waMock('sent');
  const waTo = async (jid) => (await waSent()).filter((s) => s.jid === jid);
  const ttSent = () => tt.evaluate(() => window.mock.sent());
  const channelState = async (ch) => (await api('/api/overview')).device?.status?.channels?.[ch]?.state;
  /** Settings reach the extension with the next sync: ask for one and wait until the lanes are ready. */
  const syncNow = async () => { await kick(); await sleep(1200); };

  for (const ch of ['whatsapp', 'gmail', 'tiktok']) await until(`${ch} ready`, async () => (await channelState(ch)) === 'ready', { poke: true });
  // Let the first scans settle (the seeds hold a group chat and an automated email the agent reads once).
  await until('lanes idle after the first look', async () => (await lanes()).every((l) => !l.queued && !l.inbound && !l.sending), { poke: true });
  await sleep(3000);
  pass('all three lanes ready');

  // ---- 1. five WhatsApp customers at the same moment ------------------------------------------------------
  {
    const five = [1, 2, 3, 4, 5].map((i) => ({ i, phone: `4477009010${i}0`, text: `question ${i} about the x${i} battery` }));
    const at = {};
    for (const c of five) { at[c.phone] = Date.now(); await waMock('receive', `+${c.phone}`, c.text); }
    const got = await until('five replies', async () => {
      const s = (await waSent()).filter((x) => five.some((c) => x.jid === `${c.phone}@c.us`));
      return s.length >= 5 ? s : null;
    }, { timeout: 90_000 });
    await sleep(5000);
    const all = (await waSent()).filter((x) => five.some((c) => x.jid === `${c.phone}@c.us`));
    assert.equal(all.length, 5, `exactly one reply each, no duplicates (${all.length})`);
    const lines = [];
    for (const c of five) {
      const r = got.find((x) => x.jid === `${c.phone}@c.us`);
      assert.equal(r.text, `Mock reply to: ${c.text}`, 'each reply went to the right chat');
      const ms = r.at - at[c.phone];
      times.push([`WhatsApp customer ${c.i} of 5`, ms]);
      lines.push(`#${c.i} ${secs(ms)}`);
      assert.ok(ms < 45_000, `customer ${c.i} answered in ${secs(ms)}`);
    }
    pass(`five WhatsApp customers at once, one reply each: ${lines.join(', ')}`);
  }

  // ---- 2. a customer sends three quick messages: one reply ------------------------------------------------
  {
    await pacing({ settle_seconds: 4 });
    await syncNow();
    const jid = '447700901900@c.us';
    await waMock('receive', '+447700901900', 'hi');
    await sleep(1500);
    await waMock('receive', '+447700901900', 'how much');
    await sleep(1500);
    const lastAt = Date.now();
    await waMock('receive', '+447700901900', 'for 26 inch');
    const r = await until('the reply to the burst', async () => (await waTo(jid))[0], { timeout: 60_000 });
    await sleep(8000);
    const sent = await waTo(jid);
    assert.equal(sent.length, 1, `one reply for three quick messages (${JSON.stringify(sent.map((s) => s.text))})`);
    assert.equal(sent[0].text, 'Mock reply to: for 26 inch', 'the reply was decided on the whole burst');
    const stored = await sql(`SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_thread_id = ? AND m.direction = 'in' ORDER BY m.ts`, [jid]);
    assert.deepEqual(stored.map((m) => m.body), ['hi', 'how much', 'for 26 inch'], 'all three were read before replying');
    times.push(['burst of 3 (from the last message, settle 4 s)', r.at - lastAt]);
    pass(`three quick messages, settle 4 s: one reply ${secs(r.at - lastAt)} after the last one`);
    await pacing({ settle_seconds: 2 });
  }

  // ---- 3. a newer message lands between the read and the send: answered once, in one reply --------------------
  {
    // An old server's delay (6 s from the read) holds the reply in the lane queue long enough.
    await pacing({ min_reply_delay_s: 6, max_reply_delay_s: 6 });
    await syncNow();
    const jid = '447700901800@c.us';
    await waMock('receive', '+447700901800', 'do you have the x3 in stock');
    const conv = await until('the first reply to be queued', async () => {
      const [row] = await sql(`SELECT o.id, o.status FROM outbox o JOIN conversations c ON c.id = o.conversation_id WHERE c.external_thread_id = ? ORDER BY o.created_at`, [jid]);
      return row && row.status === 'leased' ? row : null;
    }, { timeout: 30_000 });
    const newerAt = Date.now();
    await waMock('receive', '+447700901800', 'and in red?');
    const r = await until('the one reply', async () => (await waTo(jid))[0], { timeout: 60_000 });
    await sleep(9000);
    const sent = await waTo(jid);
    assert.equal(sent.length, 1, `answered once (${JSON.stringify(sent.map((s) => s.text))})`);
    assert.equal(sent[0].text, 'Mock reply to: and in red?', 'one fresh decision covered the newer message');
    const [first] = await sql('SELECT status, last_error FROM outbox WHERE id = ?', [conv.id]);
    assert.ok(['failed', 'cancelled'].includes(first.status) && /^newer_message/.test(first.last_error || ''), `the out of date reply was refused (${JSON.stringify(first)})`);
    times.push(['newer message path (from the newer message, 6 s delay)', r.at - newerAt]);
    pass(`newer message between read and send: the old reply refused (${first.status}, newer_message), one reply ${secs(r.at - newerAt)} later`);
    await pacing({ min_reply_delay_s: 0, max_reply_delay_s: 0 });
    await syncNow();
  }

  // ---- 3b. a code message is never refused for a newer message: it goes out once, after the customer wrote again ----------
  {
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:test_fake_shopify', '"created"', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [Date.now()]);
    await api('/api/settings/discounts', { method: 'PUT', body: { mode: 'auto', daily_cap: 50, one_per_customer: true } });
    await pacing({ min_reply_delay_s: 6, max_reply_delay_s: 6 }); // holds the code message in the lane queue
    await syncNow();
    const jid = '447700901850@c.us';
    await waMock('receive', '+447700901850', 'can i get my own discount code "LANE20" please');
    const code = await until('the code message to be with the laptop', async () => {
      const [row] = await sql(`SELECT o.id, o.status FROM outbox o JOIN conversations c ON c.id = o.conversation_id WHERE c.external_thread_id = ? AND o.source = 'discount'`, [jid]);
      return row && row.status === 'leased' ? row : null;
    }, { timeout: 30_000 });
    await waMock('receive', '+447700901850', 'thanks so much');
    await until('the code message in the chat', async () => (await waTo(jid)).find((x) => x.text.includes('LANE20')), { timeout: 60_000 });
    await sleep(9000);
    const sent = await waTo(jid);
    assert.equal(sent.filter((x) => x.text.includes('LANE20')).length, 1, `the code message went out exactly once (${JSON.stringify(sent.map((x) => x.text))})`);
    const [row] = await sql('SELECT status, last_error FROM outbox WHERE id = ?', [code.id]);
    assert.equal(row.status, 'sent', `the code message row ends sent (${JSON.stringify(row)})`);
    assert.equal((await sql(`SELECT COUNT(*) AS n FROM outbox o JOIN conversations c ON c.id = o.conversation_id WHERE c.external_thread_id = ? AND o.source = 'discount'`, [jid]))[0].n, 1, 'the fresh decision did not make or queue it again');
    pass('a code message queued before the customer wrote again is sent once, not refused (newer_message is for the agent\u2019s own replies)');
    await sql(`DELETE FROM settings WHERE key = 'state:test_fake_shopify'`);
    await pacing({ min_reply_delay_s: 0, max_reply_delay_s: 0 });
    await syncNow();
  }

  // ---- 4. a cut stream is read and posted again -----------------------------------------------------------------
  {
    let hits = 0;
    const handler = async (route) => {
      const body = route.request().postData() || '';
      if (!body.includes('cut-stream-check')) return route.continue();
      hits++;
      // The first report dies after the server's first line (killed invocation, dropped connection).
      if (hits === 1) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '{"type":"accepted","conversation_id":"cv_cut","new_inbound":1}\n' });
      return route.continue();
    };
    await context.route(`${base}/api/agent/inbound`, handler);
    const jid = '447700901700@c.us';
    const at = Date.now();
    await waMock('receive', '+447700901700', 'cut-stream-check is the x2 waterproof');
    const r = await until('the reply after the cut stream', async () => (await waTo(jid))[0], { timeout: 60_000 });
    await context.unroute(`${base}/api/agent/inbound`, handler);
    assert.equal(hits, 2, `posted again after the cut (${hits} reports)`);
    await sleep(3000);
    assert.equal((await waTo(jid)).length, 1, 'one reply');
    times.push(['cut stream, retried', r.at - at]);
    pass(`a stream cut before the decision is retried: replied ${secs(r.at - at)} after the message (retry after 5 s)`);
  }

  // ---- 5. three channels at once ----------------------------------------------------------------------------------
  {
    const at = Date.now();
    await waMock('receive', '+447700901600', 'three channels: whatsapp asks');
    const mail = await gm.evaluate(() => window.mock.deliver({ from: { name: 'Tess Lane', email: 'tess@example.net' }, subject: 'Range', text: 'three channels: gmail asks' }));
    await tt.evaluate(() => window.mock.receive('mia_b', 'three channels: tiktok asks'));
    const waR = await until('WhatsApp reply', async () => (await waTo('447700901600@c.us'))[0], { timeout: 90_000 });
    const gmR = await until('Gmail reply', async () => gmail.sent().find((s) => s.threadId === mail.threadId), { timeout: 90_000 });
    const ttR = await until('TikTok reply', async () => (await ttSent()).find((s) => s.text === 'Mock reply to: three channels: tiktok asks'), { timeout: 90_000 });
    assert.equal(waR.text, 'Mock reply to: three channels: whatsapp asks');
    assert.match(gmR.text, /^Mock reply to: three channels: gmail asks$/i);
    for (const [label, ms] of [['WhatsApp', waR.at - at], ['Gmail', gmR.at - at], ['TikTok', ttR.at - at]]) times.push([`three channels at once: ${label}`, ms]);
    pass(`three channels at once: WhatsApp ${secs(waR.at - at)}, Gmail ${secs(gmR.at - at)}, TikTok ${secs(ttR.at - at)}`);
  }

  // ---- 6. TikTok gaps: 1.2 s between parts, 3 s between chats ------------------------------------------------------------
  {
    const before = (await ttSent()).length;
    await tt.evaluate(() => { window.mock.receive('jake.rides', 'two-parts for jake'); window.mock.receive('mia_b', 'two-parts for mia'); });
    const four = await until('two two-part replies', async () => { const s = (await ttSent()).slice(before); return s.length >= 4 ? s : null; }, { timeout: 90_000 });
    await sleep(4000);
    const out = (await ttSent()).slice(before);
    assert.equal(out.length, 4, 'four parts in all, nothing twice');
    assert.equal(new Set(out.map((s) => s.convId)).size, 2);
    // Parts of one chat in a row, 1.2 s apart at least; the next chat 3 s after the previous one at least.
    assert.equal(out[0].convId, out[1].convId, 'a reply is never interleaved with another chat');
    assert.equal(out[2].convId, out[3].convId);
    assert.deepEqual([out[0].text, out[1].text, out[2].text, out[3].text], ['Hey', 'Mock second part', 'Hey', 'Mock second part']);
    const partGaps = [out[1].at - out[0].at, out[3].at - out[2].at];
    const chatGap = out[2].at - out[1].at;
    assert.ok(partGaps.every((g) => g >= 1150), `parts at least 1.2 s apart (${partGaps.join(', ')} ms)`);
    assert.ok(chatGap >= 2950, `chats at least 3 s apart (${chatGap} ms)`);
    pass(`TikTok gaps kept: parts ${partGaps.map(secs).join(' and ')}, next chat ${secs(chatGap)}`);
  }

  // ---- 7. one lane never blocks another: Gmail frozen, WhatsApp and TikTok still answer -----------------------------------------
  {
    const cdp = await context.newCDPSession(gm);
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.pause'); // every Gmail operation now times out, as with a frozen tab
    await sleep(1500);
    const at = Date.now();
    await waMock('receive', '+447700901500', 'gmail is frozen, still there?');
    await tt.evaluate(() => window.mock.receive('jake.rides', 'tiktok while gmail is frozen'));
    const waR = await until('WhatsApp reply with Gmail frozen', async () => (await waTo('447700901500@c.us'))[0], { timeout: 60_000 });
    const ttR = await until('TikTok reply with Gmail frozen', async () => (await ttSent()).find((s) => s.text === 'Mock reply to: tiktok while gmail is frozen'), { timeout: 60_000 });
    times.push(['WhatsApp with the Gmail tab frozen', waR.at - at], ['TikTok with the Gmail tab frozen', ttR.at - at]);
    assert.ok(waR.at - at < 30_000, `WhatsApp did not wait for Gmail (${secs(waR.at - at)})`);
    await cdp.send('Debugger.resume');
    await cdp.detach();
    const mail = await gm.evaluate(() => window.mock.deliver({ from: { name: 'Ola Fern', email: 'ola@example.net' }, subject: 'After', text: 'gmail works again' }));
    await until('Gmail answers again after the freeze', async () => gmail.sent().find((s) => s.threadId === mail.threadId), { timeout: 90_000, poke: true });
    pass(`Gmail frozen: WhatsApp answered in ${secs(waR.at - at)}, TikTok in ${secs(ttR.at - at)}; Gmail answers again after`);
  }

  // ---- 8. TikTok Business Suite: the lane brings its tab back to the business view of /messages --------------------------------
  {
    await tt.goto('https://www.tiktok.com/business-suite/messages?from=homepage&lang=en&u=1');
    await until('the tab back on the messages page', async () => /\/messages\?.*scene=business/.test(tt.url()), { timeout: 60_000, poke: true });
    await tt.waitForFunction(() => window.mock && window.mock.ready, null, { timeout: 30_000 });
    const remembered = await sw.evaluate(() => chrome.storage.local.get('tiktok_business').then((r) => r.tiktok_business));
    assert.equal(remembered, true, 'the account is remembered as a business account');
    await until('TikTok ready again', async () => (await channelState('tiktok')) === 'ready', { poke: true });
    const before = (await ttSent()).length;
    await tt.evaluate(() => window.mock.receive('mia_b', 'hello from business view'));
    await until('reply in the business view', async () => (await ttSent()).slice(before).find((s) => s.text === 'Mock reply to: hello from business view'), { timeout: 60_000 });
    pass(`TikTok tab found in Business Suite was sent back to ${new URL(tt.url()).pathname}${new URL(tt.url()).search} and answers there`);
  }

  // ---- final checks ---------------------------------------------------------------------------------------------------------
  const waAll = (await waSent()).map((s) => `${s.jid}|${s.text}`);
  assert.equal(new Set(waAll).size, waAll.length, `no WhatsApp message sent twice: ${JSON.stringify(waAll)}`);
  assert.ok((await waSent()).every((s) => !s.jid.endsWith('@g.us')), 'nothing went to a group');
  const ttAll = (await ttSent()).map((s) => `${s.convId}|${s.text}|${Math.round(s.at / 1000)}`);
  assert.equal(new Set(ttAll).size, ttAll.length, 'no TikTok message sent twice');
  const mails = gmail.sent().map((s) => `${s.threadId}|${s.text}`);
  assert.equal(new Set(mails).size, mails.length, 'no email sent twice');
  const errs = await sql(`SELECT channel, kind, substr(data, 1, 300) AS data FROM diagnostics WHERE kind IN ('error', 'selector_miss')`);
  assert.deepEqual(errs, [], 'no adapter errors or selector misses');
  assert.deepEqual(pageErrors, [], 'no errors on the pages');

  // ---- 9. the owner's own Business Suite tab is never taken over: the agent opens its own pinned tab ----------------------
  {
    const owner = await context.newPage();
    await owner.goto('https://www.tiktok.com/business-suite/messages?from=homepage&lang=en&u=1');
    await tt.close(); // no messages tab left: only the owner's Business Suite tab
    await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: true }));
    const ownTab = await until('the agent to open its own pinned messages tab', async () => {
      const tabs = await sw.evaluate(() => chrome.tabs.query({ url: 'https://www.tiktok.com/messages*' }).then((ts) => ts.map((t) => ({ id: t.id, pinned: t.pinned, url: t.url || t.pendingUrl }))));
      return tabs.find((t) => t.pinned) || null;
    }, { timeout: 60_000, poke: true });
    for (let i = 0; i < 4; i++) { await kick(); await sleep(1500); }
    assert.match(owner.url(), /\/business-suite\//, `the owner's Business Suite tab stays where it is (${owner.url()})`);
    await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false }));
    pass(`the owner's own Business Suite tab was left alone; the agent opened its own pinned tab (${new URL(ownTab.url).pathname})`);
  }

  console.log('\nReply times (message shown in the tab to reply sent):');
  for (const [label, ms] of times) console.log(`  ${label.padEnd(58)} ${secs(ms)}`);
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
  try { if (context) await context.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }
  for (const dir of tmp) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.exit(code);
