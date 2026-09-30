// Search → Message (docs/social-tenant-design.md §4.6, lane E): the people
// selection on the connections tab opens a DM in the social tenant with the
// selected person's linked user. Pure, so `node --test` covers every reason
// the button can be off without a browser.
//
// A DM is one-to-one: exactly one person, mapped person → user by
// GET /api/roster/users (whose `social` flag says whether that user holds a
// social grant — the only people a social DM reaches). The lobby is the
// library's `dmLobbyName([you, them], { prefix: 'social:' })`, which is the
// same sorted name the BFF answers from POST /api/social/dms.

import { dmLobbyName } from '@connorhoehnslalom/realtime-modules/client/video';
import type { CallPerson, RosterUser } from '../../lib/conversationCallModel';

export const SOCIAL_LOBBY_PREFIX = 'social:';

export type MessageAvailability =
  | { ok: true; target: { userId: string; displayName: string }; lobby: string; reason: string }
  | { ok: false; reason: string };

export function messageAvailability(input: {
  people: CallPerson[];
  /** GET /api/roster/users' `users`; null while it loads. */
  users: RosterUser[] | null;
  selfUserId: string | null;
}): MessageAvailability {
  const { people, users, selfUserId } = input;
  if (people.length === 0) return { ok: false, reason: 'Select a person to message' };
  if (people.length > 1) return { ok: false, reason: 'A direct message is one-to-one — select one person to message' };
  if (!users || !selfUserId) return { ok: false, reason: 'Looking up who signs in as this person…' };
  const person = people[0]!;
  const user = users.find((u) => u.personId === person.personId);
  if (!user) return { ok: false, reason: `${person.name} has no OrgIQ sign-in, so there is no one to message` };
  if (user.userId === selfUserId) return { ok: false, reason: 'You are the only person selected — pick someone else to message' };
  if (user.social === false) return { ok: false, reason: `${user.displayName || person.name} is not in Social, so a direct message would not reach them` };
  const displayName = user.displayName || person.name;
  return {
    ok: true,
    target: { userId: user.userId, displayName },
    lobby: dmLobbyName([selfUserId, user.userId], { prefix: SOCIAL_LOBBY_PREFIX }),
    reason: `Message ${displayName} in Social`,
  };
}

/** Where the DM opens: the social tenant's DM page for that lobby. */
export function dmPageHref(lobby: string): string {
  return `/social/dms/${encodeURIComponent(lobby)}`;
}
