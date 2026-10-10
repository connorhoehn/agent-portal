jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import { MemoryCallPageStore, RedisCallPageStore, type StoredCallPage } from '../call-pages.js';

const page: NonNullable<StoredCallPage['page']> = { kind: 'initiative', id: 'p-auth', presenter: { userId: 'alice', displayName: 'Alice' }, sharedAt: '2026-10-03T00:00:00.000Z', provenance: 'opaque-server-value' };

it('memory reads are detached and a clear advances rather than discards its revision', async () => {
  const store = new MemoryCallPageStore();
  const first = await store.compareAndSet('call', 0, page);
  first.state.page!.presenter.userId = 'forged';
  expect((await store.get('call')).page?.presenter.userId).toBe('alice');
  expect(await store.compareAndSet('call', 1, null)).toEqual({ applied: true, state: { revision: 2, page: null } });
  expect(await store.compareAndSet('call', 1, page)).toEqual({ applied: false, state: { revision: 2, page: null } });
  await store.forget('call'); expect(await store.get('call')).toEqual({ revision: 0, page: null });
});

it('memory caller claim is first-writer only, detached, revision zero, and retained through page changes and clear', async () => {
  const store = new MemoryCallPageStore();
  const caller = { userId: 'alice', provenance: 'alice-current-session' };
  expect(await store.claimCaller('call', caller)).toEqual({ revision: 0, page: null, caller });
  const claim = await store.claimCaller('call', { userId: 'bob', provenance: 'bob-current-session' });
  claim.caller!.userId = 'changed';
  expect((await store.get('call')).caller).toEqual(caller);
  expect((await store.compareAndSet('call', 0, page)).state.caller).toEqual(caller);
  expect((await store.compareAndSet('call', 1, null)).state.caller).toEqual(caller);
});

it.each([null, page])('Redis read refreshes a live revision’s TTL including a null tombstone (%p)', async stored => {
  const state = { revision: 42, page: stored };
  const command = jest.fn().mockResolvedValueOnce(JSON.stringify(state));
  const store = new RedisCallPageStore({ command }, 14400);
  expect(await store.get('call:1')).toEqual(state);
  expect(command.mock.calls).toEqual([['EVAL', expect.any(String), 1, 'orgiq:call-page:call%3A1', 14400]]);
});

it('Redis absent state stays at revision zero and does not create a key', async () => {
  const command = jest.fn().mockResolvedValue(null);
  expect(await new RedisCallPageStore({ command }).get('call')).toEqual({ revision: 0, page: null });
  expect(command).toHaveBeenCalledTimes(1);
});

it('Redis CAS normalizes the atomic Lua reply, carries the expected revision, and stores only one scoped key', async () => {
  const state = { revision: 8, page };
  const command = jest.fn().mockResolvedValueOnce([1, JSON.stringify(state)]).mockResolvedValueOnce([0, JSON.stringify(state)]).mockResolvedValueOnce(1);
  const store = new RedisCallPageStore({ command }, 14400);
  expect(await store.compareAndSet('call:1', 7, page)).toEqual({ applied: true, state });
  expect(await store.compareAndSet('call:1', 7, null)).toEqual({ applied: false, state });
  expect(command.mock.calls[0]).toEqual(['EVAL', expect.any(String), 1, 'orgiq:call-page:call%3A1', 7, JSON.stringify(page), 14400]);
  await store.forget('call:1'); expect(command).toHaveBeenLastCalledWith('DEL', 'orgiq:call-page:call%3A1');
});

it('Redis corruption or failure stays a failure instead of silently reverting to memory/zero', async () => {
  const command = jest.fn().mockResolvedValueOnce('not-json').mockRejectedValueOnce(new Error('unavailable'));
  const store = new RedisCallPageStore({ command });
  await expect(store.get('call')).rejects.toThrow();
  await expect(store.compareAndSet('call', 0, page)).rejects.toThrow('unavailable');
});
