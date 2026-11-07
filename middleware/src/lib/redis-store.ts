// Application store shapes over the library's bounded transport. Connections,
// TLS, deadlines, reconnects and pub/sub remain owned by realtime-modules.
import { createBoundedRedis, type BoundedRedis, type BoundedRedisOptions } from '@connorhoehn/realtime-modules/server';
import type { NotificationRedisClient } from '@connorhoehn/realtime-modules/notification';

type CommandRedis = Pick<BoundedRedis, 'command' | 'quit'>;
type RedisReply = Awaited<ReturnType<BoundedRedis['command']>>;
type RedisArg = Parameters<BoundedRedis['command']>[number];

/** Named explicitly so declaration emit never reaches into realtime-modules' own distributed-core copy. */
export interface GatewayRedisStore {
  command(...args: RedisArg[]): Promise<RedisReply>;
  quit(): Promise<void>;
  ping(): Promise<RedisReply>;
  get(key: string): Promise<RedisReply>;
  hset(key: string, field: string, value: string): Promise<RedisReply>;
  hsetnx(key: string, field: string, value: string): Promise<RedisReply>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<RedisReply>;
  sadd(key: string, ...members: string[]): Promise<RedisReply>;
  srem(key: string, ...members: string[]): Promise<RedisReply>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<RedisReply>;
  expire(key: string, seconds: number): Promise<RedisReply>;
  setNX(key: string, value: string): Promise<RedisReply>;
  zadd(key: string, score: number, member: string): Promise<RedisReply>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<RedisReply>;
}

function strings(reply: RedisReply): string[] {
  if (!Array.isArray(reply) || !reply.every((value): value is string => typeof value === 'string')) {
    throw new Error('Invalid Redis string-list reply');
  }
  return reply;
}

export function createRedisStore(redis: CommandRedis): GatewayRedisStore {
  const command: BoundedRedis['command'] = (...args) => redis.command(...args);
  return {
    command,
    quit: () => redis.quit(),
    ping: () => command('PING'),
    get: (key: string) => command('GET', key),
    hset: (key: string, field: string, value: string) => command('HSET', key, field, value),
    hsetnx: (key: string, field: string, value: string) => command('HSETNX', key, field, value),
    async hgetall(key: string): Promise<Record<string, string>> {
      const values = strings(await command('HGETALL', key));
      if (values.length % 2) throw new Error('Invalid Redis hash reply');
      const entries: [string, string][] = [];
      for (let i = 0; i < values.length; i += 2) entries.push([values[i]!, values[i + 1]!]);
      return Object.fromEntries(entries);
    },
    hdel: (key: string, ...fields: string[]) => command('HDEL', key, ...fields),
    sadd: (key: string, ...members: string[]) => command('SADD', key, ...members),
    srem: (key: string, ...members: string[]) => command('SREM', key, ...members),
    smembers: async (key: string) => strings(await command('SMEMBERS', key)),
    del: (...keys: string[]) => command('DEL', ...keys),
    expire: (key: string, seconds: number) => command('EXPIRE', key, Math.max(1, Math.floor(seconds))),
    setNX: (key: string, value: string) => command('SETNX', key, value),
    zadd: (key: string, score: number, member: string) => command('ZADD', key, score, member),
    zrange: async (key: string, start: number, stop: number) => strings(await command('ZRANGE', key, start, stop)),
    async zcard(key: string): Promise<number> {
      const value = await command('ZCARD', key);
      if (typeof value !== 'number') throw new Error('Invalid Redis cardinality reply');
      return value;
    },
    zremrangebyrank: (key: string, start: number, stop: number) => command('ZREMRANGEBYRANK', key, start, stop),
  };
}

export async function openRedisStore(url: string, options?: BoundedRedisOptions): Promise<GatewayRedisStore> {
  return createRedisStore(await createBoundedRedis(url, options));
}

/** The notification store's node-redis-shaped view over the shared store. */
export function notificationRedisClient(redis: Pick<GatewayRedisStore, 'zadd' | 'zrange' | 'zcard' | 'zremrangebyrank' | 'hset' | 'hgetall' | 'expire' | 'del'>): NotificationRedisClient {
  return {
    zAdd: (key: string, member: { score: number; value: string }) => redis.zadd(key, member.score, member.value),
    zRange: (key: string, start: number, stop: number) => redis.zrange(key, start, stop),
    zCard: (key: string) => redis.zcard(key),
    zRemRangeByRank: (key: string, start: number, stop: number) => redis.zremrangebyrank(key, start, stop),
    hSet: (key: string, field: string, value: string) => redis.hset(key, field, value),
    hGetAll: (key: string) => redis.hgetall(key),
    expire: (key: string, seconds: number) => redis.expire(key, seconds),
    del: (key: string) => redis.del(key),
  };
}

export type { NotificationRedisClient as NotificationRedisLike } from '@connorhoehn/realtime-modules/notification';
