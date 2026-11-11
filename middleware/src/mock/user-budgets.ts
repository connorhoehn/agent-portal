// User budgets, offline — `user_budgets` (schema/user_budgets_schema.sql, DE-54).
//
// Columns only. A user's burn is a read over the spend ledger (stored box-task
// entries plus bot runs derived from the bot_runs fixture) and their open
// holds, in providers/user-budgets.ts; it is never typed here.
//
// One seeded row, so the budget a user is braked by is demonstrable in
// dev:mock: Nora DaSilva (u-nora), the seeded SME. Every other seeded user has
// no row, which is the blind spot the release manager's list shows. The
// figure is sized above the Computer Lab demo's spend (three agents at ~$0.30
// each, mock/budgets.ts DEMO_ENVELOPE_USD) so the envelope, not her own
// budget, is still what stops the demo's fourth item. Her cap is null, i.e.
// the deployment default (allocated x BUDGET_HARD_CAP_FACTOR).

import { defineFixture } from './core/index.js';

export interface MockUserBudget {
  userId: string;
  allocatedUsd: number;
  hardCapUsd: number | null;
  note: string | null;
  setBy: string | null;
  /** Unset on the seed (reads as six days ago); set by every write. */
  updatedAt?: string | null;
}

function seeded(): MockUserBudget[] {
  return [
    { userId: 'u-nora', allocatedUsd: 25, hardCapUsd: null, note: 'SME on Auth Migration: agent spend across every initiative', setBy: 'u-release' },
    // The Budgets page's "at cap" person (learning loop, lane B): Eli Garcia's
    // $0.53 box task this month (mock/spend-ledger.ts, minutes old, so it holds
    // all month) against a $0.50 budget. His cap is the deployment default.
    { userId: 'u-eli', allocatedUsd: 0.5, hardCapUsd: null, note: 'SME on Observability: a trial budget, already spent', setBy: 'u-release' },
  ];
}

export const userBudgets = defineFixture<MockUserBudget>({
  key: 'user-budgets',
  scenarios: {
    default: seeded,
    empty: () => [],
    // "No budgets set" and "budgets could not be read" must not read alike:
    // the first is unbraked, the second fails closed where configured.
    error: () => { throw new Error('user_budgets unavailable: relation does not exist'); },
  },
});
