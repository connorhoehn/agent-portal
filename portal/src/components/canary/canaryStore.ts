// Canary external store — useSyncExternalStore over a single mutable state
// object. We coalesce dispatches via requestAnimationFrame so a burst of
// SSE events from /api/observability/canary/events doesn't trigger one
// React render per event.
//
// Node/edge selectors derive ReactFlow node/edge arrays from state. They
// memoize on a monotonic `stateVersion` counter so React Flow sees stable
// references when nothing relevant changed.

import { useSyncExternalStore } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type {
  CanaryEvent,
  ControllerNodeData,
  Decision,
  InputNodeData,
  JudgeNodeData,
  ModelNodeData,
  PromptVersionNodeData,
  RouterNodeData,
  ScorePanelNodeData,
  WeightedEdgeData,
} from './types.js';

// ── State shape ──────────────────────────────────────────────────────────────

export interface CanaryState {
  weightA: number;
  weightB: number;
  routerStatus: 'stable' | 'shifting';
  halted: boolean;
  recentRequests: { id: string; text: string; ts: string }[];
  rps: number;
  lastJudgeScores?: JudgeNodeData['lastScores'];
  lastJudgedAt?: string;
  sparklineA: { t: string; v: number }[];
  sparklineB: { t: string; v: number }[];
  rollingMeanA: number;
  rollingMeanB: number;
  controllerState: ControllerNodeData['state'];
  recentDecisions: Decision[];
  promptATemplate?: string;
  promptBTemplate?: string;
  promptAVersionLabel: string;
  promptBVersionLabel: string;
  /** UI flags for cross-component coordination from the contextual SubNav. */
  confirmHaltOpen: boolean;
  manualSliderOpen: boolean;
  /** Monotonic counter incremented on every update — used for memoization. */
  version: number;
}

// Caps
const RECENT_REQUESTS_CAP = 20;
const SPARKLINE_CAP = 60;
const DECISIONS_CAP = 20;
// Rolling window for the per-side mean (last N composite scores per side).
const ROLLING_WINDOW = 20;
// Window for the RPS estimate (seconds).
const RPS_WINDOW_SEC = 30;

// Per-request bookkeeping for joining started → complete → judged.
interface RequestRecord {
  id: string;
  side: 'A' | 'B';
  startedTs: string;
}
// Track recent composites per side for rolling mean.
const recentCompositesA: number[] = [];
const recentCompositesB: number[] = [];
// Track recent request start timestamps (epoch ms) for RPS estimation.
const recentRequestStartsMs: number[] = [];
// Lookup of request_id → side, so judge_score events can be attributed.
const requestSide = new Map<string, RequestRecord>();

function initialState(): CanaryState {
  return {
    weightA: 100,
    weightB: 0,
    routerStatus: 'stable',
    halted: false,
    recentRequests: [],
    rps: 0,
    sparklineA: [],
    sparklineB: [],
    rollingMeanA: 0,
    rollingMeanB: 0,
    controllerState: 'idle',
    recentDecisions: [],
    promptAVersionLabel: 'A',
    promptBVersionLabel: 'B',
    confirmHaltOpen: false,
    manualSliderOpen: false,
    version: 0,
  };
}

let state: CanaryState = initialState();
const listeners = new Set<() => void>();
let pending = false;

function flush(): void {
  pending = false;
  for (const l of listeners) l();
}

function scheduleFlush(): void {
  if (pending) return;
  pending = true;
  if (typeof requestAnimationFrame === 'undefined') {
    // SSR / test fallback — flush sync.
    flush();
    return;
  }
  requestAnimationFrame(flush);
}

function update(mutator: (s: CanaryState) => CanaryState): void {
  const next = mutator(state);
  state = { ...next, version: next.version + 1 };
  scheduleFlush();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  const out = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  out.push(item);
  return out;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function recomputeRps(nowMs: number): number {
  const cutoff = nowMs - RPS_WINDOW_SEC * 1000;
  while (recentRequestStartsMs.length > 0 && recentRequestStartsMs[0] < cutoff) {
    recentRequestStartsMs.shift();
  }
  return recentRequestStartsMs.length / RPS_WINDOW_SEC;
}

function pushSparkline(
  arr: { t: string; v: number }[],
  t: string,
  v: number,
): { t: string; v: number }[] {
  // Time-bucket per second: if the last entry has the same second-precision
  // timestamp, replace it with the latest v (avg-ish via simple replacement).
  const bucket = t.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  if (arr.length > 0) {
    const last = arr[arr.length - 1];
    if (last.t.slice(0, 19) === bucket) {
      const replaced = arr.slice(0, -1);
      replaced.push({ t: bucket, v });
      return replaced;
    }
  }
  return pushCapped(arr, { t: bucket, v }, SPARKLINE_CAP);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function dispatch(e: CanaryEvent): void {
  switch (e.type) {
    case 'invocation_started': {
      const side = e.version_label;
      requestSide.set(e.request_id, { id: e.request_id, side, startedTs: e.ts });
      const tsMs = Date.parse(e.ts);
      if (!Number.isNaN(tsMs)) recentRequestStartsMs.push(tsMs);
      update((s) => ({
        ...s,
        recentRequests: pushCapped(
          s.recentRequests,
          { id: e.request_id, text: e.question, ts: e.ts },
          RECENT_REQUESTS_CAP,
        ),
        rps: recomputeRps(Number.isNaN(tsMs) ? Date.now() : tsMs),
      }));
      break;
    }
    case 'invocation_complete': {
      // We don't currently render anything off completion alone — the visible
      // change is in the judge score. Still, bump the version so any listeners
      // selecting on completion can re-render if needed.
      update((s) => ({ ...s }));
      break;
    }
    case 'judge_score': {
      const rec = requestSide.get(e.request_id);
      const side = rec?.side;
      if (side === 'A') {
        recentCompositesA.push(e.composite);
        while (recentCompositesA.length > ROLLING_WINDOW) recentCompositesA.shift();
      } else if (side === 'B') {
        recentCompositesB.push(e.composite);
        while (recentCompositesB.length > ROLLING_WINDOW) recentCompositesB.shift();
      }
      // Drop the request-side record once judged to keep the map small.
      if (rec) requestSide.delete(e.request_id);

      update((s) => {
        const sparklineA =
          side === 'A' ? pushSparkline(s.sparklineA, e.ts, e.composite) : s.sparklineA;
        const sparklineB =
          side === 'B' ? pushSparkline(s.sparklineB, e.ts, e.composite) : s.sparklineB;
        return {
          ...s,
          lastJudgeScores: e.scores,
          lastJudgedAt: e.ts,
          rollingMeanA: mean(recentCompositesA),
          rollingMeanB: mean(recentCompositesB),
          sparklineA,
          sparklineB,
        };
      });
      break;
    }
    case 'weight_changed': {
      const wb = Math.max(0, Math.min(100, e.weight_b));
      const wa = 100 - wb;
      const shifting = e.source === 'controller' || e.source === 'manual';
      update((s) => ({
        ...s,
        weightA: wa,
        weightB: wb,
        routerStatus: shifting ? 'shifting' : 'stable',
        halted: e.source === 'halt' ? true : s.halted,
      }));
      break;
    }
    case 'decision': {
      const dec: Decision = {
        ts: e.ts,
        action: e.action,
        from: e.weight_b_before,
        to: e.weight_b_after,
        deltaScore:
          e.composite_a !== undefined && e.composite_b !== undefined
            ? e.composite_b - e.composite_a
            : undefined,
        reason: e.reason,
      };
      let nextState: ControllerNodeData['state'];
      if (e.action === 'PROMOTE') nextState = 'promoting';
      else if (e.action === 'ROLLBACK') nextState = 'halted';
      else nextState = 'evaluating';

      update((s) => ({
        ...s,
        controllerState: nextState,
        recentDecisions: pushCapped(s.recentDecisions, dec, DECISIONS_CAP),
        // A decision usually carries the new authoritative weight too.
        weightA: 100 - e.weight_b_after,
        weightB: e.weight_b_after,
        routerStatus: e.weight_b_after !== e.weight_b_before ? 'shifting' : s.routerStatus,
      }));
      break;
    }
  }
}

// ── Optimistic local-side mutators ───────────────────────────────────────────

export function setWeight(weightB: number): void {
  const wb = Math.max(0, Math.min(100, Math.round(weightB)));
  update((s) => ({
    ...s,
    weightA: 100 - wb,
    weightB: wb,
    routerStatus: 'shifting',
  }));
}

export function setHalted(halted: boolean): void {
  update((s) => ({
    ...s,
    halted,
    controllerState: halted ? 'halted' : 'idle',
  }));
}

export function openHaltConfirm(): void {
  update((s) => ({ ...s, confirmHaltOpen: true }));
}

export function closeHaltConfirm(): void {
  update((s) => ({ ...s, confirmHaltOpen: false }));
}

export function setManualSliderOpen(open: boolean): void {
  update((s) => ({ ...s, manualSliderOpen: open }));
}

export function toggleManualSlider(): void {
  update((s) => ({ ...s, manualSliderOpen: !s.manualSliderOpen }));
}

export function setPromptTemplates(args: {
  promptATemplate?: string;
  promptBTemplate?: string;
  promptAVersionLabel?: string;
  promptBVersionLabel?: string;
}): void {
  update((s) => ({
    ...s,
    promptATemplate: args.promptATemplate ?? s.promptATemplate,
    promptBTemplate: args.promptBTemplate ?? s.promptBTemplate,
    promptAVersionLabel: args.promptAVersionLabel ?? s.promptAVersionLabel,
    promptBVersionLabel: args.promptBVersionLabel ?? s.promptBVersionLabel,
  }));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCanaryStore<T>(selector: (s: CanaryState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ── Node/edge derivation ─────────────────────────────────────────────────────
//
// Static layout — node positions are fixed; we mutate `data` references when
// the relevant slice of state changes (keyed on `version`).

const POSITIONS = {
  input:       { x:    0, y:   0 },
  router:      { x:    0, y: 140 },
  promptA:     { x: -260, y: 290 },
  promptB:     { x:  260, y: 290 },
  model:       { x:    0, y: 440 },
  judge:       { x:    0, y: 580 },
  scoreA:      { x: -260, y: 720 },
  scoreB:      { x:  260, y: 720 },
  controller:  { x:    0, y: 860 },
} as const;

// Memoize the derived arrays at module scope. Both selectors read from the
// store snapshot via the same versioned cache.
let cachedNodesVersion = -1;
let cachedNodes: Node[] = [];
let cachedEdgesVersion = -1;
let cachedEdges: Edge[] = [];

function deriveNodes(s: CanaryState): Node[] {
  if (s.version === cachedNodesVersion) return cachedNodes;

  const inputData: InputNodeData = {
    recentRequests: s.recentRequests,
    rps: s.rps,
  };
  const routerData: RouterNodeData = {
    weightA: s.weightA,
    weightB: s.weightB,
    status: s.routerStatus,
  };
  const promptAData: PromptVersionNodeData = {
    side: 'A',
    versionLabel: s.promptAVersionLabel,
    templateText: s.promptATemplate,
    rollingScore: s.rollingMeanA,
  };
  const promptBData: PromptVersionNodeData = {
    side: 'B',
    versionLabel: s.promptBVersionLabel,
    templateText: s.promptBTemplate,
    rollingScore: s.rollingMeanB,
  };
  const modelData: ModelNodeData = { name: 'amazon.nova-pro-v1:0' };
  const judgeData: JudgeNodeData = {
    judgeVersion: 'judge-v1',
    lastScores: s.lastJudgeScores,
    lastJudgedAt: s.lastJudgedAt,
  };
  const scoreAData: ScorePanelNodeData = {
    side: 'A',
    rollingMean: s.rollingMeanA,
    sparkline: s.sparklineA,
  };
  const scoreBData: ScorePanelNodeData = {
    side: 'B',
    rollingMean: s.rollingMeanB,
    sparkline: s.sparklineB,
  };
  const controllerData: ControllerNodeData = {
    state: s.halted ? 'halted' : s.controllerState,
    lastDecisions: s.recentDecisions,
  };

  const nodes: Node[] = [
    { id: 'input',      type: 'inputNode',      position: POSITIONS.input,      data: inputData as unknown as Record<string, unknown> },
    { id: 'router',     type: 'routerNode',     position: POSITIONS.router,     data: routerData as unknown as Record<string, unknown> },
    { id: 'promptA',    type: 'promptVersion',  position: POSITIONS.promptA,    data: promptAData as unknown as Record<string, unknown> },
    { id: 'promptB',    type: 'promptVersion',  position: POSITIONS.promptB,    data: promptBData as unknown as Record<string, unknown> },
    { id: 'model',      type: 'modelNode',      position: POSITIONS.model,      data: modelData as unknown as Record<string, unknown> },
    { id: 'judge',      type: 'judgeNode',      position: POSITIONS.judge,      data: judgeData as unknown as Record<string, unknown> },
    { id: 'scoreA',     type: 'scorePanel',     position: POSITIONS.scoreA,     data: scoreAData as unknown as Record<string, unknown> },
    { id: 'scoreB',     type: 'scorePanel',     position: POSITIONS.scoreB,     data: scoreBData as unknown as Record<string, unknown> },
    { id: 'controller', type: 'controllerNode', position: POSITIONS.controller, data: controllerData as unknown as Record<string, unknown> },
  ];

  cachedNodesVersion = s.version;
  cachedNodes = nodes;
  return nodes;
}

function deriveEdges(s: CanaryState): Edge[] {
  if (s.version === cachedEdgesVersion) return cachedEdges;

  const weightAData: WeightedEdgeData = { weight: s.weightA };
  const weightBData: WeightedEdgeData = { weight: s.weightB };

  const edges: Edge[] = [
    {
      id: 'e-input-router',
      source: 'input',
      target: 'router',
      animated: true,
      style: { stroke: '#94a3b8', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    },
    {
      id: 'e-router-promptA',
      source: 'router',
      target: 'promptA',
      type: 'weighted',
      animated: s.weightA > 0,
      data: weightAData as unknown as Record<string, unknown>,
      label: `${Math.round(s.weightA)}%`,
      style: { stroke: '#3b82f6', strokeWidth: Math.max(1, s.weightA / 25) },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
    },
    {
      id: 'e-router-promptB',
      source: 'router',
      target: 'promptB',
      type: 'weighted',
      animated: s.weightB > 0,
      data: weightBData as unknown as Record<string, unknown>,
      label: `${Math.round(s.weightB)}%`,
      style: { stroke: '#a855f7', strokeWidth: Math.max(1, s.weightB / 25) },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#a855f7' },
    },
    {
      id: 'e-promptA-model',
      source: 'promptA',
      target: 'model',
      targetHandle: 'a',
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
    },
    {
      id: 'e-promptB-model',
      source: 'promptB',
      target: 'model',
      targetHandle: 'b',
      animated: true,
      style: { stroke: '#a855f7', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#a855f7' },
    },
    {
      id: 'e-model-judge',
      source: 'model',
      target: 'judge',
      animated: true,
      style: { stroke: '#94a3b8', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    },
    {
      id: 'e-judge-scoreA',
      source: 'judge',
      target: 'scoreA',
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
    },
    {
      id: 'e-judge-scoreB',
      source: 'judge',
      target: 'scoreB',
      animated: true,
      style: { stroke: '#a855f7', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#a855f7' },
    },
    {
      id: 'e-scoreA-controller',
      source: 'scoreA',
      target: 'controller',
      animated: false,
      style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    },
    {
      id: 'e-scoreB-controller',
      source: 'scoreB',
      target: 'controller',
      animated: false,
      style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    },
  ];

  cachedEdgesVersion = s.version;
  cachedEdges = edges;
  return edges;
}

export function useCanaryNodes(): Node[] {
  return useCanaryStore(deriveNodes);
}

export function useCanaryEdges(): Edge[] {
  return useCanaryStore(deriveEdges);
}

// Exposed for tests / debugging.
export function __resetCanaryStore(): void {
  state = initialState();
  recentCompositesA.length = 0;
  recentCompositesB.length = 0;
  recentRequestStartsMs.length = 0;
  requestSide.clear();
  cachedNodesVersion = -1;
  cachedEdgesVersion = -1;
  cachedNodes = [];
  cachedEdges = [];
  scheduleFlush();
}
