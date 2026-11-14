// Keeps the knowledge base in step with what the store shows publicly: the catalogue
// (/products.json, paged) and the shop policies (/policies/<handle>.json). No login is needed.
import type { Env } from '../types';
import { all } from '../lib/db';
import { getSettings, patchSettings } from '../lib/settings';
import { type IngestInput, type KbDocRow, cleanText, ingestBulk } from './docs';
import { htmlToText } from './extract';
import { ensureSeeded } from './seed';

interface StoreVariant { title?: string; price?: string; compare_at_price?: string | null; available?: boolean; sku?: string | null }
interface StoreProduct {
  title?: string; handle?: string; body_html?: string | null; vendor?: string; product_type?: string; tags?: string[] | string;
  options?: { name?: string; values?: string[] }[]; variants?: StoreVariant[];
}
interface StorePolicy { title?: string; handle?: string; body?: string }

const POLICY_HANDLES = ['refund-policy', 'shipping-policy', 'privacy-policy', 'terms-of-service', 'contact-information', 'legal-notice', 'subscription-policy'];
const MAX_PAGES = 20;

const money = (v: string | null | undefined, symbol: string): string => (v ? `${symbol}${v}` : '');

/** One product as a knowledge document. `slim` leaves the description out (used when a fuller document already exists). */
export function productToMarkdown(p: StoreProduct, url: string, symbol: string, slim = false): string {
  const variants = p.variants ?? [];
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
  const lines: string[] = [`- URL: ${url}`];
  if (prices.length) {
    const lo = Math.min(...prices).toFixed(2);
    const hi = Math.max(...prices).toFixed(2);
    lines.push(`- Price: ${lo === hi ? `${symbol}${lo}` : `${symbol}${lo} to ${symbol}${hi}`}`);
  }
  if (p.product_type) lines.push(`- Product type: ${p.product_type}`);
  const tags = Array.isArray(p.tags) ? p.tags.join(', ') : p.tags ?? '';
  if (tags) lines.push(`- Tags: ${tags}`);
  const options = (p.options ?? []).filter((o) => o.name && o.name !== 'Title').map((o) => `${o.name}: ${(o.values ?? []).join(', ')}`);
  if (options.length) lines.push(`- Options: ${options.join('; ')}`);
  if (variants.length) {
    lines.push(`- Variants (${variants.length}). Format: variant | price | compare at price | available`);
    for (const v of variants) {
      lines.push(`  - ${v.title ?? 'Default'} | ${money(v.price, symbol)} | ${money(v.compare_at_price, symbol) || 'none'} | ${v.available === false ? 'no (sold out)' : 'yes'}`);
    }
  }
  const body = slim ? '' : htmlToText(p.body_html ?? '');
  return lines.join('\n') + (body ? `\n\n### Description\n\n${body}` : '');
}

// A tiny pretend store for local development and automated tests, where the real site must not be called.
function fixtureFetch(url: string): Response {
  const u = new URL(url);
  if (u.pathname === '/products.json') {
    const page = Number(u.searchParams.get('page') ?? '1');
    const products = page > 1 ? [] : [
      { title: 'Test Kit 1000W', handle: 'test-kit-1000w', body_html: '<p>A <strong>test</strong> kit.</p><ul><li>Rear wheel</li></ul>', product_type: 'Kit', tags: ['kits'],
        options: [{ name: 'Wheel size', values: ['26', '29'] }], variants: [{ title: '26', price: '300.00', compare_at_price: '350.00', available: true }, { title: '29', price: '320.00', compare_at_price: null, available: false }] },
      { title: 'Test Battery 48V', handle: 'test-battery-48v', body_html: '<p>Fixture battery.</p>', variants: [{ title: 'Default Title', price: '200.00', available: true }] },
    ];
    return Response.json({ products });
  }
  if (u.pathname === '/policies/refund-policy.json') return Response.json({ policy: { title: 'Refund policy', handle: 'refund-policy', body: '<h2>Returns</h2><p>Fixture returns text.</p>' } });
  return new Response('not found', { status: 404 });
}

export interface SyncResult { ok: boolean; added: number; updated: number; error?: string }

/** Pull the public catalogue and policies and upsert them as documents with source "store". Unchanged documents are left alone. */
export async function syncStore(env: Env): Promise<SyncResult> {
  await ensureSeeded(env);
  const settings = await getSettings(env.DB, true);
  const domain = settings.store.domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!domain) return { ok: false, added: 0, updated: 0, error: 'No store domain is set' };
  const base = `https://${domain}`;
  const test = env.ACX_TEST_MODE === '1';
  const get = async (path: string): Promise<Response> => {
    if (test) return fixtureFetch(base + path);
    return fetch(base + path, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; catalogue-sync)' }, signal: AbortSignal.timeout(20_000) });
  };
  const symbol = ({ GBP: '£', EUR: '€', USD: '$' } as Record<string, string>)[settings.store.currency] ?? `${settings.store.currency} `;

  const existing = await all<KbDocRow>(env.DB, `SELECT * FROM kb_docs WHERE source IN ('store', 'seed') AND source_ref IS NOT NULL`);
  const storeDocs = new Map(existing.filter((d) => d.source === 'store').map((d) => [d.source_ref!, d]));
  // Pages the starter knowledge already covers in more detail than the public feed does.
  const seeded = new Set(existing.filter((d) => d.source === 'seed' && d.enabled === 1).map((d) => d.source_ref!));

  let added = 0;
  let updated = 0;
  // Changes are collected and written together at the end, in a few database batches.
  const writes: { input: IngestInput; existing: KbDocRow | null }[] = [];
  const upsert = (ref: string, title: string, content: string, category: string): void => {
    const old = storeDocs.get(ref) ?? null;
    if (old && old.content === cleanText(content) && old.title === title) return;
    writes.push({ input: { id: old?.id, title, content, category, source: 'store', source_ref: ref }, existing: old });
    if (old) updated++; else added++;
  };

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(`/products.json?limit=250&page=${page}`);
      if (!res.ok) throw new Error(`The store answered ${res.status} for the product list`);
      const products = ((await res.json()) as { products?: StoreProduct[] }).products ?? [];
      if (!products.length) break;
      for (const p of products) {
        if (!p.handle || !p.title) continue;
        const url = `${base}/products/${p.handle}`;
        // Prices and stock change, so they are always synced. The description is skipped when the
        // starter knowledge has a richer copy of the same page.
        const slim = seeded.has(url);
        upsert(url, slim ? `${p.title} (live prices)` : p.title, productToMarkdown(p, url, symbol, slim), 'products');
      }
      if (products.length < 250) break;
    }
    for (const handle of POLICY_HANDLES) {
      const url = `${base}/policies/${handle}`;
      if (seeded.has(url)) continue;
      const res = await get(`/policies/${handle}.json`);
      if (!res.ok) continue; // not every store has every policy
      const policy = ((await res.json().catch(() => ({}))) as { policy?: StorePolicy }).policy;
      const text = htmlToText(policy?.body ?? '');
      if (!policy?.title || !text) continue;
      upsert(url, policy.title, `- URL: ${url}\n\n${text}`, handle === 'shipping-policy' ? 'shipping' : 'policies');
    }
    await ingestBulk(env, writes);
  } catch (err) {
    return { ok: false, added: 0, updated: 0, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
  await patchSettings(env.DB, 'store', { last_sync_at: Date.now() });
  return { ok: true, added, updated };
}
