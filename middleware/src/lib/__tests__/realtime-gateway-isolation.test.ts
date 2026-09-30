// Tenant isolation on the realtime gateway (/ws), over a real http.Server and
// raw `ws` sockets carrying real realtime tokens — the same harness as
// realtime-gateway.test.ts, aimed at the chat/presence CHANNEL rule
// (channelGuard) rather than the handshake. Behaviour pinned against
// realtime-modules 0.98.7:
//   - an orgiq token cannot join, read history from, send to or read the
//     roster of an assessment channel, nor `set` presence into one: each
//     answers the sender `{type:'error', code:'AUTHZ_CHANNEL_DENIED'}` and
//     nothing reaches the assessment side;
//   - an assessment token's own join/send/history/presence succeed, and a
//     displayName forged in frame metadata is replaced by the token's;
//   - a `<org>:dm:` call lobby invite from someone who is not one of the ids
//     is refused, in both tenants, and never rings the target.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';

const SECRET = 'test-realtime-secret';
const DOC_CHANNEL = 'assessment:doc:page:100002';
const PRESENCE_CHANNEL = 'assessment:knowledge:confluence-eng';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 });
  dispose = handle.dispose;
  rejectUnsupportedUpgrades(server, { allowPaths: [REALTIME_GATEWAY_PATH] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

async function connectAs(sub: string, name: string, tenant: string): Promise<Open> {
  const session = { sub, name, role: 'member', tenant, grants: { [tenant]: ['member'] }, iat: Math.floor(Date.now() / 1000) } as Session;
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
        else if (Date.now() - start > 2_000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const denied = (o: Open) => o.frames.filter((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED');
const chatFrames = (o: Open) => o.frames.filter((f) => f.type === 'chat');
const messageTexts = (o: Open) => chatFrames(o).map((f) => JSON.stringify(f)).join('\n');

let theo: Open;
let farah: Open;
let jonas: Open;
beforeEach(async () => {
  theo = await connectAs('u-theo', 'Theo Orgiq', 'orgiq');
  farah = await connectAs('u-farah', 'Farah Assessor', 'assessment');
  jonas = await connectAs('u-jonas', 'Jonas Assessor', 'assessment');
});
afterEach(() => { for (const o of [theo, farah, jonas]) o.ws.close(); });

describe('an orgiq token against assessment channels', () => {
  it('cannot join, read history, send to, or list members of the document chat', async () => {
    send(farah, { service: 'chat', action: 'join', channel: DOC_CHANNEL });
    await settle();
    const before = farah.frames.length;

    for (const frame of [
      { service: 'chat', action: 'join', channel: DOC_CHANNEL },
      { service: 'chat', action: 'history', channel: DOC_CHANNEL, limit: 10 },
      { service: 'chat', action: 'send', channel: DOC_CHANNEL, message: 'orgiq intrusion' },
      { service: 'chat', action: 'members', channel: DOC_CHANNEL },
    ]) send(theo, frame);
    await until(() => denied(theo).length >= 4);

    expect(denied(theo).map((f) => f['kind']).sort()).toEqual(['publish', 'subscribe', 'subscribe', 'subscribe']);
    for (const f of denied(theo)) expect(f).toMatchObject({ service: 'chat', channel: DOC_CHANNEL });
    // No history came back to Theo and nothing was fanned out to the tenant's own member.
    expect(chatFrames(theo)).toEqual([]);
    await settle();
    expect(farah.frames.length).toBe(before);
    expect(messageTexts(farah)).not.toContain('orgiq intrusion');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`refused subscribe on channel '${DOC_CHANNEL}' for user 'u-theo' (org 'orgiq')`));
  });

  it('cannot subscribe to, or set presence into, an assessment presence channel', async () => {
    send(theo, { service: 'presence', action: 'subscribe', channel: PRESENCE_CHANNEL });
    send(theo, { service: 'presence', action: 'get', channel: PRESENCE_CHANNEL });
    send(theo, { service: 'presence', action: 'set', status: 'online', metadata: { displayName: 'Theo' }, channels: [PRESENCE_CHANNEL] });
    await until(() => denied(theo).length >= 3);
    expect(denied(theo).map((f) => f['channel'])).toEqual([PRESENCE_CHANNEL, PRESENCE_CHANNEL, PRESENCE_CHANNEL]);
    for (const f of denied(theo)) expect(f['service']).toBe('presence');

    // The assessment side never hears about Theo, and its roster has no orgiq entry.
    send(farah, { service: 'presence', action: 'subscribe', channel: PRESENCE_CHANNEL });
    await settle();
    expect(JSON.stringify(farah.frames)).not.toContain('u-theo');
    expect(denied(farah)).toEqual([]);
  });
});

describe('an assessment token on its own channels', () => {
  it('joins, sends, and the message reaches the other member with the token display name (a forged one is replaced)', async () => {
    send(farah, { service: 'chat', action: 'join', channel: DOC_CHANNEL });
    send(jonas, { service: 'chat', action: 'join', channel: DOC_CHANNEL });
    await settle();
    send(farah, {
      service: 'chat', action: 'send', channel: DOC_CHANNEL, message: 'hello from farah',
      metadata: { displayName: 'Definitely The CEO', userId: 'u-admin' },
    });
    await until(() => JSON.stringify(jonas.frames).includes('hello from farah'));

    expect(denied(farah)).toEqual([]);
    expect(denied(jonas)).toEqual([]);
    const seen = jonas.frames.find((f) => JSON.stringify(f).includes('hello from farah'))!;
    const text = JSON.stringify(seen);
    expect(text).toContain('Farah Assessor');
    expect(text).toContain('u-farah');
    expect(text).not.toContain('Definitely The CEO');
    expect(text).not.toContain('u-admin');

    // History returns it to a late reader in the same tenant.
    send(jonas, { service: 'chat', action: 'history', channel: DOC_CHANNEL, limit: 10 });
    await until(() => jonas.frames.filter((f) => JSON.stringify(f).includes('hello from farah')).length >= 2);
  });

  it('subscribes to its own presence channel and sets presence, with the token identity', async () => {
    send(farah, { service: 'presence', action: 'subscribe', channel: PRESENCE_CHANNEL });
    await settle();
    send(jonas, { service: 'presence', action: 'set', status: 'online', metadata: { displayName: 'Forged Name' }, channels: [PRESENCE_CHANNEL] });
    // Presence frames only: the dev:mock notification seed replays an item to
    // u-farah on connect that also names u-jonas (mock/notifications.ts).
    const presenceFrames = () => farah.frames.filter((f) => f.type === 'presence');
    await until(() => JSON.stringify(presenceFrames()).includes('u-jonas'));
    expect(denied(farah)).toEqual([]);
    expect(denied(jonas)).toEqual([]);
    const text = JSON.stringify(presenceFrames());
    expect(text).toContain('Jonas Assessor');
    expect(text).not.toContain('Forged Name');
  });
});

describe('dm lobbies', () => {
  const invite = (caller: string, lobbyName: string, callId: string, target: string) => ({
    service: 'call', action: 'invite', callId, lobbyName, callerId: caller, callerName: caller, targetUserIds: [target],
  });
  const rang = (o: Open, callId: string) => o.frames.some((f) => f.type === 'call' && (f['data'] as Frame | undefined)?.['callId'] === callId);

  it('refuses an invite into a <org>:dm: lobby from a non-participant, in either tenant, and rings nobody', async () => {
    // Theo is not one of the ids in an orgiq dm between two others.
    const nora = await connectAs('u-nora', 'Nora DaSilva', 'orgiq');
    const vera = await connectAs('u-vera', 'Vera Green', 'orgiq');
    try {
      send(theo, invite('u-theo', 'orgiq:dm:u-nora:u-vera', 'dm-orgiq', 'u-nora'));
      send(farah, invite('u-farah', 'assessment:dm:u-jonas:u-mira', 'dm-assess', 'u-jonas'));
      await until(() => o(theo).length > 0 && o(farah).length > 0);
      await settle();
      expect(o(theo)[0]).toMatchObject({ service: 'call', message: expect.stringContaining('Not authorized') });
      expect(o(farah)[0]).toMatchObject({ service: 'call', message: expect.stringContaining('Not authorized') });
      expect(rang(nora, 'dm-orgiq')).toBe(false);
      expect(rang(vera, 'dm-orgiq')).toBe(false);
      expect(rang(jonas, 'dm-assess')).toBe(false);

      // Control: a participant's invite in the same shape does ring.
      send(farah, invite('u-farah', 'assessment:dm:u-farah:u-jonas', 'dm-ok', 'u-jonas'));
      await until(() => rang(jonas, 'dm-ok'));
    } finally { nora.ws.close(); vera.ws.close(); }
    function o(x: Open) { return x.frames.filter((f) => f.type === 'error'); }
  });
});
