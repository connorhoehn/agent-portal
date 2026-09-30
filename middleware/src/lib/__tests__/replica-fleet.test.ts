// lib/replica-fleet.ts — who else is executing, and the mutex for work only one
// replica may do.
//
// The reason this module exists is a destructive default: the dispatcher's boot
// recovery requeues EVERY live job with a zero stale window, which is correct
// for one task and duplicates (and re-bills) a sibling's in-flight work at two.
// So the assertions here are mostly about the SAFE direction being chosen:
//   - no Redis → "I am alone", preserving single-task behaviour exactly;
//   - a live sibling → it is reported as a peer;
//   - a silent sibling → pruned, so a crashed replica cannot block recovery
//     forever;
//   - a Redis failure → NOT reported as "alone", because that is the permissive
//     answer that re-enables the destructive sweep;
//   - the lock is held by exactly one caller, and released only by its owner.
//
// Redis tests are skipped unless a server is reachable, so the suite stays green
// on a machine without one rather than failing for the wrong reason.

import net from 'node:net';
import { createReplicaFleet } from '../replica-fleet.js';
import { RedisLite } from '../redis-lite.js';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

function reachable(url: string, timeoutMs = 300): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    const done = (ok: boolean): void => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

let hasRedis = false;
beforeAll(async () => { hasRedis = await reachable(REDIS_URL); });

describe('replica fleet without Redis', () => {
  it('reports itself alone, so the single-task boot sweep is unchanged', async () => {
    const fleet = createReplicaFleet({ redisUrl: null, id: 'solo' });
    expect(await fleet.members()).toEqual(['solo']);
    expect(await fleet.peers()).toEqual([]);
    // And the lock is transparent: the work still runs.
    expect(await fleet.withLock('boot', 1000, async () => 'ran')).toBe('ran');
    fleet.stop();
  });
});

describe('replica fleet over Redis', () => {
  const key = 'orgiq:replicas';
  let redis: RedisLite;

  beforeEach(async () => {
    if (!hasRedis) return;
    redis = new RedisLite(REDIS_URL);
    await redis.del(key, 'orgiq:lock:boot-test');
  });
  afterEach(async () => {
    if (!hasRedis) return;
    await redis.del(key, 'orgiq:lock:boot-test');
    await redis.quit();
  });

  it('sees a sibling replica as a peer, and itself as a member', async () => {
    if (!hasRedis) return;
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    const b = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-b' });
    await a.heartbeat();
    await b.heartbeat();

    expect((await a.members()).sort()).toEqual(['task-a', 'task-b']);
    // This is the value the dispatcher branches on: non-empty means "do not
    // assert somebody else's in-flight work is dead".
    expect(await a.peers()).toEqual(['task-b']);
    expect(await b.peers()).toEqual(['task-a']);
    a.stop(); b.stop();
  });

  it('prunes a replica that stopped heartbeating, so a crash cannot block recovery forever', async () => {
    if (!hasRedis) return;
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    await a.heartbeat();
    // A sibling whose last heartbeat is older than the TTL (45s).
    await redis.zadd(key, Date.now() - 120_000, 'task-dead');
    expect((await redis.zrange(key, 0, -1)).sort()).toEqual(['task-a', 'task-dead']);

    expect(await a.peers()).toEqual([]);
    // Pruned from the set itself, not merely filtered on read.
    expect(await redis.zrange(key, 0, -1)).toEqual(['task-a']);
    a.stop();
  });

  it('leaves the fleet promptly on shutdown rather than waiting out the TTL', async () => {
    if (!hasRedis) return;
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    const b = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-b' });
    await a.heartbeat(); await b.heartbeat();
    expect(await a.peers()).toEqual(['task-b']);

    await b.leave();
    b.stop();
    expect(await a.peers()).toEqual([]);
    a.stop();
  });

  it('grants the lock to exactly one replica, and the loser does not run the work', async () => {
    if (!hasRedis) return;
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    const b = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-b' });
    const order: string[] = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });

    const first = a.withLock('boot-test', 5_000, async () => { order.push('a-ran'); await held; return 'a'; });
    // While A holds it, B must get null rather than running concurrently.
    await new Promise((r) => setTimeout(r, 50));
    expect(await b.withLock('boot-test', 5_000, async () => { order.push('b-ran'); return 'b'; })).toBeNull();
    release!();
    expect(await first).toBe('a');
    expect(order).toEqual(['a-ran']);

    // Released by its owner, so the next boot can take it.
    expect(await b.withLock('boot-test', 5_000, async () => 'b-later')).toBe('b-later');
    a.stop(); b.stop();
  });

  it('does not release a lock it no longer owns', async () => {
    if (!hasRedis) return;
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    // A's lock expires mid-run and B legitimately takes it; A's release must not
    // delete B's lock, which would hand it to a third replica.
    await a.withLock('boot-test', 1, async () => {
      await new Promise((r) => setTimeout(r, 30));
      await redis.command('SET', 'orgiq:lock:boot-test', 'task-b');
    });
    expect(await redis.get('orgiq:lock:boot-test')).toBe('task-b');
    a.stop();
  });

  it('treats an unreachable Redis as "peers unknown", never as "I am alone"', async () => {
    // Port 1 refuses instantly. The permissive answer here would re-enable the
    // destructive zero-window sweep, so the safe direction is asserted.
    const a = createReplicaFleet({ redisUrl: 'redis://127.0.0.1:1', id: 'task-a' });
    expect((await a.peers()).length).toBeGreaterThan(0);
    a.stop();
  });
});
