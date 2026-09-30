// A RealtimeRouter that spans replicas, so the gateway can run more than one
// ECS task.
//
// WHY THIS EXISTS. `attachRealtime`'s default `LocalRealtimeRouter` keeps
// channel membership and client identity in process memory. That is correct and
// fast for one task and silently wrong for two: a message published on replica
// A reaches only the sockets held by A, so two people in the same channel see
// different conversations depending on which task their websocket landed on.
// Nothing errors. The middleware's own autoscaler is configured 1→4 tasks
// (infra/lib/middleware-service-stack.ts), so "it works in the lab" was a
// function of never having scaled out.
//
// WHAT IT IS. A thin decorator over a real `LocalRealtimeRouter`, not a
// reimplementation of one. Everything the library already does correctly —
// channel authz, the `AUTHZ_CHANNEL_DENIED` refusal, plugin lifecycle, local
// membership, identity from the WS auth context — stays in the library
// instance. This class adds exactly two things:
//
//   1. fan-out: after a local publish, the frame goes onto a bus so every other
//      replica delivers it to ITS local subscribers;
//   2. a registry of the clients other replicas hold, so the synchronous
//      answers services rely on (`getClientsByUserId`, `isClientLive`,
//      `channelMembers`) describe the whole fleet instead of one task.
//
// `attachRealtime({ router })` is a supported seam, not a workaround — the
// library's own comment says the transport is swappable and that a
// Redis/multi-node router "drops in via `opts.router` without touching any
// feature". It also documents the consequence this file must honour: with a
// custom router, `authorize` and `plugins` are the router's responsibility and
// are ignored by attach. Both are therefore handed to the inner local router.
//
// THE ONE RULE THAT MATTERS: plugins fire on the ORIGIN replica only.
// `plugin.onMessage` is how the activity bell's notification producers observe
// chat traffic (lib/social-notify.ts). The inner router fires it from
// `sendToChannel`, so a frame arriving from the bus must NOT go back through
// `sendToChannel` — it is delivered straight to local sockets. Routing a remote
// frame through the normal path would fire the producers once per replica and
// notify every user N times, which is the kind of bug that only appears in
// production and reads as "the bell is broken" rather than "the router is".
//
// Not solved here, deliberately: this is fan-out over a bus, not consensus.
// Ordering is per-publisher, there is no replay for a replica that was
// disconnected during a publish, and a client's socket still lives on exactly
// one task. Those are the properties a chat/presence fleet needs; a workload
// that needs total order wants distributed-core's cluster primitives instead.

import type {
  ChannelAuthorize,
  RealtimeRouter,
  RouterLogger,
  // The /server barrel exports TWO `FeaturePlugin`s: the factory's (`name?`)
  // under the plain name, and the router's (`name` required) aliased. Only the
  // latter satisfies LocalRealtimeRouter's constructor, and picking the wrong
  // one is a type error rather than a silent mismatch — which is the good case.
  RealtimeFeaturePlugin,
} from '@connorhoehnslalom/realtime-modules/server';
import { LocalRealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';

/** 'subscribe' | 'publish' — the library's ChannelAccessKind, restated
 *  structurally because it is not exported from the /server subpath. */
type AccessKind = 'subscribe' | 'publish';

/**
 * The transport this router fans out over. Deliberately two methods: it is
 * satisfied by distributed-core's RedisPubSubManager in production and by a
 * synchronous in-memory bus in tests, so multi-replica behaviour is testable
 * without a Redis and the same code path is exercised either way.
 */
export interface RouterBus {
  publish(topic: string, payload: unknown): Promise<void> | void;
  subscribe(topic: string, handler: (payload: unknown) => void): void;
}

/** Frames on the bus. `n` is the origin node; a replica ignores its own. */
type Frame =
  | { t: 'chan'; n: string; channel: string; message: unknown; exclude?: string | null }
  | { t: 'client'; n: string; to: string; message: unknown }
  | { t: 'all'; n: string; message: unknown; exclude?: string | null }
  | { t: 'sub'; n: string; clientId: string; userId?: string; channel: string }
  | { t: 'unsub'; n: string; clientId: string; channel: string }
  | { t: 'gone'; n: string; clientId: string }
  | { t: 'hello'; n: string }
  | { t: 'state'; n: string; clients: Array<{ clientId: string; userId?: string; channels: string[] }> };

interface RemoteClient {
  userId?: string;
  channels: Set<string>;
}

/** What a remote replica told us it holds, and when we last heard from it. */
interface RemoteNode {
  clients: Map<string, RemoteClient>;
  seen: number;
}

export interface DistributedRouterOptions {
  bus: RouterBus;
  /** Stable per-replica id. Defaults to a random one; ECS task ids work well. */
  nodeId?: string;
  authorize?: ChannelAuthorize;
  plugins?: RealtimeFeaturePlugin[];
  logger?: RouterLogger;
  /** Bus topic. All replicas of one deployment must agree on it. */
  topic?: string;
  /**
   * A node silent for longer than this is treated as gone and its clients
   * dropped. Must exceed `announceIntervalMs` by a comfortable margin, or a
   * healthy-but-quiet replica gets evicted and its users look offline.
   */
  nodeTtlMs?: number;
  /** Full-state re-announce cadence. Heals any missed incremental frame. */
  announceIntervalMs?: number;
}

const DEFAULT_TOPIC = 'orgiq:realtime:fanout';

/** Backoff between cold-start `hello` attempts; ~3.6s total, then it gives up. */
const DISCOVERY_DELAYS_MS = [150, 350, 1_000, 2_000] as const;

export class DistributedRealtimeRouter implements RealtimeRouter {
  readonly redisAvailable = true;
  readonly nodeId: string;
  /** The library instance that owns authz, plugins, identity and local state. */
  readonly local: LocalRealtimeRouter;

  private readonly bus: RouterBus;
  private readonly topic: string;
  private readonly logger: RouterLogger;
  private readonly nodeTtlMs: number;
  private readonly remotes = new Map<string, RemoteNode>();
  /** Fleet-wide channel → clientIds, kept incrementally. See `channelMembers`. */
  private readonly members = new Map<string, Set<string>>();
  /** This replica's own clients, so a full-state announce is cheap. */
  private readonly mine = new Map<string, RemoteClient>();
  private announceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: DistributedRouterOptions) {
    this.bus = opts.bus;
    this.nodeId = opts.nodeId ?? `node-${Math.random().toString(36).slice(2, 10)}`;
    this.topic = opts.topic ?? DEFAULT_TOPIC;
    this.logger = opts.logger ?? { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    this.nodeTtlMs = opts.nodeTtlMs ?? 30_000;
    // authorize and plugins belong to the inner router: attach ignores them
    // when a custom router is supplied, and the inner instance is the thing
    // that enforces refusals and fires lifecycle hooks.
    this.local = new LocalRealtimeRouter({ authorize: opts.authorize, plugins: opts.plugins, logger: this.logger });

    this.bus.subscribe(this.topic, (payload) => this.onFrame(payload));
    // Ask the fleet who they hold. A replica that starts during a conversation
    // would otherwise believe every other participant is offline until the
    // first re-announce, which is long enough to misroute a call invite.
    //
    // RETRIED, because a single hello loses a race that cost a live debugging
    // round: distributed-core's RedisPubSubManager.subscribe() is synchronous
    // and issues the actual Redis SUBSCRIBE fire-and-forget, so the first hello
    // can leave before this replica is listening — the peers' `state` replies
    // then arrive at nobody and the new task believes it is alone in the fleet
    // (verified: two processes, `peers: []` while fan-out worked in one
    // direction). Retrying until a peer answers makes cold start independent of
    // when the subscription actually lands.
    this.discover(0);

    const interval = opts.announceIntervalMs ?? 10_000;
    this.announceTimer = setInterval(() => {
      this.expireStaleNodes();
      void this.send(this.stateFrame());
    }, interval);
    // Never keep the process alive for a heartbeat.
    this.announceTimer.unref?.();
  }

  // ---- bus ---------------------------------------------------------------

  /**
   * Bounded cold-start discovery: re-ask until some replica answers. Stops at
   * the first sign of a peer, so a genuinely single-task deployment sends a
   * handful of cheap frames and then goes quiet rather than polling forever.
   */
  private discover(attempt: number): void {
    if (this.stopped || this.remotes.size > 0 || attempt >= DISCOVERY_DELAYS_MS.length) return;
    void this.send({ t: 'hello', n: this.nodeId });
    const timer = setTimeout(() => this.discover(attempt + 1), DISCOVERY_DELAYS_MS[attempt]!);
    timer.unref?.();
  }

  private async send(frame: Frame): Promise<void> {
    if (this.stopped) return;
    try {
      await this.bus.publish(this.topic, frame);
    } catch (err) {
      // A failed fan-out must not fail the local send that triggered it: the
      // local half already happened and throwing here would surface a Redis
      // blip as a user-visible send error. It is logged and dropped, which is
      // honest about this being at-most-once across replicas.
      this.logger.warn?.(`[realtime] fan-out ${frame.t} failed: ${String(err)}`);
    }
  }

  private stateFrame(): Frame {
    return {
      t: 'state',
      n: this.nodeId,
      clients: [...this.mine.entries()].map(([clientId, c]) => ({
        clientId, ...(c.userId ? { userId: c.userId } : {}), channels: [...c.channels],
      })),
    };
  }

  private onFrame(payload: unknown): void {
    const frame = payload as Frame | null;
    if (!frame || typeof frame !== 'object' || typeof (frame as Frame).n !== 'string') return;
    if (frame.n === this.nodeId) return; // our own echo
    this.touch(frame.n);
    switch (frame.t) {
      case 'chan':
        this.deliverLocally(frame.channel, frame.message, frame.exclude ?? null);
        return;
      case 'client':
        // Only the replica holding the socket delivers; everyone else ignores.
        if (this.local.isClientLive(frame.to)) this.local.sendToLocalClient(frame.to, frame.message);
        return;
      case 'all':
        void this.local.broadcastToAll(frame.message, frame.exclude ?? undefined);
        return;
      case 'sub': {
        const node = this.nodeOf(frame.n);
        const entry = node.clients.get(frame.clientId) ?? { channels: new Set<string>() };
        if (frame.userId) entry.userId = frame.userId;
        entry.channels.add(frame.channel);
        node.clients.set(frame.clientId, entry);
        this.addMember(frame.channel, frame.clientId);
        return;
      }
      case 'unsub': {
        const entry = this.remotes.get(frame.n)?.clients.get(frame.clientId);
        entry?.channels.delete(frame.channel);
        this.removeMember(frame.channel, frame.clientId);
        return;
      }
      case 'gone':
        this.forgetRemoteClient(frame.n, frame.clientId);
        return;
      case 'hello':
        // A new replica announced itself: tell it what we hold. Reciprocal, so
        // the fleet converges without a coordinator.
        void this.send(this.stateFrame());
        return;
      case 'state': {
        // Authoritative replacement for that node, so a membership frame we
        // missed cannot leave a phantom subscriber behind forever.
        const previous = this.remotes.get(frame.n);
        if (previous) for (const [clientId, c] of previous.clients) {
          for (const ch of c.channels) this.removeMember(ch, clientId);
        }
        const clients = new Map<string, RemoteClient>();
        for (const c of frame.clients) {
          clients.set(c.clientId, { ...(c.userId ? { userId: c.userId } : {}), channels: new Set(c.channels) });
          for (const ch of c.channels) this.addMember(ch, c.clientId);
        }
        this.remotes.set(frame.n, { clients, seen: Date.now() });
        return;
      }
    }
  }

  private touch(nodeId: string): void { this.nodeOf(nodeId).seen = Date.now(); }

  private nodeOf(nodeId: string): RemoteNode {
    let node = this.remotes.get(nodeId);
    if (!node) { node = { clients: new Map(), seen: Date.now() }; this.remotes.set(nodeId, node); }
    return node;
  }

  private expireStaleNodes(): void {
    const cutoff = Date.now() - this.nodeTtlMs;
    for (const [nodeId, node] of this.remotes) {
      if (node.seen >= cutoff) continue;
      for (const [clientId, c] of node.clients) {
        for (const ch of c.channels) this.removeMember(ch, clientId);
      }
      this.remotes.delete(nodeId);
      this.logger.info?.(`[realtime] replica ${nodeId} timed out; dropped ${node.clients.size} client(s)`);
    }
  }

  private forgetRemoteClient(nodeId: string, clientId: string): void {
    const entry = this.remotes.get(nodeId)?.clients.get(clientId);
    if (!entry) return;
    for (const ch of entry.channels) this.removeMember(ch, clientId);
    this.remotes.get(nodeId)!.clients.delete(clientId);
  }

  // ---- fleet-wide membership --------------------------------------------

  private addMember(channel: string, clientId: string): void {
    const set = this.members.get(channel) ?? new Set<string>();
    set.add(clientId);
    this.members.set(channel, set);
  }

  private removeMember(channel: string, clientId: string): void {
    const set = this.members.get(channel);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.members.delete(channel);
  }

  /**
   * Fleet-wide channel → clientIds. `liveSubscribers` in lib/realtime-gateway.ts
   * reads this duck-typed to decide who is ALREADY watching a channel and so
   * needs no notification. On one task the local map answered that; across
   * replicas a local-only answer would notify someone who is reading the
   * message as it arrives. Includes this replica's clients and every remote
   * one, which is what makes the bell correct at >1 task.
   */
  get channelMembers(): Map<string, Set<string>> { return this.members; }

  // ---- identity ---------------------------------------------------------

  getClientData(clientId: string): ReturnType<LocalRealtimeRouter['getClientData']> {
    return this.local.getClientData(clientId);
  }

  /** Local first, then the registry — a remote client still has an identity. */
  getUserIdForClient(clientId: string): string | undefined {
    const local = this.local.getUserIdForClient(clientId);
    if (local) return local;
    for (const node of this.remotes.values()) {
      const userId = node.clients.get(clientId)?.userId;
      if (userId) return userId;
    }
    return undefined;
  }

  /**
   * Every socket in the fleet for these users. This is what a call invite rings
   * (`calls`), so a local-only answer meant a callee connected to another task
   * never heard the phone.
   */
  getClientsByUserId(userIds: string[], excludeClientId?: string): { clientId: string; userId: string }[] {
    const wanted = new Set(userIds);
    const out = this.local.getClientsByUserId(userIds, excludeClientId);
    const seen = new Set(out.map((c) => c.clientId));
    for (const node of this.remotes.values()) {
      for (const [clientId, c] of node.clients) {
        if (clientId === excludeClientId || seen.has(clientId)) continue;
        if (c.userId && wanted.has(c.userId)) { out.push({ clientId, userId: c.userId }); seen.add(clientId); }
      }
    }
    return out;
  }

  /**
   * true here, true elsewhere, else null. `null` is the contract's "unknown —
   * another replica may hold it", and returning it rather than `false` matters:
   * services use false to conclude a participant's socket is gone and tear down
   * their side of a call.
   */
  isClientLive(clientId: string): boolean | null {
    if (this.local.isClientLive(clientId)) return true;
    for (const node of this.remotes.values()) if (node.clients.has(clientId)) return true;
    return null;
  }

  hasChannelAuthorize(): boolean { return this.local.hasChannelAuthorize(); }

  checkChannel(kind: AccessKind, clientId: string, channel: string, opts?: unknown): boolean {
    return (this.local as unknown as {
      checkChannel(k: AccessKind, c: string, ch: string, o?: unknown): boolean;
    }).checkChannel(kind, clientId, channel, opts);
  }

  // ---- sends -----------------------------------------------------------

  /** Deliver to this replica's subscribers only, with NO plugin dispatch. */
  private deliverLocally(channel: string, message: unknown, exclude: string | null): void {
    // The inner router's own membership, not the merged fleet view: a remote
    // clientId is not connected here and sending to it is a no-op at best.
    const localMembers = (this.local as unknown as { channelMembers?: Map<string, Set<string>> }).channelMembers;
    for (const clientId of localMembers?.get(channel) ?? []) {
      if (clientId !== exclude) this.local.sendToLocalClient(clientId, message);
    }
  }

  sendToClient(clientId: string, message: unknown): void {
    if (this.local.isClientLive(clientId)) { this.local.sendToClient(clientId, message); return; }
    // Not ours. Publish rather than drop: the owning replica delivers, and if
    // nobody owns it the frame is simply unclaimed.
    void this.send({ t: 'client', n: this.nodeId, to: clientId, message });
  }

  sendToLocalClient(clientId: string, message: unknown): void {
    this.local.sendToLocalClient(clientId, message);
  }

  async broadcastToAll(message: unknown, excludeClientId?: string): Promise<void> {
    await this.local.broadcastToAll(message, excludeClientId);
    await this.send({ t: 'all', n: this.nodeId, message, exclude: excludeClientId ?? null });
  }

  async sendToChannel(
    channel: string,
    message: unknown,
    excludeClientId?: string | null,
    opts?: { skipCoalesce?: boolean; publisherClientId?: string | null },
  ): Promise<void> {
    const publisher = opts?.publisherClientId ?? null;
    // Authz BEFORE fan-out. The inner router refuses a denied publish locally,
    // but it cannot stop a frame this class has already put on the bus — that
    // would turn a refusal into a cross-replica broadcast, i.e. the authz check
    // would protect only the publisher's own task.
    if (publisher && this.hasChannelAuthorize() && !this.checkChannel('publish', publisher, channel)) {
      this.logger.info?.(`[realtime] publish to ${channel} denied for ${publisher} (no fan-out)`);
      return;
    }
    // Origin replica: local delivery + plugin dispatch, exactly as before.
    await this.local.sendToChannel(channel, message, excludeClientId, opts);
    // Other replicas: delivery only. `exclude` travels because the sender's own
    // socket may be anywhere, though in practice it is here.
    await this.send({ t: 'chan', n: this.nodeId, channel, message, exclude: excludeClientId ?? null });
  }

  // ---- membership ------------------------------------------------------

  async subscribeToChannel(clientId: string, channel: string, opts?: unknown): Promise<boolean | void> {
    const allowed = await (this.local as unknown as {
      subscribeToChannel(c: string, ch: string, o?: unknown): Promise<boolean | void> | boolean | void;
    }).subscribeToChannel(clientId, channel, opts);
    // A refusal must not be announced, or the fleet would record a subscriber
    // the owning replica itself rejected.
    if (allowed === false) return false;
    const userId = this.local.getUserIdForClient(clientId);
    const entry = this.mine.get(clientId) ?? { channels: new Set<string>() };
    if (userId) entry.userId = userId;
    entry.channels.add(channel);
    this.mine.set(clientId, entry);
    this.addMember(channel, clientId);
    await this.send({ t: 'sub', n: this.nodeId, clientId, ...(userId ? { userId } : {}), channel });
    return allowed;
  }

  async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
    await (this.local as unknown as {
      unsubscribeFromChannel(c: string, ch: string): Promise<void> | void;
    }).unsubscribeFromChannel(clientId, channel);
    this.mine.get(clientId)?.channels.delete(channel);
    this.removeMember(channel, clientId);
    await this.send({ t: 'unsub', n: this.nodeId, clientId, channel });
  }

  removeClient(clientId: string): void {
    this.local.removeClient(clientId);
    const entry = this.mine.get(clientId);
    if (entry) for (const ch of entry.channels) this.removeMember(ch, clientId);
    this.mine.delete(clientId);
    void this.send({ t: 'gone', n: this.nodeId, clientId });
  }

  _setHandle(handle: unknown): void {
    (this.local as unknown as { _setHandle?: (h: unknown) => void })._setHandle?.(handle);
  }

  /** Stop heartbeating. The bus itself is owned by the caller. */
  stop(): void {
    this.stopped = true;
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
  }

  /** Replicas this node has heard from — surfaced for /health and tests. */
  peers(): string[] { return [...this.remotes.keys()]; }
}

/**
 * A bus usable before its transport is connected.
 *
 * `attachRealtimeGateway` is synchronous and `redisRouterBus` is not (the pub/sub
 * manager has to `start()`), so without this the gateway would either have to
 * become async — changing every caller — or drop the frames published during
 * startup. Subscriptions are replayed BEFORE queued publishes, so a frame
 * published during startup cannot arrive before this replica is listening for
 * the answers to it.
 */
export function lazyRouterBus(pending: Promise<RouterBus>, onError?: (err: Error) => void): RouterBus {
  let real: RouterBus | null = null;
  const queuedPublishes: Array<[string, unknown]> = [];
  const queuedSubscribes: Array<[string, (p: unknown) => void]> = [];
  void pending.then((bus) => {
    real = bus;
    for (const [topic, handler] of queuedSubscribes.splice(0)) bus.subscribe(topic, handler);
    for (const [topic, payload] of queuedPublishes.splice(0)) void bus.publish(topic, payload);
  }).catch((err: unknown) => {
    // A bus that never connects leaves this replica single-task rather than
    // broken: local delivery is unaffected, and the queues are dropped so they
    // cannot grow without bound.
    queuedPublishes.length = 0;
    queuedSubscribes.length = 0;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  });
  return {
    publish(topic, payload) { if (real) return real.publish(topic, payload); queuedPublishes.push([topic, payload]); },
    subscribe(topic, handler) { if (real) real.subscribe(topic, handler); else queuedSubscribes.push([topic, handler]); },
  };
}

/**
 * The production bus: distributed-core's `RedisPubSubManager` over
 * lib/redis-lite.ts. Using the library rather than raw PUBLISH/SUBSCRIBE buys
 * the parts that are tedious and easy to get subtly wrong — it dedupes by
 * message id inside a 60s window, re-subscribes every topic after a subscriber
 * reconnect, and backs off on reconnect — and it is the component in
 * distributed-core built for exactly this fan-out.
 *
 * `createClient` is called twice, once for the publisher and once for the
 * subscriber, because a subscribed Redis connection may not issue PUBLISH.
 * `pubSubRedisClient` returns lazily-connecting sockets so each role opens only
 * the one it uses.
 */
export async function redisRouterBus(url: string, nodeId: string): Promise<RouterBus & { stop(): Promise<void> }> {
  // From the ROOT entry point, not `distributed-core/gateway`: the gateway
  // barrel re-exports only the in-process `PubSubManager`, so the Redis one is
  // reachable only from the root (src/index.ts). Importing it from the subpath
  // fails at type-check, which is how this was caught rather than at runtime.
  const { RedisPubSubManager } = await import('distributed-core');
  const { pubSubRedisClient } = await import('./redis-lite.js');
  const manager = new RedisPubSubManager({
    localNodeId: nodeId,
    createClient: () => pubSubRedisClient(url) as never,
  });
  await manager.start();
  return {
    publish: (topic: string, payload: unknown) => manager.publish(topic, payload),
    subscribe: (topic: string, handler: (p: unknown) => void) => {
      manager.subscribe(topic, (_topic: string, payload: unknown) => handler(payload));
    },
    stop: () => manager.stop(),
  };
}
