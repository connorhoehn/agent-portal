// SDLC governance — persistence and orchestration for code change requests.
//
// The pure decision logic lives in lib/sdlc-policy.ts; this is the side that
// touches Aurora and stitches the pipeline together. It mirrors the shape of
// graph-proposals — the codebase's cleanest "propose → review → approve →
// apply" pattern — but for code rather than graph writes.
//
// The one rule it holds throughout: a change advances only through states the
// gate engine or a human authorised. Nothing here flips a change to `approved`
// on its own; approval is always the result of evaluating policies against
// facts, or of a person deciding.

import { exec } from './aurora.js';
import { config } from '../config.js';
import {
  evaluate, DEFAULT_POLICIES,
  type SdlcPolicy, type ChangeFacts, type ReviewVerdict, type Evaluation,
} from '../lib/sdlc-policy.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: value } }; }
function b(name: string, value: boolean): SqlParameter { return { name, value: { booleanValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter { return v ? s(name, v) : nul(name); }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function toBool(v: unknown): boolean { return v === true || v === 'true' || v === 1; }
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

// ─── Policies ─────────────────────────────────────────────────────────────────

function rowToPolicy(r: Record<string, unknown>): SdlcPolicy {
  return {
    id: toStr(r['id']),
    name: toStr(r['name']),
    enabled: toBool(r['enabled']),
    kind: toStr(r['kind']) as SdlcPolicy['kind'],
    config: parseJson<Record<string, unknown>>(r['config'], {}),
    action: toStr(r['action'], 'require_approval') as SdlcPolicy['action'],
  };
}

export async function listPolicies(): Promise<SdlcPolicy[]> {
  if (config.mock.aurora) return DEFAULT_POLICIES.map((p, i) => ({ id: `default-${i}`, ...p }));
  const rows = await exec(`SELECT * FROM sdlc_policies ORDER BY created_at`);
  return rows.map(rowToPolicy);
}

/**
 * Ensure a set of policies exists.
 *
 * Called once when the surface is first used, so a fresh environment starts
 * governed rather than wide open — the safe default is the whole point of a
 * governance layer, and an empty policy table would auto-approve everything.
 */
export async function seedDefaultPolicies(): Promise<number> {
  if (config.mock.aurora) return 0;
  const existing = await exec(`SELECT count(*)::int AS n FROM sdlc_policies`);
  if (toNum(existing[0]?.['n']) > 0) return 0;
  let seeded = 0;
  for (const p of DEFAULT_POLICIES) {
    await exec(
      `INSERT INTO sdlc_policies (name, enabled, kind, config, action)
       VALUES (:name, :enabled, :kind, :config::jsonb, :action)`,
      [s('name', p.name), b('enabled', p.enabled), s('kind', p.kind),
        s('config', JSON.stringify(p.config)), s('action', p.action)],
    );
    seeded++;
  }
  return seeded;
}

export async function upsertPolicy(input: {
  id?: string; name: string; enabled: boolean; kind: SdlcPolicy['kind'];
  config: Record<string, unknown>; action: SdlcPolicy['action'];
}): Promise<SdlcPolicy> {
  if (input.id && isUuid(input.id)) {
    const rows = await exec(
      `UPDATE sdlc_policies
          SET name = :name, enabled = :enabled, kind = :kind,
              config = :config::jsonb, action = :action, updated_at = NOW()
        WHERE id = :id::uuid RETURNING *`,
      [s('id', input.id), s('name', input.name), b('enabled', input.enabled),
        s('kind', input.kind), s('config', JSON.stringify(input.config)), s('action', input.action)],
    );
    if (!rows[0]) throw new Error('policy not found');
    return rowToPolicy(rows[0]);
  }
  const rows = await exec(
    `INSERT INTO sdlc_policies (name, enabled, kind, config, action)
     VALUES (:name, :enabled, :kind, :config::jsonb, :action) RETURNING *`,
    [s('name', input.name), b('enabled', input.enabled), s('kind', input.kind),
      s('config', JSON.stringify(input.config)), s('action', input.action)],
  );
  return rowToPolicy(rows[0]!);
}

export async function deletePolicy(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await exec(`DELETE FROM sdlc_policies WHERE id = :id::uuid RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}

// ─── Change requests ────────────────────────────────────────────────────────

export interface ChangeReview {
  id: string;
  reviewer: string;
  model: string | null;
  verdict: ReviewVerdict;
  summary: string | null;
  findings: Array<{ severity?: string; file?: string; line?: number; note: string }>;
  createdAt: string;
}

export interface ChangeGate {
  policyName: string; kind: string; outcome: string; detail: string;
}

export interface ChangeRequest {
  id: string;
  runId: string | null;
  projectId: string;
  repoFullName: string | null;
  /** The initiative the codebase serves — lets the UI link a change to it. */
  orgProjectId: string | null;
  orgProjectName: string | null;
  /** The work item the run behind this change was serving — null for changes
   *  captured outside the marketplace loop. */
  workItemId: string | null;
  title: string;
  status: string;
  diff: string | null;
  diffTruncated: boolean;
  files: string[];
  filesChanged: number;
  model: string | null;
  /** The workspace commit this change was captured as; null for legacy changes. */
  commitSha: string | null;
  branchName: string | null;
  prUrl: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  error: string | null;
  createdAt: string;
  reviews: ChangeReview[];
  gates: ChangeGate[];
}

const MAX_DIFF_CHARS = 200_000;

function rowToChange(r: Record<string, unknown>): ChangeRequest {
  return {
    id: toStr(r['id']),
    runId: r['run_id'] ? toStr(r['run_id']) : null,
    projectId: toStr(r['project_id']),
    repoFullName: r['repo_full_name'] ? toStr(r['repo_full_name']) : null,
    orgProjectId: r['org_project_id'] ? toStr(r['org_project_id']) : null,
    orgProjectName: r['org_project_name'] ? toStr(r['org_project_name']) : null,
    workItemId: r['work_item_id'] ? toStr(r['work_item_id']) : null,
    title: toStr(r['title']),
    status: toStr(r['status'], 'captured'),
    diff: r['diff'] ? toStr(r['diff']) : null,
    diffTruncated: toBool(r['diff_truncated']),
    files: parseJson<string[]>(r['files'], []),
    filesChanged: toNum(r['files_changed']),
    model: r['model'] ? toStr(r['model']) : null,
    commitSha: r['commit_sha'] ? toStr(r['commit_sha']) : null,
    branchName: r['branch_name'] ? toStr(r['branch_name']) : null,
    prUrl: r['pr_url'] ? toStr(r['pr_url']) : null,
    decidedBy: r['decided_by'] ? toStr(r['decided_by']) : null,
    decidedAt: r['decided_at'] ? toStr(r['decided_at']) : null,
    decisionNote: r['decision_note'] ? toStr(r['decision_note']) : null,
    error: r['error'] ? toStr(r['error']) : null,
    createdAt: toStr(r['created_at']),
    reviews: [],
    gates: [],
  };
}

/**
 * Capture a diff as a change request.
 *
 * The `model` is stored on the request so a policy can gate on who authored it
 * later, when the run row may be gone. The diff is bounded rather than
 * refused: a change too big to store is too big to eyeball, so it keeps its
 * file list and stat and truncates the body.
 */
export async function createChangeRequest(input: {
  projectId: string; runId?: string | null; title: string;
  diff: string; files: string[]; model?: string | null;
}): Promise<ChangeRequest> {
  const truncated = input.diff.length > MAX_DIFF_CHARS;
  const diff = truncated ? input.diff.slice(0, MAX_DIFF_CHARS) : input.diff;
  // work_item_id is copied from the run at capture time, so the change carries
  // its marketplace attribution even after the run row is retained away. The
  // subquery yields NULL when runId is absent (no row matches a NULL id).
  const rows = await exec(
    `INSERT INTO agent_change_requests
        (project_id, run_id, title, diff, diff_truncated, files, files_changed, model, status, work_item_id)
     VALUES (:pid::uuid, :rid::uuid, :title, :diff, :trunc, :files::jsonb, :nfiles, :model, 'captured',
             (SELECT work_item_id FROM agent_project_runs WHERE id = :rid::uuid))
     RETURNING *`,
    [
      s('pid', input.projectId),
      input.runId ? s('rid', input.runId) : nul('rid'),
      s('title', input.title.slice(0, 300)),
      s('diff', diff),
      b('trunc', truncated),
      s('files', JSON.stringify(input.files)),
      n('nfiles', input.files.length),
      maybe('model', input.model ?? null),
    ],
  );
  return rowToChange(rows[0]!);
}

/** Record the workspace commit a change was captured as (commit-per-capture). */
export async function setCommitSha(id: string, sha: string): Promise<void> {
  await exec(
    `UPDATE agent_change_requests SET commit_sha = :sha, updated_at = NOW() WHERE id = :id::uuid`,
    [s('id', id), s('sha', sha)],
  );
}


// ── Mock change requests ────────────────────────────────────────────────────
//
// dev:mock previously returned an empty queue, which made the review surface
// undemoable offline — and unreviewable in tests. These fixtures are shaped
// exactly like real captures: genuine unified diffs, reviewer findings that
// point at real file:line targets inside them (the reviewer UI pins notes to
// diff lines, so a finding aimed at a line the diff lacks would silently
// exercise nothing), and gate rows. Decisions mutate them in memory.

const MOCK_DEDUP_DIFF = `diff --git a/src/alerts/dedup.ts b/src/alerts/dedup.ts
index 3f1a2b4..9c8d7e6 100644
--- a/src/alerts/dedup.ts
+++ b/src/alerts/dedup.ts
@@ -12,9 +12,12 @@ export interface AlertGroup {
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
@@ -30,6 +33,7 @@ export function dedupe(alerts: Alert[]): AlertGroup[] {
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

const MOCK_DASH_DIFF = `diff --git a/dashboards/red.jsonnet b/dashboards/red.jsonnet
index aaa111..bbb222 100644
--- a/dashboards/red.jsonnet
+++ b/dashboards/red.jsonnet
@@ -4,6 +4,8 @@ local grafana = import 'grafonnet/grafana.libsonnet';
 {
   red_dashboard(service):: {
     title: 'RED — ' + service,
+    // Span metrics are the primary source; StatsD stays as the fallback
+    // panel behind the $source variable (span metrics lag ~3min).
     panels: [
@@ -22,7 +24,7 @@ local grafana = import 'grafonnet/grafana.libsonnet';
       rate_panel(service):: {
-        expr: 'sum(rate(statsd_requests_total{service="' + service + '"}[5m]))',
+        expr: 'sum(rate(traces_span_metrics_calls_total{service="' + service + '"}[5m]))',
       },
`;

function mockChange(over: Partial<ChangeRequest> & Pick<ChangeRequest, 'id' | 'title' | 'status' | 'diff'>): ChangeRequest {
  const files = parseFilesOf(over.diff ?? '');
  return {
    runId: null, projectId: 'mock-proj-obs', repoFullName: 'connorhoehn/observability-platform',
    orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
    workItemId: null, diffTruncated: false, files, filesChanged: files.length,
    model: 'us.anthropic.claude-sonnet-5', commitSha: 'c0ffee1', branchName: null, prUrl: null,
    decidedBy: null, decidedAt: null, decisionNote: null, error: null,
    createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    reviews: [], gates: [], ...over,
  };
}

function parseFilesOf(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]!);
}

const MOCK_CHANGES: ChangeRequest[] = [
  mockChange({
    id: 'chg-mock-1',
    title: 'Alert dedup: collapse by alertname+namespace',
    status: 'needs_approval',
    diff: MOCK_DEDUP_DIFF,
    branchName: 'agent/alert-dedup-namespace',
    reviews: [{
      id: 'rev-1', reviewer: 'model', model: 'amazon.nova-pro-v1:0', verdict: 'approve',
      summary: 'Correct approach and a pinning test. One latent collision risk and one leftover variable worth a look before shipping.',
      findings: [
        { severity: 'warning', file: 'src/alerts/dedup.ts', line: 16, note: 'Template-literal key means a namespace containing ":" collides with another alert — consider a tuple key or escaping.' },
        { severity: 'info', file: 'src/alerts/dedup.ts', line: 20, note: 'The new `seen` set is never read — leftover from an earlier approach?' },
        { severity: 'info', file: 'src/alerts/dedup.test.ts', line: 5, note: 'Good: this test pins the collapse-per-namespace decision.' },
      ],
      createdAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    }],
    gates: [
      { policyName: 'sensitive-paths', kind: 'path', outcome: 'pass', detail: 'No sensitive path touched' },
      { policyName: 'max-diff-size', kind: 'size', outcome: 'pass', detail: '46 lines changed (limit 1500)' },
      { policyName: 'human-approval', kind: 'approval', outcome: 'hold', detail: 'Alerting config always needs a person' },
    ],
  }),
  mockChange({
    id: 'chg-mock-2',
    title: 'RED dashboards: span metrics primary, StatsD fallback',
    status: 'delivered',
    diff: MOCK_DASH_DIFF,
    branchName: 'agent/red-span-metrics',
    prUrl: 'https://github.com/connorhoehn/observability-platform/pull/41',
    decidedBy: 'u-nora', decidedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    decisionNote: 'Matches the consult decision — span metrics primary.',
    createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    reviews: [{
      id: 'rev-2', reviewer: 'model', model: 'amazon.nova-pro-v1:0', verdict: 'approve',
      summary: 'Source swap is scoped to the rate panel and documented.',
      findings: [],
      createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    }],
    gates: [
      { policyName: 'sensitive-paths', kind: 'path', outcome: 'pass', detail: 'No sensitive path touched' },
      { policyName: 'max-diff-size', kind: 'size', outcome: 'pass', detail: '12 lines changed (limit 1500)' },
    ],
  }),
];

export async function getChangeRequest(id: string): Promise<ChangeRequest | null> {
  if (config.mock.aurora) return MOCK_CHANGES.find((c) => c.id === id) ?? null;
  if (!isUuid(id)) return null;
  const rows = await exec(
    `SELECT cr.*, ap.repo_full_name, ap.org_project_id, op.name AS org_project_name
       FROM agent_change_requests cr
       JOIN agent_projects ap ON ap.id = cr.project_id
       LEFT JOIN projects op ON op.id = ap.org_project_id
      WHERE cr.id = :id::uuid`,
    [s('id', id)],
  );
  if (!rows[0]) return null;
  const change = rowToChange(rows[0]);
  change.reviews = await listReviews(id);
  change.gates = await listGates(id);
  return change;
}

export async function listChangeRequests(opts: { projectId?: string; open?: boolean } = {}): Promise<ChangeRequest[]> {
  if (config.mock.aurora) {
    return MOCK_CHANGES.filter((c) =>
      (!opts.projectId || c.projectId === opts.projectId) &&
      (!opts.open || ['needs_approval', 'changes_requested', 'in_review', 'captured'].includes(c.status)));
  }
  const where: string[] = [];
  const params: SqlParameter[] = [];
  if (opts.projectId && isUuid(opts.projectId)) { where.push('cr.project_id = :pid::uuid'); params.push(s('pid', opts.projectId)); }
  if (opts.open) where.push(`cr.status IN ('needs_approval','changes_requested','in_review','captured')`);
  const rows = await exec(
    `SELECT cr.*, ap.repo_full_name, ap.org_project_id, op.name AS org_project_name
       FROM agent_change_requests cr
       JOIN agent_projects ap ON ap.id = cr.project_id
       LEFT JOIN projects op ON op.id = ap.org_project_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY cr.created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(rowToChange);
}

/**
 * Has a newer change been captured for this change's project?
 *
 * Delivery ships the *live workspace*, and a project has exactly one workspace,
 * so a change captured after this one means the workspace has moved on since —
 * its files now reflect the newer run, not this one. Delivering this change
 * would push the newer change's content under this change's review and gates:
 * the reviewed thing and the delivered thing would differ. Only the latest
 * capture for a project corresponds to what is on disk, so only it is
 * deliverable. This is the guard the schema's "a new run supersedes" comment
 * describes; enforced here rather than by mutating the older row, so no new
 * status is needed and an approved-but-stale change simply cannot be shipped.
 */
export async function hasNewerChangeForProject(changeId: string): Promise<boolean> {
  if (!isUuid(changeId)) return false;
  const rows = await exec(
    `SELECT 1
       FROM agent_change_requests newer, agent_change_requests cur
      WHERE cur.id = :id::uuid
        AND newer.project_id = cur.project_id
        AND newer.id <> cur.id
        AND newer.created_at > cur.created_at
      LIMIT 1`,
    [s('id', changeId)],
  );
  return rows.length > 0;
}

async function setStatus(id: string, status: string, extra: SqlParameter[] = [], set = ''): Promise<void> {
  await exec(
    `UPDATE agent_change_requests SET status = :status, updated_at = NOW()${set ? `, ${set}` : ''} WHERE id = :id::uuid`,
    [s('id', id), s('status', status), ...extra],
  );
}

export async function markInReview(id: string): Promise<void> { await setStatus(id, 'in_review'); }
export async function markDelivering(id: string): Promise<void> { await setStatus(id, 'delivering'); }
export async function markDelivered(id: string, branch: string, prUrl: string): Promise<void> {
  await setStatus(id, 'delivered', [s('branch', branch), s('pr', prUrl)], 'branch_name = :branch, pr_url = :pr');
}
export async function markFailed(id: string, error: string): Promise<void> {
  await setStatus(id, 'failed', [s('err', error.slice(0, 2000))], 'error = :err');
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

function rowToReview(r: Record<string, unknown>): ChangeReview {
  return {
    id: toStr(r['id']),
    reviewer: toStr(r['reviewer'], 'agent'),
    model: r['model'] ? toStr(r['model']) : null,
    verdict: toStr(r['verdict']) as ReviewVerdict,
    summary: r['summary'] ? toStr(r['summary']) : null,
    findings: parseJson(r['findings'], []),
    createdAt: toStr(r['created_at']),
  };
}

export async function listReviews(changeId: string): Promise<ChangeReview[]> {
  if (!isUuid(changeId)) return [];
  const rows = await exec(
    `SELECT * FROM agent_change_reviews WHERE change_request_id = :id::uuid ORDER BY created_at DESC`,
    [s('id', changeId)],
  );
  return rows.map(rowToReview);
}

export async function recordReview(input: {
  changeId: string; reviewer?: string; model?: string | null;
  verdict: ReviewVerdict; summary?: string | null;
  findings?: ChangeReview['findings'];
}): Promise<void> {
  await exec(
    `INSERT INTO agent_change_reviews (change_request_id, reviewer, model, verdict, summary, findings)
     VALUES (:cid::uuid, :reviewer, :model, :verdict, :summary, :findings::jsonb)`,
    [
      s('cid', input.changeId),
      s('reviewer', input.reviewer ?? 'agent'),
      maybe('model', input.model ?? null),
      s('verdict', input.verdict),
      maybe('summary', input.summary ?? null),
      s('findings', JSON.stringify(input.findings ?? [])),
    ],
  );
}

// ─── Gates ────────────────────────────────────────────────────────────────────

async function listGates(changeId: string): Promise<ChangeGate[]> {
  if (!isUuid(changeId)) return [];
  const rows = await exec(
    `SELECT policy_name, kind, outcome, detail FROM agent_change_gates
      WHERE change_request_id = :id::uuid ORDER BY created_at`,
    [s('id', changeId)],
  );
  return rows.map((r) => ({
    policyName: toStr(r['policy_name']), kind: toStr(r['kind']),
    outcome: toStr(r['outcome']), detail: toStr(r['detail']),
  }));
}

/**
 * The recorded dollar cost of the run behind a change — the max_cost fact.
 *
 * Null when the change has no run, the run row is gone, or the run finished
 * without a cost being recorded. The engine treats a null cost as "cannot
 * judge" rather than "over budget"; see the max_cost case in sdlc-policy.ts.
 */
async function runCostUsd(runId: string | null): Promise<number | null> {
  if (!runId || !isUuid(runId)) return null;
  const rows = await exec(
    `SELECT cost_usd::float8 AS cost_usd FROM agent_project_runs WHERE id = :id::uuid`,
    [s('id', runId)],
  );
  const v = rows[0]?.['cost_usd'];
  return v == null ? null : Number(v);
}

/**
 * Run the gate engine over a change and record the result.
 *
 * This is the one function that moves a change into `approved`, `needs_approval`,
 * `changes_requested`, or `blocked` — always as the output of the pure engine,
 * never by fiat. It re-reads the latest review each time, so re-evaluating
 * after a review lands produces the right decision without special-casing.
 */
export async function evaluateChange(changeId: string): Promise<{ evaluation: Evaluation; status: string } | null> {
  const change = await getChangeRequest(changeId);
  if (!change) return null;

  // Seed before evaluating, not only when the policy UI is opened. A governed
  // run can capture a change before anyone has visited the policy page, and
  // evaluating against an empty policy set auto-approves it — governance
  // silently off exactly when a fresh environment most needs it on. Idempotent:
  // seeding is a no-op once any policy exists.
  await seedDefaultPolicies().catch(() => { /* fail-safe below covers a failed seed */ });
  const policies = await listPolicies();
  const latestReview = change.reviews[0] ?? null;
  const facts: ChangeFacts = {
    files: change.files,
    model: change.model,
    reviewVerdict: latestReview?.verdict ?? null,
    costUsd: await runCostUsd(change.runId),
  };
  const evaluation = evaluate(policies, facts);

  // Defence in depth: the pure engine reads zero gates as "approved" because it
  // cannot tell "no policies configured" from "policies configured, none
  // fired". If the policy set is empty here — seeding raced or failed — refuse
  // to auto-approve and route to a human instead. A governance layer must fail
  // closed, never open.
  if (policies.length === 0 && evaluation.decision === 'approved') {
    evaluation.decision = 'needs_approval';
    evaluation.autoApproved = false;
    evaluation.gates.push({
      policyId: null,
      policyName: 'no policies configured',
      kind: 'require_review',
      outcome: 'requires_approval',
      detail: 'No governance policies are configured; routed to a human to fail closed.',
    });
  }

  // Replace prior gate rows for this change — the recorded gates should reflect
  // the current decision, not accumulate every re-evaluation.
  await exec(`DELETE FROM agent_change_gates WHERE change_request_id = :id::uuid`, [s('id', changeId)]);
  for (const g of evaluation.gates) {
    await exec(
      `INSERT INTO agent_change_gates (change_request_id, policy_id, policy_name, kind, outcome, detail)
       VALUES (:cid::uuid, :pid, :name, :kind, :outcome, :detail)`,
      [s('cid', changeId), maybe('pid', g.policyId), s('name', g.policyName),
        s('kind', g.kind), s('outcome', g.outcome), maybe('detail', g.detail)],
    );
  }

  await setStatus(changeId, evaluation.decision);
  return { evaluation, status: evaluation.decision };
}

/** States a human may still decide on. */
const DECIDABLE = new Set(['needs_approval', 'changes_requested']);

/**
 * A human's decision on a change awaiting one.
 *
 * A human can decide a `changes_requested` change too, not only a
 * `needs_approval` one: the reviewer is an advisor, and a person overruling it
 * — approving a change the bot wanted revised, or rejecting one it did not — is
 * the whole reason a human is in this loop. The decision and who made it are
 * recorded either way, so an override is auditable rather than invisible.
 *
 * Deliberately narrow beyond that: it records the decision and stops. Delivery
 * is a separate, explicit step, because approving a change and shipping it are
 * two decisions and collapsing them removes the moment to stop.
 */
export async function decideChange(id: string, decision: 'approve' | 'reject', input: {
  by?: string | null; note?: string | null;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  const change = await getChangeRequest(id);
  if (!change) return { ok: false, error: 'change not found' };
  if (!DECIDABLE.has(change.status)) {
    return { ok: false, error: `change is ${change.status}, not awaiting a decision` };
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  if (config.mock.aurora) {
    change.status = status;
    change.decidedBy = input.by ?? null;
    change.decidedAt = new Date().toISOString();
    change.decisionNote = input.note ?? null;
    return { ok: true, status };
  }
  await setStatus(id, status,
    [maybe('by', input.by ?? null), maybe('note', input.note ?? null)],
    'decided_by = :by, decided_at = NOW(), decision_note = :note');
  return { ok: true, status };
}
