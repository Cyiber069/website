import type { Settings } from '../types';
import { all, one, run } from './db';

export const DEFAULT_SETTINGS: Settings = {
  agent: { enabled: true },
  channels: {
    whatsapp: { mode: 'auto' },
    gmail: { mode: 'review' },
    tiktok: { mode: 'review' },
  },
  voice: {
    brand_name: 'ACX',
    mirror_level: 'match',
    max_chars: 260,
    max_sentences: 3,
    commas: 'light',
    emojis: 'mirror',
    extra_rules: '',
    banned_phrases: [],
    bot_question_policy: 'honest_short',
    holding_reply: true,
  },
  brain: {
    provider: 'auto',
    model: 'claude-opus-5-5',
    effort: 'low',
    workers_ai_model: '@cf/google/gemma-4-26b-a4b-it',
    confidence_threshold: 0.6,
    kb_full_tokens: 24_000,
    kb_top_chunks: 14,
  },
  pacing: {
    settle_seconds: 12,
    min_reply_delay_s: 5,
    max_reply_delay_s: 20,
    typing_cps: 11,
    max_auto_replies_per_thread_per_hour: 10,
    human_takeover_minutes: 30,
    ignore_older_than_hours: 24,
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
  gmail: { account: '' },
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

let cache: { at: number; value: Settings } | null = null;
const CACHE_MS = 5_000;

export async function getSettings(db: D1Database, fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value); } catch { /* ignore a corrupt row, defaults apply */ }
  }
  const value = {} as Record<Group, unknown>;
  for (const g of GROUPS) value[g] = mergeKnown(DEFAULT_SETTINGS[g], stored[g]);
  cache = { at: Date.now(), value: value as unknown as Settings };
  return cache.value;
}

/** Shallow-merge a patch into one settings group and persist it. Unknown keys are dropped. */
export async function patchSettings<G extends Group>(db: D1Database, group: G, patch: Partial<Settings[G]>): Promise<Settings[G]> {
  const current = (await getSettings(db, true))[group];
  const next = mergeKnown(DEFAULT_SETTINGS[group], { ...(current as object), ...(patch as object) });
  await run(
    db,
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    group, JSON.stringify(next), Date.now(),
  );
  cache = null;
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
