// Canary deployment shared type contract.
//
// This file is consumed by BOTH the canary store/hook/UI layer AND the
// individual ReactFlow node components in ./nodes/*.tsx. Keep the shape
// stable — both sides import from this single source of truth.

export type CanaryVersionLabel = 'A' | 'B';

export type ControllerAction =
  | 'PROMOTE'
  | 'ROLLBACK'
  | 'HOLD'
  | 'SKIPPED_OVERRIDE'
  | 'SKIPPED_COOLDOWN'
  | 'SKIPPED_NO_SAMPLES';

// ── Stream events (server → client over SSE) ─────────────────────────────────

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
      action: ControllerAction;
      weight_b_before: number;
      weight_b_after: number;
      composite_a?: number;
      composite_b?: number;
      reason: string;
      ts: string;
    };

// ── Per-node data shapes (consumed by ReactFlow node components) ─────────────

export interface InputNodeData {
  recentRequests: { id: string; text: string; ts: string }[];
  rps: number;
}

export interface RouterNodeData {
  weightA: number;
  weightB: number;
  status: 'stable' | 'shifting';
}

export interface PromptVersionNodeData {
  side: CanaryVersionLabel;
  versionLabel: string;
  templateText?: string;
  rollingScore?: number;
}

export interface ModelNodeData {
  name: string;
}

export interface JudgeNodeData {
  judgeVersion: string;
  lastScores?: {
    helpfulness: number;
    factuality: number;
    tone: number;
    conciseness: number;
  };
  lastJudgedAt?: string;
}

export interface ScorePanelNodeData {
  side: CanaryVersionLabel;
  rollingMean: number;
  sparkline: { t: string; v: number }[];
}

export interface Decision {
  ts: string;
  action: ControllerAction;
  from: number;
  to: number;
  deltaScore?: number;
  reason: string;
}

export interface ControllerNodeData {
  executionArn?: string;
  state: 'idle' | 'evaluating' | 'promoting' | 'halted';
  lastDecisions: Decision[];
}

// ── Edge data ────────────────────────────────────────────────────────────────

export interface WeightedEdgeData {
  weight: number;
}
