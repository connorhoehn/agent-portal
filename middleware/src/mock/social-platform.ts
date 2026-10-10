// The social tenant's rooms, teams, recordings and call log under dev:mock
// without a platform-api (docs/social-tenant-design.md §4.4–§4.5, lane S2).
//
// Live, all four live in platform-api + DynamoDB (`hangout-rooms`,
// `hangout-room-members`, `teams`, `team-members`, `video-call-recordings`,
// `call-log`) and the BFF only proxies them (providers/social-platform.ts).
// These fixtures stand in when no platform-api is configured, in the SAME row
// shapes platform-api returns — captured from the running `social` compose
// profile on 2026-09-30 (`GET /api/rooms`, `POST /api/rooms`, `GET /api/teams`,
// `GET /api/recordings`, `GET /api/calls/log`) and from its repositories'
// types (HangoutRoom, TeamItem, CallRecording, CallLogRow). Every count a route
// reports is a selector over these rows (mock contract rule 1); every
// timestamp comes from the mock clock (rule 3); a write mutates a registered
// fixture so `POST /api/__mock/reset` undoes it (rule 4).
//
// The seed, for the cast (design §4.1):
//   rooms   town-hall (open, Mira's), design-crit (open, Lena's),
//           moderators-desk (private, Lena's; Mira a member — hidden from Sana)
//   teams   Community (Mira owns; Lena, Sana members; General + Events)
//           Moderation (private, Lena owns; Mira a member; General)
//           — each channel is a room carrying its teamId, as upstream
//   recordings  two calls in `social:room:town-hall` and one DM call
//   call log    Sana's and Mira's rows for the DM call, one missed call

import { clock, defineFixture } from './core/index.js';

export type RoomVisibility = 'org' | 'private';
export type ChannelPrivacy = 'standard' | 'private';

/** platform-api's HangoutRoom (a team's channel carries `teamId` + `channelPrivacy`). */
export interface SocialRoomRow {
  orgId: string;
  roomId: string;
  slug: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  visibility: RoomVisibility;
  settings: { audioOnly: boolean; recordingEnabled: boolean; softCap: number };
  state: 'active' | 'archived';
  lastActiveAt: string;
  teamId?: string;
  channelPrivacy?: ChannelPrivacy;
}

export interface SocialRoomMemberRow { roomId: string; userId: string; role: 'owner' | 'member'; addedAt: string }

/** platform-api's TeamItem. */
export interface SocialTeamRow {
  orgId: string;
  teamId: string;
  slug: string;
  name: string;
  description?: string;
  visibility: 'org' | 'private';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  state: 'active' | 'archived';
}

/** platform-api's TeamMemberItem. */
export interface SocialTeamMemberRow { teamId: string; userId: string; role: 'owner' | 'member'; favorite?: boolean; addedAt: string; addedBy: string }

/** platform-api's CallRecording as its list returns it (the subset a page reads). */
export interface SocialRecordingRow {
  callId: string;
  recordingId: string;
  lobbyName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  participantCount?: number;
  participants: Array<{ userId: string; displayName?: string }>;
  startedBy?: string;
  orgId?: string;
  stage: 'saving' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
  expiresAt: string | null;
}

/** platform-api's CallLogRow — one per person a call touched. */
export interface SocialCallLogRow {
  userId: string;
  callId: string;
  direction: 'incoming' | 'outgoing' | 'joined';
  callerId: string;
  callerName?: string;
  targetUserIds: string[];
  lobbyName: string;
  audioOnly: boolean;
  outcome: 'ringing' | 'answered' | 'missed' | 'declined' | 'cancelled';
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationMs?: number;
  seenAt?: string;
  updatedAt: string;
}

const SETTINGS = { audioOnly: false, recordingEnabled: false, softCap: 25 };

function room(slug: string, name: string, createdBy: string, visibility: RoomVisibility, days: number, extra: Partial<SocialRoomRow> = {}): SocialRoomRow {
  return {
    orgId: 'social', roomId: `mock-room-${slug}`, slug, name, createdBy,
    createdAt: clock.daysAgo(days), visibility, settings: { ...SETTINGS }, state: 'active',
    lastActiveAt: clock.hoursAgo(days * 3), ...extra,
  };
}

export const socialRoomsFixture = defineFixture<SocialRoomRow>({
  key: 'social.rooms',
  scenarios: {
    default: () => [
      room('town-hall', 'Town hall', 'u-mira', 'org', 12, { description: 'The weekly all-hands. Drop in any time.' }),
      room('design-crit', 'Design crit', 'u-lena', 'org', 8, { description: 'Bring a screen to share.' }),
      room('moderators-desk', 'Moderators desk', 'u-lena', 'private', 5, { description: 'Escalations, face to face.' }),
      // Team channels are rooms carrying their team (platform-api teams.ts).
      room('community-general', 'General', 'u-mira', 'org', 20, { teamId: 'mock-team-community', channelPrivacy: 'standard' }),
      room('community-events', 'Events', 'u-mira', 'org', 15, { teamId: 'mock-team-community', channelPrivacy: 'standard' }),
      room('moderation-general', 'General', 'u-lena', 'private', 10, { teamId: 'mock-team-moderation', channelPrivacy: 'standard' }),
    ],
    empty: () => [],
  },
});

export const socialRoomMembersFixture = defineFixture<SocialRoomMemberRow>({
  key: 'social.room-members',
  scenarios: {
    default: () => [
      { roomId: 'mock-room-moderators-desk', userId: 'u-lena', role: 'owner', addedAt: clock.daysAgo(5) },
      { roomId: 'mock-room-moderators-desk', userId: 'u-mira', role: 'member', addedAt: clock.daysAgo(5) },
    ],
    empty: () => [],
  },
});

export const socialTeamsFixture = defineFixture<SocialTeamRow>({
  key: 'social.teams',
  scenarios: {
    default: () => [
      { orgId: 'social', teamId: 'mock-team-community', slug: 'community', name: 'Community', description: 'Everyone who runs events and answers questions.', visibility: 'org', createdBy: 'u-mira', createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(2), state: 'active' },
      { orgId: 'social', teamId: 'mock-team-moderation', slug: 'moderation', name: 'Moderation', visibility: 'private', createdBy: 'u-lena', createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(1), state: 'active' },
    ],
    empty: () => [],
  },
});

export const socialTeamMembersFixture = defineFixture<SocialTeamMemberRow>({
  key: 'social.team-members',
  scenarios: {
    default: () => [
      { teamId: 'mock-team-community', userId: 'u-mira', role: 'owner', favorite: false, addedAt: clock.daysAgo(20), addedBy: 'u-mira' },
      { teamId: 'mock-team-community', userId: 'u-lena', role: 'member', favorite: false, addedAt: clock.daysAgo(19), addedBy: 'u-mira' },
      { teamId: 'mock-team-community', userId: 'u-sana', role: 'member', favorite: false, addedAt: clock.daysAgo(12), addedBy: 'u-mira' },
      { teamId: 'mock-team-moderation', userId: 'u-lena', role: 'owner', favorite: false, addedAt: clock.daysAgo(10), addedBy: 'u-lena' },
      { teamId: 'mock-team-moderation', userId: 'u-mira', role: 'member', favorite: false, addedAt: clock.daysAgo(10), addedBy: 'u-lena' },
    ],
    empty: () => [],
  },
});

function recording(id: string, lobbyName: string, hoursAgo: number, minutes: number, people: string[], startedBy: string): SocialRecordingRow {
  const startedAt = clock.hoursAgo(hoursAgo);
  return {
    callId: `mock-call-${id}`, recordingId: `mock-rec-${id}`, lobbyName, startedAt,
    endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
    durationMs: minutes * 60_000, participantCount: people.length,
    participants: people.map((userId) => ({ userId })), startedBy, orgId: 'social',
    stage: 'ready', expiresAt: new Date(clock.now().getTime() + 30 * 86_400_000).toISOString(),
  };
}

export const socialRecordingsFixture = defineFixture<SocialRecordingRow>({
  key: 'social.recordings',
  scenarios: {
    default: () => [
      recording('town-hall-1', 'social:room:town-hall', 26, 41, ['u-mira', 'u-lena', 'u-sana'], 'u-mira'),
      recording('town-hall-2', 'social:room:town-hall', 170, 37, ['u-mira', 'u-sana'], 'u-mira'),
      recording('dm-lena-sana', 'social:dm:u-lena:u-sana', 5, 9, ['u-lena', 'u-sana'], 'u-lena'),
    ],
    empty: () => [],
  },
});

/** platform-api's transcript document: speech segments (and injected `reaction` segments). */
export interface SocialTranscriptSegment { startMs: number; endMs: number; speakerId: string; speakerLabel: string; text: string; kind?: 'reaction' }
export interface SocialRecordingTranscriptRow { recordingId: string; transcriptStatus: 'ready' | 'pending' | 'failed'; segments: SocialTranscriptSegment[] }

const seg = (startMs: number, speakerId: string, speakerLabel: string, text: string, kind?: 'reaction'): SocialTranscriptSegment =>
  ({ startMs, endMs: startMs + 8_000, speakerId, speakerLabel, text, ...(kind ? { kind } : {}) });

/** One transcript per seeded recording (`transcript.json`, served by `GET /api/recordings/:id/transcript`). */
export const socialRecordingTranscriptsFixture = defineFixture<SocialRecordingTranscriptRow>({
  key: 'social.recording-transcripts',
  scenarios: {
    default: () => [
      { recordingId: 'mock-rec-town-hall-1', transcriptStatus: 'ready', segments: [
        seg(0, 'u-mira', 'Mira Okafor', 'Welcome to the town hall. We will cover the spring community calendar first.'),
        seg(9_000, 'u-lena', 'Lena Brandt', 'Moderation volume doubled after the launch, so we need two more volunteers.'),
        seg(18_000, 'u-sana', 'Sana Iyer', 'I can take the Tuesday shift and write the onboarding guide.'),
        seg(20_000, 'u-lena', 'Lena Brandt', 'reacted with a thumbs up', 'reaction'),
        seg(27_000, 'u-mira', 'Mira Okafor', 'Decision: the event calendar goes live on Friday with Sana as the owner.'),
      ] },
      { recordingId: 'mock-rec-town-hall-2', transcriptStatus: 'ready', segments: [
        seg(0, 'u-mira', 'Mira Okafor', 'Last week we agreed to trial a weekly office hour for new members.'),
        seg(9_000, 'u-sana', 'Sana Iyer', 'Attendance was thirty people and most questions were about channel etiquette.'),
      ] },
      { recordingId: 'mock-rec-dm-lena-sana', transcriptStatus: 'ready', segments: [
        seg(0, 'u-lena', 'Lena Brandt', 'Can you review the moderation checklist before the call with Mira?'),
        seg(8_000, 'u-sana', 'Sana Iyer', 'Yes, I will send my edits tonight and flag anything unclear.'),
        seg(16_000, 'u-lena', 'Lena Brandt', 'Great, the escalation section is the part I am least sure about.'),
        seg(24_000, 'u-sana', 'Sana Iyer', 'Agreed, I will rewrite the escalation steps and share them tomorrow morning.'),
      ] },
    ],
    empty: () => [],
  },
});

function logRow(userId: string, direction: SocialCallLogRow['direction'], outcome: SocialCallLogRow['outcome'], call: { id: string; callerId: string; callerName: string; targets: string[]; lobbyName: string; hoursAgo: number; minutes?: number }): SocialCallLogRow {
  const startedAt = clock.hoursAgo(call.hoursAgo);
  const answered = outcome === 'answered';
  const endedAt = new Date(Date.parse(startedAt) + (call.minutes ?? 1) * 60_000).toISOString();
  return {
    userId, callId: call.id, direction, callerId: call.callerId, callerName: call.callerName,
    targetUserIds: call.targets, lobbyName: call.lobbyName, audioOnly: false, outcome, startedAt,
    ...(answered ? { answeredAt: startedAt, durationMs: (call.minutes ?? 1) * 60_000 } : {}),
    endedAt, updatedAt: endedAt,
  };
}

const DM_CALL = { id: 'mock-call-dm-lena-sana', callerId: 'u-lena', callerName: 'Lena Brandt', targets: ['u-sana'], lobbyName: 'social:dm:u-lena:u-sana', hoursAgo: 5, minutes: 9 };
const MISSED = { id: 'mock-call-missed-mira-sana', callerId: 'u-mira', callerName: 'Mira Okafor', targets: ['u-sana'], lobbyName: 'social:dm:u-mira:u-sana', hoursAgo: 2 };
const TOWN_HALL = { id: 'mock-call-town-hall-1', callerId: 'u-mira', callerName: 'Mira Okafor', targets: [], lobbyName: 'social:room:town-hall', hoursAgo: 26, minutes: 41 };

/** A page huddle (`orgiq:initiative:<id>`, `assessment:team:<id>`): everyone who walked in reports a `joined` row naming the others. */
function pageHuddle(lobbyName: string, people: Array<[string, string]>, hoursAgo: number, minutes: number, id: string): SocialCallLogRow[] {
  return people.map(([userId, name]) => ({
    ...logRow(userId, 'joined', 'answered', { id, callerId: userId, callerName: name, targets: people.map(([u]) => u).filter((u) => u !== userId), lobbyName, hoursAgo, minutes }),
  }));
}
const INITIATIVE_HUDDLE = pageHuddle('orgiq:initiative:p-auth-migration', [['u-mia', 'Mia Singh'], ['u-nora', 'Nora DaSilva']], 7, 14, 'mock-call-initiative-1');
const TEAM_HUDDLE = pageHuddle('assessment:team:TEAM-001', [['u-asha', 'Asha Nair'], ['u-jonas', 'Jonas Lindqvist']], 4, 22, 'mock-call-team-1');

/** A huddle still going on: answered, no end yet — what the Communication plane's Active now reads as "in a huddle"
 * (lib/work-graph/plane-active.ts) and the Calls panes list as live. Mira and Lena in #general's lobby, since the
 * seed's quarter hour. Only #general's members see it there. */
function liveHuddle(lobbyName: string, people: Array<[string, string]>, minutesAgo: number, id: string): SocialCallLogRow[] {
  const startedAt = clock.hoursAgo(minutesAgo / 60);
  const [callerId, callerName] = people[0]!;
  return people.map(([userId]) => ({
    userId, callId: id, direction: 'joined', callerId, callerName,
    targetUserIds: people.map(([u]) => u).filter((u) => u !== userId), lobbyName, audioOnly: false, outcome: 'answered',
    startedAt, answeredAt: startedAt, updatedAt: startedAt,
  }));
}
const LIVE_HUDDLE = liveHuddle('social:ch:general', [['u-mira', 'Mira Okafor'], ['u-lena', 'Lena Brandt']], 14, 'mock-call-live-general');

export const socialCallLogFixture = defineFixture<SocialCallLogRow>({
  key: 'social.call-log',
  scenarios: {
    default: () => [
      logRow('u-lena', 'outgoing', 'answered', DM_CALL),
      logRow('u-sana', 'incoming', 'answered', DM_CALL),
      logRow('u-mira', 'outgoing', 'missed', MISSED),
      logRow('u-sana', 'incoming', 'missed', MISSED),
      logRow('u-mira', 'joined', 'answered', TOWN_HALL),
      logRow('u-sana', 'joined', 'answered', { ...TOWN_HALL, callerId: 'u-sana', callerName: 'Sana Iqbal' }),
      ...INITIATIVE_HUDDLE,
      ...TEAM_HUDDLE,
      ...LIVE_HUDDLE,
    ],
    empty: () => [],
  },
});
