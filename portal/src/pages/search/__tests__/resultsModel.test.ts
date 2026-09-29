import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupResults, openLabelFor, parseSort, resultsFooter } from '../resultsModel.ts';
import type { SearchRecord } from '../searchTypes.ts';

const records: SearchRecord[] = [
  { id: 'w1', type: 'work', title: 'Tenant cutover', href: '/iq/work/w1', status: 'blocked' },
  { id: 'k1', type: 'knowledge', title: 'SSO guide', href: '/iq/knowledge/k1' },
  { id: 'p1', type: 'person', title: 'Vera Green', href: '/iq/people/p1', matchReason: 'Matched through initiative membership' },
  { id: 'i1', type: 'initiative', title: 'Auth Migration', href: '/iq/projects/i1' },
  { id: 'w2', type: 'work', title: 'Logout cookie', href: '/iq/work/w2' },
];

test('groups follow People, Initiatives, Work, Decisions, Knowledge, Agent library and skip empty types', () => {
  const groups = groupResults(records, { person: 1, initiative: 1, work: 2, knowledge: 1 }, type => `?type=${type}`);
  assert.deepEqual(groups.map(group => group.id), ['person', 'initiative', 'work', 'knowledge']);
  assert.deepEqual(groups.map(group => group.label), ['People', 'Initiatives', 'Work', 'Knowledge']);
  assert.deepEqual(groups[2].records.map(record => record.id), ['w1', 'w2']);
});

test('a group counts the whole result set and offers See all only when the page holds fewer', () => {
  const groups = groupResults(records, { person: 3, work: 2 }, type => `/iq/search?type=${type}`);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].seeAllHref, '/iq/search?type=person');
  assert.equal(groups.find(group => group.id === 'work')!.seeAllHref, undefined);
  // A missing or stale count never reads lower than the rows on screen.
  assert.equal(groups.find(group => group.id === 'initiative')!.count, 1);
});

test('footer copy names the scope and pluralises honestly', () => {
  assert.equal(resultsFooter(2, 'Design System API'), '2 results in Design System API');
  assert.equal(resultsFooter(1, null), '1 result');
  assert.equal(resultsFooter(12), '12 results');
});

test('scoped row actions and sort parsing', () => {
  assert.equal(openLabelFor('work'), 'Open work item');
  assert.equal(openLabelFor('initiative'), 'Open initiative');
  assert.equal(parseSort('recent'), 'recent');
  assert.equal(parseSort('bogus'), 'relevance');
  assert.equal(parseSort(null), 'relevance');
});
