// Spend holds at dispatch (DE-34), end to end through the REAL providers in
// dev:mock — the in-process keyed lock stands in for the advisory transaction
// lock the Aurora path takes (providers/spend-holds.ts).
//
// The race this closes: two dispatches on different work items of one
// initiative used to read the same remainder and both pass, because spend
// appeared only when a run settled. Now each dispatch holds its p75 under the
// initiative lock (then the grant's), so the second sees the first's money.

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
import { __setMockDispatchStepMs, reconcileBotRuns, loadEnvelope } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import * as budgetsProvider from '../../providers/budgets.js';
import { getBudget } from '../../providers/budgets.js';
import { initiativeBudgets, budgetGrants } from '../../mock/budgets.js';
import { workItems } from '../../mock/work-items.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { mockHolds, settleHold } from '../../providers/spend-holds.js';
import { recordSpend, mockStoredEntries } from '../../providers/spend-ledger.js';
import { reserveSpend } from '../../lib/spend-holds.js';
import { freezeClock } from '../../mock/core/index.js';
import { exec } from '../../providers/aurora.js';

const OBS = 'p-observability';
// Two open, codebase-delivered, equally sized (3-point) stories on one initiative.
const ITEM_A = 'wi-obs-e2-s3';
const ITEM_B = 'wi-obs-e3-s2';
const MODEL = 'us.amazon.nova-lite-v1:0';

function app(sub: string, role: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq' };
    next();
  });
  a.use('/api/bots', botsRouter);
  a.use(errorHandler);
  return a;
}
const vera = () => app('u-vera', 'org-leader');
const layla = () => app('u-layla', 'sme');
const dispatch = (a: express.Express, workItemId: string, extra: Record<string, unknown> = {}) =>
  request(a).post('/api/bots/dispatch-work').send({ workItemId, model: MODEL, ...extra });

function resetWorld(): void {
  __resetMockRuns();
  spendHolds.reset();
  spendEntries.reset();
  initiativeBudgets.reset();
  budgetGrants.reset();
  workItems.reset();
}

function setAllocation(id: string, allocated: number): void {
  const row = initiativeBudgets.rows().find((b) => b.id === id)!;
  row.allocated = allocated;
}

/** The p75 a dispatch of ITEM_A holds, read off the hold one real dispatch writes. */
async function heldForOneDispatch(): Promise<number> {
  resetWorld();
  setAllocation(OBS, 1_000);
  const res = await dispatch(vera(), ITEM_A);
  expect(res.status).toBe(202);
  const hold = mockHolds().find((h) => h.initiativeId === OBS)!;
  expect(hold).toBeDefined();
  return hold.amountUsd;
}

/** Keep the simulated runs in flight (their holds open) while `fn` runs. */
async function inFlight<T>(fn: () => Promise<T>): Promise<T> {
  __setMockDispatchStepMs(60_000);
  try { return await fn(); } finally { __setMockDispatchStepMs(0); }
}

beforeAll(() => __setMockDispatchStepMs(0));
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => resetWorld());

describe('two concurrent dispatches against money that fits one', () => {
  it('allocation: exactly one 202, the other 409 gate allocation naming the held money', async () => {
    const p75 = await heldForOneDispatch();
    resetWorld();
    const budget = (await getBudget(OBS))!;
    // Room for one p75 and a half — never two.
    setAllocation(OBS, budget.spentThisPeriodUsd + p75 * 1.5);

    const [a, b] = await inFlight(() => Promise.all([dispatch(vera(), ITEM_A), dispatch(vera(), ITEM_B)]));
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body).toMatchObject({ gate: 'allocation', confirmFlag: 'confirmOverAllocation' });
    expect(refused.body.allocation.heldUsd).toBeCloseTo(p75, 4);
    expect(refused.body.error).toMatch(/held by runs in flight/);
  });

  it('envelope: exactly one 202, the other 409 gate envelope', async () => {
    const p75 = await heldForOneDispatch();
    resetWorld();
    setAllocation(OBS, 1_000);
    // Layla's active envelope on Observability, sized for one p75 and a half.
    const before = (await loadEnvelope(OBS, 'u-layla'))!;
    const g = budgetGrants.rows().find((x) => x.id === 'bg-obs-3')!;
    g.allocatedUsd = before.attributedSpentUsd + p75 * 1.5;

    const [a, b] = await inFlight(() => Promise.all([dispatch(layla(), ITEM_A), dispatch(layla(), ITEM_B)]));
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body).toMatchObject({ gate: 'envelope', confirmFlag: 'confirmOverEnvelope', envelope: { grantId: 'bg-obs-3' } });
    expect(refused.body.envelope.heldUsd).toBeCloseTo(p75, 4);
  });

  it('a confirmed-over dispatch still takes a hold, so the next caller sees it', async () => {
    const p75 = await heldForOneDispatch();
    resetWorld();
    const budget = (await getBudget(OBS))!;
    setAllocation(OBS, budget.spentThisPeriodUsd + p75 * 0.5);
    const res = await inFlight(() => dispatch(vera(), ITEM_A, { confirmOverAllocation: true }));
    expect(res.status).toBe(202);
    expect(mockHolds().filter((h) => h.status === 'held')).toEqual([
      expect.objectContaining({ initiativeId: OBS, basis: 'confirmed_over', source: 'bot_run', sourceId: res.body.run.id }),
    ]);
  });
});

describe('a dispatch that fails before its run is live', () => {
  it('leaves no held row (the work item was already claimed)', async () => {
    setAllocation(OBS, 1_000);
    workItems.rows().find((w) => w.id === ITEM_A)!.status = 'in_progress';
    const res = await dispatch(vera(), ITEM_A);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockHolds().filter((h) => h.status === 'held')).toHaveLength(0);
  });
});

describe('settle', () => {
  it('a settled dispatch leaves its hold settled; a retried settle changes nothing', async () => {
    setAllocation(OBS, 1_000);
    const res = await dispatch(vera(), ITEM_A);
    expect(res.status).toBe(202);
    const hold = mockHolds().find((h) => h.sourceId === res.body.run.id)!;
    // The simulated run settled before the response (step 0) with a known cost.
    expect(hold.status).toBe('settled');
    const closedAt = hold.closedAt;
    await settleHold('bot_run', res.body.run.id, exec, true);
    expect(mockHolds().find((h) => h.id === hold.id)).toMatchObject({ status: 'settled', closedAt });
  });

  it('a ledger entry with a known cost settles its hold in the same write; an unknown cost leaves it held', async () => {
    spendEntries.rows().length = 0;
    const known = await reserveSpend({
      initiativeId: OBS, actorId: 'u-vera', source: 'box_task', sourceId: 'box-x:t1',
      forecast: { costUsdP75: 0.4 }, judge: false, expiresInMs: 60_000,
    });
    const unknown = await reserveSpend({
      initiativeId: OBS, actorId: 'u-vera', source: 'box_task', sourceId: 'box-x:t2',
      forecast: { costUsdP75: 0.4 }, judge: false, expiresInMs: 60_000,
    });
    expect(known.kind).toBe('held');
    await recordSpend({ source: 'box_task', sourceId: 'box-x:t1', initiativeId: OBS, boxId: 'box-x', actorId: 'u-vera', model: 'haiku', costUsd: 0.31 });
    await recordSpend({ source: 'box_task', sourceId: 'box-x:t1', initiativeId: OBS, boxId: 'box-x', actorId: 'u-vera', model: 'haiku', costUsd: 0.31 });
    await recordSpend({ source: 'box_task', sourceId: 'box-x:t2', initiativeId: OBS, boxId: 'box-x', actorId: 'u-vera', model: 'haiku', costUsd: null });
    expect(mockStoredEntries().filter((e) => e.sourceId === 'box-x:t1')).toHaveLength(1);
    const byId = (id: string | null) => mockHolds().find((h) => h.id === id)!;
    expect(byId((known as { holdId: string }).holdId).status).toBe('settled');
    expect(byId((unknown as { holdId: string }).holdId).status).toBe('held');
  });
});

describe('unknown cost trips a brake only where someone can confirm it (DE-33)', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  const box = (forecast: number, extra: Record<string, unknown> = {}) => reserveSpend({
    initiativeId: OBS, actorId: null, source: 'box_task', sourceId: `box-x:${forecast}`,
    forecast: { costUsdP75: forecast }, expiresInMs: 60_000, ...extra,
  });

  it('a box task, bot firing or job is held, not refused, when the period only has unknown-cost runs', async () => {
    setAllocation(OBS, 1_000);
    jest.spyOn(budgetsProvider, 'unknownCostCountInPeriod').mockResolvedValue(2);
    const held = await box(0.4);
    expect(held.kind).toBe('held');
    expect(mockHolds().find((h) => h.id === (held as { holdId: string }).holdId)?.status).toBe('held');
  });

  it('the marketplace dispatch (unknownCostTrips) still asks on its own', async () => {
    setAllocation(OBS, 1_000);
    jest.spyOn(budgetsProvider, 'unknownCostCountInPeriod').mockResolvedValue(2);
    const out = await box(0.4, { unknownCostTrips: true });
    expect(out).toMatchObject({ kind: 'confirm', gate: 'allocation', confirmFlag: 'confirmOverAllocation' });
    expect((out as { reason: string }).reason).toContain('no recorded cost');
    expect(await dispatch(vera(), ITEM_A)).toMatchObject({ status: 409 });
  });

  it('a real overrun still refuses a box task, unknown cost or not', async () => {
    setAllocation(OBS, 0.01);
    jest.spyOn(budgetsProvider, 'unknownCostCountInPeriod').mockResolvedValue(2);
    const out = await box(5);
    expect(out).toMatchObject({ kind: 'confirm', gate: 'allocation' });
    expect((out as { reason: string }).reason).not.toContain('no recorded cost');
  });
});

describe('expiry', () => {
  it('a hold past expires_at is expired by the next reconcile tick', async () => {
    let restore = freezeClock('2026-10-29T10:00:00.000Z');
    try {
      const held = await reserveSpend({
        initiativeId: OBS, actorId: null, source: 'bot_run',
        forecast: { costUsdP75: 0.5 }, judge: false, expiresInMs: 35 * 60_000,
      });
      expect(held.kind).toBe('held');
      await reconcileBotRuns();
      expect(mockHolds()[0]!.status).toBe('held');
      restore();
      restore = freezeClock('2026-10-29T10:36:00.000Z');
      await reconcileBotRuns();
      expect(mockHolds()[0]).toMatchObject({ status: 'expired' });
      expect(mockHolds()[0]!.closedAt).toBe('2026-10-29T10:36:00.000Z');
    } finally {
      restore();
    }
  });
});
