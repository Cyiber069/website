// Owner facing API for the Recovery screen: who would be messaged tonight, the message itself, runs.
import type { CheckoutRow } from '../types';
import { all, one, parseJson } from '../lib/db';
import { logEvent } from '../lib/events';
import { bad, bool, json, notFound, oneOf, str, type Router } from '../lib/http';
import { getSettings, patchSettings, secretHints } from '../lib/settings';
import { DAY, HOUR, nextLondonHour } from '../lib/time';
import {
  SKIP_REASONS, TEMPLATE_VARIABLES, VARIABLE_NOTES, basicTemplateCleanup, evaluateCheckouts, liveBlocker, parseRun,
  refreshCheckouts, renderMessage, runRecovery, skipCheckout, unknownVariables, type SkipCode,
} from '../recovery';
import { maskPhone } from '../shopify/phone';

const MAX_TEMPLATE_CHARS = 900;

const count = async (db: D1Database, sql: string, ...p: (string | number)[]) => (await one<{ n: number }>(db, sql, ...p))?.n ?? 0;

const itemsOf = (row: CheckoutRow) => parseJson<{ title: string; quantity: number }[]>(row.items, []);

export function register(r: Router): void {
  r.get('/api/recovery', 'owner', async (c) => {
    const db = c.db;
    const now = c.now;
    const settings = await getSettings(db, true);
    const rs = settings.recovery;
    const [hints, evaluation, runs] = await Promise.all([
      secretHints(db),
      evaluateCheckouts(db, settings, now),
      all<Parameters<typeof parseRun>[0]>(db, 'SELECT * FROM recovery_runs ORDER BY started_at DESC LIMIT 15'),
    ]);
    const api = Boolean(hints.shopify_admin_token || (hints.shopify_client_id && hints.shopify_client_secret));
    const hook = Boolean(hints.shopify_webhook_secret);
    const renderOpts = { include_link: rs.include_link, opt_out_line: rs.opt_out_line };

    const eligible = evaluation.eligible.map((row) => ({
      id: row.id,
      first_name: row.first_name,
      phone_masked: maskPhone(row.phone_e164),
      country: row.country,
      total: row.total,
      currency: row.currency,
      items: itemsOf(row),
      age_hours: Math.round(((now - (row.created_at_shop ?? row.first_seen_at)) / HOUR) * 10) / 10,
      preview_text: rs.template.text.trim() ? renderMessage(rs.template.text, row, settings, renderOpts).parts.join('\n') : '',
    }));

    // Checkouts the rules hold back, then the ones the owner skipped by hand.
    const skipped: { id: string; first_name: string | null; reason: string; code: string }[] = evaluation.skipped.map((s) => ({
      id: s.row.id, first_name: s.row.first_name, reason: SKIP_REASONS[s.code], code: s.code,
    }));
    const byHand = await all<CheckoutRow>(db, `SELECT * FROM checkouts WHERE status = 'skipped' AND updated_at > ? ORDER BY updated_at DESC LIMIT 30`, now - 7 * DAY);
    for (const row of byHand) {
      const code = (row.skip_reason ?? 'owner') as SkipCode;
      skipped.push({ id: row.id, first_name: row.first_name, reason: SKIP_REASONS[code] ?? SKIP_REASONS.owner, code });
    }

    const since = now - 30 * DAY;
    const [messaged, replied, recovered] = await Promise.all([
      count(db, 'SELECT COUNT(*) AS n FROM checkouts WHERE messaged_at > ?', since),
      // A reply is any customer message in the thread after our reminder went out.
      count(
        db,
        `SELECT COUNT(*) AS n FROM checkouts c JOIN outbox o ON o.id = c.outbox_id JOIN conversations v ON v.id = o.conversation_id
         WHERE c.messaged_at > ? AND v.last_inbound_at > c.messaged_at`,
        since,
      ),
      count(db, `SELECT COUNT(*) AS n FROM checkouts WHERE messaged_at > ? AND completed_at IS NOT NULL AND completed_at >= messaged_at`, since),
    ]);

    return json({
      settings: rs,
      shopify: { connected: api || hook, mode: api ? 'api' : hook ? 'webhook' : 'none' },
      next_run_at: nextLondonHour(now, Math.min(23, Math.max(0, Math.round(rs.send_hour_london)))),
      // null when tonight's run will send for real, otherwise the plain reason it will only be a dry run.
      blocked_by: liveBlocker(settings),
      template: rs.template,
      variables: [...TEMPLATE_VARIABLES],
      variable_notes: VARIABLE_NOTES,
      eligible,
      skipped,
      runs: runs.map(parseRun),
      stats: { messaged_30d: messaged, replied_30d: replied, recovered_30d: recovered },
    });
  });

  // Turn the owner's rough wording into a tidy message with the right variables. Nothing is saved.
  r.post('/api/recovery/teach', 'owner', async (c) => {
    const body = await c.body<{ rough?: unknown }>();
    const rough = str(body.rough, 'rough', { max: 2000 });
    let suggestion = '';
    let source: 'brain' | 'basic' = 'basic';
    try {
      const brain = (await import('../brain/index')) as Record<string, unknown>;
      if (typeof brain.draftRecoveryTemplate === 'function') {
        const result: unknown = await (brain.draftRecoveryTemplate as (env: typeof c.env, input: { rough: string }) => Promise<unknown>)(c.env, { rough });
        const text = typeof result === 'string' ? result : result && typeof result === 'object'
          ? String((result as Record<string, unknown>).suggestion ?? (result as Record<string, unknown>).text ?? '') : '';
        if (text.trim()) { suggestion = text.trim(); source = 'brain'; }
      }
    } catch (err) {
      console.error('draftRecoveryTemplate failed, using the basic cleanup', err);
    }
    if (!suggestion) suggestion = basicTemplateCleanup(rough);
    // Whoever wrote it, the suggestion may only use variables that exist.
    for (const v of unknownVariables(suggestion)) suggestion = suggestion.split(v).join('').replace(/[ \t]{2,}/g, ' ');
    return json({ suggestion: suggestion.trim().slice(0, MAX_TEMPLATE_CHARS), source });
  });

  // Save the message. Approval is always an explicit choice made here, never a side effect.
  r.put('/api/recovery/template', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown; approved?: unknown; consent_mode?: unknown }>();
    const text = str(body.text, 'text', { max: MAX_TEMPLATE_CHARS, optional: true });
    const approved = bool(body.approved, false);
    if (approved && !text) throw bad('empty_template', 'Write the message before approving it');
    const unknown = unknownVariables(text);
    if (unknown.length) {
      throw bad('unknown_variable', `${unknown.join(', ')} is not something we can fill in. Use ${TEMPLATE_VARIABLES.join(' ')}`, { variables: unknown });
    }
    const patch: Parameters<typeof patchSettings<'recovery'>>[2] = { template: { text, approved, updated_at: c.now } };
    if (body.consent_mode !== undefined && body.consent_mode !== null) {
      patch.consent_mode = oneOf(body.consent_mode, 'consent_mode', ['all', 'opted_in'] as const);
      // Approving together with a choice of who to message is the owner's confirmation.
      if (approved) patch.consent_confirmed = true;
    }
    const next = await patchSettings(c.db, 'recovery', patch);
    await logEvent(c.db, {
      level: approved ? 'good' : 'info', type: 'recovery_template',
      message: approved ? 'Checkout reminder message approved.' : 'Checkout reminder message saved as a draft. Nothing is sent until you approve it.',
    });
    return json({ ok: true, template: next.template, settings: next, blocked_by: liveBlocker(await getSettings(c.db, true)) });
  });

  r.post('/api/recovery/run', 'owner', async (c) => {
    // A bare POST with no body means the safe choice: a dry run.
    const body = await c.body<{ dry_run?: unknown }>().catch(() => ({ dry_run: true }));
    const run = await runRecovery(c.env, { trigger: bool(body.dry_run, true) ? 'dry_run' : 'manual' });
    return json({ run });
  });

  r.post('/api/recovery/refresh', 'owner', async (c) => {
    const settings = await getSettings(c.db, true);
    const pull = await refreshCheckouts(c.env, settings, c.now);
    return json({ ok: !pull.error, ...pull });
  });

  r.post('/api/recovery/checkouts/:id/skip', 'owner', async (c) => {
    if (!(await skipCheckout(c.db, c.params.id!))) throw notFound('checkout_not_found');
    return json({ ok: true });
  });
}
