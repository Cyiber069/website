// Abandoned checkout recovery: once a day, at the owner's chosen London hour, message the people
// who left a phone number at checkout and did not finish. Everything goes through the outbox, so
// the laptop sends it from the owner's own WhatsApp like any other message.
import type { CheckoutRow, Env, Settings } from '../types';
import { all, clip, one, parseJson, run, stmt, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { getSettings } from '../lib/settings';
import { DAY, HOUR, MIN, londonDateTimeToTs, londonTime } from '../lib/time';
import { alertOwner } from '../pipeline/alerts';
import { emptyTarget, enqueueStatements } from '../pipeline/outbox';
import { fromApiNode, upsertCheckouts } from '../shopify/checkouts';
import { ShopifyError, fetchAbandonedCheckouts, hasApiCredentials } from '../shopify/client';
import { maskPhone } from '../shopify/phone';
import { LINK_PLACEHOLDER, fillTemplate, renderMessage, styleMessage, type Rendered } from './template';

export { TEMPLATE_VARIABLES, VARIABLE_NOTES, basicTemplateCleanup, renderMessage, unknownVariables } from './template';

export type RunTrigger = 'schedule' | 'manual' | 'dry_run';

/** Why a checkout is not being messaged. The text is shown to the owner as is. */
export const SKIP_REASONS = {
  completed: 'They finished the order',
  no_phone: 'No phone number was left',
  invalid_phone: 'The phone number is not valid',
  too_recent: 'Too recent, they may still be shopping',
  too_old: 'Too old to follow up',
  country: 'Outside the countries you message',
  no_consent: 'Did not accept marketing at checkout',
  opted_out: 'They asked not to be messaged',
  cooldown: 'This number was messaged recently',
  duplicate_number: 'Another checkout from the same number is ahead of it',
  daily_cap: 'Over the daily limit, waits for the next run',
  window_full: 'No time left in the sending window, waits for the next run',
  already_queued: 'A message for this checkout already exists',
  no_message: 'The message came out empty',
  owner: 'You skipped it',
} as const;
export type SkipCode = keyof typeof SKIP_REASONS;

export interface Skipped { row: CheckoutRow; code: SkipCode }
export interface Evaluation { eligible: CheckoutRow[]; skipped: Skipped[] }

const clampHour = (h: number) => Math.min(23, Math.max(0, Math.round(h)));
const startedAt = (row: CheckoutRow) => row.created_at_shop ?? row.first_seen_at;

/** Unix ms of the most recent London midnight. */
function londonDayStart(now: number): number {
  return londonDateTimeToTs(londonTime(now).date, 0);
}

/** Reminders already queued or sent today, whatever started them. Counts against the daily cap. */
async function usedToday(db: D1Database, now: number): Promise<number> {
  const row = await one<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM outbox WHERE source = 'recovery' AND created_at >= ? AND status IN ('pending', 'leased', 'sent', 'review')`, londonDayStart(now),
  );
  return row?.n ?? 0;
}

/**
 * Decide, for every checkout still marked new, whether it may be messaged now. Pure reading:
 * nothing is changed, so the Recovery screen and the run share one set of rules.
 */
export async function evaluateCheckouts(db: D1Database, settings: Settings, now: number): Promise<Evaluation> {
  const rs = settings.recovery;
  const maxAge = rs.max_age_hours * HOUR;
  const rows = await all<CheckoutRow>(
    db,
    // Newest first: the warmest leads get the limited daily slots. Long dead rows are not worth listing.
    `SELECT * FROM checkouts WHERE status = 'new' AND COALESCE(created_at_shop, first_seen_at) > ?
     ORDER BY COALESCE(created_at_shop, first_seen_at) DESC LIMIT 300`,
    now - maxAge - 3 * DAY,
  );
  const countries = rs.countries.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const cooldownStart = now - rs.cooldown_days * DAY;
  let slots = Math.max(0, rs.daily_cap - (await usedToday(db, now)));
  const seenPhones = new Set<string>();
  const out: Evaluation = { eligible: [], skipped: [] };

  // Read once for every row, not two queries per checkout: the free plan allows 50 per request.
  const [optedRows, recentRows] = await Promise.all([
    all<{ phone: string | null; external_id: string }>(db, 'SELECT phone, external_id FROM contacts WHERE opted_out = 1'),
    // One reminder per number per cooldown, across all their checkouts. A number WhatsApp
    // rejected counts too: trying it again on the next checkout would only fail again.
    all<{ id: string; phone_e164: string }>(
      db,
      `SELECT id, phone_e164 FROM checkouts WHERE phone_e164 IS NOT NULL AND (
         status = 'queued' OR (messaged_at IS NOT NULL AND messaged_at > ?)
         OR (status = 'failed' AND skip_reason IN ('not_on_whatsapp', 'invalid_number') AND updated_at > ?))`,
      cooldownStart, cooldownStart,
    ),
  ]);
  const optedOut = new Set<string>();
  for (const c of optedRows) { if (c.phone) optedOut.add(c.phone); optedOut.add(c.external_id); }
  const recentBy = new Map<string, string[]>();
  for (const r of recentRows) recentBy.set(r.phone_e164, [...(recentBy.get(r.phone_e164) ?? []), r.id]);

  for (const row of rows) {
    const skip = (code: SkipCode) => { out.skipped.push({ row, code }); };
    if (row.completed_at) { skip('completed'); continue; }
    if (!row.phone_e164) { skip(row.phone_raw ? 'invalid_phone' : 'no_phone'); continue; }
    // "Still shopping" is judged from their last activity, "too old" from when they started.
    const lastActivity = Math.max(startedAt(row), row.updated_at_shop ?? 0);
    if (now - lastActivity < rs.min_age_minutes * MIN) { skip('too_recent'); continue; }
    if (now - startedAt(row) > maxAge) { skip('too_old'); continue; }
    if (countries.length && !countries.includes((row.country ?? '').toUpperCase())) { skip('country'); continue; }
    if (rs.consent_mode === 'opted_in' && !row.consent_sms) { skip('no_consent'); continue; }

    const digits = row.phone_e164.replace(/\D/g, '');
    if (optedOut.has(row.phone_e164) || optedOut.has(digits) || optedOut.has(`${digits}@c.us`)) { skip('opted_out'); continue; }

    if ((recentBy.get(row.phone_e164) ?? []).some((id) => id !== row.id)) { skip('cooldown'); continue; }
    if (seenPhones.has(row.phone_e164)) { skip('duplicate_number'); continue; }
    seenPhones.add(row.phone_e164);

    if (slots <= 0) { skip('daily_cap'); continue; }
    slots--;
    out.eligible.push(row);
  }
  return out;
}

// ---- pulling checkouts from Shopify ------------------------------------------------------------------

export interface PullResult {
  source: 'api' | 'webhook';
  /** Checkouts Shopify returned (API mode only). */
  fetched: number;
  error: string | null;
}

/**
 * Bring the checkouts table up to date. With API credentials we ask Shopify for everything young
 * enough to matter (completed ones included, so buyers are marked and never chased). Without them
 * the table is whatever the webhooks have fed in, and there is nothing to do.
 */
export async function refreshCheckouts(env: Env, settings: Settings, now = Date.now()): Promise<PullResult> {
  const db = env.DB;
  if (!(await hasApiCredentials(db))) return { source: 'webhook', fetched: 0, error: null };
  try {
    const since = now - (settings.recovery.max_age_hours + 2) * HOUR;
    const nodes = await fetchAbandonedCheckouts(env, since);
    await upsertCheckouts(db, nodes.map((node) => fromApiNode(node, settings.store.default_country)), 'api', since);
    return { source: 'api', fetched: nodes.length, error: null };
  } catch (err) {
    const message = err instanceof ShopifyError ? err.message : 'Could not load checkouts from Shopify.';
    if (!(err instanceof ShopifyError)) console.error('refreshCheckouts failed', err);
    return { source: 'api', fetched: 0, error: message };
  }
}

// ---- the run -------------------------------------------------------------------------------------------

export interface RunMessage { checkout_id: string; first_name: string | null; phone_masked: string; text: string; not_before: number | null }
export interface RunSkip { checkout_id: string; first_name: string | null; reason: string; code: SkipCode }

export interface RunSummary {
  /** live: messages were queued. dry_run: this is only what would have been sent. */
  mode: 'live' | 'dry_run';
  /** Why a run that was meant to send did not (missing approval and so on). Null for live runs. */
  dry_reason: string | null;
  line: string;
  pull: PullResult;
  expires_at: number | null;
  messages: RunMessage[];
  skipped: RunSkip[];
  error?: string;
}

export interface RecoveryRun {
  id: string; run_date: string; trigger: RunTrigger; started_at: number; finished_at: number | null;
  status: string; found: number; queued: number; skipped: number; summary: RunSummary;
}

interface RunRow extends Omit<RecoveryRun, 'summary'> { summary: string }

const EMPTY_SUMMARY: RunSummary = { mode: 'dry_run', dry_reason: null, line: '', pull: { source: 'webhook', fetched: 0, error: null }, expires_at: null, messages: [], skipped: [] };

export function parseRun(row: RunRow): RecoveryRun {
  return { ...row, summary: { ...EMPTY_SUMMARY, ...parseJson<Partial<RunSummary>>(row.summary, {}) } };
}

/** What stands between the owner's settings and a real send, in the order they would fix it. */
export function liveBlocker(settings: Settings): string | null {
  const rs = settings.recovery;
  if (!rs.enabled) return 'checkout recovery is switched off';
  if (!rs.template.text.trim()) return 'there is no message yet';
  if (!rs.template.approved) return 'the message is not approved yet';
  if (!rs.consent_confirmed) return 'you have not confirmed who may be messaged';
  if (!settings.agent.enabled) return 'the agent is switched off';
  if (settings.channels.whatsapp.mode === 'off') return 'WhatsApp is switched off';
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const randomBetween = (a: number, b: number) => Math.min(a, b) + Math.random() * Math.abs(b - a);

/** Optional rewording by the brain so no two reminders are word for word identical. */
async function personalize(env: Env, text: string, row: CheckoutRow, link: string | null): Promise<string> {
  try {
    const brain = (await import('../brain/index')) as Record<string, unknown>;
    const fn = brain.personalizeRecovery;
    if (typeof fn !== 'function') return text;
    const result: unknown = await (fn as (env: Env, input: Record<string, unknown>) => Promise<unknown>)(env, {
      text, first_name: row.first_name, link, checkout_id: row.id,
    });
    const reworded = typeof result === 'string' ? result : result && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string' ? (result as { text: string }).text : '';
    // Never trust a rewrite that lost the customer's link or came back empty or bloated.
    if (!reworded.trim() || reworded.length > text.length * 2 + 80) return text;
    if (link && !reworded.includes(link)) return text;
    return reworded;
  } catch (err) {
    console.error('personalizeRecovery failed, using the template as written', err);
    return text;
  }
}

async function buildMessage(env: Env, settings: Settings, row: CheckoutRow, reword: boolean): Promise<Rendered> {
  const rs = settings.recovery;
  const opts = { include_link: rs.include_link, opt_out_line: rs.opt_out_line };
  if (!reword) return renderMessage(rs.template.text, row, settings, opts);
  const filled = fillTemplate(rs.template.text, row, settings, opts);
  const link = filled.has_link ? row.recovery_url!.trim() : null;
  return styleMessage(await personalize(env, filled.text, row, link), link, settings, opts);
}

/** The text of a reminder as stored and shown: parts on separate lines. */
export const messageText = (r: Rendered) => r.parts.join('\n');

/**
 * Run recovery now. `schedule` and `manual` send for real when everything is approved and
 * otherwise fall back to a dry run that records what would have gone out. `dry_run` never sends.
 */
export async function runRecovery(env: Env, opts: { trigger: RunTrigger; now?: number }): Promise<RecoveryRun> {
  const db = env.DB;
  const now = opts.now ?? Date.now();
  const settings = await getSettings(db, true);
  const rs = settings.recovery;
  const lt = londonTime(now);
  const id = uid('rr');
  await run(db, `INSERT INTO recovery_runs (id, run_date, trigger, started_at, status) VALUES (?, ?, ?, ?, 'running')`, id, lt.date, opts.trigger, now);

  if (opts.trigger === 'schedule') {
    // Once per London date. If two cron ticks raced, the earlier row wins and this one steps aside.
    const first = await one<{ id: string }>(db, `SELECT id FROM recovery_runs WHERE run_date = ? AND trigger = 'schedule' ORDER BY started_at ASC, id ASC LIMIT 1`, lt.date);
    if (first && first.id !== id) {
      await run(db, 'DELETE FROM recovery_runs WHERE id = ?', id);
      const row = await one<RunRow>(db, 'SELECT * FROM recovery_runs WHERE id = ?', first.id);
      return parseRun(row!);
    }
  }

  const summary: RunSummary = { ...EMPTY_SUMMARY, messages: [], skipped: [] };
  let status = 'done';
  let found = 0;
  try {
    const blocker = opts.trigger === 'dry_run' ? 'this was a test run' : liveBlocker(settings);
    const live = blocker === null;
    summary.mode = live ? 'live' : 'dry_run';
    summary.dry_reason = blocker;

    summary.pull = await refreshCheckouts(env, settings, now);

    if (live) {
      // Housekeeping only a real run should do: retire checkouts that can never qualify again.
      await run(
        db, `UPDATE checkouts SET status = 'expired', skip_reason = 'too_old', updated_at = ? WHERE status = 'new' AND COALESCE(created_at_shop, first_seen_at) < ?`,
        now, now - rs.max_age_hours * HOUR,
      );
    }

    const evaluation = await evaluateCheckouts(db, settings, now);
    found = evaluation.eligible.length + evaluation.skipped.length;
    const addSkip = (row: CheckoutRow, code: SkipCode) => summary.skipped.push({ checkout_id: row.id, first_name: row.first_name, reason: SKIP_REASONS[code], code });
    for (const s of evaluation.skipped) addSkip(s.row, s.code);

    // Nothing goes out after the window closes. A scheduled run measures it from the hour on the clock.
    const windowStart = opts.trigger === 'schedule' ? londonDateTimeToTs(lt.date, clampHour(rs.send_hour_london)) : now;
    const expiresAt = windowStart + Math.max(5, rs.window_minutes) * MIN;
    summary.expires_at = expiresAt;
    const [gapMin, gapMax] = [Math.max(0, rs.spacing_seconds[0] ?? 180), Math.max(0, rs.spacing_seconds[1] ?? 480)];
    let notBefore = now;
    // Every reminder is queued in one batch at the end: one D1 round trip, not three per checkout.
    const queue: { row: CheckoutRow; entry: RunMessage; id: string; statements: D1PreparedStatement[] }[] = [];

    for (const row of evaluation.eligible) {
      const rendered = await buildMessage(env, settings, row, live && rs.personalize);
      if (!rendered.parts.length) { addSkip(row, 'no_message'); continue; }
      const text = messageText(rendered);
      // The personal link opens the customer's basket for anyone, so it stays out of run logs.
      const safeText = row.recovery_url ? text.split(row.recovery_url.trim()).join(LINK_PLACEHOLDER) : text;
      const entry: RunMessage = { checkout_id: row.id, first_name: row.first_name, phone_masked: maskPhone(row.phone_e164), text: safeText, not_before: null };

      if (!live) { summary.messages.push(entry); continue; }
      if (notBefore > expiresAt - MIN) { addSkip(row, 'window_full'); continue; }

      // An earlier attempt that expired or was cancelled does not block this one (enqueue frees its key).
      const q = enqueueStatements(db, {
        channel: 'whatsapp', kind: 'new_chat', source: 'recovery', ref_id: row.id, dedupe_key: `recovery:${row.id}`,
        target: emptyTarget({ phone: row.phone_e164, title: row.first_name || row.name || null }),
        parts: rendered.parts, not_before: notBefore, expires_at: expiresAt,
        pacing: { delay_ms: Math.round(randomBetween(2000, 7000)), typing_cps: settings.pacing.typing_cps },
      });
      // Marked queued only when the insert above went in.
      q.statements.push(stmt(
        db, `UPDATE checkouts SET status = 'queued', outbox_id = ?, run_id = ?, message_text = ?, skip_reason = NULL, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM outbox WHERE id = ?)`,
        q.id, id, text, now, row.id, q.id,
      ));
      entry.not_before = notBefore;
      queue.push({ row, entry, ...q });
      notBefore += Math.round(randomBetween(gapMin, gapMax) * 1000);
    }

    if (queue.length) {
      const results = await db.batch(queue.flatMap((q) => q.statements));
      let i = 0;
      for (const q of queue) {
        i += q.statements.length;
        const inserted = (results[i - 2]?.meta?.changes ?? 0) > 0;
        if (inserted) summary.messages.push(q.entry);
        else addSkip(q.row, 'already_queued');
      }
    }

    const n = summary.messages.length;
    const waiting = summary.skipped.filter((s) => s.code === 'daily_cap' || s.code === 'window_full').length;
    if (live) {
      summary.line = n
        ? `Queued ${plural(n, 'checkout reminder')}, going out over the next ${Math.max(1, Math.ceil((notBefore - now) / MIN))} minutes.${waiting ? ` ${waiting} more wait for the next run.` : ''}`
        : 'No checkouts to message today.';
    } else {
      summary.line = n
        ? `Dry run: ${plural(n, 'reminder')} would have gone out. Nothing was sent because ${blocker}.`
        : `Dry run: no checkouts to message. Nothing was sent because ${blocker}.`;
    }
    if (summary.pull.error) summary.line += ` Shopify could not be reached, so this used the checkouts already saved.`;
  } catch (err) {
    console.error('recovery run failed', err);
    status = 'error';
    summary.error = err instanceof Error ? clip(err.message, 300) : 'unknown error';
    summary.line = 'The checkout recovery run failed. Check the Health screen.';
  }

  const queued = summary.mode === 'live' ? summary.messages.length : 0;
  await run(
    db, `UPDATE recovery_runs SET finished_at = ?, status = ?, found = ?, queued = ?, skipped = ?, summary = ? WHERE id = ?`,
    Date.now(), status, found, queued, summary.skipped.length, JSON.stringify(summary), id,
  );

  // Tell the owner, except for test runs they are watching on screen and for a feature that is switched off.
  const quiet = opts.trigger === 'dry_run' || !rs.enabled;
  await logEvent(db, {
    level: status === 'error' ? 'error' : queued ? 'good' : 'info', type: 'recovery_run', channel: 'whatsapp', message: summary.line,
    data: { run_id: id, trigger: opts.trigger, mode: summary.mode, found, queued, skipped: summary.skipped.length },
  });
  if (!quiet) {
    await alertOwner(env, settings, { kind: status === 'error' ? 'error' : 'recovery', title: 'Checkout reminders', body: summary.line, path: '/#/recovery' });
  }

  const saved = await one<RunRow>(db, 'SELECT * FROM recovery_runs WHERE id = ?', id);
  return parseRun(saved!);
}

/** Called every minute by cron. Starts the daily run when the London clock reaches the configured hour. True when it ran. */
export async function recoveryTick(env: Env): Promise<boolean> {
  const db = env.DB;
  const settings = await getSettings(db);
  const rs = settings.recovery;
  const now = Date.now();
  const lt = londonTime(now);
  const start = londonDateTimeToTs(lt.date, clampHour(rs.send_hour_london));
  if (now < start) return false;
  // If cron was late we still start, but only while a useful part of the sending window is left.
  const latest = start + Math.min(60, Math.max(10, rs.window_minutes / 2)) * MIN;
  if (now >= latest) return false;
  const done = await one<{ id: string }>(db, `SELECT id FROM recovery_runs WHERE run_date = ? AND trigger = 'schedule' LIMIT 1`, lt.date);
  if (done) return false;
  await runRecovery(env, { trigger: 'schedule', now });
  return true;
}

/** The owner does not want this one messaged. Cancels a waiting message too. */
export async function skipCheckout(db: D1Database, id: string): Promise<boolean> {
  const row = await one<CheckoutRow>(db, 'SELECT * FROM checkouts WHERE id = ?', id);
  if (!row) return false;
  if (row.status !== 'new' && row.status !== 'queued') return true;
  if (row.outbox_id) await run(db, `UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review')`, row.outbox_id);
  await run(db, `UPDATE checkouts SET status = 'skipped', skip_reason = 'owner', outbox_id = NULL, updated_at = ? WHERE id = ?`, Date.now(), id);
  return true;
}
