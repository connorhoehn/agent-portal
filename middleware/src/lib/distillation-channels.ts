// The distillation channels' names, who may read them, and the gateway they
// are pushed into — shared by the publisher (lib/distillation-realtime.ts) and
// the /ws gateway's channel guard (lib/realtime-gateway.ts) so the two agree
// on one name. Kept free of either module's imports: the gateway must not pull
// the distillation provider in, and the publisher must not pull the social
// chat stack in.
//
// The names carry the `orgiq:` partition because the gateway admits a channel
// only under a tenant prefix (channelGuard). Until 2026-10-01 they were bare
// `distill:*`: the portal subscribed to them on /ws (the only socket it opens),
// the gateway refused every one with AUTHZ_CHANNEL_DENIED, nothing was ever
// pushed there anyway (the publisher served only /realtime, which the portal
// never connects to), and the hook resubscribed on every refusal — ~4,600
// frames a second from one open tab.

import { ADMIN_ROLE } from './session.js';

export const DISTILL_CHANNEL_PREFIX = 'orgiq:distill:';

export const DISTILL_CHANNELS = {
  levels: `${DISTILL_CHANNEL_PREFIX}levels`,
  jobs: `${DISTILL_CHANNEL_PREFIX}jobs`,
  review: `${DISTILL_CHANNEL_PREFIX}review`,
} as const;

const CHANNEL_SET = new Set<string>(Object.values(DISTILL_CHANNELS));

/** One of the three channels the server pushes on. */
export function isDistillationChannel(channel: string): boolean {
  return CHANNEL_SET.has(channel);
}

/** Anything under the distillation prefix, known or not — the guard owns the whole namespace. */
export function inDistillationNamespace(channel: string): boolean {
  return channel.startsWith(DISTILL_CHANNEL_PREFIX);
}

type ReaderCtx = { userId?: unknown; org?: unknown; tenant?: unknown; role?: unknown; [key: string]: unknown } | null | undefined;

/**
 * The REST read gate on /api/distillation, as a realtime rule:
 * `requireTenant('orgiq')` (the ACTIVE tenant is orgiq, or the role is admin,
 * which crosses tenants) plus `requireSession` (a signed-in user — every orgiq
 * role reads distillation). A grant in orgiq held by someone standing in
 * another tenant is not enough, exactly as the REST route 403s them until they
 * switch. The /ws token names the active tenant `org`; the /realtime cookie
 * context names it `tenant`.
 */
export function mayReadDistillation(ctx: ReaderCtx): boolean {
  if (!ctx || typeof ctx.userId !== 'string' || !ctx.userId) return false;
  const tenant = typeof ctx.org === 'string' ? ctx.org : typeof ctx.tenant === 'string' ? ctx.tenant : '';
  return tenant === 'orgiq' || ctx.role === ADMIN_ROLE;
}

/** The slice of the gateway's router a server push needs. */
export interface DistillationPushTarget {
  sendToChannel(channel: string, message: unknown): unknown;
}

let gatewayTarget: DistillationPushTarget | null = null;

/** Set by attachRealtimeGateway (null on dispose). */
export function setDistillationGatewayTarget(target: DistillationPushTarget | null): void {
  gatewayTarget = target;
}

export function distillationGatewayTarget(): DistillationPushTarget | null {
  return gatewayTarget;
}
