// Web push for this device. The server's public key comes from GET /api/connections (push.public_key).
import { post } from './api.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function fail(message) { const e = new Error(message); e.userMessage = message; return e; }

async function registration() {
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  return reg;
}

export async function pushState() {
  if (!supported()) return { supported: false, permission: 'default', subscribed: false };
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    subscribed = Boolean(reg && (await reg.pushManager.getSubscription()));
  } catch { /* treated as not subscribed */ }
  return { supported: true, permission: Notification.permission, subscribed };
}

export async function enablePush(publicKey) {
  if (!supported()) throw fail('This browser cannot show notifications. Open ACX Agent in Chrome or Safari on your phone.');
  if (!publicKey) throw fail('Notifications are not ready on the server yet. Try again a little later.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw fail('Notifications were not allowed. Allow them for this site in your browser settings, then try again.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    } catch {
      throw fail('Your phone would not switch notifications on. Check you are online, then try again.');
    }
  }
  const json = sub.toJSON();
  await post('/api/push/subscribe', { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } });
}

export async function disablePush() {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await post('/api/push/unsubscribe', { endpoint });
}
