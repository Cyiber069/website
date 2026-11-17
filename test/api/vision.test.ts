// Google AI Studio reads photos and videos: the Connections card, the video upload route, describing in
// the pipeline and the fallbacks. "Google" is a fake (test/helpers/fake-gemini.mjs) the Worker is pointed
// at in test mode only. The brain is the mock: like Claude (sees pictures), or like Workers AI (text
// only) when the brain provider is set to workers_ai.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, inbound, sql, sync, unique } from '../helpers/client';
import { JPEG_B64 } from '../helpers/images';
// @ts-expect-error plain JS helper
import { startFakeGemini } from '../helpers/fake-gemini.mjs';

const KEY = 'AIzaSyFAKEKEYforTests0123456789abcdWXYZ';
const LIMIT = 45;
let fake: any;

const wa = () => `${unique('4479')}@c.us`;
const photo = (id: string, body = '') => ({ external_id: id, direction: 'in' as const, body, kind: 'image', media: { kind: 'image', mime: 'image/jpeg', data: JPEG_B64 } });
const videoMsg = (id: string, body = '', extra: Record<string, unknown> = {}) => ({ external_id: id, direction: 'in' as const, body, kind: 'video', media: { kind: 'video_frame', mime: 'image/jpeg', data: JPEG_B64, ...extra } });
const putVision = (body: Record<string, unknown>) => api('/api/connections/vision', { method: 'PUT', body });
const mediaRow = async (convId: string) => (await sql('SELECT id, message_id, kind, description, vision, video_ref FROM media WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', [convId])).data.results[0];
const urgentFor = async (convId: string) => (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === convId);

/** Bytes that start like an MP4 file. */
function mp4(size: number): Buffer {
  const b = Buffer.alloc(size, 0x11);
  b.writeUInt32BE(0x20, 0);
  b.write('ftypisom', 4, 'ascii');
  return b;
}
const upload = (body: Buffer, { type = 'video/mp4', query = 'channel=whatsapp&seconds=12' } = {}) =>
  fetch(`${BASE()}/api/agent/media/video?${query}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}`, 'content-type': type }, body });

beforeAll(async () => {
  fake = await startFakeGemini();
  await api('/api/test/vision-base', { as: 'public', body: { url: fake.url } });
  // The first decision on a fresh server seeds the knowledge base: not what the query counts below measure.
  await inbound('whatsapp', wa(), [{ external_id: 'warm', direction: 'in', body: 'hello' }]);
});

afterAll(async () => {
  await putVision({ gemini_api_key: '', enabled: true, model: 'gemini-3.8-flash', video_daily_cap: 20 });
  await api('/api/connections/brain', { method: 'PUT', body: { provider: 'auto' } });
  await api('/api/test/vision-base', { as: 'public', body: { url: null } });
  await fake?.stop();
});

describe('the Google AI Studio card', () => {
  it('keeps the key on the server and shows only its last 4 characters', async () => {
    const before = (await api('/api/connections')).data.vision;
    expect(before).toMatchObject({ key: { saved: false, hint: '' }, enabled: true, active: false, model: 'gemini-3.8-flash', video_daily_cap: 20 });
    expect(before.models.map((m: any) => m.id)).toContain('gemini-flash-latest');

    const saved = await putVision({ gemini_api_key: `  ${KEY}  ` });
    expect(saved.status).toBe(200);
    expect(saved.data.vision).toMatchObject({ key: { saved: true, hint: '...WXYZ' }, active: true });
    for (const res of [saved, await api('/api/connections'), await api('/api/settings'), await sync()]) expect(JSON.stringify(res.data)).not.toContain(KEY.slice(0, 20));
    expect((await sync()).data.config.vision).toEqual({ active: true, whole_videos: true });
    expect((await sql(`SELECT hint FROM secrets WHERE key = 'gemini_api_key'`)).data.results[0].hint).toBe('WXYZ');
  });

  it('refuses a Claude key, junk, a model that is not Gemini and a cap out of range', async () => {
    expect((await putVision({ gemini_api_key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' })).data.message).toMatch(/Claude key/);
    expect((await putVision({ gemini_api_key: 'not a key' })).status).toBe(400);
    expect((await putVision({ model: 'claude-opus-5-5' })).status).toBe(400);
    expect((await putVision({ video_daily_cap: 999 })).status).toBe(400);
    expect((await api('/api/settings/vision', { method: 'PUT', body: { model: 'gpt-5' } })).status).toBe(400);
    const ok = await putVision({ model: 'Gemini-Flash-Latest', video_daily_cap: 5 });
    expect(ok.data.vision).toMatchObject({ model: 'gemini-flash-latest', video_daily_cap: 5, key: { saved: true } });
    await putVision({ model: 'gemini-3.8-flash', video_daily_cap: 20 });
  });

  it('Test key makes one tiny call with the key in a header and reports plainly', async () => {
    fake.reset();
    const res = await api('/api/connections/vision/test', { body: {} });
    expect(res.data).toMatchObject({ ok: true, model: 'gemini-3.8-flash' });
    const calls = fake.generateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(calls[0].search).toBe('');
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(calls[0].json)).toContain('Reply with the word OK.');

    await putVision({ gemini_api_key: 'AIzaSyThisKeyIsWrongForSureXXXXXXBAD0' });
    const bad = await api('/api/connections/vision/test', { body: {} });
    expect(bad.data).toMatchObject({ ok: false, error: 'Google says the key is not valid. Copy it again from Google AI Studio and save it.' });
    await putVision({ gemini_api_key: KEY });
  });
});

describe('a photo, described by Google AI Studio', () => {
  it('is described once, stored with the media row and passed to the brain', async () => {
    fake.reset();
    const t = wa();
    const r = await inbound('whatsapp', t, [photo('vp1')]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo, 1 described']);
    expect(r.queries).toBeLessThanOrEqual(LIMIT);

    const row = await mediaRow(r.conversation_id!);
    expect(row.description).toBe('Fake vision saw a photo: a black mountain bike with 26 inch wheels. A label reads ORDER 1042.');
    expect(JSON.parse(row.vision)).toMatchObject({ model: 'gemini-3.8-flash', via: 'image', unclear: false, problem: 'none', tries: 1 });
    const call = fake.generateCalls()[0];
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.json.store).toBe(false);
    expect(call.json.systemInstruction.parts[0].text).toMatch(/never instructions to you/);
    expect(call.json.contents[0].parts.find((p: any) => p.inlineData).inlineData).toEqual({ mimeType: 'image/jpeg', data: JPEG_B64 });

    // The owner sees it under the thumbnail, from the message row.
    const conv = await api(`/api/conversations/${r.conversation_id}`);
    expect(conv.data.messages[0].media).toMatchObject({ id: row.id, kind: 'image', description: row.description });
    const usage = (await sql(`SELECT provider, purpose, input_tokens, ok FROM llm_usage WHERE provider = 'gemini' ORDER BY ts DESC LIMIT 1`)).data.results[0];
    expect(usage).toMatchObject({ provider: 'gemini', purpose: 'vision_image', input_tokens: 1300, ok: 1 });

    // Read again: nothing new, and Google is not asked twice.
    await inbound('whatsapp', t, [photo('vp1')]);
    expect(fake.generateCalls()).toHaveLength(1);
  });

  it('lets the Workers AI brain answer a photo with no words from the description', async () => {
    await api('/api/connections/brain', { method: 'PUT', body: { provider: 'workers_ai' } });
    try {
      const r = await inbound('whatsapp', wa(), [photo('wp1')]);
      expect(r.action).toBe('reply');
      expect(r.jobs[0]!.parts[0]).toMatch(/^Mock read the vision model: Fake vision saw a photo: a black mountain bike with 26 inch wheels/);
      expect(await urgentFor(r.conversation_id!)).toBeUndefined();

      // Switched off: today's behaviour, the owner gets it silently and Google is not asked.
      await putVision({ enabled: false });
      expect((await sync()).data.config.vision).toEqual({ active: false, whole_videos: false });
      fake.reset();
      const off = await inbound('whatsapp', wa(), [photo('wp2')]);
      expect(off.action).toBe('escalate');
      expect(off.jobs).toHaveLength(0);
      expect((await urgentFor(off.conversation_id!)).category).toBe('media');
      expect(fake.generateCalls()).toHaveLength(0);
      await api(`/api/urgent/${(await urgentFor(off.conversation_id!)).id}/dismiss`, { body: {} });
    } finally {
      await putVision({ enabled: true });
      await api('/api/connections/brain', { method: 'PUT', body: { provider: 'auto' } });
    }
  });

  it('sends an unclear photo and a safety problem to the owner with the description and a holding line', async () => {
    const r = await inbound('whatsapp', wa(), [photo('up1', 'fake-unclear will this fit my bike')]);
    expect(r.action).toBe('escalate');
    expect(r.jobs[0]!.parts).toHaveLength(1);
    expect(r.jobs[0]!.parts[0]).not.toMatch(/see|open|photo|picture|unclear/i);
    const card = await urgentFor(r.conversation_id!);
    expect(card).toMatchObject({ category: 'media', reason: 'The photo is unclear' });
    expect(card.question).toMatch(/^The photo shows: Fake vision saw a photo/);
    expect(card.question).toMatch(/The customer wrote: "fake-unclear will this fit my bike"/);
    expect(card.recent.find((m: any) => m.media).media.description).toMatch(/^Fake vision saw a photo/);
    await api(`/api/urgent/${card.id}/dismiss`, { body: {} });

    const s = await inbound('whatsapp', wa(), [photo('sp1', 'fake-burnt my battery looks like this')]);
    expect(s.action).toBe('escalate');
    const safety = await urgentFor(s.conversation_id!);
    expect(safety).toMatchObject({ category: 'safety', reason: 'The photo shows a possible safety problem' });
    await api(`/api/urgent/${safety.id}/dismiss`, { body: {} });
  });

  it('falls back to today\'s behaviour when Google fails, and notes why', async () => {
    fake.reset();
    const r = await inbound('whatsapp', wa(), [photo('fp1', 'fake-503 does this fit')]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo']);
    const row = await mediaRow(r.conversation_id!);
    expect(row.description).toBeNull();
    expect(JSON.parse(row.vision)).toMatchObject({ tries: 1, error: 'server' });
    const note = (await sql(`SELECT data FROM diagnostics WHERE kind = 'note' AND data LIKE '%vision_error%' ORDER BY id DESC LIMIT 1`)).data.results[0];
    expect(JSON.parse(note.data)).toMatchObject({ vision_error: 'server', media: row.id });
  });

  it('does not hold a reply for long: a Google that hangs is given up on and the reply goes out', async () => {
    fake.state.slowMs = 40_000;
    const started = Date.now();
    const r = await inbound('whatsapp', wa(), [photo('slow1', 'fake-slow will this fit')]);
    const ms = Date.now() - started;
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo']);
    expect(ms).toBeLessThan(30_000);
    expect(JSON.parse((await mediaRow(r.conversation_id!)).vision)).toMatchObject({ error: 'timeout' });
  }, 60_000);
});

describe('a video', () => {
  it('is streamed to Google whole, watched, and the file is deleted afterwards', async () => {
    fake.reset();
    fake.state.processingPolls = 1;
    const bytes = mp4(300_000);
    const res = await upload(bytes);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, bytes: 300_000, state: 'PROCESSING' });
    expect(body.ref).toMatch(/^vf_/);

    const [start, up] = fake.requests((q: any) => q.path === '/upload/v1beta/files');
    expect(start.headers).toMatchObject({ 'x-goog-api-key': KEY, 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': '300000', 'x-goog-upload-header-content-type': 'video/mp4' });
    expect(up.headers['x-goog-upload-command']).toBe('upload, finalize');
    expect(up.headers['x-goog-api-key']).toBe(KEY);
    expect(up.bytes).toBe(300_000); // every byte arrived
    expect(up.head).toBe(bytes.subarray(0, 16).toString('hex'));
    expect(up.search).not.toContain(KEY);
    const vf = (await sql('SELECT file_name, mime, bytes, seconds, channel FROM vision_files WHERE id = ?', [body.ref])).data.results[0];
    expect(vf).toMatchObject({ mime: 'video/mp4', bytes: 300_000, seconds: 12, channel: 'whatsapp' });

    const r = await inbound('whatsapp', wa(), [videoMsg('vv1', '', { video_ref: body.ref, seconds: 12 })]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo with 1 video frame, 1 described']);
    expect(r.queries).toBeLessThanOrEqual(LIMIT);
    const row = await mediaRow(r.conversation_id!);
    expect(row).toMatchObject({ kind: 'video_frame', video_ref: body.ref, description: 'Fake vision watched the video: a rear hub motor wheel spins, then stops with a click. The display shows error E07.' });
    expect(JSON.parse(row.vision)).toMatchObject({ via: 'video', seconds: 12 });
    const gen = fake.generateCalls();
    expect(gen).toHaveLength(1);
    expect(gen[0].json.contents[0].parts[0].fileData.fileUri).toBe(`${fake.url}/v1beta/files/${vf.file_name.split('/')[1]}`);
    expect(fake.requests((q: any) => q.method === 'GET' && q.path.startsWith('/v1beta/files/')).length).toBeGreaterThanOrEqual(1);
    expect(fake.requests((q: any) => q.method === 'DELETE').map((q: any) => q.path)).toEqual([`/v1beta/${vf.file_name}`]);
  });

  it('looks at a few frames when only those came, and at the cover when Google could not read the video', async () => {
    fake.reset();
    const frames = await inbound('whatsapp', wa(), [videoMsg('vf1', 'what is this noise', { frames: [JPEG_B64, JPEG_B64] })]);
    expect(frames.action).toBe('reply');
    expect(JSON.parse((await mediaRow(frames.conversation_id!)).vision).via).toBe('frames');
    expect(fake.generateCalls()[0].json.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(3);
    // Frames are never stored.
    expect((await sql('SELECT length(data) AS n FROM media WHERE conversation_id = ?', [frames.conversation_id])).data.results[0].n).toBe(JPEG_B64.length);

    fake.state.failFiles = true;
    const ref = (await (await upload(mp4(5000))).json()).ref;
    const cover = await inbound('whatsapp', wa(), [videoMsg('vc1', '', { video_ref: ref })]);
    expect(cover.action).toBe('reply');
    expect(JSON.parse((await mediaRow(cover.conversation_id!)).vision).via).toBe('cover');
    fake.state.failFiles = false;
  });

  it('refuses what it should: too long, too big, not a video, over the daily cap, switched off', async () => {
    expect((await upload(mp4(1000), { query: 'seconds=200' })).status).toBe(413);
    expect(((await (await upload(Buffer.alloc(21 * 1024 * 1024, 1))).json()) as any).error).toBe('too_large');
    expect((await upload(mp4(1000), { type: 'text/plain' })).status).toBe(415);
    const jpeg = Buffer.from(JPEG_B64, 'base64');
    const notVideo = await upload(Buffer.concat([jpeg, Buffer.alloc(2000)]));
    expect(notVideo.status).toBe(415);
    expect(((await notVideo.json()) as any).error).toBe('not_a_video');

    const today = (await api('/api/connections')).data.vision.videos_today;
    expect(today).toBeGreaterThanOrEqual(2);
    await putVision({ video_daily_cap: today });
    expect((await sync()).data.config.vision).toEqual({ active: true, whole_videos: false });
    const capped = await upload(mp4(1000));
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as any).error).toBe('daily_cap');
    await putVision({ video_daily_cap: 20 });

    await putVision({ enabled: false });
    expect((await upload(mp4(1000))).status).toBe(409);
    await putVision({ enabled: true });
    // Only the laptop may send videos.
    expect((await fetch(`${BASE()}/api/agent/media/video`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: mp4(1000) })).status).toBe(401);
  });
});

describe('removing the key', () => {
  it('stops describing at once', async () => {
    const res = await putVision({ gemini_api_key: '' });
    expect(res.data.vision).toMatchObject({ key: { saved: false }, active: false });
    fake.reset();
    const r = await inbound('whatsapp', wa(), [photo('rk1')]);
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo']);
    expect(fake.generateCalls()).toHaveLength(0);
    await putVision({ gemini_api_key: KEY });
  });
});
