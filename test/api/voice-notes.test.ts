// Customer voice notes: captured by the laptop as a small media item, written out by the free Cloudflare
// AI (a fake speech endpoint here, test mode only: test/helpers/fake-speech.mjs), answered by the brain
// from the transcript and shown to the owner. When it cannot be written out, nothing changes from before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, inbound, sql, unique } from '../helpers/client';
// @ts-expect-error plain JS helper
import { makeVoiceNote, startFakeSpeech } from '../helpers/fake-speech.mjs';

const LIMIT = 45;
let fake: { url: string; requests: { said: string; bytes: number; head: string }[]; stop: () => Promise<void> };
const today = () => new Date().toISOString().slice(0, 10);

const voice = (text: string, extra: Record<string, unknown> = {}) => ({
  external_id: unique('m'), direction: 'in' as const, body: '', kind: 'voice', ts: Date.now(),
  media: { kind: 'voice', mime: 'audio/ogg; codecs=opus', data: makeVoiceNote(text), seconds: 4, ...extra },
});
const conv = async (thread: string) => (await sql('SELECT id FROM conversations WHERE external_thread_id = ?', [thread])).data.results[0]?.id as string;
const mediaOf = async (thread: string) => (await sql(
  `SELECT md.kind, md.mime, md.description, md.vision, m.meta FROM media md JOIN messages m ON m.id = md.message_id JOIN conversations cv ON cv.id = md.conversation_id WHERE cv.external_thread_id = ?`, [thread])).data.results;

beforeAll(async () => {
  fake = await startFakeSpeech();
  await api('/api/test/speech-base', { as: 'public', body: { url: fake.url } });
});
afterAll(async () => {
  await api('/api/test/speech-base', { as: 'public', body: { url: null } });
  await sql(`DELETE FROM settings WHERE key = 'state:ai_state'`);
  await fake.stop();
});
beforeEach(async () => { await sql(`DELETE FROM settings WHERE key = 'state:ai_state'`); });

describe('voice notes', () => {
  it('writes out a voice note, answers it and shows the owner what it said', async () => {
    const thread = unique('vn');
    // A message before it that the server already knows, then the voice note on its own.
    const r = await inbound('whatsapp', thread, [voice('how long is delivery to Leeds')]);
    expect(r.action).toBe('reply');
    // The brain read the transcript as the customer's words.
    expect(r.jobs[0]!.parts.join(' ')).toBe('Mock reply to: how long is delivery to Leeds');
    expect(fake.requests.at(-1)).toMatchObject({ said: 'how long is delivery to Leeds', head: 'OggS' });
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);

    const [row] = await mediaOf(thread);
    expect(row).toMatchObject({ kind: 'voice', mime: 'audio/ogg', description: 'how long is delivery to Leeds' });
    expect(JSON.parse(row.vision)).toMatchObject({ model: '@cf/openai/whisper-large-v3-turbo', seconds: 4.2, tries: 1, language: 'en' });
    expect(JSON.parse(row.meta)).toMatchObject({ media_kind: 'voice', voice_text: 'how long is delivery to Leeds' });

    // Counted against the free allowance: 4.2 s at about 46.63 neurons a minute.
    const ai = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:ai_state'`)).data.results[0].value);
    expect(ai.day).toBe(today());
    expect(ai.used).toBeCloseTo((4.2 / 60) * 46.63, 1);
    const usage = (await sql(`SELECT provider, model, ok FROM llm_usage WHERE purpose = 'voice_note' ORDER BY id DESC LIMIT 1`)).data.results[0];
    expect(usage).toMatchObject({ provider: 'workers_ai', model: '@cf/openai/whisper-large-v3-turbo', ok: 1 });

    // The owner sees it under the message in Inbox, with no thumbnail.
    const thread_ = (await api(`/api/conversations/${await conv(thread)}`)).data;
    const msg = thread_.messages.find((m: any) => m.kind === 'voice');
    expect(msg.voice).toEqual({ transcript: 'how long is delivery to Leeds' });
    expect(msg.media).toBeNull();

    // Posted again (a retry): written out once only.
    const calls = fake.requests.length;
    await inbound('whatsapp', thread, [{ ...voice('how long is delivery to Leeds'), external_id: (await sql('SELECT external_id FROM messages WHERE conversation_id = ?', [await conv(thread)])).data.results[0].external_id }]);
    expect(fake.requests.length).toBe(calls);
  });

  it('keeps what an earlier voice note said when the customer writes again', async () => {
    const thread = unique('vh');
    const first = await inbound('whatsapp', thread, [voice('do you deliver the 1000W kit to Ireland')]);
    expect(first.action).toBe('reply');
    // The reply went out, then the customer types a follow up that only makes sense with the voice note.
    await sql(`UPDATE outbox SET status = 'sent' WHERE conversation_id = ? AND status IN ('pending', 'leased')`, [first.conversation_id]);
    await sql(`INSERT INTO messages (id, conversation_id, direction, author, external_id, body, kind, status, outbox_id, meta, ts, created_at) VALUES (?, ?, 'out', 'agent', ?, 'Yes we deliver to Ireland', 'text', 'sent', NULL, '{}', ?, ?)`,
      [unique('mo'), first.conversation_id, unique('x'), Date.now(), Date.now()]);
    const calls = fake.requests.length;
    const r = await inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: 'show-voice and the 750?', ts: Date.now() + 1000 }]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts.join(' ')).toBe('Mock heard 1 voice note: do you deliver the 1000W kit to Ireland');
    // Read from the stored message: not written out again, and no extra query for it.
    expect(fake.requests.length).toBe(calls);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
  });

  it('puts the transcript on the Urgent card when the owner has to answer', async () => {
    const thread = unique('vu');
    const r = await inbound('whatsapp', thread, [voice('unknown-question is the warranty valid on the moon')]);
    expect(r.action).toBe('escalate');
    const card = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === (r.conversation_id));
    expect(card.customer_message).toContain('[voice note] unknown-question is the warranty valid on the moon');
    expect(card.recent.find((m: any) => m.kind === 'voice').voice).toEqual({ transcript: 'unknown-question is the warranty valid on the moon' });
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
  });

  it('keeps today\'s behaviour when it cannot be written out', async () => {
    const silent = async (thread: string) => {
      const card = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === (thread));
      expect(card).toBeTruthy();
      expect(card.category).toBe('media');
      expect(card.reason).toBe('The agent cannot listen to voice notes');
    };
    // The speech model fails: owner asked silently, nothing sent, failure noted.
    let r = await inbound('whatsapp', unique('vf'), [voice('FAIL please call me')]);
    expect(r.action).toBe('escalate');
    expect(r.jobs).toEqual([]);
    await silent(r.conversation_id!);
    const note = (await sql(`SELECT data FROM diagnostics WHERE kind = 'note' AND data LIKE '%voice_error%' ORDER BY id DESC LIMIT 1`)).data.results[0];
    expect(JSON.parse(note.data)).toMatchObject({ voice_error: 'failed' });

    // Too long: never sent to the speech model.
    let calls = fake.requests.length;
    r = await inbound('whatsapp', unique('vl'), [voice('a very long story', { seconds: 300 })]);
    expect(r.action).toBe('escalate');
    expect(fake.requests.length).toBe(calls);
    await silent(r.conversation_id!);

    // The free allowance used up today: not sent either.
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:ai_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ day: today(), used: 10_000, out_at: Date.now() }), Date.now()]);
    calls = fake.requests.length;
    r = await inbound('whatsapp', unique('vo'), [voice('hello there')]);
    expect(r.action).toBe('escalate');
    expect(fake.requests.length).toBe(calls);
    await silent(r.conversation_id!);
    await sql(`DELETE FROM settings WHERE key = 'state:ai_state'`);

    // A daily limit error from Cloudflare: used up until 00:00 UTC, and the note goes to the owner.
    r = await inbound('whatsapp', unique('vd'), [voice('LIMIT hello')]);
    expect(r.action).toBe('escalate');
    await silent(r.conversation_id!);
    const ai = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:ai_state'`)).data.results[0].value);
    expect(ai.out_at).toBeGreaterThan(0);
    await sql(`DELETE FROM settings WHERE key = 'state:ai_state'`);

    // Not audio at all: dropped, the message kept, the owner asked as before.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]).toString('base64');
    r = await inbound('whatsapp', unique('vj'), [{ ...voice('x'), media: { kind: 'voice', mime: 'audio/ogg', data: jpeg } }]);
    expect(r.action).toBe('escalate');
    await silent(r.conversation_id!);
    const rejected = (await sql(`SELECT data FROM diagnostics WHERE data LIKE '%media_rejected%' ORDER BY id DESC LIMIT 1`)).data.results[0];
    expect(JSON.parse(rejected.data)).toEqual({ media_rejected: ['not_audio'] });

    // An older laptop that sends no audio: as before.
    r = await inbound('whatsapp', unique('vx'), [{ external_id: unique('m'), direction: 'in', body: '', kind: 'voice', ts: Date.now() }]);
    expect(r.action).toBe('escalate');
    await silent(r.conversation_id!);
  });

  it('answers the words around a voice note it could not write out, as before', async () => {
    const r = await inbound('whatsapp', unique('vw'), [voice('FAIL'), { external_id: unique('m'), direction: 'in', body: 'what time do you close', ts: Date.now() }]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts.join(' ')).toBe('Mock reply to: what time do you close');
  });
});
