// Fetch a customer's photo for a tab that could not copy it itself. Pages show photos from CDN
// hosts: the page may display them, but it may not read their pixels (the canvas is tainted) and its
// own fetch is stopped by CORS. The service worker has host permission for these few hosts, so it
// can fetch the picture and hand back a small JPEG. Nothing else is ever fetched: the address must be
// https and its host must be on the list for the channel that asks.

/** Hosts per channel, as suffixes. Keep in step with host_permissions in manifest.json. */
export const MEDIA_HOSTS = {
  whatsapp: [], // WhatsApp Web shows photos as blob: addresses, which the tab reads itself
  gmail: ['mail.google.com', '.googleusercontent.com'],
  tiktok: ['.tiktokcdn.com', '.tiktokcdn-eu.com', '.tiktokcdn-us.com'],
};

const MAX_BASE64 = 250_000;
const MAX_FETCH_BYTES = 15_000_000;
// Longest side and JPEG quality, tried in order until the result fits (same steps as content/core.js).
const STEPS = [[1024, 0.7], [896, 0.6], [768, 0.5], [640, 0.45], [512, 0.4], [384, 0.35]];

export function mediaUrlAllowed(channel, raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (MEDIA_HOSTS[channel] || []).some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Bitmap -> base64 JPEG under the cap, or null. */
async function encodeJpeg(bmp) {
  for (const [side, quality] of STEPS) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const data = toBase64(await blob.arrayBuffer());
    if (data.length <= MAX_BASE64) return data;
  }
  return null;
}

/** { ok: true, data } with a base64 JPEG, or { ok: false, error }. Never throws. */
export async function fetchMedia(channel, url, timeoutMs = 4000) {
  try {
    if (!mediaUrlAllowed(channel, url)) return { ok: false, error: 'host_not_allowed' };
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: AbortSignal.timeout(Math.min(Math.max(300, Number(timeoutMs) || 4000), 5000)) });
    // A redirect may leave the allowed hosts: the answer is only used when it ended on one.
    if (!mediaUrlAllowed(channel, res.url || url)) return { ok: false, error: 'redirect_not_allowed' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const blob = await res.blob();
    if (blob.size > MAX_FETCH_BYTES) return { ok: false, error: 'too_big' };
    const bmp = await createImageBitmap(blob);
    try {
      const data = await encodeJpeg(bmp);
      return data ? { ok: true, data } : { ok: false, error: 'too_big_after_shrinking' };
    } finally { try { bmp.close(); } catch { /* ignore */ } }
  } catch (err) {
    return { ok: false, error: String(err?.name || err?.message || err).slice(0, 60) };
  }
}
