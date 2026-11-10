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
import { EventEmitter } from 'node:events';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { noteSearchWrite } from '../lib/search-index/writes.js';
import { hasColumns, _resetColumnProbes } from './column-probe.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
// Every timestamp the mock queue writes comes from here, never `new Date()`:
// the mock branches below write into a registered fixture (mock/agent-jobs.ts)
// living outside src/mock, and a stamp minted off the wall clock cannot be
// frozen by freezeClock (so no test can pin what a transition wrote) and lands
// in yesterday when the process runs a minute after UTC midnight.
import { clock } from '../mock/core/index.js';
// The queue itself: the registered `agent-jobs` fixture (rows + reset),
// the live array view every mock branch below reads and mutates in place,
// and the pull-side claim-token map. See mock/agent-jobs.ts for why the seed
// and the claim tokens live there instead of here.
import { agentJobs, mockJobs, MOCK_CLAIM_TOKENS } from '../mock/agent-jobs.js';
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
  /**
   * Which executor runs it (docs/microvm-runner-design.md §13): set at enqueue
   * from the initiative's devbox profile. Absent on reads that do not select
   * it (and on rows from before the column) = 'fleet'. The fleet claim never
   * takes a 'microvm' row; the microVM claim takes nothing else.
   */
  runner?: JobRunner;
  /** The session subject that queued it — the authority (created_by is display). */
  actorSub?: string | null;
  /** §9: the job this one resumes, accepted only for runner 'microvm'. */
  resumeOfJobId?: string | null;
}

export type JobRunner = 'fleet' | 'microvm' | 'local';

/** Returned only to the caller that won a claim; normal job reads omit the token. */
export interface ClaimedAgentJob extends AgentJob { readonly claimToken: string; }

async function requireClaimSchema(): Promise<void> {
  if (!await hasPullSideColumns()) throw new Error('Agent job claims require schema/local_compute_worker_schema.sql');
}

/**
 * Fires whenever a job's status changes — every job, not only local-compute
 * ones. `routes/local-compute.ts`'s `GET /events` SSE stream is the one
 * listener that filters this down to an owner's own `local:` box ids (plus
 * targeted-but-unclaimed rows, via `payload.nodeId`); `job-dispatcher.ts`'s
 * `dispatcherEvents` is a separate, older feed for the work-queue pages and is
 * untouched by this. One emitter here, in the provider, rather than each
 * write site inventing its own shape.
 *
 * Every durable claim, running, terminal, cancellation, and review transition
 * emits here for both paired machines and cloud dispatch. `dispatcherEvents`
 * remains a UI-oriented compatibility feed; it is not an authenticated source
 * lifecycle and cannot replace this provider-level hook.
 */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(256);

export interface JobChangeEvent {
  jobId: string;
  boxId: string | null;
  status: JobStatus;
  title: string;
  payload: Record<string, unknown>;
  at: string;
}

function emitJobChange(job: Pick<AgentJob, 'id' | 'boxId' | 'status' | 'title' | 'payload'>): void {
  jobEvents.emit('change', {
    jobId: job.id,
    boxId: job.boxId,
    status: job.status,
    title: job.title,
    payload: job.payload,
    at: new Date().toISOString(),
  } satisfies JobChangeEvent);
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
    // Only the reads that select them (claimNextMicrovmJob, getMicrovmJobFacts).
    ...('runner' in r ? { runner: (toStr(r['runner'], 'fleet') || 'fleet') as JobRunner } : {}),
    ...('actor_sub' in r ? { actorSub: r['actor_sub'] ? toStr(r['actor_sub']) : null } : {}),
    ...('resume_of_job_id' in r ? { resumeOfJobId: r['resume_of_job_id'] ? toStr(r['resume_of_job_id']) : null } : {}),
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
//
// The rows themselves, the seed that mints them from bot-run history, and the
// pull-side claim-token map all live in mock/agent-jobs.ts now (imported
// above as `mockJobs`/`agentJobs`/`MOCK_CLAIM_TOKENS`) — a registered fixture,
// so `POST /api/__mock/reset` puts the queue back after a claim/complete
// cycle. What stays here is id-minting and sort order, which are provider
// behaviour, not seed data.

/**
 * A queue id in the shape the table itself mints.
 *
 * `agent_jobs.id` defaults to `'job-' || gen_random_uuid()`
 * (schema/agentic_work_schema.sql), and only the seed writes ids by hand
 * (`job-<slug>-maint-N`, one per cron firing it fabricates history for). The
 * mock used to mint `job-mock-1`, `job-mock-2` … — a third dialect that
 * belongs to neither, so a "job →" link from a run recorded offline opened an
 * id Aurora could never hold, and the same click worked in dev:mock and 404'd
 * on the cluster. That is the same defect mock/agent-jobs.ts's seed was
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

export async function enqueueJob(...a: Parameters<typeof enqueueJobRow>): Promise<AgentJob | null> {
  const out = await enqueueJobRow(...a);
  if (out) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `job:${out.id}` });
  return out;
}

async function enqueueJobRow(input: {
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  priority?: number;
  createdBy?: string;
  maxAttempts?: number;
  /** Set when a standing mission enqueued this, so the queue can attribute it
   * to the bot rather than showing an anonymous scheduled task. */
  botId?: string;
  /** The session subject queuing it (docs/microvm-runner-design.md §10 item 2). From the session, never a body. */
  actorSub?: string | null;
  /** §9: the job this one resumes. Only a microvm job may name one. */
  resumeOfJobId?: string | null;
}): Promise<AgentJob | null> {
  // The runner comes from the initiative's profile, never the caller
  // (lib/microvm-enqueue.ts): an egress-allowlist profile routes the job to the
  // microVM runner, and refuses the payload fields that runner does not take.
  const { resolveJobRunner } = await import('../lib/microvm-enqueue.js');
  const runner = await resolveJobRunner({ kind: input.kind, payload: input.payload ?? {}, resumeOfJobId: input.resumeOfJobId ?? null });
  const actorSub = input.actorSub && input.actorSub.trim() ? input.actorSub.trim() : null;
  const resumeOf = runner === 'microvm' && input.resumeOfJobId ? input.resumeOfJobId : null;
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
      // Only when they say something, so a fleet row reads as it always has.
      ...(runner !== 'fleet' ? { runner } : {}),
      ...(actorSub ? { actorSub } : {}),
      ...(resumeOf ? { resumeOfJobId: resumeOf } : {}),
    };
    mockJobs.push(job);
    emitJobChange(job);
    return job;
  }
  // DE-37: the initiative as a column the claim filters on, when the cluster has it.
  const initiative = typeof input.payload?.['initiativeId'] === 'string' && input.payload['initiativeId'] ? input.payload['initiativeId'] : null;
  const withInitiative = initiative !== null && await hasColumns('agent_jobs', ['initiative_id']).catch(() => false);
  // The runner columns (schema/microvm_sessions.sql), written when there is
  // something to say. A microvm job on a cluster without them is refused: the
  // row would read as 'fleet' and run on the public fleet.
  const withRunner = (runner !== 'fleet' || actorSub !== null || resumeOf !== null)
    && await hasColumns('agent_jobs', ['runner', 'actor_sub', 'resume_of_job_id']).catch(() => false);
  if (runner === 'microvm' && !withRunner) {
    throw new Error('agent_jobs.runner is missing: apply schema/microvm_sessions.sql before queuing microVM work');
  }
  const rows = await exec(
    `INSERT INTO agent_jobs (kind, title, payload, priority, created_by, max_attempts, bot_id${withInitiative ? ', initiative_id' : ''}${withRunner ? ', runner, actor_sub, resume_of_job_id' : ''})
     VALUES (:kind, :title, :payload::jsonb, :priority, :created_by, :max_attempts, :bot_id::uuid${withInitiative ? ', :initiative' : ''}${withRunner ? ', :runner, :actor_sub, :resume_of' : ''})
     RETURNING ${COLUMNS}${withRunner ? ', runner, actor_sub, resume_of_job_id' : ''}`,
    [
      ...(withInitiative ? [strParam('initiative', initiative!)] : []),
      ...(withRunner ? [
        strParam('runner', runner),
        actorSub ? strParam('actor_sub', actorSub) : { name: 'actor_sub', value: { isNull: true } },
        resumeOf ? strParam('resume_of', resumeOf) : { name: 'resume_of', value: { isNull: true } },
      ] : []),
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
  const job = rows[0] ? rowToJob(rows[0]) : null;
  if (job) emitJobChange(job);
  return job;
}

/**
 * Clone a dead-lettered job back onto the queue. Only terminal failures
 * qualify — requeueing a job that is still moving would double-run it. The
 * clone keeps the original kind/title/payload (the server holds the full
 * payload; the portal never re-supplies a prompt it may not even see) and
 * records where it came from in created_by.
 */
export async function requeueJob(...a: Parameters<typeof requeueJobRow>): Promise<AgentJob | null> {
  const out = await requeueJobRow(...a);
  if (out) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `job:${out.id}` });
  return out;
}

async function requeueJobRow(id: string, requeuedBy?: string): Promise<AgentJob | null> {
  const dead = await getJob(id);
  if (!dead) return null;
  if (dead.status !== 'failed' && dead.status !== 'cancelled') return null;
  // The clone is a NEW run: it gets its own brief at dispatch (lib/run-brief.ts),
  // so the dead run's brief stamp does not ride along.
  const { brief_id: _briefId, brief_sha: _briefSha, ...payload } = dead.payload;
  return enqueueJob({
    kind: dead.kind,
    title: dead.title,
    payload,
    priority: dead.priority,
    createdBy: requeuedBy ? `${requeuedBy} (requeue of ${dead.id})` : `requeue of ${dead.id}`,
    ...(dead.botId ? { botId: dead.botId } : {}),
  });
}

export async function listJobs(opts: { status?: string; limit?: number } = {}): Promise<AgentJob[]> {
  if (config.mock.aurora) {
    return mockJobs
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
    return mockJobs
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

/**
 * Merge `patch` into a job's payload — the session brief's stamp
 * (`brief_id`/`brief_sha`, lib/run-brief.ts) written when the run is bound to
 * a box. Only those keys are written by callers; the task the person asked for
 * is never touched.
 */
export async function stampJobPayload(id: string, patch: Record<string, string>): Promise<boolean> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) return false;
    job.payload = { ...job.payload, ...patch };
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs SET payload = payload || :patch::jsonb WHERE id = :id RETURNING id`,
    [strParam('id', id), strParam('patch', JSON.stringify(patch))],
  );
  return rows.length > 0;
}

export async function getJob(id: string): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    return job ? { ...job } : null;
  }
  const rows = await exec(
    `SELECT ${COLUMNS_WITH_BOT} FROM ${JOBS_WITH_BOT} WHERE j.id = :id`,
    [strParam('id', id)],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

/**
 * The push-side claims' runner guard (docs/microvm-runner-design.md §14 step 4):
 * a fleet box never takes a microVM job. Read through `to_jsonb` so the same
 * statement runs on a cluster that has not applied schema/microvm_sessions.sql
 * (no column → no microvm rows → the guard is true), with no probe call.
 */
const NOT_MICROVM = `COALESCE(to_jsonb(agent_jobs)->>'runner', 'fleet') <> 'microvm'`;

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
 * covered by construction, present and future. Claims require the existing
 * token/heartbeat migration for both push and pull executors.
 */
export async function claimNextJob(
  boxId: string, sessionId: string,
  /** DE-37: initiatives at their concurrency limit — their jobs stay queued and the next one is taken. */
  opts?: { skipInitiatives?: readonly string[] },
): Promise<ClaimedAgentJob | null> {
  await requireClaimSchema();
  const claimToken = mintClaimToken();
  const pullOnly = LOCAL_JOB_KINDS as readonly string[];
  const skip = (opts?.skipInitiatives ?? []).slice(0, 200);
  if (config.mock.aurora) {
    const next = mockJobs
      .filter((j) => j.status === 'queued' && j.attempts < j.maxAttempts && !pullOnly.includes(j.kind))
      .filter((j) => (j.runner ?? 'fleet') !== 'microvm')
      .filter((j) => !skip.includes(String(j.payload['initiativeId'] ?? '')))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = boxId;
    next.sessionId = sessionId;
    next.claimedAt = clock.nowIso();
    next.attempts += 1;
    MOCK_CLAIM_TOKENS.set(next.id, claimToken);
    emitJobChange(next);
    return { ...next, claimToken };
  }
  // No array parameter in the RDS Data API, so the exclusion list is expanded
  // into named placeholders — the same shape claimNextJobForWorker's allowlist
  // uses. Bounded by LOCAL_JOB_KINDS, which is a module constant.
  const kindParams = pullOnly.map((k, i) => strParam(`x${i}`, k));
  const kindList = pullOnly.map((_, i) => `:x${i}`).join(', ');
  const skipParams = skip.map((id, i) => strParam(`si${i}`, id));
  const withInitiative = skip.length > 0 && await hasColumns('agent_jobs', ['initiative_id']).catch(() => false);
  const initiativeExpr = withInitiative ? `COALESCE(initiative_id, payload->>'initiativeId', '')` : `COALESCE(payload->>'initiativeId', '')`;
  const skipClause = skip.length ? ` AND ${initiativeExpr} NOT IN (${skip.map((_, i) => `:si${i}`).join(', ')})` : '';
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claim_token = :token, heartbeat_at = NOW(), claimed_at = NOW(),
            attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
            SELECT id FROM agent_jobs
             WHERE status = 'queued' AND attempts < max_attempts AND kind NOT IN (${kindList})${skipClause}
               AND ${NOT_MICROVM}
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}`,
    [strParam('box', boxId), strParam('session', sessionId), strParam('token', claimToken), ...kindParams, ...skipParams],
  );
  const job = rows[0] ? rowToJob(rows[0]) : null;
  if (job) emitJobChange(job);
  return job ? { ...job, claimToken } : null;
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
export async function claimJob(id: string, boxId: string, sessionId: string): Promise<ClaimedAgentJob | null> {
  await requireClaimSchema();
  const claimToken = mintClaimToken();
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id && j.status === 'queued' && j.attempts < j.maxAttempts && (j.runner ?? 'fleet') !== 'microvm');
    if (!job) return null;
    job.status = 'claimed';
    job.boxId = boxId;
    job.sessionId = sessionId;
    job.claimedAt = clock.nowIso();
    job.attempts += 1;
    MOCK_CLAIM_TOKENS.set(job.id, claimToken);
    emitJobChange(job);
    return { ...job, claimToken };
  }
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = :box, session_id = :session,
            claim_token = :token, heartbeat_at = NOW(), claimed_at = NOW(),
            attempts = attempts + 1, updated_at = NOW()
      WHERE id = :id AND status = 'queued' AND attempts < max_attempts AND ${NOT_MICROVM}
      RETURNING ${COLUMNS}`,
    [strParam('id', id), strParam('box', boxId), strParam('session', sessionId), strParam('token', claimToken)],
  );
  const job = rows[0] ? rowToJob(rows[0]) : null;
  if (job) emitJobChange(job);
  return job ? { ...job, claimToken } : null;
}

// ─── The microVM runner's claim (docs/microvm-runner-design.md §3, §10) ───────
//
// No box first: a microvm job gets a fresh runtime session per attempt, so the
// claim takes the job alone, then `stampJobPlacement` writes the derived
// session id (it carries the attempt number the claim just incremented) and
// the transient box id. Both writes are fenced on the claim token.

const RUNNER_COLUMNS = ', runner, actor_sub, resume_of_job_id';

/** Whether the cluster has the runner columns (schema/microvm_sessions.sql). */
export async function hasRunnerColumns(): Promise<boolean> {
  return hasColumns('agent_jobs', ['runner', 'actor_sub', 'resume_of_job_id']);
}

/**
 * Claim the next queued `runner = 'microvm'` job. `excludeIds` are jobs this
 * tick already judged (and, held back, handed back), so one tick never spins
 * on the same head. Null when the queue has none, or the cluster has no runner
 * column (then there can be no microvm rows).
 */
export async function claimNextMicrovmJob(opts: { excludeIds?: readonly string[]; skipInitiatives?: readonly string[] } = {}): Promise<ClaimedAgentJob | null> {
  await requireClaimSchema();
  const exclude = (opts.excludeIds ?? []).slice(0, 100);
  const skip = (opts.skipInitiatives ?? []).slice(0, 200);
  const claimToken = mintClaimToken();
  if (config.mock.aurora) {
    const next = mockJobs
      .filter((j) => j.status === 'queued' && j.attempts < j.maxAttempts && j.runner === 'microvm')
      .filter((j) => !exclude.includes(j.id) && !skip.includes(String(j.payload['initiativeId'] ?? '')))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = null;
    next.sessionId = null;
    next.claimedAt = clock.nowIso();
    next.attempts += 1;
    MOCK_CLAIM_TOKENS.set(next.id, claimToken);
    emitJobChange(next);
    return { ...next, claimToken };
  }
  if (!await hasRunnerColumns()) return null;
  const excludeClause = exclude.length ? ` AND id NOT IN (${exclude.map((_, i) => `:ex${i}`).join(', ')})` : '';
  const skipClause = skip.length ? ` AND COALESCE(payload->>'initiativeId', '') NOT IN (${skip.map((_, i) => `:si${i}`).join(', ')})` : '';
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'claimed', box_id = NULL, session_id = NULL,
            claim_token = :token, heartbeat_at = NOW(), claimed_at = NOW(),
            attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
            SELECT id FROM agent_jobs
             WHERE status = 'queued' AND attempts < max_attempts AND runner = 'microvm'${excludeClause}${skipClause}
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}${RUNNER_COLUMNS}`,
    [strParam('token', claimToken), ...exclude.map((id, i) => strParam(`ex${i}`, id)), ...skip.map((id, i) => strParam(`si${i}`, id))],
  );
  const job = rows[0] ? rowToJob(rows[0]) : null;
  if (job) emitJobChange(job);
  return job ? { ...job, claimToken } : null;
}

/** Write a claimed microvm job's derived box and session ids, fenced on its claim. */
export async function stampJobPlacement(id: string, claimToken: string, boxId: string, sessionId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    if (!job || MOCK_CLAIM_TOKENS.get(id) !== claimToken || !['claimed', 'running'].includes(job.status)) return false;
    job.boxId = boxId;
    job.sessionId = sessionId;
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs SET box_id = :box, session_id = :session, updated_at = NOW()
      WHERE id = :id AND claim_token = :token AND status IN ('claimed','running') RETURNING id`,
    [strParam('id', id), strParam('token', claimToken), strParam('box', boxId), strParam('session', sessionId)],
  );
  return rows.length > 0;
}

/** A job with its runner facts (§9's resume checks read the original's). */
export async function getMicrovmJobFacts(id: string): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    return job ? { ...job, runner: job.runner ?? 'fleet', actorSub: job.actorSub ?? null, resumeOfJobId: job.resumeOfJobId ?? null } : null;
  }
  if (!await hasRunnerColumns()) return null;
  const rows = await exec(`SELECT ${COLUMNS}${RUNNER_COLUMNS} FROM agent_jobs WHERE id = :id`, [strParam('id', id)]);
  return rows[0] ? rowToJob(rows[0]) : null;
}

// ─── Pull-side claims (local compute) ────────────────────────────────────────
//
// Push and pull executors share the same per-attempt token. Claiming a job is
// atomic; every subsequent worker write is conditional on that live attempt.
// A middleware restart or another replica can otherwise make a late push
// completion overwrite newer work just as a stale workstation would.
//
// A paired workstation holds the same kind of claim. It has no inbound path (a stated
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
 * Whether this cluster has the shared attempt-fencing columns applied.
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
 *      it is handed, and wrong for a laptop: a node taking an interactive `devbox:task` would strand a person waiting
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
 * `nodeId` is claimed by NO machine (docs/next-steps.md section 8, package 6):
 * it used to go to any eligible one, which let whoever queued it run a prompt
 * on somebody else's laptop. Both enqueue routes now refuse an untargeted local
 * job, so such a row can only be legacy; it waits until someone cancels it.
 */
export async function claimNextJobForWorker(opts: {
  boxId: string;
  sessionId: string;
  kinds: readonly string[];
  /** The claiming machine's node id — matched against `payload.nodeId`. */
  nodeId?: string;
}): Promise<PullClaim | null> {
  if (opts.kinds.length === 0) return null;
  await requireClaimSchema();
  // A machine with no id can be named by no job.
  if (!opts.nodeId) return null;
  const claimToken = mintClaimToken();

  /** A job is claimable by this machine only if it names this machine. */
  const targetOk = (payload: Record<string, unknown>): boolean => payload['nodeId'] === opts.nodeId;

  if (config.mock.aurora) {
    const next = mockJobs
      .filter((j) => j.status === 'queued' && j.attempts < j.maxAttempts && opts.kinds.includes(j.kind) && targetOk(j.payload))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'claimed';
    next.boxId = opts.boxId;
    next.sessionId = opts.sessionId;
    next.claimedAt = clock.nowIso();
    next.attempts += 1;
    MOCK_CLAIM_TOKENS.set(next.id, claimToken);
    emitJobChange(next);
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
             WHERE status = 'queued' AND attempts < max_attempts AND kind IN (${kindList})
               AND payload->>'nodeId' = :node
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
      RETURNING ${COLUMNS}`,
    [strParam('box', opts.boxId), strParam('session', opts.sessionId),
      strParam('token', claimToken), strParam('node', opts.nodeId), ...kindParams],
  );
  if (!rows[0]) return null;
  const job = rowToJob(rows[0]);
  emitJobChange(job);
  return { job, claimToken };
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
    return mockJobs.filter((j) => j.boxId === boxId && (j.status === 'claimed' || j.status === 'running')).length;
  }
  const rows = await exec(
    `SELECT count(*)::int AS n FROM agent_jobs
      WHERE box_id = :box AND status IN ('claimed','running')`,
    [strParam('box', boxId)],
  );
  return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Liveness ping from an executor, guarded by its fencing token.
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
    const job = mockJobs.find((j) => j.id === id);
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

/**
 * Move a claimed job to `running`.
 *
 * `claimToken` fences the transition for every executor. Returns whether the
 * transition applied — false means the claim was already gone.
 */
/**
 * Hand a claimed job back to the queue WITHOUT burning an attempt (DE-34): the
 * dispatcher claimed it and then could not hold its money, which is nothing
 * the job did. The claim is undone exactly — status, box, session, token,
 * stamps and the attempt counter — so the next tick re-claims it as if this
 * one had never happened. Fenced on the claim token like every other write.
 */
export async function unclaimJob(id: string, claimToken: string): Promise<boolean> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    if (!job || job.status !== 'claimed' || MOCK_CLAIM_TOKENS.get(id) !== claimToken) return false;
    job.status = 'queued';
    job.boxId = null;
    job.sessionId = null;
    job.claimedAt = null;
    job.attempts = Math.max(0, job.attempts - 1);
    MOCK_CLAIM_TOKENS.delete(id);
    emitJobChange(job);
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = 'queued', box_id = NULL, session_id = NULL, claim_token = NULL,
            claimed_at = NULL, heartbeat_at = NULL,
            attempts = GREATEST(attempts - 1, 0), updated_at = NOW()
      WHERE id = :id AND claim_token = :token AND status = 'claimed'
      RETURNING id, title, payload::text AS payload`,
    [strParam('id', id), strParam('token', claimToken)],
  );
  if (rows[0]) {
    emitJobChange({
      id: toStr(rows[0]['id']), boxId: null, status: 'queued',
      title: toStr(rows[0]['title']), payload: toJson(rows[0]['payload']) ?? {},
    });
  }
  return rows.length > 0;
}

export async function markRunning(id: string, claimToken?: string): Promise<boolean> {
  if (!claimToken) return false;
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
    if (!job || !['claimed', 'running'].includes(job.status)) return false;
    if (MOCK_CLAIM_TOKENS.get(id) !== claimToken) return false;
    job.status = 'running';
    job.startedAt ??= clock.nowIso();
    emitJobChange(job);
    return true;
  }
  const rows = await exec(
    `UPDATE agent_jobs SET status='running', started_at=COALESCE(started_at,NOW()), heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=:id AND claim_token=:token AND status IN ('claimed','running') RETURNING id, box_id, title, payload::text AS payload`,
    [strParam('id', id), strParam('token', claimToken)],
  );
  if (rows[0]) {
    emitJobChange({
      id: toStr(rows[0]['id']),
      boxId: rows[0]['box_id'] ? toStr(rows[0]['box_id']) : null,
      status: 'running',
      title: toStr(rows[0]['title']),
      payload: toJson(rows[0]['payload']) ?? {},
    });
  }
  return rows.length > 0;
}

/** Record a terminal result only while the caller owns the current live attempt. */
export async function completeJob(...a: Parameters<typeof completeJobRow>): Promise<boolean> {
  const out = await completeJobRow(...a);
  if (out) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `job:${a[0]}` });
  return out;
}

async function completeJobRow(id: string, opts: {
  status: 'awaiting_review' | 'done' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  /** Required for every executor. Missing tokens are refused without a write. */
  claimToken?: string;
}): Promise<boolean> {
  if (!opts.claimToken) return false;
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id);
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
    emitJobChange(job);
    return true;
  }
  const params = [
    strParam('id', id),
    strParam('status', opts.status),
    strParam('result', opts.result ? JSON.stringify(opts.result) : ''),
    strParam('error', opts.error ?? ''),
  ];
  // Fenced callers must also still hold a LIVE claim: a job the reaper already
  // failed for good is terminal, and re-opening it from a straggler's POST would
  // resurrect work nobody is waiting for. Clearing the token makes the write
  // once-only, so a worker retrying its POST after a network blip cannot
  // double-write a result.
  const rows = await exec(
    `UPDATE agent_jobs
        SET status = :status,
            result = COALESCE(NULLIF(:result, '')::jsonb, result),
            error = NULLIF(:error, ''),
            claim_token = NULL,
            finished_at = NOW(), updated_at = NOW()
      WHERE id = :id AND claim_token = :token AND status IN ('claimed','running')
      RETURNING id, box_id, title, payload::text AS payload`,
    [...params, strParam('token', opts.claimToken)],
  );
  if (rows[0]) {
    emitJobChange({
      id: toStr(rows[0]['id']),
      boxId: rows[0]['box_id'] ? toStr(rows[0]['box_id']) : null,
      status: opts.status,
      title: toStr(rows[0]['title']),
      payload: toJson(rows[0]['payload']) ?? {},
    });
  }
  return rows.length > 0;
}

/** Human accepted or rejected the artifact an awaiting_review job produced. */
export async function reviewJob(...a: Parameters<typeof reviewJobRow>): Promise<AgentJob | null> {
  const out = await reviewJobRow(...a);
  if (out) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `job:${out.id}` });
  return out;
}

async function reviewJobRow(id: string, decision: 'accept' | 'reject', note?: string): Promise<AgentJob | null> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id && j.status === 'awaiting_review');
    if (!job) return null;
    job.status = decision === 'accept' ? 'done' : 'failed';
    job.result = { ...(job.result ?? {}), reviewNote: note ?? '' };
    emitJobChange(job);
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
  const job = rows[0] ? rowToJob(rows[0]) : null;
  if (job) emitJobChange(job);
  return job;
}

export async function cancelJob(...a: Parameters<typeof cancelJobRow>): Promise<boolean> {
  const out = await cancelJobRow(...a);
  if (out) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `job:${a[0]}` });
  return out;
}

async function cancelJobRow(id: string): Promise<boolean> {
  if (config.mock.aurora) {
    const job = mockJobs.find((j) => j.id === id && (j.status === 'queued' || j.status === 'claimed'));
    if (!job) return false;
    MOCK_CLAIM_TOKENS.delete(id);
    job.status = 'cancelled';
    job.finishedAt = clock.nowIso();
    emitJobChange(job);
    return true;
  }
  const clearToken = await hasPullSideColumns() ? ', claim_token=NULL' : '';
  const rows = await exec(
    `UPDATE agent_jobs SET status='cancelled', finished_at=NOW(), updated_at=NOW()${clearToken}
      WHERE id=:id AND status IN ('queued','claimed') RETURNING id, box_id, title, payload::text AS payload`,
    [strParam('id', id)],
  );
  if (rows[0]) {
    emitJobChange({
      id: toStr(rows[0]['id']),
      boxId: rows[0]['box_id'] ? toStr(rows[0]['box_id']) : null,
      status: 'cancelled',
      title: toStr(rows[0]['title']),
      payload: toJson(rows[0]['payload']) ?? {},
    });
  }
  return rows.length > 0;
}

export interface ReapOptions {
  /** Recovery lease guard, rechecked before each SQL mutation. */
  assertLive?: () => void;
  /**
   * Whether jobs held by any fenced claim (push or pull) are eligible.
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

  opts.assertLive?.();
  const requeued = await exec(
    `UPDATE agent_jobs
        SET status='queued', box_id=NULL, session_id=NULL, claimed_at=NULL, started_at=NULL, updated_at=NOW()${clearToken}
      WHERE ${stale}
        AND attempts < max_attempts
      RETURNING id`,
    [intParam('mins', staleMinutes)],
  );
  opts.assertLive?.();
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
    for (const j of mockJobs) { base[j.status] += 1; base.total += 1; }
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
 * A thin wrapper over the registered fixture's own `reset()` (which also
 * clears the claim-token map — see mock/agent-jobs.ts), kept under its old
 * name because routes/__tests__/work-jobs-tool-call-list.test.ts and
 * routes/__tests__/local-compute-routes.test.ts both call it directly in
 * `beforeEach`. `POST /api/__mock/reset` reaches the same `reset()` through
 * the fixture registry, so this and the control plane can no longer disagree
 * about what "reset" means for this queue.
 */
export function _resetMockQueue(): void {
  agentJobs.reset();
}
