// THE SEAM between the runbook fixtures (runbooks.ts, lane B) and the seed
// content (runbooks.seed.ts, lane C: the hand-written rewrites of the 11 seeded
// artifacts). Until lane C lands, the default world is built from the model's
// own known-good docs (lib/runbooks/__tests__/fixtures/good.ts) so the store,
// the contract suite and the mock floor have something real to hold.
//
// To cut over: replace the body of `runbookSeedRows` with a call into
// runbooks.seed.ts returning the same five arrays. Nothing else changes.
import type { Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief } from '../lib/runbooks/types.js';
import { versionOf } from '../lib/runbooks/version.js';
import { assembleBrief } from '../lib/runbooks/brief.js';
import { clock } from './core/index.js';
import { flakyRerunDiff, ssoNewOrigin, tenantCutoverV1, tenantCutoverV2 } from '../lib/runbooks/__tests__/fixtures/good.js';

export interface RunbookSeedRows {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  proposals: RunbookProposal[];
  applications: RunbookApplication[];
  briefs: SessionBrief[];
}

const person = (id: string) => ({ kind: 'person' as const, id });
const noEvidence = { lab_experience_ids: [] as string[] };

export function runbookSeedRows(): RunbookSeedRows {
  const created = clock.daysAgo(20), edited = clock.daysAgo(3), t = (d: number) => clock.daysAgo(d);
  const runbooks: Runbook[] = [
    { id: 'rb-tenant-cutover', scope: { kind: 'initiative', ref: 'p-auth-migration' }, owner_person_id: 'p-001', status: 'published', current_version: 2, created_at: created, updated_at: edited },
    { id: 'rb-sso-new-origin', scope: { kind: 'repo', ref: 'orgiq-auth-service' }, owner_person_id: 'p-001', status: 'published', current_version: 1, created_at: created, updated_at: created },
    { id: 'rb-flaky-test-rerun-diff', scope: { kind: 'repo', ref: 'orgiq-observability' }, owner_person_id: 'p-002', status: 'published', current_version: 1, created_at: created, updated_at: created },
  ];
  const versions: RunbookVersion[] = [
    versionOf({ runbook_id: 'rb-tenant-cutover', version: 1, doc: tenantCutoverV1, author: person('p-001'), accepted_by: 'p-001', accepted_at: created, provenance: { source_artifact_ids: ['art-010'] } }),
    versionOf({ runbook_id: 'rb-tenant-cutover', version: 2, doc: tenantCutoverV2, author: { kind: 'run', id: 'job-0001' }, proposal_id: 'prop-0001', accepted_by: 'p-001', accepted_at: edited, provenance: { run_refs: ['job-0001'] } }),
    versionOf({ runbook_id: 'rb-sso-new-origin', version: 1, doc: ssoNewOrigin, author: person('p-001'), accepted_by: 'p-001', accepted_at: created, provenance: { source_artifact_ids: ['art-009'] } }),
    versionOf({ runbook_id: 'rb-flaky-test-rerun-diff', version: 1, doc: flakyRerunDiff, author: person('p-002'), accepted_by: 'p-002', accepted_at: created }),
  ];
  const proposals: RunbookProposal[] = [
    { id: 'prop-0001', kind: 'edit', runbook_id: 'rb-tenant-cutover', base_version: 1, proposed: tenantCutoverV2, rationale: 'A run found the flag flip must precede the session check.',
      source: { kind: 'run', run_ref: 'job-0001', ...noEvidence }, lint: [], similar: [], status: 'accepted', decided_by: 'p-001', decided_at: edited, note: null, merged_into: null, created_at: t(4) },
    { id: 'prop-0002', kind: 'edit', runbook_id: 'rb-sso-new-origin', base_version: 1, proposed: { ...ssoNewOrigin, summary: ssoNewOrigin.summary }, rationale: 'Open for review: tighten the wording of the summary.',
      source: { kind: 'person', person_id: 'p-003', ...noEvidence }, lint: [], similar: [], status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: t(1) },
  ];
  const applications: RunbookApplication[] = [
    { id: 'app-0001', runbook_id: 'rb-tenant-cutover', version: 2, run_ref: 'job-0002', brief_id: 'brief-job-0002', outcome: 'followed', failed_at_step: null, note: null, at: t(2) },
    { id: 'app-0002', runbook_id: 'rb-tenant-cutover', version: 1, run_ref: 'job-0001', brief_id: 'brief-job-0001', outcome: 'failed', failed_at_step: 2, note: 'The flag flip did not take.', at: t(4) },
  ];
  const brief = assembleBrief({
    run_ref: 'job-0002', assembled_at: t(2), framing: '', work_item: null, initiative: null, repo: 'orgiq-auth-service', decisions: [],
    runbooks: [],
  });
  return { runbooks, versions, proposals, applications, briefs: [brief] };
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
