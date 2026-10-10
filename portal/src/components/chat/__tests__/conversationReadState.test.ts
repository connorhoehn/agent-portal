import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationReadFrame } from '../conversationReadState.ts';

const channel = 'orgiq:initiative:p-observability';
test('history, including an empty native response, confirms a discussion; join alone does not', () => {
  assert.deepEqual(conversationReadFrame({ type: 'chat', action: 'joined', channel }, channel), { kind: 'joined' });
  assert.deepEqual(conversationReadFrame({ type: 'chat', action: 'history', channel, messages: [] }, channel), { kind: 'history' });
  assert.equal(conversationReadFrame({ type: 'chat', action: 'history', channel, messages: null }, channel), null);
  assert.equal(conversationReadFrame({ type: 'chat', action: 'history', channel: 'another', messages: [] }, channel), null);
});
test('the installed gateway subscribe denial blocks reading, while publish refusals leave reads alone', () => {
  const denial = { type: 'error', code: 'AUTHZ_CHANNEL_DENIED', service: 'chat', kind: 'subscribe', channel };
  const result = conversationReadFrame(denial, channel);
  assert.equal(result?.kind, 'error');
  if (result?.kind === 'error') assert.equal(result.state.denied, true);
  assert.equal(conversationReadFrame({ ...denial, kind: 'publish' }, channel), null);
  assert.equal(conversationReadFrame({ ...denial, service: 'cursor' }, channel), null);
  assert.equal(conversationReadFrame({ ...denial, channel: 'another' }, channel), null);
});
test('channel-scoped membership refusals block reads; unscoped and unrelated request failures do not', () => {
  const result = conversationReadFrame({ type: 'error', error: { service: 'chat', channel, code: 'not-a-member' } }, channel);
  assert.equal(result?.kind, 'error');
  assert.equal(conversationReadFrame({ type: 'error', service: 'chat', error: { code: 'not-a-member' } }, channel), null);
  assert.equal(conversationReadFrame({ type: 'error', service: 'chat', channel, error: { code: 'store-failed' } }, channel), null);
});
