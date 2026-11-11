// The learning line (docs/learning-loop-design.md "Budgets", lane B): the
// distiller's one door to money, built on reserveSpend, under the organisation's
// monthly learning cap; and the Budgets lines route that shows it beside local
// compute's reported, never billed, figure.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: async () => true,
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { budgetsRouter } from '../../routes/budgets.js';
import { errorHandler } from '../async-handler.js';
import {
  learningSourceId, releaseLearningSpend, reserveLearningSpend, settleLearningSpend,
} from '../learning-budget.js';
import { setSwitch } from '../fleet-switches.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { learningBudget } from '../../mock/budget-lines.js';
import { fleetSwitches } from '../../mock/run-controls.js';

function app(sub: string, role: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq' }; next(); });
  a.use('/api/budgets', budgetsRouter);
  a.use(errorHandler);
  return a;
}
const vera = () => app('u-vera', 'org-leader');
const mia = () => app('u-mia', 'program-owner');

beforeEach(() => {
  for (const f of [spendHolds, spendEntries, learningBudget, fleetSwitches]) f.reset();
  delete process.env['LEARNING_BUDGET_USD'];
});

const learningHolds = () => spendHolds.rows().filter((h) => h.source === 'learning');

describe('reserveLearningSpend', () => {
  it('holds the estimate on the learning line, charged to nobody, idempotent on runRef', async () => {
    const a = await reserveLearningSpend({ runRef: 'run-1', estimate: 0.4 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.holdId).toBeTruthy();
    expect(learningHolds()).toEqual([expect.objectContaining({
      id: a.holdId, source: 'learning', sourceId: learningSourceId('run-1'), amountUsd: 0.4,
      initiativeId: null, actorId: null, status: 'held',
    })]);
    const again = await reserveLearningSpend({ runRef: 'run-1', estimate: 0.4 });
    expect(again).toEqual({ ok: true, holdId: a.holdId });
    expect(learningHolds()).toHaveLength(1);
  });

  it('refuses with learning-budget at the cap, counting money in flight', async () => {
    process.env['LEARNING_BUDGET_USD'] = '1';
    expect((await reserveLearningSpend({ runRef: 'run-1', estimate: 0.6 })).ok).toBe(true);
    const over = await reserveLearningSpend({ runRef: 'run-2', estimate: 0.6 });
    expect(over).toEqual({ ok: false, reason: 'learning-budget', message: expect.stringMatching(/learning line has a \$1\.00 hard cap/) });
  });

  it('with the cap at zero nothing is distilled server-side', async () => {
    learningBudget.rows().push({ id: 'org', monthlyCapUsd: 0, updatedBy: 'u-vera', updatedAt: new Date().toISOString() });
    expect(await reserveLearningSpend({ runRef: 'run-1', estimate: 0.01 })).toEqual(expect.objectContaining({ ok: false, reason: 'learning-budget' }));
  });

  it('settles into a `learning` ledger line that counts against the month', async () => {
    process.env['LEARNING_BUDGET_USD'] = '1';
    const r = await reserveLearningSpend({ runRef: 'run-1', estimate: 0.5 });
    expect(r.ok).toBe(true);
    await settleLearningSpend({ runRef: 'run-1', costUsd: 0.7, model: 'us.amazon.nova-pro-v1:0', inputTokens: 1000, outputTokens: 200 });
    expect(learningHolds()[0]!.status).toBe('settled');
    expect(spendEntries.rows().filter((e) => e.source === 'learning')).toEqual([expect.objectContaining({
      sourceId: 'learning:run-1', costUsd: 0.7, initiativeId: null, actorId: null, trigger: 'distill',
    })]);
    // $0.70 spent of $1: a $0.40 distillation no longer fits, a $0.30 one does.
    expect((await reserveLearningSpend({ runRef: 'run-2', estimate: 0.4 })).ok).toBe(false);
    expect((await reserveLearningSpend({ runRef: 'run-3', estimate: 0.3 })).ok).toBe(true);
  });

  it('a released reservation gives the money back', async () => {
    process.env['LEARNING_BUDGET_USD'] = '1';
    const r = await reserveLearningSpend({ runRef: 'run-1', estimate: 0.9 });
    if (!r.ok) throw new Error('expected a hold');
    await releaseLearningSpend(r.holdId);
    expect((await reserveLearningSpend({ runRef: 'run-2', estimate: 0.9 })).ok).toBe(true);
  });

  it('a paused fleet distils nothing', async () => {
    await setSwitch('fleet', true, 'incident', 'u-vera');
    expect(await reserveLearningSpend({ runRef: 'run-1', estimate: 0.1 })).toEqual(expect.objectContaining({ ok: false, reason: 'paused' }));
  });

  it('needs the run it distils', async () => {
    expect(await reserveLearningSpend({ runRef: ' ', estimate: 0.1 })).toEqual(expect.objectContaining({ ok: false, reason: 'refused' }));
  });
});

describe('GET /api/budgets/lines and PUT /api/budgets/learning', () => {
  it('shows the learning line (spent and held of the cap) and local runs as reported, not billed', async () => {
    await reserveLearningSpend({ runRef: 'run-1', estimate: 0.25 });
    await settleLearningSpend({ runRef: 'run-0', costUsd: 1.5 });
    await recordSpend({
      source: 'job', sourceId: 'job-local:1', initiativeId: 'p-auth-migration', boxId: 'local:n1', actorId: 'u-nora',
      model: 'sonnet', costUsd: 0, costBasis: 'reported', provider: 'local', reportedUsd: 3.75,
    });
    const res = await request(vera()).get('/api/budgets/lines');
    expect(res.status).toBe(200);
    expect(res.body.learning).toMatchObject({
      capUsd: 5, capSource: 'default', spentUsd: 1.5, heldUsd: 0.25, remainingUsd: 3.25, threshold: { percent: 35, reached: 0 },
    });
    expect(res.body.local).toEqual({ reportedUsd: 3.75, runs: 1, billedUsd: 0 });
    expect(res.body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('an org leader sets the cap; null puts the default back', async () => {
    const set = await request(vera()).put('/api/budgets/learning').send({ monthlyCapUsd: 12 });
    expect(set.status).toBe(200);
    expect(set.body.learning).toMatchObject({ capUsd: 12, capSource: 'set', updatedBy: 'u-vera' });
    expect((await request(vera()).get('/api/budgets/lines')).body.learning.capUsd).toBe(12);
    const back = await request(vera()).put('/api/budgets/learning').send({ monthlyCapUsd: null });
    expect(back.body.learning).toMatchObject({ capUsd: 5, capSource: 'default' });
  });

  it('refuses a program owner (initiative-scoped) and a bad figure', async () => {
    const po = await request(mia()).put('/api/budgets/learning').send({ monthlyCapUsd: 50 });
    expect(po.status).toBe(403);
    expect(po.body.code).toBe('NOT_ORG_WIDE');
    for (const bad of [{}, { monthlyCapUsd: -1 }, { monthlyCapUsd: '5' }]) {
      expect((await request(vera()).put('/api/budgets/learning').send(bad)).status).toBe(400);
    }
    expect(learningBudget.rows()).toHaveLength(0);
  });
});
