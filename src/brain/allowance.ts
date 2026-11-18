// Today's free Cloudflare Workers AI allowance and whether Claude is working, kept in one state row
// (settings key state:ai_state, read with the settings at no extra query, src/lib/settings.ts).
//
//   { day: 'YYYY-MM-DD' (UTC), used: neurons today, out_at: when a daily limit error came back,
//     claude_down: { at, last_at, code, message } while Claude fails for credit, billing or key reasons,
//     workers_failing_until: Workers AI failed or was too slow in the free window, Claude answers until then,
//     test_now: test mode only, the clock the routing rules read }
//
// Neurons are counted by the Worker itself from token counts (src/brain/route.ts rates): Cloudflare does
// not say how many are left. Every Workers AI call adds its neurons in the same batch as its llm_usage
// row (one query). The settings read is up to 30 s old, so this isolate also keeps what it wrote last.
import type { Env, Settings } from '../types';
import { onReset } from '../lib/cache';
import { logEvent } from '../lib/events';
import { cachedState } from '../lib/settings';
import { alertOwner } from '../pipeline/alerts';
import { WORKERS_REST_MS, allowanceView, utcDay, type AllowanceView } from './route';

export interface ClaudeDown { at: number; last_at?: number; code: string; message: string }

export interface AiState {
  day?: string;
  used?: number;
  out_at?: number | null;
  claude_down?: ClaudeDown | null;
  /** Workers AI failed or was too slow in the free window: Claude answers until then (route clock). */
  workers_failing_until?: number | null;
  /** Test mode only: the time the routing rules use (the free window, the allowance day). */
  test_now?: number | null;
}

const KEY = 'state:ai_state';
/** What this isolate wrote last, and when: newer than the settings read for about 30 s. */
let mine: { state: AiState; at: number } | null = null;
const MINE_MS = 60_000;

/** Forget what this isolate wrote (tests change the row behind the Worker's back). */
export function resetAiStateMirror(): void { mine = null; }
onReset(resetAiStateMirror, 'settings');

function parse(raw: unknown): AiState {
  if (typeof raw === 'string') { try { return parse(JSON.parse(raw)); } catch { return {}; } }
  return raw && typeof raw === 'object' ? (raw as AiState) : {};
}

/** The state as best known here: the stored row (with the settings) merged with what this isolate wrote. */
export async function aiState(env: Env): Promise<AiState> {
  const stored = parse(await cachedState<unknown>(env.DB, 'ai_state', null));
  if (!mine || Date.now() - mine.at > MINE_MS) return stored;
  // What this isolate wrote is the newest whole row it knows (a cleared Claude outage included). Other
  // isolates add neurons meanwhile: the larger count of the same day wins.
  const a = mine.state;
  const sameDay = Boolean(a.day) && a.day === stored.day;
  return {
    ...a,
    day: a.day ?? stored.day,
    used: sameDay ? Math.max(Number(a.used) || 0, Number(stored.used) || 0) : a.day ? a.used : stored.used,
    out_at: sameDay ? (a.out_at ?? stored.out_at ?? null) : a.day ? a.out_at : stored.out_at,
    workers_failing_until: Math.max(Number(a.workers_failing_until) || 0, Number(stored.workers_failing_until) || 0) || null,
    test_now: stored.test_now ?? a.test_now ?? null,
  };
}

/** The clock the routing rules read: real time, or the test clock in test mode. */
export function routeClock(env: Env, s: AiState): number {
  return env.ACX_TEST_MODE === '1' && typeof s.test_now === 'number' ? s.test_now : Date.now();
}

/** Test mode without a test clock: the free window never applies (null), so tests never depend on the hour. */
export function windowClock(env: Env, s: AiState): number | null {
  if (env.ACX_TEST_MODE !== '1') return Date.now();
  return typeof s.test_now === 'number' ? s.test_now : null;
}

export function allowanceOf(s: AiState, now: number): AllowanceView {
  return allowanceView({ day: s.day ?? '', used: Number(s.used) || 0, out: Boolean(s.day && s.out_at) }, now);
}

const remember = (raw: unknown) => {
  const s = parse(raw);
  if (Object.keys(s).length) mine = { state: s, at: Date.now() };
};

/**
 * The statement that adds `neurons` to today's count (and marks the allowance used up when `out`).
 * A count from an earlier UTC day starts again. Goes in the same batch as the call's llm_usage row.
 */
export function neuronsStatement(db: D1Database, day: string, neurons: number, out: boolean, now = Date.now()): D1PreparedStatement {
  const add = Math.max(0, Math.round(neurons * 100) / 100);
  return db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('${KEY}', json_object('day', ?1, 'used', ?2, 'out_at', ?3), ?4)
     ON CONFLICT(key) DO UPDATE SET updated_at = ?4, value = CASE
       WHEN json_extract(settings.value, '$.day') = ?1
         THEN json_set(settings.value, '$.used', COALESCE(json_extract(settings.value, '$.used'), 0) + ?2, '$.out_at', COALESCE(?3, json_extract(settings.value, '$.out_at')))
       ELSE json_set(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END, '$.day', ?1, '$.used', ?2, '$.out_at', ?3) END
     RETURNING value`,
  ).bind(day, add, out ? now : null, now);
}

/** Read the row a neurons statement returned (in a batch result) into this isolate's copy. */
export function noteNeuronsResult(res: D1Result | undefined): void {
  const row = (res?.results?.[0] ?? null) as { value?: unknown } | null;
  if (row?.value) remember(row.value);
}

/** The day the count belongs to: the test clock's in test mode. */
export async function countDay(env: Env): Promise<string> {
  return utcDay(routeClock(env, await aiState(env)));
}

/** Add neurons outside a batch (a call that wrote no usage row). Never throws. */
export async function addNeurons(env: Env, neurons: number, out = false): Promise<void> {
  try {
    const res = await neuronsStatement(env.DB, await countDay(env), neurons, out).all();
    noteNeuronsResult(res);
  } catch (err) {
    console.error('neuron count not saved', err);
  }
}

/**
 * Workers AI failed or was too slow in the free window: Claude answers the next few minutes
 * (src/brain/route.ts WORKERS_REST_MS), so a retry does not wait on it again. One query. Never throws.
 */
export async function noteWorkersFailing(env: Env): Promise<void> {
  try {
    const until = routeClock(env, await aiState(env)) + WORKERS_REST_MS;
    const res = await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('${KEY}', json_object('workers_failing_until', ?1), ?2)
       ON CONFLICT(key) DO UPDATE SET updated_at = ?2, value = json_set(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END, '$.workers_failing_until', ?1)
       RETURNING value`,
    ).bind(until, Date.now()).all<{ value: string }>();
    remember(res.results?.[0]?.value);
  } catch (err) {
    console.error('could not note that Workers AI is failing', err);
  }
}

/** Until when Claude answers in the free window because Workers AI just failed there, or null. */
export const workersFailingUntil = (s: AiState): number | null => Number(s.workers_failing_until) || null;

// ---- Claude failing for account reasons ------------------------------------------------------------------

const WHY_DOWN: Record<string, string> = {
  billing: 'Claude stopped answering because the Anthropic account has no credit left.',
  auth: 'Claude stopped answering because the API key was refused.',
};
const FIX_DOWN: Record<string, string> = {
  billing: 'Add credit at console.anthropic.com.',
  auth: 'Check the key on Connections.',
};

/**
 * The owner's words for a Claude account failure. `covered`: the free Cloudflare AI can answer instead
 * (it is there and has neurons left today). Without it customers get no answers, and the text says so.
 */
export function claudeDownText(code: string, covered = true): string {
  const c = code === 'billing' ? 'billing' : 'auth';
  if (covered) return `${WHY_DOWN[c]} The free Cloudflare AI is answering for now. ${FIX_DOWN[c]}`;
  return `${WHY_DOWN[c]} Customers are not getting answers until you ${c === 'billing' ? 'add credit at console.anthropic.com' : 'fix the key on Connections'}.`;
}

/**
 * Claude failed for credit, billing or key reasons. Remembered so the next calls go to Workers AI for a
 * while (src/brain/route.ts CLAUDE_RETRY_MS). The owner is told once per outage in plain words: only the
 * call that marks the change sends the alert. `covered`: Workers AI has free neurons left to answer
 * instead (llm.ts workersFallback), so the alert can say customers still get answers. Never throws.
 */
export async function noteClaudeDown(env: Env, settings: Settings, code: 'billing' | 'auth', detail: string, covered: boolean): Promise<void> {
  const now = Date.now();
  const down: ClaudeDown = { at: now, last_at: now, code, message: detail.slice(0, 200) };
  try {
    // Claims the change only when Claude was not already marked down: one alert per outage.
    const res = await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('${KEY}', json_object('claude_down', json(?1)), ?2)
       ON CONFLICT(key) DO UPDATE SET updated_at = ?2, value = CASE
         WHEN json_extract(settings.value, '$.claude_down.at') IS NULL THEN json_set(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END, '$.claude_down', json(?1))
         ELSE json_set(settings.value, '$.claude_down.last_at', ?2) END
       RETURNING value, json_extract(value, '$.claude_down.at') = ?2 AS claimed`,
    ).bind(JSON.stringify(down), now).all<{ value: string; claimed: number }>();
    const row = res.results?.[0];
    if (row) remember(row.value);
    if (!row || Number(row.claimed) !== 1) return;
    const text = claudeDownText(code, covered);
    await logEvent(env.DB, { level: 'error', type: 'claude_down', message: text });
    await alertOwner(env, settings, { kind: 'claude', title: 'Claude stopped working', body: text, path: '/#/connections' });
  } catch (err) {
    console.error('could not note that Claude is down', err);
  }
}

/** Claude answered again (or a new key was saved): forget the outage. One query, only while it was marked. */
export async function clearClaudeDown(env: Env, opts: { why?: 'answered' | 'new_key' } = {}): Promise<void> {
  try {
    const s = await aiState(env);
    if (!s.claude_down) return;
    const res = await env.DB.prepare(
      `UPDATE settings SET value = json_remove(value, '$.claude_down'), updated_at = ? WHERE key = '${KEY}' AND json_extract(value, '$.claude_down.at') IS NOT NULL RETURNING value`,
    ).bind(Date.now()).all<{ value: string }>();
    const row = res.results?.[0];
    remember(row?.value ?? JSON.stringify({ ...s, claude_down: null }));
    if (row && opts.why !== 'new_key') await logEvent(env.DB, { level: 'info', type: 'claude_ok', message: 'Claude is answering again.' });
  } catch (err) {
    console.error('could not clear the Claude outage', err);
  }
}

/** When Claude last failed for an account reason, or null when it is not marked down. */
export const claudeDownAt = (s: AiState): number | null => (s.claude_down ? Number(s.claude_down.last_at ?? s.claude_down.at) || null : null);
