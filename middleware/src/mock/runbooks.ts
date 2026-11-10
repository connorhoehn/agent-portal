// The runbook mock floor: five
// registered fixtures that RowsRunbookStore (lib/runbooks/store-rows.ts) reads
// and writes, so `POST /api/__mock/reset` undoes every write and the
// default / empty / large scenarios work like the rest of the floor.
//
// Rows come from the seed seam (runbooks-seed-seam.ts). `empty` is a world with
// no runbooks at all, so the Library renders its empty state. `runbooks-tools-demo`
// is the default world without the CDP harness skill, which that demo captures.
import type { Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief } from '../lib/runbooks/types.js';
import type { RunbookRowSources } from '../lib/runbooks/store-rows.js';
import { defineFixture } from './core/index.js';
import { runbookLargeRows, runbookSeedRows, runbookToolsDemoRows } from './runbooks-seed-seam.js';

export const runbooksFixture = defineFixture<Runbook>({
  key: 'runbooks',
  scenarios: { default: () => runbookSeedRows().runbooks, 'runbooks-demo': () => runbookSeedRows().runbooks, 'runbooks-tools-demo': () => runbookToolsDemoRows().runbooks, empty: () => [], large: () => runbookLargeRows().runbooks },
});
export const runbookVersionsFixture = defineFixture<RunbookVersion>({
  key: 'runbook-versions',
  scenarios: { default: () => runbookSeedRows().versions, 'runbooks-demo': () => runbookSeedRows().versions, 'runbooks-tools-demo': () => runbookToolsDemoRows().versions, empty: () => [], large: () => runbookLargeRows().versions },
});
export const runbookProposalsFixture = defineFixture<RunbookProposal>({
  key: 'runbook-proposals',
  scenarios: { default: () => runbookSeedRows().proposals, 'runbooks-demo': () => runbookSeedRows().proposals, 'runbooks-tools-demo': () => runbookToolsDemoRows().proposals, empty: () => [], large: () => runbookLargeRows().proposals },
});
export const runbookApplicationsFixture = defineFixture<RunbookApplication>({
  key: 'runbook-applications',
  scenarios: { default: () => runbookSeedRows().applications, 'runbooks-demo': () => runbookSeedRows().applications, 'runbooks-tools-demo': () => runbookToolsDemoRows().applications, empty: () => [], large: () => runbookLargeRows().applications },
});
export const sessionBriefsFixture = defineFixture<SessionBrief>({
  key: 'session-briefs',
  scenarios: { default: () => runbookSeedRows().briefs, 'runbooks-demo': () => runbookSeedRows().briefs, 'runbooks-tools-demo': () => runbookToolsDemoRows().briefs, empty: () => [], large: () => runbookLargeRows().briefs },
});

/** The live rows behind RowsRunbookStore. */
export const fixtureRunbookSources: RunbookRowSources = {
  runbooks: () => runbooksFixture.rows(),
  versions: () => runbookVersionsFixture.rows(),
  proposals: () => runbookProposalsFixture.rows(),
  applications: () => runbookApplicationsFixture.rows(),
  briefs: () => sessionBriefsFixture.rows(),
};
