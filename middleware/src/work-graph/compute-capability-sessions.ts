import { randomUUID } from 'node:crypto';
import { createComputeRegistry, type ComputeRegistry, type StoredCapabilitySession } from './compute-registry.js';

export type ComputeCapability = 'observe' | 'control';
export type ComputeCapabilitySource = 'cloud-compute' | 'local-compute';
export type ComputeCapabilityEndReason =
  | 'closed' | 'expired' | 'source-revoked' | 'source-missing' | 'owner-mismatch' | 'control-not-allowed';

export interface ComputeCapabilityResource {
  source: ComputeCapabilitySource;
  resourceId: string;
}

/** Safe source-owned status — never a task prompt, session token, or output. */
export interface ComputeCapabilityTarget {
  ownerId: string;
  resource: ComputeCapabilityResource;
  status: 'available' | 'running' | 'waiting' | 'stopped' | 'failed' | 'cancelled';
  /** Keys whose revocation ends sessions aimed at this resource. */
  revocationKeys: readonly string[];
  /** Source can actually carry out cancel/stop for this target. */
  controllable: boolean;
}

export interface OpenComputeCapabilityInput {
  organizationId: string;
  viewerId: string;
  personId: string;
  resource: ComputeCapabilityResource;
  capability: ComputeCapability;
  requestedExpiresAt: string;
}

export interface ComputeCapabilitySession {
  sessionId: string;
  organizationId: string;
  viewerId: string;
  personId: string;
  resource: ComputeCapabilityResource;
  capability: ComputeCapability;
  expiresAt: string;
  revocationKeys: readonly string[];
  active: boolean;
  endReason?: ComputeCapabilityEndReason;
}

export type CapabilityDecision =
  | { allowed: true; session: ComputeCapabilitySession }
  | { allowed: false; reason: ComputeCapabilityEndReason | 'invalid-request' };

/** Session-free source decision for graph disclosure and capability projection. */
export type ComputeCapabilityDisclosureDecision =
  | { allowed: true; directAccess: boolean; capabilities: readonly ('observe-terminal' | 'control-terminal')[] }
  | { allowed: false; reason: ComputeCapabilityEndReason | 'invalid-request'; directAccess: false; capabilities: readonly [] };

export interface ComputeCapabilitySources {
  resolve(resource: ComputeCapabilityResource): Promise<ComputeCapabilityTarget | null>;
  /** Invoked only after a fresh control authorization. */
  cancel(target: ComputeCapabilityTarget): Promise<boolean>;
}

function isFutureTimestamp(value: string, now: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now;
}

/**
 * A session registry that deliberately holds no bearer token. Platform
 * and gateway retain their own authenticated collaboration session; this store
 * is the source's revocable attachment, keyed by an opaque UUID and rechecked
 * against source truth before every use.
 */
export function createComputeCapabilitySessions(options: {
  organizationId: string;
  sources: ComputeCapabilitySources;
  maxTtlMs?: number;
  now?: () => number;
  newId?: () => string;
  /**
   * Where session records, explicit shares and revocation markers live. The
   * runtime passes the shared (DynamoDB-backed) registry so every replica
   * answers the same; omitted, it is a private in-memory one.
   */
  registry?: ComputeRegistry;
}) {
  // Per-process: sessions this replica has touched, for expiry timers and
  // listener notification. The registry is the truth; this is a cache of it.
  const sessions = new Map<string, StoredCapabilitySession>();
  const listeners = new Map<string, Set<(session: ComputeCapabilitySession) => void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Explicit, source-owned shares (registry.share/isShared): viewers a durable
  // owner has named for a resource, independent of any work-graph sharing
  // grant. This is what lets authorizeDisclosure() answer 'details' for a
  // non-owner honestly — the grant alone only says the OWNER wants to share;
  // this is the SOURCE confirming the named viewer is real. Deliberately NOT
  // populated from request input (a caller cannot grant itself access by
  // asserting it), only from `share()`, called by durable-owner-authenticated
  // callers (the portal, or — locally — the dev-only fixtures route).
  const now = options.now ?? Date.now;
  const registry = options.registry ?? createComputeRegistry({ now });
  const newId = options.newId ?? randomUUID;
  const maxTtlMs = Math.max(1_000, Math.min(options.maxTtlMs ?? 5 * 60_000, 30 * 60_000));

  function notify(session: ComputeCapabilitySession): void {
    for (const listener of listeners.get(session.sessionId) ?? []) {
      try { listener({ ...session, revocationKeys: [...session.revocationKeys] }); } catch { /* one transport cannot block revocation */ }
    }
  }

  let persistWarned = false;
  function persist(session: StoredCapabilitySession): Promise<void> {
    return registry.putSession({ ...session, revocationKeys: [...session.revocationKeys] }).catch((err: unknown) => {
      if (!persistWarned) console.warn('[compute-capability] session write failed:', (err as Error)?.message ?? err);
      persistWarned = true;
    });
  }

  function end(session: StoredCapabilitySession, reason: ComputeCapabilityEndReason, write = true): ComputeCapabilitySession {
    if (!session.active) return session;
    session.active = false;
    session.endReason = reason;
    const timer = timers.get(session.sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(session.sessionId);
    // Fire-and-forget keeps end() synchronous for its sync callers
    // (invalidateByRevocationKey, expiry timers); the memory store applies
    // the write before this returns.
    if (write) {
      const pending = persist(session).finally(() => {
        if (writes.get(session.sessionId) === pending) writes.delete(session.sessionId);
      });
      writes.set(session.sessionId, pending);
    }
    notify(session);
    return session;
  }

  // In-flight end-of-session writes. Request paths await them before
  // answering, so a caller that goes straight to another replica never
  // outruns the write that ended the session.
  const writes = new Map<string, Promise<void>>();
  async function settled<T>(sessionId: string, value: T): Promise<T> {
    await writes.get(sessionId);
    return value;
  }

  /**
   * The session as the registry knows it, merged into this process's cache.
   * A session opened on another replica is adopted (and gets a local expiry
   * timer); one another replica ended is ended here too, which notifies any
   * listener attached on this replica.
   */
  async function load(sessionId: string): Promise<StoredCapabilitySession | null> {
    let stored: StoredCapabilitySession | null = null;
    try { stored = await registry.getSession(sessionId); } catch { stored = null; }
    const cached = sessions.get(sessionId);
    if (!stored) return cached ?? null;
    if (cached) {
      if (cached.active && !stored.active) end(cached, stored.endReason ?? 'closed', false);
      return cached;
    }
    sessions.set(sessionId, stored);
    if (stored.active) scheduleExpiry(stored);
    return stored;
  }

  function scheduleExpiry(session: StoredCapabilitySession): void {
    const delay = Math.max(1, Date.parse(session.expiresAt) - now());
    const timer = setTimeout(() => end(session, 'expired'), delay);
    timer.unref?.();
    timers.set(session.sessionId, timer);
  }

  async function authorize(session: StoredCapabilitySession): Promise<CapabilityDecision> {
    if (!session.active) return { allowed: false, reason: session.endReason ?? 'closed' };
    if (!isFutureTimestamp(session.expiresAt, now())) {
      end(session, 'expired');
      return { allowed: false, reason: 'expired' };
    }
    // A revocation raised on ANY replica after this session opened ends it.
    if (await registry.revokedSince(session.resource.source, session.revocationKeys, session.openedAtMs ?? 0).catch(() => false)) {
      end(session, 'source-revoked');
      return { allowed: false, reason: 'source-revoked' };
    }
    const target = await options.sources.resolve(session.resource);
    if (!target) {
      end(session, 'source-missing');
      return { allowed: false, reason: 'source-missing' };
    }
    if (target.ownerId !== session.personId) {
      end(session, 'owner-mismatch');
      return { allowed: false, reason: 'owner-mismatch' };
    }
    // Collaboration grant enforcement belongs to the HMAC-authenticated
    // platform before it calls /open. The source adds the independent,
    // non-escalatable resource check: control exists only where this source
    // can actually carry it out.
    if (session.capability === 'control' && !target.controllable) {
      end(session, 'control-not-allowed');
      return { allowed: false, reason: 'control-not-allowed' };
    }
    // The resource can move between source-owned parents (for example, a job
    // can be rescheduled). Keep immediate invalidation keys in step with the
    // same durable lookup used for this authorization.
    session.revocationKeys = [...new Set(target.revocationKeys)];
    return { allowed: true, session };
  }

  return {
    /**
     * Does not allocate a source attachment. The platform uses this to learn
     * whether the current viewer is the durable source owner. Capabilities
     * are source availability, never a grant: platform must independently
     * enforce sharing and accepted collaboration before calling /open.
     */
    async authorizeDisclosure(input: Omit<OpenComputeCapabilityInput, 'capability' | 'requestedExpiresAt'>): Promise<ComputeCapabilityDisclosureDecision> {
      if (input.organizationId !== options.organizationId || !input.viewerId || !input.personId || !input.resource?.resourceId) {
        return { allowed: false, reason: 'invalid-request', directAccess: false, capabilities: [] };
      }
      const target = await options.sources.resolve(input.resource);
      if (!target) return { allowed: false, reason: 'source-missing', directAccess: false, capabilities: [] };
      if (target.ownerId !== input.personId) return { allowed: false, reason: 'owner-mismatch', directAccess: false, capabilities: [] };
      // Direct access is the owner, or a viewer the owner has explicitly
      // named for this exact resource — never inferred from the request
      // alone. A viewer with neither fails closed to `directAccess: false`
      // (capped at 'summary' upstream), the same as before this existed; a
      // resource nobody resolved already returned above.
      const directAccess = input.viewerId === input.personId
        || await registry.isShared(input.resource, input.viewerId);
      return {
        allowed: true,
        directAccess,
        capabilities: target.controllable ? ['observe-terminal', 'control-terminal'] : ['observe-terminal'],
      };
    },

    async open(input: OpenComputeCapabilityInput): Promise<CapabilityDecision> {
      if (input.organizationId !== options.organizationId
        || !input.viewerId || !input.personId || !input.resource?.resourceId
        || !isFutureTimestamp(input.requestedExpiresAt, now())) return { allowed: false, reason: 'invalid-request' };
      const target = await options.sources.resolve(input.resource);
      if (!target) return { allowed: false, reason: 'source-missing' };
      if (target.ownerId !== input.personId) return { allowed: false, reason: 'owner-mismatch' };
      if (input.capability === 'control' && !target.controllable) {
        return { allowed: false, reason: 'control-not-allowed' };
      }
      const expiresAt = new Date(Math.min(Date.parse(input.requestedExpiresAt), now() + maxTtlMs)).toISOString();
      const session: StoredCapabilitySession = {
        sessionId: newId(), organizationId: input.organizationId, viewerId: input.viewerId,
        personId: input.personId, resource: { ...target.resource }, capability: input.capability,
        expiresAt, revocationKeys: [...new Set(target.revocationKeys)], active: true,
        openedAtMs: now(),
      };
      sessions.set(session.sessionId, session);
      scheduleExpiry(session);
      // Awaited: the caller may take the session id straight to another replica.
      await persist(session);
      const { openedAtMs: _openedAtMs, ...publicSession } = session;
      return { allowed: true, session: { ...publicSession, revocationKeys: [...session.revocationKeys] } };
    },

    async revalidate(sessionId: string): Promise<CapabilityDecision> {
      const session = await load(sessionId);
      return session ? settled(sessionId, await authorize(session)) : { allowed: false, reason: 'source-missing' };
    },

    async use(sessionId: string, requested: ComputeCapability): Promise<CapabilityDecision & { result?: { status: string; cancelled?: boolean } }> {
      return settled(sessionId, await this._useUnsettled(sessionId, requested));
    },

    async _useUnsettled(sessionId: string, requested: ComputeCapability): Promise<CapabilityDecision & { result?: { status: string; cancelled?: boolean } }> {
      const checked = await this.revalidate(sessionId);
      if (!checked.allowed) return checked;
      if (requested !== checked.session.capability) return { allowed: false, reason: 'control-not-allowed' };
      const target = await options.sources.resolve(checked.session.resource);
      if (!target) {
        const session = sessions.get(sessionId)!;
        end(session, 'source-missing');
        return { allowed: false, reason: 'source-missing' };
      }
      const session = sessions.get(sessionId)!;
      // Resolve again immediately before the irreversible source control and
      // repeat ownership/control checks. A state change between revalidate()
      // and this call must deny, never operate on a newly reassigned target.
      if (target.ownerId !== session.personId) {
        end(session, 'owner-mismatch');
        return { allowed: false, reason: 'owner-mismatch' };
      }
      if (requested === 'control' && !target.controllable) {
        end(session, 'control-not-allowed');
        return { allowed: false, reason: 'control-not-allowed' };
      }
      session.revocationKeys = [...new Set(target.revocationKeys)];
      if (requested === 'observe') return { ...checked, result: { status: target.status } };
      const cancelled = await options.sources.cancel(target);
      if (!cancelled) return { allowed: false, reason: 'control-not-allowed' };
      end(session, 'closed');
      return { ...checked, result: { status: 'cancelled', cancelled: true } };
    },

    async close(sessionId: string): Promise<ComputeCapabilitySession | null> {
      const session = await load(sessionId);
      return session ? settled(sessionId, end(session, 'closed')) : null;
    },

    /**
     * Names a viewer as an explicit, source-owned collaborator on a resource,
     * so authorizeDisclosure() can honestly answer 'details' for them instead
     * of capping every non-owner at 'summary'. Idempotent (a Set). Does not
     * touch — and is never consulted by — open()/use(), which decide
     * observe/control capability from durable ownership alone; a share here
     * only ever widens DISCLOSURE, never collaboration capability.
     */
    share(resource: ComputeCapabilityResource, viewerId: string): Promise<void> {
      return registry.share(resource, viewerId);
    },

    invalidateByRevocationKey(source: ComputeCapabilitySource, key: string): number {
      // Sessions opened on other replicas are not in this process's cache;
      // the marker ends them at their next revalidate/use there. Kept long
      // enough to outlive any session that could still be open.
      void registry.revoke(source, key, maxTtlMs + 60_000).catch((err: unknown) => {
        console.warn('[compute-capability] revocation write failed:', (err as Error)?.message ?? err);
      });
      let count = 0;
      for (const session of sessions.values()) {
        if (session.resource.source === source && session.revocationKeys.includes(key) && session.active) {
          end(session, 'source-revoked');
          count += 1;
        }
      }
      return count;
    },

    subscribe(sessionId: string, listener: (session: ComputeCapabilitySession) => void): () => void {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      const session = sessions.get(sessionId);
      if (session && !session.active) listener({ ...session, revocationKeys: [...session.revocationKeys] });
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },

    _sessionsForTest(): readonly ComputeCapabilitySession[] { return [...sessions.values()].map((s) => ({ ...s })); },
  };
}
