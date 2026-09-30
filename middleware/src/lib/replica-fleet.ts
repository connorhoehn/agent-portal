// Which middleware replicas are alive right now, and a mutex for the work only
// one of them may do.
//
// WHY THIS EXISTS. `recoverOrphanedWork` (lib/job-dispatcher.ts) calls
// `reapStaleJobs(0)` at boot — requeue EVERY job still marked claimed/running,
// with no stale window at all. That is justified by one sentence in its own
// comment: "in a single-process middleware any job still marked live at boot is
// orphaned by definition; there is no run left to wait for."
//
// The sentence is true and the middleware autoscales to four tasks
// (infra/lib/middleware-service-stack.ts). At two tasks it is false, and the
// damage is the one already documented for paired workstations: a booting
// replica requeues work another replica is actively running, so the job runs
// twice, is BILLED twice, and the straggler's completion overwrites the newer
// attempt's result. It fires on exactly the events you scale for — a scale-out,
// and every task of a rolling deploy.
//
// So this module answers one question: is another replica alive? When the answer
// is yes, the boot sweep must not assert that somebody else's in-flight work is
// dead; it defers to the periodic sweep, which measures real staleness from
// `heartbeat_at`. That is the same resolution local compute already forced for
// fenced claims, applied to the case where the other executor is a sibling task.
//
// Membership is ONE sorted set (`orgiq:replicas`, score = last heartbeat) rather
// than a key per replica, so reading the fleet is a single range query and
// pruning the dead is a single range delete — no SCAN over the keyspace, and no
// way for a crashed replica to linger as a key nobody revisits.
//
// Everything degrades to "I am alone" when REDIS_URL is unset, which is the
// honest answer for a single task and preserves today's behaviour exactly.

import { RedisLite, lockRedisClient } from './redis-lite.js';

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
   * together do not both sweep. Returns `null` when the lock was already held.
   */
  withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null>;
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
    async withLock<T>(_name: string, _ttlMs: number, fn: () => Promise<T>) { return fn(); },
    async leave() { /* nothing to remove */ },
    stop() { /* no timer */ },
  };
}

export function createReplicaFleet(opts: { redisUrl?: string | null; id?: string } = {}): ReplicaFleet {
  const id = opts.id ?? replicaId();
  const url = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  if (!url) return soloFleet(id);

  const redis = new RedisLite(url);
  const locks = lockRedisClient(redis);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  /** Prune first, then read: a dead replica must never be counted as a peer. */
  const readMembers = async (): Promise<string[]> => {
    await redis.command('ZREMRANGEBYSCORE', FLEET_KEY, '-inf', Date.now() - REPLICA_TTL_MS);
    return redis.zrange(FLEET_KEY, 0, -1);
  };

  const fleet: ReplicaFleet = {
    id,
    async heartbeat() {
      await redis.zadd(FLEET_KEY, Date.now(), id);
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
    async withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
      // A plain SET NX PX, which is what distributed-core's RedisLockProvider
      // builds its fencing on; the value names the holder so a stuck lock is
      // attributable rather than anonymous.
      const key = `orgiq:lock:${name}`;
      const won = await locks.set(key, id, 'NX', 'PX', ttlMs);
      if (won !== 'OK') return null;
      try { return await fn(); } finally {
        // Release only if still ours: if the TTL expired mid-run another
        // replica may legitimately hold it now, and deleting that would hand
        // the lock to a third.
        await locks.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1, key, id,
        ).catch(() => undefined);
      }
    },
    async leave() {
      try { await redis.command('ZREM', FLEET_KEY, id); } catch { /* TTL will do it */ }
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
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
