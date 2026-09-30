// Run with:  cd portal && node --test 'src/pages/social/__tests__/*.test.ts'
//
// The Channels and DMs pages' data: channel/lobby names parse, the rail lists
// joined channels first, and a DM opened by URL before its first message still
// has a row named for the other person.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  channelHref, channelRailItems, dmCandidates, dmHref, dmMembers, dmPeers, dmRailItems, dmTitle,
  privacyForApi, slugFromChannel, type SocialChannel, type SocialDm,
} from '../socialChat.ts';

const channel = (slug: string, joined: boolean, extra: Partial<SocialChannel> = {}): SocialChannel => ({
  slug, channel: `social:ch:${slug}`, name: slug, description: null, privacy: 'public', createdBy: 'u-mira',
  createdAt: '2026-09-29T10:00:00.000Z', memberCount: 1, joined, role: joined ? 'member' : null,
  lastMessageAt: null, lastMessagePreview: null, ...extra,
});

test('channel and lobby names parse', () => {
  assert.equal(slugFromChannel('social:ch:design'), 'design');
  assert.equal(slugFromChannel('social:dm:u-a:u-b'), null);
  assert.equal(slugFromChannel('social:ch:'), null);
  assert.deepEqual(dmMembers('social:dm:u-lena:u-mira'), ['u-lena', 'u-mira']);
  assert.deepEqual(dmMembers('assessment:dm:u-a:u-b'), []);
});

test('hrefs stay inside the social tenant and encode the lobby', () => {
  assert.equal(channelHref('design'), '/social/channels/design');
  assert.equal(dmHref('social:dm:u-lena:u-mira'), '/social/dms/social%3Adm%3Au-lena%3Au-mira');
});

test('the dialog privacy maps onto the API vocabulary', () => {
  assert.equal(privacyForApi('standard'), 'public');
  assert.equal(privacyForApi('private'), 'private');
});

test('joined channels lead the rail, each group alphabetical, and carry the last message', () => {
  const rows = channelRailItems([
    channel('zeta', false), channel('beta', true, { lastMessagePreview: 'hi', lastMessageAt: '2026-09-29T11:00:00.000Z' }), channel('alpha', false),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['beta', 'alpha', 'zeta']);
  assert.equal(rows[0]!.kind, 'channel');
  assert.equal(rows[0]!.lastMessagePreview, 'hi');
  assert.equal('lastMessagePreview' in rows[1]!, false);
});

test('a DM opened by URL before its first message still gets a named row', () => {
  const people = [{ userId: 'u-mira', displayName: 'Mira Okafor' }, { userId: 'u-sana', displayName: 'Sana Iqbal' }];
  const rows = dmRailItems([], 'social:dm:u-mira:u-sana', 'u-sana', people);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.peers, [{ userId: 'u-mira', displayName: 'Mira Okafor' }]);
  assert.equal(rows[0]!.kind, 'dm');
  const listed: SocialDm = { channel: 'social:dm:u-mira:u-sana', peers: [{ userId: 'u-mira', displayName: 'Mira Okafor' }], lastMessageAt: null, lastMessagePreview: 'hey', lastMessageUserId: 'u-mira' };
  assert.equal(dmRailItems([listed], 'social:dm:u-mira:u-sana', 'u-sana', people).length, 1);
});

test('a DM names the other people, never the caller; unknown ids fall back to the id', () => {
  assert.deepEqual(dmPeers('social:dm:u-lena:u-x', 'u-lena', []), [{ userId: 'u-x', displayName: 'u-x' }]);
  assert.equal(dmTitle([{ userId: 'u-a', displayName: 'A' }, { userId: 'u-b', displayName: 'B' }]), 'A, B');
  assert.equal(dmTitle([]), 'Direct message');
});

test('the New DM picker offers everyone but the caller, by name', () => {
  const out = dmCandidates([
    { userId: 'u-sana', displayName: 'Sana Iqbal', roles: ['participant'] },
    { userId: 'u-lena', displayName: 'Lena Brandt', roles: ['moderator'] },
    { userId: 'u-mira', displayName: 'Mira Okafor', roles: [] },
  ], 'u-sana');
  assert.deepEqual(out.map((p) => p.userId), ['u-lena', 'u-mira']);
  assert.equal(out[0]!.hint, 'moderator');
  assert.equal('hint' in out[1]!, false);
});

test('the DM rail carries each unread count, and none on the conversation being read', () => {
  const dms = [
    { channel: 'social:dm:u-lena:u-sana', peers: [{ userId: 'u-lena', displayName: 'Lena Brandt' }], lastMessageAt: '2026-09-29T10:00:00Z', lastMessagePreview: 'hi', lastMessageUserId: 'u-lena', unreadCount: 2 },
    { channel: 'social:dm:u-mira:u-sana', peers: [{ userId: 'u-mira', displayName: 'Mira Okafor' }], lastMessageAt: '2026-09-29T09:00:00Z', lastMessagePreview: 'yo', lastMessageUserId: 'u-mira', unreadCount: 1 },
  ];
  const rows = dmRailItems(dms, 'social:dm:u-mira:u-sana', 'u-sana', []);
  assert.equal(rows.find((r) => r.channel === 'social:dm:u-lena:u-sana')?.unreadCount, 2);
  assert.equal(rows.find((r) => r.channel === 'social:dm:u-mira:u-sana')?.unreadCount, undefined);
});
