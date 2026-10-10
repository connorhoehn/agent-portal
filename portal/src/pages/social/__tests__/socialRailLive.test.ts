import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMessageChannels } from '../socialRailLive.ts';

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: 'message', title: 't', timestamp: '2026-10-06T00:00:00Z', channel: 'social:dm:a:b',
  payload: { tenant: 'social', kind: 'message' }, ...over,
});

test('a new social message item names its channel once', () => {
  const out = newMessageChannels([item('1'), item('2')], new Set());
  assert.deepEqual(out.channels, ['social:dm:a:b']);
  assert.deepEqual(out.ids, ['1', '2']);
});
test('seen items and other tenants are ignored', () => {
  const out = newMessageChannels([item('1'), item('2', { payload: { tenant: 'orgiq', kind: 'message' } })], new Set(['1']));
  assert.deepEqual(out, { channels: [], ids: [] });
});
test('non-message kinds mark the id seen but name no channel', () => {
  const out = newMessageChannels([item('3', { type: 'call', payload: { tenant: 'social', kind: 'call' } })], new Set());
  assert.deepEqual(out, { channels: [], ids: ['3'] });
});
