// Thin helpers over D1 so call sites stay short and typed.

export type Param = string | number | null;

/**
 * First row or null. Uses all() rather than first() because first() hides meta.rows_read, and the
 * usage meter (src/lib/usage.ts) can only count what it sees. Add LIMIT 1 when a query may match many.
 */
export async function one<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results?.[0] ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

/** Returns the number of rows changed. */
export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return res.meta?.changes ?? 0;
}

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** Short random id with a readable prefix, for example cv_k3f9a2x7m1qz. */
export function uid(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return `${prefix}_${s}`;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/** Rough token estimate that is good enough for budgeting prompts (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}
