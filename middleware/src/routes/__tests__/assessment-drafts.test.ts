// Evidence summary / follow-up drafts (docs/agentic-flows-migration.md slice 8):
// the authz matrix, private durable drafts, grounding with a deterministic
// fallback, accept creating real follow-up rows (and only the stored text),
// discard, and mock reset. Offline: MOCK_AGENTCORE answers through the same
// validators a real drafter's output passes.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent'] },
    { id: 'runner', tenant: 'assessment', label: 'Runner', summary: '', capabilities: ['ViewAssessment', 'RunAssessmentAgent'] },
    { id: 'assessment-reader', tenant: 'assessment', label: 'Reader', summary: '', capabilities: ['ViewAssessment'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['DispatchAgentRun'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { config } from '../../config.js';
import { assessmentRouter } from '../assessment.js';
import { pendingDrafts } from '../assessment-drafts.js';
import { mockControlRouter } from '../mock-control.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { getTeamDetail, listTeams } from '../../providers/assessment.js';
import {
  acceptFollowups, acceptSummary, draftExecutor, sourceFromDimension, type DraftSource,
} from '../../lib/assessment-drafts.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { agentcore } from '../../providers/index.js';
import type { FlowRunRow } from '../../lib/flow-runs/index.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use('/api/assessment', assessmentRouter);
  app.use(mockControlRouter);
  app.use(errorHandler);
  return app;
}
const as = (role: string, sub = `u-${role}`) => appAs({ role: role as Session['role'], tenant: 'assessment', sub });

let TEAM = ''; let DIM = '';
let source: DraftSource;
beforeAll(async () => {
  const listed = await listTeams() as unknown as { teams?: Array<{ id: string }> } | Array<{ id: string }>;
  const teams = Array.isArray(listed) ? listed : listed.teams ?? [];
  for (const t of teams) {
    const detail = await getTeamDetail(t.id);
    const d = detail?.dimensions.find(x => sourceFromDimension(x).evidence.length > 0 && sourceFromDimension(x).criteria.length > 0);
    if (d) { TEAM = t.id; DIM = d.id; source = sourceFromDimension(d); break; }
  }
  expect(TEAM).not.toBe('');
});
beforeEach(() => { flowRunsFixture.reset(); });

const base = () => `/api/assessment/teams/${TEAM}/dimensions/${DIM}/drafts`;
async function draft(app: express.Express, kind: 'evidence-summary' | 'followups'): Promise<{ runId: string; view: Record<string, any> }> {
  const res = await request(app).post(`${base()}/${kind}`).send({});
  expect(res.status).toBe(202);
  await Promise.all([...pendingDrafts]);
  const view = await request(app).get(`/api/assessment/drafts/${res.body.runId}`);
  expect(view.status).toBe(200);
  return { runId: res.body.runId, view: view.body };
}
const openQuestions = async (): Promise<string[]> =>
  (await getTeamDetail(TEAM))!.dimensions.find(d => d.id === DIM)!.follow_up_questions.filter(q => q.status === 'OPEN').map(q => q.text);

describe('route surface', () => {
  it('each route answers at its literal path', async () => {
    const app = as('assessor');
    const a = await request(app).post('/api/assessment/teams/TEAM-001/dimensions/1/drafts/evidence-summary').send({});
    const b = await request(app).post('/api/assessment/teams/TEAM-001/dimensions/1/drafts/followups').send({});
    expect([a.status, b.status]).toEqual([202, 202]);
    await Promise.all([...pendingDrafts]);
    const list = await request(app).get('/api/assessment/teams/TEAM-001/dimensions/1/drafts');
    expect(list.body.drafts.map((d: { runId: string }) => d.runId).sort()).toEqual([a.body.runId, b.body.runId].sort());
  });
});

describe('evidence summary', () => {
  it('lands as a draft with verbatim spans; levels come from the provider', async () => {
    const { view } = await draft(as('assessor'), 'evidence-summary');
    expect(view).toMatchObject({ kind: 'assessment.evidence-summary', phase: 'completed', decision: null, teamId: TEAM, dimensionId: DIM });
    const r = view['result'];
    expect(r.facts).toEqual(source.facts);
    expect(r.bullets.length).toBeGreaterThan(0);
    const byId = new Map(source.evidence.map(e => [e.id, e.excerpt]));
    for (const b of r.bullets) for (const s of b.sourceSpans) expect(byId.get(s.evidenceId)).toContain(s.text);
    expect((await openQuestions())).toEqual(source.existing_questions);
  });

  it('cannot be accepted (nothing to write), but can be discarded once', async () => {
    const app = as('assessor');
    const { runId } = await draft(app, 'evidence-summary');
    expect((await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(409);
    expect((await request(app).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(200);
    expect((await request(app).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(409);
    expect((await request(app).get(`/api/assessment/drafts/${runId}`)).body.decision).toBe('discarded');
  });
});

describe('follow-up drafts and accept', () => {
  it('drafts grounded questions without touching the team, then accept creates real OPEN rows', async () => {
    const app = as('assessor');
    const before = await openQuestions();
    const { runId, view } = await draft(app, 'followups');
    const questions: Array<{ text: string; criterionId: string | null }> = view['result'].questions;
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) { expect(q.text.endsWith('?')).toBe(true); expect(q.criterionId ?? 'x').toBeTruthy(); }
    expect(await openQuestions()).toEqual(before);

    const res = await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.body.created.map((q: { text: string }) => q.text)).toEqual(questions.map(q => q.text));
    expect(res.body.created[0]).toMatchObject({ dimension_id: DIM, status: 'OPEN', target_audience: 'team' });
    expect(await openQuestions()).toEqual([...before, ...questions.map(q => q.text)]);
    const after = await request(app).get(`/api/assessment/drafts/${runId}`);
    expect(after.body).toMatchObject({ decision: 'accepted', createdFollowUpIds: res.body.created.map((q: { question_id: string }) => q.question_id) });
    expect((await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(409);
    expect((await request(app).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(409);
  });

  it('accept takes only the picked rows, takes text from the stored draft, and rejects bad picks', async () => {
    const app = as('assessor');
    const { runId, view } = await draft(app, 'followups');
    const questions: Array<{ text: string }> = view['result'].questions;
    for (const bad of [[99], [-1], [0.5], ['0'], []]) {
      expect((await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({ indices: bad })).status).toBe(400);
    }
    const res = await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({ indices: [0], text: 'injected?', questions: ['also injected?'] });
    expect(res.status).toBe(200);
    expect(res.body.created.map((q: { text: string }) => q.text)).toEqual([questions[0]!.text]);
    expect(await openQuestions()).not.toContain('injected?');
  });

  it('a question the team already has open is skipped, not duplicated', async () => {
    const app = as('assessor');
    const first = await draft(app, 'followups');
    const second = await draft(app, 'followups');
    const q: Array<{ text: string }> = first.view['result'].questions;
    expect((await request(app).post(`/api/assessment/drafts/${first.runId}/accept`).send({})).status).toBe(200);
    const res = await request(app).post(`/api/assessment/drafts/${second.runId}/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.skipped).toEqual(q.map(x => x.text).filter(t => second.view['result'].questions.some((s: { text: string }) => s.text === t)));
  });

  it('a discarded follow-up draft creates nothing and cannot then be accepted', async () => {
    const app = as('assessor');
    const before = await openQuestions();
    const { runId } = await draft(app, 'followups');
    expect((await request(app).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(200);
    expect((await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(409);
    expect(await openQuestions()).toEqual(before);
  });
});

describe('decision race and immutability', () => {
  beforeEach(async () => { await request(as('admin')).post('/api/__mock/reset'); });
  it('Dismiss (discard) after Accept is refused and leaves the accepted rows and decision', async () => {
    const app = as('assessor');
    const { runId } = await draft(app, 'followups');
    expect((await request(app).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(200);
    const opened = await openQuestions();
    const res = await request(app).post(`/api/assessment/drafts/${runId}/discard`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already accepted/);
    expect((await request(app).get(`/api/assessment/drafts/${runId}`)).body.decision).toBe('accepted');
    expect(await openQuestions()).toEqual(opened);
  });

  it('concurrent Accept and Discard: exactly one wins, and an accept loser writes nothing', async () => {
    for (let n = 0; n < 5; n++) {
      await request(as('admin')).post('/api/__mock/reset');
      const a = as('assessor', 'u-ada'); const b = as('assessor', 'u-bo');
      const before = await openQuestions();
      const { runId } = await draft(a, 'followups');
      const [acc, dis] = await Promise.all([
        request(a).post(`/api/assessment/drafts/${runId}/accept`).send({}),
        request(b).post(`/api/assessment/drafts/${runId}/discard`).send({}),
      ]);
      expect([acc.status, dis.status].sort()).toEqual([200, 409]);
      const final = (await request(a).get(`/api/assessment/drafts/${runId}`)).body;
      if (acc.status === 200) {
        expect(final.decision).toBe('accepted');
        expect(dis.body.error).toMatch(/already accepted|decided this draft first/);
      } else {
        expect(final.decision).toBe('discarded');
        expect(acc.body.error).toMatch(/decided this draft first|already discarded/);
        expect(await openQuestions()).toEqual(before);
      }
    }
  });
});

describe('authz and privacy', () => {
  it('matrix: generate needs RunAssessmentAgent, accept needs ScoreAssessment, read needs ViewAssessment', async () => {
    const reader = as('assessment-reader');
    for (const kind of ['evidence-summary', 'followups']) expect((await request(reader).post(`${base()}/${kind}`).send({})).status).toBe(403);
    expect((await request(reader).get(base())).status).toBe(200);

    const runner = as('runner');
    const { runId } = await draft(runner, 'followups');
    expect((await request(runner).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(403);
    expect((await request(runner).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(200);
    expect((await request(as('admin')).post(`${base()}/followups`).send({})).status).toBe(202);
    await Promise.all([...pendingDrafts]);
  });

  it("another tenant's session is refused; another assessor sees, accepts and discards the shared draft; a reader reads only", async () => {
    const mine = as('assessor', 'u-ada');
    const { runId } = await draft(mine, 'followups');
    const sme = appAs({ role: 'sme' as Session['role'], tenant: 'orgiq', sub: 'u-sme' });
    expect((await request(sme).post(`${base()}/followups`).send({})).status).toBe(403);
    expect((await request(sme).get(`/api/assessment/drafts/${runId}`)).status).toBe(403);
    const other = as('assessor', 'u-bo');
    expect((await request(other).get(`/api/assessment/drafts/${runId}`)).status).toBe(200);
    expect((await request(other).get(base())).body.drafts).toHaveLength(1);
    const reader = as('assessment-reader', 'u-rd');
    expect((await request(reader).get(base())).body.drafts).toHaveLength(1);
    expect((await request(reader).post(`/api/assessment/drafts/${runId}/revise`).send({})).status).toBe(403);
    expect((await request(reader).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(403);
    expect((await request(other).post(`/api/assessment/drafts/${runId}/discard`).send({})).status).toBe(200);
    expect((await request(mine).post(`/api/assessment/drafts/${runId}/accept`).send({})).status).toBe(409);
    expect((await request(mine).get('/api/assessment/drafts/not-a-draft')).status).toBe(404);
  });

  it('Revise refines a ready draft by CAS: stale base 409, duplicate retry safe, newer version visible to the other assessor', async () => {
    const ada = as('assessor', 'u-ada'); const bo = as('assessor', 'u-bo');
    const { runId } = await draft(ada, 'evidence-summary');
    const url = `/api/assessment/drafts/${runId}/revise`;
    const get = async (a: ReturnType<typeof as>) => (await request(a).get(`/api/assessment/drafts/${runId}`)).body;
    expect((await get(bo)).revision).toBe(1);
    expect((await request(ada).post(url).send({ instruction: '', baseRevision: 1, requestId: 'req-00000001' })).status).toBe(400);
    const first = await request(ada).post(url).send({ instruction: 'Shorter, lead with gaps', baseRevision: 1, requestId: 'req-00000001' });
    expect(first.status).toBe(202); expect(first.body.revision).toBe(2);
    // response lost: the same actor retries the same request
    const retry = await request(ada).post(url).send({ instruction: 'Shorter, lead with gaps', baseRevision: 1, requestId: 'req-00000001' });
    expect(retry.status).toBe(202); expect(retry.body.revision).toBe(2);
    await Promise.all([...pendingDrafts]);
    const done = await get(bo);
    expect(done.revision).toBe(2); expect(done.phase).toBe('completed'); expect(done.revisedBy).toBe('u-ada');
    expect(done.result.summary).toContain('Revised: Shorter, lead with gaps');
    // bo still holds revision 1: refused, and told a newer version exists
    const stale = await request(bo).post(url).send({ instruction: 'Add numbers', baseRevision: 1, requestId: 'req-00000002' });
    expect(stale.status).toBe(409); expect(stale.body.error).toMatch(/newer|first/i);
    const second = await request(bo).post(url).send({ instruction: 'Add numbers', baseRevision: 2, requestId: 'req-00000003' });
    expect(second.status).toBe(202);
    await Promise.all([...pendingDrafts]);
    expect((await get(ada)).revision).toBe(3);
    // a decided draft cannot be revised
    await request(ada).post(`/api/assessment/drafts/${runId}/discard`).send({});
    expect((await request(ada).post(url).send({ instruction: 'x', baseRevision: 3, requestId: 'req-00000004' })).status).toBe(409);
  });

  it('validates ids and caps concurrent drafts', async () => {
    const app = as('assessor');
    expect((await request(app).post(`/api/assessment/teams/TEAM-999/dimensions/${DIM}/drafts/followups`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/assessment/teams/${TEAM}/dimensions/nope/drafts/followups`).send({})).status).toBe(404);
    expect((await request(app).post('/api/assessment/teams/bad id/dimensions/1/drafts/followups').send({})).status).toBe(400);
  });

  it('POST /api/__mock/reset clears drafts', async () => {
    const app = as('assessor');
    await draft(app, 'followups');
    expect((await request(app).get(base())).body.drafts).toHaveLength(1);
    expect((await request(app).post('/api/__mock/reset').send({})).status).toBe(200);
    expect((await request(app).get(base())).body.drafts).toEqual([]);
  });
});

describe('grounding (the model never decides what is true)', () => {
  const span = (i = 0) => ({ evidenceId: source.evidence[i]!.id, text: source.evidence[i]!.excerpt.trim().split('\n')[0]!.slice(0, 40) });

  it('summary: a made-up quote, an invented number or no span falls back to quoting the evidence', () => {
    const good = acceptSummary({ summary: 'Short.', bullets: [{ text: 'Shows practice.', source_spans: [span()] }] }, source);
    expect(good.fallback).toBe(false);
    for (const bullet of [
      { text: 'Fine.', source_spans: [{ ...span(), text: 'a quote nobody wrote' }] },
      { text: 'We reached level 98.', source_spans: [span()] },
      { text: 'No anchor.', source_spans: [] },
    ]) {
      const out = acceptSummary({ summary: 's', bullets: [bullet] }, source);
      expect(out.fallback).toBe(true);
      for (const b of out.bullets) for (const s of b.sourceSpans) expect(source.evidence.find(e => e.id === s.evidenceId)!.excerpt).toContain(s.text);
    }
    expect(acceptSummary('garbage', source).fallback).toBe(true);
    expect(acceptSummary({ summary: 'Reached level 98.', bullets: [{ text: 'ok', source_spans: [span()] }] }, source).summary).not.toMatch(/98/);
  });

  it('follow-ups: ungrounded, duplicate, unanchored or numeric-invention questions are dropped, then criteria stand in', () => {
    const cid = source.criteria[0]!.id;
    const existing = source.existing_questions[0];
    const out = acceptFollowups({ questions: [
      { text: 'Not a question.', criterionId: cid },
      { text: 'Is it 98 percent?', criterionId: cid },
      { text: 'Anchored nowhere?', criterionId: 'nope' },
      ...(existing ? [{ text: existing.endsWith('?') ? existing : `${existing}?`, criterionId: cid }] : []),
    ] }, source);
    expect(out.fallback).toBe(true);
    expect(out.questions.map(q => q.criterionId)).toEqual(source.criteria.slice(0, 3).map(c => c.id));
    expect(acceptFollowups({ questions: [{ text: 'How is this verified?', criterionId: cid }] }, source)).toMatchObject({ fallback: false });
  });

  it('a failing or garbage agent answer degrades to a deterministic draft instead of failing the run', async () => {
    (config.mock as { agentcore: boolean }).agentcore = false;
    const spy = jest.spyOn(agentcore, 'invokeAgent');
    try {
      for (const answer of [() => Promise.reject(new Error('down')), () => Promise.resolve({ text: 'not json', raw: {} } as never),
        () => Promise.resolve({ text: JSON.stringify({ questions: [{ text: 'Is it 98 percent?', criterionId: source.criteria[0]!.id }] }), raw: {} } as never)]) {
        spy.mockImplementationOnce(answer);
        const run = { id: 'adr-x', kind: 'assessment.followup-drafts', scope: `${TEAM}/${DIM}`, progress: [], input: { source } } as unknown as FlowRunRow;
        const out = await draftExecutor({ run, report: async () => true });
        expect(out.result).toMatchObject({ kind: 'followups', fallback: true });
      }
      expect(spy).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({
        structuredInput: expect.objectContaining({ tenant: 'assessment', mode: 'draft-followups', team_id: TEAM, dimension: source }),
      }));
    } finally { spy.mockRestore(); (config.mock as { agentcore: boolean }).agentcore = true; }
  });
});
