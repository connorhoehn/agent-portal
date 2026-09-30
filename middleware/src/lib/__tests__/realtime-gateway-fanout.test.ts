// Two gateways, two http servers, real `ws` clients, one shared bus — the
// scaled-out shape, through the real `attachRealtimeGateway` path rather than
// against the router class directly.
//
// This is the test that would have caught the bug the distributed router exists
// to fix: with the default single-process router, `alice` on gateway A and `bob`
// on gateway B are in the same channel and simply never see each other's
// messages. No error, no refusal — two people in one room with different
// transcripts. So the first case asserts delivery ACROSS gateways, and the last
// one asserts the old behaviour is still what you get when fan-out is off, since
// that is the default and must not have changed.
//
// `fanout` is injected as an in-memory bus, so this runs without a Redis while
// exercising the same code path Redis drives (redisRouterBus only swaps the
// transport underneath the identical RouterBus interface).

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import type { RouterBus } from '../realtime-router-distributed.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';

const SECRET = 'test-realtime-secret';
const GENERAL = 'social:ch:general';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

/** One bus shared by both gateways, JSON round-tripping as Redis would. */
function sharedBus(): RouterBus {
  const handlers: Array<(p: unknown) => void> = [];
  return {
    publish(_topic, payload) {
      const wire = JSON.parse(JSON.stringify(payload)) as unknown;
      for (const h of handlers) h(wire);
    },
    subscribe(_topic, handler) { handlers.push(handler); },
  };
}

interface Gateway { server: http.Server; port: number; dispose: () => Promise<void> }

async function gateway(fanout: RouterBus | null, nodeId = `test-${Math.random().toString(36).slice(2, 8)}`): Promise<Gateway> {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  // Distinct node ids are mandatory: a shared id makes each replica discard the
  // other's frames as its own echo, and fan-out silently delivers nothing.
  const { dispose } = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, fanout, nodeId });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, dispose };
}

const sockets: WebSocket[] = [];

async function connectAs(port: number, sub: string, name: string): Promise<Open> {
  const session = {
    sub, name, role: 'participant', tenant: 'social',
    grants: { social: ['participant'] }, iat: Math.floor(Date.now() / 1000),
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
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
});
afterAll(() => {
  for (const ws of sockets) ws.terminate();
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

describe('cross-replica fan-out through attachRealtimeGateway', () => {
  it('delivers a message between users whose sockets are on different gateways', async () => {
    const bus = sharedBus();
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

  it('still refuses a cross-tenant subscribe on the scaled-out path', async () => {
    // Fan-out must not become a way around the router's authz: the orgiq token
    // is refused on a social channel exactly as it is on one task.
    const bus = sharedBus();
    const a = await gateway(bus);
    try {
      const session = {
        sub: 'u-theo', name: 'Theo', role: 'member', tenant: 'orgiq',
        grants: { orgiq: ['member'] }, iat: Math.floor(Date.now() / 1000),
      } as Session;
      const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
      sockets.push(ws);
      const frames: Frame[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Frame));
      await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
      ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: GENERAL }));
      await until(() => frames.some((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED'));
      expect(frames.some((f) => f.code === 'AUTHZ_CHANNEL_DENIED')).toBe(true);
    } finally {
      await a.dispose();
      await new Promise<void>((r) => a.server.close(() => r()));
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
