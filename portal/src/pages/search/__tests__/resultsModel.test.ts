import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedLabel, groupResults, openLabelFor, parseSort, partialSourcesTitle, resultsFooter } from '../resultsModel.ts';
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
  const groups = groupResults(records, { person: 1, initiative: 1, work: 2, knowledge: 1 }, type => `?type=${type}`, true);
  assert.deepEqual(groups.map(group => group.label), ['People, at least', 'Initiatives, at least', 'Work, at least', 'Knowledge, at least']);
  assert.equal(groupResults(records, { work: 2 }, type => `?type=${type}`)[2].label, 'Work');
  assert.equal(partialSourcesTitle(['Approved design decisions unavailable']), 'One source is incomplete — counts are minimums');
  assert.equal(partialSourcesTitle(['Work source window is limited', 'Decisions unavailable']), '2 sources are incomplete — counts are minimums');
});
