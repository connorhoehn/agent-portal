import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallReactionPlayback } from '../callReactionPlayback.ts';
const now = Date.parse('2026-10-09T04:00:00Z');
const event = (id: string, age = 0, channel = 'huddle:one') => ({ id, channel, timestamp: new Date(now - age).toISOString() });
test('route remount and history refresh never replay an already displayed reaction', () => {
  const player = new CallReactionPlayback();
  assert.deepEqual(player.take([event('a')], now).map(r => r.id), ['a']);
  assert.deepEqual(player.take([event('a'), event('b')], now + 500).map(r => r.id), ['b']);
  assert.deepEqual(player.take([event('a'), event('b')], now + 1000), []);
});
test('old history, malformed timestamps, future events and message chips do not animate', () => {
  const player = new CallReactionPlayback();
  assert.deepEqual(player.take([event('old', 30000), event('future', -3000), { ...event('bad'), timestamp: 'invalid' }, { ...event('chip'), targetId: 'message:one' }], now), []);
  assert.deepEqual(player.take([event('new', 50), event('new', 50, 'huddle:two')], now).map(r => r.channel), ['huddle:one', 'huddle:two']);
});
