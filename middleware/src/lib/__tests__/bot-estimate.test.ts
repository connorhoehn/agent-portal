// Estimate basis selection — the honesty rules, pinned. The fallback chain
// (repo n≥3 → model n≥5 → prior) is what keeps two data points from being
// dressed up as a forecast, so the thresholds and their ordering are the
// behaviour under test.

import {
  selectEstimate, priorFor, REPO_MIN_SAMPLES, MODEL_MIN_SAMPLES, type RunPercentiles,
} from '../bot-estimate.js';

function sample(count: number, over: Partial<RunPercentiles> = {}): RunPercentiles {
  return { count, costUsdP25: 0.1, costUsdP75: 0.9, minutesP25: 2, minutesP75: 8, ...over };
}

describe('selectEstimate', () => {
  it('prefers repo-matched history at the repo floor', () => {
    const est = selectEstimate('sonnet-x', sample(REPO_MIN_SAMPLES, { costUsdP25: 0.2 }), sample(50));
    expect(est.basis).toBe('repo');
    expect(est.sampleCount).toBe(REPO_MIN_SAMPLES);
    expect(est.costUsdP25).toBe(0.2);
  });

  it('falls through a thin repo sample to model-wide history — specificity without volume is not evidence', () => {
    const est = selectEstimate('sonnet-x', sample(REPO_MIN_SAMPLES - 1), sample(MODEL_MIN_SAMPLES));
    expect(est.basis).toBe('model');
    expect(est.sampleCount).toBe(MODEL_MIN_SAMPLES);
  });

  it('falls to the prior when model-wide history is below its floor', () => {
    const est = selectEstimate('us.anthropic.claude-haiku-4-5', sample(2), sample(MODEL_MIN_SAMPLES - 1));
    expect(est.basis).toBe('prior');
    expect(est.sampleCount).toBe(0);
  });

  it('handles missing samples (no repo given, empty history)', () => {
    expect(selectEstimate('anything', null, null).basis).toBe('prior');
  });
});

describe('priorFor', () => {
  it('matches the tier by model-id substring — ids arrive as inference profiles, not bare names', () => {
    expect(priorFor('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toMatchObject({
      costUsdP25: 0.03, costUsdP75: 0.30, minutesP25: 1, minutesP75: 6,
    });
    expect(priorFor('us.anthropic.claude-opus-4-6')).toMatchObject({
      costUsdP25: 0.60, costUsdP75: 5.00, minutesP25: 5, minutesP75: 30,
    });
    expect(priorFor('claude-sonnet-4-5')).toMatchObject({
      costUsdP25: 0.15, costUsdP75: 1.50, minutesP25: 3, minutesP75: 15,
    });
  });

  it('gives an unrecognised model the sonnet prior — the middle tier is the least-wrong default', () => {
    expect(priorFor('some-unknown-model')).toMatchObject({ costUsdP25: 0.15, costUsdP75: 1.50 });
  });

  it('always labels itself a prior with zero samples', () => {
    const p = priorFor('haiku');
    expect(p.basis).toBe('prior');
    expect(p.sampleCount).toBe(0);
  });
});
