import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scopePresenceChannel, scopePresenceUsers } from '../scopePresenceModel.ts';

test('channels are tenant-prefixed and a focused work item wins', () => {
  assert.equal(scopePresenceChannel('p-soc2'), 'orgiq:initiative:p-soc2');
  assert.equal(scopePresenceChannel('p-soc2', 'w-1'), 'orgiq:work:w-1');
});

test('one avatar per person; unstamped connections are dropped', () => {
  const users = scopePresenceUsers([
    { clientId: 'a', metadata: { userId: 'u1', displayName: 'Ana' } },
    { clientId: 'b', metadata: { userId: 'u1', displayName: 'Ana' } },
    { clientId: 'c' },
  ]);
  assert.deepEqual(users, [{ id: 'u1', name: 'Ana' }]);
});
