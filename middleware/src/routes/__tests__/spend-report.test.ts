// GET /api/spend/report — the ledger grouped by initiative, person, model,
// source or trigger, with burn, projection, holds and allocations; one
// initiative's DE-53 blocks with ?initiativeId=. Offline, through the real
// providers: the spend-entries fixture plus bot_run entries derived from the
// bot_runs fixture, the registered holds, budgets, grants and work items.
// Below the budgets read tier every dollar is absent (never zero) except the
// caller's own.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
// The tier by role only, so the test does not depend on the Cedar seed.
jest.mock('../../lib/budget-read-tier.js', () => {
  const actual = jest.requireActual('../../lib/budget-read-tier.js');
  return { ...actual, canReadBudgets: async (s: { role: string } | null) => !!s && actual.BUDGET_READ_ROLES.includes(s.role) };
});

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireSession } from '../../lib/authz.js';
import { spendReportRouter } from '../spend-report.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { getBudget } from '../../providers/budgets.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { workItems } from '../../mock/work-items.js';
import { freezeClock } from '../../mock/core/index.js';
import { __resetMockRuns } from '../../providers/bots.js';
import type { Session } from '../../lib/session.js';
import type { SpendHold } from '../../providers/spend-holds.js';

const AUTH = 'p-auth-migration';

const app = express();
app.use((req, _res, next) => {
  const sub = req.headers['x-user'];
  const role = req.headers['x-role'];
  if (typeof sub === 'string') req.session = { sub, tenant: 'orgiq', role: typeof role === 'string' ? role : 'org-leader', iat: 1, grants: { orgiq: ['org-leader', 'sme'] } } as unknown as Session;
  next();
});
app.use('/api/spend', requireSession('ViewSpendReport'), spendReportRouter);
app.use(errorHandler);

const leader = (q: Record<string, string>) => request(app).get('/api/spend/report').query(q).set('x-user', 'u-release').set('x-role', 'org-leader');
const sme = (q: Record<string, string>, sub = 'u-nora') => request(app).get('/api/spend/report').query(q).set('x-user', sub).set('x-role', 'sme');

function hold(over: Partial<SpendHold>): SpendHold {
  return {
    id: `h-${Math.random().toString(36).slice(2)}`, initiativeId: AUTH, grantId: null, actorId: 'u-nora', source: 'box_task',
    sourceId: null, amountUsd: 1.5, basis: 'p75', essential: false, status: 'held',
    expiresAt: '2026-10-29T13:00:00.000Z', createdBy: 'u-nora', createdAt: '2026-10-29T11:50:00.000Z', closedAt: null, ...over,
  };
}

let unfreeze: () => void;
beforeAll(() => { unfreeze = freezeClock('2026-10-29T12:00:00.000Z'); });
afterAll(() => unfreeze());
beforeEach(() => {
  spendEntries.reset();
  spendHolds.reset();
  workItems.reset();
  __resetMockRuns();
});

describe('GET /api/spend/report — grouped', () => {
  it('groups by initiative with allocation, discretionary remainder, burn and projection, and keeps allocated idle initiatives', async () => {
    const res = await leader({ groupBy: 'initiative' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ groupBy: 'initiative', period: 'month', since: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z', holdsTracked: true });
    expect(res.body.budgetAccess).toBeUndefined();
    const auth = res.body.groups.find((g: { key: string }) => g.key === AUTH);
    const budget = await getBudget(AUTH);
    expect(auth).toMatchObject({ label: 'Auth Migration', allocatedUsd: 75, remainingUsd: budget!.discretionaryRemainingUsd });
    expect(auth.knownUsd).toBeGreaterThan(0);
    // The projection is month-to-date plus the 7-day burn over the 2.5 days left.
    expect(res.body.daysLeftInPeriod).toBe(2.5);
    expect(auth.projectedPeriodEndUsd).toBeCloseTo(auth.knownUsd + auth.burnPerDay7d * 2.5, 1);
    // An allocated initiative with no spend is still a row (p-zero-trust is seeded allocated and idle).
    expect(res.body.groups.find((g: { key: string }) => g.key === 'p-zero-trust')).toMatchObject({ knownUsd: 0, entries: 0, allocatedUsd: 20 });
    // Unattributed spend is its own group, never folded into an initiative.
    expect(res.body.groups.some((g: { key: string | null }) => g.key === null)).toBe(true);
  });

  it('counts an unknown cost apart and never sums it as $0', async () => {
    const before = (await leader({ groupBy: 'source' })).body.groups.find((g: { key: string }) => g.key === 'box_task');
    await recordSpend({ source: 'box_task', sourceId: 'box-x:1', initiativeId: AUTH, boxId: 'box-x', actorId: 'u-nora', model: 'sonnet', costUsd: null });
    const after = (await leader({ groupBy: 'source' })).body.groups.find((g: { key: string }) => g.key === 'box_task');
    expect(after.unknownCount).toBe(before.unknownCount + 1);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.knownUsd).toBe(before.knownUsd);
    expect(after.label).toBe('Box tasks');
  });

  it('derives the burn from the trailing seven days and projects to the end of the month', async () => {
    spendEntries.rows().length = 0;
    const base = { source: 'box_task' as const, initiativeId: 'p-x', boxId: 'b', actorId: 'u-x', model: 'm-burn' };
    await recordSpend({ ...base, sourceId: 'b:old', costUsd: 10, occurredAt: '2026-10-02T00:00:00.000Z' });
    await recordSpend({ ...base, sourceId: 'b:new', costUsd: 7, occurredAt: '2026-10-28T00:00:00.000Z' });
    const g = (await leader({ groupBy: 'model' })).body.groups.find((x: { key: string }) => x.key === 'm-burn');
    expect(g).toMatchObject({ knownUsd: 17, burnPerDay7d: 1, projectedPeriodEndUsd: 19.5, heldUsd: null });
    // A 7-day window narrows the spend but not the month-end projection.
    const w = (await leader({ groupBy: 'model', period: '7d' })).body.groups.find((x: { key: string }) => x.key === 'm-burn');
    expect(w).toMatchObject({ knownUsd: 7, entries: 1, projectedPeriodEndUsd: 19.5 });
  });

  it('carries open holds per initiative, per actor and per source, and none per model', async () => {
    spendHolds.rows().push(hold({ amountUsd: 1.5 }), hold({ amountUsd: 0.5, status: 'settled' }));
    const byInit = (await leader({ groupBy: 'initiative' })).body;
    expect(byInit.groups.find((g: { key: string }) => g.key === AUTH).heldUsd).toBe(1.5);
    expect(byInit.totals.heldUsd).toBe(1.5);
    expect((await leader({ groupBy: 'actor' })).body.groups.find((g: { key: string }) => g.key === 'u-nora').heldUsd).toBe(1.5);
    expect((await leader({ groupBy: 'source' })).body.groups.find((g: { key: string }) => g.key === 'box_task').heldUsd).toBe(1.5);
    expect((await leader({ groupBy: 'trigger' })).body.totals.heldUsd).toBeNull();
  });

  it('gives an actor with a user budget its remainder, and an actor without one none', async () => {
    const res = await leader({ groupBy: 'actor' });
    const nora = res.body.groups.find((g: { key: string }) => g.key === 'u-nora');
    expect(nora).toMatchObject({ label: 'Nora DaSilva', allocatedUsd: 25 });
    expect(nora.remainingUsd).toBeCloseTo(25 - nora.knownUsd, 4);
    const vera = res.body.groups.find((g: { key: string }) => g.key === 'u-vera');
    expect(vera).toBeDefined();
    expect('remainingUsd' in vera).toBe(false);
  });

  it('refuses an unknown grouping, period or malformed initiative id', async () => {
    expect((await leader({ groupBy: 'team' })).status).toBe(400);
    expect((await leader({ period: 'year' })).status).toBe(400);
    expect((await leader({ initiativeId: 'p x; drop' })).status).toBe(400);
  });
});

describe('GET /api/spend/report?initiativeId= — the DE-53 blocks', () => {
  it('reports the same spent figure as the Budgets row, the floor and discretionary split, envelopes, people and runs', async () => {
    const res = await leader({ groupBy: 'actor', initiativeId: AUTH });
    expect(res.status).toBe(200);
    const ini = res.body.initiative;
    const budget = await getBudget(AUTH);
    expect(ini.allocation).toMatchObject({ allocatedUsd: 75, spentUsd: budget!.spentThisPeriodUsd, runCount: budget!.runCountThisPeriod });
    expect(ini.reserve).toMatchObject({
      reserveUsd: budget!.reserveUsd, floorSpentUsd: budget!.floorSpentUsd,
      discretionarySpentUsd: budget!.discretionarySpentUsd, discretionaryRemainingUsd: budget!.discretionaryRemainingUsd,
    });
    // Every grant on the initiative, the grantee's own burn where the grantee has an account.
    const nora = ini.envelopes.find((e: { granteeUserId: string | null }) => e.granteeUserId === 'u-nora');
    expect(nora).toMatchObject({ attributionAvailable: true, allocatedUsd: 15 });
    // Simone Chang (p-051) signs in as u-simone now, so her envelope is attributed too.
    expect(ini.envelopes.find((e: { granteeUserId: string | null }) => e.granteeUserId === 'u-simone')).toMatchObject({ attributionAvailable: true });
    // A grantee with no account (Joy Chen on SOC2) has a grant and no attributable burn.
    const soc2 = (await leader({ groupBy: 'actor', initiativeId: 'p-soc2' })).body.initiative;
    const unlinked = soc2.envelopes.find((e: { granteeUserId: string | null }) => e.granteeUserId === null);
    expect(unlinked).toMatchObject({ spentUsd: null, remainingUsd: null, attributionAvailable: false });
    // People are this initiative's ledger grouped by actor — the groups themselves when groupBy=actor.
    expect(ini.people).toEqual(res.body.groups);
    expect(ini.runs.total).toBe(ini.runs.byStatus.done + ini.runs.byStatus.failed + ini.runs.byStatus.skipped + ini.runs.byStatus.running);
    expect(ini.holds).toMatchObject({ tracked: true, count: 0, heldUsd: 0 });
  });

  it('lists mixed-model forecasts per model and fits each open item against the discretionary remainder in priority order', async () => {
    const rows = workItems.rows();
    const a = rows.find((i) => i.id === 'wi-auth-e2-s2')!;
    const b = rows.find((i) => i.id === 'wi-auth-e2-b3')!;
    a.estimateModel = 'opus'; a.estimateForecast = { costUsdP25: 30, costUsdP75: 60 };
    b.estimateModel = 'haiku'; b.estimateForecast = { costUsdP25: 0.5, costUsdP75: 9 };
    const res = await leader({ groupBy: 'source', initiativeId: AUTH });
    const f = res.body.initiative.forecast;
    const remaining = res.body.initiative.reserve.discretionaryRemainingUsd;
    expect(f.mixedModels).toBe(true);
    expect(f.models).toEqual([
      { model: 'opus', p25Usd: 30, p75Usd: 60, items: 1 },
      { model: 'haiku', p25Usd: 0.5, p75Usd: 9, items: 1 },
    ]);
    expect(f.p75Usd).toBe(69);
    // The high-priority item fits; the medium one is judged after it.
    const [first, second] = f.items;
    expect(first).toMatchObject({ id: 'wi-auth-e2-s2', basis: 'forecast', p75Usd: 60, aheadUsd: 0, fitsRemaining: 60 <= remaining });
    expect(second).toMatchObject({ id: 'wi-auth-e2-b3', aheadUsd: 60, fitsRemaining: 9 <= remaining - 60 });
    expect(second.fitsRemaining).toBe(false);
  });
});

describe('GET /api/spend/report — below the budgets read tier', () => {
  it('withholds every dollar (absent, not zero) and says why', async () => {
    const res = await sme({ groupBy: 'initiative' });
    expect(res.status).toBe(200);
    expect(res.body.budgetAccess).toMatchObject({ visible: false, requestItemId: 'capability:orgiq:budgets-read' });
    for (const g of res.body.groups) {
      for (const k of ['knownUsd', 'burnPerDay7d', 'projectedPeriodEndUsd', 'heldUsd', 'remainingUsd', 'allocatedUsd']) expect(k in g).toBe(false);
      expect(typeof g.entries).toBe('number');
    }
    expect('knownUsd' in res.body.totals).toBe(false);
  });

  it('narrows a person grouping to the caller, whose own figures stay', async () => {
    const res = await sme({ groupBy: 'actor' });
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ key: 'u-nora', allocatedUsd: 25 });
    expect(res.body.groups[0].knownUsd).toBeGreaterThan(0);
  });

  it('keeps only the caller\'s own envelope and person row on an initiative, and drops allocation and reserve', async () => {
    const res = await sme({ groupBy: 'source', initiativeId: AUTH });
    const ini = res.body.initiative;
    expect(ini.allocation).toBeUndefined();
    expect(ini.reserve).toBeUndefined();
    expect(ini.budgetAccess).toMatchObject({ visible: false });
    expect(ini.envelopes.map((e: { grantId: string }) => e.grantId)).toEqual(['bg-auth-3']);
    expect(ini.envelopes[0].allocatedUsd).toBe(15);
    expect(ini.people.map((p: { key: string }) => p.key)).toEqual(['u-nora']);
    for (const item of ini.forecast.items) expect('p75Usd' in item || 'fitsRemaining' in item).toBe(false);
    expect('p75Usd' in ini.forecast).toBe(false);
    expect(ini.runs.total).toBeGreaterThan(0);
  });
});

describe('GET /api/spend/report — groupBy=bot', () => {
  it('groups bot runs by bot with its name, puts everything else in one "Not from a bot" group, and adds up to the initiative total', async () => {
    const [bot, ini] = await Promise.all([leader({ groupBy: 'bot' }), leader({ groupBy: 'initiative' })]);
    expect(bot.status).toBe(200);
    const named = bot.body.groups.filter((g: { key: string | null }) => g.key != null);
    expect(named.length).toBeGreaterThan(0);
    for (const g of named) expect(g.label).not.toBe(g.key);
    const none = bot.body.groups.filter((g: { key: string | null }) => g.key == null);
    expect(none).toHaveLength(1);
    expect(none[0].label).toBe('Not from a bot');
    expect(bot.body.totals.knownUsd).toBeCloseTo(ini.body.totals.knownUsd, 4);
    expect(bot.body.totals.entries).toBe(ini.body.totals.entries);
    expect(bot.body.totals.unknownCount).toBe(ini.body.totals.unknownCount);
    expect(bot.body.groups.reduce((a: number, g: { entries: number }) => a + g.entries, 0)).toBe(bot.body.totals.entries);
  });

  it('ties a stored job entry to the bot whose run carried that job, and keeps an unknown cost unknown', async () => {
    const probe = await leader({ groupBy: 'bot' });
    const botKey = probe.body.groups.find((g: { key: string | null }) => g.key != null).key as string;
    const { listBotRuns } = await import('../../providers/bots.js');
    const run = (await listBotRuns(botKey, 50)).find((r) => r.jobId);
    expect(run).toBeTruthy();
    const before = (await leader({ groupBy: 'bot' })).body.groups.find((g: { key: string }) => g.key === botKey);
    await recordSpend({ source: 'job', sourceId: run!.jobId!, initiativeId: AUTH, grantId: null, boxId: null, actorId: null, model: 'nova-lite', costUsd: null });
    const after = (await leader({ groupBy: 'bot' })).body.groups.find((g: { key: string }) => g.key === botKey);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.unknownCount).toBe(before.unknownCount + 1);
    expect(after.knownUsd).toBe(before.knownUsd);
  });
});

describe('GET /api/spend/report and /entries — botId', () => {
  it('narrows the grouped report and the entries to one bot, and refuses a malformed id', async () => {
    const all = await leader({ groupBy: 'bot' });
    const g = all.body.groups.find((x: { key: string | null; entries: number }) => x.key != null && x.entries > 0);
    const one = await leader({ groupBy: 'bot', botId: g.key });
    expect(one.status).toBe(200);
    expect(one.body.botId).toBe(g.key);
    expect(one.body.groups.map((x: { key: string | null }) => x.key)).toEqual([g.key]);
    expect(one.body.totals.entries).toBe(g.entries);
    const byModel = await leader({ groupBy: 'model', botId: g.key });
    expect(byModel.body.totals.entries).toBe(g.entries);
    const e = await request(app).get('/api/spend/entries').query({ groupBy: 'model', key: '', botId: g.key, limit: '100' })
      .set('x-user', 'u-release').set('x-role', 'org-leader');
    expect(e.status).toBe(200);
    expect(e.body.botId).toBe(g.key);
    for (const row of e.body.entries) expect(row.botId).toBe(g.key);
    expect((await leader({ groupBy: 'bot', botId: 'bad id;' })).status).toBe(400);
  });
});

describe('GET /api/spend/entries', () => {
  const entries = (q: Record<string, string>, sub = 'u-release', role = 'org-leader') =>
    request(app).get('/api/spend/entries').query(q).set('x-user', sub).set('x-role', role);

  it('refuses a reader with no session', async () => {
    const closed = express();
    closed.use((req, _res, next) => { req.sessionInvalid = true; next(); });
    closed.use('/api/spend', requireSession('ViewSpendReport'), spendReportRouter);
    const res = await request(closed).get('/api/spend/entries').query({ groupBy: 'bot' });
    expect(res.status).toBe(401);
  });

  it('rejects a bad grouping, period or page', async () => {
    expect((await entries({ groupBy: 'nope' })).status).toBe(400);
    expect((await entries({ groupBy: 'bot', period: 'year' })).status).toBe(400);
    expect((await entries({ groupBy: 'bot', limit: '0' })).status).toBe(400);
  });

  it('lists every group of every grouping, newest first, adding up to the group count', async () => {
    for (const groupBy of ['initiative', 'actor', 'model', 'source', 'trigger', 'bot']) {
      const report = await leader({ groupBy });
      for (const g of report.body.groups as Array<{ key: string | null; entries: number }>) {
        if (g.entries === 0) continue;
        const res = await entries({ groupBy, key: g.key ?? '', limit: '100' });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(g.entries);
        const ats = res.body.entries.map((e: { at: string }) => e.at);
        expect([...ats].sort().reverse()).toEqual(ats);
      }
    }
  });

  it('pages, links a bot run to its run report, and names the bot', async () => {
    const report = await leader({ groupBy: 'bot' });
    const g = report.body.groups.find((x: { key: string | null; entries: number }) => x.key != null && x.entries > 1);
    const first = await entries({ groupBy: 'bot', key: g.key, limit: '1' });
    const second = await entries({ groupBy: 'bot', key: g.key, limit: '1', offset: '1' });
    expect(first.body.entries).toHaveLength(1);
    expect(second.body.entries[0].sourceId).not.toBe(first.body.entries[0].sourceId);
    expect(first.body.entries[0]).toMatchObject({ source: 'bot_run', botId: g.key, what: g.label });
    expect(first.body.entries[0].runRef).toMatch(/^job-/);
  });

  it('shows an unknown cost as null with basis unknown, never zero', async () => {
    await recordSpend({ source: 'box_task', sourceId: 'box-unknown-1', initiativeId: AUTH, grantId: null, boxId: null, actorId: 'u-nora', model: null, costUsd: null });
    const res = await entries({ groupBy: 'source', key: 'box_task', limit: '100' });
    const row = res.body.entries.find((e: { sourceId: string }) => e.sourceId === 'box-unknown-1');
    expect(row.costUsd).toBeNull();
    expect(row.costBasis).toBe('unknown');
    expect(row.runRef).toBeNull();
  });

  it('withholds dollars and other people from a reader below the tier, and answers an actor grouping only for the caller', async () => {
    await recordSpend({ source: 'box_task', sourceId: 'box-nora-1', initiativeId: AUTH, grantId: null, boxId: null, actorId: 'u-nora', model: 'nova-lite', costUsd: 0.2 });
    const res = await entries({ groupBy: 'source', key: 'box_task', limit: '100' }, 'u-nora', 'sme');
    expect(res.body.budgetAccess).toMatchObject({ visible: false });
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const e of res.body.entries) {
      expect('costUsd' in e).toBe(false);
      if (e.actorId != null) expect(e.actorId).toBe('u-nora');
    }
    const others = await entries({ groupBy: 'actor', key: 'u-release' }, 'u-nora', 'sme');
    expect(others.body.entries).toEqual([]);
    expect(others.body.total).toBe(0);
    const own = await entries({ groupBy: 'actor', key: 'u-nora' }, 'u-nora', 'sme');
    expect(own.body.entries.length).toBeGreaterThan(0);
    expect('costUsd' in own.body.entries[0]).toBe(false);
  });
});
