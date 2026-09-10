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
//      an explicit confirmation still proceeds
//
// Later waves added two more gates on this route — the caller's own per-run cap
// and their sprint envelope — and split the single confirmOverBudget flag that
// used to answer all of them. The last two sections pin that split.

jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
  dispatchedSpendInWindow: jest.fn(), attributionAvailable: jest.fn(),
}));
// budgets.ts is imported, never edited, by both the route (getBudget) and the
// envelope brake (listGrants) — the SME is stopped by the same envelope figure
// the Budgets page renders.
jest.mock('../../providers/budgets.js', () => ({ getBudget: jest.fn(), listGrants: jest.fn() }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
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
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { runCostSamples, perPointCostSamples } from '../../providers/bots.js';
import { getBudget, listGrants } from '../../providers/budgets.js';
import { getUser } from '../../providers/identity.js';
import { dispatchedSpendInWindow } from '../../providers/bots.js';
import { getWorkItem } from '../../providers/work-items.js';
import { listAgentProjects } from '../../providers/agent-projects.js';
import { dispatchWorkItem } from '../../lib/bot-runner.js';

const runSamples = runCostSamples as unknown as jest.Mock;
const pointSamples = perPointCostSamples as unknown as jest.Mock;
const budget = getBudget as unknown as jest.Mock;
const workItem = getWorkItem as unknown as jest.Mock;
const projects = listAgentProjects as unknown as jest.Mock;
const dispatch = dispatchWorkItem as unknown as jest.Mock;
const grants = listGrants as unknown as jest.Mock;
const user = getUser as unknown as jest.Mock;
const burn = dispatchedSpendInWindow as unknown as jest.Mock;

/** The signed-in caller for a request. The envelope brake resolves the person
 *  from here, so tests that care about envelopes set it. */
let session: { sub: string; role?: string } | null = null;

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
  app.use((req, _res, next) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

function post(body: Record<string, unknown>) {
  return request(buildApp()).post('/api/bots/dispatch-work').send(body);
}

const BODY = { workItemId: 'wi-rag-e1-s2', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' };

/** An active sprint envelope for the caller on this initiative. */
function grant(over: Record<string, unknown> = {}) {
  return {
    id: 'bg-rag-1', orgProjectId: 'p-rag-search', granteePersonId: 'p-008',
    granteeName: 'Layla Hassan', sprintId: 'spr-rag-s1',
    sprintName: 'Sprint 12 — Rerankers', startsOn: '2026-08-10', endsOn: '2026-08-24',
    sprintStatus: 'active', allocatedUsd: 30, grantedBy: 'u-release',
    initiativeSpendInWindowUsd: 4.2, ...over,
  };
}

/** An allocation with room to spare, so a test can isolate a later gate. */
const HEALTHY = { orgProjectId: 'p-rag-search', allocatedUsd: 95, spentThisPeriodUsd: 12 };

beforeEach(() => {
  [runSamples, pointSamples, budget, workItem, projects, dispatch, grants, user, burn]
    .forEach((m) => m.mockReset());
  session = { sub: 'u-layla' };
  user.mockResolvedValue({ id: 'u-layla', displayName: 'Layla Hassan', personId: 'p-008', grants: {} });
  // No envelope by default: most of this file predates the brake and must keep
  // testing exactly what it tested.
  grants.mockResolvedValue([]);
  burn.mockResolvedValue({ spentUsd: 0, attributionAvailable: false });
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
    expect(res.body.error).toMatch(/confirmOverAllocation/);
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

// ─── 5. One flag per fence ───────────────────────────────────────────────────
//
// Three soft gates, three different limits, three different people who set
// them. They used to share one `confirmOverBudget`, defended by a comment
// saying the portal never sent budgetPerRunUsd — which was true, and was
// exactly why the per-run gate could never be wired to the portal: the moment a
// client sends both, one click silently answers two questions the operator was
// shown one of. These pin that each confirmation opens its own gate and no
// other.

describe('the confirmation flags are split', () => {
  // The prior forecast is $0.15–$1.50, so a $0.50 cap is over and a healthy
  // allocation is not — one gate at a time.
  const CAPPED = { ...BODY, budgetPerRunUsd: 0.5 };

  it("brakes on the caller's own per-run cap, naming the flag that opens it", async () => {
    budget.mockResolvedValue(HEALTHY);
    const res = await post(CAPPED);
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('run-budget');
    expect(res.body.confirmFlag).toBe('confirmOverRunBudget');
    expect(res.body.error).toMatch(/confirmOverRunBudget/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('confirmOverRunBudget opens the per-run gate and NOTHING else', async () => {
    // Tight allocation behind it: confirming the personal cap must leave the
    // initiative's allocation still asking.
    const res = await post({ ...CAPPED, confirmOverRunBudget: true });
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('allocation');
    expect(res.body.confirmFlag).toBe('confirmOverAllocation');
  });

  it('confirmOverAllocation does not open the per-run gate', async () => {
    budget.mockResolvedValue(HEALTHY);
    const res = await post({ ...CAPPED, confirmOverAllocation: true });
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('run-budget');
  });

  it('confirmOverAllocation opens the allocation gate', async () => {
    expect((await post({ ...BODY, confirmOverAllocation: true })).status).toBe(202);
  });

  // Nothing that predates the split may break.
  describe('the deprecated confirmOverBudget synonym', () => {
    it('still confirms BOTH of the gates it used to answer', async () => {
      const res = await post({ ...CAPPED, confirmOverBudget: true });
      expect(res.status).toBe(202);
      expect(dispatch).toHaveBeenCalled();
    });

    it('does not confirm the sprint envelope — that gate postdates the flag', async () => {
      budget.mockResolvedValue(HEALTHY);
      grants.mockResolvedValue([grant()]);
      burn.mockResolvedValue({ spentUsd: 29, attributionAvailable: true });
      const res = await post({ ...BODY, confirmOverBudget: true });
      expect(res.status).toBe(409);
      expect(res.body.gate).toBe('envelope');
      expect(res.body.confirmFlag).toBe('confirmOverEnvelope');
    });
  });

  it('confirmOverEnvelope opens the envelope gate', async () => {
    budget.mockResolvedValue(HEALTHY);
    grants.mockResolvedValue([grant()]);
    burn.mockResolvedValue({ spentUsd: 29, attributionAvailable: true });
    expect((await post({ ...BODY, confirmOverEnvelope: true })).status).toBe(202);
  });
});

// Each 409 must be machine-distinguishable, because the portal renders a
// different dialog for each and a wrong one asks the operator to confirm a
// fence they were never shown.
describe('the four 409s are distinguishable', () => {
  it('the codebase picker carries options and no money at all', async () => {
    projects.mockResolvedValue([REPO, OTHER]);
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.options).toHaveLength(2);
    expect(res.body.gate).toBeUndefined();
    expect(res.body.runBudget).toBeUndefined();
    expect(res.body.allocation).toBeUndefined();
    expect(res.body.envelope).toBeUndefined();
  });

  it('the per-run 409 carries runBudget only', async () => {
    budget.mockResolvedValue(HEALTHY);
    const res = await post({ ...BODY, budgetPerRunUsd: 0.5 });
    expect(res.body.runBudget).toEqual({
      budgetPerRunUsd: 0.5, costUsdP25: 0.15, costUsdP75: 1.5,
    });
    expect(res.body.estimate).toMatchObject({ confidence: 'prior' });
    expect(res.body.allocation).toBeUndefined();
    expect(res.body.envelope).toBeUndefined();
  });

  it('the allocation 409 carries allocation only', async () => {
    const res = await post(BODY);
    expect(res.body.gate).toBe('allocation');
    expect(res.body.allocation).toMatchObject({ allocatedUsd: 5, spentUsd: 4.2 });
    expect(res.body.runBudget).toBeUndefined();
    expect(res.body.envelope).toBeUndefined();
  });

  it('the envelope 409 carries envelope only, and says what the burn is', async () => {
    budget.mockResolvedValue(HEALTHY);
    grants.mockResolvedValue([grant()]);
    burn.mockResolvedValue({ spentUsd: 29, attributionAvailable: true });
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('envelope');
    expect(res.body.envelope).toEqual({
      orgProjectId: 'p-rag-search',
      grantId: 'bg-rag-1',
      sprintId: 'spr-rag-s1',
      sprintName: 'Sprint 12 — Rerankers',
      allocatedUsd: 30,
      // Named for what it is — the runs recorded as dispatched by this caller,
      // never the initiative's spend in the window.
      attributedSpentUsd: 29,
      remainingUsd: 1,
      attributionAvailable: true,
    });
    expect(res.body.error).toMatch(/counting only runs recorded as dispatched by you/);
    expect(res.body.allocation).toBeUndefined();
    expect(res.body.runBudget).toBeUndefined();
  });

  it('asks about the initiative before the person — allocation, then envelope', async () => {
    // Both would refuse. The initiative running out of money is the more
    // fundamental fact, so it is the one the operator hears first.
    grants.mockResolvedValue([grant()]);
    burn.mockResolvedValue({ spentUsd: 30, attributionAvailable: true });
    expect((await post(BODY)).body.gate).toBe('allocation');
  });
});

// ─── 6. The sprint envelope, enforced ────────────────────────────────────────
//
// budget_grants rendered on the Budgets page and nothing checked it. What the
// brake must and must not do at the route level.

describe('the sprint envelope brake', () => {
  beforeEach(() => { budget.mockResolvedValue(HEALTHY); });

  it("does not brake someone with no grant here — that is the allocation's job", async () => {
    grants.mockResolvedValue([]);
    expect((await post(BODY)).status).toBe(202);
  });

  it("ignores other people's envelopes", async () => {
    grants.mockResolvedValue([grant({ granteePersonId: 'p-999', allocatedUsd: 1 })]);
    burn.mockResolvedValue({ spentUsd: 0, attributionAvailable: true });
    expect((await post(BODY)).status).toBe(202);
  });

  it('ignores an envelope whose sprint is over', async () => {
    grants.mockResolvedValue([grant({ sprintStatus: 'done', allocatedUsd: 1 })]);
    burn.mockResolvedValue({ spentUsd: 0, attributionAvailable: true });
    expect((await post(BODY)).status).toBe(202);
  });

  it('honours a standing initiative-level grant (no sprint, unbounded window)', async () => {
    grants.mockResolvedValue([grant({ sprintId: null, sprintName: null, sprintStatus: null, allocatedUsd: 1 })]);
    burn.mockResolvedValue({ spentUsd: 0.5, attributionAvailable: true });
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/your \$1\.00 sprint envelope/);
  });

  it('burns the envelope down against the sprint window, by subject', async () => {
    grants.mockResolvedValue([grant()]);
    burn.mockResolvedValue({ spentUsd: 29, attributionAvailable: true });
    await post(BODY);
    expect(burn).toHaveBeenCalledWith({
      orgProjectId: 'p-rag-search', dispatchedBy: 'u-layla',
      startsOn: '2026-08-10', endsOn: '2026-08-24',
    });
  });

  it('does not brake a caller with no person behind their login', async () => {
    // A platform operator is not an SME; app_users.person_id is null for them,
    // so there is nobody whose envelope this could be.
    user.mockResolvedValue({ id: 'u-operator', displayName: 'Platform Operator', personId: null, grants: {} });
    grants.mockResolvedValue([grant({ allocatedUsd: 0.01 })]);
    expect((await post(BODY)).status).toBe(202);
  });

  it('does not brake an unauthenticated caller', async () => {
    session = null;
    grants.mockResolvedValue([grant({ allocatedUsd: 0.01 })]);
    expect((await post(BODY)).status).toBe(202);
    expect(grants).not.toHaveBeenCalled();
  });

  // ── Schema tolerance ──────────────────────────────────────────────────────
  // The migration ships separately, so the brake must run on a cluster where
  // bot_runs has no dispatched_by yet — and must treat the burn as UNKNOWN,
  // never as zero headroom it can spend.
  describe('before the attribution column exists', () => {
    beforeEach(() => { burn.mockResolvedValue({ spentUsd: 0, attributionAvailable: false }); });

    it('lets a forecast that fits the whole envelope through', async () => {
      grants.mockResolvedValue([grant({ allocatedUsd: 30 })]);
      expect((await post(BODY)).status).toBe(202);
    });

    it('still brakes a forecast bigger than the envelope itself', async () => {
      grants.mockResolvedValue([grant({ allocatedUsd: 1 })]);
      const res = await post(BODY);
      expect(res.status).toBe(409);
      expect(res.body.gate).toBe('envelope');
      expect(res.body.envelope.attributionAvailable).toBe(false);
      expect(res.body.error).toMatch(/no run here is recorded as dispatched by anyone yet/);
    });
  });

  it('degrades to no brake when the envelope cannot be read at all', async () => {
    // A brake that cannot read its own inputs must not become a refusal — the
    // allocation brake is still standing behind it.
    grants.mockRejectedValue(new Error('relation "budget_grants" does not exist'));
    expect((await post(BODY)).status).toBe(202);
  });
});

// ─── 7. Grant-scoped authorization runs before shape (sme.md defect #3) ──────
//
// The gates used to run the other way round: preflightWorkItem (shape +
// codebase resolution) answered first, so an SME with no grant here heard "no
// codebase delivers this initiative — link one in Codebases" (a refusal for a
// reason they cannot act on, and pointing them at a page — /admin/projects —
// that redirects every non-hr-admin role away) instead of the actual reason
// they were refused. Grant-scoped authorization now runs first, and the
// no-codebase message itself is role-aware.

describe('grant-scoped authorization runs before the codebase preflight', () => {
  beforeEach(() => {
    projects.mockResolvedValue([]); // no codebase delivers this initiative
  });

  it('403s an ungranted sme instead of answering the codebase 400', async () => {
    session = { sub: 'u-layla', role: 'sme' };
    grants.mockResolvedValue([]); // no grant at all
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no active sprint grant/);
    expect(res.body.error).not.toMatch(/codebase/);
  });

  it('lets a granted sme through to the (still role-aware) codebase refusal', async () => {
    session = { sub: 'u-layla', role: 'sme' };
    grants.mockResolvedValue([grant()]); // active grant on this initiative
    const res = await post(BODY);
    expect(res.status).toBe(400);
    // sme cannot open /admin/projects (hr-admin only) — do not send them there.
    expect(res.body.error).toBe(
      'no codebase delivers this initiative — ask a program owner to link a codebase in Codebases',
    );
  });

  it('org-leader needs no grant, but still hears the role-aware codebase message', async () => {
    session = { sub: 'u-release', role: 'org-leader' };
    const res = await post(BODY);
    expect(res.status).toBe(400);
    // org-leader cannot open /admin/projects either (hr-admin only).
    expect(res.body.error).toBe(
      'no codebase delivers this initiative — ask a program owner to link a codebase in Codebases',
    );
  });

  it('hr-admin — who CAN open Codebases — gets the original, actionable message', async () => {
    session = { sub: 'u-rachel', role: 'hr-admin' };
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no codebase delivers this initiative — link one in Codebases');
  });

  it('a request with no role at all (unknown/absent) keeps the original message', async () => {
    session = { sub: 'u-layla' };
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no codebase delivers this initiative — link one in Codebases');
  });
});
