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

async function request(path, { method = 'POST', body, auth, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const a = auth ?? (await store.get('auth'));
  if (!a?.server_url) throw new ApiError(0, 'not_paired', 'Not paired yet');
  const headers = { 'content-type': 'application/json' };
  if (a.token) headers.authorization = `Bearer ${a.token}`;
  // Every call ends: a request that hangs (laptop woke up, network changed) must never stall the agent.
  const sig = signal || AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${a.server_url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: sig, cache: 'no-store' });
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
 * Report a thread and wait for the decision. The server streams one JSON object per line and
 * sends {"type":"ping"} while the brain is thinking, which also keeps this service worker alive.
 */
export async function inbound(payload, { timeoutMs = 150_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await request('/api/agent/inbound', { body: payload, signal: ctl.signal });
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
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'decision') decision = obj;
        if (obj.type === 'error') throw new ApiError(500, obj.code || 'server_error', obj.message || 'Server error');
      }
    }
    // No decision line means the stream was cut: the server still finishes and queues the reply.
    return decision ?? { type: 'decision', action: 'none', reason: 'stream_cut', jobs: [] };
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError(0, 'timeout', 'The server took too long to decide');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
