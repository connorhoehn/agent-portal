// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The work column's rules: which group an item lands in, how the list sorts,
// what a row says about its agent, and which item opens when the URL's is stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_GROUPS, WORK_SORT_OPTIONS, activeFilterCount, isBlocked, kindLabel, ownerOptions, pickCurrent, toWorkListItem, workRows,
} from '../workListModel.ts';
import type { BotRun } from '../../bots/BotsPage';
import type { WorkItemTree } from '../types.ts';

function node(partial: Partial<WorkItemTree> & { id: string }): WorkItemTree {
  return {
    projectId: 'p-x', projectName: 'X', parentId: null, type: 'story', title: partial.id,
    description: null, status: 'open', priority: 'medium', assigneeId: null, assigneeName: null,
    assigneeDept: null, labels: [], storyPoints: null, prUrl: null, prStatus: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', completedAt: null,
    childCount: 0, childDoneCount: 0, children: [],
    ...partial,
  };
}

const tree: WorkItemTree[] = [
  node({
    id: 'e1', type: 'epic', title: 'Epic one',
    children: [
      node({ id: 's-low', title: 'B low', priority: 'low', storyPoints: 8 }),
      node({ id: 's-high', title: 'A high', priority: 'high', storyPoints: 2, status: 'in_progress' }),
      node({ id: 'b-crit', type: 'bug', title: 'C crit', priority: 'critical', status: 'cancelled' }),
    ],
  }),
];

test('rows are the stories and bugs, each remembering its epic, epics excluded', () => {
  const rows = workRows(tree, 'priority', '');
  assert.deepEqual(rows.map((r) => r.id), ['b-crit', 's-high', 's-low']);
  assert.ok(rows.every((r) => r.epicTitle === 'Epic one'));
});

test('sort by points puts the largest first; search narrows by title', () => {
  assert.deepEqual(workRows(tree, 'points', '').map((r) => r.id), ['s-low', 's-high', 'b-crit']);
  assert.deepEqual(workRows(tree, 'priority', 'high').map((r) => r.id), ['s-high']);
});

test('a cancelled item sits under Done with a chip, never vanishing', () => {
  const [crit] = workRows(tree, 'priority', '');
  const row = toWorkListItem(crit!, undefined, false);
  assert.equal(row.groupId, 'done');
  assert.deepEqual(row.chips?.map((c) => c.label), ['Bug', 'Critical', 'Cancelled']);
});

test('a running marketplace run reads "Agent running"; in review reads "Awaiting review"', () => {
  const rows = workRows(tree, 'priority', '');
  const high = rows.find((r) => r.id === 's-high')!;
  const run = { status: 'running' } as BotRun;
  assert.equal(toWorkListItem(high, run, false).signal?.label, 'Agent running');
  assert.equal(toWorkListItem({ ...high, status: 'in_review' }, undefined, false).signal?.label, 'Awaiting review');
  assert.equal(toWorkListItem(high, undefined, false).signal, null);
});

test('the URL item wins while it exists; a stale one falls back to the first item up next', () => {
  const rows = workRows(tree, 'priority', '');
  assert.equal(pickCurrent(rows, 's-high')?.id, 's-high');
  assert.equal(pickCurrent(rows, 'gone')?.id, 's-low');
  assert.equal(pickCurrent(rows, null)?.id, 's-low');
  assert.equal(pickCurrent([], 'gone'), null);
});

test('filters narrow by type, owner (including unassigned) and priority, and count themselves', () => {
  const owned: WorkItemTree[] = [node({
    id: 'e2', type: 'epic', title: 'Epic two',
    children: [
      node({ id: 'a', assigneeId: 'p-1', assigneeName: 'Ann', priority: 'high' }),
      node({ id: 'b', type: 'bug', priority: 'low' }),
    ],
  })];
  const none = { types: [], owners: [], priorities: [] };
  assert.deepEqual(workRows(owned, 'title', '', { ...none, types: ['bug'] }).map((r) => r.id), ['b']);
  assert.deepEqual(workRows(owned, 'title', '', { ...none, owners: ['p-1'] }).map((r) => r.id), ['a']);
  assert.deepEqual(workRows(owned, 'title', '', { ...none, owners: ['none'] }).map((r) => r.id), ['b']);
  assert.deepEqual(workRows(owned, 'title', '', { ...none, owners: ['none', 'p-1'] }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(workRows(owned, 'title', '', { ...none, priorities: ['high'] }).map((r) => r.id), ['a']);
  assert.equal(activeFilterCount({ types: [], owners: ['p-1'], priorities: ['high'] }), 2);
  assert.deepEqual(ownerOptions(workRows(owned, 'title', '')), [
    { value: 'p-1', label: 'Ann' },
    { value: 'none', label: 'Unassigned' },
  ]);
});

test('groups: Next up and In review open, In progress and Done collapsed', () => {
  assert.deepEqual(WORK_GROUPS.map((g) => [g.title, g.defaultOpen ?? true]), [
    ['Next up', true], ['In progress', false], ['In review', true], ['Done', false],
  ]);
});

test('sort labels read as the mockup menu', () => {
  assert.deepEqual(WORK_SORT_OPTIONS.map((o) => o.label), ['By priority', 'By points', 'Recently updated', 'By title']);
});

test('rows carry a kind label and a red Blocked tag; text meta drops the Bug chip', () => {
  const bug = { ...workRows(tree, 'priority', '').find((r) => r.id === 'b-crit')!, status: 'open' as const, labels: ['blocked'] };
  assert.equal(kindLabel(bug), 'Bug');
  assert.equal(isBlocked(bug), true);
  const chipRow = toWorkListItem(bug, undefined, false);
  assert.deepEqual(chipRow.chips?.map((c) => c.label), ['Bug', 'Critical']);
  assert.deepEqual(chipRow.tag, { label: 'Blocked', tone: 'danger' });
  const textRow = toWorkListItem(bug, undefined, false, { metaStyle: 'text' });
  assert.deepEqual(textRow.chips?.map((c) => c.label), ['Critical']);
  assert.equal(textRow.kindLabel, 'Bug');
  // A finished item's leftover label is history, not a live tag.
  assert.equal(toWorkListItem({ ...bug, status: 'done' }, undefined, false).tag, null);
  assert.equal(toWorkListItem(workRows(tree, 'priority', '')[1]!, undefined, false).kindLabel, undefined); // a story names no kind
});
