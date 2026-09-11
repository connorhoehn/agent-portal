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
