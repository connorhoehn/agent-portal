// The pure money decisions beside the allocation and envelope brakes:
// DE-36 hard caps, DE-54 user budgets, DE-55 maintenance reserve.

import {
  autoReserveUsd, budgetFailClosed, decideFloorFire, decideHardCap, decideUserBudget, discretionary,
  effectiveHardCap, hardCapFactor, maintenanceReserveFactor, unbudgetedHardCapUsd,
} from '../budget-decisions.js';

const ENV = ['BUDGET_FAIL_CLOSED', 'BUDGET_HARD_CAP_FACTOR', 'UNBUDGETED_HARD_CAP_USD', 'MAINTENANCE_RESERVE_FACTOR', 'NODE_ENV'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; for (const k of ENV) delete process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('decideHardCap (DE-36)', () => {
  const at = (spentUsd: number, heldUsd: number, amountUsd: number) => decideHardCap({ capUsd: 10, spentUsd, heldUsd, amountUsd });
  it('under the cap proceeds', () => { expect(at(4, 1, 2)).toEqual({ kind: 'proceed' }); });
  it('exactly at the cap proceeds', () => { expect(at(5, 2, 3)).toEqual({ kind: 'proceed' }); });
  it('one cent over refuses, naming the cap and saying it cannot be confirmed', () => {
    const d = at(5, 2, 3.01);
    expect(d.kind).toBe('refuse');
    expect((d as { reason: string }).reason).toMatch(/\$10\.00 hard cap .*cannot be confirmed past/);
  });
  it('takes no confirmation at all: there is no flag that opens it', () => {
    // The signature has no `confirmed` argument; a caller cannot pass one.
    expect(decideHardCap.length).toBeLessThanOrEqual(2);
  });
});

describe('effectiveHardCap', () => {
  it('a stored cap wins', () => { expect(effectiveHardCap(10, 40)).toEqual({ capUsd: 40, source: 'set' }); });
  it('a null cap is allocated x 1.25 by default', () => { expect(effectiveHardCap(10, null)).toEqual({ capUsd: 12.5, source: 'factor' }); });
  it('the factor is config; `off` leaves only stored caps', () => {
    process.env['BUDGET_HARD_CAP_FACTOR'] = '2';
    expect(hardCapFactor()).toBe(2);
    expect(effectiveHardCap(10, null)?.capUsd).toBe(20);
    process.env['BUDGET_HARD_CAP_FACTOR'] = 'off';
    expect(effectiveHardCap(10, null)).toBeNull();
    expect(effectiveHardCap(10, 15)).toEqual({ capUsd: 15, source: 'set' });
  });
  it('an unbudgeted initiative is capped at $25 in production only, unless configured', () => {
    expect(unbudgetedHardCapUsd()).toBeNull();
    expect(effectiveHardCap(null, null, { unbudgeted: true })).toBeNull();
    process.env['NODE_ENV'] = 'production';
    expect(effectiveHardCap(null, null, { unbudgeted: true })).toEqual({ capUsd: 25, source: 'unbudgeted' });
    process.env['UNBUDGETED_HARD_CAP_USD'] = 'off';
    expect(unbudgetedHardCapUsd()).toBeNull();
    delete process.env['NODE_ENV'];
    process.env['UNBUDGETED_HARD_CAP_USD'] = '7';
    expect(unbudgetedHardCapUsd()).toBe(7);
  });
  it('a user or grant with no allocation has no cap', () => { expect(effectiveHardCap(null, null)).toBeNull(); });
});

describe('budgetFailClosed', () => {
  it('is off outside production (dev:mock), on in production', () => {
    expect(budgetFailClosed()).toBe(false);
    process.env['NODE_ENV'] = 'production';
    expect(budgetFailClosed()).toBe(true);
  });
  it('BUDGET_FAIL_CLOSED overrides either way', () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    expect(budgetFailClosed()).toBe(true);
    process.env['NODE_ENV'] = 'production';
    process.env['BUDGET_FAIL_CLOSED'] = '0';
    expect(budgetFailClosed()).toBe(false);
  });
});

describe('decideUserBudget (DE-54)', () => {
  const state = { allocatedUsd: 10, spentUsd: 6, heldUsd: 1 };
  it('fits the remainder', () => { expect(decideUserBudget(state, 3, false)).toEqual({ kind: 'proceed' }); });
  it('over the remainder asks for confirmOverUserBudget', () => {
    const d = decideUserBudget(state, 3.5, false);
    expect(d).toMatchObject({ kind: 'confirm' });
    expect((d as { reason: string }).reason).toMatch(/\$3\.00 left of your \$10\.00 monthly budget .*confirmOverUserBudget/);
  });
  it('spent out says so', () => {
    expect((decideUserBudget({ allocatedUsd: 5, spentUsd: 5, heldUsd: 0 }, 0.1, false) as { reason: string }).reason).toMatch(/spent out/);
  });
  it('a confirmation proceeds', () => { expect(decideUserBudget(state, 100, true)).toEqual({ kind: 'proceed' }); });
  it('unknown cost trips it only where the caller can confirm', () => {
    const s = { ...state, unknownCount: 2 };
    expect(decideUserBudget(s, 0.1, false)).toEqual({ kind: 'proceed' });
    expect(decideUserBudget(s, 0.1, false, { unknownCostTrips: true })).toMatchObject({ kind: 'confirm' });
  });
});

describe('discretionary and the floor (DE-55)', () => {
  it('the reserve comes off the top until the floor has spent past it', () => {
    expect(discretionary({ allocatedUsd: 100, reserveUsd: 20, floorSpentUsd: 5, discretionarySpentUsd: 30 }))
      .toEqual({ floorUsd: 20, discretionaryRemainingUsd: 50 });
    expect(discretionary({ allocatedUsd: 100, reserveUsd: 20, floorSpentUsd: 25, floorHeldUsd: 5, discretionarySpentUsd: 30, discretionaryHeldUsd: 10 }))
      .toEqual({ floorUsd: 30, discretionaryRemainingUsd: 30 });
  });
  it('with no reserve it is the pre-DE-55 remainder', () => {
    expect(discretionary({ allocatedUsd: 100, reserveUsd: 0, floorSpentUsd: 10, floorHeldUsd: 2, discretionarySpentUsd: 30, discretionaryHeldUsd: 3 }).discretionaryRemainingUsd)
      .toBe(100 - 10 - 2 - 30 - 3);
  });
  it('the auto reserve is the last closed period x 1.1, else the trailing 30 days x 1.1', () => {
    expect(maintenanceReserveFactor()).toBe(1.1);
    expect(autoReserveUsd(10, 99)).toBe(11);
    expect(autoReserveUsd(0, 4)).toBe(4.4);
    process.env['MAINTENANCE_RESERVE_FACTOR'] = '1.5';
    expect(autoReserveUsd(10, 0, maintenanceReserveFactor())).toBe(15);
  });

  const base = { allocatedUsd: 10, reserveUsd: 4, floorSpentUsd: 3, floorHeldUsd: 0, discretionarySpentUsd: 5, discretionaryHeldUsd: 0, allowSpill: true };
  it('an essential firing inside the reserve proceeds without spill', () => {
    expect(decideFloorFire({ ...base, amountUsd: 1 })).toEqual({ kind: 'proceed', spill: false });
  });
  it('past the reserve it spills into discretionary money while any is left', () => {
    // floor 3 + 2 = 5 > reserve 4: spill 1; discretionary left 10 - 4 - 5 = 1.
    expect(decideFloorFire({ ...base, amountUsd: 2 })).toEqual({ kind: 'proceed', spill: true });
  });
  it('and skips once the spill does not fit', () => {
    const d = decideFloorFire({ ...base, amountUsd: 2.5 });
    expect(d.kind).toBe('skip');
    expect((d as { reason: string }).reason).toMatch(/maintenance reserve .* discretionary money left/);
  });
  it('with spill off it stops at the reserve', () => {
    expect(decideFloorFire({ ...base, allowSpill: false, amountUsd: 2 })).toMatchObject({ kind: 'skip' });
  });
});
