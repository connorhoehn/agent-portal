// The Social tenant's search projection (docs/user-search-goal.md S2).
//
// Doc types (the chip each row shows is `labels`):
//   channel    #incidents — owner and members in the row, topic in the text
//   message    a chat message in a channel or DM, the snippet as the title
//   pin        a pinned message, "Pinned in #incidents by …"
//   dm         a direct-message conversation (participant-private)
//   contact    a person holding a Social grant
//   team       a platform-api team (Community) with its roster
//   room       a standalone call room (Design crit, Town hall)
//   recording  a call recording, found by its transcript (participant-private)
//   calllog    one person's call-log row (missed calls, history) — keyed by user
//   huddle     a call still going on in a Social lobby (live, read from the call log)
//
// Who may see a candidate is NOT a second permission spelling: a private
// channel's rows follow the chat membership mirror (`socialChat().membershipStore`,
// the gateway's own guard), a DM's follow the conversation's participants
// (`dmMembers`), a private room/team/recording/call follow the platform rows'
// own member/participant lists, and a clone acts as its persona
// (`ctx.userId` is `recordUserId`).
//
// Rooms, teams, recordings and the call log live in platform-api: the BFF
// can index them only from the dev:mock fixtures. Against a real platform-api
// the build says so in `partial` instead of pretending (they need a caller's
// token). Call-log rows are written upstream, so no BFF writer exists to hook.

import { config } from '../../config.js';
import { getChannel, listChannels, type SocialChannelRow } from '../../providers/social-channels.js';
import { listUsers } from '../../providers/identity.js';
import {
  isSocialLobby, socialPlatformBackend,
  type SocialCallLogRow, type SocialRecordingRow, type SocialRoomRow, type SocialTeamRow,
} from '../../providers/social-platform.js';
import {
  socialCallLogFixture, socialRecordingTranscriptsFixture, socialRecordingsFixture, socialRoomMembersFixture, socialRoomsFixture,
  socialTeamMembersFixture, socialTeamsFixture,
} from '../../mock/social-platform.js';
import { socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { channelForSlug, dmMembers, SOCIAL_CHANNEL_PREFIX, SOCIAL_DM_PREFIX, slugForChannel, socialChat } from '../social-chat.js';
import type { ChatMessage, PinnedMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { isoOrNull } from './orgiq.js';
import { noteSearchWrite } from './writes.js';
import type { PhraseRule, TenantBuild, TenantIndexSpec, TenantSearchContext } from './tenants.js';
import type { SearchDoc } from './types.js';

export const SOCIAL_DOC_TYPES = ['channel', 'message', 'pin', 'dm', 'contact', 'team', 'room', 'recording', 'calllog', 'huddle'] as const;
export type SocialDocType = typeof SOCIAL_DOC_TYPES[number];

const enc = encodeURIComponent;
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const clip = (s: string, n: number) => { const flat = s.replace(/\s+/g, ' ').trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
const ROLE_LABEL: Record<string, string> = { participant: 'Participant', moderator: 'Moderator', 'community-admin': 'Community admin', admin: 'Admin' };
const listing = (xs: string[]) => xs.join(', ');

function doc(partition: string, type: SocialDocType, id: string, d: Partial<SearchDoc> & { title: string; record: Record<string, unknown> }): SearchDoc {
  return {
    tenant: partition, type, id, title: d.title, text: d.text ?? '',
    facets: Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]).filter(([, v]) => (v as string[]).length)),
    people: [...new Set(d.people ?? [])], edges: [], acl: null, updatedAt: d.updatedAt ?? null, record: compact(d.record),
  };
}

// ── names ────────────────────────────────────────────────────────────────────

interface Directory { names: Map<string, string>; roles: Map<string, string[]> }
async function directory(): Promise<Directory> {
  const names = new Map<string, string>(), roles = new Map<string, string[]>();
  for (const u of await listUsers()) { names.set(u.id, u.displayName); const r = u.grants['social'] ?? []; if (r.length) roles.set(u.id, [...r]); }
  return { names, roles };
}
const nameOf = (dir: Directory, id: string, fallback?: string) => dir.names.get(id) ?? fallback ?? id;

// ── per-type docs ────────────────────────────────────────────────────────────

export function channelDoc(partition: string, row: SocialChannelRow, memberIds: string[], dir: Directory): SearchDoc {
  const owner = nameOf(dir, row.createdBy);
  const members = memberIds.map(id => nameOf(dir, id));
  return doc(partition, 'channel', row.slug, {
    title: `#${row.slug}`,
    text: `${row.name} ${row.description ?? ''} channel owner ${owner} members ${listing(members)}`,
    facets: { owner: [row.createdBy], member: memberIds, private: [String(row.privacy === 'private')] },
    people: memberIds, updatedAt: isoOrNull(row.createdAt),
    record: {
      description: row.description ?? undefined, subtitle: `${row.name} · Owner: ${owner} · Members: ${listing(members)}`,
      status: row.privacy, privacy: row.privacy, href: `/social/channels/${enc(row.slug)}`, channel: channelForSlug(row.slug),
    },
  });
}

function dmTitle(channel: string, dir: Directory): string {
  return (dmMembers(channel) ?? []).map(id => nameOf(dir, id)).join(', ');
}

export function dmDoc(partition: string, channel: string, dir: Directory, last: ChatMessage | null): SearchDoc {
  const ids = dmMembers(channel) ?? [];
  const names = ids.map(id => nameOf(dir, id));
  return doc(partition, 'dm', channel, {
    title: `Direct message: ${listing(names)}`, text: `dm direct message conversation ${listing(names)}`,
    facets: { member: ids }, people: ids, updatedAt: isoOrNull(last?.timestamp),
    record: { subtitle: last && !last.deletedAt ? `Last: ${clip(last.message, 90)}` : 'Direct message', href: `/social/dms/${enc(channel)}`, channel },
  });
}

function conversationOf(channel: string, dir: Directory): { label: string; href: string; privateChannel: boolean } | null {
  const slug = slugForChannel(channel);
  if (slug) return { label: `#${slug}`, href: `/social/channels/${enc(slug)}`, privateChannel: false };
  if (channel.startsWith(SOCIAL_DM_PREFIX)) return { label: `DM ${dmTitle(channel, dir)}`, href: `/social/dms/${enc(channel)}`, privateChannel: true };
  return null;
}

const msgId = (m: Pick<ChatMessage, 'channel' | 'id'>) => `${m.channel}|${m.id}`;

export function messageDoc(partition: string, m: ChatMessage, dir: Directory, isPrivate: boolean): SearchDoc | null {
  const where = conversationOf(m.channel, dir);
  if (!where || m.deletedAt) return null;
  const sender = String((m.metadata as Record<string, unknown> | undefined)?.['displayName'] ?? '') || nameOf(dir, m.userId ?? '', m.userId ?? 'someone');
  return doc(partition, 'message', msgId(m), {
    title: clip(m.message, 160), text: `${m.message} ${sender} ${where.label}`,
    facets: { channel: [m.channel], sender: [m.userId ?? ''], private: [String(isPrivate)] },
    people: m.userId ? [m.userId] : [], updatedAt: isoOrNull(m.timestamp),
    record: { description: m.message.length > 160 ? clip(m.message, 600) : undefined, subtitle: `${where.label} · ${sender}`, href: where.href, channel: m.channel },
  });
}

export function pinDoc(partition: string, p: PinnedMessage, dir: Directory, isPrivate: boolean, fullText: string | null): SearchDoc | null {
  const where = conversationOf(p.channelId, dir);
  if (!where) return null;
  const by = nameOf(dir, p.pinnedBy);
  return doc(partition, 'pin', `${p.channelId}|${p.messageId}`, {
    title: clip(fullText ?? p.preview, 160), text: `pinned pin ${fullText ?? p.preview} ${p.author} ${where.label}`,
    facets: { channel: [p.channelId], private: [String(isPrivate)] }, people: [p.pinnedBy], updatedAt: isoOrNull(p.pinnedAt),
    record: { subtitle: `Pinned in ${where.label} by ${by}`, href: where.href, channel: p.channelId },
  });
}

export function contactDoc(partition: string, id: string, name: string, roles: string[]): SearchDoc {
  const label = roles.map(r => ROLE_LABEL[r] ?? r).join(', ');
  return doc(partition, 'contact', id, {
    title: name, text: `${name} person contact ${roles.join(' ')}`, facets: { role: roles }, people: [id],
    record: { subtitle: `${label} · Social`, status: roles[0], href: `/social/contacts/${enc(id)}` },
  });
}

export function teamDoc(partition: string, t: SocialTeamRow, members: Array<{ userId: string; role: string }>, channels: SocialRoomRow[], dir: Directory): SearchDoc {
  const owner = members.find(m => m.role === 'owner');
  const names = members.map(m => `${nameOf(dir, m.userId)}${m.role === 'owner' ? ' (owner)' : ''}`);
  return doc(partition, 'team', t.teamId, {
    title: t.name, text: `${t.description ?? ''} team owner ${owner ? nameOf(dir, owner.userId) : ''} members ${listing(names)} channels ${channels.map(c => c.name).join(' ')}`,
    facets: { member: members.map(m => m.userId), private: [String(t.visibility === 'private')] }, people: members.map(m => m.userId), updatedAt: isoOrNull(t.updatedAt),
    record: { description: t.description, subtitle: `Team · ${members.length} members: ${listing(names)}`, href: `/social/teams`, status: t.visibility },
  });
}

export function roomDoc(partition: string, r: SocialRoomRow, memberIds: string[], dir: Directory): SearchDoc {
  const priv = r.visibility === 'private';
  return doc(partition, 'room', r.slug, {
    title: r.name, text: `${r.description ?? ''} room call video hangout owner ${nameOf(dir, r.createdBy)}`,
    facets: { member: [r.createdBy, ...memberIds], private: [String(priv)] }, people: [r.createdBy, ...memberIds], updatedAt: isoOrNull(r.lastActiveAt),
    record: { description: r.description, subtitle: `Room · ${priv ? 'Private' : 'Open'} · Created by ${nameOf(dir, r.createdBy)}`, href: `/social/rooms?room=${enc(r.slug)}`, status: r.visibility },
  });
}

function lobbyLabel(lobby: string, dir: Directory): string {
  if (lobby.startsWith('social:room:')) {
    const slug = lobby.slice('social:room:'.length);
    return socialRoomsFixture.rows().find(r => r.slug === slug)?.name ?? slug;
  }
  const slug = slugForChannel(lobby);
  if (slug) return `#${slug}`;
  if (lobby.startsWith(SOCIAL_DM_PREFIX)) return `DM ${dmTitle(lobby, dir)}`;
  return lobby;
}

export function recordingDoc(partition: string, r: SocialRecordingRow, segments: string[], dir: Directory): SearchDoc {
  const where = lobbyLabel(r.lobbyName, dir);
  const who = r.participants.map(p => nameOf(dir, p.userId, p.displayName));
  const minutes = Math.round(r.durationMs / 60_000);
  return doc(partition, 'recording', r.recordingId, {
    title: `${where} recording`, text: `recording call ${where} ${listing(who)} ${segments.join(' ')}`,
    facets: { participant: r.participants.map(p => p.userId), lobby: [r.lobbyName] }, people: r.participants.map(p => p.userId), updatedAt: isoOrNull(r.startedAt),
    record: {
      description: segments.length ? clip(segments.join(' '), 400) : undefined,
      subtitle: `Recording · ${minutes} min · ${listing(who)}`, status: r.stage, href: `/social/recordings`,
    },
  });
}

export function callLogDoc(partition: string, c: SocialCallLogRow, dir: Directory): SearchDoc {
  const where = lobbyLabel(c.lobbyName, dir);
  const other = c.direction === 'outgoing' ? c.targetUserIds.map(id => nameOf(dir, id)).join(', ') : nameOf(dir, c.callerId, c.callerName);
  const title = c.outcome === 'missed'
    ? (c.direction === 'outgoing' ? `Missed call to ${other}` : `Missed call from ${other}`)
    : c.direction === 'outgoing' ? `Call to ${other}` : c.direction === 'incoming' ? `Call from ${other}` : `Joined call in ${where}`;
  return doc(partition, 'calllog', `${c.callId}|${c.userId}`, {
    title, text: `call history ${where} ${other} ${c.outcome}`, facets: { user: [c.userId], outcome: [c.outcome], direction: [c.direction] }, people: [c.userId],
    updatedAt: isoOrNull(c.startedAt),
    record: { subtitle: `${where} · ${c.outcome}`, status: c.outcome, href: '/social/calls' },
  });
}

export function huddleDoc(partition: string, callId: string, rows: SocialCallLogRow[], dir: Directory, isPrivate = false): SearchDoc {
  const first = rows[0]!;
  const where = lobbyLabel(first.lobbyName, dir);
  const who = rows.map(r => nameOf(dir, r.userId));
  return doc(partition, 'huddle', callId, {
    title: `Live huddle in ${where}`, text: `huddle live call now in a huddle ${where} ${listing(who)}`,
    facets: { lobby: [first.lobbyName], private: [String(isPrivate)] }, people: rows.map(r => r.userId), updatedAt: isoOrNull(first.startedAt),
    record: { subtitle: `In the huddle now: ${listing(who)}`, status: 'live', href: '/social/calls', channel: first.lobbyName },
  });
}

// ── reading the sources ──────────────────────────────────────────────────────

async function memberIdsOf(channel: string): Promise<string[]> {
  const chat = socialChat();
  await chat.membershipStore.hydrate(channel).catch(() => undefined);
  return chat.membershipStore.activeMembers(channel).map(m => m.userId);
}

const isLive = (r: SocialCallLogRow) => r.outcome === 'answered' && !r.endedAt;
const mockPlatform = () => socialPlatformBackend() === 'mock';

async function teamMembers(teamId: string) {
  return socialTeamMembersFixture.rows().filter(m => m.teamId === teamId);
}

export async function buildSocialDocs(partition: string): Promise<TenantBuild> {
  const partial: string[] = [];
  let failed = false;
  const docs: SearchDoc[] = [];
  const dir = await directory().catch(() => { failed = true; partial.push('People unavailable'); return { names: new Map(), roles: new Map() } as Directory; });
  const chat = socialChat();
  await chat.ready.catch(() => undefined);

  for (const [id, roles] of dir.roles) {
    if (roles.length === 1 && roles[0] === 'admin') continue; // the platform operator is not a contact (routes/social.ts GET /people)
    docs.push(contactDoc(partition, id, nameOf(dir, id), roles));
  }

  const conversations = new Map<string, boolean>(); // channel → private
  let channels: SocialChannelRow[] = [];
  try { channels = await listChannels(); } catch { failed = true; partial.push('Channels unavailable'); }
  for (const row of channels) {
    const channel = channelForSlug(row.slug);
    const ids = await memberIdsOf(channel);
    docs.push(channelDoc(partition, row, ids, dir));
    conversations.set(channel, row.privacy === 'private');
  }
  // DMs: every direct-message channel the chat store knows (mock: the registered rows; the durable store lists them per person as they are written).
  if (config.mock.aurora) {
    for (const m of socialChannelMessagesFixture.rows()) if (m.channel.startsWith(SOCIAL_DM_PREFIX)) conversations.set(m.channel, true);
  } else partial.push('Direct messages are indexed as they are written, not backfilled');

  for (const [channel, isPrivate] of conversations) {
    let messages: ChatMessage[] = [];
    try { messages = await chat.chatStore.listMessages(channel, 500); } catch { failed = true; partial.push('Chat history unavailable'); }
    if (channel.startsWith(SOCIAL_DM_PREFIX)) docs.push(dmDoc(partition, channel, dir, messages[messages.length - 1] ?? null));
    for (const m of messages) { const d = messageDoc(partition, m, dir, isPrivate); if (d) docs.push(d); }
    try {
      for (const p of await chat.pinsStore.list(channel)) {
        const full = messages.find(m => m.id === p.messageId)?.message ?? null;
        const d = pinDoc(partition, p, dir, isPrivate, full);
        if (d) docs.push(d);
      }
    } catch { partial.push('Pins unavailable'); }
  }

  if (mockPlatform()) {
    const rooms = socialRoomsFixture.rows().filter(r => r.orgId === 'social' && r.state === 'active');
    const teams = socialTeamsFixture.rows().filter(t => t.orgId === 'social' && t.state === 'active');
    for (const t of teams) docs.push(teamDoc(partition, t, await teamMembers(t.teamId), rooms.filter(r => r.teamId === t.teamId), dir));
    for (const r of rooms.filter(x => !x.teamId)) docs.push(roomDoc(partition, r, socialRoomMembersFixture.rows().filter(m => m.roomId === r.roomId).map(m => m.userId), dir));
    for (const rec of socialRecordingsFixture.rows().filter(r => isSocialLobby(r.lobbyName))) docs.push(recordingDoc(partition, rec, transcriptOf(rec.recordingId), dir));
    const log = socialCallLogFixture.rows().filter(r => isSocialLobby(r.lobbyName));
    for (const c of log) docs.push(callLogDoc(partition, c, dir));
    for (const [callId, rows] of liveCalls(log)) docs.push(huddleDoc(partition, callId, rows, dir, await isPrivateConversation(rows[0]!.lobbyName)));
  } else partial.push('Rooms, teams, recordings and calls live in platform-api and are not indexed without a caller token');

  return { docs, partial: [...new Set(partial)], failed };
}

function transcriptOf(recordingId: string): string[] {
  const t = socialRecordingTranscriptsFixture.rows().find(r => r.recordingId === recordingId);
  return (t?.segments ?? []).filter(s => s.kind !== 'reaction').map(s => s.text);
}

function liveCalls(log: SocialCallLogRow[]): Map<string, SocialCallLogRow[]> {
  const out = new Map<string, SocialCallLogRow[]>();
  for (const r of log.filter(isLive)) out.set(r.callId, [...(out.get(r.callId) ?? []), r]);
  return out;
}

export async function projectSocialRecord(partition: string, type: string, id: string): Promise<SearchDoc | null> {
  const dir = await directory();
  const chat = socialChat();
  switch (type as SocialDocType) {
    case 'channel': {
      const row = await getChannel(id);
      return row ? channelDoc(partition, row, await memberIdsOf(channelForSlug(id)), dir) : null;
    }
    case 'dm': {
      if (!dmMembers(id)) return null;
      const last = await chat.lastMessage(id);
      return last ? dmDoc(partition, id, dir, last) : null;
    }
    case 'message': {
      const at = id.lastIndexOf('|');
      const channel = id.slice(0, at), messageId = id.slice(at + 1);
      const m = await chat.chatStore.getMessage?.(channel, messageId);
      return m ? messageDoc(partition, m, dir, await isPrivateConversation(channel)) : null;
    }
    case 'pin': {
      const at = id.lastIndexOf('|');
      const channel = id.slice(0, at), messageId = id.slice(at + 1);
      const p = (await chat.pinsStore.list(channel)).find(x => x.messageId === messageId);
      if (!p) return null;
      const full = (await chat.chatStore.getMessage?.(channel, messageId))?.message ?? null;
      return pinDoc(partition, p, dir, await isPrivateConversation(channel), full);
    }
    case 'contact': {
      const roles = dir.roles.get(id);
      return roles && !(roles.length === 1 && roles[0] === 'admin') ? contactDoc(partition, id, nameOf(dir, id), roles) : null;
    }
    case 'team': {
      if (!mockPlatform()) return null;
      const t = socialTeamsFixture.rows().find(x => x.teamId === id && x.state === 'active');
      return t ? teamDoc(partition, t, await teamMembers(id), socialRoomsFixture.rows().filter(r => r.teamId === id && r.state === 'active'), dir) : null;
    }
    case 'room': {
      if (!mockPlatform()) return null;
      const r = socialRoomsFixture.rows().find(x => x.slug === id && !x.teamId && x.state === 'active');
      return r ? roomDoc(partition, r, socialRoomMembersFixture.rows().filter(m => m.roomId === r.roomId).map(m => m.userId), dir) : null;
    }
    case 'recording': {
      if (!mockPlatform()) return null;
      const r = socialRecordingsFixture.rows().find(x => x.recordingId === id && isSocialLobby(x.lobbyName));
      return r ? recordingDoc(partition, r, transcriptOf(id), dir) : null;
    }
    case 'calllog': {
      if (!mockPlatform()) return null;
      const at = id.lastIndexOf('|');
      const c = socialCallLogFixture.rows().find(x => x.callId === id.slice(0, at) && x.userId === id.slice(at + 1) && isSocialLobby(x.lobbyName));
      return c ? callLogDoc(partition, c, dir) : null;
    }
    case 'huddle': {
      if (!mockPlatform()) return null;
      const rows = liveCalls(socialCallLogFixture.rows().filter(r => isSocialLobby(r.lobbyName))).get(id);
      return rows?.length ? huddleDoc(partition, id, rows, dir, await isPrivateConversation(rows[0]!.lobbyName)) : null;
    }
  }
  return null;
}

async function isPrivateConversation(channel: string): Promise<boolean> {
  const slug = slugForChannel(channel);
  if (!slug) return channel.startsWith(SOCIAL_DM_PREFIX);
  return (await getChannel(slug))?.privacy === 'private';
}

/**
 * The refs to re-project after a pin or unpin on `channel`: every pin now on it
 * plus every pin the index still holds for it (so an unpinned row is removed).
 */
export async function pinWriteRefs(channel: string): Promise<Array<{ tenant: 'social'; type: 'pin'; id: string }>> {
  const ids = new Set<string>();
  try { for (const p of await socialChat().pinsStore.list(channel)) ids.add(`${channel}|${p.messageId}`); } catch { /* the store is down: re-project what the index holds */ }
  try {
    const { isIndexed, partitionFor, searchIndex } = await import('./registry.js');
    if (await isIndexed('social')) {
      const page = await searchIndex().query({ tenant: partitionFor('social'), terms: [], types: ['pin'], facets: { channel: [channel] } });
      for (const d of page.docs) ids.add(d.id);
    }
  } catch { /* no index in this process */ }
  return [...ids].map(id => ({ tenant: 'social' as const, type: 'pin' as const, id }));
}

/** Update the index after a chat store write on a Social conversation (the one seam: lib/social-chat.ts watchChatForWorkGraph). */
export async function noteChatWrite(channel: string, messageId?: string): Promise<void> {
  if (!channel.startsWith(SOCIAL_CHANNEL_PREFIX) && !channel.startsWith(SOCIAL_DM_PREFIX)) return;
  const refs: Array<{ tenant: 'social'; type: SocialDocType; id: string }> = [];
  if (messageId) refs.push({ tenant: 'social', type: 'message', id: `${channel}|${messageId}` });
  if (channel.startsWith(SOCIAL_DM_PREFIX)) refs.push({ tenant: 'social', type: 'dm', id: channel });
  else { const slug = slugForChannel(channel); if (slug) refs.push({ tenant: 'social', type: 'channel', id: slug }); }
  await noteSearchWrite(...refs);
}

// ── phrases and visibility ───────────────────────────────────────────────────

const rules: PhraseRule[] = [
  { re: /\bpinned\b(?: messages?)?|\bpins\b|\bpin\b/i, types: ['pin'] },
  { re: /\bmissed(?: calls?)?\b/i, types: ['calllog'], facets: { outcome: ['missed'], user: ['@me'] } },
  { re: /\bwho called me\b|\bcall history\b|\b(?:recent|past|my) calls\b/i, types: ['calllog'], facets: { user: ['@me'] } },
  { re: /\b(?:live|active) (?:calls?|huddles?)\b|\bcalls? now\b|\bhuddles?\b/i, types: ['huddle'] },
  { re: /\b(?:my )?(?:dms?|direct messages?)(?: with)?\b|\bconversations? with\b/i, types: ['dm'], facets: { member: ['@me'] } },
];

const lowerIncludes = (values: string[] | undefined, id: string) => (values ?? []).some(v => v.toLowerCase() === id.toLowerCase());

function visible(d: SearchDoc, ctx: TenantSearchContext): boolean {
  const me = ctx.userId;
  const priv = (d.facets['private'] ?? [])[0] === 'true';
  switch (d.type as SocialDocType) {
    case 'channel':
      return !priv || socialChat().membershipStore.isActiveMember(String(d.record['channel']), me);
    case 'message': case 'pin': {
      const channel = String(d.record['channel'] ?? '');
      if (channel.startsWith(SOCIAL_DM_PREFIX)) return !!dmMembers(channel)?.some(id => id.toLowerCase() === me.toLowerCase());
      return !priv || socialChat().membershipStore.isActiveMember(channel, me);
    }
    case 'dm': return lowerIncludes(d.facets['member'], me);
    case 'room': case 'team': return !priv || lowerIncludes(d.facets['member'], me);
    case 'recording': return lowerIncludes(d.facets['participant'], me);
    case 'calllog': return lowerIncludes(d.facets['user'], me);
    case 'huddle': {
      const id = d.id;
      // Still going on, read live: a call that ended upstream is no longer "anyone in a huddle".
      if (!mockPlatform() || !socialCallLogFixture.rows().some(r => r.callId === id && isLive(r))) return false;
      const lobby = String(d.record['channel'] ?? '');
      const slug = slugForChannel(lobby);
      if (slug) return !priv || socialChat().membershipStore.isActiveMember(lobby, me);
      if (lobby.startsWith(SOCIAL_DM_PREFIX)) return !!dmMembers(lobby)?.some(u => u.toLowerCase() === me.toLowerCase());
      return true;
    }
    case 'contact': return true;
  }
  return false;
}

export const socialSpec: TenantIndexSpec = {
  tenant: 'social',
  types: SOCIAL_DOC_TYPES,
  labels: { channel: 'Channel', message: 'Message', pin: 'Pin', dm: 'DM', contact: 'Person', team: 'Team', room: 'Room', recording: 'Recording', calllog: 'Calls', huddle: 'Huddle' },
  acls: [],
  build: buildSocialDocs,
  project: projectSocialRecord,
  rules,
  visible,
  scaffold: ['owns', 'owner', 'owned', 'members', 'member', 'whos', 's', 'anyone', 'anybody', 'someone', 'join', 'were'],
};
