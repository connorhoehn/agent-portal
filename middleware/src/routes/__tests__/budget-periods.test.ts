// DE-38 budget periods, end to end through the REAL providers in dev:mock:
// the registered fixtures (allocations, sprints, the spend ledger, the period
// closes), the one window helper, PUT /api/budgets/:id and the one spend
// chokepoint (lib/spend-holds.ts reserveSpend). The clock is frozen so every
// boundary is exact.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
}));

import express from 'express';
import request from '../../test-support/http.js';
import { budgetsRouter } from '../budgets.js';
import { errorHandler } from '../../lib/async-handler.js';
import { freezeClock } from '../../mock/core/index.js';
import { getBudget, listBudgets, listGrants } from '../../providers/budgets.js';
import { reserveSpend } from '../../lib/spend-holds.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { initiativeBudgets, budgetGrants } from '../../mock/budgets.js';
import { budgetPeriodCloses } from '../../mock/budget-period-closes.js';
import { sprints } from '../../mock/sprints.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { bots } from '../../mock/bots.js';
import type { SpendEntry } from '../../providers/spend-ledger.js';
import { createSprint } from '../../providers/sprints.js';

const ZT = 'p-zero-trust'; // $10 seeded, no maintenance bot, one sprint (spr-zt-s1: 7 days ago .. 7 days ahead)
const RAG = 'p-rag-search'; // $5 seeded, no sprints

let restoreClock: () => void = () => undefined;
function at(instant: string): void { restoreClock(); restoreClock = freezeClock(instant); }

function resetWorld(): void {
  __resetMockRuns();
  bots.reset();
  spendHolds.reset();
  spendEntries.reset();
  spendEntries.rows().length = 0; // only the entries each test writes
  initiativeBudgets.reset();
  budgetGrants.reset();
  budgetPeriodCloses.reset();
  sprints.reset(); // re-dated against the frozen clock
}

function entry(initiativeId: string, costUsd: number | null, occurredAt: string, n = spendEntries.rows().length): void {
  const e: SpendEntry = {
    source: 'box_task', sourceId: `box-test:${n}`, initiativeId, grantId: null, boxId: 'box-test', actorId: null,
    trigger: null, model: 'haiku', costUsd, costBasis: costUsd == null ? 'unknown' : 'reported', estimatedCostUsd: null,
    inputTokens: null, outputTokens: null, occurredAt, provider: 'bedrock',
  } as SpendEntry;
  spendEntries.rows().push(e);
}

function allocation(id: string, patch: Record<string, unknown>): void {
  Object.assign(initiativeBudgets.rows().find((b) => b.id === id)!, patch);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' }; next(); });
  a.use('/api/budgets', budgetsRouter);
  a.use(errorHandler);
  return a;
}

const closes = (id: string) => budgetPeriodCloses.rows().filter((c) => c.orgProjectId === id);

beforeEach(() => {
  process.env['SPEND_LEDGER'] = 'ledger';
  at('2026-10-15T12:00:00Z');
  resetWorld();
});
afterEach(() => { delete process.env['SPEND_LEDGER']; restoreClock(); });

describe('nothing moves until an initiative opts in', () => {
  it('every seeded allocation is monthly, keyed to this month, carries nothing and writes no close', async () => {
    delete process.env['SPEND_LEDGER']; // the default read mode, over the seeded run history
    const rows = await listBudgets();
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.period === null || r.period === 'monthly').toBe(true);
      expect(r.periodKey).toBe('2026-10');
      expect(r.periodStart).toBe('2026-10-01T00:00:00.000Z');
      expect(r.periodEnd).toBe('2026-11-01T00:00:00.000Z');
      expect(r.carryOver).toBe('none');
      expect(r.carryInUsd).toBe(0);
      expect(r.effectiveAllocatedUsd).toBe(r.allocatedUsd);
    }
    expect(budgetPeriodCloses.rows()).toHaveLength(0);
  });
});

describe('carry-over is a close row', () => {
  it('unspent with a $10 cap: $25 left last month makes this month allocation + 10; a retried close leaves one row', async () => {
    allocation(ZT, { allocated: 40, carryOver: 'unspent', carryOverCapUsd: 10 });
    entry(ZT, 15, '2026-09-20T10:00:00Z');
    entry(ZT, null, '2026-09-21T10:00:00Z'); // an unknown cost is counted on the close, never blocking it
    entry(ZT, 2, '2026-10-05T10:00:00Z');

    const row = (await getBudget(ZT))!;
    expect(row).toMatchObject({ allocatedUsd: 40, carryInUsd: 10, effectiveAllocatedUsd: 50, spentThisPeriodUsd: 2, periodKey: '2026-10' });
    expect(row.discretionaryRemainingUsd).toBe(48);
    expect(closes(ZT)).toEqual([expect.objectContaining({
      periodKey: '2026-09', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z',
      allocatedUsd: 40, carryInUsd: 0, spentUsd: 15, unknownCostEntries: 1, carryOutUsd: 10, reason: 'boundary',
    })]);

    await getBudget(ZT);
    await listBudgets();
    expect(closes(ZT)).toHaveLength(1);
  });

  it('the next close starts from its predecessor\'s carry-out', async () => {
    allocation(ZT, { allocated: 40, carryOver: 'unspent', carryOverCapUsd: null });
    entry(ZT, 30, '2026-09-10T00:00:00Z'); // September leaves 10
    await getBudget(ZT);
    at('2026-11-03T00:00:00Z');
    entry(ZT, 35, '2026-10-20T00:00:00Z'); // October: 40 + 10 - 35 = 15
    const row = (await getBudget(ZT))!;
    expect(row).toMatchObject({ periodKey: '2026-11', carryInUsd: 15, effectiveAllocatedUsd: 55 });
    expect(closes(ZT).map((c) => [c.periodKey, c.carryInUsd, c.carryOutUsd])).toEqual([['2026-09', 0, 10], ['2026-10', 10, 15]]);
  });
});

describe('the brakes judge the effective allocation', () => {
  it('an overspend carried in shrinks what a dispatch may spend (decideAllocation on allocation + carry)', async () => {
    allocation(ZT, { allocated: 10, carryOver: 'overspend' });
    entry(ZT, 14, '2026-09-12T00:00:00Z'); // September overspent by 4
    const out = await reserveSpend({ initiativeId: ZT, actorId: null, source: 'box_task', sourceId: 'box-test:x', forecast: { costUsdP75: 7 }, expiresInMs: 60_000 });
    expect(out).toMatchObject({ kind: 'confirm', gate: 'allocation', allocation: { allocatedUsd: 6, carryInUsd: -4, periodKey: '2026-10' } });

    // The control: the raw $10 would have fitted the same forecast.
    resetWorld();
    allocation(ZT, { allocated: 10 });
    entry(ZT, 14, '2026-09-12T00:00:00Z');
    const raw = await reserveSpend({ initiativeId: ZT, actorId: null, source: 'box_task', sourceId: 'box-test:y', forecast: { costUsdP75: 7 }, expiresInMs: 60_000 });
    expect(raw.kind).toBe('held');
  });

  it('between sprints the allocation is not in force: no soft brake, no remainder', async () => {
    allocation(RAG, { period: 'sprint' });
    const row = (await getBudget(RAG))!;
    expect(row).toMatchObject({ period: 'sprint', periodState: 'between-sprints', periodKey: null, effectiveAllocatedUsd: null, discretionaryRemainingUsd: null });
    const out = await reserveSpend({ initiativeId: RAG, actorId: null, source: 'box_task', sourceId: 'box-test:z', forecast: { costUsdP75: 100 }, expiresInMs: 60_000 });
    expect(out.kind).toBe('held');
  });
});

describe('sprint and quarterly windows', () => {
  it('a sprint-period allocation and the sprint envelope cover identical days', async () => {
    allocation(ZT, { period: 'sprint' });
    entry(ZT, 1.5, '2026-10-07T23:59:00Z'); // the day before spr-zt-s1 starts
    entry(ZT, 2.25, '2026-10-08T00:00:00Z');
    entry(ZT, 0.5, '2026-10-15T08:00:00Z');
    const row = (await getBudget(ZT))!;
    expect(row).toMatchObject({ periodKey: 'spr-zt-s1', periodStart: '2026-10-08T00:00:00.000Z', periodEnd: '2026-10-23T00:00:00.000Z', spentThisPeriodUsd: 2.75 });
    const [grant] = await listGrants(ZT);
    expect(grant!.initiativeSpendInWindowUsd).toBe(row.spentThisPeriodUsd);
  });

  it('a quarterly allocation sums the quarter and keys YYYY-Qn', async () => {
    allocation(ZT, { period: 'quarterly' });
    entry(ZT, 1, '2026-09-30T23:00:00Z');
    entry(ZT, 2, '2026-10-01T00:00:00Z');
    expect(await getBudget(ZT)).toMatchObject({ periodKey: '2026-Q4', periodStart: '2026-10-01T00:00:00.000Z', spentThisPeriodUsd: 2 });
  });

  it('a rolling window sums the trailing days and has no key', async () => {
    allocation(ZT, { period: 'rolling', rollingDays: 7 });
    entry(ZT, 4, '2026-10-08T11:59:00Z');
    entry(ZT, 1, '2026-10-08T12:00:00Z');
    expect(await getBudget(ZT)).toMatchObject({ periodKey: null, rollingDays: 7, periodStart: '2026-10-08T12:00:00.000Z', spentThisPeriodUsd: 1 });
  });
});

describe('PUT /api/budgets/:id period policy', () => {
  const put = (body: Record<string, unknown>) => request(app()).put(`/api/budgets/${ZT}`).send({ allocatedUsd: 10, ...body });

  it('refuses a period outside the four, a rolling window without its length, and a rolling carry', async () => {
    expect((await put({ period: 'weekly' })).status).toBe(400);
    expect((await put({ period: 'rolling' })).status).toBe(400);
    expect((await put({ period: 'rolling', rollingDays: 0 })).status).toBe(400);
    expect((await put({ period: 'rolling', rollingDays: 7, carryOver: 'unspent' })).status).toBe(400);
    expect((await put({ rollingDays: 7 })).status).toBe(400);
    expect((await put({ carryOver: 'sometimes' })).status).toBe(400);
    expect((await put({ carryOverCapUsd: -1 })).status).toBe(400);
  });

  it('stores a rolling window and answers with the window', async () => {
    const res = await put({ period: 'rolling', rollingDays: 7 });
    expect(res.status).toBe(200);
    expect(res.body.budget).toMatchObject({ period: 'rolling', rollingDays: 7, periodKey: null, carryOver: 'none' });
  });

  it('a policy change closes the outgoing window with carry 0, so the month it changed in never carries', async () => {
    entry(ZT, 3, '2026-10-02T00:00:00Z');
    const res = await put({ carryOver: 'unspent' });
    expect(res.status).toBe(200);
    expect(res.body.budget).toMatchObject({ carryOver: 'unspent', carryInUsd: 0 });
    // The outgoing October window, and (on the read-back) September's boundary
    // close — which ended before the policy took effect, so it carries 0.
    expect(closes(ZT)).toEqual(expect.arrayContaining([
      expect.objectContaining({ periodKey: '2026-10', reason: 'reconfigured', carryOutUsd: 0, spentUsd: 3 }),
      expect.objectContaining({ periodKey: '2026-09', reason: 'boundary', carryOutUsd: 0 }),
    ]));
    expect(closes(ZT)).toHaveLength(2);
    expect(initiativeBudgets.rows().find((b) => b.id === ZT)!.carryOverSince).toBe('2026-10-15T12:00:00.000Z');

    at('2026-11-10T00:00:00Z');
    expect(await getBudget(ZT)).toMatchObject({ periodKey: '2026-11', carryInUsd: 0, effectiveAllocatedUsd: 10 });
    at('2026-12-02T00:00:00Z');
    expect(await getBudget(ZT)).toMatchObject({ periodKey: '2026-12', carryInUsd: 10, effectiveAllocatedUsd: 20 });
  });

  it('an allocation-only write is not a reconfiguration', async () => {
    await put({ allocatedUsd: 12 });
    expect(closes(ZT)).toHaveLength(0);
  });
});

describe('one active sprint per initiative', () => {
  it('refuses to activate a second sprint where one is active (409), and allows a planned one', async () => {
    await expect(createSprint({ orgProjectId: ZT, name: 'Sprint 6', startsOn: '2026-10-23', endsOn: '2026-11-05', status: 'active' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(createSprint({ orgProjectId: ZT, name: 'Sprint 6', startsOn: '2026-10-23', endsOn: '2026-11-05', status: 'planned' }))
      .resolves.toMatchObject({ status: 'planned' });
  });
});
