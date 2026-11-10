// Who may read which invocation trace.
//
// invocation_traces carries every user's prompt and response snippets in every
// tenant, and the mount's gate (ViewObservability) is held by every orgiq
// member. So the routes scope themselves: a fleet-wide role (org-leader,
// hr-admin, admin) reads the whole table; anyone else reads only their own
// traces in their own tenant, and no query parameter widens that.
//
// Two halves: the live path (the SQL the route sends, with `exec` mocked) and
// the offline corpus (the rows the route actually answers with).

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
const mockFlags = { aurora: false, agentcore: true, guardrails: true, cloudwatch: true };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', accountId: '', auth: { policyStoreId: '', sessionSigningSecretArn: '' }, mock: mockFlags },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => { next(); },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { invocationsRouter } from '../invocations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { mockInvocationSearch } from '../../mock/observability-queries.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const execMock = exec as unknown as jest.Mock;
const UUID = '11111111-2222-3333-4444-555555555555';

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session) (req as unknown as { session: unknown }).session = { grants: {}, iat: 0, ...session };
    next();
  });
  app.use('/api/observability/invocations', invocationsRouter);
  app.use(errorHandler);
  return app;
}

const member = { sub: 'u-member', role: 'member', tenant: 'orgiq' };
const operator = { sub: 'u-lead', role: 'org-leader', tenant: 'orgiq' };

type Param = { name: string; value: { stringValue?: string } };
function paramsOf(call: unknown[]): Record<string, string | undefined> {
  return Object.fromEntries(((call[1] ?? []) as Param[]).map((p) => [p.name, p.value.stringValue]));
}

beforeEach(() => {
  execMock.mockReset();
  mockFlags.aurora = false;
});

describe('live path — the SQL carries the scope', () => {
  it('pins a member to their own user and tenant, ignoring ?userId=', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp(member))
      .get('/api/observability/invocations/search?userId=u-someone-else&q=salary')
      .expect(200);
    const [sql] = execMock.mock.calls[0] as [string];
    const params = paramsOf(execMock.mock.calls[0]);
    expect(sql).toContain('t.user_id = :uid');
    expect(sql).toContain('t.tenant = :scope_tenant');
    expect(params['uid']).toBe('u-member');
    expect(params['scope_tenant']).toBe('orgiq');
    expect(Object.values(params)).not.toContain('u-someone-else');
  });

  it('a member with no userId parameter is still pinned to themselves', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp(member)).get('/api/observability/invocations/search').expect(200);
    expect(paramsOf(execMock.mock.calls[0])['uid']).toBe('u-member');
  });

  it('a fleet-wide role searches everyone, and may filter by any user', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp(operator)).get('/api/observability/invocations/search').expect(200);
    const [sql] = execMock.mock.calls[0] as [string];
    expect(sql).not.toContain(':uid');
    expect(sql).not.toContain('scope_tenant');

    execMock.mockClear();
    await request(buildApp(operator)).get('/api/observability/invocations/search?userId=u-x').expect(200);
    expect(paramsOf(execMock.mock.calls[0])['uid']).toBe('u-x');
  });

  it('scopes the detail lookup and 404s a trace that is not the caller’s', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp(member)).get(`/api/observability/invocations/${UUID}`);
    expect(res.status).toBe(404);
    const [sql] = execMock.mock.calls[0] as [string];
    expect(sql).toContain('user_id = :scope_user');
    expect(sql).toContain('tenant = :scope_tenant');
    expect(paramsOf(execMock.mock.calls[0])['scope_user']).toBe('u-member');
  });

  it('404s even when the database returns another user’s row (defence in depth)', async () => {
    execMock.mockResolvedValueOnce([{ invocation_id: UUID, agent_id: 'a', user_id: 'u-other', tenant: 'orgiq' }]);
    const res = await request(buildApp(member)).get(`/api/observability/invocations/${UUID}`);
    expect(res.status).toBe(404);
  });

  it('404s a row from another tenant even when the user id matches', async () => {
    execMock.mockResolvedValueOnce([{ invocation_id: UUID, agent_id: 'a', user_id: 'u-member', tenant: 'assessment' }]);
    const res = await request(buildApp(member)).get(`/api/observability/invocations/${UUID}`);
    expect(res.status).toBe(404);
  });

  it('scopes the children lookups too', async () => {
    execMock.mockResolvedValue([]);
    execMock.mockResolvedValueOnce([{ invocation_id: UUID, agent_id: 'a', user_id: 'u-member', tenant: 'orgiq' }]);
    await request(buildApp(member)).get(`/api/observability/invocations/${UUID}`).expect(200);
    const childCall = execMock.mock.calls.find((c) => String(c[0]).includes('WHERE parent_invocation_id = :id'));
    expect(childCall).toBeDefined();
    expect(String(childCall![0])).toContain(':scope_user');
  });

  it('scopes the replay source lookup', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp(member)).post(`/api/observability/invocations/${UUID}/replay`).send({});
    expect(res.status).toBe(404);
    expect(String(execMock.mock.calls[0]![0])).toContain(':scope_user');
  });

  it('refuses a request with no session at all', async () => {
    for (const path of ['/search', `/${UUID}`]) {
      const res = await request(buildApp(null)).get(`/api/observability/invocations${path}`);
      expect(res.status).toBe(401);
    }
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('offline corpus — the rows a member gets back', () => {
  beforeEach(() => {
    mockFlags.aurora = true;
    fixtureRegistry.resetAll('default');
  });
  afterEach(() => fixtureRegistry.resetAll('default'));

  const all = () => mockInvocationSearch({
    q: '', agentId: '', minScore: null, maxScore: null,
    since: null, until: null, promptVersion: '', userId: '', limit: 500,
  });

  it('a member sees only their own traces, whatever userId they ask for', async () => {
    const rows = all();
    const owners = [...new Set(rows.map((r) => r['user_id']).filter((u): u is string => typeof u === 'string'))];
    expect(owners.length).toBeGreaterThan(1);
    const [me, other] = owners as [string, string];

    const res = await request(buildApp({ ...member, sub: me }))
      .get(`/api/observability/invocations/search?userId=${encodeURIComponent(other)}&limit=500`)
      .expect(200);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.invocations.every((r: { userId: string }) => r.userId === me)).toBe(true);
  });

  it('a member cannot open another user’s trace by id', async () => {
    const rows = all();
    const mine = rows.find((r) => r['user_id'])!;
    const theirs = rows.find((r) => r['user_id'] && r['user_id'] !== mine['user_id'])!;
    const app = buildApp({ ...member, sub: String(mine['user_id']) });

    await request(app).get(`/api/observability/invocations/${encodeURIComponent(String(mine['invocation_id']))}`).expect(200);
    const res = await request(app).get(`/api/observability/invocations/${encodeURIComponent(String(theirs['invocation_id']))}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invocation not found' });
  });
});
