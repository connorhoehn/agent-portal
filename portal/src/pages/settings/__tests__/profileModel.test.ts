// Run with:  cd portal && node --test 'src/pages/settings/__tests__/*.test.ts'
//
// The Settings → Profile section: who is signed in, whether the account is
// connected to a team profile, and — the rule that matters — a failed read is
// an error, never "not connected".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProfile, signedInLabel, IDENTITY_USERS_HREF, UNLINKED_TEXT,
} from '../profileModel.ts';

const me = { data: { sub: 'u-theo', name: 'Theo Chang' } };

test('signed-in label prints the name, never the account id', () => {
  assert.equal(signedInLabel({ sub: 'u-theo-clone-ab12cd34', name: 'Theo Chang' }), 'Theo Chang');
  assert.equal(signedInLabel({ sub: 'demo-user', name: 'demo-user' }), 'demo-user');
  assert.equal(signedInLabel({ sub: 'u-x', name: '  ' }), 'u-x');
});

test('loading: nothing is claimed while the reads are in flight', () => {
  const m = buildProfile({ me: { data: null }, person: { data: null }, canManageUsers: false });
  assert.equal(m.signedIn.state, 'loading');
  assert.equal(m.connection.state, 'loading');
});

test('a failed /me is an error, not a blank identity', () => {
  const m = buildProfile({ me: { data: null, error: 'HTTP 500' }, person: { data: null }, canManageUsers: false });
  assert.deepEqual(m.signedIn, { state: 'error', error: 'HTTP 500' });
});

test('a failed person read is an error, never "not connected"', () => {
  const m = buildProfile({ me, person: { data: null, error: 'HTTP 503' }, canManageUsers: false });
  assert.deepEqual(m.connection, { state: 'error', error: 'HTTP 503' });
});

test('a stale person body alongside an error still reads as the error', () => {
  const m = buildProfile({
    me, person: { data: { linked: false, personId: null }, error: 'HTTP 503' }, canManageUsers: false,
  });
  assert.equal(m.connection.state, 'error');
});

test('unlinked: the mockup wording, pointing at a workspace admin', () => {
  const m = buildProfile({ me, person: { data: { linked: false, personId: null } }, canManageUsers: false });
  assert.equal(m.connection.state, 'unlinked');
  if (m.connection.state !== 'unlinked') return;
  assert.equal(m.connection.text, UNLINKED_TEXT);
  assert.match(m.connection.hint, /A workspace admin can help connect it/);
  assert.equal(m.identityAction, null);
});

test('unlinked with ManageUsers: the hint names Identity → Users, and the action is offered', () => {
  const m = buildProfile({ me, person: { data: { linked: false, personId: null } }, canManageUsers: true });
  assert.equal(m.connection.state, 'unlinked');
  if (m.connection.state !== 'unlinked') return;
  assert.match(m.connection.hint, /Identity → Users/);
  assert.deepEqual(m.identityAction, { label: 'Open Identity → Users', href: IDENTITY_USERS_HREF });
});

test('linked with no id is treated as unlinked (nothing to link to)', () => {
  const m = buildProfile({ me, person: { data: { linked: true, personId: null } }, canManageUsers: false });
  assert.equal(m.connection.state, 'unlinked');
});

test('linked: the person name from the graph read', () => {
  const m = buildProfile({
    me,
    person: { data: { linked: true, personId: 'p-012' } },
    personDetail: { data: { name: 'Theo Chang' } },
    canManageUsers: false,
  });
  assert.deepEqual(m.connection, {
    state: 'linked', personId: 'p-012', name: 'Theo Chang', nameError: null, text: 'Connected to Theo Chang',
  });
});

test('linked, name still loading: connected is already true, the name is not guessed', () => {
  const m = buildProfile({
    me, person: { data: { linked: true, personId: 'p-012' } }, personDetail: { data: null }, canManageUsers: false,
  });
  assert.equal(m.connection.state, 'linked');
  if (m.connection.state !== 'linked') return;
  assert.equal(m.connection.name, null);
  assert.equal(m.connection.nameError, null);
});

test('linked, name read failed: still connected, and the failure is carried', () => {
  const m = buildProfile({
    me,
    person: { data: { linked: true, personId: 'p-012' } },
    personDetail: { data: { name: 'Stale' }, error: 'HTTP 404' },
    canManageUsers: true,
  });
  assert.equal(m.connection.state, 'linked');
  if (m.connection.state !== 'linked') return;
  assert.equal(m.connection.name, null);
  assert.equal(m.connection.nameError, 'HTTP 404');
  assert.equal(m.connection.text, 'Connected to a team profile');
  assert.ok(m.identityAction);
});
