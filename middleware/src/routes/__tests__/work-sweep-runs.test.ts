// GET /api/work/sweeps/runs — tenant from the session, the bots read gate, filters.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
const mockAllowed = { value: true };
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
  requireAction: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (mockAllowed.value ? next() : res.status(403).json({ error: 'forbidden' })),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  readForRolesElseAction: (roles: string[], _action: string) => (
    req: { method: string; session?: { role: string } },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (req.session && (req.session.role === 'admin' || roles.includes(req.session.role))) return next();
    return mockAllowed.value ? next() : res.status(403).json({ error: 'forbidden' });
  },
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { sweepRuns } from '../../mock/sweep-runs.js';

function app(session: Record<string, unknown> | null) {
  const a = express();
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  a.use('/api/work', workRouter);
  a.use(errorHandler);
  return a;
}

const leader = { sub: 'u-l', role: 'org-leader', tenant: 'orgiq' };
const sme = { sub: 'u-s', role: 'sme', tenant: 'orgiq' };

beforeEach(() => {
  mockAllowed.value = true;
  sweepRuns.reset(); sweepRuns.rows().splice(0); // start empty: the seeded morning runs would sit between these
  const base = { botId: null, finishedAt: null, findings: null, durationMs: 1 };
  sweepRuns.rows().push(
    { ...base, id: 'a', tenant: 'orgiq', sweep: 'bus_factor', startedAt: '2026-03-10T00:00:00.000Z', status: 'failed', error: 'x' },
    { ...base, id: 'b', tenant: 'orgiq', sweep: 'stale_docs', startedAt: '2026-03-11T00:00:00.000Z', status: 'ok', error: null, findings: 3 },
    { ...base, id: 'c', tenant: 'social', sweep: 'bus_factor', startedAt: '2026-03-11T01:00:00.000Z', status: 'failed', error: 'y' },
  );
});
afterEach(() => sweepRuns.reset());

describe('GET /api/work/sweeps/runs', () => {
  it('returns the session tenant newest first, never another tenant', async () => {
    const res = await request(app(leader)).get('/api/work/sweeps/runs');
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(['b', 'a']);
    expect(res.body.runs[0]).toMatchObject({ sweep: 'stale_docs', status: 'ok', findings: 3, error: null });
  });
  it('filters by status and since', async () => {
    const failed = await request(app(leader)).get('/api/work/sweeps/runs?status=failed');
    expect(failed.body.runs.map((r: { id: string }) => r.id)).toEqual(['a']);
    const since = await request(app(leader)).get('/api/work/sweeps/runs?since=2026-03-10T12:00:00Z');
    expect(since.body.runs.map((r: { id: string }) => r.id)).toEqual(['b']);
  });
  it('rejects a bad since or status', async () => {
    expect((await request(app(leader)).get('/api/work/sweeps/runs?since=nope')).status).toBe(400);
    expect((await request(app(leader)).get('/api/work/sweeps/runs?status=weird')).status).toBe(400);
  });
  it('refuses a role without the read permission', async () => {
    mockAllowed.value = false;
    expect((await request(app(sme)).get('/api/work/sweeps/runs')).status).toBe(403);
  });
});
