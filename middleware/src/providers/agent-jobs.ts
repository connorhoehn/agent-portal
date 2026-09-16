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

import { randomUUID } from 'node:crypto';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { hasColumns, _resetColumnProbes } from './column-probe.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
// Every timestamp the mock queue writes comes from here, never `new Date()`:
// the mock branches below are fixture writes living outside src/mock, and a
// stamp minted off the wall clock cannot be frozen by freezeClock (so no test
// can pin what a transition wrote) and lands in yesterday when the process
// runs a minute after UTC midnight.
import { clock } from '../mock/core/index.js';
// Mock-mode only: the roster + run history a bot's "job →" links point at
// (see seedMockJobsFromBotRuns below). bots.ts never imports this module, so
// this is a one-way dependency, not a cycle.
import { MOCK_BOTS, MOCK_BOT_RUNS, type BotRun } from './bots.js';
// The kinds only a paired workstation may run. Imported here rather than
// duplicated because `claimNextJob` (push side) must EXCLUDE exactly the set
// `claimNextJobForWorker` (pull side) selects — two copies that drifted apart
// would leave a kind claimable by both executors or by neither. `local-work.ts`
// imports nothing from this module, so this is one-way.
import { LOCAL_JOB_KINDS } from '../lib/local-work.js';

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

export interface ToolCallSummary { name: string; done: boolean }

/**
 * Plausible, deterministic tool-name cycles for the mock-only fallback below
 * — keyed by job kind because a devbox task and a local repo task don't do
 * the same shape of work. Order is narrative (look, change, verify, land),
 * not random, so two reads of the same row agree.
 */
const MOCK_TOOL_CYCLE: Record<string, readonly string[]> = {
  'devbox:task': ['read_file', 'edit_file', 'run_tests', 'git_commit'],
  'local:task': ['read_file', 'edit_file', 'run_tests', 'git_commit'],
  'local:distill': ['read_file', 'grep', 'write_file'],
  'local:consolidate': ['read_file', 'grep', 'edit_file'],
};
const DEFAULT_MOCK_TOOL_CYCLE: readonly string[] = ['read_file', 'edit_file', 'run_tests'];

/**
 * Per-job tool call list for `<ToolCallStrip>` — real signal first, mock
 * fallback second, never a fabrication of a real run.
 *
 * A job that actually ran (mock AgentCore or live) records its own tool calls
 * in `result.transcript` (`lib/devbox-runner.ts`), so a transcript that
 * exists is read verbatim rather than guessed at — every call is already
 * terminal by the time a job is readable here, so `done` is always true.
 *
 * Only when no transcript is present — the mock-dispatched run's outcome is
 * `transcript: []` (`routes/devbox.ts::runDevboxTask`'s mock branch never
 * populates it) — does this fall back to a deterministic list sized to the
 * job's own `toolCalls` count and keyed by kind. That fallback is gated to
 * mock mode on purpose: a real Aurora row with a `toolCalls` count but no
 * transcript genuinely doesn't know the tool names, and inventing them for a
 * live run would misrepresent what happened. Undefined there, honestly.
 */
export function deriveToolCallList(job: AgentJob): ToolCallSummary[] | undefined {
  const result = job.result;
  if (!result) return undefined;

  const transcript = result['transcript'];
  if (Array.isArray(transcript)) {
    const calls = transcript
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && (e as Record<string, unknown>)['t'] === 'tool')
      .map((e) => ({ name: typeof e['name'] === 'string' ? e['name'] : 'tool', done: true }));
    if (calls.length > 0) return calls;
  }

  if (!config.mock.aurora) return undefined;
  const count = typeof result['toolCalls'] === 'number' ? result['toolCalls'] : null;
  if (count == null || count <= 0) return undefined;
  const cycle = MOCK_TOOL_CYCLE[job.kind] ?? DEFAULT_MOCK_TOOL_CYCLE;
  return Array.from({ length: Math.min(count, 20) }, (_, i) => ({ name: cycle[i % cycle.length]!, done: true }));
}

/**
 * Wire shape for one job: `result.toolCallList` attached on top of whatever
 * is stored, never persisted — a read-time projection so the derivation can
 * change without a migration. No-ops a job with no result.
 */
export function withToolCallList(job: AgentJob): AgentJob {
  if (!job.result) return job;
  const toolCallList = deriveToolCallList(job);
  if (!toolCallList) return job;
  return { ...job, result: { ...job.result, toolCallList } };
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

/**
 * A queue id in the shape the table itself mints.
 *
 * `agent_jobs.id` defaults to `'job-' || gen_random_uuid()`
 * (schema/agentic_work_schema.sql), and only the seed writes ids by hand
 * (`job-<slug>-maint-N`, one per cron firing it fabricates history for). The
 * mock used to mint `job-mock-1`, `job-mock-2` … — a third dialect that
 * belongs to neither, so a "job →" link from a run recorded offline opened an
 * id Aurora could never hold, and the same click worked in dev:mock and 404'd
 * on the cluster. That is the same defect seedMockJobsFromBotRuns() below was
 * written to fix for the *seeded* runs; this closes it for newly enqueued
 * ones. A slug-and-counter id would be wrong here for a second reason: a
 * hand-driven dispatch is not maintenance, and borrowing `-maint-N` would
 * collide with the range the seed reserves for a bot that really does fire on
 * a schedule.
 */
function mockJobId(): string { return `job-${randomUUID()}`; }

const MOCK_STATUS_RANK: Record<string, number> = {
  running: 0, claimed: 1, awaiting_review: 2, queued: 3,
};

function mockOrder(a: AgentJob, b: AgentJob): number {
  const s = (MOCK_STATUS_RANK[a.status] ?? 4) - (MOCK_STATUS_RANK[b.status] ?? 4);
  if (s !== 0) return s;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.createdAt.localeCompare(a.createdAt);
}

/** BotRun.status → AgentJob.status. Every run bots.ts seeds today is 'done',
 *  but the mapping is written generically (not a single hard-coded 'done')
 *  so a future 'failed'/'running' fixture lands on the right job state
 *  without anyone having to remember to update this file too. 'skipped'
 *  never reaches here in practice (a skipped firing never dispatches, so
 *  genRun() never gives it a jobId) but maps to 'cancelled' rather than
 *  silently defaulting to 'done'. */
function jobStatusForRunStatus(status: BotRun['status']): JobStatus {
  switch (status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'skipped': return 'cancelled';
  }
}

/**
 * Mint a matching mock `agent_jobs` row for every seeded bot run that carries
 * a jobId, so the "job →" link on a bot's run history (BotDetailPage.tsx)
 * always resolves at GET /api/work/jobs/:id instead of 404ing — defect #11:
 * bots.ts's mock run generator (genRun) mints jobIds like `job-obs-maint-1`
 * that no job provider knew about, so every run-history "job →" link led to
 * a page stuck on "Loading job …" forever.
 *
 * Reads MOCK_BOTS/MOCK_BOT_RUNS directly (the SAME fixtures the bots
 * provider and BotDetailPage's run list use) rather than a second, hand-typed
 * list of ids — the two cannot drift apart, and a job's title/model/prompt
 * provenance genuinely comes from the bot that "ran" it, matching how a real
 * dispatch enqueues (lib/bot-runner.ts fireBot: kind 'devbox:task', title is
 * the bot's name, payload carries prompt/model/botId, bot_id column set).
 */
function seedMockJobsFromBotRuns(): void {
  for (const bot of MOCK_BOTS) {
    for (const run of MOCK_BOT_RUNS[bot.id] ?? []) {
      if (!run.jobId || MOCK_JOBS.some((j) => j.id === run.jobId)) continue;
      const status = jobStatusForRunStatus(run.status);
      const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
      const durationMs = run.finishedAt
        ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
        : null;
      const reason = typeof run.outcome['reason'] === 'string' ? run.outcome['reason'] as string : 'scheduled maintenance';
      MOCK_JOBS.push({
        id: run.jobId,
        kind: 'devbox:task',
        title: bot.name,
        payload: { prompt: bot.prompt, requiresReview: bot.requiresReview, botId: bot.id, model: bot.model },
        status,
        priority: 100,
        boxId: null,
        sessionId: null,
        attempts: terminal ? 1 : 0,
        // The seed writes max_attempts 1 on every scheduled job. Typing 2 here
        // made a one-shot job read as retryable offline, so the reaper's
        // "attempts 1/1 — exhausted" state was unreachable in dev:mock. New
        // jobs created at run time still default to 2 (`enqueue` below); this
        // is the seeded history, and it says 1.
        maxAttempts: 1,
        result: status === 'done'
          ? { summary: `${reason} — completed.`, costUsd: run.costUsd ?? undefined, durationMs: durationMs ?? undefined }
          : null,
        error: status === 'failed' ? reason : null,
        // Provenance, not a placeholder. A cron firing was minted by the
        // scheduler and nobody authorized it from inside an envelope — which
        // is why bot_runs.dispatched_by is null for one. `?? 'portal'` read
        // that null as "a person did this from the portal", so all nine
        // job-obs-maint-* rows claimed a human origin the seed spells
        // 'scheduler'; /iq/work then attributed scheduled maintenance to
        // someone's morning. Fall back per trigger, and only a genuinely
        // hand-driven run with no attribution column reads as 'portal'.
        createdBy: run.dispatchedBy ?? (run.trigger === 'cron' || run.trigger === 'pr_watch' ? 'scheduler' : 'portal'),
        createdAt: run.startedAt,
        claimedAt: run.startedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        botId: bot.id,
        botName: bot.name,
        botTrigger: run.trigger,
      });
    }
  }
}

if (config.mock.aurora) seedMockJobsFromBotRuns();

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
      id: mockJobId(),
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
      createdAt: clock.nowIso(),
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

/**
 * Clone a dead-lettered job back onto the queue. Only terminal failures
 * qualify — requeueing a job that is still moving would double-run it. The
 * clone keeps the original kind/title/payload (the server holds the full
 * payload; the portal never re-supplies a prompt it may not even see) and
 * records where it came from in created_by.
 */
export async function requeueJob(id: string, requeuedBy?: string): Promise<AgentJob | null> {
  const dead = await getJob(id);
  if (!dead) return null;
  if (dead.status !== 'failed' && dead.status !== 'cancelled') return null;
  return enqueueJob({
    kind: dead.kind,
    title: dead.title,
    payload: dead.payload,
    priority: dead.priority,
    createdBy: requeuedBy ? `${requeuedBy} (requeue of ${dead.id})` : `requeue of ${dead.id}`,
    ...(dead.botId ? { botId: dead.botId } : {}),
  });
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

/**
 * Every job that has run, is running, or is queued FOR a given set of boxes.
 *
 * The local-compute page's run list. Scoped by box rather than by creator on
 * purpose: the question that surface answers is "what has my machine been
 * doing", and a bot or a teammate can legitimately have queued the work — the
 * machine is still the thing whose history is being read. The caller resolves
 * which boxes it may ask about (its own machines), which is where the
 * authorization lives; this function does not know about owners.
 *
 * A queued job has no `box_id` yet, so a targeted one is matched by
 * `payload.nodeId` instead — otherwise work you just handed to a machine would
 * be invisible until the moment it was claimed, which is exactly the window a
 * person is watching.
 */
export async function listJobsForBoxes(
  boxIds: readonly string[],
  opts: { nodeIds?: readonly string[]; limit?: number } = {},
): Promise<AgentJob[]> {
  if (boxIds.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const nodeIds = opts.nodeIds ?? [];
  const boxSet = new Set(boxIds);
  const nodeSet = new Set(nodeIds);

  if (config.mock.aurora) {
    return MOCK_JOBS
      .filter((j) => (j.boxId && boxSet.has(j.boxId))
        || (typeof j.payload['nodeId'] === 'string' && nodeSet.has(j.payload['nodeId'] as string)))
      .sort(mockOrder)
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  // No array parameter in the RDS Data API, so both lists expand into named
  // placeholders. Bounded by how many machines one person has paired.
  const boxParams = boxIds.map((b, i) => strParam(`b${i}`, b));
  const boxList = boxIds.map((_, i) => `:b${i}`).join(', ');
  const nodeParams = nodeIds.map((n, i) => strParam(`n${i}`, n));
  const nodeClause = nodeIds.length
    ? ` OR j.payload->>'nodeId' IN (${nodeIds.map((_, i) => `:n${i}`).join(', ')})`
    : '';

  const rows = await exec(
    `SELECT ${COLUMNS_WITH_BOT} FROM ${JOBS_WITH_BOT}
      WHERE j.box_id IN (${boxList})${nodeClause}
      ORDER BY CASE j.status
                 WHEN 'running' THEN 0 WHEN 'claimed' THEN 1
                 WHEN 'awaiting_review' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
               j.priority, j.created_at DESC
      LIMIT :lim`,
    [intParam('lim', limit), ...boxParams, ...nodeParams],
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
 *
 * ⚠️ The kind exclusion is the other half of the local-compute namespace, and
 * without it that namespace is decorative. This statement carried NO predicate
 * on kind — right while the middleware was the only executor, since it can run
 * anything it is handed — so the first idle microVM to tick claimed the oldest
 * queued row whatever it was, including a `local:*` job somebody queued
 * specifically to run on their own machine. It would not even fail loudly:
 * `local:task` carries `payload.prompt`, so `runDevboxTask` would invoke
 * AgentCore and bill the run, and the work would simply have happened in the
 * cloud. The whole premise — "choosing local is an explicit act by whoever
 * queued it, not a race between two executors polling the same rows"
 * (lib/local-work.ts) — depends on this line.
 *
 * Excluded here rather than in `job-dispatcher.ts` so every push-side caller is
 * covered by construction, present and future. `kind` is an existing column, so
 * this is not gated on a migration probe.
 */
export async function claimNextJob(boxId: string, sessionId: string): Promise<AgentJob | null> {
  const pullOnly = LOCAL_JOB_KINDS as readonly string[];
  if (config.mock.aurora) {
    const next = MOCK_JOBS
      .filter((j) => j.status === 'queued' && !pullOnly.includes(j.kind))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = boxId;
    next.sessionId = sessionId;
    next.claimedAt = clock.nowIso();
    next.attempts += 1;
    return { ...next };
  }
  // No array parameter in the RDS Data API, so the exclusion list is expanded
  // into named placeholders — the same shape claimNextJobForWorker's allowlist
  // uses. Bounded by LOCAL_JOB_KINDS, which is a module constant.
  const kindParams = pullOnly.map((k, i) => strParam(`x${i}`, k));
  const kindList = pullOnly.map((_, i) => `:x${i}`).join(', ');
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
            SELECT id FROM agent_jobs
             WHERE status = 'queued' AND kind NOT IN (${kindList})
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}`,
    [strParam('box', boxId), strParam('session', sessionId), ...kindParams],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

/**
 * Claim ONE named job for a box — claimNextJob addressed by id instead of by
 * queue position.
 *
 * The dispatcher wants the head of the queue and must never be handed a row
 * another dispatcher already took, which is what SKIP LOCKED buys it. A caller
 * that enqueued a job and wants to drive *that* job through its states has the
 * opposite requirement: it knows which row it means, and taking whatever is
 * oldest would silently start someone else's work. Guarded on `status =
 * 'queued'` for the same reason claimNextJob is: a job already claimed must
 * not be claimed twice.
 */
export async function claimJob(id: string, boxId: string, sessionId: string): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id && j.status === 'queued');
    if (!job) return null;
    job.status = 'claimed';
    job.boxId = boxId;
    job.sessionId = sessionId;
    job.claimedAt = clock.nowIso();
    job.attempts += 1;
    return { ...job };
  }
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = :id AND status = 'queued'
      RETURNING ${COLUMNS}`,
    [strParam('id', id), strParam('box', boxId), strParam('session', sessionId)],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

// ─── Pull-side claims (local compute) ────────────────────────────────────────
//
// Everything above assumes the middleware is the executor: it claims a job,
// invokes AgentCore, watches the stream, and writes the outcome. It cannot race
// itself, which is why `completeJob` below needs no ownership guard and why
// `reapStaleJobs(0)` at boot is safe — see recoverOrphanedWork's own comment,
// "in a single-process middleware any job still marked live at boot is orphaned
// by definition."
//
// A paired workstation breaks that assumption. It has no inbound path (a stated
// non-goal, not an omission), so it CLAIMS work, runs it out of sight, and
// reports back. Now a claim can outlive the process that granted it, and a job
// still marked live at boot may have a laptop happily working on it.
//
// Three things follow, and they are the whole of this section:
//
//   * a claim is FENCED — `claim_token`, minted here, returned once, required on
//     every subsequent write, cleared on requeue;
//   * a claim is FILTERED — a local node may only take kinds it advertised and
//     the server allows, or it takes whatever is at the head of the queue,
//     including interactive cloud-only work it cannot perform;
//   * a claim is COUNTED — a node holds at most what it said it can hold.
//
// Schema: schema/local_compute_worker_schema.sql.

/** Minted per claim. Long enough that guessing it is not an attack path. */
function mintClaimToken(): string {
  return `clm_${randomUUID().replace(/-/g, '')}`;
}

export interface PullClaim {
  job: AgentJob;
  /**
   * The fencing token, returned to the claimant exactly once. Never re-read
   * from a later `getJob` — the point is that only the holder has it.
   */
  claimToken: string;
}

/**
 * Whether this cluster has the pull-side columns applied.
 *
 * Probed once and cached, because the honest failure for a cluster running
 * ahead of `schema/local_compute_worker_schema.sql` is a clear 503 to the
 * worker, not an accepted-but-unfenced claim. Degrading to "claim it anyway
 * without a token" would silently reintroduce the overwrite this section exists
 * to prevent, and it would do so on exactly the clusters least likely to notice.
 */
export async function hasPullSideColumns(): Promise<boolean> {
  return hasColumns('agent_jobs', ['claim_token', 'heartbeat_at']);
}

/** Test hook — forget the cached probe. */
export function _resetPullSideProbe(): void { _resetColumnProbes(); }

/**
 * Atomically claim the next queued job a pull-side worker is allowed to run.
 *
 * Differs from `claimNextJob` in three ways, each load-bearing:
 *
 *   1. **Filtered by kind.** `claimNextJob` selects the head of the queue with
 *      no predicate. That is right for the dispatcher, which can run anything
 *      it is handed, and wrong for a laptop: `docs/local-compute-presence.md`
 *      describes local work as nightly distillation and consolidation, and a
 *      node taking an interactive `devbox:task` would strand a person waiting
 *      on a stream that never arrives. An empty `kinds` claims nothing rather
 *      than everything — a worker that advertised no capability has none.
 *
 *   2. **Fenced.** Mints and stores `claim_token`.
 *
 *   3. **Heartbeat-stamped at claim time**, so the reaper's window starts from
 *      the claim rather than from whenever the worker first checks in.
 *
 * Still `FOR UPDATE SKIP LOCKED`: two workstations running this concurrently
 * skip each other's locked rows rather than reading them as available.
 *
 * **Targeting.** `payload.nodeId`, when a job carries one, names the ONLY machine
 * that may claim it, and `nodeId` here is the asking machine. The local pull
 * queue is otherwise global: every paired workstation registered for a kind
 * competes for the same rows, so "run this on my laptop" was not a thing anyone
 * could ask for — a second machine (or another person's) would win the race
 * about as often. That is not only surprising, it puts the prompt text of a run
 * you scoped to your own hardware on somebody else's disk. A job with no
 * `nodeId` stays claimable by any eligible machine, which is the behaviour every
 * existing caller already relies on; the portal always targets.
 */
export async function claimNextJobForWorker(opts: {
  boxId: string;
  sessionId: string;
  kinds: readonly string[];
  /** The claiming machine's node id — matched against `payload.nodeId`. */
  nodeId?: string;
}): Promise<PullClaim | null> {
  if (opts.kinds.length === 0) return null;
  const claimToken = mintClaimToken();

  /** A job is claimable by this machine if it names no machine, or names this one. */
  const targetOk = (payload: Record<string, unknown>): boolean => {
    const want = payload['nodeId'];
    if (typeof want !== 'string' || !want) return true;
    return want === opts.nodeId;
  };

  if (config.mock.aurora) {
    const next = MOCK_JOBS
      .filter((j) => j.status === 'queued' && opts.kinds.includes(j.kind) && targetOk(j.payload))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = opts.boxId;
    next.sessionId = opts.sessionId;
    next.claimedAt = clock.nowIso();
    next.attempts += 1;
    MOCK_CLAIM_TOKENS.set(next.id, claimToken);
    return { job: { ...next }, claimToken };
  }

  // The RDS Data API has no array parameter, so the allowlist is expanded into
  // named placeholders. Bounded by the caller (the route intersects the node's
  // advertised kinds with the server's own set), so this cannot grow unbounded.
  const kindParams = opts.kinds.map((k, i) => strParam(`k${i}`, k));
  const kindList = opts.kinds.map((_, i) => `:k${i}`).join(', ');

  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claim_token = :token, claimed_at = NOW(), heartbeat_at = NOW(),
            attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
            SELECT id FROM agent_jobs
             WHERE status = 'queued' AND kind IN (${kindList})
               AND (payload->>'nodeId' IS NULL OR payload->>'nodeId' = :node)
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}`,
    [strParam('box', opts.boxId), strParam('session', opts.sessionId),
      strParam('token', claimToken), strParam('node', opts.nodeId ?? ''), ...kindParams],
  );
  return rows[0] ? { job: rowToJob(rows[0]), claimToken } : null;
}

/**
 * How many jobs a box is currently holding.
 *
 * The concurrency cap has to be enforced against the DATABASE, not against
 * whatever the worker believes it is running. A worker that crashed and
 * restarted has forgotten its claims; the rows have not.
 */
export async function countLiveJobsForBox(boxId: string): Promise<number> {
  if (config.mock.aurora) {
    return MOCK_JOBS.filter((j) => j.boxId === boxId && (j.status === 'claimed' || j.status === 'running')).length;
  }
  const rows = await exec(
    `SELECT count(*)::int AS n FROM agent_jobs
      WHERE box_id = :box AND status IN ('claimed','running')`,
    [strParam('box', boxId)],
  );
  return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Liveness ping from a pull-side worker, guarded by its fencing token.
 *
 * Returns false when the claim is gone — requeued by the reaper, cancelled, or
 * never held — which is the signal for the worker to abandon the run rather than
 * finish it and post a result that would overwrite a newer attempt. Told, not
 * silently ignored: a worker that learns its claim expired can stop burning its
 * own slots on work somebody else is now doing.
 *
 * Bumps `heartbeat_at` and NOT `updated_at`: `updated_at` means "the job
 * changed", and a heartbeat is precisely the case where it did not. Conflating
 * them would make "still running" and "transitioned" indistinguishable in the
 * queue's own audit trail.
 */
export async function heartbeatJob(id: string, claimToken: string): Promise<boolean> {
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    if (!job || MOCK_CLAIM_TOKENS.get(id) !== claimToken) return false;
    return job.status === 'claimed' || job.status === 'running';
  }
  const rows = await exec(
    `UPDATE agent_jobs SET heartbeat_at = NOW()
      WHERE id = :id AND claim_token = :token AND status IN ('claimed','running')
      RETURNING id`,
    [strParam('id', id), strParam('token', claimToken)],
  );
  return rows.length > 0;
}

/** Mock-mode fencing tokens. Not persisted — the mock queue is in-process. */
const MOCK_CLAIM_TOKENS = new Map<string, string>();

/**
 * Move a claimed job to `running`.
 *
 * `claimToken` fences the transition for pull-side workers and is omitted by the
 * in-process dispatcher, which cannot race itself. Returns whether the
 * transition applied — false means the claim was already gone.
 */
export async function markRunning(id: string, claimToken?: string): Promise<boolean> {
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    if (!job) return false;
    if (claimToken !== undefined && MOCK_CLAIM_TOKENS.get(id) !== claimToken) return false;
    job.status = 'running';
    job.startedAt = clock.nowIso();
    return true;
  }
  // The new columns appear ONLY on the fenced path. A cluster that has not
  // applied schema/local_compute_worker_schema.sql must keep working exactly as
  // before — naming claim_token in the dispatcher's own statement would take the
  // whole push-side queue down on every pre-migration cluster to serve a feature
  // it is not running. The fenced path is unreachable there, because the route
  // checks hasPullSideColumns() first.
  if (claimToken === undefined) {
    await exec(
      `UPDATE agent_jobs SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=:id`,
      [strParam('id', id)],
    );
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs SET status='running', started_at=NOW(), heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=:id AND claim_token=:token RETURNING id`,
    [strParam('id', id), strParam('token', claimToken)],
  );
  return rows.length > 0;
}

/**
 * Record a job's terminal state.
 *
 * `claimToken` is the fencing guard for pull-side workers, and it is the reason
 * this returns a boolean rather than void. Without it the statement was
 * `WHERE id = :id` — correct while the middleware was the only caller, since it
 * could not race itself, and wrong the moment a laptop holds a claim across a
 * middleware restart: a late completion from a worker whose job has since been
 * requeued and re-run would overwrite the newer result with the older one, and
 * both runs were billed. The guard also clears `claim_token`, so the same worker
 * retrying its POST cannot double-write.
 *
 * Returns false when nothing was updated — the claim expired, or the job is
 * already terminal. Callers that hold no token (the dispatcher) get the old
 * unguarded behaviour and can keep ignoring the result.
 */
export async function completeJob(id: string, opts: {
  status: 'awaiting_review' | 'done' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  /** Pull-side fencing token. Omitted by the in-process dispatcher. */
  claimToken?: string;
}): Promise<boolean> {
  if (config.mock.aurora) {
    const job = MOCK_JOBS.find((j) => j.id === id);
    if (!job) return false;
    if (opts.claimToken !== undefined) {
      if (MOCK_CLAIM_TOKENS.get(id) !== opts.claimToken) return false;
      if (job.status !== 'claimed' && job.status !== 'running') return false;
      MOCK_CLAIM_TOKENS.delete(id);
    }
    job.status = opts.status;
    if (opts.result) job.result = opts.result;
    job.error = opts.error ?? null;
    job.finishedAt = clock.nowIso();
    return true;
  }
  const params = [
    strParam('id', id),
    strParam('status', opts.status),
    strParam('result', opts.result ? JSON.stringify(opts.result) : ''),
    strParam('error', opts.error ?? ''),
  ];
  // Unfenced (the in-process dispatcher): byte-for-byte the previous statement.
  // A cluster that has not applied schema/local_compute_worker_schema.sql must
  // keep working — naming claim_token here would take the push-side queue down
  // on every pre-migration cluster to serve a feature it is not running. The
  // fenced path is unreachable there, because the route checks
  // hasPullSideColumns() before handing out a claim.
  if (opts.claimToken === undefined) {
    await exec(
      `UPDATE agent_jobs
          SET status = :status,
              result = COALESCE(:result::jsonb, result),
              error = NULLIF(:error, ''),
              finished_at = NOW(), updated_at = NOW()
        WHERE id = :id`,
      params,
    );
    return true;
  }
  // Fenced callers must also still hold a LIVE claim: a job the reaper already
  // failed for good is terminal, and re-opening it from a straggler's POST would
  // resurrect work nobody is waiting for. Clearing the token makes the write
  // once-only, so a worker retrying its POST after a network blip cannot
  // double-write a result.
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = :status,
            result = COALESCE(:result::jsonb, result),
            error = NULLIF(:error, ''),
            claim_token = NULL,
            finished_at = NOW(), updated_at = NOW()
      WHERE id = :id AND claim_token = :token AND status IN ('claimed','running')
      RETURNING id`,
    [...params, strParam('token', opts.claimToken)],
  );
  return rows.length > 0;
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
    job.finishedAt = clock.nowIso();
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs SET status='cancelled', finished_at=NOW(), updated_at=NOW()
      WHERE id=:id AND status IN ('queued','claimed') RETURNING id`,
    [strParam('id', id)],
  );
  return rows.length > 0;
}

export interface ReapOptions {
  /**
   * Whether jobs held by a FENCED (pull-side) claim are eligible.
   *
   * Defaults true, which is right for the periodic sweep: a workstation that has
   * not heartbeated for the whole stale window is gone, laptop or not, and its
   * work should go back to the queue.
   *
   * The boot-time sweep passes false, and that is the one call where the
   * difference matters. `recoverOrphanedWork` calls `reapStaleJobs(0)` —
   * requeueing EVERY live job with no window at all — justified in its own
   * comment because "in a single-process middleware any job still marked live at
   * boot is orphaned by definition; there is no run left to wait for." A paired
   * workstation mid-job is exactly the counterexample. Left alone, every
   * middleware restart — every `tsx watch` save in dev — would requeue a
   * laptop's in-flight work, and both copies would run and both would be
   * recorded.
   *
   * A fenced claim is skipped rather than trusted forever: it still gets reaped
   * by the periodic sweep once its heartbeat goes quiet. The boot sweep just
   * stops asserting that a claim it did not grant is dead.
   */
  includeFenced?: boolean;
}

/**
 * Recover jobs whose worker vanished (middleware restart, runtime timeout, a
 * laptop that closed its lid).
 *
 * Requeues while attempts remain so transient failures self-heal, and fails
 * loudly rather than silently retrying forever. Requeueing CLEARS the fencing
 * token, which is what makes the straggler's later completion a no-op instead of
 * an overwrite.
 *
 * Staleness is measured from the later of `updated_at` and `heartbeat_at`: a
 * pull-side worker proves liveness without changing state, so reading
 * `updated_at` alone would reap a job that is visibly still being worked on.
 */
export async function reapStaleJobs(
  staleMinutes = 30,
  opts: ReapOptions = {},
): Promise<{ requeued: number; failed: number }> {
  if (config.mock.aurora) return { requeued: 0, failed: 0 };
  const fenced = await hasPullSideColumns();
  const includeFenced = opts.includeFenced ?? true;

  // Pre-migration clusters keep the original statements exactly. There are no
  // fenced claims there to protect, and naming the columns would fail the sweep
  // outright — turning a recovery mechanism into a source of stuck jobs.
  const liveness = fenced ? 'GREATEST(updated_at, COALESCE(heartbeat_at, updated_at))' : 'updated_at';
  const skipFenced = fenced && !includeFenced ? ' AND claim_token IS NULL' : '';
  const clearToken = fenced ? ', claim_token=NULL' : '';
  const stale = `status IN ('claimed','running')
        AND ${liveness} < NOW() - (INTERVAL '1 minute' * :mins)${skipFenced}`;

  const requeued = await exec(
    `UPDATE agent_jobs
        SET status='queued', box_id=NULL, session_id=NULL, claimed_at=NULL, updated_at=NOW()${clearToken}
      WHERE ${stale}
        AND attempts < max_attempts
      RETURNING id`,
    [intParam('mins', staleMinutes)],
  );
  const failed = await exec(
    `UPDATE agent_jobs
        SET status='failed', error='worker did not report back before the stale window elapsed',
            finished_at=NOW(), updated_at=NOW()${clearToken}
      WHERE ${stale}
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

/**
 * Test hook — put the mock queue back to the seeded history and nothing else.
 *
 * The array is module-level and lives for the whole process, so a test that
 * enqueues leaks a claimable row into every later test in the file. That matters
 * specifically for the pull-side claim, which takes the OLDEST matching queued
 * row: the leftover wins, the test's own job is not the one claimed, and the
 * failure reads as a bug in the route rather than as shared state. Spliced in
 * place rather than reassigned because every function above closes over this
 * exact array.
 */
export function _resetMockQueue(): void {
  MOCK_JOBS.length = 0;
  MOCK_CLAIM_TOKENS.clear();
  if (config.mock.aurora) seedMockJobsFromBotRuns();
}
