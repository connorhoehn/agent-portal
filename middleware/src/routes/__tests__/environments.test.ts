// Environments route (routes/environments.ts) with the provider, Cedar and the
// GitHub connector mocked.
//
// What is pinned here is the ONE thing about this domain that is easy to get
// wrong and expensive to get wrong: reading the estate is wide, reaching an
// environment is not, and the two must not share a gate. `readForRolesElseAction`
// fast-paths any GET from a tenant role straight past Cedar — correct for the
// record, catastrophic for `/access`, which would then tell a member yes. So
// the access route deliberately takes only a session floor and evaluates
// EnterEnvironment itself, and these tests fail if anyone reunites them.
//
// Also pinned: a denial is a 200 with `allowed: false` rather than a 403 (the
// caller is asking a question, not attempting the thing), the access-role ARN
// is only ever returned on an allow, and GitHub failures degrade to an empty
// run list instead of failing the whole view.

const enterAllow = { value: true };
const manageAllow = { value: true };

// The Cedar layer. `isAllowed` is what /access consults; requireAction is the
// write gate. readForRolesElseAction is reproduced faithfully — including the
// GET fast-path that makes the /access route's separate handling necessary.
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => enterAllow.value),
  environmentAttrs: (env: { name: string; kind: string; rank: number; status: string }) => ({
    envName: env.name, envKind: env.kind, envRank: env.rank, envStatus: env.status,
  }),
  requireSession: () =>
    (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!req.session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      next();
    },
  requireAction: (action: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (action === 'ManageEnvironments' && !manageAllow.value) {
        res.status(403).json({ error: 'Forbidden', action });
        return;
      }
      next();
    },
  readForRolesElseAction: (readRoles: string[], action: string) =>
    (req: { method: string; session?: { role?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const role = req.session?.role ?? '';
      if (req.method === 'GET' && req.session && (role === 'admin' || readRoles.includes(role))) { next(); return; }
      if (action === 'ManageEnvironments' && !manageAllow.value) {
        res.status(403).json({ error: 'Forbidden', action });
        return;
      }
      next();
    },
}));

jest.mock('../../lib/audit.js', () => ({
  logAuthz: jest.fn(),
  eventFromSession: jest.fn(() => ({})),
}));

jest.mock('../../providers/environments.js', () => ({
  listEnvironments: jest.fn(),
  getEnvironment: jest.fn(),
  createEnvironment: jest.fn(),
  updateEnvironment: jest.fn(),
  deleteEnvironment: jest.fn(),
  repoForInitiative: jest.fn(),
  ENVIRONMENT_KINDS: ['eks', 'ecs', 'lambda', 'static', 'rds', 'other'],
  ENVIRONMENT_STATUSES: ['active', 'provisioning', 'degraded', 'retired'],
}));

jest.mock('../../lib/github-connector.js', () => ({ listWorkflowRuns: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { environmentsRouter } from '../environments.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listEnvironments, getEnvironment, createEnvironment, updateEnvironment,
  deleteEnvironment, repoForInitiative,
} from '../../providers/environments.js';
import { listWorkflowRuns } from '../../lib/github-connector.js';
import { isAllowed } from '../../lib/authz.js';

const listMock = listEnvironments as unknown as jest.Mock;
const getMock = getEnvironment as unknown as jest.Mock;
const createMock = createEnvironment as unknown as jest.Mock;
const updateMock = updateEnvironment as unknown as jest.Mock;
const deleteMock = deleteEnvironment as unknown as jest.Mock;
const repoMock = repoForInitiative as unknown as jest.Mock;
const runsMock = listWorkflowRuns as unknown as jest.Mock;
const isAllowedMock = isAllowed as unknown as jest.Mock;

const PROD = {
  id: 'b1f0a1e1-0001-4a00-8000-000000000003',
  orgProjectId: 'p-observability', orgProjectName: 'Unified Observability',
  name: 'prod', kind: 'eks', awsAccountId: '647757222309', awsRegion: 'us-east-1',
  clusterName: 'orgiq-prod', clusterArn: 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',
  namespace: 'observability',
  accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',
  rank: 30, status: 'active', createdAt: '', updatedAt: '',
};

const RETIRED = { ...PROD, id: 'b1f0a1e1-0009-4a00-8000-000000000001', name: 'legacy-prod', status: 'retired' };
const UNWIRED = { ...PROD, id: 'b1f0a1e1-0005-4a00-8000-000000000003', accessRoleArn: null, status: 'provisioning' };

function app(role: string | null) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { session?: unknown }).session = { sub: `u-${role}`, role, tenant: 'orgiq' };
    }
    next();
  });
  a.use('/api/environments', environmentsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  enterAllow.value = true;
  manageAllow.value = true;
});

describe('reading the estate is wide', () => {
  test.each(['member', 'sme', 'org-leader', 'hr-admin'])('%s may list environments', async (role) => {
    listMock.mockResolvedValue([PROD]);
    const res = await request(app(role)).get('/api/environments');
    expect(res.status).toBe(200);
    expect(res.body.environments).toHaveLength(1);
  });

  test('orgProjectId narrows the listing and is passed through, not interpolated', async () => {
    listMock.mockResolvedValue([]);
    await request(app('member')).get('/api/environments?orgProjectId=p-soc2');
    expect(listMock).toHaveBeenCalledWith('p-soc2');
  });

  test('an absent orgProjectId asks for everything', async () => {
    listMock.mockResolvedValue([]);
    await request(app('member')).get('/api/environments');
    expect(listMock).toHaveBeenCalledWith(null);
  });
});

describe('reaching an environment is not', () => {
  test('a denied principal gets 200 allowed:false and NO access role', async () => {
    // The route asks a question on the caller's behalf; a 403 would render as
    // an error toast where the honest answer is a greyed-out button.
    getMock.mockResolvedValue(PROD);
    enterAllow.value = false;
    const res = await request(app('member')).get(`/api/environments/${PROD.id}/access`);
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.accessRoleArn).toBeUndefined();
    expect(String(res.body.reason)).toContain('member');
  });

  test('the read fast-path does NOT leak into /access — Cedar is consulted every time', async () => {
    // The regression this whole file exists for: mounting /access behind the
    // router's read gate would let any tenant role through on a GET.
    getMock.mockResolvedValue(PROD);
    enterAllow.value = false;
    for (const role of ['member', 'sme', 'org-leader', 'hr-admin']) {
      const res = await request(app(role)).get(`/api/environments/${PROD.id}/access`);
      expect(res.body.allowed).toBe(false);
    }
    expect(isAllowedMock).toHaveBeenCalledTimes(4);
  });

  test('an allowed principal gets the role ARN and the connection facts', async () => {
    getMock.mockResolvedValue(PROD);
    const res = await request(app('sme')).get(`/api/environments/${PROD.id}/access`);
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.accessRoleArn).toBe(PROD.accessRoleArn);
    expect(res.body.clusterName).toBe('orgiq-prod');
  });

  test('the environment’s properties are what Cedar is asked about', async () => {
    // The design decision in lib/authz.ts environmentAttrs: decisions key on
    // tier/kind/status, never on the environment id.
    getMock.mockResolvedValue(RETIRED);
    enterAllow.value = false;
    await request(app('sme')).get(`/api/environments/${RETIRED.id}/access`);
    const [, action, attrs] = isAllowedMock.mock.calls[0]!;
    expect(action).toBe('EnterEnvironment');
    expect(attrs).toEqual({ envName: 'legacy-prod', envKind: 'eks', envRank: 30, envStatus: 'retired' });
    expect(JSON.stringify(attrs)).not.toContain(RETIRED.id);
  });

  test('a retired environment explains itself rather than blaming the role', async () => {
    getMock.mockResolvedValue(RETIRED);
    enterAllow.value = false;
    const res = await request(app('sme')).get(`/api/environments/${RETIRED.id}/access`);
    expect(String(res.body.reason)).toContain('retired');
  });

  test('authorized but unwired is distinguished from denied', async () => {
    // Different remedies: describe the role vs. change somebody's permissions.
    getMock.mockResolvedValue(UNWIRED);
    const res = await request(app('sme')).get(`/api/environments/${UNWIRED.id}/access`);
    expect(res.body.allowed).toBe(true);
    expect(res.body.accessRoleArn).toBeNull();
  });

  test('an anonymous caller is 401, never asked about', async () => {
    getMock.mockResolvedValue(PROD);
    const res = await request(app(null)).get(`/api/environments/${PROD.id}/access`);
    expect(res.status).toBe(401);
    expect(isAllowedMock).not.toHaveBeenCalled();
  });
});

describe('mutation is narrow', () => {
  test('a create is refused before the provider is touched when Cedar says no', async () => {
    manageAllow.value = false;
    const res = await request(app('member')).post('/api/environments').send({
      orgProjectId: 'p-soc2', name: 'prod', awsAccountId: '512345678901',
    });
    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('a valid create reaches the provider', async () => {
    createMock.mockResolvedValue(PROD);
    const res = await request(app('org-leader')).post('/api/environments').send({
      orgProjectId: 'p-observability', name: 'prod', kind: 'eks',
      awsAccountId: '647757222309', awsRegion: 'us-east-1', rank: 30,
      accessRoleArn: PROD.accessRoleArn,
    });
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });

  test.each([
    ['awsAccountId', { orgProjectId: 'p', name: 'prod', awsAccountId: '12345' }],
    ['awsRegion', { orgProjectId: 'p', name: 'prod', awsAccountId: '647757222309', awsRegion: 'moon-1' }],
    ['kind', { orgProjectId: 'p', name: 'prod', awsAccountId: '647757222309', kind: 'kubernetes' }],
    ['status', { orgProjectId: 'p', name: 'prod', awsAccountId: '647757222309', status: 'on' }],
    ['accessRoleArn', { orgProjectId: 'p', name: 'prod', awsAccountId: '647757222309', accessRoleArn: 'orgiq-env-prod-access' }],
    ['name', { orgProjectId: 'p', awsAccountId: '647757222309' }],
    ['orgProjectId', { name: 'prod', awsAccountId: '647757222309' }],
  ])('a bad %s is rejected before the provider', async (_field, body) => {
    const res = await request(app('org-leader')).post('/api/environments').send(body);
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('a patch forwards only the keys actually sent', async () => {
    // Sending every column would silently blank whatever the caller did not
    // load — and blanking accessRoleArn revokes reachability by accident.
    updateMock.mockResolvedValue(PROD);
    await request(app('org-leader')).patch(`/api/environments/${PROD.id}`).send({ status: 'degraded' });
    expect(updateMock).toHaveBeenCalledWith(PROD.id, { status: 'degraded' });
  });

  test('an explicit null clears a nullable column, and is not confused with absent', async () => {
    updateMock.mockResolvedValue({ ...PROD, accessRoleArn: null });
    await request(app('org-leader')).patch(`/api/environments/${PROD.id}`).send({ accessRoleArn: null });
    expect(updateMock).toHaveBeenCalledWith(PROD.id, { accessRoleArn: null });
  });

  test('a delete of an unknown id is a 404, not a silent ok', async () => {
    deleteMock.mockResolvedValue(false);
    const res = await request(app('org-leader')).delete(`/api/environments/${PROD.id}`);
    expect(res.status).toBe(404);
  });
});

describe('workflow runs are reported, never triggered', () => {
  test('the latest runs come back for the initiative’s repo', async () => {
    getMock.mockResolvedValue(PROD);
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: 'gh' });
    runsMock.mockResolvedValue([{ id: 1, name: 'Deploy', status: 'completed', conclusion: 'success' }]);
    const res = await request(app('member')).get(`/api/environments/${PROD.id}/runs?limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe('acme/obs');
    expect(runsMock).toHaveBeenCalledWith('acme/obs', 5, { connectionName: 'gh' });
  });

  test('an initiative with no linked repo says so instead of erroring', async () => {
    getMock.mockResolvedValue(PROD);
    repoMock.mockResolvedValue(null);
    const res = await request(app('member')).get(`/api/environments/${PROD.id}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(runsMock).not.toHaveBeenCalled();
  });

  test('a GitHub failure degrades to a MARKED empty list, not a 5xx', async () => {
    getMock.mockResolvedValue(PROD);
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });
    runsMock.mockRejectedValue(new Error('GitHub rate limit reached'));
    const res = await request(app('member')).get(`/api/environments/${PROD.id}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    // The reason moved from `note` to `degraded` + `error`: `note` used to
    // carry both an exception message and ordinary facts about the org, which
    // is what made a broken integration read as an idle repository. The full
    // contract is pinned in environments-runs-degraded.test.ts.
    expect(res.body.degraded).toBe(true);
    expect(String(res.body.error)).toContain('rate limit');
  });

  test('the router exposes no route that could trigger a run', async () => {
    // Reporting only, structurally: nothing here POSTs to Actions.
    const paths = (environmentsRouter.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route!.methods).join(',')} ${l.route!.path}`);
    expect(paths.some((p) => /runs/.test(p) && !p.startsWith('get'))).toBe(false);
    expect(paths.filter((p) => /dispatch|rerun|re-run|deploy/i.test(p))).toEqual([]);
  });
});

// GET /api/environments/:id — the record read, as distinct from /:id/access.
// The two look alike and behave very differently on purpose: reading the MAP
// is wide (readGate fast-paths any tenant role), asking whether you may get
// INSIDE is Cedar-evaluated per environment. This pins the record read.
describe('GET /api/environments/:id', () => {
  const ENV = {
    id: 'env-prod', orgProjectId: 'p-observability', name: 'prod', kind: 'eks',
    rank: 3, status: 'active', awsAccountId: '647757222309', awsRegion: 'us-east-1',
    clusterName: 'orgiq-prod', accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-prod-access',
  };

  it('returns the record wrapped, for a plain member', async () => {
    // An environment row names an account, a region, a cluster and a role —
    // a map, not a key. Hiding it from the people working on the initiative
    // buys no security.
    getMock.mockResolvedValue(ENV);
    const res = await request(app('member')).get('/api/environments/env-prod');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['environment']);
    expect(res.body.environment.awsAccountId).toBe('647757222309');
    expect(getMock).toHaveBeenCalledWith('env-prod');
  });

  it('does NOT ask Cedar about the specific environment — that is /:id/access', async () => {
    getMock.mockResolvedValue(ENV);
    await request(app('member')).get('/api/environments/env-prod');
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it('404s an unknown environment', async () => {
    getMock.mockResolvedValue(null);
    const res = await request(app('member')).get('/api/environments/env-nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No such environment/);
  });

  it('reads an environment that is not wired for access yet, role ARN and all', async () => {
    // null accessRoleArn means "not wired for access yet" — a real state the
    // record read has to render rather than refuse.
    getMock.mockResolvedValue({ ...ENV, accessRoleArn: null, status: 'provisioning' });
    const res = await request(app('member')).get('/api/environments/env-prod');
    expect(res.status).toBe(200);
    expect(res.body.environment.accessRoleArn).toBeNull();
    expect(res.body.environment.status).toBe('provisioning');
  });
});
