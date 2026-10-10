// Opt in with CALL_CHAT_TEST_REDIS_URL. These tests execute real Redis Lua.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
import { RedisLite } from '../redis-lite.js';
import { RedisCallChatStateStore } from '../call-chat-state.js';
const url = process.env['CALL_CHAT_TEST_REDIS_URL']; const testRedis = url ? it : it.skip;
testRedis('real Redis retains join floors, reconnect boundaries, TTL and terminal closure across two instances', async () => {
  const one = new RedisLite(url!); const two = new RedisLite(url!);
  const first = new RedisCallChatStateStore(one, 60); const second = new RedisCallChatStateStore(two, 60);
  const callId = `chat-test-${process.pid}-${Date.now()}`; const key = `orgiq:call-chat:${callId}`;
  try {
    await first.join(callId, 'alice', '2026-10-06T00:00:00.000Z', false);
    await second.join(callId, 'bob', '2026-10-06T00:00:01.000Z', false);
    expect((await first.get(callId)).members).toEqual({ alice: { historyFrom: '2026-10-06T00:00:00.000Z', active: true },
      bob: { historyFrom: '2026-10-06T00:00:01.000Z', active: true } });
    await first.leave(callId, 'bob');
    // Resume keeps the boundary; explicit admission replaces it.
    expect((await second.join(callId, 'bob', '2026-10-06T00:00:05.000Z', true)).members.bob?.historyFrom).toBe('2026-10-06T00:00:01.000Z');
    await first.leave(callId, 'bob');
    expect((await second.join(callId, 'bob', '2026-10-06T00:00:09.000Z', false)).members.bob?.historyFrom).toBe('2026-10-06T00:00:09.000Z');
    expect(Number(await one.command('TTL', key))).toBeGreaterThan(0);
    await first.keepAlive(callId);
    const terminal = await second.finish(callId);
    expect(terminal).toMatchObject({ ended: true, members: {} });
    await expect(first.join(callId, 'carol', '2026-10-06T00:00:10.000Z', false)).rejects.toMatchObject({ status: 404 });
  } finally { await one.command('DEL', key); await one.quit(); await two.quit(); }
});
