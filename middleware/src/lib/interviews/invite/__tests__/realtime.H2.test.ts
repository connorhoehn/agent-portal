// Hardening lane H2, row I2.2: the guest's seat edges realtime.test.ts leaves open.
//
//   O-056  turned away mid-call while the gateway's verdict cache holds a yes: which of the guest's names the cache may keep, and
//          whether the turn-away tells the cache (it does not today: the failing case below is a finding for the lead).
//   O-060  the huddle runtime's guest Session and its session tag: pinned as it is now (the r3 gap is closed: the tag rides on
//          the Session, a spread keeps it, a wrong or missing tag holds nothing).
//   O-059  the guest's socket over a real /ws and its call seat, against a running stack: gated by REAL_INTERVIEWS_STACK_URL and
//          skipped by default (Docker and the social profile are down on the machine this was written on).
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


import { verdictCacheable } from '../../../gateway/authority.js';
import { bindAuthorityCache, type AuthorityCacheTarget } from '../../../gateway/authority-invalidation.js';
import { callChatChannel } from '../../../call-chat.js';
import { guestOfSession } from '../../lobby.js';

describe('with guest realtime on, admitted', () => {
  let ctx: Record<string, unknown>;
  let inviteId: string;
  let invites: MemoryInviteStore;
  const own = `interviews:interview:${OWN}`;

  beforeEach(async () => {
    process.env['INTERVIEWS_GUEST_REALTIME'] = 'true';
    process.env['INTERVIEWS_ENABLED'] = 'true';
    setInterviewsStore(new MemoryInterviewsStore());
    invites = new MemoryInviteStore();
    setInviteStore(invites);
    const issued = await invites.issueInvite({ interviewId: OWN, tokenHash: 'e'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await invites.recordOpening(issued.id, new Date().toISOString(), 'a'.repeat(64));
    inviteId = issued.id;
    const loaded = await loadGuestSession(issued.id, () => true, '');
    const { token } = await mintGuestRealtimeToken(loaded!.principal, SECRET);
    ctx = gatewayAuthFromClaims(await verifyRealtimeToken(token, SECRET)) as unknown as Record<string, unknown>;
    await applyAdmission(inviteId, { kind: 'knock' });
    expect(await applyAdmission(inviteId, { kind: 'decide', admit: true })).toMatchObject({ ok: true });
  });
  afterEach(() => { setInterviewsStore(null); setInviteStore(null); fixtureRegistry.resetAll('default'); });

  describe('O-056: turned away mid-call while a verdict is cached', () => {
    it('the cache keeps no yes for the guest\'s lobby, its presence, the call service\'s channels or its pad: those are asked fresh every frame', () => {
      for (const name of [own, `presence:${own}`, `call-lobby:${own}`, `meeting:${own}`, `doc:ivpad:${OWN}`]) {
        expect([name, verdictCacheable(name)]).toEqual([name, false]);
      }
    });

    it('the call\'s chat is cacheable, and a turned-away guest is still a current principal, so revalidation alone does not drop that yes', async () => {
      expect(verdictCacheable(callChatChannel('c1'))).toBe(true);
      const session = callContextSession(ctx, HUDDLE_CHAT_TENANTS)!;
      const authority = await currentCallAuthority(session, HUDDLE_CHAT_TENANTS);
      expect(await currentCallChatGrant(session, authority, 'PostMessage', own)).toBe(true);
      await applyAdmission(inviteId, { kind: 'decide', admit: false });
      expect(await admitPrincipal(ctx)).toBe(true);
      // The fresh decision refuses at once.
      expect(await currentCallChatGrant(session, authority, 'PostMessage', own)).toBe(false);
      expect(await join(own)).toBe(false);
    });

    // FINDING (lead): nothing on the turn-away path calls lib/gateway/authority-invalidation.ts, so with REALTIME_AUTHORITY_CACHE on a
    // turned-away candidate's cached yes on the call's chat (`orgiq:huddle:<callId>`) keeps admitting chat frames until the cache's
    // max age (5 s by default) or until the call runtime's own invalidate on leave. Fail closed would be an invalidateForUser of the
    // guest's subject (or invalidateChannel of the interview's call chats) after the admission write commits.
    it.failing('a turn-away tells the verdict cache, so no cached yes outlives it', async () => {
      const seen: string[] = [];
      const target: AuthorityCacheTarget = {
        invalidateChannel: (c) => { seen.push(`channel:${c}`); },
        invalidateUser: (u) => { seen.push(`user:${u}`); },
        clear: () => { seen.push('all'); },
      };
      const unbind = bindAuthorityCache(target);
      try {
        await applyAdmission(inviteId, { kind: 'decide', admit: false });
        expect(seen.some((s) => s === `user:guest:${inviteId}` || s === 'all' || s.startsWith('channel:orgiq:huddle:'))).toBe(true);
      } finally {
        unbind();
      }
    });

    const join = (lobbyName: string) => admitCall(ctx, 'join', { lobbyName }, callGuards(noStoredCall));
  });

  describe('O-060: the huddle runtime\'s guest Session carries the session tag', () => {
    it('built from the verified context it names the invite, the interview and the live session\'s tag, and holds the seat', async () => {
      const guestCtx = guestOfContext(ctx)!;
      const session = guestCallSession(guestCtx);
      expect(session.guest).toEqual({ inviteId, interviewId: OWN, session: guestCtx.session });
      expect(guestCtx.session).toMatch(/^[0-9a-f]{32}$/);
      expect(await sessionHoldsInterviewSeat(session, OWN)).toBe(true);
      // A spread (what a runtime does when it stores or forwards the Session) keeps the tag and the seat.
      expect(await sessionHoldsInterviewSeat({ ...session } as Session, OWN)).toBe(true);
      expect(await sessionHoldsInterviewSeat(session, 'iv-c3k8w2ma')).toBe(false);
    });

    it('a wrong tag, a missing tag, a subject that is not the invite\'s, or the guest field dropped: no guest, no seat', async () => {
      const session = guestCallSession(guestOfContext(ctx)!);
      const variants: Array<[string, Session]> = [
        ['wrong tag', { ...session, guest: { ...session.guest, session: 'f'.repeat(32) } } as Session],
        ['empty tag', { ...session, guest: { ...session.guest, session: '' } } as Session],
        ['other subject', { ...session, sub: 'guest:inv-other' } as Session],
        ['no guest field', (({ guest: _g, ...rest }) => rest)(session) as Session],
      ];
      for (const [what, s] of variants) {
        expect([what, await sessionHoldsInterviewSeat(s, OWN)]).toEqual([what, false]);
      }
      expect(guestOfSession(variants[3]![1])).toBeNull();
      expect(guestOfSession(variants[2]![1])).toBeNull();
    });

    it('the tag is the CURRENT session\'s: a new opening of the link (admitted again) leaves the older Session with nothing', async () => {
      const older = guestCallSession(guestOfContext(ctx)!);
      await invites.recordOpening(inviteId, new Date().toISOString(), 'c'.repeat(64));
      await applyAdmission(inviteId, { kind: 'knock' });
      await applyAdmission(inviteId, { kind: 'decide', admit: true });
      expect(await sessionHoldsInterviewSeat(older, OWN)).toBe(false);
      const fresh = await loadGuestSession(inviteId, () => true, '');
      expect(fresh!.principal.sessionTag).not.toBe(older.guest.session);
    });
  });
});

// O-059: the guest's socket and call seat over a REAL /ws. Needs a running mock-world middleware with the gateway on (and, for the
// media seat, the social profile's video service), reached at REAL_INTERVIEWS_STACK_URL, e.g.
//   REAL_INTERVIEWS_STACK_URL=http://localhost:4192 npx jest src/lib/interviews/invite/__tests__/realtime.H2.test.ts
// It drives only HTTP and one WebSocket; it writes to the stack's mock world (resets it first and after).
const stack = process.env['REAL_INTERVIEWS_STACK_URL'] ?? '';
(stack ? describe : describe.skip)('O-059: the guest over the real /ws (REAL_INTERVIEWS_STACK_URL)', () => {
  type Jar = { cookie: string };
  const call = async (jar: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${stack}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const name = pair!.split('=')[0]!;
      jar.cookie = [...jar.cookie.split('; ').filter((c) => c && !c.startsWith(`${name}=`)), pair!].join('; ');
    }
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> | null };
  };
  const login = async (userId: string) => { const jar = { cookie: '' }; expect((await call(jar, 'POST', '/api/session/login', { userId })).status).toBe(200); return jar; };
  const opens = (url: string, token: string) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, ['bearer-token-v1', token]);
    const done = (ok: boolean) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } resolve(ok); };
    const timer = setTimeout(() => done(false), 10_000);
    ws.addEventListener('open', () => done(true));
    ws.addEventListener('error', () => done(false));
  });

  beforeAll(async () => { expect((await fetch(`${stack}/api/__mock/reset`, { method: 'POST' })).status).toBe(200); });
  afterAll(async () => { await fetch(`${stack}/api/__mock/reset`, { method: 'POST' }); });

  it('an admitted guest\'s token opens the socket and holds its lobby; a waiting one holds nothing; the media seat is refused without a joined call', async () => {
    const recruiter = await login('u-greta');
    const lead = await login('u-hugo');
    const minted = await call(recruiter, 'POST', `/api/interviews/interviews/${OWN}/invite`, {});
    expect(minted.status).toBe(201);
    const guestJar = { cookie: '' };
    expect((await call(guestJar, 'POST', '/api/interview-invite/exchange', { token: String(minted.body!['linkPath']).split('#')[1] })).status).toBe(200);
    const notice = (await call(guestJar, 'GET', '/api/interview-invite/consents')).body!['notice'].version;
    expect((await call(guestJar, 'PUT', '/api/interview-invite/consents', { noticeVersion: notice, recording: true, transcription: true, milo: true })).status).toBe(200);
    expect((await call(guestJar, 'POST', '/api/interview-invite/knock')).status).toBe(200);
    const tokenRes = await call(guestJar, 'GET', '/api/interview-invite/realtime-token');
    expect(tokenRes.status).toBe(200);
    const token = String(tokenRes.body!['token']);
    const gatewayUrl = String(tokenRes.body!['gatewayUrl'] ?? `${stack.replace(/^http/, 'ws')}/ws`);
    const bearer = { authorization: `Bearer ${token}` };
    const lobby = `interviews:interview:${OWN}`;
    expect((await call({ cookie: '' }, 'POST', '/api/realtime/lobby-access', { lobbyName: lobby }, bearer)).status).toBe(403);
    expect((await call(lead, 'POST', `/api/interviews/interviews/${OWN}/admit`, { admit: true })).status).toBe(200);
    expect(await opens(gatewayUrl, token)).toBe(true);
    expect((await call({ cookie: '' }, 'POST', '/api/realtime/lobby-access', { lobbyName: lobby }, bearer)).status).toBe(200);
    const seat = await call({ cookie: '' }, 'POST', '/api/realtime/call-seat', { callId: 'c-none', lobbyName: lobby, clientId: 'client-none' }, bearer);
    expect([seat.status, seat.body]).toEqual([403, { allowed: false }]);
    expect((await call(lead, 'POST', `/api/interviews/interviews/${OWN}/admit`, { admit: false })).status).toBe(200);
    expect((await call({ cookie: '' }, 'POST', '/api/realtime/lobby-access', { lobbyName: lobby }, bearer)).status).toBe(403);
  }, 60_000);
});
