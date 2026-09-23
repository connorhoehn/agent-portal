/**
 * The compute registry: what the compute-capability authority needs to answer
 * the same on every replica and across restarts.
 *
 * - boxes      — fleet box registrations (`resolveCloud` reads them)
 * - shares     — explicit, source-owned viewers per resource
 *                (`authorizeDisclosure` reads them)
 * - sessions   — capability-session records (`/revalidate`, `/use`, `/close`)
 * - revocations — "every session aimed at this key is over" markers, so a
 *                revocation on one replica ends sessions opened on another
 *
 * All of it expires unless refreshed. Box and share registrations are
 * refreshed by the heartbeat in compute-registry-runtime.ts for as long as a
 * live replica holds the box in its fleet; session and revocation records
 * simply live as long as the longest session could.
 *
 * Deliberately NOT here: event tail buffers and live stream subscribers
 * (devbox-fleet's per-box `events`/`subscribers`, the capability-session
 * listeners). Those are per-connection, per-process state.
 */
import type { FleetBox } from '../lib/devbox-fleet.js';
import type { ComputeCapabilityResource, ComputeCapabilitySession } from './compute-capability-sessions.js';
import { createMemoryRegistryStore, type ComputeRegistryStore } from './compute-registry-store.js';

export const DEFAULT_REGISTRATION_TTL_MS = 15 * 60_000;

export function resourceKey(resource: ComputeCapabilityResource): string {
  return `${resource.source}:${resource.resourceId}`;
}

const BOXES = 'box';
const SESSIONS = 'session';
const REVOCATIONS = 'revoked';
const sharePartition = (resource: ComputeCapabilityResource) => `share:${resourceKey(resource)}`;

export interface StoredCapabilitySession extends ComputeCapabilitySession {
  /** When this session was opened (epoch ms) — revocations after it end it. */
  openedAtMs: number;
}

export function createComputeRegistry(options: {
  store?: ComputeRegistryStore;
  registrationTtlMs?: number;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const store = options.store ?? createMemoryRegistryStore({ now });
  const ttlMs = Math.max(1_000, options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS);

  return {
    store,
    registrationTtlMs: ttlMs,

    // ── boxes ─────────────────────────────────────────────────────────────
    putBox(box: FleetBox): Promise<void> {
      return store.put(BOXES, box.id, box, ttlMs);
    },
    refreshBox(id: string): Promise<boolean> {
      return store.refresh(BOXES, id, ttlMs);
    },
    getBox(id: string): Promise<FleetBox | null> {
      return store.get<FleetBox>(BOXES, id);
    },
    listBoxes(): Promise<FleetBox[]> {
      return store.list<FleetBox>(BOXES);
    },
    async removeBox(id: string): Promise<void> {
      await store.delete(BOXES, id);
      const resource: ComputeCapabilityResource = { source: 'cloud-compute', resourceId: `box:${id}` };
      for (const viewerId of await this.sharedWith(resource)) {
        await store.delete(sharePartition(resource), viewerId);
      }
    },

    // ── explicit shares ───────────────────────────────────────────────────
    share(resource: ComputeCapabilityResource, viewerId: string): Promise<void> {
      return store.put(sharePartition(resource), viewerId, { viewerId }, ttlMs);
    },
    async isShared(resource: ComputeCapabilityResource, viewerId: string): Promise<boolean> {
      return (await store.get(sharePartition(resource), viewerId)) !== null;
    },
    async sharedWith(resource: ComputeCapabilityResource): Promise<string[]> {
      return (await store.list<{ viewerId: string }>(sharePartition(resource))).map((row) => row.viewerId);
    },
    async refreshShares(resource: ComputeCapabilityResource): Promise<number> {
      let refreshed = 0;
      for (const viewerId of await this.sharedWith(resource)) {
        if (await store.refresh(sharePartition(resource), viewerId, ttlMs)) refreshed += 1;
      }
      return refreshed;
    },

    // ── capability sessions ───────────────────────────────────────────────
    /**
     * Kept until the session's own expiry plus a minute, so a caller asking
     * just after the end still gets the real `endReason` rather than a miss.
     */
    putSession(session: StoredCapabilitySession): Promise<void> {
      const keepMs = Math.max(1_000, Date.parse(session.expiresAt) - now() + 60_000);
      return store.put(SESSIONS, session.sessionId, session, keepMs);
    },
    getSession(sessionId: string): Promise<StoredCapabilitySession | null> {
      return store.get<StoredCapabilitySession>(SESSIONS, sessionId);
    },

    // ── revocations ───────────────────────────────────────────────────────
    revoke(source: string, key: string, keepMs: number): Promise<void> {
      return store.put(REVOCATIONS, `${source}:${key}`, { atMs: now() }, keepMs);
    },
    /** True if any of `keys` was revoked at or after `sinceMs`. */
    async revokedSince(source: string, keys: readonly string[], sinceMs: number): Promise<boolean> {
      for (const key of keys) {
        const marker = await store.get<{ atMs: number }>(REVOCATIONS, `${source}:${key}`);
        if (marker && marker.atMs >= sinceMs) return true;
      }
      return false;
    },
  };
}

export type ComputeRegistry = ReturnType<typeof createComputeRegistry>;
