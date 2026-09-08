// The reverse of assessment-tenant-gate: an assessment session is refused at
// every requireTenant('orgiq') mount — the org graph, scores and work queue
// are a different product. The browser audit
// (docs/assessment-journeys/isolation/*-outbound.md) saw 403s on
// /api/graph/people, /api/scores/leaderboard and /api/work/queue; this pins
// the gate those mounts share.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  app.get('/api/graph/people', requireTenant('orgiq'), (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);
  return app;
}

const ASSESSMENT: Array<{ role: Role; tenant: Tenant; sub: string }> = [
  { role: 'assessor', tenant: 'assessment', sub: 'u-asha' },
  { role: 'lead-assessor', tenant: 'assessment', sub: 'u-jonas' },
  { role: 'program-lead', tenant: 'assessment', sub: 'u-farah' },
];

describe('assessment roles outbound — refused at the orgiq gate', () => {
  for (const s of ASSESSMENT) {
    it(`${s.role} gets 403 on an orgiq mount`, async () => {
      const app = appAs(s);
      const org = await request(app).get('/api/graph/people');
      expect(org.status).toBe(403);
      expect(org.body.requiredTenant).toBe('orgiq');
    });
  }

  it('an orgiq session passes its own gate; admin passes it from the assessment tenant', async () => {
    expect((await request(appAs({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' })).get('/api/graph/people')).status).toBe(200);
    const admin = appAs({ role: 'admin', tenant: 'assessment', sub: 'u-operator' });
    expect((await request(admin).get('/api/graph/people')).status).toBe(200);
  });
});
