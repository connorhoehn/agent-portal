// POST /api/bots/dispatch-work — the gates between an operator clicking
// Authorize and an agent spending money, in the order they must be asked.
//
// This exists because the initiative allocation brake could not fire in a real
// deployment. It only ran when a per-point (size-scaled) forecast existed, and
// that needs >=3 completed runs bound to sized work items; with none of those,
// GET /api/bots/estimate answered `scaled:false` and the brake was skipped
// outright. So the FIRST dispatches against an initiative — no history, and
// the best chance of blowing a small allocation — went through unchecked, and
// the brake only woke up once it was needed least. What is pinned here:
//
//   1. a first, historyless dispatch against a small allocation is braked
//   2. the refusal says how much the forecast it braked on is worth
//   3. shape refusals come before any question about money
//   4. the two deliberate non-brakes survive: unbudgeted stays unbraked, and
//      an explicit confirmOverBudget still proceeds

jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// config.ts uses import.meta, which the CJS test transform cannot compile; the
// rest of these keep bot-runner loadable so its real pure decisions can run.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(), devboxDataClient: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({ registerBox: jest.fn(), getBoxBySession: jest.fn() }));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));
jest.mock('../../providers/agent-jobs.js', () => ({ enqueueJob: jest.fn() }));

jest.mock('../../providers/bots.js', () => ({
  listBots: jest.fn(), getBot: jest.fn(), createBot: jest.fn(), updateBot: jest.fn(),
  deleteBot: jest.fn(), setPausedReason: jest.fn(), listBotRuns: jest.fn(),
  listMarketplaceRuns: jest.fn(), createBotRun: jest.fn(), finalizeBotRun: jest.fn(),
  markBotRan: jest.fn(), countRunningRuns: jest.fn(),
  runCostSamples: jest.fn(), perPointCostSamples: jest.fn(),
}));
jest.mock('../../providers/budgets.js', () => ({ getBudget: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({
  getWorkItem: jest.fn(), updateWorkItem: jest.fn(), addWorkItemComment: jest.fn(),
}));
jest.mock('../../providers/agent-projects.js', () => ({
  listAgentProjects: jest.fn(), getAgentProject: jest.fn(),
  buildCloneCommand: jest.fn(), markCloned: jest.fn(),
}));

// Everything except the actual dispatch is real — the brake under test lives
// in decideAllocation and the ordering in preflightWorkItem.
jest.mock('../../lib/bot-runner.js', () => ({
  ...jest.requireActual('../../lib/bot-runner.js'),
  dispatchWorkItem: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { runCostSamples, perPointCostSamples } from '../../providers/bots.js';
import { getBudget } from '../../providers/budgets.js';
import { getWorkItem } from '../../providers/work-items.js';
import { listAgentProjects } from '../../providers/agent-projects.js';
import { dispatchWorkItem } from '../../lib/bot-runner.js';

const runSamples = runCostSamples as unknown as jest.Mock;
const pointSamples = perPointCostSamples as unknown as jest.Mock;
const budget = getBudget as unknown as jest.Mock;
const workItem = getWorkItem as unknown as jest.Mock;
const projects = listAgentProjects as unknown as jest.Mock;
const dispatch = dispatchWorkItem as unknown as jest.Mock;

const REPO = { id: '11111111-2222-3333-4444-555555555555', repoFullName: 'org/rag-search', orgProjectId: 'p-rag-search' };
const OTHER = { id: '66666666-7777-8888-9999-000000000000', repoFullName: 'org/rag-index', orgProjectId: 'p-rag-search' };

/** A sized, open story on p-rag-search — the seed's $5 initiative. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'wi-rag-e1-s2', projectId: 'p-rag-search', type: 'story', status: 'open',
    title: 'Rerank with a cross-encoder', description: null, labels: [], storyPoints: 5,
    ...over,
  };
}

/** The seeded allocation: $5 a month, most of it already spent. */
function allocation(over: Record<string, unknown> = {}) {
  return { orgProjectId: 'p-rag-search', allocatedUsd: 5, spentThisPeriodUsd: 4.2, ...over };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

function post(body: Record<string, unknown>) {
  return request(buildApp()).post('/api/bots/dispatch-work').send(body);
}

const BODY = { workItemId: 'wi-rag-e1-s2', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' };

beforeEach(() => {
  [runSamples, pointSamples, budget, workItem, projects, dispatch].forEach((m) => m.mockReset());
  // The deployment as audited: 87 completed runs, none bound to a sized work
  // item, so neither estimator has a single sample to draw on.
  runSamples.mockResolvedValue(null);
  pointSamples.mockResolvedValue(null);
  workItem.mockResolvedValue(item());
  projects.mockResolvedValue([REPO]);
  budget.mockResolvedValue(allocation());
  dispatch.mockResolvedValue({ ok: true, run: { id: 'run-1' } });
});

// ─── 1. The brake fires on a first, historyless dispatch ─────────────────────

describe('the allocation brake with no history at all', () => {
  it('refuses a first dispatch against a small allocation', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.allocation).toEqual({
      orgProjectId: 'p-rag-search', allocatedUsd: 5, spentUsd: 4.2,
      remainingUsd: expect.closeTo(0.8, 5) as number,
    });
    // Nothing ran: refused before any dispatch side effect.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('says what the forecast it braked on is worth', async () => {
    const res = await post(BODY);
    // The forecast is a prior — the widest thing we have — and the refusal
    // says so instead of quoting a number it cannot defend.
    expect(res.body.confidence).toBe('prior');
    expect(res.body.estimate).toMatchObject({ basis: 'prior', scaled: false, confidence: 'prior', points: 5 });
    expect(res.body.error).toMatch(/no history for this model yet/);
    expect(res.body.error).toMatch(/\$0\.15–\$1\.50/);
    expect(res.body.error).toMatch(/confirmOverBudget/);
  });

  it('brakes an UNPOINTED item too — an unsized story still spends money', async () => {
    workItem.mockResolvedValue(item({ storyPoints: null }));
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.estimate).toMatchObject({ points: null, scaled: false });
  });

  it('proceeds when the same forecast fits a healthy allocation', async () => {
    budget.mockResolvedValue(allocation({ allocatedUsd: 95, spentThisPeriodUsd: 12 }));
    const res = await post(BODY);
    expect(res.status).toBe(202);
    expect(dispatch).toHaveBeenCalled();
  });
});

// ─── 2. The two deliberate non-brakes ────────────────────────────────────────

describe('what the brake must NOT do', () => {
  it('leaves an unbudgeted initiative alone — unbudgeted is not zero-budget', async () => {
    budget.mockResolvedValue(null);
    expect((await post(BODY)).status).toBe(202);
    budget.mockResolvedValue(allocation({ allocatedUsd: null }));
    expect((await post(BODY)).status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('stays soft — an explicit confirmation dispatches', async () => {
    const res = await post({ ...BODY, confirmOverBudget: true });
    expect(res.status).toBe(202);
    expect(dispatch).toHaveBeenCalled();
  });
});

// ─── 3. Shape before money ───────────────────────────────────────────────────

describe('gate ordering', () => {
  // The interrogation nobody should sit through: "confirm you want to spend
  // over budget" → operator confirms → "a done work item cannot be dispatched".
  it('refuses a done work item outright, never as an over-budget confirmation', async () => {
    workItem.mockResolvedValue(item({ status: 'done' }));
    budget.mockResolvedValue(allocation({ spentThisPeriodUsd: 99 }));
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/done work item cannot be dispatched/);
    expect(res.body.allocation).toBeUndefined();
    // The allocation was never even read — there was nothing to price.
    expect(budget).not.toHaveBeenCalled();
  });

  it('refuses an epic before pricing it', async () => {
    workItem.mockResolvedValue(item({ type: 'epic' }));
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/epics roll up/);
    expect(budget).not.toHaveBeenCalled();
  });

  it('404s a missing work item before pricing it', async () => {
    workItem.mockResolvedValue(null);
    expect((await post(BODY)).status).toBe(404);
    expect(budget).not.toHaveBeenCalled();
  });

  it('asks which codebase before asking about money', async () => {
    projects.mockResolvedValue([REPO, OTHER]);
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.options).toHaveLength(2);
    // Not the budget 409 — the operator has one question at a time.
    expect(res.body.allocation).toBeUndefined();
    expect(budget).not.toHaveBeenCalled();
  });

  it('prices against the codebase the preflight resolved, not only a named one', async () => {
    // No agentProjectId in the body, one codebase delivers the initiative:
    // the repo-scoped samples must still be asked for by id.
    await post(BODY);
    expect(runSamples).toHaveBeenCalledWith(BODY.model, REPO.id);
  });
});

// ─── 4. The estimator and the brake agree ────────────────────────────────────

describe('GET /api/bots/estimate', () => {
  it('reports the same confidence the brake acts on', async () => {
    const res = await request(buildApp())
      .get('/api/bots/estimate')
      .query({ model: BODY.model, points: 8 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ basis: 'prior', scaled: false, confidence: 'prior', points: 8 });
  });
});
