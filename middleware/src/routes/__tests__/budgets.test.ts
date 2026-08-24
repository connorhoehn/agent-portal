// Budgets route tests (routes/budgets.ts) with the provider and the Cedar
// gates mocked. What is pinned here: the response shapes, the allocatedUsd
// validation boundary, the 404 for a phantom initiative, the 503 when Aurora
// is absent — and that every route sits behind the ManageBudgets action.

const mockGateActions: { read: string[]; manage: string[] } = { read: [], manage: [] };

jest.mock('../../lib/authz.js', () => ({
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
}));

import express from 'express';
import request from 'supertest';
import { budgetsRouter } from '../budgets.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listBudgets, orgSummary, upsertAllocation, deleteAllocation, initiativeExists,
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
    expect(res.body.budgets).toEqual([BUDGET]);
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
    expect(upsertMock).toHaveBeenCalledWith('p-observability', 250, null);
  });

  it('accepts zero — a real value meaning "no agent spend allowed"', async () => {
    existsMock.mockResolvedValue(true);
    upsertMock.mockResolvedValue({ ...BUDGET, allocatedUsd: 0 });
    const res = await request(buildApp()).put('/api/budgets/p-observability').send({ allocatedUsd: 0 });
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith('p-observability', 0, null);
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
