// Relayed agent runs, open from RUN_STARTED (pipelines P1, docs/pipelines-tenant-goal.md).
//
// WHY THIS EXISTS. An agent run's durable record is its trace row, and that
// row arrives late: the deployed fleet's bundle reaches `invocation_traces`
// through the CloudWatch log poller (~30s, lib/cw-trace-ingest.ts), and a run
// that is still streaming has no bundle at all. Without this, a run the user
// is watching stream would not exist on the Runs page until well after it had
// finished. `routes/agents.ts` already relays every AG-UI event, so it records
// the run's open (RUN_STARTED → `running`), its STEP_* and TOOL_CALL_*, and its
// close (RUN_FINISHED → `completed`, RUN_ERROR → `failed`) here; the projection
// (lib/pipeline-runs.ts) shows a relayed run until a trace with the same AG-UI
// run id replaces it.
//
// WHAT IT IS NOT. Not a store: in memory, one process, bounded (the newest
// MAX_RUNS), and a restart forgets it — which loses nothing durable, because
// the trace row is the record and this is only the interval before it lands.
// The middleware runs as one task (CLAUDE.md, the realtime gateway note), so
// one process's view is the whole view.

import type { AgentStepRecord, LiveAgentRunSource } from './pipeline-runs.js';

const MAX_RUNS = 200;

/** Folds AG-UI events into steps + attempts — the TS twin of instrumentation.py's `observe_agui_event`. */
export class AguiStepRecorder {
  readonly steps: AgentStepRecord[] = [];
  private readonly inflight = new Map<string, AgentStepRecord['toolCalls'][number] & { claimed?: boolean }>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  observe(event: { type?: string } & Record<string, unknown>): void {
    const str = (...keys: string[]): string | undefined => {
      for (const k of keys) { const v = event[k]; if (typeof v === 'string' && v) return v; }
      return undefined;
    };
    switch (event.type) {
      case 'STEP_STARTED': {
        const name = (str('stepName', 'step_name') ?? 'step').slice(0, 200);
        const step: AgentStepRecord = {
          stepId: `${name}-${this.steps.length + 1}`, name, status: 'running',
          startedAt: this.now(), finishedAt: null, toolCalls: [],
        };
        // The supervisor opens a step right AFTER the TOOL_CALL_START it wraps.
        for (const call of this.inflight.values()) {
          if (!call.claimed) { call.claimed = true; step.toolCalls.push(call); }
        }
        this.steps.push(step);
        break;
      }
      case 'STEP_FINISHED': {
        const name = str('stepName', 'step_name') ?? 'step';
        const open = [...this.steps].reverse().find((s) => s.name === name && s.finishedAt === null);
        if (open) { open.finishedAt = this.now(); open.status = 'completed'; }
        break;
      }
      case 'TOOL_CALL_START': {
        const id = str('toolCallId', 'tool_call_id');
        if (!id) break;
        const call = { toolCallId: id, name: (str('toolCallName', 'tool_call_name') ?? 'unknown').slice(0, 200),
          status: 'running' as const, startedAt: this.now(), finishedAt: null, claimed: false };
        this.inflight.set(id, call);
        const open = [...this.steps].reverse().find((s) => s.finishedAt === null);
        if (open) { call.claimed = true; open.toolCalls.push(call); }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const id = str('toolCallId', 'tool_call_id');
        const call = id ? this.inflight.get(id) : undefined;
        if (call && id) { call.status = 'completed'; call.finishedAt = this.now(); this.inflight.delete(id); }
        break;
      }
      case 'RUN_ERROR': this.fail(); break;
      default: break;
    }
  }

  /** Every open step and in-flight call ends `failed` (a RUN_ERROR, or a stream that threw). */
  fail(): void {
    const at = this.now();
    for (const call of this.inflight.values()) { call.status = 'failed'; call.finishedAt = at; }
    this.inflight.clear();
    for (const s of this.steps) if (s.finishedAt === null) { s.status = 'failed'; s.finishedAt = at; }
  }

  /** Wire shape — the bookkeeping flag stripped. */
  snapshot(): AgentStepRecord[] {
    return this.steps.map((s) => ({
      ...s,
      toolCalls: s.toolCalls.map(({ toolCallId, name, status, startedAt, finishedAt }) => ({ toolCallId, name, status, startedAt, finishedAt })),
    }));
  }
}

interface LiveRun {
  source: Omit<LiveAgentRunSource, 'steps'>;
  recorder: AguiStepRecorder;
}

const runs = new Map<string, LiveRun>();

/** RUN_STARTED: the run exists, `running`. */
export function openAgentRun(init: {
  runId: string; threadId: string | null; agentId: string; agentName: string;
  userId: string | null; tenant: string | null; prompt: string | null; startedAt?: string;
}): void {
  runs.delete(init.runId);
  runs.set(init.runId, {
    source: { ...init, prompt: init.prompt ? init.prompt.slice(0, 500) : null,
      startedAt: init.startedAt ?? new Date().toISOString(), status: 'running', finishedAt: null, error: null },
    recorder: new AguiStepRecorder(),
  });
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
}

/** A relayed STEP_* / TOOL_CALL_* event. Unknown run ids are ignored. */
export function recordAgentRunEvent(runId: string, event: { type?: string } & Record<string, unknown>): void {
  runs.get(runId)?.recorder.observe(event);
}

/** RUN_FINISHED (`completed`) or RUN_ERROR / a thrown stream (`failed`). */
export function closeAgentRun(runId: string, outcome: 'completed' | 'failed', error?: string | null): void {
  const run = runs.get(runId);
  if (!run || run.source.status !== 'running') return;
  if (outcome === 'failed') run.recorder.fail();
  run.source = { ...run.source, status: outcome, finishedAt: new Date().toISOString(), error: error ? error.slice(0, 500) : null };
}

/** The relayed runs, newest first, for the projection. */
export function liveAgentRuns(): LiveAgentRunSource[] {
  return [...runs.values()].reverse().map((r) => ({ ...r.source, steps: r.recorder.snapshot() }));
}

/** Tests only. */
export function _resetLiveAgentRunsForTest(): void {
  runs.clear();
}
