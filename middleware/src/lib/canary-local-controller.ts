// Local canary controller — simulates the Step Functions decision loop in dev.
//
// The real controller lives in AWS Step Functions and writes decisions to
// observability.canary_decisions (polled by canary-decisions-poller.ts). In
// local dev the SFN isn't deployed, so this module fills the gap.
//
// Logic:
//   1. Track invocation_started events: request_id → version_label.
//   2. Track judge_score events: accumulate composites per version (rolling 20).
//   3. After every new score, if both versions have ≥ MIN_SAMPLES and cooldown
//      has elapsed, compute PROMOTE / ROLLBACK / HOLD and publish the result.
//
// Only active when CANARY_LOCAL_CONTROLLER is not explicitly disabled via
// CANARY_LOCAL_CONTROLLER_DISABLED=1. It's always safe to enable alongside the
// real poller — the real poller produces authentic Aurora rows while this module
// only emits synthetic in-memory events.

import { canaryBroker } from './canary-broker.js';
import type { CanaryEvent, CanaryVersionLabel } from './canary-types.js';

const MIN_SAMPLES = 1;       // minimum scores per version before deciding (1 = fire after first sample each side)
const COOLDOWN_MS = 15_000;  // minimum ms between decisions
const PROMOTE_THRESHOLD = 0.04;   // B must beat A by this much to PROMOTE
const ROLLBACK_THRESHOLD = 0.04;  // A must beat B by this much to ROLLBACK
const ROLLING_WINDOW = 20;

const versionByRequest = new Map<string, CanaryVersionLabel>();
const scoresA: number[] = [];
const scoresB: number[] = [];
let weightB = 30; // tracks local weight in-memory
let lastDecisionAt = 0;

function pushCapped(arr: number[], val: number): void {
  arr.push(val);
  if (arr.length > ROLLING_WINDOW) arr.shift();
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function decide(): void {
  if (_terminal) return; // experiment complete — stop deciding
  const now = Date.now();
  if (now - lastDecisionAt < COOLDOWN_MS) return; // still in cooldown
  if (scoresA.length < MIN_SAMPLES || scoresB.length < MIN_SAMPLES) return;

  const compA = mean(scoresA);
  const compB = mean(scoresB);
  const delta = compB - compA;
  const weightBefore = weightB;

  type DecisionAction = Extract<CanaryEvent, { type: 'decision' }>['action'];
  let action: DecisionAction;
  let reason: string;
  let weightAfter: number;

  if (delta > PROMOTE_THRESHOLD) {
    action = 'PROMOTE';
    reason = `B (${compB.toFixed(3)}) outperforms A (${compA.toFixed(3)}) by Δ${delta.toFixed(3)} — shifting traffic to B`;
    weightAfter = clamp(weightBefore + 10, 0, 100);
  } else if (delta < -ROLLBACK_THRESHOLD) {
    action = 'ROLLBACK';
    reason = `A (${compA.toFixed(3)}) outperforms B (${compB.toFixed(3)}) by Δ${Math.abs(delta).toFixed(3)} — rolling back to A`;
    weightAfter = clamp(weightBefore - 10, 0, 100);
  } else {
    action = 'HOLD';
    reason = `Δ${delta.toFixed(3)} within threshold ±${PROMOTE_THRESHOLD} — holding at ${weightBefore}%`;
    weightAfter = weightBefore;
  }

  lastDecisionAt = now;
  weightB = weightAfter;
  if (weightAfter >= 100 || weightAfter <= 0) {
    _terminal = true;
    console.log(`[canary-local-ctrl] terminal — weight_b=${weightAfter}%, no further decisions`);
  }

  const ts = new Date().toISOString();

  if (weightAfter !== weightBefore) {
    canaryBroker.publish({
      type: 'weight_changed',
      weight_b: weightAfter,
      source: 'controller',
      ts,
    });
  }

  canaryBroker.publish({
    type: 'decision',
    action,
    weight_b_before: weightBefore,
    weight_b_after: weightAfter,
    composite_a: compA,
    composite_b: compB,
    reason,
    ts,
  });
}

function handleEvent(ev: CanaryEvent): void {
  if (ev.type === 'invocation_started') {
    versionByRequest.set(ev.request_id, ev.version_label);
    return;
  }

  if (ev.type === 'judge_score') {
    const version = versionByRequest.get(ev.request_id);
    if (!version) return; // shouldn't happen, but guard
    if (version === 'A') pushCapped(scoresA, ev.composite);
    else pushCapped(scoresB, ev.composite);
    versionByRequest.delete(ev.request_id); // don't leak memory
    decide();
    return;
  }

  if (ev.type === 'weight_changed' && ev.source !== 'controller') {
    // External weight change (manual/halt) — sync local weight so our next
    // decision uses the current baseline.
    weightB = ev.weight_b;
  }
}

let _terminal = false; // true once weight reaches 0 or 100
let _started = false;

export function resetLocalController(initialWeightB = 10): void {
  _terminal = false;
  scoresA.length = 0;
  scoresB.length = 0;
  versionByRequest.clear();
  lastDecisionAt = 0;
  weightB = initialWeightB;
}

export function startLocalController(): void {
  if (_started) return;
  if (process.env['CANARY_LOCAL_CONTROLLER_DISABLED'] === '1') {
    console.log('[canary-local-ctrl] disabled via CANARY_LOCAL_CONTROLLER_DISABLED=1');
    return;
  }
  _started = true;
  canaryBroker.subscribe(handleEvent);
  console.log(
    `[canary-local-ctrl] started — min_samples=${MIN_SAMPLES}, cooldown=${COOLDOWN_MS / 1000}s`,
  );
}
