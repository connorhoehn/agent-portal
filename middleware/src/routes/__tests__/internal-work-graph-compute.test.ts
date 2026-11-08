jest.mock('../../work-graph/compute-capability-runtime.js', () => ({
  computeCapabilityConfigured: () => true,
  computeCapabilitySessions: {
    authorizeDisclosure: jest.fn(async () => ({ allowed: true, directAccess: true, capabilities: ['observe-terminal'] })),
    open: jest.fn(async () => ({ allowed: true, session: {
      sessionId: 'capability-session-1', capability: 'observe', expiresAt: '2026-09-21T12:05:00.000Z', active: true,
    } })),
    revalidate: jest.fn(async () => ({ allowed: true, session: {
      sessionId: 'capability-session-1', capability: 'observe', expiresAt: '2026-09-21T12:05:00.000Z', active: true,
    } })),
    use: jest.fn(async () => ({ allowed: true, result: { status: 'running' }, session: {
      sessionId: 'capability-session-1', capability: 'observe', expiresAt: '2026-09-21T12:05:00.000Z', active: true,
    } })),
    close: jest.fn(() => null),
    subscribe: jest.fn(() => () => {}),
    share: jest.fn(async () => undefined),
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signEnvelope, signServiceRequest } from '@connorhoehn/service-runtime';
import { captureRawBody } from '../../lib/service-auth.js';
import { WORK_GRAPH_COMPUTE_AUDIENCE, resetLegacyBodyOnlyWarnings } from '../../lib/internal-service-auth.js';
import { internalWorkGraphComputeRouter } from '../internal-work-graph-compute.js';
import { computeCapabilitySessions } from '../../work-graph/compute-capability-runtime.js';
import { getBox, _resetFleet } from '../../lib/devbox-fleet.js';

const SECRET = 'work-graph-compute-capability-test-secret';
const originalEnv = { ...process.env };

function app() {
  const value = express();
  // As index.ts mounts it: the raw bytes are kept for the request-bound MAC.
  value.use(express.json({ verify: captureRawBody }));
  value.use('/internal/work-graph/compute-capabilities', internalWorkGraphComputeRouter);
  return value;
}

function signed(body: object, serviceId = 'platform-api'): Record<string, string> {
  return { [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret: SECRET, serviceId }) };
}

function openBody() {
  return {
    requestId: 'request-1', organizationId: 'org-1', viewerId: 'person-1', personId: 'person-1',
    resource: { source: 'cloud-compute', resourceId: 'box:box-1' }, capability: 'observe',
    expiresAt: '2026-09-21T12:10:00.000Z',
  };
}

beforeEach(() => {
  process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] = SECRET;
  // platform-api, the only caller, still signs body-only (`signed` above), and
  // the transition flag must say so: unset refuses it (pinned below).
  process.env['SERVICE_AUTH_LEGACY_BODY_ONLY'] = 'accept';
  delete process.env['WORK_GRAPH_PLATFORM_SERVICE_ID'];
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('internal work graph compute capability router', () => {
  it('requires the platform HMAC over the exact open body', async () => {
    const body = openBody();
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/open').send(body)).status).toBe(401);
    const tampered = { ...body, personId: 'person-2' };
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/open').set(signed(body)).send(tampered)).status).toBe(401);
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/open').set(signed(body, 'untrusted-service')).send(body)).status).toBe(401);
  });

  it('accepts a platform-signed use request with an explicit non-escalating capability', async () => {
    const body = { requestId: 'request-2', sessionId: 'capability-session-1', capability: 'observe' };
    const res = await request(app()).post('/internal/work-graph/compute-capabilities/use').set(signed(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: true, result: { status: 'running' } });
  });

  it('makes a signed session-free disclosure decision without opening an attachment', async () => {
    const body = {
      requestId: 'request-3', organizationId: 'org-1', viewerId: 'person-1', personId: 'person-1',
      resource: { source: 'cloud-compute', resourceId: 'box:box-1' },
    };
    const res = await request(app()).post('/internal/work-graph/compute-capabilities/authorize').set(signed(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true, directAccess: true, capabilities: ['observe-terminal'] });
  });
});

describe('session lifecycle routes', () => {
  const sessions = jest.mocked(computeCapabilitySessions);

  it('revalidate answers the source decision and 403s a revoked session with its reason', async () => {
    const body = { requestId: 'request-r1', sessionId: 'capability-session-1' };
    const ok = await request(app()).post('/internal/work-graph/compute-capabilities/revalidate').set(signed(body)).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ allowed: true, session: { sessionId: 'capability-session-1', capability: 'observe', expiresAt: '2026-09-21T12:05:00.000Z', active: true } });
    expect(sessions.revalidate).toHaveBeenLastCalledWith('capability-session-1');

    sessions.revalidate.mockResolvedValueOnce({ allowed: false, reason: 'owner_lost' } as never);
    const denied = await request(app()).post('/internal/work-graph/compute-capabilities/revalidate').set(signed(body)).send(body);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ allowed: false, reason: 'owner_lost' });
  });

  it('revalidate rejects unsigned, extra-field and unconfigured requests before reaching the source', async () => {
    sessions.revalidate.mockClear();
    const body = { requestId: 'request-r2', sessionId: 'capability-session-1' };
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/revalidate').send(body)).status).toBe(401);
    const extra = { ...body, capability: 'control' };
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/revalidate').set(signed(extra)).send(extra)).status).toBe(400);
    delete process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'];
    delete process.env['SERVICE_AUTH_SECRET'];
    const unconfigured = await request(app()).post('/internal/work-graph/compute-capabilities/revalidate').set(signed(body)).send(body);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body).toEqual({ error: 'WORK_GRAPH_CAPABILITY_UNAVAILABLE' });
    expect(sessions.revalidate).not.toHaveBeenCalled();
  });

  it('close reports whether a session was actually closed, with the source end reason', async () => {
    const body = { requestId: 'request-c1', sessionId: 'capability-session-1' };
    sessions.close.mockReturnValueOnce({ sessionId: 'capability-session-1', endReason: 'closed', active: false } as never);
    const closed = await request(app()).post('/internal/work-graph/compute-capabilities/close').set(signed(body)).send(body);
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ closed: true, reason: 'closed' });
    expect(sessions.close).toHaveBeenLastCalledWith('capability-session-1');

    const again = { requestId: 'request-c2', sessionId: 'capability-session-1' };
    const unknown = await request(app()).post('/internal/work-graph/compute-capabilities/close').set(signed(again)).send(again);
    expect(unknown.body).toEqual({ closed: false });
  });

  it('close requires the platform signature over the exact body', async () => {
    sessions.close.mockClear();
    const body = { requestId: 'request-c3', sessionId: 'capability-session-1' };
    const tampered = { ...body, sessionId: 'capability-session-2' };
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/close').set(signed(body)).send(tampered)).status).toBe(401);
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/close').set(signed({ requestId: 'x' })).send({ requestId: 'x' })).status).toBe(400);
    expect(sessions.close).not.toHaveBeenCalled();
  });

  it('events streams ready, then a terminal disconnect when the source ends the session', async () => {
    const payload = { requestId: 'request-e1', sessionId: 'capability-session-1' };
    sessions.subscribe.mockImplementationOnce(((_id: string, cb: (s: { active: boolean; endReason?: string }) => void) => {
      setImmediate(() => cb({ active: false, endReason: 'expired' }));
      return () => {};
    }) as never);
    const res = await request(app()).get('/internal/work-graph/compute-capabilities/events/capability-session-1?requestId=request-e1').set(signed(payload));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"ready"');
    expect(res.text).toContain('"sessionId":"capability-session-1"');
    expect(res.text).toContain('"type":"disconnect","reason":"expired"');
    expect(res.text.indexOf('"ready"')).toBeLessThan(res.text.indexOf('"disconnect"'));
  });

  it('events disconnects immediately when the session no longer revalidates, and refuses an unsigned stream', async () => {
    const payload = { requestId: 'request-e2', sessionId: 'capability-session-1' };
    sessions.revalidate.mockResolvedValueOnce({ allowed: false, reason: 'deleted' } as never);
    sessions.subscribe.mockClear();
    const res = await request(app()).get('/internal/work-graph/compute-capabilities/events/capability-session-1?requestId=request-e2').set(signed(payload));
    expect(res.text).toContain('"type":"disconnect","reason":"deleted"');
    expect(res.text).not.toContain('"ready"');
    expect(sessions.subscribe).not.toHaveBeenCalled();
    expect((await request(app()).get('/internal/work-graph/compute-capabilities/events/capability-session-1?requestId=request-e2')).status).toBe(401);
    // The signature binds the query's requestId too.
    expect((await request(app()).get('/internal/work-graph/compute-capabilities/events/capability-session-1?requestId=request-other').set(signed(payload))).status).toBe(401);
  });
});

describe('fixture box registration (dev/test seam)', () => {
  const sessions = jest.mocked(computeCapabilitySessions);
  const body = { id: 'seed-box-1', ownerId: 'u-dara', label: 'Seed box', sharedWith: ['u-kofi'] };
  beforeEach(() => _resetFleet());

  it('registers a real fleet box under the aws-agentcore identity and shares it with named viewers', async () => {
    const res = await request(app()).post('/internal/work-graph/compute-capabilities/fixtures/register-box').set(signed(body, 'aws-agentcore')).send(body);
    expect(res.status).toBe(200);
    expect(res.body.box).toMatchObject({ id: 'seed-box-1', ownerId: 'u-dara', label: 'Seed box', sessionId: 'fixture-seed-box-1' });
    expect(getBox('seed-box-1')).toMatchObject({ ownerId: 'u-dara' });
    expect(sessions.share).toHaveBeenCalledWith({ source: 'cloud-compute', resourceId: 'box:seed-box-1' }, 'u-kofi');
  });

  it('refuses the platform identity, a missing signature and a malformed id without registering anything', async () => {
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/fixtures/register-box').set(signed(body)).send(body)).status).toBe(401);
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/fixtures/register-box').send(body)).status).toBe(401);
    const bad = { id: 'box:with-colon', ownerId: 'u-dara' };
    expect((await request(app()).post('/internal/work-graph/compute-capabilities/fixtures/register-box').set(signed(bad, 'aws-agentcore')).send(bad)).status).toBe(400);
    expect(getBox('seed-box-1')).toBeNull();
    expect(getBox('box:with-colon')).toBeNull();
  });

  it('does not exist in production', async () => {
    process.env['NODE_ENV'] = 'production';
    try {
      const res = await request(app()).post('/internal/work-graph/compute-capabilities/fixtures/register-box').set(signed(body, 'aws-agentcore')).send(body);
      expect(res.status).toBe(404);
      expect(getBox('seed-box-1')).toBeNull();
    } finally { process.env['NODE_ENV'] = 'test'; }
  });
});

describe('request-bound envelope (service-runtime 0.7.0)', () => {
  const BASE = '/internal/work-graph/compute-capabilities';
  const body = { requestId: 'request-9', sessionId: 'capability-session-1' };
  const signedFor = (path: string, b: object) => ({ [SERVICE_AUTH_HEADER]: signServiceRequest(
    { method: 'POST', target: `${BASE}${path}`, body: JSON.stringify(b) },
    { secret: SECRET, serviceId: 'platform-api', audience: WORK_GRAPH_COMPUTE_AUDIENCE },
  ) });
  const post = (path: string, headers: Record<string, string>, b: object) =>
    request(app()).post(`${BASE}${path}`).set(headers).set('Content-Type', 'application/json').send(JSON.stringify(b));
  afterEach(() => { delete process.env['SERVICE_AUTH_LEGACY_BODY_ONLY']; resetLegacyBodyOnlyWarnings(); });

  it('a captured envelope replayed against the sibling route with the same body shape is refused', async () => {
    const captured = signedFor('/revalidate', body);
    expect((await post('/revalidate', captured, body)).status).toBe(200);
    // /close takes the identical { requestId, sessionId } body: the old
    // body-only MAC let this replay through for 30 seconds.
    const replay = await post('/close', captured, body);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'SERVICE_AUTH_INVALID' });
    expect(computeCapabilitySessions.close).not.toHaveBeenCalled();
  });

  it('with SERVICE_AUTH_LEGACY_BODY_ONLY=refuse a body-only envelope is refused on every route', async () => {
    process.env['SERVICE_AUTH_LEGACY_BODY_ONLY'] = 'refuse';
    expect((await post('/revalidate', signed(body), body)).status).toBe(401);
    expect((await post('/close', signed(body), body)).status).toBe(401);
  });

  it('with SERVICE_AUTH_LEGACY_BODY_ONLY unset a body-only envelope is refused too (the default is refuse)', async () => {
    delete process.env['SERVICE_AUTH_LEGACY_BODY_ONLY'];
    expect((await post('/revalidate', signed(body), body)).status).toBe(401);
    expect((await post('/close', signed(body), body)).status).toBe(401);
  });
});
