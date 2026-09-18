// How a provider says "I could not look" — the layer below `degraded`.
//
// WHY THIS EXISTS. routes/cost.ts and routes/environments.ts fixed the
// route-level version of this: a caught failure that answers `200 {"xs":[]}`
// destroys the difference between "there is nothing here" and "we could not
// look", so every such catch now adds `degraded: true` plus the first line of
// the error. That fix stops at the route, and the route is not where the
// distinction is usually lost. It is lost a call deeper:
//
//     const runtimes = await agentcore.listRuntimes();   // [] — why?
//
// `providers/agentcore.ts` caught `ListAgentRuntimes` and returned `[]`, so
// "the fleet is not deployed" and "the control-plane call failed" arrived at
// the route as the same value and no marker the route could add would be
// honest. That is not hypothetical here: CLAUDE.md records a rebuild where an
// empty listing was read as "nothing is deployed" for exactly this reason, and
// the agent-detail page turned it into `404 No agent runtime matching
// "orgiq-supervisor"` — a sentence that says the agent was deleted.
//
// THE SHAPE, AND WHY THIS ONE.
//
//   { items }                            we looked; this is what there is
//   { items, degraded: true, error }     we could not look; `items` is a floor
//
// Three shapes were on the table.
//
//   * A THROWN error. The most rigorous — impossible to read past by accident
//     — and rejected because it cannot be adopted one caller at a time. The
//     instant the provider throws, every call site that has not been converted
//     turns a `200` into a `500`, including call sites in files a given slice
//     is not allowed to edit. A fix whose first effect is a fleet of new 500s
//     is not a fix.
//   * A Result<T, E> union (`ok | err`). Forces the caller to discriminate
//     before it can render anything, which is the same adoption problem plus a
//     tag to get wrong — and it is wrong on the merits here. A degraded read
//     still has to render: the page shows the empty list AND says why. The
//     failure is EXTRA information about the answer, never a replacement for
//     it, and the type should say so.
//   * This envelope. `items` is always present and is always what the old
//     lossy call returned, so an unconverted caller reading `.items` behaves
//     exactly as it does today; a converted one spreads `degradedFields()`
//     into its response and the wire gains the marker.
//
// SAME WORDS AS THE WIRE, DELIBERATELY. `degraded: true` and a 160-character
// first line are what cost.ts and environments.ts already put on the wire and
// what routes/__tests__/swallowed-failure-scan.test.ts already recognises as a
// marker. Inventing a second vocabulary one layer down — `ok: false`,
// `partial`, `stale` — would mean translating at every route and would make
// the scan's MARKERS set a half-truth. `degradedFields()` exists so the
// translation is `...degradedFields(x)` and cannot drift.
//
// WHAT THIS IS NOT. It is not a retry, a circuit breaker, or a cache. It
// carries one fact — this answer is not a reading of the world — to whoever
// can act on it. Deciding what to do about that is the caller's job, and the
// right answer differs: a page renders the marker, a poller records a streak,
// and a CONCURRENCY CEILING must refuse outright, because a brake that treats
// "I could not count" as "zero are running" is not a brake.

/**
 * An answer, plus whether it is a reading of the world or a fallback.
 *
 * A union rather than an object with two optional fields, so `error` cannot be
 * set without `degraded` and TypeScript narrows on the flag.
 */
export type Upstream<T> =
  | { items: T; degraded?: undefined; error?: undefined }
  | { items: T; degraded: true; error: string };

/** The first line of an error, capped — a multi-line upstream message is a
 *  label on a page, not a stack trace. Same trim as routes/cost.ts. */
export function firstLine(err: unknown, fallback = 'upstream unavailable'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const line = raw.split('\n')[0]?.trim();
  return line ? line.slice(0, 160) : fallback;
}

/** We looked, and this is what there is. */
export function reached<T>(items: T): Upstream<T> {
  return { items };
}

/**
 * We could not look. `fallback` is what the caller gets to render — the same
 * empty collection the lossy version returned, so nothing downstream has to
 * handle a missing value as well as a failure.
 */
export function unreachable<T>(fallback: T, err: unknown, note?: string): Upstream<T> {
  const line = firstLine(err);
  return { items: fallback, degraded: true, error: note ? `${note}: ${line}` : line };
}

/**
 * Run `read`, and turn a throw into a degraded answer over `fallback`.
 *
 * The one place a `catch` is allowed to become an empty collection, because it
 * is the one place that records why.
 */
export async function attempt<T>(
  read: () => Promise<T>,
  fallback: T,
  note?: string,
): Promise<Upstream<T>> {
  try {
    return reached(await read());
  } catch (err) {
    return unreachable(fallback, err, note);
  }
}

/**
 * The marker, ready to spread into a route response.
 *
 * `res.json({ sessions: r.items, ...degradedFields(r) })` — a healthy answer
 * spreads nothing and is byte-identical to what the route sent before, which
 * is the property that lets a page and its tests stay as they are. Only a
 * failure changes shape.
 */
export function degradedFields<T>(
  r: Upstream<T>,
): Record<string, never> | { degraded: true; error: string } {
  return r.degraded ? { degraded: true, error: r.error } : {};
}

/**
 * The first line of a failure, short enough to print in a banner.
 *
 * Ten route files carried this expression verbatim as
 * `message.split('\n')[0]?.slice(0, 160)`, and a hard slice cuts mid-word: the
 * on-call banner read "alarms: could not evaluat.", which a reader takes for a
 * typo in the product rather than a truncated database error. Cutting at the
 * last word boundary and marking the cut with an ellipsis says the same thing
 * and admits there is more. Kept at 160 so no existing body grows.
 */
export function reasonLine(err: unknown, fallback = 'query failed'): string {
  const first = (err as Error | undefined)?.message?.split('\n')[0]?.trim();
  if (!first) return fallback;
  if (first.length <= 160) return first;
  const cut = first.slice(0, 160);
  const sp = cut.lastIndexOf(' ');
  // A 160-char run with no space is one long token (a URL, an ARN); slicing it
  // anywhere is equally arbitrary, so keep the full width rather than losing
  // most of it to a word boundary that isn't there.
  return `${(sp > 120 ? cut.slice(0, sp) : cut).replace(/[.,;:]$/, '')}…`;
}

/**
 * Join several degradation reasons into the one `problem` sentence a surface
 * that already has such a field (providers/kb-reconcile.ts) reports. Returns
 * undefined when nothing was degraded, so it can be spread conditionally.
 */
export function problemFrom(...reasons: Array<string | undefined>): string | undefined {
  const kept = reasons.filter((r): r is string => Boolean(r));
  return kept.length > 0 ? kept.join('; ') : undefined;
}
