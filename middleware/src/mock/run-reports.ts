// The run report mock floor (docs/learning-loop-design.md §1): a registered
// fixture RowsRunReportStore (lib/run-reports/store-rows.ts) reads and writes,
// so `POST /api/__mock/reset` takes back every report a simulated run stored.
// Every scenario starts empty: a report exists only because a run ended.
import type { RunReport } from '../lib/run-reports/types.js';
import type { RunReportRowSources } from '../lib/run-reports/store-rows.js';
import { defineFixture } from './core/index.js';

export const runReportsFixture = defineFixture<RunReport>({
  key: 'run-reports',
  scenarios: { default: () => [], empty: () => [] },
});

export const fixtureRunReportSources: RunReportRowSources = {
  reports: () => runReportsFixture.rows(),
};
