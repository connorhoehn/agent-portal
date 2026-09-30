// Run with:  cd portal && node --test 'src/pages/social/__tests__/*.test.ts'
//
// The S2 pages' data (docs/social-tenant-design.md §4.3–§4.5): lobby and
// channel names, the rooms-list adapter, the team tree, recordings, the call
// log's rows and writer, and contacts with presence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callBackTargets, callRows, contactRows, dmIds, dmLobby, findTeamChannel, formatDuration, hangoutRoomsFrom, lobbyLabel,
  mayDeleteRecording, namesFrom, parseTeamChannel, recordingItems, roomLobby, roomSlugFromLobby, socialCallHref,
  teamCandidates, teamChannelName, teamTreeItems, type SocialCall, type SocialRecording, type SocialRoom, type SocialTeam,
} from '../socialPlatform.ts';
import { callLogEvents, reportCallLogEvents } from '../socialCallLog.ts';

const nameOf = namesFrom([{ userId: 'u-mira', displayName: 'Mira Okafor' }, { userId: 'u-sana', displayName: 'Sana Iqbal' }, { userId: 'u-lena', displayName: 'Lena Brandt' }]);

test('lobby names: social:room:<slug>, social:dm:<sorted ids>, social:team:<team>:<channel>', () => {
  assert.equal(roomLobby('town-hall'), 'social:room:town-hall');
  assert.equal(roomSlugFromLobby('social:room:town-hall'), 'town-hall');
  assert.equal(roomSlugFromLobby('orgiq:room:x'), null);
  assert.equal(dmLobby(['u-sana', 'u-mira', 'u-sana']), 'social:dm:u-mira:u-sana');
  assert.deepEqual(dmIds('social:dm:u-mira:u-sana'), ['u-mira', 'u-sana']);
  // Upstream a channel slug carries its team; the conversation keeps them apart.
  assert.equal(teamChannelName({ slug: 'community' }, { slug: 'community-events' }), 'social:team:community:events');
  assert.equal(teamChannelName({ slug: 'community' }, { slug: 'standalone' }), 'social:team:community:standalone');
  assert.deepEqual(parseTeamChannel('social:team:community:events'), { team: 'community', channel: 'events' });
  assert.equal(parseTeamChannel('social:ch:general'), null);
});

test('Accept on a social ring opens the room or the DM; anything else stays put', () => {
  assert.equal(socialCallHref('social:room:town-hall'), '/social/rooms?room=town-hall');
  assert.equal(socialCallHref('social:dm:u-mira:u-sana'), `/social/dms/${encodeURIComponent('social:dm:u-mira:u-sana')}`);
  assert.equal(socialCallHref('initiative:p-soc2'), null);
});

const room = (slug: string, extra: Partial<SocialRoom> = {}): SocialRoom => ({
  orgId: 'social', roomId: `r-${slug}`, slug, name: slug, createdBy: 'u-mira', createdAt: '2026-09-29T00:00:00.000Z',
  visibility: 'org', settings: { audioOnly: false, recordingEnabled: false, softCap: 25 }, state: 'active',
  lastActiveAt: '2026-09-29T00:00:00.000Z', lobbyName: roomLobby(slug), ...extra,
});

test('hangoutRoomsFrom gives the library list useHangoutRooms()\' shape over the BFF rows', async () => {
  let posted: unknown = null;
  let refreshed = 0;
  const h = hangoutRoomsFrom({
    rooms: [room('a')], isLoading: false, error: null, refetch: () => { refreshed += 1; },
    create: async (body) => { posted = body; return room('new'); },
  });
  assert.deepEqual(h.rooms.map((r) => r.slug), ['a']);
  assert.equal(h.isLoading, false);
  assert.equal(h.error, null);
  await h.refetch();
  assert.equal(refreshed, 1);
  // The library's dialog may omit visibility; the BFF always gets one.
  await h.createRoom({ name: 'Quiet', visibility: 'private' });
  assert.deepEqual(posted, { name: 'Quiet', visibility: 'private' });
  await h.createRoom({ name: 'Open' });
  assert.deepEqual(posted, { name: 'Open', visibility: 'org' });
  await assert.rejects(h.joinRoom('a'));
  // Loading and error only while there is nothing to show.
  const loading = hangoutRoomsFrom({ rooms: null, isLoading: true, error: 'down', refetch: () => {}, create: async () => room('x') });
  assert.equal(loading.isLoading, true);
  assert.equal(loading.error?.message, 'down');
});

const team = (slug: string, channels: string[], extra: Partial<SocialTeam> = {}): SocialTeam => ({
  teamId: `t-${slug}`, slug, name: slug, visibility: 'org', createdBy: 'u-mira', role: 'member', favorite: false,
  channels: channels.map((c) => ({ roomId: `r-${c}`, slug: `${slug}-${c}`, name: c, channelPrivacy: 'standard', createdBy: 'u-mira' })), ...extra,
});

test('the team tree names each channel social:team:<team>:<channel>, and a selection finds its team', () => {
  const teams = [team('community', ['general', 'events'], { favorite: true })];
  const tree = teamTreeItems(teams);
  assert.deepEqual(tree[0]!.channels.map((c) => c.channel), ['social:team:community:general', 'social:team:community:events']);
  assert.equal(tree[0]!.pinned, true);
  const hit = findTeamChannel(teams, 'social:team:community:events');
  assert.equal(hit?.team.slug, 'community');
  assert.equal(hit?.channel.name, 'events');
  assert.equal(findTeamChannel(teams, 'social:team:nope:x'), null);
  assert.deepEqual(teamCandidates([{ userId: 'u-a' }, { userId: 'u-b' }], [{ userId: 'u-b' }]).map((p) => p.userId), ['u-a']);
});

test('recordings: labelled by room name or the other people; status from the stage; delete is the starter\'s', () => {
  const recs: SocialRecording[] = [
    { callId: 'c1', recordingId: 'r1', lobbyName: 'social:room:town-hall', startedAt: '2026-09-29T00:00:00.000Z', endedAt: '2026-09-29T00:41:00.000Z', durationMs: 2_460_000, participants: [{ userId: 'u-mira' }, { userId: 'u-sana' }], startedBy: 'u-mira', stage: 'ready', expiresAt: null },
    { callId: 'c2', recordingId: 'r2', lobbyName: 'social:dm:u-lena:u-sana', startedAt: '2026-09-29T01:00:00.000Z', endedAt: '2026-09-29T01:09:00.000Z', durationMs: 540_000, participantCount: 2, participants: [], stage: 'transcribing', expiresAt: null },
  ];
  const items = recordingItems(recs, 'u-sana', nameOf, [{ slug: 'town-hall', name: 'Town hall' }]);
  assert.deepEqual(items.map((i) => i.label), ['Town hall', 'Lena Brandt']);
  assert.deepEqual(items.map((i) => i.status), ['ready', 'processing']);
  assert.deepEqual(items.map((i) => i.participantCount), [2, 2]);
  assert.equal(items[0]!.durationSec, 2460);
  assert.equal(mayDeleteRecording(recs[0]!, 'u-mira'), true);
  assert.equal(mayDeleteRecording(recs[0]!, 'u-sana'), false);
  assert.equal(mayDeleteRecording(recs[1]!, 'u-lena'), false); // no startedBy: nobody
  assert.equal(lobbyLabel('social:dm:u-sana', 'u-sana', nameOf), 'Just you');
});

test('call log rows: who, outcome, length; call back rings the DM\'s others, a room is walked back into', () => {
  const calls: SocialCall[] = [
    { callId: 'c1', direction: 'incoming', callerId: 'u-mira', callerName: 'Mira Okafor', targetUserIds: ['u-sana'], lobbyName: 'social:dm:u-mira:u-sana', audioOnly: false, outcome: 'missed', startedAt: '2026-09-29T00:00:00.000Z' },
    { callId: 'c2', direction: 'joined', callerId: 'u-sana', targetUserIds: [], lobbyName: 'social:room:town-hall', audioOnly: false, outcome: 'answered', startedAt: '2026-09-29T01:00:00.000Z', durationMs: 125_000 },
  ];
  const rows = callRows(calls, 'u-sana', nameOf, [{ slug: 'town-hall', name: 'Town hall' }]);
  assert.deepEqual(rows.map((r) => [r.who, r.direction, r.outcome, r.missed, r.duration]), [
    ['Mira Okafor', 'Incoming', 'Missed', true, '—'],
    ['Town hall', 'Joined', 'Answered', false, '2m 5s'],
  ]);
  assert.deepEqual(callBackTargets('social:dm:u-mira:u-sana', 'u-sana'), ['u-mira']);
  assert.equal(callBackTargets('social:room:town-hall', 'u-sana'), null);
  assert.equal(formatDuration(3_725_000), '1h 2m');
});

test('contacts: people here now first, you first among them; presence marks idle', () => {
  const rows = contactRows(
    [{ userId: 'u-lena', displayName: 'Lena Brandt', roles: ['moderator'] }, { userId: 'u-sana', displayName: 'Sana Iqbal', roles: ['participant'] }, { userId: 'u-mira', displayName: 'Mira Okafor', roles: ['community-admin'] }],
    [{ id: 'u-mira', idle: true }, { id: 'u-sana' }],
    'u-sana',
  );
  assert.deepEqual(rows.map((r) => [r.userId, r.online, r.idle]), [['u-sana', true, false], ['u-mira', true, true], ['u-lena', false, false]]);
});

test('call log writer: a room is joined/ended by the reporter alone', () => {
  const e = { callId: 'k1', lobbyName: 'social:room:town-hall', peerUserIds: ['u-mira'] };
  assert.deepEqual(callLogEvents('started', e, { host: 'u-mira', selfId: 'u-sana' }).map((x) => [x.action, x.callerId, x.targetUserIds]), [['joined', 'u-sana', []]]);
  assert.deepEqual(callLogEvents('ended', e, { host: 'u-mira', selfId: 'u-sana' }).map((x) => x.action), ['ended']);
  assert.deepEqual(callLogEvents('missed', e, { host: null, selfId: 'u-sana' }), []);
});

test('call log writer: the caller writes invite+accepted / invite+missed; a callee accepts naming the host', () => {
  const e = { callId: 'k2', lobbyName: 'social:dm:u-mira:u-sana', peerUserIds: ['u-sana'] };
  assert.deepEqual(callLogEvents('started', e, { host: 'u-mira', selfId: 'u-mira', selfName: 'Mira Okafor' }).map((x) => [x.action, x.callerId, x.targetUserIds, x.callerName]), [
    ['invite', 'u-mira', ['u-sana'], 'Mira Okafor'], ['accepted', 'u-mira', ['u-sana'], 'Mira Okafor'],
  ]);
  assert.deepEqual(callLogEvents('missed', { ...e, direction: 'outgoing' }, { host: 'u-mira', selfId: 'u-mira' }).map((x) => x.action), ['invite', 'missed']);
  // The callee's side of a missed ring is the caller's to write.
  assert.deepEqual(callLogEvents('missed', { ...e, peerUserIds: ['u-mira'], direction: 'incoming' }, { host: 'u-mira', selfId: 'u-sana' }), []);
  assert.deepEqual(callLogEvents('started', { ...e, peerUserIds: ['u-mira'] }, { host: 'u-mira', selfId: 'u-sana' }).map((x) => [x.action, x.callerId, x.targetUserIds]), [['accepted', 'u-mira', ['u-sana']]]);
  assert.deepEqual(callLogEvents('ended', { ...e, peerUserIds: ['u-mira'] }, { host: 'u-mira', selfId: 'u-sana' }).map((x) => [x.action, x.callerId]), [['ended', 'u-mira']]);
  // Another tenant's lobby is not the social log's to write.
  assert.deepEqual(callLogEvents('started', { ...e, lobbyName: 'orgiq:dm:u-a:u-b' }, { host: 'u-a', selfId: 'u-a' }), []);
});

test('reportCallLogEvents posts in order with the bearer, and swallows a failure', async () => {
  const seen: Array<{ url: string; auth: string; action: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>)['Authorization']!, action: JSON.parse(String(init.body)).action });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const events = callLogEvents('missed', { callId: 'k3', lobbyName: 'social:dm:u-a:u-b', peerUserIds: ['u-b'], direction: 'outgoing' }, { host: 'u-a', selfId: 'u-a' });
  await reportCallLogEvents(events, { baseUrl: 'http://pa', getToken: async () => 'tok', fetchImpl });
  assert.deepEqual(seen.map((s) => [s.url, s.auth, s.action]), [['http://pa/api/calls/log/events', 'Bearer tok', 'invite'], ['http://pa/api/calls/log/events', 'Bearer tok', 'missed']]);
  await reportCallLogEvents(events, { baseUrl: 'http://pa', getToken: async () => { throw new Error('no token'); }, fetchImpl });
  await reportCallLogEvents(events, { baseUrl: null, getToken: async () => 'tok', fetchImpl });
  assert.equal(seen.length, 2);
});
