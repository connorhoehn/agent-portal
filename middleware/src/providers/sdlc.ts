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
  evaluate, governancePathsTouched,
  type SdlcPolicy, type ChangeFacts, type ReviewVerdict, type Evaluation,
  type GateResult,
} from '../lib/sdlc-policy.js';
import {
  mockCreateChange, mockSetCommitSha, mockGetChange, mockListChanges,
  mockHasNewerChangeForProject, mockSetChangeStatus, mockListReviews,
  mockRecordReview, mockListGates, mockListGateHistory, mockAppendGates, mockSetPolicyPin,
  mockHasChangesRequestedBy, mockRunCostUsd,
  type JoinedChange, type StatusExtras,
} from '../mock/sdlc.js';
import {
  ensureOrgPolicySet, latestPolicySet, getPolicySetVersion, resolvePolicyScope, ORG_SCOPE,
  type PolicySetVersion,
} from './sdlc-policy-sets.js';
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
//
// Policies live in versioned sets now (providers/sdlc-policy-sets.ts, DE-46).
// `listPolicies` is the org set's current version — the list the legacy
// GET /api/sdlc/policies returns. The old in-place `upsertPolicy` /
// `deletePolicy` and the seed-on-empty `seedDefaultPolicies` are gone: an edit
// is a new version, and the org set is bootstrapped once rather than
// re-seeded whenever the table happens to be empty.

export async function listPolicies(): Promise<SdlcPolicy[]> {
  return (await ensureOrgPolicySet()).policies;
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
  /** Who caused the change: the run's dispatcher, else a bot's creator (DE-43). Null for changes captured before it was recorded. */
  requestedBy: string | null;
  /** The policy set version this change is judged under (DE-46); null until first evaluated. */
  policyScope: string | null;
  policyVersion: number | null;
  /** Which evaluation `gates` belong to; earlier ones are in GET /changes/:id/evaluations. */
  evaluationSeq: number;
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
    requestedBy: r['requested_by'] ? toStr(r['requested_by']) : null,
    policyScope: r['policy_scope'] ? toStr(r['policy_scope']) : null,
    policyVersion: r['policy_version'] == null ? null : toNum(r['policy_version']),
    evaluationSeq: toNum(r['evaluation_seq']),
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
  /** Who caused it (DE-43): stamped by the pipeline from the dispatch. */
  requestedBy?: string | null;
}): Promise<ChangeRequest> {
  const truncated = input.diff.length > MAX_DIFF_CHARS;
  const diff = truncated ? input.diff.slice(0, MAX_DIFF_CHARS) : input.diff;
  const title = input.title.slice(0, 300);
  if (config.mock.aurora) {
    return joinedToChange(mockCreateChange({
      projectId: input.projectId, runId: input.runId ?? null, title,
      diff, diffTruncated: truncated, files: input.files, model: input.model ?? null,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      requestedBy: input.requestedBy ?? null,
    }));
  }
  // work_item_id is copied from the run at capture time, so the change carries
  // its marketplace attribution even after the run row is retained away. The
  // subquery yields NULL when runId is absent (no row matches a NULL id).
  const rows = await exec(
    `INSERT INTO agent_change_requests
        (project_id, run_id, title, diff, diff_truncated, files, files_changed, model, status, work_item_id, requested_by)
     VALUES (:pid::uuid, :rid::uuid, :title, :diff, :trunc, :files::jsonb, :nfiles, :model, 'captured',
             (SELECT work_item_id FROM agent_project_runs WHERE id = :rid::uuid),
             COALESCE(:requested_by, (SELECT dispatched_by FROM agent_project_runs WHERE id = :rid::uuid)))
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
      maybe('requested_by', input.requestedBy ?? null),
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
  // The current evaluation only (DE-46); the change row carries its sequence.
  const rows = await exec(
    `SELECT g.policy_name, g.kind, g.outcome, g.detail FROM agent_change_gates g
       JOIN agent_change_requests cr ON cr.id = g.change_request_id
      WHERE g.change_request_id = :id::uuid AND g.evaluation_seq = cr.evaluation_seq
      ORDER BY g.created_at`,
    [s('id', changeId)],
  );
  return rows.map((r) => ({
    policyName: toStr(r['policy_name']), kind: toStr(r['kind']),
    outcome: toStr(r['outcome']), detail: toStr(r['detail']),
  }));
}

/** One evaluation of a change: which set version judged it, and the gates it produced. */
export interface ChangeEvaluation {
  seq: number;
  policyScope: string | null;
  policyVersion: number | null;
  gates: ChangeGate[];
}

/** Every evaluation of a change, oldest first — a re-review no longer erases the one before (DE-46). */
export async function listEvaluations(changeId: string): Promise<ChangeEvaluation[]> {
  let rows: Array<{ seq: number; scope: string | null; version: number | null; gate: ChangeGate }>;
  if (config.mock.aurora) {
    rows = mockListGateHistory(changeId).map((g) => ({
      seq: g.evaluationSeq, scope: g.policyScope, version: g.policyVersion,
      gate: { policyName: g.policyName, kind: g.kind, outcome: g.outcome, detail: g.detail ?? '' },
    }));
  } else {
    if (!isUuid(changeId)) return [];
    const raw = await exec(
      `SELECT evaluation_seq, policy_scope, policy_version, policy_name, kind, outcome, detail
         FROM agent_change_gates WHERE change_request_id = :id::uuid
        ORDER BY evaluation_seq, created_at`,
      [s('id', changeId)],
    );
    rows = raw.map((r) => ({
      seq: toNum(r['evaluation_seq']) || 1,
      scope: r['policy_scope'] ? toStr(r['policy_scope']) : null,
      version: r['policy_version'] == null ? null : toNum(r['policy_version']),
      gate: { policyName: toStr(r['policy_name']), kind: toStr(r['kind']), outcome: toStr(r['outcome']), detail: toStr(r['detail']) },
    }));
  }
  const bySeq = new Map<number, ChangeEvaluation>();
  for (const r of rows) {
    const e = bySeq.get(r.seq) ?? { seq: r.seq, policyScope: r.scope, policyVersion: r.version, gates: [] };
    e.gates.push(r.gate);
    bySeq.set(r.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Append this evaluation's gates at the next sequence and move the change's
 * sequence to it (DE-46). It used to be a delete-then-insert, so a re-review
 * erased the evaluation before it and nobody could see under which rules a
 * change had first been judged.
 */
async function appendGates(changeId: string, gates: GateResult[], pin: { scope: string; version: number }): Promise<number> {
  if (config.mock.aurora) return mockAppendGates(changeId, gates, pin);
  const rows = await exec(
    `UPDATE agent_change_requests SET evaluation_seq = evaluation_seq + 1, updated_at = NOW()
      WHERE id = :id::uuid RETURNING evaluation_seq`,
    [s('id', changeId)],
  );
  const seq = toNum(rows[0]?.['evaluation_seq']) || 1;
  for (const g of gates) {
    await exec(
      `INSERT INTO agent_change_gates
          (change_request_id, policy_id, policy_name, kind, outcome, detail, policy_scope, policy_version, evaluation_seq)
       VALUES (:cid::uuid, :pid, :name, :kind, :outcome, :detail, :scope, :version, :seq)`,
      [s('cid', changeId), maybe('pid', g.policyId), s('name', g.policyName),
        s('kind', g.kind), s('outcome', g.outcome), maybe('detail', g.detail),
        s('scope', pin.scope), n('version', pin.version), n('seq', seq)],
    );
  }
  return seq;
}

/** Pin a change to the set version it is judged under (DE-46). */
async function setPolicyPin(changeId: string, scope: string, version: number): Promise<void> {
  if (config.mock.aurora) { mockSetPolicyPin(changeId, scope, version); return; }
  await exec(
    `UPDATE agent_change_requests SET policy_scope = :scope, policy_version = :v, updated_at = NOW() WHERE id = :id::uuid`,
    [s('id', changeId), s('scope', scope), n('v', version)],
  );
}

/**
 * Has `sub` caused a change governed by `scope`? For `org`, any change (the
 * org set is the floor every initiative set is checked against); for an
 * initiative, a change on one of its codebases. DE-43's self-gate: whoever the
 * rules have gated does not get to edit them.
 */
export async function hasChangesRequestedBy(sub: string, scope: string): Promise<boolean> {
  if (config.mock.aurora) return mockHasChangesRequestedBy(sub, scope);
  const rows = scope === ORG_SCOPE
    ? await exec(`SELECT 1 FROM agent_change_requests WHERE requested_by = :sub LIMIT 1`, [s('sub', sub)])
    : await exec(
      `SELECT 1 FROM agent_change_requests cr JOIN agent_projects ap ON ap.id = cr.project_id
        WHERE cr.requested_by = :sub AND ap.org_project_id = :scope LIMIT 1`,
      [s('sub', sub), s('scope', scope)],
    );
  return rows.length > 0;
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
 * The set version a change is judged under: its pin, or — first evaluation,
 * or an explicit `repin` — the latest set for its initiative (else `org`),
 * which is then pinned (DE-46). An edit governs new changes; a change keeps
 * the rules it was captured under unless someone re-pins it on purpose.
 */
async function pinnedPolicySet(change: ChangeRequest, repin: boolean): Promise<PolicySetVersion> {
  if (!repin && change.policyScope && change.policyVersion != null) {
    const pinned = await getPolicySetVersion(change.policyScope, change.policyVersion);
    if (pinned) return pinned;
    // A pin to a version that is gone cannot be honoured by guessing; fall
    // through and re-pin, which the result reports.
  }
  const scope = await resolvePolicyScope(change.orgProjectId);
  const set = scope === ORG_SCOPE ? await ensureOrgPolicySet() : await latestPolicySet(scope) ?? await ensureOrgPolicySet();
  await setPolicyPin(change.id, set.scope, set.version);
  return set;
}

/**
 * Run the gate engine over a change and record the result.
 *
 * This is the one function that moves a change into `approved`, `needs_approval`,
 * `changes_requested`, or `blocked` — always as the output of the pure engine,
 * never by fiat. It re-reads the latest review each time, so re-evaluating
 * after a review lands produces the right decision without special-casing.
 * The policies are the change's pinned set version (`repin: true` moves the
 * pin to the latest first); the gates are appended as a new evaluation.
 */
export async function evaluateChange(changeId: string, opts: { repin?: boolean } = {}): Promise<{
  evaluation: Evaluation; status: string; policyScope: string; policyVersion: number;
  evaluationSeq: number; repinned: boolean;
} | null> {
  const change = await getChangeRequest(changeId);
  if (!change) return null;

  const before = change.policyScope && change.policyVersion != null ? `${change.policyScope}@${change.policyVersion}` : null;
  const set = await pinnedPolicySet(change, opts.repin === true);
  const policies = set.policies;
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
  // fired". If no policy is ENABLED here — every rule was saved disabled, or
  // the set is empty — refuse to auto-approve and route to a human instead.
  // Counting rows let a set of disabled defaults approve every change. A
  // governance layer must fail closed, never open.
  if (!policies.some((policy) => policy.enabled) && evaluation.decision === 'approved') {
    evaluation.decision = 'needs_approval';
    evaluation.autoApproved = false;
    evaluation.gates.push({
      policyId: null,
      policyName: 'no policies configured',
      kind: 'require_review',
      outcome: 'requires_approval',
      detail: 'No governance policies are enabled; routed to a human to fail closed.',
    });
  }

  const evaluationSeq = await appendGates(changeId, evaluation.gates, { scope: set.scope, version: set.version });
  await setStatus(changeId, evaluation.decision);
  return {
    evaluation, status: evaluation.decision, policyScope: set.scope, policyVersion: set.version,
    evaluationSeq, repinned: before !== null && before !== `${set.scope}@${set.version}`,
  };
}

/** States a human may still decide on. */
const DECIDABLE = new Set(['needs_approval', 'changes_requested']);

/** Roles that may approve a change whose requester was never recorded (DE-43 default; SDLC_UNATTRIBUTED_APPROVER_ROLES). */
export function unattributedApproverRoles(): string[] {
  return listEnv('SDLC_UNATTRIBUTED_APPROVER_ROLES', ['org-leader', 'hr-admin', 'admin']);
}

/** Roles that may approve a change touching governance code (DE-43 §6; SDLC_GOVERNANCE_APPROVER_ROLES). */
export function governanceApproverRoles(): string[] {
  return listEnv('SDLC_GOVERNANCE_APPROVER_ROLES', ['org-leader', 'admin']);
}

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  return raw.split(',').map((r) => r.trim()).filter(Boolean);
}

export type DecideRefusal = 'self-approval' | 'unattributed' | 'governance-approver';

/**
 * A human's decision on a change awaiting one.
 *
 * A human can decide a `changes_requested` change too, not only a
 * `needs_approval` one: the reviewer is an advisor, and a person overruling it
 * — approving a change the bot wanted revised, or rejecting one it did not — is
 * the whole reason a human is in this loop. The decision and who made it are
 * recorded either way, so an override is auditable rather than invisible.
 *
 * Separation of duties (DE-43), checked here so every caller gets it:
 * - nobody decides a change they caused (`requested_by`), approve or reject,
 *   unless `override` (admin only, enforced and audited by the route);
 * - a change with no recorded requester is approved only by the roles in
 *   `unattributedApproverRoles()`, never an SME;
 * - a change touching governance code is approved only by the roles in
 *   `governanceApproverRoles()`.
 * A refusal carries its `gate`; the route answers 409.
 *
 * Deliberately narrow beyond that: it records the decision and stops. Delivery
 * is a separate, explicit step, because approving a change and shipping it are
 * two decisions and collapsing them removes the moment to stop.
 */
export async function decideChange(id: string, decision: 'approve' | 'reject', input: {
  by: string; role?: string | null; note?: string | null; override?: boolean;
}): Promise<{ ok: boolean; status?: string; error?: string; gate?: DecideRefusal }> {
  const change = await getChangeRequest(id);
  if (!change) return { ok: false, error: 'change not found' };
  if (!DECIDABLE.has(change.status)) {
    return { ok: false, error: `change is ${change.status}, not awaiting a decision` };
  }
  const role = input.role ?? '';
  if (change.requestedBy && change.requestedBy === input.by && !input.override) {
    return { ok: false, gate: 'self-approval', error: 'you caused this change, so someone else must decide it' };
  }
  if (decision === 'approve' && !change.requestedBy && !unattributedApproverRoles().includes(role)) {
    return {
      ok: false, gate: 'unattributed',
      error: `nobody is recorded as having caused this change, so only ${unattributedApproverRoles().join(', ')} may approve it`,
    };
  }
  if (decision === 'approve' && governancePathsTouched(change.files).length > 0 && !governanceApproverRoles().includes(role)) {
    return {
      ok: false, gate: 'governance-approver',
      error: `this change touches governance code (${governancePathsTouched(change.files).slice(0, 3).join(', ')}), so only ${governanceApproverRoles().join(', ')} may approve it`,
    };
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  // One call for both backends. The old offline arm mutated the object it had
  // just read — a copy, in the fixture world — so an offline approval reported
  // success and left the queue untouched; and it minted its own `new Date()`,
  // a fixture timestamp outside the fixture directory.
  await setStatus(id, status, { decision: { by: input.by, note: input.note ?? null } });
  return { ok: true, status };
}
