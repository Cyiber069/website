// The ACX Agent dashboard, open in this browser, talking to this laptop's extension.
//
// Registered by the service worker (sw.js registerDashboardScript) for the paired server's address only,
// and the service worker answers only a top page of that exact origin. It relays two questions from the
// dashboard page and nothing else:
//   hello            -> which laptop is this (device id, person, version) and what each lane is doing
//   open_tab {lane}  -> open that lane's tab and pin it, now (the blue dot on Live)
// It never relays pair, pause or unpair, never reads chrome.storage, and never sees or passes on the
// device token. The page and this script talk with window.postMessage on the page's own origin:
//   page -> here: { tag: 'acx-dash', dir: 'req', id, op, lane }
//   here -> page: { tag: 'acx-dash', dir: 'res', id, ok, data, error }  and once { tag: 'acx-dash', dir: 'ready' }
(() => {
  if (globalThis.__acxDashboard) return; // registered and also injected into a tab that was already open
  globalThis.__acxDashboard = true;
  if (window.top !== window) return;

  const TAG = 'acx-dash';
  const OPS = new Set(['hello', 'open_tab']);
  const reply = (msg) => { try { window.postMessage({ tag: TAG, dir: 'res', ...msg }, location.origin); } catch { /* page gone */ } };

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.tag !== TAG || d.dir !== 'req') return;
    const id = typeof d.id === 'string' ? d.id.slice(0, 40) : '';
    if (!id || !OPS.has(d.op)) { reply({ id, ok: false, error: 'unknown_op' }); return; }
    const lane = typeof d.lane === 'string' ? d.lane.slice(0, 40) : '';
    try {
      chrome.runtime.sendMessage({ acx: true, type: 'dash', op: d.op, lane }, (res) => {
        if (chrome.runtime.lastError || !res) { reply({ id, ok: false, error: 'no_extension' }); return; }
        reply({ id, ok: Boolean(res.ok), data: res.data ?? null, error: res.error || '' });
      });
    } catch {
      // The extension was reloaded or removed: this script is left over.
      reply({ id, ok: false, error: 'no_extension' });
    }
  });

  // Tell a page that loaded first that the extension is here now.
  const ready = () => { try { window.postMessage({ tag: TAG, dir: 'ready' }, location.origin); } catch { /* ignore */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
