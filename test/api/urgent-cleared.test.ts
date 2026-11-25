// The owner answers a customer by hand (from the phone or the app, not the dashboard): that chat's open
// Urgent items are cleared on the next read, so nobody answers the same thing twice (owner, 2026-11-25).
import { describe, expect, it } from 'vitest';
import { inbound, sql, unique } from '../helpers/client';

const urgentOf = async (convId: string) => (await sql(`SELECT status, owner_answer FROM urgent WHERE conversation_id = ? ORDER BY created_at`, [convId])).data.results as { status: string; owner_answer: string | null }[];

describe('Urgent clears itself when the owner answers in the chat', () => {
  it('dismisses the open Urgent item once the owner writes to that customer by hand', async () => {
    const thread = unique('uc');
    const t0 = Date.now() - 60_000;
    const asked = await inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: 'unknown-question about the moon warranty', ts: t0 }]);
    expect(asked.action).toBe('escalate');
    const convId = asked.conversation_id!;
    expect((await urgentOf(convId)).map((u) => u.status)).toEqual(['open']);

    // The owner replies from their phone: the extension reads it as an outgoing message the agent did not send.
    await inbound('whatsapp', thread, [
      { external_id: unique('m'), direction: 'in', body: 'unknown-question about the moon warranty', ts: t0 },
      { external_id: unique('m'), direction: 'out', body: 'Hi, the warranty is 12 months, I will sort it for you', ts: Date.now() },
    ]);
    const after = await urgentOf(convId);
    expect(after.map((u) => u.status)).toEqual(['dismissed']);
    expect(after[0]!.owner_answer).toMatch(/yourself/);
    // No reply from the agent is left queued for that chat.
    const queued = (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ? AND status IN ('pending', 'leased', 'review') AND source IN ('auto', 'holding')`, [convId])).data.results[0].n;
    expect(queued).toBe(0);
  });

  it('leaves the Urgent item alone when nobody answered by hand', async () => {
    const thread = unique('uc');
    const asked = await inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: 'unknown-question about the moon battery', ts: Date.now() }]);
    expect(asked.action).toBe('escalate');
    expect((await urgentOf(asked.conversation_id!)).map((u) => u.status)).toEqual(['open']);
  });
});
