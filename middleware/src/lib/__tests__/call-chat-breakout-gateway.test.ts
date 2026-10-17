jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn(), projectExists: jest.fn(async (id: string) => id === 'p-auth') }));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [{ id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] }] }));

// A meeting room's chat over the real gateway (docs/meeting-rooms-app-goal.md
// M2): `orgiq:huddle:<callId>~breakout~<roomId>` is the same call's huddle,
// scoped to the room. Its members are the call's seats in that room plus the
// meeting's organizers; sends carry the huddle contract; the call's end
// finishes it. Alice calls (the organizer), Bob is in r1, Charlie in r2.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import { attachRealtimeGateway } from '../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../social-chat.js';
import { CallChatRuntime, callChatRuntime, roomChatChannel } from '../call-chat.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../session.js';
import type { MeetingService } from '@connorhoehn/realtime-modules/meeting';

const SECRET = 'huddle-breakout-test-secret';
type Frame = Record<string, unknown>; type Client = { ws: WebSocket; frames: Frame[]; user: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 4000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Gateway condition timed out'); await sleep(10); }
}
const callId = 'breakout-call'; const lobbyName = 'orgiq:initiative:p-auth';
const r1 = roomChatChannel(callId, 'r1'); const r2 = roomChatChannel(callId, 'r2');
let sessions: Map<string, Session>; let server: http.Server; let port: number; let clients: Client[];
let handle: ReturnType<typeof attachRealtimeGateway>; let backend: ReturnType<typeof createMemorySocialChatBackend>;
let previous: string | undefined; let warning: jest.SpyInstance;

async function connect(user: string): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(sessions.get(user)!), SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]); const frames: Frame[] = [];
  ws.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
  const client = { ws, frames, user }; clients.push(client); await until(() => frames.some(frame => frame.type === 'session')); return client;
}
const out = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const errors = (client: Client) => client.frames.filter(frame => frame.type === 'error');
const errorCode = (frame: Frame) => String(frame.code ?? (frame.error as Frame | undefined)?.code ?? '');
const chatFrames = (client: Client, channel: string, action: string) => client.frames.filter(frame => frame.type === 'chat' && frame.action === action && frame.channel === channel);
const received = (client: Client, channel: string, id: string) => chatFrames(client, channel, 'message').some(frame => (frame.message as Frame | undefined)?.id === id);
async function refusal(client: Client, act: () => void): Promise<Frame> {
  const before = errors(client).length; act();
  await until(() => errors(client).length > before);
  return errors(client).at(-1)!;
}
async function join(client: Client, channel: string) {
  out(client, { service: 'chat', action: 'join', channel });
  await until(() => chatFrames(client, channel, 'joined').length > 0);
}
const send = (client: Client, channel: string, message: string, deliveryId: string) =>
  out(client, { service: 'chat', action: 'send', channel, message, metadata: { clientDeliveryId: deliveryId } });
const NOT_ADMITTED = /^(AUTHZ_CHANNEL_DENIED|not-a-member)$/;
const meetingFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'meeting' && frame.action === action);

beforeEach(async () => {
  previous = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  sessions = new Map(['alice', 'bob', 'charlie'].map(sub => [sub, { sub, name: sub, tenant: 'orgiq', role: 'member', epoch: 0,
    grants: { orgiq: ['member'] }, iat: Math.floor(Date.now() / 1000) } as Session]));
  jest.mocked(getUser).mockImplementation(async id => sessions.has(id) ? { id, displayName: id, epoch: 0, email: null, personId: null, grants: sessions.get(id)!.grants } : null);
  server = http.createServer(express()); backend = createMemorySocialChatBackend({ fixtures: false });
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  clients = []; warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.close()); await handle.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
  warning.mockRestore(); if (previous === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previous;
});

/** Alice calls Bob and Charlie, both answer; everyone follows the meeting; Alice opens r1 (Bob) and r2 (Charlie). */
async function callWithRooms() {
  const alice = await connect('alice'); const bob = await connect('bob'); const charlie = await connect('charlie');
  out(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob', 'charlie'] });
  await until(() => [bob, charlie].every(c => c.frames.some(frame => frame.type === 'call' && frame.action === 'invite')));
  for (const [client, userId] of [[bob, 'bob'], [charlie, 'charlie']] as const) {
    out(client, { service: 'call', action: 'accepted', callId, lobbyName, callerId: userId, userId, targetUserIds: ['alice'] });
  }
  await until(() => alice.frames.some(frame => frame.type === 'call-chat' && frame.action === 'members' && (frame.participants as unknown[])?.length === 3));
  for (const client of [alice, bob, charlie]) out(client, { service: 'meeting', action: 'subscribe', meetingId: lobbyName });
  await until(() => [alice, bob, charlie].every(c => meetingFrames(c, 'meeting.snapshot').length > 0));
  expect((meetingFrames(alice, 'meeting.snapshot')[0]!.data as { you: { organizer: boolean } }).you.organizer).toBe(true);
  expect((meetingFrames(bob, 'meeting.snapshot')[0]!.data as { you: { organizer: boolean } }).you.organizer).toBe(false);
  out(alice, { service: 'meeting', action: 'breakout.configure', meetingId: lobbyName, mode: 'assigned',
    rooms: [{ id: 'r1', name: 'One', members: ['bob'] }, { id: 'r2', name: 'Two', members: ['charlie'] }] });
  out(alice, { service: 'meeting', action: 'breakout.open', meetingId: lobbyName });
  await until(() => [bob, charlie].every(c => meetingFrames(c, 'breakout.changed')
    .some(frame => (frame.data as { breakout: { phase: string } }).breakout.phase === 'open')));
  return { alice, bob, charlie };
}

it('a room member joins and sends under the huddle contract; a seat outside the room is refused; the organizer joins any room', async () => {
  const { alice, bob, charlie } = await callWithRooms();
  await join(bob, r1);
  await join(alice, r1);
  await join(alice, r2);
  await join(charlie, r2);
  // Charlie is a seat of the call but not in r1: no join, read or send.
  expect(errorCode(await refusal(charlie, () => out(charlie, { service: 'chat', action: 'join', channel: r1 })))).toMatch(NOT_ADMITTED);
  expect(errorCode(await refusal(charlie, () => out(charlie, { service: 'chat', action: 'history', channel: r1 })))).toMatch(NOT_ADMITTED);
  expect(errorCode(await refusal(charlie, () => send(charlie, r1, 'Intrude', 'intrude')))).toBe('HUDDLE_CHAT_DENIED');

  send(bob, r1, 'Room one only', 'room-one');
  await until(() => chatFrames(bob, r1, 'sent').length > 0);
  const id = String(chatFrames(bob, r1, 'sent')[0]!.messageId);
  await until(() => received(alice, r1, id));
  expect((chatFrames(alice, r1, 'message').at(-1)!.message as Frame)).toMatchObject({ userId: 'bob', channel: r1, metadata: { clientDeliveryId: 'room-one' } });
  // The huddle contract: a delivery id is required, a retry answers with the original.
  expect(errorCode(await refusal(bob, () => out(bob, { service: 'chat', action: 'send', channel: r1, message: 'No id' })))).toBe('HUDDLE_CHAT_DENIED');
  send(bob, r1, 'Room one only', 'room-one');
  await until(() => chatFrames(bob, r1, 'sent').length > 1);
  expect(chatFrames(bob, r1, 'sent')[1]!.messageId).toBe(id);
  expect(await backend.chatStore.listMessages(r1, 10)).toHaveLength(1);
  await sleep(50);
  expect(received(charlie, r1, id)).toBe(false);
  // The organizer posts to a room he is not a member of.
  send(alice, r2, 'From the organizer', 'org-r2');
  await until(() => chatFrames(alice, r2, 'sent').length > 0);
  await until(() => received(charlie, r2, String(chatFrames(alice, r2, 'sent')[0]!.messageId)));
}, 30000);

it('after the call ends the room channels are gone', async () => {
  const { alice, bob, charlie } = await callWithRooms();
  await join(bob, r1);
  const unsubscribed = jest.spyOn(handle.router, 'unsubscribeFromChannel');
  const finished = jest.spyOn(CallChatRuntime.prototype, 'finish');
  for (const [client, userId] of [[bob, 'bob'], [charlie, 'charlie'], [alice, 'alice']] as const) {
    out(client, { service: 'call', action: 'user-status', callId, lobbyName, callerId: userId, userId, status: 'left', targetUserIds: [] });
    out(client, { service: 'call', action: 'ended', callId, lobbyName, callerId: userId, targetUserIds: [userId] });
  }
  // The call's terminal cleanup (onCallEnded → finish) leaves the rooms' chats with the huddle's.
  await until(() => finished.mock.calls.some(([id]) => id === callId));
  await finished.mock.results.find((_, index) => finished.mock.calls[index]![0] === callId)!.value;
  await until(() => unsubscribed.mock.calls.some(([, channel]) => channel === r1));
  expect(unsubscribed.mock.calls.some(([, channel]) => channel === `reactions:${r1}`)).toBe(true);
  const rows = await callChatRuntime().roomMemberRows(callId, 'r1');
  expect(rows.every(row => row.removedAt !== null)).toBe(true);
  expect(errorCode(await refusal(bob, () => out(bob, { service: 'chat', action: 'join', channel: r1 })))).toMatch(NOT_ADMITTED);
  expect(errorCode(await refusal(bob, () => send(bob, r1, 'After the end', 'after-end')))).toBe('HUDDLE_CHAT_DENIED');
}, 30000);

it('the call\'s end resets its meeting: the next call in the lobby starts with no rooms, hands or announcements', async () => {
  const { alice, bob, charlie } = await callWithRooms();
  const meeting = handle.services['meeting'] as MeetingService;
  out(bob, { service: 'meeting', action: 'hand.raise', meetingId: lobbyName });
  out(alice, { service: 'meeting', action: 'breakout.broadcast', meetingId: lobbyName, message: 'Five minutes left' });
  await until(() => bob.frames.some(frame => frame.type === 'meeting' && frame.action === 'breakout.announcement'));
  await until(() => meetingFrames(alice, 'hands.changed').some(frame => (frame.data as { hands: unknown[] }).hands.length === 1));
  const before = (await meeting.getState(lobbyName))!;
  expect(before.breakout.phase).toBe('open');
  expect(before.breakout.announcements).toHaveLength(1);

  for (const [client, userId] of [[bob, 'bob'], [charlie, 'charlie'], [alice, 'alice']] as const) {
    out(client, { service: 'call', action: 'user-status', callId, lobbyName, callerId: userId, userId, status: 'left', targetUserIds: [] });
    out(client, { service: 'call', action: 'ended', callId, lobbyName, callerId: userId, targetUserIds: [userId] });
  }
  await until(() => !!meetingFrames(alice, 'breakout.changed').some(frame => (frame.data as { breakout: { phase: string } }).breakout.phase === 'none'));
  const after = (await meeting.getState(lobbyName))!;
  expect(after.version).toBeGreaterThan(before.version);
  expect(after).toMatchObject({ createdBy: before.createdBy, hands: [],
    breakout: { phase: 'none', rooms: [], announcement: null, announcements: [], endsAt: null } });

  // A new call in the same lobby: a fresh follower's snapshot has nothing of the last one.
  const follower = await connect('charlie');
  out(follower, { service: 'meeting', action: 'subscribe', meetingId: lobbyName });
  await until(() => meetingFrames(follower, 'meeting.snapshot').length > 0);
  expect(meetingFrames(follower, 'meeting.snapshot')[0]!.data).toMatchObject({ hands: [], breakout: { phase: 'none', rooms: [], announcements: [] } });
  expect(await meeting.admitsBreakoutLobby('bob', `${lobbyName}~breakout~r1`)).toBe(false);
}, 30000);
