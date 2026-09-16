import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedLabel, isLive, liveProgress } from '../localComputeFormat.ts';

const T0 = Date.parse('2026-09-16T12:00:00.000Z');

test('elapsedLabel counts in units that do not jitter in width', () => {
  assert.equal(elapsedLabel('2026-09-16T12:00:00.000Z', T0), '0s');
  assert.equal(elapsedLabel('2026-09-16T11:59:53.000Z', T0), '7s');
  assert.equal(elapsedLabel('2026-09-16T11:58:56.000Z', T0), '1m 04s');
  assert.equal(elapsedLabel('2026-09-16T10:57:00.000Z', T0), '1h 03m');
});

test('elapsedLabel is null when there is no honest start', () => {
  assert.equal(elapsedLabel(null, T0), null);
  assert.equal(elapsedLabel('not a date', T0), null);
});

test('elapsedLabel never counts backwards from a clock skew', () => {
  assert.equal(elapsedLabel('2026-09-16T12:00:30.000Z', T0), '0s');
});

test('only the three in-flight statuses are live', () => {
  for (const s of ['queued', 'claimed', 'running'] as const) assert.equal(isLive(s), true);
  for (const s of ['awaiting_review', 'done', 'failed', 'cancelled'] as const) assert.equal(isLive(s), false);
});

test('running counts from its start and marks itself active', () => {
  const p = liveProgress({ status: 'running', createdAt: '2026-09-16T11:50:00.000Z', startedAt: '2026-09-16T11:58:56.000Z' }, T0);
  assert.equal(p?.label, 'running 1m 04s');
  assert.equal(p?.active, true);
});

test('claimed names the gap before the first token, which read as a hang', () => {
  const p = liveProgress({ status: 'claimed', createdAt: '2026-09-16T11:50:00.000Z', claimedAt: '2026-09-16T11:59:57.000Z' }, T0);
  assert.equal(p?.label, 'starting 3s');
  assert.equal(p?.active, true);
});

test('queued says where it sits and how long it has waited, and is not active', () => {
  const job = { status: 'queued' as const, createdAt: '2026-09-16T11:58:00.000Z' };
  assert.equal(liveProgress(job, T0)?.label, 'next in lane · waiting 2m 00s');
  assert.equal(liveProgress(job, T0, 1)?.label, 'next in lane · waiting 2m 00s');
  assert.equal(liveProgress(job, T0, 2)?.label, '2nd in lane · waiting 2m 00s');
  assert.equal(liveProgress(job, T0, 3)?.label, '3rd in lane · waiting 2m 00s');
  assert.equal(liveProgress(job, T0, 11)?.label, '11th in lane · waiting 2m 00s');
  assert.equal(liveProgress(job, T0, 2)?.active, false);
});

test('a retry says so; a first attempt stays quiet', () => {
  const base = { status: 'running' as const, createdAt: '2026-09-16T11:50:00.000Z', startedAt: '2026-09-16T11:59:50.000Z' };
  assert.equal(liveProgress(base, T0)?.attemptNote, null);
  assert.equal(liveProgress({ ...base, attempts: 1 }, T0)?.attemptNote, null);
  assert.equal(liveProgress({ ...base, attempts: 2, maxAttempts: 2 }, T0)?.attemptNote, 'attempt 2 of 2');
});

test('a settled job has no live line at all', () => {
  assert.equal(liveProgress({ status: 'done', createdAt: '2026-09-16T11:50:00.000Z' }, T0), null);
});
