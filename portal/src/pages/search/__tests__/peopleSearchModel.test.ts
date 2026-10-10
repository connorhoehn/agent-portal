import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentSearchPerson, readSearchPersonAvatars, readSearchPersonUsers, type SearchPeoplePresentation } from '../peopleSearchModel.ts';
import type { SearchRecord } from '../searchTypes.ts';

const record: SearchRecord = { type: 'person', id: 'p-caleb', title: 'Caleb Turner', href: '/iq/search', subtitle: 'Engineer · Design' };
const source: SearchPeoplePresentation = {
  avatars: [{ id: 'p-caleb', name: 'Caleb Turner', avatarUrl: '/avatars/caleb.jpg' }],
  users: [{ personId: 'p-caleb', userId: 'u-caleb' }], present: [], presenceReady: true,
};

test('uses authorized portrait by exact ID and name; source portrait wins', () => {
  assert.equal(presentSearchPerson(record, source).avatarUrl, '/avatars/caleb.jpg');
  assert.equal(presentSearchPerson({ ...record, avatarUrl: '/avatars/new.jpg' }, source).avatarUrl, '/avatars/new.jpg');
  assert.equal(presentSearchPerson({ ...record, title: 'Another Caleb' }, source).avatarUrl, undefined);
  assert.equal(presentSearchPerson({ ...record, id: 'other' }, source).avatarUrl, undefined);
  assert.equal(presentSearchPerson(record, { ...source, avatars: [] }).avatarUrl, undefined);
});

test('online and away derive only from current exact mapped signed users', () => {
  assert.equal(presentSearchPerson(record, { ...source, present: [{ id: 'u-caleb' }] }).subtitle, 'Engineer · Design · Online');
  assert.equal(presentSearchPerson(record, { ...source, present: [{ id: 'u-caleb', idle: true }] }).subtitle, 'Engineer · Design · Away');
  assert.equal(presentSearchPerson(record, { ...source, present: [{ id: 'u-caleb', idle: true }, { id: 'u-caleb', idle: false }] }).subtitle, 'Engineer · Design · Online');
});

test('offline/unknown/disconnected/ambiguous mappings add no invented last-online or status', () => {
  for (const change of [
    {}, { present: [{ id: 'p-caleb' }] }, { users: [] },
    { users: [...source.users, { personId: 'p-caleb', userId: 'another-user' }], present: [{ id: 'u-caleb' }] },
    { presenceReady: false, present: [{ id: 'u-caleb' }] },
  ]) assert.equal(presentSearchPerson(record, { ...source, ...change }).subtitle, record.subtitle);
  const other = { ...record, type: 'work' as const };
  assert.equal(presentSearchPerson(other, source), other);
});

test('readers whitelist portrait and signed identity fields without HR/presence heuristics', () => {
  assert.deepEqual(readSearchPersonAvatars({ nodes: [{ id: 'p-caleb', name: 'Caleb Turner', avatarUrl: '/caleb.jpg', presence: 'office', expertise: 'private' }, { id: 'other', name: 'Other', avatarUrl: null }] }), [{ id: 'p-caleb', name: 'Caleb Turner', avatarUrl: '/caleb.jpg' }]);
  assert.deepEqual(readSearchPersonUsers({ users: [{ personId: 'p-caleb', userId: 'u-caleb', displayName: 'Caleb' }, { personId: 'bad', userId: null }, null] }), source.users);
  assert.deepEqual(readSearchPersonAvatars(null), []);
  assert.deepEqual(readSearchPersonUsers({}), []);
});
