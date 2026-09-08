// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterFindings, sweepLabel, type FindingLike } from '../findingsFilter.ts';

function findings(...statuses: string[]): FindingLike[] {
  return statuses.map((status) => ({ status }));
}

test('filterFindings keeps only the selected status', () => {
  const all = findings('open', 'promoted', 'open', 'resolved', 'dismissed');
  assert.deepEqual(filterFindings(all, 'open'), [{ status: 'open' }, { status: 'open' }]);
  assert.deepEqual(filterFindings(all, 'promoted'), [{ status: 'promoted' }]);
  assert.deepEqual(filterFindings(all, 'dismissed'), [{ status: 'dismissed' }]);
});

test('filterFindings returns empty, not everything, when nothing matches', () => {
  assert.deepEqual(filterFindings(findings('open', 'open'), 'resolved'), []);
});

test('filterFindings on an empty list is empty for every status', () => {
  assert.deepEqual(filterFindings([], 'open'), []);
  assert.deepEqual(filterFindings([], 'dismissed'), []);
});

test('filterFindings never leaks a stale status across a re-filter', () => {
  // Simulates a fetch response that hasn't caught up with a fast filter
  // click yet — the page's own status query param says "promoted" but the
  // last resolved payload still carries mixed statuses from "open".
  const staleResponse = findings('open', 'open', 'promoted');
  assert.deepEqual(filterFindings(staleResponse, 'promoted'), [{ status: 'promoted' }]);
});

// The dismissed group's heading used to print the raw sweep id ("lab-signal")
// when no entry existed for it — org-leader DEFECTS #7.
test('sweepLabel names every known sweep kind, including lab-signal', () => {
  assert.equal(sweepLabel('bus_factor'), 'Bus factor');
  assert.equal(sweepLabel('stale_docs'), 'Stale docs');
  assert.equal(sweepLabel('orphan_decisions'), 'Orphan decisions');
  assert.equal(sweepLabel('lab-signal'), 'Lab signals');
});

test('sweepLabel title-cases an unrecognised sweep id instead of printing it raw', () => {
  assert.equal(sweepLabel('new_sweep_kind'), 'New sweep kind');
  assert.equal(sweepLabel('another-new-kind'), 'Another new kind');
  assert.equal(sweepLabel('solo'), 'Solo');
});

test('sweepLabel does not choke on an empty or oddly-punctuated id', () => {
  assert.equal(sweepLabel(''), '');
  assert.equal(sweepLabel('_leading'), 'Leading');
  assert.equal(sweepLabel('trailing_'), 'Trailing');
});
