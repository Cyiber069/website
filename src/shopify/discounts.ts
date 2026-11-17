// Discount codes in Shopify: a fixed amount off that only applies to the Kits, Bundles and Batteries
// collections. Field names checked against the Admin GraphQL schema, version 2026-10.
// Needs the write_discounts scope (and read_products to find the collections).
import type { Env } from '../types';
import { ShopifyError, adminGraphQL, shopifyAuth, type ShopifySession } from './client';

/** The store collections a creator code applies to, matched by title (case does not matter). */
export const DISCOUNT_COLLECTIONS = ['Kits', 'Bundles', 'Batteries'] as const;

const FIND_COLLECTIONS = `
query AcxDiscountCollections($kits: String!, $bundles: String!, $batteries: String!) {
  kits: collections(first: 10, query: $kits) { nodes { id title } }
  bundles: collections(first: 10, query: $bundles) { nodes { id title } }
  batteries: collections(first: 10, query: $batteries) { nodes { id title } }
}`;

const CREATE_CODE = `
mutation AcxDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount { ... on DiscountCodeBasic { status title } }
    }
    userErrors { field code message }
  }
}`;

type Nodes = { nodes: { id: string; title: string }[] };

export interface DiscountInput {
  code: string;
  amount: number;
  title: string;
  starts_at: number;
  expires_at: number | null;
  usage_limit: number | null;
}

export interface DiscountResult {
  ok: boolean;
  /** created | not_connected | failed */
  shopify_status: 'created' | 'not_connected' | 'failed';
  shopify_id?: string;
  /** Shopify's own status for the code, for example ACTIVE or SCHEDULED. */
  discount_status?: string;
  /** Short code for the reason it did not work: not_connected, missing_scope, collections_missing, code_taken, ... */
  error_code?: string;
  /** Plain words for the owner. */
  message?: string;
}

const SCOPE_HELP =
  'The Shopify app is not allowed to make discount codes yet. In the Shopify Dev Dashboard open the ACX Agent app, add write_discounts to the Scopes on Versions, press Release, then install the app on the store again.';

/** Finds the three collections by exact title. Throws a ShopifyError naming any that are missing. */
export async function findDiscountCollections(env: Env, session?: ShopifySession): Promise<string[]> {
  let data: Record<'kits' | 'bundles' | 'batteries', Nodes>;
  try {
    data = await adminGraphQL(env, FIND_COLLECTIONS, { kits: 'title:Kits', bundles: 'title:Bundles', batteries: 'title:Batteries' }, session);
  } catch (err) {
    if (err instanceof ShopifyError && err.code === 'missing_scope') {
      throw new ShopifyError('missing_scope', 'The Shopify app cannot read your collections. Add read_products and write_discounts to the app Scopes, press Release, then install the app again.');
    }
    throw err;
  }
  const ids: string[] = [];
  const missing: string[] = [];
  for (const [key, title] of [['kits', 'Kits'], ['bundles', 'Bundles'], ['batteries', 'Batteries']] as const) {
    const hit = (data[key]?.nodes ?? []).find((n) => n.title.trim().toLowerCase() === title.toLowerCase());
    if (hit) ids.push(hit.id); else missing.push(title);
  }
  if (missing.length) {
    throw new ShopifyError(
      'collections_missing',
      `Could not find the ${missing.join(' and ')} ${missing.length === 1 ? 'collection' : 'collections'} in Shopify, so the code was not made. Check the names in Shopify under Products, Collections.`,
    );
  }
  return ids;
}

function money(amount: number): string {
  return amount.toFixed(2);
}

/** Makes the code in Shopify when the API is connected. Never throws: the result says what happened. */
export async function createShopifyDiscount(env: Env, input: DiscountInput): Promise<DiscountResult> {
  // Read the saved details once for both calls (one query, not one per detail per call).
  const auth = await shopifyAuth(env.DB, env);
  if (auth.mode === 'none') {
    return { ok: false, shopify_status: 'not_connected', error_code: 'not_connected', message: 'Shopify is not connected: make the code in Shopify yourself, then press Send message.' };
  }
  const session: ShopifySession = { auth, token: null };
  try {
    const collections = await findDiscountCollections(env, session);
    const basicCodeDiscount: Record<string, unknown> = {
      title: input.title,
      code: input.code,
      startsAt: new Date(input.starts_at).toISOString(),
      endsAt: input.expires_at ? new Date(input.expires_at).toISOString() : null,
      usageLimit: input.usage_limit ?? null,
      appliesOncePerCustomer: false,
      context: { all: 'ALL' },
      customerGets: {
        value: { discountAmount: { amount: money(input.amount), appliesOnEachItem: false } },
        items: { collections: { add: collections } },
      },
    };
    let data: { discountCodeBasicCreate: { codeDiscountNode: { id: string; codeDiscount: { status?: string } | null } | null; userErrors: { field: string[] | null; code: string | null; message: string }[] } };
    try {
      data = await adminGraphQL(env, CREATE_CODE, { basicCodeDiscount }, session);
    } catch (err) {
      if (err instanceof ShopifyError && (err.code === 'missing_scope' || err.code === 'unauthorised')) throw new ShopifyError('missing_scope', SCOPE_HELP);
      throw err;
    }
    const res = data.discountCodeBasicCreate;
    const errors = res?.userErrors ?? [];
    if (errors.length || !res?.codeDiscountNode) {
      const first = errors[0];
      if (first?.code === 'TAKEN' || /taken|already/i.test(first?.message ?? '')) {
        return { ok: false, shopify_status: 'failed', error_code: 'code_taken', message: `The code ${input.code} already exists in Shopify. If it is the right one, press Send message. If not, pick another code.` };
      }
      if (/access|scope|permission/i.test(first?.message ?? '')) return { ok: false, shopify_status: 'failed', error_code: 'missing_scope', message: SCOPE_HELP };
      return { ok: false, shopify_status: 'failed', error_code: 'shopify_refused', message: `Shopify did not make the code: ${(first?.message ?? 'no reason given').slice(0, 200)}` };
    }
    return { ok: true, shopify_status: 'created', shopify_id: res.codeDiscountNode.id, discount_status: res.codeDiscountNode.codeDiscount?.status ?? 'ACTIVE' };
  } catch (err) {
    if (err instanceof ShopifyError) return { ok: false, shopify_status: 'failed', error_code: err.code, message: err.message };
    console.error('discount create failed', err);
    return { ok: false, shopify_status: 'failed', error_code: 'unknown', message: 'Something went wrong while talking to Shopify. The code was not made.' };
  }
}
