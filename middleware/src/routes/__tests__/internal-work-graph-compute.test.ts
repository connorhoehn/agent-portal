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
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import { internalWorkGraphComputeRouter } from '../internal-work-graph-compute.js';

const SECRET = 'work-graph-compute-capability-test-secret';
const originalEnv = { ...process.env };

function app() {
  const value = express();
  value.use(express.json());
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
