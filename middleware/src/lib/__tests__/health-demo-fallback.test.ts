// /health and /api/health diagnostics under demo mode (second regression walk,
// 10 November): the INSECURE_DEV_MODE demo fallback gives every cookie-less
// request a session, so "any session" handed the profile, mocks, region and
// probe errors to anyone who could reach the port. Detail now goes only to a
// loopback peer (with the forwarded-client rule for the portal's dev proxy) or
// a session from a real signed cookie. These run the real session middleware
// in front of the handler, with forged forwarding headers sent direct to the
// middleware, with and without demo mode.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' } },
}));

import type { Request, Response } from 'express';
import { createHealthHandler } from '../health-handler.js';
import { sessionMiddleware, signSession } from '../session.js';

const VERDICT = { status: 'degraded', service: 'orgiq-middleware' };

async function health(req: { socket: { remoteAddress: string }; headers?: Record<string, string>; cookies?: Record<string, string> }) {
  const handler = createHealthHandler({
    readRealtime: () => ({ ready: true }), readAws: () => ({ ok: true, checkedAt: Date.now() } as never),
    readDatastore: () => ({ ok: false, error: 'db host 10.0.0.5 refused', checkedAt: Date.now() } as never),
    mocks: { aurora: true }, region: 'us-east-1', profile: 'local-ephemeral', insecureDevMode: true,
  });
  const out: { code?: number; body?: Record<string, unknown>; session?: string; source?: string } = {};
  const res = {
    set: () => res, status: (c: number) => { out.code = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; },
    cookie: jest.fn(), clearCookie: jest.fn(),
  } as unknown as Response;
  const r = { headers: {}, cookies: {}, ...req } as unknown as Request;
  await sessionMiddleware()(r, res, () => undefined);
  out.session = r.session?.sub; out.source = r.sessionSource;
  handler(r, res);
  return out;
}

const FORGED: Array<Record<string, string>> = [
  {}, // no header at all
  { 'x-forwarded-for': '127.0.0.1' },
  { 'x-real-ip': '127.0.0.1' },
  { 'x-forwarded-for': '::1', 'x-real-ip': '127.0.0.1' },
  { forwarded: 'for=127.0.0.1' },
];

describe('health detail under demo mode', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  for (const demo of [true, false]) {
    describe(demo ? 'INSECURE_DEV_MODE on (the demo fallback)' : 'demo mode off', () => {
      beforeEach(() => {
        if (demo) { process.env['INSECURE_DEV_MODE'] = 'true'; process.env['NODE_ENV'] = 'development'; }
        else delete process.env['INSECURE_DEV_MODE'];
      });

      it('a remote socket with a forged loopback forwarding header and no cookie gets the verdict only', async () => {
        for (const headers of FORGED) {
          const out = await health({ socket: { remoteAddress: '10.1.2.3' }, headers });
          // Under demo mode the fallback did give it a session: that session is not a signed-in caller.
          expect([headers, out.session ?? null, out.source ?? null]).toEqual([headers, demo ? 'demo-user' : null, demo ? 'demo' : null]);
          expect([headers, out.code, out.body]).toEqual([headers, 200, VERDICT]);
        }
      });

      it('a remote client relayed by the dev proxy on this host (loopback peer, real client recorded) gets the verdict only', async () => {
        for (const headers of [{ 'x-forwarded-for': '192.168.1.20' }, { 'x-real-ip': '10.0.0.9' }, { 'x-forwarded-for': '127.0.0.1, 192.168.1.20' }] as Array<Record<string, string>>) {
          const out = await health({ socket: { remoteAddress: '127.0.0.1' }, headers });
          expect([headers, out.body]).toEqual([headers, VERDICT]);
        }
      });

      it('a loopback caller still gets the diagnostics (the owner portal on a loopback bind)', async () => {
        for (const headers of [{}, { 'x-forwarded-for': '127.0.0.1' }] as Array<Record<string, string>>) {
          const out = await health({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers });
          expect(out.body).toMatchObject({ mocks: { aurora: true }, region: 'us-east-1' });
        }
      });

      it('a remote caller with a real signed cookie gets the diagnostics', async () => {
        const cookie = await signSession({
          sub: 'u-s', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: Math.floor(Date.now() / 1000),
        });
        const out = await health({ socket: { remoteAddress: '10.1.2.3' }, headers: { 'x-forwarded-for': '10.1.2.3' }, cookies: { 'orgiq.session': cookie } });
        expect([out.session, out.source]).toEqual(['u-s', 'cookie']);
        expect(out.body).toHaveProperty('mocks');
        expect((out.body!['datastore'] as { error: string }).error).toContain('refused');
      });
    });
  }
});
