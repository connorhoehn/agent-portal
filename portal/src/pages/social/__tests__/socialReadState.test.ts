import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationRailEmptyLabel, socialReadLabel, socialReadState } from '../socialReadState.ts';

const ready = { data: { conversations: [] }, isLoading: false, error: null };
test('a failed first read is unavailable, never an honestly empty list', () => {
  const failed = { data: null, isLoading: false, error: '503 Service Unavailable — rooms upstream' };
  assert.equal(socialReadState(failed), 'unavailable');
  assert.equal(socialReadLabel('Channels', failed), "Channels couldn't load.");
  assert.equal(conversationRailEmptyLabel([ready, failed], ''), 'Some conversations are unavailable');
});
test('a failed refresh retains known rows and says they could not refresh', () => {
  const stale = { data: { channels: [{ slug: 'general' }] }, isLoading: false, error: '401 — downstream token expired' };
  assert.equal(socialReadState(stale), 'stale');
  assert.equal(socialReadLabel('Channels', stale), "Channels couldn't refresh.");
  assert.equal(conversationRailEmptyLabel([ready, stale], ''), 'Conversations could not be refreshed');
});
test('initial loading, successful empty, and filtered empty states remain distinct', () => {
  assert.equal(conversationRailEmptyLabel([ready, { data: null, isLoading: true, error: null }], ''), 'Loading conversations…');
  assert.equal(conversationRailEmptyLabel([ready, ready], ''), 'No conversations yet');
  assert.equal(conversationRailEmptyLabel([ready, ready], 'does not match'), 'No chats match this search');
});
