// Live distillation updates over realtime-modules, on this server's own
// WebSocket path.
//
//   ws(s)://<middleware>/realtime        (REALTIME_PATH)
//   → { service: 'subscribe', action: 'subscribe', channel: 'distill:jobs' }
//   ← { type: 'subscribe', action: 'subscribed', channel }        (the ack)
//   ← { type: 'job', channel: 'distill:jobs', job }              (server push)
//
// Channels and their frames (docs/distillation-redesign-spec.md §3d):
//   distill:levels  {type:'levels', channel, levels}    — every L0 write, job
//                                                         transition, replica repair
//   distill:jobs    {type:'job', channel, job}          — each job state/phase change
//   distill:review  {type:'review', channel, pending, decided} — any sample change
// `channel` is added to each frame so a client multiplexing several channels
// over one socket (GatewayMessage.channel) can route without guessing from
// `type`. Every payload is the REST route's own serializer (levelsView, the
// wire job, reviewCounts), so a pushed frame and a fetched response agree.
//
// Auth: the upgrade carries the browser's signed `orgiq.session` cookie, so
// this is a cookie-authenticated socket and gets the same two checks the HTTP
// side does before any session processing — the Origin allowlist
// (lib/browser-origin.ts: a cross-site page must not open a socket that rides
// the user's cookie) and a session in the orgiq tenant (admin from anywhere),
// the floor `requireTenant('orgiq') + requireSession('ViewDistillation')`
// puts under /api/distillation. The demo identity applies exactly where the
// HTTP floor's does (`demoFallbackAllowed()`).
//
// What this does NOT re-check: a socket authenticates once, at upgrade. A
// session revoked afterwards (the epoch bump in lib/session.ts) keeps its open
// socket until it reconnects. The frames are the same operational reads any
// orgiq session may make, which is why that window is accepted here.
//
// Every other upgrade path is still refused by lib/unsupported-upgrades.ts.

import type { IncomingMessage, Server } from 'node:http';
import { attachRealtime, type RealtimeHandle } from '@connorhoehnslalom/realtime-modules/server';
import { isAllowedBrowserOrigin } from './browser-origin.js';
import { COOKIE_NAME, verifySession, demoFallbackAllowed, demoSession, ADMIN_ROLE, type Session } from './session.js';
import { distillationEvents } from './distillation-events.js';
import { levelsView, jobSnapshot, reviewCounts } from '../providers/distillation.js';

export const REALTIME_PATH = '/realtime';

export const DISTILL_CHANNELS = {
  levels: 'distill:levels',
  jobs: 'distill:jobs',
  review: 'distill:review',
} as const;
const CHANNEL_SET = new Set<string>(Object.values(DISTILL_CHANNELS));

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
export async function authenticateUpgrade(req: IncomingMessage): Promise<{ userId: string; role: string; tenant: string }> {
  const origin = req.headers.origin;
  if (origin) {
    const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    if (!isAllowedBrowserOrigin(origin, `${proto}://${req.headers.host ?? ''}`)) {
      throw new Error('browser origin is not allowed');
    }
  }
  const raw = cookieFrom(req, COOKIE_NAME);
  let session: Session | null = raw ? await verifySession(raw) : null;
  if (!session && demoFallbackAllowed()) session = demoSession();
  if (!session) throw new Error('unauthenticated');
  if (session.tenant !== 'orgiq' && session.role !== ADMIN_ROLE) throw new Error('distillation is an orgiq surface');
  return { userId: session.sub, role: session.role, tenant: session.tenant };
}

/**
 * Channel authz for the local router. Clients may SUBSCRIBE to the three
 * distillation channels and nothing else; they may PUBLISH nothing — every
 * frame on these channels is the server's (a server `sendToChannel` names no
 * publisher, so it never reaches this hook).
 */
export function authorizeChannel(args: { kind: 'subscribe' | 'publish'; channel: string; ctx: { userId?: string } | null }): boolean {
  if (args.kind === 'publish') return false;
  return Boolean(args.ctx?.userId) && CHANNEL_SET.has(args.channel);
}

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
export function attachDistillationRealtime(server: Server, opts: { debounceMs?: number } = {}): RealtimeHandle & { detach: () => Promise<void> } {
  const handle = attachRealtime(server, {
    features: [],
    path: REALTIME_PATH,
    auth: authenticateUpgrade,
    authorize: authorizeChannel,
    pingIntervalMs: 30_000,
  });
  const send = (channel: string, frame: Record<string, unknown>): void => {
    void Promise.resolve(handle.router.sendToChannel(channel, { ...frame, channel }))
      .catch((err: unknown) => console.warn(`[realtime] ${channel}:`, (err as Error).message));
  };
  const wait = opts.debounceMs ?? 100;

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
    await handle.dispose();
  };
  return Object.assign(handle, { detach });
}
