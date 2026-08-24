// Sprints route (routes/sprints.ts) with the provider, identity and Cedar
// mocked. What is pinned: the two scopes and who gets which by default, that
// an SME asking for the org-wide board is refused rather than quietly narrowed,
// that the caller's app_users → people link is what "mine" resolves through,
// and the query-string validation.

const cedarAllow = { value: false };

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => cedarAllow.value),
}));

jest.mock('../../providers/sprints.js', () => ({
  listSprints: jest.fn(),
  SPRINT_STATUSES: ['planned', 'active', 'done'],
}));

jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { sprintsRouter } from '../sprints.js';
import { errorHandler } from '../../lib/async-handler.js';
import { listSprints } from '../../providers/sprints.js';
import { getUser } from '../../providers/identity.js';

const listMock = listSprints as unknown as jest.Mock;
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
  listMock.mockReset();
  listMock.mockResolvedValue([SPRINT]);
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
