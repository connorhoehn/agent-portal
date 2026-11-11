// Budget thresholds (docs/learning-loop-design.md "Budgets", lane B), through the
// REAL reserveSpend and ledger in dev:mock: one bell item per (budget, threshold,
// period), to the owner and at 100 % the org leaders, decided by a stored mark.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));

import { reserveSpend } from '../spend-holds.js';
import {
  announceCrossing, budgetsRowHref, checkBudgetThresholds, configuredThresholds, thresholdChecksSettled,
  thresholdState, thresholdsReached,
} from '../budget-thresholds.js';
import { setNotificationSink } from '../social-notify.js';
import { getBudget } from '../../providers/budgets.js';
import { releaseHold } from '../../providers/spend-holds.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { listUsers } from '../../providers/identity.js';
import { userSpendThisPeriod } from '../../providers/user-budgets.js';
import { initiativeBudgets, budgetGrants } from '../../mock/budgets.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { budgetThresholdMarks } from '../../mock/run-controls.js';

const MOBILE = 'p-mobile-redesign'; // owned by Mia Singh (u-mia, program-owner)
const ALL_CONFIRMED = { allocation: true, envelope: true, userBudget: true };

interface Sent { userId: string; id?: string; title: string; href?: string; payload?: Record<string, unknown> }
let sent: Sent[] = [];
let failDelivery = false;

beforeEach(() => {
  for (const f of [spendHolds, spendEntries, initiativeBudgets, budgetGrants, userBudgets, budgetThresholdMarks]) f.reset();
  sent = [];
  failDelivery = false;
  setNotificationSink({
    notifyUser: async (userId, input) => {
      if (failDelivery) throw new Error('gateway down');
      sent.push({ userId, id: input.id, title: input.title, href: input.action?.href, payload: input.payload });
    },
  });
  delete process.env['BUDGET_THRESHOLDS'];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  setNotificationSink(null);
  jest.restoreAllMocks();
});

/** Put the initiative's spend at `pct` of its allocation (spend is derived; the allocation moves). */
async function allocateSoSpentIs(id: string, pct: number): Promise<{ spent: number; allocated: number }> {
  const spent = (await getBudget(id))!.spentThisPeriodUsd;
  expect(spent).toBeGreaterThan(0);
  const allocated = spent / pct;
  initiativeBudgets.rows().find((b) => b.id === id)!.allocated = allocated;
  return { spent, allocated };
}

const hold = (id: string, amountUsd: number, actorId: string | null = null) => reserveSpend({
  initiativeId: id, actorId, source: 'job', sourceId: `job-${Math.random()}:1`,
  forecast: { costUsdP75: amountUsd }, confirmed: ALL_CONFIRMED, expiresInMs: 60_000,
});

const forSubject = (id: string) => sent.filter((n) => n.payload?.['subjectId'] === id);

describe('pure rules', () => {
  it('reads BUDGET_THRESHOLDS, defaulting anything unreadable to 50, 80, 100', () => {
    expect(configuredThresholds(undefined)).toEqual([50, 80, 100]);
    expect(configuredThresholds('90, 25,90')).toEqual([25, 90]);
    expect(configuredThresholds('50,abc')).toEqual([50, 80, 100]);
    expect(configuredThresholds('0,80')).toEqual([50, 80, 100]);
  });

  it('measures spent + held against the budget, at the line counting as reached', () => {
    expect(thresholdState(40, 100)).toEqual({ percent: 40, reached: 0 });
    expect(thresholdState(80, 100)).toEqual({ percent: 80, reached: 80 });
    expect(thresholdState(130, 100)).toEqual({ percent: 130, reached: 100 });
    expect(thresholdState(10, null)).toEqual({ percent: null, reached: 0 });
    expect(thresholdsReached(85, 100)).toEqual([50, 80]);
  });

  it('links each kind of budget to its Budgets row', () => {
    expect(budgetsRowHref({ kind: 'initiative', id: 'p-x' })).toBe('/admin/budgets?row=p-x');
    expect(budgetsRowHref({ kind: 'user', id: 'u-x' })).toBe('/admin/budgets?report=people&row=u-x');
    expect(budgetsRowHref({ kind: 'grant', id: 'g 1' })).toBe('/admin/budgets?report=sprints&row=g%201');
  });
});

describe('at the reservation', () => {
  it('one reservation crossing 50 and 80 announces both, once each, to the owner', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.4);
    const r = await hold(MOBILE, allocated * 0.45);
    expect(r.kind).toBe('held');
    const items = forSubject(MOBILE);
    expect(items.map((n) => n.payload?.['threshold'])).toEqual([50, 80]);
    expect(new Set(items.map((n) => n.userId))).toEqual(new Set(['u-mia']));
    expect(items[0]!.href).toBe(`/admin/budgets?row=${MOBILE}`);
    expect(items[1]!.title).toMatch(/Mobile App Redesign has used 80% of its budget/);
    expect(budgetThresholdMarks.rows().filter((m) => m.subjectId === MOBILE).map((m) => m.threshold)).toEqual([50, 80]);

    // A second hold under 100 % says nothing new.
    await hold(MOBILE, allocated * 0.05);
    expect(forSubject(MOBILE)).toHaveLength(2);
  });

  it('at 100 % the org leaders hear too', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.9);
    await hold(MOBILE, allocated * 0.15);
    const leaders = (await listUsers()).filter((u) => (u.grants['orgiq'] ?? []).includes('org-leader')).map((u) => u.id);
    expect(leaders.length).toBeGreaterThan(0);
    const atCap = forSubject(MOBILE).filter((n) => n.payload?.['threshold'] === 100);
    expect(new Set(atCap.map((n) => n.userId))).toEqual(new Set(['u-mia', ...leaders]));
    expect(atCap[0]!.title).toMatch(/has reached its budget/);
    // 50 and 80 went to the owner only.
    for (const t of [50, 80]) expect(forSubject(MOBILE).filter((n) => n.payload?.['threshold'] === t).map((n) => n.userId)).toEqual(['u-mia']);
  });

  it('a refund back under and a re-crossing in the same period sends nothing more', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.7);
    const first = await hold(MOBILE, allocated * 0.15);
    expect(forSubject(MOBILE).map((n) => n.payload?.['threshold'])).toEqual([50, 80]);
    if (first.kind !== 'held') throw new Error('expected a hold');
    await releaseHold(first.holdId);
    expect(thresholdState((await getBudget(MOBILE))!.spentThisPeriodUsd, allocated).reached).toBe(50);
    await hold(MOBILE, allocated * 0.15);
    expect(forSubject(MOBILE)).toHaveLength(2);
  });

  it('a new period announces afresh; the same period never twice', async () => {
    const c = { subject: { kind: 'initiative' as const, id: MOBILE }, label: 'Mobile App Redesign', ownerUserId: 'u-mia', usedUsd: 85, budgetUsd: 100 };
    expect((await announceCrossing({ ...c, periodKey: '2026-11' })).map((a) => a.threshold)).toEqual([50, 80]);
    expect(await announceCrossing({ ...c, periodKey: '2026-11' })).toEqual([]);
    expect((await announceCrossing({ ...c, usedUsd: 55, periodKey: '2026-12' })).map((a) => a.threshold)).toEqual([50]);
    expect(budgetThresholdMarks.rows().map((m) => `${m.periodKey}:${m.threshold}`)).toEqual(['2026-11:50', '2026-11:80', '2026-12:50']);
  });

  it('two replicas checking at once announce each threshold once (the mark decides)', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.55);
    initiativeBudgets.rows().find((b) => b.id === MOBILE)!.allocated = allocated;
    await Promise.all([checkBudgetThresholds({ initiativeId: MOBILE, actorId: null }), checkBudgetThresholds({ initiativeId: MOBILE, actorId: null })]);
    expect(forSubject(MOBILE).map((n) => n.payload?.['threshold'])).toEqual([50]);
  });

  it('a failed bell or an unwritable mark never fails the reservation', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.4);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    failDelivery = true;
    expect((await hold(MOBILE, allocated * 0.2)).kind).toBe('held');
    expect(sent).toHaveLength(0);
    // The mark was written, so a recovered gateway does not get a late duplicate.
    failDelivery = false;
    await hold(MOBILE, allocated * 0.01);
    expect(forSubject(MOBILE)).toHaveLength(0);

    jest.spyOn(budgetThresholdMarks, 'rows').mockImplementation(() => { throw new Error('budget_threshold_marks unavailable'); });
    const r = await hold(MOBILE, allocated * 0.3);
    expect(r.kind).toBe('held');
    expect(forSubject(MOBILE)).toHaveLength(0);
  });

  it('the existing hard cap still refuses at its line, thresholds or not', async () => {
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.9);
    const r = await hold(MOBILE, allocated * 0.5); // 140 % > the 125 % derived cap
    expect(r.kind).toBe('capped');
    expect(forSubject(MOBILE)).toHaveLength(0);
  });

  it("a user's own budget: the user hears it, with no link when they cannot open Budgets", async () => {
    // Nora's budget, sized so her seeded spend this month plus this hold lands at 85 %.
    const spent = (await userSpendThisPeriod('u-nora')).spentUsd;
    const row = userBudgets.rows().find((u) => u.userId === 'u-nora')!;
    row.allocatedUsd = (spent + 9) / 0.85;
    row.hardCapUsd = 1_000;
    const r = await reserveSpend({
      initiativeId: null, actorId: 'u-nora', source: 'box_task', sourceId: 'box-x:1',
      forecast: { costUsdP75: 9 }, confirmed: ALL_CONFIRMED, expiresInMs: 60_000,
    });
    expect(r.kind).toBe('held');
    const items = forSubject('u-nora');
    expect(items.map((n) => n.payload?.['threshold'])).toEqual([50, 80]);
    // An SME cannot open /admin/budgets, so her item carries no link there.
    expect(items.every((n) => n.userId === 'u-nora' && n.href === undefined)).toBe(true);
    expect(items[1]!.title).toBe('Nora DaSilva has used 80% of their monthly budget');
    expect(items[0]!.payload?.['subjectKind']).toBe('user');
  });
});

describe('a sprint envelope', () => {
  it('crossing a grant tells its grantee (an SME: no link to a page they cannot open)', async () => {
    // Nora's Sprint 10 envelope on Auth Migration (bg-auth-3), sized to land at 85 %.
    const { loadEnvelopeGate } = await import('../bot-runner.js');
    const before = await loadEnvelopeGate('p-auth-migration', 'u-nora');
    if (before.kind !== 'ok') throw new Error('expected Nora to hold an envelope');
    const grant = budgetGrants.rows().find((g) => g.id === 'bg-auth-3')!;
    grant.allocatedUsd = (before.envelope.attributedSpentUsd + 2) / 0.85;
    // Room everywhere else, so only the envelope is near a line.
    initiativeBudgets.rows().find((b) => b.id === 'p-auth-migration')!.allocated = 10_000;
    userBudgets.rows().find((u) => u.userId === 'u-nora')!.allocatedUsd = 10_000;
    const r = await reserveSpend({
      initiativeId: 'p-auth-migration', actorId: 'u-nora', source: 'job', sourceId: 'job-g:1',
      forecast: { costUsdP75: 2 }, confirmed: ALL_CONFIRMED, expiresInMs: 60_000,
    });
    expect(r.kind).toBe('held');
    const items = forSubject('bg-auth-3');
    expect(items.map((n) => n.payload?.['threshold'])).toEqual([50, 80]);
    expect(items.every((n) => n.userId === 'u-nora' && n.href === undefined)).toBe(true);
    expect(items[1]!.title).toBe('The Sprint 10 — Session hygiene envelope on Auth Migration has used 80% of its budget');
  });
});

describe('at the settle', () => {
  it('a ledger entry that pushes spend over a line announces it, in the background', async () => {
    // Offline, stored entries count toward an initiative's spend in ledger mode.
    process.env['SPEND_LEDGER'] = 'ledger';
    const { allocated } = await allocateSoSpentIs(MOBILE, 0.45);
    await recordSpend({
      source: 'job', sourceId: 'job-settle:1', initiativeId: MOBILE, boxId: null, actorId: null,
      model: 'haiku', costUsd: allocated * 0.1, costBasis: 'reported', provider: 'bedrock',
    });
    await thresholdChecksSettled();
    delete process.env['SPEND_LEDGER'];
    expect(forSubject(MOBILE).map((n) => n.payload?.['threshold'])).toEqual([50]);
  });

  it('a $0 entry (a local run) moves no threshold', async () => {
    await allocateSoSpentIs(MOBILE, 0.49);
    await recordSpend({
      source: 'job', sourceId: 'job-local:1', initiativeId: MOBILE, boxId: null, actorId: null,
      model: 'sonnet', costUsd: 0, costBasis: 'reported', provider: 'local', reportedUsd: 4.2,
    });
    await thresholdChecksSettled();
    expect(forSubject(MOBILE)).toHaveLength(0);
  });
});
