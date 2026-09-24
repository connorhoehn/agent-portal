// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFrame, applyFrame, CHANNEL_SNAPSHOT_URL } from '../distillationChannel.ts';
import type { CompactionRun } from '../types.ts';

function job(id: string, over: Partial<CompactionRun> = {}): CompactionRun {
  return {
    id, level: 'L1', status: 'running', startedAt: '2026-09-24T11:00:00Z', finishedAt: null,
    inputItems: 0, outputItems: 0, dedupedItems: 0, bytesReclaimed: 0, costUsd: 0, ...over,
  };
}

test('each channel patches its own REST route', () => {
  assert.equal(CHANNEL_SNAPSHOT_URL['distill:levels'], '/api/distillation/levels');
  assert.equal(CHANNEL_SNAPSHOT_URL['distill:jobs'], '/api/distillation/compactions');
  assert.equal(CHANNEL_SNAPSHOT_URL['distill:review'], '/api/distillation/review');
});

test('extractFrame accepts bare and wrapped frames for the right channel only', () => {
  const bare = { type: 'levels', channel: 'distill:levels', levels: [] };
  assert.deepEqual(extractFrame(bare, 'distill:levels'), bare);
  const wrapped = { type: 'message', channel: 'distill:jobs', payload: { type: 'job', job: job('j1') } };
  assert.equal(extractFrame(wrapped, 'distill:jobs')?.type, 'job');
  assert.equal(extractFrame({ type: 'x', data: { type: 'review', pending: 2, decided: 5 } }, 'distill:review')?.type, 'review');

  assert.equal(extractFrame(bare, 'distill:jobs'), null, 'other channel');
  assert.equal(extractFrame({ ...bare, channel: 'chat:general' }, 'distill:levels'), null);
  assert.equal(extractFrame({ type: 'levels', levels: 'nope' }, 'distill:levels'), null, 'malformed');
  assert.equal(extractFrame({ type: 'job', job: {} }, 'distill:jobs'), null, 'job without id');
  assert.equal(extractFrame({ type: 'review', pending: '2', decided: 1 }, 'distill:review'), null);
  assert.equal(extractFrame(null, 'distill:levels'), null);
});

test('levels frame replaces the ladder and keeps other fields', () => {
  const snap = { levels: [{ level: 'L0', count: 1 }], health: [] };
  const { next, refetch } = applyFrame(snap, { type: 'levels', levels: [{ level: 'L0', count: 9 }] });
  assert.deepEqual(next, { levels: [{ level: 'L0', count: 9 }], health: [] });
  assert.equal(refetch, false);
  assert.equal(snap.levels[0].count, 1, 'snapshot not mutated');
});

test('job frame updates a known job in place and puts a new one first', () => {
  const snap = { jobs: [job('j2'), job('j1')] };
  const upd = applyFrame(snap, { type: 'job', job: job('j1', { status: 'succeeded', percent: 100 }) });
  assert.deepEqual((upd.next as typeof snap).jobs.map((j) => [j.id, j.status]), [['j2', 'running'], ['j1', 'succeeded']]);
  const add = applyFrame(snap, { type: 'job', job: job('j3', { status: 'queued' }) });
  assert.deepEqual((add.next as typeof snap).jobs.map((j) => j.id), ['j3', 'j2', 'j1']);
  const empty = applyFrame({}, { type: 'job', job: job('j9') });
  assert.deepEqual((empty.next as { jobs: CompactionRun[] }).jobs.map((j) => j.id), ['j9']);
});

test('review frame records counts and refetches only when the samples disagree', () => {
  const snap = { samples: [{ verdict: 'pending' }, { verdict: 'agree' }] };
  const same = applyFrame<Record<string, unknown>>(snap, { type: 'review', pending: 1, decided: 1 });
  assert.deepEqual(same.next.counts, { pending: 1, decided: 1 });
  assert.equal(same.refetch, false);
  const moved = applyFrame(snap, { type: 'review', pending: 0, decided: 2 });
  assert.equal(moved.refetch, true);
  const countsOnly = applyFrame({}, { type: 'review', pending: 3, decided: 0 });
  assert.equal(countsOnly.refetch, false, 'nothing list-shaped to refresh');
});
