// Persistent state for the extension (chrome.storage.local) with small typed helpers.

const DEFAULTS = {
  auth: null, // { server_url, token, device_id, device_name }
  config: null, // last config from the server
  selectors: null, // { version, pack }
  paused: false, // local pause switch in the popup
  trusted_input: false, // use chrome.debugger for typing when the owner allowed it
  auto_open_tabs: true,
  done_jobs: [], // ids of jobs already sent, newest last
  status: { channels: {}, last_sync_at: 0, last_error: '', server_ok: false },
  timing: null, // test only: shorter watchdog and sweep timers, see TIMING in sw.js
};

export async function get(keys = Object.keys(DEFAULTS)) {
  const list = Array.isArray(keys) ? keys : [keys];
  const raw = await chrome.storage.local.get(list);
  const out = {};
  for (const k of list) out[k] = raw[k] === undefined ? structuredClone(DEFAULTS[k]) : raw[k];
  return Array.isArray(keys) ? out : out[keys];
}

export function set(patch) {
  return chrome.storage.local.set(patch);
}

export async function rememberDone(jobId) {
  const done = await get('done_jobs');
  if (done.includes(jobId)) return;
  done.push(jobId);
  await set({ done_jobs: done.slice(-300) });
}

export async function isDone(jobId) {
  return (await get('done_jobs')).includes(jobId);
}

// Per browser session memory (cleared when Chrome restarts): what each thread looked like last time.
export async function sessionGet(key, fallback) {
  const raw = await chrome.storage.session.get(key);
  return raw[key] === undefined ? fallback : raw[key];
}

export function sessionSet(key, value) {
  return chrome.storage.session.set({ [key]: value });
}
