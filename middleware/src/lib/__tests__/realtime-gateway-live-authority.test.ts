jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { attachRealtimeGateway } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, type SocialChatBackend } from '../social-chat.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import type { Session } from '../session.js';

type Frame = Record<string, unknown>;
type Client = { ws: WebSocket; frames: Frame[] };
const SECRET = 'live-authority-gateway-contract';
const DM = 'social:dm:alice:bob';
let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>, backend: SocialChatBackend;
let users: Map<string, UserInfo>, clients: Client[], unavailable: Set<string>, deniedActions: Set<string>;
let previousSecret: string | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 4000) throw new Error('Gateway receipt timed out'); await pause(10); }
}
const send = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const denied = (client: Client) => client.frames.filter(frame => frame.type === 'error');
const messages = (client: Client) => client.frames.filter(frame => frame.type === 'chat' && frame.action === 'message');
async function dispatched(client: Client, frame: Frame) {
  const service = handle.services[String(frame.service)];
  const original = service.handleAction.bind(service);
  let complete!: () => void; const receipt = new Promise<void>(resolve => { complete = resolve; });
  const action = jest.spyOn(service, 'handleAction').mockImplementationOnce(async (...args) => {
    try { await original(...args); } finally { complete(); }
  });
  try { send(client, frame); await receipt; } finally { action.mockRestore(); }
}
const inboxItems = (client: Client) => client.frames.filter(frame => frame.type === 'notification:bulk-update')
  .flatMap(frame => (frame.payload as { notifications: Array<{ id: string }> }).notifications);
const source = (sub: string): Session => ({ sub, name: sub, role: 'member', tenant: 'orgiq', epoch: 0,
  grants: { orgiq: ['member'], social: ['participant'] }, iat: Math.floor(Date.now() / 1000) });
async function connect(session: Session): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(session), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]), frames: [] as Frame[] };
  clients.push(client);
  client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  return client;
}
async function join(client: Client, channel = DM) {
  send(client, { service: 'chat', action: 'join', channel });
  await until(() => client.frames.some(frame => frame.type === 'chat' && frame.action === 'joined' && frame.channel === channel));
}
async function post(client: Client, text: string) {
  const before = client.frames.filter(frame => frame.action === 'sent').length;
  send(client, { service: 'chat', action: 'send', channel: DM, message: text });
  await until(() => client.frames.filter(frame => frame.action === 'sent').length > before);
}
beforeEach(async () => {
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  clients = []; unavailable = new Set(); deniedActions = new Set();
  users = new Map(['alice', 'bob'].map(id => [id, { id, displayName: `${id} Directory`, epoch: 0,
    email: null, personId: null, grants: structuredClone(source(id).grants) }]));
  jest.mocked(getUser).mockImplementation(async id => {
    if (unavailable.has(id)) throw new Error('Directory unavailable');
    return users.has(id) ? structuredClone(users.get(id)!) : null;
  });
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.tenant === 'social'
    && principal.role === 'participant' && !deniedActions.has(action));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  backend = createMemorySocialChatBackend({ fixtures: false });
  server = http.createServer(); handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
  jest.restoreAllMocks();
});

it('reauthorizes every live recipient and history request after Social grant removal, then observes restoration', async () => {
  const alice = await connect(source('alice')), bob = await connect(source('bob'));
  await join(alice); await join(bob);
  users.get('bob')!.grants.social = [];
  await post(alice, 'Stored after recipient removal');
  expect(messages(bob)).toEqual([]);
  send(bob, { service: 'chat', action: 'history', channel: DM });
  await until(() => denied(bob).some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(bob.frames.some(frame => frame.action === 'history')).toBe(false);
  expect((await backend.chatStore.listMessages(DM, 10)).map(row => row.message)).toEqual(['Stored after recipient removal']);
  users.get('bob')!.grants.social = ['participant'];
  send(bob, { service: 'chat', action: 'history', channel: DM });
  await until(() => bob.frames.some(frame => frame.action === 'history'));
  expect(bob.frames.find(frame => frame.action === 'history')?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: 'Stored after recipient removal' }),
  ]));
  expect(getUser).toHaveBeenCalledWith('bob', { authoritative: true });
});

it('does not store or deliver a send after current sender rights are removed', async () => {
  const alice = await connect(source('alice')), bob = await connect(source('bob'));
  await join(alice); await join(bob); users.get('alice')!.grants.social = [];
  send(alice, { service: 'chat', action: 'send', channel: DM, message: 'Must never persist' });
  await until(() => denied(alice).some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await backend.chatStore.listMessages(DM, 10)).toEqual([]); expect(messages(bob)).toEqual([]);
  expect(alice.frames.some(frame => frame.action === 'sent')).toBe(false);
});

it('keeps read access while denying current PostMessage policy, including a previously joined socket', async () => {
  const alice = await connect(source('alice')); await join(alice); deniedActions.add('PostMessage');
  send(alice, { service: 'chat', action: 'send', channel: DM, message: 'Read-only policy' });
  await until(() => denied(alice).some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await backend.chatStore.listMessages(DM, 10)).toEqual([]);
  send(alice, { service: 'presence', action: 'subscribe', channel: 'social:lobby' });
  await until(() => alice.frames.some(frame => frame.type === 'presence' && frame.action === 'subscribed'));
});

it('does not deliver to a removed DM member even when their Social grants remain active', async () => {
  for (const userId of ['alice', 'bob']) await backend.membershipStore.putMember({ channel: DM, userId, role: 'member',
    addedBy: 'alice', addedAt: new Date().toISOString(), historyFrom: null, removedAt: null });
  const alice = await connect(source('alice')), bob = await connect(source('bob')); await join(alice); await join(bob);
  const member = await backend.membershipStore.getMember(DM, 'bob');
  await backend.membershipStore.putMember({ ...member!, removedAt: new Date().toISOString() });
  await post(alice, 'Private after Leave'); expect(messages(bob)).toEqual([]);
});

it.each(['epoch', 'source-role', 'directory-outage'])('fails closed for a %s on an open source socket', async reason => {
  const alice = await connect(source('alice')); await join(alice);
  if (reason === 'epoch') users.get('alice')!.epoch++;
  if (reason === 'source-role') users.get('alice')!.grants.orgiq = ['sme'];
  if (reason === 'directory-outage') unavailable.add('alice');
  send(alice, { service: 'subscribe', action: 'subscribe', channel: 'orgiq:invoke' });
  await until(() => denied(alice).some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(alice.frames.some(frame => frame.type === 'subscribe' && frame.action === 'subscribed')).toBe(false);
  send(alice, { service: 'call', action: 'status', lobbyName: 'orgiq:initiative:test' });
  await until(() => denied(alice).some(frame => frame.service === 'call'));
});

it('awaits StartCall policy before routing or mutating state and resolves callId-only actions against current rights', async () => {
  const alice = await connect(source('alice')), bob = await connect(source('bob'));
  deniedActions.add('StartCall');
  const invite = { service: 'call', action: 'invite', callId: 'live-call', lobbyName: DM, callerId: 'alice', targetUserIds: ['bob'] };
  send(alice, invite); await until(() => denied(alice).some(frame => frame.service === 'call'));
  expect(bob.frames.some(frame => frame.type === 'call')).toBe(false);
  deniedActions.delete('StartCall'); send(alice, invite);
  await until(() => bob.frames.some(frame => frame.type === 'call' && frame.action === 'invite'));
  send(bob, { service: 'call', action: 'accepted', callId: 'live-call', lobbyName: DM, callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] });
  await until(() => alice.frames.some(frame => frame.type === 'call' && frame.action === 'accepted'));
  users.get('bob')!.grants.social = [];
  send(bob, { service: 'call', action: 'participant-state', callId: 'live-call', userId: 'bob', callerId: 'bob', participantId: 'removed-peer', targetUserIds: ['alice'] });
  await until(() => denied(bob).some(frame => frame.service === 'call'));
  expect(alice.frames.some(frame => frame.action === 'participant-state')).toBe(false);
  const previous = denied(bob).length;
  send(bob, { service: 'call', action: 'participant-state', callId: 'live-call', lobbyName: 'orgiq:dm:alice:bob',
    userId: 'bob', callerId: 'bob', participantId: 'forged-source-lobby', targetUserIds: ['alice'] });
  await until(() => denied(bob).length > previous);
  expect(alice.frames.some(frame => frame.action === 'participant-state')).toBe(false);
});

it('does not reuse masquerade authority after the operator loses current admin rights', async () => {
  users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 4, grants: { orgiq: ['admin'] } });
  const session: Session = { ...source('alice'), act: { sub: 'operator', epoch: 4, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } };
  const alice = await connect(session); await join(alice); users.get('operator')!.grants = { orgiq: ['member'] };
  send(alice, { service: 'chat', action: 'send', channel: DM, message: 'Retired operator' });
  await until(() => denied(alice).some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await backend.chatStore.listMessages(DM, 10)).toEqual([]);
});

it.each(['grant', 'epoch', 'source-role', 'directory-outage'])('does not ring a connected recipient after %s removal', async reason => {
  const alice = await connect(source('alice')), bob = await connect(source('bob'));
  if (reason === 'grant') users.get('bob')!.grants.social = [];
  if (reason === 'epoch') users.get('bob')!.epoch++;
  if (reason === 'source-role') users.get('bob')!.grants.orgiq = ['sme'];
  if (reason === 'directory-outage') unavailable.add('bob');
  await dispatched(alice, { service: 'call', action: 'invite', callId: `recipient-${reason}`, lobbyName: DM,
    callerId: 'alice', targetUserIds: ['bob'] });
  expect(bob.frames.some(frame => frame.type === 'call')).toBe(false);
});

it('filters notification history and reconnect replay by current grants while preserving the stored inbox', async () => {
  const bob = await connect(source('bob'));
  const service = handle.services.notification as unknown as { notifyUser(userId: string, data: unknown): Promise<{ record: { id: string }; delivered: number }> };
  const social = await service.notifyUser('bob', { title: 'Private DM', channel: DM, payload: { tenant: 'social', channel: DM }, action: { href: '/social/dms/example' } });
  const orgiq = await service.notifyUser('bob', { title: 'OrgIQ update', payload: { tenant: 'orgiq' }, action: { href: '/iq/projects' } });
  expect(social.delivered).toBe(1); expect(orgiq.delivered).toBe(1);
  users.get('bob')!.grants.social = [];
  await dispatched(bob, { service: 'notification', action: 'getHistory', userId: 'alice' });
  await until(() => bob.frames.some(frame => frame.type === 'notification:bulk-update'));
  expect(inboxItems(bob).map(row => row.id)).toEqual([orgiq.record.id]);
  const fresh = await connect(source('bob')); await until(() => inboxItems(fresh).length > 0);
  expect(inboxItems(fresh).map(row => row.id)).toEqual([orgiq.record.id]);
  users.get('bob')!.grants.social = ['participant'];
  const historyCount = bob.frames.filter(frame => frame.type === 'notification:bulk-update').length;
  await dispatched(bob, { service: 'notification', action: 'getHistory' });
  await until(() => bob.frames.filter(frame => frame.type === 'notification:bulk-update').length > historyCount);
  const latest = bob.frames.filter(frame => frame.type === 'notification:bulk-update').at(-1)!;
  expect((latest.payload as { notifications: Array<{ id: string }> }).notifications.map(row => row.id)).toEqual(expect.arrayContaining([social.record.id, orgiq.record.id]));
});

it('refuses retired notification mutations and delivers only to the current source connection of a user', async () => {
  const bob = await connect(source('bob'));
  users.get('bob')!.grants.orgiq = ['sme'];
  const service = handle.services.notification as unknown as { notifyUser(userId: string, data: unknown): Promise<{ record: { id: string }; delivered: number }> };
  const result = await service.notifyUser('bob', { title: 'Current user only', payload: { tenant: 'social' }, action: { href: '/social/teams' } });
  expect(result.delivered).toBe(0);
  expect(bob.frames.some(frame => frame.type === 'notification:new')).toBe(false);
  await dispatched(bob, { service: 'notification', action: 'markRead', id: result.record.id, userId: 'alice' });
  await until(() => denied(bob).some(frame => frame.code === 'AUTHZ_NOTIFICATION_DENIED'));
  expect(denied(bob).some(frame => frame.code === 'AUTHZ_NOTIFICATION_DENIED')).toBe(true);
  const current = await connect({ ...source('bob'), role: 'sme' }); await until(() => inboxItems(current).length > 0);
  expect(inboxItems(current).map(row => row.id)).toEqual([result.record.id]);
  const again = await service.notifyUser('bob', { title: 'One valid tab', payload: { tenant: 'social' }, action: { href: '/social/teams' } });
  expect(again.delivered).toBe(1);
  await until(() => current.frames.some(frame => frame.type === 'notification:new' && (frame.payload as { id: string }).id === again.record.id));
  expect(bob.frames.some(frame => frame.type === 'notification:new')).toBe(false);
});

it('delivers a callId-only terminal frame with its captured lobby after state deletion', async () => {
  const alice = await connect(source('alice')), bob = await connect(source('bob'));
  await dispatched(alice, { service: 'call', action: 'invite', callId: 'terminal-scope', lobbyName: DM, callerId: 'alice', targetUserIds: ['bob'] });
  await dispatched(bob, { service: 'call', action: 'accepted', callId: 'terminal-scope', callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] });
  await dispatched(alice, { service: 'call', action: 'cancelled', callId: 'terminal-scope', callerId: 'alice', targetUserIds: ['bob'] });
  await until(() => bob.frames.some(frame => frame.action === 'cancelled'));
  expect(bob.frames.find(frame => frame.action === 'cancelled')?.data).toMatchObject({ callId: 'terminal-scope', lobbyName: DM });
});
