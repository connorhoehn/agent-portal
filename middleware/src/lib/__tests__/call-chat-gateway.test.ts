jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
// projectExists: the huddle's `orgiq:initiative:p-auth` lobby is asked on every call decision (lib/page-resources.ts).
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn(), projectExists: jest.fn(async (id: string) => id === 'p-auth') }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [{ id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] }] }));

// Huddle chat over the real gateway: the library ChatService, reactions and
// typing on `orgiq:huddle:<callId>`, admitted only to current seats of the
// call (live-principal authorizeHuddleChannel → CallChatRuntime.assertSeat),
// with join-boundary history from the call-chat membership mirror. Every
// refusal here is a frame or status the client actually receives.
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import request from '../../test-support/http.js';
import type { IncomingMessage } from 'node:http';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { attachRealtimeGateway, authenticateGatewayUpgrade } from '../realtime-gateway.js';
import { channelGuards } from '../gateway/authority.js';
import { createUploadsRouter, gatewayUploadConfig, resetGatewayUploadBackendForTests } from '../gateway-attachments.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { createMemorySocialChatBackend } from '../social-chat.js';
import { callChatChannel, callChatRuntime } from '../call-chat.js';
import { callChatRouter } from '../../routes/call-chat.js';
import { chatPinsRouter } from '../../routes/chat-pins.js';
import { errorHandler } from '../async-handler.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import { admitPublish, admitSubscribe } from '../gateway/authority.js';
import { sessionGatewayContext } from '../live-principal.js';
import { getUser } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import { getWorkItem } from '../../providers/work-items.js';
import type { Session } from '../session.js';

const SECRET = 'huddle-gateway-test-secret';
type Frame = Record<string, unknown>; type Client = { ws: WebSocket; frames: Frame[]; user: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 4000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Gateway condition timed out'); await sleep(10); }
}
const callId = 'actual-call-chat'; const lobbyName = 'orgiq:initiative:p-auth'; const channel = callChatChannel(callId);
let sessions: Map<string, Session>; let app: express.Express; let server: http.Server;
let handle: Awaited<ReturnType<typeof attachRealtimeGateway>>; let backend: ReturnType<typeof createMemorySocialChatBackend>;
let clients: Client[]; let port: number; let previous: string | undefined; let warning: jest.SpyInstance;
let uploads: ReturnType<typeof gatewayUploadConfig>;

async function connect(user: string): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(sessions.get(user)!), SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]); const frames: Frame[] = [];
  ws.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
  const client = { ws, frames, user }; clients.push(client); await until(() => frames.some(frame => frame.type === 'session')); return client;
}
const out = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const errors = (client: Client) => client.frames.filter(frame => frame.type === 'error');
const chatFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'chat' && frame.action === action && frame.channel === channel);
/** The next error frame this client receives after `act`. */
async function refusal(client: Client, act: () => void): Promise<Frame> {
  const before = errors(client).length; act();
  await until(() => errors(client).length > before);
  return errors(client).at(-1)!;
}
const NOT_ADMITTED = /^(AUTHZ_CHANNEL_DENIED|not-a-member)$/;
const errorCode = (frame: Frame) => String(frame.code ?? (frame.error as Frame | undefined)?.code ?? '');
async function join(client: Client) {
  out(client, { service: 'chat', action: 'join', channel });
  await until(() => chatFrames(client, 'joined').length > 0);
}
function send(client: Client, message: string, metadata: Frame) { out(client, { service: 'chat', action: 'send', channel, message, metadata }); }
async function acked(client: Client, count: number) { await until(() => chatFrames(client, 'sent').length >= count); return chatFrames(client, 'sent').at(-1)!; }
const received = (client: Client, id: string) => chatFrames(client, 'message').some(frame => (frame.message as Frame | undefined)?.id === id);

beforeEach(async () => {
  previous = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  resetGatewayUploadBackendForTests();
  uploads = { ...gatewayUploadConfig({ GATEWAY_UPLOADS: 'on' } as NodeJS.ProcessEnv), dir: mkdtempSync(joinPath(tmpdir(), 'huddle-uploads-')) };
  process.env['GATEWAY_UPLOADS'] = 'on'; process.env['GATEWAY_UPLOAD_DIR'] = uploads.dir;
  sessions = new Map(['alice', 'bob', 'charlie', 'dora'].map(sub => [sub, { sub, name: `${sub} cookie`, tenant: 'orgiq', role: 'member', epoch: 0,
    grants: { orgiq: ['member'] }, iat: Math.floor(Date.now() / 1000) } as Session]));
  // Dora is signed in to another tenant, with a Social grant but no OrgIQ one.
  sessions.set('dora', { ...sessions.get('dora')!, tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'], social: ['participant'] } });
  jest.mocked(getUser).mockImplementation(async id => sessions.has(id) ? { id, displayName: `${id} Directory`, epoch: 0,
    email: null, personId: null, grants: sessions.get(id)!.grants } : null);
  jest.mocked(getProject).mockResolvedValue({ id: 'p-auth', name: 'Auth Migration' } as Awaited<ReturnType<typeof getProject>>);
  jest.mocked(getWorkItem).mockResolvedValue({ id: 'wi-auth', projectId: 'p-auth', title: 'Cutover runbook' } as Awaited<ReturnType<typeof getWorkItem>>);
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
  app.use('/api/calls', callChatRouter); app.use('/api/chat', chatPinsRouter);
  app.use('/api/uploads', createUploadsRouter(token => authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as IncomingMessage),
    channelGuards, uploads));
  app.use(errorHandler);
  server = http.createServer(app); backend = createMemorySocialChatBackend({ fixtures: false });
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  clients = []; warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.close()); await handle.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env['GATEWAY_UPLOADS']; delete process.env['GATEWAY_UPLOAD_DIR']; resetGatewayUploadBackendForTests();
  warning.mockRestore(); if (previous === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previous;
});

/** Alice calls Bob (Charlie is invited but has not answered); both seats publish their state. */
async function startCall() {
  const alice = await connect('alice'); const bob = await connect('bob'); const charlie = await connect('charlie'); const bobOtherTab = await connect('bob');
  out(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob', 'charlie'] });
  await until(() => bob.frames.some(frame => frame.type === 'call' && frame.action === 'invite'));
  out(bob, { service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] });
  await until(() => alice.frames.some(frame => frame.type === 'call' && frame.action === 'accepted'));
  for (const [client, userId] of [[alice, 'alice'], [bob, 'bob']] as const) out(client, { service: 'call', action: 'participant-state',
    callId, lobbyName, callerId: userId, userId, participantId: `pid-${userId}`, audioOn: true, cameraOn: false, screenSharing: false,
    targetUserIds: ['alice', 'bob'].filter(id => id !== userId) });
  await until(() => alice.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 2));
  return { alice, bob, charlie, bobOtherTab };
}

it('carries persisted, acknowledged huddle chat with canonical references, receipts, typing and reactions only between seats', async () => {
  const { alice, bob, charlie, bobOtherTab } = await startCall();
  await join(alice); await join(bob);
  // Speaking/chatting in an admitted Work call does not acquire Social or
  // initiative-discussion write authority. These participants have only Work.
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob')).body).toMatchObject({ channel, canSend: true });
  expect(await admitSubscribe(sessionGatewayContext(sessions.get('bob')!), 'social:ch:auth-migration')).toBe(false);
  expect(await admitPublish(sessionGatewayContext(sessions.get('bob')!), lobbyName)).toBe(false);
  // An invited but unanswered person, another tab of a seated person, and a
  // token from another tenant cannot join, read, send, type or react.
  for (const outsider of [charlie, bobOtherTab]) {
    // Charlie is not a member at all (the chat service's own membership gate
    // answers first); Bob's other tab is a member's connection but not a seat.
    expect(errorCode(await refusal(outsider, () => out(outsider, { service: 'chat', action: 'join', channel })))).toMatch(NOT_ADMITTED);
    expect(errorCode(await refusal(outsider, () => out(outsider, { service: 'chat', action: 'history', channel })))).toMatch(NOT_ADMITTED);
    expect(errorCode(await refusal(outsider, () => send(outsider, 'Intrude', { clientDeliveryId: `intrude-${outsider.user}` })))).toBe('HUDDLE_CHAT_DENIED');
    expect(errorCode(await refusal(outsider, () => out(outsider, { service: 'chat', action: 'typing', channel, typing: true })))).toBe('AUTHZ_CHANNEL_DENIED');
    expect(errorCode(await refusal(outsider, () => out(outsider, { service: 'reaction', action: 'subscribe', channel })))).toBe('AUTHZ_CHANNEL_DENIED');
    // An in-call (floating, untargeted) reaction is refused to a non-seat too.
    expect(errorCode(await refusal(outsider, () => out(outsider, { service: 'reaction', action: 'send', channel, emoji: '🎉' })))).toBe('AUTHZ_CHANNEL_DENIED');
  }
  const dora = await connect('dora');
  expect(errorCode(await refusal(dora, () => out(dora, { service: 'chat', action: 'join', channel })))).toMatch(NOT_ADMITTED);

  send(alice, 'Actual huddle only', { clientDeliveryId: 'actual-delivery', pageReference: { kind: 'work-item', id: 'wi-auth' }, displayName: 'Forged' });
  const ack = await acked(alice, 1);
  const id = String(ack.messageId);
  await until(() => received(bob, id));
  const delivered = chatFrames(bob, 'message').find(frame => (frame.message as Frame).id === id)!.message as Frame;
  // The sender is stamped from the authenticated token, never the frame's 'Forged'.
  expect(delivered).toMatchObject({ userId: 'alice', message: 'Actual huddle only', channel, metadata: { displayName: 'alice cookie', clientDeliveryId: 'actual-delivery',
    pageReference: { status: 'available', kind: 'work-item', id: 'wi-auth', title: 'Cutover runbook', href: '/iq/projects/p-auth?tab=work&item=wi-auth' } } });
  expect(received(alice, id)).toBe(true);
  // Only the descriptor is stored; titles and routes are resolved per reader.
  expect((await backend.chatStore.listMessages(channel, 10))[0]!.metadata?.['pageReference']).toEqual({ kind: 'work-item', id: 'wi-auth' });
  const replay = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob');
  expect(replay.body.messages).toEqual([delivered]);
  await sleep(50);
  for (const outsider of [charlie, bobOtherTab, dora]) expect(outsider.frames.some(frame => frame.type === 'chat' && frame.channel === channel && frame.action !== undefined && frame.action !== 'joined' && ['message', 'history', 'typing'].includes(String(frame.action)))).toBe(false);

  // The same delivery id again: the original message and acknowledgement, never a second copy.
  send(alice, 'Actual huddle only', { clientDeliveryId: 'actual-delivery', pageReference: { kind: 'work-item', id: 'wi-auth' } });
  expect((await acked(alice, 2)).messageId).toBe(id);
  expect(await backend.chatStore.listMessages(channel, 10)).toHaveLength(1);
  expect(errorCode(await refusal(alice, () => send(alice, 'Different payload', { clientDeliveryId: 'actual-delivery' })))).toBe('HUDDLE_CHAT_DENIED');
  for (const metadata of [{}, { clientDeliveryId: 'forged', pageReference: { kind: 'work-item', id: 'wi-auth', href: 'https://evil.invalid' } },
    { clientDeliveryId: 'missing', pageReference: { kind: 'initiative', id: 'missing' } }]) {
    if (metadata.pageReference?.id === 'missing') jest.mocked(getProject).mockResolvedValueOnce(null);
    expect(errorCode(await refusal(alice, () => send(alice, 'Rejected', metadata)))).toBe('HUDDLE_CHAT_DENIED');
  }
  expect(await backend.chatStore.listMessages(channel, 10)).toHaveLength(1);
  // Member management, edits and deletes are not huddle actions; presence is not a huddle service.
  for (const frame of [{ action: 'addMembers', userIds: ['charlie'], history: { mode: 'all' } }, { action: 'removeMember', userId: 'bob' },
    { action: 'edit', messageId: id, message: 'Edited' }, { action: 'delete', messageId: id }, { action: 'members' }]) {
    expect(errorCode(await refusal(alice, () => out(alice, { service: 'chat', channel, ...frame })))).toBe('HUDDLE_CHAT_DENIED');
  }
  expect(errorCode(await refusal(alice, () => out(alice, { service: 'presence', action: 'subscribe', channel })))).toBe('AUTHZ_CHANNEL_DENIED');

  // Typing is the library's chat action on the same channel and gate.
  out(alice, { service: 'chat', action: 'typing', channel, typing: true });
  await until(() => chatFrames(bob, 'typing').some(frame => frame.userId === 'alice' && frame.typing === true));
  // Read receipts: the audience is the call's members.
  out(bob, { service: 'chat', action: 'read', channel, messageId: id, timestamp: delivered.timestamp });
  out(alice, { service: 'chat', action: 'receipts', channel });
  await until(() => alice.frames.some(frame => frame.type === 'chat' && frame.channel === channel && frame.action === 'receipts'));
  expect(alice.frames.find(frame => frame.type === 'chat' && frame.action === 'receipts')).toMatchObject({ enabled: true });
  // Reactions: seats subscribe and react; the reaction reaches the other seat only.
  for (const seat of [alice, bob]) {
    out(seat, { service: 'reaction', action: 'subscribe', channel });
    await until(() => seat.frames.some(frame => JSON.stringify(frame).includes('reaction_subscribed')));
  }
  out(bob, { service: 'reaction', action: 'send', channel, emoji: Object.keys({ '👍': 1 })[0], targetId: id });
  await until(() => alice.frames.some(frame => frame.type === 'reaction' && frame.action === 'reaction_received'));
  expect(charlie.frames.some(frame => frame.type === 'reaction')).toBe(false);
  expect(bobOtherTab.frames.some(frame => frame.type === 'reaction')).toBe(false);
  // A floating in-call reaction (no target) fans out to the other seat, and only to seats.
  const floated = alice.frames.length;
  out(bob, { service: 'reaction', action: 'send', channel, emoji: '🎉' });
  await until(() => alice.frames.slice(floated).some(frame => frame.type === 'reaction' && frame.action === 'reaction_received' && (frame.data as { emoji?: string }).emoji === '🎉'));
  expect(charlie.frames.some(frame => frame.type === 'reaction')).toBe(false);
  expect(bobOtherTab.frames.some(frame => frame.type === 'reaction')).toBe(false);

  // Attachments: the upload guard is the same seat authority. A seat gets an
  // upload URL and may PUT the bytes (REST asks the session's seat); others get nothing.
  out(alice, { service: 'fileupload', action: 'request-upload', channel, id: 'corr-a', filename: 'notes.txt', size: 5, metadata: { contentType: 'text/plain' } });
  await until(() => alice.frames.some(frame => frame.type === 'fileupload:url'));
  const url = alice.frames.find(frame => frame.type === 'fileupload:url')!;
  for (const outsider of [charlie, bobOtherTab]) out(outsider, { service: 'fileupload', action: 'request-upload', channel, id: 'corr-x', filename: 'x.txt', size: 1 });
  await sleep(100);
  for (const outsider of [charlie, bobOtherTab]) expect(outsider.frames.some(frame => frame.type === 'fileupload:url')).toBe(false);
  const token = async (user: string) => (await signRealtimeToken(realtimeClaims(sessions.get(user)!), SECRET)).token;
  const put = await request(app).put(`/api/uploads/${String(url.transferId)}`).set('Authorization', `Bearer ${await token('alice')}`)
    .set('Content-Type', 'text/plain').send('hello');
  expect(put.status).toBeLessThan(300);
  expect((await request(app).get(`/api/uploads/${String(url.transferId)}`).set('Authorization', `Bearer ${await token('bob')}`)).status).toBe(200);
  expect((await request(app).get(`/api/uploads/${String(url.transferId)}`).set('Authorization', `Bearer ${await token('charlie')}`)).status).toBe(403);

  // Pins: seats read and pin through the same participant authority; others are refused.
  expect((await request(app).post('/api/chat/pins').set('x-user', 'alice').send({ channel, messageId: id })).status).toBe(200);
  expect((await request(app).get('/api/chat/pins').set('x-user', 'bob').query({ channel })).body.pins).toEqual([expect.objectContaining({ messageId: id })]);
  expect((await request(app).get('/api/chat/message').set('x-user', 'bob').query({ channel, messageId: id })).body.message).toEqual(delivered);
  for (const outsider of ['charlie', 'dora']) {
    expect((await request(app).get('/api/chat/pins').set('x-user', outsider).query({ channel })).status).toBe(403);
    expect((await request(app).post('/api/chat/pins').set('x-user', outsider).send({ channel, messageId: id })).status).toBe(403);
    expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', outsider)).status).toBe(403);
  }
  // Nothing crossed into any other conversation.
  expect(await backend.chatStore.listMessages('social:ch:auth-migration', 100)).toEqual([]);
  expect(await backend.chatStore.listMessages(lobbyName, 100)).toEqual([]);
}, 30000);

it('starts a late joiner at the join boundary, and departure removes the subscription and every later read or write', async () => {
  const { alice, bob, charlie } = await startCall();
  await join(alice); await join(bob);
  send(alice, 'Before Charlie answered', { clientDeliveryId: 'early' });
  const early = String((await acked(alice, 1)).messageId);
  await sleep(5);
  out(charlie, { service: 'call', action: 'accepted', callId, lobbyName, callerId: 'charlie', userId: 'charlie', targetUserIds: ['alice'] });
  await until(() => alice.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 3));
  await join(charlie);
  out(charlie, { service: 'chat', action: 'history', channel });
  await until(() => chatFrames(charlie, 'history').length > 0 || errors(charlie).length > 0);
  await sleep(50);
  expect(chatFrames(charlie, 'history').flatMap(frame => (frame.messages as Frame[]).map(message => message.id))).not.toContain(early);
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'charlie')).body.messages).toEqual([]);
  send(alice, 'After Charlie answered', { clientDeliveryId: 'late' });
  const late = String((await acked(alice, 2)).messageId);
  await until(() => received(charlie, late));
  expect(received(charlie, early)).toBe(false);

  // Bob leaves: his existing subscription is removed, not merely left to the next check.
  out(bob, { service: 'call', action: 'user-status', callId, lobbyName, callerId: 'bob', userId: 'bob', status: 'left', targetUserIds: ['alice'] });
  out(bob, { service: 'call', action: 'ended', callId, lobbyName, callerId: 'bob', targetUserIds: ['bob'] });
  await until(() => alice.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 2));
  send(alice, 'After Bob left', { clientDeliveryId: 'after-bob' });
  const after = String((await acked(alice, 3)).messageId);
  await until(() => received(charlie, after)); await sleep(50);
  expect(received(bob, after)).toBe(false);
  expect(errorCode(await refusal(bob, () => out(bob, { service: 'chat', action: 'history', channel })))).toBe('AUTHZ_CHANNEL_DENIED');
  expect(errorCode(await refusal(bob, () => send(bob, 'From a departed seat', { clientDeliveryId: 'departed' })))).toBe('HUDDLE_CHAT_DENIED');
  expect(errorCode(await refusal(bob, () => out(bob, { service: 'chat', action: 'typing', channel, typing: true })))).toBe('AUTHZ_CHANNEL_DENIED');
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob')).status).toBe(403);
  expect((await request(app).get('/api/chat/pins').set('x-user', 'bob').query({ channel })).status).toBe(403);
  expect(await backend.chatStore.listMessages(channel, 10)).toHaveLength(3);
  // A revoked host grant is refused on the next frame, even for a current seat.
  sessions.set('charlie', { ...sessions.get('charlie')!, grants: { social: ['participant'] } });
  expect(errorCode(await refusal(charlie, () => send(charlie, 'Revoked', { clientDeliveryId: 'revoked' })))).toBe('HUDDLE_CHAT_DENIED');
  await expect(callChatRuntime().assertMember(callId, sessions.get('alice')!, true)).resolves.toBeUndefined();
}, 30000);
