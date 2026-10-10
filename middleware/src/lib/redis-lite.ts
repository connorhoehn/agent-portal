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

interface RedisEndpoint {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  db: number;
}

/** Shared by both connection classes so they cannot disagree about a URL. */
function parseRedisUrl(url: string): RedisEndpoint {
  const u = new URL(url);
  if (u.protocol !== 'redis:') throw new Error(`unsupported Redis URL scheme '${u.protocol}' (only redis:// — no TLS support)`);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    db: Number(u.pathname.replace(/^\//, '') || 0),
  };
}

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

/** A `message` frame's payload and the channel it arrived on. */
export type SubscriberListener = (message: string, channel: string) => void;

/**
 * A connection held in Redis subscriber mode. Separate from `RedisLite` for the
 * protocol reasons in the header comment: this socket receives server PUSHES
 * that pair with no request, and may not issue ordinary commands.
 *
 * Reconnects are the point of this class, not an extra. A replica that loses
 * its subscriber connection stops receiving every other replica's frames while
 * still serving traffic and still looking healthy — a silent split where each
 * node believes it is the whole cluster. So a drop re-dials with backoff and
 * re-issues SUBSCRIBE for every channel a listener is still registered for,
 * and `onStateChange` reports it so the caller can surface the gap.
 */
export class RedisSubscriber {
  private socket: net.Socket | null = null;
  private parser = new RespParser();
  private readonly endpoint: RedisEndpoint;
  private readonly listeners = new Map<string, Set<SubscriberListener>>();
  /** Resolvers for in-flight (P)SUBSCRIBE/UNSUBSCRIBE confirmations. */
  private confirms = new Map<string, Array<() => void>>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private retry = 0;
  private errorHandlers = new Set<(err: Error) => void>();
  private stateHandlers = new Set<(state: 'ready' | 'disconnected') => void>();

  constructor(url: string, private readonly reconnectBaseMs = 50) {
    this.endpoint = parseRedisUrl(url);
  }

  onError(handler: (err: Error) => void): void { this.errorHandlers.add(handler); }
  onStateChange(handler: (state: 'ready' | 'disconnected') => void): void { this.stateHandlers.add(handler); }

  private emitError(err: Error): void {
    // A subscriber with no error handler must not take the process down with an
    // unhandled 'error' event, which is how a Redis blip became a crash loop.
    for (const h of this.errorHandlers) { try { h(err); } catch { /* ignore */ } }
  }

  private emitState(state: 'ready' | 'disconnected'): void {
    for (const h of this.stateHandlers) { try { h(state); } catch { /* ignore */ } }
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('subscriber closed');
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      socket.setNoDelay(true);
      this.parser = new RespParser();
      let settled = false;
      socket.once('connect', () => { this.socket = socket; settled = true; resolve(); });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      const drop = (err: Error): void => {
        this.socket = null;
        this.connecting = null;
        // Confirmations will never arrive on a dead socket; fail them so a
        // caller awaiting subscribe() does not hang forever.
        const waiting = [...this.confirms.values()].flat();
        this.confirms = new Map();
        for (const w of waiting) w();
        if (!settled) { settled = true; reject(err); } else this.emitError(err);
        this.emitState('disconnected');
        this.scheduleReconnect();
      };
      socket.on('error', drop);
      socket.on('close', () => drop(new Error('redis subscriber connection closed')));
    }).then(async () => {
      if (this.endpoint.password) {
        await this.send(this.endpoint.username
          ? ['AUTH', this.endpoint.username, this.endpoint.password]
          : ['AUTH', this.endpoint.password]);
      }
      // No SELECT: pub/sub is not namespaced by db, so issuing it would imply
      // an isolation this transport does not provide.
      this.connecting = null;
      this.retry = 0;
      this.emitState('ready');
    }).catch((err: unknown) => {
      this.socket?.destroy();
      this.socket = null;
      this.connecting = null;
      throw err;
    });
    return this.connecting;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.listeners.size === 0) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.retry++, 5_000);
    const timer = setTimeout(() => {
      if (this.closed) return;
      void this.connect()
        .then(() => this.resubscribeAll())
        .catch((err: unknown) => this.emitError(err instanceof Error ? err : new Error(String(err))));
    }, delay);
    // Never hold the event loop open for a reconnect nobody is waiting on.
    timer.unref?.();
  }

  private async resubscribeAll(): Promise<void> {
    const channels = [...this.listeners.keys()];
    if (channels.length > 0) await this.send(['SUBSCRIBE', ...channels]);
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    for (let r = this.parser.next(); r !== undefined; r = this.parser.next()) {
      if (r instanceof Error) { this.emitError(r); continue; }
      if (!Array.isArray(r)) continue; // +OK from AUTH, or a PONG
      const kind = typeof r[0] === 'string' ? r[0] : '';
      if (kind === 'message' && typeof r[1] === 'string' && typeof r[2] === 'string') {
        const [, channel, payload] = r as [string, string, string];
        for (const l of this.listeners.get(channel) ?? []) {
          // One listener must not be able to stop the others, or a single
          // throwing consumer silently halves the fan-out.
          try { l(payload, channel); } catch { /* ignore */ }
        }
        continue;
      }
      if ((kind === 'subscribe' || kind === 'unsubscribe') && typeof r[1] === 'string') {
        const waiting = this.confirms.get(r[1]);
        if (waiting && waiting.length > 0) waiting.shift()!();
      }
    }
  }

  private send(args: readonly (string | number)[]): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('redis subscriber not connected'));
    socket.write(encode(args));
    return Promise.resolve();
  }

  /** Resolves once the server confirms, so a caller can publish and expect delivery. */
  async subscribe(channel: string, listener: SubscriberListener): Promise<void> {
    const existing = this.listeners.get(channel);
    if (existing) { existing.add(listener); return; }
    this.listeners.set(channel, new Set([listener]));
    await this.connect();
    const confirmed = new Promise<void>((resolve) => {
      const list = this.confirms.get(channel) ?? [];
      list.push(resolve);
      this.confirms.set(channel, list);
    });
    await this.send(['SUBSCRIBE', channel]);
    await confirmed;
  }

  async unsubscribe(channel?: string): Promise<void> {
    const channels = channel ? [channel] : [...this.listeners.keys()];
    for (const c of channels) this.listeners.delete(c);
    if (!this.socket || channels.length === 0) return;
    await this.send(['UNSUBSCRIBE', ...channels]);
  }

  async quit(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (!this.socket) return;
    try { await this.send(['QUIT']); } catch { /* closing anyway */ }
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * distributed-core's `cluster/locks` RedisClient, over one RedisLite. Its
 * `set(key, value, 'NX', 'PX', ttl)` shape is ioredis's positional form; EVAL
 * and INCR are what the provider's fencing-token and release scripts need.
 */
export interface LockRedisLike {
  set(key: string, value: string, nx: 'NX' | 'XX', px: 'PX', ttlMs: number): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  quit(): Promise<void>;
}

export function lockRedisClient(r: RedisLite): LockRedisLike {
  return {
    async set(key, value, nx, px, ttlMs) {
      return (await r.command('SET', key, value, nx, px, Math.max(1, Math.floor(ttlMs)))) as 'OK' | null;
    },
    async get(key) { return (await r.command('GET', key)) as string | null; },
    eval(script, numkeys, ...args) { return r.command('EVAL', script, numkeys, ...args); },
    async incr(key) { return Number(await r.command('INCR', key)) || 0; },
    async quit() { await r.quit(); },
  };
}

/**
 * distributed-core's `gateway/pubsub` RedisLikeClient. Two sockets on purpose:
 * `publish` needs an ordinary connection and `subscribe` a subscriber-mode one
 * (header comment). `duplicate()` is what RedisPubSubManager calls when it
 * wants its own subscriber, and it must hand back an independent connection —
 * returning `this` would put the publishing socket into subscriber mode and
 * break every later publish.
 */
export interface PubSubRedisLike {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: SubscriberListener): Promise<void>;
  unsubscribe(channel?: string): Promise<void>;
  duplicate(): PubSubRedisLike;
  quit(): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

export function pubSubRedisClient(url: string): PubSubRedisLike {
  const publisher = new RedisLite(url);
  const subscriber = new RedisSubscriber(url);
  return {
    // Both sockets are LAZY: RedisPubSubManager calls createClient() twice and
    // uses one object purely as publisher and the other purely as subscriber,
    // so eagerly dialling both here would open four connections to do the work
    // of two. PING validates the URL and credentials up front — a wrong
    // REDIS_URL should fail here, not silently at the first fan-out.
    async connect() { await publisher.ping(); },
    async publish(channel, message) { return Number(await publisher.command('PUBLISH', channel, message)) || 0; },
    subscribe: (channel, listener) => subscriber.subscribe(channel, listener),
    unsubscribe: (channel) => subscriber.unsubscribe(channel),
    duplicate: () => pubSubRedisClient(url),
    async quit() { await Promise.allSettled([publisher.quit(), subscriber.quit()]); },
    on(event, handler) {
      if (event === 'error') subscriber.onError((err) => handler(err));
      if (event === 'ready') subscriber.onStateChange((s) => { if (s === 'ready') handler(); });
      if (event === 'end' || event === 'disconnect') subscriber.onStateChange((s) => { if (s === 'disconnected') handler(); });
      return undefined;
    },
  };
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
