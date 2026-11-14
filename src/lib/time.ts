// Europe/London wall clock helpers. Cron triggers run in UTC, so anything "at 20:00 UK time"
// is decided here and stays right across GMT and BST.

const LONDON = 'Europe/London';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', weekday: 'short',
});

export interface LondonTime {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: string;
}

export function londonTime(ts: number): LondonTime {
  const map: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) map[p.type] = p.value;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: map.weekday ?? '',
  };
}

/** Offset of Europe/London from UTC in minutes at the given instant (0 in winter, 60 in summer). */
export function londonOffsetMinutes(ts: number): number {
  const lt = londonTime(ts);
  const [y, m, d] = lt.date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, lt.hour, lt.minute);
  const truncated = Math.floor(ts / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** Unix ms of the given London wall clock time on the given London date (YYYY-MM-DD). */
export function londonDateTimeToTs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // Correct by the offset in force around that moment (two passes cover the DST edges).
  let ts = guess - londonOffsetMinutes(guess) * 60_000;
  ts = guess - londonOffsetMinutes(ts) * 60_000;
  return ts;
}

/** Calendar arithmetic on a YYYY-MM-DD date (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The next time the London clock reads hour:00, strictly after `ts`. */
export function nextLondonHour(ts: number, hour: number): number {
  const today = londonTime(ts).date;
  const candidate = londonDateTimeToTs(today, hour);
  return candidate > ts ? candidate : londonDateTimeToTs(addDays(today, 1), hour);
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
