// The context-filtered façades over the pipelines run projection
// (docs/pipelines-tenant-goal.md §"The vertical slice" and §E, both decided
// there): `/api/runs` under requireTenant('orgiq') serves only runs whose
// context.tenant is 'orgiq'; `/api/assessment/pipeline-runs` serves only the
// assessment tenant's. A session parked in the assessment or pipelines tenant
// is refused at the orgiq mount (403); an orgiq session is refused at the
// assessment router. A run of the other tenant is a 404 through a façade —
// the façade confirms nothing about ids it does not serve.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['ViewOrgChart'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['ViewOrgChart', 'ManageBots', 'DispatchAgentRun'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'Program owner', summary: '', capabilities: ['ViewOrgChart'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] },
    { id: 'operator', tenant: 'pipelines', label: 'Operator', summary: '', capabilities: ['ViewPipelines'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { runsFacadeRouter } from '../runs.js';
import { assessmentRouter } from '../assessment.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  // The same mounts index.ts uses.
  app.use('/api/runs', requireTenant('orgiq'), runsFacadeRouter);
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

const as = (role: Role, tenant: Tenant, sub: string) => ({ role, tenant, sub });
const mia = as('program-owner', 'orgiq', 'u-mia');
const nora = as('sme', 'orgiq', 'u-nora');

type RunWire = { id: string; context: { tenant: string; table: string; trigger?: string; botId?: string } };

describe('GET /api/runs — the orgiq façade', () => {
  it('serves only runs whose context.tenant is orgiq', async () => {
    const res = await request(appAs(mia)).get('/api/runs?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBeGreaterThan(0);
    for (const r of res.body.runs as RunWire[]) expect(r.context.tenant).toBe('orgiq');
    // Asking for the other tenant through the query changes nothing — the scope wins.
    const forced = await request(appAs(mia)).get('/api/runs?contextTenant=assessment&limit=200');
    for (const r of forced.body.runs as RunWire[]) expect(r.context.tenant).toBe('orgiq');
  });

  it('filters by bot — what the bot detail page reads', async () => {
    const all = await request(appAs(nora)).get('/api/runs?kind=bot&limit=200');
    const botId = (all.body.runs as RunWire[]).find((r) => r.context.trigger === 'cron')!.context.botId!;
    const res = await request(appAs(nora)).get(`/api/runs?botId=${botId}`);
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBeGreaterThan(0);
    for (const r of res.body.runs as RunWire[]) expect(r.context.botId).toBe(botId);
  });

  it('GET /api/runs/:id, /steps and /events serve an orgiq run', async () => {
    const all = await request(appAs(nora)).get('/api/runs?kind=bot&limit=200');
    const run = (all.body.runs as RunWire[]).find((r) => r.context.table === 'agent_jobs')!;
    const one = await request(appAs(nora)).get(`/api/runs/${encodeURIComponent(run.id)}`);
    expect(one.status).toBe(200);
    expect(one.body.run.context.tenant).toBe('orgiq');
    const steps = await request(appAs(nora)).get(`/api/runs/${encodeURIComponent(run.id)}/steps`);
    expect(steps.body.steps.length).toBeGreaterThanOrEqual(3);
    const events = await request(appAs(nora)).get(`/api/runs/${encodeURIComponent(run.id)}/events`)
      .buffer(true)
      .parse((res, cb) => {
        let buf = '';
        let done = false;
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          if (!done && buf.includes('pipeline:run:')) { done = true; cb(null, buf); (res as unknown as { destroy: () => void }).destroy(); }
        });
      });
    expect(events.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(String(events.body)).toContain('pipeline:run:started');
  });

  it('a run of another context tenant is a 404 through the orgiq façade', async () => {
    // Find an assessment-context run id the honest way — through the assessment façade as admin.
    const admin = appAs(as('admin', 'orgiq', 'u-operator'));
    const a = await request(admin).get('/api/assessment/pipeline-runs?limit=1');
    const id = (a.body.runs as RunWire[])[0]!.id;
    const res = await request(admin).get(`/api/runs/${encodeURIComponent(id)}`);
    expect(res.status).toBe(404);
  });

  it('refuses assessment and pipelines roles at the mount, and a member at the read gate (403)', async () => {
    for (const s of [as('assessor', 'assessment', 'u-asha'), as('operator', 'pipelines', 'u-kofi'), as('member', 'orgiq', 'u-theo')]) {
      for (const path of ['/api/runs', '/api/runs/job:x', '/api/runs/job:x/steps', '/api/runs/job:x/events']) {
        const res = await request(appAs(s)).get(path);
        expect({ who: s.role, path, status: res.status }).toEqual({ who: s.role, path, status: 403 });
      }
    }
  });
});

describe('GET /api/assessment/pipeline-runs — the assessment read', () => {
  it('serves only runs whose context.tenant is assessment', async () => {
    const res = await request(appAs(as('assessor', 'assessment', 'u-asha'))).get('/api/assessment/pipeline-runs?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBeGreaterThan(0);
    for (const r of res.body.runs as RunWire[]) {
      expect(r.context.tenant).toBe('assessment');
      expect(r.context.table).toBe('assessment_runs');
    }
  });

  it('counts only its own tenant\'s unlinked agent traces — never the orgiq fleet\'s (context tenant scoping, lane E)', async () => {
    const { loadProjection } = await import('../../providers/pipeline-runs.js');
    const p = await loadProjection();
    const res = await request(appAs(as('assessor', 'assessment', 'u-asha'))).get('/api/assessment/pipeline-runs?limit=5');
    expect(res.body.unlinked).toEqual({ invocation_traces: p.unlinkedByTenant.assessment ?? 0 });
    const orgiq = await request(appAs(nora)).get('/api/runs?limit=5');
    expect(orgiq.body.unlinked).toEqual({ invocation_traces: p.unlinkedByTenant.orgiq ?? 0 });
    // Split, not invented: the per-tenant counts add up to the whole.
    expect((p.unlinkedByTenant.orgiq ?? 0) + (p.unlinkedByTenant.assessment ?? 0)).toBe(p.unlinked.invocation_traces);
  });

  it('refuses an orgiq or pipelines session (403)', async () => {
    for (const s of [mia, as('operator', 'pipelines', 'u-kofi')]) {
      const res = await request(appAs(s)).get('/api/assessment/pipeline-runs');
      expect(res.status).toBe(403);
    }
  });
});
