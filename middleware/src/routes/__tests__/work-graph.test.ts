// /api/work-graph (routes/work-graph.ts) over the real mock fixtures.
//
// Pinned:
//   * honesty end to end — every node on the wire is one row the REST routes
//     serve to the same viewer (work tree, bot runs, marketplace runs), and
//     every count equals the provider's own count under the library day rule;
//   * the authz matrix — each part follows its REST read gate, decided fresh
//     per request: member (no runs), sme (ManageBots + DispatchAgentRun),
//     org-leader (read roles), another tenant (403), anonymous (401), a bumped
//     epoch (401), a failed Cedar decision (withheld + authorization-unavailable);
//   * the reference's uniform 404 body for an initiative that does not exist.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
// The flow-run read asks each run's conversation authority (routes/conversation-summarize.ts ownRun).
jest.mock('../../lib/live-principal.js', () => ({ ...jest.requireActual('../../lib/live-principal.js'), authorizeConversationChat: jest.fn() }));
jest.mock('../../lib/realtime-gateway.js', () => ({ channelGuard: {} }));
import express from 'express';
import request from '../../test-support/http.js';
import { workGraphRouter } from '../work-graph.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';
import { getProjectWorkItems, mockReprojectedIso } from '../../providers/work-items.js';
import { listBots, listBotRunsForBotsResult, listMarketplaceRuns } from '../../providers/bots.js';
import { workDayWindow, validateWorkGraphSnapshotV2 } from '@connorhoehn/realtime-modules/work-graph';
import { intervalOverlapsWorkDay } from '../../lib/work-graph/day-overlap.js';
import { clock, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { stopWorkGraphLiveHints } from '../../lib/work-graph/live.js';
import { authorizeConversationChat } from '../../lib/live-principal.js';
import { listSprints, isMine } from '../../providers/sprints.js';
import { listDecisionActivity } from '../../providers/decisions.js';
import { listProjects } from '../../providers/projects.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { enqueueJob, cancelJob } from '../../providers/agent-jobs.js';
import { agentJobs } from '../../mock/agent-jobs.js';

const POLICY: Record<string, string[]> = { member: [], sme: ['ManageBots', 'DispatchAgentRun'], 'org-leader': ['DispatchAgentRun'] };
const dayIn = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const ROLE: Record<string, string> = { theo: 'member', nora: 'sme', vera: 'org-leader', ines: 'author' };
let users: Map<string, UserInfo>;
let sessions: Map<string, Session>;
let app: express.Express;
let cedarDown = false;

const TZ = 'America/New_York';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
const graph = (who: string | null, path = '/api/work-graph/initiatives/p-auth-migration/graph', query: Record<string, string> = { day: today(), timezone: TZ }) => {
  const r = request(app).get(path).query(query);
  return who ? r.set('x-user', who) : r;
};
const v2Query = () => { const w = workDayWindow(today(), TZ); return { day: today(), timezone: TZ, schemaVersion: '2', windowStart: w.start, windowEnd: w.end, mode: 'live' }; };
const ids = (body: { nodes: Array<{ id: string; kind: string }> }, kind: string) => body.nodes.filter(n => n.kind === kind).map(n => n.id).sort();

beforeAll(() => stopWorkGraphLiveHints());
afterAll(() => unfreezeClock());
// Frozen midday so hoursAgo-stamped fixtures stay inside the local day at any wall-clock hour.
beforeEach(() => {
  unfreezeClock(); freezeClock('2026-10-06T00:00:00.000Z');
  jest.clearAllMocks(); cedarDown = false;
  users = new Map(Object.entries(ROLE).map(([id, role]): [string, UserInfo] => [id, {
    id, displayName: id, email: null, personId: null, epoch: 1, grants: { [role === 'author' ? 'pipelines' : 'orgiq']: [role] },
  }]));
  sessions = new Map(Object.entries(ROLE).map(([id, role]) => [id, {
    sub: id, tenant: role === 'author' ? 'pipelines' : 'orgiq', role, epoch: 1, iat: 1, grants: structuredClone(users.get(id)!.grants),
  } as Session]));
  jest.mocked(authorizeConversationChat).mockImplementation(async args => args.channel !== 'orgiq:initiative:p-denied');
  flowRunsFixture.reset(); agentJobs.reset();
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => {
    if (cedarDown) throw new Error('AVP unreachable');
    return (POLICY[p.role] ?? []).includes(action);
  });
  app = express();
  app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = s; next(); });
  app.use('/api/work-graph', workGraphRouter); app.use(errorHandler);
});

describe('honesty against the REST sources', () => {
  it('draws exactly the in-day rows the providers serve, with their own counts', async () => {
    const res = await graph('nora');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const window = workDayWindow(today(), TZ);
    const items = (await getProjectWorkItems('p-auth-migration')).filter(i => {
      const start = mockReprojectedIso(i.createdAt);
      const closed = i.status === 'done' || i.status === 'cancelled';
      return intervalOverlapsWorkDay(start, closed ? mockReprojectedIso(i.completedAt ?? i.updatedAt) : undefined, window);
    });
    expect(ids(res.body, 'task')).toEqual(items.map(i => `work:${i.id}`).sort());
    const bots = (await listBots()).filter(b => b.orgProjectId === 'p-auth-migration');
    const runs = [...(await listBotRunsForBotsResult(bots.map(b => b.id), 50)).items, ...await listMarketplaceRuns('p-auth-migration', 100)]
      .filter(r => intervalOverlapsWorkDay(r.startedAt, r.status === 'running' ? undefined : (r.finishedAt ?? r.startedAt), window));
    expect(ids(res.body, 'run')).toEqual([...new Set(runs.map(r => `run:${r.id}`))].sort());
    expect(ids(res.body, 'agent')).toEqual([...new Set(runs.filter(r => r.botId).map(r => `agent:${r.botId}`))].sort());
    expect(ids(res.body, 'project')).toEqual(['initiative:p-auth-migration']);
    // Each run's cost line is the row's own figure.
    for (const r of runs.filter(x => x.costUsd != null)) {
      const v2 = await graph('nora', undefined, v2Query());
      const detail = v2.body.details.find((d: { nodeId: string }) => d.nodeId === `run:${r.id}`);
      expect(detail.lines).toContain(`Cost · $${r.costUsd!.toFixed(4)}`);
      break;
    }
  });

  it('serves a v2 snapshot the library reader accepts, for an initiative and for the workspace', async () => {
    const one = await graph('nora', undefined, v2Query());
    expect(one.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(one.body).ok).toBe(true);
    expect(one.body.scope.personId).toBe('initiative:p-auth-migration');
    const ws = await graph('nora', '/api/work-graph/workspace/graph', v2Query());
    expect(ws.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(ws.body).ok).toBe(true);
    expect(ws.body.scope.personId).toBe('workspace');
    // Every initiative node on the workspace has at least one member drawn.
    for (const p of ws.body.nodes.filter((n: { kind: string }) => n.kind === 'project')) {
      expect(ws.body.edges.some((e: { toId: string }) => e.toId === p.id)).toBe(true);
    }
  });
});

describe('authz matrix (fresh per request)', () => {
  it('member: work items only; sme: plus runs and bots; org-leader: read roles admit runs', async () => {
    const member = await graph('theo');
    expect(member.status).toBe(200);
    expect(ids(member.body, 'run')).toEqual([]); expect(ids(member.body, 'agent')).toEqual([]);
    expect(member.body.sources.map((s: { source: string }) => s.source).sort()).toEqual(['document', 'pipeline']);
    expect(JSON.stringify(member.body)).not.toMatch(/auth-dep-watch|Cost ·/);
    const sme = await graph('nora');
    expect(ids(sme.body, 'task')).toEqual(ids(member.body, 'task'));
    expect(ids(sme.body, 'run').length).toBeGreaterThan(0);
    const leader = await graph('vera');
    expect(ids(leader.body, 'run')).toEqual(ids(sme.body, 'run'));
    // Different gate outcomes, different policy revisions.
    expect(member.body.scope.policyRevision).not.toBe(sme.body.scope.policyRevision);
  });

  it('refuses anonymous, another tenant, a stale epoch and a revoked grant', async () => {
    expect((await graph(null)).status).toBe(401);
    expect((await graph('ines')).status).toBe(403);
    users.get('nora')!.epoch = 2;
    expect((await graph('nora')).status).toBe(401);
    users.get('nora')!.epoch = 1; users.get('nora')!.grants = {};
    expect((await graph('nora')).status).toBe(401);
  });

  it('a failed Cedar decision withholds runs and says so, never falls open', async () => {
    cedarDown = true;
    const res = await graph('nora', undefined, v2Query());
    expect(res.status).toBe(200);
    expect(ids(res.body, 'run')).toEqual([]);
    expect(res.body.partial).toBe(true);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ source: 'cloud-compute', health: 'authorization-unavailable' }));
    expect(res.body.temporal.coverage.complete).toBe(false);
  });

  it('answers the uniform unavailable body for an unknown initiative and 400s malformed input', async () => {
    const missing = await graph('nora', '/api/work-graph/initiatives/p-nope/graph');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' });
    expect((await graph('nora', '/api/work-graph/initiatives/bad%20id/graph')).status).toBe(400);
    expect((await graph('nora', undefined, { day: today() })).status).toBe(400);
    expect((await graph('nora', undefined, { day: today(), timezone: TZ, cursor: 'x' })).status).toBe(400);
  });
});

const flowRow = (over: Record<string, unknown> = {}) => ({
  id: 'osm-00000000-0000-0000-0000-000000000001', tenant: 'orgiq', kind: 'orgiq.summarize', requestedBy: 'nora', scope: 'orgiq:initiative:p-auth-migration',
  status: 'completed', progress: [{ id: 'a', label: 'Read', status: 'completed' }, { id: 'b', label: 'Write', status: 'completed' }],
  input: { secret: 'private transcript' }, result: { text: 'private summary' }, meta: {}, error: null, attempts: 1, maxAttempts: 1,
  leaseOwner: null, leaseExpiresAt: null, createdAt: clock.nowIso(), updatedAt: clock.nowIso(), finishedAt: clock.nowIso(), ...over,
});

describe('sprints, decisions, flow runs and the person day', () => {
  it('draws exactly the sprints and decisions the REST providers serve, on their own days', async () => {
    const vera = await graph('vera', undefined, v2Query());
    expect(vera.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(vera.body).ok).toBe(true);
    const window = workDayWindow(today(), TZ);
    const sprints = (await listSprints({ orgProjectId: 'p-auth-migration', limit: 300 })).filter(sp => sp.startsOn && sp.endsOn
      && intervalOverlapsWorkDay(workDayWindow(sp.startsOn, TZ).start, new Date(Date.parse(workDayWindow(sp.endsOn, TZ).end) - 1).toISOString(), window));
    expect(sprints.length).toBeGreaterThan(0);
    expect(vera.body.nodes.filter((n: { id: string }) => n.id.startsWith('sprint:')).map((n: { id: string }) => n.id).sort())
      .toEqual(sprints.map(sp => `sprint:${sp.id}`).sort());
    // The row's own rollups, and the budgets-tier money, are on the org-leader's detail.
    const sp = sprints[0]!;
    const detail = vera.body.details.find((d: { nodeId: string }) => d.nodeId === `sprint:${sp.id}`);
    expect(detail.lines.some((l: string) => l.startsWith(`Items · ${sp.doneItemCount} of ${sp.itemCount} done`))).toBe(true);
    expect(detail.lines.some((l: string) => l.startsWith(`Planned · $${sp.estimatedCostUsd.toFixed(2)}`))).toBe(true);

    const decision = (await listDecisionActivity({ projectId: 'p-auth-migration' })).find(d => d.escalatedAt)!;
    const day = dayIn(decision.escalatedAt!);
    const w = workDayWindow(day, TZ);
    const onDay = await graph('theo', undefined, { day, timezone: TZ, schemaVersion: '2', windowStart: w.start, windowEnd: w.end, mode: 'live' });
    expect(onDay.status).toBe(200);
    expect(ids(onDay.body, 'change')).toContain(`decision:${decision.id}`);
    expect(onDay.body.edges).toContainEqual(expect.objectContaining({ fromId: `decision:${decision.id}`, toId: 'initiative:p-auth-migration', relation: 'works-on' }));
    const dDetail = onDay.body.details.find((d: { nodeId: string }) => d.nodeId === `decision:${decision.id}`);
    expect(dDetail.badge).toBe('Escalated');
  });

  it('gates sprint money by the budgets read tier and sprints by the viewer\u2019s own person', async () => {
    const leader = await graph('vera', undefined, v2Query());
    const member = await graph('theo', undefined, v2Query());
    // theo is linked to no person: scope=mine is empty, so no sprint node and no money, and no placeholder.
    expect(member.body.nodes.some((n: { id: string }) => n.id.startsWith('sprint:'))).toBe(false);
    expect(JSON.stringify(member.body)).not.toMatch(/Planned ·|Granted ·|Envelope ·/);
    // A linked sme sees exactly their own sprints (isMine), without money.
    const all = await listSprints({ orgProjectId: 'p-auth-migration', limit: 300 });
    const person = all.find(sp => sp.stewardPersonId)!.stewardPersonId!;
    users.get('nora')!.personId = person;
    const mine = await graph('nora', undefined, v2Query());
    const expected = (await listSprints({ personId: person, mineOnly: true, orgProjectId: 'p-auth-migration', limit: 300 })).filter(isMine).map(sp => `sprint:${sp.id}`);
    const drawn = ids(mine.body, 'task').filter(id => id.startsWith('sprint:'));
    expect(drawn.every(id => expected.includes(id))).toBe(true);
    expect(drawn.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine.body)).not.toMatch(/Planned ·|Granted ·|Envelope ·/);
    expect(JSON.stringify(leader.body)).toMatch(/Planned ·/);
    expect(leader.body.scope.policyRevision).not.toBe(mine.body.scope.policyRevision);
  });

  it('a failed budgets-tier decision withholds sprint money and says so on the records source', async () => {
    cedarDown = true;
    const res = await graph('nora', undefined, v2Query());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/Planned ·|Granted ·|Envelope ·/);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ source: 'document', health: 'authorization-unavailable' }));
    expect(res.body.partial).toBe(true);
  });

  it('draws only the viewer\u2019s own flow runs whose conversation they may still read, never source or result', async () => {
    flowRunsFixture.rows().push(
      flowRow() as never,
      flowRow({ id: 'osm-00000000-0000-0000-0000-000000000002', requestedBy: 'theo' }) as never,                                  // someone else's
      flowRow({ id: 'osm-00000000-0000-0000-0000-000000000003', scope: 'orgiq:initiative:p-denied' }) as never,                   // conversation no longer readable
      flowRow({ id: 'odc-00000000-0000-0000-0000-000000000004', kind: 'orgiq.doc', scope: 'orgiq:initiative:p-auth-migration' }) as never,
      flowRow({ id: 'asm-00000000-0000-0000-0000-000000000005', tenant: 'assessment', kind: 'assessment.summarize' }) as never,   // another tenant's flow
    );
    const res = await graph('nora', undefined, v2Query());
    expect(res.status).toBe(200);
    expect(ids(res.body, 'run').filter(id => id.startsWith('flow:'))).toEqual(['flow:odc-00000000-0000-0000-0000-000000000004', 'flow:osm-00000000-0000-0000-0000-000000000001']);
    const detail = res.body.details.find((d: { nodeId: string }) => d.nodeId === 'flow:osm-00000000-0000-0000-0000-000000000001');
    expect(detail.lines).toEqual(['Steps · 2 of 2 complete']);
    expect(JSON.stringify(res.body)).not.toMatch(/private transcript|private summary/);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ source: 'pipeline', health: 'available' }));
    // Another initiative's graph does not carry this initiative's conversation runs.
    const other = await graph('nora', '/api/work-graph/initiatives/p-rag-search/graph', v2Query());
    expect(ids(other.body, 'run').filter(id => id.startsWith('flow:'))).toEqual([]);
  });

  it('frames one person\u2019s day by assignee, with their own flow runs only for themselves', async () => {
    const ws = await graph('vera', '/api/work-graph/workspace/graph', v2Query());
    const projects = await listProjects({ limit: 200 });
    const byId = new Map<string, string | null>();
    for (const project of projects) for (const item of await getProjectWorkItems(project.id)) byId.set(`work:${item.id}`, item.assigneeId);
    const assignees = ws.body.nodes.filter((n: { id: string }) => n.id.startsWith('work:')).map((n: { id: string }) => byId.get(n.id)).filter((id: string | null | undefined): id is string => !!id);
    const person = assignees[0]!;
    const expected = ws.body.nodes.filter((n: { id: string }) => byId.get(n.id) === person).map((n: { id: string }) => n.id).sort();
    const res = await graph('vera', `/api/work-graph/people/${person}/graph`, v2Query());
    expect(res.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(res.body).ok).toBe(true);
    expect(res.body.scope.personId).toBe(`person:${person}`);
    expect(ids(res.body, 'task').filter(id => id.startsWith('work:'))).toEqual(expected);
    expect(res.body.nodes.length).toBeLessThan(ws.body.nodes.length);
    // Flow runs: never another person's, even when they exist.
    flowRunsFixture.rows().push(flowRow({ requestedBy: 'vera' }) as never);
    const notMine = await graph('vera', `/api/work-graph/people/${person}/graph`, v2Query());
    expect(ids(notMine.body, 'run').filter(id => id.startsWith('flow:'))).toEqual([]);
    users.get('vera')!.personId = person;
    const own = await graph('vera', `/api/work-graph/people/${person}/graph`, v2Query());
    expect(ids(own.body, 'run').filter(id => id.startsWith('flow:')).length).toBe(1);
    // Unknown person is the uniform body; a member's person day carries no runs.
    const missing = await graph('vera', '/api/work-graph/people/p-nobody/graph');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' });
    const theo = await graph('theo', `/api/work-graph/people/${person}/graph`, v2Query());
    expect(ids(theo.body, 'run').filter(id => id.startsWith('run:'))).toEqual([]);
    expect((await graph('ines', `/api/work-graph/people/${person}/graph`)).status).toBe(403);
  });
});

describe('live queue rows', () => {
  const workItem = async () => (await getProjectWorkItems('p-auth-migration')).find(i => i.status !== 'done' && i.status !== 'cancelled')!;

  it('draws a queued job for the dispatch tier only, with no prompt, and drops it when it leaves the live set', async () => {
    const item = await workItem();
    const queued = (await enqueueJob({ kind: 'devbox:task', title: 'Refresh the lockfile', payload: { prompt: 'SECRET PROMPT TEXT', workItemId: item.id, initiativeId: 'p-auth-migration' }, createdBy: 'nora' }))!;
    const done = (await enqueueJob({ kind: 'devbox:task', title: 'Already finished', payload: { workItemId: item.id } }))!;
    await cancelJob(done.id);
    const sme = await graph('nora', undefined, v2Query());
    const jobs = ids(sme.body, 'run').filter(id => id.startsWith('job:'));
    expect(jobs).toEqual([`job:${queued.id}`]);
    expect(JSON.stringify(sme.body)).not.toMatch(/SECRET PROMPT TEXT/);
    expect(sme.body.edges.some((e: { fromId: string; toId: string; relation: string }) => e.fromId === `job:${queued.id}` && e.toId === `work:${item.id}` && e.relation === 'operates-on')).toBe(true);
    // The REST floor serves a member the queue; the graph is narrower: member and non-dispatch roles see no job nodes.
    const member = await graph('theo', undefined, v2Query());
    expect(ids(member.body, 'run').filter(id => id.startsWith('job:'))).toEqual([]);
    expect(JSON.stringify(member.body)).not.toContain(queued.id);
    // A failed dispatch decision withholds jobs too.
    cedarDown = true;
    const down = await graph('nora', undefined, v2Query());
    expect(ids(down.body, 'run').filter(id => id.startsWith('job:'))).toEqual([]);
    cedarDown = false;
    await cancelJob(queued.id);
    const after = await graph('nora', undefined, v2Query());
    expect(ids(after.body, 'run').filter(id => id.startsWith('job:'))).toEqual([]);
  });

  it('a job on another initiative never appears on this initiative graph, and the person day carries only their own items\' jobs', async () => {
    const item = await workItem();
    await enqueueJob({ kind: 'devbox:task', title: 'Elsewhere', payload: { initiativeId: 'p-rag-search' } });
    await enqueueJob({ kind: 'devbox:task', title: 'Mine', payload: { workItemId: item.id } });
    const res = await graph('nora', undefined, v2Query());
    expect(res.body.nodes.filter((n: { id: string; title: string }) => n.id.startsWith('job:')).map((n: { title: string }) => n.title)).toEqual(['Mine']);
    if (item.assigneeId) {
      const person = await graph('nora', `/api/work-graph/people/${item.assigneeId}/graph`, v2Query());
      expect(person.body.nodes.filter((n: { id: string }) => n.id.startsWith('job:')).map((n: { title: string }) => n.title)).toEqual(['Mine']);
    }
  });
});
