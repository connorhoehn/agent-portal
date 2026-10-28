// The spend ledger offline (DE-30): the writer's idempotency and unknown-cost
// rules, and the mock readers in each SPEND_LEDGER mode. The SQL itself is
// proven against PostgreSQL in spend-ledger-postgres.test.ts.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { recordSpend, mockStoredEntries, ledgerMismatches, spendLedgerMode } from '../spend-ledger.js';
import { getBudget, listGrants, orgSummary } from '../budgets.js';
import { dispatchedSpendInWindow } from '../bots.js';
import { exec } from '../aurora.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { freezeClock } from '../../mock/core/index.js';

const box = (over: Partial<Parameters<typeof recordSpend>[0]> = {}) => ({
  source: 'box_task' as const, sourceId: 'box-1:t1', initiativeId: 'p-auth-migration', boxId: 'box-1',
  actorId: 'u-nora', model: 'sonnet', costUsd: 0.5, ...over,
});

let unfreeze: () => void;
beforeAll(() => { unfreeze = freezeClock('2026-10-15T12:00:00Z'); });
afterAll(() => unfreeze());
beforeEach(() => {
  spendEntries.reset();
  delete process.env['SPEND_LEDGER'];
});

describe('writer', () => {
  it('a retried write leaves one row', async () => {
    await recordSpend(box());
    await recordSpend(box());
    expect(mockStoredEntries()).toHaveLength(1);
  });

  it('keeps unknown distinct from zero, and lets a late figure replace unknown but never a known cost', async () => {
    await recordSpend(box({ costUsd: null }));
    expect(mockStoredEntries()[0]).toMatchObject({ costUsd: null, costBasis: 'unknown' });
    await recordSpend(box({ costUsd: 0.3 }));
    await recordSpend(box({ costUsd: 9 }));
    expect(mockStoredEntries()[0]).toMatchObject({ costUsd: 0.3, costBasis: 'reported' });
  });

  it('stores no bot_run rows offline: those are derived from the bot_runs fixture', async () => {
    await recordSpend(box({ source: 'bot_run', sourceId: 'run-1' }));
    expect(mockStoredEntries()).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('readers', () => {
  it('reads the SPEND_LEDGER mode, defaulting to off', () => {
    expect(spendLedgerMode()).toBe('off');
    process.env['SPEND_LEDGER'] = 'dual';
    expect(spendLedgerMode()).toBe('dual');
    process.env['SPEND_LEDGER'] = 'ledger';
    expect(spendLedgerMode()).toBe('ledger');
  });

  it('ignores ad-hoc spend until the ledger is on, then counts it on every surface', async () => {
    const before = await getBudget('p-auth-migration');
    // An envelope whose sprint window contains the frozen clock.
    const inWindow = (g: { startsOn: string | null; endsOn: string | null }) =>
      (g.startsOn == null || g.startsOn <= '2026-10-15') && (g.endsOn == null || g.endsOn >= '2026-10-15');
    const grant = (await listGrants('p-auth-migration')).find(inWindow);
    const org = await orgSummary();
    const burn = await dispatchedSpendInWindow({ orgProjectId: 'p-auth-migration', dispatchedBy: 'u-nora', startsOn: null, endsOn: null });

    await recordSpend(box());
    await recordSpend(box({ sourceId: 'box-1:t2', costUsd: null }));
    expect((await getBudget('p-auth-migration'))!.spentThisPeriodUsd).toBe(before!.spentThisPeriodUsd);

    process.env['SPEND_LEDGER'] = 'ledger';
    const after = (await getBudget('p-auth-migration'))!;
    expect(after.spentThisPeriodUsd).toBeCloseTo(before!.spentThisPeriodUsd + 0.5, 4);
    expect(after.runCountThisPeriod).toBe(before!.runCountThisPeriod + 1);
    expect(after.unknownCostCount).toBe(1);
    // A box task is not cron, so the maintenance floor does not move.
    expect(after.maintenanceUsd).toBe(before!.maintenanceUsd);

    if (grant) {
      const grantAfter = (await listGrants('p-auth-migration')).find((g) => g.id === grant.id)!;
      expect(grantAfter.initiativeSpendInWindowUsd).toBeCloseTo(grant.initiativeSpendInWindowUsd + 0.5, 4);
    }
    const orgAfter = await orgSummary();
    expect(orgAfter.totalSpentThisPeriodUsd).toBeCloseTo(org.totalSpentThisPeriodUsd + 0.5, 4);
    expect(orgAfter.byTrigger.find((t) => t.trigger === 'box_task')).toMatchObject({ spentUsd: 0.5, runCount: 1 });

    const burnAfter = await dispatchedSpendInWindow({ orgProjectId: 'p-auth-migration', dispatchedBy: 'u-nora', startsOn: null, endsOn: null });
    expect(burnAfter.spentUsd).toBeCloseTo(burn.spentUsd + 0.5, 4);
  });

  it('names every initiative whose ledger and legacy totals differ', () => {
    expect(ledgerMismatches(
      [{ id: 'a', usd: 1 }, { id: 'b', usd: 2 }],
      [{ id: 'a', usd: 1 }, { id: 'b', usd: 2.5 }, { id: 'c', usd: 0.1 }],
    )).toEqual([{ id: 'b', legacyUsd: 2, ledgerUsd: 2.5 }, { id: 'c', legacyUsd: 0, ledgerUsd: 0.1 }]);
  });
});
