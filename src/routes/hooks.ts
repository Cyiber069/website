// Shopify webhooks. Public route: the only proof of origin is the HMAC signature over the raw body.
import { b64, hmacSha256, timingSafeEqual } from '../lib/crypto';
import { logEvent } from '../lib/events';
import { HttpError, json, type Router } from '../lib/http';
import { getSecret, getSettings, getState, setState } from '../lib/settings';
import { fromWebhook, recordOrder, upsertCheckout } from '../shopify/checkouts';

const MAX_BODY_BYTES = 2_000_000;

export interface WebhookState {
  last_received_at: number | null;
  last_topic: string | null;
  received: number;
}

export const WEBHOOK_STATE = 'shopify_webhook';
export const EMPTY_WEBHOOK_STATE: WebhookState = { last_received_at: null, last_topic: null, received: 0 };

/** base64(HMAC-SHA256(secret, raw body)) compared in constant time. */
async function signatureMatches(raw: ArrayBuffer, header: string, secret: string | null): Promise<boolean> {
  if (!secret) return false;
  return timingSafeEqual(b64(await hmacSha256(secret, raw)), header);
}

export function register(r: Router): void {
  r.post('/api/hooks/shopify', 'public', async (c) => {
    // Raw bytes first: the signature covers exactly what Shopify sent, not a re-serialised copy.
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request body is too large');
    const header = (c.req.headers.get('x-shopify-hmac-sha256') ?? '').trim();
    if (!header) throw new HttpError(401, 'bad_signature', 'Missing webhook signature');

    // Webhooks made in Shopify admin are signed with the store's webhook key. Webhooks an app
    // registers are signed with the app's client secret, so that is accepted too.
    const ok =
      (await signatureMatches(raw, header, await getSecret(c.db, 'shopify_webhook_secret'))) ||
      (await signatureMatches(raw, header, await getSecret(c.db, 'shopify_client_secret')));
    if (!ok) throw new HttpError(401, 'bad_signature', 'Webhook signature does not match');

    const topic = (c.req.headers.get('x-shopify-topic') ?? '').toLowerCase();
    const before = await getState<WebhookState>(c.db, WEBHOOK_STATE, EMPTY_WEBHOOK_STATE);
    await setState(c.db, WEBHOOK_STATE, { last_received_at: c.now, last_topic: topic || null, received: (before.received ?? 0) + 1 } satisfies WebhookState);
    if (!before.last_received_at) {
      await logEvent(c.db, { level: 'good', type: 'shopify_webhook', message: 'First Shopify webhook received. The connection works.' });
    }

    // From here on always answer 200: Shopify retries failures and deletes a webhook that keeps failing.
    try {
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { payload = null; }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const body = payload as Record<string, unknown>;
        const defaultCountry = (await getSettings(c.db)).store.default_country;
        if (topic === 'checkouts/create' || topic === 'checkouts/update') {
          const checkout = fromWebhook(body, defaultCountry);
          if (checkout) await upsertCheckout(c.db, checkout, 'webhook');
        } else if (topic === 'orders/create') {
          await recordOrder(c.db, body, defaultCountry);
        }
      }
    } catch (err) {
      console.error('shopify webhook processing failed', topic, err);
    }
    return json({ ok: true });
  });
}
