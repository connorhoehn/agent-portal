// Unit tests for the rubric-weighted composite — the piece of judge-config
// that turns raw judge scores into the number the canary controller acts on.

import { weightedComposite, DEFAULT_JUDGE_CONFIG } from '../judge-config.js';

describe('weightedComposite', () => {
  const dims = [
    { key: 'helpfulness', weight: 30 },
    { key: 'factuality', weight: 30 },
    { key: 'tone', weight: 20 },
    { key: 'conciseness', weight: 20 },
  ];

  it('computes the weighted mean over declared dimensions', () => {
    const scores = { helpfulness: 1, factuality: 0.5, tone: 0, conciseness: 1 };
    // (1*30 + 0.5*30 + 0*20 + 1*20) / 100 = 0.65
    expect(weightedComposite(scores, dims)).toBeCloseTo(0.65, 10);
  });

  it('equals the plain mean when weights are equal', () => {
    const equal = dims.map(d => ({ ...d, weight: 25 }));
    const scores = { helpfulness: 0.2, factuality: 0.8, tone: 0.9, conciseness: 0.6 };
    expect(weightedComposite(scores, equal)).toBeCloseTo(0.625, 10);
  });

  it('ignores dimensions missing from the score record', () => {
    const scores = { helpfulness: 1, factuality: 1 };
    // Only the two present keys contribute: (1*30 + 1*30) / 60 = 1
    expect(weightedComposite(scores, dims)).toBeCloseTo(1, 10);
  });

  it('ignores non-finite score values', () => {
    const scores = { helpfulness: 1, factuality: Number.NaN, tone: 0.5, conciseness: 0.5 };
    // (1*30 + 0.5*20 + 0.5*20) / 70
    expect(weightedComposite(scores, dims)).toBeCloseTo(50 / 70, 10);
  });

  it('falls back to a plain mean when total weight is zero', () => {
    const zero = dims.map(d => ({ ...d, weight: 0 }));
    const scores = { helpfulness: 0.4, factuality: 0.6 };
    expect(weightedComposite(scores, zero)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for an empty score record with zero-weight dims', () => {
    expect(weightedComposite({}, [])).toBe(0);
  });

  it('default config rubric weights sum to 100', () => {
    const total = DEFAULT_JUDGE_CONFIG.dimensions.reduce((s: number, d) => s + d.weight, 0);
    expect(total).toBe(100);
  });
});
