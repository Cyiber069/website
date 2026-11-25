// Once a day the questions the agent could not answer go on the Knowledge screen's Teach me list.
import { describe, expect, it } from 'vitest';
import { api, inbound, sql, unique } from '../helpers/client';

describe('Teach me: unanswered customer questions', () => {
  it('puts a question the agent escalated on the list, once, and answering it saves knowledge', async () => {
    const tag = unique('tm').replace(/[^a-z0-9]/gi, '');
    const question = `unknown-question does the ${tag} charger work in Norway`;
    const r = await inbound('tiktok', unique('tm'), [{ external_id: unique('m'), direction: 'in', body: question, ts: Date.now() }]);
    expect(r.action).toBe('escalate');
    await sql(`DELETE FROM settings WHERE key = 'state:kb_gaps_harvest_at'`);
    await api('/api/test/cron', { as: 'public', body: {} });
    await api('/api/test/cron', { as: 'public', body: {} });
    const gaps = (await api('/api/kb')).data.gaps as { question: string; why_it_matters: string }[];
    const mine = gaps.filter((g) => g.question.includes(tag));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.why_it_matters).toMatch(/could not answer/);
    expect(gaps[0]!.why_it_matters).toMatch(/could not answer/); // what customers asked comes first
    // A second run the same day adds nothing.
    await api('/api/test/cron', { as: 'public', body: {} });
    expect(((await api('/api/kb')).data.gaps as { question: string }[]).filter((g) => g.question.includes(tag))).toHaveLength(1);
    // Answering it saves the knowledge and takes it off the list.
    const saved = await api('/api/kb/gaps/answer', { body: { question: mine[0]!.question, answer: 'Yes, the charger takes 100 to 240V, you only need a plug adapter.' } });
    expect(saved.status).toBe(200);
    expect(((await api('/api/kb')).data.gaps as { question: string }[]).some((g) => g.question.includes(tag))).toBe(false);
  });
});
