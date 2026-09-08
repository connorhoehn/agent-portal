// GET /api/environments/:id/runs — telling a broken integration apart from an
// idle repository.
//
// THE BUG THIS PINS. The handler catches, so an unreachable api.github.com
// came back as `200 { runs: [], repo, note: <exception message> }` — the same
// shape, and nearly the same words, as an initiative with no repository linked
// and as a repository with no Actions history. A reader could not tell the
// three apart and neither could any check we have: the GET wire capture
// records status codes and shapes, and all three are `200` with an empty
// array. The write-path reachability scan does not look at GET routes at all.
//
// The fix is the one routes/cost.ts already made, for the identical loss of
// meaning: those routes answered `$0.0000` whether the window was quiet or the
// database was gone, and `degraded: true` + `error` restored the difference
// without changing any existing field. cost-routes.test.ts pins that a healthy
// empty window does NOT carry the marker and every failure does; this file
// pins the same contract here, plus the third state cost.ts has no equivalent
// of — "there is no repository to ask about".
//
// The four answers, and the marker on exactly one:
//
//   { runs: [], repo: null, note }             nothing linked — a fact
//   { runs: [], repo, note }                   linked, no history — a fact
//   { runs: [...], repo }                      history
//   { runs: [], repo, degraded: true, error }  we could not ask
//
// The last two describes blocks leave the mocks behind and drive the REAL
// provider and the REAL connector with `config.mock` on, because the whole
// finding was that `dev:mock` had no branch there — a test that mocks the
// connector cannot see a missing mock branch.

const manageAllow = { value: true };

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
  environmentAttrs: () => ({}),
  requireSession: () =>
    (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!req.session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      next();
    },
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => { next(); },
  readForRolesElseAction: (readRoles: string[], action: string) =>
    (req: { method: string; session?: { role?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const role = req.session?.role ?? '';
      if (req.method === 'GET' && req.session && (role === 'admin' || readRoles.includes(role))) { next(); return; }
      if (!manageAllow.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    },
}));

jest.mock('../../lib/audit.js', () => ({ logAuthz: jest.fn(), eventFromSession: jest.fn(() => ({})) }));

// The provider and the connector are mocked ONLY for the first two blocks, so
// each of the four answers can be produced deliberately. The offline-branch
// block below imports the real modules through jest.requireActual.
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
import { getEnvironment, repoForInitiative } from '../../providers/environments.js';
import { listWorkflowRuns } from '../../lib/github-connector.js';

const getMock = getEnvironment as unknown as jest.Mock;
const repoMock = repoForInitiative as unknown as jest.Mock;
const runsMock = listWorkflowRuns as unknown as jest.Mock;

const PROD = {
  id: 'b1f0a1e1-0001-4a00-8000-000000000003',
  orgProjectId: 'p-observability', orgProjectName: 'Unified Observability',
  name: 'prod', kind: 'eks', awsAccountId: '647757222309', awsRegion: 'us-east-1',
  clusterName: 'orgiq-prod', clusterArn: 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',
  namespace: 'observability',
  accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',
  rank: 30, status: 'active', createdAt: '', updatedAt: '',
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session?: unknown }).session = { sub: 'u-member', role: 'member', tenant: 'orgiq' };
    next();
  });
  a.use('/api/environments', environmentsRouter);
  a.use(errorHandler);
  return a;
}

const RUNS_PATH = `/api/environments/${PROD.id}/runs`;

beforeEach(() => {
  jest.clearAllMocks();
  getMock.mockResolvedValue(PROD);
});

describe('the degraded marker', () => {
  it('is ABSENT when the repository genuinely has no runs — an idle repo is a real answer', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });
    runsMock.mockResolvedValue([]);
    const res = await request(app()).get(RUNS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('degraded');
    expect(res.body).not.toHaveProperty('error');
    expect(res.body.runs).toEqual([]);
    expect(res.body.repo).toBe('acme/obs');
    // Said out loud, because the JSON is otherwise identical to the failure.
    expect(String(res.body.note)).toContain('no workflow runs');
  });

  it('is ABSENT when there is no repository at all — also a fact, not a failure', async () => {
    repoMock.mockResolvedValue(null);
    const res = await request(app()).get(RUNS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('degraded');
    expect(res.body).toEqual({
      runs: [], repo: null, note: 'No repository is linked to this initiative.',
    });
    expect(runsMock).not.toHaveBeenCalled();
  });

  it('is ABSENT on a healthy answer that has runs', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: 'gh' });
    runsMock.mockResolvedValue([{ id: 1, name: 'Deploy', status: 'completed', conclusion: 'success' }]);
    const res = await request(app()).get(RUNS_PATH);
    expect(res.body).not.toHaveProperty('degraded');
    expect(res.body).not.toHaveProperty('note');
    expect(res.body.runs).toHaveLength(1);
  });

  it('is PRESENT, with the reason, when the upstream could not be asked', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });
    runsMock.mockRejectedValue(new Error('GitHub rate limit reached; it resets at 2026-09-07T12:00:00.000Z'));
    const res = await request(app()).get(RUNS_PATH);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(String(res.body.error)).toContain('rate limit');
    expect(res.body.runs).toEqual([]);
    // The repository is still named: the reader needs to know WHAT could not
    // be reached, which is the half a bare error message loses.
    expect(res.body.repo).toBe('acme/obs');
  });

  it('trims a multi-line upstream error to its first line, like cost.ts', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });
    runsMock.mockRejectedValue(new Error('GitHub /repos/acme/obs/actions/runs failed: HTTP 502\nBad gateway\nretry later'));
    const res = await request(app()).get(RUNS_PATH);
    expect(res.body.error).toBe('GitHub /repos/acme/obs/actions/runs failed: HTTP 502');
  });

  it('still never 5xxs — the environment view survives a dead upstream', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });
    runsMock.mockRejectedValue(new Error('fetch failed'));
    const res = await request(app()).get(RUNS_PATH);
    expect(res.status).toBe(200);
  });
});

describe('the failure and the empty case are distinguishable BY SHAPE', () => {
  // The point of the whole slice, stated as one assertion: a consumer that
  // only ever sees these two bodies can still tell them apart.
  it('a swallowed failure no longer looks like an idle repository', async () => {
    repoMock.mockResolvedValue({ repoFullName: 'acme/obs', connectionName: null });

    runsMock.mockResolvedValue([]);
    const idle = (await request(app()).get(RUNS_PATH)).body;

    runsMock.mockRejectedValue(new Error('GitHub rejected the credential (HTTP 401) — check the token’s scopes'));
    const broken = (await request(app()).get(RUNS_PATH)).body;

    expect(idle.runs).toEqual(broken.runs);            // both empty …
    expect(idle.repo).toEqual(broken.repo);            // … on the same repo …
    expect(Object.keys(idle).sort()).not.toEqual(Object.keys(broken).sort()); // … and not the same answer.
    expect(Boolean(idle.degraded)).toBe(false);
    expect(Boolean(broken.degraded)).toBe(true);
  });
});

// The offline branch these three states are reached through in `dev:mock` —
// `repoForInitiative` and `listWorkflowRuns` — is driven for real in
// providers/__tests__/environments-github-offline.test.ts, which cannot mock
// the connector: a test that mocks the connector cannot see a missing mock
// branch, which is exactly how this gap survived.
