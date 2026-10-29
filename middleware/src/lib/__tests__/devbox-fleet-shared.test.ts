// The shared fleet store's contract (DE-47), run against the in-memory
// backend always and against a real Redis when TEST_REDIS_URL names a
// disposable loopback server (same rule as replica-fleet.test.ts):
//
//   TEST_REDIS_URL=redis://127.0.0.1:<port> npx jest src/lib/__tests__/devbox-fleet-shared.test.ts
//
// The Redis suite writes only under a unique key prefix and deletes it after.

import { randomUUID } from 'node:crypto';
import {
  createMemoryFleetBackend, createRedisFleetBackend, sharedFleetMode, type FleetSharedBackend,
} from '../devbox-fleet-shared.js';
import type { FleetBox } from '../devbox-fleet.js';
import { openRedisStore } from '../redis-store.js';

const REDIS_URL = process.env['TEST_REDIS_URL'];
if (REDIS_URL && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(REDIS_URL).hostname)) {
  throw new Error('TEST_REDIS_URL must name a dedicated loopback Redis');
}
const redisSuite = REDIS_URL ? describe : describe.skip;

const box = (over: Partial<FleetBox> = {}): FleetBox => ({
  id: 'b1', label: 'b1', sessionId: 'x'.repeat(40), status: 'idle',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function contract(name: string, make: () => FleetSharedBackend, cleanup: () => Promise<void> = async () => undefined) {
  describe(name, () => {
    let backend: FleetSharedBackend;
    beforeEach(() => { backend = make(); });
    afterEach(async () => { await backend.close(); await cleanup(); });

    it('keeps the newer snapshot and max-merges the activity clock', async () => {
      const t0 = Date.now() - 60_000;
      await backend.putBox({ box: box({ status: 'running' }), stateAt: 200, origin: 'a' });
      await backend.putBox({ box: box({ status: 'idle', lastActivityAt: new Date(t0 + 30_000).toISOString() }), stateAt: 100, origin: 'b' });
      let [rec] = await backend.readAll();
      expect(rec?.box.status).toBe('running');
      expect(rec?.origin).toBe('a');
      expect(rec?.activityMs).toBe(t0 + 30_000);       // the stale write still moved activity forward

      await backend.touch('b1', t0 + 50_000);
      await backend.touch('b1', t0 + 10_000);           // never backwards
      [rec] = await backend.readAll();
      expect(rec?.activityMs).toBe(t0 + 50_000);

      await backend.touch('nobody', t0);                // a touch never creates a record
      expect((await backend.readAll()).map((r) => r.box.id)).toEqual(['b1']);

      await backend.removeBox('b1');
      expect(await backend.readAll()).toEqual([]);
    });

    it('exclusive holds exclude other holders; non-exclusive holds stack; releases free', async () => {
      expect(await backend.hold('b1', 'dispatcher:a', 60_000, true)).toBe(true);
      expect(await backend.hold('b1', 'dispatcher:a', 60_000, true)).toBe(true);   // renewing your own
      expect(await backend.hold('b1', 'dispatcher:b', 60_000, true)).toBe(false);
      expect(await backend.hold('b1', 'sdlc:r1', 60_000, false)).toBe(true);
      expect((await backend.holders(['b1', 'b2'])).get('b1')?.sort()).toEqual(['dispatcher:a', 'sdlc:r1']);
      await backend.release('b1', 'dispatcher:a');
      expect(await backend.hold('b1', 'dispatcher:b', 60_000, true)).toBe(false);   // the reservation still holds it
      await backend.release('b1', 'sdlc:r1');
      expect(await backend.hold('b1', 'dispatcher:b', 60_000, true)).toBe(true);
    });

    it('an expired hold no longer blocks a claim', async () => {
      expect(await backend.hold('b1', 'dispatcher:dead', 1, true)).toBe(true);
      await settle();
      expect((await backend.holders(['b1'])).get('b1')).toBeUndefined();
      expect(await backend.hold('b1', 'dispatcher:live', 60_000, true)).toBe(true);
    });

    it('delivers published events to subscribers of that box only', async () => {
      const got: string[] = [];
      const off = await backend.subscribe('b1', (m) => got.push(m));
      await backend.publish('b2', 'other');
      await backend.publish('b1', 'mine');
      await settle();
      expect(got).toEqual(['mine']);
      await off();
      await backend.publish('b1', 'after');
      await settle();
      expect(got).toEqual(['mine']);
    });
  });
}

contract('in-memory shared fleet backend', () => createMemoryFleetBackend());

redisSuite('Redis shared fleet backend', () => {
  const prefix = `test:devbox:${randomUUID()}`;
  contract('contract', () => createRedisFleetBackend({ url: REDIS_URL!, prefix }), async () => {
    const redis = await openRedisStore(REDIS_URL!);
    try {
      const keys = await redis.command('KEYS', `${prefix}*`);
      if (Array.isArray(keys) && keys.length) await redis.del(...(keys as string[]));
    } finally { await redis.quit(); }
  });

  it('two fleet modules over one Redis behave as two replicas (claim once, fresh activity wins)', async () => {
    type FleetMod = typeof import('../devbox-fleet.js');
    const load = (): FleetMod => {
      let out!: FleetMod;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      jest.isolateModules(() => { out = require('../devbox-fleet.js') as FleetMod; });
      return out;
    };
    const p2 = `test:devbox:${randomUUID()}`;
    const a = load();
    const b = load();
    a.attachSharedFleet(createRedisFleetBackend({ url: REDIS_URL!, prefix: p2 }), { replicaId: 'task-a', touchFlushMs: 0 });
    b.attachSharedFleet(createRedisFleetBackend({ url: REDIS_URL!, prefix: p2 }), { replicaId: 'task-b', touchFlushMs: 0 });
    try {
      const created = a.registerBox({ sessionId: 'r'.repeat(40), id: 'rbox' });
      b.hydrateBoxes([{ ...created, lastActivityAt: new Date(Date.now() - 30 * 60_000).toISOString() }]);
      a.appendEvent('rbox', { type: 'task_started', prompt: 'go' });
      await settle();
      await b.refreshFromShared();
      expect(b.getBox('rbox')?.status).toBe('running');
      expect(Date.parse(b.getBox('rbox')!.lastActivityAt)).toBeGreaterThan(Date.now() - 60_000);

      // The run in flight holds the box against B's dispatcher…
      expect(await b.claimBox('rbox', 'dispatcher:task-b')).toBe(false);
      a.appendEvent('rbox', { type: 'devbox_end' });
      await settle();
      // …and once it ends, two racing claims land exactly one.
      const claims = await Promise.all([a.claimBox('rbox', 'dispatcher:task-a'), b.claimBox('rbox', 'dispatcher:task-b')]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    } finally {
      a._resetFleet();
      b._resetFleet();
      const redis = await openRedisStore(REDIS_URL!);
      try {
        const keys = await redis.command('KEYS', `${p2}*`);
        if (Array.isArray(keys) && keys.length) await redis.del(...(keys as string[]));
      } finally { await redis.quit(); }
    }
  });
});

redisSuite('leader-elected reaper over a real Redis lock', () => {
  it('two replicas tick at once; only the lock holder stops the box', async () => {
    type FleetMod = typeof import('../devbox-fleet.js');
    type ReaperMod = typeof import('../devbox-reaper.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createReplicaFleet } = require('../replica-fleet.js') as typeof import('../replica-fleet.js');
    const load = () => {
      let out!: { fleet: FleetMod; reaper: ReaperMod };
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        out = { fleet: require('../devbox-fleet.js') as FleetMod, reaper: require('../devbox-reaper.js') as ReaperMod };
      });
      return out;
    };
    const prefix = `test:devbox:${randomUUID()}`;
    const stale = { id: 'idle1', label: 'idle1', sessionId: 'i'.repeat(40), status: 'idle' as const,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(), lastActivityAt: new Date(Date.now() - 30 * 60_000).toISOString() };
    const ids = [`reaper-a-${randomUUID()}`, `reaper-b-${randomUUID()}`];
    const replicas = ids.map((id) => {
      const r = load();
      r.fleet.hydrateBoxes([stale]);
      r.fleet.attachSharedFleet(createRedisFleetBackend({ url: REDIS_URL!, prefix }), { replicaId: id, touchFlushMs: 0 });
      return { ...r, lock: createReplicaFleet({ redisUrl: REDIS_URL!, id }) };
    });
    const sends = replicas.map(() => jest.fn(async (_cmd: unknown) => { await settle(); return {}; }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await Promise.all(replicas.map((r) => r.lock.heartbeat()));
      const ticks = await Promise.all(replicas.map((r, i) => r.reaper.reaperTick(
        { client: () => ({ send: sends[i]! }) as never, runtimeArn: async () => 'arn:runtime', policies: async () => new Map() },
        r.lock,
      )));
      expect(ticks.map((t) => t.ran).sort()).toEqual(['locked-elsewhere', 'swept']);
      expect(sends.map((s) => s.mock.calls.length).sort()).toEqual([0, 1]);
    } finally {
      warn.mockRestore();
      for (const r of replicas) { await r.lock.leave(); r.lock.stop(); r.fleet._resetFleet(); }
      const redis = await openRedisStore(REDIS_URL!);
      try {
        const keys = await redis.command('KEYS', `${prefix}*`);
        if (Array.isArray(keys) && keys.length) await redis.del(...(keys as string[]));
        await redis.del('orgiq:lock:devbox-reaper', 'orgiq:lock:devbox-reaper:fence');
        for (const id of ids) await redis.command('ZREM', 'orgiq:replicas', id);
      } finally { await redis.quit(); }
    }
  });
});

describe('sharedFleetMode', () => {
  it('stays single-process without Redis, in dev:mock, and when switched off', () => {
    expect(sharedFleetMode({}, false).mode).toBe('off');
    expect(sharedFleetMode({ REDIS_URL: 'redis://127.0.0.1:6379' }, true).mode).toBe('off');
    expect(sharedFleetMode({ REDIS_URL: 'redis://x:6379', DEVBOX_SHARED_STATE: 'off' }, false).mode).toBe('off');
  });
  it('shares through Redis when there is one and Aurora is real, or when asked', () => {
    expect(sharedFleetMode({ REDIS_URL: 'redis://x:6379' }, false)).toMatchObject({ mode: 'redis', url: 'redis://x:6379' });
    expect(sharedFleetMode({ REDIS_URL: 'redis://x:6379', DEVBOX_SHARED_STATE: 'redis' }, true).mode).toBe('redis');
    expect(sharedFleetMode({ DEVBOX_SHARED_STATE: 'redis' }, false).mode).toBe('off');
  });
});
