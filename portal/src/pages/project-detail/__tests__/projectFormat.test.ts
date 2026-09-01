// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json.
// projectFormat is pure TypeScript (no DOM, no fetch, type-only imports), so
// Node's type-stripping loader runs it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketByStatus,
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

test('bucketByStatus files every story and bug into one of the four lanes', () => {
  const b = bucketByStatus(EPIC);
  assert.deepEqual(b.get('open')!.map((n) => n.id), ['s2c', 'b1']);
  assert.deepEqual(b.get('in_progress')!.map((n) => n.id), ['s2', 's2b']);
  assert.deepEqual(b.get('in_review')!.map((n) => n.id), []);
  assert.deepEqual(b.get('done')!.map((n) => n.id), ['s1', 's1a', 's1b', 's2a']);
});

test('bucketByStatus keeps a cancelled item visible in Open rather than dropping it', () => {
  // The board shows four lanes; an item in a fifth status must not vanish.
  const epic = node({ id: 'e', type: 'epic', children: [node({ id: 'x', status: 'cancelled' })] });
  assert.deepEqual(bucketByStatus(epic).get('open')!.map((n) => n.id), ['x']);
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
