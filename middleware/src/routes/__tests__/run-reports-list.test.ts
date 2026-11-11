// GET /api/run-reports (routes/run-reports.ts): one filtered page of run reports across executors,
// behind the same door as /api/runs (orgiq tenant, the bots read gate).
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['ViewOrgChart'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['ViewOrgChart', 'ManageBots'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'Program owner', summary: '', capabilities: ['ViewOrgChart'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { createRunReportsRouter } from '../run-reports.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { RowsRunReportStore, privateRunReportSources } from '../../lib/run-reports/store-rows.js';
import type { RunReport } from '../../lib/run-reports/types.js';
import type { Role, Session, Tenant } from '../../lib/session.js';

const report = (runRef: string, over: Partial<RunReport> = {}): RunReport => ({
  runRef, workItemId: 'wi-1', initiativeId: 'p-auth-migration', executor: 'fleet', model: null,
  startedAt: null, endedAt: '2026-11-10T10:00:00.000Z', outcome: 'done', failureCode: null, summary: 'did it',
  changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
  runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'billed' }, kept: [],
  selfReport: 'ok', briefId: null, createdAt: '2026-11-10T10:00:00.000Z', ...over,
});

async function appAs(who: { role: Role; tenant: Tenant; sub: string }) {
  const store = new RowsRunReportStore(privateRunReportSources());
  await store.putReport(report('a', { endedAt: '2026-11-10T09:00:00.000Z' }));
  await store.putReport(report('b', { executor: 'local', outcome: 'failed', endedAt: '2026-11-10T10:00:00.000Z' }));
  await store.putReport(report('c', { executor: 'mock', initiativeId: 'p-other', endedAt: '2026-11-10T11:00:00.000Z' }));
  const app = express();
  app.use((req, _res, next) => { req.session = { sub: who.sub, iat: 0, grants: {}, role: who.role, tenant: who.tenant } as Session; next(); });
  app.use('/api/run-reports', requireTenant('orgiq'), createRunReportsRouter({ reports: () => store }));
  app.use(errorHandler);
  return app;
}

const mia = { role: 'program-owner' as Role, tenant: 'orgiq' as Tenant, sub: 'u-mia' };

describe('GET /api/run-reports', () => {
  it('lists every executor newest first, and filters by executor, outcome, initiative', async () => {
    const app = await appAs(mia);
    const refs = async (q: string) => (await request(app).get(`/api/run-reports${q}`)).body.reports.map((r: RunReport) => r.runRef);
    expect(await refs('')).toEqual(['c', 'b', 'a']);
    expect(await refs('?executor=local')).toEqual(['b']);
    expect(await refs('?executor=fleet,mock')).toEqual(['c', 'a']);
    expect(await refs('?outcome=failed')).toEqual(['b']);
    expect(await refs('?initiative=p-other')).toEqual(['c']);
    expect(await refs('?debrief=none')).toEqual(['c', 'b', 'a']);
  });

  it('pages with a cursor', async () => {
    const app = await appAs(mia);
    const first = await request(app).get('/api/run-reports?limit=2');
    expect(first.body.reports.map((r: RunReport) => r.runRef)).toEqual(['c', 'b']);
    const rest = await request(app).get(`/api/run-reports?limit=2&cursor=${encodeURIComponent(first.body.next)}`);
    expect(rest.body.reports.map((r: RunReport) => r.runRef)).toEqual(['a']);
    expect(rest.body.next).toBeNull();
  });

  it('answers 400 for a filter value that is not one, never an empty list', async () => {
    const app = await appAs(mia);
    for (const q of ['executor=box', 'outcome=ok', 'debrief=maybe']) expect((await request(app).get(`/api/run-reports?${q}`)).status).toBe(400);
  });

  it('is the /api/runs door: ManageBots reads, a member and another tenant do not', async () => {
    expect((await request(await appAs({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' })).get('/api/run-reports')).status).toBe(200);
    expect((await request(await appAs({ role: 'member', tenant: 'orgiq', sub: 'u-theo' })).get('/api/run-reports')).status).toBe(403);
    expect((await request(await appAs({ role: 'assessor', tenant: 'assessment', sub: 'u-asha' })).get('/api/run-reports')).status).toBe(403);
  });
});
