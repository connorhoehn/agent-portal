jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import type { RealtimeHandle } from '@connorhoehn/realtime-modules/server';
import { dmPageReferencesRouter } from '../dm-page-references.js';
import { attachRealtimeGateway } from '../../lib/realtime-gateway.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import { getWorkItem } from '../../providers/work-items.js';
import { isAllowed } from '../../lib/authz.js';
import { signRealtimeToken, realtimeClaims } from '../../lib/realtime-token.js';
import { createMemorySocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';
import type { Session } from '../../lib/session.js';
import request from '../../test-support/http.js';

const DM = 'social:dm:alice:bob', SECRET = 'dm-page-test-only';
const PAGE = { kind: 'work-item', id: 'work-1' };
const WORK = { id: 'work-1', projectId: 'project-1', title: 'Private architecture work' };
const PROJECT = { id: 'project-1', name: 'Private initiative' };
const session = (sub: string): Session => ({ sub, tenant: sub === 'bob' ? 'social' : 'orgiq',
  role: sub === 'bob' ? 'participant' : 'member', epoch: 0, iat: 100,
  grants: { orgiq: ['member'], social: ['participant'] } });
type Frame = Record<string, any>;
type Client = { ws: WebSocket; frames: Frame[] };
let users: Map<string, UserInfo>, backend: SocialChatBackend, app: express.Express;
let server: http.Server, handle: RealtimeHandle, port: number, clients: Client[];
let previousSecret: string | undefined, denied: Set<string>;
async function until(check: () => boolean) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > 3000) throw new Error('Timed out waiting for gateway'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function connect(sub: string) {
  const token = await signRealtimeToken(realtimeClaims(session(sub)), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', token.token]), frames: [] as Frame[] };
  clients.push(client); client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: DM }));
  await until(() => client.frames.some(frame => frame.action === 'joined')); return client;
}
async function sendReference(client: Client, page: unknown = PAGE) {
  client.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel: DM, message: 'Please review this work',
    metadata: { pageReference: page, clientDeliveryId: 'delivery-1' } }));
  await until(() => client.frames.some(frame => frame.action === 'sent' || frame.code === 'DM_PAGE_REFERENCE_DENIED'));
  return (await backend.chatStore.listMessages(DM, 10))[0];
}
const read = (messageId: string, user = 'bob', channel = DM) => request(app).get('/api/social/dms/page-reference')
  .query({ channel, messageId }).set('x-user', user);
async function stored(page: unknown = PAGE) {
  const message = { id: 'message-1', channel: DM, clientId: 'alice-connection', userId: 'alice', message: 'Read this',
    timestamp: '2026-10-04T12:00:00.000Z', metadata: { pageReference: page } };
  await backend.chatStore.putMessage(message); return message;
}
beforeEach(async () => {
  jest.clearAllMocks();
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  denied = new Set(); clients = [];
  users = new Map(['alice', 'bob', 'outsider'].map(id => [id, { id, displayName: `${id} Directory`, email: null,
    personId: null, epoch: 0, grants: structuredClone(session(id).grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.tenant === 'social' && !denied.has(action));
  jest.mocked(getProject).mockResolvedValue(PROJECT as Awaited<ReturnType<typeof getProject>>);
  jest.mocked(getWorkItem).mockResolvedValue(WORK as Awaited<ReturnType<typeof getWorkItem>>);
  backend = createMemorySocialChatBackend({ fixtures: false });
  app = express(); app.use(express.json()); app.use((req, _res, next) => { const id = req.get('x-user'); if (id) req.session = session(id); next(); });
  app.use('/api/social', dmPageReferencesRouter); app.use(errorHandler);
  server = http.createServer(app);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
  jest.restoreAllMocks();
});

it('stores and delivers only a validated descriptor, then resolves canonical reader metadata', async () => {
  const alice = await connect('alice'), bob = await connect('bob'); const message = await sendReference(alice);
  expect(message?.metadata?.['pageReference']).toEqual(PAGE);
  await until(() => bob.frames.some(frame => frame.action === 'message'));
  expect(JSON.stringify(bob.frames)).not.toContain('Private architecture work');
  const response = await read(message!.id);
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({ channel: DM, messageId: message!.id, pageReference: { ...PAGE, status: 'available',
    title: WORK.title, href: '/iq/projects/project-1?tab=work&item=work-1', project: { id: PROJECT.id, title: PROJECT.name } } });
});
it.each([{ ...PAGE, title: 'Forged title', href: '//evil.invalid' }, { kind: 'url', id: 'work-1' }, { kind: 'work-item', id: '../secret' }])
('refuses malformed or client-resolved reference metadata before persistence: %j', async page => {
  const alice = await connect('alice'); expect(await sendReference(alice, page)).toBeUndefined();
  expect(alice.frames).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DM_PAGE_REFERENCE_DENIED', status: 400 })]));
  expect(getWorkItem).not.toHaveBeenCalled();
});
it('refuses reference edits that forge canonical fields', async () => {
  const alice = await connect('alice'); const message = await sendReference(alice);
  alice.ws.send(JSON.stringify({ service: 'chat', action: 'edit', channel: DM, messageId: message!.id,
    message: 'Changed', metadata: { pageReference: { ...PAGE, title: 'Forged' } } }));
  await until(() => alice.frames.some(frame => frame.code === 'DM_PAGE_REFERENCE_DENIED'));
  expect((await backend.chatStore.getMessage!(DM, message!.id))?.message).toBe('Please review this work');
});
it('fails closed when sender PostMessage is revoked during canonical lookup', async () => {
  const alice = await connect('alice'); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(getWorkItem).mockImplementationOnce(async () => { entered(); await waiting; return WORK as Awaited<ReturnType<typeof getWorkItem>>; });
  const send = sendReference(alice); await started; denied.add('PostMessage'); release();
  expect(await send).toBeUndefined(); expect(alice.frames.some(frame => frame.action === 'sent')).toBe(false);
});
it('hides all resource-derived fields from Social-only readers and observes grant restoration', async () => {
  await stored(); users.get('bob')!.grants.orgiq = [];
  const response = await read('message-1'); expect(response.status).toBe(200);
  expect(response.body.pageReference).toEqual({ ...PAGE, status: 'unavailable' });
  expect(getWorkItem).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('Private');
  users.get('bob')!.grants.orgiq = ['member']; expect((await read('message-1')).body.pageReference.title).toBe(WORK.title);
});
it('returns an unavailable reference after the canonical resource is deleted', async () => {
  await stored(); jest.mocked(getWorkItem).mockResolvedValue(null);
  const response = await read('message-1'); expect(response.status).toBe(200); expect(response.body.pageReference).toEqual({ ...PAGE, status: 'unavailable' });
});
it('rejects anonymous/outsider/noncanonical requests and unavailable messages', async () => {
  await stored(); expect((await request(app).get('/api/social/dms/page-reference').query({ channel: DM, messageId: 'message-1' })).status).toBe(401);
  expect((await read('message-1', 'outsider')).status).toBe(403);
  expect((await read('message-1', 'bob', 'social:dm:bob:alice')).status).toBe(400);
  expect((await read('missing')).status).toBe(404);
  await backend.chatStore.updateMessage!(DM, 'message-1', { deletedAt: new Date().toISOString() }); expect((await read('message-1')).status).toBe(404);
});
it('enforces explicit membership and strictly-after history admission boundaries', async () => {
  const message = await stored(); const member = { channel: DM, userId: 'bob', role: 'member' as const, addedBy: 'alice',
    addedAt: message.timestamp, historyFrom: message.timestamp, removedAt: null };
  await backend.membershipStore.putMember(member); expect((await read(message.id)).status).toBe(404);
  await backend.membershipStore.putMember({ ...member, historyFrom: null, removedAt: message.timestamp }); expect((await read(message.id)).status).toBe(403);
});
it.each(['resource-grant', 'social-policy', 'membership', 'message-delete'])('fences delayed reader lookup against %s changes', async reason => {
  await stored(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(getWorkItem).mockImplementationOnce(async () => { entered(); await waiting; return WORK as Awaited<ReturnType<typeof getWorkItem>>; });
  const response = read('message-1').then(value => value); await started;
  if (reason === 'resource-grant') users.get('bob')!.grants.orgiq = [];
  if (reason === 'social-policy') denied.add('ViewSocial');
  if (reason === 'membership') await backend.membershipStore.putMember({ channel: DM, userId: 'bob', role: 'member', addedBy: 'alice',
    addedAt: new Date().toISOString(), historyFrom: null, removedAt: new Date().toISOString() });
  if (reason === 'message-delete') await backend.chatStore.updateMessage!(DM, 'message-1', { deletedAt: new Date().toISOString() });
  release(); const value = await response; expect(JSON.stringify(value.body)).not.toContain('Private');
  expect(value.status).toBe(reason === 'resource-grant' ? 200 : reason === 'message-delete' ? 404 : 403);
});
