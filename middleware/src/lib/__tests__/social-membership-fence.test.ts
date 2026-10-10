jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ChatMember, ChatMembershipStore } from '@connorhoehnslalom/realtime-modules/chat';
import { MirroredMembershipStore } from '../social-chat.js';

it('a delayed durable hydrate cannot revive membership after a newer successful local removal', async () => {
  const row: ChatMember = { channel: 'social:ch:private', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt: null };
  const rows = [structuredClone(row)]; let release!: () => void; let start!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { start = resolve; });
  const persist: ChatMembershipStore = { listMembers: async () => { start(); await waiting; return [structuredClone(row)]; },
    getMember: async () => row, putMember: async () => undefined };
  const store = new MirroredMembershipStore(() => rows, persist);
  const proof = store.observeChanges(row.channel); const pending = store.hydrate(row.channel); await started;
  await store.putMember({ ...row, removedAt: '2026-10-03T01:00:00.000Z' }); expect(proof.changed()).toBe(true);
  release(); await pending; expect(store.isActiveMember(row.channel, 'alice')).toBe(false); proof.dispose();
});

it('failed durable membership writes do not invalidate an unchanged current proof', async () => {
  const row: ChatMember = { channel: 'social:dm:alice:bob', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt: null };
  const persist: ChatMembershipStore = { listMembers: async () => [row], getMember: async () => row,
    putMember: async () => { throw new Error('Dynamo unavailable'); } };
  const store = new MirroredMembershipStore(() => [], persist); const proof = store.observeChanges(row.channel);
  try {
    await expect(store.putMember({ ...row, removedAt: 'now' })).rejects.toThrow('Dynamo unavailable');
    expect(proof.changed()).toBe(false);
  } finally { proof.dispose(); }
});

it('fresh channel reads observe a committed remote removal without an invalidation hint', async () => {
  const row: ChatMember = { channel: 'social:ch:private', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt: null };
  const durable = [structuredClone(row)], mirror = [structuredClone(row)];
  const persist: ChatMembershipStore = { listMembers: async () => structuredClone(durable), getMember: async () => durable[0], putMember: async () => undefined };
  const store = new MirroredMembershipStore(() => mirror, persist);
  durable[0].removedAt = '2026-10-05T01:00:00.000Z';
  expect(store.isActiveMember(row.channel, 'alice')).toBe(true);
  expect((await store.listMembers(row.channel))[0].removedAt).toBe(durable[0].removedAt);
  expect(store.isActiveMember(row.channel, 'alice')).toBe(false);
});

it('a peer invalidation fences a delayed read without trusting a membership payload', async () => {
  const row: ChatMember = { channel: 'social:ch:private', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt: null };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const persist: ChatMembershipStore = { listMembers: async () => { entered(); await waiting; return [row]; }, getMember: async () => row, putMember: async () => undefined };
  const store = new MirroredMembershipStore(() => [{ ...row, removedAt: '2026-10-05T01:00:00.000Z' }], persist);
  const proof = store.observeChanges(row.channel), pending = store.listMembers(row.channel);
  await started; store.invalidate(row.channel); release();
  await pending;
  expect(proof.changed()).toBe(true);
  expect(store.isActiveMember(row.channel, 'alice')).toBe(false);
  proof.dispose();
});

it('a committed removal replaces an outstanding DM read for later callers without sharing mutable results', async () => {
  const row: ChatMember = { channel: 'social:dm:alice:bob', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt: null };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let first = true; let durable = structuredClone(row);
  const persist: ChatMembershipStore = {
    listMembers: async () => { if (first) { first = false; await waiting; return [structuredClone(row)]; } return [structuredClone(durable)]; },
    getMember: async () => structuredClone(durable), putMember: async member => { durable = structuredClone(member); },
  };
  const store = new MirroredMembershipStore(() => [], persist);
  const proof = store.observeChanges(row.channel);
  const old = store.listMembers(row.channel);
  await store.putMember({ ...row, removedAt: 'now' });
  const fresh = await store.listMembers(row.channel);
  expect(fresh[0].removedAt).toBe('now'); expect(proof.changed()).toBe(true);
  release(); await old;
  fresh[0].removedAt = null;
  expect((await store.listMembers(row.channel))[0].removedAt).toBe('now');
  proof.dispose();
});

it('a failed outstanding membership read cannot poison the next current read', async () => {
  let fail = true;
  const persist: ChatMembershipStore = { listMembers: async () => { if (fail) throw new Error('membership offline'); return []; },
    getMember: async () => null, putMember: async () => undefined };
  const store = new MirroredMembershipStore(() => [], persist);
  await expect(store.listMembers('social:dm:a:b')).rejects.toThrow('membership offline');
  fail = false;
  expect(await store.listMembers('social:dm:a:b')).toEqual([]);
});

it('a new read after an unhinted remote removal cannot reuse a query that already captured older authority', async () => {
  const row: ChatMember = { channel: 'social:dm:alice:bob', userId: 'alice', role: 'member', addedBy: 'bob',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt: null };
  let release!: () => void, entered!: () => void, first = true;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const durable = structuredClone(row);
  const persist: ChatMembershipStore = {
    listMembers: async () => {
      const snapshot = structuredClone(durable);
      if (first) { first = false; entered(); await waiting; }
      return [snapshot];
    },
    getMember: async () => structuredClone(durable), putMember: async () => undefined,
  };
  const store = new MirroredMembershipStore(() => [], persist);
  const old = store.listMembers(row.channel); await started;
  durable.removedAt = 'remote removal without hint';
  const fresh = store.listMembers(row.channel), point = store.getMember(row.channel, row.userId);
  release();
  expect((await old)[0].removedAt).toBeNull();
  expect((await fresh)[0].removedAt).toBe(durable.removedAt);
  expect((await point)?.removedAt).toBe(durable.removedAt);
});
