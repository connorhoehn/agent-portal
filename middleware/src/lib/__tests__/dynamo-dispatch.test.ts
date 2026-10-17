jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { DynamoDispatchQueue } from '../dynamo-dispatch.js';
import { MirroredMembershipStore } from '../social-chat.js';
import type { ChatMember } from '@connorhoehn/realtime-modules/chat';
import { DynamoChatStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';
import { performance } from 'node:perf_hooks';

function held<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const holdLoop = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* delay timers deliberately */ } };

it('limits dispatch, releases failed work, and refuses excess queued work before invoking it', async () => {
  const waiting = held(), started: number[] = [];
  const queue = new DynamoDispatchQueue({ send: async (id: number) => {
    started.push(id); if (id === 1) { await waiting.promise; throw new Error('SDK failure'); } return id;
  } }, 1, 1);
  const first = queue.send(1); const failed = expect(first).rejects.toThrow('SDK failure');
  const second = queue.send(2);
  await expect(queue.send(3)).rejects.toThrow('queue is full');
  expect(started).toEqual([1]); waiting.resolve(); await failed;
  expect(await second).toBe(2); expect(await queue.send(4)).toBe(4); expect(started).toEqual([1, 2, 4]);
});

it('runs sequential membership pages under one permit without deadlocking a full pool', async () => {
  const called: number[] = [], queue = new DynamoDispatchQueue({ send: async (value: number) => { called.push(value); return value; } }, 1);
  expect(await queue.dispatchMembershipRead(async () => [await queue.send(1), await queue.send(2)])).toEqual([1, 2]);
  expect(called).toEqual([1, 2]); expect(await queue.send(3)).toBe(3);
});

it('a detached callback cannot reuse a released permit while another request occupies the pool', async () => {
  const wait = held(), later = held(), starts: string[] = [];
  let detached!: Promise<unknown>;
  const queue = new DynamoDispatchQueue({ send: async (kind: string) => {
    starts.push(kind); if (kind === 'blocking') await wait.promise; return kind;
  } }, 1);
  await queue.dispatchMembershipRead(async () => { detached = later.promise.then(() => queue.send('detached')); return 'completed'; });
  const blocking = queue.send('blocking'); later.resolve(); await turn();
  expect(starts).toEqual(['blocking']); wait.resolve(); await blocking;
  expect(await detached).toBe('detached'); expect(starts).toEqual(['blocking', 'detached']);
});

it('a dispatch rejection leaves no failed membership result for the next authority read', async () => {
  let unavailable = true;
  const store = new MirroredMembershipStore(() => [], { listMembers: async () => [], getMember: async () => null, putMember: async () => undefined },
    read => unavailable ? Promise.reject(new Error('Queue unavailable')) : read());
  await expect(store.listMembers('social:dm:alice:bob')).rejects.toThrow('Queue unavailable');
  unavailable = false;
  expect(await store.listMembers('social:dm:alice:bob')).toEqual([]);
});

it('expires queued work without dispatching it later or retaining its queue slot', async () => {
  jest.useFakeTimers();
  try {
    const wait = held(), starts: string[] = [];
    const queue = new DynamoDispatchQueue({ send: async (kind: string) => {
      starts.push(kind); if (kind === 'blocking') await wait.promise; return kind;
    } }, 1, 1, 10);
    const blocking = queue.send('blocking');
    const expired = expect(queue.send('expired')).rejects.toThrow('dispatch wait timed out');
    jest.advanceTimersByTime(11); await expired;
    const fresh = queue.send('fresh'); wait.resolve(); await blocking;
    expect(await fresh).toBe('fresh'); expect(starts).toEqual(['blocking', 'fresh']);
  } finally { jest.useRealTimers(); }
});

it('never starts expired work when a slot frees before an overdue timer callback can run', async () => {
  const wait = held(), starts: string[] = [];
  const queue = new DynamoDispatchQueue({ send: async (kind: string) => {
    starts.push(kind); if (kind === 'blocking') await wait.promise; return kind;
  } }, 1, 1, 10);
  const blocking = queue.send('blocking');
  const expired = expect(queue.send('expired')).rejects.toThrow('dispatch wait timed out');
  holdLoop(20); wait.resolve(); await Promise.all([blocking, expired]);
  expect(starts).toEqual(['blocking']); expect(await queue.send('fresh')).toBe('fresh');
});

it('overdue timers cannot leave expired jobs occupying the admission queue', async () => {
  // The fresh job needs real headroom: a 10 ms budget flaked under a full-suite
  // GC pause between its admission and the blocking job's release.
  const wait = held(), starts: string[] = [];
  const queue = new DynamoDispatchQueue({ send: async (kind: string) => {
    starts.push(kind); if (kind === 'blocking') await wait.promise; return kind;
  } }, 1, 1, 200);
  const blocking = queue.send('blocking');
  const expired = expect(queue.send('expired')).rejects.toThrow('dispatch wait timed out');
  holdLoop(220);
  const fresh = queue.send('fresh'); const accepted = expect(fresh).resolves.toBe('fresh');
  wait.resolve(); await Promise.all([blocking, expired, accepted]);
  expect(starts).toEqual(['blocking', 'fresh']);
});

it('combines only reads waiting for dispatch and starts a fresh snapshot for a later unhinted removal', async () => {
  const channel = 'social:dm:alice:bob';
  const durable: ChatMember = { channel, userId: 'bob', role: 'member', addedBy: 'alice', addedAt: 'now', historyFrom: null, removedAt: null };
  const blocker = held(), entered = held(), oldReply = held(); let snapshots = 0;
  const queue = new DynamoDispatchQueue({ send: async (kind: string) => {
    if (kind === 'blocker') return blocker.promise;
    const snapshot = structuredClone(durable); snapshots++;
    if (snapshots === 1) { entered.resolve(); await oldReply.promise; }
    return [snapshot];
  } }, 1);
  const store = new MirroredMembershipStore(() => [], { listMembers: () => queue.send('membership'),
    getMember: async () => structuredClone(durable), putMember: async () => undefined },
  read => queue.dispatchMembershipRead(read));
  const background = queue.send('blocker');
  const collected = [store.listMembers(channel)]; await turn();
  collected.push(store.listMembers(channel)); await turn();
  expect(snapshots).toBe(0);
  blocker.resolve(); await background; await entered.promise;
  durable.removedAt = 'unhinted remote removal';
  const fresh = store.listMembers(channel); await turn();
  oldReply.resolve(); const original = await Promise.all(collected);
  expect(snapshots).toBe(2); expect(original.map(rows => rows[0].removedAt)).toEqual([null, null]);
  expect((await fresh)[0].removedAt).toBe('unhinted remote removal');
  original[0][0].removedAt = 'mutated'; expect(original[1][0].removedAt).toBeNull();
});

it('keeps 1000 queued authority readers current and independent across 500 conversations', async () => {
  const release = held(), snapshots = new Map<string, number>(); let active = 0, peak = 0, revoked = false;
  const queue = new DynamoDispatchQueue({ send: async (command: { channel?: string }) => {
    active++; peak = Math.max(peak, active);
    try {
      if (!command.channel) { await release.promise; return []; }
      snapshots.set(command.channel, (snapshots.get(command.channel) ?? 0) + 1);
      await Promise.resolve();
      const members = command.channel.slice('social:dm:'.length).split(':');
      return members.map(userId => ({ channel: command.channel, userId, role: 'member', addedBy: members[0], addedAt: 'now',
        historyFrom: null, removedAt: revoked ? 'remote removal before dispatch' : null }));
    } finally { active--; }
  } }, 50);
  const store = new MirroredMembershipStore(() => [], { listMembers: channel => queue.send({ channel }),
    getMember: async () => null, putMember: async () => undefined }, read => queue.dispatchMembershipRead(read));
  const blockers = Array.from({ length: 50 }, () => queue.send({}));
  const first = Array.from({ length: 500 }, (_, index) => store.listMembers(`social:dm:alice-${index}:bob-${index}`));
  await turn();
  const second = Array.from({ length: 500 }, (_, index) => store.listMembers(`social:dm:alice-${index}:bob-${index}`));
  await turn(); expect(snapshots.size).toBe(0);
  revoked = true; release.resolve(); await Promise.all(blockers);
  const responses = await Promise.all([...first, ...second]);
  expect(peak).toBe(50); expect(snapshots.size).toBe(500); expect([...snapshots.values()]).toEqual(Array(500).fill(1));
  expect(responses.every(rows => rows[0].removedAt === 'remote removal before dispatch')).toBe(true);
  responses[0][0].removedAt = null;
  expect(responses[500][0].removedAt).toBe('remote removal before dispatch');
  await store.listMembers('social:dm:alice-0:bob-0'); expect(snapshots.get('social:dm:alice-0:bob-0')).toBe(2);
});

it('preserves the public DynamoDB adapter\'s strong reads and pagination through the dispatch scope', async () => {
  const requests: Array<{ ConsistentRead?: boolean; ExclusiveStartKey?: unknown }> = [];
  const queue = new DynamoDispatchQueue({ send: async (command: { input: { ConsistentRead?: boolean; ExclusiveStartKey?: unknown } }) => {
    requests.push(command.input);
    const userId = command.input.ExclusiveStartKey ? 'bob' : 'alice';
    return { Items: [{ channel: { S: 'social:dm:alice:bob' }, userId: { S: userId }, role: { S: 'member' },
      addedBy: { S: 'alice' }, addedAt: { S: 'now' } }],
    ...(!command.input.ExclusiveStartKey ? { LastEvaluatedKey: { channel: { S: 'social:dm:alice:bob' }, userId: { S: 'alice' } } } : {}) };
  } }, 1);
  const durable = new DynamoChatStore({ client: queue, tablePrefix: 'dispatch-test-' });
  const store = new MirroredMembershipStore(() => [], durable.members, read => queue.dispatchMembershipRead(read));
  const members = await store.listMembers('social:dm:alice:bob');
  expect(members.map(member => member.userId)).toEqual(['alice', 'bob']);
  expect(requests).toHaveLength(2); expect(requests.every(request => request.ConsistentRead === true)).toBe(true);
  expect(requests[1].ExclusiveStartKey).toEqual({ channel: { S: 'social:dm:alice:bob' }, userId: { S: 'alice' } });
});
