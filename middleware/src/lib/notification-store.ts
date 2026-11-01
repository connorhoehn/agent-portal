// Where the gateway's notification inbox lives (docs/social-tenant-design.md §3.3, §3.5).
//
// realtime-modules' `RedisNotificationStore` persists each user's inbox as a
// sorted set + a read-state hash, and with no Redis client it persists
// NOTHING — delivery to live tabs still works, but there is no replay on
// connect, so a reload shows an empty bell. That is the wrong local default
// for a header control, so without REDIS_URL the same store runs over
// `MemoryNotificationRedis` below: the library's own keying, trimming and
// read-state logic, over an in-process Map. Nothing survives a restart, and
// under `tsx watch` every save is a restart — which is what the dev:mock seed
// (mock/notifications.ts) is for.
//
// With REDIS_URL the store runs over lib/redis-store.ts through
// `notificationRedisClient`, on the connection that already backs call state.

import { RedisNotificationStore } from '@connorhoehn/realtime-modules/notification';
import { config } from '../config.js';
import { notificationRedisClient, type NotificationRedisLike, type GatewayRedisStore } from './redis-store.js';
import { holdsGrant, shapeNotification } from './social-notify.js';
import { notificationsFixture } from '../mock/notifications.js';
import { mockRestartMirror } from '../mock/restart-state.js';
import { onCloneRemoved } from '../mock/identity-clones.js';

// Explicitly own the library's key prefixes so mock cleanup never guesses at
// its private state or touches a real Redis inbox.
const LIST_PREFIX = 'notif:list:';
const READ_PREFIX = 'notif:read:';

type Entry = { score: number; value: string };

/** The eight commands `RedisNotificationStore` uses, in memory, with Redis's ordering and rank rules. */
export class MemoryNotificationRedis implements NotificationRedisLike {
  private readonly zsets = new Map<string, Entry[]>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly retiredKeys = new Set<string>();

  private sorted(key: string): Entry[] {
    return this.zsets.get(key) ?? [];
  }

  /** Redis rank arithmetic: negative indices count from the end; the range is inclusive. */
  private span(len: number, start: number, stop: number): [number, number] {
    let s = start < 0 ? len + start : start;
    let e = stop < 0 ? len + stop : stop;
    s = Math.max(0, s);
    e = Math.min(len - 1, e);
    return [s, e];
  }

  async zAdd(key: string, member: Entry): Promise<number> {
    if (this.retiredKeys.has(key)) return 0;
    const list = this.sorted(key).filter((m) => m.value !== member.value);
    const added = list.length === this.sorted(key).length ? 1 : 0;
    list.push({ score: member.score, value: member.value });
    list.sort((a, b) => a.score - b.score || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    this.zsets.set(key, list);
    return added;
  }

  async zRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.sorted(key);
    const [s, e] = this.span(list.length, start, stop);
    return s > e ? [] : list.slice(s, e + 1).map((m) => m.value);
  }

  async zCard(key: string): Promise<number> {
    return this.sorted(key).length;
  }

  async zRemRangeByRank(key: string, start: number, stop: number): Promise<number> {
    const list = this.sorted(key);
    const [s, e] = this.span(list.length, start, stop);
    if (s > e) return 0;
    list.splice(s, e - s + 1);
    if (list.length === 0) this.zsets.delete(key);
    return e - s + 1;
  }

  async hSet(key: string, field: string, value: string): Promise<number> {
    if (this.retiredKeys.has(key)) return 0;
    const h = this.hashes.get(key) ?? new Map<string, string>();
    const added = h.has(field) ? 0 : 1;
    h.set(field, value);
    this.hashes.set(key, h);
    return added;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  /** TTLs are not modelled: the process is the lifetime. */
  async expire(key: string): Promise<number> {
    return this.zsets.has(key) || this.hashes.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const had = this.zsets.delete(key) || this.hashes.delete(key);
    return had ? 1 : 0;
  }

  restore(snapshot: NonNullable<ReturnType<typeof mockRestartMirror<'notifications'>>>): void {
    for (const [key, entries] of snapshot.zsets) this.zsets.set(key, entries);
    for (const [key, entries] of snapshot.hashes) this.hashes.set(key, new Map(entries));
  }

  clear(): void {
    this.zsets.clear();
    this.hashes.clear();
  }

  /** Synchronous, exact-user cleanup; an in-flight append/read cannot recreate it. */
  removeClone(userId: string): void {
    for (const key of [LIST_PREFIX + userId, READ_PREFIX + userId]) {
      this.retiredKeys.add(key);
      this.zsets.delete(key);
      this.hashes.delete(key);
    }
  }
}

const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn('[notifications]', msg, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error('[notifications]', msg, meta ?? ''),
};

let active: { store: RedisNotificationStore; memory: MemoryNotificationRedis | null; restoredRestart?: boolean } | null = null;
onCloneRemoved(id => { if (config.mock?.aurora) active?.memory?.removeClone(id); });

/** Build the inbox the gateway's `notifications({ store })` feature persists into. */
export function createGatewayNotificationStore(redis: GatewayRedisStore | null): { store: RedisNotificationStore; memory: MemoryNotificationRedis | null } {
  const memory = redis ? null : new MemoryNotificationRedis();
  const store = new RedisNotificationStore({ redisClient: redis ? notificationRedisClient(redis) : memory, logger, listKeyPrefix: LIST_PREFIX, readKeyPrefix: READ_PREFIX });
  const snapshot = config.mock.aurora ? mockRestartMirror('notifications') : undefined;
  if (memory && snapshot) memory.restore(snapshot);
  active = { store, memory, restoredRestart: !!(memory && snapshot) };
  return active;
}

export function releaseGatewayNotificationStore(): void {
  active = null;
}

/**
 * Seed the in-memory inbox from the `notifications` fixture (dev:mock only,
 * memory store only — a Redis inbox is somebody's real state). Each row goes
 * through the grant rule, so the seed cannot put an item in a header whose
 * session could not have received it live. Resolves to the rows written.
 */
export async function seedMockNotifications(): Promise<number> {
  const target = active;
  if (!config.mock?.aurora || !target?.memory) return 0;
  if (target.restoredRestart) { target.restoredRestart = false; return 0; }
  target.memory.clear();
  let written = 0;
  for (const row of notificationsFixture.rows()) {
    if (!(await holdsGrant(row.userId, row.tenant))) continue;
    const shaped = shapeNotification({
      id: row.id, type: row.type, title: row.title, body: row.body, timestamp: row.timestamp,
      ...(row.channel ? { channel: row.channel } : {}),
      payload: { ...row.extra, tenant: row.tenant },
      action: { label: row.actionLabel, href: row.href },
    });
    await target.store.append(row.userId, { ...shaped, id: row.id, timestamp: row.timestamp });
    written += 1;
  }
  return written;
}

/**
 * The mock control plane's hook: after a reset or a scenario switch the inbox
 * is rebuilt from the fixture (items delivered since are dropped with it — the
 * whole point of reset). Synchronous for rehydrateAll; the seed itself is a
 * few in-memory writes. Throws when the fixture is pinned to a scenario that
 * throws, which rehydrateAll catches per step.
 */
export function rehydrateMockNotifications(): void {
  if (!config.mock?.aurora || !active?.memory) return;
  notificationsFixture.rows();
  void seedMockNotifications().catch((err: unknown) => {
    console.warn(`[notifications] mock seed failed: ${(err as Error).message}`);
  });
}
