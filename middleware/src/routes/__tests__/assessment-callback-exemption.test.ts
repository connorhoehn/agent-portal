// The tenant-gate exemption must match every path Express routes to the
// handler — no narrower.
//
// `assessmentRouter` applies requireTenant('assessment') to everything except
// the agent callback POST /runs/:runId/complete, which a deployed runtime hits
// with no session. The exemption is a regex, and Express matches routes with
// `strict: false, caseSensitive: false` — so a trailing slash and a different
// case both reach the handler. The original anchored, case-sensitive pattern
// refused them, and a sessionless caller got 403 "requiredTenant: assessment"
// with nothing in the message to explain why the same URL worked yesterday. A
// proxy that normalises trailing slashes is all it would have taken.
//
// This pins the pair: the exempt paths never see the tenant gate, and NO other
// path on the router is exempted by the widening.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';

// The pattern under test, read from the route module's own source so this test
// cannot drift into pinning a copy of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'routes', 'assessment.ts'), 'utf8');
const declared = /const RUN_COMPLETE_PATH = (\/.*\/[a-z]*);/.exec(src);
const RUN_COMPLETE_PATH: RegExp = eval(declared![1]!) as RegExp;

/** An Express app with the same defaults the real router has. */
function routerApp() {
  const app = express();
  const seen: string[] = [];
  app.post('/runs/:runId/complete', (req, res) => { seen.push(req.path); res.json({ ok: true }); });
  return { app, seen };
}

describe('the agent-callback tenant exemption', () => {
  it.each([
    '/runs/run-1/complete',
    '/runs/run-1/complete/',
    '/runs/run-1/COMPLETE',
    '/runs/RUN-1/Complete/',
  ])('exempts %s, which Express routes to the handler', async (path) => {
    // Express really does route it — otherwise the exemption would be moot.
    const { app } = routerApp();
    expect((await request(app).post(path)).status).toBe(200);
    // ...and the gate skips it.
    expect(RUN_COMPLETE_PATH.test(path)).toBe(true);
  });

  it.each([
    '/runs/run-1/completed',
    '/runs/run-1/complete/extra',
    '/runs/complete',
    '/teams/TEAM-001/scores/apply',
    '/runs',
  ])('does not exempt %s', (path) => {
    expect(RUN_COMPLETE_PATH.test(path)).toBe(false);
  });
});
