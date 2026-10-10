// Roster route (routes/roster.ts) — the eligible-people pick-list behind the
// sprint steward + grant grantee selectors (audit RM-5). What is pinned: the
// real path queries people (not one initiative's contributors), maps the
// is_sme aggregate to a boolean, drops rows with no id, that mock mode
// falls back to the in-memory cast so dev:mock keeps parity, and that a
// scale audit's fix — `limit` reaches the SQL as a real LIMIT, silently
// clamped rather than left unbounded — didn't change the no-params default.

const mockFlag = { value: false };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
  },
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { rosterRouter } from '../roster.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { mockPeople } from '../../mock/people.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/roster', rosterRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockFlag.value = false;
  execMock.mockReset();
});

describe('GET /api/roster (real path)', () => {
  it('returns the whole people table with an isSme flag, not one initiative\'s contributors', async () => {
    execMock.mockResolvedValue([
      { id: 'p-004', name: 'Nora Vance', title: 'Staff Engineer', is_sme: true },
      { id: 'p-020', name: 'Diana Martinez', title: 'Head of Design', is_sme: false },
    ]);
    const res = await request(buildApp()).get('/api/roster');
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([
      { id: 'p-004', name: 'Nora Vance', title: 'Staff Engineer', isSme: true },
      { id: 'p-020', name: 'Diana Martinez', title: 'Head of Design', isSme: false },
    ]);
    // The SQL reads `people`, so anyone in the org is eligible — the RM-5 fix.
    expect(String(execMock.mock.calls[0]![0])).toMatch(/FROM people/);
  });

  it('defaults the SQL limit to a generous bound and threads a caller-supplied one through, clamped', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/roster');
    await request(app).get('/api/roster?limit=5');
    await request(app).get('/api/roster?limit=999999');
    await request(app).get('/api/roster?limit=abc');
    const lims = execMock.mock.calls.map((c) =>
      (c[1] as Array<{ name: string; value: Record<string, unknown> }>)
        .find((p) => p.name === 'lim')!.value['longValue']);
    expect(lims).toEqual([500, 5, 2000, 500]);
  });

  it('coerces a null title and drops a row with no id', async () => {
    execMock.mockResolvedValue([
      { id: 'p-001', name: 'Alex Chen', title: null, is_sme: false },
      { id: null, name: 'ghost', title: 'x', is_sme: false },
    ]);
    const res = await request(buildApp()).get('/api/roster');
    expect(res.body.people).toEqual([
      { id: 'p-001', name: 'Alex Chen', title: null, isSme: false },
    ]);
  });
});

describe('GET /api/roster (mock path)', () => {
  it('serves the in-memory cast without touching the Data API', async () => {
    mockFlag.value = true;
    const res = await request(buildApp()).get('/api/roster');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.people).toHaveLength(mockPeople.length);
    const ids = res.body.people.map((p: { id: string }) => p.id);
    expect(ids).toContain('p-001');
    // Every entry carries the contract shape (isSme present, false in mock).
    expect(res.body.people.every((p: { isSme: boolean }) => p.isSme === false)).toBe(true);
  });

  it('clamps `limit` in mock mode too', async () => {
    mockFlag.value = true;
    const res = await request(buildApp()).get('/api/roster?limit=2');
    expect(res.body.people).toHaveLength(2);
  });
});

describe('GET /api/roster/users (person → user, for the initiative call)', () => {
  function appAs(tenant: string | null, grants?: Record<string, string[]>) {
    const app = express();
    app.use((req, _res, next) => {
      if (tenant) (req as unknown as { session: unknown }).session = { sub: 'u-vera', tenant, role: 'org-leader', ...(grants ? { grants } : {}) };
      next();
    });
    app.use('/api/roster', rosterRouter);
    app.use(errorHandler);
    return app;
  }

  it('maps linked persons to their user ids and lists the rest as unlinked', async () => {
    // Aurora is unconfigured in this test's config, so identity serves its seed mirror.
    const res = await request(appAs('orgiq')).get('/api/roster/users?personIds=p-002,p-004,p-051');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([
      { personId: 'p-002', userId: 'u-vera', displayName: 'Vera Green' },
      { personId: 'p-004', userId: 'u-nora', displayName: 'Nora DaSilva' },
    ]);
    expect(res.body.unlinked).toEqual(['p-051']);
  });

  it('treats a user without a grant in the current tenant as unlinked', async () => {
    const res = await request(appAs('assessment')).get('/api/roster/users?personIds=p-004');
    expect(res.body).toEqual({ users: [], unlinked: ['p-004'] });
  });

  it('says who holds a social grant only to a caller who holds one (Search → Message, lane E)', async () => {
    const res = await request(appAs('orgiq', { orgiq: ['org-leader'], social: ['participant'] })).get('/api/roster/users?personIds=p-004,p-011');
    // The 2026-10-07 seed gives every person-linked user a Social grant (u-eli included, so
    // Search → Message reaches the whole program cast); the `false` branch is no longer
    // reachable from the seed, and the negative claim below is "no field without a grant".
    expect(res.body.users).toEqual([
      { personId: 'p-004', userId: 'u-nora', displayName: 'Nora DaSilva', social: true },
      { personId: 'p-011', userId: 'u-eli', displayName: 'Eli Garcia', social: true },
    ]);
    const without = await request(appAs('orgiq', { orgiq: ['org-leader'] })).get('/api/roster/users?personIds=p-004');
    expect(without.body.users[0]).not.toHaveProperty('social');
  });

  it('answers an empty list for no person ids, without reading users', async () => {
    const res = await request(appAs('orgiq')).get('/api/roster/users');
    expect(res.body).toEqual({ users: [], unlinked: [] });
  });
});
