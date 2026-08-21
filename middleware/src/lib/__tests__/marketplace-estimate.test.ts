// Per-point estimate selection — the marketplace's scaling rule. Pins that a
// sized estimate only claims scaled precision when sized history exists (n≥3,
// repo before model-wide), that the range is per-point × N, and that below
// the floor the answer is null so the caller falls back to the run-level
// estimate labeled scaled:false.

import { selectPerPointEstimate, PER_POINT_MIN_SAMPLES } from '../marketplace-estimate.js';
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
