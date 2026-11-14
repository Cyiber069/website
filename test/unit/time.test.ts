import { describe, expect, it } from 'vitest';
import { londonDateTimeToTs, londonOffsetMinutes, londonTime, nextLondonHour } from '../../src/lib/time';

const utc = (s: string) => Date.parse(s);

describe('Europe/London clock', () => {
  it('reads winter (GMT) and summer (BST) wall time', () => {
    expect(londonTime(utc('2026-11-14T20:00:00Z'))).toMatchObject({ date: '2026-11-14', hour: 20, minute: 0 });
    expect(londonTime(utc('2026-07-01T19:00:00Z'))).toMatchObject({ date: '2026-07-01', hour: 20, minute: 0 });
    expect(londonOffsetMinutes(utc('2026-01-10T12:00:00Z'))).toBe(0);
    expect(londonOffsetMinutes(utc('2026-07-10T12:00:00Z'))).toBe(60);
  });

  it('turns a London wall time into the right instant all year', () => {
    expect(londonDateTimeToTs('2026-11-14', 20)).toBe(utc('2026-11-14T20:00:00Z'));
    expect(londonDateTimeToTs('2026-07-01', 20)).toBe(utc('2026-07-01T19:00:00Z'));
    // The evening of the clock change days.
    expect(londonDateTimeToTs('2026-03-29', 20)).toBe(utc('2026-03-29T19:00:00Z')); // BST began at 01:00 that morning
    expect(londonDateTimeToTs('2026-10-25', 20)).toBe(utc('2026-10-25T20:00:00Z')); // back to GMT that morning
  });

  it('finds the next 20:00 London', () => {
    expect(nextLondonHour(utc('2026-11-14T19:59:00Z'), 20)).toBe(utc('2026-11-14T20:00:00Z'));
    expect(nextLondonHour(utc('2026-11-14T20:00:00Z'), 20)).toBe(utc('2026-11-15T20:00:00Z'));
    expect(nextLondonHour(utc('2026-03-28T21:30:00Z'), 20)).toBe(utc('2026-03-29T19:00:00Z'));
    expect(nextLondonHour(utc('2026-10-24T19:30:00Z'), 20)).toBe(utc('2026-10-25T20:00:00Z'));
  });
});
