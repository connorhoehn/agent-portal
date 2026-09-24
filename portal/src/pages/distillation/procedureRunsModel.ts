// A procedure's Runs tab (spec §1 "procedure"): GET /procedures/:id/runs,
// each run carrying per-step outcomes, folded into
//   - the latest-run callout ("Latest run stopped at step 3 — <note>")
//   - the step list's markers (✓ done / ! failed / ○ pending / – skipped),
//     in the shape the library's `ProcedureSteps` takes
//   - run-history rows
// Pure: no React.

import { pgTimestampMs } from '../../lib/pgTimestamp.ts';
import type { ProcedureRun, ProcedureStepStatus } from './types.ts';

export interface ProcedureStepDef {
  id: string;
  title: string;
  body?: string;
  /** 1-based position; falls back to array order when absent. */
  ordinal?: number | null;
}

/** `ProcedureSteps` step shape (spec §2.1). */
export interface ProcedureStepMarker {
  id: string;
  title: string;
  body?: string;
  status?: ProcedureStepStatus;
  note?: string;
}

export const STEP_MARKER: Record<ProcedureStepStatus, string> = {
  done: '✓', failed: '!', pending: '○', skipped: '–',
};

export type RunOutcome = 'succeeded' | 'failed' | 'partial' | 'not-started';

export interface LatestRunCallout {
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  text: string;
  /** 1-based step the run failed on, when it did. */
  failedAtStep: number | null;
  at: string;
  actor: string | null;
}

export interface RunHistoryRow {
  id: string;
  at: string;
  actor: string | null;
  outcome: RunOutcome;
  /** "3 of 5 steps done" */
  summary: string;
  failedAtStep: number | null;
  note: string | null;
}

/** Steps in their procedure order (by ordinal, then as given). */
export function orderedSteps(steps: ProcedureStepDef[]): ProcedureStepDef[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.ordinal ?? a.i + 1) - (b.s.ordinal ?? b.i + 1) || a.i - b.i)
    .map(({ s }) => s);
}

/** Newest first; ties keep wire order. */
export function sortRuns(runs: ProcedureRun[]): ProcedureRun[] {
  return runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((pgTimestampMs(b.r.at) - pgTimestampMs(a.r.at)) || 0) || a.i - b.i)
    .map(({ r }) => r);
}

export function latestRun(runs: ProcedureRun[]): ProcedureRun | null {
  return sortRuns(runs)[0] ?? null;
}

/** A step the run does not mention was never reached: pending. */
function statusIn(run: ProcedureRun, stepId: string): ProcedureStepStatus {
  return run.steps.find((s) => s.step_id === stepId)?.status ?? 'pending';
}

function runKey(run: ProcedureRun, i: number): string {
  return run.id ?? `${run.at}#${i}`;
}

/** Steps with the latest run's outcome on each; no statuses when never run.
 *  The run's note sits under the step it failed on. */
export function stepMarkers(steps: ProcedureStepDef[], runs: ProcedureRun[]): ProcedureStepMarker[] {
  const ordered = orderedSteps(steps);
  const run = latestRun(runs);
  return ordered.map((s) => {
    const marker: ProcedureStepMarker = { id: s.id, title: s.title };
    if (s.body) marker.body = s.body;
    if (!run) return marker;
    marker.status = statusIn(run, s.id);
    if (marker.status === 'failed' && run.note) marker.note = run.note;
    return marker;
  });
}

function outcomeOf(steps: ProcedureStepDef[], run: ProcedureRun): { outcome: RunOutcome; failedAt: number | null; done: number } {
  const ordered = orderedSteps(steps);
  let done = 0;
  let failedAt: number | null = null;
  let anyReached = false;
  ordered.forEach((s, i) => {
    const st = statusIn(run, s.id);
    if (st === 'done') { done += 1; anyReached = true; }
    if (st === 'skipped') anyReached = true;
    if (st === 'failed' && failedAt === null) { failedAt = i + 1; anyReached = true; }
  });
  if (failedAt !== null) return { outcome: 'failed', failedAt, done };
  if (!anyReached) return { outcome: 'not-started', failedAt: null, done };
  const pending = ordered.some((s) => statusIn(run, s.id) === 'pending');
  return { outcome: pending ? 'partial' : 'succeeded', failedAt: null, done };
}

export function latestRunCallout(steps: ProcedureStepDef[], runs: ProcedureRun[]): LatestRunCallout | null {
  const run = latestRun(runs);
  if (!run) return null;
  const total = steps.length;
  const { outcome, failedAt, done } = outcomeOf(steps, run);
  const note = run.note?.trim();
  const base = { at: run.at, actor: run.actor, failedAtStep: failedAt };
  switch (outcome) {
    case 'failed':
      return { ...base, tone: 'danger', text: `Latest run stopped at step ${failedAt}${note ? ` — ${note}` : ''}` };
    case 'succeeded':
      return { ...base, tone: 'success', text: `Latest run completed all ${total} ${total === 1 ? 'step' : 'steps'}` };
    case 'partial':
      return { ...base, tone: 'warning', text: `Latest run reached ${done} of ${total} steps${note ? ` — ${note}` : ''}` };
    default:
      return { ...base, tone: 'neutral', text: `Latest run recorded no step outcomes${note ? ` — ${note}` : ''}` };
  }
}

export function runHistoryRows(steps: ProcedureStepDef[], runs: ProcedureRun[]): RunHistoryRow[] {
  const total = steps.length;
  return sortRuns(runs).map((run, i) => {
    const { outcome, failedAt, done } = outcomeOf(steps, run);
    return {
      id: runKey(run, i),
      at: run.at,
      actor: run.actor,
      outcome,
      summary: `${done} of ${total} ${total === 1 ? 'step' : 'steps'} done`,
      failedAtStep: failedAt,
      note: run.note,
    };
  });
}
