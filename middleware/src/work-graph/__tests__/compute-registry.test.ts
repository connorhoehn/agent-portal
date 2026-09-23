import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  createDynamoRegistryStore,
  createMemoryRegistryStore,
  registrySortKey,
  type ComputeRegistryStore,
} from '../compute-registry-store.js';
import { createComputeRegistry } from '../compute-registry.js';
import {
  createComputeCapabilitySessions,
  type ComputeCapabilityResource,
  type ComputeCapabilitySources,
} from '../compute-capability-sessions.js';
import { attachFleetMirror } from '../compute-registry-runtime.js';
import type { FleetBox, FleetStore } from '../../lib/devbox-fleet.js';

const T0 = Date.parse('2026-09-22T12:00:00.000Z');

function clock() {
  let t = T0;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

/**
 * A DynamoDB table in memory that understands exactly the commands the
 * registry store issues — enough to exercise its key mapping, the refresh
 * condition, and expiry filtering without a network.
 */
function fakeDynamo() {
  const rows = new Map<string, Record<string, any>>();
  const id = (key: { sessionId: string; timestamp: number }) => `${key.sessionId}|${key.timestamp}`;
  const client = {
    async send(command: unknown) {
      if (command instanceof PutCommand) {
        const item = command.input.Item as any;
        rows.set(id(item), { ...item });
        return {};
      }
      if (command instanceof GetCommand) {
        const row = rows.get(id(command.input.Key as any));
        return { Item: row ? { ...row } : undefined };
      }
      if (command instanceof DeleteCommand) {
        rows.delete(id(command.input.Key as any));
        return {};
      }
      if (command instanceof QueryCommand) {
        const pk = (command.input.ExpressionAttributeValues as any)[':pk'];
        return { Items: [...rows.values()].filter((r) => r.sessionId === pk).map((r) => ({ ...r })) };
      }
      if (command instanceof UpdateCommand) {
        const v = command.input.ExpressionAttributeValues as any;
        const row = rows.get(id(command.input.Key as any));
        // attribute_exists(sessionId) AND registryKey = :k AND expiresAtMs > :now
        if (!row || row.registryKey !== v[':k'] || !(row.expiresAtMs > v[':now'])) {
          throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
        }
        row.expiresAtMs = v[':e'];
        row.ttl = v[':t'];
        return {};
      }
      throw new Error(`unexpected command ${(command as object).constructor.name}`);
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, rows };
}

const stores: Array<[string, (now: () => number) => ComputeRegistryStore]> = [
  ['memory', (now) => createMemoryRegistryStore({ now })],
  ['dynamodb', (now) => createDynamoRegistryStore({ client: fakeDynamo().client, tableName: 't', now })],
];

describe.each(stores)('%s registry store', (_name, make) => {
  it('round-trips, lists and deletes by partition', async () => {
    const c = clock();
    const store = make(c.now);
    await store.put('box', 'a', { id: 'a' }, 60_000);
    await store.put('box', 'b', { id: 'b' }, 60_000);
    await store.put('other', 'a', { id: 'x' }, 60_000);
    await expect(store.get('box', 'a')).resolves.toEqual({ id: 'a' });
    await expect(store.list('box')).resolves.toEqual(expect.arrayContaining([{ id: 'a' }, { id: 'b' }]));
    await store.delete('box', 'a');
    await expect(store.get('box', 'a')).resolves.toBeNull();
    await expect(store.list('box')).resolves.toEqual([{ id: 'b' }]);
  });

  it('filters expired records on read and lets refresh extend only live ones', async () => {
    const c = clock();
    const store = make(c.now);
    await store.put('box', 'kept', { id: 'kept' }, 10_000);
    await store.put('box', 'lapsed', { id: 'lapsed' }, 10_000);
    c.advance(9_000);
    await expect(store.refresh('box', 'kept', 10_000)).resolves.toBe(true);
    c.advance(2_000);
    await expect(store.get('box', 'lapsed')).resolves.toBeNull();
    await expect(store.list('box')).resolves.toEqual([{ id: 'kept' }]);
    // A heartbeat never resurrects: an expired or deleted record stays gone.
    await expect(store.refresh('box', 'lapsed', 10_000)).resolves.toBe(false);
    await store.delete('box', 'kept');
    await expect(store.refresh('box', 'kept', 10_000)).resolves.toBe(false);
  });
});

describe('dynamodb registry store mapping', () => {
  it('keys rows into the sessions-table shape with a TTL attribute and ignores a sort-key collision', async () => {
    const c = clock();
    const { client, rows } = fakeDynamo();
    const store = createDynamoRegistryStore({ client, tableName: 't', now: c.now });
    await store.put('box', 'b1', { id: 'b1' }, 60_000);
    const [row] = [...rows.values()];
    expect(row).toMatchObject({
      sessionId: 'compute-registry#box', timestamp: registrySortKey('b1'), registryKey: 'b1',
      expiresAtMs: T0 + 60_000, ttl: Math.ceil((T0 + 60_000) / 1000),
    });
    expect(Number.isSafeInteger(row!.timestamp)).toBe(true);
    // A row whose stored key disagrees reads as a miss, never as another key's value.
    row!.registryKey = 'someone-else';
    await expect(store.get('box', 'b1')).resolves.toBeNull();
  });

  it('treats a row the backend has not swept yet as expired', async () => {
    const c = clock();
    const store = createDynamoRegistryStore({ client: fakeDynamo().client, tableName: 't', now: c.now });
    await store.put('share:x', 'v', { viewerId: 'v' }, 1_000);
    c.advance(1_000);
    await expect(store.get('share:x', 'v')).resolves.toBeNull();
    await expect(store.list('share:x')).resolves.toEqual([]);
  });
});

function box(id: string, overrides: Partial<FleetBox> = {}): FleetBox {
  return {
    id, label: 'Cloud terminal', sessionId: `fixture-${id}`, createdAt: new Date(T0).toISOString(),
    status: 'idle', lastActivityAt: new Date(T0).toISOString(), ownerId: 'frank', ...overrides,
  } as FleetBox;
}

describe('registry TTL', () => {
  it('expires box and share registrations unless refreshed', async () => {
    const c = clock();
    const registry = createComputeRegistry({ store: createMemoryRegistryStore({ now: c.now }), registrationTtlMs: 60_000, now: c.now });
    const resource: ComputeCapabilityResource = { source: 'cloud-compute', resourceId: 'box:b1' };
    await registry.putBox(box('b1'));
    await registry.share(resource, 'alice');
    c.advance(50_000);
    await registry.refreshBox('b1');
    await registry.refreshShares(resource);
    c.advance(50_000);
    await expect(registry.getBox('b1')).resolves.toMatchObject({ id: 'b1' });
    await expect(registry.isShared(resource, 'alice')).resolves.toBe(true);
    c.advance(60_000);
    await expect(registry.getBox('b1')).resolves.toBeNull();
    await expect(registry.isShared(resource, 'alice')).resolves.toBe(false);
  });

  it('removing a box drops its explicit shares', async () => {
    const registry = createComputeRegistry();
    const resource: ComputeCapabilityResource = { source: 'cloud-compute', resourceId: 'box:b1' };
    await registry.putBox(box('b1'));
    await registry.share(resource, 'alice');
    await registry.removeBox('b1');
    await expect(registry.isShared(resource, 'alice')).resolves.toBe(false);
  });
});

describe('two replicas over one shared store', () => {
  const resource: ComputeCapabilityResource = { source: 'cloud-compute', resourceId: 'box:b1' };

  /** One middleware process: its own registry + sessions over the shared store. */
  function replica(store: ComputeRegistryStore, now: () => number, ids: string[] = []) {
    const registry = createComputeRegistry({ store, registrationTtlMs: 60_000, now });
    // The same shape resolveCloud has: the durable owner comes from the registry.
    const sources: ComputeCapabilitySources = {
      async resolve(r) {
        const found = await registry.getBox(r.resourceId.replace(/^box:/, ''));
        return found?.ownerId ? {
          ownerId: found.ownerId, resource: r, status: 'running', controllable: true, revocationKeys: [`box:${found.id}`],
        } : null;
      },
      async cancel() { return true; },
    };
    let n = 0;
    const sessions = createComputeCapabilitySessions({
      organizationId: 'dev-org', sources, registry, now, maxTtlMs: 5 * 60_000,
      newId: () => ids[n++] ?? `s-${n}`,
    });
    return { registry, sessions };
  }

  const disclosure = (viewerId: string) => ({ organizationId: 'dev-org', viewerId, personId: 'frank', resource });

  it.each(stores)('%s: a registration made on A answers the same on B, and survives A restarting', async (_name, make) => {
    const c = clock();
    const store = make(c.now);
    const a = replica(store, c.now);
    const b = replica(store, c.now);
    await a.registry.putBox(box('b1'));
    await a.sessions.share(resource, 'alice');

    const onA = await a.sessions.authorizeDisclosure(disclosure('alice'));
    expect(onA).toEqual({ allowed: true, directAccess: true, capabilities: ['observe-terminal', 'control-terminal'] });
    // 20 of 20 reads answer the same on either replica.
    for (let i = 0; i < 20; i++) {
      const on = i % 2 ? a : b;
      await expect(on.sessions.authorizeDisclosure(disclosure('alice'))).resolves.toEqual(onA);
      await expect(on.sessions.authorizeDisclosure(disclosure('mallory'))).resolves.toMatchObject({ directAccess: false });
    }

    const restartedA = replica(store, c.now);
    await expect(restartedA.sessions.authorizeDisclosure(disclosure('alice'))).resolves.toEqual(onA);
  });

  it('a capability session opened on A can be revalidated and closed on B', async () => {
    const c = clock();
    const store = createMemoryRegistryStore({ now: c.now });
    const a = replica(store, c.now, ['cap-1']);
    const b = replica(store, c.now);
    await a.registry.putBox(box('b1'));
    const opened = await a.sessions.open({
      ...disclosure('frank'), capability: 'observe', requestedExpiresAt: new Date(T0 + 60_000).toISOString(),
    });
    expect(opened).toMatchObject({ allowed: true, session: { sessionId: 'cap-1' } });
    expect((opened as { session: object }).session).not.toHaveProperty('openedAtMs');
    await expect(b.sessions.revalidate('cap-1')).resolves.toMatchObject({ allowed: true });

    const ended = jest.fn();
    a.sessions.subscribe('cap-1', ended);
    await expect(b.sessions.close('cap-1')).resolves.toMatchObject({ active: false, endReason: 'closed' });
    // A learns of it on its next look, and tells its attached listener.
    await expect(a.sessions.revalidate('cap-1')).resolves.toEqual({ allowed: false, reason: 'closed' });
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ active: false, endReason: 'closed' }));
  });

  it('a source revocation raised on B ends a session opened on A', async () => {
    const c = clock();
    const store = createMemoryRegistryStore({ now: c.now });
    const a = replica(store, c.now, ['cap-2']);
    const b = replica(store, c.now);
    await a.registry.putBox(box('b1'));
    await a.sessions.open({ ...disclosure('frank'), capability: 'observe', requestedExpiresAt: new Date(T0 + 60_000).toISOString() });
    c.advance(1);
    expect(b.sessions.invalidateByRevocationKey('cloud-compute', 'box:b1')).toBe(0); // not in B's cache
    await expect(a.sessions.revalidate('cap-2')).resolves.toEqual({ allowed: false, reason: 'source-revoked' });
  });

  it('the fleet heartbeat keeps a replica\'s boxes registered; without a live holder they expire', async () => {
    const c = clock();
    const store = createMemoryRegistryStore({ now: c.now });
    const registry = createComputeRegistry({ store, registrationTtlMs: 60_000, now: c.now });
    const fleet: FleetBox[] = [];
    let mirror: FleetStore | null = null;
    const replicaA = attachFleetMirror(registry, {
      addFleetMirror: (m) => { mirror = m; return () => { mirror = null; }; },
      listBoxes: () => fleet,
    });
    fleet.push(box('b1'));
    mirror!.upsert(fleet[0]!);
    await registry.share(resource, 'alice');
    for (let i = 0; i < 5; i++) { c.advance(20_000); await replicaA.heartbeat(); }
    await expect(registry.getBox('b1')).resolves.toMatchObject({ id: 'b1' });
    await expect(registry.isShared(resource, 'alice')).resolves.toBe(true);

    // Activity on the box is written in full at the next beat.
    mirror!.touch({ ...fleet[0]!, lastActivityAt: new Date(c.now()).toISOString() });
    fleet[0] = { ...fleet[0]!, lastActivityAt: new Date(c.now()).toISOString() };
    await replicaA.heartbeat();
    await expect(registry.getBox('b1')).resolves.toMatchObject({ lastActivityAt: new Date(c.now()).toISOString() });

    replicaA.detach(); // every replica holding it is gone
    c.advance(61_000);
    await expect(registry.getBox('b1')).resolves.toBeNull();
    await expect(registry.isShared(resource, 'alice')).resolves.toBe(false);
  });

  it('a heartbeat does not resurrect a box another replica removed', async () => {
    const c = clock();
    const store = createMemoryRegistryStore({ now: c.now });
    const registry = createComputeRegistry({ store, registrationTtlMs: 60_000, now: c.now });
    const fleet = [box('b1')];
    const replicaB = attachFleetMirror(registry, { addFleetMirror: () => () => {}, listBoxes: () => fleet });
    await registry.putBox(fleet[0]!);
    await registry.removeBox('b1'); // replica A removed it
    await replicaB.heartbeat();       // B still holds a stale copy
    await expect(registry.getBox('b1')).resolves.toBeNull();
  });
});
