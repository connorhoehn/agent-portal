// The social tenant's rooms, teams, recordings, calls and contacts, as data
// (docs/social-tenant-design.md §4.3–§4.5, lane S2): the shapes
// `/api/social/{rooms,teams,recordings,calls}` answer with (platform-api's own
// rows, proxied by the BFF with the caller's token, or dev:mock fixtures), and
// the pure mappings from them to the library composites' props. No React, so
// `__tests__/socialPlatform.test.ts` runs under plain `node --test`.
//
// Names (§4.3): a room's call lobby is `social:room:<slug>`, a team channel's
// conversation `social:team:<team>:<slug>`, a DM `social:dm:<sorted ids>`.

export interface SocialRoom {
  orgId: string;
  roomId: string;
  slug: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  visibility: 'org' | 'private';
  settings: { audioOnly: boolean; recordingEnabled: boolean; softCap: number };
  state: 'active' | 'archived';
  lastActiveAt: string;
  /** `social:room:<slug>` — minted by the BFF. */
  lobbyName: string;
}

export interface SocialTeamChannel { roomId: string; slug: string; name: string; channelPrivacy: 'standard' | 'private'; createdBy: string }

export interface SocialTeam {
  teamId: string;
  slug: string;
  name: string;
  description?: string;
  visibility: 'org' | 'private';
  createdBy: string;
  role: 'owner' | 'member' | null;
  favorite: boolean;
  channels: SocialTeamChannel[];
}

export interface SocialTeamMember { userId: string; displayName: string; role: 'owner' | 'member'; addedAt: string }

export interface SocialRecording {
  callId: string;
  recordingId: string;
  lobbyName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  participantCount?: number;
  participants: Array<{ userId: string; displayName?: string }>;
  startedBy?: string;
  stage: 'saving' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
  expiresAt: string | null;
}

export interface SocialCall {
  callId: string;
  direction: 'incoming' | 'outgoing' | 'joined';
  callerId: string;
  callerName?: string;
  targetUserIds: string[];
  lobbyName: string;
  audioOnly: boolean;
  outcome: 'ringing' | 'answered' | 'missed' | 'declined' | 'cancelled';
  startedAt: string;
  durationMs?: number;
  /** Each named person's portrait, added by the BFF (null → initials). */
  avatars?: Record<string, string | null>;
}

export type SocialSource = 'platform' | 'mock';

// ── Names ───────────────────────────────────────────────────────────────────

const PREFIX = 'social:';
/** Everyone standing in the social workspace announces here (SocialLayout); Contacts reads it. */
export const SOCIAL_PRESENCE_CHANNEL = 'social:lobby';

export const roomLobby = (slug: string): string => `${PREFIX}room:${slug}`;
export function roomSlugFromLobby(lobby: string | null | undefined): string | null {
  const p = `${PREFIX}room:`;
  return lobby && lobby.startsWith(p) && lobby.length > p.length ? lobby.slice(p.length) : null;
}

/**
 * `social:team:<team>:<channel>`. Upstream a channel's slug carries its team
 * (`community-events`); the conversation name keeps the two apart.
 */
export function teamChannelName(team: Pick<SocialTeam, 'slug'>, channel: Pick<SocialTeamChannel, 'slug'>): string {
  const bare = channel.slug.startsWith(`${team.slug}-`) ? channel.slug.slice(team.slug.length + 1) : channel.slug;
  return `${PREFIX}team:${team.slug}:${bare || channel.slug}`;
}
export function parseTeamChannel(name: string | null | undefined): { team: string; channel: string } | null {
  const m = /^social:team:([^:]+):([^:]+)$/.exec(name ?? '');
  return m ? { team: m[1]!, channel: m[2]! } : null;
}

/** `social:dm:<sorted ids>` — the same lobby string the DM's chat uses. */
export function dmLobby(ids: readonly string[]): string {
  return `${PREFIX}dm:${[...new Set(ids)].sort().join(':')}`;
}
export function dmIds(lobby: string | null | undefined): string[] | null {
  const p = `${PREFIX}dm:`;
  return lobby && lobby.startsWith(p) ? lobby.slice(p.length).split(':').filter(Boolean) : null;
}

/** Where Accept on a social ring takes you, or null to stay put. */
export function socialCallHref(channel: string | null | undefined): string | null {
  const room = roomSlugFromLobby(channel);
  if (room) return `/social/rooms?room=${encodeURIComponent(room)}`;
  if (dmIds(channel)) return `/social/dms/${encodeURIComponent(channel!)}`;
  return null;
}

// ── Rooms → WrappedHangoutRoomsList ─────────────────────────────────────────

/**
 * The library's rooms list takes realtime-modules' `useHangoutRooms()` return.
 * Here the rows come from the BFF (tenant-scoped, Cedar-gated create), so this
 * builds the same shape over them. Joining is the call host's job
 * (`social:room:<slug>`), and archiving is not offered on this page.
 */
export interface HangoutRoomsLike {
  rooms: SocialRoom[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createRoom: (input: { name: string; description?: string; visibility?: 'org' | 'private' }) => Promise<SocialRoom>;
  archiveRoom: (slug: string) => Promise<void>;
  joinRoom: (slug: string) => Promise<never>;
}

export function hangoutRoomsFrom(input: {
  rooms: SocialRoom[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  create: (body: { name: string; description?: string; visibility: 'org' | 'private' }) => Promise<SocialRoom>;
}): HangoutRoomsLike {
  return {
    rooms: input.rooms ?? [],
    isLoading: input.isLoading && !input.rooms,
    error: input.error && !input.rooms ? new Error(input.error) : null,
    refetch: async () => { input.refetch(); },
    createRoom: (body) => input.create({ name: body.name, ...(body.description ? { description: body.description } : {}), visibility: body.visibility === 'private' ? 'private' : 'org' }),
    archiveRoom: async () => { throw new Error('Rooms are archived from platform-api, not from this page.'); },
    joinRoom: async () => { throw new Error('Join a room through its call.'); },
  };
}

// ── Teams → TeamChannelTree ─────────────────────────────────────────────────

export interface TeamTreeRow { teamId: string; name: string; expanded?: boolean; pinned?: boolean; channels: Array<{ channel: string; name: string; private?: boolean }> }

/** Teams open on arrival: a person is on a handful, and a folded team hides every channel. */
export function teamTreeItems(teams: readonly SocialTeam[]): TeamTreeRow[] {
  return teams.map((t) => ({
    teamId: t.teamId,
    name: t.name,
    expanded: true,
    ...(t.favorite ? { pinned: true } : {}),
    channels: t.channels.map((c) => ({ channel: teamChannelName(t, c), name: c.name, ...(c.channelPrivacy === 'private' ? { private: true } : {}) })),
  }));
}

/** The team and channel a tree selection names, or null. */
export function findTeamChannel(teams: readonly SocialTeam[], channel: string | null | undefined): { team: SocialTeam; channel: SocialTeamChannel } | null {
  if (!channel) return null;
  for (const t of teams) for (const c of t.channels) if (teamChannelName(t, c) === channel) return { team: t, channel: c };
  return null;
}

/** People who could be added to a team: the workspace roster minus its members. */
export function teamCandidates<P extends { userId: string }>(people: readonly P[], members: readonly { userId: string }[]): P[] {
  const inTeam = new Set(members.map((m) => m.userId));
  return people.filter((p) => !inTeam.has(p.userId));
}

// ── Names for lobbies ───────────────────────────────────────────────────────

export type NameOf = (userId: string) => string;

export function namesFrom(people: ReadonlyArray<{ userId: string; displayName: string }>): NameOf {
  const map = new Map(people.map((p) => [p.userId, p.displayName]));
  return (id) => map.get(id) ?? id;
}

/** "Town hall" for a room lobby (when known), "#general" for a channel huddle, the other people for a DM. */
export function lobbyLabel(lobby: string, me: string, nameOf: NameOf, rooms: readonly Pick<SocialRoom, 'slug' | 'name'>[] = []): string {
  const slug = roomSlugFromLobby(lobby);
  if (slug) return rooms.find((r) => r.slug === slug)?.name ?? slug;
  // A huddle opened from a channel is named for the channel.
  const channel = /^social:ch:([^:]+)$/.exec(lobby);
  if (channel) return `#${channel[1]}`;
  const ids = dmIds(lobby);
  if (ids) {
    const others = ids.filter((id) => id !== me).map(nameOf);
    return others.length ? others.join(', ') : 'Just you';
  }
  return lobby;
}

// ── Recordings → RecordingList ──────────────────────────────────────────────

export interface RecordingItem {
  id: string;
  startIso: string;
  endIso: string;
  durationSec: number;
  participantCount?: number;
  label?: string;
  status?: 'ready' | 'processing' | 'failed';
}

export function recordingStatus(stage: SocialRecording['stage']): 'ready' | 'processing' | 'failed' {
  return stage === 'ready' ? 'ready' : stage === 'failed' ? 'failed' : 'processing';
}

export function recordingItems(recs: readonly SocialRecording[], me: string, nameOf: NameOf, rooms: readonly Pick<SocialRoom, 'slug' | 'name'>[] = []): RecordingItem[] {
  return recs.map((r) => ({
    id: r.recordingId,
    startIso: r.startedAt,
    endIso: r.endedAt,
    durationSec: Math.round(r.durationMs / 1000),
    participantCount: r.participantCount ?? r.participants.length,
    label: lobbyLabel(r.lobbyName, me, nameOf, rooms),
    status: recordingStatus(r.stage),
  }));
}

/** Only whoever started a recording deletes it (platform-api's rule). */
export const mayDeleteRecording = (r: Pick<SocialRecording, 'startedBy'>, me: string): boolean => !!r.startedBy && r.startedBy === me;

// ── Calls → the call log table ──────────────────────────────────────────────

export interface CallRow {
  id: string;
  who: string;
  lobbyName: string;
  direction: string;
  outcome: string;
  missed: boolean;
  startedAt: string;
  duration: string;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 1000) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const DIRECTION: Record<SocialCall['direction'], string> = { incoming: 'Incoming', outgoing: 'Outgoing', joined: 'Joined' };
const OUTCOME: Record<SocialCall['outcome'], string> = { ringing: 'Ringing', answered: 'Answered', missed: 'Missed', declined: 'Declined', cancelled: 'Cancelled' };

export function callRows(calls: readonly SocialCall[], me: string, nameOf: NameOf, rooms: readonly Pick<SocialRoom, 'slug' | 'name'>[] = []): CallRow[] {
  return calls.map((c) => ({
    id: c.callId,
    who: c.direction === 'incoming' ? (c.callerName || nameOf(c.callerId)) : lobbyLabel(c.lobbyName, me, nameOf, rooms),
    lobbyName: c.lobbyName,
    direction: DIRECTION[c.direction] ?? c.direction,
    outcome: OUTCOME[c.outcome] ?? c.outcome,
    missed: c.outcome === 'missed',
    startedAt: c.startedAt,
    duration: formatDuration(c.durationMs),
  }));
}

/** Who to ring back: the DM lobby's others, or null for a room (you walk back in). */
export function callBackTargets(lobby: string, me: string): string[] | null {
  const ids = dmIds(lobby);
  return ids ? ids.filter((id) => id !== me) : null;
}

// ── Contacts ────────────────────────────────────────────────────────────────

export interface ContactRow { userId: string; displayName: string; roles: string[]; online: boolean; idle: boolean; avatarUrl?: string }

/**
 * The roster with presence: people here now first (you first among them),
 * then everyone else, by name.
 */
export function contactRows(
  people: ReadonlyArray<{ userId: string; displayName: string; roles: string[]; avatarUrl?: string | null }>,
  present: ReadonlyArray<{ id: string; idle?: boolean }>,
  me: string,
): ContactRow[] {
  const here = new Map(present.map((p) => [p.id, !!p.idle]));
  return people
    .map((p) => ({ userId: p.userId, displayName: p.displayName, roles: [...p.roles], online: here.has(p.userId), idle: here.get(p.userId) ?? false, ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.userId === me) - Number(a.userId === me) || a.displayName.localeCompare(b.displayName));
}

const ROLE_LABEL: Record<string, string> = { participant: 'Participant', moderator: 'Moderator', 'community-admin': 'Community admin', admin: 'Admin' };
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;
