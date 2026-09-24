// Activity (spec §1 "Activity"): compaction runs as compact rows, the run
// inspector's facts, the tier graph's edge captions, and the replication
// status line.
//
// Two denominators never mix: a run's "13 run notes → 4 patterns" is that
// job's own input/output count; the tier totals belong to the tier-flow strip
// (tierFlowModel). Produced rows come from the job's OWN output ids — never a
// sample of the tier.
//
// Pure: no React.

import { parsePgTimestamp } from '../../lib/pgTimestamp.ts';
import { usd } from '../../lib/format.ts';
import { agoLabel } from './tierFlowModel.ts';
import type { ActivityState } from './distillationRoutes.ts';
import type { CompactionRun, Level, ReplicationResponse } from './types.ts';

export type RunTone = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'pending';

const FROM_NOUN: Record<'L1' | 'L2', [string, string]> = {
  L1: ['run note', 'run notes'],
  L2: ['pattern', 'patterns'],
};
const TO_NOUN: Record<'L1' | 'L2', [string, string]> = {
  L1: ['pattern', 'patterns'],
  L2: ['guide', 'guides'],
};

function plural(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`;
}

function compactLevel(level: Level): 'L1' | 'L2' {
  return level === 'L2' ? 'L2' : 'L1';
}

/** "Run notes → Patterns" / "Patterns → Guides & findings". */
export function transformationLabel(level: Level): string {
  return compactLevel(level) === 'L1' ? 'Run notes → Patterns' : 'Patterns → Guides & findings';
}

/** The tier a job's inputs live in, and the tier its outputs land in. */
export function inputLevel(level: Level): Level { return compactLevel(level) === 'L1' ? 'L0' : 'L1'; }
export function outputLevel(level: Level): Level { return compactLevel(level); }

export function runStatus(status: CompactionRun['status']): { label: string; tone: RunTone } {
  switch (status) {
    case 'queued': return { label: 'Queued', tone: 'pending' };
    case 'running': return { label: 'Running', tone: 'info' };
    case 'succeeded': return { label: 'Completed', tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'error' };
    default: return { label: String(status), tone: 'neutral' };
  }
}

export function inputCount(job: CompactionRun): number {
  return job.input_ids?.length ?? job.inputItems;
}

export function outputCount(job: CompactionRun): number {
  return job.output_ids?.length ?? job.outputItems;
}

/** "13 run notes → 4 patterns"; a queued job has no output yet. */
export function ioLabel(job: CompactionRun): string {
  const lv = compactLevel(job.level);
  const input = plural(inputCount(job), FROM_NOUN[lv]);
  if (job.status === 'queued' || (job.status === 'running' && outputCount(job) === 0)) return `${input} → …`;
  return `${input} → ${plural(outputCount(job), TO_NOUN[lv])}`;
}

/** Wall time: the server's `duration_ms`, else finished − started; null while
 *  running or unknown. */
export function durationMs(job: CompactionRun): number | null {
  if (typeof job.duration_ms === 'number') return job.duration_ms;
  if (!job.finishedAt) return null;
  const a = parsePgTimestamp(job.startedAt);
  const b = parsePgTimestamp(job.finishedAt);
  if (!a || !b) return null;
  return Math.max(0, b.getTime() - a.getTime());
}

export function durationText(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function costOf(job: CompactionRun): number | null {
  if (typeof job.cost_usd === 'number') return job.cost_usd;
  return typeof job.costUsd === 'number' ? job.costUsd : null;
}

/** The inspector's key-values. Fractions of a cent keep 4 decimals — at 2dp
 *  every pass reads "$0.00" and the column says nothing. */
export function runFacts(job: CompactionRun): Array<{ label: string; value: string }> {
  const lv = compactLevel(job.level);
  const cost = costOf(job);
  return [
    { label: 'Input', value: plural(inputCount(job), FROM_NOUN[lv]) },
    { label: 'Output', value: job.status === 'queued' ? 'Not started' : plural(outputCount(job), TO_NOUN[lv]) },
    { label: 'Duration', value: job.status === 'running' ? 'Running' : durationText(durationMs(job)) },
    { label: 'Cost', value: cost == null ? '—' : usd(cost, { precision: 4 }) },
  ];
}

/** What the job made, with the tier each id lives in. `output_ids` when the
 *  server sends them, else the older `produced` split. */
export function producedRefs(job: CompactionRun): Array<{ id: string; level: Level }> {
  if (job.output_ids && job.output_ids.length > 0) {
    const lv = outputLevel(job.level);
    return job.output_ids.map((id) => ({ id, level: lv }));
  }
  const p = job.produced;
  if (!p) return [];
  return [
    ...p.cluster_ids.map((id) => ({ id, level: 'L1' as Level })),
    ...p.artifact_ids.map((id) => ({ id, level: 'L2' as Level })),
  ];
}

export function inputRefs(job: CompactionRun): Array<{ id: string; level: Level }> {
  const lv = inputLevel(job.level);
  return (job.input_ids ?? []).map((id) => ({ id, level: lv }));
}

/** One sentence: the server's `what_changed`, else the error, else a line
 *  built from the counts (never invented detail). */
export function whatChanged(job: CompactionRun): string {
  if (job.what_changed) return job.what_changed;
  if (job.status === 'failed') return job.error ?? 'Failed without an error message.';
  if (job.status === 'queued') return 'Waiting for the queue to hand it to a worker.';
  if (job.status === 'running') return job.stepLabel ?? job.phase ?? 'In progress.';
  return `${ioLabel(job)}.`;
}

export interface RunLogLine {
  id: string;
  timestamp?: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export function logLines(job: CompactionRun): RunLogLine[] {
  return (job.log ?? []).map((l, i) => ({
    id: `${job.id}-${i}`,
    timestamp: l.at,
    level: l.level === 'warn' || l.level === 'error' || l.level === 'debug' ? l.level : 'info',
    message: l.message,
  }));
}

/** The raw ids a technical reader wants, as plain text for TechnicalDetails. */
export function runTechnicalText(job: CompactionRun): string {
  const lines = [
    `id: ${job.id}`,
    `level: ${job.level} (${inputLevel(job.level)} → ${outputLevel(job.level)})`,
    `status: ${job.status}`,
    `started: ${job.startedAt}`,
    `finished: ${job.finishedAt ?? '—'}`,
    job.repo ? `repo: ${job.repo}` : null,
    `input_ids: ${(job.input_ids ?? []).join(', ') || '—'}`,
    `output_ids: ${(job.output_ids ?? producedRefs(job).map((r) => r.id)).join(', ') || '—'}`,
    job.error ? `error: ${job.error}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── Run list ─────────────────────────────────────────────────────────────

export type RunGroup = 'active' | 'recent' | 'earlier';

export const RUN_GROUPS: ReadonlyArray<{ id: RunGroup; title: string }> = [
  { id: 'active', title: 'In progress' },
  { id: 'recent', title: 'Last 24 hours' },
  { id: 'earlier', title: 'Earlier' },
];

export interface RunRow {
  id: string;
  groupId: RunGroup;
  title: string;
  /** "13 run notes → 4 patterns · 3h ago" */
  subline: string;
  status: { label: string; tone: RunTone };
  level: Level;
}

export function filterRuns(jobs: CompactionRun[], f: Pick<ActivityState, 'level' | 'status' | 'repo'>): CompactionRun[] {
  return jobs.filter((j) => {
    if (f.level && j.level !== f.level) return false;
    if (f.status && j.status !== f.status) return false;
    // A job with no repo ran across every repository; it stays in scope.
    if (f.repo && j.repo && j.repo !== f.repo) return false;
    return true;
  });
}

export function runRows(jobs: CompactionRun[], nowMs: number): RunRow[] {
  return [...jobs]
    .sort((a, b) => (parsePgTimestamp(b.startedAt)?.getTime() ?? 0) - (parsePgTimestamp(a.startedAt)?.getTime() ?? 0) || a.id.localeCompare(b.id))
    .map((j) => {
      const started = parsePgTimestamp(j.startedAt)?.getTime() ?? 0;
      const groupId: RunGroup = j.status === 'running' || j.status === 'queued'
        ? 'active'
        : nowMs - started <= 86_400_000 ? 'recent' : 'earlier';
      const ago = agoLabel(j.startedAt, nowMs);
      return {
        id: j.id,
        groupId,
        title: transformationLabel(j.level),
        subline: [ioLabel(j), ago ? `started ${ago}` : null].filter(Boolean).join(' · '),
        status: runStatus(j.status),
        level: j.level,
      };
    });
}

// ── Tier graph captions ──────────────────────────────────────────────────

/** Latest finished job on an edge, for its caption: "13 notes → 4 patterns ·
 *  3h ago". Null when the edge has never completed a run. */
export function edgeDetail(jobs: CompactionRun[], level: 'L1' | 'L2', nowMs: number): string | null {
  const done = jobs
    .filter((j) => j.level === level && (j.status === 'succeeded' || j.status === 'failed'))
    .sort((a, b) => (parsePgTimestamp(b.finishedAt ?? b.startedAt)?.getTime() ?? 0) - (parsePgTimestamp(a.finishedAt ?? a.startedAt)?.getTime() ?? 0));
  const j = done[0];
  if (!j) return null;
  const ago = agoLabel(j.finishedAt ?? j.startedAt, nowMs);
  const what = j.status === 'failed' ? 'failed' : `${inputCount(j)} → ${outputCount(j)}`;
  return [what, ago].filter(Boolean).join(' · ');
}

// ── Replication ──────────────────────────────────────────────────────────

/** "Replicas in sync" / "1 of 2 replicas drifting · 3 s behind" / null when
 *  the server did not answer (unknown is not "in sync"). */
export function replicationLine(rep: ReplicationResponse | null | undefined): { text: string; tone: 'success' | 'warning' } | null {
  if (!rep || !Array.isArray(rep.replicas)) return null;
  const n = rep.replicas.length;
  if (n === 0) return null;
  const primary = rep.primary?.digest;
  const drifting = rep.replicas.filter((r) => (primary && r.digest ? r.digest !== primary : false) || (r.lagMs ?? 0) > 5_000);
  if (rep.inSync === true && drifting.length === 0) {
    return { text: n === 1 ? 'Replica in sync' : `${n} replicas in sync`, tone: 'success' };
  }
  const worst = Math.max(0, ...rep.replicas.map((r) => r.lagMs ?? 0));
  const count = drifting.length || n;
  return {
    text: `${count} of ${n} ${n === 1 ? 'replica' : 'replicas'} drifting${worst > 0 ? ` · ${durationText(worst)} behind` : ''}`,
    tone: 'warning',
  };
}
