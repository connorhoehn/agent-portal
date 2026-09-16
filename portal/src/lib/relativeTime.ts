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

import { parsePgTimestamp } from './pgTimestamp.ts';

/**
 * "just now" · "12m ago" · "5h ago" · "3d ago" · "Aug 4, 2026".
 *
 * Returns `''` for a null/undefined instant so callers can drop the whole line
 * rather than render an empty bullet, and echoes an unparseable string back
 * unchanged instead of printing "NaN ago".
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = parsePgTimestamp(iso);
  if (then === null) return iso;

  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;

  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The same clock at second resolution, for surfaces where "just now" is too
 * coarse to show that a poll is live — an open browser session that last did
 * something 8 seconds ago should say so.
 */
export function relativeTimeSeconds(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = parsePgTimestamp(iso);
  if (then === null) return iso;

  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
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
