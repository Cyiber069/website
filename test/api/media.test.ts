// Photos and video frames: stored from /api/agent/inbound, shown to the brain, served to the owner only.
import { describe, expect, it } from 'vitest';
import { BASE, api, cron, inbound, sql, unique } from '../helpers/client';
import { FAKE_B64, JPEG_B64, OVERSIZE_B64, PNG_B64 } from '../helpers/images';

const wa = () => `${unique('4476')}@c.us`;
const photoMsg = (id: string, body = '', data = JPEG_B64, kind = 'image') => ({ external_id: id, direction: 'in' as const, body, kind, media: { kind: kind === 'video' ? 'video_frame' : 'image', mime: 'image/jpeg', data } });
const mediaOf = async (convId: string) => (await sql('SELECT id, message_id, kind, mime, bytes, length(data) AS chars, created_at FROM media WHERE conversation_id = ? ORDER BY created_at, id', [convId])).data.results;
const jpegBytes = Buffer.from(JPEG_B64, 'base64');
const LIMIT = 45;

describe('a photo from a customer', () => {
  it('is stored, reaches the brain and gets answered instead of going to the owner', async () => {
    const r = await inbound('whatsapp', wa(), [photoMsg('p1')]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts).toEqual(['Mock saw 1 photo']);
    expect(r.queries).toBeLessThanOrEqual(LIMIT);

    const rows = await mediaOf(r.conversation_id!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'image', mime: 'image/jpeg', bytes: jpegBytes.length, chars: JPEG_B64.length });
    const msg = (await sql('SELECT id, kind, body, meta FROM messages WHERE conversation_id = ?', [r.conversation_id])).data.results[0];
    expect(rows[0].message_id).toBe(msg.id);
    expect(JSON.parse(msg.meta)).toEqual({ media: rows[0].id, media_kind: 'image' });
    expect((await api('/api/urgent')).data.urgent.some((u: any) => u.conversation_id === r.conversation_id)).toBe(false);

    // The same thread reported again: nothing is stored twice.
    expect((await inbound('whatsapp', (await sql('SELECT external_thread_id AS t FROM conversations WHERE id = ?', [r.conversation_id])).data.results[0].t, [photoMsg('p1')])).action).toBe('none');
    expect(await mediaOf(r.conversation_id!)).toHaveLength(1);
  });

  it('passes one frame of a video as a video frame, and at most 3 pictures', async () => {
    const one = await inbound('whatsapp', wa(), [photoMsg('v1', '', PNG_B64, 'video')]);
    expect(one.jobs[0]!.parts).toEqual(['Mock saw 1 photo with 1 video frame']);
    expect((await mediaOf(one.conversation_id!))[0]).toMatchObject({ kind: 'video_frame', mime: 'image/png' });

    const many = await inbound('whatsapp', wa(), [photoMsg('a'), photoMsg('b'), photoMsg('c'), photoMsg('d', 'which one fits')]);
    expect(many.jobs[0]!.parts).toEqual(['Mock saw 3 photos']);
    expect(await mediaOf(many.conversation_id!)).toHaveLength(3);
    expect(many.queries).toBeLessThanOrEqual(LIMIT);
  });

  it('takes the unclear photo path: the owner gets a description and the customer a confident holding line', async () => {
    const r = await inbound('whatsapp', wa(), [photoMsg('u1', 'unclear-photo does it fit')]);
    expect(r.action).toBe('escalate');
    expect(r.jobs[0]!.parts).toEqual(['Let me check that for you']);
    const res = await api('/api/urgent');
    expect(res.queries).toBeLessThanOrEqual(LIMIT);
    const item = res.data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item.question).toMatch(/photo is too dark/i);
    // The card carries what the thumbnail needs, with no picture data in the list.
    const withPhoto = item.recent.find((m: any) => m.media);
    expect(withPhoto.media).toEqual({ id: (await mediaOf(r.conversation_id!))[0].id, kind: 'image' });
    expect(JSON.stringify(res.data)).not.toContain(JPEG_B64.slice(0, 40));
    await api(`/api/urgent/${item.id}/dismiss`, { body: {} });
  });

  it('answers only what came after our last message: an already answered photo is not shown again', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [photoMsg('q1')]);
    const reply = first.jobs[0]!.parts[0]!;
    const second = await inbound('whatsapp', t, [photoMsg('q1'), { external_id: 'o1', direction: 'out', body: reply }, { external_id: 'q2', direction: 'in', body: 'ok and delivery' }]);
    expect(second.jobs[0]!.parts[0]).toContain('Mock reply to: ok and delivery');
  });
});

describe('the thumbnail route', () => {
  it('serves the picture to the signed in owner only, with a private cache header', async () => {
    const r = await inbound('whatsapp', wa(), [photoMsg('t1', 'here is my bike')]);
    const conv = await api(`/api/conversations/${r.conversation_id}`);
    expect(conv.queries).toBeLessThanOrEqual(LIMIT);
    const media = conv.data.messages[0].media;
    expect(media).toMatchObject({ kind: 'image' });
    expect(conv.data.messages.find((m: any) => m.direction === 'out')?.media ?? null).toBeNull();
    expect(JSON.stringify(conv.data)).not.toContain(JPEG_B64.slice(0, 40));

    const url = `${BASE()}/api/media/${media.id}`;
    const ok = await fetch(url, { headers: { cookie: process.env.ACX_TEST_COOKIE! } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await ok.arrayBuffer()).equals(jpegBytes)).toBe(true);

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}` } })).status).toBe(401);
    expect((await fetch(`${BASE()}/api/media/md_nope`, { headers: { cookie: process.env.ACX_TEST_COOKIE! } })).status).toBe(404);
  });
});

describe('pictures that are not accepted', () => {
  it('drops a fake file and an oversize one, keeps the message and tells the owner silently as before', async () => {
    for (const [data, reason] of [[FAKE_B64, 'not_an_image'], [OVERSIZE_B64, 'too_large']] as const) {
      const r = await inbound('whatsapp', wa(), [photoMsg(unique('x'), '', data)]);
      expect(r.action).toBe('escalate');
      expect(r.jobs).toHaveLength(0); // nothing is said to the customer
      expect(await mediaOf(r.conversation_id!)).toHaveLength(0);
      const msg = (await sql('SELECT kind, body, meta FROM messages WHERE conversation_id = ?', [r.conversation_id])).data.results[0];
      expect(msg).toMatchObject({ kind: 'image', body: '[sent a photo]', meta: '{}' });
      const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
      expect(item.category).toBe('media');
      expect(item.reason).toBe('The agent could not look at this one');
      expect(item.recent.every((m: any) => m.media === null)).toBe(true);
      const note = (await sql(`SELECT data FROM diagnostics WHERE kind = 'note' AND data LIKE '%media_rejected%' ORDER BY id DESC LIMIT 1`)).data.results[0];
      expect(JSON.parse(note.data).media_rejected).toEqual([reason]);
      await api(`/api/urgent/${item.id}/dismiss`, { body: {} });
    }
  });

  it('ignores a picture on one of our own messages and a voice note still goes to the owner', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [{ external_id: 'h1', direction: 'in', body: 'hello' }, { ...photoMsg('o9', 'our own photo'), direction: 'out' as const }, { external_id: 'vn', direction: 'in', body: '', kind: 'voice' }]);
    expect(await mediaOf(r.conversation_id!)).toHaveLength(0);
    expect(r.action).toBe('escalate');
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item.reason).toBe('The agent cannot listen to voice notes');
    await api(`/api/urgent/${item.id}/dismiss`, { body: {} });
  });

  it('keeps a picture that arrives on a later read of the same message, for the thumbnail', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [{ external_id: 'late1', direction: 'in', body: '', kind: 'image' }]);
    expect(first.action).toBe('escalate');
    expect(await mediaOf(first.conversation_id!)).toHaveLength(0);
    const again = await inbound('whatsapp', t, [photoMsg('late1')]);
    expect(again.action).toBe('none');
    const rows = await mediaOf(first.conversation_id!);
    expect(rows).toHaveLength(1);
    expect((await api(`/api/conversations/${first.conversation_id}`)).data.messages[0].media).toEqual({ id: rows[0].id, kind: 'image' });
    await inbound('whatsapp', t, [photoMsg('late1')]);
    expect(await mediaOf(first.conversation_id!)).toHaveLength(1);
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === first.conversation_id);
    await api(`/api/urgent/${item.id}/dismiss`, { body: {} });
  });
});

describe('cleanup', () => {
  it('deletes pictures older than 14 days and keeps newer ones', async () => {
    const r = await inbound('whatsapp', wa(), [photoMsg('c1', 'photo to keep')]);
    const fresh = (await mediaOf(r.conversation_id!))[0];
    const DAY = 86_400_000;
    const now = Date.now();
    await sql('INSERT INTO media (id, message_id, conversation_id, kind, mime, data, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['md_old15', 'm_old', r.conversation_id, 'image', 'image/jpeg', JPEG_B64, jpegBytes.length, now - 15 * DAY]);
    await sql('INSERT INTO media (id, message_id, conversation_id, kind, mime, data, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['md_old13', 'm_old2', r.conversation_id, 'image', 'image/jpeg', JPEG_B64, jpegBytes.length, now - 13 * DAY]);
    // The cleanup runs once a day: make it due.
    await sql(`DELETE FROM settings WHERE key = 'state:cleanup_at'`);
    await cron();
    const left = (await mediaOf(r.conversation_id!)).map((m: any) => m.id).sort();
    expect(left).toEqual([fresh.id, 'md_old13'].sort());
    // A message older than 14 days no longer points at its deleted picture.
    await sql('UPDATE messages SET created_at = ? WHERE conversation_id = ?', [now - 15 * DAY, r.conversation_id]);
    expect((await api(`/api/conversations/${r.conversation_id}`)).data.messages[0].media).toBeNull();
  });
});
