// This browser's own ACX Agent extension, when the dashboard is open on a paired laptop
// (extension/content/dashboard.js, which runs on this dashboard's address only). The page can ask two
// things and nothing else: which laptop is this, and open a lane's tab here. It never sees the laptop's
// token. On the phone, or a laptop without the extension, nothing answers and every call gives null.
const TAG = 'acx-dash';
let seq = 0;
const waiting = new Map();
const listeners = new Set();
let cache = null; // { at, data } of the last hello

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || typeof d !== 'object' || d.tag !== TAG) return;
  if (d.dir === 'ready') { cache = null; for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } return; }
  if (d.dir === 'res') { const done = waiting.get(d.id); if (done) done(d); }
});

function ask(op, extra, timeoutMs) {
  return new Promise((resolve) => {
    const id = `d${Date.now().toString(36)}${(++seq).toString(36)}`;
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, timeoutMs);
    waiting.set(id, (d) => { clearTimeout(timer); waiting.delete(id); resolve(d); });
    try { window.postMessage({ tag: TAG, dir: 'req', id, op, ...extra }, location.origin); } catch { clearTimeout(timer); waiting.delete(id); resolve(null); }
  });
}

/**
 * The laptop this dashboard is open on: { device_id, person, device_name, version, lanes }, or null when
 * this browser has no ACX Agent paired to this dashboard. Asked again at most every 30 s.
 */
export async function thisLaptop(maxAgeMs = 30_000) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.data;
  const r = await ask('hello', {}, 900);
  const data = r && r.ok && r.data && typeof r.data.device_id === 'string' ? r.data : null;
  cache = { at: Date.now(), data };
  return data;
}

/** Called when the extension says it is here (it can load after the page). */
export function onThisLaptop(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Open and pin a lane's tab on this laptop, now. { ok, error }. */
export async function openHere(lane) {
  const r = await ask('open_tab', { lane }, 10_000);
  return r ? { ok: Boolean(r.ok), error: r.error || '' } : { ok: false, error: 'no_extension' };
}
