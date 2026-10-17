// Host-owned Redis connections for peer routing and application state. The
// library owns routing/lease semantics; this adapter owns TLS, connection
// lifecycle and bounded commands. The subscriber never carries store traffic.
import { createClient } from 'redis';
import type { RealtimeClusterRedis } from '@connorhoehn/realtime-modules/server';
import type { GatewayRedisStore, RedisReply } from './redis-lite.js';

function connection(url: string, timeoutMs: number) {
  return createClient({ url, RESP: 2, disableOfflineQueue: true, commandsQueueMaxLength: 2048,
    commandOptions: { timeout: timeoutMs }, socket: { connectTimeout: timeoutMs,
      reconnectStrategy: retries => Math.min(1000, 100 * (retries + 1)) } });
}
function reply(value: unknown): RedisReply {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(reply);
  throw new Error('Unsupported Redis reply');
}
export class GatewayRedis implements GatewayRedisStore {
  private readonly client: ReturnType<typeof connection>;
  private readonly publisher: ReturnType<typeof connection>;
  private readonly subscriber: ReturnType<typeof connection>;
  private closing = false;
  private readonly unavailable = new Set<() => void>();
  constructor(url: string, private readonly timeoutMs = 2000) {
    if (!['redis:', 'rediss:'].includes(new URL(url).protocol)) throw new Error('Redis URL requires redis:// or rediss://');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error('Redis command deadline must be at least 100ms');
    this.client = connection(url, timeoutMs); this.publisher = connection(url, timeoutMs); this.subscriber = connection(url, timeoutMs);
    for (const client of [this.client, this.publisher, this.subscriber]) client.on('error', error => {
      if (!this.closing) console.warn('[realtime-cluster] Redis connection error', error.name);
    });
    for (const client of [this.client, this.publisher, this.subscriber]) {
      const lost = () => this.connectionUnavailable();
      client.on('reconnecting', lost); client.on('end', lost);
    }
  }
  private connectionUnavailable(): void {
    if (this.closing) return;
    for (const observer of this.unavailable) observer();
  }
  async open(): Promise<void> {
    try { await this.bounded(Promise.all([this.client.connect(), this.publisher.connect(), this.subscriber.connect()]), () => {
      for (const client of [this.client, this.publisher, this.subscriber]) if (client.isOpen) client.destroy();
    }); }
    catch (error) { await this.quit(); throw error; }
  }
  private async bounded<T>(operation: Promise<T>, destroy: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { destroy(); reject(new Error('Redis operation deadline exceeded')); }, this.timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  readonly cluster: RealtimeClusterRedis = {
    onUnavailable: observer => {
      this.unavailable.add(observer);
      if (![this.client, this.publisher, this.subscriber].every(client => client.isReady)) observer();
      return () => { this.unavailable.delete(observer); };
    },
    command: (...args) => this.command(...args),
    publish: async (topic, payload) => {
      try { return await this.bounded(this.publisher.publish(topic, payload), () => {
        if (this.publisher.isOpen) this.publisher.destroy();
      }); }
      catch (error) { this.connectionUnavailable(); throw error; }
    },
    subscribe: async (topic, receive) => {
      await this.bounded(this.subscriber.subscribe(topic, receive), () => { if (this.subscriber.isOpen) this.subscriber.destroy(); });
      return async () => {
        if (this.subscriber.isReady) await this.bounded(this.subscriber.unsubscribe(topic), () => { if (this.subscriber.isOpen) this.subscriber.destroy(); });
      };
    },
  };
  async command(...args: (string | number)[]): Promise<RedisReply> {
    // node-redis removes its command timeout after writing to the socket.
    // Bound the reply too, destroying the owned connection so a stalled
    // response cannot keep a lease renewal pending indefinitely.
    return reply(await this.bounded(this.client.sendCommand(args.map(String)), () => {
      if (this.client.isOpen) this.client.destroy();
    }));
  }
  async quit(): Promise<void> {
    this.closing = true;
    this.unavailable.clear();
    for (const client of [this.subscriber, this.publisher, this.client]) if (client.isOpen) client.destroy();
  }
  ping() { return this.command('PING'); }
  get(key: string) { return this.command('GET', key); }
  hset(key: string, field: string, value: string) { return this.command('HSET', key, field, value); }
  hsetnx(key: string, field: string, value: string) { return this.command('HSETNX', key, field, value); }
  async hgetall(key: string): Promise<Record<string, string>> {
    const values = await this.command('HGETALL', key);
    if (!Array.isArray(values) || values.length % 2) throw new Error('Invalid Redis hash reply');
    const result: Record<string, string> = {};
    for (let i = 0; i < values.length; i += 2) {
      if (typeof values[i] !== 'string' || typeof values[i + 1] !== 'string') throw new Error('Invalid Redis hash value');
      result[values[i] as string] = values[i + 1] as string;
    }
    return result;
  }
  hdel(key: string, ...fields: string[]) { return this.command('HDEL', key, ...fields); }
  sadd(key: string, ...members: string[]) { return this.command('SADD', key, ...members); }
  srem(key: string, ...members: string[]) { return this.command('SREM', key, ...members); }
  async smembers(key: string) { return (await this.command('SMEMBERS', key)) as string[]; }
  del(...keys: string[]) { return this.command('DEL', ...keys); }
  expire(key: string, seconds: number) { return this.command('EXPIRE', key, Math.max(1, Math.floor(seconds))); }
  setNX(key: string, value: string) { return this.command('SETNX', key, value); }
  zadd(key: string, score: number, member: string) { return this.command('ZADD', key, score, member); }
  async zrange(key: string, start: number, stop: number) { return (await this.command('ZRANGE', key, start, stop)) as string[]; }
  async zcard(key: string) { return Number(await this.command('ZCARD', key)); }
  zremrangebyrank(key: string, start: number, stop: number) { return this.command('ZREMRANGEBYRANK', key, start, stop); }
}
