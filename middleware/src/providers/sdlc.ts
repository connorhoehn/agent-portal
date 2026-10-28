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
  type GateResult,
} from '../lib/sdlc-policy.js';
import {
  mockListPolicies, mockSeedDefaultPolicies, mockUpsertPolicy, mockDeletePolicy,
  mockCreateChange, mockSetCommitSha, mockGetChange, mockListChanges,
  mockHasNewerChangeForProject, mockSetChangeStatus, mockListReviews,
  mockRecordReview, mockListGates, mockReplaceGates, mockRunCostUsd,
  type JoinedChange, type StatusExtras,
} from '../mock/sdlc.js';
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
  if (config.mock.aurora) return mockListPolicies();
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
  // Offline this is not a no-op. Returning 0 without seeding left the mock
  // policy set defined only by whatever `listPolicies` happened to synthesise,
  // so an emptied policy table could never come back — and `evaluateChange`'s
  // fail-closed arm (no policies configured) could never be exercised.
  if (config.mock.aurora) return mockSeedDefaultPolicies();
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
  if (config.mock.aurora) {
    // Mirror the update/insert split exactly: only a uuid `id` addresses an
    // existing row; anything else is an insert, id and all.
    const { id, ...rest } = input;
    return mockUpsertPolicy(id && isUuid(id) ? { ...rest, id } : rest);
  }
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
  if (config.mock.aurora) return mockDeletePolicy(id);
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
  /** The work item behind the run, when the caller knows it. Real Aurora can
   *  read it back off the run row; the offline store has no subquery. */
  workItemId?: string | null;
}): Promise<ChangeRequest> {
  const truncated = input.diff.length > MAX_DIFF_CHARS;
  const diff = truncated ? input.diff.slice(0, MAX_DIFF_CHARS) : input.diff;
  const title = input.title.slice(0, 300);
  if (config.mock.aurora) {
    return joinedToChange(mockCreateChange({
      projectId: input.projectId, runId: input.runId ?? null, title,
      diff, diffTruncated: truncated, files: input.files, model: input.model ?? null,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    }));
  }
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
      s('title', title),
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
  if (config.mock.aurora) { mockSetCommitSha(id, sha); return; }
  await exec(
    `UPDATE agent_change_requests SET commit_sha = :sha, updated_at = NOW() WHERE id = :id::uuid`,
    [s('id', id), s('sha', sha)],
  );
}

/**
 * The offline row → the wire shape.
 *
 * `reviews`/`gates` start empty here for the same reason `rowToChange` does:
 * neither read joins them, and only `getChangeRequest` fetches them afterwards.
 * An offline list that carried reviews the live list cannot return would be a
 * fixture disagreeing with its own server.
 */
function joinedToChange(row: JoinedChange): ChangeRequest {
  return { ...row, reviews: [], gates: [] };
}

export async function getChangeRequest(id: string): Promise<ChangeRequest | null> {
  if (config.mock.aurora) {
    const row = mockGetChange(id);
    if (!row) return null;
    const change = joinedToChange(row);
    change.reviews = await listReviews(id);
    change.gates = await listGates(id);
    return change;
  }
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
  if (config.mock.aurora) return mockListChanges(opts).map(joinedToChange);
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
  if (config.mock.aurora) return mockHasNewerChangeForProject(changeId);
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

/**
 * Move a change to a status, optionally writing the columns that go with it.
 *
 * The extras are a typed patch rather than a raw `SET` fragment plus loose
 * parameters. The fragment version could not be mirrored offline — a mock
 * branch cannot apply `branch_name = :branch` to an object — so the whole
 * lifecycle (in_review, delivering, delivered, failed, and every human
 * decision) had no offline path and 500'd. One shape, two backends.
 */
async function setStatus(id: string, status: string, extras: StatusExtras = {}): Promise<void> {
  if (config.mock.aurora) { mockSetChangeStatus(id, status, extras); return; }
  const sets: string[] = [];
  const params: SqlParameter[] = [s('id', id), s('status', status)];
  if (extras.branchName !== undefined) { sets.push('branch_name = :branch'); params.push(s('branch', extras.branchName)); }
  if (extras.prUrl !== undefined) { sets.push('pr_url = :pr'); params.push(s('pr', extras.prUrl)); }
  if (extras.error !== undefined) { sets.push('error = :err'); params.push(s('err', extras.error.slice(0, 2000))); }
  if (extras.decision) {
    sets.push('decided_by = :by', 'decided_at = NOW()', 'decision_note = :note');
    params.push(maybe('by', extras.decision.by), maybe('note', extras.decision.note));
  }
  await exec(
    `UPDATE agent_change_requests SET status = :status, updated_at = NOW()${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = :id::uuid`,
    params,
  );
}

export async function markInReview(id: string): Promise<void> { await setStatus(id, 'in_review'); }
export async function markDelivering(id: string): Promise<void> { await setStatus(id, 'delivering'); }
export async function markDelivered(id: string, branch: string, prUrl: string): Promise<void> {
  await setStatus(id, 'delivered', { branchName: branch, prUrl });
}
export async function markFailed(id: string, error: string): Promise<void> {
  await setStatus(id, 'failed', { error });
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
  if (config.mock.aurora) {
    return mockListReviews(changeId).map(({ changeRequestId: _fk, ...review }) => review);
  }
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
  if (config.mock.aurora) {
    mockRecordReview({
      changeId: input.changeId,
      reviewer: input.reviewer ?? 'agent',
      model: input.model ?? null,
      verdict: input.verdict,
      summary: input.summary ?? null,
      findings: input.findings ?? [],
    });
    return;
  }
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
  if (config.mock.aurora) {
    // `detail` is nullable in the table and `toStr` reads a NULL as '', so the
    // offline row coalesces the same way rather than emitting a null the wire
    // shape does not allow.
    return mockListGates(changeId).map((g) => ({
      policyName: g.policyName, kind: g.kind, outcome: g.outcome, detail: g.detail ?? '',
    }));
  }
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
 * Replace this change's recorded gates with the current evaluation's.
 *
 * The recorded gates should reflect the current decision, not accumulate every
 * re-evaluation — so it is a delete-then-insert, and it is one function rather
 * than two raw `exec`s inline in `evaluateChange` so the offline path has a
 * seam to mirror. Without it, re-running the gates 500'd offline even though
 * every fact it needed was in memory.
 */
async function replaceGates(changeId: string, gates: GateResult[]): Promise<void> {
  if (config.mock.aurora) { mockReplaceGates(changeId, gates); return; }
  await exec(`DELETE FROM agent_change_gates WHERE change_request_id = :id::uuid`, [s('id', changeId)]);
  for (const g of gates) {
    await exec(
      `INSERT INTO agent_change_gates (change_request_id, policy_id, policy_name, kind, outcome, detail)
       VALUES (:cid::uuid, :pid, :name, :kind, :outcome, :detail)`,
      [s('cid', changeId), maybe('pid', g.policyId), s('name', g.policyName),
        s('kind', g.kind), s('outcome', g.outcome), maybe('detail', g.detail)],
    );
  }
}

/**
 * The recorded dollar cost of the run behind a change — the max_cost fact.
 *
 * Null when the change has no run, the run row is gone, or the run finished
 * without a cost being recorded. The engine treats a null cost as "cannot
 * judge" rather than "over budget"; see the max_cost case in sdlc-policy.ts.
 */
async function runCostUsd(runId: string | null): Promise<number | null> {
  if (config.mock.aurora) return mockRunCostUsd(runId);
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
  // fired". If no policy is ENABLED here — seeding raced or failed, or every
  // rule was saved disabled — refuse to auto-approve and route to a human
  // instead. Counting rows let a set of disabled defaults approve every change
  // (the engine skips them, and re-seeding only runs on an empty table). A
  // governance layer must fail closed, never open.
  if (!policies.some((policy) => policy.enabled) && evaluation.decision === 'approved') {
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

  await replaceGates(changeId, evaluation.gates);
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
  // One call for both backends. The old offline arm mutated the object it had
  // just read — a copy, in the fixture world — so an offline approval reported
  // success and left the queue untouched; and it minted its own `new Date()`,
  // a fixture timestamp outside the fixture directory.
  await setStatus(id, status, { decision: { by: input.by ?? null, note: input.note ?? null } });
  return { ok: true, status };
}
