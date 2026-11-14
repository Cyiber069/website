// End to end test of the Gmail adapter: real backend (wrangler dev, mock brain), real extension in
// Chromium, mock Gmail served under https://mail.google.com. Run with: node test/e2e/gmail.e2e.mjs
// Exit code 0 means every check passed.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { ACCOUNT, createGmailMock } from './mocks/gmail/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GMAIL = 'https://mail.google.com/mail/u/0/#inbox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (text) => console.log(`PASS ${text}`);

let server;
let context;
const tmp = [];

async function main() {
  // ---- backend: owner, fast pacing, pairing code ---------------------------------------------------
  server = await startServer();
  const base = server.url;
  let cookie = '';
  const api = async (path, { method, body } = {}) => {
    const headers = { cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error(`${method ?? 'POST'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return { data, res };
  };
  const sql = async (query, params = []) => (await api('/api/test/sql', { body: { sql: query, params } })).data.results;

  const setup = await api('/api/setup', { body: { password: 'correct horse battery' } });
  cookie = (setup.res.headers.get('set-cookie') ?? '').split(';')[0];
  await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 1, min_reply_delay_s: 0, max_reply_delay_s: 0, typing_cps: 400 } });
  // A selector fix from the dashboard also carries timings: no 7 s Undo wait and short waits in the test.
  await api('/api/selectors', { method: 'PUT', body: { override: { gmail: { timing: { afterSendMs: 250, waitVisibleMs: 6000 } } } } });
  const settings = (await api('/api/settings')).data.settings;
  assert.equal(settings.channels.gmail.mode, 'review', 'gmail starts in review mode');
  const pairing = (await api('/api/devices/pair-code', { body: {} })).data.pairing_string;

  // ---- browser with the unpacked extension --------------------------------------------------------
  // Work on a copy so the test never depends on the other adapters being finished.
  const ext = mkdtempSync(join(tmpdir(), 'acx-ext-'));
  tmp.push(ext);
  cpSync(join(root, 'extension'), ext, { recursive: true });
  for (const name of ['whatsapp.js', 'whatsapp-main.js', 'tiktok.js']) {
    const f = join(ext, 'content', name);
    if (!existsSync(f)) writeFileSync(f, '// not built yet\n');
  }
  // Chrome refuses to load an extension whose manifest names icon files that do not exist.
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  for (const icon of Object.values(manifest.icons ?? {})) {
    const f = join(ext, icon);
    if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, PIXEL); console.log(`NOTE extension/${icon} is missing, using a placeholder for the test`); }
  }
  const profile = mkdtempSync(join(tmpdir(), 'acx-profile-'));
  tmp.push(profile);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', // full Chromium in new headless mode; the headless shell cannot load extensions
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const gmail = createGmailMock();
  await context.route('https://mail.google.com/**', gmail.handle);
  for (const host of ['https://web.whatsapp.com/**', 'https://www.tiktok.com/**']) {
    await context.route(host, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>not under test</title>' }));
  }

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ auto_open_tabs: false }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const openGmail = async () => {
    await page.goto(GMAIL);
    await page.waitForFunction(() => document.body.dataset.mockReady === '1' || !!document.querySelector('#identifierId'), null, { timeout: 15_000 });
  };
  await openGmail();

  // ---- pair through the real popup ----------------------------------------------------------------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#pairing', pairing);
  await popup.fill('#device-name', 'E2E laptop');
  await popup.click('#pair-btn');
  await popup.waitForSelector('#main-view:not([hidden])', { timeout: 20_000 });
  step('paired through the popup');

  // Helpers that need the browser.
  const tick = () => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ acx: true, type: 'tick' }, () => r(chrome.runtime.lastError ? null : true)))).catch(() => null);
  /** Poll `fn` until it returns something truthy, asking the extension to run a cycle in between. */
  const until = async (label, fn, timeout = 60_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
      await tick();
      await sleep(700);
    }
  };
  /** Call the adapter in the Gmail tab directly, the same way the service worker does. */
  const op = (name, args = {}) => sw.evaluate(async ({ name, args }) => {
    const [tab] = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    return chrome.tabs.sendMessage(tab.id, { acx: true, op: name, args });
  }, { name, args });
  const mock = (fn, arg) => page.evaluate(fn, arg);
  const outbox = async (id) => (await sql('SELECT * FROM outbox WHERE id = ?', [id]))[0];
  const idle = async () => { for (let i = 0; i < 3; i++) { await tick(); await sleep(900); } };

  await until('popup shows Gmail working in ask-first mode', async () => (await popup.textContent('#channels')).includes('Working, asks you first'));
  step('popup shows Gmail ready, asks first');

  // ---- 1. review mode: a customer email becomes a draft, nothing is sent ------------------------
  const jake = await mock(() => window.mock.deliver({
    from: { name: 'Jake Rider', email: 'jake.rider@example.com' },
    subject: 'Delivery time',
    // Written on a phone in another mail program: quoted text and signature carry no markup.
    text: 'yo how long is delivery to Leeds\n\nSent from my iPhone\n\nOn Fri, 13 Nov 2026 at 09:12, ACX Support <support@acxebikes.example> wrote:\n> thanks for your order\n> it is on the way',
  }));
  const draft = await until('a review draft for Jake', async () => {
    const list = (await api('/api/urgent')).data.review;
    return list.find((r) => r.channel === 'gmail' && r.customer === 'Jake Rider');
  });
  assert.deepEqual(draft.parts, ['mock reply to: yo how long is delivery to Leeds']);
  assert.equal(draft.subject, 'Delivery time');
  assert.equal(draft.customer_message, 'yo how long is delivery to Leeds', 'quoted history and phone signature are stripped');
  const conv = (await sql('SELECT cv.external_thread_id, ct.email, ct.display_name FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = ?', [draft.conversation_id]))[0];
  assert.equal(conv.external_thread_id, jake.threadId, 'conversation is keyed on the real thread id');
  assert.equal(conv.email, 'jake.rider@example.com');
  const stored = await sql('SELECT external_id, direction, body, ts FROM messages WHERE conversation_id = ?', [draft.conversation_id]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].external_id, jake.messageId, 'message id is the legacy message id');
  assert.ok(Math.abs(stored[0].ts - Date.now()) < 5 * 60_000, 'message time was read from the page');
  await idle();
  assert.equal(gmail.sent().length, 0, 'review mode sends nothing');
  assert.ok(page.url().endsWith('#inbox'), `tab is back on the inbox (${page.url()})`);
  step('review mode: draft created, nothing sent, thread read cleanly');

  // ---- 2. approving the draft types and sends it in the right thread ------------------------------
  await api(`/api/review/${draft.id}/approve`, { body: {} });
  await until('the approved reply to be sent', async () => gmail.sent().length === 1 && (await outbox(draft.id)).status === 'sent');
  const first = gmail.sent()[0];
  assert.equal(first.kind, 'reply');
  assert.equal(first.threadId, jake.threadId, 'reply went into Jake\'s thread');
  assert.equal(first.to, 'jake.rider@example.com');
  assert.equal(first.text, 'mock reply to: yo how long is delivery to Leeds');
  assert.ok(first.inputEvents > 0, 'Gmail saw input events (draft autosave)');
  const sentHtml = gmail.thread(jake.threadId).messages.at(-1).html;
  assert.ok(sentHtml.indexOf('mock reply to') < sentHtml.indexOf('gmail_signature'), 'text sits above the signature');
  assert.ok(sentHtml.includes('ACX Ebikes'), 'signature kept');
  const sentRow = (await sql(`SELECT external_id FROM messages WHERE conversation_id = ? AND direction = 'out'`, [draft.conversation_id]))[0];
  assert.equal(sentRow.external_id, first.messageId, 'new message id was reported');
  step('approved draft typed above the signature and sent in the right thread');

  // ---- 3. auto mode: automatic reply, several parts, follow up in the same thread -----------------
  await api('/api/settings/channels', { method: 'PUT', body: { gmail: { mode: 'auto' } } });
  const priya = await mock(() => window.mock.deliver({ from: { name: 'Priya Shah', email: 'priya@example.org' }, subject: 'Battery range', text: 'two-parts please, what range does the battery give' }));
  await until('the automatic reply to Priya', () => gmail.sent().length === 2);
  const second = gmail.sent()[1];
  assert.equal(second.threadId, priya.threadId);
  assert.equal(second.text, 'hey\n\nmock second part', 'parts are joined by a blank line into one email');

  // The customer answers in the same thread (quoting us). The thread now has collapsed messages.
  await sleep(600);
  await mock((id) => window.mock.deliver({ threadId: id, from: { name: 'Priya Shah', email: 'priya@example.org' }, text: 'and do you ship to ireland' }), priya.threadId);
  await until('the reply to Priya\'s follow up', () => gmail.sent().length === 3);
  const third = gmail.sent()[2];
  assert.equal(third.threadId, priya.threadId);
  assert.equal(third.text, 'mock reply to: and do you ship to ireland', 'the quote of our own email is not part of the question');
  const priyaConv = (await sql('SELECT id, paused_until FROM conversations WHERE external_thread_id = ?', [priya.threadId]))[0];
  assert.equal(priyaConv.paused_until, null, 'our own email was not mistaken for the owner typing');
  await until('every reply job confirmed', async () => (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'gmail' AND status IN ('pending', 'leased')`))[0].n === 0);
  step('auto mode: automatic replies, multi part email, follow up in a long thread');

  // ---- 4. a job delivered again is not sent again (reply) ----------------------------------------
  // Forget everything the extension remembers, so only the check inside the thread can stop a resend.
  await sw.evaluate(() => chrome.storage.local.set({ done_jobs: [], gmail_adapter: null }));
  await openGmail();
  await sql(`UPDATE outbox SET status = 'pending', lease_until = NULL, attempts = 0, not_before = 0 WHERE id = ?`, [draft.id]);
  await until('the redelivered reply job to be confirmed', async () => (await outbox(draft.id)).status === 'sent');
  await idle();
  assert.equal(gmail.sent().length, 3, 'a redelivered reply is not sent twice');
  step('redelivered reply job confirmed without sending again');

  // ---- 5. new email job --------------------------------------------------------------------------
  const target = { thread_external_id: null, title: 'Sam Buyer', phone: null, email: 'sam.buyer@example.com', handle: null, subject: 'Your ACX order' };
  await sql(
    `INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, pacing, created_at) VALUES (?, 'gmail', 'new_chat', NULL, ?, ?, 'pending', 'manual', 0, '{}', ?)`,
    ['ob_e2e_new', JSON.stringify(target), JSON.stringify(['hi Sam your bike is ready', 'pop in any time this week']), Date.now()],
  );
  await until('the new email to be sent', async () => gmail.sent().length === 4 && (await outbox('ob_e2e_new')).status === 'sent', 90_000);
  const fresh = gmail.sent()[3];
  assert.equal(fresh.kind, 'new');
  assert.equal(fresh.to, 'sam.buyer@example.com');
  assert.equal(fresh.subject, 'Your ACX order');
  assert.equal(fresh.text, 'hi Sam your bike is ready\n\npop in any time this week');
  await page.waitForFunction(() => location.hash === '#inbox' && !location.search && document.body.dataset.mockReady === '1', null, { timeout: 20_000 });
  step('new email composed from the compose address and sent, tab back on the inbox');

  // Delivered again: this time the service worker forgot it, but the adapter still remembers the job.
  await sw.evaluate(() => chrome.storage.local.set({ done_jobs: [] }));
  await sql(`UPDATE outbox SET status = 'pending', lease_until = NULL, attempts = 0, not_before = 0 WHERE id = 'ob_e2e_new'`);
  await until('the redelivered new email job to be confirmed', async () => (await outbox('ob_e2e_new')).status === 'sent');
  await idle();
  assert.equal(gmail.sent().length, 4, 'a redelivered new email is not sent twice');
  step('redelivered new email job confirmed without sending again');

  // ---- 6. automated mail is never reported -----------------------------------------------------------
  await idle();
  const contacts = (await sql(`SELECT email FROM contacts WHERE channel = 'gmail'`)).map((c) => c.email).sort();
  assert.deepEqual(contacts, ['jake.rider@example.com', 'priya@example.org', 'sam.buyer@example.com'], 'only real customers reached the server');
  assert.equal(gmail.thread('19a8000000000010').unread, true, 'the newsletter was never even opened');
  assert.equal(gmail.thread('19a8000000000020').unread, false, 'the email with an Unsubscribe marker was opened once, then skipped');
  assert.equal(gmail.thread('19a8000000000030').unread, true, 'mail outside Primary is left alone');
  assert.equal(gmail.sent().length, 4);
  step('newsletter, unsubscribe marked mail and promotions never reported');

  // ---- 7. adapter operations called directly -------------------------------------------------------
  await sw.evaluate(() => chrome.storage.local.set({ paused: true })); // keep the agent's own cycle out of the way
  await idle();
  const MIA = '19a8000000000001';
  const job = (id, text) => ({ job: { id, channel: 'gmail', kind: 'reply', target: { thread_external_id: MIA }, parts: [text], pacing: { delay_ms: 0, typing_cps: 400 } } });

  const probe = await op('probe');
  assert.equal(probe.data.state, 'ready');
  assert.equal(probe.data.unread, 1, 'unread count is the Primary feed count');

  // An existing draft is never overwritten.
  await mock((id) => window.mock.setDraft(id, 'half written by the owner'), MIA);
  const busy = await op('send', job('direct-1', 'hello Mia'));
  assert.equal(busy.ok, false);
  assert.equal(busy.error_code, 'composer_busy');
  assert.equal(gmail.thread(MIA).draft, 'half written by the owner');
  await mock((id) => window.mock.setDraft(id, null), MIA);

  // Send pressed, nothing happens: unclear, so it fails for good.
  await mock(() => { window.mock.failNextSend = 'silent'; });
  const unclear = await op('send', job('direct-2', 'hello Mia'));
  assert.equal(unclear.error_code, 'send_not_confirmed');
  assert.equal(unclear.retryable, false, 'an unclear outcome must not be retried');
  await mock((id) => window.mock.setDraft(id, null), MIA);

  // Gmail says "not sent": retryable, and the next try reuses the text that is already in the box.
  await mock(() => { window.mock.failNextSend = 'error'; });
  const refused = await op('send', job('direct-3', 'hello Mia'));
  assert.equal(refused.error_code, 'send_not_confirmed');
  assert.equal(refused.retryable, true);
  assert.equal(gmail.sent().length, 4);
  const retried = await op('send', job('direct-3', 'hello Mia'));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(gmail.sent().length, 5);
  assert.equal(gmail.sent()[4].text, 'hello Mia', 'the leftover draft was sent as is, not typed twice');
  assert.equal(retried.data.sent_external_ids[0], gmail.sent()[4].messageId);
  const again = await op('send', job('direct-3', 'hello Mia'));
  assert.equal(again.ok, true);
  assert.equal(again.data.already_sent, true);
  assert.equal(gmail.sent().length, 5);
  step('draft respected, unclear send not retried, refused send retried without duplicate text');

  // Reading returns the whole conversation oldest first with directions and clean text.
  const read = await op('read', { key: MIA });
  assert.equal(read.data.thread.external_id, MIA);
  assert.equal(read.data.thread.subject, 'Charger question');
  assert.deepEqual(read.data.thread.contact, { name: 'Mia Old', phone: null, email: 'mia.old@example.com', handle: null });
  assert.deepEqual(read.data.messages.map((m) => [m.direction, m.body]), [
    ['in', 'hi do you sell spare chargers'], ['out', 'hi Mia yes we do they are on the site'], ['in', 'great thank you'], ['out', 'hello Mia'],
  ]);
  assert.ok(read.data.messages.every((m) => /^[0-9a-f]{16}$/.test(m.external_id) && m.kind === 'text'));
  step('read returns ids, directions and text without quotes or signatures');

  // Feed gone: the list scan finds the same unread people and skips the newsletter.
  const lena = await mock(() => window.mock.deliver({ from: { name: 'Lena Fox', email: 'lena@example.net' }, subject: 'Helmet size', text: 'what size helmet for a 58cm head' }));
  const viaFeed = await op('scan');
  assert.equal(viaFeed.data.source, 'feed');
  assert.deepEqual(viaFeed.data.threads.map((t) => t.title), ['Lena Fox']);
  assert.equal(viaFeed.data.threads[0].key, lena.messageId);
  gmail.feedDown = true;
  const viaList = await op('scan');
  gmail.feedDown = false;
  assert.equal(viaList.data.source, 'list');
  assert.deepEqual(viaList.data.threads.map((t) => [t.key, t.title, t.is_group]), [[lena.threadId, 'Lena Fox', false]]);
  assert.ok(page.url().endsWith('#inbox'));
  assert.equal(gmail.thread(lena.threadId).unread, true, 'scanning does not open anything');
  step('scan: feed first, list scan as fallback, automated senders skipped');

  // Self test: every check passes on the mock, a reply box is typed into and discarded, nothing is sent.
  const self = await op('selftest');
  const failed = self.data.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], 'selftest checks');
  assert.ok(self.data.checks.some((c) => c.name === 'Typing into the reply box' && c.detail === 'method: exec'));
  assert.ok(self.data.checks.some((c) => c.name === 'Draft discarded'));
  assert.equal(gmail.thread(MIA).draft, null, 'the selftest draft was discarded');
  assert.equal(gmail.sent().length, 5, 'selftest never sends');
  step(`selftest: ${self.data.checks.length} checks ok, typed and discarded, nothing sent`);

  // Signed out.
  gmail.loggedOut = true;
  await openGmail();
  const out = await until('the adapter on the sign-in page', async () => { const r = await op('probe').catch(() => null); return r && r.ok ? r : null; }, 20_000);
  assert.equal(out.data.state, 'logged_out');
  step('sign-in page reported as logged_out');

  assert.deepEqual(pageErrors, [], 'no script errors in the Gmail page');
  const diag = await sql(`SELECT kind, data FROM diagnostics WHERE channel = 'gmail' AND kind IN ('selector_miss', 'error')`);
  assert.deepEqual(diag, [], 'no selector misses or adapter errors were reported');
  console.log(`\nAll Gmail end to end checks passed (mock account ${ACCOUNT.email}).`);
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  console.error('\nFAIL', err);
  if (server) console.error('\n--- server log (tail) ---\n' + server.logs().slice(-1500));
} finally {
  if (context) await context.close().catch(() => {});
  if (server) await server.stop().catch(() => {});
  for (const dir of tmp) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(code);
