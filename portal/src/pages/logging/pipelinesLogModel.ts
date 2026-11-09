// Logging's Pipelines source (G37): the run projection, read where the
// tenant has it: /api/pipelines/runs in the pipelines tenant (ViewPipelines),
// the /api/runs façade in orgiq (the bot runs page's read gate). A run's
// record is its facts, its steps (GET …/:id/steps) and its event stream
// (GET …/:id/events, text/event-stream: the recorded history replayed as
// event-catalog frames, then live ones).

import { kindLabel, runHref, sourceLabel, type PipelineRun, type PipelineStep } from '../../lib/pipelineRuns.ts';
import { lifecycleEvents, newestFirst, plural, took, tookMs, usd4, when, type LogEvent, type LogRecord, type LogRow } from './loggingModel.ts';

export const PIPELINE_RUN = 'run';
export const pipelineRunsApi = (base: string): string => `${base}?limit=50`;
export const pipelineRunApi = (base: string, id: string): string => runHref(base, id);

/** One frame of `…/runs/:id/events` (lib/pipeline-runs.ts PipelineEvent; `replay` marks recorded history). */
export interface PipelineFrame { type: string; runId?: string; stepId?: string; at?: string | null; status?: string; detail?: string; replay?: boolean }

export function pipelineRows(runs: readonly PipelineRun[]): LogRow[] {
  return newestFirst(runs.map((r): LogRow => ({
    source: 'pipelines', kind: PIPELINE_RUN, id: r.id, at: r.startedAt ?? '',
    subline: [r.context.title, kindLabel(r.context.kind), r.status.replace(/_/g, ' '), r.context.tenant, r.costUsd == null ? null : usd4(r.costUsd)].filter(Boolean).join(' · '),
  })));
}

/** The event table from the stream's frames, in arrival order; the run and step names kept as the data. */
export function pipelineEventRows(frames: readonly PipelineFrame[]): LogEvent[] {
  return frames.map((f, i) => ({
    seq: i + 1, at: f.at ?? null, kind: f.type,
    data: [f.stepId ? `step ${f.stepId}` : null, f.status ? f.status.replace(/_/g, ' ') : null, f.detail ?? null, f.replay === false ? 'live' : null].filter(Boolean).join(' · '),
  }));
}

/**
 * A run: facts, the steps as the calls table (an agent run's attempts are its tool calls, named), and the events.
 * Until the stream has answered, the events are the steps' own start and end marks.
 */
export function pipelineRecord(run: PipelineRun, steps: readonly PipelineStep[], frames: readonly PipelineFrame[] | null): LogRecord {
  const c = run.context;
  return {
    source: 'pipelines', kind: PIPELINE_RUN, id: run.id, label: c.title || run.id,
    facts: [
      { label: 'Run', value: c.title || run.id },
      { label: 'Id', value: run.id, mono: true },
      { label: 'Definition', value: run.definitionId, mono: true },
      { label: 'Kind', value: kindLabel(c.kind) },
      { label: 'Workspace', value: c.tenant },
      { label: 'Status', value: `${run.status.replace(/_/g, ' ')}${c.sourceStatus && c.sourceStatus !== run.status ? ` (source ${c.sourceStatus.replace(/_/g, ' ')})` : ''}` },
      { label: 'Trigger', value: [run.triggerType, c.trigger].filter(Boolean).join(', ') },
      { label: 'Triggered by', value: run.triggeredByName ?? run.triggeredBy ?? 'not recorded' },
      { label: 'Started', value: run.startedAt ? when(run.startedAt) : 'not yet' },
      { label: 'Finished', value: run.finishedAt ? when(run.finishedAt) : 'not yet' },
      { label: 'Took', value: took(tookMs(run.startedAt, run.finishedAt)) || 'open' },
      { label: 'Cost', value: usd4(run.costUsd) },
      { label: 'Source', value: `${sourceLabel(c.table)} ${c.id}` },
      ...(c.initiativeName ? [{ label: 'Initiative', value: c.initiativeName }] : []),
      ...(c.error ? [{ label: 'Error', value: c.error }] : []),
      { label: 'Steps', value: plural(steps.length, 'step') },
    ],
    callsTitle: 'Steps',
    calls: steps.map((s) => ({
      id: s.stepId, at: s.startedAt, name: s.label, outcome: s.status.replace(/_/g, ' '),
      detail: [s.attempts.some((a) => a.label) ? s.attempts.map((a) => a.label ?? `attempt ${a.attempt}`).join(', ') : s.attempts.length > 1 ? plural(s.attempts.length, 'attempt') : null, s.detail ?? null].filter(Boolean).join(' · '),
      tookMs: tookMs(s.startedAt, s.finishedAt),
    })),
    events: frames ? pipelineEventRows(frames) : lifecycleEvents([
      { at: run.startedAt, kind: 'pipeline:run:started' },
      ...steps.flatMap((s) => [
        { at: s.startedAt, kind: 'pipeline:step:started', data: s.label },
        { at: s.finishedAt, kind: `pipeline:step:${s.status}`, data: s.label },
      ]),
      { at: run.finishedAt, kind: `pipeline:run:${run.status}` },
    ]),
    raw: { run, steps, events: frames ?? [] },
  };
}
