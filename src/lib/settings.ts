import type { Settings } from '../types';
import { all, one, run, stmt } from './db';
import { onReset } from './cache';

/**
 * Version of the pacing group. Version 1 rows (no `schema` key) hold the old slow values (wait 12 s
 * for the customer, then 5 to 20 s more). They are moved once to the fast defaults; see migratePacing.
 */
export const PACING_SCHEMA = 2;

/**
 * Version of the brain group. Rows from before version 2 (no `schema`) held Opus as the default model
 * whether the owner picked it or not (the Connections form always sent the model). See migrateBrain.
 */
export const BRAIN_SCHEMA = 2;
/**
 * The default Claude model setting: Haiku answers, Sonnet at low effort answers the chats that matter
 * (src/brain/route.ts). This id is only what Connections shows and sends. The stored row keeps
 * `mix: true` with a real API model id in `model` (MIX_BASE_MODEL), so an older Worker after a rollback
 * still sends a model Claude knows.
 */
export const MIX_MODEL = 'mix-haiku-sonnet';
export const MIX_BASE_MODEL = 'claude-haiku-5-5';
const API_MODEL = /^claude-[a-z0-9.-]+$/;

export const DEFAULT_SETTINGS: Settings = {
  agent: { enabled: true },
  channels: {
    whatsapp: { mode: 'auto' },
    gmail: { mode: 'review' },
    tiktok: { mode: 'auto' },   // TikTok customers are answered on their own (owner, 2026-11-25)
  },
  voice: {
    brand_name: 'ACX',
    mirror_level: 'match',
    max_chars: 260,
    max_sentences: 3,
    commas: 'normal',
    emojis: 'mirror',
    extra_rules: '',
    banned_phrases: [],
    bot_question_policy: 'honest_short',
    holding_reply: true,
  },
  brain: {
    provider: 'auto',
    model: MIX_BASE_MODEL,
    mix: true,
    model_chosen: false,
    schema: BRAIN_SCHEMA,
    effort: 'low',
    workers_ai_model: '@cf/google/gemma-4-26b-a4b-it',
    confidence_threshold: 0.6,
    kb_full_tokens: 24_000,
    kb_top_chunks: 14,
  },
  // Reply as fast as possible: a short quiet wait so a burst of messages gets one reply, and no extra
  // delay. Replies are pasted whole; typing_cps is only used for the checkout reminders.
  pacing: {
    schema: PACING_SCHEMA,
    settle_seconds: 4,
    min_reply_delay_s: 0,
    max_reply_delay_s: 0,
    typing_cps: 11,
    max_auto_replies_per_thread_per_hour: 30,
    human_takeover_minutes: 15,
    ignore_older_than_hours: 24,
    // A human pace for the agent's own replies on WhatsApp and TikTok (owner, 2026-11-25): about 10 s of
    // "typing..." before each message and about 10 s between two messages. 0 turns either off.
    typing_seconds: 10,
    gap_seconds: 10,
  },
  recovery: {
    enabled: true,
    send_hour_london: 20,
    window_minutes: 90,
    min_age_minutes: 60,
    max_age_hours: 48,
    daily_cap: 5,
    cooldown_days: 30,
    consent_mode: 'all',
    consent_confirmed: false,
    countries: [],
    spacing_seconds: [180, 480],
    personalize: true,
    include_link: false,
    opt_out_line: true,
    template: { text: '', approved: false, updated_at: null },
  },
  alerts: { push: true, whatsapp_number: '', offline_minutes: 10 },
  gmail: {
    account: '',
    ignore_senders: [
      'pinterest.com', 'instagram.com', 'facebookmail.com', 'facebook.com', 'meta.com', 'tiktok.com', 'tiktokshop.com',
      'youtube.com', 'google.com', 'linkedin.com', 'x.com', 'twitter.com', 'snapchat.com',
      'shopify.com', 'shopifyemail.com', 'klaviyo.com', 'mailchimp.com', 'paypal.com', 'stripe.com', 'nuvei.com', 'klarna.com',
      'royalmail.com', 'parcelforce.com', 'dpd.co.uk', 'evri.com', 'dhl.com', 'ups.com', 'fedex.com', 'yodel.co.uk',
      'amazon.com', 'amazon.co.uk', 'aliexpress.com', 'alibaba.com', 'matefulfill.com', 'dsers.com', 'cloudflare.com', 'github.com',
    ],
  },
  discounts: {
    mode: 'auto',   // the agent makes creator codes itself (owner, 2026-11-23)
    amount: 20,
    currency: 'GBP',
    applies_to: 'kits, bundles and batteries',
    message: "Your discount code {CODE} is now live!! It's £{AMOUNT} off all kits, bundles and batteries",
    daily_cap: 10,
    one_per_customer: true,
  },
  // Selling (src/sales): one follow up after a recommendation, and the sales style in the prompt.
  sales: {
    follow_ups: true,
    follow_up_hours: 20,
    style: 'friendly',
  },
  // Google AI Studio reads photos and videos (src/vision). On by default, but only once a key is saved.
  vision: {
    enabled: true,
    model: 'gemini-3.8-flash',
    video_daily_cap: 20,
  },
  store: {
    name: 'ACX Ebikes',
    domain: 'acxebikes.com',
    myshopify_domain: 'udh158-w3.myshopify.com',
    currency: 'GBP',
    default_country: 'GB',
    sync_public: true,
    last_sync_at: null,
  },
};

type Group = keyof Settings;
const GROUPS = Object.keys(DEFAULT_SETTINGS) as Group[];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Stored values win, but only for keys that exist in the defaults and have the same basic type. */
function mergeKnown<T>(defaults: T, stored: unknown): T {
  if (!isObject(defaults)) {
    if (stored === undefined || stored === null) return defaults;
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
    return (typeof stored === typeof defaults ? stored : defaults) as T;
  }
  const out: Record<string, unknown> = {};
  const src = isObject(stored) ? stored : {};
  for (const [k, dv] of Object.entries(defaults as Record<string, unknown>)) {
    const sv = src[k];
    if (dv === null) out[k] = sv === undefined ? null : sv; // nullable leaf, accept any stored scalar
    else out[k] = mergeKnown(dv, sv);
  }
  return out as T;
}

/**
 * Values that older versions stored and that no longer exist. Applied every time settings are read or
 * written, so the stored row never has to be edited by hand.
 *   voice.commas 'light' (the old default, "only when needed") now means 'normal': commas as written.
 */
function upgrade<G extends Group>(group: G, value: Settings[G]): Settings[G] {
  if (group === 'voice') {
    const voice = value as Settings['voice'];
    if (voice.commas !== 'none') voice.commas = 'normal';
  }
  if (group === 'brain') normaliseBrain(value as Settings['brain']);
  return value;
}

/**
 * brain.model is always a real Claude API model id, so an older Worker (after a rollback) can still use
 * it. The mix is `mix: true` with Haiku as the model. The mix id in `model` (an earlier build stored it
 * there) or anything that is not a Claude model id becomes the mix.
 */
export function normaliseBrain(b: Settings['brain']): Settings['brain'] {
  if (b.model === MIX_MODEL || !API_MODEL.test(b.model)) b.mix = true;
  if (b.mix) b.model = MIX_BASE_MODEL;
  return b;
}

/**
 * One time move of stored pacing to the fast defaults (owner directive: reply as fast as possible).
 * Only rows saved before version 2 are changed, so a value the owner saves afterwards is kept.
 * Returns true when it changed something, so the caller can save the row once.
 */
export function migratePacing(raw: unknown, value: Settings['pacing']): boolean {
  if (!isObject(raw)) return false; // nothing stored: the defaults are already the new ones
  if (typeof raw.schema === 'number' && raw.schema >= PACING_SCHEMA) return false;
  value.schema = PACING_SCHEMA;
  value.settle_seconds = DEFAULT_SETTINGS.pacing.settle_seconds;
  value.min_reply_delay_s = 0;
  value.max_reply_delay_s = 0;
  // The old default of 10 replies an hour pauses a lively chat now that bursts are answered sooner.
  if (raw.max_auto_replies_per_thread_per_hour === 10) value.max_auto_replies_per_thread_per_hour = DEFAULT_SETTINGS.pacing.max_auto_replies_per_thread_per_hour;
  return true;
}

/**
 * One time move of a brain row saved before version 2. Opus was the default and the form always sent
 * the model, so a stored Opus (or no model) that was never marked as chosen becomes the new default mix.
 * Any other model was picked by the owner: it is kept and marked as chosen. A row with the mix id in
 * `model` (an earlier build) gets `mix` instead. Returns true when it changed something, so the caller
 * can save the row once.
 */
export function migrateBrain(raw: unknown, value: Settings['brain']): boolean {
  if (!isObject(raw)) return false; // nothing stored: the defaults are already the new ones
  const model = typeof raw.model === 'string' ? raw.model : '';
  const current = typeof raw.schema === 'number' && raw.schema >= BRAIN_SCHEMA;
  if (current && typeof raw.mix === 'boolean' && model !== MIX_MODEL) return false;
  value.schema = BRAIN_SCHEMA;
  if (model === MIX_MODEL || raw.mix === true) {
    value.mix = true;
    value.model_chosen = raw.model_chosen === true;
  } else if (API_MODEL.test(model) && (raw.model_chosen === true || current || model !== 'claude-opus-5-5')) {
    value.mix = false;
    value.model = model;
    value.model_chosen = true;
  } else {
    value.mix = true;
    value.model_chosen = false;
  }
  normaliseBrain(value);
  return true;
}

/**
 * State rows read in the same query as the settings groups, so knowing them costs no extra query:
 * today's database use (the budget guard, src/lib/budget.ts), the knowledge version (src/kb/cache.ts)
 * and the settings revision (below), and what the owner locked (src/lib/locks.ts).
 */
const BUNDLED_STATE = ['d1_usage', 'kb_version', 'settings_rev', 'locks', 'ai_state', 'fx_rates'] as const;
export type BundledState = (typeof BUNDLED_STATE)[number];

interface Bundle { at: number; value: Settings; state: Partial<Record<BundledState, unknown>>; rev: number }

/**
 * One read of the settings per isolate every 30 s: it was the most read table (once a request). A change
 * made here empties it at once. A change made through another isolate is seen within 30 s, or sooner:
 * every signed in request reads the revision with its session or device row (src/lib/auth.ts) and a
 * newer one empties the cache before the request reads the settings.
 */
export const SETTINGS_CACHE_MS = 30_000;
let cache: Bundle | null = null;
let loading: Promise<Bundle> | null = null;
let newestRev = 0;
onReset(() => { cache = null; loading = null; newestRev = 0; }, 'settings');

const asNumber = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The settings revision a request saw (a JSON number in state:settings_rev). Newer than the cache: it is dropped. */
export function noteSettingsRev(raw: unknown): void {
  const n = asNumber(typeof raw === 'string' ? raw.replace(/"/g, '') : raw);
  if (n > newestRev) newestRev = n;
}

/** Forget the cached settings in this isolate (the next read goes to D1). */
export function invalidateSettings(): void {
  cache = null;
  loading = null;
}

async function loadBundle(db: D1Database): Promise<Bundle> {
  // Only the group rows and the bundled state rows, by primary key: never the whole table.
  const keys = [...GROUPS, ...BUNDLED_STATE.map((k) => `state:${k}`)];
  const rows = await all<{ key: string; value: string }>(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys);
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value); } catch { /* ignore a corrupt row, defaults apply */ }
  }
  const value = {} as Record<Group, unknown>;
  for (const g of GROUPS) value[g] = upgrade(g, mergeKnown(DEFAULT_SETTINGS[g], stored[g]));
  const pacing = value.pacing as Settings['pacing'];
  if (migratePacing(stored.pacing, pacing)) {
    // Saved straight away so it happens once. If the write fails the same values are used and it is tried again.
    await run(db, 'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', JSON.stringify(pacing), Date.now(), 'pacing').catch((err) => console.error('pacing upgrade not saved', err));
  }
  const brain = value.brain as Settings['brain'];
  if (migrateBrain(stored.brain, brain)) {
    await run(db, 'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', JSON.stringify(brain), Date.now(), 'brain').catch((err) => console.error('brain upgrade not saved', err));
  }
  const state: Bundle['state'] = {};
  for (const k of BUNDLED_STATE) if (`state:${k}` in stored) state[k] = stored[`state:${k}`];
  const rev = asNumber(state.settings_rev);
  if (rev > newestRev) newestRev = rev;
  return { at: Date.now(), value: value as unknown as Settings, state, rev };
}

async function bundle(db: D1Database, fresh = false): Promise<Bundle> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < SETTINGS_CACHE_MS && now >= cache.at && cache.rev >= newestRev) return cache;
  if (!fresh && loading) return loading;
  const p = loadBundle(db);
  if (!fresh) loading = p;
  try {
    const b = await p;
    cache = b;
    return b;
  } finally {
    if (loading === p) loading = null;
  }
}

export async function getSettings(db: D1Database, fresh = false): Promise<Settings> {
  return (await bundle(db, fresh)).value;
}

/** A state row that comes with the settings read (no extra query, up to 30 s old). */
export async function cachedState<T>(db: D1Database, key: BundledState, fallback: T): Promise<T> {
  const b = await bundle(db);
  return key in b.state ? (b.state[key] as T) : fallback;
}

/** Shallow-merge a patch into one settings group and persist it. Unknown keys are dropped. */
export async function patchSettings<G extends Group>(db: D1Database, group: G, patch: Partial<Settings[G]>): Promise<Settings[G]> {
  const current = (await getSettings(db, true))[group];
  const merged: Record<string, unknown> = { ...(current as object), ...(patch as object) };
  // A model sent without `mix` is a plain model choice, or the mix when it is the mix id.
  if (group === 'brain' && 'model' in patch && !('mix' in patch)) merged.mix = merged.model === MIX_MODEL;
  const next = upgrade(group, mergeKnown(DEFAULT_SETTINGS[group], merged));
  if (group === 'pacing') (next as Settings['pacing']).schema = PACING_SCHEMA; // never set back by a client
  if (group === 'brain') (next as Settings['brain']).schema = BRAIN_SCHEMA;
  const now = Date.now();
  const rev = Math.max(now, newestRev + 1);
  // The new revision goes in the same round trip: other isolates drop their cached settings on their next signed in request.
  await db.batch([
    stmt(db, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      group, JSON.stringify(next), now),
    stmt(db, `INSERT INTO settings (key, value, updated_at) VALUES ('state:settings_rev', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      JSON.stringify(rev), now),
  ]);
  invalidateSettings();
  newestRev = rev;
  return next;
}

export function isSettingsGroup(name: string): name is Group {
  return (GROUPS as string[]).includes(name);
}

// ---- free form key/value state (not user settings) ---------------------------------------------

export async function getState<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', `state:${key}`);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export async function setState(db: D1Database, key: string, value: unknown): Promise<void> {
  await run(
    db,
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    `state:${key}`, JSON.stringify(value), Date.now(),
  );
}

// ---- secrets --------------------------------------------------------------------------------------

export async function getSecret(db: D1Database, key: string): Promise<string | null> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM secrets WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSecret(db: D1Database, key: string, value: string): Promise<void> {
  const v = value.trim();
  if (!v) {
    await run(db, 'DELETE FROM secrets WHERE key = ?', key);
    return;
  }
  await run(
    db,
    'INSERT INTO secrets (key, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = excluded.updated_at',
    key, v, v.slice(-4), Date.now(),
  );
}

/** Which secrets are saved, with a safe hint. Never returns values. */
export async function secretHints(db: D1Database): Promise<Record<string, { hint: string; updated_at: number }>> {
  const rows = await all<{ key: string; hint: string; updated_at: number }>(db, 'SELECT key, hint, updated_at FROM secrets');
  const out: Record<string, { hint: string; updated_at: number }> = {};
  for (const r of rows) out[r.key] = { hint: r.hint, updated_at: r.updated_at };
  return out;
}
