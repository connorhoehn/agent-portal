// Main's socket fan-out contract migrated to the native leased router.
// Dedicated opt-in Redis + real WS servers, with explicit fixture authority.
// Without GATEWAY_FANOUT_REDIS_URL only the unchanged local default runs.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [{ id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] }] }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { RedisRealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { GatewayRedis } from '../gateway-redis.js';
import { createMemorySocialChatBackend, type SocialChatBackend } from '../social-chat.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';

const SECRET = 'test-realtime-secret';
const GENERAL = 'social:ch:general';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

const redisUrl = process.env['GATEWAY_FANOUT_REDIS_URL'];
if (redisUrl && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(redisUrl).hostname)) {
  throw new Error('GATEWAY_FANOUT_REDIS_URL must name a dedicated loopback test Redis');
}
const clusterCase = redisUrl ? it : it.skip;
let namespace: string, users: Map<string, UserInfo>, backend: SocialChatBackend;

interface Gateway { server: http.Server; port: number; dispose: () => Promise<void>; messages: SocialChatBackend['chatStore'] }

async function gateway(sharedRedis: string | null, nodeId = randomUUID()): Promise<Gateway> {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  // Distinct node ids are mandatory: a shared id makes each replica discard the
  // other's frames as its own echo, and fan-out silently delivers nothing.
  let redis: GatewayRedis | undefined, router: RedisRealtimeRouter | undefined;
  if (sharedRedis) { redis = new GatewayRedis(sharedRedis); await redis.open(); }
  // A channel row alone cannot authorize a Work-only identity. Include that
  // row in the negative fixture so the native router's tenant/grant fence is
  // exercised rather than stopping early at ChatService's membership gate.
  for (const userId of ['u-sana', 'u-mira', 'u-theo']) await backend.membershipStore.putMember({ channel: GENERAL, userId, role: 'member', addedBy: userId,
    addedAt: new Date().toISOString(), historyFrom: null, removedAt: null });
  const handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, statsIntervalMs: 0,
    socialChat: backend,
    ...(redis ? { redisClient: redis, routerFactory: hooks => {
      router = new RedisRealtimeRouter({ ...hooks, namespace, nodeId, redis: redis!.cluster, leaseMs: 10000, requestTimeoutMs: 3000 });
      return router;
    } } : {}),
  });
  try { await router?.start(); } catch (error) { await handle.dispose(); throw error; }
  const { dispose } = handle;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, dispose, messages: backend.chatStore };
}

const sockets: WebSocket[] = [];

async function connectAs(port: number, sub: string, name: string): Promise<Open> {
  const session = {
    sub, name, role: 'participant', tenant: 'social',
    grants: { social: ['participant'] }, epoch: 0, iat: Math.floor(Date.now() / 1000),
  } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some((f) => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
        else if (Date.now() - start > 3_000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const chatIn = (o: Open, channel: string) => o.frames
  .filter((f) => f.type === 'chat' && f.action === 'message' && (f['message'] as { channel?: string } | undefined)?.channel === channel)
  .map((f) => (f['message'] as { message: string }).message);

const prevSecret = process.env['REALTIME_JWT_SECRET'];
beforeEach(() => {
  namespace = `gateway-fanout-test-${randomUUID()}`;
  backend = createMemorySocialChatBackend({ fixtures: false });
  users = new Map(['u-sana', 'u-mira'].map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 0, grants: { social: ['participant'] } }]));
  users.set('u-theo', { id: 'u-theo', displayName: 'Fixture Work reader', email: null, personId: null, epoch: 0, grants: { orgiq: ['member'] } });
  jest.mocked(getUser).mockImplementation(async id => users.has(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async principal => principal.tenant === 'social' && principal.role === 'participant');
});
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
});
afterAll(() => {
  for (const ws of sockets) ws.terminate();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

describe('native peer delivery through attachRealtimeGateway', () => {
  clusterCase('delivers exactly once between users whose sockets are on different leased gateways', async () => {
    const bus = redisUrl!;
    const a = await gateway(bus);
    const b = await gateway(bus);
    try {
      const sana = await connectAs(a.port, 'u-sana', 'Sana');
      const mira = await connectAs(b.port, 'u-mira', 'Mira');
      send(sana, { service: 'chat', action: 'join', channel: GENERAL });
      send(mira, { service: 'chat', action: 'join', channel: GENERAL });
      await new Promise((r) => setTimeout(r, 250));

      send(sana, { service: 'chat', action: 'send', channel: GENERAL, message: 'across the fleet' });

      // The whole point: a socket on the OTHER gateway receives it.
      await until(() => chatIn(mira, GENERAL).includes('across the fleet'));
      expect(chatIn(mira, GENERAL)).toContain('across the fleet');
      // And exactly once — a frame must not be delivered per replica.
      expect(chatIn(mira, GENERAL).filter((m) => m === 'across the fleet')).toHaveLength(1);
    } finally {
      await a.dispose(); await b.dispose();
      await new Promise<void>((r) => a.server.close(() => r()));
      await new Promise<void>((r) => b.server.close(() => r()));
    }
  }, 20_000);

  clusterCase('still refuses a cross-tenant subscribe on the native leased path', async () => {
    // Fan-out must not become a way around the router's authz: the orgiq token
    // is refused on a social channel exactly as it is on one task.
    const bus = redisUrl!;
    const a = await gateway(bus);
    try {
      const session = {
        sub: 'u-theo', name: 'Theo', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, epoch: 0, iat: Math.floor(Date.now() / 1000),
      } as Session;
      const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
      sockets.push(ws);
      const frames: Frame[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Frame));
      await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
      // Native leased registration is asynchronous: an open TCP/WebSocket is
      // not the gateway's accepted-session receipt.
      await until(() => frames.some(frame => frame.type === 'session'));
      ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: GENERAL }));
      await until(() => frames.some((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED'));
      expect(frames.some((f) => f.code === 'AUTHZ_CHANNEL_DENIED')).toBe(true);
      expect(frames.some(frame => frame.action === 'joined' || frame.action === 'history')).toBe(false);
    } finally {
      await a.dispose();
      await new Promise<void>((r) => a.server.close(() => r()));
    }
  }, 20_000);

  clusterCase('reauthorizes peer recipients after grant removal without dropping the authorized stored message', async () => {
    const a = await gateway(redisUrl!), b = await gateway(redisUrl!);
    try {
      const sana = await connectAs(a.port, 'u-sana', 'Sana'), mira = await connectAs(b.port, 'u-mira', 'Mira');
      send(sana, { service: 'chat', action: 'join', channel: GENERAL }); send(mira, { service: 'chat', action: 'join', channel: GENERAL });
      await until(() => sana.frames.some(frame => frame.action === 'joined') && mira.frames.some(frame => frame.action === 'joined'));
      users.get('u-mira')!.grants.social = [];
      send(sana, { service: 'chat', action: 'send', channel: GENERAL, message: 'Stored after recipient removal' });
      await until(() => sana.frames.some(frame => frame.action === 'sent'));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(chatIn(mira, GENERAL)).not.toContain('Stored after recipient removal');
      expect((await a.messages.listMessages(GENERAL, 20)).map(row => row.message)).toContain('Stored after recipient removal');
      send(mira, { service: 'chat', action: 'history', channel: GENERAL });
      await until(() => mira.frames.some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
      expect(mira.frames.some(frame => frame.action === 'history')).toBe(false);
    } finally {
      await a.dispose(); await b.dispose();
      await new Promise<void>(resolve => a.server.close(() => resolve())); await new Promise<void>(resolve => b.server.close(() => resolve()));
    }
  }, 20_000);

  it('without fan-out, two gateways are two islands — the default, and the bug this replaces', async () => {
    const a = await gateway(null);
    const b = await gateway(null);
    try {
      const sana = await connectAs(a.port, 'u-sana', 'Sana');
      const mira = await connectAs(b.port, 'u-mira', 'Mira');
      send(sana, { service: 'chat', action: 'join', channel: GENERAL });
      send(mira, { service: 'chat', action: 'join', channel: GENERAL });
      await new Promise((r) => setTimeout(r, 250));

      send(sana, { service: 'chat', action: 'send', channel: GENERAL, message: 'island' });
      await until(() => chatIn(sana, GENERAL).includes('island'));

      // Nothing errored and nothing was refused. Theo is simply in a different
      // conversation — which is why this had to be caught by a test and not by
      // an alarm.
      await new Promise((r) => setTimeout(r, 300));
      expect(chatIn(mira, GENERAL)).not.toContain('island');
      expect(mira.frames.some((f) => f.type === 'error')).toBe(false);
    } finally {
      await a.dispose(); await b.dispose();
      await new Promise<void>((r) => a.server.close(() => r()));
      await new Promise<void>((r) => b.server.close(() => r()));
    }
  }, 20_000);
});
