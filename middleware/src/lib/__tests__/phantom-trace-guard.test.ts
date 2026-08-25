// The write-side phantom-trace guard in trace-sink.processTrace().
//
// Some bundles reaching the sink carry no substance — model_id NULL, an empty
// response, no tokens, no tool calls, no guardrail signal. These are partial/
// aborted runs or the middleware's own pre-agent `recordInvocation` shape.
// Persisting them poisons the drift/quality/error surfaces (a NULL-model,
// empty-response row scores as a hard failure it never was) while adding no
// signal. processTrace now drops them BEFORE any embed/judge/INSERT.
//
// The guard is deliberately conservative: a real short answer, a legitimately
// missing model that still carries a response/tokens/tools, or a guardrail
// block with an empty response must all survive.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
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
  judgeResponse: jest.fn(async () => ({
    score: 0.8,
    rationale: 'fine',
    usage: { inputTokens: 100, outputTokens: 20 },
  })),
  NOVA_PRO_MODEL_ID: 'amazon.nova-pro-v1:0',
}));

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../../providers/aurora.js';
import { embedText } from '../embedding.js';
import { judgeResponse } from '../judge.js';
import {
  processTrace,
  _resetCachesForTest,
  _phantomSkipCountForTest,
  type TraceInput,
} from '../trace-sink.js';

const execMock = exec as unknown as jest.Mock;
const judgeMock = judgeResponse as unknown as jest.Mock;
const embedMock = embedText as unknown as jest.Mock;

/** Count how many rows were INSERTed into invocation_traces. */
let inserts = 0;

beforeEach(() => {
  inserts = 0;
  jest.clearAllMocks();
  _resetCachesForTest();
  execMock.mockImplementation(async (sql: string, _params: SqlParameter[] = []) => {
    if (/FROM observability\.sampling_config/.test(sql)) {
      // rate 1 — take sampling out of the picture; this is about the guard.
      return [{ template_id: 'default', rate: 1, schema_json: null }];
    }
    if (/INSERT INTO observability\.invocation_traces/.test(sql)) {
      inserts++;
      return [];
    }
    return [];
  });
});

const AGENT_ID = 'orgiq-supervisor';

function base(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    agentId: AGENT_ID,
    prompt: 'Who knows auth best?',
    response: '',
    ...overrides,
  };
}

describe('phantom-trace write guard', () => {
  it('drops the canonical phantom: no model, empty response, no tokens, no tools', async () => {
    const r = await processTrace(base());
    expect(r.skipped).toBe(true);
    expect(r.inserted).toBe(false);
    expect(r.sampled).toBe(true);
    expect(inserts).toBe(0);
    // No embed / judge spend on a bundle we already know we're dropping.
    expect(embedMock).not.toHaveBeenCalled();
    expect(judgeMock).not.toHaveBeenCalled();
    expect(_phantomSkipCountForTest()).toBe(1);
  });

  it('drops a whitespace-only response the same as an empty one', async () => {
    const r = await processTrace(base({ response: '   \n\t ' }));
    expect(r.skipped).toBe(true);
    expect(inserts).toBe(0);
  });

  it('KEEPS a legitimate short answer, even with no model', async () => {
    const r = await processTrace(base({ response: 'Priya Raman.' }));
    expect(r.skipped).toBe(false);
    expect(r.inserted).toBe(true);
    expect(inserts).toBe(1);
  });

  it('KEEPS a bundle that reports tokens but has an empty response', async () => {
    const r = await processTrace(base({ outputTokens: 12 }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('KEEPS a bundle with a model attributed', async () => {
    const r = await processTrace(base({ modelId: 'amazon.nova-pro-v1:0' }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('KEEPS a bundle that made tool calls', async () => {
    const r = await processTrace(base({ toolCalls: [{ toolName: 'search_people' }] }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('KEEPS a guardrail-blocked run with an empty response — a block is substantive', async () => {
    const r = await processTrace(base({ guardrailAction: 'BLOCKED' }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('KEEPS an empty response flagged for PII', async () => {
    const r = await processTrace(base({ piiDetected: true }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('KEEPS a run carrying memory events', async () => {
    const r = await processTrace(base({ memoryEvents: [{ kind: 'retrieve' }] }));
    expect(r.skipped).toBe(false);
    expect(inserts).toBe(1);
  });

  it('EXEMPTS test:* templates — harness writes are guaranteed a row', async () => {
    const r = await processTrace(base({ templateId: 'test:smoke' }));
    expect(r.skipped).toBe(false);
    expect(r.inserted).toBe(true);
    expect(inserts).toBe(1);
  });

  it('accumulates the skip counter across phantoms', async () => {
    await processTrace(base());
    await processTrace(base({ response: '' }));
    expect(_phantomSkipCountForTest()).toBe(2);
  });
});
