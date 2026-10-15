// GET /api/me/groups?kind= (routes/me-groups.ts, lib/mine.ts) — the ONE "mine"
// reader behind the Communication plane's My initiatives / My teams / My
// pipelines / My org teams (docs/communication-plane-goal.md §1.3–§1.4), mounted
// as index.ts mounts it (session floor; the kind's tenant boundary and read
// action inside). Pinned, per kind: own groups only; another tenant refused;
// forged query/body ignored; unlinked → honest empty with the reason in
// `limits`; an identity or provider outage → 503. Assessment teams come from
// the explicit membership rows, never a display name.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../providers/pipeline-definitions.js', () => ({ ...jest.requireActual('../../providers/pipeline-definitions.js'), loadDefinitionSources: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ ...jest.requireActual('../../lib/authz.js'), isAllowed: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { isAllowed, requireSession } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { loadDefinitionSources } from '../../providers/pipeline-definitions.js';
import { meGroupsRouter } from '../me-groups.js';
import { MINE_KINDS, UNLINKED_LIMIT, type MineReply } from '../../lib/mine.js';
import { assessmentTeamMembersFixture } from '../../mock/assessment-team-members.js';
import { graphPeople, graphTeams } from '../../mock/people.js';
import { initiatives } from '../../mock/initiatives.js';
import type { Session } from '../../lib/session.js';

const USERS: UserInfo[] = [
  { id: 'u-vera', displayName: 'Vera Green', email: null, personId: 'p-002', epoch: 0, grants: { orgiq: ['org-leader', 'member'], social: ['participant'] } },
  { id: 'u-theo', displayName: 'Theo Chang', email: null, personId: 'p-001', epoch: 0, grants: { orgiq: ['member'] } },
  { id: 'u-raj', displayName: 'Raj Mehta', email: null, personId: 'p-015', epoch: 0, grants: { orgiq: ['member'] } },
  { id: 'u-hr', displayName: 'Helen Desai', email: null, personId: null, epoch: 0, grants: { orgiq: ['hr-admin'] } },
  // A namesake of the TEAM-001 lead with an assessment grant: the name must not put her on the team.
  { id: 'u-priya', displayName: 'Deepa Natarajan', email: 'deepa.natarajan@example.com', personId: null, epoch: 0, grants: { assessment: ['lead-assessor'] } },
  { id: 'u-asha', displayName: 'Asha Nair', email: 'asha.nair@assessment.example', personId: null, epoch: 0, grants: { assessment: ['assessor'] } },
  { id: 'u-jonas', displayName: 'Jonas Lindqvist', email: null, personId: null, epoch: 0, grants: { assessment: ['lead-assessor'] } },
  { id: 'u-tomas', displayName: 'Tomás Ferreira', email: null, personId: null, epoch: 0, grants: { pipelines: ['author'] } },
  { id: 'u-kofi', displayName: 'Kofi', email: null, personId: null, epoch: 0, grants: { pipelines: ['operator'] } },
  { id: 'u-operator', displayName: 'Operator', email: null, personId: null, epoch: 0, grants: { orgiq: ['admin'], assessment: ['admin'], pipelines: ['admin'] } },
];
const sessions = new Map<string, Session>(USERS.map((u) => {
  const tenant = Object.keys(u.grants)[0]!;
  return [u.id, { sub: u.id, tenant, role: u.grants[tenant]![0]!, epoch: 0, iat: 1, grants: u.grants } as Session];
}));
const app = express();
app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = structuredClone(s); next(); });
app.use('/api/me/groups', requireSession('MyGroups'), meGroupsRouter);
app.use(errorHandler);
const mine = (kind: string, user: string, extra: Record<string, string> = {}) => request(app).get('/api/me/groups').query({ kind, ...extra }).set('x-user', user);

const stored = (id: string, updatedBy: string | null) => ({ id, contextTenant: 'orgiq', kind: 'bot', title: id, owner: null, version: 2, approverRoles: [], sourceTable: 'agent_bots', sourceId: id, updatedBy, updatedAt: null });
const bot = (id: string, name: string, createdBy: string | null) => ({
  id, name, prompt: 'p', model: 'm', trigger: 'cron', cronExpr: '0 6 * * *', enabled: false, requiresReview: true, orgProjectId: null, createdBy,
});

beforeEach(() => {
  graphPeople.reset(); graphTeams.reset(); assessmentTeamMembersFixture.reset(); initiatives.reset();
  jest.mocked(getUser).mockImplementation(async (id) => structuredClone(USERS.find((u) => u.id === id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => structuredClone(USERS));
  // Open-mode Cedar as the seeds decide it for the two kinds that ask a read action.
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.role === 'admin'
    || (action === 'ViewAssessment' && p.tenant === 'assessment') || (action === 'ViewPipelines' && p.tenant === 'pipelines'));
  jest.mocked(loadDefinitionSources).mockResolvedValue({
    unavailable: [],
    sources: { bots: [bot('b1', 'mine-bot', 'u-tomas'), bot('b2', 'edited-bot', 'u-rachel'), bot('b3', 'other-bot', 'u-rachel')], commands: [], runbooks: [], agents: [], stored: [stored('bot:b2', 'u-tomas')] },
  } as never);
});

const body = (res: { body: unknown }) => res.body as MineReply;

describe('the one shape', () => {
  it('every kind answers { viewer, items, limits } with no-store, and an unknown kind is a 400', async () => {
    for (const kind of MINE_KINDS) {
      const user = kind === 'assessment-team' ? 'u-asha' : kind === 'pipeline' ? 'u-tomas' : 'u-vera';
      const res = await mine(kind, user);
      expect([kind, res.status]).toEqual([kind, 200]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body(res)).toMatchObject({ viewer: { userId: user }, limits: expect.any(Array) });
      for (const item of body(res).items) expect(item).toMatchObject({ kind, id: expect.any(String), name: expect.any(String), membership: expect.any(String) });
    }
    expect((await mine('teams', 'u-vera')).status).toBe(400);
    expect((await request(app).get('/api/me/groups').set('x-user', 'u-vera')).status).toBe(400);
  });

  it('forged query fields change nothing: the viewer is the session and its directory link', async () => {
    const res = await mine('org-team', 'u-hr', { userId: 'u-vera', personId: 'p-002', sub: 'u-vera' });
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ viewer: { userId: 'u-hr', personId: null }, items: [], limits: [UNLINKED_LIMIT] });
  });

  it('another tenant is refused, the admin passes every boundary, and the dev persona reads unlinked', async () => {
    expect((await mine('initiative', 'u-asha')).status).toBe(403);
    expect((await mine('assessment-team', 'u-vera')).status).toBe(403);
    expect((await mine('pipeline', 'u-asha')).status).toBe(403);
    expect((await mine('org-team', 'u-tomas')).body).toMatchObject({ requiredTenant: 'orgiq', tenant: 'pipelines' });
    for (const kind of MINE_KINDS) expect([kind, (await mine(kind, 'u-operator')).status]).toEqual([kind, 200]);
    // Cookie-less in development is the demo persona (lib/authz.ts), which has no app_users row: unlinked, not a leak.
    const anonymous = await request(app).get('/api/me/groups').query({ kind: 'initiative' });
    expect([anonymous.status, anonymous.body.items, anonymous.body.limits]).toEqual([200, [], [UNLINKED_LIMIT]]);
    // The two kinds behind a host read action refuse a role Cedar denies.
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect((await mine('assessment-team', 'u-asha')).status).toBe(403);
    expect((await mine('pipeline', 'u-tomas')).status).toBe(403);
    expect((await mine('initiative', 'u-vera')).status).toBe(200);
  });

  it('a directory outage is 503', async () => {
    jest.mocked(getUser).mockRejectedValueOnce(new Error('directory down'));
    expect((await mine('initiative', 'u-vera')).status).toBe(503);
  });
});

describe('kind=initiative and kind=sprint (orgiq, the person link)', () => {
  it('lists the linked person’s initiatives with owner/contributor membership; an unlinked account reads empty and why', async () => {
    const res = body(await mine('initiative', 'u-vera'));
    expect(res.viewer).toEqual({ userId: 'u-vera', personId: 'p-002' });
    const expected = initiatives.rows().filter((p) => p.owner === 'p-002' || p.smes.includes('p-002')).map((p) => p.id).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(res.items.map((i) => i.id).sort()).toEqual(expected);
    for (const item of res.items) {
      const row = initiatives.rows().find((p) => p.id === item.id)!;
      expect(item.membership).toBe(row.owner === 'p-002' ? 'owner' : 'contributor');
    }
    const unlinked = body(await mine('initiative', 'u-hr'));
    expect(unlinked).toEqual({ viewer: { userId: 'u-hr', personId: null }, items: [], limits: [UNLINKED_LIMIT] });
    const sprints = body(await mine('sprint', 'u-vera'));
    for (const s of sprints.items) expect(s).toMatchObject({ kind: 'sprint', counts: { items: expect.any(Number) } });
    expect(body(await mine('sprint', 'u-hr')).limits).toEqual([UNLINKED_LIMIT]);
  });
});

describe('kind=org-team (orgiq, team_memberships)', () => {
  it('answers the linked person’s teams with every member, users resolved where linked', async () => {
    const res = body(await mine('org-team', 'u-vera'));
    expect(res.viewer.personId).toBe('p-002');
    expect(res.items).toHaveLength(1);
    const team = res.items[0]!;
    expect(team).toMatchObject({ kind: 'org-team', id: 't-platform', name: 'Platform Engineering', role: 'Principal Engineer', membership: 'member' });
    const expected = graphPeople.rows().filter((p) => p.department === 'Platform Engineering').map((p) => p.id).sort();
    expect(team.members!.map((m) => m.personId).sort()).toEqual(expected);
    expect(team.counts).toEqual({ members: expected.length });
    expect(team.members!.find((m) => m.personId === 'p-001')).toEqual({ personId: 'p-001', name: 'Theo Chang', userId: 'u-theo' });
    expect(team.members!.find((m) => m.personId === 'p-003')).toEqual({ personId: 'p-003', name: "Owen Brooks", userId: null });
    // Raj is on Data Platform: a different team, the same shape, and Vera is not on it.
    const raj = body(await mine('org-team', 'u-raj'));
    expect(raj.items.map((t) => t.id)).toEqual(['t-data']);
    expect(raj.items[0]!.members!.some((m) => m.personId === 'p-002')).toBe(false);
  });

  it('an unlinked account reads no teams and says so', async () => {
    expect(body(await mine('org-team', 'u-hr'))).toEqual({ viewer: { userId: 'u-hr', personId: null }, items: [], limits: [UNLINKED_LIMIT] });
  });
});

describe('kind=assessment-team (assessment, assessment_team_members rows)', () => {
  it('lists only the teams the assessor holds a membership row on, with the roster resolved to users', async () => {
    const res = body(await mine('assessment-team', 'u-asha'));
    expect(res.viewer).toEqual({ userId: 'u-asha', personId: null });
    expect(res.limits).toEqual([]);
    // Asha contributes on Northstar (Jonas leads it) and leads Checkout and Fraud Detection.
    expect(res.items.map((i) => [i.id, i.membership]).sort()).toEqual([['TEAM-001', 'contributor'], ['TEAM-003', 'lead'], ['TEAM-006', 'lead']]);
    expect(res.items.find((i) => i.id === 'TEAM-001')).toEqual({
      kind: 'assessment-team', id: 'TEAM-001', name: 'Northstar Payments', role: null, membership: 'contributor',
      counts: { members: 2 }, members: expect.arrayContaining([{ userId: 'u-asha', personId: null, name: 'Asha Nair' }, { userId: 'u-jonas', personId: null, name: 'Jonas Lindqvist' }]),
    });
  });

  it('a namesake of a team’s lead is on no team: the display name is not a link, only a row is', async () => {
    // u-priya is named "Deepa Natarajan" here, a name TEAM-001 records as a contributor — the retired rule would have put her on it.
    expect(body(await mine('assessment-team', 'u-priya'))).toEqual({ viewer: { userId: 'u-priya', personId: null }, items: [], limits: [] });
    expect(body(await mine('assessment-team', 'u-jonas')).items.map((i) => i.id).sort()).toEqual(['TEAM-001', 'TEAM-002', 'TEAM-007']);
    // A row is: add her and she is on it, as its lead, beside Asha and Jonas.
    assessmentTeamMembersFixture.rows().push({ teamId: 'TEAM-001', userId: 'u-priya', role: 'lead', addedAt: '2026-10-01T00:00:00.000Z' });
    const now = body(await mine('assessment-team', 'u-priya'));
    expect(now.items).toHaveLength(1);
    expect(now.items[0]).toMatchObject({ id: 'TEAM-001', membership: 'lead', counts: { members: 3 } });
    expect(now.items[0]!.members!.map((m) => m.userId).sort()).toEqual(['u-asha', 'u-jonas', 'u-priya']);
  });

  it('a membership row naming a team that no longer exists shows nothing; a provider outage is 503', async () => {
    assessmentTeamMembersFixture.rows().push({ teamId: 'TEAM-999', userId: 'u-asha', role: 'member', addedAt: '2026-10-01T00:00:00.000Z' });
    expect(body(await mine('assessment-team', 'u-asha')).items.map((i) => i.id).sort()).toEqual(['TEAM-001', 'TEAM-003', 'TEAM-006']);
    jest.mocked(listUsers).mockRejectedValueOnce(new Error('down'));
    expect((await mine('assessment-team', 'u-asha')).status).toBe(503);
  });
});

describe('kind=pipeline (pipelines, a definition’s owner or last recorder)', () => {
  it('lists what the author owns or last edited, with the membership; another author reads nothing; an outage is 503', async () => {
    const res = body(await mine('pipeline', 'u-tomas'));
    expect(res.items).toEqual([
      { kind: 'pipeline', id: 'bot:b2', name: 'edited-bot', role: 'paused', membership: 'editor' },
      { kind: 'pipeline', id: 'bot:b1', name: 'mine-bot', role: 'paused', membership: 'owner' },
    ]);
    expect(body(await mine('pipeline', 'u-kofi', { userId: 'u-tomas' })).items).toEqual([]);
    jest.mocked(loadDefinitionSources).mockRejectedValueOnce(new Error('down'));
    expect((await mine('pipeline', 'u-tomas')).status).toBe(503);
  });
});
