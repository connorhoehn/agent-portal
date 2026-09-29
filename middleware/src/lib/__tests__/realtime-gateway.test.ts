// lib/realtime-gateway.ts — the middleware's own chat/presence/calls gateway
// on /ws, over a real http.Server and raw `ws` clients carrying real realtime
// tokens (lib/realtime-token.ts). Pinned:
//   - a valid token on `bearer-token-v1, <jwt>` is accepted, the server
//     echoes the marker subprotocol, and the library's `{type:'session',
//     status:'connected'}` frame arrives;
//   - no token, a token signed with another secret, an expired token, a token
//     with another audience, and a bare-token subprotocol are all refused 401;
//   - lobbyGuard: an orgiq caller may invite into `orgiq:dm:<self>:<other>`
//     (the other side rings) but not `assessment:dm:…`, not an orgiq dm it is
//     not part of, and not an untargeted broadcast — each refusal is an error
//     frame to the sender and nothing reaches anyone else;
//   - rejectUnsupportedUpgrades still answers every other path 404.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { SignJWT } from 'jose';
import { attachRealtimeGateway, channelGuard, lobbyGuard, realtimeGatewayEnabled, realtimeGatewayStatus, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';
import { signRealtimeToken, realtimeClaims, REALTIME_TOKEN_ISSUER, REALTIME_TOKEN_KIND } from '../realtime-token.js';
import type { Session } from '../session.js';

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
  return (await signRealtimeToken(realtimeClaims(session(sub, name, tenant)), SECRET)).token;
}

type Open = { ws: WebSocket; frames: Frame[] };
function connect(opts: { path?: string; protocols?: string[]; origin?: string } = {}): Promise<Open | { refused: number }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
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
  it('accepts a valid realtime token, echoes the marker subprotocol and sends the session frame', async () => {
    const r = await connect({ protocols: ['bearer-token-v1', await tokenFor('u-vera', 'Vera Green')], origin: 'http://localhost:5184' });
    if ('refused' in r) throw new Error(`refused ${r.refused}`);
    try {
      expect(r.ws.protocol).toBe('bearer-token-v1');
      await until(() => r.frames.some((f) => f.type === 'session'));
      expect(r.frames.find((f) => f.type === 'session')).toMatchObject({ type: 'session', status: 'connected', clientId: expect.any(String) });
      expect(realtimeGatewayStatus()).toEqual({ gateway: 'on', store: 'memory' });
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

  it('refuses a cross-site browser origin even with a valid token', async () => {
    expect(await connect({ protocols: ['bearer-token-v1', await tokenFor('u-vera', 'Vera Green')], origin: 'https://attacker.example' }))
      .toEqual({ refused: 401 });
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
    ['cursor:orgiq:doc:1', true],
    ['chat:orgiq:dm:u-theo:u-vera', true],
    ['chat:orgiq:dm:u-vera:u-nora', false],
    ['presence:', false],
    ['presence:orgiq', false],
  ])('%s → %s', (channel, ok) => expect(channelGuard(theo, channel)).toBe(ok));
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
    const ada = await connectAs('u-ada', 'Ada Assessor', 'assessment');
    try {
      ada.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId: 'call-rev', lobbyName: 'orgiq:dm:u-ada:u-nora', callerId: 'u-ada', targetUserIds: ['u-nora'] }));
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
