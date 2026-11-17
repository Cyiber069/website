// Finding the right knowledge for a conversation, and laying it out for the brain.
import type { Env } from '../types';
import { all, estimateTokens } from '../lib/db';
import { getSettings } from '../lib/settings';
import { type KbDocRow } from './docs';
import { buildFtsQuery, searchTerms } from './query';
import { ensureSeeded } from './seed';
import { cachedSearch, getCorpus, type Corpus } from './cache';

export interface KbHit {
  chunk_id: number; doc_id: string; ord: number; title: string; heading: string; content: string; category: string;
  source: string; token_estimate: number; updated_at: number;
  /** Higher is better. */
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** At most this many chunks from one document, so one long page cannot crowd out everything else. */
  perDoc?: number;
  includePinned?: boolean;
}

type Ranked = Omit<KbHit, 'score'> & { rank: number };

/**
 * The best `want` chunks of enabled documents (and not pinned ones when asked), best first. The full
 * text index only ranks (it reads about one row per result); titles, sources and text come from the
 * knowledge base in memory (src/kb/cache.ts). It fetches as many more results as there are chunks it
 * would skip, so the result is the same as filtering inside the query.
 */
async function rankChunks(env: Env, match: string, want: number, includePinned: boolean): Promise<Ranked[]> {
  let c: Corpus = await getCorpus(env);
  const skipped = (k: Corpus) => {
    let n = 0;
    for (const d of k.docs) if (d.enabled !== 1 || (!includePinned && d.pinned === 1)) n += k.chunksPerDoc.get(d.id) ?? 0;
    return n;
  };
  const ranked = await all<{ rowid: number; rank: number }>(
    env.DB,
    // rank MATCH gives the same order and values as bm25(kb_fts, 6.0, 3.0, 1.0) in ORDER BY, but lets the
    // index sort by itself: about one row read per result instead of every matching chunk three times.
    `SELECT rowid, rank FROM kb_fts WHERE kb_fts MATCH ? AND rank MATCH 'bm25(6.0, 3.0, 1.0)' ORDER BY rank LIMIT ?`,
    match, want + skipped(c) + 5,
  );
  // A chunk the memory copy does not have: the knowledge changed through another isolate. Load it again once.
  if (ranked.some((r) => !c.chunks.has(r.rowid))) c = await getCorpus(env, true);
  const out: Ranked[] = [];
  for (const r of ranked) {
    const ch = c.chunks.get(r.rowid);
    const d = ch ? c.byId.get(ch.doc_id) : undefined;
    if (!ch || !d || d.enabled !== 1 || (!includePinned && d.pinned === 1)) continue;
    out.push({
      chunk_id: ch.id, doc_id: ch.doc_id, ord: ch.ord, title: d.title, heading: ch.heading, content: ch.content, category: d.category,
      source: d.source, token_estimate: ch.token_estimate, updated_at: d.updated_at, rank: r.rank,
    });
    if (out.length >= want) break;
  }
  return out;
}

/** Best matching chunks of enabled documents for free text (bm25, title and headings weigh more than body text). */
export async function searchKb(env: Env, queryText: string, opts: SearchOptions = {}): Promise<KbHit[]> {
  await ensureSeeded(env);
  const match = buildFtsQuery(queryText);
  if (!match) return [];
  const limit = Math.max(1, Math.min(60, opts.limit ?? 10));
  const perDoc = opts.perDoc ?? 4;
  const includePinned = opts.includePinned !== false;
  // A document whose title names what the customer named ("2000w bundle") is very likely the one they mean.
  const own = searchTerms(queryText, 12).slice(0, 12);
  // The same words a few minutes later (a retry, the sweeper, a second call in one decision) are not searched again.
  const hits = await cachedSearch(env, `${limit}|${perDoc}|${includePinned ? 1 : 0}|${own.join(',')}|${match}`, async () => {
    const rows = await rankChunks(env, match, limit * 6, includePinned);
    // bm25 is negative, more negative is better. What the owner wrote or taught beats text copied
    // from the store, which contradicts itself in places.
    const titleBoost = (title: string): number => {
      const words = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      return 1 + 0.35 * own.filter((t) => words.has(t)).length;
    };
    const scored = rows.map(({ rank, ...r }) => ({ ...r, score: -rank * titleBoost(r.title) * (r.source === 'learned' || r.source === 'note' ? 1.6 : 1) }));
    scored.sort((a, b) => b.score - a.score || a.chunk_id - b.chunk_id);
    const perDocCount = new Map<string, number>();
    const out: KbHit[] = [];
    for (const hit of scored) {
      const n = perDocCount.get(hit.doc_id) ?? 0;
      if (n >= perDoc) continue;
      perDocCount.set(hit.doc_id, n + 1);
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  });
  // Callers may change what they get: hand out copies.
  return hits.map((h) => ({ ...h }));
}

export interface KnowledgeContext {
  /** full: the whole enabled knowledge base is in `stable`. top: pinned documents in `stable`, best matches in `retrieved`. */
  mode: 'full' | 'top' | 'empty';
  /** Text that stays byte for byte the same between calls until a document changes. Goes before the prompt cache breakpoint. */
  stable: string;
  /** Excerpts picked for this conversation. Different every call, so it goes after the breakpoint. */
  retrieved: string;
  /** Every document the brain was shown. Only these ids are valid in Decision.kb_refs. */
  docs: { id: string; title: string }[];
  tokens: number;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const attr = (text: string): string => text.replace(/ > /g, ' / ').replace(/["<>\n]/g, ' ').trim();

// Entries are laid out the way the prompt describes them (research/voice.md, P2.2). The source tells
// the model whose words these are: what the owner wrote or taught outranks text copied from the store.
function renderDoc(d: KbDocRow): string {
  return `<entry id="${d.id}" title="${attr(d.title)}" source="${d.source}" updated="${day(d.updated_at)}">\n${d.content}\n</entry>`;
}

function renderExcerpt(h: KbHit): string {
  return `<entry id="${h.doc_id}" title="${attr(h.title)}" section="${attr(h.heading)}" source="${h.source}" updated="${day(h.updated_at)}">\n${h.content}\n</entry>`;
}

/**
 * Knowledge for one model call: pinned documents in full, plus either the whole knowledge base (when it
 * fits brain.kb_full_tokens) or the best brain.kb_top_chunks excerpts for `queryText`.
 * `budgetTokens` caps the total for models with a small context window.
 */
export async function buildKnowledgeContext(env: Env, queryText: string, opts: { budgetTokens?: number; include?: string[] } = {}): Promise<KnowledgeContext> {
  await ensureSeeded(env);
  const settings = await getSettings(env.DB);
  const budget = opts.budgetTokens ?? Number.MAX_SAFE_INTEGER;
  // The knowledge base in memory (src/kb/cache.ts): read from D1 once per change, not once per decision.
  const corpus = await getCorpus(env);
  const enabled = corpus.docs.filter((d) => d.enabled === 1);
  if (!enabled.length) return { mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 };

  const total = enabled.reduce((n, d) => n + d.token_estimate, 0);
  if (total <= Math.min(settings.brain.kb_full_tokens, budget)) {
    return { mode: 'full', stable: enabled.map(renderDoc).join('\n\n'), retrieved: '', docs: enabled.map((d) => ({ id: d.id, title: d.title })), tokens: total };
  }
  const docs = enabled.filter((d) => d.pinned === 1);

  // Too big to send whole: pinned documents first (they are listed first), then the best matches.
  const used: { id: string; title: string }[] = [];
  const stable: string[] = [];
  let tokens = 0;
  for (const d of docs) {
    if (tokens + d.token_estimate > budget) continue;
    stable.push(renderDoc(d));
    used.push({ id: d.id, title: d.title });
    tokens += d.token_estimate;
  }
  // Documents asked for by id (the product picker for a shopper) go in full, ahead of the search matches.
  const extra: string[] = [];
  const wanted = (opts.include ?? []).filter((id) => !used.some((u) => u.id === id)).slice(0, 5);
  if (wanted.length) {
    const rows = wanted.map((id) => corpus.byId.get(id)).filter((d): d is KbDocRow => Boolean(d && d.enabled === 1));
    for (const d of rows) {
      if (tokens + d.token_estimate > budget) continue;
      extra.push(renderDoc(d));
      used.push({ id: d.id, title: d.title });
      tokens += d.token_estimate;
    }
  }
  const included = new Set(used.map((u) => u.id));
  const hits = (await searchKb(env, queryText, { limit: settings.brain.kb_top_chunks + included.size, includePinned: false })).filter((h) => !included.has(h.doc_id)).slice(0, settings.brain.kb_top_chunks);
  // Keep excerpts of one document together and in reading order, best document first.
  const order = [...new Set(hits.map((h) => h.doc_id))];
  const picked: KbHit[] = [];
  for (const h of hits) {
    const cost = estimateTokens(renderExcerpt(h));
    if (tokens + cost > budget) break;
    picked.push(h);
    tokens += cost;
  }
  picked.sort((a, b) => order.indexOf(a.doc_id) - order.indexOf(b.doc_id) || a.ord - b.ord);
  for (const h of picked) if (!used.some((u) => u.id === h.doc_id)) used.push({ id: h.doc_id, title: h.title });
  return { mode: 'top', stable: stable.join('\n\n'), retrieved: [...extra, ...picked.map(renderExcerpt)].join('\n\n'), docs: used, tokens };
}
