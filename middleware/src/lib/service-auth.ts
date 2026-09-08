// Service auth for the middleware's SESSIONLESS MACHINE CALLBACKS.
//
// A handful of routes are called by deployed AgentCore runtimes and by the
// harness runner, none of which carry a session cookie. They cannot take the
// Cedar/session gates the rest of their routers take, so each instead carries
// a shared secret in a header, compared in constant time. The contract is
// deliberately *optional* so the middleware and the fleet can deploy in either
// order:
//
//   env var unset  → the guard is open (today's demo/dev default)
//   env var set    → the header must match, byte for byte
//
//   route                                          env var                        header
//   POST /api/observability/approvals/request      APPROVALS_REQUEST_SECRET       x-approvals-auth
//   GET  /api/observability/approvals/:id          APPROVALS_REQUEST_SECRET       x-approvals-auth
//   POST /api/observability/harness/trace          HARNESS_TRACE_SECRET           x-harness-auth
//   POST /api/assessment/runs/:runId/complete      ASSESSMENT_RUN_COMPLETE_SECRET x-assessment-run-auth
//   the harness runner's control plane (below)     HARNESS_RUNNER_SECRET          x-harness-runner-auth
//
// TWO GUARD SHAPES, and the difference matters:
//
//   requireServiceAuth()  — for a WRITE-ONLY machine endpoint that no human
//     surface reads. Open when the secret is unset. This is the existing
//     precedent (approvals /request, harness /trace, assessment /complete).
//
//   serviceAuthOr(...human) — for an endpoint that BOTH a machine and a human
//     use. A valid service credential passes; ANYTHING ELSE falls through to
//     the human guards unchanged. Crucially it is NOT open when the secret is
//     unset: with no secret configured the route behaves exactly as it did
//     before this guard existed (session + Cedar), so adding it can never turn
//     a human-readable surface into an anonymous one. That is the whole reason
//     the approval long-poll could not simply reuse requireServiceAuth.
//
// ONE COMPARE, ONE PLACE. `routes/harness.ts` (`requireTraceAuth`) and
// `routes/assessment.ts` (`requireRunCompleteAuth`) each carried their own
// byte-identical copy of the compare below until 2026-09. All three were
// correct, which is precisely the argument for folding them: a timing-safe
// comparison written three times is one primitive with three chances to drift,
// and only one of the three was covered by
// `lib/__tests__/service-auth-guard.test.ts`. The specs above are now the
// canonical list — a new machine callback adds a `ServiceAuthSpec` here, never
// another compare. All five callbacks now go through this module; there is no
// second implementation of the comparison left in the tree, and a test pins
// that no route file reintroduces `timingSafeEqual`.
//
// Secrets are read live from process.env on every request (an env lookup is
// free next to the work the route does) and trimmed — an operator pasting from
// `aws secretsmanager get-secret-value --output text` picks up a trailing
// newline, which would otherwise turn a correct secret into a silent mismatch.
// The agent half of this contract is agents/_shared/callbacks.py, which trims
// for the same reason.

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface ServiceAuthSpec {
  /** Env var the shared secret is read from. */
  envVar: string;
  /** Header the caller presents it in (lower-case). */
  header: string;
}

export const APPROVALS_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'APPROVALS_REQUEST_SECRET',
  header: 'x-approvals-auth',
};

export const HARNESS_TRACE_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'HARNESS_TRACE_SECRET',
  header: 'x-harness-auth',
};

export const ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'ASSESSMENT_RUN_COMPLETE_SECRET',
  header: 'x-assessment-run-auth',
};

/**
 * The harness RUNNER's identity — `infra/scripts/harness.py`.
 *
 * WHY A SECOND HARNESS SECRET. `HARNESS_TRACE_SECRET` unlocks exactly one
 * write-only sink (`POST /harness/trace`) that agents also post to. The runner
 * needs something else: it creates a run row, registers a prompt version,
 * records results, patches the run to `done` and reads runs back — all of them
 * session-gated routes that a human portal user also uses. Handing the fleet's
 * trace secret those authorities would widen a credential that is deployed to
 * nine agent runtimes into one that can write the harness control plane; and
 * handing the runner an operator's *session cookie* is worse still — a signed
 * cookie carries a real person's grants (masquerade among them), expires under
 * `session_epoch` within 120s of any role switch, and cannot be rotated without
 * that person losing their session. A scoped machine credential is the honest
 * shape: it names the runner, not a person, and it opens only the routes it is
 * attached to.
 *
 * ALWAYS `serviceAuthOr`, NEVER `requireServiceAuth`. These routes are read and
 * written by humans in the portal, so they must keep their session + Cedar
 * gates for everyone who is not the runner — and with `HARNESS_RUNNER_SECRET`
 * unset they behave exactly as they did before this spec existed. That is what
 * makes wiring it a no-op until an operator mints the secret.
 */
export const HARNESS_RUNNER_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'HARNESS_RUNNER_SECRET',
  header: 'x-harness-runner-auth',
};

export const LAB_CALLBACK_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'LAB_CALLBACK_SECRET',
  header: 'x-lab-auth',
};

export const MOCK_CONTROL_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'MOCK_CONTROL_SECRET',
  header: 'x-mock-control-auth',
};

/** The configured secret, or '' when unset/blank. */
export function serviceSecret(spec: ServiceAuthSpec): string {
  return (process.env[spec.envVar] ?? '').trim();
}

/** True when a secret is configured for this callback. */
export function serviceAuthConfigured(spec: ServiceAuthSpec): boolean {
  return serviceSecret(spec) !== '';
}

/**
 * Does this request present the configured credential?
 *
 * False when no secret is configured — "no credential exists" is not the same
 * question as "is this route open", and conflating them is how a read gate
 * would accidentally open. Callers decide what an unconfigured secret means.
 */
export function hasServiceAuth(req: Request, spec: ServiceAuthSpec): boolean {
  const secret = serviceSecret(spec);
  if (!secret) return false;
  const raw = req.headers[spec.header];
  const presented = typeof raw === 'string' ? raw : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, so the length check is not
  // optional — it also leaks only the length, which the header already does.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Write-only machine endpoint: open when unconfigured, constant-time compare
 * when configured. 401 on mismatch.
 */
export function requireServiceAuth(
  spec: ServiceAuthSpec,
  /** Override the 401 body where a caller already had its own wording. */
  message = 'service authentication required',
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!serviceAuthConfigured(spec)) { next(); return; } // open when unconfigured
    if (hasServiceAuth(req, spec)) { next(); return; }
    res.status(401).json({ error: message });
  };
}

/**
 * Dual-caller endpoint: a valid service credential passes; everything else
 * runs `human` (e.g. requireTenant + requireAction) exactly as before.
 *
 * Never opens on an unset secret — see the module comment.
 */
export function serviceAuthOr(spec: ServiceAuthSpec, ...human: RequestHandler[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasServiceAuth(req, spec)) { next(); return; }
    runChain(human, req, res, next);
  };
}

/** Run an ordered list of Express handlers, stopping at the first that responds. */
function runChain(handlers: RequestHandler[], req: Request, res: Response, done: NextFunction): void {
  let i = 0;
  const step = (err?: unknown): void => {
    if (err) { done(err); return; }
    const handler = handlers[i++];
    if (!handler) { done(); return; }
    try {
      void handler(req, res, step as NextFunction);
    } catch (e) {
      done(e);
    }
  };
  step();
}
