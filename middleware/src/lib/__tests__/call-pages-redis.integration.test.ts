// Opt in with CALL_PAGE_TEST_REDIS_URL=redis://127.0.0.1:<port>.
// This executes the real Lua via the bounded Redis transport against two independent clients.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import { openRedisStore } from '../redis-store.js';
import { RedisCallPageStore, type StoredCallPage } from '../call-pages.js';

const url = process.env['CALL_PAGE_TEST_REDIS_URL'];
const testRedis = url ? it : it.skip;
testRedis('real Redis atomically selects one writer across two instances and retains clear revisions/TTL', async () => {
  const one = await openRedisStore(url!); const two = await openRedisStore(url!);
  const first = new RedisCallPageStore(one, 60); const second = new RedisCallPageStore(two, 60);
  const callId = `test-${process.pid}-${Date.now()}`;
  const key = `orgiq:call-page:${encodeURIComponent(callId)}`;
  const page: NonNullable<StoredCallPage['page']> = { kind: 'initiative', id: 'p-auth', presenter: { userId: 'alice', displayName: 'Alice' }, sharedAt: new Date().toISOString(), provenance: 'server-owned' };
  try {
    const claims = await Promise.all([first.claimCaller(callId, { userId: 'alice', provenance: 'alice-session' }), second.claimCaller(callId, { userId: 'bob', provenance: 'bob-session' })]);
    const caller = claims[0]!.caller!;
    expect(claims[1]!.caller).toEqual(caller);
    await one.command('EXPIRE', key, 1);
    expect(await first.get(callId)).toEqual({ revision: 0, page: null, caller });
    expect(Number(await one.command('TTL', key))).toBeGreaterThan(55);
    const results = await Promise.all([first.compareAndSet(callId, 0, page), second.compareAndSet(callId, 0, { ...page, presenter: { userId: 'bob', displayName: 'Bob' } })]);
    expect(results.filter(r => r.applied)).toHaveLength(1);
    expect(results.map(r => r.state.revision)).toEqual([1, 1]);
    const winner = results.find(r => r.applied)!.state;
    expect(await first.get(callId)).toEqual(winner); expect(await second.get(callId)).toEqual(winner);
    expect(await second.compareAndSet(callId, 1, null)).toEqual({ applied: true, state: { revision: 2, page: null, caller } });
    await one.command('EXPIRE', key, 1); // Simulate a nearly expired idle call.
    expect(await first.get(callId)).toEqual({ revision: 2, page: null, caller });
    expect(Number(await one.command('TTL', key))).toBeGreaterThan(55);
    expect(await second.compareAndSet(callId, 1, page)).toEqual({ applied: false, state: { revision: 2, page: null, caller } });
    expect((await second.claimCaller(callId, { userId: 'someone-else', provenance: 'forged' })).caller).toEqual(caller);
    expect(await first.compareAndSet(callId, 2, page)).toMatchObject({ applied: true, state: { revision: 3, page } });
    await first.forget(callId); expect(await second.get(callId)).toEqual({ revision: 0, page: null });
  } finally { await one.del(key).catch(() => undefined); await Promise.allSettled([one.quit(), two.quit()]); }
});
