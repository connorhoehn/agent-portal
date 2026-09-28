import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSearchGraph, graphRecordKey, layoutSearchGraph } from '../searchGraph.ts';
import type { SearchRecord, SearchEdge } from '../searchTypes.ts';

const records: SearchRecord[] = [
  { id: 'shared', type: 'person', title: 'Owner', href: '/people/shared' },
  { id: 'shared', type: 'initiative', title: 'Initiative', href: '/initiatives/shared' },
  { id: 'work', type: 'work', title: 'Blocked work', href: '/work/work', status: 'blocked' },
  { id: 'guide', type: 'knowledge', title: 'A guide', href: '/knowledge/guide' },
];
const edges: SearchEdge[] = [
  { id: 'owns', source: 'person:shared', target: 'initiative:shared', label: 'owns' },
  { id: 'includes', source: 'initiative:shared', target: 'work:work', label: 'includes' },
  { id: 'missing', source: 'knowledge:guide', target: 'work:missing', label: 'supports' },
];

test('mixed graph preserves typed IDs and does not create relationships for disconnected records', () => {
  const graph = filterSearchGraph([...records, records[0]], [...edges, edges[0]], 'all');
  assert.equal(graph.records.length, 4);
  assert.deepEqual(graph.edges.map(edge => edge.id), ['owns', 'includes']);
  assert.notEqual(graphRecordKey(records[0]), graphRecordKey(records[1]));
  assert.ok(graph.records.some(record => record.id === 'guide'));
});

test('type filtering removes edges whose other endpoint is hidden', () => {
  const graph = filterSearchGraph(records, edges, 'person');
  assert.deepEqual(graph.records, [records[0]]);
  assert.deepEqual(graph.edges, []);
});

test('all layouts retain disconnected records and handle cyclic evidence without mutating inputs', () => {
  const cyclic = [...edges, { id: 'cycle', source: 'work:work', target: 'person:shared', label: 'assigned to' }];
  const before = JSON.stringify({ records, cyclic });
  for (const layout of ['force', 'radial', 'hierarchy'] as const) {
    const positions = layoutSearchGraph(records, cyclic, layout);
    assert.equal(positions.size, records.length);
    assert.equal(new Set([...positions.values()].map(point => `${point.x},${point.y}`)).size, records.length);
    for (const position of positions.values()) {
      assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    }
  }
  assert.equal(JSON.stringify({ records, cyclic }), before);
});

test('hierarchy follows directed edges and force layout is repeatable', () => {
  const hierarchy = layoutSearchGraph(records, edges, 'hierarchy');
  assert.ok(hierarchy.get('person:shared')!.x < hierarchy.get('initiative:shared')!.x);
  assert.ok(hierarchy.get('initiative:shared')!.x < hierarchy.get('work:work')!.x);
  assert.deepEqual(layoutSearchGraph(records, edges, 'force'), layoutSearchGraph(records, edges, 'force'));
});
