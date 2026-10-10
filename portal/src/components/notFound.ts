// Did a read of ONE record come back "there is no such record"?
//
// That is an answer, not an outage: the server knows, so UnavailableNotice's
// "unknown rather than empty" and a Try again that can never succeed both
// mislead. `useFetch` renders a failed response as
// "<status> <text> — <server reason>", so the status leads the line. Use it
// only for a record addressed by id — a 404 from a collection route means the
// route itself is missing, which IS an outage.
//
// Pure (no JSX) so node:test can load it; re-exported from UnavailableNotice.

export function isNotFoundError(error: string | null | undefined): boolean {
  return !!error && /^404\b/.test(error.trim());
}
