// The realtime token bridge: an HS256 JWT minted from the signed session
// cookie, for the websocket-gateway's `attachRealtime({ auth })` callback and
// for platform-api's video-session calls (docs/social-calls-plan.md step 3).
//
// Why a separate token at all: the session is an httpOnly cookie scoped to
// this BFF. The gateway and platform-api are other origins that need to know
// who is calling (`sub`, `displayName`, `org` = tenant) without being handed
// the cookie — which carries grants, masquerade provenance and can switch
// identity. This token carries only identity, expires in ten minutes, and is
// minted fresh by GET /api/session/realtime-token.
//
// `tokenKind: 'orgiq-hs256'` lets a client (or a gateway that accepts both)
// tell it apart from a Cognito id_token. The middleware's own gateway on /ws
// (lib/realtime-gateway.ts) verifies it with `verifyRealtimeToken` below.
// realtime-examples' gateway, platform-api and the LVS SFU verify Cognito
// tokens against the pool's JWKS, which this is NOT: locally they run with
// SKIP_AUTH and read these claims, and platform-api and the SFU still need a
// verifier for production (docs/social-calls-deploy-plan.md risk #2).
//
// Secret contract mirrors lib/service-auth.ts: read live from process.env,
// trimmed; unset in production → the route 503s; unset elsewhere → a fixed
// dev secret with a one-time warning, so the local SKIP_AUTH stack works
// without setup.

import { SignJWT, jwtVerify } from 'jose';
import type { Session } from './session.js';

export const REALTIME_TOKEN_TTL_S = 10 * 60;
export const REALTIME_TOKEN_ISSUER = 'orgiq-middleware';
export const REALTIME_TOKEN_AUDIENCE = 'realtime';
export const REALTIME_TOKEN_KIND = 'orgiq-hs256';
export const DEV_REALTIME_SECRET = 'orgiq-dev-realtime';

let warnedDevSecret = false;

/** The signing secret, the dev fallback, or null when signing is unavailable
 * (production with REALTIME_JWT_SECRET unset). */
export function realtimeSigningSecret(): string | null {
  const configured = (process.env['REALTIME_JWT_SECRET'] ?? '').trim();
  if (configured) return configured;
  if (process.env['NODE_ENV'] === 'production') return null;
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn(`[realtime-token] REALTIME_JWT_SECRET is unset — signing with the dev secret '${DEV_REALTIME_SECRET}'. Never use this outside local development.`);
  }
  return DEV_REALTIME_SECRET;
}

export interface RealtimeTokenClaims {
  sub: string;
  displayName: string;
  /** displayName split on its first space — the gateway's SKIP_AUTH bypass
   * builds its name from these and ignores displayName. Family may be ''. */
  given_name: string;
  family_name: string;
  /** Present when the directory has one; the SKIP_AUTH gateway reads it. */
  email?: string;
  org: string;
  tenants: string[];
  role: string;
  /** Session generation, checked by stateful BFF collaboration endpoints. */
  epoch?: number;
  tokenKind: typeof REALTIME_TOKEN_KIND;
  /** The Cognito subject, when the user has signed in via SSO. */
  external_sub?: string;
  /** The real identity while masquerading, like the session cookie's `act`. */
  act?: { sub: string; epoch?: number };
  /** The directory's avatar (app_users / linked people.avatar_url). The
   * gateway stamps it on presence and chat sender identity, so peers render a
   * face instead of initials. Cosmetic: no authority reads it. */
  avatarUrl?: string;
}

/** An avatar URL safe to put in a claim: a same-origin path or an https URL, bounded. */
export function claimableAvatarUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return undefined;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return /^https:\/\/[^\s]+$/.test(raw) ? raw : undefined;
}

/** Claims for the session's EFFECTIVE identity (the masqueraded user while
 * masquerading), with the real one in `act`. */
export function realtimeClaims(
  session: Session,
  directory: { externalSub?: string | null; email?: string | null; avatarUrl?: string | null } = {},
): RealtimeTokenClaims {
  const displayName = session.name ?? session.sub;
  const space = displayName.indexOf(' ');
  const { externalSub, email } = directory;
  const avatarUrl = claimableAvatarUrl(directory.avatarUrl);
  return {
    sub: session.sub,
    displayName,
    given_name: space === -1 ? displayName : displayName.slice(0, space),
    family_name: space === -1 ? '' : displayName.slice(space + 1),
    ...(email ? { email } : {}),
    org: session.tenant,
    tenants: Object.keys(session.grants),
    role: session.role,
    epoch: session.epoch ?? 0,
    tokenKind: REALTIME_TOKEN_KIND,
    ...(externalSub ? { external_sub: externalSub } : {}),
    ...(session.act ? { act: { sub: session.act.sub, epoch: session.act.epoch ?? 0 } } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

export async function signRealtimeToken(
  claims: RealtimeTokenClaims,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: string }> {
  const exp = nowS + REALTIME_TOKEN_TTL_S;
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(nowS)
    .setExpirationTime(exp)
    .setIssuer(REALTIME_TOKEN_ISSUER)
    .setAudience(REALTIME_TOKEN_AUDIENCE)
    .sign(new TextEncoder().encode(secret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

// ── Verification (the gateway half: lib/realtime-gateway.ts) ────────────────

/** The subprotocol marker realtime-modules' client offers first; the JWT is
 * the second entry: `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`. */
export const REALTIME_BEARER_PROTOCOL = 'bearer-token-v1';

/**
 * The JWT from a `Sec-WebSocket-Protocol` header, or null when the header is
 * anything other than exactly `bearer-token-v1, <token>`. No fallback to a
 * query string or cookie: a token in the URL lands in access logs, and a
 * cookie-authenticated socket would need the CSRF checks this path avoids.
 */
export function tokenFromSubprotocol(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2 || parts[0] !== REALTIME_BEARER_PROTOCOL) return null;
  return parts[1] ?? null;
}

/**
 * Verify a token this module signed: HS256 only, same secret, `iss`/`aud`
 * checked, `exp` enforced, `tokenKind` must be ours (a Cognito id_token
 * never is). Throws on anything else.
 */
export async function verifyRealtimeToken(token: string, secret: string): Promise<RealtimeTokenClaims> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    issuer: REALTIME_TOKEN_ISSUER,
    audience: REALTIME_TOKEN_AUDIENCE,
  });
  if (payload['tokenKind'] !== REALTIME_TOKEN_KIND) throw new Error('not an orgiq realtime token');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject');
  if (typeof payload['org'] !== 'string' || !payload['org']) throw new Error('token has no org');
  if (payload['epoch'] !== undefined && (!Number.isSafeInteger(payload['epoch']) || Number(payload['epoch']) < 0)) throw new Error('invalid session epoch');
  const actor = payload['act'] as { sub?: unknown; epoch?: unknown } | undefined;
  if (actor && (typeof actor.sub !== 'string' || !actor.sub
    || (actor.epoch !== undefined && (!Number.isSafeInteger(actor.epoch) || Number(actor.epoch) < 0)))) throw new Error('invalid actor provenance');
  return payload as unknown as RealtimeTokenClaims;
}
