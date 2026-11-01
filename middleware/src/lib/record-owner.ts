// Whose records a signed-in user owns.
//
// An identity clone (mock/identity-clones.ts, dev:mock only) is a test user
// minted from a seed persona: its own id so its session epoch is its own, the
// persona's grants, person link and name. Rows keyed by USER id — an access
// request's requester, a Social channel membership, a DM lobby, an assessment
// roster row — were written for the persona, so a clone of Rhea saw "You have
// not requested any access yet" and a clone of Mira was outside #general: a
// demo given from a clone showed an empty world (docs/demo-content-goal.md
// rule 4).
//
// The rule, in one place: for RECORD OWNERSHIP a clone acts as its persona.
// Reads ("mine", membership, DM lobbies) and the writes that name an owner use
// `recordUserId`; the session itself (epoch, switch, sign-out-others, the
// realtime token's subject) keeps the clone's own id. Only a live clone maps,
// and only to the one persona it was cloned from, so two different personas
// stay isolated. Outside dev:mock the clone fixture is empty and this is the
// identity function.

import { findClone } from '../mock/identity-clones.js';
import { parseDmLobby } from '@connorhoehn/realtime-modules/call';

/** The user id records are keyed by for `userId`: a live clone's persona, else `userId` itself. */
export function recordUserId(userId: string): string;
export function recordUserId(userId: string | null | undefined): string | null;
export function recordUserId(userId: string | null | undefined): string | null {
  if (!userId) return userId ?? null;
  if (!userId.includes('-clone-')) return userId;
  return findClone(userId)?.from ?? userId;
}

/** Does a row keyed by `rowUserId` belong to `userId` (itself, or the persona it is a clone of)? */
export function ownsRecord(rowUserId: string | null | undefined, userId: string | null | undefined): boolean {
  if (!rowUserId || !userId) return false;
  return rowUserId === userId || rowUserId === recordUserId(userId);
}

/** The chat sender a socket context stands for (the library's `resolveSender`). */
export interface RecordOwnerSender { userId: string; displayName?: string; avatarUrl?: string; org?: string }

/**
 * The realtime chat service's sender for a socket: the library's default
 * mapping (userId, displayName, avatarUrl, org straight off the auth context)
 * with a clone standing as its persona. The chat gate compares this userId
 * with the channel's membership rows and stamps it on what the socket sends,
 * so a clone of Vera is inside #auth-migration and writes as Vera. The socket
 * context itself — and so the live principal's epoch check — keeps the
 * clone's id.
 */
export function recordOwnerSender(ctx: Record<string, unknown>, frame: Record<string, unknown> = {}): RecordOwnerSender | null {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const userId = str(ctx['userId']);
  if (!userId) return null;
  // A disposable DM is owned by the clone itself. The untrusted channel
  // only chooses between the context's own identity and its known persona;
  // it never supplies a different sender or bypasses channel authorization.
  const channel = str(frame['channel']);
  const dm = channel ? parseDmLobby(channel, { prefix: `${channel.split(':', 1)[0]}:` }) : null;
  const ownsDm = dm?.kind === 'dm' && dm.members.includes(userId);
  const displayName = str(ctx['displayName']) ?? str(ctx['name']);
  const avatarUrl = str(ctx['avatarUrl']) ?? str(ctx['picture']);
  const org = str(ctx['org']);
  return {
    userId: ownsDm ? userId : recordUserId(userId),
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(org ? { org } : {}),
  };
}
