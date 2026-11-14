// Owner facing API for the Voice screen. The style settings themselves are the "voice" settings group
// (PUT /api/settings/voice). This file adds the playground, where the owner types as a customer and
// sees exactly what the agent would send. Nothing here is stored or sent.
import { decide } from '../brain';
import { chooseProvider } from '../brain/llm';
import { all } from '../lib/db';
import { bad, json, oneOf, type Router } from '../lib/http';
import { getSettings } from '../lib/settings';
import { CHANNELS, type HistoryMessage } from '../types';

const MAX_MESSAGES = 30;
const MAX_BODY = 4000;

export function register(r: Router): void {
  r.post('/api/playground', 'owner', async (c) => {
    const body = await c.body<{ messages?: unknown; channel?: unknown }>();
    const channel = oneOf(body.channel, 'channel', CHANNELS, 'whatsapp');
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw bad('missing_field', 'messages is required', { field: 'messages' });

    const list = body.messages.slice(-MAX_MESSAGES);
    const history: HistoryMessage[] = list.map((raw, i) => {
      const m = (raw ?? {}) as { direction?: unknown; body?: unknown };
      if (m.direction !== 'in' && m.direction !== 'out') throw bad('invalid_field', 'Each message needs direction "in" or "out"', { field: 'messages' });
      if (typeof m.body !== 'string') throw bad('invalid_field', 'Each message needs a text body', { field: 'messages' });
      return {
        direction: m.direction, author: m.direction === 'in' ? 'customer' : 'agent', body: m.body.slice(0, MAX_BODY), kind: 'text',
        ts: c.now - (list.length - i) * 20_000, // pretend the messages arrived 20 seconds apart
      };
    });
    if (history[history.length - 1]!.direction !== 'in') throw bad('invalid_field', 'The last message must be from the customer', { field: 'messages' });

    const started = Date.now();
    const settings = await getSettings(c.db);
    const choice = await chooseProvider(c.env, settings);
    const d = await decide(c.env, { channel, contact_name: null, subject: channel === 'gmail' ? 'Question' : null, history, context_notes: [], now: c.now, mode: 'playground' });

    // Titles for the knowledge the answer leaned on, so the owner can see where it came from.
    const titles = d.kb_refs.length
      ? await all<{ id: string; title: string }>(c.db, 'SELECT id, title FROM kb_docs WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(d.kb_refs))
      : [];
    const byId = new Map(titles.map((t) => [t.id, t.title]));
    return json({
      decision: { action: d.action, parts: d.parts, confidence: d.confidence, escalate: d.escalate, tone: d.tone, flags: d.flags, note: d.note },
      kb_refs: d.kb_refs.filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)! })),
      ms: Date.now() - started, provider: d.usage?.provider ?? choice.provider, model: d.usage?.model ?? choice.model,
    });
  });
}
