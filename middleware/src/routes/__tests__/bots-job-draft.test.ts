// GET / PUT / DELETE /api/bots/work-items/:id/job-draft in dev:mock — the
// dispatch drawer's "Save for later" (schema/work_item_job_drafts_schema.sql,
// 2026-10-28) — through the REAL provider and registered fixture.
//
// Pinned properties: saving starts no run and changes no status, the draft is
// the item's (a second save replaces it, attributed to the second saver), a
// reset takes it away, and a dispatch clears it.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => null), devboxDataClient: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn((opts: { sessionId: string }) => ({ id: 'box-test', sessionId: opts.sessionId })),
  getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { workItemJobDrafts } from '../../mock/work-item-job-drafts.js';
import { deleteJobDraft, getJobDraft } from '../../providers/work-item-job-drafts.js';

// An OPEN, pointed Observability story (Layla's, on the active sprint).
const ITEM = 'wi-obs-e1-s4';
const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const CODEBASE = '11111111-2222-4333-8444-555555555555';

function buildApp(sub = 'u-rachel', role = 'hr-admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

const path = (id = ITEM) => `/api/bots/work-items/${id}/job-draft`;
const put = (app: express.Express, body: object, id = ITEM) => request(app).put(path(id)).send(body);

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('job drafts', () => {
  it('starts empty, saves, reads back, and the item stays OPEN', async () => {
    const app = buildApp();
    expect((await request(app).get(path())).body).toEqual({ draft: null });
    const saved = await put(app, { model: MODEL, budgetPerRunUsd: 2, instruction: 'Remove the bridge; keep the rollback path.', agentProjectId: CODEBASE });
    expect(saved.status).toBe(200);
    expect(saved.body.draft).toMatchObject({
      workItemId: ITEM, model: MODEL, budgetPerRunUsd: 2, instruction: 'Remove the bridge; keep the rollback path.', agentProjectId: CODEBASE,
      savedBy: 'u-rachel', savedByName: 'Rachel Kowalski',
    });
    expect(saved.body.draft.savedAt).toEqual(expect.any(String));
    expect(saved.body.draft.updatedAt).toEqual(expect.any(String));
    expect((await request(app).get(path())).body.draft).toEqual(saved.body.draft);
    // Nothing ran: the item's status is untouched.
    const item = await request(app).post(`/api/bots/work-items/${ITEM}/estimate`).send({ model: MODEL, estimate: { costUsdP75: 0.3 } });
    expect(item.body.item.status).toBe('open');
    // The row is in the registered fixture, so a reset takes it out again.
    expect(workItemJobDrafts.rows()).toHaveLength(1);
    fixtureRegistry.resetAll('default');
    expect((await request(app).get(path())).body).toEqual({ draft: null });
  });

  it('a second save replaces the draft and names the second saver; optional fields default to null', async () => {
    const first = await put(buildApp('u-rachel'), { model: MODEL, instruction: 'v1' });
    expect(first.body.draft).toMatchObject({ budgetPerRunUsd: null, agentProjectId: null, instruction: 'v1' });
    const second = await put(buildApp('u-vera', 'org-leader'), { model: MODEL, instruction: '  ' });
    expect(second.status).toBe(200);
    expect(second.body.draft).toMatchObject({ savedBy: 'u-vera', instruction: null });
    expect(second.body.draft.savedAt).toBe(first.body.draft.savedAt);
    expect(workItemJobDrafts.rows()).toHaveLength(1);
  });

  it('validates the body and refuses an unknown item', async () => {
    const app = buildApp();
    expect((await put(app, { instruction: 'no model' })).status).toBe(400);
    expect((await put(app, { model: MODEL, budgetPerRunUsd: -1 })).status).toBe(400);
    expect((await put(app, { model: MODEL, budgetPerRunUsd: '2' })).status).toBe(400);
    expect((await put(app, { model: MODEL, agentProjectId: 'not-a-uuid' })).status).toBe(400);
    expect((await put(app, { model: MODEL, instruction: 5 })).status).toBe(400);
    expect((await put(app, { model: MODEL, confirmOverEnvelope: true })).status).toBe(400);
    expect((await put(app, { model: MODEL }, 'wi-nope')).status).toBe(404);
    expect((await request(app).get(path('wi-nope'))).status).toBe(404);
    expect(workItemJobDrafts.rows()).toEqual([]);
  });

  it('is scoped to the item\'s initiative: an SME off the initiative is refused, one on it is not', async () => {
    // Caleb (p-013) is an SME on LLM Platform and Inference, not Observability.
    const caleb = buildApp('u-caleb', 'sme');
    const refused = await put(caleb, { model: MODEL });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'NOT_ON_INITIATIVE', initiativeId: 'p-observability' });
    expect((await request(caleb).get(path())).status).toBe(403);
    // Eli (p-011) is an SME on Observability: saving needs no grant, only membership.
    const eli = buildApp('u-eli', 'sme');
    expect((await put(eli, { model: MODEL })).status).toBe(200);
    expect((await request(eli).get(path())).body.draft).toMatchObject({ savedBy: 'u-eli' });
    expect((await request(caleb).delete(path())).status).toBe(403);
  });

  it('DELETE removes it (404 when there is none)', async () => {
    const app = buildApp();
    expect((await request(app).delete(path())).status).toBe(404);
    await put(app, { model: MODEL });
    expect((await request(app).delete(path())).status).toBe(204);
    expect((await request(app).get(path())).body).toEqual({ draft: null });
  });

  it('the provider clears a draft on dispatch (the route calls deleteJobDraft after a run starts)', async () => {
    await put(buildApp(), { model: MODEL });
    expect(await getJobDraft(ITEM)).not.toBeNull();
    expect(await deleteJobDraft(ITEM)).toBe(true);
    expect(await getJobDraft(ITEM)).toBeNull();
    expect(await deleteJobDraft(ITEM)).toBe(false);
  });
});
