jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [] }));
import http from 'node:http';
import { realtimeGatewayRouting, realtimeFanoutRequested } from '../gateway/env.js';
import { attachRealtimeGateway, startRealtimeGateway } from '../realtime-gateway.js';

const keys = ['REALTIME_GATEWAY_ROUTER', 'REALTIME_FANOUT', 'REDIS_URL'] as const;
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
