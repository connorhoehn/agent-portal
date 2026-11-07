// Request-bound service auth for the HMAC-only internal routers
// (routes/internal-devbox.ts, routes/internal-work-graph-compute.ts).
//
// Both used to verify service-runtime's body-only `verifyEnvelope`: the MAC
// covered the JSON body and nothing else, so a captured header replayed for
// its 30 seconds against any sibling route that accepts the same body shape
// (docs/next-steps.md §8, "the internal work-graph envelope"). They now verify
// `verifyServiceRequest` (service-runtime 0.7.0): the MAC covers the method,
// the exact origin-form target (`req.originalUrl`, query included), the exact
// body bytes (kept by `captureRawBody` in lib/service-auth.ts, wired into
// express.json in index.ts) and an audience naming the router. A header
// signed for one route is refused on every other.
//
// Signers use `signServiceRequest` (or `createServiceRequestHeaders`) with
//   audience 'orgiq-middleware/internal-devbox'      for /internal/devbox/*
//   audience 'orgiq-middleware/work-graph-compute'   for /internal/work-graph/compute-capabilities/*
// and the same secret pair as before (WORK_GRAPH_SERVICE_AUTH_SECRET, else
// SERVICE_AUTH_SECRET).
//
// THE TRANSITION. platform-api, the only caller, still signs body-only. For
// one release the old envelope is still accepted while
// SERVICE_AUTH_LEGACY_BODY_ONLY is unset or `accept`, with a DEPRECATED warning
// once per service and router; set it to `refuse` once platform-api signs the
// request. It is removed with service-runtime 0.8.0, which drops the same
// allowance from its own gate.

import type { Request } from 'express';
import { SERVICE_AUTH_HEADER, verifyEnvelope, verifyServiceRequest } from '@connorhoehn/service-runtime';

export const INTERNAL_DEVBOX_AUDIENCE = 'orgiq-middleware/internal-devbox';
export const WORK_GRAPH_COMPUTE_AUDIENCE = 'orgiq-middleware/work-graph-compute';
export const LEGACY_BODY_ONLY_ENV = 'SERVICE_AUTH_LEGACY_BODY_ONLY';

/** The internal routers' lifetime and skew, unchanged from the body-only check. */
const TTL_SEC = 30;
const TOLERANCE_SEC = 5;

/** True while the body-only envelope is still accepted (the default for this release). */
export function legacyBodyOnlyAccepted(): boolean {
  return (process.env[LEGACY_BODY_ONLY_ENV] ?? '').trim().toLowerCase() !== 'refuse';
}

export type InternalAuthVerdict =
  | { ok: true; serviceId: string; binding: 'request' | 'legacy-body' }
  | { ok: false };

const warned = new Set<string>();

/**
 * Verify `req`'s X-Service-Auth header for one internal router. `legacyPayload`
 * is what the old body-only signer covered on this route (the body, or the
 * path params a GET signed); it is consulted only while the transition flag
 * accepts the old form.
 */
export function verifyInternalRequest(req: Request, opts: {
  secret: string;
  allowedServices: readonly string[];
  audience: string;
  legacyPayload: object;
}): InternalAuthVerdict {
  const header = req.header(SERVICE_AUTH_HEADER);
  if (!header || !opts.secret) return { ok: false };
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  try {
    const bound = verifyServiceRequest(
      header,
      { method: req.method, target: req.originalUrl, body: raw ? raw.toString('utf8') : '' },
      { secret: opts.secret, allowedServices: [...opts.allowedServices], audience: opts.audience, ttlSec: TTL_SEC, toleranceSec: TOLERANCE_SEC },
    );
    if (bound.ok) return { ok: true, serviceId: bound.serviceId, binding: 'request' };
  } catch {
    // A malformed header falls through to the legacy check, then refuses.
  }
  if (!legacyBodyOnlyAccepted()) return { ok: false };
  try {
    const legacy = verifyEnvelope(header, {
      secret: opts.secret, allowedServices: [...opts.allowedServices], payload: opts.legacyPayload,
      ttlSec: TTL_SEC, toleranceSec: TOLERANCE_SEC,
    });
    if (!legacy.ok) return { ok: false };
    const key = `${legacy.serviceId}|${opts.audience}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[service-auth] DEPRECATED: ${legacy.serviceId} sent a body-only envelope to ${opts.audience}; `
        + `sign the request (signServiceRequest, audience '${opts.audience}') — ${LEGACY_BODY_ONLY_ENV}=refuse ends this`);
    }
    return { ok: true, serviceId: legacy.serviceId, binding: 'legacy-body' };
  } catch {
    return { ok: false };
  }
}

/** Test hook: forget which deprecations were logged. */
export function resetLegacyBodyOnlyWarnings(): void {
  warned.clear();
}
