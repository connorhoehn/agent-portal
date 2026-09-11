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
      /**
       * Only the dimensions the judge actually scored.
       *
       * A judge ABSTAINS on a dimension it cannot measure rather than awarding
       * marks for it: the offline `offline/lexical-answer-check` judge, for
       * instance, omits `tone` entirely unless there is a refusal to report.
       * That is load-bearing — `weightedComposite` renormalises over the keys
       * present, so abstaining costs nothing and buys nothing, whereas scoring
       * an unmeasurable dimension 1.0 was worth 20% of the composite for free.
       * Typed as an open record for exactly that reason: ANY dimension may be
       * absent, and a consumer must render "not judged" rather than defaulting
       * it to 0 — a bar at the floor is a claim, and the wrong one.
       */
      scores: Record<string, number>;
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
  versionArn?: string;
}

export interface ModelNodeData {
  name: string;
}

export interface JudgeNodeData {
  judgeVersion: string;
  /** The dimensions the last judgement actually scored — see `judge_score`.
   *  A missing key means "not judged", never "judged zero". */
  lastScores?: Record<string, number>;
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
  state: 'idle' | 'evaluating' | 'promoting' | 'halted' | 'promoted' | 'rolled_back';
  lastDecisions: Decision[];
}

// ── Prompt Library types ─────────────────────────────────────────────────────

export interface PromptLibraryEntry {
  id: string;
  arn: string;
  name: string;
  description?: string;
  version: string;      // 'DRAFT' or '1', '2', etc.
  updatedAt: string;
  isDraft?: boolean;
}

export interface PromptVersionDetail {
  id: string;
  arn: string;
  name: string;
  version: string;
  updatedAt?: string;
  variant?: {
    name: string;
    modelId?: string;
    templateType?: string;
    templateText?: string;
    inputVariables?: string[];
    inferenceConfig?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
    };
  };
}

// ── Edge data ────────────────────────────────────────────────────────────────

export interface WeightedEdgeData {
  weight: number;
}
