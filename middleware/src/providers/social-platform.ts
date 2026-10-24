// Rooms, teams, recordings and the call log for the social tenant
// (docs/social-tenant-design.md §4.2, §4.4, §4.5 — lane S2).
//
// They live in platform-api (+ DynamoDB): the BFF owns none of them. What the
// BFF adds is what platform-api cannot know:
//
//   - the tenant: every call names partition `social` (`?tenant=social` /
//     body `tenant`, platform-api 849a890), and rows from other partitions or
//     lobbies (`<tenant>:` prefix) are dropped — a person's recordings and call
//     log are keyed by user upstream, so a user in two tenants would otherwise
//     see both;
//   - the role: writes are Cedar-gated in routes/social.ts (ManageChannels for
//     rooms, ManageTeams, ManageRecordings) — platform-api lets any caller
//     create a room or a team;
//   - the shape: team channels are rooms upstream (they carry `teamId`), so
//     the rooms list leaves them to the Teams page.
//
// Identity is the caller's own: the BFF signs the SAME realtime token
// `GET /api/session/realtime-token` hands the browser (lib/realtime-token.ts),
// so platform-api sees exactly the person it would see from the page, and its
// own rules (a private room's non-member gets 403, a team route 404s outside
// the team) still apply on top.
//
// Backends, in order:
//   - a server-side platform-api URL (SOCIAL_PLATFORM_INTERNAL_URL, else the
//     document stack's DOCUMENT_PLATFORM_INTERNAL_URL, else PLATFORM_API_URL)
//     → proxied;
//   - dev:mock without one → the registered fixtures (mock/social-platform.ts),
//     same row shapes, same visibility rules;
//   - neither → 503.

import { ownsRecord } from '../lib/record-owner.js';
import { config } from '../config.js';
import { AppError, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { realtimeClaims, realtimeSigningSecret, signRealtimeToken } from '../lib/realtime-token.js';
import type { Session } from '../lib/session.js';
import { slugify } from '../lib/social-chat.js';
import { recordingConversation, speechSegments, type TranscriptSegmentView } from '../lib/recording-transcript.js';
import { clock, defineFixture } from '../mock/core/index.js';
import {
  socialCallLogFixture, socialRecordingsFixture, socialRecordingTranscriptsFixture, socialRoomMembersFixture, socialRoomsFixture,
  socialTeamMembersFixture, socialTeamsFixture,
  type SocialCallLogRow, type SocialRecordingRow, type SocialRoomRow, type SocialTeamMemberRow, type SocialTeamRow,
} from '../mock/social-platform.js';
import { invalidateAll, invalidateForUser } from '../lib/gateway/authority-invalidation.js';
import { noteSearchWrite } from '../lib/search-index/writes.js';

export type { SocialCallLogRow, SocialRecordingRow, SocialRoomRow, SocialTeamRow } from '../mock/social-platform.js';

/** The partition every social row lives in. */
export const SOCIAL_PARTITION = 'social';
const LOBBY_PREFIX = `${SOCIAL_PARTITION}:`;
const TIMEOUT_MS = 8_000;

export type SocialPlatformBackend = 'platform' | 'mock' | 'none';

export function socialPlatformUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env['SOCIAL_PLATFORM_INTERNAL_URL'] || env['DOCUMENT_PLATFORM_INTERNAL_URL'] || env['PLATFORM_API_URL'] || '';
  return url ? url.replace(/\/+$/, '') : null;
}

// Under dev:mock the platform-api URL may be configured (Tilt sets it for the
// real-media demo) while nothing answers it. A mock-Aurora run then reads the
// registered fixtures until a health probe sees platform-api answer, instead of
// proxying into a 502. Outside mock mode the URL always wins.
const PROBE_TIMEOUT_MS = 1_500;
const PROBE_UP_TTL_MS = 30_000;
const PROBE_DOWN_TTL_MS = 10_000;
// checkedAt is a monotonic reading (performance.now), not a stamp; -Infinity = never probed.
let probe: { up: boolean; checkedAt: number; inFlight: boolean } = { up: false, checkedAt: -Infinity, inFlight: false };

/** A transport failure to platform-api: serve the fixtures until the next probe says it is back. */
export function markPlatformDown(): void { probe = { up: false, checkedAt: performance.now(), inFlight: probe.inFlight }; }
/** Test seam: forget what the probe learned. */
export function resetPlatformProbe(): void { probe = { up: false, checkedAt: -Infinity, inFlight: false }; }

function probePlatform(base: string): void {
  if (probe.inFlight) return;
  probe.inFlight = true;
  fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .then(() => { probe = { up: true, checkedAt: performance.now(), inFlight: false }; })
    .catch(() => { probe = { up: false, checkedAt: performance.now(), inFlight: false }; });
}

export function socialPlatformBackend(): SocialPlatformBackend {
  const base = socialPlatformUrl();
  // SOCIAL_PLATFORM_BACKEND=platform|mock pins the choice (no probing).
  const pinned = process.env['SOCIAL_PLATFORM_BACKEND'];
  if (pinned === 'mock') return 'mock';
  if (pinned === 'platform' && base) return 'platform';
  if (base && config.mock?.aurora) {
    const age = performance.now() - probe.checkedAt;
    if (age >= (probe.up ? PROBE_UP_TTL_MS : PROBE_DOWN_TTL_MS)) probePlatform(base);
    return probe.up ? 'platform' : 'mock';
  }
  if (base) return 'platform';
  if (config.mock?.aurora) return 'mock';
  return 'none';
}

/** `social:room:<slug>` — a room's call lobby (design §4.3). */
export function roomLobby(slug: string): string { return `${LOBBY_PREFIX}room:${slug}`; }

export const isSocialLobby = (lobbyName: string | undefined | null): boolean => !!lobbyName && lobbyName.startsWith(LOBBY_PREFIX);

// ── Views ───────────────────────────────────────────────────────────────────

export interface SocialRoomView extends SocialRoomRow { lobbyName: string }
export interface SocialTeamChannelView { roomId: string; slug: string; name: string; channelPrivacy: 'standard' | 'private'; createdBy: string }
export interface SocialTeamView extends SocialTeamRow {
  role: 'owner' | 'member' | null;
  favorite: boolean;
  channels: SocialTeamChannelView[];
}
export interface SocialTeamMemberView { userId: string; role: 'owner' | 'member'; addedAt: string }
/** The upstream preference response preserves its membership timestamp shape. */
export interface SocialTeamPreferenceMember {
  teamId: string;
  userId: string;
  role: 'owner' | 'member';
  favorite: boolean;
  addedBy: string;
  addedAt?: string;
  joinedAt?: string;
}
export type SocialTranscript =
  | { status: 'ready'; recordingId: string; lobbyName: string; conversation: string | null; startedAt: string; segments: TranscriptSegmentView[] }
  | { status: string; recordingId: string; lobbyName: string; conversation: string | null; startedAt: string; terminal: boolean; retryAfterMs: number | null; error: string | null };
export interface SocialPlayback { recordingId: string; playlistUrl: string | null; mediaState: string }
export interface SocialShareLink { shareToken: string; shareUrl: string; expiresAt: string }

const roomView = (r: SocialRoomRow): SocialRoomView => ({ ...r, lobbyName: roomLobby(r.slug) });
const channelView = (r: SocialRoomRow): SocialTeamChannelView => ({
  roomId: r.roomId, slug: r.slug, name: r.name, channelPrivacy: r.channelPrivacy ?? 'standard', createdBy: r.createdBy,
});

/** Rooms that are not a team's channel, active, newest activity first. */
export function standaloneRooms(rows: SocialRoomRow[]): SocialRoomRow[] {
  return rows.filter((r) => !r.teamId && r.state === 'active').sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

// ── platform-api ────────────────────────────────────────────────────────────

async function bearer(session: Session): Promise<string> {
  const secret = realtimeSigningSecret();
  if (!secret) throw new AppError(503, 'realtime token signing unavailable, so platform-api cannot be reached');
  return (await signRealtimeToken(realtimeClaims(session), secret)).token;
}

/** platform-api's error shape is `{ error: { message } }` or `{ error: '…' }`. */
function upstreamMessage(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === 'string') return e;
  if (e && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return `platform-api answered HTTP ${status}`;
}

export async function platformRequest<T>(session: Session, method: string, path: string, body?: unknown): Promise<T> {
  const base = socialPlatformUrl();
  if (!base) throw new AppError(503, 'platform-api is not configured');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}tenant=${SOCIAL_PARTITION}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await bearer(session)}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify({ ...(body as object), tenant: SOCIAL_PARTITION }) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    markPlatformDown();
    throw new AppError(502, 'Calls and rooms are unavailable right now. Try again in a moment.');
  }
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  // Its 4xx are the caller's answer (403 on a private room, 404 outside a team); pass them on.
  if (!res.ok) throw new AppError(res.status >= 500 ? 502 : res.status, upstreamMessage(parsed, res.status));
  return parsed as T;
}

// ── mock helpers ────────────────────────────────────────────────────────────

const isRoomMember = (roomId: string, userId: string) => socialRoomMembersFixture.rows().some((m) => m.roomId === roomId && m.userId === userId);
const roomVisibleTo = (r: SocialRoomRow, userId: string) => r.visibility === 'org' || r.createdBy === userId || isRoomMember(r.roomId, userId);
const teamMember = (teamId: string, userId: string): SocialTeamMemberRow | undefined => socialTeamMembersFixture.rows().find((m) => m.teamId === teamId && m.userId === userId);

function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  for (let n = 1; n <= 50; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!taken(slug)) return slug;
  }
  throw new ValidationError('could not allocate a slug');
}

let mockSeq = 0;
const mockId = (kind: string) => `mock-${kind}-${Date.now().toString(36)}-${(mockSeq += 1)}`;

function mockTeamChannels(team: SocialTeamRow, userId: string): SocialTeamChannelView[] {
  return socialRoomsFixture.rows()
    .filter((r) => r.teamId === team.teamId && r.state === 'active')
    .filter((r) => r.channelPrivacy !== 'private' || r.createdBy === userId || isRoomMember(r.roomId, userId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(channelView);
}

// ── Rooms ───────────────────────────────────────────────────────────────────

export async function listRooms(session: Session): Promise<SocialRoomView[]> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const body = await platformRequest<{ rooms?: SocialRoomRow[] } | SocialRoomRow[]>(session, 'GET', '/api/rooms?limit=200');
    const rows = Array.isArray(body) ? body : body?.rooms ?? [];
    return standaloneRooms(rows.filter((r) => r.orgId === SOCIAL_PARTITION)).map(roomView);
  }
  if (backend === 'none') throw new AppError(503, 'rooms need platform-api (none configured)');
  return standaloneRooms(socialRoomsFixture.rows().filter((r) => roomVisibleTo(r, session.sub))).map(roomView);
}

export interface CreateRoomInput { name: string; description?: string; visibility: 'org' | 'private' }

export async function createRoom(session: Session, input: CreateRoomInput): Promise<SocialRoomView> {
  const room = await createRoomRow(session, input);
  await noteSearchWrite({ tenant: 'social', type: 'room', id: room.slug });
  return room;
}

async function createRoomRow(session: Session, input: CreateRoomInput): Promise<SocialRoomView> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const body = await platformRequest<{ room?: SocialRoomRow } | SocialRoomRow>(session, 'POST', '/api/rooms', input);
    const room = (body as { room?: SocialRoomRow }).room ?? (body as SocialRoomRow);
    return roomView(room);
  }
  if (backend === 'none') throw new AppError(503, 'rooms need platform-api (none configured)');
  const rows = socialRoomsFixture.rows();
  const slug = uniqueSlug(slugify(input.name), (s) => rows.some((r) => r.slug === s));
  const now = clock.nowIso();
  const row: SocialRoomRow = {
    orgId: SOCIAL_PARTITION, roomId: mockId('room'), slug, name: input.name,
    ...(input.description ? { description: input.description } : {}),
    createdBy: session.sub, createdAt: now, visibility: input.visibility,
    settings: { audioOnly: false, recordingEnabled: false, softCap: 25 }, state: 'active', lastActiveAt: now,
  };
  rows.push(row);
  if (input.visibility === 'private') socialRoomMembersFixture.rows().push({ roomId: row.roomId, userId: session.sub, role: 'owner', addedAt: now });
  return roomView(row);
}

// ── Team membership for the gateway (design §4.2, lane E) ───────────────────
//
// `social:team:<team slug>:<channel>` chat channels are admitted to the team's
// MEMBERS only (lib/realtime-gateway.ts channelGuard). The guard is
// synchronous and platform-api's membership needs a caller's token, so — like
// lib/social-chat.ts's MirroredMembershipStore — the BFF keeps an in-process
// copy, fed by every team read and write that passes through it: the Teams
// page lists your teams (you are recorded as a member of each), a team's
// detail replaces its roster, and add/remove/create edit it. A team the BFF
// has never seen admits nobody: fail closed, and the Teams page is the only
// door into a team channel, so a member has always passed through listTeams
// first. Under dev:mock the fixtures ARE the store, read live.

const teamRosterMirror = new Map<string, Set<string>>(); // team slug → user ids
const teamSlugById = new Map<string, string>();
// An in-flight read from before a membership write cannot undo its roster.
const teamRosterGeneration = new Map<string, number>();
const rosterGeneration = (teamId: string): number => teamRosterGeneration.get(teamId) ?? 0;
const advanceRosterGeneration = (teamId: string): void => { teamRosterGeneration.set(teamId, rosterGeneration(teamId) + 1); };

function mirrorTeam(teamId: string, slug: string): void { teamSlugById.set(teamId, slug); }
function mirrorAdd(slug: string, userId: string): void {
  const set = teamRosterMirror.get(slug) ?? new Set<string>();
  set.add(userId);
  teamRosterMirror.set(slug, set);
}

/** Is `userId` a member of the team whose slug is `teamSlug`? (sync; the gateway's guard) */
export function isSocialTeamMember(teamSlug: string, userId: string): boolean {
  if (!teamSlug || !userId) return false;
  if (socialPlatformBackend() === 'mock') {
    const team = socialTeamsFixture.rows().find((t) => t.orgId === SOCIAL_PARTITION && t.slug === teamSlug && t.state === 'active');
    return !!team && !!teamMember(team.teamId, userId);
  }
  return teamRosterMirror.get(teamSlug)?.has(userId) ?? false;
}

/** Tests only. */
export function resetSocialTeamMirror(): void { teamRosterMirror.clear(); teamSlugById.clear(); teamRosterGeneration.clear(); invalidateAll('team-mirror-reset'); }

// ── Teams ───────────────────────────────────────────────────────────────────

interface PlatformTeamListItem extends SocialTeamRow { role?: 'owner' | 'member'; favorite?: boolean; channels?: SocialRoomRow[] }
interface PlatformTeamDetail { team: SocialTeamRow; role?: 'owner' | 'member'; channels?: SocialRoomRow[]; members?: SocialTeamMemberRow[] }

/** Mutation preflights must not refresh the gateway roster from an old read. */
async function readPlatformTeam(session: Session, teamId: string): Promise<PlatformTeamDetail> {
  const body = await platformRequest<PlatformTeamDetail>(session, 'GET', `/api/teams/${encodeURIComponent(teamId)}`);
  if (!body?.team || body.team.teamId !== teamId || body.team.orgId !== SOCIAL_PARTITION || body.team.state !== 'active') throw new NotFoundError(`no team ${teamId}`);
  return body;
}

export async function listTeams(session: Session): Promise<SocialTeamView[]> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const generations = new Map(teamRosterGeneration);
    const body = await platformRequest<{ teams?: PlatformTeamListItem[] }>(session, 'GET', '/api/teams');
    return (body?.teams ?? []).filter((t) => t.orgId === SOCIAL_PARTITION).map((t) => {
      const { channels, role, favorite, ...team } = t;
      if (rosterGeneration(team.teamId) === (generations.get(team.teamId) ?? 0)) {
        mirrorTeam(team.teamId, team.slug);
        if (role) mirrorAdd(team.slug, session.sub);
      }
      return { ...team, role: role ?? null, favorite: !!favorite, channels: (channels ?? []).filter((c) => c.state !== 'archived').map(channelView) };
    });
  }
  if (backend === 'none') throw new AppError(503, 'teams need platform-api (none configured)');
  return socialTeamsFixture.rows()
    .filter((t) => t.orgId === SOCIAL_PARTITION && t.state === 'active' && !!teamMember(t.teamId, session.sub))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => {
      const m = teamMember(t.teamId, session.sub)!;
      return { ...t, role: m.role, favorite: !!m.favorite, channels: mockTeamChannels(t, session.sub) };
    });
}

export interface SocialTeamDetail { team: SocialTeamView; members: SocialTeamMemberView[] }

export async function getTeam(session: Session, teamId: string): Promise<SocialTeamDetail> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const generation = rosterGeneration(teamId);
    const body = await readPlatformTeam(session, teamId);
    const members = body.members ?? [];
    if (rosterGeneration(teamId) === generation) {
      mirrorTeam(body.team.teamId, body.team.slug);
      const before = teamRosterMirror.get(body.team.slug);
      const after = new Set(members.map((m) => m.userId));
      teamRosterMirror.set(body.team.slug, after);
      // A fresher roster can drop someone platform-api removed elsewhere: their
      // cached team-channel verdicts go now (lib/gateway/authority-invalidation.ts).
      for (const userId of before ?? []) if (!after.has(userId)) invalidateForUser(userId, 'team-roster');
    }
    const mine = members.find((m) => m.userId === session.sub);
    return {
      team: { ...body.team, role: body.role ?? null, favorite: !!mine?.favorite, channels: (body.channels ?? []).filter((c) => c.state !== 'archived').map(channelView) },
      members: members.map((m) => ({ userId: m.userId, role: m.role, addedAt: m.addedAt })),
    };
  }
  if (backend === 'none') throw new AppError(503, 'teams need platform-api (none configured)');
  const team = socialTeamsFixture.rows().find((t) => t.orgId === SOCIAL_PARTITION && t.teamId === teamId && t.state === 'active');
  const mine = team ? teamMember(team.teamId, session.sub) : undefined;
  // Upstream: a private team 404s for a non-member (no existence leak).
  if (!team || (team.visibility === 'private' && !mine)) throw new NotFoundError(`no team ${teamId}`);
  const members = socialTeamMembersFixture.rows().filter((m) => m.teamId === teamId)
    .map((m) => ({ userId: m.userId, role: m.role, addedAt: m.addedAt }));
  return { team: { ...team, role: mine?.role ?? null, favorite: !!mine?.favorite, channels: mockTeamChannels(team, session.sub) }, members };
}

/** A preference belongs to the caller's membership, never the shared team. */
export async function setTeamFavorite(session: Session, teamId: string, favorite: boolean): Promise<SocialTeamPreferenceMember> {
  if (typeof favorite !== 'boolean') throw new ValidationError('favorite is required (boolean)');
  const backend = socialPlatformBackend();
  const detail = backend === 'platform' ? await readPlatformTeam(session, teamId) : await getTeam(session, teamId);
  const team = detail.team;
  if (!detail.members?.some(member => member.userId === session.sub)) {
    if (team.visibility === 'private') throw new NotFoundError(`no team ${teamId}`);
    throw new AppError(403, 'only a team member can change their preference');
  }
  if (backend === 'platform') {
    const body = await platformRequest<{ member: SocialTeamPreferenceMember }>(session, 'PATCH', `/api/teams/${encodeURIComponent(teamId)}/me`, { favorite });
    if (!body?.member || body.member.teamId !== teamId || body.member.userId !== session.sub || body.member.favorite !== favorite) {
      throw new AppError(502, 'platform-api returned an invalid team preference');
    }
    return body.member;
  }
  if (!socialTeamsFixture.rows().some(row => row.teamId === teamId && row.orgId === SOCIAL_PARTITION && row.state === 'active')) {
    throw new NotFoundError(`no team ${teamId}`);
  }
  const mine = teamMember(teamId, session.sub);
  if (!mine) {
    if (team.visibility === 'private') throw new NotFoundError(`no team ${teamId}`);
    throw new AppError(403, 'only a team member can change their preference');
  }
  mine.favorite = favorite;
  return { ...mine, favorite };
}

export interface CreateTeamInput { name: string; description?: string; visibility: 'org' | 'private'; byName?: string }

export async function createTeam(session: Session, input: CreateTeamInput): Promise<SocialTeamView> {
  const team = await createTeamRow(session, input);
  await noteSearchWrite({ tenant: 'social', type: 'team', id: team.teamId });
  return team;
}

async function createTeamRow(session: Session, input: CreateTeamInput): Promise<SocialTeamView> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const body = await platformRequest<{ team: SocialTeamRow; channels?: SocialRoomRow[] }>(session, 'POST', '/api/teams', input);
    advanceRosterGeneration(body.team.teamId);
    mirrorTeam(body.team.teamId, body.team.slug);
    mirrorAdd(body.team.slug, session.sub);
    return { ...body.team, role: 'owner', favorite: false, channels: (body.channels ?? []).map(channelView) };
  }
  if (backend === 'none') throw new AppError(503, 'teams need platform-api (none configured)');
  const teams = socialTeamsFixture.rows();
  const slug = uniqueSlug(slugify(input.name), (s) => teams.some((t) => t.slug === s));
  const now = clock.nowIso();
  const team: SocialTeamRow = {
    orgId: SOCIAL_PARTITION, teamId: mockId('team'), slug, name: input.name,
    ...(input.description ? { description: input.description } : {}),
    visibility: input.visibility, createdBy: session.sub, createdAt: now, updatedAt: now, state: 'active',
  };
  teams.push(team);
  socialTeamMembersFixture.rows().push({ teamId: team.teamId, userId: session.sub, role: 'owner', favorite: false, addedAt: now, addedBy: session.sub });
  // A team with no channel is not a team: its General, as upstream.
  socialRoomsFixture.rows().push({
    orgId: SOCIAL_PARTITION, roomId: mockId('room'), slug: `${slug}-general`, name: 'General', createdBy: session.sub, createdAt: now,
    visibility: input.visibility, settings: { audioOnly: false, recordingEnabled: false, softCap: 25 }, state: 'active', lastActiveAt: now,
    teamId: team.teamId, channelPrivacy: 'standard',
  });
  return { ...team, role: 'owner', favorite: false, channels: mockTeamChannels(team, session.sub) };
}

export async function addTeamMember(session: Session, teamId: string, userId: string, displayName?: string): Promise<SocialTeamMemberView> {
  const member = await addTeamMemberRow(session, teamId, userId, displayName);
  await noteSearchWrite({ tenant: 'social', type: 'team', id: teamId });
  return member;
}

async function addTeamMemberRow(session: Session, teamId: string, userId: string, displayName?: string): Promise<SocialTeamMemberView> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const body = await platformRequest<{ member: SocialTeamMemberRow }>(session, 'POST', `/api/teams/${encodeURIComponent(teamId)}/members`, {
      userId, ...(displayName ? { displayName } : {}), ...(session.name ? { byName: session.name } : {}),
    });
    advanceRosterGeneration(teamId);
    const slug = teamSlugById.get(teamId);
    if (slug) mirrorAdd(slug, body.member.userId);
    invalidateForUser(body.member.userId, 'team-roster');
    return { userId: body.member.userId, role: body.member.role, addedAt: body.member.addedAt };
  }
  if (backend === 'none') throw new AppError(503, 'teams need platform-api (none configured)');
  await getTeam(session, teamId); // 404 exactly as a read would
  // Upstream: only the team's owner adds people.
  if (teamMember(teamId, session.sub)?.role !== 'owner') throw new AppError(403, `only the team's owner can add people to it`);
  const members = socialTeamMembersFixture.rows();
  const existing = members.find((m) => m.teamId === teamId && m.userId === userId);
  if (existing) return { userId, role: existing.role, addedAt: existing.addedAt };
  const row: SocialTeamMemberRow = { teamId, userId, role: 'member', favorite: false, addedAt: clock.nowIso(), addedBy: session.sub };
  members.push(row);
  invalidateForUser(userId, 'team-roster');
  return { userId, role: row.role, addedAt: row.addedAt };
}

export async function removeTeamMember(session: Session, teamId: string, userId: string): Promise<void> {
  await removeTeamMemberRow(session, teamId, userId);
  await noteSearchWrite({ tenant: 'social', type: 'team', id: teamId });
}

async function removeTeamMemberRow(session: Session, teamId: string, userId: string): Promise<void> {
  const backend = socialPlatformBackend();
  const detail = backend === 'platform' ? await readPlatformTeam(session, teamId) : await getTeam(session, teamId);
  if (detail.team.orgId !== SOCIAL_PARTITION || detail.team.state !== 'active') throw new NotFoundError(`no team ${teamId}`);
  const caller = detail.members?.find(member => member.userId === session.sub);
  if (!caller) throw new NotFoundError(`no team ${teamId}`);
  if (userId !== session.sub && caller.role !== 'owner') throw new AppError(403, `only the team's owner can remove someone else`);
  if (backend === 'platform') {
    await platformRequest<unknown>(session, 'DELETE', `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`);
    advanceRosterGeneration(teamId);
    const slug = teamSlugById.get(teamId) ?? detail.team.slug;
    if (slug) teamRosterMirror.get(slug)?.delete(userId);
    invalidateForUser(userId, 'team-roster');
    return;
  }
  if (backend === 'none') throw new AppError(503, 'teams need platform-api (none configured)');
  const members = socialTeamMembersFixture.rows();
  const i = members.findIndex((m) => m.teamId === teamId && m.userId === userId);
  if (i >= 0) members.splice(i, 1);
  invalidateForUser(userId, 'team-roster');
}

// ── Recordings ──────────────────────────────────────────────────────────────

/** Recordings you were in, in `social:` lobbies only, newest first. */
export async function listRecordings(session: Session): Promise<SocialRecordingRow[]> {
  const backend = socialPlatformBackend();
  let rows: SocialRecordingRow[];
  if (backend === 'platform') {
    const body = await platformRequest<{ items?: SocialRecordingRow[] }>(session, 'GET', '/api/recordings?limit=100');
    rows = body?.items ?? [];
  } else if (backend === 'mock') {
    rows = socialRecordingsFixture.rows().filter((r) => r.participants.some((p) => ownsRecord(p.userId, session.sub)));
  } else throw new AppError(503, 'recordings need platform-api (none configured)');
  return rows.filter((r) => isSocialLobby(r.lobbyName)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function mockOwnRecording(session: Session, recordingId: string): SocialRecordingRow {
  const row = socialRecordingsFixture.rows().find((r) => r.recordingId === recordingId);
  // Upstream `requireOwnRecording`: a recording you were not in does not exist for you.
  if (!row || !isSocialLobby(row.lobbyName) || !row.participants.some((p) => ownsRecord(p.userId, session.sub))) throw new NotFoundError(`no recording ${recordingId}`);
  return row;
}

export async function recordingPlayback(session: Session, recordingId: string): Promise<SocialPlayback> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    const body = await platformRequest<{ playlistUrl?: string | null; mediaState?: string }>(
      session, 'POST', `/api/recordings/${encodeURIComponent(recordingId)}/playback-token`);
    return { recordingId, playlistUrl: body?.playlistUrl ?? null, mediaState: body?.mediaState ?? 'unavailable' };
  }
  if (backend === 'none') throw new AppError(503, 'recordings need platform-api (none configured)');
  mockOwnRecording(session, recordingId);
  // dev:mock has no SFU: nothing to play, said as upstream says it.
  return { recordingId, playlistUrl: null, mediaState: 'unavailable' };
}


/**
 * A recording's transcript, under the authority the list and playback proxies
 * apply: a `social:` lobby only, and a recording you were not on does not
 * exist for you (upstream `requireOwnRecording`, 404). platform-api's
 * `GET /api/recordings/:id` is asked first (it carries the lobby and answers
 * that same 404), then `GET /api/recordings/:id/transcript` (src/routes/
 * recordings.ts:902), which answers 202 + progress until the transcript is ready.
 * Nothing is cached: every call asks again.
 */
export async function recordingTranscript(session: Session, recordingId: string): Promise<SocialTranscript> {
  const backend = socialPlatformBackend();
  if (backend === 'none') throw new AppError(503, 'recordings need platform-api (none configured)');
  const id = encodeURIComponent(recordingId);
  let row: Pick<SocialRecordingRow, 'lobbyName' | 'startedAt'>;
  if (backend === 'platform') {
    const detail = await platformRequest<{ lobbyName?: string; startedAt?: string } | null>(session, 'GET', `/api/recordings/${id}`);
    if (!detail || !isSocialLobby(detail.lobbyName)) throw new NotFoundError(`no recording ${recordingId}`);
    row = { lobbyName: detail.lobbyName!, startedAt: detail.startedAt ?? new Date(0).toISOString() };
  } else {
    row = mockOwnRecording(session, recordingId);
  }
  const head = { recordingId, lobbyName: row.lobbyName, conversation: recordingConversation(row.lobbyName), startedAt: row.startedAt };
  type Doc = { segments?: Array<Parameters<typeof speechSegments>[0][number]>; status?: string; transcriptStatus?: string; terminal?: boolean; retryAfterMs?: number | null; error?: string | null };
  let doc: Doc | null;
  if (backend === 'platform') {
    doc = await platformRequest<Doc | null>(session, 'GET', `/api/recordings/${id}/transcript`);
  } else {
    const t = socialRecordingTranscriptsFixture.rows().find((r) => r.recordingId === recordingId);
    if (!t) throw new NotFoundError('transcription not requested for this recording');
    doc = t.transcriptStatus === 'ready' ? { segments: t.segments }
      : { status: t.transcriptStatus, terminal: t.transcriptStatus === 'failed', retryAfterMs: t.transcriptStatus === 'failed' ? null : 5000, error: null };
  }
  if (doc && Array.isArray(doc.segments)) return { status: 'ready', ...head, segments: speechSegments(doc.segments) };
  return { status: doc?.status ?? 'pending', ...head, terminal: doc?.terminal === true, retryAfterMs: doc?.retryAfterMs ?? null, error: doc?.error ?? null };
}

/** Share links minted under dev:mock (upstream: `video-recording-share-links`). */
export const socialRecordingSharesFixture = defineFixture<SocialShareLink & { recordingId: string; createdBy: string }>({
  key: 'social.recording-shares',
  scenarios: { default: () => [], empty: () => [] },
});

export async function shareRecording(session: Session, recordingId: string): Promise<SocialShareLink> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    return platformRequest<SocialShareLink>(session, 'POST', `/api/recordings/${encodeURIComponent(recordingId)}/share`, {});
  }
  if (backend === 'none') throw new AppError(503, 'recordings need platform-api (none configured)');
  mockOwnRecording(session, recordingId);
  const shareToken = mockId('share');
  const link = { shareToken, shareUrl: `/recordings/share/${shareToken}`, expiresAt: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString() };
  socialRecordingSharesFixture.rows().push({ ...link, recordingId, createdBy: session.sub });
  return link;
}

export async function deleteRecording(session: Session, recordingId: string): Promise<void> {
  await deleteRecordingRow(session, recordingId);
  await noteSearchWrite({ tenant: 'social', type: 'recording', id: recordingId });
}

async function deleteRecordingRow(session: Session, recordingId: string): Promise<void> {
  const backend = socialPlatformBackend();
  if (backend === 'platform') {
    await platformRequest<unknown>(session, 'DELETE', `/api/recordings/${encodeURIComponent(recordingId)}`);
    return;
  }
  if (backend === 'none') throw new AppError(503, 'recordings need platform-api (none configured)');
  const row = mockOwnRecording(session, recordingId);
  // Upstream: only whoever started the recording deletes it.
  if (row.startedBy !== session.sub) throw new AppError(403, 'only the person who started a recording can delete it');
  const rows = socialRecordingsFixture.rows();
  rows.splice(rows.indexOf(row), 1);
}

// ── Call log ────────────────────────────────────────────────────────────────

/**
 * Every call-log row of the caller, any lobby, newest first. platform-api keys
 * the log by user, not tenant; callers keep the lobbies they may show
 * (`listCalls`: Social's; routes/page-calls.ts: a page's or a tenant's).
 */
export async function listCallRows(session: Session): Promise<SocialCallLogRow[]> {
  const backend = socialPlatformBackend();
  let rows: SocialCallLogRow[];
  if (backend === 'platform') {
    const body = await platformRequest<{ calls?: SocialCallLogRow[] }>(session, 'GET', '/api/calls/log?limit=500');
    rows = body?.calls ?? [];
  } else if (backend === 'mock') {
    rows = socialCallLogFixture.rows().filter((r) => ownsRecord(r.userId, session.sub));
  } else throw new AppError(503, 'the call log needs platform-api (none configured)');
  return [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Your calls in `social:` lobbies, newest first. */
export async function listCalls(session: Session): Promise<SocialCallLogRow[]> {
  return (await listCallRows(session)).filter((r) => isSocialLobby(r.lobbyName));
}
