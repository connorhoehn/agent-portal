jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [] }));
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createBoundedRedis, LeaseGroup, LocalRealtimeRouter, RedisRealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { realtimeGatewayRouting, realtimeFanoutRequested } from '../gateway/env.js';
import { attachRealtimeGateway, startRealtimeGateway, realtimeGatewayStatus } from '../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../social-chat.js';

const keys = ['REALTIME_GATEWAY_ROUTER', 'REALTIME_FANOUT', 'REDIS_URL', 'REDIS_COMMAND_TIMEOUT_MS',
  'REALTIME_GATEWAY_NAMESPACE', 'REALTIME_GATEWAY_NODE_ID'] as const;
let before: Record<string, string | undefined>;
beforeEach(() => { before = Object.fromEntries(keys.map(key => [key, process.env[key]])); keys.forEach(key => delete process.env[key]); });
afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
it('defaults to local regardless of Redis URL, and preserves legacy explicit opt-in', () => {
  expect(realtimeGatewayRouting({ REDIS_URL: 'redis://owned.test:6379' })).toBe('local');
  expect(realtimeGatewayRouting({ REALTIME_FANOUT: ' Redis ' })).toBe('redis');
  expect(realtimeFanoutRequested({ REALTIME_FANOUT: 'redis' })).toBe(true);
  for (const value of ['', 'off', 'local']) expect(realtimeGatewayRouting({ REALTIME_FANOUT: value })).toBe('local');
});
it('canonical router setting wins explicitly, and unknown settings fail before startup', () => {
  expect(realtimeGatewayRouting({ REALTIME_GATEWAY_ROUTER: 'local', REALTIME_FANOUT: 'redis' })).toBe('local');
  expect(realtimeGatewayRouting({ REALTIME_GATEWAY_ROUTER: ' redis ', REALTIME_FANOUT: 'off' })).toBe('redis');
  for (const env of [{ REALTIME_GATEWAY_ROUTER: 'unknown' }, { REALTIME_FANOUT: 'unknown' }]) expect(() => realtimeGatewayRouting(env)).toThrow(/REALTIME_/);
});
it.each(['REALTIME_GATEWAY_ROUTER', 'REALTIME_FANOUT'])('the native transport rejects missing Redis for %s instead of silently becoming local', async key => {
  process.env[key] = 'redis';
  const server = http.createServer();
  await expect(startRealtimeGateway(server, { redisUrl: null })).rejects.toThrow('requires REDIS_URL');
  expect(server.listenerCount('upgrade')).toBe(0);
});
it('synchronous attachment cannot silently ignore a leased Redis opt-in', () => {
  process.env.REALTIME_FANOUT = 'redis';
  const server = http.createServer();
  expect(() => attachRealtimeGateway(server)).toThrow('awaited startRealtimeGateway');
  expect(server.listenerCount('upgrade')).toBe(0);
});

it('local routing still awaits configured Redis storage and fails before accepting upgrades', async () => {
  const server = http.createServer();
  const redisUrl = 'redis://127.0.0.1:1';
  process.env.REDIS_COMMAND_TIMEOUT_MS = '100';
  expect(() => attachRealtimeGateway(server, { redisUrl })).toThrow('awaited startRealtimeGateway');
  await expect(startRealtimeGateway(server, { redisUrl })).rejects.toThrow();
  expect(server.listenerCount('upgrade')).toBe(0);
});

const redisUrl = process.env['GATEWAY_FANOUT_REDIS_URL'];
const testRedis = redisUrl ? it : it.skip;
testRedis('local routing opens and closes the library Redis transport for its stores', async () => {
  const handle = await startRealtimeGateway(http.createServer(), { redisUrl, pingIntervalMs: 0, statsIntervalMs: 0,
    socialChat: createMemorySocialChatBackend({ fixtures: false }) });
  try {
    expect(handle.router).toBeInstanceOf(LocalRealtimeRouter);
    expect(handle.store).toBe('redis');
    expect(await handle.redis!.ping()).toBe('PONG');
  } finally { await handle.dispose(); }
  await expect(handle.redis!.ping()).rejects.toThrow();
});

// The stalled-Redis regression that previously required an application polling
// loop: a fenced gateway must retire its healthy sibling immediately.
testRedis('the gateway joins the host LeaseGroup and connection loss retires its sibling router', async () => {
  const namespace = `gateway-ownership-${randomUUID()}`;
  process.env.REALTIME_GATEWAY_ROUTER = 'redis';
  process.env.REALTIME_GATEWAY_NAMESPACE = namespace;
  process.env.REALTIME_GATEWAY_NODE_ID = 'primary';
  const group = new LeaseGroup();
  const redis = await createBoundedRedis(redisUrl!);
  // Ownership only: the sibling admits no channel (realtime-modules 0.147.0 requires a hook).
  const sibling = new RedisRealtimeRouter({ redis, namespace, nodeId: 'sibling', leaseGroup: group, authorize: () => false });
  const handle = await startRealtimeGateway(http.createServer(), { redisUrl, leaseGroup: group,
    pingIntervalMs: 0, statsIntervalMs: 0, socialChat: createMemorySocialChatBackend({ fixtures: false }) });
  try {
    await sibling.start();
    expect(group.isLive()).toBe(true);
    expect(realtimeGatewayStatus().ready).toBe(true);
    const clientId = Number(await handle.redis!.command('CLIENT', 'ID'));
    await redis.command('CLIENT', 'KILL', 'ID', clientId);
    const deadline = Date.now() + 2000;
    while (!group.retired && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(group.retired).not.toBeNull();
    await group.retired;
    expect(realtimeGatewayStatus().ready).toBe(false);
    expect(sibling.isReady()).toBe(false);
    expect(await redis.command('GET', `realtime:${encodeURIComponent(namespace)}:node:sibling`)).toBeNull();
    const late = new RedisRealtimeRouter({ redis, namespace, nodeId: 'late', leaseGroup: group, authorize: () => false });
    try { await expect(late.start()).rejects.toThrow(/lease|ownership/i); } finally { await late.shutdown(); }
  } finally {
    await group.release();
    await sibling.shutdown();
    await handle.dispose();
    await redis.quit();
  }
});
