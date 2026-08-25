// Sprints route (routes/sprints.ts) with the provider, identity and Cedar
// mocked. What is pinned: the two scopes and who gets which by default, that
// an SME asking for the org-wide board is refused rather than quietly narrowed,
// that the caller's app_users → people link is what "mine" resolves through,
// and the query-string validation.

const cedarAllow = { value: false };
// The ManageSprints Cedar gate on the write routes. Flip to false to prove a
// write is refused before the provider is touched.
const manageAllow = { value: true };

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => cedarAllow.value),
  requireAction: (action: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (action === 'ManageSprints' && !manageAllow.value) {
        res.status(403).json({ error: 'Forbidden', action });
        return;
      }
      next();
    },
}));

jest.mock('../../providers/sprints.js', () => ({
  listSprints: jest.fn(),
  createSprint: jest.fn(),
  getSprint: jest.fn(),
  personExists: jest.fn(),
  SPRINT_STATUSES: ['planned', 'active', 'done'],
}));

jest.mock('../../providers/budgets.js', () => ({ initiativeExists: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(), updateWorkItem: jest.fn() }));

jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { sprintsRouter } from '../sprints.js';
import { errorHandler } from '../../lib/async-handler.js';
import { listSprints, createSprint, getSprint, personExists } from '../../providers/sprints.js';
import { initiativeExists } from '../../providers/budgets.js';
import { getWorkItem, updateWorkItem } from '../../providers/work-items.js';
import { getUser } from '../../providers/identity.js';

const listMock = listSprints as unknown as jest.Mock;
const createSprintMock = createSprint as unknown as jest.Mock;
const getSprintMock = getSprint as unknown as jest.Mock;
const personExistsMock = personExists as unknown as jest.Mock;
const initiativeExistsMock = initiativeExists as unknown as jest.Mock;
const getWorkItemMock = getWorkItem as unknown as jest.Mock;
const updateWorkItemMock = updateWorkItem as unknown as jest.Mock;
const getUserMock = getUser as unknown as jest.Mock;

const SPRINT = {
  id: 'spr-obs-s3', orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
  name: 'Sprint 98 — Span metrics + decom', goal: 'RED dashboards from span metrics.',
  stewardPersonId: 'p-008', stewardName: 'Layla Hassan',
  startsOn: '2026-08-10', endsOn: '2026-08-24', status: 'active',
  itemCount: 5, doneItemCount: 1, pointsTotal: 21, pointsDone: 3, estimatedCostUsd: 31.07,
  grantedUsd: 30, grantCount: 1, initiativeSpendInWindowUsd: 2.74,
  isSteward: false, isGrantee: false, myItemCount: 1, myOpenItemCount: 1,
};

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/sprints', sprintsRouter);
  app.use(errorHandler);
  return app;
}

const sme = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const leader = { sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' };

beforeEach(() => {
  cedarAllow.value = false;
  manageAllow.value = true;
  listMock.mockReset();
  listMock.mockResolvedValue([SPRINT]);
  createSprintMock.mockReset();
  createSprintMock.mockResolvedValue(SPRINT);
  getSprintMock.mockReset();
  getSprintMock.mockResolvedValue(SPRINT);
  personExistsMock.mockReset();
  personExistsMock.mockResolvedValue(true);
  initiativeExistsMock.mockReset();
  initiativeExistsMock.mockResolvedValue(true);
  getWorkItemMock.mockReset();
  updateWorkItemMock.mockReset();
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ id: 'u-nora', personId: 'p-004' });
});

describe('scope', () => {
  it('defaults an SME to their own sprints', async () => {
    const res = await request(buildApp(sme)).get('/api/sprints');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('mine');
    expect(res.body.canSeeAll).toBe(false);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ mineOnly: true, personId: 'p-004' }));
  });

  it('defaults an org-leader to the whole org board', async () => {
    const res = await request(buildApp(leader)).get('/api/sprints');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    expect(res.body.canSeeAll).toBe(true);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ mineOnly: false }));
  });

  it('refuses an SME the org-wide board rather than quietly narrowing it', async () => {
    // Every row carries the sprint's envelope and the initiative's spend — the
    // same money /api/budgets gates. Silently answering `scope=mine` here would
    // make the portal believe it had rendered the org.
    const res = await request(buildApp(sme)).get('/api/sprints?scope=all');
    expect(res.status).toBe(403);
    expect(res.body.action).toBe('ManageBudgets');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('lets a role holding ManageBudgets through even when it is not a read role', async () => {
    cedarAllow.value = true;
    const res = await request(buildApp({ sub: 'u-x', role: 'member', tenant: 'orgiq' }))
      .get('/api/sprints?scope=all');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
  });

  it('lets a leader narrow to their own sprints on request', async () => {
    const res = await request(buildApp(leader)).get('/api/sprints?scope=mine');
    expect(res.body.scope).toBe('mine');
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ mineOnly: true }));
  });

  it('rejects a scope it does not implement', async () => {
    const res = await request(buildApp(sme)).get('/api/sprints?scope=everything');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope/);
  });
});

describe('identity link', () => {
  it('resolves "mine" through app_users.person_id, not the session sub', async () => {
    await request(buildApp(sme)).get('/api/sprints');
    expect(getUserMock).toHaveBeenCalledWith('u-nora');
    expect(listMock.mock.calls[0]![0].personId).toBe('p-004');
  });

  it('answers personId: null for an account with no person record', async () => {
    // The platform operator and the HR admin have no people row. Null is an
    // explicit "your account is not linked", distinguishable from "you have no
    // sprints" — which is what an empty list alone would have said.
    getUserMock.mockResolvedValue({ id: 'u-hr', personId: null });
    listMock.mockResolvedValue([]);
    const res = await request(buildApp({ sub: 'u-hr', role: 'hr-admin', tenant: 'orgiq' }))
      .get('/api/sprints?scope=mine');
    expect(res.status).toBe(200);
    expect(res.body.personId).toBeNull();
    expect(res.body.sprints).toEqual([]);
  });

  it('survives an unknown user without 500ing', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await request(buildApp(sme)).get('/api/sprints');
    expect(res.status).toBe(200);
    expect(res.body.personId).toBeNull();
  });
});

describe('query string', () => {
  it('passes status and initiative filters through', async () => {
    await request(buildApp(leader)).get('/api/sprints?status=active&initiative=p-observability&limit=25');
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active', orgProjectId: 'p-observability', limit: 25,
    }));
  });

  it('refuses a status outside the schema CHECK', async () => {
    const res = await request(buildApp(leader)).get('/api/sprints?status=in_progress');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/planned, active, done/);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('omits filters entirely when they are blank rather than matching ""', async () => {
    await request(buildApp(leader)).get('/api/sprints?status=&initiative=');
    const opts = listMock.mock.calls[0]![0];
    expect(opts).not.toHaveProperty('status');
    expect(opts).not.toHaveProperty('orgProjectId');
  });
});

describe('response', () => {
  it('returns the rows with the scope that produced them', async () => {
    const res = await request(buildApp(leader)).get('/api/sprints');
    expect(res.body).toEqual({
      scope: 'all', personId: 'p-004', canSeeAll: true, sprints: [SPRINT],
    });
  });

  it('carries initiative spend, never a personal burn figure', async () => {
    // bot_runs record which initiative paid, never whose envelope authorized
    // it — the field name is the contract, and the portal labels it from here.
    const res = await request(buildApp(sme)).get('/api/sprints');
    const row = res.body.sprints[0];
    expect(row).toHaveProperty('initiativeSpendInWindowUsd');
    expect(Object.keys(row)).not.toContain('spentByMeUsd');
    expect(Object.keys(row)).not.toContain('burnUsd');
  });

  it('401s an anonymous request even though the mount already guards it', async () => {
    const res = await request(buildApp(null)).get('/api/sprints');
    expect(res.status).toBe(401);
  });
});

// ─── Write: create a sprint ───────────────────────────────────────────────────

const validCreate = {
  initiativeId: 'p-observability', name: 'Sprint 99 — Rollout',
  startsOn: '2026-09-01', endsOn: '2026-09-14', stewardPersonId: 'p-008',
};

describe('POST /api/sprints', () => {
  it('creates a sprint and returns 201 with the board row', async () => {
    const res = await request(buildApp(leader)).post('/api/sprints').send(validCreate);
    expect(res.status).toBe(201);
    expect(res.body.sprint).toEqual(SPRINT);
    expect(createSprintMock).toHaveBeenCalledWith(expect.objectContaining({
      orgProjectId: 'p-observability', name: 'Sprint 99 — Rollout',
      startsOn: '2026-09-01', endsOn: '2026-09-14', stewardPersonId: 'p-008',
    }));
  });

  it('allows an optional steward and goal to be omitted', async () => {
    const res = await request(buildApp(leader)).post('/api/sprints')
      .send({ initiativeId: 'p-observability', name: 'S', startsOn: '2026-09-01', endsOn: '2026-09-14' });
    expect(res.status).toBe(201);
    expect(createSprintMock.mock.calls[0]![0].stewardPersonId).toBeNull();
    expect(personExistsMock).not.toHaveBeenCalled();
  });

  it('is gated on ManageSprints — refuses before the provider is touched', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(sme)).post('/api/sprints').send(validCreate);
    expect(res.status).toBe(403);
    expect(res.body.action).toBe('ManageSprints');
    expect(createSprintMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing initiativeId', { ...validCreate, initiativeId: '' }, /initiativeId/],
    ['missing name', { ...validCreate, name: '   ' }, /name/],
    ['non-ISO startsOn', { ...validCreate, startsOn: '09/01/2026' }, /YYYY-MM-DD/],
    ['non-ISO endsOn', { ...validCreate, endsOn: 'soon' }, /YYYY-MM-DD/],
    ['end before start', { ...validCreate, startsOn: '2026-09-14', endsOn: '2026-09-01' }, /after startsOn/],
    ['equal dates', { ...validCreate, startsOn: '2026-09-01', endsOn: '2026-09-01' }, /after startsOn/],
    ['bad status', { ...validCreate, status: 'archived' }, /planned, active, done/],
  ])('rejects %s with 400 before the write', async (_label, body, re) => {
    const res = await request(buildApp(leader)).post('/api/sprints').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(re as RegExp);
    expect(createSprintMock).not.toHaveBeenCalled();
  });

  it('404s when the initiative does not exist', async () => {
    initiativeExistsMock.mockResolvedValue(false);
    const res = await request(buildApp(leader)).post('/api/sprints').send(validCreate);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/initiative/);
    expect(createSprintMock).not.toHaveBeenCalled();
  });

  it('404s when the named steward is not a real person', async () => {
    personExistsMock.mockResolvedValue(false);
    const res = await request(buildApp(leader)).post('/api/sprints').send(validCreate);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/steward/);
    expect(createSprintMock).not.toHaveBeenCalled();
  });
});

// ─── Write: move work items in/out of a sprint ─────────────────────────────────

const SPRINT_OBS = { ...SPRINT, id: 'spr-obs-s3', orgProjectId: 'p-observability' };
const ITEM = { id: 'wi-k8s-s5', projectId: 'p-observability', sprintId: null as string | null };

describe('PATCH /api/sprints/:sprintId/items', () => {
  beforeEach(() => {
    getSprintMock.mockResolvedValue(SPRINT_OBS);
    getWorkItemMock.mockResolvedValue({ ...ITEM });
    updateWorkItemMock.mockResolvedValue({ ...ITEM, sprintId: 'spr-obs-s3' });
  });

  it('adds an item on the same initiative and returns the updated item', async () => {
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-obs-s3/items').send({ workItemId: 'wi-k8s-s5' });
    expect(res.status).toBe(200);
    expect(res.body.workItem.sprintId).toBe('spr-obs-s3');
    expect(updateWorkItemMock).toHaveBeenCalledWith('wi-k8s-s5', { sprintId: 'spr-obs-s3' });
  });

  it('refuses an item from a different initiative with 400', async () => {
    getWorkItemMock.mockResolvedValue({ id: 'wi-auth-1', projectId: 'p-auth-migration', sprintId: null });
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-obs-s3/items').send({ workItemId: 'wi-auth-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/its own initiative/);
    expect(updateWorkItemMock).not.toHaveBeenCalled();
  });

  it('400s a missing workItemId', async () => {
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-obs-s3/items').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workItemId/);
  });

  it('404s an unknown sprint', async () => {
    getSprintMock.mockResolvedValue(null);
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-ghost/items').send({ workItemId: 'wi-k8s-s5' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sprint/);
  });

  it('404s an unknown work item', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-obs-s3/items').send({ workItemId: 'wi-ghost' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/work item/);
  });

  it('is gated on ManageSprints', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(sme)).patch('/api/sprints/spr-obs-s3/items').send({ workItemId: 'wi-k8s-s5' });
    expect(res.status).toBe(403);
    expect(updateWorkItemMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/sprints/:sprintId/items/:itemId', () => {
  beforeEach(() => {
    getSprintMock.mockResolvedValue(SPRINT_OBS);
    getWorkItemMock.mockResolvedValue({ ...ITEM, sprintId: 'spr-obs-s3' });
    updateWorkItemMock.mockResolvedValue({ ...ITEM, sprintId: null });
  });

  it('removes an item that is in the sprint and nulls its sprint_id', async () => {
    const res = await request(buildApp(sme)).delete('/api/sprints/spr-obs-s3/items/wi-k8s-s5');
    expect(res.status).toBe(200);
    expect(res.body.workItem.sprintId).toBeNull();
    expect(updateWorkItemMock).toHaveBeenCalledWith('wi-k8s-s5', { sprintId: null });
  });

  it('404s an item that is not in this sprint', async () => {
    getWorkItemMock.mockResolvedValue({ ...ITEM, sprintId: 'spr-other' });
    const res = await request(buildApp(sme)).delete('/api/sprints/spr-obs-s3/items/wi-k8s-s5');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not in this sprint/);
    expect(updateWorkItemMock).not.toHaveBeenCalled();
  });

  it('is gated on ManageSprints', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(sme)).delete('/api/sprints/spr-obs-s3/items/wi-k8s-s5');
    expect(res.status).toBe(403);
    expect(updateWorkItemMock).not.toHaveBeenCalled();
  });
});
