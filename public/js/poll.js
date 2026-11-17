// When the dashboard refreshes next. Each refresh reads the database, and the free plan allows 5 million
// rows a day, so the page refreshes every 30 s while it is visible and focused, every 2 min while it is
// visible behind another window, never while it is hidden, and not after 5 minutes with no click, key,
// touch, wheel or mouse move. When the server says the day's database use is high (overview.budget) it
// waits at least that long. Pure functions, tested in test/unit/d1-diet.test.ts.
export const FOCUSED_MS = 30_000;
export const BLURRED_MS = 120_000;
export const IDLE_MS = 5 * 60 * 1000;

/** How long between refreshes right now. */
export function refreshEvery({ focused, budgetSeconds }) {
  return Math.max(Math.max(0, Number(budgetSeconds) || 0) * 1000, focused ? FOCUSED_MS : BLURRED_MS);
}

/** Milliseconds until the next refresh, or null for none until someone is back. */
export function nextRefreshIn({ now, lastTick, lastActive, hidden, focused, budgetSeconds }) {
  if (hidden || now - lastActive > IDLE_MS) return null;
  return Math.max(1000, lastTick + refreshEvery({ focused, budgetSeconds }) - now);
}

/** Someone is back after the page stopped refreshing: refresh at once (unless it just did). */
export function refreshOnWake({ now, lastTick, stopped }) {
  return Boolean(stopped) && now - lastTick > 5000;
}
