// Run with:  cd portal && node --test 'src/pages/projects/__tests__/*.test.ts'
//
// The initiative call: who Start call rings (owner + SMEs with a linked user,
// never yourself), who it cannot ring and says so, and why the button is off.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initiativeCallAvailability,
  initiativeCallChannel,
  initiativeCallPeople,
  initiativeCallTargets,
  initiativeFromChannel,
  lobbyPrefix,
  skippedNotice,
} from '../initiativeCallModel.ts';

const vera = { personId: 'p-002', name: 'Vera Green' };
const nora = { personId: 'p-004', name: 'Nora DaSilva' };
const maya = { personId: 'p-051', name: 'Simone Chang' };
const users = [
  { personId: 'p-002', userId: 'u-vera', displayName: 'Vera Green' },
  { personId: 'p-004', userId: 'u-nora', displayName: 'Nora DaSilva' },
];

test('owner first, SMEs after, a repeated person once', () => {
  assert.deepEqual(initiativeCallPeople(vera, [nora, vera, maya]).map((p) => p.personId), ['p-002', 'p-004', 'p-051']);
  assert.deepEqual(initiativeCallPeople(null, [nora]).map((p) => p.personId), ['p-004']);
});

test('rings linked people except yourself; unlinked people are skipped, not rung', () => {
  const r = initiativeCallTargets([vera, nora, maya], users, 'u-vera');
  assert.deepEqual(r.targets, [{ userId: 'u-nora', displayName: 'Nora DaSilva' }]);
  assert.deepEqual(r.skipped, [maya]);
});

test('nothing is decided before the user mapping arrives', () => {
  assert.deepEqual(initiativeCallTargets([vera, nora], null, 'u-vera'), { targets: [], skipped: [], selfOnly: false });
});

test('the skipped notice names each person', () => {
  assert.equal(skippedNotice([]), null);
  assert.match(skippedNotice([maya])!, /^Simone Chang has no Work sign-in/);
  assert.match(skippedNotice([maya, nora])!, /^Simone Chang and Nora DaSilva have no/);
});

const ready: Parameters<typeof initiativeCallAvailability>[0] = {
  gatewayConfigured: true, connectionState: 'connected', platformApiUrl: 'http://localhost:13001',
  signedIn: true, usersLoaded: true, targets: [{ userId: 'u-nora', displayName: 'Nora' }],
};

test('Start call is on only with a gateway, platform-api, a connection and someone to ring', () => {
  assert.deepEqual(initiativeCallAvailability(ready), { ok: true });
  const off = (patch: Partial<typeof ready>) => {
    const a = initiativeCallAvailability({ ...ready, ...patch });
    assert.equal(a.ok, false);
    return a.ok ? '' : a.reason;
  };
  assert.match(off({ gatewayConfigured: false }), /VITE_GATEWAY_URL/);
  assert.match(off({ platformApiUrl: null }), /platform-api/);
  assert.match(off({ connectionState: 'reconnecting' }), /Connecting/);
  assert.match(off({ usersLoaded: false }), /Finding/);
  assert.match(off({ targets: [] }), /Nobody else/);
});

test('lobby prefix is the tenant; the channel carries the initiative id both ways', () => {
  assert.equal(lobbyPrefix('orgiq'), 'orgiq:');
  assert.equal(initiativeCallChannel('p-auth-migration'), 'initiative:p-auth-migration');
  assert.equal(initiativeFromChannel('initiative:p-auth-migration'), 'p-auth-migration');
  assert.equal(initiativeFromChannel('chat:dm:a:b'), null);
  assert.equal(initiativeFromChannel(null), null);
});
