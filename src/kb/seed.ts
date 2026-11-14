// The starter knowledge exported from the store (seed/knowledge) is bundled into the Worker and
// loaded into D1 the first time the knowledge base is used. After that the owner's copy in D1 is
// the truth: editing or deleting a seeded document is never undone by a deploy.
import type { Env } from '../types';
import { one, run } from '../lib/db';
import { getState, setState } from '../lib/settings';
import gapsJson from '../../seed/knowledge/gaps.json';
import indexJson from '../../seed/knowledge/index.json';
import pagesMd from '../../seed/knowledge/pages.md';
import policiesMd from '../../seed/knowledge/policies.md';
import productsMd from '../../seed/knowledge/products.md';
import storeFactsMd from '../../seed/knowledge/store-facts.md';
import { splitSections } from './chunk';
import { ingestDocument } from './docs';

export interface KbGap { question: string; why_it_matters: string; category: string }

interface SeedEntry { id: string; title: string; file: string; category: string; source_url: string; pinned: boolean }

const FILES: Record<string, string> = {
  'store-facts.md': storeFactsMd, 'products.md': productsMd, 'policies.md': policiesMd, 'pages.md': pagesMd,
};

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function getGaps(env: Env): Promise<KbGap[]> {
  return getState<KbGap[]>(env.DB, 'kb_gaps', []);
}

export async function setGaps(env: Env, gaps: KbGap[]): Promise<void> {
  await setState(env.DB, 'kb_gaps', gaps);
}

async function seed(env: Env): Promise<void> {
  for (const entry of indexJson as SeedEntry[]) {
    const text = FILES[entry.file];
    if (!text) continue;
    if (entry.pinned) {
      // Short, always needed facts stay one document so they can be given to the brain in full.
      await ingestDocument(env, { id: `seed_${entry.id}`, title: entry.title, content: text, category: entry.category, source: 'seed', source_ref: entry.source_url, pinned: true });
      continue;
    }
    // The big files hold one "## " section per product, policy or page. Each becomes its own
    // document so the owner can read, correct or switch off one product without touching the rest.
    const { intro, sections } = splitSections(text);
    if (intro) {
      await ingestDocument(env, { id: `seed_${entry.id}_notes`, title: `${entry.title}: notes`, content: intro, category: entry.category, source: 'seed', source_ref: entry.source_url });
    }
    const used = new Set<string>();
    for (const section of sections) {
      let id = `seed_${entry.id}_${slug(section.title)}`;
      while (used.has(id)) id += '_2';
      used.add(id);
      const url = /^- URL: (https?:\/\/\S+)/m.exec(section.content)?.[1] ?? `${entry.source_url}#${slug(section.title)}`;
      await ingestDocument(env, { id, title: section.title, content: section.content, category: entry.category, source: 'seed', source_ref: url });
    }
  }
  await setGaps(env, gapsJson as KbGap[]);
}

let seeded: Promise<void> | null = null;

async function seedOnce(env: Env): Promise<void> {
  const db = env.DB;
  // Claim the flag first: two requests arriving together must not both load the files.
  const claimed = await run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('state:kb_seeded', ?, ?) ON CONFLICT(key) DO NOTHING`, JSON.stringify({ at: Date.now() }), Date.now());
  if (!claimed) return;
  const has = await one<{ id: string }>(db, 'SELECT id FROM kb_docs LIMIT 1');
  if (has) return; // the owner already added knowledge by hand: leave it alone
  try {
    await seed(env);
  } catch (err) {
    await run(db, `DELETE FROM settings WHERE key = 'state:kb_seeded'`);
    throw err;
  }
}

/** Load the bundled starter knowledge if this database has never had any. Cheap to call on every request. */
export function ensureSeeded(env: Env): Promise<void> {
  if (!seeded) seeded = seedOnce(env).catch((err) => { seeded = null; throw err; });
  return seeded;
}
