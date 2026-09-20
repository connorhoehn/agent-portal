import { randomUUID } from 'node:crypto';

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
 * An in-process session registry deliberately holds no bearer token. Platform
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
}) {
  const sessions = new Map<string, ComputeCapabilitySession>();
  const listeners = new Map<string, Set<(session: ComputeCapabilitySession) => void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const maxTtlMs = Math.max(1_000, Math.min(options.maxTtlMs ?? 5 * 60_000, 30 * 60_000));

  function notify(session: ComputeCapabilitySession): void {
    for (const listener of listeners.get(session.sessionId) ?? []) {
      try { listener({ ...session, revocationKeys: [...session.revocationKeys] }); } catch { /* one transport cannot block revocation */ }
    }
  }

  function end(session: ComputeCapabilitySession, reason: ComputeCapabilityEndReason): ComputeCapabilitySession {
    if (!session.active) return session;
    session.active = false;
    session.endReason = reason;
    const timer = timers.get(session.sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(session.sessionId);
    notify(session);
    return session;
  }

  function scheduleExpiry(session: ComputeCapabilitySession): void {
    const delay = Math.max(1, Date.parse(session.expiresAt) - now());
    const timer = setTimeout(() => end(session, 'expired'), delay);
    timer.unref?.();
    timers.set(session.sessionId, timer);
  }

  async function authorize(session: ComputeCapabilitySession): Promise<CapabilityDecision> {
    if (!session.active) return { allowed: false, reason: session.endReason ?? 'closed' };
    if (!isFutureTimestamp(session.expiresAt, now())) {
      end(session, 'expired');
      return { allowed: false, reason: 'expired' };
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
     * whether the current viewer is the durable source owner; accepted
     * collaboration remains platform-owned and never becomes a source grant.
     */
    async authorizeDisclosure(input: Omit<OpenComputeCapabilityInput, 'capability' | 'requestedExpiresAt'>): Promise<ComputeCapabilityDisclosureDecision> {
      if (input.organizationId !== options.organizationId || !input.viewerId || !input.personId || !input.resource?.resourceId) {
        return { allowed: false, reason: 'invalid-request', directAccess: false, capabilities: [] };
      }
      const target = await options.sources.resolve(input.resource);
      if (!target) return { allowed: false, reason: 'source-missing', directAccess: false, capabilities: [] };
      if (target.ownerId !== input.personId) return { allowed: false, reason: 'owner-mismatch', directAccess: false, capabilities: [] };
      const directAccess = input.viewerId === input.personId;
      return {
        allowed: true,
        directAccess,
        capabilities: directAccess
          ? (target.controllable ? ['observe-terminal', 'control-terminal'] : ['observe-terminal'])
          : [],
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
      const session: ComputeCapabilitySession = {
        sessionId: newId(), organizationId: input.organizationId, viewerId: input.viewerId,
        personId: input.personId, resource: { ...target.resource }, capability: input.capability,
        expiresAt, revocationKeys: [...new Set(target.revocationKeys)], active: true,
      };
      sessions.set(session.sessionId, session);
      scheduleExpiry(session);
      return { allowed: true, session: { ...session, revocationKeys: [...session.revocationKeys] } };
    },

    async revalidate(sessionId: string): Promise<CapabilityDecision> {
      const session = sessions.get(sessionId);
      return session ? authorize(session) : { allowed: false, reason: 'source-missing' };
    },

    async use(sessionId: string, requested: ComputeCapability): Promise<CapabilityDecision & { result?: { status: string; cancelled?: boolean } }> {
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

    close(sessionId: string): ComputeCapabilitySession | null {
      const session = sessions.get(sessionId);
      return session ? end(session, 'closed') : null;
    },

    invalidateByRevocationKey(source: ComputeCapabilitySource, key: string): number {
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
