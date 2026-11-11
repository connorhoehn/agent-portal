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

async function appAs(who: { role: Role; tenant: Tenant; sub: string }, extra: RunReport[] = []) {
  const store = new RowsRunReportStore(privateRunReportSources());
  await store.putReport(report('a', { endedAt: '2026-11-10T09:00:00.000Z' }));
  await store.putReport(report('b', { executor: 'local', outcome: 'failed', endedAt: '2026-11-10T10:00:00.000Z' }));
  await store.putReport(report('c', { executor: 'mock', initiativeId: 'p-other', endedAt: '2026-11-10T11:00:00.000Z' }));
  for (const row of extra) await store.putReport(row);
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

  it('filters by work item and by runbook', async () => {
    const app = await appAs(mia, [
      report('d', { workItemId: 'wi-9', runbooksOffered: [{ id: 'rb-x', version: 1 }], endedAt: '2026-11-10T12:00:00.000Z' }),
    ]);
    const refs = async (q: string) => (await request(app).get(`/api/run-reports${q}`)).body.reports.map((r: RunReport) => r.runRef);
    expect(await refs('?workItem=wi-9')).toEqual(['d']);
    expect(await refs('?runbook=rb-x')).toEqual(['d']);
    expect(await refs('?runbook=rb-x&workItem=wi-1')).toEqual([]);
  });

  it('filters to the run refs a bot page asks for, behind the same gate', async () => {
    const app = await appAs(mia);
    const refs = async (q: string) => (await request(app).get(`/api/run-reports${q}`)).body.reports.map((r: RunReport) => r.runRef);
    expect(await refs('?runRefs=a,c,missing')).toEqual(['c', 'a']);
    const member = await appAs({ role: 'member' as Role, tenant: 'orgiq' as Tenant, sub: 'u-m' });
    expect((await request(member).get('/api/run-reports?runRefs=a')).status).toBe(403);
  });

  it('pages with a cursor', async () => {
    const app = await appAs(mia);
    const first = await request(app).get('/api/run-reports?limit=2');
    expect(first.body.reports.map((r: RunReport) => r.runRef)).toEqual(['c', 'b']);
    const rest = await request(app).get(`/api/run-reports?limit=2&cursor=${encodeURIComponent(first.body.next)}`);
    expect(rest.body.reports.map((r: RunReport) => r.runRef)).toEqual(['a']);
    expect(rest.body.next).toBeNull();
  });

  it('keeps microVM reports distinct from bots and combines executor and outcome filters', async () => {
    const app = await appAs(mia, [
      report('vm-done', { executor: 'microvm', endedAt: '2026-11-10T12:00:00.000Z' }),
      report('vm-failed', { executor: 'microvm', outcome: 'failed', endedAt: '2026-11-10T13:00:00.000Z' }),
    ]);
    const refs = async (q: string) => {
      const res = await request(app).get(`/api/run-reports?${q}`);
      expect(res.status).toBe(200);
      return res.body.reports.map((r: RunReport) => r.runRef);
    };
    expect(await refs('executor=microvm')).toEqual(['vm-failed', 'vm-done']);
    expect(await refs('executor=microvm&outcome=done')).toEqual(['vm-done']);
    expect(await refs('executor=governed,mock')).toEqual(['c']);
    expect(await refs('executor=microvm&initiative=p-other')).toEqual([]);
  });

  it('searches text: every term, any case, across summary, obstacles, learned, failure code and run ref, and pages with the filter on', async () => {
    const extra = [
      report('csrf-1', { summary: 'Fixed the CSRF token check', endedAt: '2026-11-10T12:00:00.000Z' }),
      report('csrf-2', { obstacles: ['csrf cookie missing on login'], endedAt: '2026-11-10T13:00:00.000Z' }),
      report('csrf-3', { learned: 'Always rotate the Csrf secret', endedAt: '2026-11-10T14:00:00.000Z' }),
      report('f1', { failureCode: 'timeout-hit', summary: 'csrf only', endedAt: '2026-11-10T15:00:00.000Z' }),
    ];
    const app = await appAs(mia, extra);
    const get = async (q: string) => (await request(app).get(`/api/run-reports${q}`)).body;
    expect((await get('?q=CSRF')).reports.map((r: RunReport) => r.runRef)).toEqual(['f1', 'csrf-3', 'csrf-2', 'csrf-1']);
    expect((await get('?q=csrf%20TIMEOUT')).reports.map((r: RunReport) => r.runRef)).toEqual(['f1']);
    expect((await get('?q=csrf%20nomatch')).reports).toEqual([]);
    const p1 = await get('?q=csrf&limit=3');
    expect(p1.reports.map((r: RunReport) => r.runRef)).toEqual(['f1', 'csrf-3', 'csrf-2']);
    expect(p1.next).not.toBeNull();
    const p2 = await get(`?q=csrf&limit=3&cursor=${encodeURIComponent(p1.next)}`);
    expect(p2.reports.map((r: RunReport) => r.runRef)).toEqual(['csrf-1']);
    expect(p2.next).toBeNull();
    expect((await request(app).get(`/api/run-reports?q=${'x'.repeat(201)}`)).status).toBe(400);
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

describe('GET /api/run-reports/recurring-obstacles', () => {
  const recent = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  async function obstacleApp(who: { role: Role; tenant: Tenant; sub: string }) {
    const store = new RowsRunReportStore(privateRunReportSources());
    const wall = ['The CSRF check failed on the pull request.'];
    await store.putReport(report('o1', { workItemId: 'wi-1', outcome: 'failed', obstacles: wall, endedAt: recent(30) }));
    await store.putReport(report('o2', { workItemId: 'wi-2', obstacles: ['the csrf check failed on the pull request'], endedAt: recent(5) }));
    await store.putReport(report('o3', { workItemId: 'wi-3', initiativeId: 'p-other', obstacles: wall, endedAt: recent(4) }));
    await store.putReport(report('old1', { obstacles: ['Ancient wall.'], endedAt: '2020-01-01T00:00:00.000Z' }));
    await store.putReport(report('old2', { obstacles: ['Ancient wall.'], endedAt: '2020-01-02T00:00:00.000Z' }));
    const app = express();
    app.use((req, _res, next) => { req.session = { sub: who.sub, iat: 0, grants: {}, role: who.role, tenant: who.tenant } as Session; next(); });
    app.use('/api/run-reports', requireTenant('orgiq'), createRunReportsRouter({ reports: () => store, repoOf: async (id) => (id === 'p-auth-migration' ? 'org/auth' : null) }));
    app.use(errorHandler);
    return app;
  }

  it('groups what two different runs hit, inside the window, and filters by initiative and repository', async () => {
    const app = await obstacleApp(mia);
    const res = await request(app).get('/api/run-reports/recurring-obstacles');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.obstacles).toHaveLength(1);   // p-other has one run only; the 2020 pair is outside the window
    expect(res.body.obstacles[0]).toMatchObject({ runs: 2, workItems: 2, failedRuns: 1, runRefs: ['o2', 'o1'], scope: { kind: 'repo', ref: 'org/auth' } });
    expect((await request(app).get('/api/run-reports/recurring-obstacles?repo=auth')).body.obstacles).toHaveLength(1);
    expect((await request(app).get('/api/run-reports/recurring-obstacles?repo=billing')).body.obstacles).toEqual([]);
    expect((await request(app).get('/api/run-reports/recurring-obstacles?initiative=p-other')).body.obstacles).toEqual([]);
    expect((await request(app).get('/api/run-reports/recurring-obstacles?days=36500')).status).toBe(400);
  });

  it('has the list route’s gate: ManageBots reads, a member and another tenant do not', async () => {
    expect((await request(await obstacleApp({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' })).get('/api/run-reports/recurring-obstacles')).status).toBe(200);
    expect((await request(await obstacleApp({ role: 'member', tenant: 'orgiq', sub: 'u-theo' })).get('/api/run-reports/recurring-obstacles')).status).toBe(403);
    expect((await request(await obstacleApp({ role: 'assessor', tenant: 'assessment', sub: 'u-asha' })).get('/api/run-reports/recurring-obstacles')).status).toBe(403);
  });
});
