// /api/assessment/work-graph (routes/assessment-work-graph.ts) over the real mock fixtures — the
// assessment counterpart of pipelines-work-graph.test.ts.
//
// Pinned:
//   * honesty — every node is one row the /api/assessment routes serve to the same viewer (teams,
//     dimensions, evidence, drafts, decks, runs), under the library's day rule, and every edge is
//     one of the documented relations (team→dimension, evidence→dimension, draft→dimension,
//     deck→team, run→team|deck);
//   * the authz matrix, decided fresh per request: a viewer without ViewAssessment (any role of
//     another tenant, or a denied Cedar decision) receives no team, draft or evidence, and a
//     failed decision withholds and says `authorization-unavailable`; own flow runs need
//     RunAssessmentAgent; cross-tenant 403, anonymous 401, stale epoch 401, forged 401;
//   * the uniform 404 for a team that is absent.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/live-principal.js', () => ({ ...jest.requireActual('../../lib/live-principal.js'), authorizeConversationChat: jest.fn(async () => true) }));
jest.mock('../../lib/realtime-gateway.js', () => ({ channelGuard: {} }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentWorkGraphRouter, changeFor } from '../assessment-work-graph.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';
import { workDayWindow, validateWorkGraphSnapshotV2 } from '@connorhoehnslalom/realtime-modules/work-graph';
import { clock, fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { stopWorkGraphLiveHints } from '../../lib/work-graph/live.js';
import { applyScores, uploadEvidence, listTeams, createRunRecord } from '../../providers/assessment.js';
import { flowRunStore } from '../../lib/flow-runs/index.js';
import { deckStore } from '../../providers/assessment-decks.js';
import { SUMMARY_KIND, FOLLOWUPS_KIND } from '../../lib/assessment-drafts.js';

const ASSESSMENT = ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent'];
const POLICY: Record<string, string[]> = {
  assessor: ASSESSMENT, 'lead-assessor': ASSESSMENT, 'program-lead': ASSESSMENT, readonly: ['ViewAssessment'], blind: [],
  author: ['ViewPipelines'], member: [],
};
const ROLE: Record<string, string> = { ana: 'assessor', lee: 'lead-assessor', ro: 'readonly', bo: 'blind', ines: 'author', theo: 'member' };
const TENANT_OF: Record<string, string> = { author: 'pipelines', member: 'orgiq' };
const TZ = 'UTC';
const TEAM = 'TEAM-001';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
let users: Map<string, UserInfo>;
let sessions: Map<string, Session>;
let app: express.Express;
let cedarDown = false;
const v2Query = () => { const w = workDayWindow(today(), TZ); return { day: today(), timezone: TZ, schemaVersion: '2', windowStart: w.start, windowEnd: w.end, mode: 'live' }; };
const graph = (who: string | null, path = '/api/assessment/work-graph/workspace/graph', query: Record<string, string> = v2Query()) => {
  const r = request(app).get(path).query(query);
  return who ? r.set('x-user', who) : r;
};
type Body = { nodes: Array<{ id: string; kind: string; title: string }>; edges: Array<{ fromId: string; toId: string; relation: string }>; details: Array<{ nodeId: string; lines?: string[] }> };
const ids = (body: Body, prefix: string) => body.nodes.filter(n => n.id.startsWith(prefix)).map(n => n.id).sort();
const rel = (body: Body) => body.edges.map(e => `${e.fromId}>${e.toId}:${e.relation}`);

beforeAll(() => stopWorkGraphLiveHints());
afterAll(() => unfreezeClock());
// Frozen so the suite cannot straddle midnight; FREEZE_AT lets the midnight edges be proven.
beforeEach(async () => {
  unfreezeClock(); freezeClock(process.env.FREEZE_AT ?? '2026-10-06T00:00:00.000Z');
  jest.clearAllMocks(); cedarDown = false; fixtureRegistry.resetAll();
  users = new Map(Object.entries(ROLE).map(([id, role]): [string, UserInfo] => [id, {
    id, displayName: id, email: null, personId: null, epoch: 1, grants: { [TENANT_OF[role] ?? 'assessment']: [role] },
  }]));
  sessions = new Map(Object.entries(ROLE).map(([id, role]) => [id, {
    sub: id, tenant: TENANT_OF[role] ?? 'assessment', role, epoch: 1, iat: 1, grants: structuredClone(users.get(id)!.grants),
  } as Session]));
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => {
    if (cedarDown) throw new Error('AVP unreachable');
    return (POLICY[p.role] ?? []).includes(action);
  });
  app = express();
  app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = s; next(); });
  app.use('/api/assessment/work-graph', assessmentWorkGraphRouter); app.use(errorHandler);
});

/** One score, one evidence row and one draft on TEAM-001, all stamped now (inside today's window). */
async function seedToday(): Promise<{ evidenceId: string; draftId: string }> {
  await applyScores(TEAM, {
    relevant_dimension_ids: ['2'],
    scores: [{ dimension_id: '2', suggested_level: 3, confidence: 'moderate', rationale: 'Observed in the pipeline walkthrough', evidence_excerpts: ['Release pipeline runs on every merge'] }],
  }, 'ana');
  const evidence = (await uploadEvidence(TEAM, { dimension_id: '2', source_type: 'document', excerpt: 'Runbook for the release train' }))!;
  const draft = await flowRunStore.create({ tenant: 'assessment', kind: SUMMARY_KIND, requestedBy: 'ana', scope: `${TEAM}/2`, input: {}, idPrefix: 'adr' });
  return { evidenceId: evidence.evidence_id, draftId: draft.id };
}

describe('honesty against the assessment REST sources', () => {
  it('draws today\'s score, evidence and draft with the documented edges, and nothing the routes do not serve', async () => {
    const { evidenceId, draftId } = await seedToday();
    const res = await graph('ana');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(validateWorkGraphSnapshotV2(res.body).ok).toBe(true);
    expect(res.body.scope.personId).toBe('workspace:assessment');
    expect(res.body.scope.policyRevision).toMatch(/^assessment\./);
    expect(ids(res.body, 'team:')).toContain(`team:${TEAM}`);
    expect(ids(res.body, 'dim:')).toContain(`dim:${TEAM}:2`);
    expect(ids(res.body, 'evidence:')).toContain(`evidence:${TEAM}:${evidenceId}`);
    expect(ids(res.body, 'draft:')).toContain(`draft:${draftId}`);
    const edges = rel(res.body);
    expect(edges).toContain(`team:${TEAM}>dim:${TEAM}:2:works-on`);
    expect(edges).toContain(`evidence:${TEAM}:${evidenceId}>dim:${TEAM}:2:operates-on`);
    expect(edges).toContain(`draft:${draftId}>dim:${TEAM}:2:operates-on`);
    // The dimension's own figure, never a derived one.
    const dim = res.body.details.find((d: { nodeId: string }) => d.nodeId === `dim:${TEAM}:2`);
    expect(dim.lines).toContain('Level · 3');
    // Every node is inside an effort (the team anchors it), and every team anchor is `project`.
    const inEffort = new Set((res.body.efforts as Array<{ nodeIds: string[] }>).flatMap(e => e.nodeIds));
    expect(res.body.nodes.filter((n: { id: string }) => !inEffort.has(n.id))).toEqual([]);
    for (const t of res.body.nodes.filter((n: { id: string }) => n.id.startsWith('team:'))) expect(t.kind).toBe('project');
    // Every drawn team is one the REST list serves.
    const served = new Set((await listTeams()).map(t => `team:${t.id}`));
    for (const id of ids(res.body, 'team:')) expect(served.has(id)).toBe(true);
  });

  it('a team page draws its own team with its dimensions and evidence, and none of another team\'s', async () => {
    await seedToday();
    const res = await graph('ana', `/api/assessment/work-graph/teams/${TEAM}/graph`);
    expect(res.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(res.body).ok).toBe(true);
    expect(res.body.scope.personId).toBe(`team:${TEAM}`);
    expect(ids(res.body, 'team:')).toEqual([`team:${TEAM}`]);
    expect(res.body.nodes.every((n: { id: string }) => !/TEAM-00[2-7]/.test(n.id))).toBe(true);
    expect(ids(res.body, 'dim:').length).toBeGreaterThan(1);
  });

  it('draws a review deck (deck→team) and the agent run that built it (run→deck), and a team-less run off a queue anchor', async () => {
    const run = await createRunRecord({ command: 'draft-review-deck', team_id: TEAM, status: 'running', args: { deck_id: 'deck-x1' } });
    await deckStore.insertDeck({ id: 'deck-x1', teamId: TEAM, title: 'TEAM-001 review', audience: null, dimensionIds: [], createdBy: 'ana', headRevisionId: null, lastRunId: run.id });
    const loose = await createRunRecord({ command: 'validate-outputs', status: 'completed' });
    const res = await graph('ana');
    const edges = rel(res.body);
    expect(edges).toContain(`adeck:deck-x1>team:${TEAM}:derived-from`);
    expect(edges).toContain(`arun:${run.id}>adeck:deck-x1:operates-on`);
    expect(edges).toContain(`arun:${loose.id}>queue:runs:operates-on`);
    expect(res.body.nodes.find((n: { id: string }) => n.id === `arun:${run.id}`).status).toBe('running');
    // A team page draws the deck and its run, with the team's own runs, not a team-less one.
    const page = await graph('ana', `/api/assessment/work-graph/teams/${TEAM}/graph`);
    expect(ids(page.body, 'adeck:')).toEqual(['adeck:deck-x1']);
    expect(ids(page.body, 'arun:')).toContain(`arun:${run.id}`);
    expect(ids(page.body, 'arun:')).not.toContain(`arun:${loose.id}`);
  });

  it('a draft awaiting an editor is `change`/waiting; a running one is running', async () => {
    const run = await flowRunStore.create({ tenant: 'assessment', kind: FOLLOWUPS_KIND, requestedBy: 'ana', scope: `${TEAM}/3`, input: {}, idPrefix: 'adr' });
    const res = await graph('ana', `/api/assessment/work-graph/teams/${TEAM}/graph`);
    const node = res.body.nodes.find((n: { id: string }) => n.id === `draft:${run.id}`);
    expect(node).toBeDefined();
    expect(node.kind).toBe('change');
    expect(node.status).toBe('running');
  });
});

describe('authz matrix (fresh per request)', () => {
  it('a viewer without ViewAssessment receives no team, draft or evidence', async () => {
    const { draftId } = await seedToday();
    const blind = await graph('bo');
    expect(blind.status).toBe(200);
    expect(blind.body.nodes).toEqual([]);
    expect(JSON.stringify(blind.body)).not.toContain(draftId);
    expect(JSON.stringify(blind.body)).not.toContain(TEAM);
    // …and the team page for a team it cannot read is the uniform 404, same as an absent one.
    expect((await graph('bo', `/api/assessment/work-graph/teams/${TEAM}/graph`)).status).toBe(404);
    // A reader (ViewAssessment only) sees the graph; its policy revision differs from an editor's.
    const reader = await graph('ro');
    const editor = await graph('ana');
    expect(ids(reader.body, 'draft:')).toEqual(ids(editor.body, 'draft:'));
    expect(reader.body.scope.policyRevision).not.toBe(editor.body.scope.policyRevision);
    const readerDraft = reader.body.nodes.find((n: { id: string }) => n.id === `draft:${draftId}`);
    expect(readerDraft).toBeDefined();
  });

  it('own flow runs need RunAssessmentAgent: a reader never sees one, the requester does', async () => {
    const flow = await flowRunStore.create({ tenant: 'assessment', kind: 'assessment.summarize', requestedBy: 'ro', scope: `assessment:team:${TEAM}`, input: {}, idPrefix: 'asm' });
    const mine = await flowRunStore.create({ tenant: 'assessment', kind: 'assessment.summarize', requestedBy: 'ana', scope: `assessment:team:${TEAM}`, input: {}, idPrefix: 'asm' });
    const reader = await graph('ro');
    expect(ids(reader.body, 'aflow:')).toEqual([]);
    const editor = await graph('ana');
    expect(ids(editor.body, 'aflow:')).toEqual([`aflow:${mine.id}`]);
    expect(JSON.stringify(editor.body)).not.toContain(flow.id);
  });

  it('refuses another tenant\'s roles, anonymous, a stale epoch, a revoked grant and a forged session', async () => {
    expect((await graph(null)).status).toBe(401);
    expect((await graph('ines')).status).toBe(403);
    expect((await graph('theo')).status).toBe(403);
    users.get('ana')!.epoch = 2;
    expect((await graph('ana')).status).toBe(401);
    users.get('ana')!.epoch = 1; users.get('ana')!.grants = {};
    expect((await graph('ana')).status).toBe(401);
    sessions.set('forged', { sub: 'ines', tenant: 'assessment', role: 'lead-assessor', epoch: 1, iat: 1, grants: { assessment: ['lead-assessor'] } } as Session);
    expect((await graph('forged')).status).toBe(401);
  });

  it('a failed Cedar decision withholds everything and says so, never falls open', async () => {
    await seedToday();
    cedarDown = true;
    const res = await graph('ana');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.partial).toBe(true);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ source: 'document', health: 'authorization-unavailable' }));
    expect((await graph('ana', `/api/assessment/work-graph/teams/${TEAM}/graph`)).status).toBe(404);
  });

  it('answers the uniform unavailable body for an absent team and 400s malformed input', async () => {
    const res = await graph('ana', '/api/assessment/work-graph/teams/TEAM-999/graph');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' });
    expect((await graph('ana', '/api/assessment/work-graph/teams/nope/graph')).status).toBe(400);
    expect((await graph('ana', undefined, { day: 'nope', timezone: TZ })).status).toBe(400);
    expect((await graph('ana', undefined, { day: today(), timezone: TZ, extra: '1' })).status).toBe(400);
  });
});

describe('which writes hint the graph', () => {
  it('names the cause and, when the path does, the team', () => {
    expect(changeFor('POST', `/teams/${TEAM}/scores/apply`)).toEqual({ cause: 'score', teamId: TEAM });
    expect(changeFor('POST', `/teams/${TEAM}/evidence`)).toEqual({ cause: 'evidence', teamId: TEAM });
    expect(changeFor('POST', `/teams/${TEAM}/intake/text`)).toEqual({ cause: 'evidence', teamId: TEAM });
    expect(changeFor('POST', `/teams/${TEAM}/dimensions/2/drafts/followups`)).toEqual({ cause: 'draft', teamId: TEAM });
    expect(changeFor('POST', '/drafts/adr-1/accept')).toEqual({ cause: 'draft', teamId: null });
    expect(changeFor('POST', `/teams/${TEAM}/decks`)).toEqual({ cause: 'deck', teamId: TEAM });
    expect(changeFor('POST', '/decks/d1/revisions')).toEqual({ cause: 'deck', teamId: null });
    expect(changeFor('POST', '/runs')).toEqual({ cause: 'run', teamId: null });
    expect(changeFor('GET', `/teams/${TEAM}`)).toBeNull();
    expect(changeFor('PUT', '/configuration')).toBeNull();
  });
});
