// The social tenant's channels and DMs on the gateway (docs/social-tenant-design.md
// §4.2–§4.4, §3.4 row 5), over a real http.Server and raw `ws` clients with
// real realtime tokens, on the memory backend whose `social:` rows are the
// registered fixtures (mock/social-channels.ts — MOCK_AURORA):
//   - a `social:ch:<slug>` channel admits its MEMBERS only: a social user who
//     is not a member is refused join/send/presence with AUTHZ_CHANNEL_DENIED,
//     a member reads and writes, and a message persists into the fixture rows;
//   - the tenant rule still comes first: an orgiq token for a user who IS a
//     member of #general is refused (a forged cross-tenant subscribe);
//   - `social:dm:<ids>` admits the ids only;
//   - a membership written after attach (a REST join) opens the channel;
//   - row 5: a channel message notifies members with no live subscription,
//     and an `@<name>` mention reaches the mentioned member even while live.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, channelGuard, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { socialChat } from '../social-chat.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';

const SECRET = 'test-realtime-secret';
const GENERAL = 'social:ch:general';
const DESIGN = 'social:ch:design-reviews';
const DM = 'social:dm:u-lena:u-sana';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

async function connectAs(sub: string, name: string, tenant: string): Promise<Open> {
  const session = { sub, name, role: 'participant', tenant, grants: { [tenant]: ['participant'] }, iat: Math.floor(Date.now() / 1000) } as Session;
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
const chatMessages = (o: Open, channel: string) => o.frames
  .filter((f) => f.type === 'chat' && f.action === 'message' && (f['message'] as { channel?: string } | undefined)?.channel === channel)
  .map((f) => f['message'] as { message: string; userId?: string });
const newItems = (o: Open) => o.frames.filter((f) => f.type === 'notification:new').map((f) => f['payload'] as Frame);

describe('channelGuard on social:ch: names', () => {
  it('admits a member, refuses a non-member, and refuses another tenant before membership is asked', () => {
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, GENERAL)).toBe(true);
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, `chat:${GENERAL}`)).toBe(true);
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, DESIGN)).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, `presence:${DESIGN}`)).toBe(false);
    // u-theo is a member of #general, but a token standing in orgiq is not in social.
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq' }, GENERAL)).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, 'social:ch:no-such-channel')).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, 'social:ch:Bad Slug')).toBe(false);
  });

  it('admits a DM to its ids only', () => {
    expect(channelGuard({ userId: 'u-sana', org: 'social' }, DM)).toBe(true);
    expect(channelGuard({ userId: 'u-lena', org: 'social' }, DM)).toBe(true);
    expect(channelGuard({ userId: 'u-mira', org: 'social' }, DM)).toBe(false);
  });
});

describe('channels over the socket', () => {
  let mira: Open;
  let sana: Open;
  let theo: Open;
  beforeEach(async () => {
    mira = await connectAs('u-mira', 'Mira Okafor', 'social');
    sana = await connectAs('u-sana', 'Sana Iqbal', 'social');
    theo = await connectAs('u-theo', 'Theo Chang', 'orgiq');
  });
  afterEach(() => { for (const o of [mira, sana, theo]) o.ws.close(); });

  it('a member posts in social:ch:general and another member reads it live; it lands in the store', async () => {
    send(sana, { service: 'chat', action: 'join', channel: GENERAL });
    send(mira, { service: 'chat', action: 'join', channel: GENERAL });
    await settle();
    send(mira, { service: 'chat', action: 'send', channel: GENERAL, message: 'hello from the test' });
    await until(() => chatMessages(sana, GENERAL).some((m) => m.message === 'hello from the test'));
    expect(chatMessages(sana, GENERAL).find((m) => m.message === 'hello from the test')).toMatchObject({ userId: 'u-mira' });
    expect(denied(mira)).toEqual([]);
    expect(socialChannelMessagesFixture.rows().some((m) => m.channel === GENERAL && m.message === 'hello from the test')).toBe(true);
  });

  it('a social user who is not a member of social:ch:design-reviews is refused join, send and presence', async () => {
    for (const frame of [
      { service: 'chat', action: 'join', channel: DESIGN },
      { service: 'chat', action: 'send', channel: DESIGN, message: 'not a member' },
      { service: 'presence', action: 'subscribe', channel: DESIGN },
    ]) send(sana, frame);
    // The library's own membership gate (the channel is closed: it has member
    // rows) answers the join first; the gateway's guard answers the publish
    // and the presence subscribe, which the chat service never sees.
    const notMember = () => sana.frames.filter((f) => f.type === 'error' && (f['error'] as { code?: string } | undefined)?.code === 'not-a-member');
    await until(() => notMember().length >= 1 && denied(sana).length >= 2);
    expect(denied(sana).map((f) => `${String(f['service'])}/${String(f['kind'])}`).sort()).toEqual(['chat/publish', 'presence/subscribe']);
    for (const f of denied(sana)) expect(f['channel']).toBe(DESIGN);
    expect(chatMessages(sana, DESIGN)).toEqual([]);
    expect(socialChannelMessagesFixture.rows().some((m) => m.message === 'not a member')).toBe(false);
  });

  it('a forged cross-tenant subscribe to social:ch:general from an orgiq session answers AUTHZ_CHANNEL_DENIED', async () => {
    send(theo, { service: 'chat', action: 'join', channel: GENERAL });
    send(theo, { service: 'chat', action: 'history', channel: GENERAL, limit: 10 });
    await until(() => denied(theo).length >= 2);
    expect(denied(theo)[0]).toMatchObject({ service: 'chat', channel: GENERAL });
    expect(theo.frames.some((f) => f.type === 'chat' && (f.action === 'history' || f.action === 'message'))).toBe(false);
  });

  it('a membership written after attach (a REST join) opens the channel', async () => {
    const chat = socialChat();
    expect(chat.membershipStore.isActiveMember(DESIGN, 'u-sana')).toBe(false);
    await chat.membershipStore.putMember({ channel: DESIGN, userId: 'u-sana', role: 'member', addedBy: 'u-sana', addedAt: new Date().toISOString(), historyFrom: null, removedAt: null });
    send(sana, { service: 'chat', action: 'join', channel: DESIGN });
    await settle();
    expect(denied(sana)).toEqual([]);
    await chat.membershipStore.putMember({ channel: DESIGN, userId: 'u-sana', role: 'member', addedBy: 'u-sana', addedAt: new Date().toISOString(), historyFrom: null, removedAt: new Date().toISOString() });
    expect(chat.membershipStore.isActiveMember(DESIGN, 'u-sana')).toBe(false);
  });
});

describe('DMs over the socket', () => {
  it('the two ids exchange messages; a third social user is refused', async () => {
    const lena = await connectAs('u-lena', 'Lena Brandt', 'social');
    const sana = await connectAs('u-sana', 'Sana Iqbal', 'social');
    const mira = await connectAs('u-mira', 'Mira Okafor', 'social');
    try {
      send(sana, { service: 'chat', action: 'join', channel: DM });
      send(lena, { service: 'chat', action: 'join', channel: DM });
      await settle();
      send(lena, { service: 'chat', action: 'send', channel: DM, message: 'dm round trip' });
      await until(() => chatMessages(sana, DM).some((m) => m.message === 'dm round trip'));
      send(mira, { service: 'chat', action: 'join', channel: DM });
      await until(() => denied(mira).length >= 1);
      expect(chatMessages(mira, DM)).toEqual([]);
      const rows = await socialChat().conversations.listForUser('u-sana');
      expect(rows.find((r) => r.channel === DM)?.lastMessagePreview).toBe('dm round trip');
    } finally { for (const o of [lena, sana, mira]) o.ws.close(); }
  });
});

describe('producer row 5 — channel messages', () => {
  it('notifies a member with no live subscription to social:ch:general, and a mention reaches a live member', async () => {
    const mira = await connectAs('u-mira', 'Mira Okafor', 'social');
    const lena = await connectAs('u-lena', 'Lena Brandt', 'social'); // a member, not viewing the channel
    const sana = await connectAs('u-sana', 'Sana Iqbal', 'social'); // a member, viewing it
    try {
      send(mira, { service: 'chat', action: 'join', channel: GENERAL });
      send(sana, { service: 'chat', action: 'join', channel: GENERAL });
      await settle();
      send(mira, { service: 'chat', action: 'send', channel: GENERAL, message: 'agenda is up — @Sana Iqbal can you take notes?' });
      await until(() => newItems(lena).length >= 1 && newItems(sana).length >= 1);
      expect(newItems(lena)[0]).toMatchObject({
        type: 'message', title: 'Mira Okafor in #general',
        payload: { tenant: 'social', channel: GENERAL, actorId: 'u-mira' },
        action: { href: '/social/channels/general' },
      });
      expect(newItems(sana)[0]).toMatchObject({ type: 'mention', title: 'Mira Okafor mentioned you in #general' });
      expect(newItems(mira)).toEqual([]);
    } finally { for (const o of [mira, lena, sana]) o.ws.close(); }
  });
});
