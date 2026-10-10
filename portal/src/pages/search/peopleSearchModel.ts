import type { SearchRecord } from './searchTypes.ts';

export interface SearchPersonAvatar { id: string; name: string; avatarUrl?: string | null }
export interface SearchPersonUser { personId: string; userId: string }
export interface SearchPersonPresence { id: string; idle?: boolean }

export interface SearchPeoplePresentation {
  avatars: readonly SearchPersonAvatar[];
  users: readonly SearchPersonUser[];
  present: readonly SearchPersonPresence[];
  /** Only true for the current actor's authenticated shell presence snapshot. */
  presenceReady: boolean;
}

/** The graph's office/remote/away field and heartbeat timestamps are deliberately
 * absent: neither tells us when a person was last online. Missing live entries
 * remain unknown, because this roster describes Social workspace presence. */
export function presentSearchPerson<T extends SearchRecord>(record: T, source: SearchPeoplePresentation): T {
  if (record.type !== 'person') return record;
  const portrait = source.avatars.find(person => person.id === record.id && person.name === record.title)?.avatarUrl;
  const avatarUrl = record.avatarUrl?.trim() || portrait?.trim();
  const users = source.users.filter(user => user.personId === record.id);
  const userId = users.length === 1 ? users[0]?.userId : undefined;
  // Several sockets can belong to one signed person. Any active socket wins.
  const live = source.presenceReady && userId ? source.present.filter(person => person.id === userId) : [];
  const label = live.length ? live.some(person => !person.idle) ? 'Online' : 'Away' : undefined;
  return { ...record,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(label ? { subtitle: [record.subtitle, label].filter(Boolean).join(' · ') } : {}),
  };
}

/** Malformed or ambiguous identity mappings never turn names into presence. */
export function readSearchPersonUsers(raw: unknown): SearchPersonUser[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { users?: unknown }).users)) return [];
  return (raw as { users: unknown[] }).users.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const { personId, userId } = row as Record<string, unknown>;
    return typeof personId === 'string' && personId && typeof userId === 'string' && userId
      ? [{ personId, userId }] : [];
  });
}

export function readSearchPersonAvatars(raw: unknown): SearchPersonAvatar[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { nodes?: unknown }).nodes)) return [];
  return (raw as { nodes: unknown[] }).nodes.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const { id, name, avatarUrl } = row as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' && typeof avatarUrl === 'string' && avatarUrl.trim()
      ? [{ id, name, avatarUrl }] : [];
  });
}
