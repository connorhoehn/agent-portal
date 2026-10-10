// The ONE Social permission path (docs/audit/2026-10-07-audit-plan.md D1).
//
// Three gates used to sit over the same Social handlers — `requireAction` on
// the tenant router (cookie grants, up to 120 s stale), `planeAction` on
// /api/social/plane (current directory grants) and `embedGate` on the bindings
// and DM routes (a third mix of both) — and a request-scoped WeakSet let the
// personal-team routes trust whichever gate had run. They could disagree for
// a whole grants-refresh window. Now every mount asks this module, and the
// verdict for one (user, action, epoch) is the same on every URL:
//
//   1. the signed session's provenance, then the directory's CURRENT row for
//      the user and, while masquerading, for the actor (`currentLiveSession`:
//      epoch match, the signed role still granted in the signed tenant, the
//      actor still an admin) — no directory outage or missing user falls back
//      to a seed account;
//   2. the action asked against EVERY Social role the directory grants the user
//      (`socialActionRole`), never the signed role alone — a session standing
//      in orgiq with `social: participant` may read, one holding no Social
//      grant may not, whatever its cookie claims;
//   3. a second directory read after the policy call, so a grant revoked or an
//      epoch bumped while the policy I/O was in flight refuses;
//   4. optionally a current grant in a second tenant (the bindings routes:
//      the context's tenant).
//
// No cache: every request re-reads the directory (the rule the plane already
// followed). The tenant mount keeps `requireTenant('social')` in front — that
// is the data boundary (a session parked elsewhere is refused before any
// handler), not a permission check — and the gateway's channel and lobby
// guards are unchanged. Handlers that read after the gate recheck with
// `currentSocialActionSession` before answering, as before.

import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler, SessionInvalidError } from './async-handler.js';
import { currentLiveSession, socialActionRole } from './live-principal.js';
import type { Session } from './session.js';

export const SOCIAL_GATE_REFUSAL = 'Your Social grants do not allow this action';

/** The actor's current Social authority for `action`: the fresh session, or 401/403/503. */
export async function currentSocialActionSession(session: Session, action: string | readonly string[]): Promise<Session> {
  const current = await currentLiveSession(session);
  const actions = typeof action === 'string' ? [action] : action;
  const roles: string[] = [];
  for (const a of actions) {
    const role = await socialActionRole(current, a);
    if (role === null) throw new AppError(403, SOCIAL_GATE_REFUSAL);
    roles.push(role);
  }
  // A policy call can outlive directory revocation. Recheck provenance and
  // the exact roles whose policies allowed the actions after that await.
  const latest = await currentLiveSession(current);
  if (roles.some(role => !latest.grants.social?.includes(role))) throw new AppError(403, SOCIAL_GATE_REFUSAL);
  return latest;
}

export interface SocialAuthorityNeeds {
  /** A current grant in this tenant as well (the bindings routes: the context's tenant). */
  grantIn?: string | null;
}

export class TenantGrantRefusal extends AppError {
  constructor(readonly requiredTenant: string) { super(403, 'Forbidden'); }
}

/** `currentSocialActionSession`, plus the second-tenant grant when asked. */
export async function currentSocialAuthority(session: Session, action: string | readonly string[], needs: SocialAuthorityNeeds = {}): Promise<Session> {
  const current = await currentSocialActionSession(session, action);
  if (needs.grantIn && !(current.grants[needs.grantIn]?.length)) throw new TenantGrantRefusal(needs.grantIn);
  return current;
}

export type SocialGateAction = string | readonly string[] | ((req: Request) => string | readonly string[]);
export interface SocialGateOptions {
  /** The second tenant a request needs a grant in, read from the request (a validation error here is the route's 400). */
  grantIn?: (req: Request) => string;
}

/**
 * The Express form: resolves the current authority and replaces `req.session`
 * with the fresh directory-backed session, so every handler behind it reads
 * current grants and the directory's display name. A refusal names what was
 * missing (`requiredTenant`, `action`) the way the old gates did. The signed
 * cookie only: the cookie-less dev persona holds no Social grant by design
 * (docs/social-tenant-design.md §4.1), so no session is 401 here, never a
 * demo identity.
 */
export function socialGate(action: SocialGateAction, opts: SocialGateOptions = {}): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const signed = req.session;
    if (!signed) throw new SessionInvalidError('Unauthenticated');
    const asked = typeof action === 'function' ? action(req) : action;
    const grantIn = opts.grantIn ? opts.grantIn(req) : null;
    try {
      req.session = await currentSocialAuthority(signed, asked, { grantIn });
    } catch (error) {
      if (error instanceof TenantGrantRefusal) {
        res.status(403).json({ error: 'Forbidden', requiredTenant: error.requiredTenant, tenant: signed.tenant });
        return;
      }
      if (error instanceof AppError && error.status === 403) {
        const named = typeof asked === 'string' ? asked : asked[asked.length - 1];
        res.status(403).json({ error: error.message, requiredTenant: 'social', ...(named ? { action: named } : {}), tenant: signed.tenant });
        return;
      }
      throw error;
    }
    next();
  });
}
