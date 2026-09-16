// One shape for every write against the middleware, for every page.
//
// This used to be ~13 hand-rolled copies across pages/sprints, pages/admin/kb,
// pages/local-compute, pages/project-detail and a handful of one-off
// `fetch(...).then(...)` blocks. Several of those copies skipped the server's
// `{ error }` body entirely (surfacing `res.statusText` or a bare status
// code instead), and the two worst bugs the write-path audit found were both
// exactly that: a hand-rolled copy that silently swallowed the real refusal
// reason. This is the one version everything now shares.
//
// `conflict`/`gate`/`confirmFlag` exist because some routes are guarded by a
// soft money brake (see docs/program-operating-model.md) that answers 409
// with `{ gate, confirmFlag }` naming which brake tripped and which flag
// re-sends past it — callers that care read those off the result rather than
// treating every 409 as a plain error.

export interface WriteResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  /**
   * The server refused because the thing it asks for is ALREADY HAPPENING
   * (e.g. a sync already in flight) — read off the body's `{ conflict: true }`
   * rather than off `status === 409`, since 409 is also the answer to a
   * duplicate slug or an unconfigured resource, neither of which is "busy,
   * not broken".
   */
  conflict: boolean;
  /** Which soft money brake tripped, on a dispatch 409 (`docs/program-operating-model.md`). */
  gate?: string;
  /** The confirm flag that re-sends the same write past that brake. */
  confirmFlag?: string;
}

interface ErrorBody {
  error?: string;
  conflict?: boolean;
  gate?: string;
  confirmFlag?: string;
}

/**
 * Sends JSON with the session cookie and surfaces the backend's `{ error }`
 * message verbatim. A bare 403 with no body reads as a permission problem
 * rather than a raw status code. Never throws — inspect `.ok`.
 */
export async function writeJson<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as ErrorBody & Record<string, unknown>;
    if (!res.ok) {
      const fallback = res.status === 403
        ? 'You do not have permission for this action.'
        : `HTTP ${res.status}`;
      return {
        ok: false,
        status: res.status,
        // Carried through even on failure: some routes' error bodies name
        // something the caller needs to act on (e.g. `jobId` of the run
        // already in flight on a 409), not just an error string.
        data: Object.keys(json).length ? (json as T) : null,
        error: json.error ?? fallback,
        conflict: json.conflict === true,
        gate: json.gate,
        confirmFlag: json.confirmFlag,
      };
    }
    return { ok: true, status: res.status, data: json as T, error: null, conflict: false };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : 'Request failed',
      conflict: false,
    };
  }
}

export class HttpError extends Error {
  status: number;
  gate?: string;
  confirmFlag?: string;
  constructor(status: number, message: string, opts?: { gate?: string; confirmFlag?: string }) {
    super(message);
    this.status = status;
    this.gate = opts?.gate;
    this.confirmFlag = opts?.confirmFlag;
  }
}

/**
 * Throwing wrapper over {@link writeJson}. Insists on an answer — non-2xx
 * throws `HttpError` carrying the server's own message, so a refusal can
 * never be mistaken for success by a caller that forgets to check `.ok`.
 */
export async function sendJson<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const res = await writeJson<T>(url, method, body);
  if (!res.ok) throw new HttpError(res.status, res.error ?? `HTTP ${res.status}`, { gate: res.gate, confirmFlag: res.confirmFlag });
  return res.data as T;
}
