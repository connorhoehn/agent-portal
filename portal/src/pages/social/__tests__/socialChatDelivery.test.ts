import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendAndWaitForSocialChatAck, socialChatError } from '../socialChatDelivery.ts';

function connection() {
  const handlers = new Set<(frame: Record<string, unknown>) => void>();
  return { handlers, listen: (handler: (frame: Record<string, unknown>) => void) => {
    handlers.add(handler); return () => { handlers.delete(handler); };
  }, emit: (frame: Record<string, unknown>) => { for (const handler of handlers) handler(frame); } };
}
const channel = 'social:team:community:events';
const attempt = { channel, deliveryId: 'delivery-current', userId: 'u-mira' };
const broadcast = (id = 'message-current', deliveryId = attempt.deliveryId, userId = attempt.userId) => ({
  type: 'chat', action: 'message', channel, message: { id, channel, userId, metadata: { clientDeliveryId: deliveryId } },
});

test('a send retains its draft through live broadcasts and other-channel acknowledgements until its own persisted ack', async () => {
  const socket = connection(); let confirmed = false;
  const result = sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: new AbortController().signal, send: () => {
    assert.equal(socket.handlers.size, 1, 'listener is installed before sending');
    socket.emit(broadcast());
    socket.emit({ type: 'chat', action: 'sent', messageId: 'message-current', channel: 'social:ch:general' });
  } }).then(() => { confirmed = true; });
  await Promise.resolve(); assert.equal(confirmed, false);
  socket.emit({ type: 'chat', action: 'sent', channel, messageId: 'message-current' });
  await result; assert.equal(confirmed, true); assert.equal(socket.handlers.size, 0);
});

test('a nested server chat error rejects the send and unregisters without waiting for timeout', async () => {
  const socket = connection();
  await assert.rejects(sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: new AbortController().signal,
    send: () => socket.emit({ type: 'error', service: 'chat', error: { message: 'You must join the channel before sending messages' } }) }), /must join/);
  assert.equal(socket.handlers.size, 0);
});

test('unconfirmed sends time out, while navigation aborts promptly and never sends on an already abandoned scope', async () => {
  const socket = connection(); const abort = new AbortController(); let sent = 0;
  await assert.rejects(sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: abort.signal, timeoutMs: 2, send: () => { sent++; } }), /not confirmed/);
  const result = sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: abort.signal, send: () => { sent++; } });
  abort.abort(); await assert.rejects(result, /conversation changed/);
  await assert.rejects(sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: abort.signal, send: () => { sent++; } }), /conversation changed/);
  assert.equal(sent, 2); assert.equal(socket.handlers.size, 0);
});

test('synchronous socket refusal keeps the send unconfirmed and releases its listener', async () => {
  const socket = connection();
  await assert.rejects(sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: new AbortController().signal, send: () => { throw new Error('socket disconnected'); } }), /disconnected/);
  assert.equal(socket.handlers.size, 0);
});

test('a late prior acknowledgement and another author cannot confirm a newer attempt; either echo/ack order is supported', async () => {
  const socket = connection(); let confirmed = false;
  const result = sendAndWaitForSocialChatAck({ ...attempt, listen: socket.listen, signal: new AbortController().signal, send: () => {} }).then(() => { confirmed = true; });
  socket.emit(broadcast('message-old', 'delivery-old'));
  socket.emit({ type: 'chat', action: 'sent', channel, messageId: 'message-old' });
  socket.emit(broadcast('message-peer', attempt.deliveryId, 'u-sana'));
  socket.emit({ type: 'chat', action: 'sent', channel, messageId: 'message-peer' });
  socket.emit({ type: 'chat', action: 'sent', channel, messageId: 'message-current' });
  await Promise.resolve(); assert.equal(confirmed, false);
  socket.emit(broadcast()); await result;
  assert.equal(confirmed, true); assert.equal(socket.handlers.size, 0);
});

test('chat errors from another channel or service cannot contaminate this conversation', () => {
  assert.equal(socialChatError({ type: 'error', service: 'chat', channel: 'social:ch:general', error: 'other conversation' }, channel), null);
  assert.equal(socialChatError({ type: 'error', service: 'presence', error: 'presence' }, channel), null);
  assert.equal(socialChatError({ type: 'error', service: 'chat', channel, error: { message: 'store unavailable' } }, channel), 'store unavailable');
});
