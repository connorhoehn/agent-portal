// Grants route (routes/grants.ts) with the providers and Cedar gates mocked.
// Pinned here: every write sits behind ManageBudgets, the amount and referenced
// ids are validated before the write, a sprint on the wrong initiative is
// refused, and grantedBy comes from the session sub rather than the body.

const manageAllow = { value: true };
const gateActions: { read: string[]; manage: string[] } = { read: [], manage: [] };

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => (req as { session?: unknown }).session ?? null,
  readForRolesElseAction: (_roles: string[], action: string) => {
    gateActions.read.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAction: (action: string) => {
    gateActions.manage.push(action);
    return (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!manageAllow.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    };
  },
}));

jest.mock('../../providers/budgets.js', () => ({ initiativeExists: jest.fn() }));
jest.mock('../../providers/sprints.js', () => ({ getSprint: jest.fn(), personExists: jest.fn() }));
jest.mock('../../providers/grants.js', () => ({
  createGrant: jest.fn(), updateGrant: jest.fn(), revokeGrant: jest.fn(), listGrantsForSprint: jest.fn(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { grantsRouter } from '../grants.js';
import { errorHandler } from '../../lib/async-handler.js';
import { initiativeExists } from '../../providers/budgets.js';
import { getSprint, personExists } from '../../providers/sprints.js';
import {
  createGrant, updateGrant, revokeGrant, listGrantsForSprint,
} from '../../providers/grants.js';

const initiativeExistsMock = initiativeExists as unknown as jest.Mock;
const getSprintMock = getSprint as unknown as jest.Mock;
const personExistsMock = personExists as unknown as jest.Mock;
const createGrantMock = createGrant as unknown as jest.Mock;
const updateGrantMock = updateGrant as unknown as jest.Mock;
const revokeGrantMock = revokeGrant as unknown as jest.Mock;
const listForSprintMock = listGrantsForSprint as unknown as jest.Mock;

const GRANT = {
  id: 'bg-obs-3', orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
  granteePersonId: 'p-008', granteeName: 'Layla Hassan',
  sprintId: 'spr-obs-s3', sprintName: 'Sprint 98', startsOn: '2026-08-10', endsOn: '2026-08-24',
  sprintStatus: 'active', allocatedUsd: 30, grantedBy: 'u-release', initiativeSpendInWindowUsd: 2.74,
};

const SPRINT = { id: 'spr-obs-s3', orgProjectId: 'p-observability', name: 'Sprint 98', status: 'active',
  orgProjectName: 'Observability Platform', startsOn: '2026-08-10', endsOn: '2026-08-24' };

const release = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/grants', grantsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  manageAllow.value = true;
  initiativeExistsMock.mockReset(); initiativeExistsMock.mockResolvedValue(true);
  getSprintMock.mockReset(); getSprintMock.mockResolvedValue(SPRINT);
  personExistsMock.mockReset(); personExistsMock.mockResolvedValue(true);
  createGrantMock.mockReset(); createGrantMock.mockResolvedValue(GRANT);
  updateGrantMock.mockReset(); updateGrantMock.mockResolvedValue(GRANT);
  revokeGrantMock.mockReset(); revokeGrantMock.mockResolvedValue(true);
  listForSprintMock.mockReset(); listForSprintMock.mockResolvedValue([GRANT]);
});

const validGrant = {
  initiativeId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008', amountUsd: 30,
};

describe('gating', () => {
  it('reads behind the org-leader/hr-admin tier, writes behind ManageBudgets', () => {
    // The gates are shared constants built once at module load (readGate /
    // manageGate); the per-route 403 tests below prove each write enforces it.
    expect(gateActions.read).toContain('ManageBudgets');
    expect(gateActions.manage).toEqual(['ManageBudgets']);
  });
});

describe('GET /api/grants', () => {
  it('lists a sprint\'s envelopes', async () => {
    const res = await request(buildApp(release)).get('/api/grants?sprintId=spr-obs-s3');
    expect(res.status).toBe(200);
    expect(res.body.grants).toEqual([GRANT]);
    expect(listForSprintMock).toHaveBeenCalledWith('spr-obs-s3');
  });

  it('400s without a sprintId', async () => {
    const res = await request(buildApp(release)).get('/api/grants');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sprintId/);
  });
});

describe('POST /api/grants', () => {
  it('creates an envelope and attributes it to the session sub, not the body', async () => {
    const res = await request(buildApp(release)).post('/api/grants')
      .send({ ...validGrant, grantedBy: 'someone-else' });
    expect(res.status).toBe(201);
    expect(res.body.grant).toEqual(GRANT);
    expect(createGrantMock).toHaveBeenCalledWith(expect.objectContaining({
      orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008',
      amountUsd: 30, grantedBy: 'u-release',
    }));
  });

  it('accepts a zero envelope — a real "no spend authorized yet" value', async () => {
    const res = await request(buildApp(release)).post('/api/grants').send({ ...validGrant, amountUsd: 0 });
    expect(res.status).toBe(201);
    expect(createGrantMock.mock.calls[0]![0].amountUsd).toBe(0);
  });

  it('is gated on ManageBudgets', async () => {
    manageAllow.value = false;
    const res = await request(buildApp({ sub: 'u-nora', role: 'sme', tenant: 'orgiq' }))
      .post('/api/grants').send(validGrant);
    expect(res.status).toBe(403);
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing initiativeId', { ...validGrant, initiativeId: '' }, /initiativeId/],
    ['missing sprintId', { ...validGrant, sprintId: '' }, /sprintId/],
    ['missing granteePersonId', { ...validGrant, granteePersonId: '' }, /granteePersonId/],
    ['negative amount', { ...validGrant, amountUsd: -5 }, /amountUsd/],
    ['non-finite amount', { ...validGrant, amountUsd: Infinity }, /amountUsd/],
    ['coercible string amount', { ...validGrant, amountUsd: '30' }, /amountUsd/],
    ['missing amount', { initiativeId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008' }, /amountUsd/],
  ])('rejects %s with 400 before the write', async (_label, body, re) => {
    const res = await request(buildApp(release)).post('/api/grants').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(re as RegExp);
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it('404s an unknown initiative', async () => {
    initiativeExistsMock.mockResolvedValue(false);
    const res = await request(buildApp(release)).post('/api/grants').send(validGrant);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/initiative/);
  });

  it('404s an unknown grantee', async () => {
    personExistsMock.mockResolvedValue(false);
    const res = await request(buildApp(release)).post('/api/grants').send(validGrant);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/grantee/);
  });

  it('404s an unknown sprint', async () => {
    getSprintMock.mockResolvedValue(null);
    const res = await request(buildApp(release)).post('/api/grants').send(validGrant);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sprint/);
  });

  it('400s when the sprint belongs to a different initiative', async () => {
    getSprintMock.mockResolvedValue({ ...SPRINT, orgProjectId: 'p-auth-migration' });
    const res = await request(buildApp(release)).post('/api/grants').send(validGrant);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/belongs to/);
    expect(createGrantMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/grants/:id', () => {
  it('re-allocates the envelope (amount only)', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ amountUsd: 45 });
    expect(res.status).toBe(200);
    expect(res.body.grant).toEqual(GRANT);
    expect(updateGrantMock).toHaveBeenCalledWith('bg-obs-3', { amountUsd: 45 });
  });

  it('corrects only the note, leaving the amount alone', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ note: 'fixed typo' });
    expect(res.status).toBe(200);
    // No amountUsd in the patch — the amount column is untouched.
    expect(updateGrantMock).toHaveBeenCalledWith('bg-obs-3', { note: 'fixed typo' });
  });

  it('patches amount and note together', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3')
      .send({ amountUsd: 45, note: 'raised for scope creep' });
    expect(res.status).toBe(200);
    expect(updateGrantMock).toHaveBeenCalledWith('bg-obs-3', { amountUsd: 45, note: 'raised for scope creep' });
  });

  it('accepts an empty-string note to clear it', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ note: '' });
    expect(res.status).toBe(200);
    expect(updateGrantMock).toHaveBeenCalledWith('bg-obs-3', { note: '' });
  });

  it('400s an empty patch with neither field', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountUsd and\/or note/);
    expect(updateGrantMock).not.toHaveBeenCalled();
  });

  it('rejects a bad amount with 400', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ amountUsd: -1 });
    expect(res.status).toBe(400);
    expect(updateGrantMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string note with 400', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ note: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/note must be a string/);
    expect(updateGrantMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long note with 400', async () => {
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ note: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 500 characters/);
    expect(updateGrantMock).not.toHaveBeenCalled();
  });

  it('404s an unknown grant', async () => {
    updateGrantMock.mockResolvedValue(null);
    const res = await request(buildApp(release)).patch('/api/grants/bg-ghost').send({ amountUsd: 10 });
    expect(res.status).toBe(404);
  });

  it('is gated on ManageBudgets', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(release)).patch('/api/grants/bg-obs-3').send({ amountUsd: 10 });
    expect(res.status).toBe(403);
    expect(updateGrantMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/grants/:id', () => {
  it('revokes a grant', async () => {
    const res = await request(buildApp(release)).delete('/api/grants/bg-obs-3');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(revokeGrantMock).toHaveBeenCalledWith('bg-obs-3');
  });

  it('404s when nothing matched', async () => {
    revokeGrantMock.mockResolvedValue(false);
    const res = await request(buildApp(release)).delete('/api/grants/bg-ghost');
    expect(res.status).toBe(404);
  });

  it('is gated on ManageBudgets', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(release)).delete('/api/grants/bg-obs-3');
    expect(res.status).toBe(403);
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });
});
