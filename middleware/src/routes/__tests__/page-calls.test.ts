// Call history for page huddles (routes/page-calls.ts): initiative, team,
// document and run readers list their own rows for that lobby; the lobby's
// authority is the gateway's (family read action, the page existing now),
// asked fresh; another tenant's lobby is a 404; the tenant list is the
// caller's rows across that tenant's lobbies only, with the missed count.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  requireSession: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => (req.session ? next() : res.status(401).json({ error: 'no' })),
  isAllowed: jest.fn(),
}));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn(async (_kind: string, bare: string) => !bare.endsWith('-GONE') && !bare.endsWith('-gone')) }));

import express from 'express';
import request from '../../test-support/http.js';
import { pageCallsRouter } from '../page-calls.js';
import { AppError, errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { socialCallLogFixture, type SocialCallLogRow } from '../../mock/social-platform.js';
import type { Session } from '../../lib/session.js';

const POLICY: Record<string, string[]> = { member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment'], 'assessment-reader': [], author: ['ViewPipelines'] };
let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const sessionFor = (sub: string, tenant: string, role: string): Session => ({ sub, tenant, role, epoch: 1, iat: 1, grants: structuredClone(users.get(sub)?.grants ?? {}) }) as Session;

const app = express();
app.use((req, _res, next) => {
  const raw = req.headers['x-as'];
  if (typeof raw === 'string') { const [sub, tenant, role] = raw.split('/'); req.session = sessionFor(sub!, tenant!, role!); }
  next();
});
app.use('/api/calls', pageCallsRouter);
app.use(errorHandler);

const row = (userId: string, lobbyName: string, over: Partial<SocialCallLogRow> = {}): SocialCallLogRow => ({
  userId, callId: `${lobbyName}-${userId}`, direction: 'joined', callerId: userId, targetUserIds: [], lobbyName, audioOnly: false,
  outcome: 'answered', startedAt: '2026-10-07T10:00:00.000Z', answeredAt: '2026-10-07T10:00:00.000Z', endedAt: '2026-10-07T10:05:00.000Z', durationMs: 300_000, updatedAt: '2026-10-07T10:05:00.000Z', ...over,
});
const TEAM = 'assessment:team:TEAM-001';
const INIT = 'orgiq:initiative:p-auth';
const RUN = 'pipelines:run:run-1';
const DOC = 'assessment:doc:d-1';

beforeEach(() => {
  users = new Map([
    ['olu', user('olu', { orgiq: ['sme'] })],
    ['ana', user('ana', { assessment: ['assessor'] })],
    ['bo', user('bo', { assessment: ['assessor'] })],
    ['rae', user('rae', { assessment: ['assessment-reader'] })],
    ['pat', user('pat', { pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (POLICY[p.role] ?? []).includes(action));
  socialCallLogFixture.rows().splice(0, socialCallLogFixture.rows().length,
    row('ana', TEAM, { targetUserIds: ['bo'] }), row('bo', TEAM, { targetUserIds: ['ana'] }),
    row('ana', DOC), row('ana', 'social:dm:ana:bo'), row('ana', 'assessment:team:TEAM-002'),
    row('olu', INIT), row('olu', 'pipelines:run:run-9'),
    row('pat', RUN),
    row('ana', 'assessment:team:TEAM-001', { callId: 'missed-1', direction: 'incoming', outcome: 'missed', callerId: 'bo', startedAt: '2026-10-07T11:00:00.000Z', durationMs: undefined as never }));
});
afterEach(() => jest.clearAllMocks());

const calls = (as: string, lobby: string) => request(app).get(`/api/calls?lobby=${encodeURIComponent(lobby)}`).set('x-as', as);

describe('GET /api/calls?lobby=', () => {
  it('a team reader lists only their own rows in that lobby, newest first, with participants and the missed count', async () => {
    const res = await calls('ana/assessment/assessor', TEAM);
    expect(res.status).toBe(200);
    expect(res.body.calls.map((c: SocialCallLogRow) => c.callId)).toEqual(['missed-1', `${TEAM}-ana`]);
    expect(res.body.calls.every((c: SocialCallLogRow) => c.userId === 'ana' && c.lobbyName === TEAM)).toBe(true);
    expect(res.body.calls[1]).toMatchObject({ durationMs: 300_000, targetUserIds: ['bo'] });
    expect(res.body.counts).toEqual({ total: 2, missed: 1 });
  });

  it.each([
    ['initiative', 'olu/orgiq/sme', INIT],
    ['document', 'ana/assessment/assessor', DOC],
    ['run', 'pat/pipelines/author', RUN],
  ])('a %s reader lists that lobby', async (_name, as, lobby) => {
    const res = await calls(as, lobby);
    expect(res.status).toBe(200);
    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].lobbyName).toBe(lobby);
  });

  it('a same-tenant caller without the family action is refused', async () => {
    expect((await calls('rae/assessment/assessment-reader', TEAM)).status).toBe(403);
  });

  it.each([[TEAM, 'olu/orgiq/sme'], [INIT, 'ana/assessment/assessor'], [RUN, 'ana/assessment/assessor'], [DOC, 'pat/pipelines/author']])('%s is a 404 across tenants', async (lobby, as) => {
    expect((await calls(as, lobby)).status).toBe(404);
  });

  it('a page that no longer exists, a Social lobby and a non-lobby family are 404; a missing lobby is 400; no session is 401', async () => {
    expect((await calls('ana/assessment/assessor', 'assessment:team:TEAM-GONE')).status).toBe(404);
    expect((await calls('ana/assessment/assessor', 'social:dm:ana:bo')).status).toBe(404);
    expect((await calls('olu/orgiq/sme', 'orgiq:work:w-1')).status).toBe(404);
    expect((await request(app).get('/api/calls').set('x-as', 'ana/assessment/assessor')).status).toBe(400);
    expect((await request(app).get(`/api/calls?lobby=${TEAM}`)).status).toBe(401);
  });

  it('a revocation between requests is honoured: the directory is not cached', async () => {
    expect((await calls('ana/assessment/assessor', TEAM)).status).toBe(200);
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect((await calls('ana/assessment/assessor', TEAM)).status).toBe(403);
  });
});

describe('GET /api/calls/tenant', () => {
  it('lists the caller\'s calls across the active tenant\'s page lobbies only', async () => {
    const res = await request(app).get('/api/calls/tenant').set('x-as', 'ana/assessment/assessor');
    expect(res.status).toBe(200);
    expect(res.body.calls.map((c: SocialCallLogRow) => c.lobbyName).sort()).toEqual([DOC, 'assessment:team:TEAM-001', 'assessment:team:TEAM-001', 'assessment:team:TEAM-002'].sort());
    expect(res.body.counts).toEqual({ total: 4, missed: 1 });
    const orgiq = await request(app).get('/api/calls/tenant').set('x-as', 'olu/orgiq/sme');
    expect(orgiq.body.calls.map((c: SocialCallLogRow) => c.lobbyName).sort()).toEqual([INIT]);
  });

  it('lists only lobbies the caller may read now: each lobby\'s own read rule, as GET /api/calls?lobby= asks it', async () => {
    // Ana's own row in a team page that no longer exists: hers in the log, not hers to list.
    socialCallLogFixture.rows().push(row('ana', 'assessment:team:TEAM-GONE'));
    const res = await request(app).get('/api/calls/tenant').set('x-as', 'ana/assessment/assessor');
    expect(res.status).toBe(200);
    const lobbies = res.body.calls.map((c: SocialCallLogRow) => c.lobbyName);
    expect(lobbies).not.toContain('assessment:team:TEAM-GONE');
    expect(lobbies.sort()).toEqual([DOC, TEAM, TEAM, 'assessment:team:TEAM-002'].sort());
    expect(res.body.counts.total).toBe(4);
    // The single-lobby route agrees: that lobby is a 404 for her.
    expect((await request(app).get('/api/calls').query({ lobby: 'assessment:team:TEAM-GONE' }).set('x-as', 'ana/assessment/assessor')).status).toBe(404);
  });

  it('asks the tenant\'s own read action and refuses other tenants', async () => {
    expect((await request(app).get('/api/calls/tenant').set('x-as', 'rae/assessment/assessment-reader')).status).toBe(403);
    expect((await request(app).get('/api/calls/tenant').set('x-as', 'pat/pipelines/author')).status).toBe(200);
    expect((await request(app).get('/api/calls/tenant')).status).toBe(401);
    users.set('sam', user('sam', { social: ['participant'] }));
    expect((await request(app).get('/api/calls/tenant').set('x-as', 'sam/social/participant')).status).toBe(404);
  });

  it('answers 200 with an unavailable marker, not a raw 502, when the call log service is down', async () => {
    const providers = await import('../../providers/social-platform.js');
    const down = jest.spyOn(providers, 'listCallRows').mockRejectedValue(new AppError(502, 'platform-api is unreachable (fetch failed)'));
    try {
      const one = await request(app).get('/api/calls').query({ lobby: INIT }).set('x-as', 'olu/orgiq/sme');
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ source: 'unavailable', lobby: INIT, calls: [], counts: { total: 0, missed: 0 } });
      expect(typeof one.body.unavailable).toBe('string');
      const tenant = await request(app).get('/api/calls/tenant').set('x-as', 'olu/orgiq/sme');
      expect(tenant.status).toBe(200);
      expect(tenant.body.source).toBe('unavailable');
      // Authority is still asked first: another tenant's lobby stays a 404.
      expect((await request(app).get('/api/calls').query({ lobby: TEAM }).set('x-as', 'olu/orgiq/sme')).status).toBe(404);
    } finally { down.mockRestore(); }
  });
});
