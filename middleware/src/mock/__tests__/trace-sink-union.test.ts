// The write side and the read side are one table.
//
// WHAT WAS WRONG. `mock/trace-sink.ts` holds what `processTrace` writes offline
// and `mock/observability.ts` `traceRows()` holds the seeded day. They were two
// worlds that never met: a trace posted to `POST /api/observability/harness/trace`
// was sampled, embedded, judged and stored, was counted by `GET /api/__mock/state`
// and could be re-judged by id — and appeared in no list and no rollup, because
// every read goes through `traceRows()` and `traceRows()` could not see it. Two
// views of one table disagreeing, with nothing saying so, which is contract.ts
// bug #1 at its widest.
//
// WHAT THESE TESTS ARE ABOUT. Not "the union happens" — that is one assertion.
// They are about the two things a union of a SEEDED corpus and a WRITTEN one can
// get wrong:
//
//   THE SEEDED TAIL MUST NOT MOVE. Six surfaces count it, and
//   `/recent-invocations` depends on its error rows being banded newer than its
//   clean rows. So the seeded half is pinned bit-for-bit across a write: same
//   rows, same order, same instants, same parents.
//
//   A WRITTEN ROW MUST NOT BE DRESSED AS A SEEDED ONE. The seeded corpus
//   synthesises tool calls from the agent's documented tools, fires guardrail
//   rules from the guardrail fixture, models a drift distance from an authored
//   band and links a quarter of its rows to a supervisor parent. Doing ANY of
//   that to a row that really ran would be inventing telemetry for a real
//   request — worse than the gap it replaces, because it looks like evidence.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
}));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(),
  putQualityMetric: jest.fn(),
  putSchemaMetric: jest.fn(),
}));

import { fixtureRegistry, freezeClock } from '../core/index.js';
import { processTrace, _resetCachesForTest, type TraceInput } from '../../lib/trace-sink.js';
import { cosineDistance as libCosineDistance } from '../../lib/embedding.js';
import { cosineDistance, sinkToolCalls, sinkTraces } from '../trace-sink.js';
import {
  interventionRows, memoryEventRows, modelledDistance, percentileCont,
  toolCallRows, traceRows, tracesInWindow, type MockTraceRow,
} from '../observability.js';
import {
  isRealFailure, mockDriftOutliers, mockDriftSummary, mockInvocationSearch,
  mockInvocationToolCalls, mockMemoryStats, mockToolLatency, mockTrafficPerAgentSummary,
} from '../observability-queries.js';
import { ERROR_WINDOW } from '../invocations.js';

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

/**
 * A live (non-`test:`) bundle, so it reaches the lists and the rollups.
 *
 * The defaults carry REAL SUBSTANCE — a model, an answer, tokens and a duration
 * — on purpose. `processTrace`'s phantom guard drops a bundle only when every
 * substance axis is empty at once, so a helper that let a caller omit `response`
 * by accident would silently be exercising the drop branch while reading like a
 * successful write. A test that wants the phantom path asks for it in full,
 * as `drops a call whose trace is not in the table` does below.
 */
async function postTrace(over: Partial<TraceInput> = {}) {
  return processTrace({
    agentId: AGENT,
    agentName: 'Search',
    prompt: PROMPT,
    response: ANSWER,
    durationMs: 810,
    modelId: 'amazon.nova-pro-v1:0',
    inputTokens: 290,
    outputTokens: 140,
    ...over,
  });
}

const seeded = (rows: MockTraceRow[]) => rows.filter((r) => r.source === 'seed');
const written = (rows: MockTraceRow[]) => rows.filter((r) => r.source === 'sink');

// ── The seeded tail does not move ──────────────────────────────────────────

describe('the seeded day is unchanged by anything written beside it', () => {
  it('is byte-for-byte the same corpus before and after a write', async () => {
    const before = traceRows();
    expect(written(before)).toEqual([]);

    await postTrace();

    const after = traceRows();
    expect(written(after)).toHaveLength(1);
    // Not "the same length" and not "the same ids" — the same ROWS, in the same
    // order, with every field equal. A union that re-derived or re-banded the
    // seed would move numbers on six pages, and nothing else here would notice.
    expect(seeded(after)).toEqual(before);
  });

  it('layers the written row on top rather than interleaving into the day', async () => {
    await postTrace();
    const rows = traceRows();
    expect(rows[0]!.source).toBe('sink');
    expect(rows.slice(1).every((r) => r.source === 'seed')).toBe(true);
    // Newest first, still — the order every list and every bucketing relies on.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.tsIso >= rows[i]!.tsIso).toBe(true);
    }
  });

  it('keeps every seeded error inside the tail window the Runs list actually shows', async () => {
    await postTrace();
    const rows = seeded(traceRows());
    // The REQUIREMENT (org-leader.md #14), not the mechanism: every THROWN run
    // — the rows carrying `error`, which project to `schema_valid: false` —
    // must rank inside `ERROR_WINDOW` (`mock/invocations.ts`), because
    // `getRecentInvocations` prepends live ring traffic ahead of this fixture
    // before applying `/recent-invocations`'s default 50-row cap. The bare
    // `/recent-invocations` route only needs `TAIL_WINDOW` (50); the parity
    // invariant "the promised errors survive the default 50-row window"
    // (mock/core/parity/invariants.ts) models a manual audit session's live
    // traffic — ten rows — landing ahead of the mock tail, which is why the
    // real placement budget is `TAIL_WINDOW - LIVE_RING_HEADROOM` (40), not
    // the full 50: an error ranked 40-49 survives the route's bare window but
    // not the one with live traffic in front of it, and Health counts it
    // either way. A guardrail block is deliberately not part of this — it
    // produced no exception, so it is not `isRealFailure`, which counts both.
    //
    // `mock/invocations.ts` used to satisfy this with two disjoint recency
    // bands — every error strictly ahead of every clean row — which over-shot
    // the requirement and made the Runs list wall-to-wall red (see
    // middleware/src/mock/core/contract.ts, "The error band, and what it costs"). Errors are now
    // interleaved through `ERROR_WINDOW` instead, so this only asserts what
    // the route (and the invariant that models its live-traffic case)
    // actually depends on, whatever the corpus size.
    const threw = (r: MockTraceRow) => r.schema_valid === false;
    const errorRanks = rows.reduce<number[]>((acc, r, i) => (threw(r) ? [...acc, i] : acc), []);
    expect(errorRanks.length).toBeGreaterThan(0);
    for (const rank of errorRanks) {
      expect(rank).toBeLessThan(ERROR_WINDOW);
    }
  });

  it('a reset takes the written row away and leaves the day standing', async () => {
    const before = traceRows();
    await postTrace();
    expect(traceRows()).toHaveLength(before.length + 1);

    // What `POST /api/__mock/reset` does.
    fixtureRegistry.resetAll('default');
    expect(traceRows()).toEqual(before);
  });

  it('every seeded rollup is unmoved while the sink is empty', () => {
    // The guard on the whole union: with nothing written, every selector must
    // answer exactly what it answered before the sink was joined in. Pinned
    // against the corpus's own totals rather than a captured snapshot.
    const summary = mockTrafficPerAgentSummary(24);
    expect(summary.reduce((a, r) => a + (r['invocations'] as number), 0)).toBe(335);
    expect(tracesInWindow(24).every((r) => r.source === 'seed')).toBe(true);
    expect(toolCallRows().every((c) => c.trace.source === 'seed')).toBe(true);
    expect(interventionRows().length).toBeGreaterThan(0);
  });
});

// ── The written row reaches the list and the rollups ───────────────────────

describe('a trace that exists is a trace the list shows', () => {
  it('appears in the search list, newest first', async () => {
    const result = await postTrace();
    expect(result.inserted).toBe(true);

    const rows = mockInvocationSearch({
      q: '', agentId: '', minScore: null, maxScore: null,
      since: null, until: null, promptVersion: '', userId: '', limit: 200,
    });
    expect(rows[0]!['invocation_id']).toBe(result.invocationId);
    expect(rows[0]!['prompt_snippet']).toBe(PROMPT);
    expect(rows[0]!['judge_score']).toBe(result.judgeScore);
  });

  it('is countable in the per-agent rollup, and the rollup is its rows', async () => {
    const before = mockTrafficPerAgentSummary(24).find((r) => r['agent_id'] === AGENT)!;
    await postTrace();
    const after = mockTrafficPerAgentSummary(24).find((r) => r['agent_id'] === AGENT)!;

    expect(after['invocations']).toBe((before['invocations'] as number) + 1);

    // THE pin the mandate asks for: the rollup is a selector over the rows a
    // reader can open, written rows included. If these ever disagree the
    // summary is promising something the list cannot show.
    const mine = tracesInWindow(24).filter((t) => t.agent_id === AGENT);
    expect(after['invocations']).toBe(mine.length);
    expect(after['error_count']).toBe(mine.filter(isRealFailure).length);
    expect(after['low_quality_count'])
      .toBe(mine.filter((t) => t.judge_score !== null && t.judge_score < 0.3).length);
    expect(after['p50']).toBe(percentileCont(mine.map((t) => t.duration_ms), 0.5));
    expect(after['p99']).toBe(percentileCont(mine.map((t) => t.duration_ms), 0.99));
  });

  it('moves no OTHER agent’s numbers', async () => {
    const before = mockTrafficPerAgentSummary(24).filter((r) => r['agent_id'] !== AGENT);
    await postTrace();
    const after = mockTrafficPerAgentSummary(24).filter((r) => r['agent_id'] !== AGENT);
    expect(after).toEqual(before);
  });

  it('a written failure is an error, and a weak answer is not', async () => {
    const base = mockTrafficPerAgentSummary(24).find((r) => r['agent_id'] === AGENT)!;

    // A guardrail intervention is a real failure — `errorRate`'s first half.
    await postTrace({
      agentId: AGENT,
      invocationId: '22222222-2222-4222-8222-222222222222',
      guardrailAction: 'BLOCKED',
      guardrailInterventions: [{ ruleName: 'comp-band', action: 'BLOCKED', severity: 'HIGH' }],
    });
    // A weak but genuine answer is NOT an error — it is low quality, counted
    // separately, which is the gotcha that made a healthy fleet alarm once.
    await postTrace({
      agentId: AGENT,
      invocationId: '33333333-3333-4333-8333-333333333333',
      prompt: PROMPT,
      response: 'Some people know it.',
    });

    const after = mockTrafficPerAgentSummary(24).find((r) => r['agent_id'] === AGENT)!;
    expect(after['invocations']).toBe((base['invocations'] as number) + 2);
    expect(after['error_count']).toBe((base['error_count'] as number) + 1);
    expect(after['low_quality_count']).toBe((base['low_quality_count'] as number) + 1);
  });
});

// ── Nothing is invented for a row that really ran ──────────────────────────

describe('a written row brings its own telemetry and is given none', () => {
  it('carries exactly the tool calls it posted, not the agent’s tool list', async () => {
    const result = await postTrace({
      agentId: AGENT,
      toolCalls: [{ toolName: 'query_graph', durationMs: 120, startedAt: '2026-09-08T09:14:59.000Z' }],
    });

    const calls = mockInvocationToolCalls(result.invocationId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!['tool_name']).toBe('query_graph');
    // The seeded half gives every trace one to three calls drawn from
    // `agentFleet`'s tools. A real request that called one tool must read as
    // one tool.
    expect(toolCallRows().filter((c) => c.invocation_id === result.invocationId)).toHaveLength(1);
  });

  it('gets no tool calls at all when it declared none', async () => {
    const result = await postTrace();
    expect(mockInvocationToolCalls(result.invocationId)).toEqual([]);
  });

  it('fires only the guardrail rules it posted', async () => {
    const quiet = await postTrace();
    expect(interventionRows().filter((i) => i.invocation_id === quiet.invocationId)).toEqual([]);

    const blocked = await postTrace({
      agentId: AGENT,
      invocationId: '44444444-4444-4444-8444-444444444444',
      guardrailAction: 'BLOCKED',
      guardrailInterventions: [{ ruleName: 'comp-band', action: 'BLOCKED', severity: 'HIGH' }],
    });
    const fired = interventionRows().filter((i) => i.invocation_id === blocked.invocationId);
    expect(fired.map((i) => i.rule_name)).toEqual(['comp-band']);
  });

  it('gets no memory events synthesised for it', async () => {
    const result = await postTrace();
    // orgiq-search's profile says `usesMemory`, so the seeded half would have
    // given this row a retrieve and a write. It declared none, so it has none.
    expect(memoryEventRows().filter((e) => e.invocation_id === result.invocationId)).toEqual([]);

    const withMemory = await postTrace({
      agentId: AGENT,
      invocationId: '55555555-5555-4555-8555-555555555555',
      memoryEvents: [{ kind: 'retrieve', resultCount: 3, durationMs: 44 }],
    });
    const events = memoryEventRows().filter((e) => e.invocation_id === withMemory.invocationId);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('retrieve');
    expect(events[0]!.result_count).toBe(3);
    // And the /stats rollup counts it, because it is one of that agent's rows.
    const stats = mockMemoryStats(24).find((r) => r['agent_id'] === AGENT)!;
    expect(stats['retrieves']).toBe(
      memoryEventRows().filter((e) => e.agent_id === AGENT && e.kind === 'retrieve').length,
    );
  });

  it('neither acquires an A2A parent nor becomes one', async () => {
    const result = await postTrace();
    const row = traceRows().find((r) => r.invocation_id === result.invocationId)!;
    expect(row.parent_invocation_id).toBeNull();
    expect(traceRows().some((r) => r.parent_invocation_id === result.invocationId)).toBe(false);
  });

  it('keeps the parent it was posted with', async () => {
    const parent = await postTrace({ agentId: 'orgiq-supervisor', invocationId: '66666666-6666-4666-8666-666666666666' });
    const child = await postTrace({
      agentId: AGENT,
      invocationId: '77777777-7777-4777-8777-777777777777',
      parentInvocationId: parent.invocationId,
    });
    const row = traceRows().find((r) => r.invocation_id === child.invocationId)!;
    expect(row.parent_invocation_id).toBe(parent.invocationId);
  });

  it('borrows no drift band — its distance is measured or it is nothing', async () => {
    const result = await postTrace();
    const row = traceRows().find((r) => r.invocation_id === result.invocationId)!;
    expect(row.profile).toBeNull();
    expect(row.output_embedding).not.toBeNull();

    // One written row is its own centroid, which is what `AVG(output_embedding)`
    // over a one-row window returns, so the distance is 0 — a measurement, not
    // a number drawn from `orgiq-search`'s authored 0.07±0.04 band.
    expect(modelledDistance(row)).toBe(0);

    // And the drift rollup is still a percentile over the rows it can list.
    const summary = mockDriftSummary(24).find((r) => r['agent_id'] === AGENT)!;
    const mine = tracesInWindow(24).filter((t) => t.agent_id === AGENT);
    expect(summary['cnt']).toBe(mine.length);
    expect(summary['drift_p95']).toBe(
      percentileCont(mine.map(modelledDistance).filter((d): d is number => d !== null), 0.95) ?? 0,
    );
  });

  it('is reachable in the 1h outlier list on the strength of its own measured distance', async () => {
    // This used to read "the seeded clean rows cannot reach here": the old
    // two-band corpus put every clean row 8–24h back, so the 1h window held
    // only failures (no embedding, no distance) and a written row was the
    // ONLY thing that could ever appear. That is no longer true — interleaving
    // the errors through the tail (middleware/src/mock/core/contract.ts, "The error band, and
    // what it costs") means some of the day's own clean rows now legitimately
    // fall inside the newest hour too, so the list is non-empty before any
    // write. What's still true, and what this asserts instead: a written row
    // reaches the list on its own measured distance, not by having an empty
    // list to appear in.
    const before = mockDriftOutliers(undefined, 20);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((r) => r['agent_id'] === AGENT)).toBe(true); // seeded orgiq-search rows

    const result = await postTrace();
    const after = mockDriftOutliers(undefined, 20);
    expect(after).toHaveLength(before.length + 1);

    const mine = after.find((r) => r['invocation_id'] === result.invocationId);
    expect(mine).toBeDefined();
    // One written row is its own centroid (see the distance-0 case above), so
    // sorted by dist descending it sinks to the very bottom rather than
    // displacing a seeded outlier that scored higher.
    expect(mine!['dist']).toBe(0);
    expect(after[after.length - 1]!['invocation_id']).toBe(result.invocationId);
  });
});

// ── The tool-call rollup sees written calls ────────────────────────────────

describe('written tool calls join the tool rollups', () => {
  it('are counted by /latency and attributed to the right agent', async () => {
    const before = mockToolLatency(24, AGENT).find((r) => r['tool_name'] === 'query_graph');
    const beforeCnt = (before?.['cnt'] as number) ?? 0;

    await postTrace({
      agentId: AGENT,
      toolCalls: [{ toolName: 'query_graph', durationMs: 120, startedAt: AT }],
    });

    const after = mockToolLatency(24, AGENT).find((r) => r['tool_name'] === 'query_graph')!;
    expect(after['cnt']).toBe(beforeCnt + 1);
    // Another agent's panel is untouched.
    expect(mockToolLatency(24, 'orgiq-scoring'))
      .toEqual(mockToolLatency(24, 'orgiq-scoring'));
  });

  it('drops a call whose trace is not in the table', () => {
    // An orphan is reachable in the real table too — `tool_calls` has no FK to
    // `invocation_traces` and the trace INSERT can lose an `ON CONFLICT` race —
    // and the rollups all read the trace for the agent and the test-traffic
    // filter, so a call that cannot answer those is not a row any query could
    // have returned. Written straight into the fixture because `processTrace`
    // will not produce one: a bundle carrying tool calls has substance, so the
    // phantom guard keeps its trace.
    sinkToolCalls.rows().push({
      invocation_id: '99999999-9999-4999-8999-999999999999',
      tool_name: 'query_graph',
      started_at: AT,
      duration_ms: 40,
      input_size: null,
      output_size: null,
      errored: false,
      error_message: null,
      input_sample: null,
      output_sample: null,
      est_cost_usd: null,
    });
    expect(sinkTraces.rows()).toHaveLength(0);
    expect(toolCallRows().every((c) => c.trace.source === 'seed')).toBe(true);
  });
});

// ── The duplicated arithmetic is held to its original ──────────────────────

describe('the mock cosine distance is the same function lib/embedding.ts has', () => {
  it('agrees on ordinary, orthogonal, identical and degenerate vectors', () => {
    const cases: Array<[number[], number[]]> = [
      [[1, 0, 0], [1, 0, 0]],
      [[1, 0, 0], [0, 1, 0]],
      [[1, 2, 3], [4, 5, 6]],
      [[-1, 2, -3], [3, -2, 1]],
      [[0, 0, 0], [1, 2, 3]],
      [[1, 2], [1, 2, 3]],
      [[], []],
    ];
    for (const [a, b] of cases) {
      expect(cosineDistance(a, b)).toBeCloseTo(libCosineDistance(a, b), 12);
    }
  });
});
