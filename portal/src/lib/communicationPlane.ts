// The Communication plane (docs/social-tenant-design.md §4.6, "Communication";
// docs/nav-server-tier-decisions.md, 2026-10-07): the Social application
// embedded in the orgiq, assessment and pipelines tenants as a rail page, in
// place of each tenant's former "Calls" log. No React, so
// `__tests__/communicationPlane.test.ts` runs under plain `node --test`.
//
// Authority is never decided here. The plane's reads and writes go to the
// grant-gated `/api/social/plane` router (the tenant router's own handlers,
// gated on the actor's CURRENT Social grants) and the source tenant's call log
// (`GET /api/calls/tenant`); the gateway's channel guard decides every
// subscribe. This module only says which state the page is in, given the
// session the shell already holds, and carries the rail door's count.

import type { SocialDm } from '../pages/social/socialChat.ts';

/** The tenants whose rail carries Communication; Social's own Meet › Calls stays. */
export const COMMUNICATION_PATHS = {
  orgiq: '/iq/communication',
  assessment: '/assessment/communication',
  pipelines: '/pipelines/communication',
} as const;
export type CommunicationTenant = keyof typeof COMMUNICATION_PATHS;

export function communicationPath(tenant: string | null | undefined): string | null {
  return tenant && tenant in COMMUNICATION_PATHS ? COMMUNICATION_PATHS[tenant as CommunicationTenant] : null;
}

/** Where a former `/<tenant>/calls` link lands: the plane's Calls destination. */
export function legacyCallsTarget(tenant: CommunicationTenant): string {
  return `${COMMUNICATION_PATHS[tenant]}/calls`;
}

/**
 * Which plane a session gets. `social`: the Social plane, under the session's
 * own Social grant (the BFF re-checks it on every read). `no-grant`: the
 * honest denied state — the call log stays, conversations do not. The
 * cookie-less demo identity holds no Social grant (`permissiveGrants()`), so
 * it lands on `no-grant` too.
 */
export type CommunicationAccess = 'signed-out' | 'social-disabled' | 'no-grant' | 'social';

export function communicationAccess(
  session: { sub: string; grants: Readonly<Record<string, readonly string[] | undefined>> } | null | undefined,
  socialEnabled: boolean,
): CommunicationAccess {
  if (!session || session.sub === 'unknown') return 'signed-out';
  if (!socialEnabled) return 'social-disabled';
  return (session.grants['social']?.length ?? 0) > 0 ? 'social' : 'no-grant';
}

/** The rail door's badge: Social DMs with new messages (each counted on the server). */
export function communicationUnreadCount(conversations: readonly Pick<SocialDm, 'unreadCount'>[]): number {
  return conversations.filter((dm) => (dm.unreadCount ?? 0) > 0).length;
}

/**
 * The plane's unread count, published by the shell's Social embedding (which
 * already holds the `/embedded` snapshot) and read by the rail. A tiny
 * external store, so neither side owns the other.
 */
export interface CountStore {
  get(): number;
  set(next: number): void;
  subscribe(listener: () => void): () => void;
}

export function createCountStore(): CountStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const n = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
      if (n === value) return;
      value = n; listeners.forEach((listener) => listener());
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const communicationUnread = createCountStore();

/** The rail's per-door section counts, with the plane's door added for the active tenant. */
export function withCommunicationCount(sections: Readonly<Record<string, number>>, tenant: string | null | undefined, count: number): Record<string, number> {
  const path = communicationPath(tenant);
  if (!path || count <= 0) return { ...sections };
  return { ...sections, [path]: (sections[path] ?? 0) + count };
}
