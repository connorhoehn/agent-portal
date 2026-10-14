// Run with:  cd portal && node --test 'src/pages/sprints/__tests__/*.test.ts'
//
// Same runner as sprintForm.test.ts — plain node:test, no DOM. Everything in
// sprintFormat is pure by construction, which is the point of having pulled it
// out of the .tsx: the rollup reducer, the column bucketing and the option
// grouping used to sit inside a render where none of it could be asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usd, shortDate, daysUntil, windowProgress, sprintWindow, dateRange, timeLeftLabel,
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

test('timeLeftLabel counts the end date as a working day, in the card form and the prose form', () => {
  // 13 Oct, mid-afternoon UTC.
  const now = Date.UTC(2026, 9, 13, 15, 0);
  assert.equal(timeLeftLabel('2026-10-16', 'short', now), '4d left'); // 13, 14, 15, 16
  assert.equal(timeLeftLabel('2026-10-16', 'long', now), '4 days left');
  assert.equal(timeLeftLabel('2026-10-14', 'long', now), '2 days left');
  // The last day is a day to work, not "0 days left".
  assert.equal(timeLeftLabel('2026-10-13', 'long', now), 'last day');
  assert.equal(timeLeftLabel('2026-10-13', 'short', now), 'last day');
  // Singular, because "1 days over" is the kind of thing that makes a page
  // look unfinished. Ended yesterday = one day over.
  assert.equal(timeLeftLabel('2026-10-12', 'long', now), '1 day over');
  assert.equal(timeLeftLabel('2026-10-11', 'short', now), '2d over');
  assert.equal(timeLeftLabel(null), null);
  assert.equal(timeLeftLabel('nope'), null);
});

test('sprintWindow: an active sprint on its last day is not finished (the reported 30 Sep → 14 Oct case)', () => {
  const s = { startsOn: '2026-09-30', endsOn: '2026-10-14' };
  const lastDayEvening = Date.UTC(2026, 9, 14, 18, 0);
  const w = sprintWindow(s, lastDayEvening)!;
  assert.equal(w.days, 15);
  assert.equal(w.day, 15);
  assert.equal(w.daysLeft, 1);
  assert.ok(w.progress < 1 && w.progress > 0.95, `progress ${w.progress}`);
  assert.equal(timeLeftLabel(s.endsOn, 'long', lastDayEvening), 'last day');
  // It finishes at the end of the 14th, i.e. midnight starting the 15th.
  const closed = sprintWindow(s, Date.UTC(2026, 9, 15, 0, 0))!;
  assert.equal(closed.progress, 1);
  assert.equal(closed.daysLeft, 0);
  assert.equal(closed.day, 15);
  // First day: day 1 of 15, a sliver elapsed.
  const first = sprintWindow(s, Date.UTC(2026, 8, 30, 0, 0))!;
  assert.deepEqual([first.day, first.daysLeft, first.progress], [1, 15, 0]);
  // Before it starts: day 0.
  assert.equal(sprintWindow(s, Date.UTC(2026, 8, 29, 12, 0))!.day, 0);
});

test('windowProgress is 0–1 across the inclusive window and null when it cannot be computed', () => {
  assert.equal(windowProgress(sprint({ startsOn: '2000-01-01', endsOn: '2000-01-10' })), 1);
  assert.equal(windowProgress(sprint({ startsOn: '2999-01-01', endsOn: '2999-01-10' })), 0);
  assert.equal(windowProgress(sprint({ startsOn: null })), null);
  // A one-day sprint is a real (one-day) window: half-way through its day.
  assert.equal(windowProgress(sprint({ startsOn: '2026-01-10', endsOn: '2026-01-10' }), Date.UTC(2026, 0, 10, 12)), 0.5);
  // An inverted window has no meaningful progress.
  assert.equal(windowProgress(sprint({ startsOn: '2026-01-10', endsOn: '2026-01-01' })), null);
});

test('peopleGroups is empty when nobody is available, so the caller can say why', () => {
  assert.deepEqual(peopleGroups([], []), []);
});

// ─── Health ──────────────────────────────────────────────────────────────────
// Dates far in the past so windowProgress clamps to 1 (fully elapsed) without
// the tests depending on today's date.

import { sprintHealth, atRiskCount } from '../sprintFormat.ts';

const ELAPSED = { startsOn: '2020-01-01', endsOn: '2020-01-15' };

test('sprintHealth judges only active sprints', () => {
  assert.equal(sprintHealth(sprint({ status: 'planned', pointsTotal: 10 })), null);
  assert.equal(sprintHealth(sprint({ status: 'done', pointsTotal: 10 })), null);
});

test('sprintHealth: fully elapsed with nothing delivered is off track', () => {
  const h = sprintHealth(sprint({ ...ELAPSED, pointsTotal: 26, pointsDone: 0 }));
  assert.equal(h?.key, 'off_track');
  assert.equal(h?.tone, 'danger');
});

test('sprintHealth: fully elapsed and fully delivered is on track', () => {
  const h = sprintHealth(sprint({ ...ELAPSED, pointsTotal: 26, pointsDone: 26 }));
  assert.equal(h?.key, 'on_track');
});

test('sprintHealth: a moderate gap is at risk', () => {
  // elapsed 1.0, delivered 0.65 → gap 0.35 → at risk (not off track).
  const h = sprintHealth(sprint({ ...ELAPSED, pointsTotal: 20, pointsDone: 13 }));
  assert.equal(h?.key, 'at_risk');
  assert.equal(h?.tone, 'warning');
});

test('sprintHealth: over-envelope trumps a healthy points line', () => {
  const h = sprintHealth(sprint({
    ...ELAPSED, pointsTotal: 20, pointsDone: 20,
    grantCount: 1, grantedUsd: 10, initiativeSpendInWindowUsd: 12,
  }));
  assert.equal(h?.key, 'over_envelope');
  assert.equal(h?.tone, 'danger');
});

test('sprintHealth: nothing estimated → nothing to judge', () => {
  assert.equal(sprintHealth(sprint({ ...ELAPSED, pointsTotal: 0 })), null);
});

test('atRiskCount counts everything not on track', () => {
  const sprints = [
    sprint({ ...ELAPSED, pointsTotal: 26, pointsDone: 0 }),                 // off track
    sprint({ ...ELAPSED, pointsTotal: 26, pointsDone: 26 }),                // on track
    sprint({ status: 'planned', pointsTotal: 10 }),                          // unjudged
    sprint({ ...ELAPSED, pointsTotal: 20, pointsDone: 20, grantCount: 1, grantedUsd: 5, initiativeSpendInWindowUsd: 9 }), // over envelope
  ];
  assert.equal(atRiskCount(sprints), 2);
});

// ─── Board quick filters ─────────────────────────────────────────────────────

import { applyQuickFilters, parseQuickFilters, serializeQuickFilters } from '../sprintFormat.ts';

const wi = (over: Partial<WorkItem>): WorkItem => ({
  id: 'w', projectId: 'p', type: 'task', title: 't', status: 'open', priority: 'medium',
  assigneeId: null, assigneeName: null, storyPoints: null, estimatedCostUsd: null, prUrl: null, ...over,
});

test('quick filters round-trip through the URL in a stable order and drop unknown ids', () => {
  assert.deepEqual(parseQuickFilters('recent,mine,bogus'), ['mine', 'recent']);
  assert.deepEqual(parseQuickFilters(null), []);
  assert.equal(serializeQuickFilters(['recent', 'mine']), 'mine,recent');
  // Nothing on → no param at all, not `?quick=`.
  assert.equal(serializeQuickFilters([]), null);
});

test('quick filters combine with AND; "mine" without a linked person matches nothing', () => {
  const now = Date.UTC(2026, 9, 13);
  const items = [
    wi({ id: 'a', assigneeId: 'p-1', updatedAt: new Date(now - 2 * 86_400_000).toISOString() }),
    wi({ id: 'b', assigneeId: 'p-2', updatedAt: new Date(now - 1 * 86_400_000).toISOString() }),
    wi({ id: 'c', assigneeId: 'p-1', updatedAt: new Date(now - 30 * 86_400_000).toISOString() }),
    wi({ id: 'd', assigneeId: 'p-1' }),
  ];
  const ids = (xs: WorkItem[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(applyQuickFilters(items, [], { personId: 'p-1', now })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(applyQuickFilters(items, ['mine'], { personId: 'p-1', now })), ['a', 'c', 'd']);
  assert.deepEqual(ids(applyQuickFilters(items, ['recent'], { personId: 'p-1', now })), ['a', 'b']);
  assert.deepEqual(ids(applyQuickFilters(items, ['mine', 'recent'], { personId: 'p-1', now })), ['a']);
  assert.deepEqual(ids(applyQuickFilters(items, ['mine'], { personId: null, now })), []);
});
