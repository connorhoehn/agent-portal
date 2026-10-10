// A run's recorded history as activity rows, and the merge with the gateway's
// live rows. The gateway's activity history is a per-process ring that only
// fills as a run moves, so a run that finished before the page opened (or
// before the process started) would read "No recent activity" even though its
// record names every step. This mirrors middleware `runEvents` over the run
// and steps the page already read, in the same `run.<status>` /
// `step.<status>` vocabulary the BFF publishes live (lib/gateway-run-feed.ts),
// so a live row and its recorded twin collapse into one.
//
// Pure, no React: runs under plain `node --test`.

import type { PipelineRun, PipelineStep } from '../../lib/pipelineRuns.ts';

export interface FeedEvent {
  eventType: string;
  detail: Record<string, unknown>;
  timestamp: string;
  userId: string | null;
  displayName: string;
}

const at = (iso: string | null | undefined, fallback: string): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
};

export function recordedRunActivity(run: PipelineRun, steps: readonly PipelineStep[]): FeedEvent[] {
  const base = at(run.startedAt, new Date(0).toISOString());
  const row = (eventType: string, when: string | null | undefined, detail: Record<string, unknown>): FeedEvent =>
    ({ eventType, detail: { runId: run.id, ...detail }, timestamp: at(when, base), userId: null, displayName: 'System' });
  const out: FeedEvent[] = [row('run.started', run.startedAt, { status: 'running' })];
  for (const s of steps) {
    if (s.status === 'pending') continue;
    out.push(row('step.started', s.startedAt, { stepId: s.stepId, label: s.label }));
    if (s.status === 'running' || s.status === 'awaiting_approval') continue;
    out.push(row(`step.${s.status}`, s.finishedAt ?? s.startedAt, { stepId: s.stepId, label: s.label, ...(s.detail ? { detail: s.detail } : {}) }));
  }
  if (run.finishedAt || ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status)) {
    // A run with no finish time ends no earlier than its last step did.
    const lastStep = steps.map(s => s.finishedAt ?? s.startedAt).filter((t): t is string => !!t).sort().at(-1);
    out.push(row(`run.${run.status}`, run.finishedAt ?? lastStep, { status: run.status, ...(run.context.error ? { error: run.context.error } : {}) }));
  }
  return out;
}

const key = (e: FeedEvent): string => `${e.eventType}|${String(e.detail['stepId'] ?? '')}`;

/**
 * Recorded history under live rows. A live row wins over its recorded twin
 * (same type and step); the result is oldest first, the order the feed reads.
 */
export function mergeActivity(recorded: readonly FeedEvent[], live: readonly FeedEvent[]): FeedEvent[] {
  const liveKeys = new Set(live.map(key));
  const kept = recorded.filter(e => !liveKeys.has(key(e)));
  return [...kept, ...live].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
