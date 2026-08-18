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
} from '@aws-sdk/client-bedrock-agentcore';

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
  costUsd: number;
  toolCalls: number;
  exitCode: number | null;
  error?: string;
  /** Bounded record of the run, for review after the event buffer rolls. */
  transcript: ActivityEntry[];
}

export interface DevboxRunOptions {
  sessionId: string;
  prompt: string;
  resume?: boolean;
  timeoutSeconds?: number;
  /** Called for every parsed stream event (already unwrapped). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Resolved runtime ARN + client injected by the caller so this module
   *  stays free of ARN-resolution and test-hook concerns. */
  runtimeArn: string;
  client: BedrockAgentCoreClient;
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
    ok: false, summary: '', turns: 0, durationMs: 0, costUsd: 0, toolCalls: 0, exitCode: null,
    transcript: [],
  };

  const record = (entry: ActivityEntry): void => {
    // Keep the head of the run rather than the tail: the first turns explain
    // what the agent decided to do, which is what a reviewer needs. The tail
    // is already summarised in `result`.
    if (outcome.transcript.length < TRANSCRIPT_MAX_ENTRIES) outcome.transcript.push(entry);
  };

  const payload = JSON.stringify({
    prompt: opts.prompt,
    resume: Boolean(opts.resume),
    ...(opts.timeoutSeconds ? { timeout: Math.min(opts.timeoutSeconds, 3300) } : {}),
  });

  try {
    const resp = await opts.client.send(new InvokeRuntime({
      agentRuntimeArn: opts.runtimeArn,
      qualifier: 'DEFAULT',
      runtimeSessionId: opts.sessionId,
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(payload),
    }));

    const stream = resp.response as AsyncIterable<Uint8Array> | undefined;
    if (!stream) {
      outcome.error = 'empty response stream';
      outcome.durationMs = Date.now() - started;
      return outcome;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
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

        const type = ev['type'];
        const ts = new Date().toISOString();
        if (type === 'assistant') {
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
          outcome.turns = Number(ev['num_turns'] ?? 0);
          outcome.costUsd = Number(ev['total_cost_usd'] ?? 0);
          if (typeof ev['result'] === 'string') outcome.summary = ev['result'];
          // subtype 'success' is Claude Code's own verdict for the run.
          outcome.ok = String(ev['subtype'] ?? '') === 'success';
        } else if (type === 'devbox_end') {
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
      }
    }
  } catch (err) {
    outcome.error = (err as Error).message;
  }

  outcome.durationMs = Date.now() - started;
  return outcome;
}
