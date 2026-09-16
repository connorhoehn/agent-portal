// One offline store for `observability.approvals`, not two.
//
// `routes/approvals.ts` used to keep a bare `Map`, seeded with nothing and
// filled only by runtime POSTs, while On-Call's HITL rollup read the
// registered `approvalRequests` fixture. Same table, two offline
// representations of it, and they disagreed on screen: On-Call's card said
// "PENDING 1" while the Approvals queue two clicks away said "0 pending".
//
// The Map also broke the mock floor's rule that a write must mutate a
// REGISTERED fixture so `POST /api/__mock/reset` can undo it — the registry
// cannot see a bare Map, so approving something offline was permanent until
// the process restarted.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    // No cluster ARN → approvals.ts takes its offline branch, which is the
    // branch under test.
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: true },
    auth: { policyStoreId: undefined },
    cognito: {},
  },
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'org-leader', tenant: 'orgiq', label: 'Org Leader', summary: '',
      capabilities: ['ViewObservability', 'ApproveTransaction'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { approvalsRouter } from '../approvals.js';
import { approvalRequests } from '../../mock/observability.js';
import { mockOncallHitlSla } from '../../mock/observability-queries.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      sub: 'u-vera', name: 'Vera Green', role: 'org-leader', tenant: 'orgiq',
      grants: { orgiq: ['org-leader'] }, iat: 0,
    };
    next();
  });
  app.use('/api/observability/approvals', approvalsRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => { approvalRequests.reset(); });

describe('the approvals queue and the On-Call rollup read one source', () => {
  it('the queue lists the same rows the fixture holds', async () => {
    const res = await request(buildApp()).get('/api/observability/approvals');
    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(approvalRequests.rows().length);
    expect(res.body.approvals.length).toBeGreaterThan(0);
  });

  it('agrees with On-Call about how many are pending — the bug this fixes', async () => {
    const res = await request(buildApp()).get('/api/observability/approvals?status=PENDING');
    const rollup = mockOncallHitlSla(24)[0]!;
    expect(res.body.approvals.length).toBe(Number(rollup['pending_count']));
    // Load-bearing: a zero on both sides would satisfy the equality without
    // proving they read the same rows.
    expect(res.body.approvals.length).toBeGreaterThan(0);
  });

  it('carries the payload, which is the only thing a decider actually reads', async () => {
    const res = await request(buildApp()).get('/api/observability/approvals');
    // The SQL selects it and the drawer renders it, so the fixture standing in
    // for that table has to have it. Without it the offline queue could only
    // ever show a request with no substance.
    for (const a of res.body.approvals) expect(a.payload).toBeTruthy();
  });

  it('a decision made offline is undone by reset, because it lands in the fixture', async () => {
    const before = approvalRequests.rows().find((r) => r.status === 'PENDING')!;
    expect(before).toBeDefined();

    const decided = await request(buildApp())
      .post(`/api/observability/approvals/${before.approval_id}/decision`)
      .send({ decision: 'APPROVED', note: 'proceed' });
    expect([200, 201, 204]).toContain(decided.status);
    expect(approvalRequests.rows().find((r) => r.approval_id === before.approval_id)!.status)
      .toBe('APPROVED');

    approvalRequests.reset();
    // The whole point of the registry: reset means reset. Against the old bare
    // Map this row would still read APPROVED.
    expect(approvalRequests.rows().find((r) => r.approval_id === before.approval_id)!.status)
      .toBe('PENDING');
  });
});
