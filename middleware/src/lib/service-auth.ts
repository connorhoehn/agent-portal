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
export function requireServiceAuth(spec: ServiceAuthSpec): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!serviceAuthConfigured(spec)) { next(); return; } // open when unconfigured
    if (hasServiceAuth(req, spec)) { next(); return; }
    res.status(401).json({ error: 'service authentication required' });
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
