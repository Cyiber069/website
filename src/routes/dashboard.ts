// Owner facing API for the core screens: Live, Urgent, Inbox, Settings, Health.
import type { Channel, ContactRow, ConversationRow, JobTarget, MessageRow, OutboxRow, Settings, UrgentRow } from '../types';
import { CHANNELS } from '../types';
import { pairingCode, sha256Hex } from '../lib/crypto';
import { all, clip, one, parseJson, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError, bad, bool, int, json, str, type Router } from '../lib/http';
import { getSettings, getState, isSettingsGroup, patchSettings, secretHints, setState } from '../lib/settings';
import { DAY, HOUR, MIN, londonTime, nextLondonHour } from '../lib/time';
import { cancelJob, emptyTarget, enqueue } from '../pipeline/outbox';
import { processConversation } from '../pipeline/inbound';
import { answerUrgent, dismissUrgent, sendUrgentDraft } from '../pipeline/urgent';
import { currentDevice, pairingCodeRow, selectorPack } from './agent';

const count = async (db: D1Database, sql: string, ...p: (string | number)[]) => (await one<{ n: number }>(db, sql, ...p))?.n ?? 0;

function startOfLondonDay(now: number): number {
  const lt = londonTime(now);
  return now - (lt.hour * HOUR + lt.minute * MIN) - (now % MIN);
}

async function urgentView(db: D1Database, rows: UrgentRow[]) {
  const out = [];
  for (const u of rows) {
    const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', u.conversation_id);
    const contact = conv ? await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id) : null;
    const recent = await all<MessageRow>(
      db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 8) ORDER BY ts ASC, created_at ASC', u.conversation_id,
    );
    out.push({
      id: u.id, channel: u.channel, status: u.status, question: u.question, customer_message: u.customer_message,
      reason: u.reason, category: u.category, draft: u.status === 'open' ? u.polished_answer : null,
      owner_answer: u.owner_answer, sent_text: u.status !== 'open' ? u.polished_answer : null,
      created_at: u.created_at, answered_at: u.answered_at, sent_at: u.sent_at,
      conversation_id: u.conversation_id, customer: contact?.display_name || conv?.title || 'Customer',
      recent: recent.map((m) => ({ direction: m.direction, author: m.author, body: m.body, ts: m.ts })),
    });
  }
  return out;
}

function reviewView(row: OutboxRow, conv: ConversationRow | null, lastInbound: string) {
  const target = parseJson<JobTarget>(row.target, emptyTarget());
  return {
    id: row.id, channel: row.channel, parts: parseJson<string[]>(row.parts, []), created_at: row.created_at,
    conversation_id: row.conversation_id, customer: conv?.title || target.title || target.email || target.phone || 'Customer',
    subject: conv?.subject ?? target.subject, customer_message: lastInbound,
  };
}

export function register(r: Router): void {
  // ---- Live ------------------------------------------------------------------------------------
  r.get('/api/overview', 'owner', async (c) => {
    const db = c.db;
    const now = c.now;
    const settings = await getSettings(db);
    const day = startOfLondonDay(now);
    const [devices, hints] = await Promise.all([currentDevice(db, now), secretHints(db)]);
    const device = devices[0] ?? null;
    const [urgentOpen, reviewPending, inboundToday, sentToday, queued, convToday, kbDocs, kbTokens, autoToday, escalatedToday] = await Promise.all([
      count(db, `SELECT COUNT(*) AS n FROM urgent WHERE status = 'open'`),
      count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status = 'review'`),
      count(db, `SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND status = 'received' AND created_at >= ?`, day),
      count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND source != 'alert' AND sent_at >= ?`, day),
      count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'leased')`),
      count(db, `SELECT COUNT(*) AS n FROM conversations WHERE last_inbound_at >= ?`, day),
      count(db, `SELECT COUNT(*) AS n FROM kb_docs WHERE enabled = 1`),
      count(db, `SELECT COALESCE(SUM(token_estimate), 0) AS n FROM kb_docs WHERE enabled = 1`),
      count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND source = 'auto' AND sent_at >= ?`, day),
      count(db, `SELECT COUNT(*) AS n FROM urgent WHERE created_at >= ?`, day),
    ]);
    const lastRun = await one<Record<string, unknown>>(db, `SELECT * FROM recovery_runs WHERE trigger != 'dry_run' ORDER BY started_at DESC LIMIT 1`);
    const hasClaude = Boolean(hints.anthropic_api_key || c.env.ANTHROPIC_API_KEY);
    const shopifyApi = Boolean(hints.shopify_client_secret || hints.shopify_admin_token);
    const shopifyHook = Boolean(hints.shopify_webhook_secret);
    const brainProvider = settings.brain.provider === 'workers_ai' ? 'workers_ai' : hasClaude ? 'anthropic' : c.env.AI ? 'workers_ai' : 'none';
    const pushCount = await count(db, 'SELECT COUNT(*) AS n FROM push_subscriptions');
    return json({
      now,
      agent: { enabled: settings.agent.enabled },
      device,
      channels: settings.channels,
      counts: {
        urgent_open: urgentOpen, review_pending: reviewPending, inbound_today: inboundToday, sent_today: sentToday,
        queued, conversations_today: convToday, auto_today: autoToday, escalated_today: escalatedToday,
      },
      brain: { provider: brainProvider, model: brainProvider === 'anthropic' ? settings.brain.model : settings.brain.workers_ai_model, claude_key: hasClaude },
      shopify: { connected: shopifyApi || shopifyHook, mode: shopifyApi ? 'api' : shopifyHook ? 'webhook' : 'none' },
      kb: { docs: kbDocs, tokens: kbTokens },
      recovery: {
        enabled: settings.recovery.enabled,
        template_ready: settings.recovery.template.approved && settings.recovery.template.text.trim().length > 0 && settings.recovery.consent_confirmed,
        next_run_at: nextLondonHour(now, settings.recovery.send_hour_london),
        last_run: lastRun,
      },
      setup: {
        device_paired: devices.length > 0,
        brain_ready: brainProvider !== 'none',
        knowledge_added: kbDocs > 0,
        shopify_connected: shopifyApi || shopifyHook,
        recovery_taught: settings.recovery.template.approved,
        push_enabled: pushCount > 0,
      },
    });
  });

  r.get('/api/events', 'owner', async (c) => {
    const after = int(c.url.searchParams.get('after'), 'after', 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = int(c.url.searchParams.get('limit'), 'limit', 1, 200, 60);
    const rows = after
      ? await all(c.db, 'SELECT * FROM (SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?) ORDER BY id DESC', after, limit)
      : await all(c.db, 'SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
    return json({ events: rows });
  });

  r.post('/api/agent-toggle', 'owner', async (c) => {
    const body = await c.body<{ enabled?: unknown }>();
    const enabled = bool(body.enabled, true);
    await patchSettings(c.db, 'agent', { enabled });
    await logEvent(c.db, { level: enabled ? 'good' : 'warn', type: 'agent_toggle', message: enabled ? 'Agent switched on.' : 'Agent switched off. Nothing will be sent.' });
    return json({ enabled });
  });

  // Stop everything now: switch off and throw away whatever is still waiting to be sent.
  r.post('/api/panic', 'owner', async (c) => {
    await patchSettings(c.db, 'agent', { enabled: false });
    const cancelled = await run(c.db, `UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'review', 'leased')`);
    await run(c.db, `UPDATE checkouts SET status = 'new', outbox_id = NULL WHERE status = 'queued'`);
    await logEvent(c.db, { level: 'warn', type: 'panic', message: `Emergency stop. Agent is off and ${cancelled} waiting message${cancelled === 1 ? ' was' : 's were'} cancelled.` });
    return json({ ok: true, cancelled });
  });

  // ---- Urgent -------------------------------------------------------------------------------------
  r.get('/api/urgent', 'owner', async (c) => {
    const status = c.url.searchParams.get('status') === 'done' ? 'done' : 'open';
    const rows = status === 'open'
      ? await all<UrgentRow>(c.db, `SELECT * FROM urgent WHERE status = 'open' ORDER BY created_at ASC LIMIT 100`)
      : await all<UrgentRow>(c.db, `SELECT * FROM urgent WHERE status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC LIMIT 50`);
    const review = await all<OutboxRow>(c.db, `SELECT * FROM outbox WHERE status = 'review' ORDER BY created_at ASC LIMIT 100`);
    const reviewOut = [];
    for (const row of review) {
      const conv = row.conversation_id ? await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', row.conversation_id) : null;
      const lastIn = row.conversation_id
        ? await one<{ body: string }>(c.db, `SELECT body FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY ts DESC, created_at DESC LIMIT 1`, row.conversation_id)
        : null;
      reviewOut.push(reviewView(row, conv, lastIn?.body ?? ''));
    }
    return json({ urgent: await urgentView(c.db, rows), review: status === 'open' ? reviewOut : [] });
  });

  r.post('/api/urgent/:id/answer', 'owner', async (c) => {
    const body = await c.body<{ answer?: unknown; learn?: unknown }>();
    const answer = str(body.answer, 'answer', { max: 2000 });
    const res = await answerUrgent(c.env, c.params.id!, answer, bool(body.learn, true));
    return json({ ok: true, parts: res.parts, learned: res.learned, status: res.urgent.status });
  });

  r.post('/api/urgent/:id/send-draft', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const text = typeof body.text === 'string' ? str(body.text, 'text', { max: 2000 }) : undefined;
    const res = await sendUrgentDraft(c.env, c.params.id!, text);
    return json({ ok: true, parts: res.parts });
  });

  r.post('/api/urgent/:id/dismiss', 'owner', async (c) => {
    await dismissUrgent(c.env, c.params.id!);
    return json({ ok: true });
  });

  // ---- Review queue (channels set to "ask me first") -------------------------------------------------
  r.post('/api/review/:id/approve', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const row = await one<OutboxRow>(c.db, `SELECT * FROM outbox WHERE id = ? AND status = 'review'`, c.params.id!);
    if (!row) throw new HttpError(404, 'not_found', 'That draft is gone');
    let parts = parseJson<string[]>(row.parts, []);
    if (typeof body.text === 'string' && body.text.trim()) parts = body.text.split('\n').map((p) => p.trim()).filter(Boolean).slice(0, 3);
    if (!parts.length) throw bad('empty_message', 'Nothing to send');
    await run(c.db, `UPDATE outbox SET status = 'pending', source = 'review', parts = ?, not_before = ?, pacing = ? WHERE id = ?`,
      JSON.stringify(parts), c.now, JSON.stringify({ delay_ms: 1500 }), row.id);
    await logEvent(c.db, { level: 'good', type: 'approved', channel: row.channel, conversation_id: row.conversation_id, message: `You approved a reply: ${clip(parts.join(' '), 160)}` });
    return json({ ok: true });
  });

  r.post('/api/review/:id/reject', 'owner', async (c) => json({ ok: await cancelJob(c.db, c.params.id!) }));

  // ---- Inbox ---------------------------------------------------------------------------------------
  r.get('/api/conversations', 'owner', async (c) => {
    const channel = c.url.searchParams.get('channel');
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (channel && CHANNELS.includes(channel as Channel)) { where.push('cv.channel = ?'); params.push(channel); }
    if (q) { where.push('(cv.title LIKE ? OR cv.last_preview LIKE ? OR ct.display_name LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; params.push(like, like, like); }
    const rows = await all<ConversationRow & { display_name: string; opted_out: number }>(
      c.db,
      `SELECT cv.*, ct.display_name, ct.opted_out FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cv.updated_at DESC LIMIT 80`,
      ...params,
    );
    return json({
      conversations: rows.map((cv) => ({
        id: cv.id, channel: cv.channel, customer: cv.display_name || cv.title || 'Customer', subject: cv.subject, status: cv.status,
        preview: cv.last_preview, last_direction: cv.last_direction, updated_at: cv.updated_at,
        paused: Boolean(cv.paused_until && cv.paused_until > c.now), opted_out: Boolean(cv.opted_out),
      })),
    });
  });

  r.get('/api/conversations/:id', 'owner', async (c) => {
    const conv = await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', c.params.id!);
    if (!conv) throw new HttpError(404, 'not_found');
    const contact = (await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
    const messages = await all<MessageRow>(
      c.db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 120) ORDER BY ts ASC, created_at ASC', conv.id,
    );
    const pending = await all<OutboxRow>(c.db, `SELECT * FROM outbox WHERE conversation_id = ? AND status IN ('pending', 'leased', 'review') ORDER BY created_at ASC`, conv.id);
    return json({
      conversation: {
        id: conv.id, contact_id: contact.id, channel: conv.channel, customer: contact.display_name || conv.title || 'Customer', subject: conv.subject,
        status: conv.status, paused_until: conv.paused_until && conv.paused_until > c.now ? conv.paused_until : null, pause_reason: conv.pause_reason,
        phone: contact.phone, email: contact.email, handle: contact.handle, opted_out: Boolean(contact.opted_out),
        tone: parseJson(contact.tone_profile, {}),
      },
      messages: messages.map((m) => ({ id: m.id, direction: m.direction, author: m.author, body: m.body, kind: m.kind, status: m.status, ts: m.ts })),
      pending: pending.map((p) => ({ id: p.id, status: p.status, source: p.source, parts: parseJson<string[]>(p.parts, []) })),
    });
  });

  r.post('/api/conversations/:id/pause', 'owner', async (c) => {
    const body = await c.body<{ minutes?: unknown }>();
    const minutes = int(body.minutes, 'minutes', 0, 60 * 24 * 365, 60 * 24 * 365);
    const until = minutes ? c.now + minutes * MIN : null;
    const changed = await run(c.db, 'UPDATE conversations SET paused_until = ?, pause_reason = ?, needs_reply_since = NULL WHERE id = ?', until, until ? 'Paused by you' : null, c.params.id!);
    if (!changed) throw new HttpError(404, 'not_found');
    if (!until) {
      // Handed back: if the customer is still waiting, the agent answers now instead of at their next message.
      const last = await one<{ direction: string; status: string }>(c.db, 'SELECT direction, status FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 1', c.params.id!);
      if (last?.direction === 'in' && last.status !== 'history') {
        await run(c.db, 'UPDATE conversations SET needs_reply_since = ? WHERE id = ?', c.now, c.params.id!);
        c.exec.waitUntil(processConversation(c.env, c.params.id!, null).catch((err) => console.error('resume failed', err)));
      }
    }
    return json({ ok: true, paused_until: until });
  });

  // Chats the agent is staying out of: taken over by the owner or paused, with when it may reply again.
  r.get('/api/takeovers', 'owner', async (c) => {
    const rows = await all<ConversationRow & { display_name: string; last_in: string | null }>(
      c.db,
      `SELECT cv.*, ct.display_name,
         (SELECT direction FROM messages m WHERE m.conversation_id = cv.id ORDER BY ts DESC, created_at DESC LIMIT 1) AS last_in
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       WHERE cv.paused_until IS NOT NULL AND cv.paused_until > ? ORDER BY cv.paused_until ASC LIMIT 50`,
      c.now,
    );
    return json({
      now: c.now,
      chats: rows.map((cv) => ({
        id: cv.id, channel: cv.channel, customer: cv.display_name || cv.title || 'Customer', preview: cv.last_preview,
        paused_until: cv.paused_until, reason: cv.pause_reason || '', until_unpaused: (cv.paused_until ?? 0) - c.now > 30 * DAY,
        customer_waiting: cv.last_in === 'in',
      })),
    });
  });

  // Send a message you typed yourself from the dashboard through the laptop.
  r.post('/api/conversations/:id/send', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const text = str(body.text, 'text', { max: 3000 });
    const conv = await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', c.params.id!);
    if (!conv) throw new HttpError(404, 'not_found');
    const contact = (await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
    const id = await enqueue(c.db, {
      channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: 'manual',
      target: emptyTarget({ thread_external_id: conv.external_thread_id, title: conv.title || contact.display_name, phone: contact.phone, email: contact.email, handle: contact.handle, subject: conv.subject }),
      parts: [text], expires_at: c.now + DAY, pacing: { delay_ms: 500, typing_cps: 30 },
    });
    return json({ ok: true, outbox_id: id });
  });

  r.post('/api/contacts/:id/opt-out', 'owner', async (c) => {
    const body = await c.body<{ opted_out?: unknown }>();
    await run(c.db, 'UPDATE contacts SET opted_out = ?, updated_at = ? WHERE id = ?', bool(body.opted_out, true) ? 1 : 0, c.now, c.params.id!);
    return json({ ok: true });
  });

  // ---- Settings ---------------------------------------------------------------------------------------
  r.get('/api/settings', 'owner', async (c) => json({ settings: await getSettings(c.db, true) }));

  r.put('/api/settings/:group', 'owner', async (c) => {
    const group = c.params.group!;
    if (!isSettingsGroup(group)) throw new HttpError(404, 'unknown_group');
    const patch = await c.body<Record<string, unknown>>(64_000);
    // The recovery message is changed through /api/recovery so approval is always deliberate.
    if (group === 'recovery') { delete patch.template; delete patch.consent_confirmed; }
    const next = await patchSettings(c.db, group, patch as Partial<Settings[typeof group]>);
    return json({ ok: true, [group]: next });
  });

  // ---- Devices -----------------------------------------------------------------------------------------
  r.get('/api/devices', 'owner', async (c) => json({ devices: await currentDevice(c.db, c.now) }));

  r.post('/api/devices/pair-code', 'owner', async (c) => {
    const code = pairingCode();
    await pairingCodeRow(c.db, await sha256Hex(code), c.now);
    return json({ code, server_url: c.url.origin, pairing_string: `${c.url.origin}#${code}`, expires_at: c.now + 15 * MIN });
  });

  r.delete('/api/devices/:id', 'owner', async (c) => {
    await run(c.db, 'UPDATE devices SET revoked_at = ? WHERE id = ?', c.now, c.params.id!);
    return json({ ok: true });
  });

  // ---- Health -------------------------------------------------------------------------------------------
  r.get('/api/health', 'owner', async (c) => {
    const since = c.now - DAY;
    const [devices, misses, failed, errors, usage, sel] = await Promise.all([
      currentDevice(c.db, c.now),
      all(c.db, `SELECT id, ts, channel, kind, data FROM diagnostics WHERE ts > ? ORDER BY id DESC LIMIT 60`, since),
      all<OutboxRow>(c.db, `SELECT * FROM outbox WHERE status = 'failed' AND created_at > ? ORDER BY created_at DESC LIMIT 30`, since),
      all(c.db, `SELECT id, ts, type, channel, message FROM events WHERE level = 'error' AND ts > ? ORDER BY id DESC LIMIT 30`, since),
      all(c.db, `SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, AVG(ms) AS avg_ms, SUM(ok) AS ok FROM llm_usage WHERE ts > ? GROUP BY provider, model`, since),
      selectorPack(c.db),
    ]);
    return json({
      now: c.now,
      devices,
      diagnostics: misses.map((m) => ({ ...(m as object), data: parseJson((m as { data: string }).data, {}) })),
      failed_jobs: failed.map((f) => ({ id: f.id, channel: f.channel, source: f.source, error: f.last_error, created_at: f.created_at, target: parseJson<JobTarget>(f.target, emptyTarget()).title })),
      errors,
      llm_usage: usage,
      selectors_version: sel.version,
    });
  });

  // Selector fixes saved here reach the laptop on its next sync, no reinstall needed.
  r.get('/api/selectors', 'owner', async (c) => {
    const override = await getState<{ rev: number; pack: Record<string, unknown> } | null>(c.db, 'selectors_override', null);
    return json({ ...(await selectorPack(c.db)), override: override?.pack ?? {} });
  });

  r.put('/api/selectors', 'owner', async (c) => {
    const body = await c.body<{ override?: unknown }>(200_000);
    if (typeof body.override !== 'object' || body.override === null || Array.isArray(body.override)) throw bad('invalid_field', 'override must be an object');
    const prev = await getState<{ rev: number } | null>(c.db, 'selectors_override', null);
    await setState(c.db, 'selectors_override', { rev: (prev?.rev ?? 0) + 1, pack: body.override });
    return json({ ok: true, ...(await selectorPack(c.db)) });
  });
}
