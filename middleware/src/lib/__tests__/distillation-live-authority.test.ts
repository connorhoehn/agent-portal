jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' },
  cognito: { portalOrigin: '' }, mock: { aurora: true }, messageQueue: { mock: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/distillation.js', () => ({ levelsView: async () => ({ levels: [] }),
  jobSnapshot: () => null, reviewCounts: () => ({ pending: 0, decided: 0 }) }));

import http from 'node:http';
import WebSocket from 'ws';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { signSession, COOKIE_NAME, type Session } from '../session.js';
import { attachDistillationRealtime, DISTILL_CHANNELS } from '../distillation-realtime.js';
import { distillationEvents } from '../distillation-events.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let users: Map<string, UserInfo>, server: http.Server, handle: ReturnType<typeof attachDistillationRealtime>, port: number;
let clients: WebSocket[];
const source: Session = { sub: 'distill-member', role: 'member', tenant: 'orgiq', epoch: 4, iat: 100, grants: { orgiq: ['member'] } };
beforeEach(async () => {
  users = new Map([['distill-member', { id: 'distill-member', displayName: 'Member', email: null, personId: null, epoch: 4, grants: { orgiq: ['member'] } }],
    ['operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 8, grants: { orgiq: ['admin'] } }]]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  server = http.createServer(); handle = attachDistillationRealtime(server, { debounceMs: 1 }); clients = [];
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  await handle.detach(); await new Promise<void>(resolve => server.close(() => resolve())); jest.clearAllMocks();
});
async function connect(session: Session) {
  const cookie = await signSession({ ...session, iat: Math.floor(Date.now() / 1000) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`, { headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(cookie)}` } });
  clients.push(ws); const frames: any[] = [];
  ws.on('message', raw => frames.push(JSON.parse(String(raw)))); ws.on('error', () => undefined);
  const status = await new Promise<number>(resolve => {
    ws.on('open', () => resolve(101)); ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate(); });
  });
  return { ws, frames, status };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); }
  throw new Error('Distillation receipt timed out');
}

it.each(['epoch', 'role', 'actor'] as const)('refuses current-cookie upgrade after %s retirement', async reason => {
  const session = structuredClone(source);
  if (reason === 'epoch') users.get(source.sub)!.epoch++;
  if (reason === 'role') users.get(source.sub)!.grants.orgiq = ['sme'];
  if (reason === 'actor') {
    session.act = { sub: 'operator', epoch: 8, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } };
    users.get('operator')!.grants.orgiq = ['member'];
  }
  expect((await connect(session)).status).toBe(401);
});

it('an open cookie socket loses subscriptions and delivery after an unhinted epoch bump', async () => {
  const client = await connect(source); expect(client.status).toBe(101);
  client.ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: DISTILL_CHANNELS.review }));
  await until(() => client.frames.some(frame => frame.action === 'subscribed'));
  distillationEvents.emit('review'); await until(() => client.frames.some(frame => frame.type === 'review'));
  const prior = client.frames.filter(frame => frame.type === 'review').length;
  users.get(source.sub)!.epoch++;
  distillationEvents.emit('review'); await pause(80);
  expect(client.frames.filter(frame => frame.type === 'review')).toHaveLength(prior);
  const clientId = handle.listClients()[0];
  expect(await handle.router.subscribeToChannel!(clientId, DISTILL_CHANNELS.jobs)).toBe(false);
  expect(await handle.router.sendToClient(clientId, { type: 'review', channel: DISTILL_CHANNELS.review })).toBe(false);
  expect((await connect(source)).status).toBe(401);
});
