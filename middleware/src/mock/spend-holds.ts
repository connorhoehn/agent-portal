// Spend holds, offline — `spend_holds` (schema/spend_holds_schema.sql).
//
// Every row is written by a dispatch in this process (a seed would assert
// money in flight that nothing is spending), so the fixture starts empty and
// `POST /api/__mock/reset` empties it again. Rows are appended and mutated by
// providers/spend-holds.ts under its in-process keyed lock, the mock analogue
// of the advisory transaction lock the Aurora path takes.

import { defineFixture } from './core/index.js';
import type { SpendHold } from '../providers/spend-holds.js';

export const spendHolds = defineFixture<SpendHold>({
  key: 'spend-holds',
  scenarios: {
    default: () => [],
    empty: () => [],
    error: () => { throw new Error('spend_holds unavailable: relation does not exist'); },
  },
});
