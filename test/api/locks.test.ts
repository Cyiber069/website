// Settings locks against the local Worker: set a PIN, lock, every lockable box's change routes refused with 423
// (reads still work), the never lockable routes and the laptop untouched while everything is locked, unlock,
// wrong PIN counting and the 15 minute block, changing the PIN.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, cron, finish, inbound, sql, sync, unique } from '../helpers/client';

const PIN = '2468';
const SECTIONS = ['voice', 'brain', 'vision', 'shopify', 'alerts', 'channels', 'gmail', 'pacing', 'laptops', 'recovery_message', 'recovery_settings', 'discounts', 'sales', 'knowledge'];
const clear = () => sql(`DELETE FROM settings WHERE key IN ('state:lock_pin', 'state:locks', 'state:lock_fails')`);
const resetFails = () => sql(`DELETE FROM settings WHERE key = 'state:lock_fails'`);
const lock = (id: string, locked: boolean, pin = PIN) => api(`/api/locks/sections/${id}`, { body: { locked, pin } });
const fails = async () => JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:lock_fails'`)).data.results[0]?.value ?? '{"fails":0,"until":0}');
const rev = async () => Number(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:settings_rev'`)).data.results[0]?.value ?? '0'));

/** Every change route of every box, as the dashboard would send it. The body does not matter: the lock comes first. */
const WRITES: [string, string, string, unknown?][] = [
  ['voice', 'PUT', '/api/settings/voice', { extra_rules: 'locked change' }],
  ['brain', 'PUT', '/api/connections/brain', { effort: 'high' }], ['brain', 'PUT', '/api/settings/brain', { effort: 'high' }],
  ['vision', 'PUT', '/api/connections/vision', { enabled: false }], ['vision', 'PUT', '/api/settings/vision', { enabled: false }],
  ['shopify', 'PUT', '/api/connections/shopify', { myshopify_domain: 'other.myshopify.com' }], ['shopify', 'DELETE', '/api/connections/shopify'], ['shopify', 'PUT', '/api/settings/store', { name: 'Other' }],
  ['alerts', 'PUT', '/api/settings/alerts', { push: false }], ['alerts', 'POST', '/api/push/subscribe', {}], ['alerts', 'POST', '/api/push/unsubscribe', {}],
  ['channels', 'PUT', '/api/settings/channels', { whatsapp: { mode: 'off' } }],
  ['gmail', 'PUT', '/api/settings/gmail', { account: 'someone@example.com' }],
  ['pacing', 'PUT', '/api/settings/pacing', { settle_seconds: 9 }],
  ['laptops', 'POST', '/api/devices/pair-code', {}], ['laptops', 'DELETE', '/api/devices/dv_nope'],
  ['recovery_message', 'PUT', '/api/recovery/template', { text: 'Hi {first_name}', approved: false }],
  ['recovery_settings', 'PUT', '/api/settings/recovery', { enabled: false }],
  ['discounts', 'PUT', '/api/settings/discounts', { mode: 'off' }],
  ['sales', 'PUT', '/api/sales/settings', { follow_ups: false }], ['sales', 'PUT', '/api/settings/sales', { follow_ups: false }],
  ['knowledge', 'POST', '/api/kb/upload', {}], ['knowledge', 'POST', '/api/kb/note', { title: 'Locked', content: 'Should not be saved' }],
  ['knowledge', 'PATCH', '/api/kb/kb_nope', { enabled: false }], ['knowledge', 'DELETE', '/api/kb/kb_nope'], ['knowledge', 'POST', '/api/kb/sync-store', {}],
  ['knowledge', 'POST', '/api/kb/gaps/answer', { question: 'q', answer: 'a' }], ['knowledge', 'POST', '/api/kb/gaps/dismiss', { question: 'q' }],
];

/** A raw owner request, for the headers. */
async function ownerFetch(path: string, init: RequestInit = {}) {
  return fetch(`${BASE()}${path}`, { ...init, headers: { cookie: process.env.ACX_TEST_COOKIE!, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
}

beforeAll(async () => { await clear(); });
afterAll(async () => {
  await clear();
  await api('/api/agent-toggle', { body: { enabled: true } });
});

describe('settings locks', () => {
  it('starts with nothing locked and no PIN, and the state is cheap to read', async () => {
    const res = await api('/api/locks');
    expect(res.status).toBe(200);
    expect(res.data.pin_set).toBe(false);
    expect(res.data.locked).toEqual([]);
    expect(res.data.sections.map((s: { id: string }) => s.id)).toEqual(SECTIONS);
    expect(res.queries).toBeLessThanOrEqual(2);
    expect((await api('/api/locks', { as: 'public' })).status).toBe(401);
    expect((await api('/api/locks/sections/voice', { as: 'public', body: { locked: true, pin: PIN } })).status).toBe(401);
  });

  it('needs a PIN before anything can be locked, and takes only 4 to 8 digits', async () => {
    const none = await lock('voice', true);
    expect(none.status).toBe(409);
    expect(none.data.error).toBe('no_pin');
    for (const pin of ['12', 'abcd', '123456789', '12 34', 1234]) {
      const r = await api('/api/locks/pin', { body: { pin } });
      expect(r.status, String(pin)).toBe(400);
      expect(r.data.error).toBe('invalid_pin');
      expect(r.data.message).toBe('Use 4 to 8 numbers for the PIN.');
    }
    expect((await fails()).fails).toBe(0); // the check with no PIN set was not counted as a wrong PIN
  });

  it('sets the PIN once and keeps only a PBKDF2 hash of it', async () => {
    const set = await api('/api/locks/pin', { body: { pin: PIN } });
    expect(set.status).toBe(200);
    expect(set.data.pin_set).toBe(true);
    const row = (await sql(`SELECT value FROM settings WHERE key = 'state:lock_pin'`)).data.results[0].value as string;
    expect(row).not.toContain(PIN);
    expect(JSON.parse(row)).toMatchObject({ hash: expect.any(String), salt: expect.any(String), iterations: expect.any(Number) });
    const again = await api('/api/locks/pin', { body: { pin: '1111' } });
    expect(again.status).toBe(409);
    expect(again.data.error).toBe('pin_exists');
  });

  it('locks one box on every device: its change is refused with 423, other boxes and reads still work', async () => {
    const before = (await api('/api/settings')).data.settings;
    const revBefore = await rev();
    const locked = await lock('voice', true);
    expect(locked.status).toBe(200);
    expect(locked.data.locked).toEqual(['voice']);
    // The settings revision moved in the same batch, so other isolates read the lock on their next request.
    expect(await rev()).toBeGreaterThan(revBefore);

    const refused = await api('/api/settings/voice', { method: 'PUT', body: { extra_rules: 'locked change' } });
    expect(refused.status).toBe(423);
    expect(refused.data).toMatchObject({ error: 'locked', message: 'This is locked. Unlock it with your PIN.', section: 'voice', locks: { pin: true, locked: ['voice'] } });
    expect(refused.queries).toBeLessThanOrEqual(3);
    expect((await api('/api/settings')).data.settings.voice.extra_rules).toBe(before.voice.extra_rules);

    const other = await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: before.pacing.settle_seconds } });
    expect(other.status).toBe(200);

    // Every owner answer says what is locked, so the dashboard on another device follows at its next refresh.
    const ov = await ownerFetch('/api/overview');
    expect(ov.status).toBe(200);
    expect(JSON.parse(ov.headers.get('x-acx-locks')!)).toEqual({ pin: true, locked: ['voice'] });
    const view = await api('/api/locks');
    expect(view.data.sections.find((s: { id: string }) => s.id === 'voice')).toMatchObject({ locked: true, locked_at: expect.any(Number) });
  });

  it('with everything locked, refuses every change route of every box, however the path is written', async () => {
    for (const id of SECTIONS) expect((await lock(id, true)).status, id).toBe(200);
    expect((await api('/api/locks')).data.locked).toEqual(SECTIONS);
    for (const [id, method, path, body] of WRITES) {
      const res = await api(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(423);
      expect(res.data.section, `${method} ${path}`).toBe(id);
    }
    expect(new Set(WRITES.map(([id]) => id))).toEqual(new Set(SECTIONS));
    for (const path of ['/api/settings/voice/', '/api//settings/voice', '/api/settings/%76oice']) {
      expect((await api(path, { method: 'PUT', body: { extra_rules: 'x' } })).status, path).toBe(423);
    }
    // Nothing was changed by any of them.
    const s = (await api('/api/settings')).data.settings;
    expect(s.voice.extra_rules).not.toBe('locked change');
    expect(s.pacing.settle_seconds).not.toBe(9);
    expect(s.channels.whatsapp.mode).not.toBe('off');
    expect((await sql(`SELECT COUNT(*) AS n FROM kb_docs WHERE title = 'Locked'`)).data.results[0].n).toBe(0);
  });

  it('reads still work while everything is locked', async () => {
    for (const path of ['/api/settings', '/api/connections', '/api/kb', '/api/recovery', '/api/discounts', '/api/sales', '/api/devices', '/api/overview', '/api/health', '/api/locks', '/api/urgent', '/api/conversations']) {
      expect((await api(path)).status, path).toBe(200);
    }
  });

  it('never locks the agent switch, the emergency stop, replies, the support link, sign in and out, or the Test buttons', async () => {
    expect((await api('/api/agent-toggle', { body: { enabled: false } })).status).toBe(200);
    expect((await api('/api/settings/agent', { method: 'PUT', body: { enabled: true } })).status).toBe(200);
    expect((await api('/api/panic', { body: {} })).status).toBe(200);
    expect((await api('/api/agent-toggle', { body: { enabled: true } })).status).toBe(200);
    const notLocked: [string, string, unknown?][] = [
      ['POST', '/api/urgent/ur_nope/answer', { answer: 'hi' }], ['POST', '/api/urgent/ur_nope/note', { note: 'hi' }],
      ['POST', '/api/urgent/ur_nope/send-draft', {}], ['POST', '/api/urgent/ur_nope/dismiss', {}],
      ['POST', '/api/review/ob_nope/approve', {}], ['POST', '/api/review/ob_nope/reject', {}], ['POST', '/api/discounts/dc_nope/approve', {}],
      ['POST', '/api/conversations/cv_nope/send', { text: 'hi' }], ['POST', '/api/conversations/cv_nope/pause', { minutes: 5 }],
      ['POST', '/api/contacts/ct_nope/opt-out', { opted_out: true }],
      ['POST', '/api/support/link', {}], ['DELETE', '/api/support/link'],
      ['POST', '/api/connections/brain/test', {}], ['POST', '/api/push/test', {}], ['POST', '/api/connections/shopify/test', {}],
    ];
    for (const [method, path, body] of notLocked) {
      const res = await api(path, { method, body });
      expect(res.status, `${method} ${path}`).not.toBe(423);
      expect(res.status, `${method} ${path}`).toBeLessThan(500);
    }
    expect((await api('/api/login', { as: 'public', body: { password: 'correct horse battery' } })).status).toBe(200);
    expect((await api('/api/logout', { as: 'public', body: {} })).status).toBe(200);
  });

  it("never touches the laptop or the agent's own work while everything is locked", async () => {
    const s = await sync();
    expect(s.status).toBe(200);
    expect(s.data.config.enabled).toBe(true);
    expect((await api('/api/agent/selectors', { as: 'device' })).status).toBe(200);
    expect((await api('/api/agent/diagnostics', { as: 'device', body: { channel: 'whatsapp', kind: 'note', data: { locks: 'test' } } })).status).toBe(200);
    expect((await cron()).status).toBe(200);
    // A customer still gets an answer: the agent's own work is never locked.
    const out = await inbound('whatsapp', `4477${Math.floor(Math.random() * 1e9)}@c.us`, [{ direction: 'in', body: 'hi how long is delivery', external_id: unique('lk') }]);
    expect(out.action).not.toBe('none');
  });

  it('unlocks with the right PIN, and the change goes through again', async () => {
    const before = (await api('/api/settings')).data.settings.voice.extra_rules;
    for (const id of SECTIONS) expect((await lock(id, false)).status, id).toBe(200);
    expect((await api('/api/locks')).data.locked).toEqual([]);
    const ok = await api('/api/settings/voice', { method: 'PUT', body: { extra_rules: before } });
    expect(ok.status).toBe(200);
    const header = (await ownerFetch('/api/locks')).headers.get('x-acx-locks');
    expect(JSON.parse(header!)).toEqual({ pin: true, locked: [] });
  });

  it('counts wrong PINs on the server and refuses every PIN check for 15 minutes after 5', async () => {
    await resetFails();
    for (let left = 4; left >= 1; left--) {
      const r = await lock('voice', true, '0000');
      expect(r.status).toBe(403);
      expect(r.data).toMatchObject({ error: 'wrong_pin', tries_left: left, message: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` });
    }
    const fifth = await lock('voice', true, '0000');
    expect(fifth.status).toBe(429);
    expect(fifth.data.error).toBe('pin_blocked');
    expect(fifth.data.message).toBe('Too many wrong PINs. Try again in 15 minutes.');
    // Blocked: even the right PIN is refused, for locking, unlocking and changing it.
    const right = await lock('voice', true);
    expect(right.status).toBe(429);
    expect((await api('/api/locks/pin', { body: { pin: '9999', old_pin: PIN } })).status).toBe(429);
    const f = await fails();
    expect(f.until).toBeGreaterThan(Date.now() + 14.5 * 60_000);
    expect(f.until).toBeLessThan(Date.now() + 15.5 * 60_000);
    expect((await api('/api/locks')).data.locked).toEqual([]);
    // Fifteen minutes later (the block's end moved into the past) the right PIN works and the count starts again.
    await sql(`UPDATE settings SET value = json_object('fails', 0, 'until', ?) WHERE key = 'state:lock_fails'`, [Date.now() - 1000]);
    expect((await lock('voice', true)).status).toBe(200);
    expect((await fails()).fails).toBe(0);
    expect((await lock('voice', false)).status).toBe(200);
  });

  it('counts guesses sent all at once: only 5 are ever checked', async () => {
    await resetFails();
    const all = await Promise.all(Array.from({ length: 8 }, () => lock('voice', true, '1357')));
    const codes = all.map((r) => r.status).sort();
    expect(codes.filter((s) => s === 403)).toHaveLength(4);
    expect(codes.filter((s) => s === 429)).toHaveLength(4);
    expect((await api('/api/locks')).data.locked).toEqual([]);
    await resetFails();
  });

  it('changes the PIN only with the old one', async () => {
    await resetFails();
    const wrong = await api('/api/locks/pin', { body: { pin: '13579', old_pin: '0000' } });
    expect(wrong.status).toBe(403);
    expect(wrong.data.error).toBe('wrong_pin');
    const changed = await api('/api/locks/pin', { body: { pin: '13579', old_pin: PIN } });
    expect(changed.status).toBe(200);
    expect((await lock('voice', true)).status).toBe(403); // the old PIN no longer works
    expect((await lock('voice', true, '13579')).status).toBe(200);
    expect((await lock('voice', false, '13579')).status).toBe(200);
    expect((await fails()).fails).toBe(0);
  });

  it('refuses an unknown box and a body without locked', async () => {
    const unknown = await api('/api/locks/sections/nope', { body: { locked: true, pin: '13579' } });
    expect(unknown.status).toBe(404);
    expect(unknown.data.error).toBe('unknown_section');
    expect((await api('/api/locks/sections/voice', { body: { pin: '13579' } })).status).toBe(400);
    expect((await api('/api/locks/sections/voice', { body: { locked: true, pin: '12' } })).status).toBe(400);
  });

  it('a PIN cleared by hand (the Forgotten PIN steps) unlocks everything and a new PIN can be set', async () => {
    expect((await lock('pacing', true, '13579')).status).toBe(200);
    expect((await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 4 } })).status).toBe(423);
    // docs/SETUP.md, "Forgot your PIN": the exact SQL the owner runs in the D1 console.
    await sql(`DELETE FROM settings WHERE key IN ('state:lock_pin', 'state:locks', 'state:lock_fails')`);
    expect((await api('/api/locks')).data).toMatchObject({ pin_set: false, locked: [] });
    expect((await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 4 } })).status).toBe(200);
    expect((await api('/api/locks/pin', { body: { pin: PIN } })).status).toBe(200);
  });

  it('hashes a new PIN with 10,000 rounds and still takes an older hash with its own count', async () => {
    const stored = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:lock_pin'`)).data.results[0].value);
    expect(stored.iterations).toBe(10_000);
    // A hash made with 40,000 rounds (the first build) keeps working.
    const salt = randomBytes(16);
    const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const old = { hash: b64url(pbkdf2Sync('97531', salt, 40_000, 32, 'sha256')), salt: b64url(salt), iterations: 40_000, set_at: 1 };
    await sql(`UPDATE settings SET value = ? WHERE key = 'state:lock_pin'`, [JSON.stringify(old)]);
    await resetFails();
    expect((await lock('sales', true, '97531')).status).toBe(200);
    expect((await lock('sales', false, '97531')).status).toBe(200);
    // Changing it hashes the new one with the cheaper count.
    expect((await api('/api/locks/pin', { body: { pin: PIN, old_pin: '97531' } })).status).toBe(200);
    expect(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:lock_pin'`)).data.results[0].value).iterations).toBe(10_000);
  });

  it('with the reminder message locked, who gets it cannot change through the reminder settings either', async () => {
    const before = (await api('/api/settings')).data.settings.recovery;
    const other = before.consent_mode === 'all' ? 'opted_in' : 'all';
    expect((await lock('recovery_message', true)).status).toBe(200);
    const res = await api('/api/settings/recovery', { method: 'PUT', body: { consent_mode: other, enabled: before.enabled } });
    expect(res.status).toBe(200); // the reminder settings box is not locked
    expect(res.data.recovery.consent_mode).toBe(before.consent_mode);
    expect((await api('/api/settings')).data.settings.recovery.consent_mode).toBe(before.consent_mode);
    expect((await lock('recovery_message', false)).status).toBe(200);
    // Unlocked too: who gets it is only ever chosen when the message is approved (PUT /api/recovery/template).
    expect((await api('/api/settings/recovery', { method: 'PUT', body: { consent_mode: other } })).data.recovery.consent_mode).toBe(before.consent_mode);
  });

  it('with Knowledge locked an Urgent answer or note still goes out, but nothing is saved to Knowledge', async () => {
    await api('/api/agent-toggle', { body: { enabled: true } });
    const escalated = async () => {
      const res = await inbound('whatsapp', `${unique('4479')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: 'unknown-question can I get a refund' }]);
      expect(res.action).toBe('escalate');
      for (const job of res.jobs) await finish(job.id, { status: 'sent' });
      return (await sql(`SELECT id FROM urgent WHERE conversation_id = ? AND status = 'open'`, [res.conversation_id])).data.results[0].id as string;
    };
    const learnedFor = async (id: string) => (await sql(`SELECT id FROM kb_docs WHERE source = 'learned' AND source_ref = ?`, [id])).data.results;
    const docs = async () => (await sql(`SELECT COUNT(*) AS n FROM kb_docs`)).data.results[0].n as number;
    expect((await lock('knowledge', true)).status).toBe(200);
    const before = await docs();

    const a = await escalated();
    const answered = await api(`/api/urgent/${a}/answer`, { body: { answer: 'Refunds take 5 working days once the parcel is back with us', learn: true } });
    expect(answered.status).toBe(200);
    expect(answered.data).toMatchObject({ ok: true, learned: false, knowledge_locked: true });
    expect((await sql(`SELECT COUNT(*) AS n FROM outbox WHERE source = 'urgent' AND ref_id = ?`, [a])).data.results[0].n).toBe(1);

    const b = await escalated();
    const noted = await api(`/api/urgent/${b}/note`, { body: { note: 'the 72v batteries are back in stock on Friday', remember: true } });
    expect(noted.status).toBe(200);
    expect(noted.data).toMatchObject({ ok: true, learned: false, kb_doc_id: null, knowledge_locked: true });
    expect(noted.data.parts.length).toBeGreaterThan(0);

    expect(await learnedFor(a)).toEqual([]);
    expect(await learnedFor(b)).toEqual([]);
    expect(await docs()).toBe(before);
    // Not asked to remember: nothing to say.
    const c = await escalated();
    expect((await api(`/api/urgent/${c}/answer`, { body: { answer: 'Yes we can', learn: false } })).data.knowledge_locked).toBe(false);
    expect((await lock('knowledge', false)).status).toBe(200);
  });
});
