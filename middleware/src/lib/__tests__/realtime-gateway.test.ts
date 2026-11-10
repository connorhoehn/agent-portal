// lib/realtime-gateway.ts — the middleware's own chat/presence/calls gateway
// on /ws, over a real http.Server and raw `ws` clients carrying real realtime
// tokens (lib/realtime-token.ts). Pinned:
//   - a valid token on `bearer-token-v1, <jwt>` is accepted, the server
//     echoes the marker subprotocol, and the library's `{type:'session',
//     status:'connected'}` frame arrives;
//   - no token, a token signed with another secret, an expired token, a token
//     with another audience, and a bare-token subprotocol are all refused 401;
//   - a browser Origin outside the allowlist is refused 403 (realtime-modules 0.147.0);
//   - lobbyGuard: an orgiq caller may invite into `orgiq:dm:<self>:<other>`
//     (the other side rings) but not `assessment:dm:…`, not an orgiq dm it is
//     not part of, and not an untargeted broadcast — each refusal is an error
//     frame to the sender and nothing reaches anyone else;
//   - rejectUnsupportedUpgrades still answers every other path 404.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
// Jest's CJS transform cannot evaluate role-registry's import.meta URL. Keep
// the same Social seed capabilities while exercising the attached runtime.
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
  { id: 'moderator', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
  { id: 'community-admin', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
] }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { SignJWT } from 'jose';
import {
  attachRealtimeGateway, channelGuard, gatewayStatsLine, type GatewayStatsInput, GATEWAY_STATS_TYPE, lobbyGuard, realtimeGatewayEnabled,
  realtimeGatewayStatus, REALTIME_GATEWAY_PATH, statsIntervalMs,
} from '../realtime-gateway.js';
import { authenticateGatewayUpgrade, gatewayOriginAllowed } from '../gateway/auth.js';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';
import { signRealtimeToken, realtimeClaims, REALTIME_TOKEN_ISSUER, REALTIME_TOKEN_KIND } from '../realtime-token.js';
import type { Session } from '../session.js';
import { getUser } from '../../providers/identity.js';

const SECRET = 'test-realtime-secret';
type Frame = Record<string, unknown> & { type?: string };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 });
  dispose = handle.dispose;
  rejectUnsupportedUpgrades(server, { allowPaths: ['/realtime', REALTIME_GATEWAY_PATH] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

function session(sub: string, name: string, tenant = 'orgiq'): Session {
  return { sub, name, role: 'member', tenant, grants: { [tenant]: ['member'] }, iat: Math.floor(Date.now() / 1000) } as Session;
}

async function tokenFor(sub: string, name: string, tenant = 'orgiq'): Promise<string> {
  const user = await getUser(sub, { authoritative: true });
  const current = { ...session(sub, name, tenant), role: user?.grants[tenant]?.[0] ?? 'member', epoch: user?.epoch ?? 0 } as Session;
  return (await signRealtimeToken(realtimeClaims(current), SECRET)).token;
}

type Open = { ws: WebSocket; frames: Frame[] };
function connect(opts: { path?: string; protocols?: string[]; origin?: string; headers?: Record<string, string> } = {}): Promise<Open | { refused: number }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.origin) headers['origin'] = opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? REALTIME_GATEWAY_PATH}`, opts.protocols ?? [], { headers });
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (_req, res) => { resolve({ refused: res.statusCode ?? 0 }); ws.terminate(); });
    ws.on('error', () => { /* surfaced through unexpected-response */ });
  });
}

async function connectAs(sub: string, name: string, tenant = 'orgiq'): Promise<Open> {
  const r = await connect({ protocols: ['bearer-token-v1', await tokenFor(sub, name, tenant)] });
  if ('refused' in r) throw new Error(`refused ${r.refused}`);
  await until(() => r.frames.some((f) => f.type === 'session'));
  return r;
}

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('handshake', () => {
  it('closes an oversized signalling frame with 1009 before dispatch', async () => {
    const sender = await connectAs('u-vera', 'Vera Green');
    const peer = await connectAs('u-nora', 'Nora DaSilva');
    try {
      const closed = new Promise<number>((resolve) => sender.ws.once('close', resolve));
      sender.ws.send(JSON.stringify({
        type: 'call', action: 'invite',
        data: {
          callId: 'oversized-invite', lobbyName: 'orgiq:dm:u-nora:u-vera',
          callerId: 'u-vera', targetUserIds: ['u-nora'], padding: 'x'.repeat(256 * 1024),
        },
      }));
      expect(await closed).toBe(1009);
      await settle();
      expect(peer.frames.some((f) => f.type === 'call')).toBe(false);
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    } finally { sender.ws.close(); peer.ws.close(); }
  });

  it('accepts a valid realtime token, echoes the marker subprotocol and sends the session frame', async () => {
    const r = await connect({ protocols: ['bearer-token-v1', await tokenFor('u-vera', 'Vera Green')], origin: 'http://localhost:5184' });
    if ('refused' in r) throw new Error(`refused ${r.refused}`);
    try {
      expect(r.ws.protocol).toBe('bearer-token-v1');
      await until(() => r.frames.some((f) => f.type === 'session'));
      expect(r.frames.find((f) => f.type === 'session')).toMatchObject({ type: 'session', status: 'connected', clientId: expect.any(String) });
      expect(realtimeGatewayStatus()).toEqual({ gateway: 'on', store: 'memory', chatStore: 'memory' });
    } finally { r.ws.close(); }
  });

  it('refuses no token, a foreign signature, an expired or wrong-audience token, and a bare token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = realtimeClaims(session('u-vera', 'Vera Green'));
    const forged = (await signRealtimeToken(claims, 'not-the-secret')).token;
    const expired = (await signRealtimeToken(claims, SECRET, now - 3600)).token;
    const wrongAud = await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256' }).setSubject('u-vera')
      .setIssuedAt(now).setExpirationTime(now + 600).setIssuer(REALTIME_TOKEN_ISSUER).setAudience('someone-else')
      .sign(new TextEncoder().encode(SECRET));
    const notOurs = await new SignJWT({ sub: 'u-vera', org: 'orgiq', tokenKind: 'cognito' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now).setExpirationTime(now + 600).setIssuer(REALTIME_TOKEN_ISSUER).setAudience('realtime')
      .sign(new TextEncoder().encode(SECRET));
    expect(claims.tokenKind).toBe(REALTIME_TOKEN_KIND);
    const valid = await tokenFor('u-vera', 'Vera Green');
    for (const protocols of [[], ['bearer-token-v1', forged], ['bearer-token-v1', expired], ['bearer-token-v1', wrongAud], ['bearer-token-v1', notOurs], [valid]]) {
      expect(await connect({ protocols })).toEqual({ refused: 401 });
    }
  });

  // realtime-modules 0.147.0: the socket handler's `allowedOrigins` (the same
  // rule as the bearer admission) answers first, with 403.
  it('refuses a cross-site browser origin even with a valid token', async () => {
    const token = await tokenFor('u-vera', 'Vera Green');
    expect(await connect({ protocols: ['bearer-token-v1', token], origin: 'https://attacker.example' }))
      .toEqual({ refused: 403 });
    // The bearer admission keeps its own copy of the rule (401 if reached).
    const upgrade = (origin: string) => ({ headers: { origin, host: `127.0.0.1:${port}`, 'sec-websocket-protocol': `bearer-token-v1, ${token}` },
      socket: {} }) as unknown as http.IncomingMessage;
    await expect(authenticateGatewayUpgrade(upgrade('https://attacker.example'))).rejects.toThrow(/origin/i);
    await expect(authenticateGatewayUpgrade(upgrade(`http://127.0.0.1:${port}`))).resolves.toMatchObject({ userId: 'u-vera' });
    expect(gatewayOriginAllowed('https://attacker.example', upgrade('https://attacker.example'))).toBe(false);
    expect(gatewayOriginAllowed(`http://127.0.0.1:${port}`, upgrade(`http://127.0.0.1:${port}`))).toBe(true);
  });

  describe('behind CloudFront → ALB (TRUST_PROXY_HOPS=2)', () => {
    // The portal and /ws share the CloudFront origin, but the socket the
    // middleware sees is plain TCP from the ALB, so the same-origin test used
    // to compare https://<cf> against http://<cf> and refuse the portal's own
    // socket (unless PUBLIC_BASE_URL happened to list it).
    const prior = process.env['TRUST_PROXY_HOPS'];
    afterEach(() => { if (prior === undefined) delete process.env['TRUST_PROXY_HOPS']; else process.env['TRUST_PROXY_HOPS'] = prior; });
    const viaCloudFront = { host: 'd111.cloudfront.net', 'x-forwarded-proto': 'http', 'cloudfront-forwarded-proto': 'https' };

    it('admits the https:// portal page as same-origin', async () => {
      process.env['TRUST_PROXY_HOPS'] = '2';
      const r = await connect({ protocols: ['bearer-token-v1', await tokenFor('u-vera', 'Vera Green')], origin: 'https://d111.cloudfront.net', headers: viaCloudFront });
      if ('refused' in r) throw new Error(`refused ${r.refused}`);
      r.ws.close();
    });

    it('does not take the CloudFront header from a caller when no proxy is declared', async () => {
      delete process.env['TRUST_PROXY_HOPS'];
      expect(await connect({ protocols: ['bearer-token-v1', await tokenFor('u-vera', 'Vera Green')], origin: 'https://d111.cloudfront.net', headers: viaCloudFront }))
        .toEqual({ refused: 403 });
    });
  });

  it('leaves every other upgrade path to rejectUnsupportedUpgrades (404)', async () => {
    const token = await tokenFor('u-vera', 'Vera Green');
    expect(await connect({ path: '/socket', protocols: ['bearer-token-v1', token] })).toEqual({ refused: 404 });
    expect(await connect({ path: '/wsx', protocols: ['bearer-token-v1', token] })).toEqual({ refused: 404 });
  });
});

describe('channelGuard (pure) — chat and presence channels are tenant-scoped like lobbies', () => {
  const theo = { userId: 'u-theo', org: 'orgiq' };
  it.each([
    ['orgiq:invoke', true],
    ['orgiq:session:abc', true],
    ['orgiq:dm:u-theo:u-vera', true],
    ['orgiq:dm:u-vera:u-nora', false],
    ['assessment:doc:page:100002', false],
    ['assessment:knowledge:confluence', false],
    ['invoke', false],
    ['', false],
    // The library's services subscribe under their own prefix (defect #9).
    ['presence:orgiq:invoke', true],
    ['presence:assessment:knowledge:confluence-eng', false],
    ['reactions:orgiq:session:abc', true],
    // Default deny (2026-10-05): a family lib/tenant-channels.ts does not list.
    ['cursor:orgiq:doc:1', false],
    ['orgiq:anything', false],
    ['presence:orgiq:lobby', true],
    ['orgiq:lobby', false],
    ['chat:orgiq:lobby', false],
    ['orgiq:initiative:p-soc2', true],
    ['chat:orgiq:dm:u-theo:u-vera', true],
    ['chat:orgiq:dm:u-vera:u-nora', false],
    // Huddle chat: shape only (chat or reactions on the exact name); the
    // call-seat authority is live-principal's authorizeHuddleChannel.
    ['orgiq:huddle', false],
    ['orgiq:huddle:call-id', true],
    ['reactions:orgiq:huddle:call-id', true],
    ['presence:orgiq:huddle:call-id', false],
    ['cursor:orgiq:huddle:call-id', false],
    ['chat:orgiq:huddle:call-id', false],
    ['presence:', false],
    ['presence:orgiq', false],
  ])('%s → %s', (channel, ok) => expect(channelGuard(theo, channel)).toBe(ok));
  it('admits the huddle chat shape for supported tenants, never as a call lobby', () => {
    expect(channelGuard(theo, 'orgiq:huddle:call-id', 'publish')).toBe(true);
    expect(channelGuard({ ...theo, org: 'social', tenants: ['social'] }, 'orgiq:huddle:call-id')).toBe(true);
    expect(channelGuard({ ...theo, org: 'pipelines', tenants: ['pipelines'] }, 'orgiq:huddle:call-id')).toBe(false);
    expect(channelGuard({ ...theo, userId: '' }, 'orgiq:huddle:call-id')).toBe(false);
    expect(lobbyGuard(theo, 'orgiq:huddle:call-id')).toBe(false);
  });
  it('refuses a socket with no auth context', () => {
    expect(channelGuard(null, 'orgiq:invoke')).toBe(false);
  });
});

describe('lobbyGuard (pure)', () => {
  const vera = { userId: 'u-vera', org: 'orgiq' };
  it.each([
    ['orgiq:dm:u-nora:u-vera', true],
    ['orgiq:initiative:p-auth-migration', true],
    ['assessment:dm:u-nora:u-vera', false],
    ['orgiq:dm:u-nora:u-theo', false],
    ['orgiq:invoke', false],
    ['orgiq:work:wi-1', false],
    ['orgiq:room:x', false],
    ['orgiq:', false],
    ['orgiqx:dm:u-vera', false],
    ['dm:u-nora:u-vera', false],
  ])('%s → %s', (lobby, ok) => expect(lobbyGuard(vera, lobby)).toBe(ok));
  it('refuses a context without org or userId', () => {
    expect(lobbyGuard({ userId: 'u-vera' }, 'orgiq:dm:u-vera')).toBe(false);
    expect(lobbyGuard({ org: 'orgiq' }, 'orgiq:dm:u-vera')).toBe(false);
  });
});

describe('calls over the socket', () => {
  let vera: Open;
  let nora: Open;
  let warn: jest.SpyInstance;
  beforeEach(async () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    vera = await connectAs('u-vera', 'Vera Green');
    nora = await connectAs('u-nora', 'Nora DaSilva');
  });
  afterEach(() => { vera.ws.close(); nora.ws.close(); warn.mockRestore(); });

  const invite = (lobbyName: string, callId: string, targetUserIds: string[] = ['u-nora']) => JSON.stringify({
    service: 'call', action: 'invite', callId, lobbyName, callerId: 'u-vera', callerName: 'Vera Green', targetUserIds,
  });
  const callFrames = (o: Open, callId: string) => o.frames.filter((f) => f.type === 'call' && (f['data'] as Frame | undefined)?.['callId'] === callId);
  const errors = (o: Open) => o.frames.filter((f) => f.type === 'error');

  it('rings the target for orgiq:dm:<self>:<other>', async () => {
    vera.ws.send(invite('orgiq:dm:u-nora:u-vera', 'call-ok'));
    await until(() => callFrames(nora, 'call-ok').length > 0);
    expect(callFrames(nora, 'call-ok')[0]).toMatchObject({ type: 'call', action: 'invite', data: { lobbyName: 'orgiq:dm:u-nora:u-vera', callerId: 'u-vera' } });
    expect(errors(vera)).toEqual([]);
  });

  it.each(['flat', 'nested'])('refuses a %s invite that assigns caller ownership to another authenticated user', async shape => {
    const callId = `call-spoof-${shape}`;
    const payload = { callId, lobbyName: 'orgiq:dm:u-nora:u-vera', callerId: 'u-nora', targetUserIds: ['u-nora'] };
    vera.ws.send(JSON.stringify({ service: 'call', action: 'invite', ...(shape === 'flat' ? payload : { data: payload }) }));
    await until(() => errors(vera).length > 0); await settle();
    expect(errors(vera)[0]).toMatchObject({ type: 'error', service: 'call', message: expect.stringContaining('Not authorized') });
    expect(callFrames(nora, callId)).toEqual([]);
  });

  it('refuses an assessment: lobby for an orgiq caller — error to the sender, nothing to the target', async () => {
    vera.ws.send(invite('assessment:dm:u-nora:u-vera', 'call-cross'));
    await until(() => errors(vera).length > 0);
    await settle();
    expect(errors(vera)[0]).toMatchObject({ type: 'error', service: 'call', message: expect.stringContaining('Not authorized') });
    expect(callFrames(nora, 'call-cross')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refused lobby 'assessment:dm:u-nora:u-vera'"));
  });

  it('refuses the same frame nested under data (the library accepts both envelopes)', async () => {
    vera.ws.send(JSON.stringify({ service: 'call', action: 'invite', data: { callId: 'call-nested', lobbyName: 'assessment:dm:u-nora:u-vera', callerId: 'u-vera', targetUserIds: ['u-nora'] } }));
    await until(() => errors(vera).length > 0);
    await settle();
    expect(callFrames(nora, 'call-nested')).toEqual([]);
  });

  it('refuses an orgiq dm the caller is not part of', async () => {
    vera.ws.send(invite('orgiq:dm:u-nora:u-theo', 'call-notmine'));
    await until(() => errors(vera).length > 0);
    await settle();
    expect(callFrames(nora, 'call-notmine')).toEqual([]);
  });

  it('refuses an untargeted (broadcast) invite', async () => {
    vera.ws.send(invite('orgiq:initiative:p-auth-migration', 'call-bcast', []));
    await until(() => errors(vera).length > 0);
    await settle();
    expect(callFrames(nora, 'call-bcast')).toEqual([]);
  });

  it('refuses an orgiq lobby for an assessment caller', async () => {
    const ada = await connectAs('u-asha', 'Asha Nair', 'assessment');
    try {
      ada.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId: 'call-rev', lobbyName: 'orgiq:dm:u-asha:u-nora', callerId: 'u-asha', targetUserIds: ['u-nora'] }));
      await until(() => errors(ada).length > 0);
      await settle();
      expect(callFrames(nora, 'call-rev')).toEqual([]);
    } finally { ada.ws.close(); }
  });
});

describe('REALTIME_GATEWAY', () => {
  it('defaults on outside production and off in production; on/off override both', () => {
    expect(realtimeGatewayEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(realtimeGatewayEnabled({})).toBe(true);
    expect(realtimeGatewayEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(realtimeGatewayEnabled({ NODE_ENV: 'production', REALTIME_GATEWAY: 'on' })).toBe(true);
    expect(realtimeGatewayEnabled({ NODE_ENV: 'development', REALTIME_GATEWAY: 'off' })).toBe(false);
  });
});

describe('the load line (capacity review #9)', () => {
  it('is one JSON object with the fields the infra metric filters read', () => {
    // The reading is the library's handle.stats() (0.119); the line adds its type and the store.
    const line = JSON.parse(gatewayStatsLine({
      sockets: 1000, activeCalls: 100, eventLoopDelayP99Ms: 12.35, eventLoopDelayMaxMs: 98, rssMb: 300, ts: '2026-10-01T00:00:00.000Z', store: 'redis',
    } as GatewayStatsInput)); // the library's other readings (0.120 queue depth, inbound) ride along unchanged
    expect(line).toEqual({
      type: GATEWAY_STATS_TYPE, sockets: 1000, activeCalls: 100, eventLoopDelayP99Ms: 12.35, eventLoopDelayMaxMs: 98,
      rssMb: 300, store: 'redis', ts: '2026-10-01T00:00:00.000Z',
    });
    // The infra filter and this line must agree on the names.
    expect(GATEWAY_STATS_TYPE).toBe('realtime-gateway-stats');
  });

  it('defaults to once a minute; REALTIME_STATS_INTERVAL_MS=0 turns it off', () => {
    expect(statsIntervalMs({})).toBe(60_000);
    expect(statsIntervalMs({ REALTIME_STATS_INTERVAL_MS: '0' })).toBe(0);
    expect(statsIntervalMs({ REALTIME_STATS_INTERVAL_MS: 'nope' })).toBe(60_000);
  });

  it('is emitted by a live gateway with real counts', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
    const s2 = http.createServer();
    const h = attachRealtimeGateway(s2, { redisUrl: null, pingIntervalMs: 0, statsIntervalMs: 40 });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const stats = lines.filter((l) => l.includes(GATEWAY_STATS_TYPE)).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0]).toMatchObject({ type: GATEWAY_STATS_TYPE, sockets: 0, activeCalls: 0, store: 'memory' });
      expect(typeof stats[0]!['eventLoopDelayP99Ms']).toBe('number');
    } finally {
      await h.dispose();
      spy.mockRestore();
    }
  });
});
