// /health answers before any auth (the load balancer checks it), so its
// diagnostics (profile, mocks, region, probe errors) go only to a loopback
// caller or a session from a signed cookie (never the demo fallback). Anyone else gets the verdict and the same
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

  it('a remote caller relayed by a proxy on this host gets the verdict only (the portal dev server, a sidecar)', () => {
    // The portal's dev server listens on every interface and proxies /api from
    // loopback, recording the real client (xfwd).
    for (const headers of [
      { 'x-forwarded-for': '::ffff:192.168.1.20' },
      { 'x-forwarded-for': '127.0.0.1, 192.168.1.20' },   // a forged loopback entry, then the hop's real one
      { 'x-real-ip': '10.0.0.9' },
      { forwarded: 'for="[2001:db8::7]";proto=http' },
      { forwarded: 'for=unknown' },
      { via: '1.1 sidecar' },                            // relayed, but no address recorded
    ]) {
      const out = call({ socket: { remoteAddress: '127.0.0.1' }, headers } as unknown as Partial<Request>);
      expect([JSON.stringify(headers), out.body]).toEqual([JSON.stringify(headers), { status: 'degraded', service: 'orgiq-middleware' }]);
    }
  });

  it('a local browser through the dev-server proxy still gets the diagnostics', () => {
    for (const headers of [{ 'x-forwarded-for': '::1' }, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }]) {
      expect(healthDetailAllowed({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers } as unknown as Request)).toBe(true);
    }
  });

  it('neither a forwarding header nor the Host header makes a remote socket loopback', () => {
    for (const headers of [{ 'x-forwarded-for': '127.0.0.1' }, { host: 'localhost:3001' }, { forwarded: 'for=127.0.0.1', host: '127.0.0.1' }]) {
      expect(healthDetailAllowed({ socket: { remoteAddress: '10.0.0.4' }, headers } as unknown as Request)).toBe(false);
    }
  });

  it('a signed-in session from a signed cookie gets the diagnostics (the portal shell reads them)', () => {
    const out = call(remote({ session: { sub: 'u-1' }, sessionSource: 'cookie' } as never));
    expect(out.body).toHaveProperty('mocks');
    expect(healthDetailAllowed(remote({ session: { sub: '' }, sessionSource: 'cookie' } as never) as Request)).toBe(false);
  });

  it('the demo fallback session (every cookie-less request under INSECURE_DEV_MODE) is not a signed-in caller', () => {
    expect(call(remote({ session: { sub: 'demo-user' }, sessionSource: 'demo' } as never)).body).toEqual({ status: 'degraded', service: 'orgiq-middleware' });
    // A session with no recorded source never counts either.
    expect(healthDetailAllowed(remote({ session: { sub: 'u-1' } } as never) as Request)).toBe(false);
  });
});
