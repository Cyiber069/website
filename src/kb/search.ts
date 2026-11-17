// Finding the right knowledge for a conversation, and laying it out for the brain.
import type { Env } from '../types';
import { all, estimateTokens } from '../lib/db';
import { getSettings } from '../lib/settings';
import { type KbDocRow, listDocuments } from './docs';
import { buildFtsQuery, searchTerms } from './query';
import { ensureSeeded } from './seed';

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

/** Best matching chunks of enabled documents for free text (bm25, title and headings weigh more than body text). */
export async function searchKb(env: Env, queryText: string, opts: SearchOptions = {}): Promise<KbHit[]> {
  await ensureSeeded(env);
  const match = buildFtsQuery(queryText);
  if (!match) return [];
  const limit = Math.max(1, Math.min(60, opts.limit ?? 10));
  const perDoc = opts.perDoc ?? 4;
  const rows = await all<Omit<KbHit, 'score'> & { rank: number }>(
    env.DB,
    `SELECT c.id AS chunk_id, c.doc_id, c.ord, d.title, c.heading, c.content, d.category, d.source, c.token_estimate, d.updated_at,
            bm25(kb_fts, 6.0, 3.0, 1.0) AS rank
     FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid JOIN kb_docs d ON d.id = c.doc_id
     WHERE kb_fts MATCH ? AND d.enabled = 1 ${opts.includePinned === false ? 'AND d.pinned = 0' : ''}
     ORDER BY rank LIMIT ?`,
    match, limit * 6,
  );
  // bm25 is negative, more negative is better. What the owner wrote or taught beats text copied
  // from the store, which contradicts itself in places.
  // A document whose title names what the customer named ("2000w bundle") is very likely the one they mean.
  const own = searchTerms(queryText, 12).slice(0, 12);
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
  // Sizes first, without the text: a large knowledge base is not read in full just to find that it is too large.
  const sizes = await listDocuments(env, { onlyEnabled: true, contentChars: 0 });
  if (!sizes.length) return { mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 };

  const total = sizes.reduce((n, d) => n + d.token_estimate, 0);
  if (total <= Math.min(settings.brain.kb_full_tokens, budget)) {
    const docs = await listDocuments(env, { onlyEnabled: true });
    return { mode: 'full', stable: docs.map(renderDoc).join('\n\n'), retrieved: '', docs: docs.map((d) => ({ id: d.id, title: d.title })), tokens: total };
  }
  const docs = sizes.some((d) => d.pinned === 1) ? await listDocuments(env, { onlyEnabled: true, onlyPinned: true }) : [];

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
    const rows = await all<KbDocRow>(env.DB, `SELECT * FROM kb_docs WHERE id IN (SELECT value FROM json_each(?)) AND enabled = 1`, JSON.stringify(wanted));
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
