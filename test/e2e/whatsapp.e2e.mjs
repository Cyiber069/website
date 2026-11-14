// End to end test of the WhatsApp adapter: real backend (wrangler dev, mock brain), real Chromium
// with the unpacked extension, and a mock of WhatsApp Web served under https://web.whatsapp.com/.
//
//   node test/e2e/whatsapp.e2e.mjs            exit code 0 = everything passed
//   HEADED=1 node test/e2e/whatsapp.e2e.mjs   watch it happen
//
// The mock page lives in test/e2e/mocks/whatsapp (rebuild its bundle with build.mjs after editing).
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // pre-installed on the machine, not a dependency of the repo

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const MOCK = join(here, 'mocks', 'whatsapp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
const pass = (msg) => log(`PASS  ${msg}`);

let server;
let context;
let workDir;
let cookie = '';

/** Call the backend as the owner (session cookie + same-origin header). */
async function api(path, { method, body } = {}) {
  const headers = { cookie, origin: server.url };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return data;
}
const sql = async (query, params = []) => (await api('/api/test/sql', { body: { sql: query, params } })).results;

async function main() {
  // ---- backend ----------------------------------------------------------------------------------
  server = await startServer();
  const setup = await fetch(`${server.url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(setup.status, 200, 'owner setup');
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
  await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 1, min_reply_delay_s: 0, max_reply_delay_s: 0 } });
  const { pairing_string: pairing } = await api('/api/devices/pair-code', { body: {} });
  log(`backend up at ${server.url}`);

  // ---- browser with the extension -----------------------------------------------------------------
  // Work on a copy so a content script another adapter has not delivered yet cannot stop the load.
  workDir = mkdtempSync(join(tmpdir(), 'acx-wa-e2e-'));
  const ext = join(workDir, 'extension');
  cpSync(join(root, 'extension'), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts) for (const f of cs.js) if (!existsSync(join(ext, f))) writeFileSync(join(ext, f), '// not built yet\n');

  context = await chromium.launchPersistentContext(join(workDir, 'profile'), {
    channel: 'chromium', // full Chromium: the default headless shell cannot load extensions
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await context.route('https://web.whatsapp.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app.bundle.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(MOCK, 'app.bundle.js')) });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: readFileSync(join(MOCK, 'index.html')) });
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;
  // Only WhatsApp is under test: do not let the worker open Gmail and TikTok tabs.
  await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false }));

  const wa = await context.newPage();
  const pageErrors = [];
  wa.on('pageerror', (e) => pageErrors.push(String(e)));
  await wa.goto('https://web.whatsapp.com/');
  await wa.waitForFunction(() => document.body.dataset.mockReady === '1');

  // ---- pair through the real popup ---------------------------------------------------------------------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#pairing', pairing);
  await popup.fill('#device-name', 'E2E laptop');
  await popup.click('#pair-btn');
  await popup.waitForSelector('#main-view:not([hidden])', { timeout: 15_000 });
  pass('paired through the popup');

  // ---- helpers -------------------------------------------------------------------------------------------
  const mock = (fn, ...args) => wa.evaluate(([f, a]) => window.mock[f](...a), [fn, args]);
  const kick = () => popup.evaluate(() => chrome.runtime.sendMessage({ acx: true, type: 'tick' })).catch(() => {});
  /** Wait for `fn` to return something truthy. Keeps the worker cycling so the test does not wait for poll timers. */
  async function until(what, fn, { timeout = 60_000, every = 500 } = {}) {
    const end = Date.now() + timeout;
    let lastKick = 0;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) {
        const outbox = await sql('SELECT id, kind, status, last_error, parts FROM outbox ORDER BY created_at DESC LIMIT 5').catch(() => []);
        const diags = await sql('SELECT kind, data FROM diagnostics ORDER BY created_at DESC LIMIT 5').catch(() => []);
        throw new Error(`timed out waiting for: ${what}\n  sent: ${JSON.stringify(await mock('sent').catch(() => '?'))}\n  outbox: ${JSON.stringify(outbox)}\n  diagnostics: ${JSON.stringify(diags).slice(0, 1500)}`);
      }
      if (Date.now() - lastKick > 1500) { lastKick = Date.now(); await kick(); }
      await sleep(every);
    }
  }
  const sentTo = async (jid) => (await mock('sent')).filter((s) => s.jid === jid);
  const channelState = async () => (await api('/api/overview')).device?.status?.channels?.whatsapp?.state;
  const conversation = async (threadId) => (await sql(
    `SELECT cv.id, cv.external_thread_id, ct.phone, ct.display_name FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.channel = 'whatsapp' AND cv.external_thread_id = ?`, [threadId]))[0];
  const messagesOf = (convId) => sql('SELECT direction, body, kind, external_id FROM messages WHERE conversation_id = ? ORDER BY ts, created_at', [convId]);
  const jobSettled = (id) => until(`job ${id} to be reported`, async () => { const r = (await sql('SELECT status, last_error, sent_at FROM outbox WHERE id = ?', [id]))[0]; return r && (r.status === 'sent' || r.status === 'failed') ? r : null; });

  const JAKE = '447700900123@c.us';
  const LENA = '93497327620330@lid';
  const UNSAVED = '447700900456@c.us';
  const GROUP = '120363041234567890@g.us';

  await until('WhatsApp to be reported ready', async () => (await channelState()) === 'ready');
  pass('ready state reported in /api/overview');

  // ---- 1. a customer message gets a typed reply in the right chat ----------------------------------------------
  const longText = `long one 🚲 ${'I have been looking at the range for a while and want to be sure before I order. '.repeat(5)}thanks`;
  await mock('receive', 'Jake', '', { kind: 'voice' });
  await mock('receive', 'Jake', 'this is the bike', { kind: 'image' });
  await mock('receive', 'Jake', 'that one yes', { quoted: 'yes mate plenty in stock' });
  await mock('receive', 'Jake', longText);
  const t0 = Date.now();
  await mock('receive', 'Jake', 'yo how long is delivery');
  const first = (await until('reply to Jake', async () => (await sentTo(JAKE))[0]));
  assert.equal(first.text, 'mock reply to: yo how long is delivery');
  assert.equal(first.title, 'Jake');
  const took = first.at - t0;
  assert.ok(took >= 700, `the reply was typed at a human pace (took ${took} ms)`);
  assert.ok(took <= 45_000, `the reply arrived within the pacing limits (took ${took} ms)`);
  await sleep(1500);
  assert.equal((await sentTo(JAKE)).length, 1, 'exactly one reply');
  pass(`customer message answered in the right chat after ${(took / 1000).toFixed(1)} s`);

  const jake = await until('Jake conversation on the server', () => conversation(JAKE));
  assert.equal(jake.phone, '+447700900123');
  assert.equal(jake.display_name, 'Jake');
  const stored = await until('the sent reply to be recorded', async () => { const m = await messagesOf(jake.id); return m.some((x) => x.direction === 'out' && x.body === first.text) ? m : null; });
  const kinds = stored.map((m) => `${m.direction}:${m.kind}`);
  assert.ok(kinds.includes('in:voice'), 'voice note stored as a voice message');
  const image = stored.find((m) => m.kind === 'image');
  assert.equal(image?.body, 'this is the bike', 'image caption read');
  assert.ok(stored.some((m) => m.body === 'that one yes'), 'a reply is read without the quoted text');
  assert.ok(stored.some((m) => m.body === longText), 'long message read in full, emoji included');
  assert.ok(stored.filter((m) => m.external_id).every((m) => /^(true|false)_447700900123@c\.us_[0-9A-Z]+$/.test(m.external_id)), 'message ids are the full data-id');
  assert.ok(stored.find((m) => m.body === first.text).external_id.startsWith('true_'), 'the sent message id was reported');
  pass('thread read correctly: ids, phone, voice note, caption, quoted reply, long text');

  // ---- self test: types and clears, never sends ---------------------------------------------------------------------
  const selftest = await popup.evaluate(() => chrome.runtime.sendMessage({ acx: true, type: 'selftest' }));
  const checks = selftest.results.whatsapp.data?.checks ?? [];
  assert.ok(checks.length >= 12, `self test ran (${JSON.stringify(selftest.results.whatsapp).slice(0, 300)})`);
  assert.deepEqual(checks.filter((c) => !c.ok), [], 'every self test check passes');
  assert.match(checks.find((c) => c.name === 'typing').detail, /method: (paste|exec|beforeinput)/);
  assert.equal((await mock('chats')).find((c) => c.open).draft, '', 'self test left the message box empty');
  assert.equal((await sentTo(JAKE)).length, 1, 'self test sent nothing');
  pass(`self test: ${checks.length} checks ok, typing ${checks.find((c) => c.name === 'typing').detail}`);

  // ---- 2. two part reply, in order, in a chat with a hidden (LID) id ----------------------------------------------------
  await mock('receive', 'Riders Club', 'two-parts for everyone', { author: 'Sam' });
  await mock('receive', 'Lena', 'two-parts please');
  const two = await until('two part reply to Lena', async () => { const s = await sentTo(LENA); return s.length >= 2 ? s : null; });
  assert.deepEqual(two.map((s) => s.text), ['hey', 'mock second part']);
  assert.ok(two[1].at > two[0].at, 'parts arrive in order');
  const lena = await until('Lena conversation on the server', () => conversation(LENA));
  assert.equal(lena.phone, null, 'no phone is invented for a hidden id');
  pass('two part reply arrives as two messages in order (LID chat)');

  // ---- 3. a "what's new" dialog is closed, unsaved number gets its phone from the title -----------------------------------
  await mock('showDialog', 'whatsnew');
  await mock('receive', '+44 7700 900456', 'do you have the x2');
  const third = await until('reply to the unsaved number', async () => (await sentTo(UNSAVED))[0]);
  assert.equal(third.text, 'mock reply to: do you have the x2');
  const st3 = await mock('state');
  assert.equal(st3.dialog, null, 'the dialog was closed');
  assert.equal(st3.continueClicked, 0, 'never pressed Continue on an unknown dialog');
  const unsaved = await until('unsaved conversation on the server', () => conversation(UNSAVED));
  assert.equal(unsaved.phone, '+447700900456');
  pass('blocking dialog closed through its Close button; unsaved contact identified by number');

  // ---- 4. escalation: holding line, Urgent card, owner answer typed into the chat ---------------------------------------------
  await mock('receive', 'Jake', 'unknown-question about the frame');
  await until('holding line to Jake', async () => (await sentTo(JAKE)).find((s) => s.text === 'good question let me check that for you'));
  const card = await until('Urgent card', async () => (await api('/api/urgent')).urgent.find((u) => u.conversation_id === jake.id && String(u.question).includes('unknown-question')));
  await api(`/api/urgent/${card.id}/answer`, { body: { answer: 'fits any 135mm dropout', learn: false } });
  await until('owner answer typed into the chat', async () => (await sentTo(JAKE)).find((s) => s.text === 'polished: fits any 135mm dropout'));
  assert.deepEqual((await sentTo(JAKE)).map((s) => s.text), ['mock reply to: yo how long is delivery', 'good question let me check that for you', 'polished: fits any 135mm dropout']);
  pass('escalated question appears in /api/urgent and the owner answer is typed into the chat');

  // ---- 5. never types over someone's draft ------------------------------------------------------------------------------------
  await mock('setDraft', 'Lena', 'half typed by the owner');
  await mock('receive', 'Lena', 'what colours do you have');
  const busy = await until('the job to fail with composer_busy', async () => (await sql(`SELECT id, status, last_error FROM outbox WHERE last_error LIKE 'composer_busy%'`))[0]);
  assert.equal(busy.status, 'pending', 'a busy message box is retried later');
  assert.equal((await sentTo(LENA)).length, 2, 'nothing was sent while the draft was there');
  assert.equal((await mock('chats')).find((c) => c.jid === LENA).draft, 'half typed by the owner', 'the draft is untouched');
  await mock('setDraft', 'Lena', '');
  await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [busy.id]);
  await until('reply to Lena once the draft is gone', async () => (await sentTo(LENA)).find((s) => s.text === 'mock reply to: what colours do you have'));
  pass('composer with a draft is left alone (composer_busy), reply goes out once it is free');

  // ---- 6. groups are ignored ------------------------------------------------------------------------------------------------------
  assert.equal((await sentTo(GROUP)).length, 0, 'nothing sent to the group');
  assert.equal((await sql(`SELECT COUNT(*) AS n FROM outbox WHERE target LIKE '%@g.us%'`))[0].n, 0, 'no job was ever queued for the group');
  pass('group chat ignored');

  // ---- 7. the same job delivered again is not sent twice --------------------------------------------------------------------------
  const job = (await sql(`SELECT id, sent_at FROM outbox WHERE status = 'sent' AND target LIKE ? ORDER BY sent_at DESC LIMIT 1`, [`%${UNSAVED}%`]))[0];
  const redeliver = async () => {
    await sql(`UPDATE outbox SET status = 'pending', not_before = 0, lease_until = NULL, attempts = 0, sent_at = NULL WHERE id = ?`, [job.id]);
    const again = await jobSettled(job.id);
    assert.equal(again.status, 'sent');
    await sleep(1200);
    assert.equal((await sentTo(UNSAVED)).length, 1, 'still exactly one message in the chat');
  };
  await redeliver(); // the worker remembers finished job ids
  await sw.evaluate(() => chrome.storage.local.set({ done_jobs: [] }));
  await redeliver(); // even with that memory gone, the adapter sees the text is already the last outgoing message
  pass('a job delivered again is confirmed without sending twice (worker memory and adapter check)');

  // ---- 8. new chat by phone number ------------------------------------------------------------------------------------------------------
  const newChat = async (id, phone, text) => sql(
    `INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, ref_id, not_before, expires_at, dedupe_key, pacing, created_at)
     VALUES (?, 'whatsapp', 'new_chat', NULL, ?, ?, 'pending', 'recovery', NULL, 0, NULL, NULL, ?, ?)`,
    [id, JSON.stringify({ thread_external_id: null, title: 'Mia', phone, email: null, handle: null, subject: null }), JSON.stringify([text]), JSON.stringify({ delay_ms: 0, typing_cps: 30 }), Date.now()]);
  await newChat('ob_e2e_new', '+447700900999', 'hi Mia you left an x1 in your basket, want the link?');
  const viaLink = await until('first contact message', async () => (await sentTo('447700900999@c.us'))[0], { timeout: 90_000 });
  assert.equal(viaLink.text, 'hi Mia you left an x1 in your basket, want the link?');
  assert.equal(viaLink.title, '+44 7700 900999');
  assert.equal((await jobSettled('ob_e2e_new')).status, 'sent');
  assert.ok(await conversation('447700900999@c.us'), 'the new chat is filed as a conversation');
  pass('new_chat job navigates to the number and sends');

  await newChat('ob_e2e_bad', '+447700000000', 'hello there');
  const bad = await until('invalid number job to fail', async () => (await sql(`SELECT status, last_error FROM outbox WHERE id = 'ob_e2e_bad' AND status = 'failed'`))[0], { timeout: 90_000 });
  assert.match(bad.last_error, /^not_on_whatsapp/);
  assert.equal((await mock('sent')).filter((s) => s.text === 'hello there').length, 0, 'nothing sent for the invalid number');
  await until('invalid number dialog to be dismissed', async () => (await mock('state')).dialog === null);
  pass('invalid number fails with not_on_whatsapp, nothing sent');

  await mock('set', { restricted: true });
  await newChat('ob_e2e_restricted', '+447700900998', 'hello again');
  const restricted = await until('restricted job to fail', async () => (await sql(`SELECT status, last_error FROM outbox WHERE id = 'ob_e2e_restricted' AND status = 'failed'`))[0], { timeout: 90_000 });
  assert.match(restricted.last_error, /^blocked/);
  await until('restriction notice to show as blocked', async () => (await channelState()) === 'blocked');
  await mock('set', { restricted: false, dialog: null });
  pass('restriction notice fails the job as blocked and is reported');

  // ---- 9. logged out and "open in another window" are reported -----------------------------------------------------------------------------
  await mock('set', { mode: 'qr' });
  await until('logged_out in /api/overview', async () => (await channelState()) === 'logged_out');
  await mock('set', { mode: 'conflict' });
  await until('blocked in /api/overview', async () => (await channelState()) === 'blocked');
  await mock('set', { mode: 'main' });
  await until('ready again', async () => (await channelState()) === 'ready');
  pass('logged out (QR) and conflict states reported in /api/overview');

  // ---- 10. builds with bare message ids: identity through the bridge, then through IndexedDB ------------------------------------------------
  await mock('set', { idForm: 'bare', bridge: true });
  await mock('receive', '11122233344455@lid', 'hi from a hidden id', { title: 'Nora', phone: '447700900777' });
  await until('reply to Nora', async () => (await sentTo('11122233344455@lid')).find((s) => s.text === 'mock reply to: hi from a hidden id'));
  const nora = await until('Nora conversation', () => conversation('11122233344455@lid'));
  assert.equal(nora.phone, '+447700900777', 'phone behind the hidden id comes from the bridge');
  const noraMsgs = await until('Nora messages recorded', async () => { const m = await messagesOf(nora.id); return m.length >= 2 ? m : null; });
  assert.ok(noraMsgs.every((m) => /^[0-9A-Z]{16,}$/.test(m.external_id || '')), 'bare ids are reported as they are');
  assert.deepEqual(noraMsgs.map((m) => m.direction), ['in', 'out']);
  pass('bare id build: chat id and phone resolved through the read only bridge');

  await mock('set', { bridge: false });
  await mock('receive', '22233344455566@lid', 'hello without a bridge', { title: 'Omar', phone: '447700900888' });
  await until('reply to Omar', async () => (await sentTo('22233344455566@lid')).find((s) => s.text === 'mock reply to: hello without a bridge'));
  const omar = await until('Omar conversation', () => conversation('22233344455566@lid'));
  assert.equal(omar.phone, '+447700900888', 'phone comes from the contact store');
  pass('bare id build without the bridge: chat id resolved from IndexedDB');

  // ---- final sweep ---------------------------------------------------------------------------------------------------------------
  await sleep(2500);
  const all = await mock('sent');
  const keys = all.map((s) => `${s.jid}|${s.text}`);
  assert.equal(new Set(keys).size, keys.length, `no message was sent twice: ${JSON.stringify(keys)}`);
  assert.ok(all.every((s) => !s.jid.endsWith('@g.us')), 'nothing ever went to a group');
  assert.ok(all.every((s) => s.trusted === false), 'everything was sent by clicking the Send button from the content script');
  const diags = await sql(`SELECT kind, data FROM diagnostics WHERE channel = 'whatsapp' AND kind IN ('error', 'dom_snapshot', 'selector_miss')`);
  assert.deepEqual(diags, [], 'no selector misses, snapshots or errors were reported');
  assert.deepEqual(pageErrors, [], 'no errors on the page');
  pass(`${all.length} messages sent in total, none twice, no diagnostics`);
}

let failed = false;
try {
  await main();
  log('ALL PASSED');
} catch (err) {
  failed = true;
  console.error(`\nFAIL  ${err?.stack || err}`);
  if (server && process.env.SERVER_LOG) console.error(server.logs().slice(-4000));
} finally {
  try { if (context) await context.close(); } catch { /* already gone */ }
  try { if (server) await server.stop(); } catch { /* already gone */ }
  try { if (workDir) rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(failed ? 1 : 0);
