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
  /** The standing mission that enqueued this job, when one did. */
  botId: string | null;
  /** Resolved on reads that join bots; null on INSERT ... RETURNING. */
  botName: string | null;
  botTrigger: string | null;
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
  started_at::text AS started_at, finished_at::text AS finished_at,
  bot_id::text AS bot_id`;

// Reads that want to name the enqueueing bot. Kept separate from COLUMNS
// because INSERT ... RETURNING cannot join, and a queue row whose origin is a
// standing mission reads very differently from one a person queued by hand:
// scheduled maintenance is a cost of ownership, not a decision someone made
// this morning.
const COLUMNS_WITH_BOT = `j.id, j.kind, j.title, j.payload::text AS payload, j.status, j.priority,
  j.box_id, j.session_id, j.attempts, j.max_attempts, j.result::text AS result, j.error,
  j.created_by, j.created_at::text AS created_at, j.claimed_at::text AS claimed_at,
  j.started_at::text AS started_at, j.finished_at::text AS finished_at,
  j.bot_id::text AS bot_id, b.name AS bot_name, b.trigger AS bot_trigger`;

const JOBS_WITH_BOT = 'agent_jobs j LEFT JOIN bots b ON b.id = j.bot_id';

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
    botId: r['bot_id'] ? toStr(r['bot_id']) : null,
    botName: r['bot_name'] ? toStr(r['bot_name']) : null,
    botTrigger: r['bot_trigger'] ? toStr(r['bot_trigger']) : null,
  };
}

// ─── Mock queue ──────────────────────────────────────────────────────────────
//
// Without Aurora every queue call used to answer "no": enqueue returned null,
// which the route reports as 503 "queue unavailable", and the list came back
// empty. So in `dev:mock` the Work page could offer you a suggestion, fill the
// composer with a runnable prompt, and then refuse the one action the page
// exists for — with an error that reads like an outage. The interesting half
// of the journey (suggestion → job → what it serves) was untestable by hand.
//
// This is a queue, not a fake: the same states, the same ordering, the same
// claim-once guarantee (single-process, so a plain splice is the whole of the
// concurrency story). Nothing dispatches it unless a devbox worker registers,
// which in mock mode leaves rows sitting visibly `queued` — the honest answer,
// and the one the page renders.
const MOCK_JOBS: AgentJob[] = [];
let mockSeq = 0;

const MOCK_STATUS_RANK: Record<string, number> = {
  running: 0, claimed: 1, awaiting_review: 2, queued: 3,
};

function mockOrder(a: AgentJob, b: AgentJob): number {
  const s = (MOCK_STATUS_RANK[a.status] ?? 4) - (MOCK_STATUS_RANK[b.status] ?? 4);
  if (s !== 0) return s;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.createdAt.localeCompare(a.createdAt);
}

export async function enqueueJob(input: {
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  priority?: number;
  createdBy?: string;
  maxAttempts?: number;
  /** Set when a standing mission enqueued this, so the queue can attribute it
   * to the bot rather than showing an anonymous scheduled task. */
  botId?: string;
}): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job: AgentJob = {
      id: `job-mock-${++mockSeq}`,
      kind: input.kind,
      title: input.title,
      payload: input.payload ?? {},
      status: 'queued',
      priority: input.priority ?? 100,
      boxId: null,
      sessionId: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      result: null,
      error: null,
      createdBy: input.createdBy ?? 'portal',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      botId: input.botId ?? null,
      botName: null,
      botTrigger: null,
    };
    MOCK_JOBS.push(job);
    return job;
  }
  const rows = await exec(
    `INSERT INTO agent_jobs (kind, title, payload, priority, created_by, max_attempts, bot_id)
     VALUES (:kind, :title, :payload::jsonb, :priority, :created_by, :max_attempts, :bot_id::uuid)
     RETURNING ${COLUMNS}`,
    [
      strParam('kind', input.kind),
      strParam('title', input.title),
      strParam('payload', JSON.stringify(input.payload ?? {})),
      intParam('priority', input.priority ?? 100),
      strParam('created_by', input.createdBy ?? 'portal'),
      intParam('max_attempts', input.maxAttempts ?? 2),
      input.botId
        ? strParam('bot_id', input.botId)
        : { name: 'bot_id', value: { isNull: true } },
    ],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function listJobs(opts: { status?: string; limit?: number } = {}): Promise<AgentJob[]> {
  if (config.mock.aurora) {
    return MOCK_JOBS
      .filter((j) => !opts.status || j.status === opts.status)
      .sort(mockOrder)
      .slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200))
      .map((j) => ({ ...j }));
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: SqlParameter[] = [intParam('lim', limit)];
  let where = '';
  if (opts.status) {
    where = 'WHERE j.status = :status';
    params.push(strParam('status', opts.status));
  }
  const rows = await exec(
    `SELECT ${COLUMNS_WITH_BOT} FROM ${JOBS_WITH_BOT} ${where}
      ORDER BY CASE j.status
                 WHEN 'running' THEN 0 WHEN 'claimed' THEN 1
                 WHEN 'awaiting_review' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
               j.priority, j.created_at DESC
      LIMIT :lim`,
    params,
  );
  return rows.map(rowToJob);
}

export async function getJob(id: string): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    return job ? { ...job } : null;
  }
  const rows = await exec(
    `SELECT ${COLUMNS_WITH_BOT} FROM ${JOBS_WITH_BOT} WHERE j.id = :id`,
    [strParam('id', id)],
  );
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
  if (config.mock.aurora) {
    const next = MOCK_JOBS
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = boxId;
    next.sessionId = sessionId;
    next.claimedAt = new Date().toISOString();
    next.attempts += 1;
    return { ...next };
  }
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
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    if (job) { job.status = 'running'; job.startedAt = new Date().toISOString(); }
    return;
  }
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
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    if (job) {
      job.status = opts.status;
      if (opts.result) job.result = opts.result;
      job.error = opts.error ?? null;
      job.finishedAt = new Date().toISOString();
    }
    return;
  }
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
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id && j.status === 'awaiting_review');
    if (!job) return null;
    job.status = decision === 'accept' ? 'done' : 'failed';
    job.result = { ...(job.result ?? {}), reviewNote: note ?? '' };
    return { ...job };
  }
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
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id && (j.status === 'queued' || j.status === 'claimed'));
    if (!job) return false;
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    return true;
  }
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
  if (config.mock.aurora) {
    for (const j of MOCK_JOBS) { base[j.status] += 1; base.total += 1; }
    return base;
  }
  const rows = await exec(`SELECT status, count(*)::int AS n FROM agent_jobs GROUP BY status`);
  for (const r of rows) {
    const s = toStr(r['status']) as JobStatus;
    const n = Number(r['n'] ?? 0);
    if (s in base) base[s] = n;
    base.total += n;
  }
  return base;
}
