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
  title: string;
  status: string;
  diff: string | null;
  diffTruncated: boolean;
  files: string[];
  filesChanged: number;
  model: string | null;
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
    title: toStr(r['title']),
    status: toStr(r['status'], 'captured'),
    diff: r['diff'] ? toStr(r['diff']) : null,
    diffTruncated: toBool(r['diff_truncated']),
    files: parseJson<string[]>(r['files'], []),
    filesChanged: toNum(r['files_changed']),
    model: r['model'] ? toStr(r['model']) : null,
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
  const rows = await exec(
    `INSERT INTO agent_change_requests
        (project_id, run_id, title, diff, diff_truncated, files, files_changed, model, status)
     VALUES (:pid::uuid, :rid, :title, :diff, :trunc, :files::jsonb, :nfiles, :model, 'captured')
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

export async function getChangeRequest(id: string): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const rows = await exec(
    `SELECT cr.*, ap.repo_full_name
       FROM agent_change_requests cr
       JOIN agent_projects ap ON ap.id = cr.project_id
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
  if (config.mock.aurora) return [];
  const where: string[] = [];
  const params: SqlParameter[] = [];
  if (opts.projectId && isUuid(opts.projectId)) { where.push('cr.project_id = :pid::uuid'); params.push(s('pid', opts.projectId)); }
  if (opts.open) where.push(`cr.status IN ('needs_approval','changes_requested','in_review','captured')`);
  const rows = await exec(
    `SELECT cr.*, ap.repo_full_name
       FROM agent_change_requests cr
       JOIN agent_projects ap ON ap.id = cr.project_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY cr.created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(rowToChange);
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

  const policies = await listPolicies();
  const latestReview = change.reviews[0] ?? null;
  const facts: ChangeFacts = {
    files: change.files,
    model: change.model,
    reviewVerdict: latestReview?.verdict ?? null,
  };
  const evaluation = evaluate(policies, facts);

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

/**
 * A human's decision on a change that needs approval.
 *
 * Deliberately narrow: it moves a change out of `needs_approval` and records
 * who and why, and does nothing else — delivery is a separate, explicit step,
 * because approving a change and shipping it are two decisions and collapsing
 * them removes the moment to stop.
 */
export async function decideChange(id: string, decision: 'approve' | 'reject', input: {
  by?: string | null; note?: string | null;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  const change = await getChangeRequest(id);
  if (!change) return { ok: false, error: 'change not found' };
  if (change.status !== 'needs_approval') {
    return { ok: false, error: `change is ${change.status}, not awaiting approval` };
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await setStatus(id, status,
    [maybe('by', input.by ?? null), maybe('note', input.note ?? null)],
    'decided_by = :by, decided_at = NOW(), decision_note = :note');
  return { ok: true, status };
}
