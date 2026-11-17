// The guest's realtime token (docs/interviews-tenant-plan.md, rows I2.1 and I2.2; "I0.7 answer", "The guest's seat").
//
// The token bridge's claims (lib/realtime-token.ts) for a guest: no tenants, the `interview-guest` role (no
// tenant has a Cedar file for it), and a `guest` claim naming its one interview, its invite and a tag of its
// guest session. Signed with the same secret, issuer and audience as a staff token, so it verifies wherever
// one does. This middleware's gateway loads such a socket from its INVITE, not the directory
// (lib/interviews/lobby.ts `guestOfContext`), and opens exactly three names for it once the lead has admitted
// it: the interview's lobby, that lobby's call chat and, in a technical round, the pad.
//
// SERVED ONLY WHEN GUEST REALTIME IS ON (`INTERVIEWS_GUEST_REALTIME`, below). Until platform-api refuses a
// guest claim outside its video session (row I2.2's platform-api half), such a token is a valid identity on
// EVERY platform-api route. So the route that hands it out (routes/interview-invite.ts GET /realtime-token),
// and this gateway's acceptance of it, are off everywhere except the mock world, which has no platform-api,
// until a deployer turns the setting on AFTER platform-api's change is deployed. Never default it on elsewhere.
//
// `org` is `interviews`: the video session the guest will join belongs to the interviews tenant, and the
// verifier requires a non-empty org. It is not a grant: `tenants` is empty and the role holds no action.
import { config } from '../../../config.js';
import { REALTIME_TOKEN_KIND, signRealtimeToken, type RealtimeTokenClaims } from '../../realtime-token.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { GUEST_ROLE, type GuestPrincipal } from './guest.js';

/** The name the panel sees for the guest. Nothing from the candidate's record rides in the token. */
export const GUEST_DISPLAY_NAME = 'Candidate';

export interface GuestRealtimeClaims extends RealtimeTokenClaims {
  role: typeof GUEST_ROLE;
  tenants: [];
  guest: { interviewId: string; inviteId: string; session: string };
}

/**
 * INTERVIEWS_GUEST_REALTIME: may a guest hold a realtime token at all? `true`/`1` on, `false`/`0` off. Unset, on
 * only in the mock world (MOCK_AURORA: dev:mock, the walks), where no platform-api exists to misuse it. Read
 * per request. See the header for why it must stay off until platform-api refuses guest claims.
 */
export function guestRealtimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env['INTERVIEWS_GUEST_REALTIME'] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return config.mock?.aurora === true;
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
    guest: { interviewId: guest.interviewId, inviteId: guest.inviteId, session: guest.sessionTag },
  };
}

/** Mint a guest's realtime token. Served only while `guestRealtimeEnabled()` (see the header). */
export async function mintGuestRealtimeToken(guest: GuestPrincipal, secret: string, nowS?: number): Promise<{ token: string; expiresAt: string }> {
  return signRealtimeToken(guestRealtimeClaims(guest), secret, nowS);
}
