// The Architecture page's list half.
//
// The bug these guard against was not a rendering bug. The page drew six
// agents because it had coordinates for six, and then reported "online / 6"
// — a denominator taken from the diagram rather than from the fleet, so the
// page agreed with its own omission instead of admitting it. Every assertion
// below is about the number and the list coming from what the server actually
// returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fleetRows,
  filterFleet,
  offDiagramCount,
  onlineLabel,
  prettyName,
  type FleetSummaryLike,
} from '../agentFleetRows.ts';

function summary(id: string, over: Partial<FleetSummaryLike> = {}): FleetSummaryLike {
  return {
    id,
    status: 'healthy',
    protocol: 'ag-ui',
    model: 'nova-pro-v1',
    tools: [],
    invocationCount: 0,
    errorCount: 0,
    p50Ms: null,
    p95Ms: null,
    ...over,
  };
}

const CATALOG = new Map([
  ['orgiq-supervisor', 'Supervisor'],
  ['orgiq-search', 'Search'],
]);

test('every agent the server returned is a row, diagram or not', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['orgiq-supervisor', summary('orgiq-supervisor')],
    ['orgiq-assessment-scorer', summary('orgiq-assessment-scorer')],
  ]);
  const rows = fleetRows(summaries, CATALOG);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key).sort(), ['orgiq-assessment-scorer', 'orgiq-supervisor']);
});

test('an agent with no coordinates is marked off-diagram and counted', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['orgiq-supervisor', summary('orgiq-supervisor')],
    ['orgiq-assessment-scorer', summary('orgiq-assessment-scorer')],
    ['orgiq-devbox', summary('orgiq-devbox')],
  ]);
  const rows = fleetRows(summaries, CATALOG);
  assert.equal(offDiagramCount(rows), 2);
  assert.equal(rows.find((r) => r.key === 'orgiq-supervisor')!.onDiagram, true);
  assert.equal(rows.find((r) => r.key === 'orgiq-devbox')!.onDiagram, false);
});

test('the online denominator is the fleet, never the catalog', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['orgiq-supervisor', summary('orgiq-supervisor', { status: 'healthy' })],
    ['orgiq-search', summary('orgiq-search', { status: 'offline' })],
    ['orgiq-assessment-scorer', summary('orgiq-assessment-scorer', { status: 'healthy' })],
  ]);
  const rows = fleetRows(summaries, CATALOG);
  // Two of three online. The catalog has two entries; if the denominator came
  // from it this would read "2/2" and claim a whole fleet was up.
  assert.equal(onlineLabel(rows, false), '2/3');
});

test('deploying counts as online; offline and degraded do not', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['a', summary('a', { status: 'deploying' })],
    ['b', summary('b', { status: 'degraded' })],
    ['c', summary('c', { status: 'offline' })],
  ]);
  assert.equal(onlineLabel(fleetRows(summaries, new Map()), false), '1/3');
});

test('a failed fleet read has no number at all, not a zero', () => {
  assert.equal(onlineLabel([], true), null);
});

test('rows sort busiest first, ties by name, so an idle fleet is stable', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['orgiq-zeta', summary('orgiq-zeta', { invocationCount: 0 })],
    ['orgiq-search', summary('orgiq-search', { invocationCount: 50 })],
    ['orgiq-alpha', summary('orgiq-alpha', { invocationCount: 0 })],
  ]);
  const rows = fleetRows(summaries, CATALOG);
  assert.deepEqual(rows.map((r) => r.name), ['Search', 'Alpha', 'Zeta']);
});

test('an unknown agent gets a readable name from its id', () => {
  assert.equal(prettyName('orgiq-assessment-scorer'), 'Assessment Scorer');
  assert.equal(prettyName('orgiq_graph_builder'), 'Graph Builder');
  assert.equal(prettyName('devbox'), 'Devbox');
});

test('the catalog name wins over the derived one', () => {
  const summaries = new Map<string, FleetSummaryLike>([['orgiq-search', summary('orgiq-search')]]);
  assert.equal(fleetRows(summaries, CATALOG)[0]!.name, 'Search');
});

test('a missing status reads unknown rather than defaulting to healthy', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['x', { id: 'x', invocationCount: 0, errorCount: 0, p50Ms: null, p95Ms: null }],
  ]);
  const rows = fleetRows(summaries, new Map());
  assert.equal(rows[0]!.status, 'unknown');
  // And an unknown agent must not be counted as up.
  assert.equal(onlineLabel(rows, false), '0/1');
});

test('filter is identity on an empty query and matches name, id, model and tools', () => {
  const summaries = new Map<string, FleetSummaryLike>([
    ['orgiq-search', summary('orgiq-search', { tools: ['query_knowledge_base'] })],
    ['orgiq-devbox', summary('orgiq-devbox', { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' })],
  ]);
  const rows = fleetRows(summaries, CATALOG);
  assert.equal(filterFleet(rows, '   ').length, 2);
  assert.deepEqual(filterFleet(rows, 'KNOWLEDGE').map((r) => r.key), ['orgiq-search']);
  assert.deepEqual(filterFleet(rows, 'haiku').map((r) => r.key), ['orgiq-devbox']);
  assert.deepEqual(filterFleet(rows, 'devbox').map((r) => r.key), ['orgiq-devbox']);
  assert.equal(filterFleet(rows, 'nothing-matches-this').length, 0);
});
