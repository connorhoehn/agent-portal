// Collaborative cursors on the BFF gateway (realtime-parity gap 4), through a
// real router. A cursor rides `cursor:assessment:doc:<id>` and is judged by the
// same live family rule as the document's presence and chat; the frame that
// reaches a peer carries position + authenticated identity and nothing else.
jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import * as identity from '../../providers/identity.js';
import { getUser } from '../../providers/identity.js';

const SECRET = 'test-realtime-secret';
const DOC = 'assessment:doc:page:100002';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server; let port: number; let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});
beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

async function connectAs(sub: string, name: string, tenant: string): Promise<Open> {
  const user = await getUser(sub, { authoritative: true });
  const session = { sub, name, role: user?.grants[tenant]?.[0], tenant, grants: user?.grants ?? {}, epoch: user?.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some(f => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
        else if (Date.now() - start > 2000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}
const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const settle = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
async function until(pred: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) throw new Error('timed out waiting for a frame'); await new Promise(r => setTimeout(r, 10)); }
}
const denied = (o: Open) => o.frames.filter(f => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED');
const cursors = (o: Open, action: string) => o.frames.filter(f => f.type === 'cursor' && f.action === action);

let farah: Open; let jonas: Open; let theo: Open;
beforeEach(async () => {
  farah = await connectAs('u-farah', 'Farah Assessor', 'assessment');
  jonas = await connectAs('u-jonas', 'Jonas Assessor', 'assessment');
  theo = await connectAs('u-theo', 'Theo Orgiq', 'orgiq');
});
afterEach(() => { for (const o of [farah, jonas, theo]) o.ws.close(); });

describe('document cursors', () => {
  it('shows one reader to another, carrying only position and the token identity', async () => {
    send(jonas, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(jonas, 'subscribed').length === 1);
    send(farah, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(farah, 'subscribed').length === 1);
    send(farah, { service: 'cursor', action: 'update', channel: DOC, mode: 'canvas',
      position: { x: 0.25, y: 0.5, secret: 'leak' },
      metadata: { displayName: 'Forged Name', userColor: '#000', userInitials: 'ZZ', note: 'extra', email: 'x@y.z' } });
    await until(() => cursors(jonas, 'updated').length + cursors(jonas, 'update').length >= 1);
    const frame = JSON.stringify([...cursors(jonas, 'updated'), ...cursors(jonas, 'update')][0]);
    const body = JSON.parse(frame) as { cursor?: { position: unknown; metadata: Record<string, unknown> }; position?: unknown; metadata?: Record<string, unknown> };
    const c = body.cursor ?? body;
    expect(c.position).toEqual({ x: 0.25, y: 0.5 });
    expect(c.metadata).toEqual({ mode: 'canvas', userId: 'u-farah', displayName: 'Farah Assessor', userInitials: 'FA', userColor: expect.stringMatching(/^#[0-9A-Fa-f]{6}$/) });
    expect(frame).not.toMatch(/Forged|leak|extra|x@y\.z/);
    expect(denied(jonas)).toEqual([]);
  });

  it('removes a cursor when its owner leaves', async () => {
    send(jonas, { service: 'cursor', action: 'subscribe', channel: DOC });
    send(farah, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(jonas, 'subscribed').length === 1 && cursors(farah, 'subscribed').length === 1);
    send(farah, { service: 'cursor', action: 'update', channel: DOC, position: { x: 0.1, y: 0.1 } });
    await until(() => cursors(jonas, 'updated').length + cursors(jonas, 'update').length >= 1);
    farah.ws.close();
    await until(() => jonas.frames.some(f => f.type === 'cursor' && /remov|left|disconnect/i.test(String(f.action))));
  });

  it('refuses an orgiq session every cursor verb on an assessment document, and tells the reader nothing', async () => {
    send(farah, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(farah, 'subscribed').length === 1);
    const before = farah.frames.length;
    for (const frame of [
      { service: 'cursor', action: 'subscribe', channel: DOC },
      { service: 'cursor', action: 'get', channel: DOC },
      { service: 'cursor', action: 'update', channel: DOC, position: { x: 0.5, y: 0.5 } },
    ]) send(theo, frame);
    await until(() => denied(theo).length >= 3);
    expect(cursors(theo, 'subscribed')).toEqual([]);
    expect(cursors(theo, 'cursors')).toEqual([]);
    await settle();
    expect(farah.frames.length).toBe(before);
  });

  it('refuses a malformed position and an unrelated channel without fan-out', async () => {
    send(jonas, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(jonas, 'subscribed').length === 1);
    const before = jonas.frames.length;
    send(farah, { service: 'cursor', action: 'update', channel: DOC, position: { x: 'a', y: 1 } });
    send(farah, { service: 'cursor', action: 'update', channel: 'orgiq:initiative:p-soc2', position: { x: 1, y: 1 } });
    await settle(300);
    expect(jonas.frames.length).toBe(before);
  });
});

describe('revocation while a cursor subscription is open', () => {
  it.each(['epoch', 'grant'])('fences a subscriber after an %s change: no further frames, no publishing', async reason => {
    send(farah, { service: 'cursor', action: 'subscribe', channel: DOC });
    send(jonas, { service: 'cursor', action: 'subscribe', channel: DOC });
    await until(() => cursors(farah, 'subscribed').length === 1 && cursors(jonas, 'subscribed').length === 1);
    const seen = (o: Open) => o.frames.filter(f => f.type === 'cursor' && f.action !== 'subscribed').length;
    send(jonas, { service: 'cursor', action: 'update', channel: DOC, position: { x: 0.1, y: 0.1 } });
    await until(() => seen(farah) >= 1);

    const real = identity.getUser;
    jest.spyOn(identity, 'getUser').mockImplementation(async (id, opts) => {
      const user = await real(id, opts);
      if (!user || id !== 'u-farah') return user;
      return reason === 'epoch' ? { ...user, epoch: user.epoch + 1 } : { ...user, grants: { ...user.grants, assessment: [] } };
    });
    const before = farah.frames.length; const jonasBefore = denied(jonas).length;
    await settle(50);
    send(jonas, { service: 'cursor', action: 'update', channel: DOC, position: { x: 0.9, y: 0.9 } });
    await settle(400);
    expect(farah.frames.slice(before).filter(f => f.type === 'cursor')).toEqual([]);
    send(farah, { service: 'cursor', action: 'update', channel: DOC, position: { x: 0.5, y: 0.5 } });
    await until(() => denied(farah).length >= 1);
    expect(denied(jonas).length).toBe(jonasBefore);
  });
});

// The work graph on a page is a shared canvas: the families that carry one admit
// `cursor` under the same read authority as their presence (lib/tenant-channels.ts).
describe.each([
  { name: 'an orgiq initiative', channel: 'orgiq:initiative:p-auth-migration', a: ['u-theo', 'Theo Chang', 'orgiq'], b: ['u-vera', 'Vera Green', 'orgiq'], outsider: ['u-farah', 'Farah Assessor', 'assessment'] },
  { name: 'an assessment team', channel: 'assessment:team:TEAM-001', a: ['u-farah', 'Farah Assessor', 'assessment'], b: ['u-jonas', 'Jonas Assessor', 'assessment'], outsider: ['u-theo', 'Theo Chang', 'orgiq'] },
  { name: 'a social channel', channel: 'social:ch:general', a: ['u-theo', 'Theo Chang', 'social'], b: ['u-vera', 'Vera Green', 'social'], outsider: ['u-hr', 'Helen Desai', 'orgiq'] },
  { name: 'a pipelines run', channel: 'pipelines:run:run-1', a: ['u-ines', 'Ines Moreau', 'pipelines'], b: ['u-kofi', 'Kofi Mensah', 'pipelines'], outsider: ['u-hr', 'Helen Desai', 'orgiq'] },
])('canvas cursors on $name', ({ channel, a, b, outsider }) => {
  it('shows one member to another with the token identity, and refuses an outsider and a cross-tenant session', async () => {
    const one = await connectAs(a[0]!, a[1]!, a[2]!); const two = await connectAs(b[0]!, b[1]!, b[2]!); const out = await connectAs(outsider[0]!, outsider[1]!, outsider[2]!);
    try {
      send(two, { service: 'cursor', action: 'subscribe', channel });
      send(one, { service: 'cursor', action: 'subscribe', channel });
      await until(() => cursors(two, 'subscribed').length === 1 && cursors(one, 'subscribed').length === 1);
      send(one, { service: 'cursor', action: 'update', channel, mode: 'canvas', position: { x: 0.4, y: 0.6 }, metadata: { displayName: 'Forged' } });
      await until(() => cursors(two, 'updated').length + cursors(two, 'update').length >= 1);
      const frame = JSON.stringify([...cursors(two, 'updated'), ...cursors(two, 'update')][0]);
      expect(frame).toContain(a[0]!);
      expect(frame).not.toContain('Forged');
      const before = two.frames.length;
      send(out, { service: 'cursor', action: 'subscribe', channel });
      send(out, { service: 'cursor', action: 'update', channel, position: { x: 0.5, y: 0.5 } });
      await until(() => denied(out).length >= 2);
      expect(cursors(out, 'subscribed')).toEqual([]);
      await settle();
      expect(two.frames.length).toBe(before);
    } finally { for (const o of [one, two, out]) o.ws.close(); }
  });
});
