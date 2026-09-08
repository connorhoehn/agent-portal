// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json.
// projectFormat is pure TypeScript (no DOM, no fetch, type-only imports), so
// Node's type-stripping loader runs it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countPoints,
  countStories,
  flattenByType,
  hasActiveGrantOnInitiative,
  parseTs,
  progressColor,
  runsByWorkItem,
  sumForestPoints,
} from '../projectFormat.ts';
import type { WorkItemTree } from '../types.ts';

/** Minimal tree node — only the fields the derivations read. */
function node(partial: Partial<WorkItemTree> & { id: string }): WorkItemTree {
  return {
    projectId: 'p-1', projectName: 'P', parentId: null, type: 'story',
    title: partial.id, description: null, status: 'open', priority: 'medium',
    assigneeId: null, assigneeName: null, assigneeDept: null, labels: [],
    storyPoints: null, prUrl: null, prStatus: null,
    createdAt: '', updatedAt: '', completedAt: null,
    childCount: 0, childDoneCount: 0, children: [],
    ...partial,
  };
}

// The shape the API actually returns: an epic whose stories have stories under
// them. Everything sized lives at depth 2, which is why the rollups have to
// walk the whole subtree rather than the direct children.
const EPIC = node({
  id: 'e1', type: 'epic', status: 'in_progress',
  children: [
    node({
      id: 's1', status: 'done', children: [
        node({ id: 's1a', status: 'done', storyPoints: 8 }),
        node({ id: 's1b', status: 'done', storyPoints: 5 }),
      ],
    }),
    node({
      id: 's2', status: 'in_progress', children: [
        node({ id: 's2a', status: 'done', storyPoints: 5 }),
        node({ id: 's2b', status: 'in_progress', storyPoints: 8 }),
        node({ id: 's2c', status: 'open', storyPoints: 5 }),
        node({ id: 'b1', type: 'bug', status: 'open', storyPoints: 3 }),
      ],
    }),
  ],
});

// ─── Tree arithmetic ─────────────────────────────────────────────────────────

test('countPoints sums sized descendants at every depth, not just children', () => {
  // 8+5 done, plus 5 done / 8+5+3 not — bugs are sized work and count.
  assert.deepEqual(countPoints(EPIC), { done: 18, total: 34 });
});

test('countPoints ignores unsized nodes and the epic itself', () => {
  const bare = node({ id: 'e', type: 'epic', storyPoints: 99, children: [] });
  assert.deepEqual(countPoints(bare), { done: 0, total: 0 });
});

test('countStories counts stories only — a bug is not a story', () => {
  // s1, s1a, s1b, s2, s2a, s2b, s2c = 7 stories; b1 excluded.
  assert.deepEqual(countStories(EPIC), { done: 4, total: 7 });
});

test('sumForestPoints rolls the whole forest up and derives the percentage', () => {
  assert.deepEqual(sumForestPoints([EPIC]), { done: 18, total: 34, pct: 53 });
});

test('sumForestPoints reports 0% rather than dividing by zero on unsized work', () => {
  assert.deepEqual(sumForestPoints([node({ id: 'e', type: 'epic' })]), { done: 0, total: 0, pct: 0 });
});

test('flattenByType reaches every depth', () => {
  assert.deepEqual(
    flattenByType([EPIC], ['story', 'bug']).map((n) => n.id),
    ['s1', 's1a', 's1b', 's2', 's2a', 's2b', 's2c', 'b1'],
  );
  assert.deepEqual(flattenByType([EPIC], ['epic']).map((n) => n.id), ['e1']);
});

// ─── Run selection ───────────────────────────────────────────────────────────

interface Run { workItemId: string | null; status: string; startedAt: string }
const run = (workItemId: string | null, status: string, startedAt: string): Run =>
  ({ workItemId, status, startedAt });

test('parseTs normalizes Aurora timestamps that arrive without T/Z', () => {
  assert.equal(parseTs('2026-09-01 12:00:00'), Date.parse('2026-09-01T12:00:00Z'));
  assert.equal(parseTs('2026-09-01T12:00:00Z'), Date.parse('2026-09-01T12:00:00Z'));
});

test('runsByWorkItem prefers a running run over a newer finished one', () => {
  const runs = [
    run('wi-1', 'running', '2026-09-01 10:00:00'),
    run('wi-1', 'succeeded', '2026-09-01 18:00:00'),
  ];
  assert.equal(runsByWorkItem(runs as never)['wi-1']!.startedAt, '2026-09-01 10:00:00');
});

test('runsByWorkItem falls back to the newest when none is running', () => {
  const runs = [
    run('wi-1', 'failed', '2026-09-01 10:00:00'),
    run('wi-1', 'succeeded', '2026-09-01 18:00:00'),
  ];
  assert.equal(runsByWorkItem(runs as never)['wi-1']!.startedAt, '2026-09-01 18:00:00');
});

test('runsByWorkItem drops runs not attached to a work item', () => {
  assert.deepEqual(Object.keys(runsByWorkItem([run(null, 'running', '2026-09-01 10:00:00')] as never)), []);
});

// ─── Grant cue ───────────────────────────────────────────────────────────────

test('hasActiveGrantOnInitiative needs grantee AND active AND this initiative', () => {
  const sprints = [
    { orgProjectId: 'p-1', status: 'active', isGrantee: false },
    { orgProjectId: 'p-1', status: 'closed', isGrantee: true },
    { orgProjectId: 'p-2', status: 'active', isGrantee: true },
  ];
  assert.equal(hasActiveGrantOnInitiative(sprints, 'p-1'), false);
  assert.equal(hasActiveGrantOnInitiative([...sprints, { orgProjectId: 'p-1', status: 'active', isGrantee: true }], 'p-1'), true);
  assert.equal(hasActiveGrantOnInitiative([], 'p-1'), false);
});

// ─── Progress tone ───────────────────────────────────────────────────────────

test('progressColor steps warning → primary → success at 40 and 80', () => {
  assert.match(progressColor(0), /warning/);
  assert.match(progressColor(39), /warning/);
  assert.match(progressColor(40), /primary/);
  assert.match(progressColor(79), /primary/);
  assert.match(progressColor(80), /success/);
  assert.match(progressColor(100), /success/);
});

// ─── One board, one table ────────────────────────────────────────────────────

import {
  flattenWorkItems, filterWorkItems, bucketItemsByStatus, epicFacets, assigneeFacets,
} from '../projectFormat.ts';

function flatNode(over: Partial<WorkItemTree> & Pick<WorkItemTree, 'id' | 'title' | 'type'>): WorkItemTree {
  return {
    projectId: 'p', projectName: 'P', parentId: null, description: null,
    status: 'open', priority: 'medium', assigneeId: null, assigneeName: null,
    assigneeDept: null, labels: [], storyPoints: null, prUrl: null, prStatus: null,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', completedAt: null,
    childCount: 0, childDoneCount: 0, children: [], ...over,
  };
}

const EPICS: WorkItemTree[] = [
  flatNode({ id: 'e1', title: 'SLOs', type: 'epic', children: [
    flatNode({ id: 's1', title: 'Error-budget dashboard', type: 'story', assigneeId: 'p-004', assigneeName: 'Nora', labels: ['runbook'] }),
    flatNode({ id: 'b1', title: 'Alert dedup storm', type: 'bug', status: 'in_progress', assigneeId: 'p-011', assigneeName: 'Eli' }),
  ] }),
  flatNode({ id: 'e2', title: 'Control Plane', type: 'epic', children: [
    flatNode({ id: 's2', title: 'Node upgrade', type: 'story', status: 'done', assigneeId: 'p-004', assigneeName: 'Nora' }),
  ] }),
];

test('flattenWorkItems drops epics and tags each item with its epic', () => {
  const flat = flattenWorkItems(EPICS);
  assert.deepEqual(flat.map((i) => i.id), ['s1', 'b1', 's2']);
  assert.equal(flat[0]!.epicTitle, 'SLOs');
  assert.equal(flat[2]!.epicId, 'e2');
  // An epic is a container, never a row of work.
  assert.ok(!flat.some((i) => i.type === 'epic'));
});

test('filterWorkItems: every facet tolerates the "all" sentinel', () => {
  const flat = flattenWorkItems(EPICS);
  assert.equal(filterWorkItems(flat, { epicId: 'all', status: 'all', type: 'all' }).length, 3);
  assert.deepEqual(filterWorkItems(flat, { epicId: 'e1' }).map((i) => i.id), ['s1', 'b1']);
  assert.deepEqual(filterWorkItems(flat, { status: 'done' }).map((i) => i.id), ['s2']);
  assert.deepEqual(filterWorkItems(flat, { type: 'bug' }).map((i) => i.id), ['b1']);
  assert.deepEqual(filterWorkItems(flat, { assigneeId: 'p-011' }).map((i) => i.id), ['b1']);
});

test('search covers what people actually type — title, epic, assignee, labels', () => {
  const flat = flattenWorkItems(EPICS);
  assert.deepEqual(filterWorkItems(flat, { q: 'dedup' }).map((i) => i.id), ['b1']);
  assert.deepEqual(filterWorkItems(flat, { q: 'control plane' }).map((i) => i.id), ['s2']);
  assert.deepEqual(filterWorkItems(flat, { q: 'eli' }).map((i) => i.id), ['b1']);
  assert.deepEqual(filterWorkItems(flat, { q: 'runbook' }).map((i) => i.id), ['s1']);
  // Searching an epic's name returns that epic's whole backlog, which is the
  // point of carrying epicTitle onto every row.
  assert.deepEqual(filterWorkItems(flat, { q: 'slos' }).map((i) => i.id), ['s1', 'b1']);
});

test('bucketItemsByStatus keeps a cancelled item visible in Open rather than dropping it', () => {
  // The board draws four lanes; an item in a fifth status must not vanish.
  const epic = flatNode({ id: 'e', title: 'E', type: 'epic', children: [
    flatNode({ id: 'x', title: 'Abandoned', type: 'story', status: 'cancelled' }),
  ] });
  const by = bucketItemsByStatus(flattenWorkItems([epic]));
  assert.deepEqual(by.get('open')!.map((i) => i.id), ['x']);
});

test('bucketItemsByStatus makes ONE board for the whole backlog', () => {
  // Not one board per epic: an initiative has a single backlog, and an epic is
  // a filter over it.
  const by = bucketItemsByStatus(flattenWorkItems(EPICS));
  assert.deepEqual(by.get('open')!.map((i) => i.id), ['s1']);
  assert.deepEqual(by.get('in_progress')!.map((i) => i.id), ['b1']);
  assert.deepEqual(by.get('done')!.map((i) => i.id), ['s2']);
  assert.equal(by.get('in_review')!.length, 0);
});

test('facets count real membership, and assignees list only people holding work', () => {
  const flat = flattenWorkItems(EPICS);
  assert.deepEqual(epicFacets(EPICS, flat), [
    { value: 'e1', label: 'SLOs', count: 2 },
    { value: 'e2', label: 'Control Plane', count: 1 },
  ]);
  const people = assigneeFacets(flat);
  assert.deepEqual(people.map((p) => p.label), ['Nora', 'Eli']);
  assert.equal(people[0]!.count, 2);
});

// ─── Deep-linking one item ───────────────────────────────────────────────────

test('an item link resolves against the UNFILTERED backlog', () => {
  // The drawer looks its item up in the full list, not the filtered one: a
  // link pasted from Slack has to open even when the recipient's saved
  // filters would hide that row.
  const all = flattenWorkItems(EPICS);
  const visible = filterWorkItems(all, { status: 'done' });
  assert.equal(visible.find((i) => i.id === 'b1'), undefined);
  assert.equal(all.find((i) => i.id === 'b1')?.title, 'Alert dedup storm');
});

test('every row carries the ids needed to cite it', () => {
  // The user asked for machine slugs "all the way down": an item names its
  // own id, its epic's, and its initiative's, so any row can be quoted to an
  // agent without opening anything.
  for (const item of flattenWorkItems(EPICS)) {
    assert.ok(item.id.length > 0);
    assert.ok(item.epicId.length > 0);
    assert.ok(item.projectId.length > 0);
  }
});


// ─── Item links are additive ─────────────────────────────────────────────────

/** Mirrors useOpenWorkItem's itemHref — pure, so it is testable without a router. */
function itemHref(current: string, id: string): string {
  const next = new URLSearchParams(current);
  next.set('item', id);
  return `?${next.toString()}`;
}

test('opening an item preserves the params already in the URL', () => {
  // A bare `?item=x` would replace the whole query string. Opening a row is an
  // addition to the current view, never a reset of it.
  assert.equal(itemHref('lens=sprints', 'wi-1'), '?lens=sprints&item=wi-1');
  assert.equal(itemHref('', 'wi-1'), '?item=wi-1');
});

test('opening a second item replaces only the item param', () => {
  assert.equal(itemHref('lens=sprints&item=wi-1', 'wi-2'), '?lens=sprints&item=wi-2');
});

// ─── Initiative age ──────────────────────────────────────────────────────────

import { daysRunning, runningLabel } from '../projectFormat.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');

test('daysRunning counts whole days, and tolerates the two timestamp shapes', () => {
  assert.equal(daysRunning('2026-09-02T00:00:00Z', NOW), 0);
  assert.equal(daysRunning('2026-08-03T12:00:00Z', NOW), 30);
  // Aurora hands back "YYYY-MM-DD HH:MM:SS" with no T and no Z.
  assert.equal(daysRunning('2026-08-03 12:00:00', NOW), 30);
});

test('daysRunning refuses to report a negative age', () => {
  // A start date in the future is bad data, not "-4 days running".
  assert.equal(daysRunning('2026-09-06T12:00:00Z', NOW), 0);
});

test('daysRunning returns null rather than NaN for missing or junk dates', () => {
  assert.equal(daysRunning(null, NOW), null);
  assert.equal(daysRunning('not a date', NOW), null);
});

test('runningLabel scales the unit to the age', () => {
  assert.equal(runningLabel(0), 'today');
  assert.equal(runningLabel(1), '1 day');
  assert.equal(runningLabel(30), '30 days');
  assert.equal(runningLabel(60), '2 mo');
  assert.equal(runningLabel(365), '1y');
  assert.equal(runningLabel(428), '1y 2m');
  assert.equal(runningLabel(null), '—');
});

// ─── Activity buckets ────────────────────────────────────────────────────────

import { activityBuckets } from '../projectFormat.ts';

const T = Date.parse('2026-09-02T18:30:00Z');

test('every day in the window gets a bucket, including the quiet ones', () => {
  // A sparkline reads its array positionally; dropping empty days would
  // compress the gaps and draw a busier initiative than the real one.
  const b = activityBuckets([{ startedAt: '2026-09-02T01:00:00Z', costUsd: 1 }], [], 7, T);
  assert.equal(b.labels.length, 7);
  assert.equal(b.runs.length, 7);
  assert.deepEqual(b.runs, [0, 0, 0, 0, 0, 0, 1]);
  assert.equal(b.labels[6], '2026-09-02');
  assert.equal(b.labels[0], '2026-08-27');
});

test('the window ends on today regardless of the time of day', () => {
  // Anchored on UTC midnight — otherwise the whole window slides with the
  // clock and the same data lands in different buckets through the day.
  const morning = activityBuckets([], [], 5, Date.parse('2026-09-02T00:05:00Z'));
  const evening = activityBuckets([], [], 5, Date.parse('2026-09-02T23:55:00Z'));
  assert.deepEqual(morning.labels, evening.labels);
});

test('runs sum their cost into the right day, and totals match the arrays', () => {
  const b = activityBuckets(
    [
      { startedAt: '2026-09-01T03:00:00Z', costUsd: 1.005 },
      { startedAt: '2026-09-01T22:00:00Z', costUsd: 2 },
      { startedAt: '2026-09-02T09:00:00Z', costUsd: null },
    ],
    [{ completedAt: '2026-09-02T10:00:00Z' }, { completedAt: null }],
    3, T,
  );
  assert.deepEqual(b.runs, [0, 2, 1]);
  assert.deepEqual(b.spendUsd, [0, 3.01, 0]);
  assert.deepEqual(b.completed, [0, 0, 1]);
  assert.equal(b.totals.runs, b.runs.reduce((x, y) => x + y, 0));
  assert.equal(b.totals.completed, 1);
  assert.equal(b.totals.spendUsd, 3.01);
});

test('a null cost counts as a run but adds no spend', () => {
  const b = activityBuckets([{ startedAt: '2026-09-02T09:00:00Z', costUsd: null }], [], 2, T);
  assert.equal(b.totals.runs, 1);
  assert.equal(b.totals.spendUsd, 0);
});

test('anything outside the window is ignored, not clamped into an edge bucket', () => {
  // Clamping would pile a year of history onto day one and invent a spike.
  const b = activityBuckets(
    [{ startedAt: '2025-01-01T00:00:00Z', costUsd: 99 }],
    [{ completedAt: '2027-01-01T00:00:00Z' }],
    5, T,
  );
  assert.equal(b.totals.runs, 0);
  assert.equal(b.totals.spendUsd, 0);
  assert.equal(b.totals.completed, 0);
});

test('the day span is clamped to a sane range', () => {
  assert.equal(activityBuckets([], [], 0, T).labels.length, 1);
  assert.equal(activityBuckets([], [], 500, T).labels.length, 180);
});

test('junk timestamps are skipped rather than throwing or landing on NaN', () => {
  const b = activityBuckets([{ startedAt: 'not a date', costUsd: 5 }], [], 3, T);
  assert.equal(b.totals.runs, 0);
});
