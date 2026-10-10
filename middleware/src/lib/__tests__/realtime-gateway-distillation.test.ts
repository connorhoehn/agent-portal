// The distillation feed on the /ws gateway (2026-10-01) — the socket the
// portal actually opens. Before this the portal subscribed to bare
// `distill:*` here, the gateway refused it (no tenant partition), nothing was
// ever pushed here, and the hook's resubscribe-on-refusal ran ~4,600 frames a
// second from one tab. Over a real http.Server with BOTH realtime paths
// attached, as index.ts does, and raw `ws` clients with real realtime tokens:
//   - an orgiq member's plain subscribe to orgiq:distill:* is acked, and a
//     review verdict reaches it as a pushed frame;
//   - the old bare name is refused, as is a client publish on the feed (a
//     forged frame never reaches another reader) and any service-prefixed
//     form (chat/presence on the name);
//   - an assessment-only user is refused, and so is an orgiq GRANT holder
//     standing in another tenant — the REST read gate is requireTenant('orgiq');
//   - admin reads it from anywhere, as the REST gate lets them.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' },
    mock: { aurora: true }, messageQueue: { mock: true },
  },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, channelGuard, lobbyGuard, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { attachDistillationRealtime } from '../distillation-realtime.js';
import { DISTILL_CHANNELS, distillationGatewayTarget, mayReadDistillation } from '../distillation-channels.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { decideReview, __resetDistillationMock } from '../../providers/distillation.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';

const SECRET = 'test-realtime-secret';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string; channel?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let disposeGateway: () => Promise<void>;
let detachDistillation: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  detachDistillation = attachDistillationRealtime(server, { debounceMs: 5 }).detach;
  disposeGateway = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, statsIntervalMs: 0 }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await disposeGateway();
  await detachDistillation();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetDistillationMock();
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

beforeEach(() => __resetDistillationMock());

function session(sub: string, tenant: string, grants: Record<string, string[]>, role?: string): Session {
  return { sub, name: sub, role: role ?? grants[tenant]?.[0] ?? 'member', tenant, grants, iat: Math.floor(Date.now() / 1000) } as Session;
}

async function connect(s: Session): Promise<Open> {
  const { token } = await signRealtimeToken(realtimeClaims(s), SECRET);
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
const subscribe = (o: Open, channel: string) => send(o, { service: 'subscribe', action: 'subscribe', channel });
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const acked = (o: Open, channel: string) => o.frames.some((f) => f.type === 'subscribe' && f.action === 'subscribed' && f.channel === channel);
const deniedOn = (o: Open, channel: string) => o.frames.some((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED' && f.channel === channel);

const MEMBER = session('u-theo', 'orgiq', { orgiq: ['member'], social: ['participant'] });
const LEADER = session('u-vera', 'orgiq', { orgiq: ['org-leader'] });

describe('the guard', () => {
  it('admits a plain subscribe for the REST read gate and nothing else', () => {
    const theo = { userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'], role: 'member' };
    for (const ch of Object.values(DISTILL_CHANNELS)) expect(channelGuard(theo, ch, 'subscribe')).toBe(true);
    expect(channelGuard(theo, DISTILL_CHANNELS.levels, 'publish')).toBe(false);
    expect(channelGuard(theo, `presence:${DISTILL_CHANNELS.levels}`, 'subscribe')).toBe(false);
    expect(channelGuard(theo, `chat:${DISTILL_CHANNELS.levels}`, 'subscribe')).toBe(false);
    expect(channelGuard(theo, 'orgiq:distill:anything-else', 'subscribe')).toBe(false);
    expect(channelGuard(theo, 'distill:levels', 'subscribe')).toBe(false);
    expect(lobbyGuard(theo, DISTILL_CHANNELS.levels)).toBe(false);
  });

  it('follows the ACTIVE tenant, as requireTenant does — a grant alone is not enough; admin crosses', () => {
    expect(mayReadDistillation({ userId: 'u-theo', org: 'social', tenants: ['orgiq', 'social'], role: 'participant' })).toBe(false);
    expect(mayReadDistillation({ userId: 'u-ana', org: 'assessment', tenants: ['assessment'], role: 'assessor' })).toBe(false);
    expect(mayReadDistillation({ userId: 'u-admin', org: 'assessment', tenants: ['assessment'], role: 'admin' })).toBe(true);
    expect(mayReadDistillation({ userId: 'u-x', tenant: 'orgiq', role: 'member' })).toBe(true);
    expect(mayReadDistillation({ org: 'orgiq', role: 'member' })).toBe(false);
  });

  it('is wired into the gateway (and unwired on dispose)', () => {
    expect(distillationGatewayTarget()).not.toBeNull();
  });
});

describe('over the socket', () => {
  it('acks an orgiq member and pushes a review verdict to them', async () => {
    const theo = await connect(MEMBER);
    subscribe(theo, DISTILL_CHANNELS.review);
    await until(() => acked(theo, DISTILL_CHANNELS.review));
    await decideReview('rev-003', { verdict: 'agree', note: null }, 'Test');
    await until(() => theo.frames.some((f) => f.type === 'review' && f.channel === DISTILL_CHANNELS.review));
    const review = theo.frames.find((f) => f.type === 'review')!;
    expect(typeof review['pending']).toBe('number');
    expect(typeof review['decided']).toBe('number');
    expect(deniedOn(theo, DISTILL_CHANNELS.review)).toBe(false);
  });

  it('refuses the bare pre-2026-10-01 name', async () => {
    const theo = await connect(MEMBER);
    subscribe(theo, 'distill:levels');
    await until(() => deniedOn(theo, 'distill:levels'));
    expect(acked(theo, 'distill:levels')).toBe(false);
  });

  it('refuses an assessment-only user and an orgiq grant holder standing in social', async () => {
    for (const s of [
      session('u-asha', 'assessment', { assessment: ['assessor'] }),
      session('u-theo', 'social', { orgiq: ['member'], social: ['participant'] }),
    ]) {
      const o = await connect(s);
      subscribe(o, DISTILL_CHANNELS.levels);
      await until(() => deniedOn(o, DISTILL_CHANNELS.levels));
      expect(acked(o, DISTILL_CHANNELS.levels)).toBe(false);
    }
  });

  it('admits admin from another tenant', async () => {
    const admin = await connect(session('u-operator', 'assessment', { assessment: ['admin'] }, 'admin'));
    subscribe(admin, DISTILL_CHANNELS.levels);
    await until(() => acked(admin, DISTILL_CHANNELS.levels));
  });

  it('drops a client publish on the feed: a forged frame never reaches another reader', async () => {
    const reader = await connect(LEADER);
    subscribe(reader, DISTILL_CHANNELS.levels);
    await until(() => acked(reader, DISTILL_CHANNELS.levels));
    const forger = await connect(MEMBER);
    subscribe(forger, DISTILL_CHANNELS.levels);
    await until(() => acked(forger, DISTILL_CHANNELS.levels));
    send(forger, { service: 'subscribe', action: 'publish', channel: DISTILL_CHANNELS.levels, type: 'levels', levels: [] });
    send(forger, { service: 'chat', action: 'send', channel: DISTILL_CHANNELS.levels, message: 'forged' });
    await new Promise((r) => setTimeout(r, 200));
    expect(reader.frames.some((f) => f.type === 'levels' || f.type === 'chat')).toBe(false);
  });
});
