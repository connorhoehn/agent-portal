// The guest's realtime token and what the gateway lets it do (lib/interviews/invite/realtime.ts, lib/interviews/lobby.ts,
// lib/gateway/authority.ts; docs/interviews-tenant-plan.md rows I2.1, I2.2 and "I0.7 answer").
//
// Starts from "a guest is refused everything": with guest realtime off (the default outside the mock world) a guest
// token is refused on every name and at the upgrade. With it on, the guest is loaded from its invite and passes
// exactly its own lobby (presence, the call, the call service's watch channels) and its technical pad, and only
// once the lead has admitted it; one name from every family in lib/tenant-channels.ts, and every host namespace,
// stays refused. (The call chat needs a live call and the huddle runtime: the gateway suites carry it.)
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []) }));
jest.mock('../../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../../page-resources.js', () => ({ pageResourceVisible: jest.fn(async () => true) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { getUser, type UserInfo } from '../../../../providers/identity.js';
import { realtimeClaims, signRealtimeToken, verifyRealtimeToken } from '../../../realtime-token.js';
import { authenticateGatewayUpgrade, gatewayAuthFromClaims } from '../../../gateway/auth.js';
import {
  admitCall, admitCallRecipient, admitCursor, admitLobbyRead, admitPrincipal, admitPublish, admitSubscribe, callGuards, noStoredCall,
} from '../../../gateway/authority.js';
import { TENANT_CHANNEL_FAMILIES } from '../../../tenant-channels.js';
import type { Session } from '../../../session.js';
import { enumerateRoutes } from '../../../../mock/core/wire/routes.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { MemoryInterviewsStore } from '../../store.js';
import { setInterviewsStore } from '../../store-select.js';
import { applyAdmission } from '../admission.js';
import { GUEST_ROLE, loadGuestSession, type GuestPrincipal } from '../guest.js';
import { GUEST_DISPLAY_NAME, guestRealtimeClaims, guestRealtimeEnabled, mintGuestRealtimeToken } from '../realtime.js';
import { MemoryInviteStore, setInviteStore } from '../store.js';
import { HUDDLE_CHAT_TENANTS, callContextSession, callProvenance, currentCallAuthority, currentCallChatGrant } from '../../../call-access.js';
import { guestCallSession, guestOfContext, sessionHoldsInterviewSeat } from '../../lobby.js';
import { interviewsStore } from '../../store-select.js';

const SECRET = 'guest-realtime-test-secret';
const OWN = 'iv-k1p5w8ra';          // the seed's technical round, Hugo's, ready
const OTHER = 'iv-c3k8w2ma';         // another technical round
const guest: GuestPrincipal = {
  kind: 'interview-guest', inviteId: 'inv-1', interviewId: OWN, role: GUEST_ROLE, tenant: null, grants: {}, since: '2026-11-16T10:00:00.000Z', sessionTag: 'tag-1',
};
const ENV = ['INTERVIEWS_GUEST_REALTIME', 'INTERVIEWS_ENABLED', 'REALTIME_JWT_SECRET'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
  const users = new Map<string, UserInfo>([
    ['u-greta', { id: 'u-greta', displayName: 'Greta', epoch: 0, email: null, personId: null, grants: { interviews: ['recruiter'] } }],
    ['u-hugo', { id: 'u-hugo', displayName: 'Hugo', epoch: 0, email: null, personId: null, grants: { interviews: ['interviewer'] } }],
    ['u-wen', { id: 'u-wen', displayName: 'Wen', epoch: 0, email: null, personId: null, grants: { interviews: ['interviewer'] } }],
    ['u-ines', { id: 'u-ines', displayName: 'Ines', epoch: 0, email: null, personId: null, grants: { interviews: ['interviewer'] } }],
    ['u-kai', { id: 'u-kai', displayName: 'Kai', epoch: 0, email: null, personId: null, grants: { interviews: ['interviewer'] } }],
    ['u-amara', { id: 'u-amara', displayName: 'Amara', epoch: 0, email: null, personId: null, grants: { interviews: ['hiring-manager'] } }],
  ]);
  jest.mocked(getUser).mockImplementation(async (id) => structuredClone(users.get(id) ?? null));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('the claims', () => {
  it('name one interview and its session, hold no tenant and a role no Cedar file grants, and carry nothing from the candidate\'s record', () => {
    const c = guestRealtimeClaims(guest);
    expect(c).toMatchObject({ sub: 'guest:inv-1', displayName: GUEST_DISPLAY_NAME, tenants: [], role: 'interview-guest', org: 'interviews',
      guest: { interviewId: OWN, inviteId: 'inv-1', session: 'tag-1' } });
    expect(c.email).toBeUndefined();
    expect(c.act).toBeUndefined();
    const seeds = join(__dirname, '..', '..', '..', '..', '..', 'seeds', 'roles');
    for (const tenant of ['interviews', 'orgiq', 'assessment', 'social', 'pipelines', 'access']) {
      expect(() => readFileSync(join(seeds, tenant, `${GUEST_ROLE}.cedar`))).toThrow();
    }
  });

  it('verify exactly as the token bridge\'s own tokens do, and the gateway context keeps the guest claim', async () => {
    const { token, expiresAt } = await mintGuestRealtimeToken(guest, SECRET);
    const verified = await verifyRealtimeToken(token, SECRET);
    expect(verified).toMatchObject({ sub: 'guest:inv-1', role: GUEST_ROLE, tenants: [], guest: { interviewId: OWN } });
    expect(gatewayAuthFromClaims(verified)).toMatchObject({ userId: 'guest:inv-1', role: GUEST_ROLE, tenants: [], guest: { interviewId: OWN, inviteId: 'inv-1', session: 'tag-1' } });
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('served only by the guest\'s own router', () => {
  it('the guest routes are the seven of rows I2.1 to I2.3 and the room of row I2.4, and only routes/interview-invite.ts mints a token', () => {
    const routes = enumerateRoutes().routes.filter((r) => r.path.startsWith('/api/interview-invite')).map((r) => `${r.method} ${r.path}`);
    expect(routes.sort()).toEqual([
      'GET /api/interview-invite/admission',
      'GET /api/interview-invite/calls/:callId/chat/reads', // the candidate's call chat read position (routes/interview-invite-chat-reads.ts)
      'GET /api/interview-invite/captions', // gap audit 2026-11-20 §11: the candidate's own live captions, off by default
      'GET /api/interview-invite/consents', 'GET /api/interview-invite/interview',
      'GET /api/interview-invite/milo/floor', // hands-free Milo (lane D): who is talking to Milo, and the candidate's hold button
      'GET /api/interview-invite/realtime-token',
      'GET /api/interview-invite/room',
      'GET /api/interview-invite/runs', 'GET /api/interview-invite/runs/:runId', 'GET /api/interview-invite/runs/events', // lane RUNS (row I4.4)
      'POST /api/interview-invite/cant-make', // gap audit 2026-11-20 §6: the candidate's "I can't make this time"
      'POST /api/interview-invite/exchange', 'POST /api/interview-invite/knock',
      'POST /api/interview-invite/media/participant', // the candidate's own media id, bound to its session's subject (routes/interview-invite-media.ts)
      'POST /api/interview-invite/milo/hold/:action', // hands-free Milo (lane D): the candidate's hold, only with pad help on
      'POST /api/interview-invite/milo/request', // lane SPEAK (rows I3.5, I3.8): the candidate's two requests (routes/interview-invite-milo.ts)
      'POST /api/interview-invite/pad/events', // row I4.3: the candidate's pad log writes (routes/interview-invite-pad.ts)
      'POST /api/interview-invite/runs', 'POST /api/interview-invite/runs/:runId/cancel', // lane RUNS (row I4.4)
      'PUT /api/interview-invite/calls/:callId/chat/reads',
      'PUT /api/interview-invite/consents',
    ]);
    for (const file of ['routes/interviews/invite.ts', 'routes/interviews/admission.ts', 'routes/session.ts', 'index.ts']) {
      expect([file, readFileSync(join(__dirname, '..', '..', '..', '..', file), 'utf8').includes('mintGuestRealtimeToken')]).toEqual([file, false]);
    }
  });

  it('guest realtime is off outside the mock world unless set, and the setting wins either way', () => {
    expect(guestRealtimeEnabled({})).toBe(false);
    expect(guestRealtimeEnabled({ INTERVIEWS_GUEST_REALTIME: 'true' })).toBe(true);
    expect(guestRealtimeEnabled({ INTERVIEWS_GUEST_REALTIME: '0' })).toBe(false);
  });
});

/** One name from every family of lib/tenant-channels.ts, and the host namespaces, none of them the guest's. */
const FAMILY_SAMPLES: Record<string, string[]> = {
  'orgiq:invoke': ['orgiq:invoke'], 'orgiq:session': ['orgiq:session:s1'], 'orgiq:initiative': ['orgiq:initiative:p-1', 'presence:orgiq:initiative:p-1'],
  'orgiq:work': ['orgiq:work:w1'], 'orgiq:workgraph': ['orgiq:workgraph'], 'pipelines:workgraph': ['pipelines:workgraph'],
  'assessment:workgraph': ['assessment:workgraph'], 'social:workgraph': ['social:workgraph'], 'orgiq:deck': ['presence:orgiq:deck:d1'],
  'assessment:doc': ['assessment:doc:1'], 'assessment:team': ['assessment:team:TEAM-1'], 'assessment:knowledge': ['presence:assessment:knowledge:k'],
  'assessment:deck': ['presence:assessment:deck:d1'], 'pipelines:deck': ['presence:pipelines:deck:d1'], 'pipelines:run': ['pipelines:run:r1'],
  'pipelines:def': ['pipelines:def:d1'], 'access:req': ['access:req:req-0001'],
  'interviews:interview': [`presence:interviews:interview:${OTHER}`, `typing:interviews:interview:${OWN}`, `cursor:interviews:interview:${OWN}`],
  'orgiq:lobby': ['presence:orgiq:lobby'], 'assessment:lobby': ['presence:assessment:lobby'], 'pipelines:lobby': ['presence:pipelines:lobby'],
};
const HOST_NAMES = [
  'orgiq:huddle:c1', 'reactions:orgiq:huddle:c1', `orgiq:huddle:c1~breakout~r1`, `meeting:interviews:interview:${OTHER}`, `call-lobby:interviews:interview:${OTHER}`,
  'doc:notes', `doc:ivpad:${OTHER}`, `presence:doc:ivpad:${OWN}`, 'social:flowrun:run-1', 'assessment:flowrun:run-1', 'social:deck:d1', 'presence:social:deck:d1',
  'social:ch:general', 'social:dm:guest:inv-1:u-hugo', 'social:team:t1:general', 'social:workgraph:conversation:social:ch:general',
  'interviews:dm:guest:inv-1:u-hugo', 'interviews:lobby', 'presence:interviews:lobby', 'interviews:pad:iv-k1p5w8ra', 'notifications:guest:inv-1',
];

describe('with guest realtime off, a guest token is refused everything', () => {
  let ctx: Record<string, unknown>;
  beforeEach(async () => {
    const { token } = await mintGuestRealtimeToken(guest, SECRET);
    ctx = gatewayAuthFromClaims(await verifyRealtimeToken(token, SECRET)) as unknown as Record<string, unknown>;
  });

  it('at the upgrade, and as a principal', async () => {
    process.env['REALTIME_JWT_SECRET'] = SECRET;
    const { token } = await mintGuestRealtimeToken(guest, SECRET);
    await expect(authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as IncomingMessage)).rejects.toThrow();
    expect(await admitPrincipal(ctx)).toBe(false);
  });

  it.each([...Object.values(FAMILY_SAMPLES).flat(), ...HOST_NAMES, `presence:interviews:interview:${OWN}`, `doc:ivpad:${OWN}`])('%s', async (channel) => {
    expect(await admitSubscribe(ctx, channel)).toBe(false);
    expect(await admitPublish(ctx, channel)).toBe(false);
    expect(await admitCursor(ctx, channel, 'publish')).toBe(false);
  });

  it('no lobby admits it, its own interview\'s included', async () => {
    for (const lobby of [`interviews:interview:${OWN}`, 'orgiq:initiative:p-1']) expect(await admitLobbyRead(ctx, lobby)).not.toBe('ok');
  });
});

describe('with guest realtime on', () => {
  let ctx: Record<string, unknown>;
  let inviteId: string;
  const invites = new MemoryInviteStore();

  beforeEach(async () => {
    process.env['INTERVIEWS_GUEST_REALTIME'] = 'true';
    process.env['INTERVIEWS_ENABLED'] = 'true';
    setInterviewsStore(new MemoryInterviewsStore());
    setInviteStore(invites);
    const issued = await invites.issueInvite({ interviewId: OWN, tokenHash: 'e'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await invites.recordOpening(issued.id, new Date().toISOString(), 'a'.repeat(64));
    inviteId = issued.id;
    const loaded = await loadGuestSession(issued.id, () => true, '');
    const { token } = await mintGuestRealtimeToken(loaded!.principal, SECRET);
    ctx = gatewayAuthFromClaims(await verifyRealtimeToken(token, SECRET)) as unknown as Record<string, unknown>;
  });
  afterEach(() => { setInterviewsStore(null); setInviteStore(null); fixtureRegistry.resetAll('default'); });

  const admit = async () => {
    await applyAdmission(inviteId, { kind: 'knock' });
    expect(await applyAdmission(inviteId, { kind: 'decide', admit: true })).toMatchObject({ ok: true });
  };
  const own = `interviews:interview:${OWN}`;
  const join = (lobbyName: string, action = 'join') => admitCall(ctx, action, { lobbyName }, callGuards(noStoredCall));

  it('a waiting guest is a current principal, and holds no seat yet', async () => {
    expect(await admitPrincipal(ctx)).toBe(true);
    await applyAdmission(inviteId, { kind: 'knock' });
    expect(await admitSubscribe(ctx, `presence:${own}`)).toBe(false);
    expect(await admitSubscribe(ctx, own)).toBe(false);
    expect(await join(own)).toBe(false);
    expect(await admitSubscribe(ctx, `doc:ivpad:${OWN}`)).toBe(false);
    expect(await admitLobbyRead(ctx, own)).toBe('denied');
  });

  it('once admitted: its lobby\'s presence, its call, the call service\'s watch channels, its pad', async () => {
    await admit();
    expect(await admitSubscribe(ctx, `presence:${own}`)).toBe(true);
    expect(await admitPublish(ctx, `presence:${own}`)).toBe(true);
    expect(await join(own)).toBe(true);
    expect(await admitCallRecipient(ctx, { lobbyName: own, callId: 'c1' }, callGuards(async () => own))).toBe(true);
    expect(await admitSubscribe(ctx, `call-lobby:${own}`)).toBe(true);
    expect(await admitSubscribe(ctx, `meeting:${own}`)).toBe(true);
    expect(await admitPublish(ctx, `meeting:${own}`)).toBe(false);
    expect(await admitSubscribe(ctx, `doc:ivpad:${OWN}`)).toBe(true);
    expect(await admitLobbyRead(ctx, own)).toBe('ok');
  });

  it('once admitted it hears its own interview\'s live hints (the bare lobby name), read only, never another interview\'s', async () => {
    await admit();
    expect(await admitSubscribe(ctx, own)).toBe(true);
    expect(await admitPublish(ctx, own)).toBe(false);
    expect(await admitSubscribe(ctx, `interviews:interview:${OTHER}`)).toBe(false);
  });

  it('after the lead ends the interview the guest still hears the hint channel (the end itself) and nothing else of the room', async () => {
    await admit();
    const row = await interviewsStore().getInterview(OWN);
    const ended = await interviewsStore().endInterview(OWN, new Date().toISOString(), row!.revision);
    expect([ended.ok, (await interviewsStore().getInterview(OWN))?.state]).toEqual([true, 'ended']);
    expect(await admitSubscribe(ctx, own)).toBe(true);
    expect(await admitPublish(ctx, own)).toBe(false);
    expect(await admitSubscribe(ctx, `presence:${own}`)).toBe(false);
    expect(await join(own)).toBe(false);
  });

  it('never rings anyone or runs the call, and never another lobby', async () => {
    await admit();
    for (const action of ['invite', 'remove-participant', 'mute-participant', 'transfer-host', 'set-title']) expect([action, await join(own, action)]).toEqual([action, false]);
    for (const lobby of [`interviews:interview:${OTHER}`, 'orgiq:initiative:p-1', 'interviews:dm:guest:inv-1:u-hugo', 'social:ch:general', `${own}~breakout~r1`]) {
      expect([lobby, await join(lobby)]).toEqual([lobby, false]);
    }
    // A stored call in another lobby cannot be renamed into its own.
    expect(await admitCall(ctx, 'join', { callId: 'c9', lobbyName: own }, callGuards(async () => 'orgiq:initiative:p-1'))).toBe(false);
  });

  it('every family in lib/tenant-channels.ts and every host namespace stays refused, admitted or not', async () => {
    expect(Object.keys(FAMILY_SAMPLES).sort()).toEqual(TENANT_CHANNEL_FAMILIES.map((f) => f.id).sort());
    await admit();
    const names = [...Object.values(FAMILY_SAMPLES).flat(), ...HOST_NAMES];
    for (const channel of names) {
      expect([channel, await admitSubscribe(ctx, channel), await admitPublish(ctx, channel), await admitCursor(ctx, channel, 'publish')])
        .toEqual([channel, false, false, false]);
    }
    for (const lobby of ['orgiq:initiative:p-1', 'assessment:team:TEAM-1', 'pipelines:run:r1', `interviews:interview:${OTHER}`]) {
      expect([lobby, await admitLobbyRead(ctx, lobby)]).toEqual([lobby, 'denied']);
    }
  });

  it('a turn-away, a revoke, a new exchange of the link and the setting each end the seat', async () => {
    await admit();
    await applyAdmission(inviteId, { kind: 'decide', admit: false });
    expect(await join(own)).toBe(false);
    await admit();
    process.env['INTERVIEWS_GUEST_REALTIME'] = 'false';
    expect(await join(own)).toBe(false);
    expect(await admitPrincipal(ctx)).toBe(false);
    process.env['INTERVIEWS_GUEST_REALTIME'] = 'true';
    expect(await join(own)).toBe(true);
    await invites.recordOpening(inviteId, new Date().toISOString(), 'b'.repeat(64));
    expect(await admitPrincipal(ctx)).toBe(false);
    expect(await join(own)).toBe(false);
    await invites.revokeInvite(OWN, new Date().toISOString(), 'u-greta');
    expect(await admitPrincipal(ctx)).toBe(false);
  });

  it('staff: the lead holds the seat; the recruiter, who reads the interview, does not', async () => {
    const staffCtx = async (sub: string, role: string) => {
      const session = { sub, name: sub, role, tenant: 'interviews', grants: { interviews: [role] }, epoch: 0, iat: Math.floor(Date.now() / 1000) } as Session;
      return gatewayAuthFromClaims(await verifyRealtimeToken((await signRealtimeToken(realtimeClaims(session), SECRET)).token, SECRET)) as unknown as Record<string, unknown>;
    };
    const hugo = await staffCtx('u-hugo', 'interviewer');
    const greta = await staffCtx('u-greta', 'recruiter');
    expect(await admitCall(hugo, 'join', { lobbyName: own }, callGuards(noStoredCall))).toBe(true);
    expect(await admitSubscribe(hugo, `presence:${own}`)).toBe(true);
    expect(await admitLobbyRead(hugo, own)).toBe('ok');
    expect(await admitCall(hugo, 'join', { lobbyName: `interviews:interview:${OTHER}` }, callGuards(noStoredCall))).toBe(false);
    expect(await admitCall(greta, 'join', { lobbyName: own }, callGuards(noStoredCall))).toBe(false);
    expect(await admitSubscribe(greta, `presence:${own}`)).toBe(false);
    expect(await admitLobbyRead(greta, own)).toBe('denied');
    // The lobby name itself carries the room's live hints (knock, end) and nothing else: only that interview's seats read it, nobody writes it.
    expect(await admitSubscribe(hugo, own)).toBe(true);
    expect(await admitPublish(hugo, own)).toBe(false);
    expect(await admitSubscribe(hugo, `interviews:interview:${OTHER}`)).toBe(false);
    expect(await admitSubscribe(greta, own)).toBe(false);
  });

  // Round 3's session-tag gap: the call runtimes held a guest Session by its subject alone, so a link opened again
  // elsewhere (a new session, admitted again there) handed the older session's socket its seat back.
  it('every recheck of a guest asks the live session\'s tag: an older session of the same invite is refused the call, the chat and the recipient check', async () => {
    const old = ctx;
    await invites.recordOpening(inviteId, new Date().toISOString(), 'b'.repeat(64));
    const fresh = await loadGuestSession(inviteId, () => true, '');
    const current = gatewayAuthFromClaims(await verifyRealtimeToken((await mintGuestRealtimeToken(fresh!.principal, SECRET)).token, SECRET)) as unknown as Record<string, unknown>;
    await admit();
    const recipient = (c: Record<string, unknown>) => admitCallRecipient(c, { lobbyName: own, callId: 'c1' }, callGuards(async () => own));
    const chat = async (c: Record<string, unknown>) => {
      const session = callContextSession(c, HUDDLE_CHAT_TENANTS)!;
      const authority = await currentCallAuthority(session, HUDDLE_CHAT_TENANTS);
      return [await sessionHoldsInterviewSeat(session, OWN), await currentCallChatGrant(session, authority, 'PostMessage', own), await currentCallChatGrant(session, authority, 'ViewSocial', own)];
    };
    expect(await chat(current)).toEqual([true, true, true]);
    expect(await recipient(current)).toBe(true);
    expect(await chat(old)).toEqual([false, false, false]);
    expect(await recipient(old)).toBe(false);
    expect(await join(own)).toBe(false); // `ctx` is the older session's
    // Two sessions of one invite are two seats, never one.
    expect(callProvenance(callContextSession(old, HUDDLE_CHAT_TENANTS)!)).not.toBe(callProvenance(callContextSession(current, HUDDLE_CHAT_TENANTS)!));
    // The huddle runtime's own Session for a guest socket carries the claims too.
    expect(await sessionHoldsInterviewSeat(guestCallSession(guestOfContext(current)!), OWN)).toBe(true);
    expect(await sessionHoldsInterviewSeat(guestCallSession(guestOfContext(old)!), OWN)).toBe(false);
    // A guest Session known by its subject alone holds nothing, and is no call authority.
    const bare = { sub: `guest:${inviteId}`, name: 'Candidate', tenant: 'interviews', role: GUEST_ROLE, grants: { interviews: [GUEST_ROLE] }, epoch: 0, iat: 0 } as unknown as Session;
    expect(await sessionHoldsInterviewSeat(bare, OWN)).toBe(false);
    await expect(currentCallAuthority(bare, HUDDLE_CHAT_TENANTS)).rejects.toMatchObject({ status: 401 });
  });

  // Row I2.7, the server's half: the panel's seats in the call, its chat and its presence.
  it('the lead and each of two panel members hold a seat; a reassignment takes it from the one removed; no one else holds one; the guest is unaffected', async () => {
    const staffCtx = async (sub: string, role: string) => {
      const session = { sub, name: sub, role, tenant: 'interviews', grants: { interviews: [role] }, epoch: 0, iat: Math.floor(Date.now() / 1000) } as Session;
      return gatewayAuthFromClaims(await verifyRealtimeToken((await signRealtimeToken(realtimeClaims(session), SECRET)).token, SECRET)) as unknown as Record<string, unknown>;
    };
    const reseat = async (id: string, leadId: string, panelIds: string[]) => {
      const row = (await interviewsStore().listInterviews()).find((i) => i.id === id)!;
      const at = new Date().toISOString();
      const acceptances = [{ userId: leadId, seat: 'lead' as const, at }, ...panelIds.map((userId) => ({ userId, seat: 'panel' as const, at }))];
      expect(await interviewsStore().reassign(id, { leadId, panelIds, state: row.state, acceptances }, row.revision)).toMatchObject({ ok: true });
    };
    const holds = async (c: Record<string, unknown>, interviewId = OWN) => {
      const lobby = `interviews:interview:${interviewId}`;
      const session = callContextSession(c, HUDDLE_CHAT_TENANTS)!;
      const authority = await currentCallAuthority(session, HUDDLE_CHAT_TENANTS);
      return [
        await admitCall(c, 'join', { lobbyName: lobby }, callGuards(noStoredCall)),
        await admitSubscribe(c, `presence:${lobby}`),
        await currentCallChatGrant(session, authority, 'PostMessage', lobby),
        await currentCallChatGrant(session, authority, 'ViewSocial', lobby),
      ];
    };
    const SEAT = [true, true, true, true];
    const NONE = [false, false, false, false];
    await reseat(OWN, 'u-hugo', ['u-wen', 'u-ines']);
    await reseat(OTHER, 'u-kai', []);
    await admit();
    const [hugo, wen, ines, kai, greta, amara] = await Promise.all([
      staffCtx('u-hugo', 'interviewer'), staffCtx('u-wen', 'interviewer'), staffCtx('u-ines', 'interviewer'),
      staffCtx('u-kai', 'interviewer'), staffCtx('u-greta', 'recruiter'), staffCtx('u-amara', 'hiring-manager'),
    ]);
    expect(await holds(hugo)).toEqual(SEAT);
    expect(await holds(wen)).toEqual(SEAT);
    expect(await holds(ines)).toEqual(SEAT);
    // An interviewer of another round holds that round's seat, not this one's; the recruiter and the hiring manager hold none.
    expect(await holds(kai, OTHER)).toEqual(SEAT);
    expect(await holds(kai)).toEqual(NONE);
    expect(await holds(greta)).toEqual(NONE);
    expect(await holds(amara)).toEqual(NONE);
    expect(await join(own)).toBe(true);
    // A reassignment drops Ines from the panel: her next check refuses; the others and the guest keep theirs.
    await reseat(OWN, 'u-hugo', ['u-wen']);
    expect(await holds(ines)).toEqual(NONE);
    expect(await holds(hugo)).toEqual(SEAT);
    expect(await holds(wen)).toEqual(SEAT);
    expect(await join(own)).toBe(true);
    expect(await admitSubscribe(ctx, `presence:${own}`)).toBe(true);
  });
});
