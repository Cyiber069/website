// End to end test of the TikTok adapter:  node test/e2e/tiktok.e2e.mjs   (exit code 0 = pass)
//
// Real pieces: the Worker (wrangler dev, test config, mock brain), the unpacked extension in Chromium
// (service worker, popup, core.js, tiktok.js) and the real Draft.js editor inside the mock page.
// Faked: https://www.tiktok.com itself, served from test/e2e/mocks/tiktok/index.html through
// context.route, so the content script runs on the real host name and nothing reaches the network.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // pre-installed, found through NODE_PATH

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const MOCK_HTML = readFileSync(join(here, 'mocks', 'tiktok', 'index.html'), 'utf8');
const TIKTOK_URL = 'https://www.tiktok.com/messages?lang=en';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let step = 0;
const pass = (what) => log(`PASS ${String(++step).padStart(2)} ${what}`);

/** Copy of the extension. Files other adapters have not written yet are stubbed so Chrome loads it. */
function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'acx-ext-'));
  cpSync(join(root, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts) {
    for (const file of cs.js) {
      const p = join(dir, file);
      if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '// stub for the TikTok end to end test\n'); }
    }
  }
  // Same for icons: a 1x1 PNG stands in for any that is not drawn yet.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (const file of [...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})]) {
    const p = join(dir, file);
    if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, png); }
  }
  return dir;
}

let server;
let context;
const tmp = [];

async function main() {
  // ---- backend: owner account, fast pacing, pairing code --------------------------------------
  server = await startServer();
  const base = server.url;
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(setup.status, 200, 'owner setup');
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];

  const owner = async (path, { method, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body !== undefined ? 'POST' : 'GET'),
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    assert.ok(res.ok, `${method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return data;
  };
  const sql = async (query, params = []) => {
    const res = await fetch(`${base}/api/test/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: query, params }) });
    return (await res.json()).results;
  };

  await owner('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 1, min_reply_delay_s: 0, max_reply_delay_s: 0, typing_cps: 80 } });
  const { pairing_string } = await owner('/api/devices/pair-code', { body: {} });

  // ---- browser with the unpacked extension -----------------------------------------------------
  const extDir = stageExtension();
  const profile = mkdtempSync(join(tmpdir(), 'acx-pw-'));
  tmp.push(extDir, profile);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', // full Chromium in new headless mode: the headless shell cannot run extensions
    headless: true,
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  await context.route('https://www.tiktok.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: path.startsWith('/messages') ? MOCK_HTML : '<!doctype html><title>TikTok (mock)</title>' });
  });
  for (const host of ['https://web.whatsapp.com/**', 'https://mail.google.com/**']) {
    await context.route(host, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mock</title>' }));
  }
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;

  // The seeded chats carry the current time, and on its first look the adapter answers chats from the
  // last 10 minutes whose customer wrote last (Leo). This test starts from a quiet inbox instead: the
  // seed is saved with times from two hours ago before the extension is paired.
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

  // ---- pair through the real popup ---------------------------------------------------------------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false })); // the test opens the tab itself
  await popup.fill('#pairing', pairing_string);
  await popup.fill('#device-name', 'E2E laptop');
  await popup.click('#pair-btn');
  await popup.waitForSelector('#main-view:not([hidden])', { timeout: 20_000 });
  pass(`paired through the popup (extension ${extensionId})`);

  /** Run the service worker's cycle now instead of waiting for its timer. */
  const kick = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'tick' }, () => { void chrome.runtime.lastError; r(); })));
  /** Call the adapter directly, the same way the service worker does. */
  const op = (name, args = {}) => popup.evaluate(async ({ name, args }) => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.tiktok.com/messages*' });
    if (!tab) return { ok: false, error_code: 'tab_missing' };
    try { return await chrome.tabs.sendMessage(tab.id, { acx: true, op: name, args }); } catch (e) { return { ok: false, error_code: 'no_content_script', error: String(e) }; }
  }, { name, args });
  /** Poll until `fn` returns something truthy, nudging the extension along. */
  const until = async (label, fn, timeout = 90_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
      await kick();
      await sleep(600);
    }
  };

  const page = await context.newPage();
  await page.goto(TIKTOK_URL);
  await page.waitForFunction(() => window.mock && window.mock.ready);
  const mock = (fn, arg) => page.evaluate(fn, arg);
  const sent = () => mock(() => window.mock.sent());
  const tiktokStatus = async () => (await owner('/api/overview')).device?.status?.channels?.tiktok;
  const idOf = (who) => mock((w) => window.mock.conv(w).id, who);
  const jakeId = await idOf('jake.rides');
  const miaId = await idOf('mia_b');
  const leoId = await idOf('leo.media');

  const ready = await until('tiktok ready in /api/overview', async () => { const s = await tiktokStatus(); return s?.state === 'ready' ? s : null; });
  assert.match(ready.detail, /sdk/, 'probe detail names the front end variant');
  pass(`probe: ready, "${ready.detail}"`);

  // ---- review mode (default): a DM becomes a draft, approving sends it ----------------------------
  await mock(() => window.mock.receive('jake.rides', 'yo how long is delivery'));
  const draft = await until('draft in the review list', async () => (await owner('/api/urgent')).review.find((r) => r.channel === 'tiktok'));
  assert.equal(draft.customer, 'Jake');
  assert.equal(draft.customer_message, 'yo how long is delivery');
  assert.match(draft.parts[0], /mock reply to: yo how long is delivery/);
  const [convRow] = await sql('SELECT cv.external_thread_id, ct.handle, ct.display_name FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = ?', [draft.conversation_id]);
  assert.equal(convRow.external_thread_id, jakeId, 'thread id is the TikTok conversation id');
  assert.equal(convRow.handle, 'jake.rides');
  // The chat is now open with the customer's message last: it is read again, which must not draft twice or send.
  for (let i = 0; i < 6; i++) { await kick(); await sleep(600); }
  assert.equal((await owner('/api/urgent')).review.filter((r) => r.channel === 'tiktok').length, 1, 'one draft only');
  assert.equal((await sent()).length, 0, 'nothing is sent before the owner approves');
  pass('review mode: DM produced one draft, nothing sent');

  await owner(`/api/review/${draft.id}/approve`, { body: {} });
  await until('approved reply sent', async () => (await sent()).length === 1);
  let out = await sent();
  assert.equal(out[0].convId, jakeId, 'sent in the right conversation');
  assert.equal(out[0].text, draft.parts[0]);
  await until('job marked sent', async () => (await sql('SELECT status FROM outbox WHERE id = ?', [draft.id]))[0]?.status === 'sent');
  assert.equal(await mock(() => window.mock.composerText()), '', 'message box is empty after sending');
  const jakeLast = (await mock(() => window.mock.conv('jake.rides'))).messages.at(-1);
  const [stored] = await sql(`SELECT external_id FROM messages WHERE outbox_id = ?`, [draft.id]);
  assert.equal(stored.external_id, jakeLast.serverId, 'the TikTok message id was reported back');
  pass(`approved draft pasted and sent to Jake (via ${out[0].via}), id ${stored.external_id}`);

  // ---- the same job delivered again: nothing is sent twice ---------------------------------------
  const [jobRow] = await sql('SELECT target, parts FROM outbox WHERE id = ?', [draft.id]);
  const job = { id: draft.id, channel: 'tiktok', kind: 'reply', source: 'review', target: JSON.parse(jobRow.target), parts: JSON.parse(jobRow.parts), pacing: { delay_ms: 0, typing_cps: 80 } };
  const again = await op('send', { job });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.data.sent_external_ids, [jakeLast.serverId]);
  assert.equal((await sent()).length, 1, 'redelivery in the same page did not send again');
  await page.reload();
  await page.waitForFunction(() => window.mock && window.mock.ready);
  const afterReload = await until('adapter answers after reload', async () => { const r = await op('send', { job: { ...job, id: 'ob_other_id' } }); return r.error_code === 'no_content_script' || /not ready/i.test(r.error || '') ? null : r; });
  assert.equal(afterReload.ok, true, JSON.stringify(afterReload));
  assert.equal((await sent()).length, 1, 'redelivery after a reload (judged from the chat itself) did not send again');
  pass('job delivered again twice: still exactly one message');

  // ---- auto mode -------------------------------------------------------------------------------------
  await owner('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
  await mock(() => window.mock.receive('mia_b', 'ok')); // Mia's chat is closed: found through the unread badge
  await until('auto reply to Mia', async () => (await sent()).length === 2);
  out = await sent();
  assert.equal(out[1].convId, miaId);
  assert.match(out[1].text, /mock reply to: ok/);
  pass('auto mode: new DM answered automatically');

  await sleep(500);
  await mock(() => window.mock.receive('mia_b', 'ok')); // same text again, chat now open (no badge)
  await until('second identical message answered', async () => (await sent()).length === 3);
  assert.equal((await sent())[2].convId, miaId);

  await mock(() => window.mock.receive('jake.rides', 'two-parts please'));
  await until('two part reply', async () => (await sent()).length === 5);
  out = await sent();
  assert.deepEqual(out.slice(3).map((s) => [s.convId, s.text]), [[jakeId, 'hey'], [jakeId, 'mock second part']]);
  assert.ok(out[4].at - out[3].at >= 1900, `parts are spaced out (${out[4].at - out[3].at} ms)`);
  pass('two part reply sent in order with a pause between the parts');

  await mock(() => window.mock.receive('mia_b', 'ok')); // third time, chat closed again, same preview as the first
  await until('third identical message answered', async () => (await sent()).length === 6);
  assert.equal((await sent())[5].convId, miaId);
  await until('all jobs recorded', async () => (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'tiktok' AND status = 'sent'`))[0].n === 5);
  const miaMsgs = await sql(`SELECT m.direction, m.body, m.status FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_thread_id = ? ORDER BY m.ts, m.created_at`, [miaId]);
  assert.equal(miaMsgs.filter((m) => m.direction === 'in' && m.body === 'ok').length, 3, 'three identical customer messages stored as three');
  assert.equal(miaMsgs.filter((m) => m.direction === 'out' && /mock reply to: ok/.test(m.body)).length, 3, 'each one got its own reply');
  pass('the same text sent again counts as a new message (closed chat, open chat, closed chat)');

  // ---- reading: kinds, directions, ids ------------------------------------------------------------------
  const leo = await op('read', { key: `dm|id|${leoId}` });
  assert.equal(leo.ok, true, JSON.stringify(leo));
  assert.deepEqual(leo.data.thread, { external_id: leoId, title: 'Leo', is_group: false, subject: null, contact: { name: 'Leo', phone: null, email: null, handle: 'leo.media' } });
  assert.deepEqual(leo.data.messages.map((m) => [m.direction, m.kind, m.body]), [
    ['in', 'text', 'look at this 😂 lol'],
    ['in', 'video', ''],
    ['in', 'sticker', ''],
    ['in', 'image', ''],
    ['in', 'video', ''],
    ['in', 'other', "[This message type isn't supported]"],
    ['out', 'text', 'nice one'], // the recalled notice and our failed bubble are left out
    ['in', 'text', 'line one\nline two'],
  ]);
  assert.ok(leo.data.messages.every((m) => /^\d+$/.test(m.external_id) && m.ts === null), 'message ids come from the page, no timestamps');
  pass('read: text, emoji, shared video, sticker, image, video, unsupported; direction from layout; ids');
  // Leo's chat is now open with his message last, so the agent picks it up and answers (multi line inbound).
  await until('reply to Leo', async () => (await sent()).length === 7);
  assert.equal((await sent())[6].convId, leoId);
  await until('Leo job recorded', async () => (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'tiktok' AND status = 'sent'`))[0].n === 6);

  const scan = await op('scan');
  assert.equal(scan.ok, true, JSON.stringify(scan));
  const group = scan.data.threads.find((t) => t.title === 'Ride crew');
  assert.ok(group && group.is_group === true && group.unread === 2, 'group chats are flagged so they are skipped');
  pass('scan: group conversation flagged as group');

  // ---- selftest: audit plus type-then-clear, never sends -------------------------------------------------
  const test = await op('selftest');
  assert.equal(test.ok, true, JSON.stringify(test));
  const bad = test.data.checks.filter((c) => !c.ok);
  assert.deepEqual(bad, [], 'selftest checks');
  assert.ok(test.data.checks.some((c) => c.name === 'Typing' && c.detail === 'paste'), 'typing used paste');
  assert.ok(test.data.checks.some((c) => c.name === 'Layout' && /^sdk; flags sdk=v4/.test(c.detail)));
  assert.equal(await mock(() => window.mock.composerText()), '', 'selftest left the message box empty');
  assert.equal(await page.locator('[data-e2e="dm-new-send-btn"]').count(), 0);
  assert.equal((await sent()).length, 7, 'selftest sent nothing');
  pass(`selftest: ${test.data.checks.length} checks ok, typed and cleared without sending`);

  // ---- refusals --------------------------------------------------------------------------------------------
  const fake = (over = {}) => ({ id: `ob_fake_${Math.random().toString(36).slice(2)}`, channel: 'tiktok', kind: 'reply', source: 'manual', target: { thread_external_id: jakeId, title: 'Jake', handle: 'jake.rides' }, parts: ['should never be sent'], pacing: { delay_ms: 0, typing_cps: 80 }, ...over });
  await mock(() => window.mock.open('jake.rides'));
  await page.click('.public-DraftEditor-content');
  await page.keyboard.type('half typed');
  assert.equal(await mock(() => window.mock.composerText()), 'half typed');
  const busy = await op('send', { job: fake() });
  assert.deepEqual([busy.ok, busy.error_code, busy.retryable], [false, 'composer_busy', true], JSON.stringify(busy));
  assert.equal(await mock(() => window.mock.composerText()), 'half typed', 'the draft is left alone');
  await page.click('.public-DraftEditor-content');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  assert.equal(await mock(() => window.mock.composerText()), '');

  const newChat = await op('send', { job: fake({ kind: 'new_chat' }) });
  assert.deepEqual([newChat.ok, newChat.error_code, newChat.retryable], [false, 'unknown', false], JSON.stringify(newChat));
  const nobody = await op('send', { job: fake({ target: { thread_external_id: '0:1:1:2', title: 'Nobody', handle: 'nobody' } }) });
  assert.deepEqual([nobody.ok, nobody.error_code], [false, 'thread_not_found'], JSON.stringify(nobody));
  const wrongPeer = await op('send', { job: fake({ target: { thread_external_id: 'someone.else', title: 'Jake', handle: 'someone.else' } }) });
  assert.deepEqual([wrongPeer.ok, wrongPeer.error_code], [false, 'thread_not_found'], JSON.stringify(wrongPeer));
  assert.equal((await sent()).length, 7);
  pass('refused: draft in the message box (composer_busy), new_chat (unknown), unknown conversation, wrong person');

  // ---- send button that ignores the click: Enter is the fallback ---------------------------------------
  await mock(() => window.mock.setQuirk('ignoreSendClick', true));
  const viaEnter = await op('send', { job: fake({ parts: ['sent with enter'] }) });
  await mock(() => window.mock.setQuirk('ignoreSendClick', false));
  assert.equal(viaEnter.ok, true, JSON.stringify(viaEnter));
  out = await sent();
  assert.deepEqual([out.length, out[7].text, out[7].via, out[7].convId], [8, 'sent with enter', 'enter', jakeId]);

  // ---- unclear outcome: the box emptied but no bubble appeared. Fails for good, never resent ----------
  await mock(() => window.mock.setQuirk('dropNextSend', true));
  const unclear = await op('send', { job: fake({ parts: ['lost in the post'] }) });
  assert.deepEqual([unclear.ok, unclear.error_code, unclear.retryable], [false, 'send_not_confirmed', false], JSON.stringify(unclear));
  assert.equal((await mock(() => window.mock.dropped())).length, 1);
  assert.equal((await sent()).length, 8);
  pass('click ignored: sent with Enter instead. Unclear outcome: send_not_confirmed, not retryable');

  // ---- message request: read, answered by the brain, send fails cleanly with "blocked" ------------------
  const samId = await mock(() => window.mock.receiveRequest({ handle: 'sam.new', nickname: 'Sam', text: 'do you have the x3 in stock' }));
  const samJob = await until('request job failed', async () => {
    const [row] = await sql(`SELECT o.status, o.last_error FROM outbox o JOIN conversations c ON c.id = o.conversation_id WHERE c.external_thread_id = ?`, [samId]);
    return row && row.status === 'failed' ? row : null;
  });
  assert.match(samJob.last_error, /^blocked: Accept the message request in TikTok first/);
  // (The adapter may be looking inside Message requests at this very moment; it always comes back.)
  await until('list back on the normal conversations', async () => (await mock(() => window.mock.state())).view === 'main', 15_000);
  const samState = await mock(() => window.mock.state());
  assert.equal(samState.convs.find((c) => c.peer.uniqueId === 'sam.new').request, true, 'the request was not accepted for the owner');
  assert.equal((await sent()).length, 8);
  const [samMsg] = await sql(`SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_thread_id = ? AND m.direction = 'in'`, [samId]);
  assert.equal(samMsg.body, 'do you have the x3 in stock');
  pass('message request: read and reported, reply failed with blocked (not retried, not accepted)');

  // ---- legacy front end: no ids in the DOM ---------------------------------------------------------------
  await mock(() => window.mock.setVariant('legacy'));
  const legacyProbe = await until('legacy probe', async () => { const r = await op('probe'); return r.ok && /legacy/.test(r.data.detail) ? r : null; });
  assert.equal(legacyProbe.data.state, 'ready');
  const jakeLegacy = await op('read', { key: `dm|id|${jakeId}` });
  assert.equal(jakeLegacy.ok, true, JSON.stringify(jakeLegacy));
  assert.equal(jakeLegacy.data.thread.external_id, jakeId, 'conversation id still comes from the row id attribute');
  assert.ok(jakeLegacy.data.messages.length >= 5 && jakeLegacy.data.messages.every((m) => m.external_id === null), 'no message ids in the legacy layout');
  assert.deepEqual(jakeLegacy.data.messages.slice(-3).map((m) => [m.direction, m.body]), [['out', 'hey'], ['out', 'mock second part'], ['out', 'sent with enter']]);
  const samLegacy = await op('send', { job: fake({ target: { thread_external_id: samId, title: 'Sam', handle: 'sam.new' } }) });
  assert.deepEqual([samLegacy.ok, samLegacy.error_code, samLegacy.retryable, samLegacy.error], [false, 'blocked', false, 'Accept the message request in TikTok first'], JSON.stringify(samLegacy));
  await mock(() => window.mock.receive('mia_b', 'ok'));
  await until('legacy reply to Mia', async () => (await sent()).length === 9);
  assert.equal((await sent())[8].convId, miaId);
  await until('legacy job recorded', async () => (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'tiktok' AND status = 'sent'`))[0].n === 7);
  for (let i = 0; i < 5; i++) { await kick(); await sleep(600); }
  const paused = await sql(`SELECT COUNT(*) AS n FROM conversations WHERE channel = 'tiktok' AND paused_until IS NOT NULL`);
  assert.equal(paused[0].n, 0, 'our own messages were never mistaken for the owner typing');
  assert.equal((await sent()).length, 9);
  pass('legacy layout: read without ids, send confirmed by text, request still blocked');
  await mock(() => window.mock.setVariant('sdk'));

  // ---- watchdog: a hung tab (the content script never answers) is reloaded and the channel recovers --------
  const timing = (t) => popup.evaluate((v) => chrome.storage.local.set({ timing: v }), t);
  await until('channel settled', async () => { const s = await tiktokStatus(); return s?.state === 'ready' && !s.busy ? s : null; });
  const recoveriesBefore = (await tiktokStatus()).recoveries || 0;
  await timing({ stall_ms: 5000, recovery_gap_ms: 5000, replace_after_ms: 120_000 });
  const cdp = await context.newCDPSession(page);
  // Stop all script in the page (the content script runs on the same thread): it never answers again,
  // as with a frozen or hung tab. Only a reload brings it back.
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  const healed = await until('watchdog reloads the hung tab', async () => { const s = await tiktokStatus(); return s && s.recoveries > recoveriesBefore ? s : null; }, 90_000);
  assert.match(healed.last_error, /No good read|has not answered|stopped answering/, JSON.stringify(healed));
  await page.waitForFunction(() => window.mock && window.mock.ready, null, { timeout: 30_000 });
  const recovered = await until('tiktok ready again after the reload', async () => { const s = await tiktokStatus(); return s?.state === 'ready' && !s.last_error ? s : null; });
  assert.ok(recovered.last_ok_at > 0, 'a good read is reported after the recovery');
  await timing(null);
  let before = (await sent()).length;
  await mock(() => window.mock.receive('mia_b', 'are you still there'));
  await until('answer after the recovery', async () => (await sent()).length === before + 1);
  assert.equal((await sent()).at(-1).convId, miaId);
  assert.equal((await sent()).at(-1).text, 'mock reply to: are you still there');
  await until('recovered job recorded', async () => (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'tiktok' AND status = 'sent'`))[0].n === 8);
  pass(`watchdog: hung tab reloaded (${healed.recoveries} fix today, "${healed.last_error}"), channel answers again`);

  // ---- a second TikTok tab: only the first one is ever read or typed into --------------------------------------
  const page2 = await context.newPage();
  await page2.goto(TIKTOK_URL);
  await page2.waitForFunction(() => window.mock && window.mock.ready);
  const mock2 = (fn, arg) => page2.evaluate(fn, arg);
  const sent2 = () => mock2(() => window.mock.sent());
  const sent2Before = (await sent2()).length; // the copy starts from the first tab's saved state
  const dupStatus = await until('duplicate tab reported', async () => { const s = await tiktokStatus(); return /2 TikTok tabs are open/.test(s?.detail || '') ? s : null; });
  assert.equal(dupStatus.state, 'ready');
  await mock2(() => window.mock.receive('jake.rides', 'hello from the second tab'));
  before = (await sent()).length;
  await mock(() => window.mock.receive('mia_b', 'one more question'));
  await until('answer in the first tab', async () => (await sent()).length === before + 1);
  for (let i = 0; i < 8; i++) { await kick(); await sleep(600); }
  assert.equal((await sent()).length, before + 1, 'answered once');
  assert.equal((await sent()).at(-1).convId, miaId);
  assert.equal((await sent2()).length, sent2Before, 'nothing was typed into the second tab');
  const read2 = await sql(`SELECT COUNT(*) AS n FROM messages WHERE body = 'hello from the second tab'`);
  assert.equal(read2[0].n, 0, 'the second tab was never read');
  await page2.close();
  await until('duplicate note gone', async () => { const s = await tiktokStatus(); return s?.state === 'ready' && !/tabs are open/.test(s.detail || '') ? s : null; });
  pass(`duplicate tab: "${dupStatus.detail}"; reads and sends stay in the first tab`);

  // ---- captcha and rate limit stop the channel ------------------------------------------------------------
  await mock(() => window.mock.setCaptcha(true));
  const captcha = await op('probe');
  assert.equal(captcha.data.state, 'blocked');
  assert.match(captcha.data.detail, /captcha/i);
  await mock(() => window.mock.setCaptcha(false));
  assert.equal((await op('probe')).data.state, 'ready');

  // The limit hits in the middle of a send: TikTok shows our bubble as failed plus a "too fast" notice.
  await mock(() => window.mock.setQuirk('limitNextSend', true));
  const hit = await op('send', { job: fake({ parts: ['one too many'] }) });
  assert.deepEqual([hit.ok, hit.error_code, hit.retryable], [false, 'blocked', false], JSON.stringify(hit));
  assert.match(hit.error, /too fast/);
  assert.equal((await mock(() => window.mock.failed())).length, 1);
  const blocked = await until('blocked in /api/overview', async () => { const s = await tiktokStatus(); return s?.state === 'blocked' ? s : null; });
  assert.match(blocked.detail, /too fast/i);
  const sentBeforeBlock = (await sent()).length;
  await mock(() => window.mock.receive('jake.rides', 'hello?'));
  for (let i = 0; i < 6; i++) { await kick(); await sleep(600); }
  assert.equal((await sent()).length, sentBeforeBlock, 'nothing is sent while blocked');
  assert.equal((await mock(() => window.mock.failed())).length, 1, 'the agent did not try again');
  const whileBlocked = await op('send', { job: fake() });
  assert.deepEqual([whileBlocked.ok, whileBlocked.error_code], [false, 'blocked'], JSON.stringify(whileBlocked));
  await mock(() => window.mock.setRateLimited(false));
  const resting = await op('probe');
  assert.equal(resting.data.state, 'blocked', 'the channel keeps resting after the notice is gone');
  assert.match(resting.data.detail, /Resting until \d\d:\d\d/);
  pass(`rate limit: reported as blocked in /api/overview ("${blocked.detail}"), captcha too, channel rests`);

  const diag = await sql(`SELECT kind, COUNT(*) AS n FROM diagnostics WHERE channel = 'tiktok' GROUP BY kind`);
  log(`diagnostics sent by the adapter: ${diag.map((d) => `${d.kind}=${d.n}`).join(', ') || 'none'}`);
  const errors = await sql(`SELECT data FROM diagnostics WHERE channel = 'tiktok' AND kind IN ('error', 'selector_miss')`);
  assert.deepEqual(errors, [], 'no unexpected adapter errors or selector misses');
  log('ALL PASSED');
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  console.error('FAIL', err);
  if (server) console.error('--- server log tail ---\n' + server.logs().slice(-1500));
} finally {
  try { if (context) await context.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }
  for (const dir of tmp) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.exit(code);
