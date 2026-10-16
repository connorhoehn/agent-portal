// Organizational sweep findings — `agent_findings`, offline.
//
// These seven rows were a `seedMockFindings()` function inside
// providers/org-sweeps.ts, pushing into a bare module-level `MOCK_FINDINGS`
// array. They moved here for the two reasons the floor names:
//
//   1. THE STAMPS WERE MINTED OFF THE WALL CLOCK. The seed built every
//      first/last-seen out of a local `new Date(Date.now() - h * 3_600_000)`,
//      so `freezeClock` could not pin them and a frozen-clock test could not
//      assert what a sweep re-observed. `clock.hoursAgo` inside the rows
//      factory samples at READ time instead, which is also what keeps the ages
//      honest in a process left running overnight.
//   2. WRITES HAD NOWHERE TO GO BACK TO. `fileLabSignal`, `setFindingStatus`
//      and the mock `runSweep` all mutate these rows — dismissing a finding or
//      promoting it to a job is a demo action an auditor takes — and a
//      mutation against a bare array is the "damage the shared state and warn
//      the next auditor" problem the scenario control plane exists to end.
//      Behind a fixture, `POST /api/__mock/reset` puts the board back.
//
// AGE IS THE CLAIM HERE, NOT THE DAY, so none of these use
// `keepWithinToday`: nothing buckets a finding by calendar day (the Work page
// renders them as a severity-ranked list), and a finding first seen 200 hours
// ago is meant to read as eight days old whatever the wall clock says.
//
// IDS ARE PART OF THE CONTRACT. `find-mock-1` … `find-mock-7` are addressed by
// name from routes/__tests__/work-findings-promote.test.ts (which picks rows
// for their evidence shape: an initiative-scoped finding, one with no
// initiative context at all, one carrying only a candidate initiative), so
// they are written out rather than handed to a counter that renumbers when a
// row is inserted above.

import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';
import { devboxBoxes } from './devbox-fleet.js';
// Type-only, so it is erased at compile: providers/org-sweeps.ts imports the
// rows below at run time, and a value import back the other way would be a
// genuine cycle rather than a shared shape.
import type { Finding } from '../providers/org-sweeps.js';

/** Matches providers/org-sweeps.ts's `LAB_SWEEP` without importing it — that
 *  module imports this one, and a cycle through a const is avoidable. */
const LAB_SWEEP = 'lab-signal';

/**
 * What the three scheduled sweeps and one lab signal produce against
 * schema/seed_program.sql's cast. Every status the Work page filters on is
 * represented (open / promoted / resolved / dismissed) — an empty status tab
 * is indistinguishable from a broken query, and this is the surface that has
 * to be auditable without Aurora.
 */
function seedFindings(): Finding[] {
  return [
    // The one skill the mock cast holds at or under the sweep's HAVING
    // count(person_id) <= 2 (providers/org-sweeps.ts): MLOps, held by Lena
    // Dubois and Zoe Thompson (mock/people.ts + graph-taxonomy.ts agree).
    // Title and evidence follow `sweepBusFactor`'s exact shape so the Explore
    // page's rare-skill strip can join to it by name. Earlier this row named a
    // prompt-library skill (skill-cold-start-aurora) that no person in the
    // graph holds — the bus-factor sweep reads person_skills, not the library,
    // so the graph and the board disagreed under dev:mock and the deep link
    // from Explore landed on "Nothing here".
    {
      id: 'find-mock-1',
      sweep: 'bus_factor', severity: 'warning',
      title: 'MLOps: 2 holders org-wide',
      detail: 'MLOps is held by just Camille Dubois, Zoe Thompson. One departure leaves a single point of failure.',
      entityType: 'skill', entityId: 'sk-mlops',
      evidence: { holders: 2, holderIds: ['p-019', 'p-044'], holderNames: ['Camille Dubois', 'Zoe Thompson'], initiatives: ['p-observability'] },
      status: 'open', jobId: null,
      firstSeenAt: clock.hoursAgo(70), lastSeenAt: clock.hoursAgo(6),
      fingerprint: 'skill:sk-mlops',
    },
    // An org-wide decision (mock/decisions.ts `projectId: null`) that nothing
    // cites: no initiative anywhere in its evidence, which is what the promote
    // route's "unscoped, not denied" branch is exercised with.
    {
      id: 'find-mock-2',
      sweep: 'orphan_decisions', severity: 'warning',
      title: 'Decision "Migrate to Kubernetes from ECS" links to no initiative',
      detail: 'The EKS standard binds twelve teams, but its decider is no longer on the roster and no initiative or work item cites it, so nobody owns the next cluster upgrade.',
      entityType: 'decision', entityId: 'd-k8s',
      evidence: { ownerId: null, citedBy: 0 },
      status: 'open', jobId: null,
      firstSeenAt: clock.hoursAgo(46), lastSeenAt: clock.hoursAgo(6),
      fingerprint: 'orphan_decisions:d-k8s',
    },
    {
      id: 'find-mock-3',
      sweep: 'stale_docs', severity: 'warning',
      title: 'ADR-014 "Retry the Data API through an Aurora cold start" is 190 days old',
      detail: 'Last edited before the schema loader learned to retry the first call against a resuming cluster, so it still tells readers to wait five minutes and rerun by hand.',
      entityType: 'document', entityId: 'doc-adr-014',
      evidence: { ageDays: 190, initiative: 'p-observability', lastEditedBy: 'p-002' },
      status: 'promoted', jobId: null,
      firstSeenAt: clock.hoursAgo(120), lastSeenAt: clock.hoursAgo(6),
      fingerprint: 'stale_docs:doc-adr-014',
    },
    {
      id: 'find-mock-4',
      sweep: 'stale_docs', severity: 'info',
      title: 'Cost-optimisation runbook has no owner on the current roster',
      detail: 'The idle-teardown runbook names an owner who has left, and Cost Optimization has no replacement steward for it.',
      entityType: 'document', entityId: 'doc-runbook-cost-opt',
      evidence: { ageDays: 88, initiative: 'p-cost-opt', ownerActive: false },
      status: 'open', jobId: null,
      firstSeenAt: clock.hoursAgo(30), lastSeenAt: clock.hoursAgo(6),
      fingerprint: 'stale_docs:doc-runbook-cost-opt',
    },
    // Was 'dec-cognito-hosted-ui' — mock/decisions.ts has never had an id by
    // that name (the real Cognito-flavored row there, 'd-cognito-cutover', is
    // already cited by p-auth-migration and wi-auth-e2, so it isn't an orphan
    // to begin with). 'd-aurora' is the org-wide ADR that genuinely has
    // `projectId: null` and no `workItemId` — the other one, 'd-k8s', is
    // find-mock-2's. Owner is d-aurora's decider.
    // `evidence.candidateInitiative` STAYS 'p-auth-migration' — it is pinned
    // by name in routes/__tests__/work-findings-promote.test.ts
    // (FINDING_AUTH_CANDIDATE), which promotes this exact finding as the
    // sme persona (Nora, p-004) who holds an active grant there. It reads as
    // an arbitrary pairing with an Aurora-vs-Neptune decision, and honestly
    // is one: every initiative depends on the Aurora/pgvector store this
    // decision picked, so naming any one of them a "candidate" owner is a
    // little arbitrary — p-auth-migration is not a materially worse home for
    // it than another initiative would be, which is what the detail below
    // says instead of pretending a thematic tie that isn't there.
    {
      id: 'find-mock-5',
      sweep: 'orphan_decisions', severity: 'warning',
      title: 'Decision "Adopt Aurora over Neptune" links to no initiative',
      detail: 'Vikram Patel decided it, but no initiative or work item cites it. Every initiative depends on the Aurora and pgvector store it picked, and Auth Migration, whose session tables live there, is as reasonable a home as any.',
      entityType: 'decision', entityId: 'd-aurora',
      evidence: { ownerId: 'p-046', candidateInitiative: 'p-auth-migration', citedBy: 0 },
      status: 'open', jobId: null,
      firstSeenAt: clock.hoursAgo(54), lastSeenAt: clock.hoursAgo(6),
      fingerprint: 'orphan_decisions:d-aurora',
    },
    // Was 'dec-titan-1024' — no such id in mock/decisions.ts, and there is no
    // Titan/embeddings-dimension decision row to rename it to (the KB's
    // embedding-dims choice was never itself raised as a `decisions` row).
    // 'd-nova' is the closest resolved LLM-platform decision that genuinely
    // carries `projectId: 'p-llm-platform'`, which is what "resolved, now
    // linked" needs to be honest about.
    {
      id: 'find-mock-6',
      sweep: 'orphan_decisions', severity: 'info',
      title: 'Decision "Standardize on Nova Pro" linked to the LLM platform initiative',
      detail: 'Resolved, with LLM Application Platform as its initiative of record.',
      entityType: 'decision', entityId: 'd-nova',
      evidence: { ownerId: 'p-043', linkedTo: 'p-llm-platform' },
      status: 'resolved', jobId: null,
      firstSeenAt: clock.hoursAgo(200), lastSeenAt: clock.hoursAgo(26),
      fingerprint: 'orphan_decisions:d-nova',
    },
    {
      id: 'find-mock-7',
      sweep: LAB_SWEEP, severity: 'warning',
      title: 'Devbox session left 412 MB of build output in /mnt/workspace',
      detail: 'Session storage is wiped on every runtime update; the artefacts were never pushed. Dismissed: the box was a throwaway experiment.',
      entityType: 'repo', entityId: 'orgiq-portal',
      evidence: { sessionId: 'sess-mock-throwaway-experiment-000000000001', boxId: 'box-mock-0004', repo: 'orgiq-portal', initiativeId: 'p-observability' },
      status: 'dismissed', jobId: null,
      firstSeenAt: clock.hoursAgo(20), lastSeenAt: clock.hoursAgo(20),
      fingerprint: 'lab:workspace-bloat:box-mock-0004',
    },
    // A second lab signal, and the reason it is OPEN rather than another
    // dismissed one.
    //
    // The distillation ProcessFlow has a "Lab signals" node feeding L0, and it
    // counts findings the Work page returns by DEFAULT — which excludes
    // dismissed. With `find-mock-7` the only lab row, that node read 0 in every
    // demo and `breathing('lab-L0', …)` (distillationFormat.ts) only animates
    // the edge when the count is above zero, so an entire path of the flagship
    // diagram was permanently dead offline: a real feature that looked like it
    // did nothing.
    //
    // The comment at the top of this function already promises "every status
    // the Work page filters on is represented". That was true of the sweeps as
    // a whole and quietly false of the lab sweep, which had exactly one row in
    // the one status that makes it invisible.
    //
    // The box id is one the devbox fleet fixture actually seeds
    // (mock/devbox-fleet.ts) rather than an invented one, so following the
    // evidence from this finding lands on a computer that exists.
    {
      id: 'find-mock-8',
      sweep: LAB_SWEEP, severity: 'warning',
      // Read off the box the finding is about — its age and context are the
      // fleet row's, never a second copy that drifts from it (rule 1). It
      // said "5 hours" while the reaper caps a box at 60 minutes.
      title: longTaskTitle(),
      detail: 'The session has not checkpointed or opened a PR. Either the task is larger than it looked and wants splitting, or the box is stuck and should be recycled before its context fills.',
      entityType: 'repo', entityId: 'orgiq-auth-service',
      evidence: {
        sessionId: 'sess-mock-auth-migration-0001-0000-0000-000000000001',
        boxId: 'box-mock-0001', repo: 'orgiq-auth-service', initiativeId: 'p-auth-migration',
      },
      status: 'open', jobId: null,
      firstSeenAt: devboxBoxes.rows('default').find((b) => b.id === 'box-mock-0001')?.createdAt ?? clock.hoursAgo(0.5),
      lastSeenAt: clock.hoursAgo(0.05),
      fingerprint: 'lab:long-running-task:box-mock-0001',
    },
  ];
}

// `listFindings` (providers/org-sweeps.ts) caps its LIST at 300 rows — a page
// size, not a count. `findingStats` is the real GROUP BY over every row, and
// backs `/api/work/summary`'s `findings.open/critical/warning`; before it
// existed, the summary read `listFindings({limit:300}).length`, which
// undercounted the instant a program crossed 300 open findings with no error
// to notice it by. `REPEATS` clones of the seven seeded findings, all kept
// `open` — the seed already carries one `open` example per sweep type, so the
// clones don't need the other statuses to prove the count stays right past
// the cap — 7 * 45 = 315.
const LARGE_REPEATS = 45;

function largeFindings(): Finding[] {
  const base = seedFindings();
  const out: Finding[] = [];
  for (let round = 0; round < LARGE_REPEATS; round += 1) {
    for (const f of base) {
      const n = out.length + 1;
      out.push({
        ...f,
        id: `find-mock-${n}`,
        status: 'open',
        fingerprint: `${f.fingerprint}:${n}`,
        firstSeenAt: clock.hoursAgo(70 + (n % 200)),
        lastSeenAt: clock.hoursAgo(n % 24),
      });
    }
  }
  return out;
}

/**
 * The findings board.
 *
 * `empty` — the sweeps have run and found nothing. Declared explicitly: an
 *           undeclared scenario falls back to `default`, and "no findings" is
 *           the state the Work page's reassuring empty copy is written for —
 *           the one state a seeded board can never show.
 * `large` — 315 open findings, so `/api/work/summary`'s GROUP BY and the
 *           `/api/work/findings` list's 300-row cap can both be exercised.
 */
export const orgFindings = defineFixture<Finding>({
  key: 'org-findings',
  scenarios: {
    default: seedFindings,
    empty: () => [],
    large: largeFindings,
  },
});

/** Live view — see mock/live.ts. The provider keeps reading it as an array. */
export const mockFindings: Finding[] = liveRows(orgFindings);

/**
 * The next `find-mock-N` id, derived from the rows that are actually there
 * rather than from a module counter.
 *
 * A counter would collide after a reset: `POST /api/__mock/reset` rebuilds the
 * seed as `find-mock-1` … `-7` while a counter that had reached 9 keeps
 * counting, and a counter reset with the fixture would re-mint an id the
 * seed already owns. Reading the high-water mark off the live rows is correct
 * in both directions.
 */
export function nextMockFindingId(): string {
  let max = 0;
  for (const f of orgFindings.rows()) {
    const m = /^find-mock-(\d+)$/.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `find-mock-${max + 1}`;
}

/** The long-running-task finding's headline, from the box row it describes. */
function longTaskTitle(): string {
  const box = devboxBoxes.rows('default').find((b) => b.id === 'box-mock-0001');
  if (!box) return 'A computer has been on one task for most of its lifetime';
  const minutes = Math.round((clock.now().getTime() - Date.parse(box.createdAt)) / 60_000);
  const context = Math.round((box.contextUsed ?? 0) * 100);
  return `${box.label} has been on one task for ${minutes} minutes with context at ${context}%`;
}
