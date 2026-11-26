// Cancel, did not take place, the recruiter's End and withdraw: the portal's pure helpers (lib/interviewsCancel.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAssignAgain, canCancel, canEndAsRecruiter, canMarkNotHeld, canWithdraw, cancelledLine, noteProblem } from '../interviewsCancel.ts';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');

test('cancel is offered on a round not yet live only', () => {
  for (const s of ['assigned', 'accepted', 'ready'] as const) assert.equal(canCancel(s), true);
  for (const s of ['live', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'] as const) assert.equal(canCancel(s), false);
});

test('did not take place: a live round, or a not-yet-live round past its start', () => {
  assert.equal(canMarkNotHeld({ state: 'live', scheduledAt: null }, NOW), true);
  assert.equal(canMarkNotHeld({ state: 'ready', scheduledAt: '2026-11-20T11:00:00.000Z' }, NOW), true);
  assert.equal(canMarkNotHeld({ state: 'ready', scheduledAt: '2026-11-20T13:00:00.000Z' }, NOW), false);
  assert.equal(canMarkNotHeld({ state: 'assigned', scheduledAt: null }, NOW), false);
  assert.equal(canMarkNotHeld({ state: 'ended', scheduledAt: '2026-11-20T11:00:00.000Z' }, NOW), false);
});

test('the recruiter ends a live round; a cancelled round may be assigned again', () => {
  assert.equal(canEndAsRecruiter('live'), true);
  assert.equal(canEndAsRecruiter('ready'), false);
  assert.equal(canAssignAgain('cancelled'), true);
  assert.equal(canAssignAgain('declined'), false);
});

test('withdraw: not on a closed application, not while a round is live', () => {
  assert.equal(canWithdraw('interviewing', [{ state: 'ready' }]), true);
  assert.equal(canWithdraw('interviewing', [{ state: 'live' }]), false);
  for (const s of ['withdrawn', 'rejected', 'hired']) assert.equal(canWithdraw(s, []), false);
});

test('the cancelled line carries the reason and the note', () => {
  const by = { id: 'u', name: 'Greta' };
  assert.equal(cancelledLine({ state: 'cancelled', cancellation: { reason: 'rescheduling', label: 'Rescheduling', note: null, by, at: '' } }), 'Rescheduling');
  assert.equal(cancelledLine({ state: 'cancelled', cancellation: { reason: 'other', label: 'Other', note: 'Moved', by, at: '' } }), 'Other: Moved');
  assert.equal(cancelledLine({ state: 'ready', cancellation: null }), null);
});

test('a note over 280 characters is a problem', () => {
  assert.equal(noteProblem('x'.repeat(280)), null);
  assert.match(noteProblem('x'.repeat(281)) ?? '', /280/);
});
