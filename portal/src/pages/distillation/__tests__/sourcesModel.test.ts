// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sourceRows, sourceHref, sourcesGraph, lineageGraph, tierGraph, graphListRows, sourceKindLabel, recordFileKind, sourceLevel,
} from '../sourcesModel.ts';
import { tierFlowModel } from '../tierFlowModel.ts';
import type { CompactionRun, ItemSourcesResponse, Lineage } from '../types.ts';

const SOURCES: ItemSourcesResponse = {
  sources: [
    { id: 'cl-1', kind: 'cluster', title: 'Retries need jitter', timestamp: '2026-09-24T09:00:00Z', excerpt: 'Three sessions…' },
    { id: 'obs-7', kind: 'observation', title: '', timestamp: null, excerpt: null, session_id: 'sess-1', repo: 'api' },
    { id: 'sess-1', kind: 'session', title: 'Session sess-1', timestamp: null, excerpt: null },
    { id: 'cl-1', kind: 'cluster', title: 'duplicate', timestamp: null, excerpt: null },
  ],
};

test('source rows: kind label, fallback title, link into Knowledge', () => {
  const rows = sourceRows(SOURCES);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kindLabel, 'Pattern');
  assert.equal(rows[0].href, '/iq/distillation/knowledge?view=patterns&item=cl-1');
  assert.equal(rows[1].title, 'Run note obs-7', 'an empty title never renders blank');
  assert.equal(rows[1].href, '/iq/distillation/knowledge?view=notes&item=obs-7');
  assert.equal(rows[1].sessionId, 'sess-1');
  assert.equal(rows[1].repo, 'api');
  assert.equal(rows[2].href, null, 'a session is not a Knowledge record and GET /items cannot filter by it');
  assert.deepEqual(sourceRows(null), []);
});

test('sourceHref for a guide and an unknown kind', () => {
  assert.equal(sourceHref({ id: 'art-1', kind: 'artifact' }), '/iq/distillation/knowledge?item=art-1');
  assert.equal(sourceHref({ id: 'x', kind: 'mystery' }), null);
  assert.equal(sourceKindLabel('library_item'), 'Library asset');
});

test('sources graph: the item on the right, each distinct source → item', () => {
  const g = sourcesGraph({ id: 'art-1', kind: 'artifact', title: 'Retry guide' }, SOURCES);
  assert.equal(g.nodes.length, 4, 'duplicate source collapsed');
  const item = g.nodes[0];
  assert.equal(item.id, 'art-1');
  assert.equal(item.data.current, true);
  for (const n of g.nodes.slice(1)) assert.ok(n.rank < item.rank, `${n.id} sits left of the item`);
  assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.label]), [
    ['cl-1', 'art-1', 'distilled into'],
    ['obs-7', 'art-1', 'evidence for'],
    ['sess-1', 'art-1', 'wrote'],
  ]);
});

test('sources graph for a run note keeps evidence left of it', () => {
  const g = sourcesGraph({ id: 'obs-7', kind: 'observation', title: 'n' }, { sources: [{ id: 's', kind: 'session', title: 'S', timestamp: null, excerpt: null }] });
  assert.ok(g.nodes[1].rank < g.nodes[0].rank);
});

test('lineage graph: relation labels, written_by reversed, dangling edges dropped', () => {
  const lineage: Lineage = {
    nodes: [
      { id: 'sess', kind: 'session', label: 'Session', meta: {} },
      { id: 'o1', kind: 'observation', label: 'Note', meta: {} },
      { id: 'c1', kind: 'cluster', label: 'Pattern', meta: {} },
      { id: 'a1', kind: 'artifact', label: 'Guide', meta: {} },
      { id: 'lib', kind: 'library_item', label: 'Asset', meta: {} },
    ],
    edges: [
      { from: 'o1', to: 'sess', relation: 'written_by' },
      { from: 'o1', to: 'c1', relation: 'merged_into' },
      { from: 'c1', to: 'a1', relation: 'distilled_into' },
      { from: 'a1', to: 'lib', relation: 'published_as' },
      { from: 'a1', to: 'ghost', relation: 'supports' },
    ],
  };
  const g = lineageGraph(lineage, 'a1');
  assert.deepEqual(g.edges.map((e) => `${e.from}-${e.label}-${e.to}`), [
    'sess-wrote-o1', 'o1-merged into-c1', 'c1-distilled into-a1', 'a1-published as-lib',
  ]);
  assert.equal(g.nodes.find((n) => n.id === 'a1')!.data.current, true);
  assert.equal(g.nodes.find((n) => n.id === 'lib')!.data.href, '/iq/library/lib');
  assert.equal(g.nodes.find((n) => n.id === 'c1')!.data.href, '/iq/distillation/knowledge?view=patterns&item=c1');
  assert.deepEqual(lineageGraph(null), { nodes: [], edges: [] });

  const list = graphListRows(g);
  assert.equal(list[0].from, 'Session', 'list equivalent reads left to right');
  assert.equal(list.length, 4);
});

function run(id: string, level: 'L1' | 'L2', status: CompactionRun['status'], percent?: number): CompactionRun {
  return {
    id, level, status, startedAt: '2026-09-24T11:00:00Z', finishedAt: null,
    inputItems: 0, outputItems: 0, dedupedItems: 0, bytesReclaimed: 0, costUsd: 0, percent,
  };
}

test('tier graph: tiers + Library, Compact/Compact/Publish, markers only for live jobs', () => {
  const flow = tierFlowModel([
    { level: 'L0', count: 10 }, { level: 'L1', count: 4, health: { state: 'behind', reason: '', lagSeconds: 60 } }, { level: 'L2', count: 2 },
  ], 1);
  const g = tierGraph(flow, [
    run('j-old', 'L1', 'succeeded'),
    run('j-run', 'L1', 'running', 42.4),
    run('j-q', 'L2', 'queued'),
  ]);
  assert.deepEqual(g.nodes.map((n) => [n.id, n.kind, n.rank]), [['L0', 'tier', 0], ['L1', 'tier', 1], ['L2', 'tier', 2], ['library', 'library', 3]]);
  assert.deepEqual(g.edges.map((e) => [e.id, e.label, e.tone]), [
    ['L0->L1', 'Compact', 'warning'], ['L1->L2', 'Compact', undefined], ['L2->library', 'Publish', undefined],
  ]);
  assert.equal(g.edges[0].animated, true);
  assert.deepEqual(g.edges[0].marker, { id: 'j-run', label: 'Running 42%', tone: 'info' });
  assert.equal(g.edges[1].animated, false, 'queued is not animated');
  assert.equal(g.edges[1].marker?.label, 'Queued');
  assert.equal(g.edges[2].marker, undefined);
  assert.equal(g.nodes[0].data.href, '/iq/distillation/knowledge?view=notes');

  const list = graphListRows(g);
  assert.equal(list[0].relation, 'Compact (Running 42%)');
});

test('tier graph with no jobs has no markers or animation', () => {
  const g = tierGraph(tierFlowModel([], null));
  assert.ok(g.edges.every((e) => !e.animated && !e.marker));
  assert.equal(g.nodes[0].data.value, null);
});

test('record kinds map onto the library FileKind glyphs', () => {
  assert.equal(recordFileKind('artifact', 'runbook'), 'page');
  assert.equal(recordFileKind('artifact', 'procedure'), 'workflow');
  assert.equal(recordFileKind('cluster'), 'diagram');
  assert.equal(recordFileKind('observation'), 'transcript');
  assert.equal(recordFileKind('session'), 'conversation');
  assert.equal(sourceLevel('cluster'), 'L1');
  assert.equal(sourceLevel('session'), null);
});
