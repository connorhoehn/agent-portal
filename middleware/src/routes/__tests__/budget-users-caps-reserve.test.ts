// User budgets (DE-54), hard caps + fail closed (DE-36) and the maintenance
// reserve (DE-55), end to end through the REAL providers in dev:mock: the
// registered fixtures, the in-process keyed lock standing in for the advisory
// locks, and the one chokepoint (lib/spend-holds.ts reserveSpend) reached
// through the real routes.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
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
import { botsRouter, __resetLegacyConfirmWarning } from '../bots.js';
import { budgetsRouter } from '../budgets.js';
import { grantsRouter } from '../grants.js';
import { userBudgetsRouter } from '../user-budgets.js';
import { meSpendRouter } from '../me-spend.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs, loadEnvelope } from '../../lib/bot-runner.js';
import { __resetMockRuns, mockAllRuns } from '../../providers/bots.js';
import * as budgetsProvider from '../../providers/budgets.js';
import * as userBudgetsProvider from '../../providers/user-budgets.js';
import { getBudget } from '../../providers/budgets.js';
import { userSpendThisPeriod } from '../../providers/user-budgets.js';
import { initiativeBudgets, budgetGrants } from '../../mock/budgets.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { bots } from '../../mock/bots.js';
import { workItems } from '../../mock/work-items.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { mockHolds } from '../../providers/spend-holds.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { reserveSpend } from '../../lib/spend-holds.js';

const OBS = 'p-observability';
const COST = 'p-cost-opt';
const ITEM_A = 'wi-obs-e2-s3';
const ITEM_B = 'wi-obs-e3-s2';
const MODEL = 'us.amazon.nova-lite-v1:0';
const OBS_BOT = '32970d0a-e28e-5100-8fb0-a5cbb87dac99';

function app(sub: string, role: string, act?: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq', ...(act ? { act: { sub: act } } : {}) };
    next();
  });
  a.use('/api/bots', botsRouter);
  a.use('/api/budgets', budgetsRouter);
  a.use('/api/grants', grantsRouter);
  a.use('/api/user-budgets', userBudgetsRouter);
  a.use('/api/me/spend', meSpendRouter);
  a.use(errorHandler);
  return a;
}
const vera = () => app('u-vera', 'org-leader');
const layla = () => app('u-layla', 'sme');
const release = () => app('u-release', 'org-leader');
const dispatch = (a: express.Express, workItemId: string, extra: Record<string, unknown> = {}) =>
  request(a).post('/api/bots/dispatch-work').send({ workItemId, model: MODEL, ...extra });
const ALL_FLAGS = { confirmOverAllocation: true, confirmOverEnvelope: true, confirmOverUserBudget: true, confirmOverBudget: true, confirmOverRunBudget: true };

function resetWorld(): void {
  __resetMockRuns();
  spendHolds.reset();
  spendEntries.reset();
  initiativeBudgets.reset();
  budgetGrants.reset();
  userBudgets.reset();
  bots.reset();
  workItems.reset();
}
function budgetRow(id: string) { return initiativeBudgets.rows().find((b) => b.id === id)!; }
function setAllocation(id: string, allocated: number, extra: Partial<ReturnType<typeof budgetRow>> = {}): void {
  Object.assign(budgetRow(id), { allocated, ...extra });
}
function setUserBudget(userId: string, allocatedUsd: number, hardCapUsd: number | null = null): void {
  const rows = userBudgets.rows();
  const at = rows.findIndex((r) => r.userId === userId);
  const row = { userId, allocatedUsd, hardCapUsd, note: null, setBy: 'u-release' };
  if (at < 0) rows.push(row); else rows[at] = row;
}
const openHolds = () => mockHolds().filter((h) => h.status === 'held');

/** The p75 one dispatch of ITEM_A holds, read off a real dispatch's hold. */
async function p75(): Promise<number> {
  resetWorld();
  setAllocation(OBS, 1_000);
  const res = await dispatch(vera(), ITEM_A);
  expect(res.status).toBe(202);
  const amount = mockHolds().find((h) => h.initiativeId === OBS)!.amountUsd;
  resetWorld();
  return amount;
}

async function inFlight<T>(fn: () => Promise<T>): Promise<T> {
  __setMockDispatchStepMs(60_000);
  try { return await fn(); } finally { __setMockDispatchStepMs(0); }
}

let P75 = 0;
beforeAll(async () => { __setMockDispatchStepMs(0); P75 = await p75(); expect(P75).toBeGreaterThan(0); });
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => { resetWorld(); setAllocation(OBS, 1_000); setAllocation(COST, 1_000); });
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env['BUDGET_FAIL_CLOSED'];
  delete process.env['MAINTENANCE_RESERVE'];
});

// ─── DE-54 user budgets ──────────────────────────────────────────────────────

describe('DE-54: the write route', () => {
  it('a ManageBudgets holder sets another user\'s budget; the response carries the cap enforced and the burn', async () => {
    const res = await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 40, note: 'org-leader agent spend' });
    expect(res.status).toBe(200);
    const spent = (await userSpendThisPeriod('u-vera')).spentUsd;
    expect(res.body.budget).toMatchObject({
      userId: 'u-vera', period: 'monthly', allocatedUsd: 40, hardCapUsd: null, effectiveHardCapUsd: 50, hardCapSource: 'factor',
      spentUsd: spent, heldUsd: 0, setBy: 'u-release', note: 'org-leader agent spend',
    });
    expect(res.body.budget.remainingUsd).toBeCloseTo(40 - spent, 4);
    expect(userBudgets.rows().find((r) => r.userId === 'u-vera')).toMatchObject({ allocatedUsd: 40, setBy: 'u-release' });
  });

  it('a user never sets or removes their own budget, nor does the real identity behind a masquerade', async () => {
    expect((await request(vera()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 999 })).body).toMatchObject({ gate: 'self-budget' });
    expect((await request(app('u-nora', 'sme', 'u-vera')).put('/api/user-budgets/u-vera').send({ allocatedUsd: 999 })).status).toBe(403);
    setUserBudget('u-vera', 5);
    expect((await request(vera()).delete('/api/user-budgets/u-vera')).status).toBe(403);
    expect(userBudgets.rows().find((r) => r.userId === 'u-vera')?.allocatedUsd).toBe(5);
  });

  it('validates: cap below the allocation 400, a stored cap must clear a raised allocation, unknown user 404', async () => {
    expect((await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 10, hardCapUsd: 9 })).status).toBe(400);
    expect((await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 10, hardCapUsd: 12 })).status).toBe(200);
    expect((await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 20 })).status).toBe(400);
    expect((await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: 20, hardCapUsd: null })).body.budget.effectiveHardCapUsd).toBe(25);
    expect((await request(release()).put('/api/user-budgets/u-nobody').send({ allocatedUsd: 1 })).status).toBe(404);
    expect((await request(release()).put('/api/user-budgets/u-vera').send({ allocatedUsd: '5' })).status).toBe(400);
  });

  it('DELETE removes a row; a second DELETE is 404', async () => {
    setUserBudget('u-vera', 5);
    expect((await request(release()).delete('/api/user-budgets/u-vera')).status).toBe(200);
    expect((await request(release()).delete('/api/user-budgets/u-vera')).status).toBe(404);
  });

  it('the list shows every budget and every user spending without one (the blind spot)', async () => {
    const res = await request(release()).get('/api/user-budgets');
    expect(res.status).toBe(200);
    const byId = new Map((res.body.budgets as Array<{ userId: string; allocatedUsd: number | null; spentUsd: number }>).map((b) => [b.userId, b]));
    expect(byId.get('u-nora')).toMatchObject({ allocatedUsd: 25 });
    const blind = [...byId.values()].filter((b) => b.allocatedUsd == null);
    expect(blind.length).toBeGreaterThan(0);
    for (const b of blind) expect(b.spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/me/spend carries the caller\'s budget, or null when none is set', async () => {
    const nora = await request(app('u-nora', 'sme')).get('/api/me/spend');
    expect(nora.body.budget).toMatchObject({ userId: 'u-nora', allocatedUsd: 25, effectiveHardCapUsd: 31.25, period: 'monthly' });
    expect(typeof nora.body.budget.remainingUsd).toBe('number');
    expect((await request(vera()).get('/api/me/spend')).body.budget).toBeNull();
  });
});

describe('DE-54: the user budget in every hold', () => {
  it('a dispatch over the user\'s remainder answers 409 user-budget; confirmOverUserBudget dispatches and holds confirmed_over', async () => {
    const spent = (await userSpendThisPeriod('u-vera')).spentUsd;
    setUserBudget('u-vera', spent + P75 * 0.5, spent + P75 * 10);
    const refused = await dispatch(vera(), ITEM_A);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      gate: 'user-budget', confirmFlag: 'confirmOverUserBudget',
      userBudget: { userId: 'u-vera', period: 'monthly', heldUsd: 0, hardCapUsd: spent + P75 * 10 },
    });
    expect(refused.body.userBudget.remainingUsd).toBeCloseTo(P75 * 0.5, 4);
    expect(refused.body.allocation).toBeUndefined();
    expect(openHolds()).toHaveLength(0);

    const ok = await inFlight(() => dispatch(vera(), ITEM_A, { confirmOverUserBudget: true }));
    expect(ok.status).toBe(202);
    expect(openHolds()).toEqual([expect.objectContaining({ actorId: 'u-vera', basis: 'confirmed_over' })]);
  });

  it('the user cap refuses with 403 user-cap whatever is confirmed, starting nothing', async () => {
    const spent = (await userSpendThisPeriod('u-vera')).spentUsd;
    setUserBudget('u-vera', spent + P75 * 0.5, spent + P75 * 0.8);
    const runsBefore = mockAllRuns().length;
    const res = await dispatch(vera(), ITEM_A, ALL_FLAGS);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'user-cap', userBudget: { userId: 'u-vera' } });
    expect(res.body.capUsd).toBeCloseTo(spent + P75 * 0.8, 4);
    expect(res.body.amountUsd).toBeCloseTo(P75, 4);
    expect(res.body.confirmFlag).toBeUndefined();
    expect(openHolds()).toHaveLength(0);
    expect(mockAllRuns()).toHaveLength(runsBefore);
  });

  it('the user budget spans initiatives: spend on one is judged on another', async () => {
    const before = (await userSpendThisPeriod('u-vera')).spentUsd;
    await recordSpend({ source: 'box_task', sourceId: 'box-cost:1', initiativeId: COST, boxId: 'box-cost', actorId: 'u-vera', model: 'haiku', costUsd: 3 });
    setUserBudget('u-vera', before + 3 + P75 * 0.5, 1_000);
    const res = await dispatch(vera(), ITEM_A);
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('user-budget');
    expect(res.body.userBudget.spentUsd).toBeCloseTo(before + 3, 4);
  });

  it('two concurrent holds on DIFFERENT initiatives serialise on the user lock: one fits, one is braked', async () => {
    const spent = (await userSpendThisPeriod('u-vera')).spentUsd;
    setUserBudget('u-vera', spent + 1.5, 1_000);
    const hold = (pid: string, i: number) => reserveSpend({
      initiativeId: pid, actorId: 'u-vera', source: 'box_task', sourceId: `box-u:${i}`,
      forecast: { costUsdP75: 1 }, expiresInMs: 60_000,
    });
    const out = await Promise.all([hold(OBS, 1), hold(COST, 2)]);
    expect(out.map((o) => o.kind).sort()).toEqual(['confirm', 'held']);
    expect(out.find((o) => o.kind === 'confirm')).toMatchObject({ gate: 'user-budget' });
  });

  it('unattributed spend is held against the spender\'s user budget, and unheld for a user with none', async () => {
    const spent = (await userSpendThisPeriod('u-vera')).spentUsd;
    setUserBudget('u-vera', spent + 1, 1_000);
    const held = await reserveSpend({ initiativeId: null, actorId: 'u-vera', source: 'box_task', sourceId: 'box-none:1', forecast: { costUsdP75: 0.6 }, expiresInMs: 60_000 });
    expect(held).toMatchObject({ kind: 'held', initiativeId: null });
    expect((held as { holdId: string | null }).holdId).not.toBeNull();
    const over = await reserveSpend({ initiativeId: null, actorId: 'u-vera', source: 'box_task', sourceId: 'box-none:2', forecast: { costUsdP75: 0.6 }, expiresInMs: 60_000 });
    expect(over).toMatchObject({ kind: 'confirm', gate: 'user-budget' });
    const none = await reserveSpend({ initiativeId: null, actorId: 'u-layla', source: 'box_task', sourceId: 'box-none:3', forecast: { costUsdP75: 0.6 }, expiresInMs: 60_000 });
    expect(none).toMatchObject({ kind: 'held', holdId: null });
  });

  it('cron spend never charges a user: an essential firing ignores the user budget', async () => {
    setUserBudget('u-vera', 0, 0);
    const out = await reserveSpend({ initiativeId: OBS, actorId: 'u-vera', source: 'bot_run', essential: true, forecast: { costUsdP75: 0.2 }, expiresInMs: 60_000 });
    expect(out.kind).toBe('held');
  });
});

// ─── DE-36 hard caps and fail closed ────────────────────────────────────────

describe('DE-36: hard caps before the soft brakes', () => {
  it('dispatch-work with every confirm flag over the initiative cap answers 403 allocation-cap and starts nothing', async () => {
    const spent = (await getBudget(OBS))!.spentThisPeriodUsd;
    setAllocation(OBS, spent + P75 * 0.5, { hardCapUsd: spent + P75 * 0.8 });
    const runsBefore = mockAllRuns().length;
    const res = await dispatch(vera(), ITEM_A, ALL_FLAGS);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'allocation-cap', heldUsd: 0, allocation: { orgProjectId: OBS } });
    expect(res.body.capUsd).toBeCloseTo(spent + P75 * 0.8, 4);
    expect(res.body.spentUsd).toBeCloseTo(spent, 4);
    expect(res.body.confirmFlag).toBeUndefined();
    expect(openHolds()).toHaveLength(0);
    expect(mockAllRuns()).toHaveLength(runsBefore);
  });

  it('a null cap is allocated x 1.25: confirmed over the allocation passes inside it, not past it', async () => {
    const spent = (await getBudget(OBS))!.spentThisPeriodUsd;
    // Allocation leaves half a p75; the default cap (x1.25) leaves room only if 1.25 x alloc >= spent + p75.
    const alloc = (spent + P75) / 1.25 + 0.0001;
    setAllocation(OBS, alloc, { hardCapUsd: null, maintenanceReserveUsd: 0 });
    expect((await dispatch(vera(), ITEM_A, { confirmOverAllocation: true })).status).toBe(202);
    resetWorld();
    setAllocation(OBS, (spent + P75) / 1.25 - 0.01, { hardCapUsd: null, maintenanceReserveUsd: 0 });
    expect((await dispatch(vera(), ITEM_A, { confirmOverAllocation: true })).body.gate).toBe('allocation-cap');
  });

  it('a grant cap answers 403 envelope-cap', async () => {
    const before = (await loadEnvelope(OBS, 'u-layla'))!;
    const g = budgetGrants.rows().find((x) => x.id === 'bg-obs-3')!;
    g.allocatedUsd = before.attributedSpentUsd + P75 * 0.5;
    g.hardCapUsd = before.attributedSpentUsd + P75 * 0.8;
    const res = await dispatch(layla(), ITEM_A, ALL_FLAGS);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'envelope-cap', envelope: { grantId: 'bg-obs-3' } });
    expect(openHolds()).toHaveLength(0);
  });

  it('PUT /api/budgets/:id refuses a cap below the allocation (400) and stores a valid one', async () => {
    expect((await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 100, hardCapUsd: 99 })).status).toBe(400);
    const ok = await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 100, hardCapUsd: 150 });
    expect(ok.status).toBe(200);
    expect(ok.body.budget).toMatchObject({ allocatedUsd: 100, hardCapUsd: 150, effectiveHardCapUsd: 150, hardCapSource: 'set' });
    // A raised allocation must still sit under the stored cap.
    expect((await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 200 })).status).toBe(400);
  });

  it('grants: a cap below the envelope is 400 on create and on patch', async () => {
    expect((await request(release()).post('/api/grants').send({
      initiativeId: OBS, sprintId: 'spr-obs-s3', granteePersonId: 'p-011', amountUsd: 10, hardCapUsd: 5,
    })).status).toBe(400);
    const created = await request(release()).post('/api/grants').send({
      initiativeId: OBS, sprintId: 'spr-obs-s3', granteePersonId: 'p-011', amountUsd: 10, hardCapUsd: 15,
    });
    expect(created.status).toBe(201);
    expect(created.body.grant).toMatchObject({ allocatedUsd: 10, hardCapUsd: 15 });
    expect((await request(release()).patch('/api/grants/bg-obs-3').send({ hardCapUsd: 1 })).status).toBe(400);
    expect((await request(release()).patch('/api/grants/bg-obs-3').send({ hardCapUsd: 500 })).body.grant).toMatchObject({ hardCapUsd: 500 });
    expect((await request(release()).patch('/api/grants/bg-obs-3').send({ amountUsd: 600 })).status).toBe(400);
  });

  it('confirmOverBudget alone logs the deprecation warning', async () => {
    __resetLegacyConfirmWarning();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await dispatch(vera(), ITEM_A, { confirmOverBudget: true });
    expect(warn.mock.calls.some((c) => /confirmOverBudget is deprecated/.test(String(c[0])))).toBe(true);
  });
});

describe('DE-36: unreadable budget state fails closed where configured', () => {
  const missing = { kind: 'unavailable' as const, reason: 'relation "initiative_budgets" does not exist', error: new Error('relation "initiative_budgets" does not exist') };

  it('BUDGET_FAIL_CLOSED=1: a missing allocation table answers 503 budget-state, no run, no hold', async () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    jest.spyOn(budgetsProvider, 'readBudgetGate').mockResolvedValue(missing);
    const runsBefore = mockAllRuns().length;
    const res = await dispatch(vera(), ITEM_A);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Budget state could not be read. No work was started.', gate: 'budget-state' });
    expect(openHolds()).toHaveLength(0);
    expect(mockAllRuns()).toHaveLength(runsBefore);
  });

  it('a getBudget read that throws is the same 503', async () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    jest.spyOn(budgetsProvider, 'readBudgetGate').mockResolvedValue({ kind: 'unavailable', reason: 'Data API timeout', error: new Error('Data API timeout') });
    expect((await dispatch(vera(), ITEM_A)).body.gate).toBe('budget-state');
  });

  it('a listGrants that throws is 503 for an SME', async () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    // The grant-authorization gate reads grants before the hold does; let it
    // through once, then fail the envelope read inside the hold.
    const real = budgetsProvider.listGrants;
    let calls = 0;
    jest.spyOn(budgetsProvider, 'listGrants').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) return real(...args);
      throw new Error('budget_grants: connection reset');
    });
    const res = await dispatch(layla(), ITEM_A);
    expect(res.status).toBe(503);
    expect(res.body.gate).toBe('budget-state');
    expect(openHolds()).toHaveLength(0);
  });

  it('an unreadable user budget is 503 too', async () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    jest.spyOn(userBudgetsProvider, 'readUserBudgetGate').mockResolvedValue({ kind: 'unavailable', reason: 'x', error: new Error('x') });
    expect((await dispatch(vera(), ITEM_A)).body).toMatchObject({ gate: 'budget-state' });
  });

  it('off (the dev:mock default): a missing allocation table is unbraked, as before', async () => {
    jest.spyOn(budgetsProvider, 'readBudgetGate').mockResolvedValue(missing);
    expect((await dispatch(vera(), ITEM_A)).status).toBe(202);
  });
});

// ─── DE-55 maintenance reserve ──────────────────────────────────────────────

describe('DE-55: the reserve is funded first; work is judged against the discretionary remainder', () => {
  it('BudgetRow carries the reserve and discretionary figures, derived', async () => {
    const row = (await getBudget(OBS))!;
    expect(row.reserveSource).toBe('auto');
    expect(row.reserveUsd).toBeGreaterThanOrEqual(0);
    expect(row.floorSpentUsd! + row.discretionarySpentUsd!).toBeCloseTo(row.spentThisPeriodUsd, 4);
    expect(row.discretionaryRemainingUsd).toBeCloseTo(
      1_000 - Math.max(row.reserveUsd!, row.floorSpentUsd!) - row.discretionarySpentUsd!, 4,
    );
    // The seeded obs maintenance bot is cron, so its spend is the floor.
    expect(row.floorSpentUsd).toBeGreaterThan(0);
  });

  it('a dispatch that fits allocation - spent is refused when the reserve takes that room', async () => {
    const row = (await getBudget(OBS))!;
    const alloc = row.spentThisPeriodUsd + P75 * 1.5;
    // Reserve: what the floor already spent plus one p75 — so only half a p75 is discretionary.
    setAllocation(OBS, alloc, { maintenanceReserveUsd: row.floorSpentUsd! + P75, hardCapUsd: alloc * 10 });
    const res = await dispatch(vera(), ITEM_A);
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('allocation');
    expect(res.body.error).toMatch(/kept for maintenance/);
    expect(res.body.allocation).toMatchObject({ reserveUsd: row.floorSpentUsd! + P75 });
    expect(res.body.allocation.discretionaryRemainingUsd).toBeCloseTo(P75 * 0.5, 4);
    expect(res.body.allocation.remainingUsd).toBeCloseTo(P75 * 0.5, 4);
    // With the reserve off, the same dispatch fits.
    process.env['MAINTENANCE_RESERVE'] = 'off';
    expect((await dispatch(vera(), ITEM_A)).status).toBe(202);
  });

  it('PUT /api/budgets/:id sets the reserve and the spill rule; null puts the reserve back to auto', async () => {
    const res = await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 100, maintenanceReserveUsd: 12, allowFloorSpill: false });
    expect(res.status).toBe(200);
    expect(res.body.budget).toMatchObject({ maintenanceReserveUsd: 12, reserveUsd: 12, reserveSource: 'set', allowFloorSpill: false });
    const back = await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 100, maintenanceReserveUsd: null });
    expect(back.body.budget).toMatchObject({ maintenanceReserveUsd: null, reserveSource: 'auto', allowFloorSpill: false });
    expect((await request(release()).put(`/api/budgets/${OBS}`).send({ allocatedUsd: 100, allowFloorSpill: 'no' })).status).toBe(400);
  });

  it('an essential firing\'s hold is floor money: it shrinks the floor slice, not the discretionary holds', async () => {
    const out = await reserveSpend({ initiativeId: OBS, actorId: null, source: 'bot_run', essential: true, forecast: { costUsdP75: 0.25 }, expiresInMs: 60_000 });
    expect(out.kind).toBe('held');
    expect(openHolds()).toEqual([expect.objectContaining({ essential: true, amountUsd: 0.25 })]);
    const row = (await getBudget(OBS))!;
    expect(row).toMatchObject({ floorHeldUsd: 0.25, discretionaryHeldUsd: 0 });
  });

  it('PUT /api/bots/:id/essential marks a bot (ManageBudgets); null is back to "by trigger"', async () => {
    const off = await request(release()).put(`/api/bots/${OBS_BOT}/essential`).send({ essential: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ essential: false, bot: { id: OBS_BOT, essential: false } });
    // Its spend is no longer the floor.
    expect((await getBudget(OBS))!.floorSpentUsd).toBe(0);
    const back = await request(release()).put(`/api/bots/${OBS_BOT}/essential`).send({ essential: null });
    expect(back.body).toMatchObject({ essential: true });
    expect((await request(release()).put(`/api/bots/${OBS_BOT}/essential`).send({ essential: 'yes' })).status).toBe(400);
    expect((await request(release()).put('/api/bots/00000000-0000-0000-0000-000000000000/essential').send({ essential: true })).status).toBe(404);
  });

  it('two concurrent dispatches still serialise against the discretionary remainder', async () => {
    const row = (await getBudget(OBS))!;
    const alloc = row.spentThisPeriodUsd + P75 * 2.5;
    setAllocation(OBS, alloc, { maintenanceReserveUsd: row.floorSpentUsd! + P75, hardCapUsd: alloc * 10 });
    const [a, b] = await inFlight(() => Promise.all([dispatch(vera(), ITEM_A), dispatch(vera(), ITEM_B)]));
    expect([a.status, b.status].sort()).toEqual([202, 409]);
  });
});
