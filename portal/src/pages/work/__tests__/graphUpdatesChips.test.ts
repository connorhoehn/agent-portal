// UX walk, 9 November 2026: the Graph updates "all" chip clicked to nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusChip } from '../graphUpdatesChips.ts';

const COUNTS = { applied: 3, pending: 2, rejected: 1 };

test('with everything loaded, "all" carries the total and says it is the view on screen', () => {
  assert.deepEqual(statusChip('all', 'all', COUNTS), { label: 'all (6)', title: 'Showing every graph update', disabled: false, next: 'all' });
  assert.deepEqual(statusChip('applied', 'all', COUNTS), { label: 'applied (3)', title: 'Show only applied updates', disabled: false, next: 'applied' });
});

test('an empty status is off, with why', () => {
  assert.deepEqual(statusChip('failed', 'all', COUNTS), { label: 'failed (0)', title: 'No failed graph updates', disabled: true, next: 'failed' });
});

test('the selected status clicks back to all; counts are not guessed in a filtered view', () => {
  assert.deepEqual(statusChip('pending', 'pending', COUNTS), { label: 'pending', title: 'Showing pending updates; click to show all', disabled: false, next: 'all' });
  assert.deepEqual(statusChip('failed', 'pending', COUNTS), { label: 'failed', title: 'Show only failed updates', disabled: false, next: 'failed' });
  assert.equal(statusChip('all', 'all', null).label, 'all');
});
