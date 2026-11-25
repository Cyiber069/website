// Faults the reply trainer (test/train) found in the agent's own checks, 2026-11-26.
import { describe, expect, it } from 'vitest';
import { renderConversation, type RawDecision } from '../../src/brain/prompt';
import { enforceDecision } from '../../src/brain/rules';
import { sanitizeParts } from '../../src/brain/sanitize';
import { analyzeTone } from '../../src/brain/tone';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import type { DecideInput, HistoryMessage } from '../../src/types';

const NOW = 1_794_700_000_000;
const inMsg = (body: string): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: NOW });
const esc = { question: 'q', reason: 'r', category: 'refund_return' };
const flags = { opt_out: false, asked_if_bot: false, needs_human: true };
function enforce(parts: string[], history: HistoryMessage[], channel: DecideInput['channel'] = 'whatsapp', sources = 'The 30Ah only fits XL or stealth frames. 2000W bundle from £595.') {
  const d: RawDecision = { action: 'escalate', parts, confidence: 0.6, escalate: esc, flags, kb_refs: [], note: '' };
  const input: DecideInput = { channel, contact_name: null, subject: null, history, context_notes: [], now: NOW, mode: 'live' };
  return enforceDecision(d, { settings: DEFAULT_SETTINGS, input, tone: analyzeTone(history).profile, sources: `${sources}\n${renderConversation(history, NOW)}` });
}

describe('a hand over keeps what the model wrote', () => {
  it("keeps the owner's refund reply instead of swapping it for a bare holding line", () => {
    const reply = "I'm really sorry about this. I'm passing it straight to the team so they can sort it properly, and we'll come back to you as soon as possible. Could you send your order number so they can find your order straight away?";
    const out = enforce([reply], [inMsg('I want a full refund or I will go to my bank')], 'gmail');
    expect(out.action).toBe('escalate');
    expect(out.parts.join(' ')).toContain("I'm passing it straight to the team");
    expect(out.parts.join(' ')).not.toMatch(/^Let me check that/);
  });
  it('keeps both messages of a confirmed order change', () => {
    const out = enforce([
      "Yes, of course. We'll go with the 2000W bundle on 27.5 inch wheels with the 30Ah battery, and the battery bag from your other order will still come with it",
      "I've passed it to the team to update your order and send over the £50 payment link. The 30Ah only fits XL or stealth frames, so tell me your frame size. Do you have any other questions?",
    ], [{ ...inMsg('upgrade to the 2000W bundle for an extra £50'), direction: 'out', author: 'owner' }, inMsg('Can I go for the 2000w bundle 27.5 inch and a 30ah battery, will my battery bag still be included?')]);
    expect(out.parts).toHaveLength(2);
    expect(out.parts[1]).toContain('frame size');
  });
  it('drops a part with a made up figure, and falls back to an approved line when nothing is left', () => {
    const out = enforce(['It will be with you in 4 days for £17'], [inMsg('where is my order')]);
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]).toMatch(/warehouse so I give you the right answer|passing this to the team/);
  });
  it('stays silent when the hand over was meant to be silent', () => {
    expect(enforce([], [inMsg('hello?')]).parts).toEqual([]);
  });
});

describe('the sanitizer leaves product words alone', () => {
  it('keeps pedal assist and XL', () => {
    const r = sanitizeParts(['The 250W is pedal assist only and the assist cuts out at 25 km/h. You need a large or XL frame for the 72V'], { tone: analyzeTone([inMsg('hi')]).profile, channel: 'whatsapp', max_chars: 900, max_sentences: 10 });
    expect(r.parts.join(' ')).toContain('pedal assist only');
    expect(r.parts.join(' ')).toContain('the assist cuts out');
    expect(r.parts.join(' ')).toContain('XL');
  });
  it('still swaps the stiff verb', () => {
    const r = sanitizeParts(['We can assist you with that'], { tone: analyzeTone([inMsg('hi')]).profile, channel: 'whatsapp', max_chars: 900, max_sentences: 10 });
    expect(r.parts.join(' ')).toContain('help you');
  });
});
