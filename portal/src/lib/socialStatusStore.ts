// The status you set for Social (status and status line), kept across a reload
// (regression walk, 9 November night, E4).
//
// Presence is per connection: a reload opens a new socket whose gateway entry
// starts empty, so the status line set from /social/profile or voice
// `set_status` vanished and the profile read an empty line back. The shell's
// one presence announcement (components/shell/EmbeddedSocial.tsx) writes what
// is set here and announces it again when it joins, so the footer faces and
// the profile page read it from the same presence metadata as before.
//
// Device storage, keyed to the signed-in user: it is read back only for that
// user, survives a workspace switch (the status is the person's, not the
// workspace's), and is removed when the identity changes (lib/auth.tsx login
// and logout). Every access is wrapped: private mode simply forgets.

export type SocialPresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export interface SavedSocialStatus {
  /** The status set explicitly; absent when only the line was set. */
  status?: SocialPresenceStatus;
  /** The status line; absent when cleared. */
  statusMessage?: string;
}

export const SOCIAL_STATUS_STORAGE_KEY = 'social.status.v1';
const STATUSES: readonly string[] = ['online', 'away', 'busy', 'offline'];

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** What this user last set, or null. */
export function loadSocialStatus(userId: string, store: Store | null = defaultStore()): SavedSocialStatus | null {
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(SOCIAL_STATUS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: unknown; status?: unknown; statusMessage?: unknown };
    if (parsed.userId !== userId) return null;
    const out: SavedSocialStatus = {};
    if (typeof parsed.status === 'string' && STATUSES.includes(parsed.status)) out.status = parsed.status as SocialPresenceStatus;
    if (typeof parsed.statusMessage === 'string' && parsed.statusMessage.trim()) out.statusMessage = parsed.statusMessage;
    return out.status || out.statusMessage ? out : null;
  } catch {
    return null;
  }
}

/** Merge a change into what this user has set: a status, a line, or a cleared line (null). */
export function saveSocialStatus(
  userId: string,
  patch: { status?: SocialPresenceStatus; statusMessage?: string | null },
  store: Store | null = defaultStore(),
): void {
  if (!store || !userId) return;
  const next: SavedSocialStatus = { ...(loadSocialStatus(userId, store) ?? {}) };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.statusMessage !== undefined) {
    if (patch.statusMessage) next.statusMessage = patch.statusMessage;
    else delete next.statusMessage;
  }
  try {
    if (!next.status && !next.statusMessage) store.removeItem(SOCIAL_STATUS_STORAGE_KEY);
    else store.setItem(SOCIAL_STATUS_STORAGE_KEY, JSON.stringify({ userId, ...next }));
  } catch { /* private mode / quota: forget */ }
}

/** Forget it (an identity change). */
export function clearSocialStatus(store: Store | null = defaultStore()): void {
  try { store?.removeItem(SOCIAL_STATUS_STORAGE_KEY); } catch { /* ignore */ }
}
