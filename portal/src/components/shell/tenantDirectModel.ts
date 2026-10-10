// The tenant-neutral shell presence/DM entry, as data. A session with no
// Social grant still shares its active tenant with other people: the BFF lists
// them (`GET /api/people/shared`), the gateway admits `<tenant>:lobby` for
// presence and `<tenant>:dm:<sorted ids>` for the conversation (middleware
// lib/tenant-channels.ts, realtime-gateway.ts lobbyGuard). Nothing here
// trusts a name the server did not hand back.

export interface SharedPerson { userId: string; displayName: string; avatarUrl?: string }
export interface SharedPeople {
  tenant: string; me: SharedPerson; lobby: string; dmPrefix: string; people: SharedPerson[];
}

const person = (value: unknown): SharedPerson | null => {
  if (!value || typeof value !== 'object') return null;
  const { userId, displayName, avatarUrl } = value as Record<string, unknown>;
  if (!(typeof userId === 'string' && userId && typeof displayName === 'string')) return null;
  // A face is optional: anything but a non-empty string reads as "initials".
  return { userId, displayName: displayName || userId, ...(typeof avatarUrl === 'string' && avatarUrl ? { avatarUrl } : {}) };
};

/** Accepts only a well-formed response whose names belong to its own tenant. */
export function readSharedPeople(value: unknown): SharedPeople | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const tenant = typeof raw.tenant === 'string' ? raw.tenant : '';
  const me = person(raw.me);
  if (!tenant || !me || raw.lobby !== `${tenant}:lobby` || raw.dmPrefix !== `${tenant}:dm:` || !Array.isArray(raw.people)) return null;
  const people = raw.people.map(person).filter((p): p is SharedPerson => !!p && p.userId !== me.userId);
  return { tenant, me, lobby: raw.lobby, dmPrefix: raw.dmPrefix, people };
}

/** `<tenant>:dm:<sorted, distinct ids>` — the same name for both people. */
export function tenantDmChannel(dmPrefix: string, ids: readonly string[]): string {
  return `${dmPrefix}${[...new Set(ids)].sort().join(':')}`;
}

/** Online people from a presence roster, limited to the listed directory. */
export function onlineIds(roster: ReadonlyArray<{ status?: string; metadata?: Record<string, unknown> }>, people: readonly SharedPerson[]): Set<string> {
  const known = new Set(people.map(p => p.userId));
  const out = new Set<string>();
  for (const entry of roster) {
    const id = entry.metadata?.['userId'];
    if (typeof id === 'string' && known.has(id) && (!entry.status || entry.status === 'online')) out.add(id);
  }
  return out;
}

export interface DmConversation {
  channel: string; peer: SharedPerson; lastMessageAt: string | null; lastMessagePreview: string | null; unreadCount: number;
}

/**
 * Reads `GET /api/people/conversations`. Keeps only 1:1 rows whose channel is
 * exactly this tenant's DM name for me + that peer; anything else is dropped.
 */
export function readConversations(value: unknown, directory: SharedPeople | null): DmConversation[] {
  if (!directory || !value || typeof value !== 'object') return [];
  const raw = value as Record<string, unknown>;
  if (raw.tenant !== directory.tenant || !Array.isArray(raw.conversations)) return [];
  const out: DmConversation[] = [];
  for (const item of raw.conversations) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const peers = Array.isArray(c.peers) ? c.peers.map(person).filter((p): p is SharedPerson => !!p) : [];
    const peer = peers.length === 1 ? peers[0]! : null;
    if (!peer || peer.userId === directory.me.userId || c.channel !== tenantDmChannel(directory.dmPrefix, [directory.me.userId, peer.userId])) continue;
    out.push({ channel: c.channel, peer,
      lastMessageAt: typeof c.lastMessageAt === 'string' ? c.lastMessageAt : null,
      lastMessagePreview: typeof c.lastMessagePreview === 'string' ? c.lastMessagePreview : null,
      unreadCount: typeof c.unreadCount === 'number' && c.unreadCount > 0 ? Math.floor(c.unreadCount) : 0 });
  }
  return out;
}
