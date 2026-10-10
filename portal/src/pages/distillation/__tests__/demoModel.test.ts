// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'
//
// The live-demo helpers: the landing's progress line (demoModel), what a live
// refresh counts as new (knowledgeModel.freshIds) and how arrivals are
// announced, and how Activity names a pass the queue is about to retry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { demoProgress, type DemoState } from '../demoModel.ts';
import { agoPhrase, freshAnnouncement, freshIds } from '../knowledgeModel.ts';
import { reviewArrivalAnnouncement } from '../reviewQueueModel.ts';
import { isRetrying, jobStatus, retryReason, runRows, whatChanged } from '../activityModel.ts';
import type { CompactionRun } from '../types.ts';

const MILESTONES = { patternsMinted: false, sampled: false, reviewed: false, guideMinted: false, published: false, applied: false };
const state = (over: Partial<DemoState>): DemoState => ({
  phase: 'idle', notes: [], notesTotal: 12, milestones: { ...MILESTONES }, guideId: null, openDecidedBy: null, errors: [], ...over,
});

test('demoProgress: nothing played says nothing', () => {
  assert.deepEqual(demoProgress(null), { playing: false, line: null, tone: 'neutral', status: 'Not playing', look: null });
  assert.equal(demoProgress(state({})).line, null);
});

test('demoProgress: writing counts the notes against the script and points at Run notes', () => {
  const p = demoProgress(state({ phase: 'writing', notes: ['a', 'b', 'c'] }));
  assert.equal(p.playing, true);
  assert.match(p.line!, /3 of 12 so far/);
  assert.equal(p.look!.href, '/iq/distillation/knowledge?view=notes');
});

test('demoProgress: review says one pattern waits for the reader, once sampled', () => {
  assert.match(demoProgress(state({ phase: 'reviewing' })).line!, /being sampled/);
  const p = demoProgress(state({ phase: 'reviewing', milestones: { ...MILESTONES, sampled: true } }));
  assert.match(p.line!, /One is left for you/);
  assert.equal(p.look!.href, '/iq/distillation/review');
});

test('demoProgress: the guide beats link the guide; done stops playing; failed names the error', () => {
  const pub = demoProgress(state({ phase: 'publishing', guideId: 'art-901', milestones: { ...MILESTONES, guideMinted: true } }));
  assert.equal(pub.look!.href, '/iq/distillation/knowledge?item=art-901');
  const done = demoProgress(state({ phase: 'done', guideId: 'art-901', milestones: { ...MILESTONES, applied: true } }));
  assert.equal(done.playing, false);
  assert.equal(done.tone, 'success');
  assert.equal(demoProgress(state({ phase: 'failed', errors: ['boom'] })).line, 'boom');
  assert.equal(demoProgress(state({ phase: 'stopped' })).playing, false);
});

test('freshIds: the first load marks nothing; a refresh marks only what was not there', () => {
  assert.equal(freshIds(null, [{ id: 'a' }]).size, 0);
  assert.deepEqual([...freshIds([{ id: 'a' }], [{ id: 'b' }, { id: 'a' }, { id: 'c' }])], ['b', 'c']);
  assert.equal(freshIds([{ id: 'a' }], [{ id: 'a' }]).size, 0);
});

test('arrival announcements read as a sentence, and say nothing for zero', () => {
  assert.equal(freshAnnouncement(1, 'notes'), '1 new run note');
  assert.equal(freshAnnouncement(3, 'patterns'), '3 new patterns');
  assert.equal(freshAnnouncement(0, 'notes'), '');
  assert.equal(reviewArrivalAnnouncement(4), '4 new samples to review');
  assert.equal(reviewArrivalAnnouncement(1), '1 new sample to review');
  assert.equal(reviewArrivalAnnouncement(0), '');
});

const job = (over: Partial<CompactionRun>): CompactionRun => ({
  id: 'comp-92', level: 'L1', startedAt: '2026-10-07T12:00:00Z', finishedAt: null, status: 'queued',
  inputItems: 3, outputItems: 0, dedupedItems: 0, input_ids: ['a', 'b', 'c'], output_ids: [],
  ...over,
} as CompactionRun);

test('a queued pass whose delivery failed reads as Retrying, with the server’s own reason', () => {
  const retrying = job({ phase: 'retrying', attempts: 1, log: [
    { at: '2026-10-07T12:00:01Z', level: 'info', message: 'Claimed' },
    { at: '2026-10-07T12:00:03Z', level: 'warn', message: 'compaction write failed (injected) — left on distill-compact-l1 for redelivery (delivery 1 of 3).' },
  ] });
  assert.equal(isRetrying(retrying), true);
  assert.deepEqual(jobStatus(retrying), { label: 'Retrying', tone: 'warning', meta: 'delivery 1 failed' });
  assert.match(retryReason(retrying)!, /left on distill-compact-l1 for redelivery/);
  assert.match(whatChanged(retrying), /redelivery/);
  assert.equal(runRows([retrying], Date.parse('2026-10-07T12:01:00Z'))[0].status.label, 'Retrying');
});

test('a plain queued pass is still Queued; a retry with no log falls back to the attempt count', () => {
  assert.deepEqual(jobStatus(job({})), { label: 'Queued', tone: 'pending' });
  assert.equal(retryReason(job({})), null);
  assert.match(retryReason(job({ phase: 'retrying', attempts: 2 }))!, /^Delivery 2 failed/);
});

test('agoPhrase never says "now ago"', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(agoPhrase('2026-10-07T11:59:40Z', now), 'just now');
  assert.equal(agoPhrase('2026-10-07T09:00:00Z', now), '3h ago');
  assert.equal(agoPhrase(null, now), '');
});
