// Review-deck routes (docs/assessment-deck-goal.md "API" + "Definition of
// done"): the authz matrix per assessment role, another tenant's 403, CAS on
// baseRevisionId, preview and download shapes, a generation run and an agent
// revise becoming revisions (producedBy = run id) offline, and mock reset.

// Sessions here are hand-built (no directory rows): the deck write rule's fresh
// directory re-read (live-principal.ts) is the identity, its Cedar decisions stay real.
jest.mock('../../lib/live-principal.js', () => ({
  ...jest.requireActual('../../lib/live-principal.js'),
  currentLiveSession: async (session: unknown) => session,
}));
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
// The three assessment roles with their seed actions (seeds/roles/assessment/*.cedar),
// plus a read-only role so "a role without ScoreAssessment" has a subject.
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent', 'ManageSubmissions', 'LabelFeedback', 'Search'] },
    { id: 'lead-assessor', tenant: 'assessment', label: 'Lead Assessor', summary: '', capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent', 'ApproveException', 'PublishReport', 'ManageKnowledge'] },
    { id: 'program-lead', tenant: 'assessment', label: 'Program Lead', summary: '', capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent', 'ManageAssessmentConfig', 'ManageUsers'] },
    { id: 'assessment-reader', tenant: 'assessment', label: 'Reader', summary: '', capabilities: ['ViewAssessment'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['DispatchAgentRun'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import JSZip from 'jszip';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { mockControlRouter } from '../mock-control.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { completeRun, getRun } from '../../providers/assessment.js';
import { mockDeckRunResult } from '../../providers/assessment-decks.js';
import { assessmentDecksFixture, assessmentDeckRevisionsFixture } from '../../mock/assessment-decks.js';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
beforeEach(() => { assessmentDecksFixture.reset(); assessmentDeckRevisionsFixture.reset(); });

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use('/api/assessment', assessmentRouter);
  app.use(mockControlRouter);
  app.use(errorHandler);
  return app;
}

const as = (role: string, sub = `u-${role}`) => appAs({ role: role as Session['role'], tenant: 'assessment', sub });

/** The offline drafter's answer, through the same completion seam a real agent uses. */
async function finishRun(runId: string): Promise<void> {
  const run = (await getRun(runId))!;
  const result = await completeRun(runId, { status: 'completed', deck_result: await mockDeckRunResult(run) });
  expect(result.ok).toBe(true);
}

async function createDeck(app: express.Express, teamId: string): Promise<{ deckId: string; runId: string }> {
  const res = await request(app).post(`/api/assessment/teams/${teamId}/decks`).send({ audience: 'team review' });
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ deckId: expect.stringMatching(/^deck-/), runId: expect.stringMatching(/^run-/) });
  await finishRun(res.body.runId);
  return res.body;
}

describe('review decks — generation and reads', () => {
  it('a generation run becomes revision 1, produced by the run', async () => {
    const app = as('assessor');
    const { deckId, runId } = await createDeck(app, 'TEAM-002');
    const detail = await request(app).get(`/api/assessment/decks/${deckId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: deckId, teamId: 'TEAM-002', lockedSlideIds: [], lastRun: { runId, status: 'completed' } });
    expect(detail.body.pendingRun).toBeUndefined();
    expect(detail.body.revisions).toEqual([{ id: detail.body.activeRevisionId, label: 'Draft by agent', createdAt: expect.any(String), producedBy: runId }]);

    const list = await request(app).get('/api/assessment/decks?teamId=TEAM-002');
    expect(list.body).toEqual([{ id: deckId, teamId: 'TEAM-002', title: detail.body.title, latestRevision: detail.body.revisions[0], updatedAt: expect.any(String) }]);
    expect((await request(app).get('/api/assessment/decks?teamId=TEAM-003')).body).toEqual([]);

    const spec = await request(app).get(`/api/assessment/decks/${deckId}/revisions/${detail.body.activeRevisionId}/spec`);
    expect(spec.status).toBe(200);
    expect(spec.body.slides.filter((s: { id: string }) => s.id.startsWith('dim-')).length).toBe(17);
    expect((await getRun(runId))!.summary).toMatch(/Saved revision 1/);
  });

  it('a pending run shows on the deck until it completes; unknown ids 404', async () => {
    const app = as('assessor');
    const res = await request(app).post('/api/assessment/teams/TEAM-003/decks').send({});
    const pending = await request(app).get(`/api/assessment/decks/${res.body.deckId}`);
    expect(pending.body).toMatchObject({ activeRevisionId: null, revisions: [], pendingRun: { runId: res.body.runId, command: 'draft-review-deck', status: 'running' } });
    await finishRun(res.body.runId);
    expect((await request(app).get('/api/assessment/decks/deck-00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await request(app).get('/api/assessment/decks/not-a-deck')).status).toBe(404);
    expect((await request(app).post('/api/assessment/teams/TEAM-999/decks').send({})).status).toBe(404);
    expect((await request(app).post('/api/assessment/teams/TEAM-004/decks').send({ dimensionIds: ['nope'] })).status).toBe(400);
  });

  it('preview answers one SVG per slide plus the generated Sources slide', async () => {
    const app = as('assessor');
    const { deckId } = await createDeck(app, 'TEAM-004');
    const detail = await request(app).get(`/api/assessment/decks/${deckId}`);
    const spec = (await request(app).get(`/api/assessment/decks/${deckId}/revisions/${detail.body.activeRevisionId}/spec`)).body as DeckSpec;
    const res = await request(app).post(`/api/assessment/decks/${deckId}/preview`).send({ spec });
    expect(res.status).toBe(200);
    expect(res.body.slides).toHaveLength(spec.slides.length + 1);
    expect(res.body.slides[0]).toEqual({ id: 'title', svg: expect.stringMatching(/^<svg/), title: spec.slides[0]!.title });
    expect(res.body.slides.at(-1)).toMatchObject({ id: 'sources', generated: true });
    expect(Array.isArray(res.body.warnings)).toBe(true);
    const bad = await request(app).post(`/api/assessment/decks/${deckId}/preview`).send({ spec: { title: 'x', slides: [{ id: 'a', layout: 'bullets', title: 't', bullets: ['b'], sources: [] }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.join(' ')).toMatch(/cite at least one source/);
  });

  it('download is a .pptx attachment', async () => {
    const app = as('assessor');
    const { deckId } = await createDeck(app, 'TEAM-005');
    const detail = await request(app).get(`/api/assessment/decks/${deckId}`);
    const res = await request(app).get(`/api/assessment/decks/${deckId}/revisions/${detail.body.activeRevisionId}/file`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v1\.pptx"$/);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('presentationml.presentation.main+xml');
  });
});

describe('review decks — revisions, CAS and agent revise', () => {
  it('a person edit appends; a stale baseRevisionId is 409 naming the head', async () => {
    const app = as('assessor');
    const { deckId } = await createDeck(app, 'TEAM-002');
    const head = (await request(app).get(`/api/assessment/decks/${deckId}`)).body.activeRevisionId as string;
    const spec = (await request(app).get(`/api/assessment/decks/${deckId}/revisions/${head}/spec`)).body as DeckSpec;
    spec.slides[0]!.notes = 'Edited by hand.';
    const first = await request(app).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec, baseRevisionId: head, lockedSlideIds: ['title'] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ label: 'Edited', producedBy: 'person:u-assessor' });
    const stale = await request(app).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec, baseRevisionId: head });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'the deck has a newer revision', activeRevisionId: first.body.id });
    const staleRevise = await request(app).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: 'shorter', baseRevisionId: head });
    expect(staleRevise.status).toBe(409);
    const detail = await request(app).get(`/api/assessment/decks/${deckId}`);
    expect(detail.body.lockedSlideIds).toEqual(['title']);
    expect(detail.body.revisions.map((r: { id: string }) => r.id)).toEqual([first.body.id, head]);
    const invalid = await request(app).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec: { title: 'x', slides: [] }, baseRevisionId: first.body.id });
    expect(invalid.status).toBe(400);
  });

  it('an agent revise becomes a revision produced by its run; a locked slide refuses a scoped revise', async () => {
    const app = as('lead-assessor');
    const { deckId } = await createDeck(app, 'TEAM-003');
    const head = (await request(app).get(`/api/assessment/decks/${deckId}`)).body.activeRevisionId as string;
    const res = await request(app).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: 'make the title shorter', slideId: 'executive-summary', baseRevisionId: head });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: expect.stringMatching(/^run-/) });
    await finishRun(res.body.runId);
    const detail = await request(app).get(`/api/assessment/decks/${deckId}`);
    expect(detail.body.revisions[0]).toMatchObject({ producedBy: res.body.runId, label: 'Agent: make the title shorter' });
    const spec = (await request(app).get(`/api/assessment/decks/${deckId}/revisions/${detail.body.activeRevisionId}/spec`)).body as DeckSpec;
    expect(spec.slides.find((s) => s.id === 'executive-summary')!.title).toBe('Executive');

    const lockedSpec = { ...spec };
    const locked = await request(app).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec: lockedSpec, baseRevisionId: detail.body.activeRevisionId, lockedSlideIds: ['next-steps'] });
    expect(locked.status).toBe(201);
    const refused = await request(app).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: 'rewrite', slideId: 'next-steps', baseRevisionId: locked.body.id });
    expect(refused.status).toBe(409);
    expect((await request(app).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: '', baseRevisionId: locked.body.id })).status).toBe(400);
  });

  it('a deck command cannot be launched through the generic POST /runs', async () => {
    const res = await request(as('assessor')).post('/api/assessment/runs').send({ command: 'draft-review-deck', args: {}, team_id: 'TEAM-002' });
    expect(res.status).toBe(400);
  });
});

describe('review decks — authz', () => {
  for (const role of ['assessor', 'lead-assessor', 'program-lead']) {
    it(`${role} can generate, read, save a person edit and revise by agent`, async () => {
      const app = as(role);
      const { deckId } = await createDeck(app, 'TEAM-004');
      const head = (await request(app).get(`/api/assessment/decks/${deckId}`)).body.activeRevisionId as string;
      const spec = (await request(app).get(`/api/assessment/decks/${deckId}/revisions/${head}/spec`)).body;
      const saved = await request(app).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec, baseRevisionId: head });
      expect(saved.status).toBe(201);
      const revise = await request(app).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: 'add a reviewer note', baseRevisionId: saved.body.id });
      expect(revise.status).toBe(202);
      await finishRun(revise.body.runId);
      // An unscoped instruction the drafter applied to one slide changes that slide only.
      expect((await getRun(revise.body.runId))!.summary).toMatch(/Saved revision 3 \(executive-summary\)\.$/);
    });
  }

  it('a role without ScoreAssessment / RunAssessmentAgent can read but not write', async () => {
    const { deckId } = await createDeck(as('assessor'), 'TEAM-005');
    const reader = as('assessment-reader');
    const detail = await request(reader).get(`/api/assessment/decks/${deckId}`);
    expect(detail.status).toBe(200);
    const head = detail.body.activeRevisionId as string;
    const spec = (await request(reader).get(`/api/assessment/decks/${deckId}/revisions/${head}/spec`)).body;
    expect((await request(reader).post(`/api/assessment/decks/${deckId}/preview`).send({ spec })).status).toBe(200);
    expect((await request(reader).get(`/api/assessment/decks/${deckId}/revisions/${head}/file`)).status).toBe(200);
    expect((await request(reader).post(`/api/assessment/decks/${deckId}/revisions`).send({ spec, baseRevisionId: head })).status).toBe(403);
    expect((await request(reader).post(`/api/assessment/decks/${deckId}/revise`).send({ instruction: 'x', baseRevisionId: head })).status).toBe(403);
    expect((await request(reader).post('/api/assessment/teams/TEAM-005/decks').send({})).status).toBe(403);
  });

  it('another tenant gets 403 on every deck route', async () => {
    const { deckId } = await createDeck(as('assessor'), 'TEAM-002');
    const outsider = appAs({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' });
    const rid = 'rev-00000000-0000-0000-0000-000000000000';
    for (const [method, path] of [
      ['get', '/api/assessment/decks'], ['get', `/api/assessment/decks/${deckId}`],
      ['get', `/api/assessment/decks/${deckId}/revisions/${rid}/spec`], ['get', `/api/assessment/decks/${deckId}/revisions/${rid}/file`],
      ['post', `/api/assessment/decks/${deckId}/revisions`], ['post', `/api/assessment/decks/${deckId}/preview`],
      ['post', `/api/assessment/decks/${deckId}/revise`], ['post', '/api/assessment/teams/TEAM-002/decks'],
    ] as const) {
      const res = await request(outsider)[method](path).send({});
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
    }
  });
});

describe('review decks — mock reset', () => {
  it('POST /api/__mock/reset clears decks and revisions created in the session', async () => {
    const app = as('assessor');
    await createDeck(app, 'TEAM-003');
    expect((await request(app).get('/api/assessment/decks')).body).toHaveLength(1);
    const reset = await request(app).post('/api/__mock/reset').send({});
    expect(reset.status).toBe(200);
    expect((await request(app).get('/api/assessment/decks')).body).toEqual([]);
    expect(assessmentDeckRevisionsFixture.rows()).toEqual([]);
  });
});
