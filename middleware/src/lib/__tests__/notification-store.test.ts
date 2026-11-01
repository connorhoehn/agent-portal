// lib/notification-store.ts — the in-memory stand-in for Redis under the
// library's own RedisNotificationStore, and the dev:mock seed:
//   - the memory client keeps Redis's sorted-set order and rank arithmetic,
//     so the library's trim-to-newest-N and read-state logic behave as on Redis;
//   - the seed writes the fixture's rows through the grant rule, the `empty`
//     scenario seeds nothing, and a rehydrate after reset drops live items.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));

import { RedisNotificationStore } from '@connorhoehn/realtime-modules/notification';
import {
  MemoryNotificationRedis, createGatewayNotificationStore, rehydrateMockNotifications,
  releaseGatewayNotificationStore, seedMockNotifications,
} from '../notification-store.js';
import { notificationsFixture } from '../../mock/notifications.js';
import { fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { identityClonesFixture, removeClone, liveClones } from '../../mock/identity-clones.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('MemoryNotificationRedis', () => {
  it('orders by score, supports negative ranks, and trims like ZREMRANGEBYRANK', async () => {
    const m = new MemoryNotificationRedis();
    for (const [score, value] of [[3, 'c'], [1, 'a'], [2, 'b'], [4, 'd']] as const) await m.zAdd('k', { score, value });
    expect(await m.zRange('k', 0, -1)).toEqual(['a', 'b', 'c', 'd']);
    expect(await m.zRange('k', -2, -1)).toEqual(['c', 'd']);
    expect(await m.zRange('k', 3, 1)).toEqual([]);
    expect(await m.zCard('k')).toBe(4);
    expect(await m.zRemRangeByRank('k', 0, -3)).toBe(2); // keep the newest two
    expect(await m.zRange('k', 0, -1)).toEqual(['c', 'd']);
    expect(await m.zAdd('k', { score: 9, value: 'c' })).toBe(0); // re-add moves, does not duplicate
    expect(await m.zRange('k', 0, -1)).toEqual(['d', 'c']);
  });

  it('backs the library store: newest-N cap, read state, unread replay', async () => {
    const store = new RedisNotificationStore({ redisClient: new MemoryNotificationRedis(), logger, maxPerUser: 2 });
    for (let i = 1; i <= 3; i += 1) {
      await store.append('u-jonas', { id: `n${i}`, type: 'reply', title: `t${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() });
    }
    expect((await store.list('u-jonas')).map((n) => n.id)).toEqual(['n2', 'n3']);
    await store.markRead('u-jonas', 'n3');
    expect((await store.listUnread('u-jonas')).map((n) => n.id)).toEqual(['n2']);
    expect(await store.list('u-farah')).toEqual([]);
  });
});

describe('the dev:mock seed', () => {
  afterEach(() => { fixtureRegistry.resetAll('default'); releaseGatewayNotificationStore(); });

  it('writes every fixture row whose recipient holds the tenant grant', async () => {
    const { store } = createGatewayNotificationStore(null);
    const rows = notificationsFixture.rows();
    expect(await seedMockNotifications()).toBe(rows.length);
    for (const row of rows) {
      const item = (await store.list(row.userId)).find((n) => n.id === row.id);
      expect(item).toMatchObject({ id: row.id, type: row.type, payload: { tenant: row.tenant }, action: { href: row.href } });
    }
  });

  it('seeds nothing in the empty world, and a rehydrate drops items delivered since', async () => {
    const { store } = createGatewayNotificationStore(null);
    await seedMockNotifications();
    await store.append('u-farah', { id: 'live-1', type: 'reply', title: 'live', timestamp: new Date().toISOString() });
    fixtureRegistry.resetAll('empty');
    rehydrateMockNotifications();
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.list('u-farah')).toEqual([]);
    fixtureRegistry.resetAll('default');
    rehydrateMockNotifications();
    await new Promise((r) => setTimeout(r, 20));
    const back = (await store.list('u-farah')).map((n) => n.id);
    expect(back).toContain('mock-notif-reply-farah');
    expect(back).not.toContain('live-1');
  });

  it('never seeds a Redis-backed inbox', async () => {
    releaseGatewayNotificationStore();
    expect(await seedMockNotifications()).toBe(0);
  });
});


describe('disposable clone inboxes', () => {
  afterEach(() => { identityClonesFixture.reset(); releaseGatewayNotificationStore(); unfreezeClock(); });
  it.each(['delete', 'expire'])('%s removes only that clone inbox and cannot be repopulated by a late write', async how => {
    freezeClock('2026-10-31T12:00:00.000Z');
    const clone = 'u-sana-clone-1234abcd';
    identityClonesFixture.rows().push({ id: clone, from: 'u-sana', label: 'test', displayName: 'Sana', email: null, personId: null,
      grants: { social: ['participant'] }, epoch: 0, createdAt: '2026-10-31T11:00:00Z', expiresAt: '2026-10-31T13:00:00Z' });
    const { store, memory } = createGatewayNotificationStore(null);
    const users = [clone, 'u-sana', 'u-lena', clone + '-other'];
    for (const user of users) {
      await store.append(user, { id: user, type: 'message', title: 'Keep', timestamp: '2026-10-31T12:00:00Z' });
      await store.markRead(user, user);
    }
    const original = await Promise.all(users.slice(1).map(user => store.list(user)));
    if (how === 'delete') expect(removeClone(clone)).toBe(true);
    else { freezeClock('2026-10-31T13:00:00.000Z'); expect(liveClones()).toEqual([]); }
    await store.append(clone, { id: 'late', type: 'message', title: 'Late', timestamp: '2026-10-31T13:00:00Z' });
    await store.markRead(clone, 'late');
    expect(await store.list(clone)).toEqual([]);
    expect(await memory!.hGetAll('notif:read:' + clone)).toEqual({});
    expect(await Promise.all(users.slice(1).map(user => store.list(user)))).toEqual(original);
  });
});
