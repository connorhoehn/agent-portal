import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobTimingSteps } from '../jobTiming.ts';
const times = { createdAt: '2026-11-02T08:00:00Z', claimedAt: '2026-11-02T08:00:03Z', startedAt: '2026-11-02T08:00:04Z', finishedAt: '2026-11-02T08:02:14Z' };
test('completed milestones preserve recorded times and no longer claim to be running', () => {
  const steps = jobTimingSteps({ ...times, status: 'done' });
  assert.deepEqual(steps.map(s => s.label), ['Queued', 'Claimed', 'Started', 'Finished']);
  assert.ok(steps.every(s => s.done && !s.active && s.description !== 'Not recorded'));
});
test('a failure before claim does not invent successful stages or missing timestamps', () => {
  const steps = jobTimingSteps({ ...times, claimedAt: null, startedAt: null, status: 'failed' });
  assert.equal(steps[1]?.done, false); assert.equal(steps[2]?.description, 'Not recorded');
  assert.equal(steps[3]?.outcome, 'failed'); assert.equal(steps[3]?.done, false);
});
test('running, cancelled and review states remain distinct from completed', () => {
  const running = jobTimingSteps({ ...times, status: 'running', finishedAt: null });
  assert.equal(running[2]?.active, true); assert.equal(running[3]?.description, 'Not yet');
  assert.equal(jobTimingSteps({ ...times, status: 'cancelled' })[3]?.outcome, 'cancelled');
  const review = jobTimingSteps({ ...times, status: 'awaiting_review' })[3];
  assert.equal(review?.label, 'Ready for review'); assert.equal(review?.active, true); assert.equal(review?.done, false);
});
