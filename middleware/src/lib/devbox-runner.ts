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
        if (type === 'assistant') {
          const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
          for (const block of content) {
            if (block['type'] === 'tool_use') outcome.toolCalls += 1;
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
        }
      }
    }
  } catch (err) {
    outcome.error = (err as Error).message;
  }

  outcome.durationMs = Date.now() - started;
  return outcome;
}
