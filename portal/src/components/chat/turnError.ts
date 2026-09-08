// turnError — what to tell the user when a chat turn's POST fails, and how to
// get the real detail there.
//
// useAgentStream (realtime-modules) reports send failures as a single
// `error: string`, built from `throw new Error(\`Stream failed: ${res.status}\`)`
// when the response isn't ok — the middleware's actual JSON body (e.g.
// routes/agents.ts's `{ error: 'authorization unavailable', action: … }` on a
// 503, or `{ error: 'Forbidden', requiredTenant, agentId }` on a 403) is read
// nowhere and lost. DEFECTS.md program-owner #5: a real 503 mid-restart
// rendered as a bare "Error: Stream failed: 500" with no way to retry and no
// server detail — the wrong status, no explanation, no recovery but retyping.
//
// The fix lives in two parts:
//  - `describeTurnError` (here): pure status+body → one human sentence.
//  - InvokePage's injected `fetch` (agentInvokeFetch): the only place that
//    still holds the real Response, so it reads the body and calls this
//    function BEFORE throwing — the hook's `error` then already carries the
//    honest text, with no parsing needed downstream.

/** Short, non-technical headline for a known HTTP status. Chosen from the
 *  responses this app's own routes actually send (see routes/agents.ts,
 *  routes/authz.ts) — not a generic HTTP status-code dictionary. */
const STATUS_LABELS: Record<number, string> = {
  400: 'That request was invalid',
  401: 'You need to sign in again',
  403: "You don't have permission for this",
  404: 'That agent could not be found',
  408: 'The request timed out',
  409: 'That conflicts with the current state',
  429: 'Too many requests — slow down and try again',
  500: 'Something went wrong on the server',
  502: 'The agent gateway had a bad response',
  503: 'The agent is unavailable',
  504: 'The agent took too long to respond',
};

function labelFor(status: number): string {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (status >= 500) return 'Something went wrong on the server';
  if (status >= 400) return 'The request failed';
  return 'The request did not complete';
}

function truncate(s: string, max = 240): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Pull the one human-readable detail out of a response body, or undefined
 * when there isn't one. This app's error responses are JSON `{ error: string,
 * ... }` (occasionally `message`/`detail`/`reason`); a non-JSON body is used
 * as raw text so an upstream proxy's plain-text error page still says
 * something. Long text is capped so the banner stays one or two lines.
 */
export function extractServerDetail(body?: string | null): string | undefined {
  if (!body) return undefined;
  const raw = body.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'reason']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim()) return truncate(v.trim());
    }
    return undefined; // valid JSON but none of the known detail fields — say nothing rather than dump the object
  } catch {
    return truncate(raw); // not JSON — a plain-text error body still has something to say
  }
}

/**
 * The full sentence for a failed turn: "<what happened> (<status>) — <server
 * detail>", or without the dash when there is no detail to add. `status <= 0`
 * (or non-finite) means the request never reached a server at all — a
 * connection failure, not an HTTP error — and gets its own message with no
 * status number to misreport.
 */
export function describeTurnError(status: number, body?: string | null): string {
  if (!Number.isFinite(status) || status <= 0) {
    return 'Could not reach the agent — check your connection and retry.';
  }
  const detail = extractServerDetail(body);
  const label = labelFor(status);
  return detail ? `${label} (${status}) — ${detail}` : `${label} (${status})`;
}
