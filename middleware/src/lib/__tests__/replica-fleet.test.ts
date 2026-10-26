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
// Redis cases require an explicit TEST_REDIS_URL to a disposable loopback
// server. Never delete fleet keys from the shared development Redis by default.

import { createReplicaFleet } from '../replica-fleet.js';
import { openRedisStore, type GatewayRedisStore } from '../redis-store.js';

const REDIS_URL = process.env['TEST_REDIS_URL'];
const redisSuite = REDIS_URL ? describe : describe.skip;
if (REDIS_URL && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(REDIS_URL).hostname)) {
  throw new Error('TEST_REDIS_URL must name a dedicated loopback Redis');
}

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

redisSuite('replica fleet over Redis', () => {
  const key = 'orgiq:replicas';
  let redis: GatewayRedisStore;

  beforeEach(async () => {
    redis = await openRedisStore(REDIS_URL!);
    await redis.del(key, 'orgiq:lock:boot-test', 'orgiq:lock:boot-test:fence');
  });
  afterEach(async () => {
    await redis.del(key, 'orgiq:lock:boot-test', 'orgiq:lock:boot-test:fence');
    await redis.quit();
  });

  it('sees a sibling replica as a peer, and itself as a member', async () => {
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

  it('renews long work beyond the original TTL without admitting a competitor', async () => {
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    const b = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-b' });
    try {
      await a.withLock('boot-test', 600, async lease => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        lease!.assertLive();
        expect(lease!.signal.aborted).toBe(false);
        expect(await b.withLock('boot-test', 600, async () => 'wrong')).toBeNull();
      });
      expect(await b.withLock('boot-test', 600, async () => 'next')).toBe('next');
    } finally { a.stop(); b.stop(); }
  });

  it('fences displaced work without deleting the replacement lock or continuing writes', async () => {
    const a = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-a' });
    let staleWrite = false;
    let finished: Promise<void> | undefined;
    try {
      await expect(a.withLock('boot-test', 600, async lease => {
        await redis.command('SET', 'orgiq:lock:boot-test', 'task-b');
        finished = new Promise<void>(resolve => setTimeout(resolve, 500)).then(() => {
          expect(lease!.signal.aborted).toBe(true);
          expect(() => lease!.assertLive()).toThrow();
          if (!lease!.signal.aborted) staleWrite = true;
        });
        await finished;
      })).rejects.toThrow('Replica lock lost');
      await finished;
      expect(staleWrite).toBe(false);
      expect(await redis.get('orgiq:lock:boot-test')).toBe('task-b');
    } finally { a.stop(); }
  });

  it('treats an unreachable Redis as "peers unknown", never as "I am alone"', async () => {
    // Port 1 refuses instantly. The permissive answer here would re-enable the
    // destructive zero-window sweep, so the safe direction is asserted.
    const a = createReplicaFleet({ redisUrl: 'redis://127.0.0.1:1', id: 'task-a' });
    expect((await a.peers()).length).toBeGreaterThan(0);
    a.stop();
  });

  it('keeps a healthy transport after failed application work, and closes it on stop', async () => {
    const clients = async () => new Set(String(await redis.command('CLIENT', 'LIST')).trim().split('\n')
      .map(line => line.match(/^id=(\d+)/)?.[1]).filter(Boolean));
    const before = await clients();
    const fleet = createReplicaFleet({ redisUrl: REDIS_URL, id: 'task-lifecycle' });
    try {
      await fleet.heartbeat();
      const owned = [...await clients()].filter(id => !before.has(id));
      expect(owned).toHaveLength(3);
      await expect(fleet.withLock('boot-test', 5000, async () => { throw new Error('work failed'); })).rejects.toThrow('work failed');
      await fleet.heartbeat();
      const afterWork = await clients();
      expect(owned.every(id => afterWork.has(id))).toBe(true);
      expect(await redis.get('orgiq:lock:boot-test')).toBeNull();
      fleet.stop();
      await expect(fleet.heartbeat()).rejects.toThrow('stopped');
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const remaining = await clients();
        if (owned.every(id => !remaining.has(id))) return;
      }
      throw new Error('stopped fleet retained Redis connections');
    } finally { fleet.stop(); }
  });
});
