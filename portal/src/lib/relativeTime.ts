// One relative-timestamp formatter for the portal.
//
// Three pages had shipped three near-identical private copies of this
// (ProjectsPage.relativeTime, BrowserPage.formatAge, PromptsPage.fmtRelative),
// each with a slightly different cutover — one dropped to a calendar date after
// a week, one never did, one stopped at hours and reported a two-day-old
// session as "51h ago". They now share this module. Other pages still carrying
// a private copy should adopt it as they are touched.
//
// Both entry points parse through `lib/pgTimestamp` rather than `new Date`,
// because several of the fields fed to them are Postgres `timestamptz` values
// rendered as `2026-09-08 08:19:23+00` — a string V8 refuses (`+00` is not a
// legal ISO 8601 offset). The `isNaN` guard below meant that failure printed
// the raw database row instead of "3h ago", and only ever in AWS: `dev:mock`
// mints its fixtures through `mock/core/clock.ts`, which emits `…Z`.

import { parsePgTimestamp, parsePgTimestampAsUtc } from './pgTimestamp.ts';

/**
 * A server instant. A stamp with a clock time but no zone
 * (`2026-09-08 08:19:23`, how the RDS Data API renders a TIMESTAMPTZ) means
 * UTC here, never the browser's local zone: read as local it lands hours in
 * the future west of Greenwich. While this formatter had no future branch
 * that error hid as "just now"; with one it would read "in 3h".
 */
function parseInstant(iso: string): Date | null {
  return /\d{2}:\d{2}/.test(iso) ? parsePgTimestampAsUtc(iso) : parsePgTimestamp(iso);
}

/**
 * "just now" · "12m ago" · "5h ago" · "3d ago" · "Aug 4, 2026", and the same
 * ladder forwards for a future instant: "in 12m" · "in 5h" · "in 3d" ·
 * "Nov 12, 2026".
 *
 * The future branch exists because an active grant's "Expires" (the access
 * request record) used to fall into the `mins < 2` bucket — any negative
 * difference read "just now". Both directions share one cutover: under two
 * minutes either way is "just now" (absorbs clock skew on a fresh write),
 * and a week or more either way is a calendar date.
 *
 * Returns `''` for a null/undefined instant so callers can drop the whole line
 * rather than render an empty bullet, and echoes an unparseable string back
 * unchanged instead of printing "NaN ago".
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = parseInstant(iso);
  if (then === null) return iso;

  const diffMs = Date.now() - then.getTime();
  const future = diffMs < 0;
  const mins = Math.floor(Math.abs(diffMs) / 60_000);
  const say = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (mins < 2) return 'just now';
  if (mins < 60) return say(mins, 'm');

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return say(hrs, 'h');

  const days = Math.floor(hrs / 24);
  if (days < 7) return say(days, 'd');

  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The same clock at second resolution, for surfaces where "just now" is too
 * coarse to show that a poll is live — an open browser session that last did
 * something 8 seconds ago should say so.
 */
export function relativeTimeSeconds(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = parseInstant(iso);
  if (then === null) return iso;

  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  // A future instant (or one a few seconds ahead through clock skew) takes
  // the minute ladder rather than printing "-5s ago".
  if (secs >= 0 && secs < 60) return `${secs}s ago`;
  return relativeTime(iso);
}

/**
 * The fully-resolved local clock — "9/8/2026, 8:19:23 AM" — for surfaces that
 * want the actual timestamp rather than an age (a rail's "Captured", a job's
 * Queued/Claimed/Started/Finished timeline). Returns `'—'` for a
 * null/undefined/unparseable instant, since there's no raw string worth
 * echoing back for a value the reader expects to be a clock face.
 */
export function absoluteTime(iso: string | null | undefined): string {
  const then = parsePgTimestamp(iso);
  return then === null ? '—' : then.toLocaleString();
}

/**
 * "140ms" · "1.8s" · "3m 20s" — a task/run duration in human units.
 *
 * `AgentProjectsPage` and `JobDetailPage` had each grown their own copy of
 * this, one rounding to the nearest minute and the other keeping seconds
 * within the minute — shared here on the more precise of the two. Returns
 * `'—'` for a missing or non-positive duration (a duration of exactly 0 is
 * indistinguishable from "never measured").
 */
export function durationLabel(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
