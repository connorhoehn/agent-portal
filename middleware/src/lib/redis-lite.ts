// A minimal Redis (RESP2) client — just enough for realtime-modules'
// `RedisCallStateStore` and `RedisNotificationStore` (lib/realtime-gateway.ts).
//
// The original single-gateway state connection needs a dozen commands,
// which RESP makes small:
// requests are arrays of bulk strings, replies arrive in order, so a FIFO of
// pending promises is the whole protocol state. Swap this for a real client
// the next time the dependency tree is being moved anyway — the store takes
// any object with these method names. Cluster routing uses the bounded
// node-redis adapter in gateway-redis.ts, including TLS and pub/sub.
//
// Scope, deliberately: one connection, no pipelining API, no pub/sub, no
// cluster, no TLS (`rediss://` is refused rather than silently downgraded).
// A dropped connection rejects everything in flight and reconnects on the
// next command; so does a command that outlives its deadline
// (REDIS_COMMAND_TIMEOUT_MS, default 2 s).

import net from 'node:net';

export type RedisReply = string | number | null | RedisReply[];
type Reply = RedisReply;

class RespParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  /** The next complete reply, `undefined` if more bytes are needed. Errors
   * come back as an Error instance. */
  next(): Reply | Error | undefined {
    const r = this.parse(0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r.end);
    return r.value;
  }

  private line(at: number): { text: string; end: number } | null {
    const i = this.buf.indexOf('\r\n', at);
    return i < 0 ? null : { text: this.buf.toString('utf8', at + 1, i), end: i + 2 };
  }

  private parse(at: number): { value: Reply | Error; end: number } | null {
    if (at >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[at]!);
    const l = this.line(at);
    if (!l) return null;
    switch (type) {
      case '+': return { value: l.text, end: l.end };
      case '-': return { value: new Error(l.text), end: l.end };
      case ':': return { value: Number(l.text), end: l.end };
      case '$': {
        const len = Number(l.text);
        if (len < 0) return { value: null, end: l.end };
        if (this.buf.length < l.end + len + 2) return null;
        return { value: this.buf.toString('utf8', l.end, l.end + len), end: l.end + len + 2 };
      }
      case '*': {
        const n = Number(l.text);
        if (n < 0) return { value: null, end: l.end };
        const out: Reply[] = [];
        let end = l.end;
        for (let k = 0; k < n; k++) {
          const item = this.parse(end);
          if (!item) return null;
          if (item.value instanceof Error) return { value: item.value, end: item.end };
          out.push(item.value);
          end = item.end;
        }
        return { value: out, end };
      }
      default:
        return { value: new Error(`unexpected RESP type '${type}'`), end: l.end };
    }
  }
}

function encode(args: readonly (string | number)[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

/** Per-command and connect deadlines (`REDIS_COMMAND_TIMEOUT_MS`, default 2 s). */
export interface RedisLiteOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
}

function envMs(key: string, fallback: number): number {
  const n = Number((process.env[key] ?? '').trim());
  return (process.env[key] ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

type Pending = { resolve: (r: Reply) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class RedisLite {
  private socket: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private pending: Pending[] = [];
  private parser = new RespParser();
  /** Bumped whenever a connection is abandoned, so its late events are ignored. */
  private generation = 0;
  private readonly host: string;
  private readonly port: number;
  private readonly password: string | null;
  private readonly username: string | null;
  private readonly db: number;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(url: string, opts: RedisLiteOptions = {}) {
    const u = new URL(url);
    if (u.protocol !== 'redis:') throw new Error(`unsupported Redis URL scheme '${u.protocol}' (only redis:// — no TLS support)`);
    this.host = u.hostname || '127.0.0.1';
    this.port = Number(u.port || 6379);
    this.username = u.username ? decodeURIComponent(u.username) : null;
    this.password = u.password ? decodeURIComponent(u.password) : null;
    this.db = Number(u.pathname.replace(/^\//, '') || 0);
    // A Redis that accepts TCP and then stalls (a failover in progress, a
    // saturated node) used to hang every awaited command — every call frame
    // that touches call state — forever: there was no deadline anywhere.
    // Replies on one connection arrive in order, so one late reply cannot be
    // skipped; a timeout therefore ABANDONS the connection (rejecting all in
    // flight) and the next command reconnects. 0 disables either deadline.
    this.commandTimeoutMs = opts.commandTimeoutMs ?? envMs('REDIS_COMMAND_TIMEOUT_MS', 2_000);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? envMs('REDIS_CONNECT_TIMEOUT_MS', 5_000);
  }

  /** Drop the current connection and reject everything waiting on it. */
  private abandon(err: Error): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    const inflight = this.pending;
    this.pending = [];
    for (const p of inflight) { if (p.timer) clearTimeout(p.timer); p.reject(err); }
    socket?.destroy();
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const gen = ++this.generation;
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      this.parser = new RespParser();
      const deadline = this.connectTimeoutMs > 0
        ? setTimeout(() => socket.destroy(new Error(`redis connect timed out after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs)
        : undefined;
      deadline?.unref?.();
      const fail = (err: Error): void => {
        if (deadline) clearTimeout(deadline);
        reject(err);
        if (gen !== this.generation) return; // already abandoned; a newer connection owns the state
        this.abandon(err);
      };
      socket.once('connect', () => {
        if (deadline) clearTimeout(deadline);
        if (gen !== this.generation) { socket.destroy(); return; }
        this.socket = socket;
        resolve();
      });
      socket.on('data', (chunk: Buffer) => {
        if (gen !== this.generation) return;
        this.parser.push(chunk);
        for (let r = this.parser.next(); r !== undefined; r = this.parser.next()) {
          const p = this.pending.shift();
          if (!p) continue;
          if (p.timer) clearTimeout(p.timer);
          if (r instanceof Error) p.reject(r); else p.resolve(r);
        }
      });
      socket.on('error', (err) => fail(err));
      socket.on('close', () => fail(new Error('redis connection closed')));
    }).then(async () => {
      if (this.password) await this.raw(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password]);
      if (this.db) await this.raw(['SELECT', this.db]);
    }).catch((err: unknown) => {
      if (gen === this.generation) {
        this.socket?.destroy();
        this.socket = null;
        this.ready = null;
      }
      throw err;
    });
    return this.ready;
  }

  private raw(args: readonly (string | number)[]): Promise<Reply> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('redis not connected'));
    return new Promise<Reply>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (this.commandTimeoutMs > 0) {
        entry.timer = setTimeout(
          () => this.abandon(new Error(`redis ${String(args[0])} timed out after ${this.commandTimeoutMs}ms`)),
          this.commandTimeoutMs,
        );
        entry.timer.unref?.();
      }
      this.pending.push(entry);
      socket.write(encode(args));
    });
  }

  async command(...args: (string | number)[]): Promise<Reply> {
    await this.connect();
    return this.raw(args);
  }

  async quit(): Promise<void> {
    if (!this.socket) return;
    try { await this.raw(['QUIT']); } catch { /* closing anyway */ }
    this.generation += 1;
    this.socket?.destroy();
    this.socket = null;
    this.ready = null;
  }

  // ── The CallStateRedis surface (snake_case, ioredis-shaped) ──────────────
  ping(): Promise<Reply> { return this.command('PING'); }
  get(key: string): Promise<Reply> { return this.command('GET', key); }
  hset(key: string, field: string, value: string): Promise<Reply> { return this.command('HSET', key, field, value); }
  hsetnx(key: string, field: string, value: string): Promise<Reply> { return this.command('HSETNX', key, field, value); }
  async hgetall(key: string): Promise<Record<string, string>> {
    const flat = (await this.command('HGETALL', key)) as string[] | null;
    const out: Record<string, string> = {};
    for (let i = 0; flat && i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
    return out;
  }
  hdel(key: string, ...fields: string[]): Promise<Reply> { return this.command('HDEL', key, ...fields); }
  sadd(key: string, ...members: string[]): Promise<Reply> { return this.command('SADD', key, ...members); }
  srem(key: string, ...members: string[]): Promise<Reply> { return this.command('SREM', key, ...members); }
  async smembers(key: string): Promise<string[]> { return ((await this.command('SMEMBERS', key)) as string[] | null) ?? []; }
  del(...keys: string[]): Promise<Reply> { return this.command('DEL', ...keys); }
  expire(key: string, seconds: number): Promise<Reply> { return this.command('EXPIRE', key, Math.max(1, Math.floor(seconds))); }
  /** 1 when the key was created, 0 when it already existed. */
  setNX(key: string, value: string): Promise<Reply> { return this.command('SETNX', key, value); }

  // ── Sorted sets, for the notification inbox (notif:list:<userId>) ─────────
  zadd(key: string, score: number, member: string): Promise<Reply> { return this.command('ZADD', key, score, member); }
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await this.command('ZRANGE', key, start, stop)) as string[] | null) ?? [];
  }
  async zcard(key: string): Promise<number> { return Number(await this.command('ZCARD', key)) || 0; }
  zremrangebyrank(key: string, start: number, stop: number): Promise<Reply> { return this.command('ZREMRANGEBYRANK', key, start, stop); }
}

/**
 * realtime-modules' `NotificationRedisClient` is node-redis v4-shaped
 * (camelCase, `zAdd(key, { score, value })`); RedisLite is ioredis-shaped.
 * This adapter maps the casing so one REDIS_URL connection backs call state
 * and the notification inbox alike.
 */
export interface NotificationRedisLike {
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRange(key: string, start: number, stop: number): Promise<string[]>;
  zCard(key: string): Promise<number>;
  zRemRangeByRank(key: string, start: number, stop: number): Promise<unknown>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export type GatewayRedisStore = Pick<RedisLite, 'command' | 'quit' | 'ping' | 'get' | 'hset' | 'hsetnx' | 'hgetall'
  | 'hdel' | 'sadd' | 'srem' | 'smembers' | 'del' | 'expire' | 'setNX' | 'zadd' | 'zrange' | 'zcard' | 'zremrangebyrank'>;

export function notificationRedisClient(r: Pick<GatewayRedisStore, 'zadd' | 'zrange' | 'zcard' | 'zremrangebyrank' | 'hset' | 'hgetall' | 'expire' | 'del'>): NotificationRedisLike {
  return {
    zAdd: (key, m) => r.zadd(key, m.score, m.value),
    zRange: (key, start, stop) => r.zrange(key, start, stop),
    zCard: (key) => r.zcard(key),
    zRemRangeByRank: (key, start, stop) => r.zremrangebyrank(key, start, stop),
    hSet: (key, field, value) => r.hset(key, field, value),
    hGetAll: (key) => r.hgetall(key),
    expire: (key, seconds) => r.expire(key, seconds),
    del: (key) => r.del(key),
  };
}
