import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedLabel, groupResults, openLabelFor, parseSort, partialSourcesTitle, resultsFooter, searchResultType, countIsLowerBound } from '../resultsModel.ts';
import type { SearchRecord } from '../searchTypes.ts';

const records: SearchRecord[] = [
  { id: 'w1', type: 'work', title: 'Tenant cutover', href: '/iq/work/w1', status: 'blocked' },
  { id: 'k1', type: 'knowledge', title: 'SSO guide', href: '/iq/knowledge/k1' },
  { id: 'p1', type: 'person', title: 'Vera Green', href: '/iq/people/p1', matchReason: 'Matched through initiative membership' },
  { id: 'i1', type: 'initiative', title: 'Auth Migration', href: '/iq/projects/i1' },
  { id: 'w2', type: 'work', title: 'Logout cookie', href: '/iq/work/w2' },
];

test('All results is one list in the server rank order, with a whole-result count', () => {
  const groups = groupResults(records, 'all', 38);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'all');
  assert.equal(groups[0].label, 'All results');
  assert.equal(groups[0].count, 38);
  assert.deepEqual(groups[0].records.map(record => record.id), ['w1', 'k1', 'p1', 'i1', 'w2']);
});

test('a typed view has one heading and pagination counts, and empty views have no groups', () => {
  const work = records.filter(record => record.type === 'work');
  assert.deepEqual(groupResults(work, 'work', 20), [{ id: 'work', label: 'Work', count: 20, records: work }]);
  assert.equal(groupResults(work, 'work', 0)[0].count, work.length);
  assert.deepEqual(groupResults([], 'person', 0), []);
});

test('scoped browsing starts with Work, while explicit types and queries retain their meaning', () => {
  assert.equal(searchResultType(null, 'auth', ''), 'work');
  assert.equal(searchResultType(null, 'auth', '  '), 'work');
  assert.equal(searchResultType('all', 'auth', ''), 'all');
  assert.equal(searchResultType('person', 'auth', ''), 'person');
  assert.equal(searchResultType(null, 'auth', 'cutover'), 'all');
  assert.equal(searchResultType(null, '', ''), 'all');
  assert.equal(searchResultType('invalid', 'auth', ''), 'work');
});

test('footer copy names the scope and pluralises honestly', () => {
  assert.equal(resultsFooter(2, 'Design System API'), '2 results in Design System API');
  assert.equal(resultsFooter(1, null), '1 result');
  assert.equal(resultsFooter(12), '12 results');
  assert.equal(resultsFooter(1, null, true), '1+ results');
  assert.equal(resultsFooter(200, 'Auth Migration', true), '200+ results in Auth Migration');
});

test('scoped row actions and sort parsing', () => {
  assert.equal(openLabelFor('work'), 'Open work item');
  assert.equal(openLabelFor('initiative'), 'Open initiative');
  assert.equal(parseSort('recent'), 'recent');
  assert.equal(parseSort('bogus'), 'relevance');
  assert.equal(parseSort(null), 'relevance');
});

// A partial read (a failed or capped source) makes every server count a floor:
// the tab, the rail and the group headings must all say so, like the footer.
test('a count that is a floor reads "N+" everywhere a count is drawn', () => {
  assert.deepEqual(countedLabel('Results', 44), { label: 'Results', count: 44 });
  assert.deepEqual(countedLabel('Results', 44, true), { label: 'Results 44+' });
  assert.deepEqual(countedLabel('Decisions', 0, true), { label: 'Decisions 0+' });
  assert.deepEqual(countedLabel('Decisions', undefined, true), { label: 'Decisions' });
  const groups = groupResults(records, 'all', 5, true);
  assert.deepEqual(groups.map(group => group.label), ['All results, at least']);
  assert.equal(groupResults(records.filter(record => record.type === 'work'), 'work', 2)[0].label, 'Work');
  assert.equal(partialSourcesTitle(['Approved design decisions unavailable']), 'One source is incomplete — counts are minimums');
  assert.equal(partialSourcesTitle(['Work source window is limited', 'Decisions unavailable']), '2 sources are incomplete — counts are minimums');
});


test('recording results retain a distinct group, action and canonical file link', () => {
  const recording: SearchRecord = { id: 'rec-7', type: 'recording', title: 'Auth huddle', href: '/iq/projects/auth?tab=docs&recording=rec-7', description: 'Transcript excerpt' };
  const group = groupResults([recording], 'recording', 1)[0];
  assert.equal(group.label, 'Recordings');
  assert.equal(group.id, 'recording');
  assert.equal(group.records[0].href, recording.href);
  assert.equal(openLabelFor('recording'), 'Open recording');
});

test('only the types a partial source feeds carry a floor', () => {
  const data = { totalIsLowerBound: true, lowerBoundCounts: ['recording', 'all'] as Array<'recording' | 'all'> };
  assert.equal(countIsLowerBound(data, 'recording'), true);
  assert.equal(countIsLowerBound(data, 'all'), true);
  assert.equal(countIsLowerBound(data, 'person'), false);
  assert.equal(countIsLowerBound({ totalIsLowerBound: false, lowerBoundCounts: [] }, 'all'), false);
  // An older server: any short source marks every count.
  assert.equal(countIsLowerBound({ totalIsLowerBound: true }, 'person'), true);
  assert.equal(countIsLowerBound(null, 'person'), false);
});
