// The pipelines tenant's API gate (docs/pipelines-tenant-goal.md §Routes,
// docs/social-tenant-design.md §6): a session parked in orgiq, assessment or
// social is refused at requireTenant('pipelines') BEFORE any handler runs —
// 403 naming the tenant it would have needed. Every pipelines role reads the
// summary; the cross-tenant admin passes from any tenant.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'author', tenant: 'pipelines', label: 'Author', summary: '', capabilities: ['ViewPipelines', 'AuthorDefinition', 'RunPipeline'] },
    { id: 'operator', tenant: 'pipelines', label: 'Operator', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun'] },
    { id: 'pipeline-admin', tenant: 'pipelines', label: 'Pipeline Admin', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun', 'ManagePipelineConfig', 'ManageUsers'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { pipelinesRouter } from '../pipelines.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';
import { pipelinesSurfaces } from '../../mock/pipelines.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  // The same mount index.ts uses.
  app.use('/api/pipelines', requireTenant('pipelines'), pipelinesRouter);
  app.use(errorHandler);
  return app;
}

const OUTSIDE: Array<{ role: Role; tenant: Tenant; sub: string }> = [
  { role: 'member', tenant: 'orgiq', sub: 'u-theo' },
  { role: 'sme', tenant: 'orgiq', sub: 'u-nora' },
  { role: 'program-owner', tenant: 'orgiq', sub: 'u-mia' },
  { role: 'org-leader', tenant: 'orgiq', sub: 'u-vera' },
  { role: 'hr-admin', tenant: 'orgiq', sub: 'u-hr' },
  { role: 'assessor', tenant: 'assessment', sub: 'u-asha' },
  { role: 'lead-assessor', tenant: 'assessment', sub: 'u-jonas' },
  { role: 'program-lead', tenant: 'assessment', sub: 'u-farah' },
  { role: 'participant', tenant: 'social', sub: 'u-sana' },
  { role: 'moderator', tenant: 'social', sub: 'u-lena' },
  { role: 'community-admin', tenant: 'social', sub: 'u-mira' },
];

describe('requireTenant(pipelines) — outside roles', () => {
  for (const s of OUTSIDE) {
    it(`${s.tenant}/${s.role} gets 403 on /api/pipelines/summary`, async () => {
      const res = await request(appAs(s)).get('/api/pipelines/summary');
      expect(res.status).toBe(403);
      expect(res.body.requiredTenant).toBe('pipelines');
    });
  }
});

describe('GET /api/pipelines/summary', () => {
  afterEach(() => pipelinesSurfaces.reset());

  for (const role of ['author', 'operator', 'pipeline-admin'] as Role[]) {
    it(`pipelines/${role} reads the summary`, async () => {
      const res = await request(appAs({ role, tenant: 'pipelines', sub: 'u-kofi' })).get('/api/pipelines/summary');
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe('pipelines');
    });
  }

  it('admin passes the gate from any tenant', async () => {
    const res = await request(appAs({ role: 'admin', tenant: 'assessment', sub: 'u-operator' })).get('/api/pipelines/summary');
    expect(res.status).toBe(200);
  });

  it('counts members from grants and surfaces from the registered catalog', async () => {
    const res = await request(appAs({ role: 'operator', tenant: 'pipelines', sub: 'u-kofi' })).get('/api/pipelines/summary');
    const rows = pipelinesSurfaces.rows();
    expect(res.body.surfaces).toEqual({ total: rows.length, live: rows.filter((r) => r.live).length, pending: rows.filter((r) => !r.live).length });
    // One seeded user per role, plus the cross-tenant operator.
    expect(res.body.members.byRole).toEqual({ author: 1, operator: 1, 'pipeline-admin': 1, admin: 1 });
    expect(res.body.members.total).toBe(4);
  });

  it('the empty scenario reads zero surfaces', async () => {
    expect(pipelinesSurfaces.rows('empty')).toEqual([]);
  });
});

// ─── The run projection (docs/pipelines-tenant-goal.md §Routes) ─────────────

/** Read an SSE response until `until` appears, then hand back what arrived. */
function readStream(pending: ReturnType<ReturnType<typeof request>['get']>, until: RegExp) {
  return pending
    .buffer(true)
    .parse((res, cb) => {
      let buf = '';
      let done = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        if (!done && until.test(buf)) { done = true; cb(null, buf); (res as unknown as { destroy: () => void }).destroy(); }
      });
      res.on('end', () => { if (!done) { done = true; cb(null, buf); } });
    });
}

describe('GET /api/pipelines/runs*', () => {
  const kofi = { role: 'operator' as Role, tenant: 'pipelines' as Tenant, sub: 'u-kofi' };

  async function aBotJobRunId(): Promise<string> {
    const res = await request(appAs(kofi)).get('/api/pipelines/runs?kind=bot&limit=200');
    const run = (res.body.runs as Array<{ id: string; context: { table: string; trigger: string } }>)
      .find((r) => r.context.table === 'agent_jobs' && r.context.trigger === 'cron');
    expect(run).toBeDefined();
    return run!.id;
  }

  it('lists every tenant\'s runs with valid statuses, a pre-paging total, and filters', async () => {
    const res = await request(appAs(kofi)).get('/api/pipelines/runs?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    expect(res.body.total).toBeGreaterThan(5);
    const all = await request(appAs(kofi)).get('/api/pipelines/runs?limit=200');
    const tenants = new Set((all.body.runs as Array<{ context: { tenant: string } }>).map((r) => r.context.tenant));
    expect([...tenants].sort()).toEqual(['assessment', 'orgiq']);
    const onlyAssessment = await request(appAs(kofi)).get('/api/pipelines/runs?contextTenant=assessment&limit=200');
    expect(onlyAssessment.body.runs.length).toBeGreaterThan(0);
    for (const r of onlyAssessment.body.runs) expect(r.context.tenant).toBe('assessment');
    const failed = await request(appAs(kofi)).get('/api/pipelines/runs?status=failed&limit=200');
    for (const r of failed.body.runs) expect(r.status).toBe('failed');
  });

  it('GET /runs/:id returns the Run with its context and artifacts; an unknown id 404s', async () => {
    const id = await aBotJobRunId();
    const res = await request(appAs(kofi)).get(`/api/pipelines/runs/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(id);
    expect(res.body.run.context.sourceStatus).toBeDefined();
    expect(res.body.run.context.sources.some((s: { role: string }) => s.role === 'trigger')).toBe(true);
    expect(res.body.artifacts.length).toBeGreaterThan(0);
    const missing = await request(appAs(kofi)).get('/api/pipelines/runs/job:does-not-exist');
    expect(missing.status).toBe(404);
  });

  it('GET /runs/:id/steps returns at least three steps for a maintenance bot\'s run', async () => {
    const id = await aBotJobRunId();
    const res = await request(appAs(kofi)).get(`/api/pipelines/runs/${encodeURIComponent(id)}/steps`);
    expect(res.status).toBe(200);
    expect(res.body.steps.length).toBeGreaterThanOrEqual(3);
    expect(res.body.steps[0].stepId).toBe('trigger');
  });

  it('GET /runs/:id/events answers text/event-stream with event-catalog frames', async () => {
    const id = await aBotJobRunId();
    const pending = request(appAs(kofi)).get(`/api/pipelines/runs/${encodeURIComponent(id)}/events`);
    const res = await readStream(pending, /pipeline:run:completed/);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    const body = String(res.body);
    expect(body).toContain('"type":"pipeline:run:started"');
    expect(body).toContain('"type":"pipeline:step:completed"');
  });

  it('GET /artifacts lists the projection\'s artifacts, filterable by kind', async () => {
    const res = await request(appAs(kofi)).get('/api/pipelines/artifacts?kind=scores');
    expect(res.status).toBe(200);
    expect(res.body.artifacts.length).toBeGreaterThan(0);
    for (const a of res.body.artifacts) expect(a.kind).toBe('scores');
  });

  it('refuses every run route, the SSE door included, to an outside tenant\'s role (403)', async () => {
    for (const s of [
      { role: 'member' as Role, tenant: 'orgiq' as Tenant, sub: 'u-theo' },
      { role: 'assessor' as Role, tenant: 'assessment' as Tenant, sub: 'u-asha' },
      { role: 'participant' as Role, tenant: 'social' as Tenant, sub: 'u-sana' },
    ]) {
      for (const path of ['/api/pipelines/runs', '/api/pipelines/runs/job:x', '/api/pipelines/runs/job:x/steps', '/api/pipelines/runs/job:x/events', '/api/pipelines/artifacts']) {
        const res = await request(appAs(s)).get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
    }
  });
});
