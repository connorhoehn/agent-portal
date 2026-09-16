import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, statusTone, truncate, when,
  pollState, pollLabel, POLL_STALE_MS,
} from '../localComputeFormat.ts';

test('statusLabel normalizes job statuses', () => {
  assert.equal(statusLabel('queued'), 'queued');
  assert.equal(statusLabel('awaiting_review'), 'awaiting review');
  assert.equal(statusLabel('done'), 'done');
  assert.equal(statusLabel('failed'), 'failed');
});

// Tones now come from the shared runStateChip (lib/statusTone.ts), the work
// lane's canonical map — `running` and `awaiting_review` changed colour here
// to match it (see localComputeFormat.ts's doc comment).
test('statusTone maps statuses to tones', () => {
  assert.equal(statusTone('done'), 'success');
  assert.equal(statusTone('awaiting_review'), 'warning');
  assert.equal(statusTone('running'), 'accent');
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
  // Floors rather than rounds, since 2026-09-16: `when` delegates to the
  // shared lib/relativeTime instead of parsing with `new Date` itself (the
  // naive-timestamp bug), and that helper floors. "1h ago" for ninety minutes
  // is the honest reading — the old local copy rounded it up to "2h ago",
  // overstating how stale the fact was.
  assert.equal(when(new Date(now - 90 * 60_000).toISOString()), '1h ago');
  assert.equal(when(new Date(now - 2 * 24 * 60 * 60_000).toISOString()), '2d ago');
});

test('truncate leaves short text alone and ellipsizes long text', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('exactly ten', 11), 'exactly ten');
  assert.equal(truncate('this is a long summary line', 10), 'this is a …');
});

// ── Is it pulling work? ──────────────────────────────────────────────────────
//
// Presence cannot answer this. The worker announces every 25s whether or not
// it is asking for work, so a paired laptop with its worker switched off reads
// `connected` and looks exactly like one working all day. Reported by someone
// away from their desk wanting to know their machine was still going.

test('a machine that claimed just now is pulling work', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  assert.equal(pollState('2026-09-16 11:59:50+00', now), 'pulling');
  assert.equal(pollLabel(pollState('2026-09-16 11:59:50+00', now)), 'pulling work');
});

test('a claim older than the window reads as stopped, not as never', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  // Ten minutes: several missed polls on any sane interval.
  assert.equal(pollState('2026-09-16 11:50:00+00', now), 'stopped');
  assert.equal(pollLabel(pollState('2026-09-16 11:50:00+00', now)), 'not polling');
});

test('the window tolerates a slow poll rather than flickering', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  // Just inside three minutes is still pulling: a 30s poller that hit a slow
  // claim must not drop to "stopped" between polls.
  assert.equal(pollState(new Date(now - POLL_STALE_MS + 1_000).toISOString(), now), 'pulling');
  assert.equal(pollState(new Date(now - POLL_STALE_MS - 1_000).toISOString(), now), 'stopped');
});

test('never claimed is its own state, not a failure', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  assert.equal(pollState(null, now), 'never');
  assert.equal(pollState(undefined, now), 'never');
  assert.equal(pollLabel(pollState(null, now)), 'worker not started');
});

test('an unparseable timestamp reads as never rather than as pulling', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  // Never guess "healthy" from a value we could not read.
  assert.equal(pollState('not a date', now), 'never');
  assert.equal(pollState('', now), 'never');
});
