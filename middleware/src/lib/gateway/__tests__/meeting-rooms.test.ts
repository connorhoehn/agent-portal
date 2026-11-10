// Meeting rooms under the authority facade (docs/meeting-rooms-app-goal.md M2,
// B2/B3): a breakout room's lobby, a meeting's own channel and a room's chat,
// decided against a real MeetingService and one directory world.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []) }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
jest.mock('../../initiative-scope.js', () => ({ stewardsInitiative: jest.fn(async () => false) }));
jest.mock('../../gateway-run-feed.js', () => ({ publishChannelActivity: jest.fn(async () => undefined) }));
// The huddle's own seat rule is call-chat's (its suites pin it); here a seat is a set entry.
jest.mock('../../live-principal.js', () => {
  const actual = jest.requireActual('../../live-principal.js');
  return { ...actual, authorizeHuddleChannel: jest.fn() };
});
import { MeetingService, type MeetingRouter } from '@connorhoehn/realtime-modules/meeting';
import { getUser, type UserInfo } from '../../../providers/identity.js';
import { isAllowed } from '../../authz.js';
import { pageResourceVisible } from '../../page-resources.js';
import { stewardsInitiative } from '../../initiative-scope.js';
import { publishChannelActivity } from '../../gateway-run-feed.js';
import { authorizeHuddleChannel, sessionGatewayContext } from '../../live-principal.js';
import {
  admitCall, admitChannel, admitMeetingRoom, bindMeetingRooms, callGuards, channelGuard, lobbyGuard,
  meetingOrganizer, noStoredCall, splitMeetingRoom, verdictCacheable,
} from '../authority.js';
import { breakoutActivity } from '../meeting.js';
import { tenantChannelFamily } from '../../tenant-channels.js';
import type { Grants, Session } from '../../session.js';

const LOBBY = 'orgiq:initiative:p-1';
const OTHER = 'orgiq:initiative:p-2';
const CALL = 'call-1';
const room = (id: string, lobby = LOBBY) => `${lobby}~breakout~${id}`;
const DIRECTORY: Record<string, Grants> = {
  olive: { orgiq: ['member'] }, // the organizer
  bob: { orgiq: ['member'] },   // in room r1
  carol: { orgiq: ['member'] }, // in room r2 (closed)
  dan: { orgiq: ['member'] },   // in no room
  mod: { orgiq: ['member'], social: ['moderator'] },
  pat: { pipelines: ['operator'] },
};
const POLICY: Record<string, Record<string, string[]>> = {
  orgiq: { member: ['ViewOrgChart'] }, pipelines: { operator: ['ViewPipelines'] },
  social: { moderator: ['ViewSocial', 'ManageChannels'] },
};
const session = (sub: string, tenant = Object.keys(DIRECTORY[sub]!)[0]!): Session => ({
  sub, name: sub, tenant: tenant as Session['tenant'], role: DIRECTORY[sub]![tenant]![0] as Session['role'],
  epoch: 0, grants: structuredClone(DIRECTORY[sub]!), iat: 1_700_000_000,
});
const ctx = (sub: string, tenant?: string) => sessionGatewayContext(session(sub, tenant), value => Number(value ?? 0));

let users: Map<string, UserInfo>;
let visible: Set<string>;
let service: MeetingService;
let errors: unknown[];
let seats: Set<string>;
let lobbies: Map<string, string>;
const CLIENTS: Record<string, string> = { 'c-olive': 'olive', 'c-bob': 'bob', 'c-carol': 'carol', 'c-dan': 'dan' };

/** The meeting as the organizer leaves it: assigned mode, r1 (bob) open, r2 (carol) closed. */
async function openRooms(mode: 'assigned' | 'self-select' = 'assigned') {
  await service.handleAction('c-olive', 'breakout.configure', { meetingId: LOBBY, mode,
    rooms: [{ id: 'r1', name: 'One', members: ['bob'] }, { id: 'r2', name: 'Two', members: ['carol'] }] });
  await service.handleAction('c-olive', 'breakout.open', { meetingId: LOBBY, roomIds: ['r1'] });
  expect(errors).toEqual([]);
}

beforeEach(async () => {
  visible = new Set([LOBBY, OTHER]);
  users = new Map(Object.entries(DIRECTORY).map(([id, grants]) => [id, { id, displayName: id, epoch: 0, email: null, personId: null, grants: structuredClone(grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.has(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => (POLICY[principal.tenant]?.[principal.role] ?? []).includes(action));
  jest.mocked(pageResourceVisible).mockImplementation(async (_kind, bare) => visible.has(bare));
  jest.mocked(stewardsInitiative).mockResolvedValue(false);
  seats = new Set(); lobbies = new Map([[CALL, LOBBY]]);
  jest.mocked(authorizeHuddleChannel).mockImplementation(async (args, base) => seats.has(`${args.clientId}|${base}`) && args.channel.endsWith(base));
  errors = [];
  const router: MeetingRouter = {
    sendToClient: (_id, frame) => { if ((frame as { action?: string }).action === 'error') errors.push(frame); return true; },
    sendToChannel: async () => undefined,
    subscribeToChannel: async () => true,
    getUserIdForClient: id => CLIENTS[id],
    getClientData: id => ({ userContext: { userId: CLIENTS[id]!, displayName: CLIENTS[id] } }),
    // realtime-modules 0.147.0 requires the router's channel check; this is the
    // gateway's own (the router's `authorize` is `admitChannel`).
    checkChannel: (kind, id, channel) => admitChannel({ kind, clientId: id, channel, ctx: ctx(CLIENTS[id]!) }),
  };
  service = new MeetingService({ router, config: { isOrganizer: ({ userId }) => userId === 'olive' } });
  for (const clientId of Object.keys(CLIENTS)) await service.handleAction(clientId, 'subscribe', { meetingId: LOBBY });
  bindMeetingRooms({ service, lobbyOfCall: async callId => lobbies.get(callId) ?? null });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { bindMeetingRooms(null); service.dispose(); jest.restoreAllMocks(); });

const join = (sub: string, lobbyName: string, action = 'join') => admitCall(ctx(sub), action, { lobbyName }, callGuards(noStoredCall));

describe('a breakout lobby (B3: lobbyGuard and admitCall)', () => {
  it('admits a room member, refuses a non-member, admits the organizer (assigned mode)', async () => {
    await openRooms();
    expect(await join('bob', room('r1'))).toBe(true);
    expect(lobbyGuard(ctx('bob'), room('r1'))).toBe(true);
    expect(await join('dan', room('r1'))).toBe(false);
    expect(lobbyGuard(ctx('dan'), room('r1'))).toBe(false);
    expect(await join('olive', room('r1'))).toBe(true);
    expect(lobbyGuard(ctx('olive'), room('r1'))).toBe(true);
  });
  it('refuses a forged room: another member\'s room in assigned mode', async () => {
    await openRooms();
    await service.handleAction('c-olive', 'breakout.open', { meetingId: LOBBY, roomIds: ['r2'] });
    expect(await join('carol', room('r2'))).toBe(true);
    expect(await join('bob', room('r2'))).toBe(false);
    expect(lobbyGuard(ctx('bob'), room('r2'))).toBe(false);
  });
  it('refuses a closed room, an unknown room and another meeting\'s room', async () => {
    await openRooms();
    expect(await join('carol', room('r2'))).toBe(false);
    expect(await join('bob', room('nope'))).toBe(false);
    expect(await join('bob', room('r1', OTHER))).toBe(false);
    expect(lobbyGuard(ctx('bob'), room('r1', OTHER))).toBe(false);
  });
  it('self-select: any open room, still never a closed one', async () => {
    await openRooms('self-select');
    expect(await join('dan', room('r1'))).toBe(true);
    expect(await join('dan', room('r2'))).toBe(false);
  });
  it('the room asks the call\'s own lobby too: a gone page or another tenant refuses', async () => {
    await openRooms('self-select');
    expect(await join('pat', room('r1'))).toBe(false);
    visible.delete(LOBBY);
    expect(await join('bob', room('r1'))).toBe(false);
  });
  it('only a join: no frame creates, rings or answers a call in a room', async () => {
    await openRooms();
    for (const action of ['invite', 'accept', 'decline']) expect([action, await join('bob', room('r1'), action)]).toEqual([action, false]);
  });
  it('rooms end with the session: closing all rooms refuses the member', async () => {
    await openRooms();
    await service.handleAction('c-olive', 'breakout.close', { meetingId: LOBBY });
    expect(await join('bob', room('r1'))).toBe(false);
    expect(lobbyGuard(ctx('bob'), room('r1'))).toBe(false);
  });
  it('an unbound meeting service refuses every room', async () => {
    await openRooms();
    bindMeetingRooms(null);
    expect(await join('bob', room('r1'))).toBe(false);
    expect(await admitMeetingRoom('bob', room('r1'))).toBe(false);
  });
});

describe('a breakout name never reaches the family RID match (decision 2)', () => {
  it('the families do not read the suffix as an id', () => {
    expect(tenantChannelFamily(LOBBY)?.id).toBe('orgiq:initiative');
    expect(tenantChannelFamily(room('r1'))).toBeNull();
    expect(tenantChannelFamily('orgiq:session:s~breakout~r1')).toBeNull();
  });
  it('with no meeting, a name that once matched orgiq:initiative or a DM is refused', async () => {
    expect(await join('bob', room('r1'))).toBe(false);
    expect(lobbyGuard(ctx('bob'), 'orgiq:dm:bob:dan~breakout~r1')).toBe(false);
    expect(await join('bob', 'orgiq:dm:bob:dan~breakout~r1')).toBe(false);
    expect(channelGuard(ctx('bob'), room('r1'))).toBe(false);
    expect(await admitChannel({ kind: 'subscribe', clientId: 'c-bob', channel: room('r1'), ctx: ctx('bob') })).toBe(false);
  });
  it('malformed rooms are refused even for a member: a bad room id, a room of a room', async () => {
    await openRooms();
    expect(splitMeetingRoom(`${LOBBY}~breakout~bad!`)).toBe(false);
    expect(splitMeetingRoom(`${room('r1')}~breakout~r1`)).toBe(false);
    expect(await join('bob', `${LOBBY}~breakout~bad!`)).toBe(false);
    expect(await join('bob', `${room('r1')}~breakout~r1`)).toBe(false);
    expect(lobbyGuard(ctx('bob'), `${room('r1')}~breakout~r1`)).toBe(false);
  });
});

describe('the meeting channel `meeting:<lobby>` follows the base lobby (B2)', () => {
  const sub = (who: string, channel: string, kind: 'subscribe' | 'publish' = 'subscribe', tenant?: string) =>
    admitChannel({ kind, clientId: `c-${who}`, channel, ctx: ctx(who, tenant) });
  it('admitted exactly when the lobby admits a call join', async () => {
    expect(await sub('dan', `meeting:${LOBBY}`)).toBe(true);
    expect(await join('dan', LOBBY)).toBe(true);
    expect(await sub('pat', `meeting:${LOBBY}`)).toBe(false);
    expect(await join('pat', LOBBY)).toBe(false);
    visible.delete(LOBBY);
    expect(await sub('dan', `meeting:${LOBBY}`)).toBe(false);
    expect(await join('dan', LOBBY)).toBe(false);
  });
  it('subscribe only; never a non-lobby, a room or a prefixed name', async () => {
    expect(await sub('dan', `meeting:${LOBBY}`, 'publish')).toBe(false);
    expect(await sub('dan', 'meeting:orgiq:work:w-1')).toBe(false);
    expect(await sub('dan', 'meeting:orgiq:huddle:call-1')).toBe(false);
    expect(await sub('bob', `meeting:${room('r1')}`)).toBe(false);
    expect(await sub('dan', `presence:meeting:${LOBBY}`)).toBe(false);
  });
  it('a DM call\'s meeting admits only the DM\'s ids', async () => {
    expect(await sub('bob', 'meeting:orgiq:dm:bob:dan')).toBe(true);
    expect(await sub('carol', 'meeting:orgiq:dm:bob:dan')).toBe(false);
  });
  it('neither the meeting nor a room chat is ever a cached verdict', () => {
    expect(verdictCacheable(`meeting:${LOBBY}`)).toBe(false);
    expect(verdictCacheable(`orgiq:huddle:${CALL}~breakout~r1`)).toBe(false);
    expect(verdictCacheable(`orgiq:huddle:${CALL}`)).toBe(true);
  });
});

describe('a lobby\'s occupancy `call-lobby:<lobby>` follows the lobby read (live huddle on a page)', () => {
  const sub = (who: string, channel: string, kind: 'subscribe' | 'publish' = 'subscribe', tenant?: string) =>
    admitChannel({ kind, clientId: `c-${who}`, channel, ctx: ctx(who, tenant) });
  it('admitted exactly when the page lobby may be read now', async () => {
    expect(await sub('dan', `call-lobby:${LOBBY}`)).toBe(true);
    expect(await sub('pat', `call-lobby:${LOBBY}`)).toBe(false);
    visible.delete(LOBBY);
    expect(await sub('dan', `call-lobby:${LOBBY}`)).toBe(false);
  });
  it('subscribe only; never a non-lobby, a room, a malformed or a prefixed name', async () => {
    expect(await sub('dan', `call-lobby:${LOBBY}`, 'publish')).toBe(false);
    expect(await sub('dan', 'call-lobby:orgiq:work:w-1')).toBe(false);
    expect(await sub('dan', 'call-lobby:')).toBe(false);
    expect(await sub('bob', `call-lobby:${room('r1')}`)).toBe(false);
    expect(await sub('dan', `presence:call-lobby:${LOBBY}`)).toBe(false);
  });
  it('a DM lobby\'s occupancy admits only the DM\'s ids; never a cached verdict', async () => {
    expect(await sub('bob', 'call-lobby:orgiq:dm:bob:dan')).toBe(true);
    expect(await sub('carol', 'call-lobby:orgiq:dm:bob:dan')).toBe(false);
    expect(verdictCacheable(`call-lobby:${LOBBY}`)).toBe(false);
  });
});

describe('a room\'s chat `orgiq:huddle:<callId>~breakout~<room>` (B2)', () => {
  const chat = (who: string, roomId = 'r1', kind: 'subscribe' | 'publish' = 'subscribe', prefix = '') =>
    admitChannel({ kind, clientId: `c-${who}`, channel: `${prefix}orgiq:huddle:${CALL}~breakout~${roomId}`, ctx: ctx(who) });
  beforeEach(() => { for (const c of Object.keys(CLIENTS)) seats.add(`${c}|orgiq:huddle:${CALL}`); });
  it('a seated room member reads and posts; reactions ride along', async () => {
    await openRooms();
    expect(await chat('bob')).toBe(true);
    expect(await chat('bob', 'r1', 'publish')).toBe(true);
    expect(await chat('bob', 'r1', 'subscribe', 'reactions:')).toBe(true);
    expect(jest.mocked(authorizeHuddleChannel).mock.calls.at(-1)![1]).toBe(`orgiq:huddle:${CALL}`);
  });
  it('a seated non-member, a closed room and an unknown room are refused; the organizer reads', async () => {
    await openRooms();
    expect(await chat('dan')).toBe(false);
    expect(await chat('carol', 'r2')).toBe(false);
    expect(await chat('bob', 'nope')).toBe(false);
    expect(await chat('olive')).toBe(true);
  });
  it('a room member who is not a current seat of the huddle is refused', async () => {
    await openRooms();
    seats.delete(`c-bob|orgiq:huddle:${CALL}`);
    expect(await chat('bob')).toBe(false);
  });
  it('an ended call has no room chat; presence on it is not a huddle service', async () => {
    await openRooms();
    expect(await chat('bob', 'r1', 'subscribe', 'presence:')).toBe(false);
    lobbies.delete(CALL);
    expect(await chat('bob')).toBe(false);
  });
});

describe('meetingOrganizer (decision 3)', () => {
  it('the call\'s caller, a ManageChannels holder in the lobby\'s tenant, an initiative steward; nobody else', async () => {
    expect(await meetingOrganizer(ctx('olive'), LOBBY, { callerId: 'olive', lobbyName: LOBBY })).toBe(true);
    expect(await meetingOrganizer(ctx('olive'), LOBBY, { callerId: 'olive', lobbyName: OTHER })).toBe(false);
    expect(await meetingOrganizer(ctx('dan'), LOBBY, { callerId: 'olive', lobbyName: LOBBY })).toBe(false);
    expect(await meetingOrganizer(ctx('mod', 'social'), 'social:ch:general', null)).toBe(true);
    expect(await meetingOrganizer(ctx('mod'), LOBBY, null)).toBe(false);
    jest.mocked(stewardsInitiative).mockImplementation(async (s, id) => s?.sub === 'dan' && id === 'p-1');
    expect(await meetingOrganizer(ctx('dan'), LOBBY, null)).toBe(true);
    expect(await meetingOrganizer(ctx('dan'), OTHER, null)).toBe(false);
  });
  it('a retired session is a participant', async () => {
    users.get('olive')!.epoch = 4;
    expect(await meetingOrganizer(ctx('olive'), LOBBY, { callerId: 'olive', lobbyName: LOBBY })).toBe(false);
  });
});

describe('breakout activity (B4)', () => {
  it('one row when the session opens and one when it closes; none per room or hand', async () => {
    const onChange = breakoutActivity();
    const state = (phase: 'none' | 'draft' | 'open', open = 0) => ({ meetingId: LOBBY, version: 1, createdBy: 'olive', hands: [], updatedAt: '',
      breakout: { phase, mode: 'assigned' as const, rooms: [{ id: 'r1', name: 'One', state: open > 0 ? 'open' as const : 'closed' as const, members: [] },
        { id: 'r2', name: 'Two', state: open > 1 ? 'open' as const : 'closed' as const, members: [] }],
        returned: [], endsAt: null, announcement: null, settings: { allowReturnToMain: true } } });
    onChange({ meetingId: LOBBY, action: 'breakout.configure', userId: 'olive', state: state('draft') });
    onChange({ meetingId: LOBBY, action: 'breakout.open', userId: 'olive', state: state('open', 1) });
    onChange({ meetingId: LOBBY, action: 'breakout.open', userId: 'olive', state: state('open', 2) });
    onChange({ meetingId: LOBBY, action: 'hand.raise', userId: 'bob', state: state('open', 2) });
    onChange({ meetingId: LOBBY, action: 'breakout.end', userId: 'system', state: state('draft') });
    expect(jest.mocked(publishChannelActivity).mock.calls).toEqual([
      [LOBBY, 'breakout.opened', { rooms: 1 }, { userId: 'olive' }],
      [LOBBY, 'breakout.closed', {}, undefined],
    ]);
  });
});
