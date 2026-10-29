// Shared devbox fleet state across middleware replicas (DE-47).
//
// lib/devbox-fleet.ts keeps its synchronous per-process Maps; this module is
// the cross-replica truth those Maps are refreshed from. It holds the fields
// that gate decisions, and nothing else:
//
//   - one record per box: the last structural snapshot (status, task clock,
//     label…) stamped with when it was taken, plus the activity clock,
//     max-merged so a replica with a stale copy can never move it backwards;
//   - holds per box: who is counting on it (the dispatcher's exclusive claim,
//     an SDLC run's reservation), each with an expiry its holder renews, so a
//     replica that dies lets go on its own;
//   - an event channel per box, so a tail on one replica sees a run on another.
//
// Two backends: Redis (the deployed shape, any time there is more than one
// task) and an in-memory one that several fleet instances in one test process
// can share. With neither attached the fleet behaves exactly as it did before
// this file existed, which is the truth for one process (dev:mock, a laptop).

import { createBoundedRedis, type BoundedRedis } from '@connorhoehn/realtime-modules/server';
import type { FleetBox } from './devbox-fleet.js';

export interface SharedBoxRecord {
  box: FleetBox;
  /** When the structural snapshot was taken (epoch ms). Newer wins. */
  stateAt: number;
  /** The activity clock (epoch ms), max-merged across replicas. */
  activityMs: number;
  /** The replica that wrote the snapshot. */
  origin: string;
}

export interface FleetSharedBackend {
  readonly kind: 'memory' | 'redis';
  /** Upsert a structural snapshot; an older `stateAt` than the stored one only merges activity. */
  putBox(rec: { box: FleetBox; stateAt: number; origin: string }): Promise<void>;
  /** Move the activity clock forward (never back). */
  touch(id: string, activityMs: number): Promise<void>;
  removeBox(id: string): Promise<void>;
  readAll(): Promise<SharedBoxRecord[]>;
  /**
   * Take or renew a hold. `exclusive` succeeds only when no OTHER live holder
   * exists (the dispatcher's claim); a non-exclusive hold always lands (a
   * reservation: several holders may hold one box). Expired holds are pruned
   * first, so a dead replica's hold never blocks forever.
   */
  hold(id: string, holder: string, ttlMs: number, exclusive: boolean): Promise<boolean>;
  release(id: string, holder: string): Promise<void>;
  /** Live holders per box id (boxes with none are absent). */
  holders(ids: readonly string[]): Promise<Map<string, string[]>>;
  publish(id: string, message: string): Promise<void>;
  subscribe(id: string, receive: (message: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Stopped boxes' records linger this long for late readers, then expire. */
const STOPPED_RECORD_TTL_MS = 24 * 3_600_000;

// ─── In memory ───────────────────────────────────────────────────────────────

/**
 * One process-local "Redis". Several fleet module instances (jest
 * isolateModules) attached to the same object behave like replicas over one
 * store. `now` is injectable so hold expiry is testable without waiting.
 */
export function createMemoryFleetBackend(opts: { now?: () => number } = {}): FleetSharedBackend {
  const clock = opts.now ?? Date.now;
  const records = new Map<string, SharedBoxRecord>();
  const holds = new Map<string, Map<string, number>>();
  const channels = new Map<string, Set<(m: string) => void>>();
  const live = (id: string): Map<string, number> => {
    const h = holds.get(id) ?? new Map<string, number>();
    const t = clock();
    for (const [holder, until] of h) if (until <= t) h.delete(holder);
    if (h.size === 0) holds.delete(id); else holds.set(id, h);
    return h;
  };
  return {
    kind: 'memory',
    async putBox({ box, stateAt, origin }) {
      const prev = records.get(box.id);
      const act = Math.max(prev?.activityMs ?? 0, Date.parse(box.lastActivityAt) || 0);
      if (prev && prev.stateAt > stateAt) { prev.activityMs = act; return; }
      records.set(box.id, { box: { ...box }, stateAt, activityMs: act, origin });
    },
    async touch(id, activityMs) {
      const prev = records.get(id);
      if (prev && activityMs > prev.activityMs) prev.activityMs = activityMs;
    },
    async removeBox(id) { records.delete(id); holds.delete(id); },
    async readAll() { return [...records.values()].map((r) => ({ ...r, box: { ...r.box } })); },
    async hold(id, holder, ttlMs, exclusive) {
      const h = live(id);
      if (exclusive && [...h.keys()].some((k) => k !== holder)) return false;
      h.set(holder, clock() + ttlMs);
      holds.set(id, h);
      return true;
    },
    async release(id, holder) {
      const h = holds.get(id);
      if (!h) return;
      h.delete(holder);
      if (h.size === 0) holds.delete(id);
    },
    async holders(ids) {
      const out = new Map<string, string[]>();
      for (const id of ids) { const h = live(id); if (h.size) out.set(id, [...h.keys()]); }
      return out;
    },
    async publish(id, message) {
      for (const cb of [...(channels.get(id) ?? [])]) { try { cb(message); } catch { /* one bad listener */ } }
    },
    async subscribe(id, receive) {
      let set = channels.get(id);
      if (!set) { set = new Set(); channels.set(id, set); }
      set.add(receive);
      return async () => { set!.delete(receive); };
    },
    async close() { channels.clear(); },
  };
}

// ─── Redis ───────────────────────────────────────────────────────────────────

/** Upsert a box record: newer snapshot wins, activity is max-merged, index kept. */
const PUT_LUA = `
local prevState = tonumber(redis.call('HGET', KEYS[1], 'stateAt') or '-1')
local prevAct = tonumber(redis.call('HGET', KEYS[1], 'activity') or '0')
local act = tonumber(ARGV[3])
if prevAct > act then act = prevAct end
if prevState > tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'activity', act)
  return 0
end
redis.call('HSET', KEYS[1], 'json', ARGV[1], 'stateAt', ARGV[2], 'activity', act, 'origin', ARGV[4])
redis.call('SADD', KEYS[2], ARGV[5])
if tonumber(ARGV[6]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[6]) else redis.call('PERSIST', KEYS[1]) end
return 1`;

/** Move the activity clock forward only; a missing record is left missing. */
const TOUCH_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local prev = tonumber(redis.call('HGET', KEYS[1], 'activity') or '0')
if tonumber(ARGV[1]) > prev then redis.call('HSET', KEYS[1], 'activity', ARGV[1]) return 1 end
return 0`;

/** Prune expired holders, refuse an exclusive claim over another live holder, record. */
const HOLD_LUA = `
local now = tonumber(ARGV[3])
local all = redis.call('HGETALL', KEYS[1])
local maxUntil = tonumber(ARGV[2])
for i = 1, #all, 2 do
  local exp = tonumber(all[i + 1])
  if exp <= now then redis.call('HDEL', KEYS[1], all[i])
  elseif exp > maxUntil then maxUntil = exp end
end
if ARGV[4] == '1' then
  local others = redis.call('HLEN', KEYS[1]) - redis.call('HEXISTS', KEYS[1], ARGV[1])
  if others > 0 then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIREAT', KEYS[1], maxUntil)
return 1`;

type RedisPort = Pick<BoundedRedis, 'command' | 'publish' | 'subscribe' | 'quit'>;

export function createRedisFleetBackend(opts: {
  url?: string;
  /** Inject a connection (tests); otherwise one is opened lazily from `url`. */
  redis?: RedisPort;
  /** Key namespace; tests use a unique one. Default `orgiq:devbox`. */
  prefix?: string;
}): FleetSharedBackend {
  const prefix = opts.prefix ?? 'orgiq:devbox';
  const indexKey = `${prefix}:boxes`;
  const boxKey = (id: string) => `${prefix}:box:${id}`;
  const holdKey = (id: string) => `${prefix}:holds:${id}`;
  // The spec's channel name: `orgiq:devbox:<boxId>`.
  const channel = (id: string) => `${prefix}:${id}`;

  let connection: Promise<RedisPort> | null = opts.redis ? Promise.resolve(opts.redis) : null;
  let closed = false;
  // Same discipline as lib/replica-fleet.ts: a failed connection is dropped so
  // the next call reconnects, and a failure is thrown, never read as "empty".
  const withRedis = async <T>(op: (r: RedisPort) => Promise<T>): Promise<T> => {
    if (closed) throw new Error('Shared fleet backend is closed');
    if (!connection) {
      if (!opts.url) throw new Error('Shared fleet backend has no Redis URL');
      connection = createBoundedRedis(opts.url);
    }
    const pending = connection;
    try {
      return await op(await pending);
    } catch (err) {
      if (!opts.redis && connection === pending) {
        connection = null;
        await pending.then((r) => r.quit()).catch(() => undefined);
      }
      throw err;
    }
  };

  return {
    kind: 'redis',
    async putBox({ box, stateAt, origin }) {
      const act = Date.parse(box.lastActivityAt) || 0;
      const ttl = box.status === 'stopped' ? STOPPED_RECORD_TTL_MS : 0;
      await withRedis((r) => r.command('EVAL', PUT_LUA, 2, boxKey(box.id), indexKey,
        JSON.stringify(box), stateAt, act, origin, box.id, ttl));
    },
    async touch(id, activityMs) {
      await withRedis((r) => r.command('EVAL', TOUCH_LUA, 1, boxKey(id), Math.floor(activityMs)));
    },
    async removeBox(id) {
      await withRedis(async (r) => {
        await r.command('DEL', boxKey(id), holdKey(id));
        await r.command('SREM', indexKey, id);
      });
    },
    async readAll() {
      return withRedis(async (r) => {
        const ids = await r.command('SMEMBERS', indexKey);
        if (!Array.isArray(ids)) throw new Error('Invalid Redis set reply');
        const out: SharedBoxRecord[] = [];
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          const reply = await r.command('HMGET', boxKey(id), 'json', 'stateAt', 'activity', 'origin');
          if (!Array.isArray(reply)) throw new Error('Invalid Redis hash reply');
          const [json, stateAt, activity, origin] = reply;
          if (typeof json !== 'string') { await r.command('SREM', indexKey, id); continue; }
          try {
            out.push({
              box: JSON.parse(json) as FleetBox,
              stateAt: Number(stateAt) || 0,
              activityMs: Number(activity) || 0,
              origin: typeof origin === 'string' ? origin : '',
            });
          } catch { /* a corrupt record is skipped, not fatal */ }
        }
        return out;
      });
    },
    async hold(id, holder, ttlMs, exclusive) {
      const now = Date.now();
      const reply = await withRedis((r) => r.command('EVAL', HOLD_LUA, 1, holdKey(id),
        holder, now + Math.max(1, Math.floor(ttlMs)), now, exclusive ? '1' : '0'));
      return reply === 1;
    },
    async release(id, holder) {
      await withRedis((r) => r.command('HDEL', holdKey(id), holder));
    },
    async holders(ids) {
      return withRedis(async (r) => {
        const out = new Map<string, string[]>();
        const now = Date.now();
        for (const id of ids) {
          const reply = await r.command('HGETALL', holdKey(id));
          if (!Array.isArray(reply)) throw new Error('Invalid Redis hash reply');
          const live: string[] = [];
          for (let i = 0; i + 1 < reply.length; i += 2) {
            if (Number(reply[i + 1]) > now) live.push(String(reply[i]));
          }
          if (live.length) out.set(id, live);
        }
        return out;
      });
    },
    async publish(id, message) {
      await withRedis((r) => r.publish(channel(id), message));
    },
    async subscribe(id, receive) {
      return withRedis((r) => r.subscribe(channel(id), receive));
    },
    async close() {
      closed = true;
      const pending = connection;
      connection = null;
      if (!opts.redis) await pending?.then((r) => r.quit()).catch(() => undefined);
    },
  };
}

// ─── Boot wiring ─────────────────────────────────────────────────────────────

/**
 * Whether this process shares fleet state, from `DEVBOX_SHARED_STATE`:
 *   auto (default) — Redis when REDIS_URL is set and Aurora is real. dev:mock
 *                    stays single-process even beside a local Redis, because
 *                    its fleet is a registered fixture `__mock/reset` rebuilds
 *                    and a Redis copy would outlive the reset;
 *   redis          — Redis whenever REDIS_URL is set;
 *   off            — never.
 */
export function sharedFleetMode(env: NodeJS.ProcessEnv, mockAurora: boolean): { mode: 'redis' | 'off'; url: string | null; why: string } {
  const want = (env['DEVBOX_SHARED_STATE'] ?? 'auto').trim().toLowerCase();
  const url = (env['REDIS_URL'] ?? '').trim() || null;
  if (want === 'off') return { mode: 'off', url: null, why: 'DEVBOX_SHARED_STATE=off' };
  if (!url) return { mode: 'off', url: null, why: 'no REDIS_URL — one process is its own truth' };
  if (want === 'redis') return { mode: 'redis', url, why: 'DEVBOX_SHARED_STATE=redis' };
  if (mockAurora) return { mode: 'off', url: null, why: 'mock Aurora — the fleet is a fixture' };
  return { mode: 'redis', url, why: 'REDIS_URL set' };
}
