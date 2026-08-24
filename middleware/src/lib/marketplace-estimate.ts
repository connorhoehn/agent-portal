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

import { selectEstimate, type Estimate, type ForecastConfidence, type RunPercentiles } from './bot-estimate.js';

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

/** Every sample the two estimators can draw on for one (model, repo, size). */
export interface ForecastSamples {
  perPointRepo: RunPercentiles | null;
  perPointModel: RunPercentiles | null;
  runRepo: RunPercentiles | null;
  runModel: RunPercentiles | null;
}

/** A forecast plus the two things a caller must not have to re-derive: whether
 *  the range is size-scaled, and how much it is entitled to claim. */
export interface DispatchForecast {
  estimate: Estimate;
  points: number | null;
  scaled: boolean;
  confidence: ForecastConfidence;
}

/**
 * The one forecast the whole marketplace uses — what GET /api/bots/estimate
 * shows the operator AND what the allocation brake judges at dispatch.
 *
 * They were separate expressions of the same fallback chain, and they diverged
 * in the way that mattered: the estimator fell back to the run-level range for
 * an unsized or historyless item, while the brake simply gave up and let the
 * dispatch through. Every first dispatch against an initiative — exactly the
 * ones with no history to brake on and the best chance of blowing a small
 * allocation — passed unchecked, and the brake only came alive once enough
 * sized runs existed that it was needed least. One function now, so the number
 * shown and the number judged cannot disagree again.
 *
 * The chain is unchanged and still refuses to invent precision: per-point
 * history × points when the sample floor is cleared (confidence 'scaled'),
 * otherwise the run-level range labeled for what it is ('run-history'), and a
 * static per-tier prior when there is no history at all ('prior').
 */
export function selectDispatchForecast(
  model: string,
  points: number | null,
  samples: ForecastSamples,
): DispatchForecast {
  if (points != null && points > 0) {
    const scaled = selectPerPointEstimate(points, samples.perPointRepo, samples.perPointModel);
    if (scaled) return { estimate: scaled, points, scaled: true, confidence: 'scaled' };
  }
  const estimate = selectEstimate(model, samples.runRepo, samples.runModel);
  return {
    estimate,
    points,
    scaled: false,
    confidence: estimate.basis === 'prior' ? 'prior' : 'run-history',
  };
}
