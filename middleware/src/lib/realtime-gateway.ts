// The OrgIQ middleware as its own realtime gateway (docs/social-calls-plan.md
// step 7, deploy-plan risk #2 — the gateway half).
//
//   ws(s)://<middleware>/ws     Sec-WebSocket-Protocol: bearer-token-v1, <jwt>
//   features: chat, presence, calls (+ the library's built-in subscribe)
//
// Why here and not realtime-examples' gateway container: that server verifies
// Cognito id_tokens (or runs with SKIP_AUTH, which trusts any claims), and it
// cannot scope a lobby to a tenant. Serving the socket from the BFF makes the
// identity OUR token — the HS256 realtime token `GET /api/session/realtime-token`
// mints (lib/realtime-token.ts) — and lets `calls({ lobbyGuard })` refuse any
// lobby outside the caller's tenant.
//
// Auth runs once, at upgrade (the library answers 401 when it throws):
//   1. the browser Origin allowlist, as every other browser-facing path;
//   2. `Sec-WebSocket-Protocol` must be exactly `bearer-token-v1, <jwt>` —
//      no query-string or cookie fallback;
//   3. the JWT verifies against REALTIME_JWT_SECRET (HS256, iss/aud/exp,
//      tokenKind 'orgiq-hs256').
// The resulting context — `{ userId: sub, displayName, org, tenants, role }` —
// is what the router routes rings by (`getClientsByUserId`) and what
// `lobbyGuard` sees. Like lib/distillation-realtime.ts, an open socket is not
// re-checked: a token that expires mid-connection keeps its socket until it
// reconnects, and the portal re-fetches a token on every drop.
//
// Tenant scoping, and what it does NOT cover yet:
//   - call frames naming a lobby: refused unless the lobby is `<org>:…`, and a
//     `<org>:dm:<ids>` lobby additionally only for one of those ids;
//   - untargeted (broadcast) invites: refused — the library fans those out to
//     every connected client, which would ring across tenants;
//   - chat and presence CHANNELS are not tenant-scoped here: the portal's
//     channel names (`invoke`, section/doc ids) carry no tenant prefix, so
//     that belongs with the presence-directory work in plan step 7.
//
// Enabled by REALTIME_GATEWAY=on|off. Default: on outside production, off in
// production unless set, so the ECS task is unchanged until someone asks.
//
// Call state lives in Redis when REDIS_URL is set (realtime-modules'
// RedisCallStateStore over lib/redis-lite.ts), in memory otherwise. The
// ROUTER is always the library's single-process LocalRealtimeRouter: Redis
// makes call state survive a restart and be shared, but it does not fan
// frames out across replicas — run one task until a Redis-backed router
// exists (the library's recipe names realtime-examples' MessageRouter as the
// reference implementation).

import type { IncomingMessage, Server } from 'node:http';
import { attachRealtime, chat, presence, calls, type RealtimeHandle } from '@connorhoehnslalom/realtime-modules/server';
import { RedisCallStateStore, InMemoryCallStateStore, type CallStateRedis } from '@connorhoehnslalom/realtime-modules/call';
import { isAllowedBrowserOrigin } from './browser-origin.js';
import { realtimeSigningSecret, tokenFromSubprotocol, verifyRealtimeToken } from './realtime-token.js';
import { RedisLite } from './redis-lite.js';

export const REALTIME_GATEWAY_PATH = '/ws';

export type RealtimeGatewayStore = 'redis' | 'memory';

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
 * The upgrade's auth callback. Throws to refuse (the library answers 401).
 */
export async function authenticateGatewayUpgrade(req: IncomingMessage): Promise<RealtimeGatewayAuth> {
  const origin = req.headers.origin;
  if (origin) {
    const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    if (!isAllowedBrowserOrigin(origin, `${proto}://${req.headers.host ?? ''}`)) {
      throw new Error('browser origin is not allowed');
    }
  }
  const token = tokenFromSubprotocol(req.headers['sec-websocket-protocol']);
  if (!token) throw new Error('missing bearer-token-v1 subprotocol');
  const secret = realtimeSigningSecret();
  if (!secret) throw new Error('realtime token verification unavailable');
  const claims = await verifyRealtimeToken(token, secret);
  return {
    userId: claims.sub,
    displayName: typeof claims.displayName === 'string' && claims.displayName ? claims.displayName : claims.sub,
    org: claims.org,
    tenants: Array.isArray(claims.tenants) ? claims.tenants.filter((t): t is string => typeof t === 'string') : [],
    role: typeof claims.role === 'string' ? claims.role : '',
  };
}

/**
 * May this connection use `lobbyName`? Only lobbies prefixed with the
 * caller's own tenant (`<org>:`); a `<org>:dm:<a>:<b>…` lobby (the shape
 * `dmLobbyName(ids, { prefix: '<org>:' })` builds) only when the caller is
 * one of the ids. Anything else under the prefix (a room, an initiative) is
 * open to the tenant.
 */
export function lobbyGuard(auth: { userId?: unknown; org?: unknown }, lobbyName: string): boolean {
  const org = typeof auth.org === 'string' ? auth.org : '';
  const userId = typeof auth.userId === 'string' ? auth.userId : '';
  if (!org || !userId) return false;
  const prefix = `${org}:`;
  if (!lobbyName.startsWith(prefix)) return false;
  const rest = lobbyName.slice(prefix.length);
  if (!rest) return false;
  if (rest === 'dm' || rest.startsWith('dm:')) {
    const ids = rest.slice(3).split(':').filter(Boolean);
    return ids.includes(userId);
  }
  return true;
}

/**
 * May this connection subscribe to / publish on `channel` (chat, presence)?
 * The same rule as lobbies (2026-09-29): only channels prefixed with the
 * caller's own tenant (`<org>:`), and a `<org>:dm:<a>:<b>…` channel only
 * when the caller is one of the ids. Before this, `lobbyGuard` scoped calls
 * only, and every orgiq persona could join `assessment:doc:<id>` — read its
 * history and post into it (assessment isolation walk, 2026-09-29).
 */
export function channelGuard(auth: { userId?: unknown; org?: unknown } | null, channel: string): boolean {
  return auth != null && lobbyGuard(auth, stripServicePrefix(channel));
}

/**
 * The library's services subscribe under their own prefix — `presence:<channel>`,
 * `reactions:<channel>`, `cursor:<channel>`, `chat:<channel>` — and the hook
 * sees that full name. The tenant rule applies to the channel the app named,
 * so the service prefix is stripped first; without this the tenant's own
 * presence was refused (assessment re-audit, 2026-09-29, defect #9).
 */
const SERVICE_PREFIX = /^(presence|reactions|cursor|chat|typing|activity|pins):/;
export function stripServicePrefix(channel: string): string {
  return channel.replace(SERVICE_PREFIX, '');
}

// Typed inline: the library's `ChannelAuthorize` type reaches ts-jest as `any`.
const authorizeChannel = ({ kind, channel, ctx }: { kind: 'subscribe' | 'publish'; clientId: string; channel: string; ctx: { userId?: unknown; org?: unknown } | null }): boolean => {
  const ok = channelGuard(ctx as { userId?: unknown; org?: unknown } | null, channel);
  if (!ok) {
    const who = ctx as Record<string, unknown> | null;
    console.warn(`[realtime-gateway] refused ${kind} on channel '${channel}' for user '${String(who?.['userId'] ?? '?')}' (org '${String(who?.['org'] ?? '?')}')`);
  }
  return ok;
};

function guardWithLog(auth: Record<string, unknown>, lobbyName: string): boolean {
  const ok = lobbyGuard(auth, lobbyName);
  if (!ok) {
    console.warn(`[realtime-gateway] refused lobby '${lobbyName}' for user '${String(auth['userId'] ?? '?')}' (org '${String(auth['org'] ?? '?')}')`);
  }
  return ok;
}

let status: { gateway: 'on' | 'off'; store: RealtimeGatewayStore | null } = { gateway: 'off', store: null };

/** For /api/health. */
export function realtimeGatewayStatus(): typeof status {
  return { ...status };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn('[realtime-gateway]', ...args),
  error: (...args: unknown[]) => console.error('[realtime-gateway]', ...args),
};

export interface AttachGatewayOptions {
  /** Override REDIS_URL (tests). `null` forces memory. */
  redisUrl?: string | null;
  pingIntervalMs?: number;
}

/**
 * Attach chat + presence + calls on REALTIME_GATEWAY_PATH. The caller decides
 * whether to call this (realtimeGatewayEnabled) and must add the path to
 * rejectUnsupportedUpgrades' allowPaths.
 */
export function attachRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): RealtimeHandle & { store: RealtimeGatewayStore; redis: RedisLite | null } {
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  const redis = redisUrl ? new RedisLite(redisUrl) : null;
  const store: RealtimeGatewayStore = redis ? 'redis' : 'memory';
  const stateStore = redis ? new RedisCallStateStore(redis as unknown as CallStateRedis) : new InMemoryCallStateStore();
  // Since realtime-modules 0.98.6 the router is the single authorization
  // point: a refused presence/reactions/cursor subscribe reaches no service
  // state and every fan-out runs `authorize` first, answering
  // `AUTHZ_CHANNEL_DENIED`. Under 0.98.5 the presence service ignored the
  // router's refusal (an orgiq user could read an assessment roster), and
  // this gateway briefly wired `presence({ authorizeChannel })` as well —
  // dropped again because that hook answers silently and hid the router's
  // refusal frame (assessment re-audit, 2026-09-29).
  const handle = attachRealtime(server, {
    path: REALTIME_GATEWAY_PATH,
    auth: authenticateGatewayUpgrade,
    pingIntervalMs: opts.pingIntervalMs ?? 30_000,
    logger,
    // Chat + presence channels are tenant-scoped like call lobbies.
    authorize: authorizeChannel,
    features: [
      chat(),
      presence(),
      calls({
        stateStore,
        lobbyGuard: guardWithLog,
        config: {
          // An invite with no targets is fanned out to every connected
          // client — every tenant. The portal's hooks always target.
          canCall: (_callerId: string, targetUserIds: string[]) => targetUserIds.length > 0,
        },
      }),
    ],
  });
  status = { gateway: 'on', store };
  const where = redis ? `redis (${redisUrl!.replace(/\/\/[^@/]*@/, '//***@')})` : 'memory';
  console.log(`[realtime-gateway] serving ${REALTIME_GATEWAY_PATH} (chat, presence, calls); call state: ${where}`);
  if (redis) {
    void redis.ping().catch((err: unknown) => {
      console.warn(`[realtime-gateway] REDIS_URL is set but Redis did not answer (${(err as Error).message}); call frames will fail until it does`);
    });
  }
  const baseDispose = handle.dispose.bind(handle);
  return Object.assign(handle, {
    store,
    redis,
    dispose: async () => {
      await baseDispose();
      await redis?.quit();
      status = { gateway: 'off', store: null };
    },
  });
}
