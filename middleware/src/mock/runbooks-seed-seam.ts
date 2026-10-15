// THE SEAM between the runbook fixtures (runbooks.ts, lane B) and the seed
// content (runbooks.seed.ts, lane C: the nine hand-written rewrites of the
// eleven seeded distillation artifacts, their open proposals and the
// application history carried over from distillation).
//
// `default` is lane C's world, exactly. Briefs start empty: a brief is frozen
// when a run is dispatched or claimed (lib/run-brief.ts), and every seeded run
// predates briefs. `large` is that world plus generated bulk to page through.
import type { Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief } from '../lib/runbooks/types.js';
import { versionOf } from '../lib/runbooks/version.js';
import { assembleBrief } from '../lib/runbooks/brief.js';
import { clock } from './core/index.js';
import { runbookSeedWorld } from './runbooks.seed.js';
import { flakyRerunDiff, ssoNewOrigin, tenantCutoverV1 } from '../lib/runbooks/__tests__/fixtures/good.js';

export interface RunbookSeedRows {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  proposals: RunbookProposal[];
  applications: RunbookApplication[];
  briefs: SessionBrief[];
}

const person = (id: string) => ({ kind: 'person' as const, id });

export function runbookSeedRows(): RunbookSeedRows {
  return runbookSeedWorld();
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
    if (i % 2 === 0) out.briefs.push(assembleBrief({ run_ref: `job-bulk-${i}`, assembled_at: at, framing: '', work_item: null, initiative: null, repo: null, decisions: [], runbooks: [] }));
  }
  return { runbooks: [...base.runbooks, ...out.runbooks], versions: [...base.versions, ...out.versions], proposals: [...base.proposals, ...out.proposals], applications: [...base.applications, ...out.applications], briefs: [...base.briefs, ...out.briefs] };
}
