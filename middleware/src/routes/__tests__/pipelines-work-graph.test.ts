// /api/pipelines/work-graph (routes/pipelines-work-graph.ts) over the real
// mock fixtures — the pipelines counterpart of work-graph.test.ts.
//
// Pinned:
//   * honesty — every node is one row the /api/pipelines routes serve to the same viewer
//     (definitions, runs, steps, pending approvals, decks), under the library's day rule;
//   * the authz matrix, decided fresh per request: an author (ViewPipelines only) never
//     receives approval nodes; an operator (ApproveStep) does; another tenant 403, anonymous
//     401, a bumped epoch 401, a failed Cedar decision withholds and says so;
//   * the uniform 404 for a run that is absent.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/live-principal.js', () => ({ ...jest.requireActual('../../lib/live-principal.js'), authorizeConversationChat: jest.fn(async () => true) }));
jest.mock('../../lib/realtime-gateway.js', () => ({ channelGuard: {} }));
import express from 'express';
import request from '../../test-support/http.js';
import { pipelinesWorkGraphRouter } from '../pipelines-work-graph.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';
import { workDayWindow, validateWorkGraphSnapshotV2 } from '@connorhoehn/realtime-modules/work-graph';
import { clock, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { stopWorkGraphLiveHints } from '../../lib/work-graph/live.js';
import { loadProjection } from '../../providers/pipeline-runs.js';
import { listApprovals } from '../../providers/pipeline-definitions.js';
import { claimJob, enqueueJob, completeJob } from '../../providers/agent-jobs.js';
import { agentJobs } from '../../mock/agent-jobs.js';
import { intervalOverlapsWorkDay } from '../../lib/work-graph/day-overlap.js';

const POLICY: Record<string, string[]> = {
  author: ['ViewPipelines'], operator: ['ViewPipelines', 'ApproveStep'], 'pipeline-admin': ['ViewPipelines', 'ApproveStep'], member: [],
};
const ROLE: Record<string, string> = { ines: 'author', kofi: 'operator', dara: 'pipeline-admin', theo: 'member' };
const TZ = 'UTC';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
let users: Map<string, UserInfo>;
let sessions: Map<string, Session>;
let app: express.Express;
let cedarDown = false;
const v2Query = () => { const w = workDayWindow(today(), TZ); return { day: today(), timezone: TZ, schemaVersion: '2', windowStart: w.start, windowEnd: w.end, mode: 'live' }; };
const graph = (who: string | null, path = '/api/pipelines/work-graph/workspace/graph', query: Record<string, string> = v2Query()) => {
  const r = request(app).get(path).query(query);
  return who ? r.set('x-user', who) : r;
};
const ids = (body: { nodes: Array<{ id: string; kind: string }> }, prefix: string) => body.nodes.filter(n => n.id.startsWith(prefix)).map(n => n.id).sort();

beforeAll(() => stopWorkGraphLiveHints());
afterAll(() => unfreezeClock());
// Frozen midday so hoursAgo-stamped fixtures stay inside the local day at any wall-clock hour.
beforeEach(() => {
  unfreezeClock(); freezeClock('2026-10-06T00:00:00.000Z');
  jest.clearAllMocks(); cedarDown = false; agentJobs.reset();
  users = new Map(Object.entries(ROLE).map(([id, role]): [string, UserInfo] => [id, {
    id, displayName: id, email: null, personId: null, epoch: 1, grants: { [role === 'member' ? 'orgiq' : 'pipelines']: [role] },
  }]));
  sessions = new Map(Object.entries(ROLE).map(([id, role]) => [id, {
    sub: id, tenant: role === 'member' ? 'orgiq' : 'pipelines', role, epoch: 1, iat: 1, grants: structuredClone(users.get(id)!.grants),
  } as Session]));
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => {
    if (cedarDown) throw new Error('AVP unreachable');
    return (POLICY[p.role] ?? []).includes(action);
  });
  app = express();
  app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = s; next(); });
  app.use('/api/pipelines/work-graph', pipelinesWorkGraphRouter); app.use(errorHandler);
});

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'cancelled']);
const inDay = (r: { startedAt: string | null; finishedAt: string | null; status: string }) => {
  if (!r.startedAt) return false;
  const w = workDayWindow(today(), TZ);
  return intervalOverlapsWorkDay(r.startedAt, TERMINAL.has(r.status) ? (r.finishedAt ?? r.startedAt) : undefined, w);
};

describe('honesty against the pipelines REST sources', () => {
  it('draws exactly the in-day runs, their in-flight steps, pending approvals and definitions the routes serve', async () => {
    const res = await graph('kofi');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const projection = await loadProjection();
    const dayRuns = projection.runs.filter(inDay);
    expect(dayRuns.length).toBeGreaterThan(0);
    expect(ids(res.body, 'prun:')).toEqual(dayRuns.map(r => `prun:${r.id}`).sort());
    const liveSteps = dayRuns.filter(r => !TERMINAL.has(r.status)).flatMap(r => projection.steps.get(r.id) ?? []);
    expect(ids(res.body, 'step:')).toEqual(liveSteps.map(s => `step:${s.runId}:${s.stepId}`).sort());
    const approvals = (await listApprovals()).approvals;
    expect(ids(res.body, 'approval:')).toEqual(approvals.map(a => `approval:${a.id}`).sort());
    // Every drawn definition has a drawn run (or approval) of its own; the subject-kind is `project`.
    const defs = res.body.nodes.filter((n: { id: string }) => n.id.startsWith('definition:'));
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      expect(d.kind).toBe('project');
      expect(res.body.edges.some((e: { toId: string }) => e.toId === d.id)).toBe(true);
    }
    // The reader draws only nodes inside an effort: nothing served is left unanchored.
    const inEffort = new Set((res.body.efforts as Array<{ nodeIds: string[] }>).flatMap(e => e.nodeIds));
    expect(res.body.nodes.filter((n: { id: string }) => !inEffort.has(n.id))).toEqual([]);
    // A run's own figures, never derived ones.
    const withCost = dayRuns.find(r => r.costUsd != null);
    if (withCost) {
      const v2 = res.body.details.find((d: { nodeId: string }) => d.nodeId === `prun:${withCost.id}`);
      expect(v2.lines).toContain(`Cost · $${withCost.costUsd!.toFixed(4)}`);
    }
  });

  it('serves a v2 snapshot the library reader accepts, for the workspace and for one run', async () => {
    const ws = await graph('kofi');
    expect(validateWorkGraphSnapshotV2(ws.body).ok).toBe(true);
    expect(ws.body.scope.personId).toBe('workspace:pipelines');
    expect(ws.body.scope.policyRevision).toMatch(/^pipelines\./);
    const run = (await loadProjection()).runs.find(inDay)!;
    const one = await graph('kofi', `/api/pipelines/work-graph/runs/${encodeURIComponent(run.id)}/graph`);
    expect(one.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(one.body).ok).toBe(true);
    expect(one.body.scope.personId).toBe(`run:${run.id}`);
    expect(ids(one.body, 'prun:')).toEqual([`prun:${run.id}`]);
    expect(ids(one.body, 'definition:')).toEqual([`definition:${run.definitionId}`]);
  });

  it('draws a run with its steps and the run→definition and step→run edges', async () => {
    const projection = await loadProjection();
    const run = projection.runs.find(r => (projection.steps.get(r.id)?.length ?? 0) > 1)!;
    const res = await graph('kofi', `/api/pipelines/work-graph/runs/${encodeURIComponent(run.id)}/graph`);
    const steps = projection.steps.get(run.id)!;
    expect(ids(res.body, 'step:')).toEqual(steps.map(s => `step:${s.runId}:${s.stepId}`).sort());
    const relations = res.body.edges.map((e: { fromId: string; toId: string; relation: string }) => `${e.fromId}>${e.toId}`);
    expect(relations).toContain(`prun:${run.id}>definition:${run.definitionId}`);
    for (const s of steps) expect(relations).toContain(`step:${s.runId}:${s.stepId}>prun:${run.id}`);
  });
});

describe('authz matrix (fresh per request)', () => {
  it('author: runs and steps but never approvals; operator and admin: approvals too', async () => {
    const author = await graph('ines');
    expect(author.status).toBe(200);
    expect(ids(author.body, 'approval:')).toEqual([]);
    expect(JSON.stringify(author.body)).not.toMatch(/Approval ·|"approval:|con-mock-1/);
    expect(ids(author.body, 'prun:').length).toBeGreaterThan(0);
    const operator = await graph('kofi');
    expect(ids(operator.body, 'approval:').length).toBeGreaterThan(0);
    expect(ids(operator.body, 'prun:')).toEqual(ids(author.body, 'prun:'));
    expect(ids((await graph('dara')).body, 'approval:')).toEqual(ids(operator.body, 'approval:'));
    // Different gate outcomes, different policy revisions.
    expect(author.body.scope.policyRevision).not.toBe(operator.body.scope.policyRevision);
  });

  it('an approval on a projected run hangs off its step and is withheld from an author on the run page too', async () => {
    const job = (await enqueueJob({ kind: 'work', title: 'Review the plan', payload: { requiresReview: true }, createdBy: 'ines' }))!;
    const claim = await claimJob(job.id, 'test-box', 'test-session');
    await completeJob(job.id, { claimToken: claim!.claimToken, status: 'awaiting_review' });
    const approvals = (await listApprovals()).approvals;
    const mine = approvals.find(a => a.runId === `job:${job.id}`)!;
    expect(mine).toBeDefined();
    const path = `/api/pipelines/work-graph/runs/${encodeURIComponent(`job:${job.id}`)}/graph`;
    const author = await graph('ines', path);
    expect(author.status).toBe(200);
    expect(ids(author.body, 'approval:')).toEqual([]);
    // The step is still a step the steps route serves to every reader.
    expect(ids(author.body, 'step:')).toContain(`step:job:${job.id}:review`);
    const operator = await graph('kofi', path);
    expect(ids(operator.body, 'approval:')).toEqual([`approval:${mine.id}`]);
    const edges = operator.body.edges.map((e: { fromId: string; toId: string }) => `${e.fromId}>${e.toId}`);
    expect(edges).toContain(`approval:${mine.id}>step:job:${job.id}:review`);
  });

  it('refuses anonymous, another tenant, a stale epoch and a revoked grant', async () => {
    expect((await graph(null)).status).toBe(401);
    expect((await graph('theo')).status).toBe(403);
    users.get('kofi')!.epoch = 2;
    expect((await graph('kofi')).status).toBe(401);
    users.get('kofi')!.epoch = 1; users.get('kofi')!.grants = {};
    expect((await graph('kofi')).status).toBe(401);
    // A forged session (a tenant the directory does not back) is refused, not trusted.
    sessions.set('forged', { sub: 'ines', tenant: 'pipelines', role: 'pipeline-admin', epoch: 1, iat: 1, grants: { pipelines: ['pipeline-admin'] } } as Session);
    expect((await graph('forged')).status).toBe(401);
  });

  it('a failed Cedar decision withholds everything and says so, never falls open', async () => {
    cedarDown = true;
    const res = await graph('kofi');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.partial).toBe(true);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ source: 'pipeline', health: 'authorization-unavailable' }));
    expect((await graph('kofi', '/api/pipelines/work-graph/runs/job:x/graph')).status).toBe(404);
  });

  it('answers the uniform unavailable body for an absent run and 400s malformed input', async () => {
    const res = await graph('kofi', '/api/pipelines/work-graph/runs/job:does-not-exist/graph');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' });
    expect((await graph('kofi', '/api/pipelines/work-graph/runs/%20bad/graph')).status).toBe(400);
    expect((await graph('kofi', undefined, { day: 'nope', timezone: TZ })).status).toBe(400);
    expect((await graph('kofi', undefined, { day: today(), timezone: TZ, extra: '1' })).status).toBe(400);
  });
});
