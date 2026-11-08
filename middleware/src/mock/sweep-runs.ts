// Org-sweep runs, offline: the `sweep_runs` rows (schema/sweep_runs.sql).
// Starts empty; runSweep writes here in dev:mock. A reset clears it.

import { defineFixture } from './core/index.js';
import type { SweepRunRow } from '../providers/sweep-runs.js';

export const sweepRuns = defineFixture<SweepRunRow>({
  key: 'sweep-runs',
  scenarios: { default: () => [] },
});
