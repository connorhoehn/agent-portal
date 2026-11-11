// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'
//
// The header badge and Automate › Runs both list dispatched runs through this
// module, so where a row leads is pinned here once: never a door the caller's
// role cannot open.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCHED_RUNS_PATH, dispatchedRunDestination, dispatchedRunLabel, dispatchedRunsNoun, type DispatchedRun,
} from '../dispatchedRuns.ts';

const run = (over: Partial<DispatchedRun> = {}): DispatchedRun => ({
  id: 'r1', workItemId: 'wi-auth-e2-s2', workItemTitle: 'Cutover runbook', projectId: 'p-auth-migration',
  trigger: 'marketplace', startedAt: '2026-10-01T00:00:00Z', outcome: { boxId: 'box 1' }, ...over,
});

test('a lab holder goes to the computer doing the work', () => {
  assert.deepEqual(dispatchedRunDestination(run(), true), { path: '/iq/computers?computer=box%201', kind: 'computer' });
});

test('everyone else goes to the work item on its initiative', () => {
  assert.deepEqual(dispatchedRunDestination(run(), false), {
    path: '/iq/projects/p-auth-migration?item=wi-auth-e2-s2', kind: 'work-item',
  });
  assert.equal(dispatchedRunDestination(run({ outcome: {} }), true).kind, 'work-item');
});

test('a run with neither a box nor a work item falls back to the list', () => {
  assert.deepEqual(
    dispatchedRunDestination(run({ outcome: null, workItemId: null, projectId: null }), true),
    { path: DISPATCHED_RUNS_PATH, kind: 'list' },
  );
});

test('label and noun', () => {
  assert.equal(dispatchedRunLabel(run()), 'Cutover runbook');
  // A work item whose name was not found reads in words; its id is behind the row's copy control (UX leftovers, 10 November).
  assert.equal(dispatchedRunLabel(run({ workItemTitle: null })), 'Marketplace work');
  assert.equal(dispatchedRunLabel(run({ workItemTitle: null, workItemId: null })), 'marketplace');
  assert.equal(dispatchedRunsNoun(1), '1 dispatched run');
  assert.equal(dispatchedRunsNoun(3), '3 dispatched runs');
});
