// ACX Agent service worker: push notifications, and the app shell kept for when the signal drops.
const CACHE = 'acx-shell-v1';
const SHELL = ['/', '/css/acx.css', '/css/app.css', '/js/app.js', '/img/logo.png', '/icons/icon-192.png', '/fonts/inter-latin-wght-normal.woff2', '/fonts/oswald-latin-wght-normal.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, so a new version always wins. The cache only answers when the network cannot.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? (await caches.match('/')) : undefined) || Response.error()),
  );
});

// Payload: JSON { title, body, url, tag }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { try { data = { body: event.data.text() }; } catch { data = {}; } }
  const title = typeof data.title === 'string' && data.title ? data.title : 'ACX Agent';
  const options = {
    body: typeof data.body === 'string' ? data.body : 'Something needs you.',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'acx',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/#/urgent' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try { target = new URL(event.notification.data?.url || '/#/urgent', self.location.origin); } catch { target = new URL('/#/urgent', self.location.origin); }
  if (target.origin !== self.location.origin) target = new URL('/#/urgent', self.location.origin);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (new URL(client.url).origin === target.origin && 'focus' in client) {
        await client.focus();
        client.postMessage({ type: 'navigate', url: target.href });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
