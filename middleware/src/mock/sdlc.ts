// AI SDLC governance — `agent_change_requests`, `agent_change_reviews`,
// `agent_change_gates` and `sdlc_policies`, offline.
//
// WHY THIS MODULE EXISTS. The whole capture → review → gate → deliver pipeline
// was Aurora-only. `providers/sdlc.ts` carried two mock *reads* (a bare
// `const MOCK_CHANGES` array and a `DEFAULT_POLICIES.map`) and no mock
// *writes* at all, so in `dev:mock` every governance action 500'd: creating or
// deleting a policy, recording a review, re-running the gates, deciding a
// change. A 500 reads as "this feature is broken", which is the wrong message
// for a feature that works.
//
// Four rules of the floor shaped what moved here (docs/mock-floor.md):
//
//   1. WRITES NEED SOMEWHERE TO GO. A raw `exec()` reaches the RDS Data API
//      whatever `config.mock.aurora` says. A mock branch has to mutate
//      *something*, and mutating a bare module-level array is the exact
//      "auditor damages shared state and warns the next auditor" problem the
//      scenario control plane exists to end. Behind a fixture,
//      `POST /api/__mock/reset` puts the seeded queue back.
//
//   2. NO TYPED AGGREGATES, AND NO TYPED *DECISIONS* EITHER. The old fixture
//      hand-typed each change's `status` beside hand-typed gate rows, and the
//      two disagreed with the engine that produces both: a change marked
//      `needs_approval` carried gates whose outcomes evaluate to `approved`,
//      and one gate's outcome was `hold` — a value `agent_change_gates`'
//      CHECK constraint forbids and no code path can produce. Here the seeded
//      status and the seeded gates are BOTH the output of the real engine
//      (`lib/sdlc-policy.ts` `evaluate`) over the seeded facts, so they cannot
//      drift from each other or from production. Only a change a human or a
//      delivery moved *past* the gates pins its own status.
//
//   3. NO INVENTED WIRE STRINGS. Gate `kind` is a `PolicyKind`, gate `outcome`
//      is one of the three the schema's CHECK allows, review `verdict` is one
//      of the three `agent_change_reviews` allows, and every `policyName` is a
//      real `DEFAULT_POLICIES` name. The old fixture invented all four
//      (`path`/`size`/`approval`, `hold`, `sensitive-paths`, `max-diff-size`).
//
//   4. EVERY TIMESTAMP FROM THE CLOCK. The old rows minted
//      `new Date(Date.now() - 40 * 60_000)` at module scope, baking "40 minutes
//      ago" at import — forty minutes before the *process started*, which on a
//      long-lived dev server is hours.
//
// WHAT THE JOIN COLUMNS DO. `repo_full_name`, `org_project_id` and
// `org_project_name` are NOT columns of `agent_change_requests` — the Aurora
// reads JOIN `agent_projects` and LEFT JOIN `projects` for them. So the rows
// below carry only the table's own columns and the join is resolved at read
// time against the same fixtures those tables mock, which is also why
// `createChangeRequest` returns them null offline: `INSERT ... RETURNING *`
// returns the inserted row, not the join.

import { randomUUID } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import { agentProjectRuns } from './agent-project-runs.js';
import { mockGetAgentProject } from './agent-projects.js';
import { mockProjectName } from '../providers/projects.js';
import {
  evaluate, DEFAULT_POLICIES,
  type ChangeFacts, type GateResult, type ReviewVerdict, type SdlcPolicy,
} from '../lib/sdlc-policy.js';

// ─── The seeded codebase ────────────────────────────────────────────────────
//
// `schema/seed_program.sql` links `connorhoehnslalom/orgiq-observability` to
// the `p-observability` initiative under this id. Named rather than inlined so
// a wrong uuid is one edit — and so it is plain that no change here points at
// an invented codebase.

const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a';

/** Bedrock inference-profile ids, as `portal/src/lib/devboxModels.ts` sends them. */
const SONNET = 'us.anthropic.claude-sonnet-5';
/** The reviewer's model — `lib/change-reviewer.ts`'s `SDLC_REVIEW_MODEL_ID` default. */
const REVIEW_MODEL = 'amazon.nova-pro-v1:0';

// ─── The diffs ──────────────────────────────────────────────────────────────
//
// Real unified diffs, with hunk headers whose counts actually match their
// bodies. The reviewer surface pins each finding to the diff line it names, so
// a finding aimed at a line the diff does not contain silently exercises
// nothing — every `line` below is a new-side line number inside its hunk.

/**
 * Touches two globs of the protected-paths policy at once: the `infra` prefix
 * and the terraform suffix. That is what puts it in front of a human.
 */
const INHIBIT_DIFF = `diff --git a/infra/alerting/inhibit.tf b/infra/alerting/inhibit.tf
new file mode 100644
index 0000000..4c1d9a2
--- /dev/null
+++ b/infra/alerting/inhibit.tf
@@ -0,0 +1,14 @@
+# A cluster-wide outage should page once, not once per service. The tier-1
+# route still fires; these rules suppress the downstream noise it would
+# otherwise fan out into.
+resource "alertmanager_inhibit_rule" "cluster_down" {
+  source_matchers = ["alertname = ClusterUnreachable"]
+  target_matchers = ["severity = page"]
+  equal           = ["cluster"]
+}
+
+resource "alertmanager_inhibit_rule" "collector_down" {
+  source_matchers = ["alertname = CollectorDown"]
+  target_matchers = ["alertname = NoSpansReceived"]
+  equal           = ["namespace"]
+}
diff --git a/infra/alerting/routes.tf b/infra/alerting/routes.tf
index 7b3e1c8..9d2f4a5 100644
--- a/infra/alerting/routes.tf
+++ b/infra/alerting/routes.tf
@@ -18,6 +18,7 @@ resource "alertmanager_route" "tier1" {
   group_by       = ["alertname", "namespace"]
   group_wait     = "30s"
   group_interval = "5m"
+  repeat_interval = "4h"
   receiver       = "pagerduty-primary"
   continue       = false
 }
`;

const DEDUP_DIFF = `diff --git a/src/alerts/dedup.ts b/src/alerts/dedup.ts
index 3f1a2b4..9c8d7e6 100644
--- a/src/alerts/dedup.ts
+++ b/src/alerts/dedup.ts
@@ -12,8 +12,11 @@ export interface AlertGroup {
 export function groupKey(alert: Alert): string {
-  return alert.name;
+  // Collapse per team, not per fleet: a storm on a shared dependency is
+  // handled by the inhibition rule, not by hiding real per-team pages.
+  return \`\${alert.name}:\${alert.namespace}\`;
 }

 export function dedupe(alerts: Alert[]): AlertGroup[] {
   const groups = new Map<string, Alert[]>();
+  const seen = new Set<string>();
   for (const a of alerts) {
     const key = groupKey(a);
@@ -30,5 +33,6 @@ export function dedupe(alerts: Alert[]): AlertGroup[] {
   return [...groups.entries()].map(([key, list]) => ({
     key,
     count: list.length,
+    namespaces: [...new Set(list.map((a) => a.namespace))],
   }));
 }
diff --git a/src/alerts/dedup.test.ts b/src/alerts/dedup.test.ts
new file mode 100644
index 0000000..1a2b3c4
--- /dev/null
+++ b/src/alerts/dedup.test.ts
@@ -0,0 +1,9 @@
+import { groupKey } from './dedup';
+
+describe('groupKey', () => {
+  it('separates namespaces', () => {
+    expect(groupKey({ name: 'HighErrorRate', namespace: 'payments' }))
+      .not.toBe(groupKey({ name: 'HighErrorRate', namespace: 'search' }));
+  });
+});
+
`;

const DASH_DIFF = `diff --git a/dashboards/red.jsonnet b/dashboards/red.jsonnet
index aaa1112..bbb2223 100644
--- a/dashboards/red.jsonnet
+++ b/dashboards/red.jsonnet
@@ -4,4 +4,6 @@ local grafana = import 'grafonnet/grafana.libsonnet';
 {
   red_dashboard(service):: {
     title: 'RED — ' + service,
+    // Span metrics are the primary source; StatsD stays as the fallback
+    // panel behind the $source variable (span metrics lag ~3min).
     panels: [
@@ -22,3 +24,3 @@ local grafana = import 'grafonnet/grafana.libsonnet';
       rate_panel(service):: {
-        expr: 'sum(rate(statsd_requests_total{service="' + service + '"}[5m]))',
+        expr: 'sum(rate(traces_span_metrics_calls_total{service="' + service + '"}[5m]))',
       },
`;

/** The `b/` side of every `diff --git` header — what `parsePorcelainFiles` records. */
export function parseFilesOf(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]!);
}

// ─── Policies ───────────────────────────────────────────────────────────────

/** A policy row: `sdlc_policies`, plus the `created_at` its ORDER BY reads. */
export interface PolicyRow extends SdlcPolicy {
  createdAt: string;
}

/**
 * Stable uuids for the four seeded defaults, in `DEFAULT_POLICIES` order.
 *
 * They are uuids because `sdlc_policies.id` is one, and because
 * `deletePolicy`/`upsertPolicy` gate on `isUuid` — under the old
 * `default-0`-style ids every offline DELETE 404'd before it reached the row
 * it was aimed at, which looked exactly like "the policy is not there".
 */
const POLICY_IDS = [
  'b0d1f7a4-3c52-4e19-9a67-2f8c41d5e603',
  'c1e2a8b5-4d63-4f2a-8b78-3a9d52e6f714',
  'd2f3b9c6-5e74-4a3b-9c89-4bae63f70825',
  'e3a4cad7-6f85-4b4c-ad9a-5cbf74081936',
];

/**
 * Governance policies.
 *
 * `default` — the four `DEFAULT_POLICIES` a fresh environment seeds itself
 *             with, which is what Aurora holds the moment anyone opens the
 *             policy surface.
 * `empty`   — an *ungoverned* environment. Note this is a state the product
 *             actively repairs: `seedDefaultPolicies` re-seeds an empty table
 *             on the next read, offline exactly as in Aurora, so pinning this
 *             fixture to `empty` shows the fail-closed path
 *             (`evaluateChange` refusing to auto-approve with no policies)
 *             rather than a permanently empty list.
 */
export const sdlcPolicies = defineFixture<PolicyRow>({
  key: 'sdlc-policies',
  scenarios: {
    default: () => DEFAULT_POLICIES.map((p, i) => ({
      ...p,
      id: POLICY_IDS[i] ?? randomUUID(),
      config: { ...p.config },
      createdAt: clock.daysAgo(DEFAULT_POLICIES.length - i),
    })),
    empty: () => [],
  },
});

/** `SELECT * FROM sdlc_policies ORDER BY created_at`. */
export function mockListPolicies(): SdlcPolicy[] {
  return sdlcPolicies
    .rows()
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(({ createdAt: _createdAt, ...policy }) => ({ ...policy, config: { ...policy.config } }));
}

/**
 * `seedDefaultPolicies` offline: seed only into an empty table, and report how
 * many rows were written so the caller can tell "seeded" from "already there".
 */
export function mockSeedDefaultPolicies(): number {
  const rows = sdlcPolicies.rows();
  if (rows.length > 0) return 0;
  for (const p of DEFAULT_POLICIES) {
    rows.push({ ...p, id: randomUUID(), config: { ...p.config }, createdAt: clock.nowIso() });
  }
  return DEFAULT_POLICIES.length;
}

/** `UPDATE ... RETURNING *`, or `INSERT ... RETURNING *`. Throws like the real one. */
export function mockUpsertPolicy(input: {
  id?: string; name: string; enabled: boolean; kind: SdlcPolicy['kind'];
  config: Record<string, unknown>; action: SdlcPolicy['action'];
}): SdlcPolicy {
  const rows = sdlcPolicies.rows();
  if (input.id) {
    const existing = rows.find((p) => p.id === input.id);
    if (!existing) throw new Error('policy not found');
    existing.name = input.name;
    existing.enabled = input.enabled;
    existing.kind = input.kind;
    existing.config = { ...input.config };
    existing.action = input.action;
    const { createdAt: _createdAt, ...policy } = existing;
    return { ...policy, config: { ...policy.config } };
  }
  const created: PolicyRow = {
    id: randomUUID(),
    name: input.name,
    enabled: input.enabled,
    kind: input.kind,
    config: { ...input.config },
    action: input.action,
    createdAt: clock.nowIso(),
  };
  rows.push(created);
  const { createdAt: _createdAt, ...policy } = created;
  return { ...policy, config: { ...policy.config } };
}

/** `DELETE ... RETURNING id` — false means "no such row", not "failed". */
export function mockDeletePolicy(id: string): boolean {
  const rows = sdlcPolicies.rows();
  const i = rows.findIndex((p) => p.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  return true;
}

// ─── Change requests ────────────────────────────────────────────────────────

/**
 * A change as `agent_change_requests` holds it — its OWN columns only.
 * `repoFullName`/`orgProjectId`/`orgProjectName` come from the reads' joins
 * and are resolved in `toWire`, never stored.
 */
export interface ChangeRow {
  id: string;
  runId: string | null;
  projectId: string;
  workItemId: string | null;
  title: string;
  status: string;
  diff: string | null;
  diffTruncated: boolean;
  files: string[];
  filesChanged: number;
  model: string | null;
  commitSha: string | null;
  branchName: string | null;
  prUrl: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  error: string | null;
  createdAt: string;
}

/** A review as `agent_change_reviews` holds it — the FK is a column, not a nesting. */
export interface ReviewRow {
  id: string;
  changeRequestId: string;
  reviewer: string;
  model: string | null;
  verdict: ReviewVerdict;
  summary: string | null;
  findings: Array<{ severity?: string; file?: string; line?: number; note: string }>;
  createdAt: string;
}

/** A gate as `agent_change_gates` holds it. `outcome` is CHECK-constrained. */
export interface GateRow {
  id: string;
  changeRequestId: string;
  policyId: string | null;
  policyName: string;
  kind: string;
  outcome: string;
  detail: string | null;
  createdAt: string;
}

const CHANGE_INHIBIT = '9f2c17a0-5b64-4de1-8a03-6c1de4f27b58';
const CHANGE_DEDUP = 'a03d28b1-6c75-4ef2-9b14-7d2ef5083c69';
const CHANGE_DASH = 'b14e39c2-7d86-4f03-ac25-8e3f06194d7a';

/**
 * The seeded captures, as facts. Everything a *gate* depends on is here;
 * nothing a gate *decides* is, because the engine decides it below.
 */
interface ChangeSeed {
  id: string;
  title: string;
  diff: string;
  model: string;
  commitSha: string;
  branchName: string | null;
  prUrl: string | null;
  workItemId: string | null;
  createdHoursAgo: number;
  /**
   * Pinned only for a change a human or a delivery moved on from. Left null,
   * the seeded status is whatever the real engine decides — so a seeded change
   * can never claim a status its own gates contradict.
   */
  status: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedHoursAgo: number | null;
  review: {
    id: string;
    verdict: ReviewVerdict;
    summary: string;
    findings: Array<{ severity: string; file: string; line: number; note: string }>;
  };
}

const CHANGE_SEEDS: ChangeSeed[] = [
  {
    id: CHANGE_INHIBIT,
    title: 'Suppress downstream pages during a cluster-wide outage',
    diff: INHIBIT_DIFF,
    model: SONNET,
    commitSha: '4f19c0d7a3b25e8146fa9c0b73d5e21048ab6cf9',
    branchName: 'agent/alert-inhibit-cluster-down',
    prUrl: null,
    workItemId: null,
    createdHoursAgo: 0.6,
    status: null,
    decidedBy: null,
    decisionNote: null,
    decidedHoursAgo: null,
    review: {
      id: '5c8a0e31-92b7-4d60-8f14-1ab2c3d4e5f6',
      verdict: 'approve',
      summary: 'The inhibition rules are correct and scoped. Two things to confirm before this touches paging.',
      findings: [
        {
          severity: 'medium', file: 'infra/alerting/inhibit.tf', line: 7,
          note: 'Equality on `cluster` only — a source alert without that label matches nothing and inhibits nothing. Confirm ClusterUnreachable always carries it.',
        },
        {
          severity: 'low', file: 'infra/alerting/routes.tf', line: 21,
          note: 'A 4h repeat interval on tier-1 is long enough that a re-page could arrive after the on-call handover. Intentional?',
        },
      ],
    },
  },
  {
    id: CHANGE_DEDUP,
    title: 'Alert dedup: collapse by alertname+namespace',
    diff: DEDUP_DIFF,
    model: SONNET,
    commitSha: '82be40cf15d7a9603e4b1d8c72fa50e9d631470b',
    branchName: 'agent/alert-dedup-namespace',
    prUrl: null,
    workItemId: null,
    createdHoursAgo: 2.5,
    status: null,
    decidedBy: null,
    decisionNote: null,
    decidedHoursAgo: null,
    review: {
      id: '6d9b1f42-a3c8-4e71-9025-2bc3d4e5f607',
      verdict: 'request_changes',
      summary: 'Right approach and a pinning test, but the key can collide and the change leaves dead code behind.',
      findings: [
        {
          severity: 'high', file: 'src/alerts/dedup.ts', line: 15,
          note: 'A template-literal key means a namespace containing ":" collides with another alert — use a tuple key or escape the separator.',
        },
        {
          severity: 'medium', file: 'src/alerts/dedup.ts', line: 20,
          note: 'The new `seen` set is never read — leftover from an earlier approach, and it will confuse the next reader.',
        },
        {
          severity: 'low', file: 'src/alerts/dedup.test.ts', line: 5,
          note: 'Good: this test pins the collapse-per-namespace decision so a later refactor cannot quietly undo it.',
        },
      ],
    },
  },
  {
    id: CHANGE_DASH,
    title: 'RED dashboards: span metrics primary, StatsD fallback',
    diff: DASH_DIFF,
    model: SONNET,
    commitSha: 'c73d5a081b46e2f907ac31b58d0e64f2a9051837',
    branchName: 'agent/red-span-metrics',
    prUrl: 'https://github.com/connorhoehnslalom/orgiq-observability/pull/41',
    // `wi-obs-e1-s3` — "Span-metrics connector feeding RED dashboards"
    // (schema/seed_program.sql). This is the marketplace attribution
    // `createChangeRequest` copies off the run, and what delivery writes the
    // PR url back onto.
    workItemId: 'wi-obs-e1-s3',
    createdHoursAgo: 30,
    // Pinned: the gates cleared this one, a person approved it, and delivery
    // opened the PR. `delivered` is not something the engine can decide.
    status: 'delivered',
    decidedBy: 'u-nora',
    decisionNote: 'Matches the consult decision — span metrics primary, StatsD stays behind the $source variable.',
    decidedHoursAgo: 29,
    review: {
      id: '7ea02053-b4d9-4082-9136-3cd4e5f60718',
      verdict: 'approve',
      summary: 'The source swap is scoped to the rate panel and the fallback is documented in place.',
      findings: [],
    },
  },
];

/** The facts the gate engine is allowed to see, for a seeded change. */
function factsOf(seed: ChangeSeed): ChangeFacts {
  return {
    files: parseFilesOf(seed.diff),
    model: seed.model,
    reviewVerdict: seed.review.verdict,
    // No seeded change carries a run id (see `sdlcChanges` below), and a run
    // with no recorded cost is exactly what `runCostUsd` returns null for.
    costUsd: null,
  };
}

/**
 * The gate engine over the seeded policies — the same call `evaluateChange`
 * makes. `rows('default')` explicitly, not `rows()`: the seeded gates describe
 * the policies as shipped, and must not silently change because an auditor
 * pinned the policy fixture to another world.
 */
function evaluationOf(seed: ChangeSeed): { decision: string; gates: GateResult[] } {
  const policies = sdlcPolicies.rows('default').map(({ createdAt: _createdAt, ...p }) => p);
  return evaluate(policies, factsOf(seed));
}

/**
 * Captured changes.
 *
 * `default` — three captures against the seeded observability codebase: one
 *             the protected-paths policy routed to a human, one the reviewer
 *             sent back, and one already delivered as a pull request. That is
 *             a "needs you" row, an "address the review" row and a terminal
 *             row, which is every branch the queue renders.
 * `empty`   — no agent has changed code yet. Declared, because an undeclared
 *             scenario falls back to `default` and this is the state the
 *             "No changes yet" copy is for.
 * `fresh`   — same: the cast and the codebases exist, nothing has run.
 *
 * `runId` is null throughout. The seed links no run to a capture — Aurora's
 * `agent_project_runs` rows are produced by the fleet, not declared by the
 * corpus — and pointing a change at one of `mock/agent-project-runs.ts`'s runs
 * would assert a relationship neither seed states.
 */
export const sdlcChanges = defineFixture<ChangeRow>({
  key: 'sdlc-changes',
  scenarios: {
    default: () => CHANGE_SEEDS.map((seed): ChangeRow => {
      const files = parseFilesOf(seed.diff);
      return {
        id: seed.id,
        runId: null,
        projectId: OBSERVABILITY,
        workItemId: seed.workItemId,
        title: seed.title,
        status: seed.status ?? evaluationOf(seed).decision,
        diff: seed.diff,
        diffTruncated: false,
        files,
        filesChanged: files.length,
        model: seed.model,
        commitSha: seed.commitSha,
        branchName: seed.branchName,
        prUrl: seed.prUrl,
        decidedBy: seed.decidedBy,
        decidedAt: seed.decidedHoursAgo == null ? null : clock.hoursAgo(seed.decidedHoursAgo),
        decisionNote: seed.decisionNote,
        error: null,
        createdAt: clock.hoursAgo(seed.createdHoursAgo),
      };
    }),
    empty: () => [],
    fresh: () => [],
  },
});

/** Reviews, one per seeded change. Split out because the table is split out. */
export const sdlcChangeReviews = defineFixture<ReviewRow>({
  key: 'sdlc-change-reviews',
  scenarios: {
    default: () => CHANGE_SEEDS.map((seed): ReviewRow => ({
      id: seed.review.id,
      changeRequestId: seed.id,
      reviewer: 'agent',
      model: REVIEW_MODEL,
      verdict: seed.review.verdict,
      summary: seed.review.summary,
      findings: seed.review.findings,
      // The reviewer runs immediately after capture — minutes, not hours.
      createdAt: clock.hoursAgo(Math.max(0, seed.createdHoursAgo - 0.05)),
    })),
    empty: () => [],
    fresh: () => [],
  },
});

/**
 * Gates — the engine's own output, never hand-typed.
 *
 * `evaluateChange` writes exactly these rows for exactly these facts, so the
 * seeded explanation of "why does this need a human" is the explanation the
 * running engine would give.
 */
export const sdlcChangeGates = defineFixture<GateRow>({
  key: 'sdlc-change-gates',
  scenarios: {
    default: () => CHANGE_SEEDS.flatMap((seed) =>
      evaluationOf(seed).gates.map((g, i): GateRow => ({
        id: randomUUID(),
        changeRequestId: seed.id,
        policyId: g.policyId,
        policyName: g.policyName,
        kind: g.kind,
        outcome: g.outcome,
        detail: g.detail,
        // Gates are written in one pass right after the review lands; the
        // index keeps their ORDER BY created_at stable.
        createdAt: clock.hoursAgo(Math.max(0, seed.createdHoursAgo - 0.04 - i * 0.0001)),
      }))),
    empty: () => [],
    fresh: () => [],
  },
});

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The wire shape the provider's `ChangeRequest` describes, minus its nestings. */
export interface JoinedChange extends ChangeRow {
  repoFullName: string | null;
  orgProjectId: string | null;
  orgProjectName: string | null;
}

/**
 * Resolve the reads' joins.
 *
 * `JOIN agent_projects ap ON ap.id = cr.project_id` and
 * `LEFT JOIN projects op ON op.id = ap.org_project_id`. The inner join means a
 * change whose codebase has been unlinked does not come back at all — which is
 * why `mockListChangeRequests` filters on it rather than emitting nulls.
 */
function joinOf(row: ChangeRow): JoinedChange | null {
  const project = mockGetAgentProject(row.projectId);
  if (!project) return null;
  return {
    ...row,
    files: [...row.files],
    repoFullName: project.repoFullName,
    orgProjectId: project.orgProjectId,
    orgProjectName: project.orgProjectId ? mockProjectName(project.orgProjectId) : null,
  };
}

/** `INSERT ... RETURNING *` — the inserted row, with no join resolved. */
function unjoined(row: ChangeRow): JoinedChange {
  return { ...row, files: [...row.files], repoFullName: null, orgProjectId: null, orgProjectName: null };
}

function newestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** `WHERE change_request_id = :id ORDER BY created_at DESC`. */
export function mockListReviews(changeId: string): ReviewRow[] {
  return sdlcChangeReviews
    .rows()
    .filter((r) => r.changeRequestId === changeId)
    .sort(newestFirst)
    .map((r) => ({ ...r, findings: r.findings.map((f) => ({ ...f })) }));
}

/** `WHERE change_request_id = :id ORDER BY created_at` — ascending, unlike reviews. */
export function mockListGates(changeId: string): GateRow[] {
  return sdlcChangeGates
    .rows()
    .filter((g) => g.changeRequestId === changeId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((g) => ({ ...g }));
}

/** One change with its joins resolved; null for an unknown id or an unlinked codebase. */
export function mockGetChange(id: string): JoinedChange | null {
  const row = sdlcChanges.rows().find((c) => c.id === id);
  return row ? joinOf(row) : null;
}

/** The open states `listChangeRequests`' `open` filter and the schema's index name. */
const OPEN_STATUSES = ['needs_approval', 'changes_requested', 'in_review', 'captured'];

/**
 * `ORDER BY cr.created_at DESC LIMIT 100`, with `reviews`/`gates` left to the
 * caller — the list query does not join either, so the offline list must not
 * carry what the live one cannot.
 */
export function mockListChanges(opts: { projectId?: string; open?: boolean } = {}): JoinedChange[] {
  return sdlcChanges
    .rows()
    .filter((c) => (!opts.projectId || c.projectId === opts.projectId)
      && (!opts.open || OPEN_STATUSES.includes(c.status)))
    .map(joinOf)
    .filter((c): c is JoinedChange => c !== null)
    .sort(newestFirst)
    .slice(0, 100);
}

/**
 * Is there a later capture for this change's codebase? Delivery ships the live
 * workspace, and only the newest capture matches what is on disk.
 */
export function mockHasNewerChangeForProject(changeId: string): boolean {
  const rows = sdlcChanges.rows();
  const cur = rows.find((c) => c.id === changeId);
  if (!cur) return false;
  const curMs = new Date(cur.createdAt).getTime();
  return rows.some((c) => c.projectId === cur.projectId && c.id !== cur.id
    && new Date(c.createdAt).getTime() > curMs);
}

/**
 * The recorded cost of the run behind a change — `agent_project_runs.cost_usd`.
 * Null means "cannot judge", which is what the max_cost gate treats it as.
 */
export function mockRunCostUsd(runId: string | null): number | null {
  if (!runId) return null;
  return agentProjectRuns.rows().find((r) => r.id === runId)?.costUsd ?? null;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** What `setStatus` may set alongside the status. */
export interface StatusExtras {
  branchName?: string;
  prUrl?: string;
  error?: string;
  /** `decided_by`/`decided_at = NOW()`/`decision_note`, written together. */
  decision?: { by: string | null; note: string | null };
}

/** `UPDATE agent_change_requests SET status = ... WHERE id = ...` — silent on a miss. */
export function mockSetChangeStatus(id: string, status: string, extras: StatusExtras = {}): void {
  const row = sdlcChanges.rows().find((c) => c.id === id);
  if (!row) return;
  row.status = status;
  if (extras.branchName !== undefined) row.branchName = extras.branchName;
  if (extras.prUrl !== undefined) row.prUrl = extras.prUrl;
  if (extras.error !== undefined) row.error = extras.error;
  if (extras.decision) {
    row.decidedBy = extras.decision.by;
    row.decidedAt = clock.nowIso();
    row.decisionNote = extras.decision.note;
  }
}

/** `UPDATE agent_change_requests SET commit_sha = ...`. */
export function mockSetCommitSha(id: string, sha: string): void {
  const row = sdlcChanges.rows().find((c) => c.id === id);
  if (row) row.commitSha = sha;
}

/**
 * `INSERT INTO agent_change_requests ... RETURNING *`.
 *
 * `work_item_id` is copied from the run, as the real statement's subquery does
 * — but `mock/agent-project-runs.ts` does not model that column, so offline it
 * resolves to null for every run, exactly as the subquery does for a run that
 * carries none. Diff truncation happens in the provider, above this call, so
 * both paths bound it identically.
 */
export function mockCreateChange(input: {
  projectId: string; runId: string | null; title: string;
  diff: string; diffTruncated: boolean; files: string[]; model: string | null;
}): JoinedChange {
  const row: ChangeRow = {
    id: randomUUID(),
    runId: input.runId,
    projectId: input.projectId,
    workItemId: null,
    title: input.title,
    status: 'captured',
    diff: input.diff,
    diffTruncated: input.diffTruncated,
    files: [...input.files],
    filesChanged: input.files.length,
    model: input.model,
    commitSha: null,
    branchName: null,
    prUrl: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    error: null,
    createdAt: clock.nowIso(),
  };
  sdlcChanges.rows().push(row);
  return unjoined(row);
}

/** `INSERT INTO agent_change_reviews ...` — appends, never overwrites. */
export function mockRecordReview(input: {
  changeId: string; reviewer: string; model: string | null;
  verdict: ReviewVerdict; summary: string | null;
  findings: ReviewRow['findings'];
}): void {
  sdlcChangeReviews.rows().push({
    id: randomUUID(),
    changeRequestId: input.changeId,
    reviewer: input.reviewer,
    model: input.model,
    verdict: input.verdict,
    summary: input.summary,
    findings: input.findings.map((f) => ({ ...f })),
    createdAt: clock.nowIso(),
  });
}

/**
 * `DELETE FROM agent_change_gates WHERE change_request_id = ...` then one
 * INSERT per gate — the recorded gates reflect the current decision rather
 * than accumulating every re-evaluation.
 */
export function mockReplaceGates(changeId: string, gates: GateResult[]): void {
  const rows = sdlcChangeGates.rows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.changeRequestId === changeId) rows.splice(i, 1);
  }
  const at = clock.nowIso();
  for (const g of gates) {
    rows.push({
      id: randomUUID(),
      changeRequestId: changeId,
      policyId: g.policyId,
      policyName: g.policyName,
      kind: g.kind,
      outcome: g.outcome,
      detail: g.detail,
      createdAt: at,
    });
  }
}
