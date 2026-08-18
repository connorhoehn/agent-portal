// Agent work queue — the durable spine of the agentic loop.
//
// Jobs are claimed with FOR UPDATE SKIP LOCKED so two dispatchers (or two
// middleware instances) can never hand the same job to two devbox workers.
// Every state transition is a single statement; there is no read-modify-write
// window where a crash could strand a job in an ambiguous state.
//
//   queued → claimed → running → awaiting_review | done | failed
//                                      ↑ human accepts/rejects the artifact
//
// A job that dies mid-flight (middleware restart, runtime timeout) is
// recovered by reapStaleJobs(): claimed/running rows older than the stale
// window go back to queued if attempts remain, else fail with a clear reason.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

export type JobStatus =
  | 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

export interface AgentJob {
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  boxId: string | null;
  sessionId: string | null;
  attempts: number;
  maxAttempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function toStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}
function toJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return null; }
}

const COLUMNS = `id, kind, title, payload::text AS payload, status, priority,
  box_id, session_id, attempts, max_attempts, result::text AS result, error,
  created_by, created_at::text AS created_at, claimed_at::text AS claimed_at,
  started_at::text AS started_at, finished_at::text AS finished_at`;

function rowToJob(r: Record<string, unknown>): AgentJob {
  return {
    id: toStr(r['id']),
    kind: toStr(r['kind']),
    title: toStr(r['title']),
    payload: toJson(r['payload']) ?? {},
    status: toStr(r['status'], 'queued') as JobStatus,
    priority: Number(r['priority'] ?? 100),
    boxId: r['box_id'] ? toStr(r['box_id']) : null,
    sessionId: r['session_id'] ? toStr(r['session_id']) : null,
    attempts: Number(r['attempts'] ?? 0),
    maxAttempts: Number(r['max_attempts'] ?? 2),
    result: toJson(r['result']),
    error: r['error'] ? toStr(r['error']) : null,
    createdBy: r['created_by'] ? toStr(r['created_by']) : null,
    createdAt: toStr(r['created_at']),
    claimedAt: r['claimed_at'] ? toStr(r['claimed_at']) : null,
    startedAt: r['started_at'] ? toStr(r['started_at']) : null,
    finishedAt: r['finished_at'] ? toStr(r['finished_at']) : null,
  };
}

export async function enqueueJob(input: {
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  priority?: number;
  createdBy?: string;
  maxAttempts?: number;
}): Promise<AgentJob | null> {
  if (config.mock.aurora) return null;
  const rows = await exec(
    `INSERT INTO agent_jobs (kind, title, payload, priority, created_by, max_attempts)
     VALUES (:kind, :title, :payload::jsonb, :priority, :created_by, :max_attempts)
     RETURNING ${COLUMNS}`,
    [
      strParam('kind', input.kind),
      strParam('title', input.title),
      strParam('payload', JSON.stringify(input.payload ?? {})),
      intParam('priority', input.priority ?? 100),
      strParam('created_by', input.createdBy ?? 'portal'),
      intParam('max_attempts', input.maxAttempts ?? 2),
    ],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function listJobs(opts: { status?: string; limit?: number } = {}): Promise<AgentJob[]> {
  if (config.mock.aurora) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: SqlParameter[] = [intParam('lim', limit)];
  let where = '';
  if (opts.status) {
    where = 'WHERE status = :status';
    params.push(strParam('status', opts.status));
  }
  const rows = await exec(
    `SELECT ${COLUMNS} FROM agent_jobs ${where}
      ORDER BY CASE status
                 WHEN 'running' THEN 0 WHEN 'claimed' THEN 1
                 WHEN 'awaiting_review' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
               priority, created_at DESC
      LIMIT :lim`,
    params,
  );
  return rows.map(rowToJob);
}

export async function getJob(id: string): Promise<AgentJob | null> {
  if (config.mock.aurora) return null;
  const rows = await exec(`SELECT ${COLUMNS} FROM agent_jobs WHERE id = :id`, [strParam('id', id)]);
  return rows[0] ? rowToJob(rows[0]) : null;
}

/**
 * Atomically claim the next queued job for a box.
 *
 * SKIP LOCKED is what makes this safe under concurrency: a second dispatcher
 * running the same statement skips the row this one has locked instead of
 * blocking on it or — worse — reading it as available.
 */
export async function claimNextJob(boxId: string, sessionId: string): Promise<AgentJob | null> {
  if (config.mock.aurora) return null;
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
            SELECT id FROM agent_jobs
             WHERE status = 'queued'
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}`,
    [strParam('box', boxId), strParam('session', sessionId)],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function markRunning(id: string): Promise<void> {
  if (config.mock.aurora) return;
  await exec(
    `UPDATE agent_jobs SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=:id`,
    [strParam('id', id)],
  );
}

export async function completeJob(id: string, opts: {
  status: 'awaiting_review' | 'done' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  if (config.mock.aurora) return;
  await exec(
    `UPDATE agent_jobs
        SET status = :status,
            result = COALESCE(:result::jsonb, result),
            error = NULLIF(:error, ''),
            finished_at = NOW(), updated_at = NOW()
      WHERE id = :id`,
    [
      strParam('id', id),
      strParam('status', opts.status),
      strParam('result', opts.result ? JSON.stringify(opts.result) : ''),
      strParam('error', opts.error ?? ''),
    ],
  );
}

/** Human accepted or rejected the artifact an awaiting_review job produced. */
export async function reviewJob(id: string, decision: 'accept' | 'reject', note?: string): Promise<AgentJob | null> {
  if (config.mock.aurora) return null;
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = :status,
            result = jsonb_set(COALESCE(result, '{}'::jsonb), '{reviewNote}', to_jsonb(:note::text), true),
            updated_at = NOW()
      WHERE id = :id AND status = 'awaiting_review'
      RETURNING ${COLUMNS}`,
    [
      strParam('id', id),
      strParam('status', decision === 'accept' ? 'done' : 'failed'),
      strParam('note', note ?? ''),
    ],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function cancelJob(id: string): Promise<boolean> {
  if (config.mock.aurora) return false;
  const rows = await exec(
    `UPDATE agent_jobs SET status='cancelled', finished_at=NOW(), updated_at=NOW()
      WHERE id=:id AND status IN ('queued','claimed') RETURNING id`,
    [strParam('id', id)],
  );
  return rows.length > 0;
}

/**
 * Recover jobs whose worker vanished (middleware restart, runtime timeout).
 * Requeues while attempts remain so transient failures self-heal, and fails
 * loudly rather than silently retrying forever.
 */
export async function reapStaleJobs(staleMinutes = 30): Promise<{ requeued: number; failed: number }> {
  if (config.mock.aurora) return { requeued: 0, failed: 0 };
  const requeued = await exec(
    `UPDATE agent_jobs
        SET status='queued', box_id=NULL, session_id=NULL, claimed_at=NULL, updated_at=NOW()
      WHERE status IN ('claimed','running')
        AND updated_at < NOW() - (INTERVAL '1 minute' * :mins)
        AND attempts < max_attempts
      RETURNING id`,
    [intParam('mins', staleMinutes)],
  );
  const failed = await exec(
    `UPDATE agent_jobs
        SET status='failed', error='worker did not report back before the stale window elapsed',
            finished_at=NOW(), updated_at=NOW()
      WHERE status IN ('claimed','running')
        AND updated_at < NOW() - (INTERVAL '1 minute' * :mins)
        AND attempts >= max_attempts
      RETURNING id`,
    [intParam('mins', staleMinutes)],
  );
  return { requeued: requeued.length, failed: failed.length };
}

export async function queueStats(): Promise<Record<JobStatus | 'total', number>> {
  const base = {
    queued: 0, claimed: 0, running: 0, awaiting_review: 0,
    done: 0, failed: 0, cancelled: 0, total: 0,
  } as Record<JobStatus | 'total', number>;
  if (config.mock.aurora) return base;
  const rows = await exec(`SELECT status, count(*)::int AS n FROM agent_jobs GROUP BY status`);
  for (const r of rows) {
    const s = toStr(r['status']) as JobStatus;
    const n = Number(r['n'] ?? 0);
    if (s in base) base[s] = n;
    base.total += n;
  }
  return base;
}
