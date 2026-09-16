// `processTrace` offline — the sink the CloudWatch poller and every agent's
// `ORGIQ_TRACE:` line feed.
//
// Nine backends had no mock branch here (six Aurora statements, two Bedrock
// calls, one CloudWatch publish), so `POST /api/observability/harness/trace`
// and `POST /api/observability/invocations/:id/replay` both 500'd in `dev:mock`
// — and the two rules this pipeline exists to enforce could not be exercised at
// all. Those two rules are what these tests are actually about:
//
//   SAMPLING GATES PERSISTENCE. The die is rolled BEFORE the embed, the judge
//   and the INSERT, so a sampled-out bundle costs nothing and stores nothing.
//   `test:*` is exempt by contract. At the old 0.1 rate this lab wrote one row
//   in ten while the poller logged "persisted N" for every bundle, which is how
//   an observability surface looked broken with no signal why.
//
//   A PHANTOM IS DROPPED ONLY WHEN EVERY AXIS IS EMPTY. No model AND no
//   response AND no tokens AND no tool calls AND no guardrail signal AND no
//   memory events. A real short answer keeps its text and must never be
//   dropped; the predicate is conservative because a false drop is worse than
//   a phantom slipping through.
//
// Neither rule is re-implemented offline — the same code decides both. The
// mock branches are underneath them, at the six statements and three calls.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));
// Any Aurora or CloudWatch call at all is a missing branch, not a slow test.
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
}));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(() => { throw new Error('CloudWatch must not be reached offline'); }),
  putQualityMetric: jest.fn(() => { throw new Error('CloudWatch must not be reached offline'); }),
  putSchemaMetric: jest.fn(() => { throw new Error('CloudWatch must not be reached offline'); }),
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import {
  processTrace, _resetCachesForTest, _phantomSkipCountForTest,
} from '../../lib/trace-sink.js';
import { EMBEDDING_DIMENSIONS, cosineDistance } from '../../lib/embedding.js';
import {
  sinkGuardrailInterventions, sinkMemoryEvents, sinkMetrics, sinkSamplingConfig,
  sinkToolCalls, sinkTraceById, sinkTraces,
} from '../trace-sink.js';

const AT = '2026-09-08T09:15:00.000Z';
const AGENT = 'orgiq-search';
const PROMPT = 'Who are our Kubernetes experts?';
const ANSWER = 'Theo Chang (Staff Engineer, Platform Engineering) is the top Kubernetes '
  + 'expert with a score of 89. James Thompson leads operations, and Nora DaSilva '
  + 'contributed the Kafka deployment.';

let restore = () => {};

beforeEach(() => {
  restore = freezeClock(AT);
  fixtureRegistry.resetAll('default');
  _resetCachesForTest();
});

afterEach(() => {
  restore();
  fixtureRegistry.resetAll('default');
  _resetCachesForTest();
});

describe('a trace lands, with the numbers it actually earned', () => {
  it('judges, embeds, stores and reports one bundle', async () => {
    const result = await processTrace({
      agentId: AGENT,
      agentName: 'Search',
      templateId: 'test:offline',
      prompt: PROMPT,
      response: ANSWER,
      durationMs: 2140,
      modelId: 'amazon.nova-pro-v1:0',
      inputTokens: 400,
      outputTokens: 120,
    });

    expect(result.sampled).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.inserted).toBe(true);
    expect(result.embeddingComputed).toBe(true);
    // The derived verdict, not a canned one — the same 0.975 the judge's own
    // tests pin for this answer.
    expect(result.judgeScore).toBe(0.975);
    expect(result.judgeRationale).toContain('offline/lexical-answer-check');
    // The agent's tokens are the caller's and are priced; the judge bought no
    // tokens offline, so its cost is 0 rather than a fabricated spend.
    expect(result.inputTokens).toBe(400);
    expect(result.judgeInputTokens).toBe(0);
    expect(result.judgeCostUsd).toBe(0);
    expect(result.totalCostUsd).toBe(result.estCostUsd);

    const rows = sinkTraces.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe(AGENT);
    expect(rows[0]!.judge_score).toBe(0.975);
    expect(rows[0]!.model_id).toBe('amazon.nova-pro-v1:0');
    // `ts` is `DEFAULT now()` in the schema — the server's clock, which offline
    // is the mock clock and never `new Date()`.
    expect(rows[0]!.ts).toBe(AT);
    expect(rows[0]!.output_embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('honours ON CONFLICT DO NOTHING — a retried bundle leaves the first row', async () => {
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const first = await processTrace({ agentId: AGENT, invocationId, templateId: 'test:offline', prompt: PROMPT, response: ANSWER });
    const second = await processTrace({ agentId: AGENT, invocationId, templateId: 'test:offline', prompt: PROMPT, response: 'A different, later answer about Kubernetes.' });
    expect(sinkTraces.rows()).toHaveLength(1);
    expect(sinkTraceById(invocationId)!.response_snippet).toBe(ANSWER);
    // The row identity check above is necessary but not sufficient: the
    // second call must also SAY it lost the race, not report `inserted:
    // true` for a write that changed nothing. This is what
    // cw-trace-ingest.ts's "duplicate" counter and the /replay route's
    // "did not report a row" branch both key off.
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it('stores the child rows the bundle carried, capped and validated as live', async () => {
    await processTrace({
      agentId: AGENT,
      templateId: 'test:offline',
      prompt: PROMPT,
      response: ANSWER,
      toolCalls: [
        { toolName: 'query_graph', durationMs: 120, startedAt: '2026-09-08T09:14:59.000Z' },
        { toolName: '   ', durationMs: 5 }, // blank name — rejected on both paths
      ],
      memoryEvents: [
        { kind: 'retrieve', resultCount: 3 },
        { kind: 'teleport' as 'retrieve', resultCount: 1 }, // not a valid kind
      ],
      guardrailInterventions: [
        { ruleName: 'comp-band', action: 'BLOCKED', severity: 'HIGH' },
        { ruleName: 'nope', action: 'SHRUGGED' as 'BLOCKED' }, // not a valid action
      ],
    });

    expect(sinkToolCalls.rows().map((r) => r.tool_name)).toEqual(['query_graph']);
    expect(sinkToolCalls.rows()[0]!.started_at).toBe('2026-09-08T09:14:59.000Z');
    expect(sinkMemoryEvents.rows().map((r) => r.kind)).toEqual(['retrieve']);
    expect(sinkGuardrailInterventions.rows().map((r) => r.rule_name)).toEqual(['comp-band']);
  });
});

describe('sampling gates persistence', () => {
  it('drops a non-test bundle when the configured rate is 0 — before any work', async () => {
    sinkSamplingConfig.rows()[0]!.rate = 0;
    const result = await processTrace({ agentId: AGENT, prompt: PROMPT, response: ANSWER });
    expect(result.sampled).toBe(false);
    expect(result.inserted).toBe(false);
    // Not judged, not embedded, not stored: the die is rolled first for exactly
    // this reason — a sampled-out bundle must cost nothing.
    expect(result.judgeScore).toBeNull();
    expect(result.embeddingComputed).toBe(false);
    expect(sinkTraces.rows()).toHaveLength(0);
    expect(sinkMetrics.rows()).toHaveLength(0);
  });

  it('samples a test:* bundle whatever the rate says', async () => {
    sinkSamplingConfig.rows()[0]!.rate = 0;
    const result = await processTrace({
      agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: ANSWER,
    });
    expect(result.sampled).toBe(true);
    expect(sinkTraces.rows()).toHaveLength(1);
  });

  it('falls back to the hard-coded rate when the table has no rows', async () => {
    // `empty` is the state that made this lab's observability pages look broken:
    // no config row, so `decideSampling` returns 0.1 and nine bundles in ten are
    // dropped. `resetAll` is the in-process switch; over HTTP the same world is
    // one fixture at a time — `POST /api/__mock/scenario
    // {"scenario":"empty","fixture":"trace-sink-sampling"}`.
    fixtureRegistry.resetAll('empty');
    _resetCachesForTest();
    expect(sinkSamplingConfig.rows()).toHaveLength(0);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => processTrace({
        agentId: AGENT, prompt: PROMPT, response: `${ANSWER} #${i}`,
      })),
    );
    const sampled = results.filter((r) => r.sampled).length;
    expect(sampled).toBeLessThan(results.length);
    expect(sinkTraces.rows()).toHaveLength(sampled);
  });
});

describe('the phantom guard', () => {
  it('drops a bundle that is empty on every axis', async () => {
    const before = _phantomSkipCountForTest();
    const result = await processTrace({ agentId: AGENT, prompt: PROMPT, response: '' });
    expect(result.skipped).toBe(true);
    expect(result.sampled).toBe(true);
    expect(result.inserted).toBe(false);
    expect(sinkTraces.rows()).toHaveLength(0);
    expect(_phantomSkipCountForTest()).toBe(before + 1);
  });

  it('keeps a bundle that has substance on ANY axis', async () => {
    // One axis each — a real short answer, a model attribution, token usage, a
    // tool call, a guardrail signal, a memory event. Every one of these is a
    // row that must survive, and a predicate that dropped any of them would be
    // deleting real traffic.
    const substantive = [
      { response: 'Theo Chang.' },
      { response: '', modelId: 'amazon.nova-pro-v1:0' },
      { response: '', inputTokens: 12, outputTokens: 0 },
      { response: '', toolCalls: [{ toolName: 'query_graph' }] },
      { response: '', guardrailAction: 'GUARDRAIL_INTERVENED' },
      { response: '', piiDetected: true },
      { response: '', memoryEvents: [{ kind: 'retrieve' as const }] },
    ];
    for (const extra of substantive) {
      const result = await processTrace({ agentId: AGENT, prompt: PROMPT, ...extra });
      expect(result.skipped).toBe(false);
    }
    expect(sinkTraces.rows()).toHaveLength(substantive.length);
  });

  it('exempts test:* — the harness contract guarantees a row', async () => {
    const result = await processTrace({
      agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: '',
    });
    expect(result.skipped).toBe(false);
    expect(sinkTraces.rows()).toHaveLength(1);
  });
});

describe('the drift half of the pipeline', () => {
  it('publishes no drift until the centroid has its five samples', async () => {
    for (let i = 0; i < 4; i++) {
      await processTrace({
        agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: `${ANSWER} #${i}`,
      });
    }
    expect(sinkMetrics.rows().filter((m) => m.metric_name === 'EmbeddingDriftP95')).toHaveLength(0);
    // Four rows in the window is fewer than CENTROID_MIN_SAMPLES, so a cold
    // offline sink is silent exactly as a cold Aurora is — it does not publish
    // a 0 that an alarm would read as "no drift".

    await processTrace({
      agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: `${ANSWER} #4`,
    });
    const drift = sinkMetrics.rows().filter((m) => m.metric_name === 'EmbeddingDriftP95');
    expect(drift).toHaveLength(1);
    expect(drift[0]!.value).toBeGreaterThanOrEqual(0);
    expect(drift[0]!.value).toBeLessThanOrEqual(2);
    expect(drift[0]!.ts).toBe(AT);
  });

  it('measures vocabulary: a same-subject answer is nearer the centroid than an unrelated one', async () => {
    const { lexicalEmbedding } = await import('../embedding.js');
    const a = lexicalEmbedding(ANSWER, EMBEDDING_DIMENSIONS)!;
    const b = lexicalEmbedding(`${ANSWER} James Thompson also mentors on Kubernetes.`, EMBEDDING_DIMENSIONS)!;
    const c = lexicalEmbedding('Rainfall totals for the coastal counties this quarter.', EMBEDDING_DIMENSIONS)!;
    expect(cosineDistance(a, b)).toBeLessThan(cosineDistance(a, c));
  });

  it('records one JudgeScore datapoint per judged trace', async () => {
    await processTrace({ agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: ANSWER });
    const quality = sinkMetrics.rows().filter((m) => m.metric_name === 'JudgeScore');
    expect(quality).toHaveLength(1);
    expect(quality[0]!.value).toBe(0.975);
  });
});

describe('reset undoes an audit', () => {
  it('puts every sink fixture back where POST /api/__mock/reset would', async () => {
    await processTrace({
      agentId: AGENT, templateId: 'test:offline', prompt: PROMPT, response: ANSWER,
      toolCalls: [{ toolName: 'query_graph' }],
      memoryEvents: [{ kind: 'retrieve' }],
      guardrailInterventions: [{ ruleName: 'comp-band', action: 'BLOCKED' }],
    });
    expect(sinkTraces.rows()).toHaveLength(1);

    fixtureRegistry.resetAll('default');

    expect(sinkTraces.rows()).toHaveLength(0);
    expect(sinkToolCalls.rows()).toHaveLength(0);
    expect(sinkMemoryEvents.rows()).toHaveLength(0);
    expect(sinkGuardrailInterventions.rows()).toHaveLength(0);
    expect(sinkMetrics.rows()).toHaveLength(0);
    expect(sinkSamplingConfig.rows()).toHaveLength(1);
  });
});
