// Pure classification of the error string useFetch() produces
// (`${res.status} ${res.statusText}`, e.g. "404 Not Found") so
// JobDetailPage can tell "this job id does not exist" apart from a
// transient/other failure without re-deriving the parse inline — and so the
// distinction is unit-testable without mounting the page (no fetch, no DOM).
//
// Guards on the numeric status prefix, never on substring-matching the
// message text — a job whose recorded error happens to mention "404" must
// not be mistaken for a fetch failure.

/** True when the useFetch() error came from an HTTP 404 response. */
export function isNotFoundFetchError(error: string | null): boolean {
  if (!error) return false;
  return /^404(\s|$)/.test(error);
}
