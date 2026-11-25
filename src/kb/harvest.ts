// Once a day: the questions customers asked that the agent could not answer go on the Knowledge screen's
// "Teach me" list, so the owner answers each one once and it never reaches Urgent again.
// Only questions asked since the last run are read (one indexed query), so one the owner skipped is not
// put back unless a customer asks it again. Items the owner answered in Urgent are left out: those answers
// were learned already.
import type { Env } from '../types';
import { all, clip } from '../lib/db';
import { getState, setState } from '../lib/settings';
import { titleSimilarity } from './query';
import { getGaps, setGaps, type KbGap } from './seed';

const DAY = 86_400_000;
/** Urgent categories that mean "a fact is missing", not an order, a refund or a complaint the owner must handle. */
const GAP_CATEGORIES = ['unknown_fact', 'unknown', 'product_support', 'low_confidence', 'other'];
const MAX_NEW = 10;
const MAX_GAPS = 60;

export async function harvestGaps(env: Env, now: number): Promise<number> {
  const last = Number(await getState<number>(env.DB, 'kb_gaps_harvest_at', 0)) || 0;
  if (now - last < DAY) return 0;
  const since = Math.max(last, now - 7 * DAY);
  const rows = await all<{ question: string; n: number }>(
    env.DB,
    `SELECT MAX(question) AS question, COUNT(*) AS n FROM urgent
     WHERE created_at > ? AND status IN ('open', 'dismissed') AND category IN (${GAP_CATEGORIES.map(() => '?').join(', ')}) AND length(question) BETWEEN 8 AND 400
     GROUP BY lower(question) ORDER BY n DESC, MAX(created_at) DESC LIMIT 30`,
    since, ...GAP_CATEGORIES,
  );
  await setState(env.DB, 'kb_gaps_harvest_at', now);
  if (!rows.length) return 0;
  const gaps = await getGaps(env);
  const fresh: KbGap[] = [];
  for (const r of rows) {
    const q = clip(r.question.replace(/\s+/g, ' ').trim(), 300);
    const known = [...gaps, ...fresh].find((g) => titleSimilarity(g.question, q) >= 0.8);
    if (known) continue;
    fresh.push({ question: q, why_it_matters: `A customer asked this ${r.n > 1 ? `${r.n} times ` : ''}this week and the agent could not answer. Answer it once and it stops reaching Urgent.`, category: 'faq' });
    if (fresh.length >= MAX_NEW) break;
  }
  if (!fresh.length) return 0;
  // What customers really asked goes first.
  await setGaps(env, [...fresh, ...gaps].slice(0, MAX_GAPS));
  return fresh.length;
}
