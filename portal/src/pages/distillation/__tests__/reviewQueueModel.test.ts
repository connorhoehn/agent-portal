// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toQueueRow, queueRows, queueCounts, nextSampleAfterVerdict,
  applyOptimisticVerdict, rollbackVerdict, reviewTypeLabel, sourceCountLabel, UNRESOLVED_TITLE,
} from '../reviewQueueModel.ts';
import type { ReviewSampleWithTarget } from '../types.ts';

function sample(id: string, over: Partial<ReviewSampleWithTarget> = {}): ReviewSampleWithTarget {
  return {
    id, target_kind: 'cluster', target_id: `cl-${id}`, sampled_at: '2026-09-24T10:00:00Z',
    reviewer: null, verdict: 'pending', note: null,
    target: { id: `cl-${id}`, kind: 'cluster', title: `Pattern ${id}`, repo: 'api', source_count: 4 },
    ...over,
  };
}

const QUEUE = [
  sample('a', { sampled_at: '2026-09-24T09:00:00Z' }),
  sample('b', { sampled_at: '2026-09-24T07:00:00Z' }),
  sample('c', { sampled_at: '2026-09-24T08:00:00Z' }),
  sample('d', { verdict: 'agree', reviewer: 'p-001', reviewed_at: '2026-09-24T11:00:00Z' }),
  sample('e', { verdict: 'disagree', reviewer: 'p-002', reviewed_at: '2026-09-24T11:30:00Z' }),
];

test('a row carries the resolved title, type, repo and source count', () => {
  const r = toQueueRow(QUEUE[0]);
  assert.equal(r.title, 'Pattern a');
  assert.equal(r.resolved, true);
  assert.equal(r.typeLabel, 'Pattern');
  assert.equal(r.repo, 'api');
  assert.equal(r.sourceCount, 4);
  assert.equal(r.error, null);
});

test('an unresolvable target says so — never the bare id', () => {
  const r = toQueueRow(sample('x', { target: null, target_error: 'cluster cl-022 not found' }));
  assert.equal(r.title, UNRESOLVED_TITLE);
  assert.notEqual(r.title, 'cl-x');
  assert.equal(r.resolved, false);
  assert.equal(r.error, 'cluster cl-022 not found');
  assert.equal(r.typeLabel, 'Pattern', 'falls back to target_kind');
  assert.equal(r.sourceCount, null);
  // Pre-redesign wire: no target at all.
  const old = toQueueRow({ id: 'o', target_kind: 'artifact', target_id: 'art-1', sampled_at: '', reviewer: null, verdict: 'pending', note: null });
  assert.equal(old.resolved, false);
  assert.equal(old.typeLabel, 'Guide');
  assert.match(old.error ?? '', /no target/);
});

test('counts', () => {
  assert.deepEqual(queueCounts(QUEUE), { pending: 3, decided: 2 });
  assert.deepEqual(queueCounts([]), { pending: 0, decided: 0 });
});

test('pending is oldest-first, reviewed is most-recently-reviewed first', () => {
  assert.deepEqual(queueRows(QUEUE, 'pending').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(queueRows(QUEUE, 'decided').map((r) => r.id), ['e', 'd']);
});

test('search matches title, type and repo', () => {
  assert.deepEqual(queueRows(QUEUE, 'pending', 'pattern c').map((r) => r.id), ['c']);
  assert.deepEqual(queueRows(QUEUE, 'pending', '  API ').length, 3);
  assert.deepEqual(queueRows(QUEUE, 'pending', 'nothing'), []);
});

test('next sample after a verdict is the next pending in queue order, wrapping', () => {
  assert.equal(nextSampleAfterVerdict(QUEUE, 'b'), 'c');
  assert.equal(nextSampleAfterVerdict(QUEUE, 'c'), 'a');
  assert.equal(nextSampleAfterVerdict(QUEUE, 'a'), 'b', 'wraps to the oldest');
  assert.equal(nextSampleAfterVerdict([sample('only')], 'only'), null);
  assert.equal(nextSampleAfterVerdict(QUEUE, 'zzz'), 'b', 'unknown id → first pending');
});

test('optimistic verdict moves the sample to Reviewed; rollback restores it exactly', () => {
  const { samples, previous } = applyOptimisticVerdict(QUEUE, 'c', 'agree', { note: 'matches', reviewer: 'p-009', nowIso: '2026-09-24T12:00:00Z' });
  assert.deepEqual(queueCounts(samples), { pending: 2, decided: 3 });
  const c = samples.find((s) => s.id === 'c')!;
  assert.equal(c.verdict, 'agree');
  assert.equal(c.note, 'matches');
  assert.equal(c.reviewer, 'p-009');
  assert.equal(queueRows(samples, 'decided')[0].id, 'c', 'just-reviewed sits at the top of Reviewed');
  assert.equal(QUEUE.find((s) => s.id === 'c')!.verdict, 'pending', 'input not mutated');

  const back = rollbackVerdict(samples, previous);
  assert.deepEqual(back, QUEUE);
});

test('verdict on an unknown id is a no-op with nothing to roll back', () => {
  const r = applyOptimisticVerdict(QUEUE, 'nope', 'disagree');
  assert.equal(r.samples, QUEUE);
  assert.equal(r.previous, null);
  assert.equal(rollbackVerdict(QUEUE, null), QUEUE);
});

test('labels', () => {
  assert.equal(reviewTypeLabel('procedure'), 'Procedure');
  assert.equal(reviewTypeLabel('library_item'), 'Library item');
  assert.equal(reviewTypeLabel(null), 'Item');
  assert.equal(sourceCountLabel(1), '1 source');
  assert.equal(sourceCountLabel(0), '0 sources');
  assert.equal(sourceCountLabel(null), '');
});
