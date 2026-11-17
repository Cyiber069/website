// Photos and video frames from customers (migrations/0007_media.sql). The extension sends each one as
// base64 inside the inbound report. Nothing is trusted: the type is read from the first bytes and
// anything that is not a real JPEG, PNG or WebP, or is too big, is dropped.

export type MediaKind = 'image' | 'video_frame';
export type MediaMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** A checked picture, ready to store. `data` is plain base64 with no data: prefix. */
export interface MediaItem {
  kind: MediaKind;
  mime: MediaMime;
  data: string;
  bytes: number;
}

/** What a message row remembers about its picture (messages.meta), so lists never touch the media table. */
export interface MediaRef {
  media?: string;
  media_kind?: MediaKind;
}

/** The extension aims for 250,000 characters of base64. A little room on top, then a hard no. */
export const MEDIA_MAX_BASE64 = 260_000;
export const MEDIA_PER_REPORT = 3;
export const MEDIA_KEEP_DAYS = 14;

/** The image type the first bytes say it is, or null. */
export function sniffImage(b: Uint8Array): MediaMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export type MediaCheck = { ok: true; item: MediaItem } | { ok: false; reason: 'missing' | 'too_large' | 'not_base64' | 'not_an_image' };

/** Check one `media` value from an inbound message: { kind, data }. The mime the sender claims is ignored. */
export function checkMedia(raw: unknown): MediaCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'missing' };
  const o = raw as Record<string, unknown>;
  if (typeof o.data !== 'string' || !o.data) return { ok: false, reason: 'missing' };
  if (o.data.length > MEDIA_MAX_BASE64 + 64) return { ok: false, reason: 'too_large' };
  const data = o.data.replace(/^data:[a-z0-9.+/-]+;base64,/i, '');
  if (data.length > MEDIA_MAX_BASE64) return { ok: false, reason: 'too_large' };
  if (data.length < 64 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, reason: 'not_base64' };
  let head: Uint8Array;
  try {
    head = Uint8Array.from(atob(data.slice(0, 32)), (c) => c.charCodeAt(0));
  } catch { return { ok: false, reason: 'not_base64' }; }
  const mime = sniffImage(head);
  if (!mime) return { ok: false, reason: 'not_an_image' };
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return { ok: true, item: { kind: o.kind === 'video_frame' ? 'video_frame' : 'image', mime, data, bytes: (data.length / 4) * 3 - pad } };
}

/** base64 to bytes, for serving a stored picture. */
export function base64Bytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
