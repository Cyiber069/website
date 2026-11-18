// When the dashboard refreshes next. Each refresh reads the database, and the free plan allows 5 million
// rows a day, so the page refreshes every 30 s while it is visible, focused and in use, and every 2 min
// while it is visible behind another window or nobody has clicked, typed, touched, scrolled or moved the
// mouse on it for 5 minutes. It never stops while it can be seen: the owner keeps Live open beside the
// WhatsApp window or on the phone and must see the truth there (about 70 rows a refresh, about 50,000 a
// day if left open all day). Never while hidden: it refreshes at once when shown again. When the server
// says the day's database use is high (overview.budget) it waits at least that long. Pure functions,
// tested in test/unit/d1-diet.test.ts.
export const FOCUSED_MS = 30_000;
export const BLURRED_MS = 120_000;
export const IDLE_MS = 5 * 60 * 1000;
/** What is on screen is called out of date when the last good refresh is older than this (two slow ones missed). */
export const STALE_MS = 5 * 60 * 1000;

/** How long between refreshes right now. */
export function refreshEvery({ focused, idle = false, budgetSeconds }) {
  return Math.max(Math.max(0, Number(budgetSeconds) || 0) * 1000, focused && !idle ? FOCUSED_MS : BLURRED_MS);
}

/** Milliseconds until the next refresh, or null while the page is hidden. */
export function nextRefreshIn({ now, lastTick, lastActive, hidden, focused, budgetSeconds }) {
  if (hidden) return null;
  const idle = now - lastActive > IDLE_MS;
  return Math.max(1000, lastTick + refreshEvery({ focused, idle, budgetSeconds }) - now);
}

/** Someone is back after the page stopped refreshing (it was hidden): refresh at once (unless it just did). */
export function refreshOnWake({ now, lastTick, stopped }) {
  return Boolean(stopped) && now - lastTick > 5000;
}

/** The screen shows what the server said more than STALE_MS ago: refreshes failed, or the computer slept. */
export function isStale({ now, lastGoodAt }) {
  return Boolean(lastGoodAt) && now - lastGoodAt > STALE_MS;
}
