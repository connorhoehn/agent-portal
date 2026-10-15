// /api/social — the social tenant's API (docs/social-tenant-design.md §4).
//
// Mounted in index.ts as `app.use('/api/social', requireTenant('social'), …)`:
// the tenant has no machine callback of its own, so the data boundary sits at
// the mount (a session parked in orgiq or assessment is refused with 403
// before any handler runs; the cross-tenant admin passes). Reads are gated on
// `ViewSocial`, which every social role holds.
//
// Phase S0 served `GET /summary`; phase S1 (design §4.3–§4.5) adds channels
// and DMs — the directory (providers/social-channels.ts), membership and the
// conversations index (lib/social-chat.ts, the library's DynamoChatStore or
// the fixture-backed memory store) — and the tenant roster the New DM picker
// reads. Rooms/teams/recordings arrive in S2, bindings in E (socialEmbedRouter).
//
//   GET  /channels                 public channels + private ones you are in
//   POST /channels                 create (ManageChannels); you become its owner
//   GET  /channels/:slug           the channel, its members, recent messages
//   POST /channels/:slug/join      join a public channel
//   POST /channels/:slug/leave     leave
//   GET  /dms                      your DMs, newest first
//   POST /dms {userId}             open a DM → its lobby `social:dm:<sorted ids>`
//                                  (socialEmbedRouter, below: grant-gated, lane E)
//   POST /dms/read {channel}       you have read the DM up to now (its unread count → 0)
//   GET  /people                   everyone holding a social grant
//
// Phase S2 (design §4.4–§4.5): rooms, teams, recordings and the call log live
// in platform-api; these are thin tenant-scoped proxies to it with the
// caller's own realtime token, or the registered fixtures under dev:mock
// (providers/social-platform.ts). The writes are here, not in the browser,
// because the Cedar gate is the BFF's — platform-api lets anyone create.
//
//   GET    /rooms                           rooms in partition social (team channels left out)
//   POST   /rooms                           create (ManageChannels) — public or private
//   GET    /teams                           your teams, each with its channels
//   POST   /teams                           create (ManageTeams) — with its General channel
//   GET    /teams/:teamId                   one team: channels + members
//   PATCH  /teams/:teamId/me {favorite}     your own preference (ViewSocial; a member)
//   POST   /teams/:teamId/members {userId}  add someone (ManageTeams; the team's owner)
//   DELETE /teams/:teamId/members/:userId   leave (ViewSocial), or remove someone (ManageTeams; the owner)
//   GET    /recordings                      recordings you were in, social: lobbies only
//   GET    /recordings/:recordingId/playback  what there is to play
//   GET    /recordings/:recordingId/transcript  speech segments (ViewSocial; same authority as playback)
//   POST   /recordings/:recordingId/share   mint a share link (ManageRecordings)
//   DELETE /recordings/:recordingId         delete (ManageRecordings; whoever started it)
//   GET    /calls                           your call log, social: lobbies only
//
// Messages are never written here: they go over the gateway (`/ws`, `useChat`),
// which admits a `social:ch:<slug>` subscribe/publish to its members only.

import { Router, type Request, type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { currentSocialMembershipProof, socialActionRole, type SocialMembershipProof } from '../lib/live-principal.js';
import { currentSocialActionSession, socialGate } from '../lib/social-authority.js';
import { requiredName, NAME_MAX } from '../lib/social-names.js';
import { channelForSlug, dmChannelFor, dmMembers, isValidSlug, slugForChannel, slugify, socialChat, SOCIAL_DM_PREFIX } from '../lib/social-chat.js';
import { recordUserId } from '../lib/record-owner.js';
import { clock } from '../mock/core/index.js';
import { unreadFor } from '../mock/social-channels.js';
import { createChannel, DuplicateChannelError, getChannel, listChannels, type SocialChannelPrivacy, type SocialChannelRow } from '../providers/social-channels.js';
import { listUsers } from '../providers/identity.js';
import { userAvatars } from '../providers/user-avatars.js';
import { withCallAvatars } from '../lib/call-log-avatars.js';
import { deleteBinding, getBinding, putBinding, type BindingContext, type SocialBindingRow } from '../providers/social-bindings.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { SOCIAL_CONVERSATION_ID } from '../lib/tenant-channels.js';
import { sharedWorkInConversation } from '../lib/work-graph/shared-work.js';
import { socialSurfaceCounts, socialSurfaces } from '../mock/social.js';
import { socialWorkGraphRouter } from './social-work-graph.js';
import { emitSocialWorkGraphEvent } from '../lib/work-graph/social-events.js';
import {
  addTeamMember, createRoom, createTeam, deleteRecording, getTeam, listCalls, listRecordings, listRooms, listTeams,
  recordingPlayback, recordingTranscript, removeTeamMember, setTeamFavorite, shareRecording, socialPlatformBackend,
} from '../providers/social-platform.js';
import type { Session } from '../lib/session.js';

export const socialRouter = Router();

// The tenant's activity/work graph (docs/activity-graph-migration.md §10): its own gates, decided per request.
socialRouter.use('/work-graph', socialWorkGraphRouter);

/**
 * The cross-tenant half of /api/social (design E5, §4.6 — lane E), mounted in
 * index.ts BEFORE the `requireTenant('social')` mount, so a session standing
 * in orgiq (or assessment) reaches it. Its gate is the caller's GRANTS, never
 * the session's current tenant — the same key the gateway's partition rule
 * reads from the realtime token's `tenants`:
 *
 *   GET    /bindings?context=<kind>:<id>  which social channel is this context's
 *                                         discussion (a grant in social AND in
 *                                         the context's tenant)
 *   PUT    /bindings?context=… {channel}   bind (ManageChannels in social AND a
 *                                         grant in the context's tenant)
 *   DELETE /bindings?context=…            unbind (the same)
 *   POST   /dms {userId}                  open a DM → its lobby
 *                                         `social:dm:<sorted ids>` (PostMessage
 *                                         in social) — Search's people → Message
 *
 * Only these; everything else under /api/social stays behind the tenant gate.
 */
export const socialEmbedRouter = Router();

/**
 * The Social application plane for a session standing in another tenant
 * (docs/social-tenant-design.md §4.6 "Communication") is routes/social-plane.ts:
 * it mounts the SAME handlers registered below (`socialHandler`) behind the
 * SAME gate — `socialGate` (lib/social-authority.ts): the actor's CURRENT
 * directory grants, epoch and masquerade actor, the action asked against every
 * granted Social role. The only difference between the two mounts is the
 * tenant boundary in front of this one (`requireTenant('social')` in
 * index.ts). The handlers read only the session's `sub` (platform-api
 * receives the caller's own realtime token), so the source tenant stays pinned.
 */
const SOCIAL_HANDLERS = new Map<string, RequestHandler>();
function socialHandler(key: string, handler: RequestHandler): RequestHandler {
  SOCIAL_HANDLERS.set(key, handler);
  return handler;
}
/** One of the tenant router's handlers, by `<method> <path>`, for the plane to mount as-is. */
export function sharedSocialHandler(key: string): RequestHandler {
  const handler = SOCIAL_HANDLERS.get(key);
  if (!handler) throw new Error(`no Social handler ${key}`);
  return handler;
}
/** Leaving a team yourself is ViewSocial; removing someone else is ManageTeams. */
export const teamMemberAction = (req: Request): string => (req.session?.sub === req.params['userId'] ? 'ViewSocial' : 'ManageTeams');

socialRouter.get('/summary', socialGate('ViewSocial'), asyncHandler(async (_req, res) => {
  const body: TenantSummary = {
    tenant: 'social',
    members: await tenantMembers('social', ROLES_BY_TENANT.social),
    surfaces: socialSurfaceCounts(socialSurfaces.rows()),
  };
  res.json(body);
}));

// ── Channels and DMs (phase S1) ─────────────────────────────────────────────

export interface SocialChannelView {
  slug: string;
  channel: string;
  name: string;
  description: string | null;
  privacy: SocialChannelPrivacy;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  joined: boolean;
  role: 'owner' | 'member' | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

const DESCRIPTION_MAX = 280;
const RECENT_LIMIT = 30;
/** How many recent DM messages the unread count looks at. */
const UNREAD_WINDOW = 50;

/** The user whose Social records these are: a clone reads its persona's channels and DMs (lib/record-owner.ts). */
const me = (req: Request): string => recordUserId(req.session?.sub ?? '');

/** Everyone holding a social grant, by id. */
export async function socialRoster(options: { authoritative?: boolean } = {}): Promise<Map<string, { userId: string; displayName: string; roles: string[] }>> {
  const out = new Map<string, { userId: string; displayName: string; roles: string[] }>();
  for (const u of await listUsers(options)) {
    const roles = u.grants['social'] ?? [];
    if (roles.length) out.set(u.id, { userId: u.id, displayName: u.displayName, roles: [...roles] });
  }
  return out;
}

async function displayNames(): Promise<Map<string, string>> {
  return new Map((await listUsers()).map((u) => [u.id, u.displayName]));
}

function preview(text: string | undefined | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? flat.slice(0, 140) : flat;
}

async function channelView(row: SocialChannelRow, userId: string): Promise<SocialChannelView> {
  const chat = socialChat();
  const channel = channelForSlug(row.slug);
  await chat.membershipStore.hydrate(channel);
  const members = chat.membershipStore.activeMembers(channel);
  const mine = members.find((m) => m.userId === userId) ?? null;
  const last = await chat.lastMessage(channel);
  return {
    slug: row.slug,
    channel,
    name: row.name,
    description: row.description,
    privacy: row.privacy,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    memberCount: members.length,
    joined: !!mine,
    role: mine ? mine.role : null,
    lastMessageAt: last?.timestamp ?? null,
    lastMessagePreview: last ? (last.deletedAt ? 'Message deleted' : preview(last.message)) : null,
  };
}

/** The channel, or 404 — a private channel does not exist for a non-member. */
async function visibleChannel(slug: string, userId: string): Promise<SocialChannelRow> {
  const row = isValidSlug(slug) ? await getChannel(slug) : null;
  if (!row) throw new NotFoundError(`no channel #${slug}`);
  await socialChat().membershipStore.hydrate(channelForSlug(slug));
  if (row.privacy === 'private' && !socialChat().membershipStore.isActiveMember(channelForSlug(slug), userId)) {
    throw new NotFoundError(`no channel #${slug}`);
  }
  return row;
}

socialRouter.get('/channels', socialGate('ViewSocial'), socialHandler('get /channels', asyncHandler(async (req, res) => {
  const userId = me(req);
  const chat = socialChat();
  await chat.ready;
  const directory = await listChannels();
  await Promise.all(directory.map(row => chat.membershipStore.hydrate(channelForSlug(row.slug))));
  const rows = directory.filter((r) => r.privacy === 'public' || chat.membershipStore.isActiveMember(channelForSlug(r.slug), userId));
  const channels = await Promise.all(rows.map((r) => channelView(r, userId)));
  channels.sort((a, b) => Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name));
  res.json({ channels });
})));

socialRouter.post('/channels', socialGate('ManageChannels'), socialHandler('post /channels', asyncHandler(async (req, res) => {
  const userId = me(req);
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; privacy?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().replace(/^#/, '') : '';
  if (!name || name.length > NAME_MAX) throw new ValidationError(`a channel needs a name of 1–${NAME_MAX} characters`);
  const slug = slugify(name);
  if (!isValidSlug(slug)) throw new ValidationError('a channel name needs at least one letter or digit');
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, DESCRIPTION_MAX) : null;
  const privacy: SocialChannelPrivacy = body.privacy === 'private' ? 'private' : 'public';
  let row: SocialChannelRow;
  try {
    row = await createChannel({ slug, name, description, privacy, createdBy: userId });
  } catch (err) {
    if (err instanceof DuplicateChannelError) { res.status(409).json({ error: err.message, slug }); return; }
    throw err;
  }
  const chat = socialChat();
  const channel = channelForSlug(slug);
  // The owner row closes the channel: from here on the gateway (and the
  // library's own membership gate) admit members only.
  await chat.membershipStore.putMember({ channel, userId, role: 'owner', addedBy: userId, addedAt: clock.nowIso(), historyFrom: null, removedAt: null });
  await chat.conversations.recordJoin(channel, userId).catch(() => undefined);
  res.status(201).json({ channel: await channelView(row, userId) });
})));

socialRouter.get('/channels/:slug', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const userId = me(req);
  const chat = socialChat();
  await chat.ready;
  const row = await visibleChannel(String(req.params['slug']), userId);
  const channel = channelForSlug(row.slug);
  const names = await displayNames();
  const members = chat.membershipStore.activeMembers(channel)
    .map((m) => ({ userId: m.userId, displayName: names.get(m.userId) ?? m.userId, role: m.role, addedAt: m.addedAt }))
    .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.displayName.localeCompare(b.displayName));
  const recent = (await chat.chatStore.listMessages(channel, RECENT_LIMIT))
    .filter((m) => !m.deletedAt)
    .map((m) => ({
      id: m.id,
      userId: m.userId ?? null,
      displayName: typeof m.metadata?.['displayName'] === 'string' ? m.metadata['displayName'] : names.get(m.userId ?? '') ?? m.userId ?? 'Unknown',
      message: m.message,
      timestamp: m.timestamp,
    }));
  res.json({ channel: await channelView(row, userId), members, recent });
}));

socialRouter.post('/channels/:slug/join', socialGate('PostMessage'), socialHandler('post /channels/:slug/join', asyncHandler(async (req, res) => {
  const userId = me(req);
  const chat = socialChat();
  await chat.ready;
  const slug = String(req.params['slug']);
  const row = isValidSlug(slug) ? await getChannel(slug) : null;
  if (!row) throw new NotFoundError(`no channel #${slug}`);
  const channel = channelForSlug(slug);
  const existing = await chat.membershipStore.getMember(channel, userId);
  if (!existing?.removedAt && existing) { res.json({ channel: await channelView(row, userId) }); return; }
  // A private channel does not exist for a non-member (the same 404 the read gives).
  if (row.privacy === 'private') throw new NotFoundError(`no channel #${slug}`);
  await chat.membershipStore.putMember({
    channel, userId, role: existing?.role ?? 'member', addedBy: userId,
    addedAt: existing?.addedAt ?? clock.nowIso(), historyFrom: existing?.historyFrom ?? null, removedAt: null,
  });
  await chat.conversations.recordJoin(channel, userId).catch(() => undefined);
  res.json({ channel: await channelView(row, userId) });
})));

socialRouter.post('/channels/:slug/leave', socialGate('ViewSocial'), socialHandler('post /channels/:slug/leave', asyncHandler(async (req, res) => {
  const userId = me(req);
  const chat = socialChat();
  await chat.ready;
  const row = await visibleChannel(String(req.params['slug']), userId);
  const channel = channelForSlug(row.slug);
  const existing = await chat.membershipStore.getMember(channel, userId);
  if (existing && !existing.removedAt) {
    await chat.membershipStore.putMember({ ...existing, removedAt: clock.nowIso() });
  }
  res.json({ channel: await channelView(row, userId) });
})));

export async function socialDirectMessages(userId: string, names: Map<string, string>, limit = Infinity,
  fences?: Set<SocialMembershipProof>, bounds?: { hasMore: boolean }) {
  const chat = socialChat();
  const indexed = (await chat.conversations.listForUser(userId))
    .filter((r) => r.channel.startsWith(SOCIAL_DM_PREFIX) && (dmMembers(r.channel) ?? []).includes(userId))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.channel.localeCompare(b.channel));
  if (bounds) bounds.hasMore = indexed.length > limit;
  const rows = indexed.slice(0, limit);
  const results = await Promise.allSettled(rows.map(async (r) => {
    const proof = await currentSocialMembershipProof(r.channel, userId);
    let retained = false;
    try {
      if (!proof.allows()) return null;
      const [recent, cursors] = await Promise.all([chat.recentMessages(r.channel, UNREAD_WINDOW), chat.readReceiptStore.listReceipts(r.channel)]);
      if (!proof.allows()) return null;
      if (fences) { fences.add(proof); retained = true; }
      const readAt = cursors.find((c) => c.userId === userId)?.readAt ?? null;
      return {
        channel: r.channel,
        peers: (dmMembers(r.channel) ?? []).filter((u) => u !== userId).map((u) => ({ userId: u, displayName: names.get(u) ?? u })),
        lastMessageAt: r.lastMessageAt,
        lastMessagePreview: r.lastMessagePreview,
        lastMessageUserId: r.lastMessageUserId,
        // Counted from the messages and your cursor (capped at the window read).
        unreadCount: unreadFor(recent, r.channel, userId, readAt),
      };
    } finally { if (!retained) proof.dispose(); }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}
socialRouter.get('/dms', socialGate('ViewSocial'), socialHandler('get /dms', asyncHandler(async (req, res) => {
  const directory = await listUsers();
  const names = new Map(directory.map((u) => [u.id, u.displayName]));
  const conversations = await socialDirectMessages(me(req), names);
  res.json({ conversations: withPeerAvatars(conversations, await userAvatars(directory)) });
})));

/** DM rows with each peer's avatar (null → initials); the rows are otherwise unchanged. */
function withPeerAvatars<Row extends { peers: Array<{ userId: string; displayName: string }> }>(
  rows: Row[], avatars: Map<string, string | null>,
): Array<Row & { peers: Array<{ userId: string; displayName: string; avatarUrl: string | null }> }> {
  return rows.map((row) => ({ ...row, peers: row.peers.map((peer) => ({ ...peer, avatarUrl: avatars.get(peer.userId) ?? null })) }));
}

socialEmbedRouter.post('/dms/read', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const userId = recordUserId(session.sub);
  const channel = typeof (req.body as { channel?: unknown } | undefined)?.channel === 'string' ? String((req.body as { channel: string }).channel) : '';
  const ids = dmMembers(channel);
  if (!ids || new Set(ids).size < 2 || dmChannelFor(ids) !== channel) throw new ValidationError('name a sorted, distinct DM (channel: social:dm:<ids>)');
  // A DM that does not name you does not exist for you.
  if (!ids.includes(userId)) throw new NotFoundError('no such conversation');
  const membership = await currentSocialMembershipProof(channel, userId);
  try {
    if (!membership.allows()) throw new NotFoundError('no such conversation');
    await currentSocialActionSession(session, 'ViewSocial');
    if (!membership.allows()) throw new NotFoundError('no such conversation');
    const now = clock.nowIso();
    await socialChat().readReceiptStore.advance({ channel, userId, readAt: now, updatedAt: now });
    res.json({ channel, readAt: now });
  } finally { membership.dispose(); }
}));

socialRouter.get('/people', socialGate('ViewSocial'), socialHandler('get /people', asyncHandler(async (_req, res) => {
  const directory = await listUsers();
  const avatars = await userAvatars(directory);
  // The cross-tenant platform operator (`admin`, a service account) holds a Social grant so it can administer the
  // tenant, but it is not a member of the community: a contact list is the people one can talk to.
  const people = [...(await socialRoster()).values()].filter((p) => !(p.roles.length === 1 && p.roles[0] === 'admin'))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((person) => ({ ...person, avatarUrl: avatars.get(person.userId) ?? null }));
  res.json({ people });
})));

// ── Rooms, teams, recordings, calls (phase S2) ──────────────────────────────

const sessionOf = (req: Request): Session => req.session as Session;
const source = () => socialPlatformBackend();

function optionalDescription(raw: unknown): { description?: string } {
  return typeof raw === 'string' && raw.trim() ? { description: raw.trim().slice(0, DESCRIPTION_MAX) } : {};
}

socialRouter.get('/rooms', socialGate('ViewSocial'), socialHandler('get /rooms', asyncHandler(async (req, res) => {
  const rooms = await listRooms(sessionOf(req));
  const open = rooms.filter((r) => r.visibility === 'org').length;
  res.json({ source: source(), rooms, counts: { total: rooms.length, open, private: rooms.length - open } });
})));

socialRouter.post('/rooms', socialGate('ManageChannels'), socialHandler('post /rooms', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; visibility?: unknown };
  const name = requiredName(body.name, 'room');
  const room = await createRoom(sessionOf(req), { name, ...optionalDescription(body.description), visibility: body.visibility === 'private' ? 'private' : 'org' });
  res.status(201).json({ room });
})));

socialRouter.get('/teams', socialGate('ViewSocial'), socialHandler('get /teams', asyncHandler(async (req, res) => {
  const teams = await listTeams(sessionOf(req));
  res.json({ source: source(), teams, counts: { total: teams.length, channels: teams.reduce((n, t) => n + t.channels.length, 0) } });
})));

socialRouter.post('/teams', socialGate('ManageTeams'), socialHandler('post /teams', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; visibility?: unknown };
  const session = sessionOf(req);
  const team = await createTeam(session, {
    name: requiredName(body.name, 'team'), ...optionalDescription(body.description),
    visibility: body.visibility === 'private' ? 'private' : 'org', ...(session.name ? { byName: session.name } : {}),
  });
  res.status(201).json({ team });
})));

socialRouter.get('/teams/:teamId', socialGate('ViewSocial'), socialHandler('get /teams/:teamId', asyncHandler(async (req, res) => {
  const detail = await getTeam(sessionOf(req), String(req.params['teamId']));
  const names = await displayNames();
  res.json({ ...detail, members: detail.members.map((m) => ({ ...m, displayName: names.get(m.userId) ?? m.userId })) });
})));

// Personal team actions (your pin, leaving yourself) read the gate's session:
// `socialGate` has already resolved this request's CURRENT directory grants,
// epoch and actor and asked ViewSocial against the granted Social roles — on
// this mount and on the plane alike.
socialRouter.patch('/teams/:teamId/me', socialGate('ViewSocial'), socialHandler('patch /teams/:teamId/me', asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof (body as { favorite?: unknown }).favorite !== 'boolean') {
    throw new ValidationError('send only favorite (boolean)');
  }
  const member = await setTeamFavorite(session, String(req.params['teamId']), (body as { favorite: boolean }).favorite);
  res.json({ member });
})));

socialRouter.post('/teams/:teamId/members', socialGate('ManageTeams'), socialHandler('post /teams/:teamId/members', asyncHandler(async (req, res) => {
  const userId = typeof (req.body as { userId?: unknown } | undefined)?.userId === 'string' ? String((req.body as { userId: string }).userId).trim() : '';
  if (!userId) throw new ValidationError('name the person to add (userId)');
  // Only people who may stand in this tenant: a team is not a way in.
  const peer = (await socialRoster()).get(userId);
  if (!peer) throw new NotFoundError(`${userId} is not in this workspace`);
  const member = await addTeamMember(sessionOf(req), String(req.params['teamId']), userId, peer.displayName);
  res.status(201).json({ member: { ...member, displayName: peer.displayName } });
})));

socialRouter.delete('/teams/:teamId/members/:userId', socialGate(teamMemberAction), socialHandler('delete /teams/:teamId/members/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params['userId']);
  await removeTeamMember(sessionOf(req), String(req.params['teamId']), userId);
  res.status(204).end();
})));

socialRouter.get('/recordings', socialGate('ViewSocial'), socialHandler('get /recordings', asyncHandler(async (req, res) => {
  const recordings = await listRecordings(sessionOf(req));
  res.json({ source: source(), recordings, counts: { total: recordings.length, ready: recordings.filter((r) => r.stage === 'ready').length } });
})));

socialRouter.get('/recordings/:recordingId/playback', socialGate('ViewSocial'), socialHandler('get /recordings/:recordingId/playback', asyncHandler(async (req, res) => {
  res.json(await recordingPlayback(sessionOf(req), String(req.params['recordingId'])));
})));

socialRouter.get('/recordings/:recordingId/transcript', socialGate('ViewSocial'), socialHandler('get /recordings/:recordingId/transcript', asyncHandler(async (req, res) => {
  const transcript = await recordingTranscript(sessionOf(req), String(req.params['recordingId']));
  res.status(transcript.status === 'ready' ? 200 : 202).json(transcript);
})));

socialRouter.post('/recordings/:recordingId/share', socialGate('ManageRecordings'), socialHandler('post /recordings/:recordingId/share', asyncHandler(async (req, res) => {
  res.status(201).json(await shareRecording(sessionOf(req), String(req.params['recordingId'])));
})));

socialRouter.delete('/recordings/:recordingId', socialGate('ManageRecordings'), socialHandler('delete /recordings/:recordingId', asyncHandler(async (req, res) => {
  await deleteRecording(sessionOf(req), String(req.params['recordingId']));
  emitSocialWorkGraphEvent({ conversationId: null, cause: 'recording' });
  res.status(204).end();
})));

socialRouter.get('/calls', socialGate('ViewSocial'), socialHandler('get /calls', asyncHandler(async (req, res) => {
  const calls = await listCalls(sessionOf(req));
  res.json({ source: source(), calls: await withCallAvatars(calls), counts: { total: calls.length, missed: calls.filter((c) => c.outcome === 'missed' && c.direction === 'incoming').length } });
})));

// ── Shared work (docs/communication-plane-goal.md §2; the ONE shared-work notion) ─
//
//   GET /conversations/:id/shared-work   everything shared INTO this conversation as THIS reader may see it
//                                        (lib/work-graph/shared-work.ts `sharedWorkInConversation`): page
//                                        references, deck shares, files and sharing grants, each folded
//                                        through the reader's current authority; a non-member (or a malformed
//                                        name) is the uniform 404. `:id` is the chat channel name, URL-encoded.

socialRouter.get('/conversations/:id/shared-work', socialGate('ViewSocial'), socialHandler('get /conversations/:id/shared-work', asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const id = String(req.params['id'] ?? '');
  if (!SOCIAL_CONVERSATION_ID.test(id)) throw new NotFoundError('no such conversation');
  const body = await sharedWorkInConversation(session, id);
  if (!body) throw new NotFoundError('no such conversation');
  // The reads can outlive revocation: recheck before answering.
  await currentSocialActionSession(session, 'ViewSocial');
  res.set('Cache-Control', 'no-store');
  res.json(body);
})));

// ── The cross-tenant half: bindings and opening a DM (lane E) ──────────────

/** The tenant each context kind lives in. A kind not listed here cannot be bound. */
/** `assessment-team` is an assessment team (`TEAM-…`), `pipeline` a pipelines definition id — the plane's "My teams" / "My pipelines". `team` is an org-graph team (`teams.id`, GET /api/graph/teams?scope=mine) — the Communication plane's "My org teams" bind here. */
export const BINDING_CONTEXT_TENANT: Readonly<Record<string, string>> = { initiative: 'orgiq', document: 'assessment', team: 'orgiq', 'assessment-team': 'assessment', pipeline: 'pipelines' };
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A pipeline definition id is `bot:<uuid>` / `assessment:<name>` / `runbook:<id>` / `agent:<id>`. */
const PIPELINE_CONTEXT_ID = /^[a-z][a-z-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function bindingContext(raw: unknown): BindingContext {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const cut = text.indexOf(':');
  const kind = cut > 0 ? text.slice(0, cut) : '';
  const id = cut > 0 ? text.slice(cut + 1) : '';
  const tenant = BINDING_CONTEXT_TENANT[kind];
  if (!tenant || !(kind === 'pipeline' ? PIPELINE_CONTEXT_ID : CONTEXT_ID).test(id)) {
    throw new ValidationError(`name the context as ?context=<kind>:<id>, kind one of ${Object.keys(BINDING_CONTEXT_TENANT).join(', ')}`);
  }
  return { tenant, kind, id };
}

const hasGrant = (session: Session, tenant: string) => (session.grants?.[tenant]?.length ?? 0) > 0;
/** The context's tenant, for the bindings gate (a malformed context is the route's 400). */
const contextTenant = (req: Request): string => bindingContext(req.query['context']).tenant;

/** Small grant-gated workspace for the shell; the source session stays put. */
socialEmbedRouter.get('/embedded', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const fences = new Set<SocialMembershipProof>();
  try {
    const gate = { session: sessionOf(req) };
    let directory;
    try { directory = await listUsers({ authoritative: true }); }
    catch { throw new AppError(503, 'The identity store is unavailable'); }
    const names = new Map(directory.map(user => [user.id, user.displayName]));
    const roster = directory.filter(user => (user.grants.social?.length ?? 0) > 0)
      .map(user => ({ userId: user.id, displayName: user.displayName, roles: [...user.grants.social!] }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
    await socialChat().ready;
    const bounds = { hasMore: false };
    const conversations = await socialDirectMessages(recordUserId(gate.session.sub), names, 50, fences, bounds);
    // Directory/chat reads can outlive revocation. No roster or message preview
    // escapes unless the requesting source/actor and read action remain current.
    const current = await currentSocialActionSession(gate.session, 'ViewSocial');
    const canSend = (await socialActionRole(current, 'PostMessage')) !== null;
    const source = { userId: current.sub, tenant: current.tenant, role: current.role, epoch: current.epoch ?? 0,
      actor: current.act ? { userId: current.act.sub, epoch: current.act.epoch ?? 0 } : null };
    const authorityKey = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    res.set('Cache-Control', 'no-store');
    const allowedChannels = new Set([...fences].filter(proof => proof.allows()).map(proof => proof.channel));
    const visibleConversations = conversations.filter(row => allowedChannels.has(row.channel));
    // Keep returned conversation peers in the bounded picker whenever possible.
    // The metadata makes any omitted roster/index entries explicitly unknown,
    // rather than evidence that a previously selected person was revoked.
    const peerIds = new Set(visibleConversations.flatMap(row => row.peers.map(peer => peer.userId)));
    const priority = roster.filter(person => peerIds.has(person.userId));
    const avatars = await userAvatars(directory);
    const people = [...priority, ...roster.filter(person => !peerIds.has(person.userId))].slice(0, 500)
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId))
      .map(person => ({ ...person, avatarUrl: avatars.get(person.userId) ?? null }));
    res.json({ me: { userId: current.sub, displayName: current.name ?? current.sub, avatarUrl: avatars.get(current.sub) ?? null }, canSend, people,
      peopleTotal: roster.length, peopleHasMore: roster.length > people.length,
      conversations: withPeerAvatars(visibleConversations, avatars), conversationsHasMore: bounds.hasMore, authorityKey, source });
  } finally { for (const proof of fences) proof.dispose(); }
}));

/**
 * Where this person may post a shared file from any tenant: the channels they
 * are an ACTIVE member of (a public channel they have not joined is excluded,
 * so "members can download" names people who actually see it) and their DMs.
 * Grant-gated like /embedded; the browser still sends through the gateway,
 * whose channel guard is the authority at upload and publish time.
 */
socialEmbedRouter.get('/share-destinations', socialGate(['ViewSocial', 'PostMessage']), asyncHandler(async (req, res) => {
  const gate = { session: sessionOf(req) };
  const userId = recordUserId(gate.session.sub);
  const chat = socialChat();
  await chat.ready;
  const directory = await listChannels();
  await Promise.all(directory.map(row => chat.membershipStore.hydrate(channelForSlug(row.slug))));
  const channels = directory.filter(row => chat.membershipStore.isActiveMember(channelForSlug(row.slug), userId))
    .map(row => ({ channel: channelForSlug(row.slug), slug: row.slug, name: row.name, privacy: row.privacy,
      memberCount: chat.membershipStore.activeMembers(channelForSlug(row.slug)).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let names: Map<string, string>;
  try { names = new Map((await listUsers({ authoritative: true })).map(user => [user.id, user.displayName])); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  const fences = new Set<SocialMembershipProof>();
  let dms;
  try {
    dms = await socialDirectMessages(userId, names, 50, fences, { hasMore: false });
    const allowed = new Set([...fences].filter(proof => proof.allows()).map(proof => proof.channel));
    dms = dms.filter(row => allowed.has(row.channel));
  } finally { for (const proof of fences) proof.dispose(); }
  await currentSocialActionSession(gate.session, 'PostMessage');
  res.set('Cache-Control', 'no-store');
  res.json({ channels, conversations: dms.map(row => ({ channel: row.channel, peers: row.peers })) });
}));

export interface SocialBindingView {
  context: string;
  tenant: string;
  binding: (SocialBindingRow & { slug: string | null; name: string; privacy: SocialChannelPrivacy | null }) | null;
  /** The caller is an active member of the bound channel (the gateway admits members only). */
  joined: boolean;
  /** The caller may bind/unbind here (ManageChannels in social + a grant in the context's tenant). */
  canManage: boolean;
  /** What the caller could bind to (public channels + private ones they are in); only when canManage. */
  choices: Array<{ channel: string; slug: string; name: string; privacy: SocialChannelPrivacy }>;
}

async function bindingView(c: BindingContext, session: Session): Promise<SocialBindingView> {
  const chat = socialChat();
  await chat.ready;
  const row = await getBinding(c);
  const slug = row ? slugForChannel(row.channel) : null;
  const dir = slug ? await getChannel(slug) : null;
  if (row) await chat.membershipStore.hydrate(row.channel);
  // A private channel the caller is not in reads as "bound, but not to you".
  const visible = !!row && (!dir || dir.privacy === 'public' || chat.membershipStore.isActiveMember(row.channel, session.sub));
  const canManage = (await socialActionRole(session, 'ManageChannels')) !== null && hasGrant(session, c.tenant);
  const directory = canManage ? await listChannels() : [];
  await Promise.all(directory.map(row => chat.membershipStore.hydrate(channelForSlug(row.slug))));
  const choices = canManage
    ? directory
      .filter((r) => r.privacy === 'public' || chat.membershipStore.isActiveMember(channelForSlug(r.slug), session.sub))
      .map((r) => ({ channel: channelForSlug(r.slug), slug: r.slug, name: r.name, privacy: r.privacy }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return {
    context: `${c.kind}:${c.id}`,
    tenant: c.tenant,
    binding: row && visible ? { ...row, slug, name: dir?.name ?? slug ?? row.channel, privacy: dir?.privacy ?? null } : null,
    joined: !!row && visible && chat.membershipStore.isActiveMember(row.channel, session.sub),
    canManage,
    choices,
  };
}

socialEmbedRouter.get('/bindings', socialGate('ViewSocial', { grantIn: contextTenant }), asyncHandler(async (req, res) => {
  const c = bindingContext(req.query['context']);
  res.json(await bindingView(c, sessionOf(req)));
}));

socialEmbedRouter.put('/bindings', socialGate('ManageChannels', { grantIn: contextTenant }), asyncHandler(async (req, res) => {
  const c = bindingContext(req.query['context']);
  const gate = { session: sessionOf(req) };
  const channel = typeof (req.body as { channel?: unknown } | undefined)?.channel === 'string' ? String((req.body as { channel: string }).channel).trim() : '';
  const slug = slugForChannel(channel);
  if (!slug) throw new ValidationError('bind a channel by name (channel: social:ch:<slug>)');
  const chat = socialChat();
  await chat.ready;
  const dir = await getChannel(slug);
  await chat.membershipStore.hydrate(channel);
  // A private channel does not exist for a non-member (the directory's rule).
  if (!dir || (dir.privacy === 'private' && !chat.membershipStore.isActiveMember(channel, gate.session.sub))) {
    throw new NotFoundError(`no channel #${slug}`);
  }
  await putBinding(c, channel, gate.session.sub);
  res.json(await bindingView(c, gate.session));
}));

socialEmbedRouter.delete('/bindings', socialGate('ManageChannels', { grantIn: contextTenant }), asyncHandler(async (req, res) => {
  const c = bindingContext(req.query['context']);
  await deleteBinding(c);
  res.json(await bindingView(c, sessionOf(req)));
}));

// Opening a DM is grant-gated rather than tenant-gated so Search's people →
// Message works from an orgiq session holding a social grant (design §4.6);
// for a session standing in social the outcome is the one the tenant-gated
// route gave. The DM itself is only ever read and written in the social shell.
socialEmbedRouter.post('/dms', socialGate('PostMessage'), asyncHandler(async (req, res) => {
  const gate = { session: sessionOf(req) };
  const userId = recordUserId(gate.session.sub);
  const target = typeof (req.body as { userId?: unknown } | undefined)?.userId === 'string' ? String((req.body as { userId: string }).userId).trim() : '';
  if (!target) throw new ValidationError('name the person to message (userId)');
  if (target === userId) throw new ValidationError('a direct message needs someone other than you');
  let roster;
  try { roster = await socialRoster({ authoritative: true }); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  const peer = roster.get(target);
  if (!peer) throw new NotFoundError(`${target} is not in this workspace`);
  const channel = dmChannelFor([userId, target]);
  const chat = socialChat();
  await currentSocialActionSession(gate.session, 'PostMessage');
  await Promise.all([userId, target].map((u) => chat.conversations.recordJoin(channel, u).catch(() => undefined)));
  res.json({ channel, peers: [{ userId: peer.userId, displayName: peer.displayName }] });
}));
