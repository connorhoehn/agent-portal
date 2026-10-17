// Socket admission for the /ws gateway: the upgrade's auth callback and the
// socket context a verified realtime token stands for. No channel or lobby
// rule lives here — that is lib/gateway/authority.ts.
//
// Auth runs once, at upgrade (the library answers 401 when it throws):
//   1. the browser Origin allowlist, as every other browser-facing path;
//   2. `Sec-WebSocket-Protocol` must be exactly `bearer-token-v1, <jwt>` —
//      no query-string or cookie fallback;
//   3. the JWT verifies against REALTIME_JWT_SECRET (HS256, iss/aud/exp,
//      tokenKind 'orgiq-hs256').
// The resulting context — `{ userId: sub, displayName, org, tenants, role }` —
// is what the router routes rings by (`getClientsByUserId`) and what the
// current-principal preflight sees. Token expiry itself is verified at
// upgrade; the portal re-fetches on drops.

import type { IncomingMessage } from 'node:http';
import { bearerSubprotocolAuth } from '@connorhoehn/realtime-modules/server';
import { isAllowedBrowserOrigin } from '../browser-origin.js';
import { upgradeScheme } from '../trusted-proxy.js';
import { claimableAvatarUrl, realtimeSigningSecret, verifyRealtimeToken, type RealtimeTokenClaims } from '../realtime-token.js';

export interface RealtimeGatewayAuth {
  userId: string;
  displayName: string;
  org: string;
  tenants: string[];
  role: string;
  [key: string]: unknown;
}

/** REALTIME_GATEWAY=on|off; unset → on unless NODE_ENV=production. */
export function realtimeGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['REALTIME_GATEWAY'] ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return env['NODE_ENV'] !== 'production';
}

/**
 * The library's bearer-subprotocol admission (realtime-modules 0.116
 * `bearerSubprotocolAuth`): the Origin check when the upgrade carries one, the
 * exact two-entry `bearer-token-v1, <jwt>` header, then this host's
 * verification. A verified identity without a user id is refused.
 */
const bearerAuth = bearerSubprotocolAuth<RealtimeGatewayAuth>({
  // The viewer's scheme behind the declared proxies (lib/trusted-proxy.ts).
  allowOrigin: (origin, req) => isAllowedBrowserOrigin(origin, `${upgradeScheme(req)}://${req.headers.host ?? ''}`),
  verify: async token => {
    const secret = realtimeSigningSecret();
    if (!secret) throw new Error('realtime token verification unavailable');
    return gatewayAuthFromClaims(await verifyRealtimeToken(token, secret));
  },
});

/**
 * The upgrade's auth callback. Throws to refuse (the library answers 401).
 */
export async function authenticateGatewayUpgrade(req: IncomingMessage): Promise<RealtimeGatewayAuth> {
  return await bearerAuth(req) as RealtimeGatewayAuth;
}

/** The socket context a verified realtime token stands for — the same shape
 * the upgrade hands the router, reused by POST /api/realtime/lobby-access
 * (routes/realtime-lobby-access.ts) so platform-api's question is asked of
 * exactly the identity the gateway would admit. */
export function gatewayAuthFromClaims(claims: RealtimeTokenClaims): RealtimeGatewayAuth {
  return {
    userId: claims.sub,
    displayName: typeof claims.displayName === 'string' && claims.displayName ? claims.displayName : claims.sub,
    org: claims.org,
    tenants: Array.isArray(claims.tenants) ? claims.tenants.filter((t): t is string => typeof t === 'string') : [],
    role: typeof claims.role === 'string' ? claims.role : '',
    epoch: claims.epoch ?? 0,
    sessionIat: Number((claims as unknown as { iat?: number }).iat) || 0,
    ...(claims.act ? { act: { sub: claims.act.sub, epoch: claims.act.epoch ?? 0 } } : {}),
    // Presence and chat stamp `avatarUrl` off this context (the library's
    // default resolveSender), so a peer's face comes from the signed token.
    ...(claimableAvatarUrl(claims.avatarUrl) ? { avatarUrl: claimableAvatarUrl(claims.avatarUrl) } : {}),
  };
}
