import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueTotal, type PipelineQueue } from '../pipelineQueues.ts';
const row = (ready: number | null, state: PipelineQueue['state'] = 'available'): PipelineQueue => ({ name: 'q', purpose: '', deadLetter: false, redriveTo: null, maxReceives: null, reason: null, state, snapshot: { ready, inFlight: 0, delayed: 0, fifo: null, visibilityTimeoutSeconds: 60 } });
test('partial queue totals remain unknown instead of showing zero or a misleading partial sum', () => {
  assert.equal(queueTotal([row(2), row(3)], 'ready'), 5);
  assert.equal(queueTotal([row(0)], 'ready'), 0);
  assert.equal(queueTotal([row(2), row(null)], 'ready'), null);
  assert.equal(queueTotal([row(2), row(0, 'unavailable')], 'ready'), null);
  assert.equal(queueTotal([], 'ready'), null);
});
