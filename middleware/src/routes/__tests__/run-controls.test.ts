// Run controls in dev:mock, end to end through the REAL providers: the mid-run
// cutoff's top-ups and record (DE-35), run limits (DE-37), kill switches and
// alerts (DE-50). The in-process keyed lock stands in for the advisory locks.

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
import { budgetsRouter } from '../budgets.js';
import { opsSwitchesRouter } from '../ops-switches.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs, reconcileBotRuns } from '../../lib/bot-runner.js';
import { __resetMockRuns, createBotRun } from '../../providers/bots.js';
import { liveBotRuns } from '../../mock/bots.js';
import { initiativeBudgets, budgetGrants } from '../../mock/budgets.js';
import { workItems } from '../../mock/work-items.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { agentProjectRuns } from '../../mock/agent-project-runs.js';
import { runLimits, runSlots, fleetSwitches, fleetSwitchLog, budgetThresholds } from '../../mock/run-controls.js';
import { mockHolds } from '../../providers/spend-holds.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { reserveSpend, meterForHold } from '../../lib/spend-holds.js';
import { listWorkItemComments } from '../../providers/work-items.js';
import { acquireRunSlots, freeDeadSlots, liveSlotCount, upsertRunLimit } from '../../providers/run-limits.js';
import { decideRunLimits } from '../../lib/run-limits.js';
import { setSwitch } from '../../lib/fleet-switches.js';
import { sweepBudgetThresholds, crossedThreshold, thresholdToAnnounce, fleetAlerts } from '../../lib/fleet-alerts.js';
import { freezeClock, clock } from '../../mock/core/index.js';
import { _resetModelPricesForTest } from '../../lib/model-prices.js';

const OBS = 'p-observability';
const ZT = 'p-zero-trust';
const ITEM_A = 'wi-obs-e2-s3';
const ITEM_B = 'wi-obs-e3-s2';
const ITEM_ZT = 'wi-zt-e1-s2';
const MODEL = 'us.amazon.nova-lite-v1:0';
const SONNET = 'us.anthropic.claude-sonnet-5';

function app(sub: string, role: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq' };
    next();
  });
  a.use('/api/bots', botsRouter);
  a.use('/api/budgets', budgetsRouter);
  a.use('/api/ops', opsSwitchesRouter);
  a.use(errorHandler);
  return a;
}
const vera = () => app('u-vera', 'org-leader');
const layla = () => app('u-layla', 'sme');
const dispatch = (a: express.Express, workItemId: string, extra: Record<string, unknown> = {}) =>
  request(a).post('/api/bots/dispatch-work').send({ workItemId, model: MODEL, ...extra });

function resetWorld(): void {
  __resetMockRuns();
  for (const f of [spendHolds, spendEntries, initiativeBudgets, budgetGrants, workItems, agentProjectRuns,
    runLimits, runSlots, fleetSwitches, fleetSwitchLog, budgetThresholds]) f.reset();
}

function setAllocation(id: string, allocated: number, hardCapUsd?: number): void {
  const row = initiativeBudgets.rows().find((b) => b.id === id)!;
  row.allocated = allocated;
  if (hardCapUsd !== undefined) (row as unknown as { hardCapUsd: number }).hardCapUsd = hardCapUsd;
}

async function inFlight<T>(fn: () => Promise<T>): Promise<T> {
  __setMockDispatchStepMs(60_000);
  try { return await fn(); } finally { __setMockDispatchStepMs(0); }
}

beforeAll(() => __setMockDispatchStepMs(0));
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => { resetWorld(); _resetModelPricesForTest(); });

// ─── DE-35 ────────────────────────────────────────────────────────────────────

describe('DE-35 the hold is the ceiling', () => {
  const turn = (id: string, out: number) => ({ type: 'assistant', message: { id, usage: { input_tokens: 0, output_tokens: out } } });

  it('crossing 80 % with room left takes a topup hold, and the attempt\'s ledger entry settles both', async () => {
    setAllocation(OBS, 1_000);
    const held = await reserveSpend({
      initiativeId: OBS, actorId: 'u-vera', source: 'box_task', sourceId: 'box-m:t1',
      forecast: { costUsdP75: 0.05 }, expiresInMs: 600_000,
    });
    expect(held.kind).toBe('held');
    const h = held as Extract<typeof held, { kind: 'held' }>;
    const meter = (await meterForHold({
      holdId: h.holdId, amountUsd: h.amountUsd, initiativeId: OBS, actorId: 'u-vera',
      source: 'box_task', sourceId: 'box-m:t1', model: SONNET, expiresInMs: 600_000,
    }))!;
    expect(meter).not.toBeNull();
    // Output tokens worth ~90 % of the hold.
    meter.observe(turn('m1', Math.ceil((0.045 / 0.01) * 1000)));
    await meter.settled();
    const topups = mockHolds().filter((x) => x.basis === 'topup');
    expect(topups).toHaveLength(1);
    expect(topups[0]).toMatchObject({ initiativeId: OBS, source: 'box_task', sourceId: 'box-m:t1#topup-1', status: 'held' });
    expect(meter.ceilingUsd).toBeGreaterThan(h.amountUsd);
    expect(meter.cutoff).toBeNull();

    await recordSpend({ source: 'box_task', sourceId: 'box-m:t1', initiativeId: OBS, boxId: 'box-m', actorId: 'u-vera', model: SONNET, costUsd: 0.06 });
    expect(mockHolds().filter((x) => x.sourceId?.startsWith('box-m:t1')).map((x) => x.status)).toEqual(['settled', 'settled']);
  });

  it('with no room the top-up is refused and the run is cut at its hold', async () => {
    const held = await reserveSpend({
      initiativeId: OBS, actorId: null, source: 'box_task', sourceId: 'box-m:t2',
      forecast: { costUsdP75: 0.05 }, expiresInMs: 600_000,
    }) as { kind: 'held'; holdId: string; amountUsd: number };
    // Now the initiative has nothing left: a hard cap at what is already spent and held.
    const spent = (await import('../../providers/budgets.js')).getBudget;
    const b = (await spent(OBS))!;
    setAllocation(OBS, b.spentThisPeriodUsd, b.spentThisPeriodUsd + 0.05);
    const meter = (await meterForHold({
      holdId: held.holdId, amountUsd: held.amountUsd, initiativeId: OBS, actorId: null,
      source: 'box_task', sourceId: 'box-m:t2', model: SONNET, expiresInMs: 600_000,
    }))!;
    meter.observe(turn('m1', Math.ceil((0.045 / 0.01) * 1000)));
    await meter.settled();
    expect(meter.cutoff).toBeNull();
    meter.observe(turn('m2', Math.ceil((0.01 / 0.01) * 1000)));
    await meter.settled();
    expect(meter.cutoff).toMatchObject({ reason: 'budget', holdIds: [held.holdId] });
    expect(mockHolds().filter((x) => x.basis === 'topup')).toHaveLength(0);
  });

  it('a cut governed run settles its bot_run failed with outcome.cutoff and comments on the work item', async () => {
    workItems.rows().find((w) => w.id === ITEM_A)!.status = 'in_progress';
    const runId = '11111111-1111-4111-8111-111111111111';
    const cutoff = { reason: 'budget', ceilingUsd: 0.5, meteredUsd: 0.52, holdIds: ['h1'], at: clock.nowIso() };
    agentProjectRuns.rows().push({
      id: runId, projectId: '4870e01d-9274-5c4a-91af-ea9acb7f857a', prompt: 'x', model: SONNET, status: 'failed',
      startedAt: clock.nowIso(), finishedAt: clock.nowIso(), filesChanged: 0, diffSummary: null,
      error: 'stopped at $0.52 of its $0.50 hold; raise the allocation or re-dispatch', costUsd: 0.52, workItemId: ITEM_A, cutoff,
    });
    const run = await createBotRun({ botId: null, trigger: 'marketplace', runId, workItemId: ITEM_A, outcome: { budgetPerRunUsd: 0.1 } });
    await reconcileBotRuns();
    const settled = liveBotRuns.rows().find((r) => r.id === run!.id)!;
    expect(settled.status).toBe('failed');
    expect(settled.outcome).toMatchObject({ cutoff: { reason: 'budget', ceilingUsd: 0.5, meteredUsd: 0.52 }, overRunBudget: true });
    const { comments } = await listWorkItemComments(ITEM_A);
    expect(comments.map((c) => c.body)).toContain('Marketplace run stopped at $0.52 of its $0.50 hold; raise the allocation or re-dispatch.');
  });

  it('a marketplace run with budgetPerRunUsd and a higher actual cost settles overRunBudget', async () => {
    workItems.rows().find((w) => w.id === ITEM_B)!.status = 'in_progress';
    const runId = '22222222-2222-4222-8222-222222222222';
    agentProjectRuns.rows().push({
      id: runId, projectId: '4870e01d-9274-5c4a-91af-ea9acb7f857a', prompt: 'x', model: SONNET, status: 'done',
      startedAt: clock.nowIso(), finishedAt: clock.nowIso(), filesChanged: 0, diffSummary: null, error: null, costUsd: 0.9, workItemId: ITEM_B,
    });
    const run = await createBotRun({ botId: null, trigger: 'marketplace', runId, workItemId: ITEM_B, outcome: { budgetPerRunUsd: 0.5 } });
    await reconcileBotRuns();
    const settled = liveBotRuns.rows().find((r) => r.id === run!.id)!;
    expect(settled.outcome).toMatchObject({ overRunBudget: true });
  });

  it('dispatch-work persists the request\'s budgetPerRunUsd on the bot_run outcome', async () => {
    setAllocation(OBS, 1_000);
    const res = await dispatch(vera(), ITEM_A, { budgetPerRunUsd: 50 });
    expect(res.status).toBe(202);
    expect(res.body.run.outcome).toMatchObject({ budgetPerRunUsd: 50 });
  });
});

// ─── DE-37 ────────────────────────────────────────────────────────────────────

describe('DE-37 run limits', () => {
  it('decideRunLimits: narrowest scope first, then concurrency, runs/day, $/hour', () => {
    const limit = (o: Record<string, number | null>) => ({ maxConcurrent: null, maxRunsPerDay: null, maxUsdPerHour: null, updatedBy: null, updatedAt: '', ...o });
    const st = (kind: 'initiative' | 'tenant' | 'global', id: string, l: Record<string, number | null>, u: Partial<{ liveSlots: number; runsToday: number; usdLastHour: number }>, takesSlot = true) => ({
      scope: { kind, id }, limit: { scopeKind: kind, scopeId: id, ...limit(l) }, usage: { liveSlots: 0, runsToday: 0, usdLastHour: 0, ...u }, takesSlot,
    });
    expect(decideRunLimits([st('initiative', OBS, { maxConcurrent: 2 }, { liveSlots: 1 })], 0.1).kind).toBe('proceed');
    expect(decideRunLimits([st('initiative', OBS, { maxConcurrent: 1 }, { liveSlots: 1 })], 0.1)).toMatchObject({ kind: 'refuse', limitKind: 'concurrency', scope: { kind: 'initiative', id: OBS } });
    // A box task takes no tenant slot, so the tenant's concurrency does not refuse it.
    expect(decideRunLimits([st('tenant', 'orgiq', { maxConcurrent: 1 }, { liveSlots: 5 }, false)], 0.1).kind).toBe('proceed');
    expect(decideRunLimits([st('tenant', 'orgiq', { maxRunsPerDay: 10 }, { runsToday: 10 })], 0.1)).toMatchObject({ limitKind: 'runs-per-day', retryAfterS: 3600 });
    expect(decideRunLimits([st('global', '*', { maxUsdPerHour: 1 }, { usdLastHour: 0.95 })], 0.1)).toMatchObject({ limitKind: 'usd-per-hour' });
    // Initiative before tenant, whatever the input order.
    expect(decideRunLimits([
      st('tenant', 'orgiq', { maxConcurrent: 1 }, { liveSlots: 1 }), st('initiative', OBS, { maxConcurrent: 1 }, { liveSlots: 1 }),
    ], 0)).toMatchObject({ scope: { kind: 'initiative' } });
  });

  it('with an initiative limit of 1, a second dispatch-work there is 429 naming it; another initiative proceeds', async () => {
    setAllocation(OBS, 1_000);
    setAllocation(ZT, 1_000);
    // The global bot-run ceiling (BOT_MAX_CONCURRENT, 3) already counts the seed's
    // live runs; this test is about the initiative limit, so give the fleet room.
    process.env['BOT_MAX_CONCURRENT'] = '10';
    const put = await request(vera()).put(`/api/budgets/${OBS}/limits`).send({ maxConcurrent: 1 });
    expect(put.status).toBe(200);
    expect(put.body.limits).toMatchObject({ orgProjectId: OBS, maxConcurrent: 1, maxRunsPerDay: null });

    const [first, second, other] = await inFlight(async () => [
      await dispatch(vera(), ITEM_A), await dispatch(vera(), ITEM_B), await dispatch(vera(), ITEM_ZT),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('30');
    expect(second.body).toMatchObject({ gate: 'run-limit', limitKind: 'concurrency', limit: 1, scope: { kind: 'initiative', id: OBS } });
    expect(second.body.error).toContain(OBS);
    expect(other.status).toBe(202);
    // The refused dispatch held nothing.
    expect(mockHolds().filter((h) => h.initiativeId === OBS && h.status === 'held')).toHaveLength(1);
    const read = await request(vera()).get(`/api/budgets/${OBS}/limits`);
    expect(read.body.limits.usage.liveSlots).toBe(1);
    delete process.env['BOT_MAX_CONCURRENT'];
  });

  it('the slot frees when the run\'s hold closes', async () => {
    setAllocation(OBS, 1_000);
    await upsertRunLimit('initiative', OBS, { maxConcurrent: 1 }, 'u-vera');
    // Step 0: the simulated run settles (its hold settles) before the response.
    expect((await dispatch(vera(), ITEM_A)).status).toBe(202);
    expect(await liveSlotCount(`initiative:${OBS}`)).toBe(0);
    expect((await dispatch(vera(), ITEM_B)).status).toBe(202);
  });

  it('a box task takes the initiative slot but never the tenant one', async () => {
    await upsertRunLimit('initiative', OBS, { maxConcurrent: 1 }, null);
    await upsertRunLimit('tenant', 'orgiq', { maxConcurrent: 0 }, null);
    const box = await reserveSpend({ initiativeId: OBS, actorId: 'u-vera', source: 'box_task', sourceId: 'b:1', forecast: { costUsdP75: 0.01 }, expiresInMs: 60_000 });
    expect(box.kind).toBe('held');
    expect(await liveSlotCount(`initiative:${OBS}`)).toBe(1);
    expect(await liveSlotCount('tenant:orgiq')).toBe(0);
    const again = await reserveSpend({ initiativeId: OBS, actorId: 'u-vera', source: 'box_task', sourceId: 'b:2', forecast: { costUsdP75: 0.01 }, expiresInMs: 60_000 });
    expect(again).toMatchObject({ kind: 'limited', limitKind: 'concurrency' });
    // A job on the same tenant is refused by the tenant's 0.
    const job = await reserveSpend({ initiativeId: ZT, actorId: null, source: 'job', sourceId: 'j:1', forecast: { costUsdP75: 0.01 }, expiresInMs: 60_000 });
    expect(job).toMatchObject({ kind: 'limited', scope: { kind: 'tenant', id: 'orgiq' } });
  });

  it('an expired slot is freed by the reaper sweep and the next acquire succeeds', async () => {
    const restore = freezeClock(new Date('2026-10-29T12:00:00Z'));
    try {
      const key = `initiative:${OBS}`;
      expect(await acquireRunSlots('holder-a', [{ key, max: 1 }], '2026-10-29T12:05:00Z')).toEqual({ ok: true });
      expect(await acquireRunSlots('holder-b', [{ key, max: 1 }], '2026-10-29T12:05:00Z')).toMatchObject({ ok: false, live: 1 });
      freezeClock(new Date('2026-10-29T12:06:00Z'));
      expect(await freeDeadSlots()).toBe(1);
      expect(runSlots.rows()).toHaveLength(0);
      expect(await acquireRunSlots('holder-b', [{ key, max: 1 }], '2026-10-29T12:10:00Z')).toEqual({ ok: true });
    } finally { restore(); }
  });
});

// ─── DE-50 ────────────────────────────────────────────────────────────────────

describe('DE-50 kill switches', () => {
  it('a fleet pause refuses every path with 423 before any hold; an initiative pause only its own', async () => {
    setAllocation(OBS, 1_000);
    setAllocation(ZT, 1_000);
    await setSwitch(`initiative:${OBS}`, true, 'incident review', 'u-vera');
    const obs = await dispatch(vera(), ITEM_A);
    expect(obs.status).toBe(423);
    expect(obs.body).toMatchObject({ gate: 'paused', scope: `initiative:${OBS}` });
    expect(obs.body.error).toMatch(/incident review/);
    expect((await dispatch(vera(), ITEM_ZT)).status).toBe(202);

    await setSwitch('fleet', true, null, 'u-vera');
    for (const source of ['box_task', 'agent_loop', 'job', 'bot_run', 'agent_project_run'] as const) {
      const r = await reserveSpend({ initiativeId: ZT, actorId: 'u-vera', source, sourceId: `x:${source}`, forecast: { costUsdP75: 0.01 }, expiresInMs: 60_000 });
      expect(r).toMatchObject({ kind: 'paused', scope: 'fleet' });
    }
    // Unattributed spend too.
    expect(await reserveSpend({ initiativeId: null, actorId: 'u-vera', source: 'box_task', forecast: { costUsdP75: 0.01 }, expiresInMs: 60_000 }))
      .toMatchObject({ kind: 'paused' });
    expect(mockHolds().filter((h) => h.sourceId?.startsWith('x:'))).toHaveLength(0);
  });

  it('PUT /api/ops/switches: fleet needs an org-wide role, an initiative its stewardship; every flip is logged', async () => {
    const sme = await request(layla()).put('/api/ops/switches/fleet').send({ paused: true });
    expect(sme.status).toBe(403);
    const bad = await request(vera()).put('/api/ops/switches/nope').send({ paused: true });
    expect(bad.status).toBe(400);
    const on = await request(vera()).put('/api/ops/switches/fleet').send({ paused: true, reason: 'spend spike' });
    expect(on.status).toBe(200);
    expect(on.body.switch).toMatchObject({ scope: 'fleet', paused: true, reason: 'spend spike', setBy: 'u-vera' });
    const off = await request(vera()).put('/api/ops/switches/fleet').send({ paused: false });
    expect(off.body.switch.paused).toBe(false);
    const list = await request(vera()).get('/api/ops/switches');
    expect(list.body.switches).toEqual([expect.objectContaining({ scope: 'fleet', paused: false })]);
    expect(list.body.history.map((h: { paused: boolean }) => h.paused).sort()).toEqual([false, true]);
  });
});

describe('DE-50 alerts', () => {
  it('thresholds are pure: highest crossed, announced once per period', () => {
    expect(crossedThreshold(49, 100)).toBe(0);
    expect(crossedThreshold(85, 100)).toBe(80);
    expect(crossedThreshold(120, 100)).toBe(100);
    expect(thresholdToAnnounce(80, '2026-10', { threshold: 50, period: '2026-10' })).toBe(80);
    expect(thresholdToAnnounce(80, '2026-10', { threshold: 80, period: '2026-10' })).toBeNull();
    expect(thresholdToAnnounce(50, '2026-11', { threshold: 100, period: '2026-10' })).toBe(50);
  });

  it('the budget sweep crosses 50, 80 and 100 once each in a period and never twice', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const listener = (l: Record<string, unknown>) => { if (l['type'] === 'budget-threshold' && l['InitiativeId'] === OBS) lines.push(l); };
    fleetAlerts.on('alert', listener);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const b = (await (await import('../../providers/budgets.js')).getBudget(OBS))!;
      const spent = b.spentThisPeriodUsd;
      expect(spent).toBeGreaterThan(0);
      const now = new Date('2026-10-29T12:00:00Z');
      const at = (pct: number) => setAllocation(OBS, spent / pct);
      at(0.4); await sweepBudgetThresholds(now);
      at(0.55); await sweepBudgetThresholds(now); await sweepBudgetThresholds(now);
      at(0.85); await sweepBudgetThresholds(now); await sweepBudgetThresholds(now);
      at(1.1); await sweepBudgetThresholds(now); await sweepBudgetThresholds(now);
      expect(lines.map((l) => l['threshold'])).toEqual([50, 80, 100]);
      // Auto-pause is off by default.
      expect(fleetSwitches.rows()).toHaveLength(0);
      // The JSON line itself is on stdout with the InitiativeId dimension.
      const json = log.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('"budget-threshold"') && s.includes(OBS));
      expect(json).toHaveLength(3);
    } finally {
      fleetAlerts.off('alert', listener);
      log.mockRestore();
    }
  });

  it('BUDGET_AUTO_PAUSE=on pauses the initiative at 100 %', async () => {
    process.env['BUDGET_AUTO_PAUSE'] = 'on';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const b = (await (await import('../../providers/budgets.js')).getBudget(OBS))!;
      setAllocation(OBS, b.spentThisPeriodUsd / 1.2);
      await sweepBudgetThresholds(new Date('2026-10-29T12:00:00Z'));
      expect(fleetSwitches.rows()).toEqual([expect.objectContaining({ scope: `initiative:${OBS}`, paused: true, reason: 'budget' })]);
    } finally {
      delete process.env['BUDGET_AUTO_PAUSE'];
      log.mockRestore();
    }
  });
});
