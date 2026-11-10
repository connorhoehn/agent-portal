// lib/service-auth.ts — the two guard shapes for sessionless machine callers.
//
// The distinction these tests exist to pin: `requireServiceAuth` is OPEN when
// its secret is unset in development, but fails closed in production,
// while `serviceAuthOr` is NEVER open — an unset secret leaves the human gate
// running exactly as before. Getting that backwards on GET /approvals/:id would
// have turned a Cedar-gated read into an anonymous one, which is the failure
// mode the whole guard was written to avoid.

import express from 'express';
import request from 'supertest';
import {
  requireServiceAuth,
  serviceAuthOr,
  hasServiceAuth,
  serviceAuthConfigured,
  type ServiceAuthSpec,
} from '../service-auth.js';

const SPEC: ServiceAuthSpec = { envVar: 'TEST_CALLBACK_SECRET', header: 'x-test-auth' };

// Stands in for requireTenant/requireAction: refuses anyone without a session
// header, so "did the human gate run?" is observable as a 401 vs 200.
const humanGate: express.RequestHandler = (req, res, next) => {
  if (req.headers['x-fake-session'] === 'yes') { next(); return; }
  res.status(401).json({ error: 'Unauthenticated' });
};

function appWith(handler: express.RequestHandler) {
  const app = express();
  app.get('/thing', handler, (_req, res) => { res.json({ ok: true }); });
  return app;
}

afterEach(() => { delete process.env[SPEC.envVar]; });

describe('requireServiceAuth — write-only machine callback', () => {
  it.each([undefined, '', '   '])('fails closed in production with secret=%s', async (secret) => {
    const priorEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    if (secret === undefined) delete process.env[SPEC.envVar];
    else process.env[SPEC.envVar] = secret;
    try {
      const res = await request(appWith(requireServiceAuth(SPEC))).get('/thing').set(SPEC.header, 'anything');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'service authentication is not configured' });
    } finally {
      if (priorEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = priorEnv;
    }
  });

  it('is open when the secret is unset (the dev default)', async () => {
    const res = await request(appWith(requireServiceAuth(SPEC))).get('/thing');
    expect(res.status).toBe(200);
  });

  it('401s a missing or wrong header once the secret is set', async () => {
    process.env[SPEC.envVar] = 'sesame';
    const app = appWith(requireServiceAuth(SPEC));
    expect((await request(app).get('/thing')).status).toBe(401);
    expect((await request(app).get('/thing').set(SPEC.header, 'nope')).status).toBe(401);
    // A prefix must not pass — the length check is part of the compare.
    expect((await request(app).get('/thing').set(SPEC.header, 'sesam')).status).toBe(401);
  });

  it('passes the matching header', async () => {
    process.env[SPEC.envVar] = 'sesame';
    const res = await request(appWith(requireServiceAuth(SPEC))).get('/thing').set(SPEC.header, 'sesame');
    expect(res.status).toBe(200);
  });
});

describe('serviceAuthOr — dual-caller endpoint', () => {
  it('with the secret UNSET, the human gate still runs (nothing is opened)', async () => {
    const app = appWith(serviceAuthOr(SPEC, humanGate));
    // Anonymous — exactly what it was before the guard existed.
    expect((await request(app).get('/thing')).status).toBe(401);
    // And a header cannot conjure authority out of an unconfigured secret.
    expect((await request(app).get('/thing').set(SPEC.header, 'anything')).status).toBe(401);
    expect((await request(app).get('/thing').set(SPEC.header, '')).status).toBe(401);
    // The human path is untouched.
    expect((await request(app).get('/thing').set('x-fake-session', 'yes')).status).toBe(200);
  });

  it('with the secret SET, the machine passes and everyone else still meets the human gate', async () => {
    process.env[SPEC.envVar] = 'sesame';
    const app = appWith(serviceAuthOr(SPEC, humanGate));
    expect((await request(app).get('/thing').set(SPEC.header, 'sesame')).status).toBe(200);
    expect((await request(app).get('/thing')).status).toBe(401);
    expect((await request(app).get('/thing').set(SPEC.header, 'wrong')).status).toBe(401);
    // A wrong credential is not a lockout for a real human session.
    expect((await request(app).get('/thing').set(SPEC.header, 'wrong').set('x-fake-session', 'yes')).status).toBe(200);
  });

  it('runs the human chain in order and stops at the first responder', async () => {
    const order: string[] = [];
    const first: express.RequestHandler = (_req, res) => { order.push('first'); res.status(403).end(); };
    const second: express.RequestHandler = (_req, _res, next) => { order.push('second'); next(); };
    const res = await request(appWith(serviceAuthOr(SPEC, first, second))).get('/thing');
    expect(res.status).toBe(403);
    expect(order).toEqual(['first']);
  });
});

describe('secret hygiene', () => {
  it('a blank or whitespace-only value counts as unset', () => {
    process.env[SPEC.envVar] = '   ';
    expect(serviceAuthConfigured(SPEC)).toBe(false);
  });

  it('trims the secret so a pasted trailing newline still matches', async () => {
    process.env[SPEC.envVar] = 'sesame\n';
    const req = { headers: { [SPEC.header]: 'sesame' } } as unknown as express.Request;
    await expect(hasServiceAuth(req, SPEC)).resolves.toBe(true);
  });

  it('hasServiceAuth is false when nothing is configured, header or not', async () => {
    const req = { headers: { [SPEC.header]: 'sesame' } } as unknown as express.Request;
    await expect(hasServiceAuth(req, SPEC)).resolves.toBe(false);
  });
});
