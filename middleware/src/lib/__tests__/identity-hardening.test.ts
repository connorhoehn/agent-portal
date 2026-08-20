// Hardening tests: Cedar statement parsing, tenant guards, production
// demo-mode lockdown, and the session rate limiter.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import type { Request, Response } from 'express';
import { splitStatements } from '../cedar-parse.js';
import { requireTenant } from '../authz.js';
import { demoSession, permissiveGrants } from '../session.js';
import { rateLimit, resetRateLimits } from '../rate-limit.js';

describe('splitStatements', () => {
  it('splits permit + forbid with simple when clauses', () => {
    const cedar = `
      // a comment
      permit (principal, action in [OrgIQ::Action::"Search"], resource)
      when { principal.role == "member" };
      forbid (principal, action == OrgIQ::Action::"ApproveTransaction", resource)
      when { principal.role == "member" };
    `;
    const out = splitStatements(cedar);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^permit/);
    expect(out[1]).toMatch(/^forbid/);
    expect(out[0]!.endsWith(';')).toBe(true);
  });

  it('handles nested braces inside a when clause', () => {
    const cedar = `
      permit (principal, action, resource)
      when { principal.tags.contains({ "team": "sre" }) && principal.role == "admin" };
    `;
    const out = splitStatements(cedar);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('{ "team": "sre" }');
    expect(out[0]).toContain('principal.role == "admin"');
  });

  it('handles multiple when/unless clauses on one statement', () => {
    const cedar = `
      permit (principal, action, resource)
      when { principal.role == "editor" }
      unless { resource.sealed == true };
    `;
    const out = splitStatements(cedar);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('unless');
  });

  it('parses an unconstrained-action admin policy', () => {
    const out = splitStatements('permit (principal, action, resource) when { principal.role == "admin" };');
    expect(out).toHaveLength(1);
  });
});

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('requireTenant', () => {
  const mk = (tenant: string, role: string) => ({
    session: { sub: 'u', role, tenant, grants: {}, iat: 0 },
    path: '/x',
  }) as unknown as Request;

  it('passes matching tenant, rejects mismatched tenant', () => {
    const guard = requireTenant('newsroom');
    const next = jest.fn();
    guard(mk('newsroom', 'reporter'), fakeRes(), next);
    expect(next).toHaveBeenCalled();

    const res = fakeRes();
    const next2 = jest.fn();
    guard(mk('orgiq', 'member'), res, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('lets the cross-tenant admin through any guard', () => {
    const next = jest.fn();
    requireTenant('newsroom')(mk('orgiq', 'admin'), fakeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('production demo-mode lockdown', () => {
  const prevEnv = process.env['NODE_ENV'];
  const prevFlag = process.env['AUTH_DEMO_MODE'];
  afterEach(() => {
    if (prevEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = prevEnv;
    if (prevFlag === undefined) delete process.env['AUTH_DEMO_MODE']; else process.env['AUTH_DEMO_MODE'] = prevFlag;
  });

  it('grants everything outside production', () => {
    process.env['NODE_ENV'] = 'test';
    expect(demoSession().grants).toEqual(permissiveGrants());
  });

  it('grants nothing in production without the opt-in flag', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['AUTH_DEMO_MODE'];
    expect(demoSession().grants).toEqual({});
  });

  it('honors AUTH_DEMO_MODE=true in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['AUTH_DEMO_MODE'] = 'true';
    expect(demoSession().grants).toEqual(permissiveGrants());
  });
});

describe('rateLimit', () => {
  beforeEach(() => resetRateLimits());

  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as Request;

  it('allows up to max then 429s with Retry-After', () => {
    const limiter = rateLimit('test', 3, 60_000);
    const next = jest.fn();
    for (let i = 0; i < 3; i++) limiter(req, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);

    const res = fakeRes();
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(429);
    expect((res as unknown as { headers: Record<string, unknown> }).headers['Retry-After']).toBeDefined();
  });

  it('buckets by client, not globally', () => {
    const limiter = rateLimit('test2', 1, 60_000);
    const other = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } } as unknown as Request;
    const next = jest.fn();
    limiter(req, fakeRes(), next);
    limiter(other, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
