// Which extension is talking to the server. The owner's laptop may run an older build for a while
// after a deploy, so a few answers depend on it.

/**
 * True for an extension release before 0.4.0. Those builds have no newer_message re-read and treat
 * typing_cps 0 as a slow typing speed, so they get the pacing and the settle time they were made for.
 * A version that is not a release number (a test or a dev build) counts as current.
 */
export function isLegacyExtension(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(version ?? '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major === 0 && minor < 4;
}

/** The settle time the old builds were made for: they need the long quiet wait (12 s) to read a burst once. */
export const LEGACY_SETTLE_SECONDS = 12;

/**
 * True for an extension that knows about lanes (0.6.0 and up, or a test or dev build): it stands by when
 * another laptop answers a lane (it only probes, never reads or sends) and it runs the dashboard's
 * commands (open a tab). Older builds read every lane they have open; the server still gives them jobs
 * only for the lanes they answer.
 */
export function canStandBy(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(version ?? '').trim());
  if (!m) return true;
  return Number(m[1]) > 0 || Number(m[2]) >= 6;
}
