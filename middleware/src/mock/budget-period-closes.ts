// Budget period closes, offline — `budget_period_closes`
// (schema/budget_periods_schema.sql, DE-38).
//
// Columns only, and nothing seeded: a close row is DERIVED from the run
// history the first time a read needs the period after it, exactly as the
// Aurora read writes it (providers/budget-periods.ts). Every seeded allocation
// is monthly with carry-over 'none', which never closes at a boundary, so a
// fresh process holds no rows; an initiative that opts in gets its closes
// computed from the seeded bot_runs on the next read, and
// `POST /api/__mock/reset` takes them back out with the policy change.

import { defineFixture } from './core/index.js';

export interface MockPeriodClose {
  orgProjectId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  allocatedUsd: number;
  carryInUsd: number;
  spentUsd: number;
  unknownCostEntries: number;
  carryOutUsd: number;
  reason: 'boundary' | 'reconfigured';
  closedAt: string;
}

export const budgetPeriodCloses = defineFixture<MockPeriodClose>({
  key: 'budget-period-closes',
  scenarios: {
    default: () => [],
  },
});
