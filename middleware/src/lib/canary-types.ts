// Shared canary types — used by the canary router, broker, judge dispatcher,
// EMF emitter, and (downstream) the canary SSE routes.
//
// Two version labels: 'A' (stable / control) and 'B' (canary / candidate).
// Weight `weight_b` is the percentage (0..100) of traffic routed to B.
//
// Events flow through `canary-broker.ts`:
//   - invocation_started → emitted by the middleware proxy after picking a version
//   - invocation_complete → emitted when the upstream agent reply lands
//   - judge_score → emitted asynchronously when the canary judge finishes
//   - weight_changed → emitted whenever weight_b is mutated (controller, manual, halt)
//   - decision → emitted by the promote/rollback controller (or skip reasons)

export type CanaryVersionLabel = 'A' | 'B';

export type CanaryEvent =
  | {
      type: 'invocation_started';
      request_id: string;
      version_arn: string;
      version_label: CanaryVersionLabel;
      question: string;
      ts: string;
    }
  | {
      type: 'invocation_complete';
      request_id: string;
      latency_ms: number;
      response_preview: string;
      ts: string;
    }
  | {
      type: 'judge_score';
      request_id: string;
      scores: {
        helpfulness: number;
        factuality: number;
        tone: number;
        conciseness: number;
      };
      composite: number;
      ts: string;
    }
  | {
      type: 'weight_changed';
      weight_b: number;
      source: 'controller' | 'manual' | 'halt';
      ts: string;
    }
  | {
      type: 'decision';
      action:
        | 'PROMOTE'
        | 'ROLLBACK'
        | 'HOLD'
        | 'SKIPPED_OVERRIDE'
        | 'SKIPPED_COOLDOWN'
        | 'SKIPPED_NO_SAMPLES';
      weight_b_before: number;
      weight_b_after: number;
      composite_a?: number;
      composite_b?: number;
      reason: string;
      ts: string;
    };

export interface CanaryControlState {
  manual_override_until: string;
  cooldown_until: string;
  halted: boolean;
}
