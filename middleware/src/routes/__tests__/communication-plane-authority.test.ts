// The Communication plane (portal/src/pages/communication/CommunicationPlane.tsx)
// renders the Social workspace inside orgiq/assessment/pipelines. This is its
// role matrix at the BFF, mounted the way index.ts mounts it:
//
//   /api/social        socialEmbedRouter (grant-gated: /embedded, /dms, …)
//   /api/social/plane  socialPlaneRouter — the tenant router's OWN handlers,
//                      each gated on the actor's CURRENT Social grants
//                      (live-principal.ts currentSocialActionSession)
//   /api/social        requireTenant('social') + socialRouter (unchanged)
//
// For every plane read and write: a grant holder standing in orgiq gets what
// the Social tenant gives the same actor (and keeps its source tenant); a
// session with no Social grant is refused; a cookie claiming a Social grant
// the directory does not hold is refused; an epoch bump — before or DURING a
// request — refuses. The tenant-gated half still refuses orgiq sessions.
//
// The plane's own reads (docs/communication-plane-goal.md §1.2, §3 — Lane A):
// `/active`, `/people/:userId/shared-work`, the work-sharing writes and the
// plane's mount of the conversation work graph, each per-viewer on the server:
// a huddle in a lobby the viewer cannot read and a work node the viewer cannot
// open never leave the server; shared work reaches the owner (all of it), an
// audience member (the granted nodes, historical after a stop, referenced
// through a conversation), and nobody else (an empty 200, never a 403).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../lib/authz.js', () => {
  const actual = jest.requireActual('../../lib/authz.js');
  return {
    ...actual, isAllowed: jest.fn(),
    // The tenant router's gate, as Cedar decides it for a session standing in social.
    requireAction: (action: string) => (req: { session?: { tenant?: string; role?: string } }, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
      const s = req.session;
      const allowed = s?.tenant === 'social' && (mockRoleActions[s.role ?? ''] ?? []).includes(action);
      if (allowed) next(); else res.status(403).json({ error: 'Forbidden' });
    },
  };
});
const mockRoleActions: Record<string, string[]> = {
  participant: ['ViewSocial', 'PostMessage', 'StartCall'],
  moderator: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageRecordings'],
  'community-admin': ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'],
  admin: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'],
};
import express, { Router } from 'express';
import request from '../../test-support/http.js';
import { socialEmbedRouter, socialRouter } from '../social.js';
import { socialPlaneRouter } from '../social-plane.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed, requireTenant } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';
import { createChannel } from '../../providers/social-channels.js';
import {
  socialCallLogFixture, socialRecordingsFixture, socialRecordingTranscriptsFixture, socialRoomMembersFixture, socialRoomsFixture,
  socialTeamMembersFixture, socialTeamsFixture,
} from '../../mock/social-platform.js';
import { socialRecordingSharesFixture } from '../../providers/social-platform.js';
import { socialWorkSharingFixture } from '../../mock/social-work-sharing.js';
import { clock } from '../../mock/core/index.js';
import { stopWorkGraphLiveHints } from '../../lib/work-graph/live.js';
import { validateWorkGraphSnapshotV2 } from '@connorhoehnslalom/realtime-modules/work-graph';
import type { Session } from '../../lib/session.js';

const FIXTURES = [socialRoomsFixture, socialRoomMembersFixture, socialTeamsFixture, socialTeamMembersFixture, socialRecordingsFixture,
  socialRecordingTranscriptsFixture, socialCallLogFixture, socialRecordingSharesFixture, socialWorkSharingFixture];
const S = (sub: string, tenant: string, role: string, grants: Record<string, string[]>): Session =>
  ({ sub, name: sub, tenant, role, epoch: 1, iat: 100, grants } as unknown as Session);
// Social actors standing in OTHER tenants (the fixture people, so the platform fixtures name them).
const sana = S('u-sana', 'orgiq', 'member', { orgiq: ['member'], social: ['participant'] });
// Lena: in the seeded live #general huddle with Mira (mock/social-platform.ts LIVE_HUDDLE).
const lena = S('u-lena', 'orgiq', 'member', { orgiq: ['member'], social: ['moderator'] });
const mira = S('u-mira', 'assessment', 'assessor', { assessment: ['assessor'], social: ['community-admin'] });
const eli = S('u-eli', 'orgiq', 'sme', { orgiq: ['sme'] });
const operator = S('u-operator', 'orgiq', 'admin', { orgiq: ['admin'], social: ['admin'] });
const theo = S('u-theo', 'orgiq', 'member', { orgiq: ['member'], social: ['participant'] });
// Vera: the seeded work-sharing owner (person p-002, four Auth Migration items, owner of #auth-migration).
const vera = S('u-vera', 'orgiq', 'org-leader', { orgiq: ['org-leader', 'member'], social: ['participant'] });
const PERSON: Record<string, string | null> = { 'u-vera': 'p-002', 'u-theo': 'p-001' };

let sessions: Map<string, Session>; let users: Map<string, UserInfo>; let chat: SocialChatBackend;
const tenantGated = Router();
tenantGated.get('/channels', (_req, res) => { res.json({ reached: true }); });
const app = express(); app.use(express.json());
app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = structuredClone(s); next(); });
app.use('/api/social', socialEmbedRouter);
app.use('/api/social/plane', socialPlaneRouter);
app.use('/api/social', requireTenant('social'), tenantGated);
app.use(errorHandler);
const get = (url: string, user: string) => request(app).get(url).set('x-user', user);
const P = '/api/social/plane';

beforeEach(async () => {
  sessions = new Map([sana, lena, mira, eli, operator, theo, vera].map(s => [s.sub, structuredClone(s)]));
  users = new Map([sana, lena, mira, eli, operator, theo, vera].map(s => [s.sub, { id: s.sub, displayName: `${s.sub} Directory`, email: null,
    personId: PERSON[s.sub] ?? null, epoch: s.epoch!, grants: structuredClone(s.grants) } as UserInfo]));
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()].map(u => structuredClone(u)));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && (mockRoleActions[p.role] ?? []).includes(action));
  chat = createMemorySocialChatBackend({ fixtures: false }); setSocialChatBackend(chat);
  for (const [slug, privacy] of [['plane-open', 'public'], ['plane-private', 'private'], ['plane-general', 'public']] as const) {
    await createChannel({ slug, name: slug, description: null, privacy, createdBy: 'u-mira' }).catch(() => undefined);
  }
  for (const userId of ['u-theo', 'u-operator', 'u-sana']) {
    await chat.membershipStore.putMember({ channel: 'social:ch:plane-general', userId, role: 'member', addedBy: userId,
      addedAt: '2026-10-01T00:00:00.000Z', historyFrom: null, removedAt: null });
  }
  // The seeded sharing audience (#auth-migration: Vera, Theo) and the seeded live huddle's lobby (#general: Mira, Lena, Sana, Theo).
  for (const [slug, members] of [['auth-migration', ['u-vera', 'u-theo']], ['general', ['u-mira', 'u-lena', 'u-sana', 'u-theo']]] as const) {
    await createChannel({ slug, name: slug, description: null, privacy: 'public', createdBy: members[0]! }).catch(() => undefined);
    for (const userId of members) {
      await chat.membershipStore.putMember({ channel: `social:ch:${slug}`, userId, role: userId === members[0] ? 'owner' : 'member', addedBy: members[0]!,
        addedAt: '2026-10-01T00:00:00.000Z', historyFrom: null, removedAt: null });
    }
  }
  await chat.membershipStore.putMember({ channel: 'social:ch:plane-private', userId: 'u-mira', role: 'owner', addedBy: 'u-mira',
    addedAt: '2026-10-01T00:00:00.000Z', historyFrom: null, removedAt: null });
});
const savedEnv = { ...process.env };
beforeAll(() => { stopWorkGraphLiveHints(); for (const k of ['SOCIAL_PLATFORM_INTERNAL_URL', 'DOCUMENT_PLATFORM_INTERNAL_URL', 'PLATFORM_API_URL']) delete process.env[k]; });
afterAll(() => { process.env = savedEnv; });
afterEach(() => { for (const f of FIXTURES) f.reset(); jest.restoreAllMocks(); });

// Every plane route, with what the Social tenant asks of the same actor.
const today = () => clock.nowIso().slice(0, 10);
const GRAPH_QUERY = () => `day=${today()}&timezone=UTC`;
const READS = ['/capabilities', '/channels', '/people', '/dms', '/rooms', '/teams', '/teams/mock-team-community', '/recordings',
  '/recordings/mock-rec-dm-lena-sana/playback', '/recordings/mock-rec-dm-lena-sana/transcript', '/calls',
  // The plane's own reads (Lane A).
  '/active', '/people/u-vera/shared-work', `/work-graph/conversations/${encodeURIComponent('social:ch:plane-general')}/graph?${GRAPH_QUERY()}`];
type Write = { method: 'post' | 'patch' | 'delete'; path: string; body?: object; action: string };
const WRITES: Write[] = [
  { method: 'post', path: '/channels', body: { name: 'plane-created' }, action: 'ManageChannels' },
  { method: 'post', path: '/channels/plane-open/join', action: 'PostMessage' },
  { method: 'post', path: '/channels/plane-open/leave', action: 'ViewSocial' },
  { method: 'post', path: '/rooms', body: { name: 'Plane room' }, action: 'ManageChannels' },
  { method: 'post', path: '/teams', body: { name: 'Plane team' }, action: 'ManageTeams' },
  { method: 'patch', path: '/teams/mock-team-community/me', body: { favorite: true }, action: 'ViewSocial' },
  { method: 'post', path: '/teams/mock-team-community/members', body: { userId: 'u-theo' }, action: 'ManageTeams' },
  { method: 'delete', path: '/teams/mock-team-community/members/u-sana', action: 'ViewSocial' },
  { method: 'post', path: '/recordings/mock-rec-town-hall-1/share', action: 'ManageRecordings' },
  { method: 'delete', path: '/recordings/mock-rec-town-hall-1', action: 'ManageRecordings' },
];
const send = (w: Write, user: string) => request(app)[w.method](`${P}${w.path}`).set('x-user', user).send(w.body ?? {});
const GATE = 'Your Social grants do not allow this action';

describe('reads', () => {
  it('a Social participant standing in orgiq reads every plane route, and stays in orgiq', async () => {
    for (const path of READS) {
      const res = await get(`${P}${path}`, 'u-sana');
      expect([path, res.status]).toEqual([path, res.status === 202 ? 202 : 200]);
    }
    const caps = await get(`${P}/capabilities`, 'u-sana');
    expect(caps.body).toEqual({ tenant: 'orgiq', actions: { ViewSocial: true, PostMessage: true, StartCall: true, ManageChannels: false, ManageTeams: false, ManageRecordings: false } });
    const channels = (await get(`${P}/channels`, 'u-sana')).body.channels.map((c: { slug: string; joined: boolean }) => [c.slug, c.joined]);
    // The public directory, as Social lists it: a private channel she is not in does not exist for her.
    expect(channels).toEqual(expect.arrayContaining([['plane-open', false]]));
    expect(channels.map((c: [string]) => c[0])).not.toContain('plane-private');
    expect(sessions.get('u-sana')).toMatchObject({ tenant: 'orgiq', role: 'member' });
  });

  it('the community-admin (the manager) standing in assessment is offered every manage action, as in Social', async () => {
    const caps = await get(`${P}/capabilities`, 'u-mira');
    expect(caps.body).toEqual({ tenant: 'assessment', actions: { ViewSocial: true, PostMessage: true, StartCall: true, ManageChannels: true, ManageTeams: true, ManageRecordings: true } });
    expect((await get(`${P}/channels`, 'u-mira')).body.channels.map((c: { slug: string }) => c.slug)).toContain('plane-private');
  });

  it('a session without a Social grant is refused every read, plane and embed alike', async () => {
    for (const path of [...READS.map(p => `${P}${p}`), '/api/social/embedded', '/api/social/share-destinations', '/api/social/channels']) {
      expect([path, (await get(path, 'u-eli')).status]).toEqual([path, 403]);
    }
  });

  it('the cross-tenant admin reads the plane under its Social admin grant', async () => {
    for (const path of ['/capabilities', '/channels', '/teams', '/rooms', '/recordings', '/calls']) {
      expect([path, (await get(`${P}${path}`, 'u-operator')).status]).toEqual([path, 200]);
    }
  });
});

describe('writes — the same actions the Social tenant allows the same actor', () => {
  it('a participant joins and leaves a public channel, pins and leaves a team; every manage action is refused at the gate', async () => {
    for (const w of WRITES) {
      const res = await send(w, 'u-sana');
      if (mockRoleActions['participant']!.includes(w.action)) expect([w.path, res.status < 300]).toEqual([w.path, true]);
      else expect([w.path, res.status, res.body.error]).toEqual([w.path, 403, GATE]);
    }
  });

  it('join adds only the caller (a forged body names nobody) and makes the gateway admit her', async () => {
    const res = await request(app).post(`${P}/channels/plane-open/join`).set('x-user', 'u-sana').send({ userId: 'u-mira', tenant: 'social' });
    expect(res.status).toBe(200); expect(res.body.channel).toMatchObject({ slug: 'plane-open', joined: true });
    expect(chat.membershipStore.isActiveMember('social:ch:plane-open', 'u-sana')).toBe(true);
    expect(chat.membershipStore.isActiveMember('social:ch:plane-open', 'u-mira')).toBe(false);
    // A private channel does not exist for a non-member here either.
    expect((await request(app).post(`${P}/channels/plane-private/join`).set('x-user', 'u-sana')).status).toBe(404);
  });

  it('the community-admin standing in assessment creates channels, rooms and teams, adds people, shares and deletes her recording', async () => {
    for (const w of WRITES) {
      const res = await send(w, 'u-mira');
      // Leaving u-sana's own membership is ViewSocial only for u-sana; for the owner it is ManageTeams and allowed.
      expect([w.path, res.status < 300]).toEqual([w.path, true]);
    }
    expect((await get(`${P}/channels`, 'u-mira')).body.channels.map((c: { slug: string }) => c.slug)).toContain('plane-created');
  });

  it('a session without a Social grant is refused every write', async () => {
    for (const w of WRITES) expect([w.path, (await send(w, 'u-eli')).status]).toEqual([w.path, 403]);
    expect((await request(app).post('/api/social/dms').set('x-user', 'u-eli').send({ userId: 'u-sana' })).status).toBe(403);
  });
});

describe('every plane route, by its literal path', () => {
  it('answers the community-admin standing in assessment exactly as the Social tenant would', async () => {
    const m = 'u-mira';
    const ok = (res: { status: number }) => expect(res.status).toBeLessThan(300);
    ok(await request(app).get('/api/social/plane/capabilities').set('x-user', m));
    ok(await request(app).get('/api/social/plane/channels').set('x-user', m));
    ok(await request(app).post('/api/social/plane/channels').set('x-user', m).send({ name: 'literal-created' }));
    ok(await request(app).post('/api/social/plane/channels/plane-open/join').set('x-user', m));
    ok(await request(app).post('/api/social/plane/channels/plane-open/leave').set('x-user', m));
    ok(await request(app).get('/api/social/plane/dms').set('x-user', m));
    ok(await request(app).get('/api/social/plane/people').set('x-user', m));
    ok(await request(app).get('/api/social/plane/rooms').set('x-user', m));
    ok(await request(app).post('/api/social/plane/rooms').set('x-user', m).send({ name: 'Literal room' }));
    ok(await request(app).get('/api/social/plane/teams').set('x-user', m));
    ok(await request(app).post('/api/social/plane/teams').set('x-user', m).send({ name: 'Literal team' }));
    ok(await request(app).get('/api/social/plane/teams/mock-team-community').set('x-user', m));
    ok(await request(app).patch('/api/social/plane/teams/mock-team-community/me').set('x-user', m).send({ favorite: true }));
    ok(await request(app).post('/api/social/plane/teams/mock-team-community/members').set('x-user', m).send({ userId: 'u-theo' }));
    ok(await request(app).delete('/api/social/plane/teams/mock-team-community/members/u-theo').set('x-user', m));
    ok(await request(app).get('/api/social/plane/recordings').set('x-user', m));
    ok(await request(app).get('/api/social/plane/recordings/mock-rec-town-hall-1/playback').set('x-user', m));
    ok(await request(app).get('/api/social/plane/recordings/mock-rec-town-hall-1/transcript').set('x-user', m));
    ok(await request(app).post('/api/social/plane/recordings/mock-rec-town-hall-1/share').set('x-user', m));
    ok(await request(app).delete('/api/social/plane/recordings/mock-rec-town-hall-1').set('x-user', m));
    ok(await request(app).get('/api/social/plane/calls').set('x-user', m));
  });
});

describe('forgery and revocation', () => {
  it('a cookie claiming a Social grant the directory does not hold is refused on every route', async () => {
    sessions.set('u-eli', { ...eli, grants: { orgiq: ['sme'], social: ['community-admin'] } } as Session);
    for (const path of READS) expect([path, (await get(`${P}${path}`, 'u-eli')).status]).toEqual([path, 403]);
    for (const w of WRITES) expect([w.path, (await send(w, 'u-eli')).status]).toEqual([w.path, 403]);
  });

  it('a cookie claiming another tenant or role than the directory grants is refused', async () => {
    sessions.set('u-sana', { ...sana, tenant: 'social', role: 'community-admin' } as Session);
    expect((await get(`${P}/channels`, 'u-sana')).status).toBe(401);
    expect((await send(WRITES[0]!, 'u-sana')).status).toBe(401);
  });

  it('a revoked Social grant refuses the next request', async () => {
    users.get('u-sana')!.grants = { orgiq: ['member'] };
    expect((await get(`${P}/channels`, 'u-sana')).status).toBe(403);
    expect((await send(WRITES[1]!, 'u-sana')).status).toBe(403);
  });

  it('an epoch bump between requests refuses every read and write', async () => {
    expect((await get(`${P}/teams`, 'u-sana')).status).toBe(200);
    users.get('u-sana')!.epoch = 2;
    for (const path of READS) expect([path, (await get(`${P}${path}`, 'u-sana')).status]).toEqual([path, 401]);
    for (const w of WRITES) expect([w.path, (await send(w, 'u-sana')).status]).toEqual([w.path, 401]);
    expect(chat.membershipStore.isActiveMember('social:ch:plane-open', 'u-sana')).toBe(false);
  });

  it('an epoch bump DURING the policy decision refuses, and the join writes nothing', async () => {
    jest.mocked(isAllowed).mockImplementation(async (p, action) => {
      users.get('u-sana')!.epoch = 2; // revoked while the policy call was in flight
      return p.tenant === 'social' && (mockRoleActions[p.role] ?? []).includes(action);
    });
    expect((await request(app).post(`${P}/channels/plane-open/join`).set('x-user', 'u-sana')).status).toBe(401);
    expect(chat.membershipStore.isActiveMember('social:ch:plane-open', 'u-sana')).toBe(false);
  });
});

describe('the embed half and the tenant gate are unchanged', () => {
  it('an orgiq member with a Social grant reads /embedded and her member channels without leaving orgiq', async () => {
    const embedded = await get('/api/social/embedded', 'u-theo');
    expect(embedded.status).toBe(200);
    expect(embedded.body.source).toMatchObject({ userId: 'u-theo', tenant: 'orgiq', role: 'member' });
    const channels = await get('/api/social/share-destinations', 'u-theo');
    expect(channels.status).toBe(200);
    // Lane A's setup also seats Theo in #auth-migration and #general (the seeded sharing audience and the live huddle's lobby).
    expect(channels.body.channels.map((c: { channel: string }) => c.channel)).toEqual(['social:ch:auth-migration', 'social:ch:general', 'social:ch:plane-general']);
  });

  it('the tenant-gated Social routes still refuse an orgiq session that holds a Social grant', async () => {
    const refused = await get('/api/social/channels', 'u-theo');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ requiredTenant: 'social', tenant: 'orgiq' });
    expect((await request(app).get('/api/social/embedded')).status).toBe(401);
    expect((await request(app).get(`${P}/channels`)).status).toBe(401);
  });

  it('the Social tenant router serves the same handlers behind its own gate', async () => {
    const tenantApp = express(); tenantApp.use(express.json());
    tenantApp.use((req, _res, next) => { req.session = S('u-sana', 'social', 'participant', { social: ['participant'] }); next(); });
    tenantApp.use('/api/social', requireTenant('social'), socialRouter); tenantApp.use(errorHandler);
    const inSocial = (await request(tenantApp).get('/api/social/channels')).body.channels.map((c: { slug: string }) => c.slug).sort();
    const inPlane = (await get(`${P}/channels`, 'u-sana')).body.channels.map((c: { slug: string }) => c.slug).sort();
    expect(inPlane).toEqual(inSocial);
    expect((await request(tenantApp).post('/api/social/channels').send({ name: 'nope' })).status).toBe(403);
  });
});

// ── The plane's own reads (docs/communication-plane-goal.md §1.2, §3 — Lane A) ─

type ActiveBody = { people: Array<{ userId: string; status: string; inCall: { lobby: string; title: string | null } | null; activity: string | null; workSharing: { state: string; fresh: boolean } | null }>; counts: { people: number; inCall: number }; limits: string[] };
type SharedBody = { snapshot: { nodes: Array<{ id: string; title: string; disclosure: string }>; edges: Array<{ fromId: string; toId: string }>; scope: { personId: string } };
  sharing: { viewer: string; state: string | null; provenance: Record<string, string>; grants: Array<{ id: string; state: string; revision: number }>; referencedIn: string[] } };
const person = (body: ActiveBody, id: string) => body.people.find(p => p.userId === id);
const nodeIds = (body: SharedBody) => body.snapshot.nodes.map(n => n.id).sort();

describe('GET /active — what THIS viewer may know about each person', () => {
  it('a participant in the seeded live huddle sees Mira in it; a #general member outside the call, and someone outside #general, are told nothing of it', async () => {
    // The call log is per person (platform-api's contract, and the mock's since D7): Lena's own row names Mira.
    const res = await request(app).get('/api/social/plane/active').set('x-user', 'u-lena');
    expect(res.status).toBe(200);
    const mira = person(res.body, 'u-mira')!;
    expect(mira).toMatchObject({ status: 'busy', inCall: { lobby: 'social:ch:general', title: '#general' }, activity: 'In a huddle on #general' });
    expect(person(res.body, 'u-lena')).toMatchObject({ status: 'busy', inCall: { lobby: 'social:ch:general' } });
    expect(res.body.counts).toMatchObject({ people: res.body.people.length, inCall: res.body.people.filter((p: { inCall: unknown }) => p.inCall).length });
    expect(res.body.limits).toContain('the call log is per person, so a live call is known only when the viewer is in it');
    // Sana is in #general but not in the call: her log holds no row for it, so Mira is simply online to her —
    // under the mock exactly as against platform-api (the fixture is not a wider contract).
    const member = await get('/api/social/plane/active', 'u-sana');
    expect(person(member.body, 'u-mira')).toMatchObject({ status: 'online', inCall: null });
    // Vera is not in #general: the huddle does not exist for her, whatever Mira is doing.
    const outside = await get('/api/social/plane/active', 'u-vera');
    expect(outside.status).toBe(200);
    expect(person(outside.body, 'u-mira')).toMatchObject({ status: 'online', inCall: null });
    // Mira has no linked person either, so nothing else names an activity for her.
    expect(person(outside.body, 'u-mira')!.activity).toBeNull();
    // `users=` narrows to the shell's roster.
    const narrowed = await request(app).get('/api/social/plane/active').query({ users: 'u-mira,u-nobody' }).set('x-user', 'u-sana');
    expect(narrowed.body.people.map((p: { userId: string }) => p.userId)).toEqual(['u-mira']);
  });

  it('activity is the person’s latest orgiq work node under the VIEWER’s gates; a viewer standing elsewhere reads none, and sharing shows only to its audience', async () => {
    const inOrgiq = await get('/api/social/plane/active', 'u-theo');
    expect(inOrgiq.status).toBe(200);
    const veraForTheo = person(inOrgiq.body, 'u-vera')!;
    expect(veraForTheo.activity).toMatch(/^(Working on|On|Editing|Ran|Running|Deciding) /);
    // Theo is in #auth-migration, the seeded grants' audience.
    expect(veraForTheo.workSharing).toEqual({ state: 'active', fresh: true });
    // Sana is not: no sharing, though Vera's tenant-open work still names an activity for an orgiq viewer.
    const forSana = person((await get('/api/social/plane/active', 'u-sana')).body, 'u-vera')!;
    expect(forSana.workSharing).toBeNull();
    // Mira stands in assessment: the orgiq work graph is not hers to read, so no title reaches her.
    const inAssessment = await get('/api/social/plane/active', 'u-mira');
    expect(inAssessment.status).toBe(200);
    expect(person(inAssessment.body, 'u-vera')!.activity).toBeNull();
    expect(inAssessment.body.limits.join(' ')).toMatch(/standing elsewhere/);
    // An unlinked person has no work graph; a person in nothing today has no activity.
    expect(person(inOrgiq.body, 'u-sana')!.activity).toBeNull();
  });

  it('no grant 403; a forged grant 403; an epoch bump during the policy call 401', async () => {
    expect((await get('/api/social/plane/active', 'u-eli')).status).toBe(403);
    sessions.set('u-eli', { ...eli, grants: { orgiq: ['sme'], social: ['participant'] } } as Session);
    expect((await get('/api/social/plane/active', 'u-eli')).status).toBe(403);
    jest.mocked(isAllowed).mockImplementation(async (p, action) => {
      users.get('u-sana')!.epoch = 2;
      return p.tenant === 'social' && (mockRoleActions[p.role] ?? []).includes(action);
    });
    expect((await get('/api/social/plane/active', 'u-sana')).status).toBe(401);
  });
});

describe('GET /people/:userId/shared-work — owner, audience, outsider, historical, conversation-implicit', () => {
  it('the owner sees all of her own graph and every grant with its revision', async () => {
    const res = await request(app).get('/api/social/plane/people/u-vera/shared-work').set('x-user', 'u-vera');
    expect(res.status).toBe(200);
    const body: SharedBody = res.body;
    expect(body.sharing.viewer).toBe('owner');
    // Keyed on the REQUEST's subject (what the portal's reader keys its snapshot on), never the owner's `person:` id.
    expect(body.snapshot.scope.personId).toBe('shared-work:u-vera');
    expect(nodeIds(body)).toEqual(expect.arrayContaining(['work:wi-auth-e1', 'work:wi-auth-e1-b4', 'work:wi-auth-e2', 'work:wi-auth-e2-b3']));
    expect(body.sharing.grants.map(g => [g.id, g.state]).sort()).toEqual([['wsg-vera-auth-current', 'active'], ['wsg-vera-auth-history', 'active'], ['wsg-vera-auth-stopped', 'stopped']]);
    expect(body.sharing.state).toBe('active');
  });

  it('an audience member sees exactly the granted nodes — active ones, and the stopped share’s days as historical', async () => {
    const res = await request(app).get('/api/social/plane/people/u-vera/shared-work').set('x-user', 'u-theo');
    expect(res.status).toBe(200);
    const body: SharedBody = res.body;
    expect(body.sharing.viewer).toBe('audience');
    expect(nodeIds(body)).toEqual(['initiative:p-auth-migration', 'work:wi-auth-e1', 'work:wi-auth-e1-b4', 'work:wi-auth-e2']);
    expect(body.sharing.provenance).toEqual({ 'initiative:p-auth-migration': 'active', 'work:wi-auth-e1': 'active', 'work:wi-auth-e1-b4': 'active', 'work:wi-auth-e2': 'historical' });
    // Summary disclosure: titles, no descriptions; edges only between disclosed nodes.
    for (const n of body.snapshot.nodes) expect(n.disclosure).toBe('summary');
    const ids = new Set(nodeIds(body));
    for (const e of body.snapshot.edges) { expect(ids.has(e.fromId)).toBe(true); expect(ids.has(e.toId)).toBe(true); }
    expect(body.sharing.grants.map(g => g.id).sort()).toEqual(['wsg-vera-auth-current', 'wsg-vera-auth-history']);
    expect(body.sharing.state).toBe('active');
    // Only the history grant left: the state reads historical.
    socialWorkSharingFixture.rows().find(r => r.grantId === 'wsg-vera-auth-current')!.grant.state = 'stopped';
    const later: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-theo')).body;
    expect(later.sharing.state).toBe('historical');
    expect(nodeIds(later)).toEqual(['work:wi-auth-e2']);
  });

  it('an audience reply is the library’s own contract: keyed on the request’s subject, v2-valid, efforts naming only edges it carries (D1)', async () => {
    // The browser's request: today, the whole local day, schema 2 (WorkGraphActivity's useWorkGraphSource).
    const day = today();
    const q = `day=${day}&timezone=UTC&schemaVersion=2&windowStart=${day}T00:00:00.000Z&windowEnd=${day}T23:59:59.000Z&mode=live`;
    const res = await get(`/api/social/plane/people/u-vera/shared-work?${q}`, 'u-theo');
    expect(res.status).toBe(200);
    const snapshot = res.body.snapshot as { scope: { personId: string }; query: { personId: string }; edges: Array<{ id: string }>; efforts: Array<{ edgeIds: string[]; nodeIds: string[] }>; nodes: Array<{ id: string }> };
    expect(res.body.sharing.viewer).toBe('audience');
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    // One key, decided here: the request's `shared-work:<userId>`, in the scope AND the v2 query (the client re-keys nothing).
    expect([snapshot.scope.personId, snapshot.query.personId]).toEqual(['shared-work:u-vera', 'shared-work:u-vera']);
    // The grants select nodes, so the owner's day loses the edges to the rest; an effort must not keep naming them —
    // the library's reader refused exactly that, and the portal drew "The activity graph could not load".
    const edges = new Set(snapshot.edges.map(e => e.id)), nodes = new Set(snapshot.nodes.map(n => n.id));
    expect(snapshot.efforts.length).toBeGreaterThan(0);
    for (const effort of snapshot.efforts) {
      expect(effort.edgeIds.every(id => edges.has(id))).toBe(true);
      expect(effort.nodeIds.every(id => nodes.has(id))).toBe(true);
    }
    expect(validateWorkGraphSnapshotV2(snapshot).ok).toBe(true);
    // The v1 shape and the empty (outsider) reply carry the same key.
    const v1 = (await get(`/api/social/plane/people/u-vera/shared-work?day=${day}&timezone=UTC`, 'u-theo')).body as SharedBody;
    expect(v1.snapshot.scope.personId).toBe('shared-work:u-vera');
    const outsider = (await get(`/api/social/plane/people/u-vera/shared-work?${q}`, 'u-sana')).body as SharedBody;
    expect([outsider.sharing.viewer, outsider.snapshot.scope.personId]).toEqual(['none', 'shared-work:u-vera']);
  });

  it('an outsider gets an empty graph (200), as does an unknown or unlinked person — never a 403 that reveals work', async () => {
    const sana: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-sana')).body;
    expect(sana.sharing).toMatchObject({ viewer: 'none', state: null, provenance: {}, grants: [] });
    expect(sana.snapshot.nodes).toEqual([]);
    for (const who of ['u-nobody', 'u-sana']) {
      const res = await get(`/api/social/plane/people/${who}/shared-work`, 'u-theo');
      expect([who, res.status, res.body.sharing.viewer, res.body.snapshot.nodes.length]).toEqual([who, 200, 'none', 0]);
    }
    expect((await get('/api/social/plane/people/u-vera/shared-work', 'u-eli')).status).toBe(403);
    expect((await get('/api/social/plane/people/bad%20id/shared-work', 'u-theo')).status).toBe(400);
  });

  it('work the owner referenced into a conversation is implicitly shared with that conversation’s members only', async () => {
    await chat.membershipStore.putMember({ channel: 'social:ch:plane-general', userId: 'u-vera', role: 'member', addedBy: 'u-vera',
      addedAt: '2026-10-01T00:00:00.000Z', historyFrom: null, removedAt: null });
    await chat.chatStore.putMessage({ id: 'm-ref-1', clientId: 'c', userId: 'u-vera', channel: 'social:ch:plane-general', message: 'look at this',
      timestamp: clock.nowIso(), metadata: { displayName: 'Vera', pageReference: { kind: 'work-item', id: 'wi-auth-e2-b3' } } } as never);
    // Sana is in plane-general (not in #auth-migration): the referenced item, and nothing else.
    const sana: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-sana')).body;
    expect(sana.sharing.viewer).toBe('audience');
    expect(nodeIds(sana)).toEqual(['work:wi-auth-e2-b3']);
    expect(sana.sharing.provenance).toEqual({ 'work:wi-auth-e2-b3': 'referenced' });
    expect(sana.sharing.referencedIn).toEqual(['social:ch:plane-general']);
    // Mira is in neither conversation: still nothing.
    const mira: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-mira')).body;
    expect([mira.sharing.viewer, mira.snapshot.nodes.length]).toEqual(['none', 0]);
    // A reference to someone else's work does not share Vera's: Theo posting Vera's item id shares nothing of Vera's with Sana beyond what Vera posted.
    await chat.chatStore.putMessage({ id: 'm-ref-2', clientId: 'c', userId: 'u-theo', channel: 'social:ch:plane-general', message: 'and this',
      timestamp: clock.nowIso(), metadata: { displayName: 'Theo', pageReference: { kind: 'work-item', id: 'wi-auth-e1' } } } as never);
    expect(nodeIds((await get('/api/social/plane/people/u-vera/shared-work', 'u-sana')).body)).toEqual(['work:wi-auth-e2-b3']);
  });

  it('a forged grant, a revoked grant and an epoch bump refuse', async () => {
    sessions.set('u-eli', { ...eli, grants: { orgiq: ['sme'], social: ['community-admin'] } } as Session);
    expect((await get('/api/social/plane/people/u-vera/shared-work', 'u-eli')).status).toBe(403);
    users.get('u-theo')!.grants = { orgiq: ['member'] };
    expect((await get('/api/social/plane/people/u-vera/shared-work', 'u-theo')).status).toBe(403);
    users.get('u-sana')!.epoch = 2;
    expect((await get('/api/social/plane/people/u-vera/shared-work', 'u-sana')).status).toBe(401);
  });
});

describe('work-sharing writes — the owner’s PostMessage (conversation) or ManageTeams (team), and the library lifecycle', () => {
  const share = (user: string, body: object) => request(app).post('/api/social/plane/work-sharing').set('x-user', user).send(body);
  it('a member shares her own work into a conversation she is in; the audience sees it; a stop leaves only the history', async () => {
    const created = await share('u-vera', { audience: { kind: 'conversation', id: 'social:ch:auth-migration' }, nodeIds: ['work:wi-auth-e2-b3'],
      history: { dayFrom: today(), dayThrough: today() } });
    expect(created.status).toBe(201);
    expect(created.body.grant).toMatchObject({ state: 'active', kind: 'current', revision: 1, audience: { kind: 'conversation', id: 'social:ch:auth-migration' }, nodeIds: ['work:wi-auth-e2-b3'] });
    expect(created.body.history).toMatchObject({ state: 'active', kind: 'history', dayFrom: today() });
    const theo: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-theo')).body;
    expect(theo.sharing.provenance['work:wi-auth-e2-b3']).toBe('active');
    const stopped = await request(app).post(`/api/social/plane/work-sharing/${created.body.grant.id}/transition`).set('x-user', 'u-vera').send({ action: 'stop', expectedRevision: 1 });
    expect(stopped.status).toBe(200);
    expect(stopped.body.grant).toMatchObject({ state: 'stopped', revision: 2 });
    const after: SharedBody = (await get('/api/social/plane/people/u-vera/shared-work', 'u-theo')).body;
    expect(after.sharing.provenance['work:wi-auth-e2-b3']).toBe('historical');
    // A stale revision is a 409; a stopped grant cannot stop again.
    expect((await request(app).post(`/api/social/plane/work-sharing/${created.body.grant.id}/transition`).set('x-user', 'u-vera').send({ action: 'stop', expectedRevision: 1 })).status).toBe(409);
    expect((await request(app).post(`/api/social/plane/work-sharing/${created.body.grant.id}/transition`).set('x-user', 'u-vera').send({ action: 'stop', expectedRevision: 2 })).status).toBe(409);
  });

  it('the audience must be one the owner belongs to now; someone else’s grant does not exist; the body never names the owner', async () => {
    // Sana is not in #auth-migration.
    expect((await share('u-sana', { audience: { kind: 'conversation', id: 'social:ch:auth-migration' }, nodeIds: ['work:x'] })).status).toBe(404);
    // A team she is not on; the team Mira owns (ManageTeams, which Sana lacks → 403 first).
    expect((await share('u-sana', { audience: { kind: 'team', id: 'mock-team-community' }, nodeIds: ['work:x'] })).status).toBe(403);
    const team = await share('u-mira', { audience: { kind: 'team', id: 'mock-team-community' }, nodeIds: ['work:x'] });
    expect(team.status).toBe(201);
    expect((await share('u-mira', { audience: { kind: 'team', id: 'mock-team-nope' }, nodeIds: ['work:x'] })).status).toBe(404);
    // Only the owner may transition it; the id alone reveals nothing to anyone else.
    expect((await request(app).post(`/api/social/plane/work-sharing/${team.body.grant.id}/transition`).set('x-user', 'u-sana').send({ action: 'stop', expectedRevision: 1 })).status).toBe(404);
    expect((await request(app).post('/api/social/plane/work-sharing/wsg-vera-auth-current/transition').set('x-user', 'u-theo').send({ action: 'stop', expectedRevision: 1 })).status).toBe(404);
    // A forged ownerId in the body is ignored: the grant is the caller's.
    const forged = await share('u-sana', { ownerId: 'u-vera', audience: { kind: 'conversation', id: 'social:ch:plane-general' }, nodeIds: ['work:wi-auth-e1'] });
    expect(forged.status).toBe(201);
    expect(socialWorkSharingFixture.rows().find(r => r.grantId === forged.body.grant.id)!.ownerId).toBe('u-sana');
    expect((await share('u-sana', { audience: { kind: 'conversation', id: 'social:ch:plane-general' }, nodeIds: [] })).status).toBe(400);
    expect((await share('u-sana', { audience: { kind: 'people', id: 'x' }, nodeIds: ['work:x'] })).status).toBe(400);
  });

  it('no grant, a forged grant, a revoked grant and an epoch bump refuse every write and persist nothing', async () => {
    const before = socialWorkSharingFixture.rows().length;
    const body = { audience: { kind: 'conversation', id: 'social:ch:plane-general' }, nodeIds: ['work:wi-auth-e1'] };
    expect((await share('u-eli', body)).status).toBe(403);
    sessions.set('u-eli', { ...eli, grants: { orgiq: ['sme'], social: ['participant'] } } as Session);
    expect((await share('u-eli', body)).status).toBe(403);
    users.get('u-sana')!.grants = { orgiq: ['member'] };
    expect((await share('u-sana', body)).status).toBe(403);
    users.get('u-theo')!.epoch = 2;
    expect((await share('u-theo', body)).status).toBe(401);
    expect((await request(app).post('/api/social/plane/work-sharing/wsg-vera-auth-current/transition').set('x-user', 'u-theo').send({ action: 'stop', expectedRevision: 1 })).status).toBe(401);
    jest.mocked(isAllowed).mockImplementation(async (p, action) => {
      users.get('u-vera')!.epoch = 2;
      return p.tenant === 'social' && (mockRoleActions[p.role] ?? []).includes(action);
    });
    expect((await share('u-vera', { audience: { kind: 'conversation', id: 'social:ch:auth-migration' }, nodeIds: ['work:wi-auth-e1'] })).status).toBe(401);
    expect(socialWorkSharingFixture.rows().length).toBe(before);
  });
});

describe('GET /work-graph/conversations/:id/graph on the plane — Social’s builder, re-gated', () => {
  const path = (conversation: string) => `/api/social/plane/work-graph/conversations/${encodeURIComponent(conversation)}/graph`;
  it('a member reads the conversation graph without leaving orgiq; a non-member and a malformed name get the uniform 404', async () => {
    const res = await request(app).get('/api/social/plane/work-graph/conversations/social%3Ach%3Aplane-general/graph').query({ day: today(), timezone: 'UTC' }).set('x-user', 'u-theo');
    expect(res.status).toBe(200);
    expect(res.body.scope.personId).toBe('conversation:social:ch:plane-general');
    expect(res.body.nodes.map((n: { id: string }) => n.id)).toContain('sconv:social:ch:plane-general');
    expect(sessions.get('u-theo')).toMatchObject({ tenant: 'orgiq', role: 'member' });
    const unavailable = { error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' };
    const outsider = await request(app).get(path('social:ch:plane-private')).query({ day: today(), timezone: 'UTC' }).set('x-user', 'u-theo');
    expect([outsider.status, outsider.body]).toEqual([404, unavailable]);
    const bad = await request(app).get(path('nonsense')).query({ day: today(), timezone: 'UTC' }).set('x-user', 'u-theo');
    expect([bad.status, bad.body]).toEqual([404, unavailable]);
    expect((await request(app).get(path('social:ch:plane-general')).query({ day: today(), timezone: 'UTC' }).set('x-user', 'u-eli')).status).toBe(403);
    users.get('u-theo')!.grants = { orgiq: ['member'] };
    expect((await request(app).get(path('social:ch:plane-general')).query({ day: today(), timezone: 'UTC' }).set('x-user', 'u-theo')).status).toBe(403);
  });
});

describe('social_bindings `team` kind — an org team binds under the same dual-grant gate', () => {
  it('reads need social + orgiq grants; binding needs ManageChannels; a malformed context is a 400', async () => {
    const view = await request(app).get('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-sana');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ context: 'team:t-platform', tenant: 'orgiq', binding: null, canManage: false });
    // Mira holds no orgiq grant: the orgiq context is not hers to read.
    expect((await request(app).get('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-mira')).status).toBe(403);
    expect((await request(app).put('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-sana').send({ channel: 'social:ch:plane-open' })).status).toBe(403);
    const bound = await request(app).put('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-operator').send({ channel: 'social:ch:plane-open' });
    expect(bound.status).toBe(200);
    expect(bound.body.binding).toMatchObject({ tenant: 'orgiq', contextKind: 'team', contextId: 't-platform', channel: 'social:ch:plane-open' });
    expect((await request(app).get('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-sana')).body.binding).toMatchObject({ slug: 'plane-open' });
    expect((await request(app).delete('/api/social/bindings').query({ context: 'team:t-platform' }).set('x-user', 'u-operator')).body.binding).toBeNull();
    expect((await request(app).get('/api/social/bindings').query({ context: 'team:' }).set('x-user', 'u-sana')).status).toBe(400);
  });
});

// ── One Social permission path (docs/audit/2026-10-07-audit-plan.md D1) ──────
//
// `socialGate` (lib/social-authority.ts) is the only gate on /api/social/*, /api/social/plane/* and the bindings
// routes. For one (user, action, epoch) the verdict is the same on every URL; the tenant mount only adds the
// `requireTenant('social')` boundary in front. The retired `personalTeamSession`, `embedGate` and the WeakSet
// that let the plane's gate vouch for the tenant router's handlers are gone, so nothing here can disagree for a
// grants-refresh window.
describe('one Social permission path — the tenant mount and the plane agree', () => {
  const tenantApp = express(); tenantApp.use(express.json());
  tenantApp.use((req, _res, next) => { const s = sessions.get(`social:${String(req.headers['x-user'])}`); if (s) req.session = structuredClone(s); next(); });
  tenantApp.use('/api/social', socialEmbedRouter);
  tenantApp.use('/api/social', requireTenant('social'), socialRouter); tenantApp.use(errorHandler);
  const T = '/api/social';
  // The routes both mounts serve (the plane's own reads live only on the plane).
  const SHARED_READS = READS.filter(p => !/^\/(capabilities|active|people\/u-|work-graph)/.test(p));
  const verdict = (status: number) => (status === 401 || status === 403 ? status : 'pass');
  const standingInSocial = (s: Session): Session => ({ ...s, tenant: 'social', role: (s.grants.social?.[0] ?? 'participant') } as Session);

  beforeEach(() => { for (const s of [sana, mira, theo, operator, eli]) sessions.set(`social:${s.sub}`, standingInSocial(structuredClone(s))); });

  it.each(['u-sana', 'u-mira', 'u-operator'])('%s gets the same verdict for every shared read and write on both URLs', async user => {
    for (const path of SHARED_READS) {
      const plane = await get(`${P}${path}`, user);
      const tenant = await request(tenantApp).get(`${T}${path}`).set('x-user', user);
      expect([path, verdict(plane.status)]).toEqual([path, verdict(tenant.status)]);
    }
    for (const w of WRITES) {
      const plane = await send(w, user);
      const tenant = await request(tenantApp)[w.method](`${T}${w.path}`).set('x-user', user).send(w.body ?? {});
      expect([w.path, verdict(plane.status)]).toEqual([w.path, verdict(tenant.status)]);
    }
  });

  it('the bindings routes ask the same gate: ViewSocial + a grant in the context tenant to read, ManageChannels to bind', async () => {
    const ctx = { context: 'initiative:p-auth-migration' };
    for (const app_ of [app, tenantApp]) {
      expect((await request(app_).get('/api/social/bindings').query(ctx).set('x-user', 'u-sana')).status).toBe(200);
      expect((await request(app_).put('/api/social/bindings').query(ctx).set('x-user', 'u-sana').send({ channel: 'social:ch:plane-open' })).status).toBe(403);
      // Mira holds no orgiq grant: the context's tenant refuses her, naming it, on both mounts.
      const refused = await request(app_).get('/api/social/bindings').query(ctx).set('x-user', 'u-mira');
      expect([refused.status, refused.body.requiredTenant]).toEqual([403, 'orgiq']);
      // Eli holds no Social grant: refused (403 standing in orgiq; 401 standing in social, where his signed role is the forgery).
      expect([401, 403]).toContain((await request(app_).get('/api/social/bindings').query(ctx).set('x-user', 'u-eli')).status);
    }
  });

  it('a revoked grant, an epoch bump, a forged cookie, a stale masquerade actor and a cross-tenant claim each refuse on both URLs', async () => {
    const both = async (path: string, user: string) => [(await get(`${P}${path}`, user)).status, (await request(tenantApp).get(`${T}${path}`).set('x-user', user)).status];
    const refusals = (codes: number[]) => codes.every(c => c === 401 || c === 403);
    // Revoked Social grant: 403 on both (the signed orgiq / social role may itself be gone — then 401; still a refusal).
    users.get('u-sana')!.grants = { orgiq: ['member'] };
    expect(refusals(await both('/channels', 'u-sana'))).toBe(true);
    expect(refusals(await both('/teams', 'u-sana'))).toBe(true);
    // Epoch bump: 401 on both.
    users.get('u-mira')!.epoch = 2;
    expect(await both('/channels', 'u-mira')).toEqual([401, 401]);
    // A forged cookie claiming a Social grant the directory does not hold: refused on both (403 where the signed
    // role still stands, 401 where the forged role is the signed one).
    sessions.set('u-eli', { ...eli, grants: { orgiq: ['sme'], social: ['community-admin'] } } as Session);
    sessions.set('social:u-eli', { ...eli, tenant: 'social', role: 'community-admin', grants: { orgiq: ['sme'], social: ['community-admin'] } } as Session);
    expect(refusals(await both('/channels', 'u-eli'))).toBe(true);
    // Masquerade: the actor must still be a current admin; a bumped actor epoch refuses on both.
    const act = { sub: 'u-operator', epoch: 5, role: 'admin', tenant: 'orgiq', grants: {} } as Session['act'];
    sessions.set('u-theo', { ...theo, act } as Session);
    sessions.set('social:u-theo', { ...standingInSocial(theo), act } as Session);
    expect(await both('/channels', 'u-theo')).toEqual([401, 401]);
    // A cookie whose signed tenant/role the directory does not grant (cross-tenant forgery): 401 on both.
    sessions.set('u-operator', { ...operator, tenant: 'pipelines', role: 'author' } as Session);
    sessions.set('social:u-operator', { ...operator, tenant: 'social', role: 'participant' } as Session);
    expect(await both('/channels', 'u-operator')).toEqual([401, 401]);
    // No session at all: the gate answers 401, never the dev persona (the tenant mount's `requireTenant` boundary
    // meets that persona first and refuses it as parked in orgiq — a refusal either way).
    expect((await request(app).get(`${P}/channels`)).status).toBe(401);
    expect([401, 403]).toContain((await request(tenantApp).get(`${T}/channels`)).status);
  });
});

// ── One shared-work notion (docs/audit/2026-10-07-audit-plan.md D6) ───────────
//
// `sharedWorkInConversation` (lib/work-graph/shared-work.ts) is the one resolver behind the conversation's Shared
// work view on both mounts; `buildSharedWork`'s `items` and Active now's `workSharing` read the same grant
// derivation (`ownerSharingState`). Every row is folded through the viewer's current authority: a title the
// viewer may not read never leaves the server.
describe('GET /conversations/:id/shared-work — owner, audience, outsider, historical, implicit membership; no title leaks', () => {
  type Item = { kind: string; id: string; title: string | null; status: string; sharedBy: { userId: string } | null; sharedInto: { kind: string; id: string }; authority: string; provenance: string; ref: Record<string, string> };
  const path = (c: string) => `/api/social/plane/conversations/${encodeURIComponent(c)}/shared-work`;
  const items = (body: { items: Item[] }) => body.items;

  it('an audience member sees the grants shared into the conversation — active and historical — and the owner sees her own', async () => {
    // Theo and Vera are members of #auth-migration, the seeded grants' audience.
    const theo = await request(app).get('/api/social/plane/conversations/social%3Ach%3Aauth-migration/shared-work').set('x-user', 'u-theo');
    expect(theo.status).toBe(200);
    expect(theo.headers['cache-control']).toBe('no-store');
    expect(theo.body).toMatchObject({ conversation: 'social:ch:auth-migration', title: '#auth-migration' });
    const byId = new Map(items(theo.body).map(i => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual(['initiative:p-auth-migration', 'work:wi-auth-e1', 'work:wi-auth-e1-b4', 'work:wi-auth-e2']);
    expect(byId.get('work:wi-auth-e1')).toMatchObject({ kind: 'work-node', status: 'available', sharedBy: { userId: 'u-vera' }, authority: 'grant', provenance: 'grant:active',
      sharedInto: { kind: 'conversation', id: 'social:ch:auth-migration' }, ref: { grantId: 'wsg-vera-auth-current' } });
    expect(byId.get('work:wi-auth-e2')).toMatchObject({ provenance: 'grant:historical', ref: { grantId: 'wsg-vera-auth-history' } });
    for (const i of items(theo.body)) expect(typeof i.title).toBe('string');
    // The owner is in her own audience: the same rows, from the same resolver.
    const vera = await get(path('social:ch:auth-migration'), 'u-vera');
    expect(items(vera.body).map(i => i.id).sort()).toEqual([...byId.keys()].sort());
    // A stop leaves only the history grant's days.
    socialWorkSharingFixture.rows().find(r => r.grantId === 'wsg-vera-auth-current')!.grant.state = 'stopped';
    const later = await get(path('social:ch:auth-migration'), 'u-theo');
    expect(items(later.body).map(i => [i.id, i.provenance])).toEqual([['work:wi-auth-e2', 'grant:historical']]);
  });

  it('an outsider gets the uniform 404 — on the plane and on the tenant mount — and a malformed name reads the same', async () => {
    expect((await get(path('social:ch:auth-migration'), 'u-sana')).status).toBe(404);
    expect((await get(path('social:ch:plane-private'), 'u-theo')).status).toBe(404);
    expect((await get(path('nonsense'), 'u-theo')).status).toBe(404);
    expect((await get(path('social:ch:auth-migration'), 'u-eli')).status).toBe(403);
    const tenantApp = express(); tenantApp.use(express.json());
    tenantApp.use((req, _res, next) => { req.session = S(String(req.headers['x-user']), 'social', 'participant', { orgiq: ['member'], social: ['participant'] }); next(); });
    tenantApp.use('/api/social', requireTenant('social'), socialRouter); tenantApp.use(errorHandler);
    const inSocial = await request(tenantApp).get('/api/social/conversations/social%3Ach%3Aauth-migration/shared-work').set('x-user', 'u-theo');
    expect(inSocial.status).toBe(200);
    expect(items(inSocial.body).map(i => i.id).sort()).toEqual(items((await get(path('social:ch:auth-migration'), 'u-theo')).body).map(i => i.id).sort());
    expect((await request(tenantApp).get('/api/social/conversations/social%3Ach%3Aauth-migration/shared-work').set('x-user', 'u-sana')).status).toBe(404);
  });

  it('a page reference is a row for every member, but its title only for a reader who may open the page now', async () => {
    for (const userId of ['u-vera', 'u-mira']) {
      await chat.membershipStore.putMember({ channel: 'social:ch:plane-general', userId, role: 'member', addedBy: userId, addedAt: '2026-10-01T00:00:00.000Z', historyFrom: null, removedAt: null });
    }
    await chat.chatStore.putMessage({ id: 'm-sw-1', clientId: 'c', userId: 'u-vera', channel: 'social:ch:plane-general', message: 'look',
      timestamp: clock.nowIso(), metadata: { displayName: 'Vera', pageReference: { kind: 'work-item', id: 'wi-auth-e2-b3' } } } as never);
    await chat.chatStore.putMessage({ id: 'm-sw-2', clientId: 'c', userId: 'u-theo', channel: 'social:ch:plane-general', message: 'gone',
      timestamp: clock.nowIso(), metadata: { displayName: 'Theo', pageReference: { kind: 'initiative', id: 'p-does-not-exist' } } } as never);
    // Sana stands in orgiq: the work item resolves under her authority.
    const sana = await get(path('social:ch:plane-general'), 'u-sana');
    const forSana = new Map(items(sana.body).map(i => [i.ref['messageId'], i]));
    expect(forSana.get('m-sw-1')).toMatchObject({ kind: 'work-item', id: 'wi-auth-e2-b3', status: 'available', title: expect.any(String), authority: 'membership', provenance: 'reference', sharedBy: { userId: 'u-vera' } });
    // A reference to a page that does not exist is a row with no title, never a 404 of the whole view.
    expect(forSana.get('m-sw-2')).toMatchObject({ kind: 'initiative', id: 'p-does-not-exist', status: 'unavailable', title: null });
    // Mira holds no orgiq grant: the row exists, the title does not reach her.
    const mira = await get(path('social:ch:plane-general'), 'u-mira');
    expect(items(mira.body).find(i => i.ref['messageId'] === 'm-sw-1')).toMatchObject({ status: 'unavailable', title: null, href: null });
    // A member added after the message (history floor) never sees it.
    await chat.membershipStore.putMember({ channel: 'social:ch:plane-general', userId: 'u-lena', role: 'member', addedBy: 'u-lena',
      addedAt: clock.nowIso(), historyFrom: new Date(Date.parse(clock.nowIso()) + 60_000).toISOString(), removedAt: null });
    expect(items((await get(path('social:ch:plane-general'), 'u-lena')).body).map(i => i.ref['messageId'])).not.toContain('m-sw-1');
  });

  it('a person’s shared work and Active now derive from the same grants: items name the audience, the flag the state', async () => {
    const person = await get('/api/social/plane/people/u-vera/shared-work', 'u-theo');
    const rows = items(person.body);
    expect(rows.map(i => i.id).sort()).toEqual(['initiative:p-auth-migration', 'work:wi-auth-e1', 'work:wi-auth-e1-b4', 'work:wi-auth-e2']);
    for (const i of rows) expect(i).toMatchObject({ kind: 'work-node', authority: 'grant', sharedInto: { kind: 'conversation', id: 'social:ch:auth-migration' } });
    // The owner's list is exactly what her audience can see — the stopped share's history node included, as historical.
    const own = await get('/api/social/plane/people/u-vera/shared-work', 'u-vera');
    expect(items(own.body).map(i => [i.id, i.provenance]).sort()).toEqual([['initiative:p-auth-migration', 'grant:active'], ['work:wi-auth-e1', 'grant:active'], ['work:wi-auth-e1-b4', 'grant:active'], ['work:wi-auth-e2', 'grant:historical']]);
    expect(items((await get('/api/social/plane/people/u-vera/shared-work', 'u-sana')).body)).toEqual([]);
    const active = await get('/api/social/plane/active', 'u-theo');
    expect(person_(active.body, 'u-vera')?.workSharing).toEqual({ state: 'active', fresh: true });
    socialWorkSharingFixture.rows().find(r => r.grantId === 'wsg-vera-auth-current')!.grant.state = 'stopped';
    expect(person_((await get('/api/social/plane/active', 'u-theo')).body, 'u-vera')?.workSharing).toMatchObject({ state: 'historical' });
    expect(items((await get('/api/social/plane/people/u-vera/shared-work', 'u-theo')).body).map(i => i.provenance)).toEqual(['grant:historical']);
  });
  const person_ = (body: ActiveBody, id: string) => body.people.find(p => p.userId === id);
});
