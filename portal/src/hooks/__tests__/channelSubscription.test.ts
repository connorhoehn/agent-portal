// The gateway's answers to a channel subscribe, as useDistillationChannel
// reads them, and the retry schedule after a refusal. The storm this pins
// against (2026-10-01): a refusal re-ran the subscribe immediately, ~4,600
// frames a second from one tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChannelHolds, isSubscribeAck, isSubscribeRefusal, resubscribeDelayMs, RESUBSCRIBE_BASE_MS, RESUBSCRIBE_MAX_MS,
} from '../channelSubscription.ts';

const CH = 'orgiq:distill:levels';

test('the router\'s refusal frame for our channel is a refusal', () => {
  // The exact shape realtime-modules 0.99.3 sends (server-ws/channelAccess.js).
  const denied = {
    type: 'error', code: 'AUTHZ_CHANNEL_DENIED', kind: 'subscribe', channel: CH,
    message: `Not allowed to subscribe to ${CH}`,
    error: { code: 'AUTHZ_CHANNEL_DENIED', message: `Not allowed to subscribe to ${CH}`, timestamp: 't' },
    timestamp: 't',
  };
  assert.equal(isSubscribeRefusal(denied, CH), true);
  // Any error naming our channel counts; an error for another channel does not.
  assert.equal(isSubscribeRefusal({ type: 'error', code: 'INVALID_PAYLOAD', channel: CH }, CH), true);
  assert.equal(isSubscribeRefusal({ ...denied, channel: 'orgiq:distill:review' }, CH), false);
  assert.equal(isSubscribeRefusal({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED' }, CH), false, 'names no channel');
  assert.equal(isSubscribeRefusal({ type: 'levels', channel: CH, levels: [] }, CH), false);
  assert.equal(isSubscribeRefusal(null, CH), false);
});

test('the subscribed ack is recognised for our channel only', () => {
  assert.equal(isSubscribeAck({ type: 'subscribe', action: 'subscribed', channel: CH }, CH), true);
  assert.equal(isSubscribeAck({ type: 'subscribe', action: 'unsubscribed', channel: CH }, CH), false);
  assert.equal(isSubscribeAck({ type: 'subscribe', action: 'subscribed', channel: 'distill:levels' }, CH), false);
});

test('a refusal waits at least 30 s, doubling, capped at 10 min — never an immediate retry', () => {
  assert.equal(resubscribeDelayMs(1), RESUBSCRIBE_BASE_MS);
  assert.equal(resubscribeDelayMs(2), 2 * RESUBSCRIBE_BASE_MS);
  assert.equal(resubscribeDelayMs(3), 4 * RESUBSCRIBE_BASE_MS);
  assert.equal(resubscribeDelayMs(50), RESUBSCRIBE_MAX_MS);
  // Degenerate counts still wait the base delay.
  assert.equal(resubscribeDelayMs(0), RESUBSCRIBE_BASE_MS);
  assert.equal(resubscribeDelayMs(-3), RESUBSCRIBE_BASE_MS);
  for (let n = 0; n < 40; n++) assert.ok(resubscribeDelayMs(n) >= RESUBSCRIBE_BASE_MS);
});

test('two holders share one membership: first acquire subscribes, last release unsubscribes', () => {
  const holds = createChannelHolds();
  const frames: string[] = [];
  const sub = (c: string) => frames.push(`sub ${c}`);
  const unsub = (c: string) => frames.push(`unsub ${c}`);
  const socket = sub; // the socket is keyed by its stable subscribe function
  holds.acquire(socket, CH, sub);
  holds.acquire(socket, CH, sub);
  assert.deepEqual(frames, [`sub ${CH}`]);
  holds.release(socket, CH, unsub);
  assert.deepEqual(frames, [`sub ${CH}`], 'the other holder still reads the channel');
  holds.release(socket, CH, unsub);
  assert.deepEqual(frames, [`sub ${CH}`, `unsub ${CH}`]);
  // An unmatched release sends nothing.
  holds.release(socket, CH, unsub);
  assert.equal(frames.length, 2);
  assert.equal(holds.count(socket, CH), 0);
  // A different socket (a reconnect's new provider) counts on its own.
  const other = () => undefined;
  holds.acquire(other, CH, sub);
  assert.equal(holds.count(other, CH), 1);
  assert.equal(holds.count(socket, CH), 0);
});
