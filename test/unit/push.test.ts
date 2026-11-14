import { describe, expect, it } from 'vitest';
import { b64url, b64urlDecode } from '../../src/lib/crypto';
import { encryptPayload, vapidToken } from '../../src/lib/push';

const enc = new TextEncoder();
const dec = new TextDecoder();

// RFC 8291 appendix A, "Intermediate Values for Encryption".
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  ua_private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** What the phone does on receipt (RFC 8291 section 3.4), written separately from the code under test. */
async function decrypt(body: Uint8Array, uaPublicB64: string, uaPrivateB64: string, authB64: string): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLen = body[20]!;
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  expect(recordSize).toBe(4096);
  expect(idLen).toBe(65);
  const uaPublic = b64urlDecode(uaPublicB64);
  const priv = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', d: uaPrivateB64, x: b64url(uaPublic.slice(1, 33)), y: b64url(uaPublic.slice(33)) }, ECDH, false, ['deriveBits'],
  );
  const pub = await crypto.subtle.importKey('raw', asPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub } as any, priv, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(b64urlDecode(authB64), shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  // Strip the padding: everything after the last 0x02 delimiter is zeros.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2);
  return dec.decode(plain.slice(0, end));
}

describe('web push encryption (RFC 8291, aes128gcm)', () => {
  it('reproduces the RFC 8291 appendix A message byte for byte', async () => {
    const body = await encryptPayload(enc.encode(RFC.plaintext), RFC.ua_public, RFC.auth_secret, {
      salt: b64urlDecode(RFC.salt),
      localKey: { publicKey: RFC.as_public, privateKey: RFC.as_private },
    });
    expect(b64url(body)).toBe(RFC.body);
  });

  it('the RFC message decrypts with the receiver keys', async () => {
    expect(await decrypt(b64urlDecode(RFC.body), RFC.ua_public, RFC.ua_private, RFC.auth_secret)).toBe(RFC.plaintext);
  });

  it('uses a fresh key and salt for every real message, and the receiver can read it', async () => {
    const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const uaPublic = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer));
    const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const message = JSON.stringify({ title: 'Urgent question', body: 'Jake asks about delivery to Ireland', url: '/#/urgent', tag: 'urgent' });

    const a = await encryptPayload(enc.encode(message), uaPublic, auth);
    const b = await encryptPayload(enc.encode(message), uaPublic, auth);
    expect(b64url(a)).not.toBe(b64url(b));
    expect(a.length).toBe(16 + 4 + 1 + 65 + message.length + 1 + 16);
    expect(await decrypt(a, uaPublic, jwk.d!, auth)).toBe(message);
    expect(await decrypt(b, uaPublic, jwk.d!, auth)).toBe(message);
  });

  it('refuses bad keys and oversized payloads', async () => {
    await expect(encryptPayload(enc.encode('x'), 'AAAA', RFC.auth_secret)).rejects.toThrow();
    await expect(encryptPayload(enc.encode('x'), RFC.ua_public, 'AAAA')).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(4000), RFC.ua_public, RFC.auth_secret)).rejects.toThrow(/too large/);
  });
});

describe('VAPID token (RFC 8292)', () => {
  it('is an ES256 JWT for the push service origin that verifies with the public key', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d: string; x: string; y: string };
    const now = Date.UTC(2026, 10, 14, 20, 0, 0);
    const token = await vapidToken('https://push.example', 'https://shop.example', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, now);
    const [head, claims, sig] = token.split('.') as [string, string, string];
    expect(JSON.parse(dec.decode(b64urlDecode(head)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const body = JSON.parse(dec.decode(b64urlDecode(claims)));
    expect(body.aud).toBe('https://push.example');
    expect(body.sub).toBe('https://shop.example');
    expect(body.exp - now / 1000).toBe(12 * 3600); // push services reject anything over 24 hours
    expect(b64urlDecode(sig)).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, b64urlDecode(sig), enc.encode(`${head}.${claims}`))).toBe(true);
  });
});
