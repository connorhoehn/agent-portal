// Run with:  cd portal && node --test 'src/pages/sprints/__tests__/*.test.ts'
//
// Same runner as sprintForm.test.ts — plain node:test, no DOM. Everything in
// sprintFormat is pure by construction, which is the point of having pulled it
// out of the .tsx: the rollup reducer, the column bucketing and the option
// grouping used to sit inside a render where none of it could be asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usd, shortDate, daysUntil, windowProgress, dateRange, timeLeftLabel,
  isOverEnvelope, mineReasons, sprintTotals, bucketByColumn, flattenTree,
  addableItems, peopleGroups,
} from '../sprintFormat.ts';
import type { Sprint, WorkItem, WorkTreeNode } from '../types.ts';

// A sprint with every field at a neutral value; tests override what they mean.
function sprint(over: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1', orgProjectId: 'p1', orgProjectName: 'Auth', name: 'Sprint 1', goal: null,
    stewardPersonId: null, stewardName: null, startsOn: '2026-01-01', endsOn: '2026-01-15',
    status: 'active', itemCount: 0, doneItemCount: 0, pointsTotal: 0, pointsDone: 0,
    estimatedCostUsd: 0, grantedUsd: 0, grantCount: 0, initiativeSpendInWindowUsd: 0,
    isSteward: false, isGrantee: false, myItemCount: 0, myOpenItemCount: 0,
    ...over,
  };
}

// ─── Money ───────────────────────────────────────────────────────────────────

test('usd always shows two decimal places and thousands separators', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(30.5), '$30.50');
  assert.equal(usd(1234567.891), '$1,234,567.89');
});

// ─── Dates ───────────────────────────────────────────────────────────────────

test('shortDate formats in UTC, so a sprint boundary does not shift west of Greenwich', () => {
  // Parsed and printed as UTC: local-time parsing would render 23 Aug for
  // anyone behind UTC, moving a sprint by a day.
  assert.equal(shortDate('2026-08-24'), '24 Aug');
  assert.equal(shortDate('2026-01-01'), '1 Jan');
});

test('shortDate renders a missing date as an em dash and passes junk through', () => {
  assert.equal(shortDate(null), '—');
  assert.equal(shortDate('not-a-date'), 'not-a-date');
});

test('dateRange joins the two ends with an arrow', () => {
  assert.equal(dateRange(sprint({ startsOn: '2026-08-18', endsOn: '2026-09-01' })), '18 Aug → 1 Sept');
});

test('daysUntil counts whole days and goes negative once the date has passed', () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const plus = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 5));
  const minus = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3));
  assert.equal(daysUntil(iso(plus)), 5);
  assert.equal(daysUntil(iso(minus)), -3);
  assert.equal(daysUntil(null), null);
  assert.equal(daysUntil('nope'), null);
});

test('timeLeftLabel says left or over, in the card form and the prose form', () => {
  const iso = (offset: number) => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offset))
      .toISOString().slice(0, 10);
  };
  assert.equal(timeLeftLabel(iso(3), 'short'), '3d left');
  assert.equal(timeLeftLabel(iso(-2), 'short'), '2d over');
  assert.equal(timeLeftLabel(iso(3)), '3 days left');
  // Singular, because "1 days left" is the kind of thing that makes a page
  // look unfinished.
  assert.equal(timeLeftLabel(iso(1)), '1 day left');
  assert.equal(timeLeftLabel(null), null);
});

test('windowProgress is 0–1 across the window and null when it cannot be computed', () => {
  assert.equal(windowProgress(sprint({ startsOn: '2000-01-01', endsOn: '2000-01-10' })), 1);
  assert.equal(windowProgress(sprint({ startsOn: '2999-01-01', endsOn: '2999-01-10' })), 0);
  assert.equal(windowProgress(sprint({ startsOn: null })), null);
  // A zero-length or inverted window has no meaningful progress.
  assert.equal(windowProgress(sprint({ startsOn: '2026-01-10', endsOn: '2026-01-10' })), null);
  assert.equal(windowProgress(sprint({ startsOn: '2026-01-10', endsOn: '2026-01-01' })), null);
});

// ─── Envelope ────────────────────────────────────────────────────────────────

test('isOverEnvelope needs an envelope to be over — no grant means nothing to exceed', () => {
  assert.equal(isOverEnvelope(sprint({ grantCount: 1, grantedUsd: 100, initiativeSpendInWindowUsd: 101 })), true);
  assert.equal(isOverEnvelope(sprint({ grantCount: 1, grantedUsd: 100, initiativeSpendInWindowUsd: 100 })), false);
  assert.equal(isOverEnvelope(sprint({ grantCount: 0, grantedUsd: 0, initiativeSpendInWindowUsd: 999 })), false);
});

// ─── Why it is mine ──────────────────────────────────────────────────────────

test('mineReasons names each of the three ways a sprint can be yours', () => {
  assert.deepEqual(mineReasons(sprint()).map((r) => r.key), []);
  assert.deepEqual(
    mineReasons(sprint({ isSteward: true, isGrantee: true, myItemCount: 4, myOpenItemCount: 1 }))
      .map((r) => r.key),
    ['steward', 'grantee', 'items'],
  );
});

test('mineReasons distinguishes open work from finished work', () => {
  const open = mineReasons(sprint({ myItemCount: 4, myOpenItemCount: 1 }));
  assert.equal(open[0]!.label, '1 open of 4 yours');
  const done = mineReasons(sprint({ myItemCount: 4, myOpenItemCount: 0 }));
  assert.equal(done[0]!.label, '4 yours, all done');
});

// ─── Rollup ──────────────────────────────────────────────────────────────────

test('sprintTotals sums the five figures the header tiles show', () => {
  const totals = sprintTotals([
    sprint({ grantedUsd: 10, initiativeSpendInWindowUsd: 1, myOpenItemCount: 2, pointsDone: 3, pointsTotal: 8 }),
    sprint({ grantedUsd: 25, initiativeSpendInWindowUsd: 4.5, myOpenItemCount: 1, pointsDone: 5, pointsTotal: 5 }),
  ]);
  assert.deepEqual(totals, { granted: 35, spend: 5.5, myOpen: 3, pointsDone: 8, pointsTotal: 13 });
});

test('sprintTotals on an empty list is all zeroes, not NaN', () => {
  assert.deepEqual(sprintTotals([]), { granted: 0, spend: 0, myOpen: 0, pointsDone: 0, pointsTotal: 0 });
});

// ─── Board ───────────────────────────────────────────────────────────────────

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'w1', projectId: 'p1', type: 'story', title: 'T', status: 'open', priority: 'medium',
    assigneeId: null, assigneeName: null, storyPoints: null, estimatedCostUsd: null, prUrl: null,
    ...over,
  };
}

test('bucketByColumn keeps the flow order and hides an empty cancelled lane', () => {
  const cols = bucketByColumn([item({ id: 'a', status: 'open' }), item({ id: 'b', status: 'done' })]);
  assert.deepEqual(cols.map((c) => c.status), ['open', 'in_progress', 'in_review', 'done']);
  assert.deepEqual(cols[0]!.items.map((i) => i.id), ['a']);
  // An always-present empty Cancelled column reads as a stage of the process
  // rather than an exception.
  assert.equal(cols.some((c) => c.status === 'cancelled'), false);
});

test('bucketByColumn shows the cancelled lane once something is actually in it', () => {
  const cols = bucketByColumn([item({ status: 'cancelled' })]);
  assert.equal(cols.at(-1)!.status, 'cancelled');
});

const tree: WorkTreeNode[] = [
  { id: 'e1', type: 'epic', title: 'Epic', children: [
    { id: 's1', type: 'story', title: 'Open story', status: 'open' },
    { id: 's2', type: 'story', title: 'Done story', status: 'done' },
    { id: 's3', type: 'bug', title: 'Cancelled bug', status: 'cancelled' },
    { id: 's4', type: 'story', title: 'Already here', status: 'in_progress' },
  ] },
];

test('flattenTree walks the whole tree, parents included', () => {
  assert.deepEqual(flattenTree(tree).map((n) => n.id), ['e1', 's1', 's2', 's3', 's4']);
});

test('addableItems drops epics, closed work, and anything already in the sprint', () => {
  // Epics are containers; done/cancelled work would fold closed items into the
  // sprint's point and cost totals; an item already here is a no-op.
  assert.deepEqual(addableItems(tree, new Set(['s4'])).map((n) => n.id), ['s1']);
});

test('addableItems keeps an item whose status the API did not send', () => {
  const untyped: WorkTreeNode[] = [{ id: 'x', type: 'story', title: 'No status' }];
  assert.deepEqual(addableItems(untyped, new Set()).map((n) => n.id), ['x']);
});

// ─── People pickers ──────────────────────────────────────────────────────────

test('peopleGroups puts the initiative first and labels contributors with their role', () => {
  const groups = peopleGroups(
    [{ personId: 'p1', name: 'Ada', role: 'SRE' }, { personId: 'p2', name: 'Bo', role: null }],
    [{ id: 'p1', name: 'Ada' }, { id: 'p9', name: 'Cy', isSme: true }],
  );
  assert.deepEqual(groups.map((g) => g.label), ['On this initiative', 'Everyone else']);
  assert.deepEqual(groups[0]!.options, [
    { value: 'p1', label: 'Ada · SRE' },
    { value: 'p2', label: 'Bo' },
  ]);
  // p1 is already listed above, so the roster half must not repeat them.
  assert.deepEqual(groups[1]!.options, [{ value: 'p9', label: 'Cy · SME' }]);
});

test('peopleGroups labels the roster "People" when there are no contributors', () => {
  const groups = peopleGroups([], [{ id: 'p9', name: 'Cy' }]);
  assert.deepEqual(groups.map((g) => g.label), ['People']);
});

test('peopleGroups is empty when nobody is available, so the caller can say why', () => {
  assert.deepEqual(peopleGroups([], []), []);
});
