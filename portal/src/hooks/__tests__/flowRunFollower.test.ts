// Run with: cd portal && node --test --experimental-strip-types 'src/hooks/__tests__/flowRunFollower.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlowRunFollower, flowRunWireChannel, isFlowRunAck, isFlowRunFrame, isFlowRunRefusal, isLiveFlowRunId,
  type FlowRunFollowerOptions, type FlowRunOutcome,
} from '../flowRunFollower.ts';

type R = { status: string; n?: number };
const fin = (r: R): boolean => r.status === 'completed' || r.status === 'failed';
const ID = 'sum-0f0e0d0c-0b0a-4908-8706-050403020100';

/** A manual clock and timer queue; reads resolve when the test says so. */
function harness(over: Partial<FlowRunFollowerOptions<R>> = {}) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const pending: Array<{ resolve: (r: R) => void; reject: (e: Error) => void; signal: AbortSignal }> = [];
  const updates: R[] = []; const errors: string[] = []; const outcomes: FlowRunOutcome<R>[] = [];
  const f = createFlowRunFollower<R>(ID, {
    getRun: (_id, signal) => new Promise<R>((resolve, reject) => { pending.push({ resolve, reject, signal }); }),
    isFinished: fin,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    now: () => t,
    onUpdate: (r) => updates.push(r), onError: (m) => errors.push(m), onDone: (o) => outcomes.push(o),
    ...over,
  });
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  return {
    f, updates, errors, outcomes, pending, timers,
    /** Resolve the oldest outstanding read. */
    async answer(r: R | Error): Promise<void> {
      const p = pending.shift(); assert.ok(p, 'a read is outstanding');
      if (r instanceof Error) p.reject(r); else p.resolve(r);
      await flush();
    },
    /** Advance to the next timer and fire it. Returns the delay waited. */
    async tick(): Promise<number> {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift(); assert.ok(next, 'a timer is scheduled');
      const waited = next.at - t; t = next.at; next.fn(); await flush();
      return waited;
    },
  };
}

test('live run ids are the flows with a private channel; deck runs are not', () => {
  assert.equal(isLiveFlowRunId(ID), true);
  assert.equal(isLiveFlowRunId('adr-0f0e0d0c-0b0a-4908-8706-050403020100'), true);
  for (const p of ['osm', 'asm', 'psm']) assert.equal(isLiveFlowRunId(`${p}-0f0e0d0c-0b0a-4908-8706-050403020100`), true);
  assert.equal(isLiveFlowRunId('sdk-0f0e0d0c-0b0a-4908-8706-050403020100'), true); // Social /deck
  assert.equal(isLiveFlowRunId('pdr-0f0e0d0c-0b0a-4908-8706-050403020100'), true); // pipelines deck revise
  assert.equal(isLiveFlowRunId('sdeck-0f0e0d0c-0b0a-4908-8706-050403020100'), false); // a deck id is not a run
  assert.equal(isLiveFlowRunId('run-7'), false);
  assert.equal(isLiveFlowRunId('xyz-0f0e0d0c-0b0a-4908-8706-050403020100'), false);
});

test('reads the gateway answers for this run only', () => {
  const wire = flowRunWireChannel(ID);
  assert.equal(isFlowRunAck({ type: 'pipeline', action: 'subscribed', channel: wire }, ID), true);
  assert.equal(isFlowRunAck({ type: 'pipeline', action: 'subscribed', channel: 'pipeline:run:other' }, ID), false);
  assert.equal(isFlowRunRefusal({ type: 'error', code: 'PIPELINE_CHANNEL_REFUSED', channel: wire }, ID), true);
  assert.equal(isFlowRunRefusal({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', channel: `social:flowrun:${ID}` }, ID), true);
  assert.equal(isFlowRunRefusal({ type: 'error', channel: 'social:ch:x' }, ID), false);
  assert.equal(isFlowRunFrame({ type: 'pipeline:event', payload: { runId: ID } }, ID), true);
  assert.equal(isFlowRunFrame({ type: 'pipeline:event', payload: { runId: 'sum-other' } }, ID), false);
});

test('offline: polls on the caller cadence, backs off a failure, resets on success, finishes once', async () => {
  const h = harness({ delayMs: () => 100 });
  await h.answer(new Error('net'));
  assert.equal(await h.tick(), 200); // one failure doubles
  await h.answer({ status: 'running' });
  assert.equal(await h.tick(), 100); // success resets
  await h.answer({ status: 'completed' });
  assert.deepEqual(h.outcomes, [{ status: 'finished', run: { status: 'completed' } }]);
  assert.deepEqual(h.errors, ['net']);
  assert.equal(h.timers.length, 0);
});

test('live: a frame re-reads the snapshot at once; no fast polling in between', async () => {
  const h = harness({ delayMs: () => 100 });
  await h.answer({ status: 'queued' });
  h.f.setLive(true);                              // catch-up read on becoming live
  await h.answer({ status: 'queued', n: 1 });
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.at, 30_000);          // only the safety read is scheduled
  h.f.frame();
  await h.answer({ status: 'running' });
  h.f.frame();
  await h.answer({ status: 'completed' });
  assert.deepEqual(h.updates.map((u) => u.status), ['queued', 'queued', 'running', 'completed']);
  assert.equal(h.outcomes.length, 1);
});

test('frames that land while a read is in flight coalesce into one follow-up read', async () => {
  const h = harness();
  h.f.setLive(true);           // first read still outstanding: marks dirty instead of a second request
  h.f.frame(); h.f.frame();
  assert.equal(h.pending.length, 1);
  await h.answer({ status: 'running' });
  assert.equal(h.pending.length, 1); // exactly one queued read
  await h.answer({ status: 'completed' });
  assert.equal(h.pending.length, 0);
  assert.equal(h.outcomes[0]!.status, 'finished');
});

test('a reconnect re-reads the snapshot (frames sent while down are only in the record)', async () => {
  const h = harness({ delayMs: () => 100 });
  await h.answer({ status: 'queued' });
  h.f.setLive(true); await h.answer({ status: 'running' });
  h.f.setLive(false);                       // socket dropped: back to the offline cadence now
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.at - 0, 100);
  h.f.setLive(true);                        // reconnected before the poll fired
  assert.equal(h.pending.length, 1);
  await h.answer({ status: 'completed' });
  assert.equal(h.outcomes[0]!.status, 'finished');
});

test('maxPolls keeps its offline meaning while live: the wall-time budget times out a stuck run', async () => {
  const h = harness({ delayMs: () => 1000, maxPolls: 5 }); // budget 5 s
  await h.answer({ status: 'queued' });
  h.f.setLive(true); await h.answer({ status: 'running' });
  const waited = await h.tick();             // safety read clipped to the budget, not 30 s
  assert.ok(waited <= 5000);
  if (h.pending.length) await h.answer({ status: 'running' });
  while (h.outcomes.length === 0 && h.timers.length) { await h.tick(); if (h.pending.length) await h.answer({ status: 'running' }); }
  assert.deepEqual(h.outcomes, [{ status: 'timed-out' }]);
});

test('maxPolls bounds a lost run offline', async () => {
  const h = harness({ maxPolls: 3 });
  await h.answer({ status: 'running' });
  await h.tick(); await h.answer({ status: 'running' });
  await h.tick(); await h.answer({ status: 'running' });
  assert.deepEqual(h.outcomes, [{ status: 'timed-out' }]);
});

test('offline polling pauses while hidden; stop() ends everything and nothing reports after it', async () => {
  let hidden = true; let resume: (() => void) | null = null;
  const h = harness({ isHidden: () => hidden, whenVisible: (fn) => { resume = fn; return () => { resume = null; }; } });
  await h.answer({ status: 'running' });
  await h.tick();
  assert.equal(h.pending.length, 0);   // hidden: waiting, not reading
  hidden = false; resume!();
  assert.equal(h.pending.length, 1);
  h.f.stop();
  await h.answer({ status: 'completed' });
  assert.equal(h.pending[0]?.signal.aborted ?? true, true);
  assert.equal(h.outcomes.length, 0);
  assert.equal(h.updates.length, 1);
});
