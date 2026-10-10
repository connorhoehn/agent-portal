// Run with:  cd portal && node --test src/lib/__tests__/avatars.test.ts
//
// Faces end to end on the client: every mapper between a BFF/presence payload
// and a library composite carries `avatarUrl` through, and a missing or null
// one is LEFT OFF (the composite then draws initials) rather than passed as
// null or an empty string.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { presenceAvatarUsers } from '../../pages/assessment/knowledge/knowledgeFormat.ts';
import { rosterUsers } from '../../pages/pipelines/pipelinesRealtime.ts';
import { activeNow, dmCandidates, dmPeers, dmRailItems, type SocialDm } from '../../pages/social/socialChat.ts';
import { contactRows } from '../../pages/social/socialPlatform.ts';
import { readSharedPeople } from '../../components/shell/tenantDirectModel.ts';
import { rowPeople } from '../pageCalls.ts';

const entry = (clientId: string, userId: string, displayName: string, avatarUrl?: unknown) =>
  ({ clientId, status: 'online', metadata: { userId, displayName, ...(avatarUrl === undefined ? {} : { avatarUrl }) } });

test('presence rosters carry the stamped avatar, one per person, and drop a blank one', () => {
  const users = presenceAvatarUsers([
    entry('c1', 'u-mira', 'Mira Okafor'), entry('c2', 'u-mira', 'Mira Okafor', '/avatars/u-mira.svg'),
    entry('c3', 'u-lena', 'Lena Brandt', ''),
  ]);
  assert.deepEqual(users, [
    { id: 'u-mira', name: 'Mira Okafor', avatarUrl: '/avatars/u-mira.svg' },
    { id: 'u-lena', name: 'Lena Brandt' },
  ]);
  assert.deepEqual(rosterUsers([entry('c1', 'u-ines', 'Ines Moreau', '/avatars/u-ines.svg')]),
    [{ id: 'u-ines', name: 'Ines Moreau', avatarUrl: '/avatars/u-ines.svg' }]);
  assert.deepEqual(activeNow(users, 'u-lena'), [{ userId: 'u-mira', displayName: 'Mira Okafor', status: 'online', avatarUrl: '/avatars/u-mira.svg' }]);
});

test('DM rail peers keep a face and leave a null one off', () => {
  const dms: SocialDm[] = [
    { channel: 'social:dm:u-farah:u-mira', peers: [{ userId: 'u-farah', displayName: 'Farah Osei', avatarUrl: '/avatars/u-farah.svg' }], lastMessageAt: null, lastMessagePreview: null, lastMessageUserId: null },
    { channel: 'social:dm:u-lena:u-mira', peers: [{ userId: 'u-lena', displayName: 'Lena Brandt', avatarUrl: null }], lastMessageAt: null, lastMessagePreview: null, lastMessageUserId: null },
  ];
  const [farah, lena] = dmRailItems(dms, null, 'u-mira', []);
  assert.deepEqual(farah!.peers, [{ userId: 'u-farah', displayName: 'Farah Osei', avatarUrl: '/avatars/u-farah.svg' }]);
  assert.deepEqual(lena!.peers, [{ userId: 'u-lena', displayName: 'Lena Brandt' }]);
  // A DM opened by URL before its first message borrows the roster's face.
  const opened = dmRailItems([], 'social:dm:u-mira:u-sana', 'u-mira', [{ userId: 'u-sana', displayName: 'Sana Iqbal', avatarUrl: '/avatars/u-sana.svg' }]);
  assert.deepEqual(opened[0]!.peers, [{ userId: 'u-sana', displayName: 'Sana Iqbal', avatarUrl: '/avatars/u-sana.svg' }]);
  assert.deepEqual(dmPeers('social:dm:u-mira:u-sana', 'u-mira', []), [{ userId: 'u-sana', displayName: 'u-sana' }]);
  assert.deepEqual(dmCandidates([{ userId: 'u-sana', displayName: 'Sana Iqbal', roles: [], avatarUrl: '/avatars/u-sana.svg' }], 'u-mira'),
    [{ userId: 'u-sana', displayName: 'Sana Iqbal', avatarUrl: '/avatars/u-sana.svg' }]);
});

test('contacts, the shared directory and call-log rows carry faces', () => {
  const rows = contactRows([{ userId: 'u-sana', displayName: 'Sana Iqbal', roles: ['participant'], avatarUrl: '/avatars/u-sana.svg' },
    { userId: 'u-lena', displayName: 'Lena Brandt', roles: ['moderator'], avatarUrl: null }], [], 'u-mira');
  assert.equal(rows.find((r) => r.userId === 'u-sana')!.avatarUrl, '/avatars/u-sana.svg');
  assert.equal('avatarUrl' in rows.find((r) => r.userId === 'u-lena')!, false);

  const shared = readSharedPeople({ tenant: 'orgiq', lobby: 'orgiq:lobby', dmPrefix: 'orgiq:dm:',
    me: { userId: 'u-theo', displayName: 'Theo Chang', avatarUrl: '/avatars/p-001.svg' },
    people: [{ userId: 'u-vera', displayName: 'Vera Green', avatarUrl: 7 }] });
  assert.equal(shared!.me.avatarUrl, '/avatars/p-001.svg');
  assert.deepEqual(shared!.people, [{ userId: 'u-vera', displayName: 'Vera Green' }]);

  const people = rowPeople({ callId: 'c', direction: 'incoming', callerId: 'u-lena', targetUserIds: ['u-mira'], lobbyName: 'social:dm:u-lena:u-mira',
    audioOnly: false, outcome: 'missed', startedAt: '2026-10-07T00:00:00.000Z', avatars: { 'u-lena': '/avatars/u-lena.svg', 'u-mira': null } }, 'u-mira', (id) => id);
  assert.deepEqual(people, [{ userId: 'u-mira', displayName: 'You' }, { userId: 'u-lena', displayName: 'u-lena', avatarUrl: '/avatars/u-lena.svg' }]);
});
