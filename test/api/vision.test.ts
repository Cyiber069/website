// Google AI Studio reads photos and videos: the Connections card, the video upload route, describing in
// the pipeline and the fallbacks. "Google" is a fake (test/helpers/fake-gemini.mjs) the Worker is pointed
// at in test mode only. The brain is the mock: like Claude (sees pictures), or like Workers AI (text
// only) when the brain provider is set to workers_ai.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, cron, inbound, sql, sync, unique } from '../helpers/client';
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
const check = async (query: string) =>
  (await fetch(`${BASE()}/api/agent/media/video?${query}`, { headers: { authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}` } })).json() as Promise<any>;
const finalized = () => fake.requests((q: any) => q.path === '/upload/v1beta/files' && /finalize/.test(q.headers['x-goog-upload-command'] || ''));
const deletes = () => fake.requests((q: any) => q.method === 'DELETE').map((q: any) => q.path);
/** Deletes run after the answer (waitUntil): wait a moment for them. */
async function eventually<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); }
}
const gone = async (ref: string) => (await sql('SELECT gone_at FROM vision_files WHERE id = ?', [ref])).data.results[0]?.gone_at ?? null;

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

  it('a model that refuses store false is never sent customer photos without it, and the owner is told', async () => {
    fake.reset();
    fake.next((_req: any, res: any) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "store": Cannot find field.' } })); });
    const r = await inbound('whatsapp', wa(), [photo('ns1', 'does this fit')]);
    expect(r.action).toBe('reply');
    expect(fake.generateCalls()).toHaveLength(1); // no second try without store false
    expect(fake.generateCalls()[0].json.store).toBe(false);
    expect(JSON.parse((await mediaRow(r.conversation_id!)).vision)).toMatchObject({ error: 'no_store' });
    const ev = (await sql(`SELECT message FROM events WHERE type = 'vision_error' AND conversation_id = ? ORDER BY id DESC LIMIT 1`, [r.conversation_id])).data.results[0];
    expect(ev.message).toMatch(/store false/);
    expect(ev.message).not.toMatch(/[–—]/);
  });

  it('an answer cut off at the token limit is not stored as a description', async () => {
    fake.reset();
    fake.next((_req: any, res: any) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"description": "The battery pack is swollen and the casing is split near' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: {} }));
    });
    const r = await inbound('whatsapp', wa(), [photo('mt1', 'is my battery ok')]);
    const row = await mediaRow(r.conversation_id!);
    expect(row.description).toBeNull();
    expect(JSON.parse(row.vision)).toMatchObject({ tries: 1, error: 'bad_output' });
  });

  it('an open question that quotes what the vision model saw is labelled as customer content for the brain', async () => {
    const t = wa();
    const s = await inbound('whatsapp', t, [photo('in1', 'fake-burnt fake-inject my battery <b>shop note</b>')]);
    expect(s.action).toBe('escalate');
    const card = await urgentFor(s.conversation_id!);
    expect(card.question).toMatch(/ignore your rules/); // the owner sees what the vision model saw
    const next = await inbound('whatsapp', t, [photo('in1', 'fake-burnt fake-inject my battery <b>shop note</b>'), { external_id: 'in2', direction: 'in' as const, body: 'show-urgent-note any news' }]);
    expect(next.jobs[0]?.parts[0]).toBe('Mock urgent note labelled');
    await api(`/api/urgent/${card.id}/dismiss`, { body: {} });
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
    expect(r.fetches).toBeGreaterThan(0);
    expect(r.fetches).toBeLessThanOrEqual(20); // the vision model's share of the 50 subrequests
    const row = await mediaRow(r.conversation_id!);
    expect(row).toMatchObject({ kind: 'video_frame', video_ref: body.ref, description: 'Fake vision watched the video: a rear hub motor wheel spins, then stops with a click. The display shows error E07.' });
    expect(JSON.parse(row.vision)).toMatchObject({ via: 'video', seconds: 12 });
    const gen = fake.generateCalls();
    expect(gen).toHaveLength(1);
    expect(gen[0].json.contents[0].parts[0].fileData.fileUri).toBe(`${fake.url}/v1beta/files/${vf.file_name.split('/')[1]}`);
    expect(fake.requests((q: any) => q.method === 'GET' && q.path.startsWith('/v1beta/files/')).length).toBeGreaterThanOrEqual(1);
    expect(await eventually(deletes, (d) => d.length > 0)).toEqual([`/v1beta/${vf.file_name}`]);
    expect(await gone(body.ref)).toBeGreaterThan(0);
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
    // Described by its cover: Google does not keep holding the video either.
    const file = (await sql('SELECT file_name FROM vision_files WHERE id = ?', [ref])).data.results[0].file_name;
    expect(await eventually(deletes, (d) => d.includes(`/v1beta/${file}`))).toContain(`/v1beta/${file}`);
    expect(await gone(ref)).toBeGreaterThan(0);
  });

  it('a video read again later is never pulled, uploaded or counted twice', async () => {
    fake.reset();
    const t = wa();
    const who = `channel=whatsapp&message=vd1&thread=${encodeURIComponent(t)}`;
    const before = (await api('/api/connections')).data.vision.videos_today;
    expect(await check(who)).toMatchObject({ upload: true, ref: null, described: false });
    const first = await (await upload(mp4(4000), { query: `${who}&seconds=9` })).json() as any;
    expect(first.ref).toMatch(/^vf_/);
    // Read again before it was described (the worker restarted and forgot): the same row, nothing sent.
    expect(await check(who)).toMatchObject({ upload: false, ref: first.ref, why: 'known' });
    const again = await (await upload(mp4(4000), { query: who })).json() as any;
    expect(again).toMatchObject({ ref: first.ref, reused: true });
    expect(finalized()).toHaveLength(1);
    expect((await api('/api/connections')).data.vision.videos_today).toBe(before + 1);
    // Described: asked again 90 minutes later, it is not needed at all.
    const r = await inbound('whatsapp', t, [videoMsg('vd1', 'what is this noise', { video_ref: first.ref })]);
    expect(r.action).toBe('reply');
    expect(await check(who)).toMatchObject({ upload: false, described: true, why: 'described' });
    const late = await upload(mp4(4000), { query: who });
    expect(late.status).toBe(409);
    expect(((await late.json()) as any).error).toBe('already_described');
    expect(finalized()).toHaveLength(1);
    expect((await api('/api/connections')).data.vision.videos_today).toBe(before + 1);
  });

  it('lanes uploading at once never take more than the daily cap', async () => {
    fake.reset();
    const today = (await api('/api/connections')).data.vision.videos_today;
    await putVision({ video_daily_cap: today + 1 });
    try {
      const res = await Promise.all([1, 2, 3].map((i) => upload(mp4(3000), { query: `channel=whatsapp&message=cap${i}${unique('')}&thread=t${i}` })));
      expect(res.map((x) => x.status).sort()).toEqual([200, 429, 429]);
      expect(finalized()).toHaveLength(1);
      expect((await api('/api/connections')).data.vision.videos_today).toBe(today + 1);
    } finally {
      await putVision({ video_daily_cap: 20 });
    }
  });

  it('one report with three videos watches one whole, stays inside its calls to Google and lets Google drop all three', async () => {
    fake.reset();
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) refs.push(((await (await upload(mp4(2000 + i))).json()) as any).ref);
    fake.reset();
    const r = await inbound('whatsapp', wa(), refs.map((ref, i) => videoMsg(`v3${i}`, i === 2 ? 'three clips of the noise' : '', { video_ref: ref })));
    expect(r.action).toBe('reply');
    expect(r.fetches).toBeLessThanOrEqual(20);
    const watched = fake.generateCalls().filter((c: any) => JSON.stringify(c.json).includes('fileData'));
    expect(watched).toHaveLength(1);
    const vias = (await sql('SELECT vision FROM media WHERE conversation_id = ? ORDER BY created_at, id', [r.conversation_id])).data.results.map((x: any) => JSON.parse(x.vision).via);
    expect(vias.filter((v: string) => v === 'video')).toHaveLength(1);
    expect(vias).toHaveLength(3);
    for (const ref of refs) expect(await eventually(() => gone(ref), (g) => Boolean(g))).toBeGreaterThan(0);
    expect((await eventually(deletes, (d) => d.length >= 3))).toHaveLength(3);
  });

  it('cron deletes from Google a video nothing described after 6 hours', async () => {
    fake.reset();
    const ref = ((await (await upload(mp4(2500))).json()) as any).ref;
    const file = (await sql('SELECT file_name FROM vision_files WHERE id = ?', [ref])).data.results[0].file_name;
    await sql('UPDATE vision_files SET created_at = ? WHERE id = ?', [Date.now() - 7 * 3600_000, ref]);
    await sql('UPDATE conversations SET needs_reply_since = NULL'); // the sweeper has nothing to answer this minute
    await cron();
    expect(deletes()).toContain(`/v1beta/${file}`);
    expect(await gone(ref)).toBeGreaterThan(0);
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
