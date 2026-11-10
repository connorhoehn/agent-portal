// Service auth for the middleware's SESSIONLESS MACHINE CALLBACKS.
//
// A handful of routes are called by deployed AgentCore runtimes and by the
// harness runner, none of which carry a session cookie. They cannot take the
// Cedar/session gates the rest of their routers take, so each instead carries
// a shared secret in a header, compared in constant time. The contract is
// deliberately *optional* so the middleware and the fleet can deploy in either
// order:
//
//   env var unset  → 503, unless INSECURE_DEV_MODE=true (then open: the laptop case)
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
//     surface reads. Open under INSECURE_DEV_MODE when the secret is unset,
//     503 otherwise (approvals /request, harness /trace, assessment /complete).
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
//
// SIGNED ENVELOPES (lane C4, 2026-10-14). A static header is a bearer token:
// anything that sees one request (an access log, a proxy, a debug dump) can
// replay it forever against any route that shares the secret. The four agent
// and devbox callbacks (approvals, harness trace, assessment run-complete, lab)
// now also accept service-runtime's signed request envelope, keyed by the SAME
// secret, so the rollout mints nothing new:
//
//   X-Service-Auth:  v1.<serviceId>.<unixTs>.<base64url HMAC-SHA256>
//                    over service-runtime's `service-http-v1` payload
//                    {protocol, audience, method, target, body}
//   x-service-nonce: 16–128 base64url chars, fresh per request
//
// `verifyServiceRequest` binds the MAC to the method, the exact origin-form
// target (`req.originalUrl`, query included), the exact UTF-8 body bytes (kept
// by `captureRawBody`, wired into express.json in index.ts) and an audience.
// The audience is `<spec audience>#<nonce>`, so the nonce is inside the MAC:
// changing it breaks the signature, and replaying it is refused by the
// single-use cache below. Timestamps outside 60 s (+10 s future skew) are
// refused by service-runtime itself; MAC compares are timing-safe there, and
// the legacy compare below stays timing-safe here.
//
// THE TRANSITION FLAG. The middleware accepts EITHER a valid envelope OR the
// legacy header only while `SERVICE_AUTH_LEGACY_HEADERS` says `accept` (or
// `allow`). Unset refuses (docs/fail-open-audit.md §2: transition flags default
// to refuse); the ECS task sets `refuse` and every signer is on the envelope.
// The agents read the same variable and stop sending the static header when it
// says `refuse`. An envelope that is present always decides on its own — a bad
// envelope is not rescued by a legacy header riding alongside it. Specs with no
// `signed` contract (harness runner, document policy, mock control) are
// unchanged and ignore the flag. An unset secret answers 503 unless
// INSECURE_DEV_MODE=true, and `serviceAuthOr` never opens.
//
// REPLAY SCOPE. The in-process nonce cache stops a replay to the same process.
// With SERVICE_AUTH_REPLAY_TABLE set, a nonce the process has not seen is also
// claimed with a conditional put into a shared DynamoDB-compatible table
// (lib/service-nonce-store.ts), so a captured request cannot be accepted again
// on another replica inside the 70 s window. Once that table is configured any
// store error refuses the request (fail closed); unset keeps the process-only
// cache, which is enough for the single replica the BFF runs as today.
//
// Ordered rollout: docs/agentcore-preview-surface.md §6a.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { SERVICE_AUTH_HEADER, verifyServiceRequest } from '@connorhoehn/service-runtime';
import { insecureDevMode } from './insecure-dev-mode.js';
import { sharedNonceStore, type NonceStore } from './service-nonce-store.js';

export interface SignedServiceAuth {
  /** Audience prefix the signer binds; the nonce is appended as `#<nonce>`. */
  audience: string;
  /** Envelope service ids allowed to call this route. */
  allowedServices: readonly string[];
}

export interface ServiceAuthSpec {
  /** Env var the shared secret is read from. */
  envVar: string;
  /** Header the caller presents it in (lower-case). */
  header: string;
  /** Signed-envelope contract (lane C4). Absent → the legacy header only. */
  signed?: SignedServiceAuth;
}

/** Envelope service id the Strands agents sign as (agents/_shared/callbacks.py). */
export const AGENT_SERVICE_ID = 'orgiq-agent';
/** Envelope service id the devbox `lab` CLI signs as (agents/devbox/lab). */
export const DEVBOX_SERVICE_ID = 'orgiq-devbox';
/** Per-request nonce header, bound into the signed audience. */
export const SERVICE_NONCE_HEADER = 'x-service-nonce';
/** The transition flag both the middleware and the signers read. */
export const LEGACY_HEADERS_ENV = 'SERVICE_AUTH_LEGACY_HEADERS';

/** Envelope lifetime and tolerated future skew — service-runtime's request defaults, spelled out. */
const ENVELOPE_TTL_SEC = 60;
const ENVELOPE_TOLERANCE_SEC = 10;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const DOCUMENT_POLICY_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'DOCUMENT_POLICY_SECRET',
  header: 'x-document-policy-key',
};

export const APPROVALS_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'APPROVALS_REQUEST_SECRET',
  header: 'x-approvals-auth',
  signed: { audience: 'orgiq-middleware/approvals', allowedServices: [AGENT_SERVICE_ID] },
};

export const HARNESS_TRACE_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'HARNESS_TRACE_SECRET',
  header: 'x-harness-auth',
  signed: { audience: 'orgiq-middleware/harness-trace', allowedServices: [AGENT_SERVICE_ID] },
};

export const ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH: ServiceAuthSpec = {
  envVar: 'ASSESSMENT_RUN_COMPLETE_SECRET',
  header: 'x-assessment-run-auth',
  signed: { audience: 'orgiq-middleware/assessment-run-complete', allowedServices: [AGENT_SERVICE_ID] },
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
  signed: { audience: 'orgiq-middleware/lab', allowedServices: [DEVBOX_SERVICE_ID] },
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

/** True only while the transition flag explicitly accepts the static header (`accept` / `allow`). */
export function legacyHeadersAccepted(): boolean {
  return ['accept', 'allow'].includes((process.env[LEGACY_HEADERS_ENV] ?? '').trim().toLowerCase());
}

type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };

/**
 * `express.json({ verify: captureRawBody })` — keep the exact body bytes for
 * requests that carry a signed envelope, so the MAC is checked against what
 * was sent rather than a re-serialisation of what was parsed. Requests without
 * the header keep nothing extra.
 */
export function captureRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  if (req.headers[SERVICE_AUTH_HEADER.toLowerCase()]) (req as RawBodyRequest).rawBody = buf;
}

/**
 * Single-use nonces: the in-process cache in front (a replay to the same
 * process never leaves it), then the shared store when one is configured.
 * One guard per process; tests build a second one to stand in for another
 * replica.
 */
export class ServiceNonceGuard {
  // `<serviceId>:<nonce>` → expiry (ms). Insertion order is expiry order
  // (fixed window), so sweeping from the front is enough.
  private readonly seen = new Map<string, number>();

  constructor(private readonly shared: () => NonceStore | null = () => sharedNonceStore()) {}

  /** 'ok' on first use; 'replayed' if spent here or on another replica; 'store-unavailable' when the shared store cannot decide. */
  async claim(key: string, nowMs: number): Promise<'ok' | 'replayed' | 'store-unavailable'> {
    for (const [k, exp] of this.seen) {
      if (exp > nowMs && this.seen.size < NONCE_CACHE_MAX) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return 'replayed';
    this.seen.set(key, nowMs + NONCE_WINDOW_MS);
    const store = this.shared();
    if (!store) return 'ok';
    try {
      return (await store.claim(key, nowMs, NONCE_WINDOW_MS)) ? 'ok' : 'replayed';
    } catch (e) {
      noteStoreError(e);
      return 'store-unavailable';
    }
  }

  reset(): void { this.seen.clear(); }
}

const NONCE_CACHE_MAX = 50_000;
const NONCE_WINDOW_MS = (ENVELOPE_TTL_SEC + ENVELOPE_TOLERANCE_SEC) * 1000;
const processNonces = new ServiceNonceGuard();

let lastStoreErrorLog = 0;
function noteStoreError(e: unknown): void {
  const now = Date.now();
  if (now - lastStoreErrorLog < 60_000) return;
  lastStoreErrorLog = now;
  console.error(`[service-auth] the shared replay store refused the write (${(e as Error)?.name ?? 'Error'}); `
    + 'signed requests are refused until it recovers');
}

/** Test hook — forget every nonce this process claimed. */
export function resetServiceNonceCache(): void {
  processNonces.reset();
}

export type EnvelopeVerdict =
  | { ok: true; serviceId: string }
  | { ok: false; reason: string };

/**
 * Verify the signed envelope on `req` for `spec` (lane C4). The caller has
 * already established that a secret is configured and the header is present.
 */
export async function verifySignedRequest(
  req: Request,
  spec: ServiceAuthSpec,
  secret: string,
  nonces: ServiceNonceGuard = processNonces,
): Promise<EnvelopeVerdict> {
  if (!spec.signed) return { ok: false, reason: 'unsigned-spec' };
  const header = req.headers[SERVICE_AUTH_HEADER.toLowerCase()];
  const nonce = req.headers[SERVICE_NONCE_HEADER];
  if (typeof header !== 'string') return { ok: false, reason: 'malformed' };
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'bad-nonce' };
  const raw = (req as unknown as RawBodyRequest).rawBody;
  let result;
  try {
    result = verifyServiceRequest(
      header,
      { method: req.method, target: req.originalUrl, body: raw ? raw.toString('utf8') : '' },
      {
        secret,
        allowedServices: [...spec.signed.allowedServices],
        audience: `${spec.signed.audience}#${nonce}`,
        ttlSec: ENVELOPE_TTL_SEC,
        toleranceSec: ENVELOPE_TOLERANCE_SEC,
      },
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  // After the MAC, never before: only a holder of the secret can spend a nonce.
  const claimed = await nonces.claim(`${result.serviceId}:${nonce}`, Date.now());
  if (claimed !== 'ok') return { ok: false, reason: claimed };
  return { ok: true, serviceId: result.serviceId };
}

/**
 * Does this request present the configured credential?
 *
 * False when no secret is configured — "no credential exists" is not the same
 * question as "is this route open", and conflating them is how a read gate
 * would accidentally open. Callers decide what an unconfigured secret means.
 *
 * A signed spec takes a valid envelope; a present envelope decides alone. The
 * static header passes only for unsigned specs or while the transition flag
 * accepts it.
 */
export async function hasServiceAuth(req: Request, spec: ServiceAuthSpec): Promise<boolean> {
  const secret = serviceSecret(spec);
  if (!secret) return false;
  if (spec.signed) {
    if (req.headers[SERVICE_AUTH_HEADER.toLowerCase()] !== undefined) {
      return (await verifySignedRequest(req, spec, secret)).ok;
    }
    if (!legacyHeadersAccepted()) return false;
  }
  const raw = req.headers[spec.header];
  const presented = typeof raw === 'string' ? raw : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, so the length check is not
  // optional — it also leaks only the length, which the header already does.
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok && spec.signed) noteLegacyAccepted(spec);
  return ok;
}

// Once per spec per process: the signal an operator reads before setting
// SERVICE_AUTH_LEGACY_HEADERS=refuse (§6a). Silence across a full traffic
// cycle means every caller of that route signs.
const legacyNoted = new Set<string>();
function noteLegacyAccepted(spec: ServiceAuthSpec): void {
  if (legacyNoted.has(spec.envVar)) return;
  legacyNoted.add(spec.envVar);
  console.warn(`[service-auth] accepted the static ${spec.header} header (${spec.envVar}); `
    + `this caller does not sign yet — ${LEGACY_HEADERS_ENV}=accept is what lets it through until it does (lane C4)`);
}

/**
 * Write-only machine endpoint: constant-time compare when configured, 401 on
 * mismatch. Unconfigured answers 503 in every environment (an unset NODE_ENV
 * included) except INSECURE_DEV_MODE, where it passes so a laptop needs no
 * secrets.
 */
export function requireServiceAuth(
  spec: ServiceAuthSpec,
  /** Override the 401 body where a caller already had its own wording. */
  message = 'service authentication required',
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!serviceAuthConfigured(spec)) {
      if (insecureDevMode()) { next(); return; }
      res.status(503).json({ error: 'service authentication is not configured' });
      return;
    }
    void hasServiceAuth(req, spec).then((ok) => {
      if (ok) { next(); return; }
      res.status(401).json({ error: message });
    }, next);
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
    void hasServiceAuth(req, spec).then((ok) => {
      if (ok) { next(); return; }
      runChain(human, req, res, next);
    }, next);
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
