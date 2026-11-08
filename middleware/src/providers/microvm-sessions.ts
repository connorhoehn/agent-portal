// microVM runner sessions as data (docs/microvm-runner-design.md §7, §9, §13): storage only.
//
// One row per runtime session, written by lib/microvm-dispatcher.ts at every
// status and read by three questions: how many live sessions an actor holds
// (§10 item 10), what a resume may reconstitute (§9), and which live sessions
// have overrun their task (the reaper, §7). Never a prompt, a token or a URL.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { microvmSessions } from '../mock/microvm-sessions.js';
import type { CostBasis } from '../lib/run-cost.js';

export type MicrovmSessionStatus = 'booting' | 'cloning' | 'ready' | 'running' | 'pushing' | 'reporting' | 'stopped' | 'failed';
export const LIVE_SESSION_STATUSES: readonly MicrovmSessionStatus[] = ['booting', 'cloning', 'ready', 'running', 'pushing', 'reporting'];

export interface MicrovmSessionRow {
  session_id: string;
  job_id: string;
  attempt: number;
  actor_sub: string;
  tenant: string;
  agent_project_id: string | null;
  initiative_id: string | null;
  runtime_arn: string | null;
  profile_id: string | null;
  profile_version: number | null;
  network_class: string | null;
  status: MicrovmSessionStatus;
  hold_id: string | null;
  brief_sha: string | null;
  library_sha: string | null;
  claude_session_id: string | null;
  base_sha: string | null;
  head_sha: string | null;
  branch: string | null;
  pr_url: string | null;
  transcript_s3_key: string | null;
  exit_code: number | null;
  fresh_tokens: number | null;
  cost_usd: number | null;
  cost_basis: CostBasis | null;
  compute_seconds: number | null;
  compute_usd: number | null;
  stop_reason: string | null;
  task_timeout_s: number | null;
  created_at: string;
  booted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  stopped_at: string | null;
}

export type MicrovmSessionInsert = Pick<MicrovmSessionRow,
  'session_id' | 'job_id' | 'attempt' | 'actor_sub' | 'tenant' | 'agent_project_id' | 'initiative_id' | 'runtime_arn'
  | 'profile_id' | 'profile_version' | 'network_class' | 'hold_id' | 'brief_sha' | 'library_sha' | 'branch' | 'task_timeout_s'>;

/** Every column a status update may set (never the identity columns). */
export type MicrovmSessionPatch = Partial<Omit<MicrovmSessionRow, 'session_id' | 'job_id' | 'attempt' | 'actor_sub' | 'tenant' | 'created_at'>>;

const PATCHABLE: ReadonlyArray<keyof MicrovmSessionPatch> = [
  'agent_project_id', 'initiative_id', 'runtime_arn', 'profile_id', 'profile_version', 'network_class', 'status', 'hold_id',
  'brief_sha', 'library_sha', 'claude_session_id', 'base_sha', 'head_sha', 'branch', 'pr_url', 'transcript_s3_key',
  'exit_code', 'fresh_tokens', 'cost_usd', 'cost_basis', 'compute_seconds', 'compute_usd', 'stop_reason', 'task_timeout_s',
  'booted_at', 'started_at', 'ended_at', 'stopped_at',
];
const INTS = new Set(['profile_version', 'exit_code', 'compute_seconds', 'task_timeout_s', 'attempt']);
const NUMS = new Set(['fresh_tokens', 'cost_usd', 'compute_usd']);
const TIMES = new Set(['booted_at', 'started_at', 'ended_at', 'stopped_at']);
const UUIDS = new Set(['agent_project_id', 'hold_id']);

function param(name: string, value: unknown): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (INTS.has(name)) return { name, value: { longValue: Math.trunc(Number(value)) } };
  if (NUMS.has(name)) return { name, value: { doubleValue: Number(value) } };
  return { name, value: { stringValue: String(value) } };
}
function cast(name: string): string {
  if (TIMES.has(name)) return `:${name}::timestamptz`;
  if (UUIDS.has(name)) return `:${name}::uuid`;
  if (name === 'fresh_tokens') return `:${name}::bigint`;
  if (name === 'cost_usd' || name === 'compute_usd') return `:${name}::numeric`;
  return `:${name}`;
}

const SELECT = `session_id, job_id, attempt, actor_sub, tenant, agent_project_id::text AS agent_project_id, initiative_id,
  runtime_arn, profile_id, profile_version, network_class, status, hold_id::text AS hold_id, brief_sha, library_sha,
  claude_session_id, base_sha, head_sha, branch, pr_url, transcript_s3_key, exit_code, fresh_tokens, cost_usd, cost_basis,
  compute_seconds, compute_usd, stop_reason, task_timeout_s, created_at::text AS created_at, booted_at::text AS booted_at,
  started_at::text AS started_at, ended_at::text AS ended_at, stopped_at::text AS stopped_at`;

function toRow(r: Record<string, unknown>): MicrovmSessionRow {
  const str = (k: string): string | null => (r[k] == null ? null : String(r[k]));
  const n = (k: string): number | null => (r[k] == null || !Number.isFinite(Number(r[k])) ? null : Number(r[k]));
  return {
    session_id: String(r['session_id']), job_id: String(r['job_id']), attempt: Number(r['attempt'] ?? 0),
    actor_sub: String(r['actor_sub'] ?? ''), tenant: String(r['tenant'] ?? ''),
    agent_project_id: str('agent_project_id'), initiative_id: str('initiative_id'), runtime_arn: str('runtime_arn'),
    profile_id: str('profile_id'), profile_version: n('profile_version'), network_class: str('network_class'),
    status: String(r['status'] ?? 'booting') as MicrovmSessionStatus, hold_id: str('hold_id'), brief_sha: str('brief_sha'),
    library_sha: str('library_sha'), claude_session_id: str('claude_session_id'), base_sha: str('base_sha'),
    head_sha: str('head_sha'), branch: str('branch'), pr_url: str('pr_url'), transcript_s3_key: str('transcript_s3_key'),
    exit_code: n('exit_code'), fresh_tokens: n('fresh_tokens'), cost_usd: n('cost_usd'),
    cost_basis: (str('cost_basis') as CostBasis | null), compute_seconds: n('compute_seconds'), compute_usd: n('compute_usd'),
    stop_reason: str('stop_reason'), task_timeout_s: n('task_timeout_s'), created_at: String(r['created_at'] ?? ''),
    booted_at: str('booted_at'), started_at: str('started_at'), ended_at: str('ended_at'), stopped_at: str('stopped_at'),
  };
}

export async function insertMicrovmSession(row: MicrovmSessionInsert): Promise<MicrovmSessionRow> {
  if (config.mock.aurora) {
    const full: MicrovmSessionRow = {
      ...row, status: 'booting', claude_session_id: null, base_sha: null, head_sha: null, pr_url: null,
      transcript_s3_key: null, exit_code: null, fresh_tokens: null, cost_usd: null, cost_basis: null, compute_seconds: null,
      compute_usd: null, stop_reason: null, created_at: clock.nowIso(), booted_at: null, started_at: null, ended_at: null, stopped_at: null,
    };
    const rows = microvmSessions.rows();
    if (rows.some((r) => r.session_id === row.session_id || (r.job_id === row.job_id && r.attempt === row.attempt))) {
      throw new Error(`microvm session ${row.session_id} already exists`);
    }
    rows.push(full);
    return { ...full };
  }
  const cols = Object.keys(row) as Array<keyof MicrovmSessionInsert>;
  const rows = await exec(
    `INSERT INTO microvm_sessions (${cols.join(', ')}) VALUES (${cols.map((c) => cast(c)).join(', ')}) RETURNING ${SELECT}`,
    cols.map((c) => param(c, row[c])),
  );
  return toRow(rows[0] ?? {});
}

/** Set the given columns on one session. A patch with no known column is a no-op. */
export async function updateMicrovmSession(sessionId: string, patch: MicrovmSessionPatch): Promise<void> {
  const cols = PATCHABLE.filter((c) => Object.prototype.hasOwnProperty.call(patch, c));
  if (!cols.length) return;
  if (config.mock.aurora) {
    const row = microvmSessions.rows().find((r) => r.session_id === sessionId);
    if (row) Object.assign(row, Object.fromEntries(cols.map((c) => [c, patch[c] ?? null])));
    return;
  }
  await exec(
    `UPDATE microvm_sessions SET ${cols.map((c) => `${c} = ${cast(c)}`).join(', ')} WHERE session_id = :sid`,
    [...cols.map((c) => param(c, patch[c])), { name: 'sid', value: { stringValue: sessionId } }],
  );
}

/** The newest session a job ran (any attempt), or null. */
export async function latestSessionForJob(jobId: string): Promise<MicrovmSessionRow | null> {
  if (config.mock.aurora) {
    const rows = microvmSessions.rows().filter((r) => r.job_id === jobId).sort((a, b) => b.attempt - a.attempt);
    return rows[0] ? { ...rows[0] } : null;
  }
  const rows = await exec(`SELECT ${SELECT} FROM microvm_sessions WHERE job_id = :job ORDER BY attempt DESC LIMIT 1`,
    [{ name: 'job', value: { stringValue: jobId } }]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * The head an earlier attempt of this job pushed to its branch, or null when
 * none did: the push lease of the next attempt (`expected_head`). `head_sha`
 * is written only after a push the box confirmed, so a commit that never left
 * the box is not a lease.
 */
export async function pushedHeadForJob(jobId: string, beforeAttempt: number): Promise<string | null> {
  if (config.mock.aurora) {
    const row = microvmSessions.rows()
      .filter((r) => r.job_id === jobId && r.attempt < beforeAttempt && r.head_sha)
      .sort((a, b) => b.attempt - a.attempt)[0];
    return row?.head_sha ?? null;
  }
  const rows = await exec(
    `SELECT head_sha FROM microvm_sessions WHERE job_id = :job AND attempt < :attempt AND head_sha IS NOT NULL
      ORDER BY attempt DESC LIMIT 1`,
    [{ name: 'job', value: { stringValue: jobId } }, { name: 'attempt', value: { longValue: Math.trunc(beforeAttempt) } }],
  );
  const v = rows[0]?.['head_sha'];
  return typeof v === 'string' && v ? v : null;
}

/** How many sessions the actor holds that have not stopped or failed (§10 item 10). */
export async function countLiveSessionsForActor(actorSub: string): Promise<number> {
  if (config.mock.aurora) {
    return microvmSessions.rows().filter((r) => r.actor_sub === actorSub && LIVE_SESSION_STATUSES.includes(r.status)).length;
  }
  const rows = await exec(
    `SELECT COUNT(*)::int AS n FROM microvm_sessions WHERE actor_sub = :sub AND status NOT IN ('stopped', 'failed')`,
    [{ name: 'sub', value: { stringValue: actorSub } }],
  );
  return Number(rows[0]?.['n'] ?? 0);
}

/** Every session not yet stopped or failed (the reaper decides which overran). */
export async function listLiveSessions(limit = 200): Promise<MicrovmSessionRow[]> {
  if (config.mock.aurora) {
    return microvmSessions.rows().filter((r) => LIVE_SESSION_STATUSES.includes(r.status)).slice(0, limit).map((r) => ({ ...r }));
  }
  const rows = await exec(
    `SELECT ${SELECT} FROM microvm_sessions WHERE status NOT IN ('stopped', 'failed') ORDER BY created_at LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}`,
  );
  return rows.map(toRow);
}

/**
 * p75 of the compute seconds past sessions of one (agent project, model)
 * took, or null under three samples. The forecast's compute term (§6).
 */
export async function computeSecondsP75(agentProjectId: string, model: string | null): Promise<number | null> {
  let samples: number[];
  if (config.mock.aurora) {
    samples = microvmSessions.rows()
      .filter((r) => r.agent_project_id === agentProjectId && r.compute_seconds != null)
      .map((r) => Number(r.compute_seconds));
  } else {
    // model is not a session column; the agent project is the dominant term.
    void model;
    const rows = await exec(
      `SELECT compute_seconds FROM microvm_sessions WHERE agent_project_id = :ap::uuid AND compute_seconds IS NOT NULL
        ORDER BY created_at DESC LIMIT 50`,
      [{ name: 'ap', value: { stringValue: agentProjectId } }],
    );
    samples = rows.map((r) => Number(r['compute_seconds'])).filter((x) => Number.isFinite(x));
  }
  if (samples.length < 3) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.75 * sorted.length) - 1)] ?? null;
}
