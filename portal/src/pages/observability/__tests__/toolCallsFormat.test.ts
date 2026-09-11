import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorTone,
  filterErrors,
  fmtMs,
  fmtPct,
  fmtTs,
  fmtToolCost,
  latencyTone,
  matchesQuery,
  summarize,
  volumeSeriesByTool,
  windowFor,
  type ToolErrorRow,
  type ToolLatencyRow,
  type ToolTimeseriesPoint,
} from '../toolCallsFormat.ts';

const point = (bucketStart: string, toolName: string, count: number): ToolTimeseriesPoint => ({
  bucketStart, toolName, count, p99DurationMs: 100, errorRate: 0, totalCostUsd: 0,
});

test('windowFor falls back to 24h for an unknown label', () => {
  assert.equal(windowFor('24h').hours, 24);
  assert.equal(windowFor('nonsense').label, '24h');
});

test('volumeSeriesByTool pads idle buckets with a real zero', () => {
  // The wire omits a (bucket, tool) row when the tool did not run, so a tool
  // seen in one of three buckets must still draw as a three-point series.
  const series = volumeSeriesByTool([
    point('2026-09-08 06:00:00+00', 'query_graph', 3),
    point('2026-09-08 07:00:00+00', 'query_graph', 5),
    point('2026-09-08 08:00:00+00', 'query_graph', 1),
    point('2026-09-08 07:00:00+00', 'vector_search', 9),
  ]);
  assert.deepEqual(series.get('query_graph'), [3, 5, 1]);
  assert.deepEqual(series.get('vector_search'), [0, 9, 0]);
});

test('volumeSeriesByTool orders buckets chronologically regardless of payload order', () => {
  const series = volumeSeriesByTool([
    point('2026-09-08 08:00:00+00', 'a', 2),
    point('2026-09-08 06:00:00+00', 'a', 1),
  ]);
  assert.deepEqual(series.get('a'), [1, 2]);
});

test('volumeSeriesByTool on an empty payload yields no series', () => {
  assert.equal(volumeSeriesByTool([]).size, 0);
});

test('matchesQuery is case-insensitive and empty matches everything', () => {
  assert.equal(matchesQuery('search_knowledge_base', 'KNOW'), true);
  assert.equal(matchesQuery('search_knowledge_base', '  '), true);
  assert.equal(matchesQuery('search_knowledge_base', 'graph'), false);
});

const err = (agentId: string, toolName: string): ToolErrorRow => ({
  toolCallId: `${agentId}-${toolName}`, invocationId: 'inv-1', agentId, toolName,
  errorMessage: 'boom', ts: '2026-09-08 08:19:23+00',
});

test('filterErrors applies the agent and tool filters the server does not', () => {
  // GET /tools/errors takes only `limit` — no agentId, no windowHours — so
  // without this the error tail contradicts the table above it.
  const rows = [err('orgiq-search', 'query_graph'), err('orgiq-supervisor', 'route_to_agent')];
  assert.equal(filterErrors(rows, { agentId: 'all', query: '' }).length, 2);
  assert.equal(filterErrors(rows, { agentId: 'orgiq-search', query: '' }).length, 1);
  assert.equal(filterErrors(rows, { agentId: 'all', query: 'route' })[0]?.agentId, 'orgiq-supervisor');
  assert.equal(filterErrors(rows, { agentId: 'orgiq-search', query: 'route' }).length, 0);
});

const row = (over: Partial<ToolLatencyRow>): ToolLatencyRow => ({
  toolName: 't', count: 10, p50DurationMs: 100, p99DurationMs: 200,
  errorRate: 0, totalCostUsd: 0, withCost: 0, ...over,
});

test('summarize counts tools with any failure, not failed calls', () => {
  const s = summarize([
    row({ toolName: 'a', count: 92, errorRate: 0.01, totalCostUsd: 0.5, withCost: 92 }),
    row({ toolName: 'b', count: 81, errorRate: 0 }),
  ]);
  assert.deepEqual(s, { tools: 2, calls: 173, failing: 1, costUsd: 0.5 });
});

test('summarize of nothing is all zeros, never NaN', () => {
  assert.deepEqual(summarize([]), { tools: 0, calls: 0, failing: 0, costUsd: 0 });
});

test('fmtToolCost distinguishes a free tool from an unpriced one', () => {
  // withCost === 0 means no row carried an estimate — not "it was free".
  assert.equal(fmtToolCost(0, 0), '—');
  assert.equal(fmtToolCost(0, 84), '$0.0000');
  assert.equal(fmtToolCost(0.017975, 84), '$0.018');
  assert.equal(fmtToolCost(2.5, 84), '$2.50');
});

test('fmtMs steps from ms to seconds to minutes', () => {
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtMs(837.27), '837ms');
  assert.equal(fmtMs(1633.64), '1.6s');
  assert.equal(fmtMs(120_000), '2.0m');
});

test('fmtPct renders a wire fraction as a percentage', () => {
  assert.equal(fmtPct(0.010869565217391304), '1.1%');
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(undefined), '—');
});

test('errorTone treats a clean tool as neutral, not as good news', () => {
  assert.equal(errorTone(0), 'neutral');
  assert.equal(errorTone(0.01), 'warning');
  assert.equal(errorTone(0.5), 'danger');
});

test('latencyTone is neutral when p99 is unknown', () => {
  assert.equal(latencyTone(null), 'neutral');
  assert.equal(latencyTone(300), 'success');
  assert.equal(latencyTone(2000), 'warning');
  assert.equal(latencyTone(6000), 'danger');
});

test('fmtTs parses the Postgres +00 offset rather than echoing the raw string', () => {
  // `2026-09-08T08:19:23+00` is Invalid Date in V8 — a bare-hour offset is not
  // ISO 8601 — which is how the raw database text reached the WHEN column.
  const out = fmtTs('2026-09-08 08:19:23+00');
  assert.notEqual(out, '2026-09-08 08:19:23+00');
  assert.equal(out, new Date('2026-09-08T08:19:23+00:00').toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }));
});

test('fmtTs leaves an unparseable value alone rather than printing NaN', () => {
  assert.equal(fmtTs(''), '—');
  assert.equal(fmtTs('not a date'), 'not a date');
});
