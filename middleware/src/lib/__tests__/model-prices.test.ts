// The Claude price table from config (DE-32): the fixture offline, the
// defaults + SSM overlay online, the one id rule, per-bucket pricing, and the
// refusal of any entry nobody can trace to a source.

import { fixtureRegistry } from '../../mock/core/index.js';
import {
  _resetModelPricesForTest,
  _setModelPricesTransportForTest,
  buildSnapshot,
  defaultsEnabled,
  estimateUsageCost,
  modelPricesSnapshot,
  priceFor,
  refreshModelPrices,
  validateModelPrices,
} from '../model-prices.js';
import { DEFAULT_MODEL_PRICES } from '../model-prices-defaults.js';
import { estimateCostOrNull } from '../pricing.js';
import { modelPriceRows } from '../../mock/model-prices.js';

const SONNET = 'anthropic.claude-sonnet-5';
const sonnet = DEFAULT_MODEL_PRICES[SONNET]!;

beforeEach(() => {
  process.env['MOCK_AGENTCORE'] = 'true';
  delete process.env['MODEL_PRICES_DEFAULTS'];
  fixtureRegistry.resetAll('default');
  _resetModelPricesForTest();
  _setModelPricesTransportForTest(null);
});
afterAll(() => { fixtureRegistry.resetAll('default'); delete process.env['MOCK_AGENTCORE']; });

describe('offline: the fixture is the table', () => {
  it('a us. profile id resolves to its bare entry', () => {
    expect(priceFor(`us.${SONNET}`)).toMatchObject({ input: sonnet.input, output: sonnet.output, source: 'mock' });
    expect(priceFor(`eu.${SONNET}`)).toMatchObject({ source: 'mock' });
    expect(priceFor(SONNET)).toMatchObject({ source: 'mock' });
  });

  it('cache-read tokens are priced at cacheRead, not input', () => {
    const readOnly = estimateUsageCost(`us.${SONNET}`, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 });
    expect(readOnly).toBeCloseTo(sonnet.cacheRead!, 12);
    expect(readOnly).not.toBeCloseTo(sonnet.input, 12);
    const writeOnly = estimateUsageCost(SONNET, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 });
    expect(writeOnly).toBeCloseTo(sonnet.cacheWrite!, 12);
    const all = estimateUsageCost(SONNET, { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 10_000 });
    expect(all).toBeCloseTo(sonnet.input + sonnet.output * 0.5 + sonnet.cacheWrite! * 2 + sonnet.cacheRead! * 10, 12);
  });

  it('a model with no entry returns null; so does an entry missing a rate a non-zero bucket needs', () => {
    expect(estimateUsageCost('us.anthropic.claude-nobody', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    const rows = modelPriceRows.rows();
    rows.push({ modelId: 'anthropic.claude-no-cache', input: 0.001, output: 0.002, source: 'mock', effectiveFrom: '2026-01-01' });
    expect(estimateUsageCost('us.anthropic.claude-no-cache', { inputTokens: 10, outputTokens: 10 })).toBeCloseTo(0.00003, 12);
    expect(estimateUsageCost('us.anthropic.claude-no-cache', { inputTokens: 10, outputTokens: 10, cacheReadTokens: 1 })).toBeNull();
  });

  it('the empty scenario blanks the table and every Claude run prices to null', () => {
    fixtureRegistry.resetAll('empty');
    expect(modelPricesSnapshot().origin).toBe('empty');
    expect(estimateUsageCost(`us.${SONNET}`, { inputTokens: 10, outputTokens: 10 })).toBeNull();
    // Nova stays priced from code regardless.
    expect(estimateCostOrNull('us.amazon.nova-pro-v1:0', { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.0008, 12);
  });

  it('prices the ids the mock fleet and the mock agent loop send', () => {
    expect(priceFor('claude-sonnet-5')).toMatchObject({ source: 'mock' });
    expect(priceFor('sonnet')).toMatchObject({ source: 'mock' });
  });
});

describe('validation: an entry without a source is refused', () => {
  it('refuses missing source, missing effectiveFrom and non-numeric rates, and keeps the rest', () => {
    const { accepted, rejected } = validateModelPrices({
      good: { input: 0.001, output: 0.005, cacheRead: 0.0001, source: 'console 2026-10-28', effectiveFrom: '2026-10-28' },
      noSource: { input: 0.001, output: 0.005, effectiveFrom: '2026-10-28' },
      noDate: { input: 0.001, output: 0.005, source: 'x' },
      badRate: { input: 'cheap', output: 0.005, source: 'x', effectiveFrom: '2026-10-28' },
      badCache: { input: 0.001, output: 0.005, cacheWrite: -1, source: 'x', effectiveFrom: '2026-10-28' },
    });
    expect(Object.keys(accepted)).toEqual(['good']);
    expect(rejected.map((r) => r.id).sort()).toEqual(['badCache', 'badRate', 'noDate', 'noSource']);
    expect(rejected.find((r) => r.id === 'noSource')?.reason).toMatch(/source/);
  });

  it('refuses a document that is not an object, loading nothing from it', () => {
    expect(validateModelPrices([1, 2]).rejected[0]?.id).toBe('*');
    expect(validateModelPrices('{}').accepted).toEqual({});
  });
});

describe('online: defaults overlaid by the parameter', () => {
  beforeEach(() => { delete process.env['MOCK_AGENTCORE']; });

  it('an absent parameter leaves the labelled defaults, each with a source and date', () => {
    const snap = buildSnapshot(null, 0);
    expect(snap.origin).toBe('defaults');
    for (const [id, p] of Object.entries(snap.prices)) {
      expect(id.startsWith('anthropic.claude-')).toBe(true);
      expect(p.source).toMatch(/first-party list price/);
      expect(p.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('a parameter row replaces the default for its id and leaves the others; refused rows are reported', () => {
    const snap = buildSnapshot({
      value: JSON.stringify({
        [SONNET]: { input: 0.003, output: 0.015, cacheWrite: 0.00375, cacheRead: 0.0003, source: 'bedrock console', effectiveFrom: '2026-10-28' },
        'anthropic.claude-mystery': { input: 1, output: 1 },
      }),
      version: '7',
    }, 0);
    expect(snap.origin).toBe('ssm+defaults');
    expect(snap.version).toBe('7');
    expect(snap.prices[SONNET]).toMatchObject({ input: 0.003, source: 'bedrock console' });
    expect(snap.prices['anthropic.claude-opus-4-8']).toEqual(DEFAULT_MODEL_PRICES['anthropic.claude-opus-4-8']);
    expect(snap.prices['anthropic.claude-mystery']).toBeUndefined();
    expect(snap.rejected).toEqual([{ id: 'anthropic.claude-mystery', reason: 'missing source' }]);
  });

  it('MODEL_PRICES_DEFAULTS=off ships an empty table until the operator supplies rates', () => {
    process.env['MODEL_PRICES_DEFAULTS'] = 'off';
    expect(defaultsEnabled()).toBe(false);
    expect(buildSnapshot(null, 0).origin).toBe('empty');
    expect(estimateUsageCost(`us.${SONNET}`, { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('refreshModelPrices reads the parameter through the transport and the sync lookup sees it', async () => {
    _setModelPricesTransportForTest(async (name) => {
      expect(name).toBe('/orgiq/pricing/model_prices');
      return { value: JSON.stringify({ [SONNET]: { input: 0.009, output: 0.09, source: 's', effectiveFrom: '2026-10-28' } }), version: '2' };
    });
    await refreshModelPrices();
    expect(priceFor(`us.${SONNET}`)).toMatchObject({ input: 0.009, source: 's' });
    expect(estimateUsageCost(`us.${SONNET}`, { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.009, 12);
  });

  it('serves the last good snapshot on an SSM error, and the defaults when there is none', async () => {
    _setModelPricesTransportForTest(async () => { throw Object.assign(new Error('boom'), { name: 'AccessDeniedException' }); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = await refreshModelPrices();
      expect(first.origin).toBe('defaults');
      _setModelPricesTransportForTest(async () => ({
        value: JSON.stringify({ [SONNET]: { input: 0.009, output: 0.09, source: 's', effectiveFrom: '2026-10-28' } }), version: '3',
      }));
      await refreshModelPrices();
      _setModelPricesTransportForTest(async () => { throw new Error('boom'); });
      const stale = await refreshModelPrices();
      expect(stale.version).toBe('3');
      expect(priceFor(SONNET)).toMatchObject({ input: 0.009 });
    } finally {
      warn.mockRestore();
    }
  });
});
