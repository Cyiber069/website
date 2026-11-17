// The knowledge base held in memory by one isolate, so each decision does not read it again from D1.
//
// Every write to the knowledge base (src/kb/docs.ts) adds one to the version in the settings row
// state:kb_version, in the same batch. The version comes with the settings read (src/lib/settings.ts,
// cached about 30 s), so another isolate's change is seen within about 30 s at no extra query. A write
// made in this isolate empties the caches at once. A knowledge row changed by hand in D1 should bump
// state:kb_version too; without that it is seen after CORPUS_MS at the latest.
import type { Env } from '../types';
import { all, stmt } from '../lib/db';
import { onReset } from '../lib/cache';
import { cachedState, invalidateSettings } from '../lib/settings';
import { MIN } from '../lib/time';
import type { KbDocRow } from './docs';

export interface CorpusChunk { id: number; doc_id: string; ord: number; heading: string; content: string; token_estimate: number }

export interface Corpus {
  key: string;
  at: number;
  /** Every document, in the order listDocuments gives them (pinned first, then category, title, id). */
  docs: KbDocRow[];
  byId: Map<string, KbDocRow>;
  chunks: Map<number, CorpusChunk>;
  /** How many chunks each document has, so a search knows how many rows to fetch past the ones it skips. */
  chunksPerDoc: Map<string, number>;
}

/** The longest a loaded knowledge base is used without a version change. */
export const CORPUS_MS = 30 * MIN;
/** Search results for the same words. */
export const SEARCH_MS = 5 * MIN;
const MAX_SEARCHES = 200;

let local = 0;
let corpus: Corpus | null = null;
let loading: Promise<Corpus> | null = null;
const searches = new Map<string, { at: number; value: unknown }>();
let totals: { key: string; at: number; docs: number; tokens: number } | null = null;

function clear(): void {
  corpus = null;
  loading = null;
  searches.clear();
  totals = null;
}
onReset(() => { clear(); local++; }, 'kb');

/** The statement that marks the knowledge base as changed. Put it in the same batch as the write. */
export function kbVersionStatement(db: D1Database): D1PreparedStatement {
  const now = Date.now();
  return stmt(db,
    `INSERT INTO settings (key, value, updated_at) VALUES ('state:kb_version', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`, now);
}

/** This isolate wrote to the knowledge base: what it holds is out of date. */
export function kbChanged(): void {
  local++;
  clear();
  invalidateSettings(); // the next settings read brings the new version for the other caches
}

/** The version the caches are keyed by: the stored one and this isolate's own writes. */
export async function kbVersionKey(env: Env): Promise<string> {
  return `${Number(await cachedState<unknown>(env.DB, 'kb_version', 0)) || 0}:${local}`;
}

async function loadCorpus(env: Env, key: string): Promise<Corpus> {
  const [docs, chunks] = await Promise.all([
    all<KbDocRow>(env.DB, `SELECT id, title, category, source, source_ref, filename, mime, bytes, content, enabled, pinned, token_estimate, created_at, updated_at
      FROM kb_docs ORDER BY pinned DESC, category ASC, title ASC, id ASC`),
    all<CorpusChunk>(env.DB, 'SELECT id, doc_id, ord, heading, content, token_estimate FROM kb_chunks'),
  ]);
  const byChunk = new Map<number, CorpusChunk>();
  const perDoc = new Map<string, number>();
  for (const c of chunks) { byChunk.set(c.id, c); perDoc.set(c.doc_id, (perDoc.get(c.doc_id) ?? 0) + 1); }
  return { key, at: Date.now(), docs, byId: new Map(docs.map((d) => [d.id, d])), chunks: byChunk, chunksPerDoc: perDoc };
}

/**
 * The whole knowledge base (documents and chunks with their text), loaded once per version and isolate:
 * about one row per document and per chunk. `force` loads it again (a search found a chunk it does not hold).
 */
export async function getCorpus(env: Env, force = false): Promise<Corpus> {
  const key = await kbVersionKey(env);
  const now = Date.now();
  if (!force && corpus && corpus.key === key && now - corpus.at < CORPUS_MS && now >= corpus.at) return corpus;
  if (!force && loading) return loading;
  const p = loadCorpus(env, key);
  loading = p;
  try {
    const c = await p;
    if (loading === p) { corpus = c; if (searches.size) searches.clear(); }
    return c;
  } finally {
    if (loading === p) loading = null;
  }
}

/** The corpus when it is already in memory and current, else null (nothing is read). */
export async function corpusIfLoaded(env: Env): Promise<Corpus | null> {
  const key = await kbVersionKey(env);
  const now = Date.now();
  return corpus && corpus.key === key && now - corpus.at < CORPUS_MS && now >= corpus.at ? corpus : null;
}

/** Search results kept for a few minutes per version, for the same words (retries, the sweeper, a second look). */
export async function cachedSearch<T>(env: Env, words: string, load: () => Promise<T>): Promise<T> {
  const key = `${await kbVersionKey(env)}|${words}`;
  const now = Date.now();
  const hit = searches.get(key);
  if (hit && now - hit.at < SEARCH_MS && now >= hit.at) return hit.value as T;
  const value = await load();
  searches.set(key, { at: now, value });
  if (searches.size > MAX_SEARCHES) for (const k of searches.keys()) { if (searches.size <= MAX_SEARCHES) break; searches.delete(k); }
  return value;
}

/** Enabled documents and their tokens, for Live and the Knowledge screen. From memory when it can be. */
export async function kbTotals(env: Env): Promise<{ docs: number; tokens: number }> {
  const loaded = await corpusIfLoaded(env);
  if (loaded) {
    const on = loaded.docs.filter((d) => d.enabled === 1);
    return { docs: on.length, tokens: on.reduce((n, d) => n + d.token_estimate, 0) };
  }
  const key = await kbVersionKey(env);
  const now = Date.now();
  if (totals && totals.key === key && now - totals.at < CORPUS_MS && now >= totals.at) return { docs: totals.docs, tokens: totals.tokens };
  const rows = await all<{ docs: number; tokens: number }>(env.DB, 'SELECT COUNT(*) AS docs, COALESCE(SUM(token_estimate), 0) AS tokens FROM kb_docs WHERE enabled = 1');
  totals = { key, at: now, docs: rows[0]?.docs ?? 0, tokens: rows[0]?.tokens ?? 0 };
  return { docs: totals.docs, tokens: totals.tokens };
}
