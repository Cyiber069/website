// Photos and video frames from customers (migrations/0007_media.sql), and voice notes (src/speech). The
// extension sends each one as base64 inside the inbound report. Nothing is trusted: the type is read
// from the first bytes and anything that is not a real JPEG, PNG or WebP (or, for a voice note, a real
// Ogg, WebM, MP3, AAC, M4A or WAV file), or is too big, is dropped.

export type MediaKind = 'image' | 'video_frame' | 'voice';
export type MediaMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type AudioMime = 'audio/ogg' | 'audio/webm' | 'audio/mpeg' | 'audio/aac' | 'audio/mp4' | 'audio/wav';

/** A checked picture, ready to store. `data` is plain base64 with no data: prefix. */
export interface MediaItem {
  kind: MediaKind;
  mime: MediaMime | AudioMime;
  data: string;
  bytes: number;
  /** The whole video, uploaded by the laptop first (POST /api/agent/media/video): a vision_files id. */
  video_ref?: string | null;
  /** A few more frames of the video, small JPEGs in order. Looked at by the vision model, never stored. */
  frames?: string[];
  /** A shared TikTok post: who posted it and its caption. */
  shared?: { author: string; caption: string } | null;
  /** How long the video is, as the laptop measured it. */
  seconds?: number | null;
}

/** What a message row remembers about its picture (messages.meta), so lists never touch the media table. */
export interface MediaRef {
  media?: string;
  media_kind?: MediaKind;
  /** What the vision model saw, short (src/vision). Written once it has looked. */
  media_desc?: string;
  /** What the speech model heard in a voice note, short (src/speech). Written once it has listened. */
  voice_text?: string;
}

/** The extension aims for 250,000 characters of base64. A little room on top, then a hard no. */
export const MEDIA_MAX_BASE64 = 260_000;
export const MEDIA_PER_REPORT = 3;
/** Extra frames of one video in a report, each a small JPEG (the vision model looks at them, they are not stored). */
export const FRAMES_PER_VIDEO = 4;
export const FRAME_MAX_BASE64 = 90_000;
export const MEDIA_KEEP_DAYS = 14;

/** The image type the first bytes say it is, or null. */
export function sniffImage(b: Uint8Array): MediaMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** The audio type the first bytes say it is, or null. Voice notes are short Ogg Opus files on WhatsApp. */
export function sniffAudio(b: Uint8Array): AudioMime | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 4 && at(0, 0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg'; // OggS
  if (b.length >= 4 && at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'audio/webm'; // Matroska / WebM
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return 'audio/wav'; // RIFF....WAVE
  if (b.length >= 8 && at(4, 0x66, 0x74, 0x79, 0x70)) return 'audio/mp4'; // ....ftyp (M4A)
  if (b.length >= 3 && at(0, 0x49, 0x44, 0x33)) return 'audio/mpeg'; // ID3
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'audio/mpeg'; // MPEG audio frame
  return null;
}

/** Voice notes longer than this are not written out (keep today's behaviour: the owner listens). */
export const VOICE_MAX_SECONDS = 120;

export type MediaCheck = { ok: true; item: MediaItem } | { ok: false; reason: 'missing' | 'too_large' | 'not_base64' | 'not_an_image' | 'not_audio' };

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
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = (data.length / 4) * 3 - pad;
  if (o.kind === 'voice') {
    const audio = sniffAudio(head);
    if (!audio) return { ok: false, reason: 'not_audio' };
    return { ok: true, item: { kind: 'voice', mime: audio, data, bytes } };
  }
  const mime = sniffImage(head);
  if (!mime) return { ok: false, reason: 'not_an_image' };
  return { ok: true, item: { kind: o.kind === 'video_frame' ? 'video_frame' : 'image', mime, data, bytes } };
}

/** Extras of a checked video cover: the uploaded video's ref, more frames, a shared post. Anything odd is dropped. */
export function mediaExtras(raw: unknown, kind: MediaKind): Pick<MediaItem, 'video_ref' | 'frames' | 'shared' | 'seconds'> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Pick<MediaItem, 'video_ref' | 'frames' | 'shared' | 'seconds'> = {};
  const seconds = typeof o.seconds === 'number' && Number.isFinite(o.seconds) && o.seconds > 0 && o.seconds < 36_000 ? Math.round(o.seconds * 10) / 10 : null;
  // A voice note: how long it is, as the laptop read it.
  if (kind === 'voice') { if (seconds) out.seconds = seconds; return out; }
  if (kind !== 'video_frame') return out;
  if (typeof o.video_ref === 'string' && /^vf_[a-z0-9]{6,24}$/.test(o.video_ref)) out.video_ref = o.video_ref;
  if (Array.isArray(o.frames)) {
    const frames = o.frames.slice(0, FRAMES_PER_VIDEO)
      .filter((f): f is string => typeof f === 'string' && f.length <= FRAME_MAX_BASE64)
      .map((f) => checkMedia({ kind: 'video_frame', data: f }))
      .filter((r): r is { ok: true; item: MediaItem } => r.ok && r.item.mime === 'image/jpeg')
      .map((r) => r.item.data);
    if (frames.length) out.frames = frames;
  }
  if (o.shared && typeof o.shared === 'object') {
    const sh = o.shared as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const shared = { author: text(sh.author, 60), caption: text(sh.caption, 300) };
    if (shared.author || shared.caption) out.shared = shared;
  }
  if (typeof o.seconds === 'number' && Number.isFinite(o.seconds) && o.seconds > 0 && o.seconds < 36_000) out.seconds = Math.round(o.seconds * 10) / 10;
  return out;
}

/** base64 to bytes, for serving a stored picture. */
export function base64Bytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
