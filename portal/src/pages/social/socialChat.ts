// The social tenant's Channels and DMs, as data (docs/social-tenant-design.md
// §4.3–§4.5): the wire shapes `/api/social/*` answers with, and the pure
// mappings from them to the library rail's rows. No React, so
// `__tests__/socialChat.test.ts` runs under plain `node --test`.
//
// Channel names are `social:ch:<slug>` and DM lobbies `social:dm:<sorted ids>`
// (§4.3) — the server mints both; the portal only reads them back.

/** One channel as `GET /api/social/channels` lists it. */
export interface SocialChannel {
  slug: string;
  /** `social:ch:<slug>` — the `useChat` channel. */
  channel: string;
  name: string;
  description: string | null;
  privacy: 'public' | 'private';
  createdBy: string;
  createdAt: string;
  memberCount: number;
  /** The caller is an active member (the gateway admits only members). */
  joined: boolean;
  role: 'owner' | 'member' | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface SocialPeer {
  userId: string;
  displayName: string;
}

/** One person holding a social grant (`GET /api/social/people`). */
export interface SocialPerson extends SocialPeer {
  roles: string[];
}

/** One direct conversation (`GET /api/social/dms`); `peers` excludes the caller. */
export interface SocialDm {
  channel: string;
  peers: SocialPeer[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageUserId: string | null;
  /** Messages from the others you have not read (`POST /api/social/dms/read` clears it). */
  unreadCount?: number;
}

/** A row's person, with the presence dot the rail draws (undefined: no dot). */
export interface SocialRailPeer extends SocialPeer {
  online?: boolean;
}

/** The rail row the library's `ConversationRail` takes (its `ConversationItem`, the fields used here). */
export interface SocialRailItem {
  channel: string;
  kind: 'dm' | 'group' | 'channel';
  name?: string;
  peers: SocialRailPeer[];
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount?: number;
}

export const CHANNEL_PREFIX = 'social:ch:';
export const DM_PREFIX = 'social:dm:';

/** `social:ch:<slug>` → `<slug>`; anything else → null. */
export function slugFromChannel(channel: string): string | null {
  return channel.startsWith(CHANNEL_PREFIX) && channel.length > CHANNEL_PREFIX.length ? channel.slice(CHANNEL_PREFIX.length) : null;
}

/** `social:dm:<a>:<b>…` → its member ids; anything else → []. */
export function dmMembers(lobby: string): string[] {
  if (!lobby.startsWith(DM_PREFIX)) return [];
  return lobby.slice(DM_PREFIX.length).split(':').filter(Boolean);
}

export function channelHref(slug: string): string {
  return `/social/channels/${encodeURIComponent(slug)}`;
}

export function dmHref(lobby: string): string {
  return `/social/dms/${encodeURIComponent(lobby)}`;
}

/** The create dialog says `standard | private`; the API says `public | private`. */
export function privacyForApi(privacy: 'standard' | 'private'): 'public' | 'private' {
  return privacy === 'private' ? 'private' : 'public';
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function channelRailItem(c: SocialChannel): SocialRailItem {
  const preview = optional(c.lastMessagePreview);
  const at = optional(c.lastMessageAt);
  return {
    channel: c.channel,
    kind: 'channel',
    name: c.slug,
    peers: [],
    ...(preview !== undefined ? { lastMessagePreview: preview } : {}),
    ...(at !== undefined ? { lastMessageAt: at } : {}),
  };
}

/**
 * Channels as the rail lists them: the ones the caller is in, then the public
 * ones they could join, each alphabetical — the server's order, re-asserted
 * so the rail never depends on it.
 */
export function channelRailItems(channels: readonly SocialChannel[]): SocialRailItem[] {
  return [...channels]
    .sort((a, b) => Number(b.joined) - Number(a.joined) || a.slug.localeCompare(b.slug))
    .map(channelRailItem);
}

/** A DM's people, named from the roster where the list did not name them; the caller left out. */
export function dmPeers(lobby: string, selfId: string, people: readonly SocialPeer[], known?: readonly SocialPeer[]): SocialPeer[] {
  const names = new Map<string, string>();
  for (const p of people) names.set(p.userId, p.displayName);
  for (const p of known ?? []) names.set(p.userId, p.displayName);
  return dmMembers(lobby).filter((id) => id !== selfId).map((id) => ({ userId: id, displayName: names.get(id) ?? id }));
}

export function dmRailItem(dm: SocialDm): SocialRailItem {
  const preview = optional(dm.lastMessagePreview);
  const at = optional(dm.lastMessageAt);
  return {
    channel: dm.channel,
    kind: dm.peers.length > 1 ? 'group' : 'dm',
    peers: dm.peers,
    ...(preview !== undefined ? { lastMessagePreview: preview } : {}),
    ...(at !== undefined ? { lastMessageAt: at } : {}),
    ...(dm.unreadCount ? { unreadCount: dm.unreadCount } : {}),
  };
}

/**
 * The DM rail: every listed conversation, plus the one open by URL when the
 * list does not carry it yet (a DM just opened, before its first message).
 */
export function dmRailItems(dms: readonly SocialDm[], selected: string | null, selfId: string, people: readonly SocialPeer[]): SocialRailItem[] {
  // The open conversation is being read: its count is about to clear, so it shows none.
  const items = dms.map((dm) => dmRailItem(dm.channel === selected ? { ...dm, unreadCount: 0 } : dm));
  if (selected && selected.startsWith(DM_PREFIX) && !items.some((i) => i.channel === selected)) {
    const peers = dmPeers(selected, selfId, people);
    if (peers.length) items.unshift({ channel: selected, kind: peers.length > 1 ? 'group' : 'dm', peers });
  }
  return items;
}

/** The heading over a DM: the other people's names. */
export function dmTitle(peers: readonly SocialPeer[]): string {
  return peers.length ? peers.map((p) => p.displayName).join(', ') : 'Direct message';
}

/** People the caller can start a DM with — everyone on the social roster but themselves, by name. */
export function dmCandidates(people: readonly SocialPerson[], selfId: string): Array<{ userId: string; displayName: string; hint?: string }> {
  return people
    .filter((p) => p.userId !== selfId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((p) => ({ userId: p.userId, displayName: p.displayName, ...(p.roles.length ? { hint: p.roles.join(', ') } : {}) }));
}

// ── The chat rail's extras (SocialChatWorkspace) ────────────────────────────

/**
 * The DM rows' presence dots: a peer standing in the workspace (on
 * `social:lobby`) is online, anyone else offline. Channel rows carry no peers.
 */
export function withPresence(items: readonly SocialRailItem[], online: ReadonlySet<string>): SocialRailItem[] {
  return items.map((item) => (item.peers.length
    ? { ...item, peers: item.peers.map((p) => ({ ...p, online: online.has(p.userId) })) }
    : item));
}

/** One tile of the rail's "Active now" grid (the library's `ActivePerson`, the fields used here). */
export interface SocialActivePerson {
  userId: string;
  displayName: string;
  status: 'online' | 'away';
}

/**
 * Who is in the workspace right now, from the lobby roster as
 * `presenceAvatarUsers` folds it (one entry per person): everyone but the
 * viewer, online before away, then by name.
 */
export function activeNow(here: ReadonlyArray<{ id: string; name: string; idle?: boolean }>, selfId: string): SocialActivePerson[] {
  return here
    .filter((p) => p.id !== selfId)
    .map((p) => ({ userId: p.id, displayName: p.name, status: p.idle ? 'away' as const : 'online' as const }))
    .sort((a, b) => Number(a.status === 'away') - Number(b.status === 'away') || a.displayName.localeCompare(b.displayName));
}

/** A row matches the rail's find box by its channel name or a person's name. */
export function matchesRailFilter(item: SocialRailItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (item.name ?? '').toLowerCase().includes(q) || item.peers.some((p) => p.displayName.toLowerCase().includes(q));
}

/** The inbox entry fields the rail reads (realtime-modules' `Notification`). */
export interface SocialInboxEntry {
  id: string;
  type: string;
  title: string;
  body?: string;
  timestamp: string;
  read?: boolean;
  channel?: string;
  payload?: Record<string, unknown>;
}

/** Only this workspace's items: the shelf counts and lists what the social tenant sent. */
export function socialInbox<E extends SocialInboxEntry>(entries: readonly E[]): E[] {
  return entries.filter((e) => e.payload?.['tenant'] === 'social');
}

/** A mention as the library's `ChannelMentionsPanel` lists it (`ChannelMentionItem`). */
export interface SocialMention {
  messageId: string;
  channel: string;
  channelLabel?: string;
  author: string;
  excerpt: string;
  at?: string;
  unread?: boolean;
}

/**
 * The Mentions shelf: the inbox's `mention` items (row 5 of the producer
 * table sends one when `@name` in a channel message names you), newest first.
 * The item id stands in for the message id — the notification does not carry
 * one — so a jump lands on the channel, not the line.
 */
export function mentionItems(entries: readonly SocialInboxEntry[]): SocialMention[] {
  return socialInbox(entries)
    .filter((e) => (e.payload?.['kind'] ?? e.type) === 'mention' && typeof e.channel === 'string' && e.channel.length > 0)
    .map((e) => {
      const slug = slugFromChannel(e.channel!);
      const actor = e.payload?.['actorName'];
      return {
        messageId: e.id,
        channel: e.channel!,
        ...(slug ? { channelLabel: `#${slug}` } : {}),
        author: typeof actor === 'string' && actor ? actor : 'Someone',
        excerpt: e.body ?? e.title,
        at: e.timestamp,
        ...(e.read ? {} : { unread: true }),
      };
    })
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/** A recording as the conversation's Calls view lists it (the library's `ChannelRecordingItem`). */
export interface SocialConversationRecording {
  recordingId: string;
  startedAt?: string;
  durationMs?: number;
  participantCount?: number;
  participants?: Array<{ userId: string; displayName?: string }>;
  playable?: boolean;
}

/** The recordings made in one conversation's lobby, newest first. */
export function conversationRecordings(
  recordings: ReadonlyArray<{ recordingId: string; lobbyName: string; startedAt: string; durationMs: number; participantCount?: number; participants: Array<{ userId: string; displayName?: string }>; stage: string }>,
  lobby: string,
): SocialConversationRecording[] {
  return recordings
    .filter((r) => r.lobbyName === lobby)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((r) => ({
      recordingId: r.recordingId,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      participantCount: r.participantCount ?? r.participants.length,
      participants: r.participants,
      playable: r.stage === 'ready',
    }));
}
