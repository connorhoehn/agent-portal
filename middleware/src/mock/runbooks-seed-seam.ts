// THE SEAM between the runbook fixtures (runbooks.ts) and the seed content
// (runbooks.seed.ts and its siblings: runbooks, open proposals, applications).
//
// `default` is the seeded world, exactly. A brief is frozen when a run is
// dispatched or claimed (lib/run-brief.ts); most seeded runs predate briefs, and
// the one that started after the runbooks existed (job-auth-maint-1) carries one. `large` is that world plus generated bulk to page through.
import type { Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief } from '../lib/runbooks/types.js';
import { versionOf } from '../lib/runbooks/version.js';
import { assembleBrief } from '../lib/runbooks/brief.js';
import { clock } from './core/index.js';
import { runbookSeedWorld, seedBriefs } from './runbooks.seed.js';
import { buildSkillLibrary, BOX_SKILLS_DIR } from '../lib/runbooks/library.js';
import { flakyRerunDiff, ssoNewOrigin, tenantCutoverV1 } from '../lib/runbooks/__tests__/fixtures/good.js';
import { CDP_RUNBOOK_ID, JOURNEY_WALK_RUNBOOK_ID, LIBRARY_RELEASE_RUNBOOK_ID, PRESENCE_BUSY_PROPOSAL, PRESENCE_RUNBOOK_ID, SEEDED_BUNDLES, bundleFiles } from './runbook-bundles.js';
import { lintRunbook } from '../lib/runbooks/lint.js';
import { engagementRunbookRows } from './runbooks-engagement.js';

export interface RunbookSeedRows {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  proposals: RunbookProposal[];
  applications: RunbookApplication[];
  briefs: SessionBrief[];
}

const person = (id: string) => ({ kind: 'person' as const, id });

export function runbookSeedRows(): RunbookSeedRows {
  return withTools(withEngagement(runbookSeedWorld()), toolRunbookRows());
}

/** The six runbooks written after a lost day (mock/runbooks-engagement.ts), added to the migrated world. */
function withEngagement(world: RunbookSeedRows): RunbookSeedRows {
  const e = engagementRunbookRows();
  return {
    ...world,
    runbooks: [...world.runbooks, ...e.runbooks],
    versions: [...world.versions, ...e.versions],
    applications: [...world.applications, ...e.applications],
    proposals: [...world.proposals, ...e.proposals],
  };
}

/** The world plus tool runbooks, its frozen brief recording the whole library its box synced. */
function withTools(world: RunbookSeedRows, tools: Pick<RunbookSeedRows, 'runbooks' | 'versions'>): RunbookSeedRows {
  const runbooks = [...world.runbooks, ...tools.runbooks];
  const versions = [...world.versions, ...tools.versions];
  const lib = buildSkillLibrary(runbooks.map((r) => ({ runbook: r, version: versions.find((v) => v.runbook_id === r.id && v.version === r.current_version)! })).filter((x) => x.version));
  return {
    ...world, runbooks, versions,
    proposals: [...world.proposals, ...toolProposals(runbooks)],
    briefs: seedBriefs({ sha256: lib.sha256, dir: BOX_SKILLS_DIR, skills: lib.skills.map((k) => ({ name: k.name, version: k.version })) }),
  };
}

/** R8: the open run proposal that changes a tool's files (the presence client learns do-not-disturb). */
function toolProposals(runbooks: Runbook[]): RunbookProposal[] {
  if (!runbooks.some((r) => r.id === PRESENCE_RUNBOOK_ID)) return [];
  const p = PRESENCE_BUSY_PROPOSAL;
  const files = bundleFiles(p.bundle);
  return [{
    id: p.id, kind: 'edit', runbook_id: PRESENCE_RUNBOOK_ID, base_version: 1, proposed: p.doc, proposed_files: files, rationale: p.rationale,
    source: { kind: 'run', run_ref: p.run_ref, work_item_id: 'wi-obs-e2-b4', dispatched_by: p.dispatched_by, lab_experience_ids: [] },
    lint: lintRunbook(p.doc, { files, skill: { name: PRESENCE_RUNBOOK_ID } }), similar: [],
    status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: clock.hoursAgo(5),
  }];
}

/**
 * The `runbooks-tools-demo` world: the default world WITHOUT the CDP harness,
 * which the demo's run builds, captures and gets accepted (mock/runbooks-tools-demo.ts).
 */
export function runbookToolsDemoRows(): RunbookSeedRows {
  return withTools(withEngagement(runbookSeedWorld()), toolRunbookRows([CDP_RUNBOOK_ID]));
}

/** Who owns each seeded tool runbook: all are org-wide skills (scope is a label; every box gets them). */
const TOOL_OWNERS: Record<string, { owner: string; created_h: number }> = {
  [CDP_RUNBOOK_ID]: { owner: 'p-011', created_h: 52 },
  [PRESENCE_RUNBOOK_ID]: { owner: 'p-008', created_h: 30 },
  [JOURNEY_WALK_RUNBOOK_ID]: { owner: 'p-004', created_h: 20 },
  [LIBRARY_RELEASE_RUNBOOK_ID]: { owner: 'p-011', created_h: 18 },
};

/** R8: the runbooks that carry scripts and data (mock/runbook-bundles.ts), as org-scope v1 rows. */
export function toolRunbookRows(exclude: readonly string[] = []): Pick<RunbookSeedRows, 'runbooks' | 'versions'> {
  const out: Pick<RunbookSeedRows, 'runbooks' | 'versions'> = { runbooks: [], versions: [] };
  for (const { id, doc } of SEEDED_BUNDLES) {
    if (exclude.includes(id)) continue;
    const { owner, created_h } = TOOL_OWNERS[id]!;
    const at = clock.hoursAgo(created_h);
    out.runbooks.push({ id, scope: { kind: 'org', ref: null }, owner_person_id: owner, status: 'published', current_version: 1, created_at: at, updated_at: at });
    out.versions.push(versionOf({ runbook_id: id, version: 1, doc, author: person(owner), accepted_by: owner, accepted_at: at, files: bundleFiles(id) }));
  }
  return out;
}

/** The `large` scenario: `n` published runbooks of two versions each, with proposals, applications and briefs to page through. */
export function runbookLargeRows(n = 120): RunbookSeedRows {
  const base = runbookSeedRows();
  const docs = [tenantCutoverV1, ssoNewOrigin, flakyRerunDiff];
  const out: RunbookSeedRows = { runbooks: [], versions: [], proposals: [], applications: [], briefs: [] };
  for (let i = 0; i < n; i++) {
    const id = `rb-bulk-${String(i).padStart(4, '0')}`;
    const doc = { ...docs[i % docs.length]!, title: `${docs[i % docs.length]!.title} (variant ${i})` };
    const doc2 = { ...doc, summary: `${doc.summary} Revised.` };
    const at = clock.daysAgo(30 - (i % 25));
    out.runbooks.push({ id, scope: { kind: i % 4 === 0 ? 'org' : 'repo', ref: i % 4 === 0 ? null : `orgiq-repo-${i % 7}` }, owner_person_id: `p-00${1 + (i % 5)}`, status: i % 17 === 0 ? 'draft' : 'published', current_version: 2, created_at: at, updated_at: at });
    out.versions.push(versionOf({ runbook_id: id, version: 1, doc, author: person('p-001'), accepted_by: 'p-001', accepted_at: at }));
    out.versions.push(versionOf({ runbook_id: id, version: 2, doc: doc2, author: person('p-001'), accepted_by: 'p-001', accepted_at: at }));
    out.applications.push({ id: `app-bulk-${i}`, runbook_id: id, version: 2, run_ref: `job-bulk-${i}`, brief_id: `brief-job-bulk-${i}`, outcome: 'followed', failed_at_step: null, note: null, at });
    if (i % 3 === 0) {
      out.proposals.push({ id: `prop-bulk-${i}`, kind: 'edit', runbook_id: id, base_version: 2, proposed: doc2, rationale: 'Bulk proposal.', source: { kind: 'person', person_id: 'p-002', lab_experience_ids: [] }, lint: [], similar: [], status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: at });
    }
    if (i % 2 === 0) out.briefs.push(assembleBrief({ run_ref: `job-bulk-${i}`, assembled_at: at, framing: '', work_item: null, initiative: null, repo: null, decisions: [] }));
  }
  return { runbooks: [...base.runbooks, ...out.runbooks], versions: [...base.versions, ...out.versions], proposals: [...base.proposals, ...out.proposals], applications: [...base.applications, ...out.applications], briefs: [...base.briefs, ...out.briefs] };
}
