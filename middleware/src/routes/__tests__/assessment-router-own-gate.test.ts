// The tenant gate now lives INSIDE assessmentRouter (so the sessionless
// POST /runs/:id/complete agent callback can be exempted), not at the
// index.ts mount. assessment-tenant-gate.test.ts wraps the router in its own
// requireTenant, so it would stay green even if the router lost its gate —
// this mounts the router bare and proves the gate is the router's own.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['ViewGraph'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';

function bareApp(session: Partial<Session> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (session) req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use('/api/assessment', assessmentRouter);   // no requireTenant here on purpose
  app.use(errorHandler);
  return app;
}

describe('assessmentRouter carries its own tenant gate', () => {
  it('an orgiq sme is refused on the bare router; an assessor passes', async () => {
    const sme = bareApp({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' });
    for (const p of ['/api/assessment/teams', '/api/assessment/runs', '/api/assessment/knowledge/tree', '/api/assessment/events']) {
      const res = await request(sme).get(p);
      expect({ p, status: res.status }).toEqual({ p, status: 403 });
    }
    expect((await request(bareApp({ role: 'assessor', tenant: 'assessment', sub: 'u-asha' })).get('/api/assessment/teams')).status).toBe(200);
  });

  it('the run-complete callback is the only sessionless path, and it never leaks tenant data', async () => {
    const anon = bareApp(null);
    // No session at all: the gate refuses (401 or 403 depending on the
    // resolver), never 200.
    expect([401, 403]).toContain((await request(anon).get('/api/assessment/teams')).status);
    const cb = await request(anon).post('/api/assessment/runs/run-does-not-exist/complete').send({ status: 'failed' });
    expect([404, 401]).toContain(cb.status);
  });
});
