// Per-point estimate selection — the marketplace's scaling rule. Pins that a
// sized estimate only claims scaled precision when sized history exists (n≥3,
// repo before model-wide), that the range is per-point × N, and that below
// the floor the answer is null so the caller falls back to the run-level
// estimate labeled scaled:false.

import {
  selectPerPointEstimate, selectDispatchForecast, PER_POINT_MIN_SAMPLES,
  type ForecastSamples,
} from '../marketplace-estimate.js';
import type { RunPercentiles } from '../bot-estimate.js';

function sample(count: number, over: Partial<RunPercentiles> = {}): RunPercentiles {
  return { count, costUsdP25: 0.10, costUsdP75: 0.40, minutesP25: 1, minutesP75: 4, ...over };
}

describe('selectPerPointEstimate', () => {
  it('scales the repo basis by the point count', () => {
    const e = selectPerPointEstimate(5, sample(4), null);
    expect(e).toEqual({
      basis: 'repo', sampleCount: 4,
      costUsdP25: 0.5, costUsdP75: 2.0, minutesP25: 5, minutesP75: 20,
    });
  });

  it('falls through a thin repo sample to model-wide — specificity without volume loses', () => {
    const e = selectPerPointEstimate(2, sample(PER_POINT_MIN_SAMPLES - 1), sample(9, { costUsdP25: 0.2 }));
    expect(e).toMatchObject({ basis: 'model', sampleCount: 9, costUsdP25: 0.4 });
  });

  it('accepts exactly the floor', () => {
    expect(selectPerPointEstimate(1, sample(PER_POINT_MIN_SAMPLES), null)).toMatchObject({ basis: 'repo' });
  });

  it('returns null when neither scope clears the floor — the caller falls back unscaled', () => {
    expect(selectPerPointEstimate(8, sample(2), sample(2))).toBeNull();
  });

  it('returns null with no history at all', () => {
    expect(selectPerPointEstimate(3, null, null)).toBeNull();
  });
});

// The whole chain in one function, because the estimate the operator reads and
// the forecast the allocation brake judges must be the same number. They were
// two expressions of this chain and they disagreed: the estimator fell back to
// the run-level range, the brake gave up and let the dispatch through.
describe('selectDispatchForecast', () => {
  const NONE: ForecastSamples = { perPointRepo: null, perPointModel: null, runRepo: null, runModel: null };

  it('prefers per-point history and calls it scaled', () => {
    const f = selectDispatchForecast('sonnet', 5, { ...NONE, perPointRepo: sample(4) });
    expect(f).toMatchObject({ points: 5, scaled: true, confidence: 'scaled' });
    expect(f.estimate).toMatchObject({ basis: 'repo', costUsdP75: 2.0 });
  });

  it('falls back to run-level history, labeled for what it is', () => {
    const f = selectDispatchForecast('sonnet', 5, { ...NONE, runRepo: sample(6) });
    expect(f).toMatchObject({ scaled: false, confidence: 'run-history' });
    // Run-level: the range is NOT multiplied by the points.
    expect(f.estimate).toMatchObject({ basis: 'repo', costUsdP25: 0.10, costUsdP75: 0.40 });
  });

  // The live case: 87 seeded runs, none bound to a sized work item, so there
  // is no per-point sample at all and every dispatch lands here.
  it('lands on a prior with no history whatsoever — and still returns a range', () => {
    const f = selectDispatchForecast('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 8, NONE);
    expect(f).toMatchObject({ points: 8, scaled: false, confidence: 'prior' });
    expect(f.estimate).toMatchObject({ basis: 'prior', costUsdP25: 0.15, costUsdP75: 1.5 });
  });

  it('forecasts an unsized item too — an unpointed story still spends money', () => {
    const f = selectDispatchForecast('haiku', null, { ...NONE, perPointRepo: sample(9) });
    // Per-point history cannot be scaled without points, so it is not used.
    expect(f).toMatchObject({ points: null, scaled: false, confidence: 'prior' });
    expect(f.estimate).toMatchObject({ basis: 'prior', costUsdP75: 0.30 });
  });

  it('a thin per-point sample falls through to run-level, not to a fake scaling', () => {
    const f = selectDispatchForecast('sonnet', 3, {
      ...NONE, perPointRepo: sample(PER_POINT_MIN_SAMPLES - 1), runModel: sample(9),
    });
    expect(f).toMatchObject({ scaled: false, confidence: 'run-history' });
  });
});
