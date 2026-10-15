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
