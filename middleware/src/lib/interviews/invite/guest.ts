// The guest principal (docs/interviews-tenant-plan.md, row I2.1; decision 3; "I0.7 answer", "The guest's seat").
//
// The candidate is not a user. A guest is the only identity in the product with no grant anywhere, so it
// starts refused everywhere and this file opens nothing: it only says who the guest is.
//
//   Its own cookie   `interviews.guest`, httpOnly, SameSite=Strict, path /api/interview-invite. Never the
//                    staff session's: a recruiter who opens a candidate's link keeps their own session,
//                    and a guest cookie never reads as a staff session (its signed payload has no `sub` or
//                    `role`, so lib/session.ts verifySession refuses it, and it carries a kind of its own).
//   One invite       the cookie names one invite and one guest session. On EVERY request the invite is
//                    loaded again and the guest is refused the moment it is dead (rules.ts), or the moment a
//                    newer exchange of the same link replaced this session.
//   No tenant        not a Session at all: `req.session` stays empty, and lib/session.ts marks a request that
//                    carries only a guest cookie so the demo fallback never hands it the demo identity. So
//                    every existing gate (requireSession, requireTenant, requireAction) refuses it unchanged.
//                    Its realtime role, `interview-guest`, has no Cedar file (realtime.ts).
//
// `requireGuest` is the one guard, used only by the guest routes (routes/interview-invite.ts).

import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { GUEST_COOKIE_NAME, cookieSecure, signValue, verifyValue } from '../../session.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewsStore } from '../store-select.js';
import type { Interview } from '../types.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { inviteDeadReason } from './rules.js';
import { inviteStore, type Invite } from './store.js';
import { sameHash } from './token.js';

export { GUEST_COOKIE_NAME };
/** The guest routes' prefix, and the only path the browser sends the guest cookie to. */
export const GUEST_COOKIE_PATH = '/api/interview-invite';
/** A guest cookie is good for at most this long; the invite's own expiry ends it sooner. */
export const GUEST_SESSION_MAX_AGE_S = 12 * 60 * 60;
/** The role a guest's realtime token names. No tenant has a Cedar file for it. */
export const GUEST_ROLE = 'interview-guest';
const KIND = 'interview-guest';

/** Who a guest is, re-read from the invite on every request. No tenant, no grants, one interview. */
export interface GuestPrincipal {
  kind: 'interview-guest';
  inviteId: string;
  interviewId: string;
  role: typeof GUEST_ROLE;
  tenant: null;
  grants: Record<string, never>;
  /** When this guest session began (the exchange). */
  since: string;
}

interface GuestCookie { k: typeof KIND; inv: string; sid: string; iat: number }

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireGuest on the guest routes only. Never read by a staff route. */
    guest?: GuestPrincipal;
  }
}

export const hashGuestSession = (sid: string): string => createHash('sha256').update(sid).digest('hex');

/** Start a guest session for `invite`: a fresh session id whose hash the exchange stores on the invite. */
export function newGuestSession(): { sid: string; sessionHash: string } {
  const sid = randomBytes(32).toString('base64url');
  return { sid, sessionHash: hashGuestSession(sid) };
}

export async function setGuestCookie(res: Response, inviteId: string, sid: string, expiresAt: string, now = Date.now()): Promise<void> {
  const value: GuestCookie = { k: KIND, inv: inviteId, sid, iat: Math.floor(now / 1000) };
  const maxAge = Math.max(0, Math.min(GUEST_SESSION_MAX_AGE_S * 1000, Date.parse(expiresAt) - now));
  res.cookie(GUEST_COOKIE_NAME, await signValue(value), {
    httpOnly: true, sameSite: 'strict', secure: cookieSecure(res), maxAge, path: GUEST_COOKIE_PATH,
  });
}

export function clearGuestCookie(res: Response): void {
  res.clearCookie(GUEST_COOKIE_NAME, { path: GUEST_COOKIE_PATH });
}

/** The guest cookie's raw value, if the request carries one. */
export function guestCookieOf(req: Request): string | undefined {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[GUEST_COOKIE_NAME];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** The guest the cookie stands for now, with its invite and interview; null for anything dead or forged. */
export async function loadGuest(raw: string | undefined, now = new Date()):
  Promise<{ principal: GuestPrincipal; invite: Invite; interview: Interview } | null> {
  if (!raw) return null;
  const c = await verifyValue<Partial<GuestCookie>>(raw);
  if (!c || c.k !== KIND || typeof c.inv !== 'string' || typeof c.sid !== 'string' || typeof c.iat !== 'number') return null;
  const age = now.getTime() / 1000 - c.iat;
  if (age < -60 || age > GUEST_SESSION_MAX_AGE_S) return null;
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const invite = await inviteStore().getInvite(c.inv!);
    if (!invite || !invite.sessionHash || !sameHash(invite.sessionHash, hashGuestSession(c.sid!))) return null;
    const interview = (await interviewsStore().listInterviews()).find((i) => i.id === invite.interviewId) ?? null;
    if (inviteDeadReason(invite, interview, now) !== null || !interview) return null;
    const principal: GuestPrincipal = {
      kind: 'interview-guest', inviteId: invite.id, interviewId: interview.id, role: GUEST_ROLE, tenant: null, grants: {},
      since: new Date(c.iat! * 1000).toISOString(),
    };
    return { principal, invite, interview };
  });
}

/** The answer for every guest refusal: a dead link, a replaced session, no cookie, a staff session. */
export const GUEST_REFUSAL = { error: 'This link no longer works.' } as const;

/**
 * The guard for the guest routes, and only those. Reads only the guest cookie (a staff session is not a
 * guest), loads the guest again, and refuses with the one not-found answer when there is none.
 */
export function requireGuest() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = guestCookieOf(req);
      const loaded = await loadGuest(raw);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!loaded) {
        if (raw) clearGuestCookie(res);
        res.status(404).json(GUEST_REFUSAL);
        return;
      }
      req.guest = loaded.principal;
      runWithDbTenant(INTERVIEWS_TENANT, () => next());
    } catch (error) {
      next(error);
    }
  };
}

