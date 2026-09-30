// lib/realtime-router-distributed.ts — the router that lets the gateway run at
// more than one ECS task.
//
// Two replicas share one bus in every test, because every bug this class exists
// to prevent is invisible with one. The bus JSON round-trips each frame, as
// Redis would, so a payload that cannot survive serialization fails here rather
// than in the fleet.
//
// What is pinned, and why each one is a real failure mode:
//   - a publish on A reaches a subscriber on B (the whole point);
//   - plugins fire ONCE per message, on the origin replica — firing per replica
//     would notify every user N times via the activity bell's producers;
//   - a publish the channel authz denies does not fan out (otherwise the check
//     only protects the publisher's own task);
//   - getClientsByUserId / isClientLive / channelMembers answer for the FLEET,
//     so a call rings a callee on another task and the bell does not notify
//     someone who is already reading the channel;
//   - a replica that goes silent has its clients evicted, and a late-joining
//     replica converges via hello/state.

import { DistributedRealtimeRouter, type RouterBus } from '../realtime-router-distributed.js';

/** One bus, JSON round-tripping like Redis, delivering to every subscriber. */
function memoryBus(): RouterBus & { frames: unknown[] } {
  const handlers: Array<(p: unknown) => void> = [];
  return {
    frames: [],
    publish(_topic: string, payload: unknown) {
      (this as unknown as { frames: unknown[] }).frames.push(payload);
      const wire = JSON.parse(JSON.stringify(payload)) as unknown;
      for (const h of handlers) h(wire);
    },
    subscribe(_topic: string, handler: (p: unknown) => void) { handlers.push(handler); },
  };
}

interface Replica {
  router: DistributedRealtimeRouter;
  sent: Array<{ clientId: string; message: unknown }>;
  connect(clientId: string, userId: string): void;
  disconnect(clientId: string): void;
}

function replica(bus: RouterBus, nodeId: string, opts: {
  authorize?: (info: { kind: string; clientId: string; channel: string }) => boolean;
  plugins?: Array<{ name: string; onMessage?: (i: { clientId: string; channelId: string; message: unknown; userId?: string }) => void }>;
  nodeTtlMs?: number;
} = {}): Replica {
  const sent: Array<{ clientId: string; message: unknown }> = [];
  const contexts = new Map<string, { userId: string }>();
  const router = new DistributedRealtimeRouter({
    bus, nodeId,
    authorize: opts.authorize as never,
    plugins: opts.plugins as never,
    nodeTtlMs: opts.nodeTtlMs,
    announceIntervalMs: 60_000, // no background heartbeat during a test
  });
  router._setHandle({
    getClientContext: (id: string) => contexts.get(id) ?? null,
    sendToClient: (id: string, msg: unknown) => { sent.push({ clientId: id, message: msg }); },
    listClients: () => [...contexts.keys()],
  });
  return {
    router, sent,
    connect: (clientId, userId) => { contexts.set(clientId, { userId }); },
    disconnect: (clientId) => { contexts.delete(clientId); router.removeClient(clientId); },
  };
}

describe('DistributedRealtimeRouter', () => {
  it('delivers a publish on one replica to a subscriber on another', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    const b = replica(bus, 'node-b');
    a.connect('c1', 'u-mira');
    b.connect('c2', 'u-lena');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    await b.router.subscribeToChannel('c2', 'social:ch:general');

    await a.router.sendToChannel('social:ch:general', { type: 'chat', text: 'hi' }, 'c1', { publisherClientId: 'c1' });

    // The sender is excluded on its own replica; the remote subscriber gets it.
    expect(a.sent.map((s) => s.clientId)).toEqual([]);
    expect(b.sent).toEqual([{ clientId: 'c2', message: { type: 'chat', text: 'hi' } }]);
  });

  it('fires plugins exactly once — on the origin replica, not once per task', async () => {
    const bus = memoryBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const a = replica(bus, 'node-a', { plugins: [{ name: 'notify', onMessage: (i) => seenA.push(String((i.message as { text: string }).text)) }] });
    const b = replica(bus, 'node-b', { plugins: [{ name: 'notify', onMessage: (i) => seenB.push(String((i.message as { text: string }).text)) }] });
    a.connect('c1', 'u-mira');
    b.connect('c2', 'u-lena');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    await b.router.subscribeToChannel('c2', 'social:ch:general');

    await a.router.sendToChannel('social:ch:general', { text: 'once' }, 'c1', { publisherClientId: 'c1' });

    expect(seenA).toEqual(['once']);
    // The bell's producers live in a plugin. If this were ['once'] too, every
    // notification would be duplicated per replica.
    expect(seenB).toEqual([]);
    // ...and replica B still DELIVERED the message to its socket.
    expect(b.sent).toHaveLength(1);
  });

  it('does not fan out a publish the channel authz denies', async () => {
    const bus = memoryBus();
    const deny = ({ kind, channel }: { kind: string; channel: string }) => !(kind === 'publish' && channel === 'social:ch:private');
    const a = replica(bus, 'node-a', { authorize: deny });
    const b = replica(bus, 'node-b', { authorize: deny });
    a.connect('c1', 'u-outsider');
    b.connect('c2', 'u-member');
    await b.router.subscribeToChannel('c2', 'social:ch:private');

    await a.router.sendToChannel('social:ch:private', { text: 'leak' }, null, { publisherClientId: 'c1' });

    expect(b.sent).toEqual([]);
    expect(bus.frames.filter((f) => (f as { t: string }).t === 'chan')).toEqual([]);
  });

  it('rings a user whose socket is on another replica, and never the excluded one', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    const b = replica(bus, 'node-b');
    a.connect('c1', 'u-mira');
    b.connect('c2', 'u-lena');
    // Identity reaches the registry through a subscription announcement.
    await a.router.subscribeToChannel('c1', 'social:presence');
    await b.router.subscribeToChannel('c2', 'social:presence');

    expect(a.router.getClientsByUserId(['u-lena'])).toEqual([{ clientId: 'c2', userId: 'u-lena' }]);
    expect(a.router.getClientsByUserId(['u-mira', 'u-lena'], 'c1').map((c) => c.userId)).toEqual(['u-lena']);
    // A directed send to a socket on B is delivered by B alone.
    a.router.sendToClient('c2', { type: 'call-invite' });
    expect(b.sent).toEqual([{ clientId: 'c2', message: { type: 'call-invite' } }]);
    expect(a.sent).toEqual([]);
  });

  it('reports a remote client live and an unknown one as unknown, not absent', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    const b = replica(bus, 'node-b');
    b.connect('c2', 'u-lena');
    await b.router.subscribeToChannel('c2', 'social:presence');

    expect(a.router.isClientLive('c2')).toBe(true);
    // null, not false: false would let a service conclude the socket is gone
    // and tear down its half of a call.
    expect(a.router.isClientLive('c-unknown')).toBeNull();
  });

  it('exposes fleet-wide channel membership, so the bell skips a reader on another task', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    const b = replica(bus, 'node-b');
    a.connect('c1', 'u-mira');
    b.connect('c2', 'u-lena');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    await b.router.subscribeToChannel('c2', 'social:ch:general');

    expect([...(a.router.channelMembers.get('social:ch:general') ?? [])].sort()).toEqual(['c1', 'c2']);
    expect(a.router.getUserIdForClient('c2')).toBe('u-lena');

    await b.router.unsubscribeFromChannel('c2', 'social:ch:general');
    expect([...(a.router.channelMembers.get('social:ch:general') ?? [])]).toEqual(['c1']);
  });

  it('drops a disconnected remote client, and a whole replica that goes silent', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a', { nodeTtlMs: 30_000 });
    const b = replica(bus, 'node-b');
    b.connect('c2', 'u-lena');
    await b.router.subscribeToChannel('c2', 'social:ch:general');
    expect(a.router.peers()).toEqual(['node-b']);

    b.disconnect('c2');
    expect(a.router.channelMembers.get('social:ch:general')).toBeUndefined();
    expect(a.router.isClientLive('c2')).toBeNull();

    // A replica that stops heartbeating ages out rather than leaving phantom
    // subscribers. Its last-seen is pushed beyond the TTL instead of sleeping,
    // so the assertion is about the eviction rule and not about wall-clock.
    const c3 = replica(bus, 'node-c');
    c3.connect('c4', 'u-sana');
    await c3.router.subscribeToChannel('c4', 'social:ch:general');
    expect([...(a.router.channelMembers.get('social:ch:general') ?? [])]).toEqual(['c4']);
    const remotes = (a.router as unknown as { remotes: Map<string, { seen: number }> }).remotes;
    remotes.get('node-c')!.seen = Date.now() - 60_000;
    (a.router as unknown as { expireStaleNodes(): void }).expireStaleNodes();
    expect(a.router.peers()).toEqual(['node-b']);
    // The dead replica's subscribers go with it.
    expect(a.router.channelMembers.get('social:ch:general')).toBeUndefined();
  });

  it('converges when a replica joins late — hello draws a full state reply', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    a.connect('c1', 'u-mira');
    await a.router.subscribeToChannel('c1', 'social:ch:general');

    // B starts after the subscription: no incremental frame will ever arrive
    // for it, so only the hello/state exchange can make c1 visible.
    const b = replica(bus, 'node-b');
    expect([...(b.router.channelMembers.get('social:ch:general') ?? [])]).toEqual(['c1']);
    expect(b.router.getClientsByUserId(['u-mira'])).toEqual([{ clientId: 'c1', userId: 'u-mira' }]);
  });

  it('a state frame replaces a node\'s membership rather than accumulating it', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'node-a');
    const b = replica(bus, 'node-b');
    b.connect('c2', 'u-lena');
    await b.router.subscribeToChannel('c2', 'social:ch:general');
    await b.router.subscribeToChannel('c2', 'social:ch:random');
    expect([...(a.router.channelMembers.get('social:ch:random') ?? [])]).toEqual(['c2']);

    // B leaves one channel and re-announces. The dropped channel must not
    // survive as a phantom subscriber on A.
    await b.router.unsubscribeFromChannel('c2', 'social:ch:random');
    (b.router as unknown as { send(f: unknown): Promise<void> }).send(
      (b.router as unknown as { stateFrame(): unknown }).stateFrame(),
    );
    expect(a.router.channelMembers.get('social:ch:random')).toBeUndefined();
    expect([...(a.router.channelMembers.get('social:ch:general') ?? [])]).toEqual(['c2']);
  });

  // Regression for a race found by running two real processes, not by reading:
  // distributed-core's RedisPubSubManager.subscribe() is synchronous but issues
  // the Redis SUBSCRIBE fire-and-forget, so a single cold-start `hello` can
  // leave before this replica is listening. The peers' `state` replies then land
  // on nobody and the new task believes it is alone — fan-out works outbound
  // while every inbound answer (ring a callee, is-this-client-live) says no.
  it('converges even when the bus subscribes late, so a scaled-up task is not born blind', async () => {
    const handlers: Array<(p: unknown) => void> = [];
    const pending: unknown[] = [];
    // A bus that accepts publishes immediately but only wires the subscriber up
    // after an explicit flush — the shape of an async SUBSCRIBE.
    const lateBus: RouterBus & { attach(): void } = {
      publish(_topic, payload) {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        if (handlers.length === 0) pending.push(wire); else for (const h of handlers) h(wire);
      },
      subscribe(_topic, handler) { pending.push({ __register: handler }); },
      attach() {
        for (const p of pending.splice(0)) {
          if (p && typeof p === 'object' && '__register' in p) handlers.push((p as { __register: (x: unknown) => void }).__register);
          else for (const h of handlers) h(p);
        }
      },
    };
    const a = replica(lateBus, 'node-a');
    a.connect('c1', 'u-mira');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    // Replica A's first hello went nowhere: it is not subscribed yet.
    expect(a.router.peers()).toEqual([]);

    lateBus.attach();
    // A retried hello now reaches a peer that answers with its state.
    const b = replica(lateBus, 'node-b');
    b.connect('c2', 'u-lena');
    await b.router.subscribeToChannel('c2', 'social:ch:general');
    await new Promise((r) => setTimeout(r, 250)); // first discovery retry
    expect(a.router.peers()).toEqual(['node-b']);
    expect(a.router.getClientsByUserId(['u-lena'])).toEqual([{ clientId: 'c2', userId: 'u-lena' }]);
  });

  // Documents a constraint rather than a behaviour, because violating it fails
  // silently and totally: a replica drops frames tagged with its own node id as
  // its own echo, so two replicas sharing an id deliver NOTHING to each other
  // while looking correctly wired. This cost a debugging round when replicaId()
  // fell back to `local-<pid>` and two gateways in one process collided. Keep
  // replicaId() unique per process.
  it('cannot deliver between two replicas that share a node id — ids must be unique', async () => {
    const bus = memoryBus();
    const a = replica(bus, 'same-id');
    const b = replica(bus, 'same-id');
    a.connect('c1', 'u-mira');
    b.connect('c2', 'u-lena');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    await b.router.subscribeToChannel('c2', 'social:ch:general');

    await a.router.sendToChannel('social:ch:general', { text: 'lost' }, 'c1', { publisherClientId: 'c1' });
    expect(b.sent).toEqual([]);
    expect(a.router.peers()).toEqual([]);
  });

  it('survives a bus that throws, because a fan-out failure must not fail the local send', async () => {
    const broken: RouterBus = { publish() { throw new Error('redis down'); }, subscribe() { /* none */ } };
    const a = replica(broken, 'node-a');
    a.connect('c1', 'u-mira');
    await a.router.subscribeToChannel('c1', 'social:ch:general');
    a.connect('c3', 'u-theo');
    await a.router.subscribeToChannel('c3', 'social:ch:general');

    await expect(a.router.sendToChannel('social:ch:general', { text: 'local still works' }, 'c1', { publisherClientId: 'c1' }))
      .resolves.toBeUndefined();
    expect(a.sent).toEqual([{ clientId: 'c3', message: { text: 'local still works' } }]);
  });
});
