// Postgres `timestamptz::text` → a Date the browser will actually parse.
//
// WHY THIS EXISTS. Postgres renders a timestamptz as
// `2026-09-08 08:19:23+00`, and that string is wrong for JavaScript in TWO
// ways. The space instead of `T` is the obvious one and everybody handles it.
// The second is not obvious and nearly everybody missed it: `+00` is not a
// valid ISO 8601 offset — the standard wants `+00:00` (or `Z`) — so
// `new Date('2026-09-08T08:19:23+00')` is **Invalid Date** in V8.
//
// The failure is silent and production-only. Every caller here already guarded
// with something like `Number.isNaN(d.getTime()) ? raw : formatted`, so the
// page did not throw: it rendered the raw database string in a column that was
// supposed to say "2 hours ago". And it never showed up in `dev:mock`, because
// the fixtures mint their timestamps through `mock/core/clock.ts`, which emits
// `…Z`. So the bug lives exactly where nobody is looking at it.
//
// One implementation, because this repo has already learned twice that one
// question answered by two functions is how the two answers drift apart.

/** Normalise a Postgres (or ISO) timestamp string into something `Date` parses. */
export function normalizePgTimestamp(raw: string): string {
  return raw
    .replace(' ', 'T')
    // `+00` / `-05` → `+00:00` / `-05:00`. Anchored, so an already-correct
    // `+00:00` and a trailing `Z` are both left alone.
    .replace(/([+-]\d{2})$/, '$1:00');
}

/**
 * Parse one. Returns `null` rather than an `Invalid Date`, so a caller has to
 * decide what an unparseable stamp means instead of formatting `NaN`.
 */
export function parsePgTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(normalizePgTimestamp(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Epoch ms, or `NaN` — for the call sites that feed arithmetic and charts. */
export function pgTimestampMs(raw: string | null | undefined): number {
  const d = parsePgTimestamp(raw);
  return d === null ? Number.NaN : d.getTime();
}

/**
 * Parse, treating a stamp with NO zone as UTC.
 *
 * Some observability rows arrive naive (`2026-09-08 08:19:23`) and the pages
 * that read them mean UTC. The naive way to say that — appending `'Z'` — is
 * a bug on a stamp that DOES carry an offset: `…+00` + `Z` is `…+00Z`, which
 * is doubly invalid. Normalise first, then only add `Z` when nothing else
 * says what zone it is.
 */
export function parsePgTimestampAsUtc(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const iso = normalizePgTimestamp(raw);
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(iso);
  const d = new Date(zoned ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
