import { describe, expect, it } from 'vitest';
import { noReplyNeeded } from '../../src/pipeline/noreply';

describe('noReplyNeeded', () => {
  it('skips streak counting and lone reactions', () => {
    for (const t of ['day 12', 'Day 13', 'DAY 14!!', 'day 15 🙏', 'Day 16 of messaging ACX until I get a free kit', 'day 100 until free bike', 'd17', '👍', '🔥🔥', '😂 😂']) {
      expect(noReplyNeeded(t), t).toBe(true);
    }
    expect(noReplyNeeded('', 'sticker')).toBe(true);
  });
  it('answers real questions, even ones that start with day', () => {
    for (const t of ['day 12 and my order still has not come', 'how fast does the 2000w go', 'ok but which battery do I need', 'day 3 of waiting for my refund', 'yo', 'thanks bro, one more question']) {
      expect(noReplyNeeded(t), t).toBe(false);
    }
  });
});
