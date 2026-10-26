// Which middleware replicas are alive right now, and a mutex for the work only
// one of them may do.
//
// A replica's presence prevents another from declaring legacy tokenless jobs
// orphaned at boot. Current push and pull jobs have per-attempt SQL tokens and
// heartbeats, so every replica leaves them to the ordinary stale sweep.
// Named maintenance locks use the shared FencedLease owner: renewable, bounded
// on dependency loss, and paired with conditional writes at the destination.
//
// Membership is ONE sorted set (`orgiq:replicas`, score = last heartbeat) rather
// than a key per replica, so reading the fleet is a single range query and
// pruning the dead is a single range delete — no SCAN over the keyspace, and no
// way for a crashed replica to linger as a key nobody revisits.
//
// Everything degrades to "I am alone" when REDIS_URL is unset, which is the
// honest answer for a single task and preserves today's behaviour exactly.

import { FencedLease, LeaseHeldError, createBoundedRedis, type BoundedRedis } from '@connorhoehn/realtime-modules/server';
import { createRedisStore } from './redis-store.js';

const FLEET_KEY = 'orgiq:replicas';
/** A replica silent this long is treated as gone. Must exceed the heartbeat. */
const REPLICA_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;

let cachedId: string | null = null;

/**
 * This process's identity in the fleet, computed once.
 *
 * Two replicas sharing an id fail SILENTLY and completely: each treats the
 * other's frames as its own echo and drops them, so fan-out looks wired up and
 * delivers nothing. That is not hypothetical — it is what an early version of
 * this did, because the fallback was `local-<pid>` and two gateways in one
 * process share a pid. ECS task ids are distinct, but the fallback must be too,
 * so it carries a random suffix. Memoized because a per-call random value would
 * hand the gateway and the fleet registry different identities for the same
 * process.
 */
export function replicaId(): string {
  if (cachedId) return cachedId;
  const fromEcs = (process.env['ECS_TASK_ID'] ?? '').trim();
  const meta = (process.env['ECS_CONTAINER_METADATA_URI_V4'] ?? '').trim();
  const fromMeta = meta ? meta.split('/').pop() : '';
  const explicit = (process.env['REPLICA_ID'] ?? '').trim();
  cachedId = fromEcs || fromMeta || explicit
    || `local-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return cachedId;
}

export interface ReplicaLock {
  readonly signal: AbortSignal;
  readonly token: number;
  /** Check before each mutation; the destination still needs conditional writes. */
  assertLive(): void;
}

export interface ReplicaFleet {
  readonly id: string;
  /** Record this replica as alive. Safe to call repeatedly. */
  heartbeat(): Promise<void>;
  /** Live replica ids INCLUDING this one, freshest state available. */
  members(): Promise<string[]>;
  /** Live replicas other than this one. `[]` means "I am the only executor". */
  peers(): Promise<string[]>;
  /**
   * Run `fn` only if this replica wins the named lock, so two replicas booting
   * together do not both sweep. Renews through the callback; loss aborts the
   * context and rejects. Returns `null` when another owner holds the lock.
   */
  withLock<T>(name: string, ttlMs: number, fn: (lease?: ReplicaLock) => Promise<T>): Promise<T | null>;
  /** Leave the fleet promptly rather than waiting out the TTL. */
  leave(): Promise<void>;
  stop(): void;
}

/** The no-Redis case: exactly one executor, which is the truth for one task. */
function soloFleet(id: string): ReplicaFleet {
  return {
    id,
    async heartbeat() { /* nothing to record */ },
    async members() { return [id]; },
    async peers() { return []; },
    async withLock<T>(_name: string, _ttlMs: number, fn: (lease?: ReplicaLock) => Promise<T>) { return fn({ signal: new AbortController().signal, token: 0, assertLive() {} }); },
    async leave() { /* nothing to remove */ },
    stop() { /* no timer */ },
  };
}

export function createReplicaFleet(opts: { redisUrl?: string | null; id?: string } = {}): ReplicaFleet {
  const id = opts.id ?? replicaId();
  const url = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  if (!url) return soloFleet(id);

  let connection: Promise<BoundedRedis> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const leases = new Set<FencedLease>();

  // The fleet API is synchronous, while each operation awaits the library's
  // connection. Failed connections are discarded so a later heartbeat can
  // recover; no failed read is ever interpreted as an empty fleet.
  const withRedis = async <T>(operation: (redis: BoundedRedis) => Promise<T>): Promise<T> => {
    if (stopped) throw new Error('Replica fleet is stopped');
    const pending = connection ??= createBoundedRedis(url);
    try {
      const redis = await pending;
      if (stopped) throw new Error('Replica fleet is stopped');
      return await operation(redis);
    } catch (error) {
      if (connection === pending) connection = null;
      await pending.then(redis => redis.quit()).catch(() => undefined);
      throw error;
    }
  };

  /** Prune first, then read: a dead replica must never be counted as a peer. */
  const readMembers = (): Promise<string[]> => withRedis(async redis => {
    await redis.command('ZREMRANGEBYSCORE', FLEET_KEY, '-inf', Date.now() - REPLICA_TTL_MS);
    return createRedisStore(redis).zrange(FLEET_KEY, 0, -1);
  });

  const fleet: ReplicaFleet = {
    id,
    async heartbeat() {
      await withRedis(redis => redis.command('ZADD', FLEET_KEY, Date.now(), id));
    },
    async members() {
      try { return await readMembers(); } catch {
        // A Redis failure must not be read as "I am alone" — that is the
        // permissive answer, and it re-enables the destructive boot sweep.
        // Claiming the fleet is larger than we can see is the safe direction.
        return [id, 'unknown-peer'];
      }
    },
    async peers() {
      return (await fleet.members()).filter((m) => m !== id);
    },
    async withLock<T>(name: string, ttlMs: number, fn: (lease?: ReplicaLock) => Promise<T>): Promise<T | null> {
      const lease = await withRedis(async redis => {
        const candidate = new FencedLease({ redis, key: `orgiq:lock:${name}`, leaseMs: ttlMs });
        try { await candidate.acquire(); return candidate; }
        catch (error) { if (error instanceof LeaseHeldError) return null; throw error; }
      });
      if (!lease) return null;
      leases.add(lease);
      const controller = new AbortController();
      const off = lease.onFence(event => controller.abort(new Error(`Replica lock lost: ${event.reason}`)));
      const assertLive = () => {
        if (!lease.isLive()) throw controller.signal.reason ?? new Error('Replica lock is not live');
      };
      let onAbort: (() => void) | undefined;
      try {
        assertLive();
        const lost = new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const result = await Promise.race([fn({ signal: controller.signal, token: lease.token, assertLive }), lost]);
        assertLive();
        return result;
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        off();
        leases.delete(lease);
        await lease.release();
      }
    },
    async leave() {
      try { await withRedis(redis => redis.command('ZREM', FLEET_KEY, id)); } catch { /* TTL will do it */ }
    },
    stop() {
      stopped = true;
      for (const lease of leases) lease.fence('manual', 'Replica fleet stopped');
      if (timer) clearInterval(timer);
      timer = null;
      const pending = connection;
      connection = null;
      void pending?.then(redis => redis.quit()).catch(() => undefined);
    },
  };

  void fleet.heartbeat().catch(() => undefined);
  timer = setInterval(() => {
    if (stopped) return;
    void fleet.heartbeat().catch(() => undefined);
  }, HEARTBEAT_MS);
  timer.unref?.();
  return fleet;
}

let shared: ReplicaFleet | null = null;

/** The process-wide fleet handle. Created on first use. */
export function replicaFleet(): ReplicaFleet {
  shared ??= createReplicaFleet();
  return shared;
}

/** Tests only — drop the shared handle so a new REDIS_URL takes effect. */
export function resetReplicaFleet(): void {
  shared?.stop();
  shared = null;
}
