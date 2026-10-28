// The spend ledger, offline — `spend_entries` (schema/spend_ledger_schema.sql).
//
// Only the rows that have no other home are stored: job, box_task and
// agent_loop entries. A `bot_run` entry is DERIVED from the bot_runs fixture at
// read time (providers/spend-ledger.ts `mockLedgerEntries`), never copied here,
// because a copy is right the day it is written and wrong the first time a run
// settles. Seeded empty: nothing ran ad hoc before the process started.

import { defineFixture } from './core/index.js';
import type { SpendEntry } from '../providers/spend-ledger.js';

export const spendEntries = defineFixture<SpendEntry>({
  key: 'spend-entries',
  scenarios: {
    default: () => [],
    empty: () => [],
    error: () => { throw new Error('spend_entries unavailable: relation does not exist'); },
  },
});
