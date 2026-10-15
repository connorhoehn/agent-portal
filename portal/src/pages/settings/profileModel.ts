// The Settings → Profile section's model (plan D7). No React; unit-tested alone.
//
// This is where the Mine view's "Check profile" lands (/settings#profile), so
// it has to answer the one question that sent the reader here: is my account
// connected to a team profile, and if not, who can fix it?
//
// Three reads, each of which can fail on its own:
//   GET /api/session/me        — who is signed in
//   GET /api/session/person    — {linked, personId}
//   GET /api/graph/people/:id  — the connected person's name
//
// The rule that matters (honest-numbers class 3): a failed person read is an
// error, never "Not connected". Saying "not connected" when we could not ask
// would send someone to an admin to fix a link that may be fine.

export interface Read<T> {
  data: T | null | undefined;
  error?: string | null;
}

export interface SessionMe {
  sub: string;
  name?: string | null;
}

export interface SessionPerson {
  linked: boolean;
  personId: string | null;
}

export interface PersonName {
  name?: string | null;
}

export interface ProfileInput {
  me: Read<SessionMe>;
  person: Read<SessionPerson>;
  /** Only read once `person` says linked; null/undefined until then. */
  personDetail?: Read<PersonName>;
  /** ManageUsers — hr-admin (and admin) can connect accounts themselves. */
  canManageUsers: boolean;
}

export const PROFILE_ANCHOR = 'profile';
export const IDENTITY_USERS_HREF = '/admin/identity/users';

export type SignedIn =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ok'; label: string };

export type Connection =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'unlinked'; text: string; hint: string }
  | {
      state: 'linked';
      personId: string;
      /** The person's name; null when the name read failed or is in flight. */
      name: string | null;
      text: string;
      /** Set when the name read failed — the link is real, the label is the id. */
      nameError: string | null;
    };

export interface ProfileModel {
  signedIn: SignedIn;
  connection: Connection;
  /** Present only for ManageUsers. */
  identityAction: { label: string; href: string } | null;
}

export const UNLINKED_TEXT = 'Not connected to a team profile';

/** "Theo Chang" — the name; the account id only when there is no name to print.
 *  A dev:mock clone's `u-theo-clone-ab12cd34` is not something a peer should read. */
export function signedInLabel(me: SessionMe): string {
  const name = me.name?.trim();
  return name || me.sub;
}

export function buildProfile(input: ProfileInput): ProfileModel {
  const signedIn: SignedIn = input.me.error
    ? { state: 'error', error: input.me.error }
    : input.me.data == null
      ? { state: 'loading' }
      : { state: 'ok', label: signedInLabel(input.me.data) };

  const identityAction = input.canManageUsers
    ? { label: 'Open Identity → Users', href: IDENTITY_USERS_HREF }
    : null;

  return { signedIn, connection: buildConnection(input), identityAction };
}

function buildConnection(input: ProfileInput): Connection {
  if (input.person.error) return { state: 'error', error: input.person.error };
  const person = input.person.data;
  if (person == null) return { state: 'loading' };

  if (!person.linked || !person.personId) {
    return {
      state: 'unlinked',
      text: UNLINKED_TEXT,
      hint: input.canManageUsers
        ? 'Your "Mine" views stay empty until this account is connected. You can connect it in Identity → Users.'
        : 'Your "Mine" views stay empty until this account is connected. A workspace admin can help connect it.',
    };
  }

  const detail = input.personDetail;
  const nameError = detail?.error ?? null;
  const name = nameError ? null : detail?.data?.name?.trim() || null;
  return {
    state: 'linked',
    personId: person.personId,
    name,
    nameError,
    text: name ? `Connected to ${name}` : 'Connected to a team profile',
  };
}
