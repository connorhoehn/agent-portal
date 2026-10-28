// `lib/pricing.ts` alone — no config, no registered Claude table: the Nova/
// Titan rates, the one id rule, and the per-bucket estimator's refusal to
// price partially. The DE-3 item owed to this row: a `us.` inference profile
// prices as its bare foundation model.

import {
  BEDROCK_PRICING,
  estimateCost,
  estimateCostOrNull,
  estimateUsageCost,
  hasPricing,
  normalizeModelId,
  priceFor,
  registerPriceSource,
} from '../pricing.js';

afterEach(() => registerPriceSource(null));

describe('the one id rule', () => {
  it.each([undefined, null, 42])('keeps a malformed runtime id unpriced: %s', (modelId) => {
    const id = modelId as unknown as string;
    expect(priceFor(id)).toBeNull();
    expect(estimateCostOrNull(id, { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(estimateCost(id, { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
  it('a us. inference profile prices as its bare foundation model (DE-3 item 6)', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    const bare = estimateCostOrNull('amazon.nova-pro-v1:0', usage);
    expect(bare).toBeCloseTo(0.0008 + 0.0032, 10);
    expect(estimateCostOrNull('us.amazon.nova-pro-v1:0', usage)).toBe(bare);
    expect(estimateCostOrNull('eu.amazon.nova-pro-v1:0', usage)).toBe(bare);
    expect(estimateCostOrNull('global.amazon.nova-pro-v1:0', usage)).toBe(bare);
  });

  it('exact match wins over the stripped id', () => {
    const known = (id: string) => id === 'us.x' || id === 'x';
    expect(normalizeModelId('us.x', known)).toBe('us.x');
    expect(normalizeModelId('eu.x', known)).toBe('x');
    expect(normalizeModelId('x', known)).toBe('x');
    expect(normalizeModelId('apac.y', known)).toBeNull();
    expect(normalizeModelId('  ', known)).toBeNull();
  });

  it('strips only a geo/global profile prefix, never an arbitrary dotted head', () => {
    expect(priceFor('anthropic.amazon.nova-pro-v1:0')).toBeNull();
    expect(hasPricing('us.amazon.nova-lite-v1:0')).toBe(true);
    expect(hasPricing('us.anthropic.claude-sonnet-5')).toBe(false); // no table registered here
  });
});

describe('estimateUsageCost', () => {
  it('prices every bucket at its own rate', () => {
    registerPriceSource((id) => id === 'm' ? { input: 1, output: 2, cacheWrite: 0.5, cacheRead: 0.1 } : undefined);
    const usd = estimateUsageCost('us.m', { inputTokens: 1000, outputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 1000 });
    expect(usd).toBeCloseTo(1 + 2 + 0.5 + 0.1, 10);
  });

  it('refuses a partial price: a non-zero bucket with no rate is null, a zero bucket needs none', () => {
    registerPriceSource((id) => id === 'm' ? { input: 1, output: 2 } : undefined);
    expect(estimateUsageCost('m', { inputTokens: 10, outputTokens: 10, cacheReadTokens: 5 })).toBeNull();
    expect(estimateUsageCost('m', { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 })).toBeCloseTo(0.03, 10);
  });

  it('an unknown model is null for the honest callers and 0 only for estimateCost', () => {
    const usage = { inputTokens: 10, outputTokens: 10 };
    expect(estimateUsageCost('nobody', usage)).toBeNull();
    expect(estimateCostOrNull('nobody', usage)).toBeNull();
    expect(estimateCost('nobody', usage)).toBe(0);
  });

  it('the Nova/Titan rows are unchanged in shape and still priced from code', () => {
    expect(Object.keys(BEDROCK_PRICING).sort()).toEqual([
      'amazon.nova-lite-v1:0', 'amazon.nova-micro-v1:0', 'amazon.nova-pro-v1:0', 'amazon.titan-embed-text-v2:0',
    ]);
    expect(estimateCost('amazon.titan-embed-text-v2:0', { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.00002, 12);
  });
});
