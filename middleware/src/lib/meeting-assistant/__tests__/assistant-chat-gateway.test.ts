jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../../providers/projects.js', () => ({ getProject: jest.fn(), projectExists: jest.fn(async (id: string) => id === 'p-auth') }));
jest.mock('../../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [{ id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] }] }));

// Nova in the call chat over the REAL gateway: a seatless server post reaches seats live, a status change updates the
// same message, and no signed-in client can produce a Nova message. Harness: lib/__tests__/call-chat-gateway.test.ts.
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import request from '../../../test-support/http.js';
import { attachRealtimeGateway } from '../../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../../social-chat.js';
import { callChatChannel } from '../../call-chat.js';
import { callChatRouter } from '../../../routes/call-chat.js';
import { errorHandler } from '../../async-handler.js';
import { signRealtimeToken, realtimeClaims } from '../../realtime-token.js';
import { getUser } from '../../../providers/identity.js';
import { getProject } from '../../../providers/projects.js';
import type { Session } from '../../session.js';
import { setAssistantStore, MemoryAssistantStore, assistantStore } from '../index.js';
import { postNotice, postReply, postAction, moveAction, postAsAssistant } from '../chat.js';
import { NOVA_USER_ID } from '../chat-types.js';
import { VoiceRelay, voiceChannel } from '../voice.js';
import { sendThreadFrame } from '../../social-chat.js';

const SECRET = 'assistant-chat-test-secret';
type Frame = Record<string, unknown>; type Client = { ws: WebSocket; frames: Frame[]; user: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 4000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Gateway condition timed out'); await sleep(10); }
}
const callId = 'nova-call-chat'; const lobbyName = 'orgiq:initiative:p-auth'; const channel = callChatChannel(callId);
let sessions: Map<string, Session>; let app: express.Express; let server: http.Server;
let handle: Awaited<ReturnType<typeof attachRealtimeGateway>>; let backend: ReturnType<typeof createMemorySocialChatBackend>;
let clients: Client[]; let port: number; let previous: string | undefined; let warning: jest.SpyInstance;

async function connect(user: string): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(sessions.get(user)!), SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]); const frames: Frame[] = [];
  ws.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
  const client = { ws, frames, user }; clients.push(client); await until(() => frames.some(frame => frame.type === 'session')); return client;
}
const out = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const errors = (client: Client) => client.frames.filter(frame => frame.type === 'error');
const chatFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'chat' && frame.action === action && frame.channel === channel);
async function refusal(client: Client, act: () => void): Promise<Frame> {
  const before = errors(client).length; act();
  await until(() => errors(client).length > before);
  return errors(client).at(-1)!;
}
const errorCode = (frame: Frame) => String(frame.code ?? (frame.error as Frame | undefined)?.code ?? '');
async function join(client: Client) { out(client, { service: 'chat', action: 'join', channel }); await until(() => chatFrames(client, 'joined').length > 0); }
function send(client: Client, message: string, metadata: Frame) { out(client, { service: 'chat', action: 'send', channel, message, metadata }); }
const messageIn = (client: Client, action: string, pick: (m: Frame) => boolean) => chatFrames(client, action).map(f => f.message as Frame).find(pick);

beforeEach(async () => {
  previous = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  sessions = new Map(['alice', 'bob', 'charlie', NOVA_USER_ID].map(sub => [sub, { sub, name: `${sub} cookie`, tenant: 'orgiq', role: 'member', epoch: 0,
    grants: { orgiq: ['member'] }, iat: Math.floor(Date.now() / 1000) } as Session]));
  jest.mocked(getUser).mockImplementation(async id => sessions.has(id) ? { id, displayName: `${id} Directory`, epoch: 0,
    email: null, personId: null, grants: sessions.get(id)!.grants } : null);
  jest.mocked(getProject).mockResolvedValue({ id: 'p-auth', name: 'Auth Migration' } as Awaited<ReturnType<typeof getProject>>);
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
  app.use('/api/calls', callChatRouter); app.use(errorHandler);
  server = http.createServer(app); backend = createMemorySocialChatBackend({ fixtures: false });
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  clients = []; warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  setAssistantStore(new MemoryAssistantStore());
});
afterEach(async () => {
  clients.forEach(client => client.ws.close()); await handle.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
  setAssistantStore(null);
  warning.mockRestore(); if (previous === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previous;
});

async function startCall() {
  const alice = await connect('alice'); const bob = await connect('bob'); const charlie = await connect('charlie');
  out(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob', 'charlie'] });
  await until(() => bob.frames.some(frame => frame.type === 'call' && frame.action === 'invite'));
  out(bob, { service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] });
  await until(() => alice.frames.some(frame => frame.type === 'call' && frame.action === 'accepted'));
  for (const [client, userId] of [[alice, 'alice'], [bob, 'bob']] as const) out(client, { service: 'call', action: 'participant-state',
    callId, lobbyName, callerId: userId, userId, participantId: `pid-${userId}`, audioOn: true, cameraOn: false, screenSharing: false,
    targetUserIds: ['alice', 'bob'].filter(id => id !== userId) });
  await until(() => alice.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 2));
  return { alice, bob, charlie };
}
const invite = (by = 'alice') => assistantStore().create({ callId, tenant: 'orgiq', lobby: lobbyName, initiativeId: 'p-auth', state: 'listening', invitedBy: by,
  invitedAt: Date.now(), pausedBy: null, leftAt: null, leftBy: null, acked: [by], attendees: [by], presentAtInvite: [by], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] });

it('posts as Nova without a seat: seats get it live with the assistant keys, an outsider gets nothing, the author is the fixed identity', async () => {
  const { alice, bob, charlie } = await startCall(); await join(alice); await join(bob);
  await invite();
  const posted = await postNotice(callId, 'Nova joined at alice\'s invitation.');
  expect(posted).toMatchObject({ userId: NOVA_USER_ID, channel, metadata: { kind: 'assistant-notice', assistant: true, displayName: 'Nova' } });
  await until(() => !!messageIn(bob, 'message', m => m.id === posted!.id));
  expect(messageIn(bob, 'message', m => m.id === posted!.id)).toMatchObject({ userId: NOVA_USER_ID, message: 'Nova joined at alice\'s invitation.',
    metadata: { kind: 'assistant-notice', assistant: true, displayName: 'Nova' } });
  // A reader who reads later gets it from history, rendered with the keys.
  const replay = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob');
  expect(replay.body.messages).toHaveLength(1);
  expect(replay.body.messages[0]).toMatchObject({ userId: NOVA_USER_ID, metadata: { kind: 'assistant-notice', assistant: true } });
  await sleep(50);
  expect(charlie.frames.some(f => f.type === 'chat' && f.channel === channel && f.action === 'message')).toBe(false);
});

it('Nova\'s voice (assistant-audio) reaches only the sockets that joined the call chat, as a transient frame nothing stores', async () => {
  const { alice, bob, charlie } = await startCall(); await join(alice); await join(bob); // charlie holds no seat and never joined
  await invite();
  const sent: Frame[] = [];
  const relay = new VoiceRelay(callId, voiceChannel(callId), () => async (ch, frame) => { sent.push(frame as unknown as Frame); return sendThreadFrame(ch, frame); });
  const pcm = Buffer.alloc(4800, 5);
  relay.push(pcm, false); relay.push(pcm, true);
  const audio = (c: Client) => c.frames.filter(f => f.type === 'assistant-audio');
  await until(() => audio(bob).length === 2 && audio(alice).length === 2);
  expect(audio(bob).map(f => (f.data as Frame).seq)).toEqual([1, 2]);
  expect(audio(bob)[1]).toMatchObject({ type: 'assistant-audio', channel, data: { callId, sampleRate: 24000, last: true } });
  expect(Buffer.from(String((audio(bob)[0]!.data as Frame).pcm), 'base64')).toEqual(pcm);
  await sleep(50);
  expect(audio(charlie)).toEqual([]);
  expect(relay.relayed).toBe(2);
  // Nothing was stored: history is empty.
  const replay = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob');
  expect(replay.body.messages).toEqual([]);
  // A person who left the call chat stops getting it.
  out(bob, { service: 'chat', action: 'leave', channel }); await sleep(50);
  const before = audio(bob).length; relay.push(pcm, false); await until(() => audio(alice).length === 3); await sleep(30);
  expect(audio(bob)).toHaveLength(before);
});

it('without a gateway in this process the frame is not sent and the sink says so', async () => {
  await handle.dispose();
  expect(await sendThreadFrame(channel, { type: 'assistant-audio' })).toBe(false);
});

it('an action card is one message: a status change reaches readers as messageUpdated on the same id, and history shows one row', async () => {
  const { alice, bob } = await startCall(); await join(alice); await join(bob);
  await invite();
  const card = await postAction(callId, { actionId: 'act-1', askedBy: 'alice', askedByName: 'Alice', summary: 'Create work item "Login cookie bug"',
    detail: ['Assignee: Priya'], tool: { name: 'create_work_item', argsDigest: 'sha256:abc' } });
  expect(card?.created).toBe(true);
  await until(() => !!messageIn(bob, 'message', m => m.id === card!.message.id));
  expect(messageIn(bob, 'message', m => m.id === card!.message.id)).toMatchObject({ metadata: { kind: 'assistant-action', status: 'waiting', actionId: 'act-1', askedBy: 'alice' } });
  const moved = await moveAction(callId, 'act-1', { from: ['waiting'], to: 'confirmed', by: 'alice' });
  expect(moved).toMatchObject({ status: 'confirmed', decidedBy: 'alice', messageId: card!.message.id });
  await until(() => !!messageIn(bob, 'messageUpdated', m => m.id === card!.message.id));
  expect(messageIn(bob, 'messageUpdated', m => m.id === card!.message.id)).toMatchObject({ userId: NOVA_USER_ID, metadata: { kind: 'assistant-action', status: 'confirmed', summary: 'Create work item "Login cookie bug"', askedBy: 'alice' } });
  const replay = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'alice');
  expect(replay.body.messages).toHaveLength(1);
  expect(replay.body.messages[0].metadata).toMatchObject({ status: 'confirmed', detail: ['Assignee: Priya'] });
  // A second decision on a decided card does nothing.
  expect(await moveAction(callId, 'act-1', { from: ['waiting'], to: 'declined', by: 'alice' })).toBeNull();
});

it('no signed-in client can produce a Nova message', async () => {
  const { alice, bob } = await startCall(); await join(alice); await join(bob);
  await invite();
  // The keys are refused on the way in, whatever else the message carries.
  const forged: Frame[] = [{ assistant: true }, { kind: 'assistant-reply', askedBy: 'bob', askedByName: 'Bob' }, { kind: 'assistant-notice' },
    { assistant: false }, { kind: 'assistant-action', status: 'confirmed' }];
  for (const [i, metadata] of forged.entries()) {
    const frame = await refusal(alice, () => send(alice, 'Pretending', { clientDeliveryId: `forge-${i}`, ...metadata }));
    expect(errorCode(frame)).toBe('HUDDLE_CHAT_DENIED');
    expect(String((frame.error as Frame).message)).toMatch(/assistant/);
  }
  expect(await backend.chatStore.listMessages(channel, 50)).toEqual([]);
  // The author id: a connection signed in as the assistant's own id posts nothing and is told why.
  const impostor = await connect(NOVA_USER_ID);
  const refused = await refusal(impostor, () => send(impostor, 'I am Nova', { clientDeliveryId: 'nova-1' }));
  expect(errorCode(refused)).toBe('HUDDLE_CHAT_DENIED');
  expect(String((refused.error as Frame).message)).toBe('This author cannot post to a huddle conversation');
  expect(await backend.chatStore.listMessages(channel, 50)).toEqual([]);
  // Second lock, on the way out: a row a person authored that carries the keys (written straight to the store) renders without them.
  await backend.chatStore.putMessage({ id: 'forged-row', clientId: 'x', userId: 'alice', channel, message: 'forged', timestamp: new Date().toISOString(),
    metadata: { kind: 'assistant-action', assistant: true, actionId: 'a', askedBy: 'alice', askedByName: 'A', summary: 's', tool: { name: 't', argsDigest: '' }, status: 'waiting', displayName: 'Nova' } });
  const replay = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bob');
  const row = replay.body.messages.find((m: { id: string }) => m.id === 'forged-row');
  expect(row.userId).toBe('alice');
  expect(row.metadata.kind).toBeUndefined(); expect(row.metadata.assistant).toBeUndefined(); expect(row.metadata.status).toBeUndefined();
});

it('posts only while an assistant record exists and is not left, except the leave notice', async () => {
  await startCall();
  expect(await postNotice(callId, 'no record yet')).toBeNull();
  expect(await postReply(callId, { text: 'x', askedBy: 'alice', askedByName: 'Alice' })).toBeNull();
  expect(await postAction(callId, { actionId: 'a', askedBy: 'alice', askedByName: 'Alice', summary: 's', tool: { name: 't', argsDigest: '' } })).toBeNull();
  await invite();
  expect(await postNotice(callId, 'now there is')).not.toBeNull();
  await assistantStore().transition(callId, { from: ['listening'], to: 'left', by: 'alice', at: Date.now() });
  expect(await postNotice(callId, 'after leaving')).toBeNull();
  expect(await postAsAssistant(callId, { text: 'x', metadata: { assistant: true, displayName: 'Nova', kind: 'assistant-notice' } })).toBeNull();
  expect(await postNotice(callId, 'alice dismissed Nova.', { leaving: true })).not.toBeNull();
  expect((await backend.chatStore.listMessages(channel, 50)).map(m => m.message)).toEqual(['now there is', 'alice dismissed Nova.']);
});
