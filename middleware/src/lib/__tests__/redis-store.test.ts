import { randomUUID } from 'node:crypto';
import { createBoundedRedis, type BoundedRedis } from '@connorhoehn/realtime-modules/server';
import { RedisNotificationStore } from '@connorhoehn/realtime-modules/notification';
import { createRedisStore, openRedisStore, notificationRedisClient } from '../redis-store.js';

const url = process.env['REDIS_STORE_TEST_URL'];
const testRedis = url ? it : it.skip;

it('rejects malformed hash replies and preserves literal prototype-named fields', async () => {
  const command = jest.fn<ReturnType<BoundedRedis['command']>, Parameters<BoundedRedis['command']>>();
  const store = createRedisStore({ command, quit: async () => undefined });
  command.mockResolvedValue(['odd']);
  await expect(store.hgetall('hash')).rejects.toThrow('Invalid Redis hash');
  command.mockResolvedValue(['key', 1]);
  await expect(store.hgetall('hash')).rejects.toThrow('Invalid Redis string-list');
  command.mockResolvedValue(['__proto__', 'literal', 'name', 'Alice']);
  expect(await store.hgetall('hash')).toEqual(JSON.parse('{"__proto__":"literal","name":"Alice"}'));
});

testRedis('the library notification store persists, trims, and reconciles reads through two bounded clients', async () => {
  const one = await openRedisStore(url!);
  const two = await openRedisStore(url!);
  const prefix = `notification-adapter:${randomUUID()}:`;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const opts = { logger, maxPerUser: 2, ttlSec: 60, listKeyPrefix: `${prefix}list:`, readKeyPrefix: `${prefix}read:` };
  const first = new RedisNotificationStore({ ...opts, redisClient: notificationRedisClient(one) });
  const second = new RedisNotificationStore({ ...opts, redisClient: notificationRedisClient(two) });
  try {
    for (let i = 1; i <= 3; i++) await first.append('alice', {
      id: `n${i}`, type: 'message', title: `Notice ${i}`, timestamp: new Date(2026, 9, 18, 10, 0, i).toISOString(), read: false,
    });
    expect((await second.list('alice')).map(n => n.id)).toEqual(['n2', 'n3']);
    await second.markRead('alice', 'n2');
    expect((await first.listUnread('alice')).map(n => n.id)).toEqual(['n3']);
    expect(Number(await one.command('TTL', `${prefix}list:alice`))).toBeGreaterThan(0);
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    await one.del(`${prefix}list:alice`, `${prefix}read:alice`);
    await Promise.all([one.quit(), two.quit()]);
  }
});

testRedis('a stalled reply is bounded after the socket write and reports lost ownership', async () => {
  const redis = await createBoundedRedis(url!, { timeoutMs: 150 });
  const lost = jest.fn();
  redis.onUnavailable(lost);
  const start = performance.now();
  try {
    // Destroying node-redis may reject its pending command before the
    // deadline error wins the race. Both paths must fence within the bound.
    await expect(redis.command('BLPOP', `deadline:${randomUUID()}`, 0)).rejects.toThrow();
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(lost).toHaveBeenCalled();
    expect(redis.isReady).toBe(false);
  } finally { await redis.quit(); }
});
