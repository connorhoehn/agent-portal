// Initiatives — /api/graph/projects (routes/projects.ts).
//
// What is pinned:
//   * the AUTH FLOOR asymmetry the router's own header claims: the two reads
//     carry NO capability gate (they inherit the tenant mount), while both
//     governance writes carry DispatchAgentRun. Naming an owner or an SME is
//     deciding who may direct agents on an initiative — if either write ever
//     loses its gate, this test fails,
//   * `scope=mine` resolving through the SESSION's linked person, and an
//     UNLINKED account getting an empty list rather than everybody's work,
//   * the validation boundaries the portal depends on to distinguish "clear
//     the owner" (null) from "bad request" (empty string / missing key),
//   * that a provider refusal's own status is relayed, not flattened to 500.

const gateCalls: string[] = [];
let sessionValue: { sub: string; name?: string; role?: string } | null = { sub: 'u-1', name: 'RM' };

// lib/mine.ts (the one "mine" viewer this route resolves through) reaches config through its providers.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: () => sessionValue,
}));

jest.mock('../../providers/projects.js', () => ({
  listProjects: jest.fn(),
  getProject: jest.fn(),
  updateProjectOwner: jest.fn(),
  setContributionRole: jest.fn(),
}));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
// Who is on which initiative (sweep 11): `onInitiative` holds the initiatives
// the caller is one of the people of, `ownerOf` the ones they own.
const onInitiative = new Set<string>(['p-observability', 'p-o']);
const ownerOf = new Set<string>(['p-observability', 'p-o']);
jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async (_s: unknown, id: string) => onInitiative.has(id)),
  ownsInitiative: jest.fn(async (_s: unknown, id: string) => ownerOf.has(id)),
  requireInitiativeScope: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, id: string) => {
    if (onInitiative.has(id)) return true;
    res.status(403).json({ error: 'not on this initiative', code: 'NOT_ON_INITIATIVE' }); return false;
  }),
}));

// The budgets read tier (lib/budget-read-tier.ts) decides whether the dollar
// fields ship; these suites read as a tier holder unless a case says otherwise.
const mockCanReadBudgets = jest.fn(async () => true);
jest.mock('../../lib/budget-read-tier.js', () => ({
  ...jest.requireActual('../../lib/budget-read-tier.js'),
  canReadBudgets: () => mockCanReadBudgets(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { projectsRouter } from '../projects.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listProjects, getProject, updateProjectOwner, setContributionRole,
} from '../../providers/projects.js';
import { getUser } from '../../providers/identity.js';

const listMock = listProjects as unknown as jest.Mock;
const getMock = getProject as unknown as jest.Mock;
const ownerMock = updateProjectOwner as unknown as jest.Mock;
const roleMock = setContributionRole as unknown as jest.Mock;
const getUserMock = getUser as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/graph/projects', projectsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); getMock.mockReset(); ownerMock.mockReset(); roleMock.mockReset();
  getUserMock.mockReset();
  sessionValue = { sub: 'u-1', name: 'RM' };
  onInitiative.clear(); ['p-observability', 'p-o'].forEach((id) => onInitiative.add(id));
  ownerOf.clear(); ['p-observability', 'p-o'].forEach((id) => ownerOf.add(id));
});

describe('auth floor', () => {
  it('gates the two governance writes on DispatchAgentRun and the devbox profile pointer on ManageBudgets', () => {
    // Constructed once at module load — one gate shared by both governance
    // PATCHes; PATCH /:id/devbox-profile (DE-40) is a release-manager call.
    expect(gateCalls).toEqual(['DispatchAgentRun', 'ManageBudgets']);
  });
});

describe('GET /api/graph/projects', () => {
  it('defaults to scope=all with limit 50 and never resolves a person', async () => {
    listMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/graph/projects');
    expect(listMock).toHaveBeenCalledWith({ status: undefined, limit: 50, mineOnly: false, personId: null });
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('clamps limit into 1..200 and drops a non-numeric one back to 50', async () => {
    listMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/graph/projects?limit=0');
    await request(app).get('/api/graph/projects?limit=9999');
    await request(app).get('/api/graph/projects?limit=nope');
    expect(listMock.mock.calls.map((c) => (c[0] as { limit: number }).limit)).toEqual([1, 200, 50]);
  });

  it('rejects an unknown scope with a 400 that names the two legal values', async () => {
    const res = await request(buildApp()).get('/api/graph/projects?scope=theirs');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/'mine' or 'all'/);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('scope=mine narrows by the session user\'s LINKED person', async () => {
    getUserMock.mockResolvedValue({ id: 'u-1', personId: 'p-004' });
    listMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/graph/projects?scope=mine');
    expect(getUserMock).toHaveBeenCalledWith('u-1');
    expect(listMock).toHaveBeenCalledWith({ status: undefined, limit: 50, mineOnly: true, personId: 'p-004' });
  });

  it('scope=mine on an UNLINKED account asks for mine with no person — not everybody\'s', async () => {
    getUserMock.mockResolvedValue({ id: 'u-1', personId: null });
    listMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/graph/projects?scope=mine');
    const arg = listMock.mock.calls[0]![0] as { mineOnly: boolean; personId: string | null };
    expect(arg.mineOnly).toBe(true);
    expect(arg.personId).toBeNull();
  });

  it('scope=mine with no session at all still stays narrowed', async () => {
    sessionValue = null;
    listMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/graph/projects?scope=mine');
    expect(getUserMock).not.toHaveBeenCalled();
    expect((listMock.mock.calls[0]![0] as { personId: null }).personId).toBeNull();
  });

  it('passes a status filter through and returns the provider list verbatim', async () => {
    listMock.mockResolvedValue([{ id: 'p-observability', name: 'Observability', status: 'active' }]);
    const res = await request(buildApp()).get('/api/graph/projects?status=active');
    expect(res.status).toBe(200);
    expect((listMock.mock.calls[0]![0] as { status?: string }).status).toBe('active');
    expect(res.body[0].id).toBe('p-observability');
  });
});

describe('the budgets read tier (lib/budget-read-tier.ts)', () => {
  const row = { id: 'p-observability', name: 'Observability', status: 'active', agentSpendUsd: 1.73, allocatedUsd: 95 };
  afterEach(() => mockCanReadBudgets.mockResolvedValue(true));

  it('a tier holder gets the list and the detail unchanged', async () => {
    listMock.mockResolvedValue([row]);
    getMock.mockResolvedValue({ ...row, contributors: [] });
    expect((await request(buildApp()).get('/api/graph/projects')).body).toEqual([row]);
    expect((await request(buildApp()).get('/api/graph/projects/p-observability')).body).toEqual({ ...row, contributors: [], canWriteWork: true });
  });

  it('below the tier the dollar fields are withheld and budgetAccess says why and what to request', async () => {
    mockCanReadBudgets.mockResolvedValue(false);
    listMock.mockResolvedValue([row]);
    getMock.mockResolvedValue({ ...row, contributors: [] });
    const locked = { visible: false, reason: expect.stringContaining('budgets read tier'), requestItemId: 'capability:orgiq:budgets-read' };
    const list = await request(buildApp()).get('/api/graph/projects');
    expect(list.body).toEqual([{ id: 'p-observability', name: 'Observability', status: 'active', budgetAccess: locked }]);
    const detail = await request(buildApp()).get('/api/graph/projects/p-observability');
    expect(detail.body).toEqual({ id: 'p-observability', name: 'Observability', status: 'active', contributors: [], budgetAccess: locked, canWriteWork: true });
  });
});

describe('GET /api/graph/projects/:id', () => {
  it('returns the detail, and 404s an id nothing matches', async () => {
    getMock.mockResolvedValue({ id: 'p-observability', name: 'Observability', contributors: [] });
    const ok = await request(buildApp()).get('/api/graph/projects/p-observability');
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('p-observability');

    getMock.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/graph/projects/p-nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Project not found' });
  });
});

describe('canWriteWork on the detail (sweep 11)', () => {
  it('says whether the caller is one of the initiative\'s people', async () => {
    getMock.mockResolvedValue({ id: 'p-elsewhere', name: 'Elsewhere', contributors: [] });
    expect((await request(buildApp()).get('/api/graph/projects/p-elsewhere')).body.canWriteWork).toBe(false);
    getMock.mockResolvedValue({ id: 'p-observability', name: 'Observability', contributors: [] });
    expect((await request(buildApp()).get('/api/graph/projects/p-observability')).body.canWriteWork).toBe(true);
  });
});

describe('governance writes need the initiative\'s own people (sweep 11)', () => {
  it('403s an owner change and a role change on an initiative the caller is not on', async () => {
    ownerMock.mockResolvedValue({ ok: true }); roleMock.mockResolvedValue({ ok: true });
    expect((await request(buildApp()).patch('/api/graph/projects/p-elsewhere').send({ ownerId: 'p-004' })).status).toBe(403);
    expect((await request(buildApp()).patch('/api/graph/projects/p-elsewhere/contributors/p-004').send({ role: 'sme' })).status).toBe(403);
    expect(ownerMock).not.toHaveBeenCalled();
    expect(roleMock).not.toHaveBeenCalled();
  });

  it('a contributor who is not the owner cannot name the owner; an org-wide role can', async () => {
    ownerMock.mockResolvedValue({ ok: true });
    ownerOf.delete('p-observability');
    const res = await request(buildApp()).patch('/api/graph/projects/p-observability').send({ ownerId: 'p-004' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_INITIATIVE_OWNER');
    expect(ownerMock).not.toHaveBeenCalled();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-9', role: 'org-leader' }; next(); });
    app.use('/api/graph/projects', projectsRouter);
    app.use(errorHandler);
    expect((await request(app).patch('/api/graph/projects/p-observability').send({ ownerId: 'p-004' })).status).toBe(200);
  });
});

describe('PATCH /api/graph/projects/:id (owner)', () => {
  it('sets an owner and echoes the trimmed id back', async () => {
    ownerMock.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .patch('/api/graph/projects/p-observability').send({ ownerId: '  p-004  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ownerId: 'p-004' });
    expect(ownerMock).toHaveBeenCalledWith('p-observability', 'p-004');
  });

  it('accepts null as CLEAR, and refuses an empty string as ambiguous', async () => {
    ownerMock.mockResolvedValue({ ok: true });
    const cleared = await request(buildApp())
      .patch('/api/graph/projects/p-observability').send({ ownerId: null });
    expect(cleared.status).toBe(200);
    expect(ownerMock).toHaveBeenCalledWith('p-observability', null);

    const blank = await request(buildApp())
      .patch('/api/graph/projects/p-observability').send({ ownerId: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/use null to clear/);
  });

  it('400s when ownerId is absent or the wrong type — a missing key is not a clear', async () => {
    const absent = await request(buildApp()).patch('/api/graph/projects/p-observability').send({});
    expect(absent.status).toBe(400);
    const wrongType = await request(buildApp())
      .patch('/api/graph/projects/p-observability').send({ ownerId: 7 });
    expect(wrongType.status).toBe(400);
    expect(ownerMock).not.toHaveBeenCalled();
  });

  it('relays the provider\'s own refusal status instead of flattening it to 500', async () => {
    ownerMock.mockResolvedValue({ ok: false, status: 409, error: 'owner is not a contributor' });
    const res = await request(buildApp())
      .patch('/api/graph/projects/p-observability').send({ ownerId: 'p-004' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'owner is not a contributor' });
  });
});

describe('PATCH /api/graph/projects/:id/contributors/:personId', () => {
  it('sets a contributor role', async () => {
    roleMock.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .patch('/api/graph/projects/p-observability/contributors/p-004').send({ role: ' sme ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(roleMock).toHaveBeenCalledWith('p-observability', 'p-004', 'sme');
  });

  it('accepts null as CLEAR and rejects a blank string', async () => {
    roleMock.mockResolvedValue({ ok: true });
    expect((await request(buildApp())
      .patch('/api/graph/projects/p-o/contributors/p-004').send({ role: null })).status).toBe(200);
    expect(roleMock).toHaveBeenCalledWith('p-o', 'p-004', null);

    const blank = await request(buildApp())
      .patch('/api/graph/projects/p-o/contributors/p-004').send({ role: '' });
    expect(blank.status).toBe(400);
  });

  it('404s through the provider when the contribution does not exist', async () => {
    roleMock.mockResolvedValue({ ok: false, status: 404, error: 'contribution not found' });
    const res = await request(buildApp())
      .patch('/api/graph/projects/p-o/contributors/p-999').send({ role: 'sme' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contribution not found');
  });
});
