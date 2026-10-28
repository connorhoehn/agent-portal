// trace-sink × the Claude price table (DE-32): a `us.anthropic.*` trace with
// tokens stores a non-null `est_cost_usd` while the table has a seeded price,
// and NULL — never 0 — once the fixture is blanked. Same mocks as
// phantom-trace-guard.test.ts; offline (MOCK_AGENTCORE) so the price fixture
// is the table.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: true, guardrails: false, cloudwatch: false },
};

jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(async () => undefined),
  putQualityMetric: jest.fn(async () => undefined),
  putSchemaMetric: jest.fn(async () => undefined),
}));
jest.mock('../embedding.js', () => ({
  embedText: jest.fn(async () => null),
  toPgVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  cosineDistance: () => 0,
  EMBEDDING_DIMENSIONS: 1024,
}));
jest.mock('../judge.js', () => ({
  judgeResponse: jest.fn(async () => null),
  NOVA_PRO_MODEL_ID: 'amazon.nova-pro-v1:0',
}));

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../../providers/aurora.js';
import { processTrace, _resetCachesForTest, type TraceInput } from '../trace-sink.js';
import { _resetModelPricesForTest } from '../model-prices.js';
import { DEFAULT_MODEL_PRICES } from '../model-prices-defaults.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const execMock = exec as unknown as jest.Mock;
let insertedParams: SqlParameter[] | null = null;
afterAll(() => { fixtureRegistry.resetAll('default'); delete process.env['MOCK_AGENTCORE']; });

beforeEach(() => {
  insertedParams = null;
  jest.clearAllMocks();
  _resetCachesForTest();
  process.env['MOCK_AGENTCORE'] = 'true';
  fixtureRegistry.resetAll('default');
  _resetModelPricesForTest();
  execMock.mockImplementation(async (sql: string, params: SqlParameter[] = []) => {
    if (/FROM observability\.sampling_config/.test(sql)) return [{ template_id: 'default', rate: 1, schema_json: null }];
    if (/INSERT INTO observability\.invocation_traces/.test(sql)) {
      insertedParams = params;
      return [{ invocation_id: 'x' }];
    }
    return [];
  });
});

function param(name: string): SqlParameter | undefined {
  return insertedParams?.find((p) => p.name === name);
}

function trace(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    agentId: 'orgiq-devbox',
    prompt: 'read the README',
    response: 'The README describes the lab.',
    inputTokens: 1000,
    outputTokens: 500,
    modelId: 'us.anthropic.claude-sonnet-5',
    ...overrides,
  };
}

describe('trace-sink prices Claude inference profiles from the table', () => {
  it('a us.anthropic.* trace with a seeded price stores a non-null cost_usd', async () => {
    const r = await processTrace(trace());
    expect(r.inserted).toBe(true);
    const est = param('est_cost_usd');
    expect(est).toBeDefined();
    const sonnet = DEFAULT_MODEL_PRICES['anthropic.claude-sonnet-5']!;
    expect(est?.value?.doubleValue).toBeCloseTo(sonnet.input * 1 + sonnet.output * 0.5, 10);
    expect(param('total_cost_usd')?.value?.doubleValue).toBeCloseTo(sonnet.input * 1 + sonnet.output * 0.5, 10);
  });

  it('with the fixture blanked the same trace stores NULL, not 0', async () => {
    fixtureRegistry.resetAll('empty');
    const r = await processTrace(trace());
    expect(r.inserted).toBe(true);
    expect(param('est_cost_usd')?.value).toEqual({ isNull: true });
    expect(param('total_cost_usd')?.value).toEqual({ isNull: true });
  });

  it('Nova keeps pricing from code either way', async () => {
    fixtureRegistry.resetAll('empty');
    await processTrace(trace({ modelId: 'us.amazon.nova-pro-v1:0' }));
    expect(param('est_cost_usd')?.value?.doubleValue).toBeCloseTo(0.0008 + 0.0032 * 0.5, 10);
  });
});
