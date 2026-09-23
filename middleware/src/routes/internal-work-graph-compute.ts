import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { computeCapabilityConfigured, computeCapabilitySessions } from '../work-graph/compute-capability-runtime.js';
import type { ComputeCapability, ComputeCapabilityResource } from '../work-graph/compute-capability-sessions.js';
import { registerBox } from '../lib/devbox-fleet.js';

export const internalWorkGraphComputeRouter = Router();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
// Narrower than ID above: matches the id shape resolveCloud() in
// work-graph/mapCloudCompute.ts actually accepts once a `box:`/`job:`
// prefix is stripped (no ':', '@' or '/').
const FIXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const requestCache = new Map<string, { expiresAt: number; fingerprint: string; body: unknown }>();

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function configuredSecret(): string {
  return (process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] ?? process.env['SERVICE_AUTH_SECRET'] ?? '').trim();
}

function signed(req: Request, res: Response, payload: object): boolean {
  const secret = configuredSecret();
  const header = req.header(SERVICE_AUTH_HEADER);
  if (!computeCapabilityConfigured() || !secret) {
    res.status(503).json({ error: 'WORK_GRAPH_CAPABILITY_UNAVAILABLE' });
    return false;
  }
  if (!header) {
    res.status(401).json({ error: 'SERVICE_AUTH_INVALID' });
    return false;
  }
  const result = verifyEnvelope(header, {
    secret,
    allowedServices: [process.env['WORK_GRAPH_PLATFORM_SERVICE_ID']?.trim() || 'platform-api'],
    payload,
    ttlSec: 30,
    toleranceSec: 5,
  });
  if (!result.ok) {
    res.status(401).json({ error: 'SERVICE_AUTH_INVALID' });
    return false;
  }
  return true;
}

function requestId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function resource(value: unknown): value is ComputeCapabilityResource {
  return record(value)
    && (value.source === 'cloud-compute' || value.source === 'local-compute')
    && typeof value.resourceId === 'string' && ID.test(value.resourceId);
}

function openBody(value: unknown): value is {
  requestId: string; organizationId: string; viewerId: string; personId: string;
  resource: ComputeCapabilityResource; capability: ComputeCapability; expiresAt: string;
} {
  return record(value)
    && Object.keys(value).every((key) => ['requestId', 'organizationId', 'viewerId', 'personId', 'resource', 'capability', 'expiresAt'].includes(key))
    && requestId(value.requestId) && typeof value.organizationId === 'string' && ID.test(value.organizationId)
    && typeof value.viewerId === 'string' && ID.test(value.viewerId)
    && typeof value.personId === 'string' && ID.test(value.personId)
    && resource(value.resource) && (value.capability === 'observe' || value.capability === 'control')
    && typeof value.expiresAt === 'string';
}

function authorizeBody(value: unknown): value is {
  requestId: string; organizationId: string; viewerId: string; personId: string; resource: ComputeCapabilityResource;
} {
  return record(value)
    && Object.keys(value).every((key) => ['requestId', 'organizationId', 'viewerId', 'personId', 'resource'].includes(key))
    && requestId(value.requestId) && typeof value.organizationId === 'string' && ID.test(value.organizationId)
    && typeof value.viewerId === 'string' && ID.test(value.viewerId)
    && typeof value.personId === 'string' && ID.test(value.personId) && resource(value.resource);
}

function sessionFields(value: unknown): value is { requestId: string; sessionId: string } {
  return record(value)
    && requestId(value.requestId) && typeof value.sessionId === 'string' && ID.test(value.sessionId);
}

function sessionBody(value: unknown): value is { requestId: string; sessionId: string } {
  return sessionFields(value) && Object.keys(value).every((key) => ['requestId', 'sessionId'].includes(key));
}

function useBody(value: unknown): value is { requestId: string; sessionId: string; capability: ComputeCapability } {
  const candidate = value as Record<string, unknown>;
  return sessionFields(value) && record(value)
    && Object.keys(value).every((key) => ['requestId', 'sessionId', 'capability'].includes(key))
    && (candidate['capability'] === 'observe' || candidate['capability'] === 'control');
}

function replyDecision(res: Response, decision: Awaited<ReturnType<typeof computeCapabilitySessions.revalidate>>): void {
  if (!decision.allowed) {
    res.status(403).json({ allowed: false, reason: decision.reason });
    return;
  }
  res.json({ allowed: true, session: {
    sessionId: decision.session.sessionId, capability: decision.session.capability,
    expiresAt: decision.session.expiresAt, active: decision.session.active,
  } });
}

internalWorkGraphComputeRouter.post('/open', asyncHandler(async (req, res) => {
  if (!openBody(req.body) || !signed(req, res, req.body)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
  const cached = requestCache.get(req.body.requestId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.fingerprint !== fingerprint) { res.status(409).json({ error: 'REQUEST_ID_REUSED' }); return; }
    res.status(200).json(cached.body);
    return;
  }
  // This is a bounded, in-memory transport replay guard. The session itself
  // remains source-revalidated; expired entries cannot grant anything.
  if (requestCache.size > 1_000) {
    const cutoff = Date.now();
    for (const [key, value] of requestCache) if (value.expiresAt <= cutoff) requestCache.delete(key);
  }
  const decision = await computeCapabilitySessions.open({
    organizationId: req.body.organizationId, viewerId: req.body.viewerId, personId: req.body.personId,
    resource: req.body.resource, capability: req.body.capability, requestedExpiresAt: req.body.expiresAt,
  });
  const body = decision.allowed
    ? { allowed: true, session: { sessionId: decision.session.sessionId, capability: decision.session.capability, expiresAt: decision.session.expiresAt, active: true } }
    : { allowed: false, reason: decision.reason };
  requestCache.set(req.body.requestId, { expiresAt: Date.now() + 60_000, fingerprint, body });
  res.status(decision.allowed ? 201 : 403).json(body);
}));

/**
 * Session-free durable source check for graph disclosure. A positive result
 * reports durable source capability availability plus whether this viewer is
 * the source owner. It never creates an attachment or turns availability into
 * collaboration access; platform enforces sharing and accepted controls.
 */
internalWorkGraphComputeRouter.post('/authorize', asyncHandler(async (req, res) => {
  if (!authorizeBody(req.body) || !signed(req, res, req.body)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  const decision = await computeCapabilitySessions.authorizeDisclosure({
    organizationId: req.body.organizationId, viewerId: req.body.viewerId,
    personId: req.body.personId, resource: req.body.resource,
  });
  if (!decision.allowed) {
    res.status(403).json({ allowed: false, reason: decision.reason, directAccess: false, capabilities: [] });
    return;
  }
  res.json(decision);
}));

internalWorkGraphComputeRouter.post('/revalidate', asyncHandler(async (req, res) => {
  if (!sessionBody(req.body) || !signed(req, res, req.body)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  replyDecision(res, await computeCapabilitySessions.revalidate(req.body.sessionId));
}));

internalWorkGraphComputeRouter.post('/use', asyncHandler(async (req, res) => {
  if (!useBody(req.body) || !signed(req, res, req.body)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  const result = await computeCapabilitySessions.use(req.body.sessionId, req.body.capability);
  if (!result.allowed) { res.status(403).json({ allowed: false, reason: result.reason }); return; }
  res.json({ allowed: true, result: result.result, session: { sessionId: result.session.sessionId, active: result.session.active, expiresAt: result.session.expiresAt } });
}));

internalWorkGraphComputeRouter.post('/close', asyncHandler(async (req, res) => {
  if (!sessionBody(req.body) || !signed(req, res, req.body)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  const session = await computeCapabilitySessions.close(req.body.sessionId);
  res.json({ closed: !!session, ...(session ? { reason: session.endReason } : {}) });
}));

/**
 * Source-owned disconnect stream. Platform/gateway can bridge this to an
 * already-open tail or control transport; a `disconnect` event is terminal and
 * ends the stream immediately when expiry, deletion, or owner loss happens.
 */
internalWorkGraphComputeRouter.get('/events/:sessionId', asyncHandler(async (req, res) => {
  const payload = { requestId: String(req.query['requestId'] ?? ''), sessionId: String(req.params['sessionId'] ?? '') };
  if (!sessionBody(payload) || !signed(req, res, payload)) {
    if (!res.headersSent) res.status(400).json({ error: 'INVALID_REQUEST' });
    return;
  }
  initSSE(res);
  const decision = await computeCapabilitySessions.revalidate(payload.sessionId);
  if (!decision.allowed) {
    writeSSE(res, { type: 'disconnect', reason: decision.reason });
    endSSE(res);
    return;
  }
  writeSSE(res, { type: 'ready', sessionId: payload.sessionId, expiresAt: decision.session.expiresAt });
  const unsubscribe = computeCapabilitySessions.subscribe(payload.sessionId, (session) => {
    if (session.active) return;
    writeSSE(res, { type: 'disconnect', reason: session.endReason ?? 'closed' });
    unsubscribe();
    endSSE(res);
  });
  req.on('close', () => { unsubscribe(); endSSE(res); });
}));

function fixtureBoxBody(value: unknown): value is {
  id: string; ownerId: string; sessionId?: string; label?: string; projectId?: string; sharedWith?: string[];
} {
  return record(value)
    && Object.keys(value).every((key) => ['id', 'ownerId', 'sessionId', 'label', 'projectId', 'sharedWith'].includes(key))
    && typeof value.id === 'string' && FIXTURE_ID.test(value.id)
    && typeof value.ownerId === 'string' && FIXTURE_ID.test(value.ownerId)
    && (value.sessionId === undefined || (typeof value.sessionId === 'string' && value.sessionId.length > 0))
    && (value.label === undefined || typeof value.label === 'string')
    && (value.projectId === undefined || (typeof value.projectId === 'string' && FIXTURE_ID.test(value.projectId)))
    && (value.sharedWith === undefined || (Array.isArray(value.sharedWith)
      && value.sharedWith.every((viewerId) => typeof viewerId === 'string' && FIXTURE_ID.test(viewerId))));
}

/**
 * Dev/test-only seam: registers a fleet box directly against the SAME
 * in-memory registry `resolveCloud()` reads (lib/devbox-fleet.ts), without
 * going through the portal's session/Cedar/Aurora stack.
 *
 * WHY THIS EXISTS. `/authorize` and `/open` above answer honestly from
 * durable source state — they were never the problem. The problem is that a
 * *local* seed script (no browser, no OrgIQ session, no Aurora) has no way to
 * put a real box into that state, so a seeded "cloud terminal" effort could
 * never clear disclosure locally and platform-api correctly, if unhelpfully,
 * withheld it. This route is that seam: same shape as
 * routes/test-fixtures.ts (idempotent, dev-only, no session), scoped to
 * exactly the one write a seed needs (a box row), and gated the same way the
 * source-owned callbacks above are — a signed service-auth envelope, not an
 * open door. It is never mounted in production and grants no capability by
 * itself; `/authorize`/`/open` still make their own decision from whatever
 * this seeds. `sharedWith` (optional) is the same idea one level up: it
 * names viewers as explicit, source-owned collaborators via
 * computeCapabilitySessions.share() (compute-capability-sessions.ts), the
 * durable-owner-authenticated seam that authorizeDisclosure() consults so a
 * genuinely shared viewer gets 'details' instead of every non-owner being
 * capped at 'summary'. Registered under the exact resourceId shape
 * platform-api sends (`box:<id>`) — see sourceOwnedResourceId in
 * platform-api's runtime.ts.
 */
internalWorkGraphComputeRouter.post('/fixtures/register-box', asyncHandler(async (req, res) => {
  if (process.env['NODE_ENV'] === 'production') { res.status(404).end(); return; }
  const secret = configuredSecret();
  const header = req.header(SERVICE_AUTH_HEADER);
  if (!secret || !header) { res.status(401).json({ error: 'SERVICE_AUTH_INVALID' }); return; }
  if (!fixtureBoxBody(req.body)) { res.status(400).json({ error: 'INVALID_REQUEST' }); return; }
  const result = verifyEnvelope(header, {
    secret,
    // Deliberately its own allowlist, not the platform's: this route is
    // aws-agentcore seeding its own state for itself, not platform-api
    // calling in, so it never claims the 'platform-api' service identity.
    allowedServices: [process.env['WORK_GRAPH_FIXTURE_SERVICE_ID']?.trim() || 'aws-agentcore'],
    payload: req.body,
    ttlSec: 30,
    toleranceSec: 5,
  });
  if (!result.ok) { res.status(401).json({ error: 'SERVICE_AUTH_INVALID' }); return; }
  const box = registerBox({
    id: req.body.id,
    sessionId: req.body.sessionId ?? `fixture-${req.body.id}`,
    ownerId: req.body.ownerId,
    ...(req.body.projectId ? { projectId: req.body.projectId } : {}),
    ...(req.body.label ? { label: req.body.label } : {}),
  });
  for (const viewerId of req.body.sharedWith ?? []) {
    await computeCapabilitySessions.share({ source: 'cloud-compute', resourceId: `box:${box.id}` }, viewerId);
  }
  res.status(200).json({ box });
}));
