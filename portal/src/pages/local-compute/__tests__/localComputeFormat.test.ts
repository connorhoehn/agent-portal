import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, statusTone, when } from '../localComputeFormat.ts';

test('statusLabel normalizes job statuses', () => {
  assert.equal(statusLabel('queued'), 'queued');
  assert.equal(statusLabel('awaiting_review'), 'awaiting review');
  assert.equal(statusLabel('done'), 'done');
  assert.equal(statusLabel('failed'), 'failed');
});

test('statusTone maps statuses to tones', () => {
  assert.equal(statusTone('done'), 'success');
  assert.equal(statusTone('awaiting_review'), 'info');
  assert.equal(statusTone('running'), 'info');
  assert.equal(statusTone('failed'), 'danger');
  assert.equal(statusTone('cancelled'), 'neutral');
  assert.equal(statusTone('queued'), 'neutral');
});

test('when formats timestamps', () => {
  const now = Date.now();
  assert.equal(when(null), 'never');
  assert.equal(when(undefined), 'never');
  assert.equal(when('invalid'), '—');
  assert.equal(when(new Date(now - 30_000).toISOString()), 'just now');
  assert.equal(when(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(when(new Date(now - 90 * 60_000).toISOString()), '2h ago');
  assert.equal(when(new Date(now - 2 * 24 * 60 * 60_000).toISOString()), '2d ago');
});
