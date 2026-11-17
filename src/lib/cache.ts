// Small caches kept in memory by one Worker isolate. They save D1 reads (the free plan allows 5 million
// rows a day) for things that are read again and again and change rarely: the dashboard screens that
// poll, the settings, the knowledge base. Each isolate has its own copy, so every entry also has a short
// life: a change made through another isolate shows up within that time.

/** Dashboard answers. Any D1 write in this isolate (src/lib/usage.ts sees them all) starts a new generation. */
let generation = 0;
const answers = new Map<string, { at: number; gen: number; value: Promise<unknown> }>();
const MAX_ANSWERS = 120;

/** Something was written: the dashboard answers cached so far may be out of date. */
export function bumpDashboard(): void {
  generation++;
}

/**
 * The answer for `key`, from memory while it is younger than `ttlMs` and nothing was written since, else
 * loaded (once, even when two requests ask at the same moment). A failed load is not kept.
 */
export function cachedAnswer<T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> {
  const hit = answers.get(key);
  if (hit && hit.gen === generation && now - hit.at < ttlMs && now >= hit.at) return hit.value as Promise<T>;
  const gen = generation;
  const value = load();
  answers.set(key, { at: now, gen, value });
  value.catch(() => { if (answers.get(key)?.value === value) answers.delete(key); });
  if (answers.size > MAX_ANSWERS) {
    // Oldest first: a Map keeps insertion order.
    for (const k of answers.keys()) { if (answers.size <= MAX_ANSWERS) break; answers.delete(k); }
  }
  return value;
}

/** What a reset empties: the settings, the knowledge base, the counts and answers made from the data, or the usage meter. */
export type CacheScope = 'settings' | 'kb' | 'data' | 'usage';
const resetters: { fn: () => void; scope: CacheScope }[] = [];

/** Register a cache that resetCaches() empties (tests change the database behind the Worker's back). */
export function onReset(fn: () => void, scope: CacheScope = 'data'): void {
  resetters.push({ fn, scope });
}

/** Forget what this isolate holds in memory: everything, or only the given scopes. */
export function resetCaches(...scopes: CacheScope[]): void {
  const all = !scopes.length;
  if (all || scopes.includes('data')) { answers.clear(); generation++; }
  for (const r of resetters) if (all || scopes.includes(r.scope)) r.fn();
}
