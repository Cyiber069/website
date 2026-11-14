// Web Push to the owner's phone, built on Web Crypto only (no dependency):
//   * VAPID (RFC 8292): a short lived ES256 token that tells the push service who is sending.
//   * Message encryption (RFC 8291, "aes128gcm" content coding from RFC 8188).
// The VAPID key pair is made on first use. The private half lives in the secrets table
// (vapid_private_jwk), the public half is also cached in state for the dashboard to subscribe with.
import type { Env } from '../types';
import { b64url, b64urlDecode } from './crypto';
import { all, one, run } from './db';
import { getSecret, getSettings, getState, setState } from './settings';

export interface OwnerNotification {
  title: string;
  body: string;
  /** Path inside the dashboard to open, for example /#/urgent */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}

const enc = new TextEncoder();
const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
/** One encrypted record. Push services accept bodies up to 4096 bytes. */
const RECORD_SIZE = 4096;
const SEND_TIMEOUT_MS = 8000;
/** Give up on a phone that has failed this many times in a row (it probably uninstalled the app). */
const MAX_FAILS = 12;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** HKDF-SHA256 (RFC 5869) with Web Crypto. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

interface PrivateJwk { kty: 'EC'; crv: 'P-256'; d: string; x: string; y: string }

/** The 65 byte uncompressed point (0x04, x, y) that browsers call the application server key. */
function rawPublicKey(jwk: { x: string; y: string }): Uint8Array {
  return concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
}

/** An ECDH private key from its raw public point and private scalar (both base64url). */
async function importEcdhPrivate(publicB64: string, privateB64: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicB64);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);
}

export interface EncryptOptions {
  /** Fixed values, only for reproducing the RFC 8291 test vector. Real sends use fresh random ones. */
  salt?: Uint8Array;
  localKey?: { publicKey: string; privateKey: string };
}

/**
 * Encrypt a push message for one subscription (RFC 8291). Returns the complete request body:
 * salt (16) | record size (4) | key id length (1) | our public key (65) | ciphertext.
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length < 16) throw new Error('bad auth secret');
  // Padding delimiter (1 byte) and the AES-GCM tag (16 bytes) must fit in the single record with the header.
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error('push payload too large');

  // A throwaway key pair per message: the phone combines its private key with our public one.
  let localPrivate: CryptoKey;
  let localPublic: Uint8Array;
  if (opts.localKey) {
    localPrivate = await importEcdhPrivate(opts.localKey.publicKey, opts.localKey.privateKey);
    localPublic = b64urlDecode(opts.localKey.publicKey);
  } else {
    const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
    localPrivate = pair.privateKey;
    localPublic = rawPublicKey((await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string; y: string });
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ECDH, false, []);
  // The Workers type names this field "$public"; the runtime (like every Web Crypto) reads "public".
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, localPrivate, 256));

  // Mix in the subscription's auth secret, then derive the content key and nonce from a random salt.
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, localPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (here the only) record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = localPublic.length;
  return concat(header, localPublic, sealed);
}

/** The VAPID token: an ES256 JWT naming the push service, valid for twelve hours. */
export async function vapidToken(audience: string, subject: string, jwk: PrivateJwk, now = Date.now()): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, P256, false, ['sign']);
  // Web Crypto already returns the raw r|s form that JWT wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** Load the VAPID key pair, creating and saving it the first time. */
async function vapidKeys(db: D1Database): Promise<{ jwk: PrivateJwk; publicKey: string }> {
  let stored = await getSecret(db, 'vapid_private_jwk');
  if (!stored) {
    const pair = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
    const full = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d: string; x: string; y: string };
    // Field order is fixed so the secret's 4 character hint only ever shows public material (the end of y).
    const value = JSON.stringify({ kty: 'EC', crv: 'P-256', d: full.d, x: full.x, y: full.y });
    // Insert only if still absent: two requests racing here must end up with the same key,
    // because changing it would silently break every existing subscription.
    await run(db, 'INSERT INTO secrets (key, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING', 'vapid_private_jwk', value, value.slice(-4), Date.now());
    stored = (await getSecret(db, 'vapid_private_jwk')) ?? value;
  }
  const jwk = JSON.parse(stored) as PrivateJwk;
  const publicKey = b64url(rawPublicKey(jwk));
  if ((await getState<string>(db, 'vapid_public_key', '')) !== publicKey) await setState(db, 'vapid_public_key', publicKey);
  return { jwk, publicKey };
}

/** The key the dashboard passes to pushManager.subscribe as applicationServerKey (base64url). */
export async function getVapidPublicKey(env: Env): Promise<string> {
  return (await vapidKeys(env.DB)).publicKey;
}

interface SubscriptionRow { id: string; endpoint: string; p256dh: string; auth: string; fail_count: number }

/** Push endpoints are always https. Plain http to this machine is allowed only for the automated tests. */
export function validPushEndpoint(env: Env, endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return env.ACX_TEST_MODE === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1';
}

/** Best effort: resolves to the number of devices reached and never throws. */
export async function notifyOwner(env: Env, n: OwnerNotification): Promise<number> {
  try {
    const db = env.DB;
    const subs = await all<SubscriptionRow>(db, 'SELECT id, endpoint, p256dh, auth, fail_count FROM push_subscriptions');
    if (!subs.length) return 0;
    const [{ jwk, publicKey }, settings] = await Promise.all([vapidKeys(db), getSettings(db)]);
    // Push services want a way to contact the sender. Apple insists on a real looking https or mailto address.
    const subject = `https://${settings.store.domain || 'example.com'}`;
    const payload = enc.encode(JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag }));
    const topic = n.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

    const results = await Promise.all(subs.map(async (sub): Promise<boolean> => {
      try {
        if (!validPushEndpoint(env, sub.endpoint)) throw new Error('bad endpoint');
        const body = await encryptPayload(payload, sub.p256dh, sub.auth);
        const token = await vapidToken(new URL(sub.endpoint).origin, subject, jwk);
        const headers: Record<string, string> = {
          authorization: `vapid t=${token}, k=${publicKey}`,
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: '43200',       // keep trying for 12 hours if the phone is off
          urgency: 'high',
        };
        if (topic) headers.topic = topic; // a newer alert of the same kind replaces an undelivered older one
        const res = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        if (res.status === 404 || res.status === 410) {
          // The browser dropped this subscription. It will never work again.
          await run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
          return false;
        }
        if (!res.ok) throw new Error(`push service answered ${res.status}`);
        await run(db, 'UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?', Date.now(), sub.id);
        return true;
      } catch (err) {
        console.error('push send failed', err instanceof Error ? err.message : err);
        if (sub.fail_count + 1 >= MAX_FAILS) await run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
        else await run(db, 'UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?', sub.id);
        return false;
      }
    }));
    return results.filter(Boolean).length;
  } catch (err) {
    console.error('notifyOwner failed', err);
    return 0;
  }
}

/** Used by the Connections screen to show how many phones are subscribed. */
export async function pushSubscriptionCount(db: D1Database): Promise<number> {
  return (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM push_subscriptions'))?.n ?? 0;
}
