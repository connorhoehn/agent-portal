// A page that says "reconnecting…" before it has ever connected reports a
// failure that has not happened. Both live-stream indicators did that from the
// moment they mounted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamPhase, streamStatusLabel } from '../streamStatus.ts';

test('the first wait is connecting, not reconnecting', () => {
  assert.equal(streamPhase(false, false), 'connecting');
  assert.equal(streamStatusLabel(false, false), 'connecting…');
});

test('a gap after the stream has been up is a reconnect', () => {
  assert.equal(streamPhase(false, true), 'reconnecting');
  assert.equal(streamStatusLabel(false, true), 'reconnecting…');
});

test('connected reads live, whether or not it has dropped before', () => {
  assert.equal(streamStatusLabel(true, false), 'live');
  assert.equal(streamStatusLabel(true, true), 'live');
});
