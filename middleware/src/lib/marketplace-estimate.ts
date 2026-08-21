// Per-point estimate selection — the marketplace half of the cost estimator.
//
// Wave 1's estimator (lib/bot-estimate.ts) forecasts a RUN: percentiles over
// whole completed runs. A sized story wants a forecast that scales — 5 points
// should cost about 5 × what one point historically costs — which needs runs
// that were bound to sized work items ($/point, minutes/point). This module is
// the pure selector over those per-point samples; the SQL lives in
// providers/bots.ts (perPointCostSamples). When no per-point basis clears the
// sample floor the caller falls back to the run-level estimate, labeled
// scaled:false — the same honesty rule as bot-estimate: never dress a blind
// range up as a scaled forecast.

import type { Estimate, RunPercentiles } from './bot-estimate.js';

/** Both scopes trust three samples: per-point history is already normalised by
 *  size, so repo- and model-wide need the same floor. */
export const PER_POINT_MIN_SAMPLES = 3;

/**
 * Scale the strongest per-point basis to N points, or null when neither scope
 * has enough sized history. Same ordering rule as selectEstimate: a thin repo
 * sample falls through to model-wide rather than winning on specificity.
 * Returns Estimate (basis 'repo' | 'model' only — a prior has no per-point
 * form; below the floor the answer is null, not a made-up scaling).
 */
export function selectPerPointEstimate(
  points: number,
  repoSample: RunPercentiles | null,
  modelSample: RunPercentiles | null,
): Estimate | null {
  const pick =
    repoSample && repoSample.count >= PER_POINT_MIN_SAMPLES
      ? { basis: 'repo' as const, sample: repoSample }
      : modelSample && modelSample.count >= PER_POINT_MIN_SAMPLES
        ? { basis: 'model' as const, sample: modelSample }
        : null;
  if (!pick) return null;
  return {
    basis: pick.basis,
    sampleCount: pick.sample.count,
    costUsdP25: pick.sample.costUsdP25 * points,
    costUsdP75: pick.sample.costUsdP75 * points,
    minutesP25: pick.sample.minutesP25 * points,
    minutesP75: pick.sample.minutesP75 * points,
  };
}
