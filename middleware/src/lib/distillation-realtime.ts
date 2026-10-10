// Live distillation updates over realtime-modules, on this server's own
// WebSocket paths.
//
//   ws(s)://<middleware>/realtime        (REALTIME_PATH)
//   ws(s)://<middleware>/ws              (the /ws gateway, when it is on)
//   → { service: 'subscribe', action: 'subscribe', channel: 'orgiq:distill:jobs' }
//   ← { type: 'subscribe', action: 'subscribed', channel }        (the ack)
//   ← { type: 'job', channel: 'orgiq:distill:jobs', job }        (server push)
//
// Channels and their frames (docs/distillation-redesign-spec.md §3d; the names
// gained the `orgiq:` partition on 2026-10-01 — lib/distillation-channels.ts):
//   orgiq:distill:levels  {type:'levels', channel, levels}    — every L0 write, job
//                                                               transition, replica repair
//   orgiq:distill:jobs    {type:'job', channel, job}          — each job state/phase change
//   orgiq:distill:review  {type:'review', channel, pending, decided} — any sample change
//
// Every frame goes to BOTH sockets. The portal opens only the /ws gateway
// (OptionalGatewayProvider), whose channelGuard admits these names under the
// same rule as the REST read gate (mayReadDistillation) and refuses every
// client publish on them; /realtime stays for cookie-only clients.
//
// `channel` is added to each frame so a client multiplexing several channels
// over one socket (GatewayMessage.channel) can route without guessing from
// `type`. Every payload is the REST route's own serializer (levelsView, the
// wire job, reviewCounts), so a pushed frame and a fetched response agree.
//
// Auth (/realtime): the upgrade carries the browser's signed `orgiq.session` cookie, so
// this is a cookie-authenticated socket and gets the same two checks the HTTP
// side does before any session processing — the Origin allowlist
// (lib/browser-origin.ts: a cross-site page must not open a socket that rides
// the user's cookie) and a session in the orgiq tenant (admin from anywhere),
// the floor `requireTenant('orgiq') + requireSession('ViewDistillation')`
// puts under /api/distillation. The demo identity applies exactly where the
// HTTP floor's does (`demoFallbackAllowed()`).
//
// Directory epoch, active role and operator provenance are checked at upgrade,
// subscription and delivery. Redis routing gives this path its own leased
// owners and peer fan-out when REALTIME_GATEWAY_ROUTER=redis.
//
// Every other upgrade path is still refused by lib/unsupported-upgrades.ts.

import type { IncomingMessage, Server } from 'node:http';
import { hostname } from 'node:os';
import { attachRealtime, RedisRealtimeRouter, type RealtimeHandle } from '@connorhoehnslalom/realtime-modules/server';
import { isAllowedBrowserOrigin } from './browser-origin.js';
import { upgradeScheme } from './trusted-proxy.js';
import { COOKIE_NAME, verifySession, demoFallbackAllowed, demoSession, ADMIN_ROLE, type Session } from './session.js';
import { distillationEvents } from './distillation-events.js';
import { levelsView, jobSnapshot, reviewCounts } from '../providers/distillation.js';
import { DISTILL_CHANNELS, distillationGatewayTarget } from './distillation-channels.js';
import { currentLiveSession, type LiveGatewayAuth } from './live-principal.js';
import { admitDistillation, admitDistillationDelivery } from './gateway/authority.js';
import { GatewayRedis } from './gateway-redis.js';
import type { LeasedOwner } from './realtime-node-ownership.js';
import { realtimeGatewayRouting } from './gateway/env.js';

export { DISTILL_CHANNELS };

export const REALTIME_PATH = '/realtime';
let readiness: (() => boolean) | null = null;

export function distillationRealtimeStatus() {
  return { router: readiness ? 'redis' : 'local', ...(readiness ? { ready: readiness() } : {}) };
}

function cookieFrom(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/**
 * The upgrade's auth callback: throw to refuse (the library answers 401).
 * Returns the identity the router later hands to `authorizeChannel`.
 */
export async function authenticateUpgrade(req: IncomingMessage): Promise<LiveGatewayAuth> {
  const origin = req.headers.origin;
  if (origin) {
    // The viewer's scheme behind the declared proxies (lib/trusted-proxy.ts).
    if (!isAllowedBrowserOrigin(origin, `${upgradeScheme(req)}://${req.headers.host ?? ''}`)) {
      throw new Error('browser origin is not allowed');
    }
  }
  const raw = cookieFrom(req, COOKIE_NAME);
  let session: Session | null = raw ? await verifySession(raw) : null;
  if (!session && demoFallbackAllowed()) session = demoSession();
  if (!session) throw new Error('unauthenticated');
  session = await currentLiveSession(session);
  if (session.tenant !== 'orgiq' && session.role !== ADMIN_ROLE) throw new Error('distillation is an orgiq surface');
  return { userId: session.sub, displayName: session.name ?? session.sub, role: session.role, org: session.tenant,
    epoch: session.epoch ?? 0, sessionIat: session.iat,
    tenants: Object.keys(session.grants), ...(session.act ? { act: { sub: session.act.sub, epoch: session.act.epoch ?? 0 } } : {}) };
}

/**
 * Channel authz for the local router: the facade's distillation rule
 * (lib/gateway/authority.ts `admitDistillation`). Clients may SUBSCRIBE to the
 * three distillation channels and nothing else; they may PUBLISH nothing —
 * every frame on these channels is the server's (a server `sendToChannel`
 * names no publisher, so it never reaches this hook).
 */
export function authorizeChannel(args: { kind: 'subscribe' | 'publish'; channel: string; ctx: Record<string, unknown> | null }): Promise<boolean> {
  return admitDistillation(args.ctx, args.channel, args.kind);
}

const routerHooks = {
  authorize: authorizeChannel,
  filterClientMessage: async ({ message, ctx }: { message: unknown; ctx: Record<string, unknown> | null }) =>
    await admitDistillationDelivery(ctx) ? message : null,
};

/** Coalesce bursts (a pass emits several levels changes in one tick). */
function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) return;
    t = setTimeout(() => { t = null; fn(); }, ms);
    t.unref?.();
  };
}

/**
 * Attach realtime on REALTIME_PATH and wire the provider's change signals to
 * channel pushes. Returns the handle plus a `dispose` that also unhooks the
 * listeners (tests attach and dispose per server).
 */
export function attachDistillationRealtime(server: Server, opts: { debounceMs?: number; router?: RedisRealtimeRouter } = {}): RealtimeHandle & { detach: () => Promise<void> } {
  if (realtimeGatewayRouting() === 'redis' && !opts.router) {
    throw new Error('Redis distillation routing requires awaited startDistillationRealtime, not synchronous attachDistillationRealtime');
  }
  const handle = attachRealtime(server, {
    features: [],
    path: REALTIME_PATH,
    auth: async req => {
      const auth = await authenticateUpgrade(req);
      if (opts.router && !opts.router.isReady()) throw new Error('Distillation ownership is unavailable');
      return auth;
    },
    ...(opts.router ? { router: opts.router } : routerHooks),
    pingIntervalMs: 30_000,
  });
  const send = (channel: string, frame: Record<string, unknown>): void => {
    const message = { ...frame, channel };
    for (const target of [handle.router, distillationGatewayTarget()]) {
      if (!target) continue;
      void Promise.resolve(target.sendToChannel(channel, message))
        .catch((err: unknown) => console.warn(`[realtime] ${channel}:`, (err as Error).message));
    }
  };
  const wait = opts.debounceMs ?? 100;
  const ownedReadiness = opts.router ? () => opts.router!.isReady() : null;
  readiness = ownedReadiness;

  const pushLevels = debounce(() => {
    void levelsView()
      .then(({ levels }) => send(DISTILL_CHANNELS.levels, { type: 'levels', levels }))
      .catch((err: unknown) => console.warn('[realtime] levels:', (err as Error).message));
  }, wait);
  const pushReview = debounce(() => send(DISTILL_CHANNELS.review, { type: 'review', ...reviewCounts() }), wait);
  // Job frames are NOT debounced: each phase is its own frame, and a client
  // drawing a progress bar needs every one of them in order.
  const pushJob = (jobId: string): void => {
    const job = jobSnapshot(jobId);
    if (job) send(DISTILL_CHANNELS.jobs, { type: 'job', job });
    pushLevels();
  };

  distillationEvents.on('levels', pushLevels);
  distillationEvents.on('review', pushReview);
  distillationEvents.on('job', pushJob);

  const detach = async (): Promise<void> => {
    distillationEvents.off('levels', pushLevels);
    distillationEvents.off('review', pushReview);
    distillationEvents.off('job', pushJob);
    try { await handle.dispose(); } finally { if (readiness === ownedReadiness) readiness = null; }
  };
  return Object.assign(handle, { detach });
}

/** Start leased cookie transport before the HTTP listener accepts traffic.
 * Its separate namespace keeps /ws feature/service ownership independent. */
export async function startDistillationRealtime(server: Server, opts: { debounceMs?: number } = {}) {
  const routing = realtimeGatewayRouting();
  if (routing === 'local') return attachDistillationRealtime(server, opts);
  const redisUrl = (process.env['REDIS_URL'] ?? '').trim();
  if (!redisUrl) throw new Error('Redis distillation routing requires REDIS_URL');
  const bound = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const redis = new GatewayRedis(redisUrl, bound('REDIS_COMMAND_TIMEOUT_MS', 2000));
  await redis.open();
  let handle: ReturnType<typeof attachDistillationRealtime> | undefined;
  try {
    const router = new RedisRealtimeRouter({ ...routerHooks, redis: redis.cluster,
      namespace: `${process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway'}:distillation`,
      nodeId: process.env['REALTIME_GATEWAY_NODE_ID'] || `${hostname()}:${process.pid}`,
      leaseMs: bound('REALTIME_GATEWAY_LEASE_MS', 30000),
      requestTimeoutMs: bound('REALTIME_GATEWAY_RECEIPT_TIMEOUT_MS', 3000) });
    handle = attachDistillationRealtime(server, { ...opts, router });
    await router.start();
    const detach = handle.detach;
    return Object.assign(handle, { ownership: router as LeasedOwner, detach: async () => { try { await detach(); } finally { await redis.quit(); } } });
  } catch (error) {
    try { await handle?.detach(); } finally { await redis.quit(); }
    throw error;
  }
}
