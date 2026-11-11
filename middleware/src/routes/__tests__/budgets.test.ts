// Budgets route tests (routes/budgets.ts) with the provider and the Cedar
// gates mocked. What is pinned here: the response shapes, the allocatedUsd
// validation boundary, the 404 for a phantom initiative, the 503 when Aurora
// is absent — and that every route sits behind the ManageBudgets action.

const mockGateActions: { read: string[]; manage: string[] } = { read: [], manage: [] };

jest.mock('../../lib/authz.js', () => ({
  // lib/budget-scope.ts (program-owner scope, budgets-program-owner-scope.test.ts):
  // no session here, so it never narrows these writes.
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: async () => true,
  readForRolesElseAction: (_roles: string[], action: string) => {
    mockGateActions.read.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAction: (action: string) => {
    mockGateActions.manage.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

jest.mock('../../providers/budgets.js', () => ({
  listBudgets: jest.fn(),
  orgSummary: jest.fn(),
  upsertAllocation: jest.fn(),
  deleteAllocation: jest.fn(),
  initiativeExists: jest.fn(),
  listGrants: jest.fn(),
  // The DE-36 cap check reads the stored row; none here.
  getBudget: jest.fn(async () => null),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { budgetsRouter } from '../budgets.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listBudgets, orgSummary, upsertAllocation, deleteAllocation, initiativeExists, listGrants,
} from '../../providers/budgets.js';

const listMock = listBudgets as unknown as jest.Mock;
const summaryMock = orgSummary as unknown as jest.Mock;
const upsertMock = upsertAllocation as unknown as jest.Mock;
const deleteMock = deleteAllocation as unknown as jest.Mock;
const existsMock = initiativeExists as unknown as jest.Mock;

const BUDGET = {
  orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
  allocatedUsd: 250, period: 'monthly', updatedBy: 'pm@example.com',
  updatedAt: '2026-08-01T00:00:00Z', spentThisPeriodUsd: 42.5,
  runCountThisPeriod: 7, lastAgentActivityAt: '2026-08-20T12:00:00Z',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/budgets', budgetsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); summaryMock.mockReset(); upsertMock.mockReset();
  deleteMock.mockReset(); existsMock.mockReset();
});

describe('gating', () => {
  it('puts every route behind ManageBudgets', () => {
    // Gates are constructed at module load; both tiers name the same action.
    expect(mockGateActions.read).toEqual(['ManageBudgets']);
    expect(mockGateActions.manage).toEqual(['ManageBudgets']);
  });
});

describe('GET /api/budgets', () => {
  it('returns the ledger beside the org summary', async () => {
    listMock.mockResolvedValue([BUDGET]);
    summaryMock.mockResolvedValue({
      totalAllocatedUsd: 250, totalSpentThisPeriodUsd: 42.5, byModel: [], byTrigger: [],
    });
    const res = await request(buildApp()).get('/api/budgets');
    expect(res.status).toBe(200);
    // Each row carries its threshold mark (learning loop, lane B): $42.50 of $250 is 17 %, under 50.
    expect(res.body.budgets).toEqual([{ ...BUDGET, threshold: { percent: 17, reached: 0 } }]);
    expect(res.body.thresholds).toEqual([50, 80, 100]);
    expect(res.body.summary.totalAllocatedUsd).toBe(250);
  });
});

describe('PUT /api/budgets/:orgProjectId', () => {
  it('upserts and returns the budget', async () => {
    existsMock.mockResolvedValue(true);
    upsertMock.mockResolvedValue(BUDGET);
    const res = await request(buildApp())
      .put('/api/budgets/p-observability')
      .send({ allocatedUsd: 250 });
    expect(res.status).toBe(200);
    expect(res.body.budget).toEqual(BUDGET);
    expect(upsertMock).toHaveBeenCalledWith('p-observability', 250, null, {});
  });

  it('accepts zero — a real value meaning "no agent spend allowed"', async () => {
    existsMock.mockResolvedValue(true);
    upsertMock.mockResolvedValue({ ...BUDGET, allocatedUsd: 0 });
    const res = await request(buildApp()).put('/api/budgets/p-observability').send({ allocatedUsd: 0 });
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith('p-observability', 0, null, {});
  });

  it.each([
    ['missing', {}],
    ['negative', { allocatedUsd: -1 }],
    ['non-finite', { allocatedUsd: Infinity }],
    ['NaN', { allocatedUsd: NaN }],
    ['a coercible string', { allocatedUsd: '250' }],
    ['null', { allocatedUsd: null }],
  ])('rejects %s allocatedUsd with 400 before touching the provider', async (_label, body) => {
    const res = await request(buildApp()).put('/api/budgets/p-observability').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allocatedUsd/);
    expect(existsMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('404s when the initiative does not exist', async () => {
    existsMock.mockResolvedValue(false);
    const res = await request(buildApp()).put('/api/budgets/proj-ghost').send({ allocatedUsd: 10 });
    expect(res.status).toBe(404);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('503s when the provider has no Aurora behind it', async () => {
    existsMock.mockResolvedValue(true);
    upsertMock.mockResolvedValue(null);
    const res = await request(buildApp()).put('/api/budgets/p-observability').send({ allocatedUsd: 10 });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Aurora/);
  });
});

describe('DELETE /api/budgets/:orgProjectId', () => {
  it('deletes an allocation', async () => {
    deleteMock.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/budgets/p-observability');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith('p-observability');
  });

  it('404s when no allocation existed', async () => {
    deleteMock.mockResolvedValue(false);
    const res = await request(buildApp()).delete('/api/budgets/proj-none');
    expect(res.status).toBe(404);
  });
});

// Sprint envelopes — GET /api/budgets/grants. Declared BEFORE '/:orgProjectId'
// in the router, and that ordering is the thing worth pinning: if it slipped
// below, "grants" would be read as an initiative id and the envelope list
// would 404 (or worse, answer about an initiative called "grants").
describe('GET /api/budgets/grants', () => {
  const grantsMock = listGrants as unknown as jest.Mock;

  beforeEach(() => { grantsMock.mockReset(); });

  it('resolves as a literal, not as /:orgProjectId', async () => {
    grantsMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/budgets/grants');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['grants']);
    // The param route would have asked the budgets provider about an
    // initiative literally called "grants".
    expect(listMock).not.toHaveBeenCalled();
  });

  it('carries who holds how much, on which sprint', async () => {
    grantsMock.mockResolvedValue([{
      id: 'bg-auth-3', orgProjectId: 'p-auth-migration', granteePersonId: 'p-004',
      granteeName: 'Nora Vance', sprintId: 'sp-12', amountUsd: 120, spentUsd: 42.5,
      grantedBy: 'u-release', status: 'active',
    }]);
    const res = await request(buildApp()).get('/api/budgets/grants?orgProjectId=p-auth-migration');
    expect(res.status).toBe(200);
    const g = res.body.grants[0];
    // An envelope means nothing without all three: whose, how much, which sprint.
    expect(g.granteePersonId).toBe('p-004');
    expect(g.sprintId).toBe('sp-12');
    expect(g.amountUsd).toBe(120);
    // Spend is reported beside the envelope, not derived by the caller.
    expect(g.spentUsd).toBeLessThanOrEqual(g.amountUsd);
  });

  it('scopes to one initiative when asked, and to all when not', async () => {
    grantsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/budgets/grants');
    await request(app).get('/api/budgets/grants?orgProjectId=');
    await request(app).get('/api/budgets/grants?orgProjectId=%20%20');
    await request(app).get('/api/budgets/grants?orgProjectId=p-auth-migration');
    // A blank filter widens to every initiative rather than matching an
    // initiative whose id is the empty string.
    expect(grantsMock.mock.calls.map((c) => c[0]))
      .toEqual([undefined, undefined, undefined, 'p-auth-migration']);
  });

  it('serves an initiative with no envelopes as an empty list', async () => {
    grantsMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/budgets/grants?orgProjectId=p-observability');
    expect(res.body).toEqual({ grants: [] });
  });

  // A scale audit flagged this as an unbounded read. `limit` clamps the
  // RESPONSE, never the provider call itself — lib/bot-runner.ts's envelope
  // brake calls listGrants() unscoped and must see every grant, so the fix
  // cannot live inside the provider.
  it('clamps `limit` on the response without touching what listGrants() was called with', async () => {
    grantsMock.mockResolvedValue([
      { id: 'bg-1', orgProjectId: 'p-a', granteePersonId: 'p-001', granteeName: 'A', sprintId: 's-1', amountUsd: 10, spentUsd: 0, grantedBy: 'u-1', status: 'active' },
      { id: 'bg-2', orgProjectId: 'p-b', granteePersonId: 'p-002', granteeName: 'B', sprintId: 's-2', amountUsd: 10, spentUsd: 0, grantedBy: 'u-1', status: 'active' },
      { id: 'bg-3', orgProjectId: 'p-c', granteePersonId: 'p-003', granteeName: 'C', sprintId: 's-3', amountUsd: 10, spentUsd: 0, grantedBy: 'u-1', status: 'active' },
    ]);
    const capped = await request(buildApp()).get('/api/budgets/grants?limit=1');
    expect(capped.body.grants).toHaveLength(1);
    expect(grantsMock).toHaveBeenCalledWith(undefined);
  });
});
