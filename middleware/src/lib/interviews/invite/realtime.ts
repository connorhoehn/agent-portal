// The guest's realtime token: BUILT, NOT SERVED (docs/interviews-tenant-plan.md, "I0.7 answer", "The guest's seat").
//
// The token bridge's claims (lib/realtime-token.ts) for a guest: no tenants, the `interview-guest` role (no
// tenant has a Cedar file for it), and a `guest` claim naming its one interview and invite. Signed with the
// same secret, issuer and audience as a staff token, so it verifies wherever one does.
//
// That is why no route hands one out yet. Today such a token is a valid identity on EVERY platform-api
// route, and this middleware's own gateway refuses it on every channel only because the directory has no
// user for its subject (getLivePrincipal). Row I2.2 serves it, in the same change that teaches platform-api
// to refuse a guest claim outside its video session and teaches this middleware's gateway to load a guest
// principal from its invite for the `interviews:interview:<id>` lobby, its call chat and the pad.
//
// `org` is `interviews`: the video session the guest will join belongs to the interviews tenant, and the
// verifier requires a non-empty org. It is not a grant: `tenants` is empty and the role holds no action.
import { REALTIME_TOKEN_KIND, signRealtimeToken, type RealtimeTokenClaims } from '../../realtime-token.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { GUEST_ROLE, type GuestPrincipal } from './guest.js';

/** The name the panel sees for the guest. Nothing from the candidate's record rides in the token. */
export const GUEST_DISPLAY_NAME = 'Candidate';

export interface GuestRealtimeClaims extends RealtimeTokenClaims {
  role: typeof GUEST_ROLE;
  tenants: [];
  guest: { interviewId: string; inviteId: string };
}

/** The subject a guest's token names: one per invite, never an app user id. */
export const guestSubject = (inviteId: string): string => `guest:${inviteId}`;

export function guestRealtimeClaims(guest: GuestPrincipal): GuestRealtimeClaims {
  return {
    sub: guestSubject(guest.inviteId),
    displayName: GUEST_DISPLAY_NAME,
    given_name: GUEST_DISPLAY_NAME,
    family_name: '',
    org: INTERVIEWS_TENANT,
    tenants: [],
    role: GUEST_ROLE,
    epoch: 0,
    tokenKind: REALTIME_TOKEN_KIND,
    guest: { interviewId: guest.interviewId, inviteId: guest.inviteId },
  };
}

/** Mint a guest's realtime token. Not mounted on any route until row I2.2 (see the header). */
export async function mintGuestRealtimeToken(guest: GuestPrincipal, secret: string, nowS?: number): Promise<{ token: string; expiresAt: string }> {
  return signRealtimeToken(guestRealtimeClaims(guest), secret, nowS);
}
