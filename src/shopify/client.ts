// Admin GraphQL client for the owner's one Shopify store.
//
// Two ways to authenticate, whichever the owner saved on the Connections screen:
//   1. shopify_admin_token: a ready made Admin API token (older stores with a legacy custom app).
//   2. shopify_client_id + shopify_client_secret: a Dev Dashboard app. We swap them for a 24 hour
//      token with the client credentials grant and keep it in settings state until shortly before
//      it runs out.
// The store is always addressed by its *.myshopify.com domain (settings.store.myshopify_domain).
import type { Env } from '../types';
import { all } from '../lib/db';
import { getSettings, getState, setState } from '../lib/settings';
import { MIN } from '../lib/time';

export const API_VERSION = '2026-10';
const TOKEN_STATE = 'shopify_token';
/** Ask for a new token this long before the old one expires. */
const TOKEN_SKEW_MS = 10 * MIN;
const REQUEST_TIMEOUT_MS = 20_000;

/** An error whose message is safe and useful to show the owner. */
export class ShopifyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ShopifyAuth {
  mode: 'admin_token' | 'client_credentials' | 'none';
  domain: string;
  /** Where the Admin API is: https://<domain>, or a fake Shopify in tests. */
  base: string;
  /** The saved details, read once (one query) and passed along so a request never reads them again. */
  creds: { adminToken: string | null; clientId: string | null; clientSecret: string | null };
}

const SECRET_KEYS = ['shopify_admin_token', 'shopify_client_id', 'shopify_client_secret'] as const;

/** Accepts "abc-123", "abc-123.myshopify.com" or a pasted admin URL. Returns '' when it is not a store domain. */
export function normaliseShopDomain(input: string): string {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  // https://admin.shopify.com/store/abc-123/settings
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(d);
  if (admin) d = admin[1]!;
  d = d.split(/[/?#]/)[0]!;
  if (/^[a-z0-9][a-z0-9-]*$/.test(d)) d = `${d}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d) ? d : '';
}

/**
 * How to reach the store: the mode, the domain and every saved detail, in one query (the free plan
 * allows 50 per request and a code request makes two Admin API calls). `env` is only needed to let
 * the tests point it at a fake Shopify (test mode only).
 */
export async function shopifyAuth(db: D1Database, env?: Env): Promise<ShopifyAuth> {
  const [settings, rows] = await Promise.all([
    getSettings(db),
    all<{ key: string; value: string }>(db, `SELECT key, value FROM secrets WHERE key IN (${SECRET_KEYS.map(() => '?').join(', ')})`, ...SECRET_KEYS),
  ]);
  const got = new Map(rows.map((r) => [r.key, r.value]));
  const creds = { adminToken: got.get('shopify_admin_token') ?? null, clientId: got.get('shopify_client_id') ?? null, clientSecret: got.get('shopify_client_secret') ?? null };
  const domain = normaliseShopDomain(settings.store.myshopify_domain);
  const mode = creds.adminToken ? 'admin_token' : creds.clientId && creds.clientSecret ? 'client_credentials' : 'none';
  const fake = env?.ACX_TEST_MODE === '1' ? await getState<string | null>(db, 'test_shopify_base', null) : null;
  return { mode, domain, base: fake && /^http:\/\/127\.0\.0\.1:\d+$/.test(fake) ? fake : `https://${domain}`, creds };
}

/** True when the Admin API can be called (a token or an app id and secret is saved). */
export async function hasApiCredentials(db: D1Database): Promise<boolean> {
  return (await shopifyAuth(db)).mode !== 'none';
}

/** Forget the cached client credentials token (after the owner changes or removes credentials). */
export async function clearTokenCache(db: D1Database): Promise<void> {
  await setState(db, TOKEN_STATE, null);
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ShopifyError('unreachable', 'Could not reach Shopify. Check the store address and try again.');
  }
}

/** Client credentials grant. The token lasts 24 hours and there is no refresh token: we just ask again. */
async function requestToken(db: D1Database, auth: ShopifyAuth): Promise<string> {
  const { clientId, clientSecret } = auth.creds;
  const domain = auth.domain;
  if (!clientId || !clientSecret) throw new ShopifyError('not_connected', 'No Shopify app details are saved yet.');
  const res = await timedFetch(`${auth.base}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes('shop_not_permitted')) {
      throw new ShopifyError('shop_not_permitted', 'Shopify refused: the app and the store are not in the same Shopify organisation, or the app is not installed on the store yet.');
    }
    if (res.status === 404) throw new ShopifyError('wrong_domain', `Shopify does not know the store ${domain}. Check the myshopify address.`);
    throw new ShopifyError('bad_credentials', 'Shopify did not accept the Client ID and Client secret. Copy both again from the app settings.');
  }
  let body: { access_token?: string; expires_in?: number };
  try { body = JSON.parse(text) as typeof body; } catch { body = {}; }
  if (!body.access_token) throw new ShopifyError('bad_credentials', 'Shopify answered without a token. Check the app is installed on the store.');
  const expiresAt = Date.now() + (body.expires_in ?? 86_399) * 1000;
  await setState(db, TOKEN_STATE, { token: body.access_token, expires_at: expiresAt, domain });
  return body.access_token;
}

async function accessToken(db: D1Database, auth: ShopifyAuth, forceNew = false): Promise<string> {
  if (auth.mode === 'admin_token' && auth.creds.adminToken) return auth.creds.adminToken;
  if (auth.mode === 'none') throw new ShopifyError('not_connected', 'Shopify is not connected yet.');
  if (!forceNew) {
    const cached = await getState<{ token: string; expires_at: number; domain: string } | null>(db, TOKEN_STATE, null);
    if (cached?.token && cached.domain === auth.domain && cached.expires_at - TOKEN_SKEW_MS > Date.now()) return cached.token;
  }
  return requestToken(db, auth);
}

/** The auth and token for several Admin API calls in one request, read once. */
export interface ShopifySession { auth: ShopifyAuth; token: string | null }

interface GqlError { message: string; extensions?: { code?: string } }
interface GqlResponse<T> {
  data?: T | null;
  errors?: GqlError[] | string;
  extensions?: { cost?: { requestedQueryCost: number; throttleStatus: { currentlyAvailable: number; restoreRate: number } } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one Admin GraphQL query. Refreshes an expired token once and waits out short throttles. Pass a
 * `session` to share the auth and token between calls of one request (no database reads then).
 */
export async function adminGraphQL<T>(env: Env, query: string, variables: Record<string, unknown> = {}, session?: ShopifySession): Promise<T> {
  const db = env.DB;
  const auth = session?.auth ?? (await shopifyAuth(db, env));
  if (!auth.domain) throw new ShopifyError('wrong_domain', 'The store address should look like your-store.myshopify.com.');
  let token = session?.token ?? (await accessToken(db, auth));
  if (session) session.token = token;
  let refreshed = false;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await timedFetch(`${auth.base}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 || res.status === 403) {
      // A cached token can be revoked early. Ask for a fresh one once, then give up.
      if (auth.mode === 'client_credentials' && !refreshed) {
        refreshed = true;
        token = await accessToken(db, auth, true);
        if (session) session.token = token;
        continue;
      }
      throw new ShopifyError('unauthorised', 'Shopify rejected the saved access details. Check the app is still installed and has the order permissions.');
    }
    if (res.status === 404) throw new ShopifyError('wrong_domain', `Shopify does not know the store ${auth.domain}. Check the myshopify address.`);
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(5000, (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) throw new ShopifyError('http_error', `Shopify answered with an error (${res.status}).`);

    const body = (await res.json()) as GqlResponse<T>;
    const errors = Array.isArray(body.errors) ? body.errors : body.errors ? [{ message: String(body.errors) }] : [];
    if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
      const c = body.extensions?.cost;
      const wait = c ? (c.requestedQueryCost - c.throttleStatus.currentlyAvailable) / c.throttleStatus.restoreRate : 2;
      await sleep(Math.min(8000, Math.max(1, Math.ceil(wait)) * 1000));
      continue;
    }
    if (errors.length && !body.data) {
      // With data present the errors are field redactions (protected customer data): the rest is still usable.
      if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
        throw new ShopifyError('missing_scope', 'The Shopify app is missing a permission. It needs read_orders and read_customers, then install the app again.');
      }
      throw new ShopifyError('graphql_error', `Shopify could not run the request: ${errors[0]!.message.slice(0, 200)}`);
    }
    if (!body.data) throw new ShopifyError('graphql_error', 'Shopify sent an empty answer.');
    return body.data;
  }
  throw new ShopifyError('busy', 'Shopify is busy right now. Try again in a minute.');
}

// ---- abandoned checkouts -----------------------------------------------------------------------------

// Fields checked against the 2026-10 schema. Consent lives on the customer's default phone number and
// email address (the older customer level consent fields are deprecated).
const ABANDONED_CHECKOUTS = `
query AcxAbandonedCheckouts($first: Int!, $after: String, $query: String!) {
  abandonedCheckouts(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    nodes {
      id
      name
      abandonedCheckoutUrl
      createdAt
      updatedAt
      completedAt
      totalPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { amount currencyCode }
      }
      lineItems(first: 10) { nodes { title variantTitle quantity } }
      shippingAddress { firstName phone countryCodeV2 }
      billingAddress { firstName phone countryCodeV2 }
      customer {
        id
        firstName
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber {
          phoneNumber
          smsMarketingConsent { state }
          whatsAppMarketingConsent { state }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface Money { amount: string; currencyCode: string }
interface ApiAddress { firstName: string | null; phone: string | null; countryCodeV2: string | null }

/** One abandoned checkout as the Admin API returns it. */
export interface AbandonedCheckoutNode {
  id: string;
  name: string | null;
  abandonedCheckoutUrl: string | null;
  createdAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  totalPriceSet: { shopMoney: Money | null; presentmentMoney: Money | null } | null;
  lineItems: { nodes: { title: string | null; variantTitle: string | null; quantity: number }[] } | null;
  shippingAddress: ApiAddress | null;
  billingAddress: ApiAddress | null;
  customer: {
    id: string;
    firstName: string | null;
    defaultEmailAddress: { emailAddress: string | null; marketingState: string | null } | null;
    defaultPhoneNumber: {
      phoneNumber: string | null;
      smsMarketingConsent: { state: string | null } | null;
      whatsAppMarketingConsent: { state: string | null } | null;
    } | null;
  } | null;
}

const PAGE_SIZE = 25; // about 630 cost points per page, under Shopify's 1,000 point ceiling for one query

/**
 * Checkouts created since `since`, oldest first, completed ones included so the caller can mark
 * them recovered. Follows the cursor until the last page (at most `maxPages`).
 */
export async function fetchAbandonedCheckouts(env: Env, since: number, maxPages = 20): Promise<AbandonedCheckoutNode[]> {
  const search = `created_at:>='${new Date(since).toISOString()}'`;
  const out: AbandonedCheckoutNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: { abandonedCheckouts: { nodes: AbandonedCheckoutNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await adminGraphQL(env, ABANDONED_CHECKOUTS, { first: PAGE_SIZE, after, query: search });
    const conn = data.abandonedCheckouts;
    for (const node of conn.nodes ?? []) {
      // Filter again here: Shopify silently ignores a search term it does not understand and returns everything.
      if (node && Date.parse(node.createdAt) >= since) out.push(node);
    }
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

export interface ConnectionTest {
  ok: boolean;
  shop_name?: string;
  /** Checkouts Shopify lists for the last two days (first page). */
  checkouts?: number;
  error?: string;
}

/** Proves the saved details work end to end: token, store name, and the exact query the daily run uses. */
export async function testConnection(env: Env): Promise<ConnectionTest> {
  try {
    const auth = await shopifyAuth(env.DB);
    if (auth.mode === 'none') return { ok: false, error: 'No Shopify app details are saved yet.' };
    const shop = await adminGraphQL<{ shop: { name: string } }>(env, 'query AcxShop { shop { name } }');
    const recent = await fetchAbandonedCheckouts(env, Date.now() - 48 * 60 * MIN, 1);
    return { ok: true, shop_name: shop.shop.name, checkouts: recent.length };
  } catch (err) {
    if (err instanceof ShopifyError) return { ok: false, error: err.message };
    console.error('shopify test failed', err);
    return { ok: false, error: 'Something went wrong while talking to Shopify.' };
  }
}
