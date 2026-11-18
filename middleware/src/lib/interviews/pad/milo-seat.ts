// Milo's seat on an interview's code pad (docs/interviews-tenant-plan.md, "Milo writes test cases").
//
// When the candidate asks Milo for test cases, the server writes them into the pad itself: it opens its own socket to the
// BFF's /ws gateway and edits the shared Yjs document there, exactly as a person's pad does (./milo-writer.ts). That socket
// needs an identity, and the gateway decides every one of its subscribes and writes with the pad's own rule
// (./authority.ts admitPadChannel). This module is that identity and its rule, and nothing else.
//
//   The grant    one write is one grant: an id this process opens just before it connects and closes as soon as the write is
//                acknowledged (or fails), at most MILO_PAD_GRANT_MS later. Grants live in this process's memory only, so a
//                token is good only on the socket this same process opens to itself, only for the one interview the grant
//                names, and only while the write is in flight. Nothing else can open one: there is no route to it.
//   The token    a realtime token (lib/realtime-token.ts) with no tenants, the role `interview-milo` (no tenant has a Cedar
//                file for it), the subject `milo-pad:<grant>` and a `miloPad` claim naming the interview and the grant. The
//                upgrade refuses it when its grant is not open (lib/gateway/auth.ts).
//   The seat     the pad of the grant's interview, while that interview is a technical round that is live and the tenant's
//                flag is on, read fresh on every decision. Every other channel, call frame, lobby read and delivery is
//                refused (lib/gateway/authority.ts answers such a context before anything else).
import { randomBytes } from 'node:crypto';
import { interviewsEnabled } from '../flag.js';
import { interviewsStore } from '../store-select.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { REALTIME_TOKEN_KIND, signRealtimeToken, type RealtimeTokenClaims } from '../../realtime-token.js';

type Context = Record<string, unknown> | null | undefined;

/** The role a Milo pad token carries. No tenant has a Cedar file for it, so every staff rule refuses it as well. */
export const MILO_PAD_ROLE = 'interview-milo';
/** The longest a grant stays open: the writer's three bounds (sync, plan, write), plus a little. */
export const MILO_PAD_GRANT_MS = 60_000;
const SUBJECT_PREFIX = 'milo-pad:';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const GRANT_ID = /^[a-f0-9]{24}$/;

interface Grant { interviewId: string; expiresAtMs: number }
const grants = new Map<string, Grant>();

/** Open a grant for one write to `interviewId`'s pad; close it with `closeMiloPadGrant` once the write is over. */
export function openMiloPadGrant(interviewId: string, nowMs = Date.now()): string {
  if (!INTERVIEW_ID.test(interviewId)) throw new Error('not an interview id');
  for (const [id, g] of grants) if (g.expiresAtMs <= nowMs) grants.delete(id);
  const id = randomBytes(12).toString('hex');
  grants.set(id, { interviewId, expiresAtMs: nowMs + MILO_PAD_GRANT_MS });
  return id;
}

export function closeMiloPadGrant(grantId: string): void { grants.delete(grantId); }

/** Is this grant open now for this interview? */
export function miloPadGrantOpen(grantId: string, interviewId: string, nowMs = Date.now()): boolean {
  const g = grants.get(grantId);
  if (!g || g.interviewId !== interviewId) return false;
  if (g.expiresAtMs <= nowMs) { grants.delete(grantId); return false; }
  return true;
}

/** The claim a Milo pad token carries. */
export interface MiloPadClaim { interviewId: string; grant: string }

/** The token's claims for one grant. */
export function miloPadClaims(claim: MiloPadClaim): RealtimeTokenClaims & { miloPad: MiloPadClaim } {
  return {
    sub: `${SUBJECT_PREFIX}${claim.grant}`, displayName: 'Milo', given_name: 'Milo', family_name: '',
    org: INTERVIEWS_TENANT, tenants: [], role: MILO_PAD_ROLE, tokenKind: REALTIME_TOKEN_KIND,
    miloPad: { interviewId: claim.interviewId, grant: claim.grant },
  };
}

/** Sign the token for one grant (the same secret, issuer and audience as every realtime token). */
export async function mintMiloPadToken(claim: MiloPadClaim, secret: string): Promise<string> {
  return (await signRealtimeToken(miloPadClaims(claim), secret)).token;
}

/** The signed `miloPad` claim's two strings, read from verified claims; undefined when there is none or it is malformed. */
export function miloPadClaimOf(claims: Record<string, unknown>): MiloPadClaim | undefined {
  const c = claims['miloPad'];
  if (!c || typeof c !== 'object') return undefined;
  const { interviewId, grant } = c as Record<string, unknown>;
  return typeof interviewId === 'string' && INTERVIEW_ID.test(interviewId) && typeof grant === 'string' && GRANT_ID.test(grant)
    ? { interviewId, grant } : undefined;
}

/** Does this context claim to be Milo's pad writer in any way (the role, the claim, or the subject)? Such a context gets only the pad. */
export function claimsMiloPad(ctx: Context): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  return ctx['role'] === MILO_PAD_ROLE || ctx['miloPad'] !== undefined || (typeof ctx['userId'] === 'string' && ctx['userId'].startsWith(SUBJECT_PREFIX));
}

/** The Milo pad writer a context stands for, by its claims alone (no I/O); null when it is not a well-formed one. */
export function miloPadOfContext(ctx: Context): MiloPadClaim | null {
  if (!ctx || ctx['role'] !== MILO_PAD_ROLE || ctx['org'] !== INTERVIEWS_TENANT || ctx['act'] !== undefined) return null;
  if (!Array.isArray(ctx['tenants']) || (ctx['tenants'] as unknown[]).length !== 0) return null;
  const claim = miloPadClaimOf(ctx);
  return claim && ctx['userId'] === `${SUBJECT_PREFIX}${claim.grant}` ? claim : null;
}

/** Is this Milo pad context still current: well formed and its grant open? */
export function miloPadContextCurrent(ctx: Context): boolean {
  const claim = miloPadOfContext(ctx);
  return !!claim && miloPadGrantOpen(claim.grant, claim.interviewId);
}

/** May this Milo context read and write `interviewId`'s pad now: its own grant open, the round technical and live, the flag on. */
export async function miloHoldsPadSeat(ctx: Context, interviewId: string): Promise<boolean> {
  const claim = miloPadOfContext(ctx);
  if (!claim || claim.interviewId !== interviewId || !interviewsEnabled()) return false;
  if (!miloPadGrantOpen(claim.grant, interviewId)) return false;
  try {
    const interview = await runWithDbTenant(INTERVIEWS_TENANT, () => interviewsStore().getInterview(interviewId));
    return !!interview && interview.type === 'technical' && interview.state === 'live' && miloPadGrantOpen(claim.grant, interviewId);
  } catch {
    return false;
  }
}
