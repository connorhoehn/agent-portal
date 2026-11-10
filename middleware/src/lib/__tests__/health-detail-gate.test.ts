// /health answers before any auth (the load balancer checks it), so its
// diagnostics (profile, mocks, region, probe errors) go only to a loopback
// caller or a signed-in session. Anyone else gets the verdict and the same
// status code. A forwarding header never makes a request loopback.
import type { Request, Response } from 'express';
import { createHealthHandler, healthDetailAllowed } from '../health-handler.js';

function call(req: Partial<Request>, ready = true) {
  const handler = createHealthHandler({
    readRealtime: () => ({ ready }), readAws: () => ({ ok: true, checkedAt: Date.now() } as never),
    readDatastore: () => ({ ok: false, error: 'db host 10.0.0.5 refused', checkedAt: Date.now() } as never),
    mocks: { aurora: false }, region: 'us-east-1', profile: 'local-ephemeral', insecureDevMode: false,
  });
  const out: { code?: number; body?: Record<string, unknown> } = {};
  const res = {
    set: () => res, status: (c: number) => { out.code = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; },
  } as unknown as Response;
  handler(req as Request, res);
  return out;
}

const remote = (extra: Partial<Request> = {}) => ({
  socket: { remoteAddress: '10.1.2.3' }, headers: { 'x-forwarded-for': '127.0.0.1' }, ...extra,
}) as unknown as Partial<Request>;

describe('health detail gate', () => {
  it('a remote caller without a session gets the verdict only', () => {
    const out = call(remote());
    expect(out.code).toBe(200);
    expect(out.body).toEqual({ status: 'degraded', service: 'orgiq-middleware' });
  });

  it('keeps the status code a load balancer reads', () => {
    expect(call(remote(), false)).toEqual({ code: 503, body: { status: 'degraded', service: 'orgiq-middleware' } });
  });

  it('a loopback caller gets the diagnostics', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const out = call({ socket: { remoteAddress: addr } } as unknown as Partial<Request>);
      expect(out.body).toMatchObject({ mocks: { aurora: false }, region: 'us-east-1' });
      expect((out.body!['datastore'] as { error: string }).error).toContain('refused');
    }
  });

  it('a signed-in session gets the diagnostics (the portal shell reads them)', () => {
    const out = call(remote({ session: { sub: 'u-1' } } as never));
    expect(out.body).toHaveProperty('mocks');
    expect(healthDetailAllowed(remote({ session: { sub: '' } } as never) as Request)).toBe(false);
  });
});
