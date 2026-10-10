jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn(), resolveSession: (req: { session?: unknown }) => req.session ?? null }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));

// An assessment team page's huddle (`assessment:team:<id>`) carries the same
// huddle conversation an OrgIQ call does (the team page's in-page block shows
// it beside the tiles): ordinary gateway chat on `orgiq:huddle:<callId>`,
// admitted only to current seats whose session stands in the lobby's tenant
// and holds the Social grant. Page references (initiative/work) stay OrgIQ's.
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import request from '../../test-support/http.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { attachRealtimeGateway } from '../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../social-chat.js';
import { callChatChannel } from '../call-chat.js';
import { callChatRouter } from '../../routes/call-chat.js';
import { errorHandler } from '../async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import type { Session } from '../session.js';

type Frame = Record<string, unknown>;
type Client = { ws: WebSocket; frames: Frame[] };
const SECRET = 'assessment-huddle-chat-contract';
const TEAM = 'assessment:team:TEAM-005';
const callId = 'team-huddle-1';
const channel = callChatChannel(callId);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 4000) throw new Error('Gateway receipt timed out'); await pause(10); }
}
const out = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const errorCode = (frame: Frame) => String(frame.code ?? (frame.error as Frame | undefined)?.code ?? '');
const errors = (client: Client) => client.frames.filter(frame => frame.type === 'error');
async function refusal(client: Client, act: () => void): Promise<Frame> {
  const before = errors(client).length; act();
  await until(() => errors(client).length > before);
  return errors(client).at(-1)!;
}
const chatFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'chat' && frame.action === action && frame.channel === channel);

let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>, app: express.Express;
let users: Map<string, UserInfo>, sessions: Map<string, Session>, clients: Client[], previousSecret: string | undefined;

const session = (sub: string, tenant: string, role: string, grants: Record<string, string[]>): Session =>
  ({ sub, name: sub, role, tenant, epoch: 0, grants, iat: Math.floor(Date.now() / 1000) }) as unknown as Session;

async function connect(sub: string): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(sessions.get(sub)!), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]), frames: [] as Frame[] };
  clients.push(client);
  client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  return client;
}

beforeEach(async () => {
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  clients = [];
  sessions = new Map([
    ['ana', session('ana', 'assessment', 'assessor', { assessment: ['assessor'], social: ['participant'] })],
    ['bea', session('bea', 'assessment', 'assessor', { assessment: ['assessor'], social: ['participant'] })],
    ['cy', session('cy', 'assessment', 'assessor', { assessment: ['assessor'], social: ['participant'] })],
    // An OrgIQ session with a Social grant: never a seat of an assessment huddle.
    ['oz', session('oz', 'orgiq', 'member', { orgiq: ['member'], social: ['participant'] })],
  ]);
  users = new Map([...sessions].map(([id, s]) => [id, { id, displayName: `${id} Directory`, epoch: 0, email: null, personId: null, grants: s.grants }]));
  jest.mocked(getUser).mockImplementation(async id => (users.has(id) ? structuredClone(users.get(id)!) : null));
  jest.mocked(isAllowed).mockImplementation(async (principal, action) =>
    (principal.tenant === 'assessment' && action === 'ViewAssessment')
    || (principal.tenant === 'orgiq' && action === 'ViewOrg')
    || (principal.tenant === 'social' && ['ViewSocial', 'PostMessage'].includes(action)));
  jest.mocked(pageResourceVisible).mockImplementation(async (_kind, bare) => bare === TEAM);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
  app.use('/api/calls', callChatRouter); app.use(errorHandler);
  server = http.createServer(app);
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: createMemorySocialChatBackend({ fixtures: false }), statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  jest.restoreAllMocks();
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});

it('gives an assessment team huddle its seat-scoped chat, without page references or OrgIQ seats', async () => {
  const ana = await connect('ana'); const bea = await connect('bea'); const oz = await connect('oz');
  out(ana, { service: 'call', action: 'invite', callId, lobbyName: TEAM, callerId: 'ana', callerName: 'ana', targetUserIds: ['bea'] });
  await until(() => bea.frames.some(frame => frame.type === 'call' && frame.action === 'invite'));
  out(bea, { service: 'call', action: 'accepted', callId, lobbyName: TEAM, callerId: 'bea', userId: 'bea', targetUserIds: ['ana'] });
  await until(() => ana.frames.some(frame => frame.type === 'call' && frame.action === 'accepted'));
  for (const [client, userId] of [[ana, 'ana'], [bea, 'bea']] as const) out(client, { service: 'call', action: 'participant-state',
    callId, lobbyName: TEAM, callerId: userId, userId, participantId: `pid-${userId}`, audioOn: true, cameraOn: false, screenSharing: false,
    targetUserIds: ['ana', 'bea'].filter(id => id !== userId) });
  await until(() => ana.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 2));

  // The resolver names the channel and its audience for a seat, and refuses an OrgIQ session.
  const resolved = await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bea');
  expect(resolved.status).toBe(200);
  expect(resolved.body).toMatchObject({ channel, canSend: true, participants: [{ userId: 'ana' }, { userId: 'bea' }] });
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'oz')).status).toBe(403);

  for (const seat of [ana, bea]) { out(seat, { service: 'chat', action: 'join', channel }); await until(() => chatFrames(seat, 'joined').length > 0); }
  out(ana, { service: 'chat', action: 'send', channel, message: 'Team huddle note', metadata: { clientDeliveryId: 'team-1' } });
  await until(() => chatFrames(ana, 'sent').length > 0);
  const id = String(chatFrames(ana, 'sent')[0]!.messageId);
  await until(() => chatFrames(bea, 'message').some(frame => (frame.message as Frame).id === id));

  // Initiative/work page references belong to OrgIQ huddles.
  expect(errorCode(await refusal(ana, () => out(ana, { service: 'chat', action: 'send', channel, message: 'With a page',
    metadata: { clientDeliveryId: 'team-2', pageReference: { kind: 'initiative', id: 'p-auth' } } })))).toBe('HUDDLE_CHAT_DENIED');
  // An OrgIQ session cannot join, read or post, even holding a Social grant.
  expect(errorCode(await refusal(oz, () => out(oz, { service: 'chat', action: 'join', channel })))).toMatch(/^(AUTHZ_CHANNEL_DENIED|not-a-member)$/);
  expect(errorCode(await refusal(oz, () => out(oz, { service: 'chat', action: 'send', channel, message: 'Intrude', metadata: { clientDeliveryId: 'oz' } })))).toBe('HUDDLE_CHAT_DENIED');
  await pause(50);
  expect(oz.frames.some(frame => frame.type === 'chat' && frame.channel === channel && ['message', 'history'].includes(String(frame.action)))).toBe(false);
}, 30000);

// A page huddle rings nobody: the footer's Huddle sends `join` (realtime-modules
// 0.111), so the gateway knows the call and its seats are whoever joined.
it('admits exactly the people seated by joining the lobby; a non-joined teammate, an outsider and a leaver are refused', async () => {
  const ana = await connect('ana'); const bea = await connect('bea'); const cy = await connect('cy'); const oz = await connect('oz');
  const join = (client: Client, userId: string) => out(client, { service: 'call', action: 'join', callId, lobbyName: TEAM, callerId: userId, callerName: userId });
  const announce = (client: Client, userId: string, targets: string[]) => out(client, { service: 'call', action: 'participant-state',
    callId, lobbyName: TEAM, callerId: userId, userId, participantId: `pid-${userId}`, audioOn: true, cameraOn: false, screenSharing: false, targetUserIds: targets });
  join(ana, 'ana'); await pause(100);
  join(bea, 'bea'); await pause(100);
  // The outsider's join is refused by the lobby guard; the teammate who never joined has no seat.
  join(oz, 'oz'); await pause(100);
  announce(ana, 'ana', ['bea']); announce(bea, 'bea', ['ana']);
  await until(() => ana.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 2));

  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bea')).body).toMatchObject({ channel, canSend: true, participants: [{ userId: 'ana' }, { userId: 'bea' }] });
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'cy')).status).toBe(403);
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'oz')).status).toBe(403);
  for (const seat of [ana, bea]) { out(seat, { service: 'chat', action: 'join', channel }); await until(() => chatFrames(seat, 'joined').length > 0); }
  out(ana, { service: 'chat', action: 'send', channel, message: 'Joined-lobby note', metadata: { clientDeliveryId: 'join-1' } });
  await until(() => chatFrames(ana, 'sent').length > 0);
  const id = String(chatFrames(ana, 'sent')[0]!.messageId);
  await until(() => chatFrames(bea, 'message').some(frame => (frame.message as Frame).id === id));
  expect(errorCode(await refusal(cy, () => out(cy, { service: 'chat', action: 'join', channel })))).toMatch(/^(AUTHZ_CHANNEL_DENIED|not-a-member)$/);
  expect(errorCode(await refusal(cy, () => out(cy, { service: 'chat', action: 'send', channel, message: 'Not seated', metadata: { clientDeliveryId: 'cy' } })))).toBe('HUDDLE_CHAT_DENIED');
  expect(cy.frames.some(frame => frame.type === 'chat' && frame.channel === channel && ['message', 'history'].includes(String(frame.action)))).toBe(false);

  // Leaving is the ordinary terminal verb aimed at yourself: the seat is gone.
  out(bea, { service: 'call', action: 'ended', callId, lobbyName: TEAM, callerId: 'bea', targetUserIds: ['bea'] });
  await until(() => ana.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 1));
  expect((await request(app).get(`/api/calls/${callId}/chat`).set('x-user', 'bea')).status).toBe(403);
  expect(errorCode(await refusal(bea, () => out(bea, { service: 'chat', action: 'send', channel, message: 'After leaving', metadata: { clientDeliveryId: 'bea-2' } })))).toBe('HUDDLE_CHAT_DENIED');
}, 30000);
