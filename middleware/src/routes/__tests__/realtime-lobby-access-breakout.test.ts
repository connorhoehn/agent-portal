// POST /api/realtime/lobby-access and /call-seat for a meeting room's lobby
// `<call lobby>~breakout~<room>` (docs/meeting-rooms-app-goal.md B3): the
// call's own lobby by today's rules AND the room admits the bearer now (its
// members and organizers; self-select: any open room). platform-api asks
// /call-seat with the call's `callId` and the room's `lobbyName`
// (../platform-api/src/routes/videoSessions.ts:132).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => false) }));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { MeetingService, type MeetingRouter } from '@connorhoehn/realtime-modules/meeting';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { pageResourceVisible } from '../../lib/page-resources.js';
import { CallMediaProofRuntime, setCallMediaProofRuntime } from '../../lib/call-media-proof.js';
import { admitChannel, bindMeetingRooms, lobbyGuard } from '../../lib/gateway/authority.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import type { Session } from '../../lib/session.js';
import { realtimeLobbyAccessRouter } from '../realtime-lobby-access.js';

const SECRET = 'breakout-lobby-secret';
const LOBBY = 'orgiq:initiative:p-1', OTHER = 'orgiq:initiative:p-2', CALL = 'call-1';
const room = (id: string, lobby = LOBBY) => `${lobby}~breakout~${id}`;
const signed = (sub: string): Session => ({ sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'] }, iat: 100 });
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, epoch: s.epoch, sessionIat: s.iat });
const token = async (sub: string) => (await signRealtimeToken(realtimeClaims(signed(sub)), SECRET)).token;
const app = express().use(express.json()).use('/api/realtime', realtimeLobbyAccessRouter)
  .use((e: { status?: number; message: string }, _q: unknown, s: express.Response, _n: unknown) => s.status(e.status ?? 500).json({ error: e.message }));

let users: Map<string, UserInfo>;
let service: MeetingService;
let calls: InMemoryCallStateStore;
const CLIENTS: Record<string, string> = { 'olive-socket': 'olive', 'bob-socket': 'bob', 'dan-socket': 'dan' };

beforeEach(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  users = new Map(['olive', 'bob', 'dan'].map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 0, grants: { orgiq: ['member'] } }]));
  jest.mocked(getUser).mockReset().mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  const meetingRouter: MeetingRouter = {
    sendToClient: () => true, sendToChannel: async () => undefined, subscribeToChannel: async () => true,
    getUserIdForClient: id => CLIENTS[id], getClientData: id => ({ userContext: { userId: CLIENTS[id]!, displayName: CLIENTS[id] } }),
    // realtime-modules 0.147.0 requires the router's channel check; this is the
    // gateway's own (the router's `authorize` is `admitChannel`).
    checkChannel: (kind, id, channel) => admitChannel({ kind, clientId: id, channel, ctx: ctx(signed(CLIENTS[id]!)) }),
  };
  service = new MeetingService({ router: meetingRouter, config: { isOrganizer: ({ userId }) => userId === 'olive' } });
  for (const clientId of Object.keys(CLIENTS)) await service.handleAction(clientId, 'subscribe', { meetingId: LOBBY });
  await service.handleAction('olive-socket', 'breakout.configure', { meetingId: LOBBY, mode: 'assigned',
    rooms: [{ id: 'r1', name: 'One', members: ['bob'] }, { id: 'r2', name: 'Two', members: ['dan'] }] });
  await service.handleAction('olive-socket', 'breakout.open', { meetingId: LOBBY, roomIds: ['r1'] });
  calls = new InMemoryCallStateStore();
  for (const clientId of Object.keys(CLIENTS)) await calls.registerParticipant(CALL, clientId, 'olive', LOBBY, []);
  await calls.markAccepted(CALL, 600);
  bindMeetingRooms({ service, lobbyOfCall: async id => (await calls.getCall(id))?.lobbyName ?? null });
  const sockets = new Map(Object.entries(CLIENTS).map(([clientId, sub]) => [clientId, ctx(signed(sub))]));
  const router = { isClientLive: (id: string) => sockets.has(id), getClientData: (id: string) => ({ userContext: sockets.get(id) }) } as RealtimeRouter;
  setCallMediaProofRuntime(new CallMediaProofRuntime({ calls, router, lobbyAllowed: lobbyGuard }));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { bindMeetingRooms(null); setCallMediaProofRuntime(null); service.dispose(); jest.restoreAllMocks(); });

const access = async (sub: string, lobbyName: string) =>
  request(app).post('/api/realtime/lobby-access').set('authorization', `Bearer ${await token(sub)}`).send({ lobbyName });
const seat = async (sub: string, lobbyName: string, callId = CALL) =>
  request(app).post('/api/realtime/call-seat').set('authorization', `Bearer ${await token(sub)}`)
    .send({ callId, lobbyName, clientId: `${sub}-socket` });

describe('POST /lobby-access for a room lobby', () => {
  it('the room\'s member and the organizer are allowed; a non-member is refused', async () => {
    expect((await access('bob', room('r1'))).body).toEqual({ allowed: true });
    expect((await access('olive', room('r1'))).status).toBe(200);
    expect((await access('dan', room('r1'))).status).toBe(403);
  });
  it('a closed room, an unknown room, another meeting\'s room and a malformed room are refused', async () => {
    expect((await access('dan', room('r2'))).status).toBe(403);
    expect((await access('bob', room('r9'))).status).toBe(403);
    expect((await access('bob', room('r1', OTHER))).status).toBe(403);
    expect((await access('bob', `${room('r1')}~breakout~r1`)).status).toBe(403);
  });
  it('the call\'s own lobby still decides: a gone initiative refuses the member', async () => {
    jest.mocked(pageResourceVisible).mockResolvedValue(false);
    expect((await access('bob', room('r1'))).status).toBe(403);
  });
  it('a name the RID family once read as an id is refused without a meeting', async () => {
    bindMeetingRooms(null);
    expect((await access('bob', room('r1'))).status).toBe(403);
    expect((await access('bob', 'orgiq:dm:bob:dan~breakout~r1')).status).toBe(403);
  });
});

describe('POST /call-seat for a room lobby', () => {
  it('the member\'s seat in the call is proven for the room lobby the leg is in', async () => {
    const res = await seat('bob', room('r1'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: true, callId: CALL, lobbyName: room('r1'), clientId: 'bob-socket', userId: 'bob' });
    expect((await seat('olive', room('r1'))).status).toBe(200);
  });
  it('a non-member, a closed room, an unknown room and another call\'s lobby are refused', async () => {
    expect((await seat('dan', room('r1'))).status).toBe(403);
    expect((await seat('dan', room('r2'))).status).toBe(403);
    expect((await seat('bob', room('r9'))).status).toBe(403);
    expect((await seat('bob', room('r1', OTHER))).status).toBe(403);
    expect((await seat('bob', `${room('r1')}~breakout~r1`)).status).toBe(403);
  });
  it('closing the rooms or ending the call refuses the proof', async () => {
    await service.handleAction('olive-socket', 'breakout.close', { meetingId: LOBBY });
    expect((await seat('bob', room('r1'))).status).toBe(403);
    await service.handleAction('olive-socket', 'breakout.open', { meetingId: LOBBY, roomIds: ['r1'] });
    expect((await seat('bob', room('r1'))).status).toBe(200);
    await calls.forgetCall(CALL);
    expect((await seat('bob', room('r1'))).status).toBe(403);
  });
});
