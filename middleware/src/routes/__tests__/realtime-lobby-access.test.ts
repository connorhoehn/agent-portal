// POST /api/realtime/lobby-access (routes/realtime-lobby-access.ts) — the
// question platform-api asks before it opens a call lobby when
// LOBBY_AUTHORITY_REQUIRED=true (docs/social-calls-plan.md, "Lobby admission
// at platform-api"). Pinned: the answer is yes ONLY when the gateway's own
// fresh call admission (lobbyGuard + live-principal) admits the bearer; a
// refused, forged, unlisted or stale lobby gets 403 and no allowance; a bad or
// expired token is 401 before any directory read.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { pageResourceVisible } from '../../lib/page-resources.js';
import { getKnowledgeDoc } from '../../providers/assessment.js';
import { assessmentDocumentLobby } from '../../lib/assessment-document-context.js';
import { realtimeClaims, signRealtimeToken, REALTIME_TOKEN_TTL_S } from '../../lib/realtime-token.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import type { Session } from '../../lib/session.js';
import { realtimeLobbyAccessRouter } from '../realtime-lobby-access.js';

const SECRET = 'lobby-access-test-secret';
const app = express().use(express.json()).use('/api/realtime', realtimeLobbyAccessRouter);
const alice: Session = { sub: 'alice', tenant: 'orgiq', role: 'member', epoch: 2, iat: 100,
  grants: { orgiq: ['member'], social: ['participant'], assessment: ['assessor'], pipelines: ['author'] } };
// The assessment/pipelines families are active-tenant gates (requireTenant):
// asked from a session standing in that tenant.
const inAssessment: Session = { ...alice, tenant: 'assessment', role: 'assessor' };
const tokenFor = async (s: Session = alice, nowS?: number) =>
  (await signRealtimeToken(realtimeClaims(s), SECRET, nowS)).token;
const ask = (lobbyName: unknown, token?: string) => {
  const r = request(app).post('/api/realtime/lobby-access');
  return (token ? r.set('authorization', `Bearer ${token}`) : r).send({ lobbyName } as object);
};

let users: Map<string, UserInfo>;
const original = process.env['REALTIME_JWT_SECRET'];
beforeEach(() => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([['alice', { id: 'alice', displayName: 'Alice', email: null, personId: null, epoch: 2,
    grants: structuredClone(alice.grants) }]]);
  jest.mocked(getUser).mockReset().mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(isAllowed).mockReset().mockResolvedValue(true);
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  jest.mocked(getKnowledgeDoc).mockReset();
});

describe('stored recording document source read', () => {
  const sourceId = 'ec:standards/ci-cd.md', lobbyName = assessmentDocumentLobby(sourceId);
  const doc = { id: sourceId, title: 'CI standards', classification: 'internal', markdown: '', editable: false, path: '', updated_at: '' };
  const read = async (body: object = { lobbyName, documentSourceId: sourceId }, s = inAssessment) => request(app)
    .post('/api/realtime/lobby-access').set('authorization', `Bearer ${await tokenFor(s)}`).send(body);
  it('exact source exists + current Assessment read returns allowed with no Social grant', async () => {
    jest.mocked(getKnowledgeDoc).mockResolvedValue(doc);
    expect((await read()).body).toEqual({ allowed: true });
    expect(getKnowledgeDoc).toHaveBeenCalledTimes(2);
    expect(getKnowledgeDoc).toHaveBeenCalledWith(sourceId);
  });
  it('wrong hash, deleted source, wrong active tenant and revoked ViewAssessment deny', async () => {
    jest.mocked(getKnowledgeDoc).mockResolvedValue(doc);
    expect((await read({ lobbyName, documentSourceId: 'other-source' })).status).toBe(403);
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null); expect((await read()).status).toBe(403);
    expect((await read(undefined, alice)).status).toBe(403);
    jest.mocked(isAllowed).mockResolvedValue(false); expect((await read()).status).toBe(403);
  });
  it('source deletion or epoch revocation during source I/O cannot authorize playback', async () => {
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(doc).mockResolvedValueOnce(null);
    expect((await read()).status).toBe(403);
    jest.mocked(getKnowledgeDoc).mockImplementation(async () => { users.get('alice')!.epoch += 1; return doc; });
    expect((await read()).status).toBe(403);
  });
  it.each([{ lobbyName, documentSourceId: '' }, { lobbyName, documentSourceId: ['one', 'two'] }, { lobbyName: 'orgiq:initiative:p-auth-migration', documentSourceId: sourceId }])('malformed/unrelated hint %j is rejected', async body => {
    expect((await read(body)).status).toBe(400); expect(getKnowledgeDoc).not.toHaveBeenCalled();
  });
});
afterAll(() => {
  if (original === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = original;
});

describe('token', () => {
  it('no bearer, a forged signature or an expired token is 401 before any directory read', async () => {
    expect((await ask('orgiq:initiative:p-auth-migration')).status).toBe(401);
    const forged = (await signRealtimeToken(realtimeClaims(alice), 'not-the-secret')).token;
    expect((await ask('orgiq:initiative:p-auth-migration', forged)).status).toBe(401);
    const expired = await tokenFor(alice, Math.floor(Date.now() / 1000) - REALTIME_TOKEN_TTL_S - 60);
    expect((await ask('orgiq:initiative:p-auth-migration', expired)).status).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
  });
  it('production with no signing secret is 503, never an open answer', async () => {
    const token = await tokenFor();
    delete process.env['REALTIME_JWT_SECRET'];
    const env = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try { expect((await ask('orgiq:initiative:p-auth-migration', token)).status).toBe(503); }
    finally { process.env['NODE_ENV'] = env; }
  });
  it('a missing or oversized lobby name is 400', async () => {
    const token = await tokenFor();
    expect((await ask(undefined, token)).status).toBe(400);
    expect((await ask('orgiq:initiative:' + 'x'.repeat(300), token)).status).toBe(400);
  });
});

describe('admission is the gateway call admission, asked now', () => {
  it('admits a lobby lobbyGuard and the family read gate admit, uncached', async () => {
    const res = await ask('orgiq:initiative:p-auth-migration', await tokenFor());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(getUser).toHaveBeenCalledWith('alice', { authoritative: true });
  });
  it('a DM lobby only for a listed id', async () => {
    const token = await tokenFor();
    expect((await ask('orgiq:dm:alice:bob', token)).status).toBe(200);
    const refused = await ask('orgiq:dm:bob:carol', token);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ allowed: false });
  });
  it('an unlisted name under a tenant prefix is not a lobby (default deny)', async () => {
    const token = await tokenFor();
    for (const lobby of ['orgiq:anything', 'orgiq:work:w-1', 'orgiq:huddle:call-1', 'orgiq:distill:jobs', 'global-hangout', 'dm:alice:bob']) {
      expect([lobby, (await ask(lobby, token)).status]).toEqual([lobby, 403]);
    }
  });
  it('a forged tenant: a lobby in a tenant the directory no longer grants is refused, whatever the token lists', async () => {
    const token = await tokenFor(inAssessment);
    expect((await ask('assessment:doc:d-1', token)).status).toBe(200);
    users.get('alice')!.grants = { orgiq: ['member'] };
    expect((await ask('assessment:doc:d-1', token)).status).toBe(403);
    // A token standing in orgiq cannot open another tenant's page lobby,
    // whatever its tenants claim lists (requireTenant parity).
    users.get('alice')!.grants = structuredClone(alice.grants);
    const orgiqToken = await tokenFor();
    expect((await ask('assessment:doc:d-1', orgiqToken)).status).toBe(403);
    expect((await ask('pipelines:run:r-1', orgiqToken)).status).toBe(403);
    // The directory decides the partition, not the token's tenants claim:
    // a Social grant revoked after minting refuses a Social DM lobby.
    expect((await ask('social:dm:alice:bob', orgiqToken)).status).toBe(200);
    users.get('alice')!.grants = { orgiq: ['member'] };
    expect((await ask('social:dm:alice:bob', orgiqToken)).status).toBe(403);
  });
  it('a retired session epoch is refused', async () => {
    const token = await tokenFor();
    users.get('alice')!.epoch = 3;
    expect((await ask('orgiq:initiative:p-auth-migration', token)).status).toBe(403);
  });
  it('a page lobby asks its resource: a deleted team or pruned run is refused', async () => {
    const token = await tokenFor(inAssessment);
    const run = await tokenFor({ ...alice, tenant: 'pipelines', role: 'author' });
    expect((await ask('assessment:team:TEAM-7', token)).status).toBe(200);
    expect((await ask('pipelines:run:r-1', run)).status).toBe(200);
    jest.mocked(pageResourceVisible).mockResolvedValue(false);
    expect((await ask('assessment:team:TEAM-7', token)).status).toBe(403);
    expect((await ask('pipelines:run:r-1', run)).status).toBe(403);
  });
  it('the family policy decision is honoured (ViewAssessment refused → refused)', async () => {
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect((await ask('assessment:doc:d-1', await tokenFor(inAssessment))).status).toBe(403);
  });
  it('a private Social channel lobby admits its active members only', async () => {
    const token = await tokenFor();
    const channel = 'social:ch:design-private';
    expect((await ask(channel, token)).status).toBe(403);
    await socialChat().membershipStore.putMember({ channel, userId: 'alice', role: 'member', addedBy: 'alice',
      addedAt: new Date().toISOString(), historyFrom: null, removedAt: null });
    expect((await ask(channel, token)).status).toBe(200);
  });
  it('a directory outage fails closed', async () => {
    jest.mocked(getUser).mockRejectedValue(new Error('Aurora unavailable'));
    expect((await ask('orgiq:initiative:p-auth-migration', await tokenFor())).status).toBe(403);
  });
});
