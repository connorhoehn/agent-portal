// Run with:  cd portal && node --test 'src/pages/social/__tests__/*.test.ts'
//
// The Channels and DMs pages' data: channel/lobby names parse, the rail lists
// joined channels first, and a DM opened by URL before its first message still
// has a row named for the other person.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeNow, channelHref, channelRailItems, conversationRecordings, dmCandidates, dmHref, dmMembers, dmPeers, dmRailItems, dmTitle,
  matchesRailFilter, mentionItems, privacyForApi, slugFromChannel, socialInbox, withPresence, type SocialChannel, type SocialDm,
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

// ── The chat rail's extras (SocialChatWorkspace) ────────────────────────────

test('DM rows carry a presence dot; channel rows none', () => {
  const rows = withPresence([
    { channel: 'social:dm:u-a:u-b', kind: 'dm', peers: [{ userId: 'u-b', displayName: 'Bea' }] },
    { channel: 'social:ch:general', kind: 'channel', name: 'general', peers: [] },
  ], new Set(['u-b']));
  assert.equal(rows[0]!.peers[0]!.online, true);
  assert.deepEqual(rows[1]!.peers, []);
  assert.equal(withPresence(rows, new Set())[0]!.peers[0]!.online, false);
});

test('Active now leaves the viewer out, online before away', () => {
  const people = activeNow([
    { id: 'u-me', name: 'Me' }, { id: 'u-z', name: 'Zed', idle: true }, { id: 'u-b', name: 'Bea' }, { id: 'u-a', name: 'Ann' },
  ], 'u-me');
  assert.deepEqual(people.map((p) => `${p.displayName}:${p.status}`), ['Ann:online', 'Bea:online', 'Zed:away']);
});

test('the find box matches a channel name or a person', () => {
  const ch = { channel: 'social:ch:design', kind: 'channel' as const, name: 'design', peers: [] };
  const dm = { channel: 'social:dm:u-a:u-b', kind: 'dm' as const, peers: [{ userId: 'u-b', displayName: 'Bea Chen' }] };
  assert.equal(matchesRailFilter(ch, ''), true);
  assert.equal(matchesRailFilter(ch, 'DES'), true);
  assert.equal(matchesRailFilter(dm, 'chen'), true);
  assert.equal(matchesRailFilter(dm, 'design'), false);
});

test('the shelf counts only this workspace\'s inbox; Mentions are its mention items', () => {
  const entries = [
    { id: 'n1', type: 'mention', title: 'Lena mentioned you in #general', body: '@Mira can you look', timestamp: '2026-09-30T10:00:00Z', channel: 'social:ch:general', payload: { tenant: 'social', kind: 'mention', actorName: 'Lena Brandt' } },
    { id: 'n2', type: 'message' as never, title: 'Theo in #general', timestamp: '2026-09-30T11:00:00Z', channel: 'social:ch:general', payload: { tenant: 'social', kind: 'message' } },
    { id: 'n3', type: 'mention', title: 'elsewhere', timestamp: '2026-09-30T12:00:00Z', channel: 'orgiq:x', read: true, payload: { tenant: 'orgiq', kind: 'mention' } },
  ];
  assert.deepEqual(socialInbox(entries).map((e) => e.id), ['n1', 'n2']);
  assert.deepEqual(mentionItems(entries), [{
    messageId: 'n1', channel: 'social:ch:general', channelLabel: '#general', author: 'Lena Brandt',
    excerpt: '@Mira can you look', at: '2026-09-30T10:00:00Z', unread: true,
  }]);
});

test('a conversation\'s Calls view lists the recordings from its own lobby, newest first', () => {
  const rec = (id: string, lobbyName: string, startedAt: string, stage = 'ready') => ({
    recordingId: id, lobbyName, startedAt, durationMs: 60_000, participants: [{ userId: 'u-a' }], stage,
  });
  const items = conversationRecordings([
    rec('r1', 'social:ch:general', '2026-09-29T10:00:00Z'),
    rec('r2', 'social:room:town-hall', '2026-09-30T10:00:00Z'),
    rec('r3', 'social:ch:general', '2026-09-30T09:00:00Z', 'saving'),
  ], 'social:ch:general');
  assert.deepEqual(items.map((i) => `${i.recordingId}:${i.playable}:${i.participantCount}`), ['r3:false:1', 'r1:true:1']);
});

test('one section per route: each Social rail page shows Active now and only its own section', async () => {
  const { railSectionsFor, ROUTE_RAIL_CAPTION, SOCIAL_SECTION_CAPTIONS } = await import('../socialChat.ts');
  assert.deepEqual(railSectionsFor('channels'), ['active-now', 'channels']);
  assert.deepEqual(railSectionsFor('dms'), ['active-now', 'dms']);
  assert.deepEqual(railSectionsFor('teams'), ['active-now', 'teams']);
  assert.deepEqual(railSectionsFor('rooms'), ['rooms']);
  assert.deepEqual(railSectionsFor('calls'), ['active-now']);
  assert.deepEqual(railSectionsFor('recordings'), ['active-now']);
  for (const route of ['channels', 'dms', 'teams', 'rooms'] as const) {
    const own = ROUTE_RAIL_CAPTION[route]!;
    assert.ok((SOCIAL_SECTION_CAPTIONS as readonly string[]).includes(own), `${route} caption ${own} is a known section caption`);
  }
  assert.equal(ROUTE_RAIL_CAPTION.calls, null);
  assert.equal(ROUTE_RAIL_CAPTION.recordings, null);
});

test('the find field lists message and pin hits as rail rows, each opening its own in-app link', async () => {
  const { messageHitRailItems } = await import('../socialChat.ts');
  const { items, hrefs } = messageHitRailItems([
    { type: 'message', id: 'social:ch:general|g01', title: 'The community call moves to Thursdays at 3pm', href: '/social/channels/general', subtitle: '#general · Mira Okafor' },
    { type: 'pin', id: 'social:ch:events|e01', title: 'Quarterly community call is booked', href: '/social/channels/events', subtitle: 'Pinned in #events by Mira Okafor' },
    { type: 'message', id: 'social:ch:general|g01', title: 'duplicate', href: '/social/channels/general', subtitle: '#general · Mira Okafor' },
    { type: 'message', id: 'social:dm:u-lena:u-sana|d1', title: 'Your lightning talk slot is confirmed', href: '/social/dms/social%3Adm%3Au-lena%3Au-sana', subtitle: 'DM Lena Brandt, Sana Iqbal · Lena Brandt' },
    { type: 'channel', id: 'social:ch:general', title: '#general', href: '/social/channels/general' },
    { type: 'message', id: 'x', title: 'off-site', href: '//evil.example/p' },
    { type: 'message', id: 'y', title: '', href: '/social/channels/general' },
  ]);
  assert.deepEqual(items.map((i) => [i.channel, i.kind, i.name, i.lastMessagePreview]), [
    ['search:message:social:ch:general|g01', 'channel', 'general · Mira Okafor', 'The community call moves to Thursdays at 3pm'],
    ['search:pin:social:ch:events|e01', 'channel', 'Pinned in #events by Mira Okafor', 'Quarterly community call is booked'],
    ['search:message:social:dm:u-lena:u-sana|d1', 'group', undefined, 'Your lightning talk slot is confirmed'],
  ]);
  assert.deepEqual(items[2]!.peers.map((p) => p.displayName), ['Lena Brandt', 'Sana Iqbal']);
  assert.equal(hrefs.get('search:pin:social:ch:events|e01'), '/social/channels/events');
  assert.equal(hrefs.size, 3);
});
