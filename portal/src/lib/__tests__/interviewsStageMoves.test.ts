// The recruiter's stage moves: the portal's pure helpers (lib/interviewsStageMoves.ts), which mirror the server's rules
// (middleware lib/interviews/stage-moves.ts) so the profile's "Move stage" menu offers only what the server allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_HIRING_MANAGER_WARNING, STAGE_MOVE_LABEL, noHiringManagerFix, openingEditHref, reopenTarget, stageMoveReasonProblem, stageMovesFor } from '../interviewsStageMoves.ts';

test('the menu offers only the moves the stage takes', () => {
  assert.deepEqual(stageMovesFor('applied', []), [{ move: 'screen', to: 'screening' }]);
  assert.deepEqual(stageMovesFor('offer', []), [{ move: 'hire', to: 'hired' }, { move: 'decline', to: 'rejected' }]);
  for (const s of ['rejected', 'withdrawn', 'on-hold'] as const) assert.deepEqual(stageMovesFor(s, []), [{ move: 'reopen', to: 'screening' }]);
  for (const s of ['screening', 'interviewing', 'debrief', 'hired'] as const) assert.deepEqual(stageMovesFor(s, []), []);
});

test('reopen goes back to interviewing when a round was held or is still to run', () => {
  assert.equal(reopenTarget([{ state: 'reviewed' }]), 'interviewing');
  assert.equal(reopenTarget([{ state: 'assigned' }]), 'interviewing');
  assert.equal(reopenTarget([{ state: 'cancelled' }, { state: 'declined' }]), 'screening');
  assert.deepEqual(stageMovesFor('rejected', [{ state: 'ended' }]), [{ move: 'reopen', to: 'interviewing' }]);
});

test('the reason: required on Offer declined and Reopen, optional on Mark hired', () => {
  assert.match(stageMoveReasonProblem('decline', '') ?? '', /Say why/);
  assert.match(stageMoveReasonProblem('reopen', 'short') ?? '', /Say why/);
  assert.equal(stageMoveReasonProblem('reopen', 'They asked to be considered again.'), null);
  assert.equal(stageMoveReasonProblem('hire', ''), null);
  assert.match(stageMoveReasonProblem('hire', 'x'.repeat(1001)) ?? '', /under 1000/);
});

test('the labels are the ones the hiring manager\'s refusals name', () => {
  assert.deepEqual(STAGE_MOVE_LABEL, { screen: 'Start screening', hire: 'Mark hired', decline: 'Offer declined', reopen: 'Reopen' });
});

test('no hiring manager: one warning, and the fix for whoever reads it', () => {
  assert.match(NO_HIRING_MANAGER_WARNING, /Nobody can decide/);
  assert.match(noHiringManagerFix(true), /Details tab/);
  assert.match(noHiringManagerFix(false), /recruiter/);
  assert.equal(openingEditHref('op ios'), '/interviews/openings/op%20ios/edit');
});
