// Client for the ACX Agent backend. Every call carries the device token.
import * as store from './store.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** "https://acx-agent.example.workers.dev#K7QM-2XHD" -> { server_url, code } */
export function parsePairingString(text) {
  const raw = String(text || '').trim();
  const hash = raw.lastIndexOf('#');
  if (hash < 0) throw new ApiError(0, 'bad_pairing_string', 'Paste the full pairing line from the dashboard');
  const code = raw.slice(hash + 1).trim().toUpperCase();
  let url;
  try { url = new URL(raw.slice(0, hash).trim()); } catch { throw new ApiError(0, 'bad_pairing_string', 'That does not look like a pairing line'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) throw new ApiError(0, 'bad_pairing_string', 'The dashboard address must start with https');
  if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) throw new ApiError(0, 'bad_pairing_string', 'The code at the end looks wrong');
  return { server_url: url.origin, code };
}

const REQUEST_TIMEOUT_MS = 30_000;

async function request(path, { method = 'POST', body, raw, contentType, auth, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const a = auth ?? (await store.get('auth'));
  if (!a?.server_url) throw new ApiError(0, 'not_paired', 'Not paired yet');
  // `raw` (a Blob) goes as it is, with its own type: the video upload.
  const headers = { 'content-type': raw ? contentType || raw.type || 'application/octet-stream' : 'application/json' };
  if (a.token) headers.authorization = `Bearer ${a.token}`;
  // Every call ends: a request that hangs (laptop woke up, network changed) must never stall the agent.
  const sig = signal || AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${a.server_url}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: sig, cache: 'no-store' });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new ApiError(0, 'timeout', 'The dashboard server did not answer in time');
    throw new ApiError(0, 'network', `Cannot reach the dashboard server (${err?.message || 'network error'})`);
  }
  return res;
}

async function json(path, opts) {
  const res = await request(path, opts);
  let data = null;
  // The body can hang too: give it the same limit as the request.
  const STUCK = Symbol('stuck');
  let timer;
  const stuck = new Promise((r) => { timer = setTimeout(() => r(STUCK), REQUEST_TIMEOUT_MS); });
  try {
    data = await Promise.race([res.json(), stuck]);
  } catch { data = null; /* empty or non JSON body */ } finally { clearTimeout(timer); }
  if (data === STUCK) throw new ApiError(0, 'timeout', 'The dashboard server stopped halfway through its answer');
  if (!res.ok) throw new ApiError(res.status, data?.error || `http_${res.status}`, data?.message || `Server said ${res.status}`);
  return data;
}

export async function pair(pairingString, deviceName) {
  const { server_url, code } = parsePairingString(pairingString);
  const data = await json('/api/agent/pair', { body: { code, name: deviceName }, auth: { server_url } });
  const auth = { server_url, token: data.token, device_id: data.device_id, device_name: deviceName };
  await store.set({ auth });
  return auth;
}

export const sync = (status, selectorsVersion, version) =>
  json('/api/agent/sync', { body: { version, selectors_version: selectorsVersion, status } });

export const jobResult = (jobId, result) => json(`/api/agent/jobs/${encodeURIComponent(jobId)}/result`, { body: result });

export const diagnostics = (channel, kind, data) => json('/api/agent/diagnostics', { body: { channel, kind, data } });

/**
 * One customer video, sent whole before the report that names it. The server streams the bytes to
 * Google AI Studio and answers { ref } (a vision_files id) for the report's media.video_ref.
 * Throws ApiError: 409 vision_off, 413 too_large or too_long, 415 not_a_video, 429 daily_cap, 502 vision_failed.
 */
export function uploadVideo(blob, { mime, seconds, channel, timeoutMs = 75_000 } = {}) {
  const q = new URLSearchParams();
  if (channel) q.set('channel', channel);
  if (Number.isFinite(seconds) && seconds > 0) q.set('seconds', String(Math.round(seconds * 10) / 10));
  return json(`/api/agent/media/video?${q}`, { raw: blob, contentType: mime || blob.type || 'video/mp4', timeoutMs });
}

/**
 * Report a thread and wait for the decision. The server streams one JSON object per line and
 * sends {"type":"ping"} while the brain is thinking, which also keeps this service worker alive.
 */
const MEDIA_MAX_BASE64 = 250_000;
const MEDIA_MAX_ITEMS = 3;
const FRAME_MAX_BASE64 = 90_000;
const FRAMES_MAX = 4;
// The whole report stays under the server's 1.2 MB: pictures first, then video frames while they fit.
const REPORT_MEDIA_BUDGET = 1_000_000;

/**
 * Photos ride along inside the report. Keep only well formed ones under the size cap, the newest 3,
 * so a bad capture can never make the server refuse the whole report. A video's extra frames are kept
 * while the report has room (newest video first); `video` (the laptop's own note of the bytes) never goes.
 */
export function trimMedia(messages) {
  let kept = 0;
  let used = 0;
  const out = (Array.isArray(messages) ? messages : []).map((m) => ({ ...m, ...(m && m.media ? { media: { ...m.media } } : {}) }));
  for (let i = out.length - 1; i >= 0; i--) {
    const media = out[i].media;
    if (media === undefined) continue;
    const ok = media && out[i].direction === 'in' && typeof media.data === 'string' && media.data.length > 0 && media.data.length <= MEDIA_MAX_BASE64 && kept < MEDIA_MAX_ITEMS;
    if (ok) { kept++; used += media.data.length; delete media.video; } else delete out[i].media;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const media = out[i].media;
    if (!media || media.frames === undefined) continue;
    const frames = (Array.isArray(media.frames) ? media.frames : []).filter((f) => typeof f === 'string' && f.length > 100 && f.length <= FRAME_MAX_BASE64).slice(0, FRAMES_MAX);
    const fit = [];
    for (const f of frames) { if (used + f.length > REPORT_MEDIA_BUDGET) break; fit.push(f); used += f.length; }
    if (fit.length) media.frames = fit; else delete media.frames;
  }
  return out;
}

/**
 * The decision for a report. A stream that ends without a decision line, stops sending anything for
 * `stallMs` (the server pings every 4 s) or runs past `timeoutMs` comes back as a decision with
 * `cut: true`, which the worker treats as final=false: it reads the chat again and posts once more.
 * `accepted` is the server's first line when it came (the conversation id), else null.
 * Throws ApiError for a refused request (status 4xx/5xx), an error line (500) or no connection (0).
 */
export async function inbound(payload, { timeoutMs = 90_000, stallMs = 15_000 } = {}) {
  payload = { ...payload, messages: trimMedia(payload.messages) };
  const ctl = new AbortController();
  let why = '';
  const stop = (reason) => { if (!why) { why = reason; ctl.abort(); } };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  let stall = setTimeout(() => stop('stall'), stallMs + 15_000); // the first line waits for the messages to be stored
  const cut = (reason, accepted) => ({ type: 'decision', action: 'none', reason, jobs: [], cut: true, final: false, accepted: accepted || null });
  let accepted = null;
  try {
    let res;
    try {
      res = await request('/api/agent/inbound', { body: payload, signal: ctl.signal });
    } catch (err) {
      if (why) return cut(why === 'stall' ? 'stream_stalled' : 'timeout', null);
      throw err;
    }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      throw new ApiError(res.status, data?.error || `http_${res.status}`, data?.message || `Server said ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let decision = null;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (why) break; // stopped by the stall or time limit
        if (decision) break;
        return cut('stream_cut', accepted); // connection dropped half way
      }
      const { value, done } = chunk;
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => stop('stall'), stallMs);
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'accepted') accepted = obj;
        if (obj.type === 'decision') decision = obj;
        if (obj.type === 'error') throw new ApiError(500, obj.code || 'server_error', obj.message || 'Server error');
      }
      if (decision) { reader.cancel().catch(() => {}); break; } // the decision is the last line that matters
    }
    if (decision) return { ...decision, accepted };
    // No decision line: the request may or may not have finished on the server. Treated as not final.
    return cut(why === 'stall' ? 'stream_stalled' : why === 'timeout' ? 'timeout' : 'stream_cut', accepted);
  } finally {
    clearTimeout(timer);
    clearTimeout(stall);
  }
}
