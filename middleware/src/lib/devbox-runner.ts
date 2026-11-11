// Shared devbox task execution.
//
// The portal's SSE route and the job dispatcher must run tasks the SAME way —
// otherwise queue work would drift from hand-driven work (different payload
// shape, different event parsing, different failure semantics). This module is
// the single implementation; the route streams its events to a browser, the
// dispatcher records them into the fleet log and summarises the outcome.

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand as InvokeRuntime,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  parseReportedCost, parseResultUsage, resultEventError, resultEventFailureCode, resultEventSucceeded, settleRunCost, type CostBasis,
} from './run-cost.js';
import { estimateUsageCost } from './model-prices.js';
import type { TokenUsage } from './pricing.js';
import { clampTaskTimeout } from './devbox-lifetime.js';
import { RunCutoffError, anySignal, cutoffGraceMs, cutoffMessage, type RunCutoff, type RunMeter } from './run-meter.js';
import { skillsLoadedByEvent } from './run-reports/use-detection.js';

/**
 * One line of what the worker actually did.
 *
 * The fleet event log is an in-memory ring buffer, so it cannot answer "what
 * did this job do?" once the buffer rolls or the process restarts. A job is
 * reviewed minutes-to-hours after it ran, so the transcript has to outlive
 * the stream — this is the durable, bounded record that gets stored with the
 * job and rendered on its detail page.
 */
export interface ActivityEntry {
  /** 'text' = assistant prose, 'tool' = a tool invocation, 'error' = failure. */
  t: 'text' | 'tool' | 'error';
  /** Tool name, for 'tool' entries. */
  name?: string;
  detail: string;
  ts: string;
}

/** Bounds — a runaway agent must not write an unbounded blob into Aurora. */
const TRANSCRIPT_MAX_ENTRIES = 200;
const TRANSCRIPT_MAX_DETAIL = 600;

function clip(v: unknown, max = TRANSCRIPT_MAX_DETAIL): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface DevboxRunOutcome {
  ok: boolean;
  /** Claude Code's final answer text, when the run produced one. */
  summary: string;
  turns: number;
  durationMs: number;
  /**
   * What the run cost, or `null` when no trustworthy figure arrived.
   *
   * `null`, never `0`. This used to be `Number(ev['total_cost_usd'] ?? 0)`,
   * which turned "the result event carried no cost" into a countable zero —
   * the exact value `lib/pricing.ts` spends thirty lines arguing must never be
   * recorded, because a 0 beside real token counts reads as *free* rather than
   * as unpriced. It spends nobody's envelope and trips none of the three
   * brakes in `bot-runner.ts`.
   *
   * Every consumer already handles null: `providers/bots.ts` writes
   * `cost_usd = COALESCE(:cost, cost_usd)`, `providers/budgets.ts` filters on
   * `cost_usd IS NOT NULL`, and `agent_run_attribution_schema.sql` states the
   * doctrine outright — degrade to "burn unknown", never to "burn zero".
   *
   * A run served by a LOCAL model reports a figure that is present, non-zero
   * and fictional (Claude Code prices it from its own table at Sonnet rates for
   * tokens that cost nothing). That is not fixable here — this module only ever
   * sees AgentCore runs, so what it reports is genuinely billed. `lib/run-cost.ts`
   * owns that rule, and both parsers below live there so the fleet's independent
   * copy cannot drift from this one again.
   */
  costUsd: number | null;
  /**
   * Where `costUsd` came from (DE-32). `reported` is Claude Code's own
   * `total_cost_usd`; `estimated` is the `result` event's `usage` priced
   * through `lib/model-prices.ts` when no figure was reported; `unknown` is
   * null. DE-30's writers pass it straight through to `spend_entries`.
   */
  costBasis: CostBasis;
  /** The table's figure, kept beside the reported one for the drift check; null when unpriceable. */
  estimatedCostUsd: number | null;
  /** The model the runtime announced on `devbox_start`, else the one requested, else null. */
  model: string | null;
  /** The `result` event's usage block, when it carried one. */
  usage: TokenUsage | null;
  toolCalls: number;
  exitCode: number | null;
  error?: string;
  /** A validated terminal_reason from a failed result; error retains the full detail. */
  failureCode?: string;
  /** Bounded record of the run, for review after the event buffer rolls. */
  transcript: ActivityEntry[];
  /** DE-35: set when the run was stopped at its spend ceiling. */
  cutoff?: RunCutoff;
  /**
   * Skills the session was seen loading (a `Skill` tool call, or a read of a skill's
   * SKILL.md), from the runner's own stream-json events — the run report's observed
   * use (lib/run-reports/use-detection.ts). Distinct, in first-load order.
   */
  skillsLoaded?: string[];
  /** The Claude Code session the run ended in, when the runtime says (devbox_end's `claude_session_id`); a debrief resumes it. */
  claudeSessionId?: string | null;
}

export interface DevboxRunOptions {
  signal?: AbortSignal;
  sessionId: string;
  prompt: string;
  resume?: boolean;
  timeoutSeconds?: number;
  /** Bedrock inference-profile id. Omitted = the runtime's default (Haiku). */
  model?: string;
  /** Called for every parsed stream event (already unwrapped). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Resolved runtime ARN + client injected by the caller so this module
   *  stays free of ARN-resolution and test-hook concerns. */
  runtimeArn: string;
  client: BedrockAgentCoreClient;
  /**
   * The run this task is (lib/run-brief.ts): sent as `lab` in the invoke
   * payload, which agents/devbox/main.py turns into the LAB_* env every `lab`
   * call reads — LAB_RUN_REF + LAB_RUN_TOKEN for `lab brief`, `lab applied`
   * and `lab propose`, plus attribution. Absent → the box has no run brief.
   */
  lab?: DevboxLabContext;
  /**
   * The mid-run meter (DE-35, lib/run-meter.ts). Every parsed event is fed to
   * it; when it cuts, the invoke is aborted (closing the stream, which the box
   * turns into a process-group kill) and the run returns `ok: false` with
   * `cutoff`. Its token ceiling rides the payload as `budget`.
   */
  meter?: RunMeter | null;
  /**
   * Layer 3: after a cut with no `devbox_end` seen, wait `graceMs` (default
   * RUN_CUTOFF_GRACE_MS, 30 s) and stop the runtime session — the reaper's
   * StopRuntimeSession. `onStopped` runs after a successful stop.
   */
  cutoffBackstop?: { stop: () => Promise<void>; graceMs?: number; onStopped?: () => void };
}

/** Stop one runtime session (the cutoff backstop's AWS call lives here with the other devbox transport). */
export async function stopDevboxSession(client: BedrockAgentCoreClient, runtimeArn: string, sessionId: string): Promise<void> {
  // Mocked AgentCore has no runtime session to stop.
  // Lazy: config.ts cannot load statically under the CommonJS test build.
  const { config } = await import('../config.js');
  if (config.mock.agentcore) return;
  await client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: runtimeArn, runtimeSessionId: sessionId }));
}

/**
 * Stop a cut run's session after the grace period unless it ended on its own
 * (DE-35 layer 3). Fire-and-forget, unref'd; once per cut.
 */
export function scheduleCutoffBackstop(
  backstop: NonNullable<DevboxRunOptions['cutoffBackstop']>,
  ended: () => boolean,
  onEvent?: (event: Record<string, unknown>) => void,
): void {
  const timer = setTimeout(() => {
    if (ended()) return;
    void backstop.stop()
      .then(() => {
        try { onEvent?.({ type: 'devbox_reaped', reason: 'budget', ts: new Date().toISOString() }); } catch { /* best effort */ }
        backstop.onStopped?.();
      })
      .catch((err: unknown) => console.warn('[devbox] cutoff session stop failed:', (err as Error).message));
  }, backstop.graceMs ?? cutoffGraceMs());
  timer.unref?.();
}

export interface DevboxLabContext {
  run_ref: string;
  run_token: string;
  brief_id: string;
  work_item_id: string | null;
  initiative_id: string | null;
  repo: string | null;
  session_id: string;
  box_id: string | null;
}

/**
 * Run one Claude Code task in a devbox session and summarise the outcome.
 *
 * Never throws for agent-side failures — a failed run is a value
 * (`ok: false` + `error`), because the dispatcher must record it as a job
 * failure rather than crash a tick.
 */
export async function executeDevboxTask(opts: DevboxRunOptions): Promise<DevboxRunOutcome> {
  const started = Date.now();
  const outcome: DevboxRunOutcome = {
    ok: false, summary: '', turns: 0, durationMs: 0, costUsd: null, costBasis: 'unknown', estimatedCostUsd: null,
    model: opts.model ?? null, usage: null, toolCalls: 0, exitCode: null,
    transcript: [], skillsLoaded: [],
  };

  const record = (entry: ActivityEntry): void => {
    // Keep the head of the run rather than the tail: the first turns explain
    // what the agent decided to do, which is what a reviewer needs. The tail
    // is already summarised in `result`.
    if (outcome.transcript.length < TRANSCRIPT_MAX_ENTRIES) outcome.transcript.push(entry);
  };

  const budget = opts.meter?.boxBudget(opts.lab?.run_ref ?? opts.sessionId) ?? null;
  const payload = JSON.stringify({
    prompt: opts.prompt,
    resume: Boolean(opts.resume),
    ...(opts.model ? { model: opts.model } : {}),
    // The one cap (DE-48, lib/devbox-lifetime.ts); the image repeats it as its
    // own defence.
    ...(opts.timeoutSeconds ? { timeout: clampTaskTimeout(opts.timeoutSeconds) } : {}),
    ...(opts.lab ? { lab: opts.lab } : {}),
    ...(budget ? { budget } : {}),
  });

  const meter = opts.meter ?? null;
  const signal = anySignal([opts.signal, meter?.signal]);
  let endSeen = false;
  let resultSeen = false;
  let boxBudgetKill = false;

  try {
    signal?.throwIfAborted();
    const resp = await opts.client.send(new InvokeRuntime({
      agentRuntimeArn: opts.runtimeArn,
      qualifier: 'DEFAULT',
      runtimeSessionId: opts.sessionId,
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(payload),
    }), ...(signal ? [{ abortSignal: signal }] : []));

    const stream = resp.response as AsyncIterable<Uint8Array> | undefined;
    if (!stream) {
      outcome.error = 'empty response stream';
      outcome.durationMs = Date.now() - started;
      return outcome;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) line = line.slice(5).trim();
        // Unwrap double-encoded frames (`data: "{\"type\"..."`).
        if (line.startsWith('"')) {
          try {
            const inner: unknown = JSON.parse(line);
            if (typeof inner === 'string') line = inner.trim();
          } catch { /* not JSON — skipped below */ }
        }
        if (!line.startsWith('{')) continue;

        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        opts.onEvent?.(ev);
        meter?.observe(ev);

        const type = ev['type'];
        const ts = new Date().toISOString();
        if (type === 'devbox_start') {
          // The runtime's own announcement of the model it resolved to — the
          // id the price table is keyed by (an inference-profile id in the
          // cloud), ahead of whatever the caller asked for.
          if (typeof ev['model'] === 'string' && ev['model']) outcome.model = ev['model'];
        } else if (type === 'assistant') {
          for (const name of skillsLoadedByEvent(ev)) {
            if (!outcome.skillsLoaded!.includes(name) && outcome.skillsLoaded!.length < 50) outcome.skillsLoaded!.push(name);
          }
          const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
          for (const block of content) {
            if (block['type'] === 'tool_use') {
              outcome.toolCalls += 1;
              const name = String(block['name'] ?? 'tool');
              const input = block['input'] as Record<string, unknown> | undefined;
              // Prefer the field that says what the call is aimed at — a bare
              // JSON dump of the input is unreadable in a review context.
              const target = input?.['command'] ?? input?.['file_path'] ?? input?.['path']
                ?? input?.['pattern'] ?? input?.['prompt'] ?? input;
              record({ t: 'tool', name, detail: clip(target), ts });
            } else if (block['type'] === 'text') {
              const text = String(block['text'] ?? '').trim();
              if (text) record({ t: 'text', detail: clip(text), ts });
            }
          }
        } else if (type === 'result') {
          resultSeen = true;
          outcome.turns = Number(ev['num_turns'] ?? 0);
          // Reported figure first; when Claude Code reports none, the usage
          // block priced through the table (DE-32), each cache bucket at its
          // own rate; else unknown. The estimate is kept beside a reported
          // figure so the two can be compared later.
          outcome.usage = parseResultUsage(ev);
          const estimated = outcome.usage && outcome.model ? estimateUsageCost(outcome.model, outcome.usage) : null;
          const settled = settleRunCost(parseReportedCost(ev), estimated);
          outcome.costUsd = settled.costUsd;
          outcome.costBasis = settled.costBasis;
          outcome.estimatedCostUsd = settled.estimatedCostUsd;
          if (typeof ev['result'] === 'string') outcome.summary = ev['result'];
          outcome.ok = resultEventSucceeded(ev);
          outcome.failureCode = resultEventFailureCode(ev);
          if (!outcome.ok) {
            const err = resultEventError(ev);
            if (err) {
              outcome.error ??= err;
              record({ t: 'error', detail: err, ts });
            }
          }
        } else if (type === 'devbox_end') {
          endSeen = true;
          if (typeof ev['claude_session_id'] === 'string' && ev['claude_session_id']) outcome.claudeSessionId = ev['claude_session_id'];
          // The box's own token ceiling (DE-35 layer 1) fired.
          if (ev['killed_reason'] === 'budget') boxBudgetKill = true;
          outcome.exitCode = (ev['exit_code'] ?? null) as number | null;
          if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
            outcome.ok = false;
            outcome.error ??= `devbox exited ${outcome.exitCode}`;
          }
        } else if (type === 'devbox_error') {
          outcome.ok = false;
          outcome.error = String(ev['error'] ?? 'devbox error');
          record({ t: 'error', detail: clip(outcome.error), ts });
        }
        // The meter cut on this event: stop reading now (the abort has
        // already gone to the SDK, which closes the stream).
        if (meter?.cutoff) throw new RunCutoffError(meter.cutoff);
      }
    }
  } catch (err) {
    if (!(err instanceof RunCutoffError) && !meter?.cutoff) outcome.error = (err as Error).message;
  }

  // A top-up still being decided lands before the caller writes the ledger
  // entry that settles it.
  if (meter) await meter.settled();
  const cutoff: RunCutoff | null = meter?.cutoff ?? (boxBudgetKill ? {
    reason: 'budget', ceilingUsd: meter?.ceilingUsd ?? 0, meteredUsd: meter?.meteredUsd ?? 0,
    holdIds: meter?.holdIds ?? [], at: new Date().toISOString(),
  } : null);
  if (cutoff) {
    outcome.ok = false;
    outcome.cutoff = cutoff;
    outcome.error = cutoffMessage(cutoff);
    record({ t: 'error', detail: outcome.error, ts: new Date().toISOString() });
    // No result arrived: the metered figure, labelled an estimate.
    if (!resultSeen && meter && meter.meteredUsd > 0) {
      outcome.costUsd = meter.meteredUsd;
      outcome.costBasis = 'estimated';
      outcome.estimatedCostUsd = meter.meteredUsd;
    }
    try {
      opts.onEvent?.({ type: 'run_cutoff', ...cutoff, ts: new Date().toISOString() });
    } catch { /* the tee is best effort */ }
    if (opts.cutoffBackstop && !endSeen) scheduleCutoffBackstop(opts.cutoffBackstop, () => endSeen, opts.onEvent);
  }

  outcome.durationMs = Date.now() - started;
  return outcome;
}
