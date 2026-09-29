import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionsView, focusedRecordEdges, focusedRecords, focusOrgPeople, orgFocusIds } from '../connectionsModel.ts';
import { searchMigration } from '../searchModel.ts';
import { parseRecordKeys, recordKey, type SearchEdge, type SearchRecord } from '../searchTypes.ts';

const rec = (type: SearchRecord['type'], id: string): SearchRecord => ({ type, id, title: id, href: `/iq/${type}/${id}` });
const sarah = rec('person', 'p-014');
const auth = rec('initiative', 'auth');
const cutover = rec('work', 'cutover');
const observations = Array.from({ length: 15 }, (_, i) => rec('knowledge', `obs-${i}`));
const edges: SearchEdge[] = [
  { id: 'e1', source: 'person:vera', target: 'initiative:auth', label: 'owns' },
  { id: 'e2', source: 'initiative:auth', target: 'work:cutover', label: 'includes' },
];
const records = [sarah, auth, cutover, rec('person', 'vera'), ...observations];

test('a lone person selection with no query is the org graph (the p-014 screenshot)', () => {
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:p-014'], query: '', edges: [], records: [sarah, ...observations] }), 'org');
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:a', 'person:b'], query: '  ', edges, records }), 'org');
});

test('the People type filter is always the org graph, query or not', () => {
  assert.equal(connectionsView({ type: 'person', selectedKeys: [], query: 'auth', edges: [], records: [] }), 'org');
  assert.equal(connectionsView({ type: 'person', selectedKeys: ['initiative:auth'], query: '', edges, records }), 'org');
});

test('the legacy /iq/explore?focus=<id> link lands on the org view', () => {
  const url = new URL(searchMigration('/iq/explore', '?focus=p-014'), 'http://local');
  const selectedKeys = parseRecordKeys(url.searchParams.get('selection')).map(recordKey);
  assert.equal(url.searchParams.get('tab'), 'connections');
  assert.equal(connectionsView({ type: 'all', selectedKeys, query: url.searchParams.get('q') ?? '', edges: [], records: [] }), 'org');
  assert.deepEqual(orgFocusIds(selectedKeys), ['p-014']);
});

test('records when an edge touches the selection, or any edge with no selection', () => {
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:vera', 'work:cutover'], query: 'who', edges, records }), 'records');
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:vera'], query: 'who', edges, records }), 'records');
  assert.equal(connectionsView({ type: 'all', selectedKeys: [], query: 'auth', edges, records }), 'records');
});

test('empty when no edge touches the selection, or an edge end is not loaded', () => {
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['knowledge:obs-1'], query: '', edges, records }), 'empty');
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:p-014'], query: 'x', edges, records }), 'empty');
  assert.equal(connectionsView({ type: 'all', selectedKeys: [], query: '', edges: [], records }), 'empty');
  assert.equal(connectionsView({ type: 'all', selectedKeys: ['person:vera'], query: 'x', edges, records: [rec('person', 'vera')] }), 'empty');
});

test('focusedRecords is the selection plus connected records, never filler', () => {
  assert.deepEqual(focusedRecords(records, edges, ['work:cutover']).map(recordKey), ['work:cutover', 'initiative:auth']);
  assert.deepEqual(focusedRecords(records, edges, []).map(recordKey).sort(), ['initiative:auth', 'person:vera', 'work:cutover']);
  assert.deepEqual(focusedRecords([sarah, ...observations], [], ['person:p-014']).map(recordKey), ['person:p-014']);
  assert.deepEqual(focusedRecordEdges(records, edges, ['person:vera']).map(e => e.id), ['e1']);
});

test('orgFocusIds keeps bare, unique person ids only', () => {
  assert.deepEqual(orgFocusIds(['person:p-1', 'initiative:auth', 'person:p-1', 'person:p-2']), ['p-1', 'p-2']);
  assert.deepEqual(orgFocusIds([]), []);
});

test('focusOrgPeople narrows to the focus and direct neighbours', () => {
  const people = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const rels = [{ source: 'a', target: 'b' }, { source: 'c', target: 'a' }, { source: 'c', target: 'd' }, { source: 'b', target: 'c' }];
  const narrowed = focusOrgPeople(people, rels, ['a']);
  assert.deepEqual(narrowed.people.map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(narrowed.relationships, [rels[0], rels[1], rels[3]]);
  assert.equal(focusOrgPeople(people, rels, []).people, people);
  assert.deepEqual(focusOrgPeople(people, rels, ['zzz']).people, []);
});
