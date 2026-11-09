// Logging's Jobs and sweeps source (G37): agent jobs on the work queue
// (GET /api/work/jobs and /jobs/:id, ViewWork), the org sweeps' runs
// (GET /api/work/sweeps/runs, the sweep runs' read gate: newest first, the
// session's tenant) and a background sweep job by its id
// (GET /api/work/sweeps/jobs/:id, the caller's own: the job a voice toast
// names). There is no list of sweep jobs (they live an hour in memory), so a
// sweep job opens by its URL and is not a rail row.

import { lifecycleEvents, newestFirst, plural, took, tookMs, when, type LogRecord, type LogRow } from './loggingModel.ts';

export const WORK_JOBS_API = '/api/work/jobs?limit=50';
export const SWEEP_RUNS_API = '/api/work/sweeps/runs?limit=50';
export const workJobApi = (id: string): string => `/api/work/jobs/${encodeURIComponent(id)}`;
export const sweepJobApi = (id: string): string => `/api/work/sweeps/jobs/${encodeURIComponent(id)}`;

export const AGENT_JOB = 'agent-jobs';
export const SWEEP_RUN = 'sweep-runs';
export const SWEEP_JOB = 'sweep-jobs';

/** providers/agent-jobs.ts AgentJob, as the work routes answer it. */
export interface WorkJob {
  id: string;
  kind: string;
  title: string;
  status: string;
  priority: number;
  boxId: string | null;
  attempts: number;
  maxAttempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  botId: string | null;
  botName: string | null;
  runner?: string;
}

/** providers/sweep-runs.ts SweepRunRow. */
export interface SweepRun {
  id: string;
  tenant: string;
  sweep: string;
  botId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
  findings: number | null;
  durationMs: number | null;
}

/** lib/sweep-jobs.ts SweepJob. */
export interface SweepJob {
  jobId: string;
  kind: 'sweep';
  sweep: string | null;
  title: string;
  state: string;
  detail: string | null;
  href: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const sweepName = (s: string) => s.replace(/_/g, ' ');

export function jobRows(jobs: readonly WorkJob[], sweeps: readonly SweepRun[]): LogRow[] {
  return newestFirst([
    ...jobs.map((j): LogRow => ({
      source: 'jobs', kind: AGENT_JOB, id: j.id, at: j.createdAt,
      subline: [j.title || j.kind, j.botName ? `by ${j.botName}` : 'agent job', j.status.replace(/_/g, ' ')].filter(Boolean).join(' · '),
    })),
    ...sweeps.map((r): LogRow => ({
      source: 'jobs', kind: SWEEP_RUN, id: r.id, at: r.startedAt,
      subline: [`The ${sweepName(r.sweep)} sweep`, r.status, r.findings == null ? null : plural(r.findings, 'finding'), r.durationMs == null ? null : took(r.durationMs)].filter(Boolean).join(' · '),
    })),
  ]);
}

export function agentJobRecord(j: WorkJob): LogRecord {
  const listed = Array.isArray(j.result?.['toolCallList']) ? j.result!['toolCallList'] as Array<{ name?: unknown; done?: unknown }> : [];
  const summary = typeof j.result?.['summary'] === 'string' ? j.result['summary'] as string : null;
  const cost = typeof j.result?.['costUsd'] === 'number' ? j.result['costUsd'] as number : null;
  return {
    source: 'jobs', kind: AGENT_JOB, id: j.id, label: j.title || `Job ${j.id}`,
    facts: [
      { label: 'Job', value: j.id, mono: true },
      { label: 'Title', value: j.title || j.kind },
      { label: 'Kind', value: j.kind },
      { label: 'Status', value: j.status.replace(/_/g, ' ') },
      { label: 'Queued', value: when(j.createdAt) },
      { label: 'Finished', value: j.finishedAt ? when(j.finishedAt) : 'not yet' },
      { label: 'Took', value: took(tookMs(j.startedAt ?? j.claimedAt ?? j.createdAt, j.finishedAt)) || 'open' },
      { label: 'Attempts', value: `${j.attempts} of ${j.maxAttempts}` },
      { label: 'Runner', value: [j.runner ?? 'fleet', j.boxId].filter(Boolean).join(' · ') },
      { label: 'Queued by', value: j.botName ? `the ${j.botName} bot` : j.createdBy ?? 'not recorded' },
      ...(cost != null ? [{ label: 'Cost', value: `$${cost.toFixed(4)}` }] : []),
      ...(summary ? [{ label: 'Result', value: summary }] : []),
      ...(j.error ? [{ label: 'Error', value: j.error }] : []),
    ],
    callsTitle: 'Tool calls',
    calls: listed.map((c, i) => ({ id: `${i}`, at: null, name: typeof c.name === 'string' ? c.name : 'tool', outcome: c.done === false ? 'running' : 'done', detail: '', tookMs: null })),
    events: lifecycleEvents([
      { at: j.createdAt, kind: 'queued', data: { priority: j.priority } },
      { at: j.claimedAt, kind: 'claimed', data: j.boxId ? { box: j.boxId } : undefined },
      { at: j.startedAt, kind: 'running' },
      { at: j.finishedAt, kind: j.status, data: j.error ? { error: j.error } : undefined },
    ]),
    raw: j,
  };
}

export function sweepRunRecord(r: SweepRun): LogRecord {
  return {
    source: 'jobs', kind: SWEEP_RUN, id: r.id, label: `The ${sweepName(r.sweep)} sweep`,
    facts: [
      { label: 'Sweep run', value: r.id, mono: true },
      { label: 'Sweep', value: sweepName(r.sweep) },
      { label: 'Workspace', value: r.tenant },
      { label: 'Status', value: r.status },
      { label: 'Started', value: when(r.startedAt) },
      { label: 'Finished', value: r.finishedAt ? when(r.finishedAt) : 'not yet' },
      { label: 'Took', value: took(r.durationMs) || 'open' },
      { label: 'Findings', value: r.findings == null ? 'not counted' : String(r.findings) },
      ...(r.botId ? [{ label: 'Bot', value: r.botId, mono: true }] : []),
      ...(r.error ? [{ label: 'Error', value: r.error }] : []),
    ],
    callsTitle: 'Steps',
    calls: [],
    events: lifecycleEvents([
      { at: r.startedAt, kind: 'running', data: { sweep: r.sweep } },
      { at: r.finishedAt, kind: r.status, data: r.error ? { error: r.error } : r.findings != null ? { findings: r.findings } : undefined },
    ]),
    raw: r,
  };
}

export function sweepJobRecord(j: SweepJob): LogRecord {
  return {
    source: 'jobs', kind: SWEEP_JOB, id: j.jobId, label: j.title,
    facts: [
      { label: 'Sweep job', value: j.jobId, mono: true },
      { label: 'Runs', value: j.title },
      { label: 'State', value: j.state },
      { label: 'Queued', value: when(j.queuedAt) },
      { label: 'Finished', value: j.finishedAt ? when(j.finishedAt) : 'not yet' },
      { label: 'Took', value: took(tookMs(j.startedAt ?? j.queuedAt, j.finishedAt)) || 'open' },
      ...(j.detail ? [{ label: 'Outcome', value: j.detail }] : []),
    ],
    callsTitle: 'Steps',
    calls: [],
    events: lifecycleEvents([
      { at: j.queuedAt, kind: 'queued', data: j.sweep ? { sweep: j.sweep } : { sweep: 'all' } },
      { at: j.startedAt, kind: 'running' },
      { at: j.finishedAt, kind: j.state, data: j.detail ?? undefined },
    ]),
    raw: j,
  };
}
