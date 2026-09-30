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
// reads. Rooms/teams/recordings arrive in S2, bindings in E.
//
//   GET  /channels                 public channels + private ones you are in
//   POST /channels                 create (ManageChannels); you become its owner
//   GET  /channels/:slug           the channel, its members, recent messages
//   POST /channels/:slug/join      join a public channel
//   POST /channels/:slug/leave     leave
//   GET  /dms                      your DMs, newest first
//   POST /dms {userId}             open a DM → its lobby `social:dm:<sorted ids>`
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
//   POST   /teams/:teamId/members {userId}  add someone (ManageTeams; the team's owner)
//   DELETE /teams/:teamId/members/:userId   remove someone (ManageTeams; the owner, or yourself)
//   GET    /recordings                      recordings you were in, social: lobbies only
//   GET    /recordings/:recordingId/playback  what there is to play
//   POST   /recordings/:recordingId/share   mint a share link (ManageRecordings)
//   DELETE /recordings/:recordingId         delete (ManageRecordings; whoever started it)
//   GET    /calls                           your call log, social: lobbies only
//
// Messages are never written here: they go over the gateway (`/ws`, `useChat`),
// which admits a `social:ch:<slug>` subscribe/publish to its members only.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { channelForSlug, dmChannelFor, dmMembers, isValidSlug, slugify, socialChat, SOCIAL_DM_PREFIX } from '../lib/social-chat.js';
import { clock } from '../mock/core/index.js';
import { unreadFor } from '../mock/social-channels.js';
import { createChannel, DuplicateChannelError, getChannel, listChannels, type SocialChannelPrivacy, type SocialChannelRow } from '../providers/social-channels.js';
import { listUsers } from '../providers/identity.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { socialSurfaceCounts, socialSurfaces } from '../mock/social.js';
import {
  addTeamMember, createRoom, createTeam, deleteRecording, getTeam, listCalls, listRecordings, listRooms, listTeams,
  recordingPlayback, removeTeamMember, shareRecording, socialPlatformBackend,
} from '../providers/social-platform.js';
import type { Session } from '../lib/session.js';

export const socialRouter = Router();

socialRouter.get('/summary', requireAction('ViewSocial'), asyncHandler(async (_req, res) => {
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

const NAME_MAX = 80;
const DESCRIPTION_MAX = 280;
const RECENT_LIMIT = 30;
/** How many recent DM messages the unread count looks at. */
const UNREAD_WINDOW = 50;

const me = (req: Request): string => req.session?.sub ?? '';

/** Everyone holding a social grant, by id. */
async function socialRoster(): Promise<Map<string, { userId: string; displayName: string; roles: string[] }>> {
  const out = new Map<string, { userId: string; displayName: string; roles: string[] }>();
  for (const u of await listUsers()) {
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
  if (row.privacy === 'private' && !socialChat().membershipStore.isActiveMember(channelForSlug(slug), userId)) {
    throw new NotFoundError(`no channel #${slug}`);
  }
  return row;
}

socialRouter.get('/channels', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const userId = me(req);
  const chat = socialChat();
  await chat.ready;
  const rows = (await listChannels()).filter((r) => r.privacy === 'public' || chat.membershipStore.isActiveMember(channelForSlug(r.slug), userId));
  const channels = await Promise.all(rows.map((r) => channelView(r, userId)));
  channels.sort((a, b) => Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name));
  res.json({ channels });
}));

socialRouter.post('/channels', requireAction('ManageChannels'), asyncHandler(async (req, res) => {
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
}));

socialRouter.get('/channels/:slug', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
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

socialRouter.post('/channels/:slug/join', requireAction('PostMessage'), asyncHandler(async (req, res) => {
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
}));

socialRouter.post('/channels/:slug/leave', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
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
}));

socialRouter.get('/dms', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const userId = me(req);
  const names = await displayNames();
  const chat = socialChat();
  const rows = (await chat.conversations.listForUser(userId))
    .filter((r) => r.channel.startsWith(SOCIAL_DM_PREFIX) && (dmMembers(r.channel) ?? []).includes(userId));
  const conversations = (await Promise.all(rows.map(async (r) => {
    const [recent, cursors] = await Promise.all([chat.recentMessages(r.channel, UNREAD_WINDOW), chat.readReceiptStore.listReceipts(r.channel)]);
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
  }))).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  res.json({ conversations });
}));

socialRouter.post('/dms', requireAction('PostMessage'), asyncHandler(async (req, res) => {
  const userId = me(req);
  const target = typeof (req.body as { userId?: unknown } | undefined)?.userId === 'string' ? String((req.body as { userId: string }).userId).trim() : '';
  if (!target) throw new ValidationError('name the person to message (userId)');
  if (target === userId) throw new ValidationError('a direct message needs someone other than you');
  const roster = await socialRoster();
  const peer = roster.get(target);
  if (!peer) throw new NotFoundError(`${target} is not in this workspace`);
  const channel = dmChannelFor([userId, target]);
  const chat = socialChat();
  await Promise.all([userId, target].map((u) => chat.conversations.recordJoin(channel, u).catch(() => undefined)));
  res.json({ channel, peers: [{ userId: peer.userId, displayName: peer.displayName }] });
}));

socialRouter.post('/dms/read', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const userId = me(req);
  const channel = typeof (req.body as { channel?: unknown } | undefined)?.channel === 'string' ? String((req.body as { channel: string }).channel) : '';
  const ids = dmMembers(channel);
  if (!ids) throw new ValidationError('name a DM (channel: social:dm:<ids>)');
  // A DM that does not name you does not exist for you.
  if (!ids.includes(userId)) throw new NotFoundError('no such conversation');
  const now = clock.nowIso();
  await socialChat().readReceiptStore.advance({ channel, userId, readAt: now, updatedAt: now });
  res.json({ channel, readAt: now });
}));

socialRouter.get('/people', requireAction('ViewSocial'), asyncHandler(async (_req, res) => {
  const people = [...(await socialRoster()).values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ people });
}));

// ── Rooms, teams, recordings, calls (phase S2) ──────────────────────────────

const sessionOf = (req: Request): Session => req.session as Session;
const source = () => socialPlatformBackend();

function requiredName(raw: unknown, what: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > NAME_MAX) throw new ValidationError(`a ${what} needs a name of 1–${NAME_MAX} characters`);
  if (!isValidSlug(slugify(name))) throw new ValidationError(`a ${what} name needs at least one letter or digit`);
  return name;
}
function optionalDescription(raw: unknown): { description?: string } {
  return typeof raw === 'string' && raw.trim() ? { description: raw.trim().slice(0, DESCRIPTION_MAX) } : {};
}

socialRouter.get('/rooms', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const rooms = await listRooms(sessionOf(req));
  const open = rooms.filter((r) => r.visibility === 'org').length;
  res.json({ source: source(), rooms, counts: { total: rooms.length, open, private: rooms.length - open } });
}));

socialRouter.post('/rooms', requireAction('ManageChannels'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; visibility?: unknown };
  const name = requiredName(body.name, 'room');
  const room = await createRoom(sessionOf(req), { name, ...optionalDescription(body.description), visibility: body.visibility === 'private' ? 'private' : 'org' });
  res.status(201).json({ room });
}));

socialRouter.get('/teams', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const teams = await listTeams(sessionOf(req));
  res.json({ source: source(), teams, counts: { total: teams.length, channels: teams.reduce((n, t) => n + t.channels.length, 0) } });
}));

socialRouter.post('/teams', requireAction('ManageTeams'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; visibility?: unknown };
  const session = sessionOf(req);
  const team = await createTeam(session, {
    name: requiredName(body.name, 'team'), ...optionalDescription(body.description),
    visibility: body.visibility === 'private' ? 'private' : 'org', ...(session.name ? { byName: session.name } : {}),
  });
  res.status(201).json({ team });
}));

socialRouter.get('/teams/:teamId', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const detail = await getTeam(sessionOf(req), String(req.params['teamId']));
  const names = await displayNames();
  res.json({ ...detail, members: detail.members.map((m) => ({ ...m, displayName: names.get(m.userId) ?? m.userId })) });
}));

socialRouter.post('/teams/:teamId/members', requireAction('ManageTeams'), asyncHandler(async (req, res) => {
  const userId = typeof (req.body as { userId?: unknown } | undefined)?.userId === 'string' ? String((req.body as { userId: string }).userId).trim() : '';
  if (!userId) throw new ValidationError('name the person to add (userId)');
  // Only people who may stand in this tenant: a team is not a way in.
  const peer = (await socialRoster()).get(userId);
  if (!peer) throw new NotFoundError(`${userId} is not in this workspace`);
  const member = await addTeamMember(sessionOf(req), String(req.params['teamId']), userId, peer.displayName);
  res.status(201).json({ member: { ...member, displayName: peer.displayName } });
}));

socialRouter.delete('/teams/:teamId/members/:userId', requireAction('ManageTeams'), asyncHandler(async (req, res) => {
  await removeTeamMember(sessionOf(req), String(req.params['teamId']), String(req.params['userId']));
  res.status(204).end();
}));

socialRouter.get('/recordings', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const recordings = await listRecordings(sessionOf(req));
  res.json({ source: source(), recordings, counts: { total: recordings.length, ready: recordings.filter((r) => r.stage === 'ready').length } });
}));

socialRouter.get('/recordings/:recordingId/playback', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  res.json(await recordingPlayback(sessionOf(req), String(req.params['recordingId'])));
}));

socialRouter.post('/recordings/:recordingId/share', requireAction('ManageRecordings'), asyncHandler(async (req, res) => {
  res.status(201).json(await shareRecording(sessionOf(req), String(req.params['recordingId'])));
}));

socialRouter.delete('/recordings/:recordingId', requireAction('ManageRecordings'), asyncHandler(async (req, res) => {
  await deleteRecording(sessionOf(req), String(req.params['recordingId']));
  res.status(204).end();
}));

socialRouter.get('/calls', requireAction('ViewSocial'), asyncHandler(async (req, res) => {
  const calls = await listCalls(sessionOf(req));
  res.json({ source: source(), calls, counts: { total: calls.length, missed: calls.filter((c) => c.outcome === 'missed' && c.direction === 'incoming').length } });
}));
