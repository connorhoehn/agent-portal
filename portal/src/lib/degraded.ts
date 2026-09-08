// Reading the wire's "we could not look" marker.
//
// WHY. About thirty middleware endpoints used to catch a failed read and
// answer an ordinary empty collection, so `{"errors":[]}` meant both "no tool
// errors" and "the query for tool errors blew up" — and the reassuring one is
// the reading a person gets when they came specifically to check for errors.
// Those routes now answer `200 { …, degraded: true, error: "<first line>" }`
// (the convention routes/cost.ts set, and lib/upstream.ts one layer below it).
// This is the portal half: turn that marker back into something a page can
// render, so a broken query stops looking like a quiet week.
//
// GUARD ON SHAPE, NOT PRESENCE. `degraded` is absent on every healthy answer,
// so a `'degraded' in body` test is not the check — the check is the value
// being exactly `true`, on an object.
//
// AND THE ARRAY CASE, DELIBERATELY. `GET /api/observability/drift/summary`
// answers a BARE ARRAY when it is healthy — the portal maps over it directly
// and drift-routes.test.ts pins that — and an array cannot carry a marker, so
// its failure branch answers the object form `{ agents: [], degraded, error }`
// instead. Its consumers already write `Array.isArray(x) ? x : []`, which
// silently turns the failure into an empty rollup. `readDegraded` therefore
// returns `null` for any array *by rule rather than by accident*: an array is
// always a real reading, an object may not be, and the same call handles both
// families of endpoint with no per-caller branch to get wrong.

/** The first line of the error a degraded answer carries, or `null`. */
export function readDegraded(body: unknown): string | null {
  // An array is the healthy shape wherever it appears (see above) — it has
  // nowhere to put a marker, so it cannot be claiming one.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  if (rec['degraded'] !== true) return null;
  const err = rec['error'];
  // The server promises `error`, but a marker with no message is still a
  // marker: say something rather than render a blank alert.
  return typeof err === 'string' && err.trim().length > 0
    ? err.trim()
    : 'the server did not say why';
}

/**
 * The first failure among several reads that make up one page.
 *
 * Cost, Traffic and Drift each fan out to four-to-eight endpoints off the same
 * tables; when that table is unreadable they all fail together, and seven
 * stacked banners saying the same sentence is worse than one.
 */
export function firstDegraded(...bodies: unknown[]): string | null {
  for (const b of bodies) {
    const d = readDegraded(b);
    if (d) return d;
  }
  return null;
}
