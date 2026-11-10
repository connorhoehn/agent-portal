// GET /api/observability/authz/stream and GET /api/observability/traces/:traceId,
// behind the mount index.ts gives the router: `viewObs` = tenant scope +
// ViewObservability (same harness as pr-watch-health-route.test.ts).
//
// What is pinned here:
//   * the AUTH FLOOR on both: anonymous 401, wrong tenant 403, missing
//     capability 403 — the authz stream carries every decision's sub and role,
//     so it must not open for anyone outside the observability read,
//   * the stream replays the recent buffer OLDEST-FIRST on connect (the buffer
//     query is newest-first; the route reverses it), then forwards live
//     decisions as they are logged, every frame tagged `type: 'authz'`,
//   * a trace id the provider does not know is a 404, not an empty 200.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
    auth: { policyStoreId: undefined },
    cognito: {
      userPoolId: 'us-east-1_test', clientId: 'cid', clientSecret: 'csec',
      domain: 'example.auth', callbackUrl: 'http://localhost/cb',
    },
  },
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['ViewObservability'] },
    // A fleet-wide role (lib/devbox-visibility FLEET_WIDE_ROLES): every user's traces in its own tenant.
    { id: 'org-leader', tenant: 'orgiq', label: 'Org leader', summary: '', capabilities: ['ViewObservability'] },
    { id: 'no-obs', tenant: 'orgiq', label: 'No obs', summary: '', capabilities: [] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewObservability'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey: jest.fn() }));
jest.mock('../../providers/bots.js', () => ({ createBotRun: jest.fn() }));
jest.mock('../../lib/github-connector.js', () => ({ listPulls: jest.fn(), getPullStatus: jest.fn() }));
jest.mock('../../lib/bot-runner.js', () => ({ checkConcurrency: jest.fn(), botMaxConcurrent: () => 2 }));
jest.mock('../../providers/index.js', () => ({
  cloudwatch: { getTrace: jest.fn(), listTraces: jest.fn(), getSummary: jest.fn(), listBedrockInvocations: jest.fn() },
}));
jest.mock('../../lib/invocations.js', () => ({
  getRecentInvocations: jest.fn(), getCapabilityEvents: jest.fn(),
}));

import express from 'express';
import type { IncomingMessage } from 'node:http';
import request from '../../test-support/http.js';
import { observabilityRouter } from '../observability.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireAction, requireTenant } from '../../lib/authz.js';
import { logAuthz } from '../../lib/audit.js';
import { cloudwatch } from '../../providers/index.js';
import { getRecentInvocations, getCapabilityEvents } from '../../lib/invocations.js';

type FakeSession = {
  sub: string; name: string; role: string; tenant: string;
  grants: Record<string, string[]>; iat: number;
};

function sessionFor(role: string, tenant: string): FakeSession {
  return { sub: `u-${role}`, name: role, role, tenant, grants: { [tenant]: [role] }, iat: 0 };
}

function buildApp(session: FakeSession | null) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      (req as unknown as { session: FakeSession }).session = session;
      next();
    });
  }
  app.use('/api/observability', requireTenant('orgiq'), requireAction('ViewObservability'), observabilityRouter);
  app.use(errorHandler);
  return app;
}

const getTraceMock = cloudwatch.getTrace as unknown as jest.Mock;
const listTracesMock = cloudwatch.listTraces as unknown as jest.Mock;
const summaryMock = cloudwatch.getSummary as unknown as jest.Mock;
const bedrockMock = cloudwatch.listBedrockInvocations as unknown as jest.Mock;
const recentMock = getRecentInvocations as unknown as jest.Mock;
const capEventsMock = getCapabilityEvents as unknown as jest.Mock;

beforeEach(() => {
  for (const m of [getTraceMock, listTracesMock, summaryMock, bedrockMock, recentMock, capEventsMock]) m.mockReset();
  recentMock.mockReturnValue([]); capEventsMock.mockReturnValue([]);
  // logAuthz writes a JSON line to stdout for log shipping; keep the run quiet.
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const member = () => sessionFor('member', 'orgiq');
// The text-bearing reads apply the caller's trace scope (lib/trace-scope.ts);
// the data-plane cases below run as the cross-tenant admin, and the member's
// view of the same rows is pinned beside them.
const admin = () => sessionFor('admin', 'orgiq');

describe('the whole router sits behind the observability read', () => {
  const READS = [
    '/api/observability/authz', '/api/observability/recent-invocations', '/api/observability/capability-events',
    '/api/observability/bedrock-invocations', '/api/observability/summary', '/api/observability/traces',
  ];
  it('401s anonymous, 403s another tenant and a role without ViewObservability, and never reads a provider', async () => {
    for (const path of READS) {
      expect({ path, status: (await request(buildApp(null)).get(path)).status }).toEqual({ path, status: 401 });
      expect({ path, status: (await request(buildApp(sessionFor('assessor', 'assessment'))).get(path)).status }).toEqual({ path, status: 403 });
      expect({ path, status: (await request(buildApp(sessionFor('no-obs', 'orgiq'))).get(path)).status }).toEqual({ path, status: 403 });
    }
    for (const m of [listTracesMock, summaryMock, bedrockMock, recentMock, capEventsMock]) expect(m).not.toHaveBeenCalled();
  });
});

describe('GET /api/observability/authz', () => {
  it('filters the decision buffer by decision, role and action substring, newest first', async () => {
    const marker = `filter${Date.now()}`;
    logAuthz({ decision: 'ALLOW', action: `${marker}Read`, sub: 'u-1', role: 'member', tenant: 'orgiq' });
    logAuthz({ decision: 'DENY', action: `${marker}Write`, sub: 'u-2', role: 'member', tenant: 'orgiq' });
    logAuthz({ decision: 'DENY', action: `${marker}Write`, sub: 'u-3', role: 'sme', tenant: 'orgiq' });
    const res = await request(buildApp(member())).get(`/api/observability/authz?decision=DENY&role=member&action=${marker}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ decision: 'DENY', sub: 'u-2', role: 'member', action: `${marker}Write` });

    const all = await request(buildApp(member())).get(`/api/observability/authz?action=${marker.toUpperCase()}`);
    // Case-insensitive, newest first.
    expect(all.body.events.map((e: { sub: string }) => e.sub)).toEqual(['u-3', 'u-2', 'u-1']);
  });

  it('ignores an unknown decision value and caps the limit', async () => {
    const marker = `cap${Date.now()}`;
    for (let i = 0; i < 3; i++) logAuthz({ decision: 'ALLOW', action: marker, sub: `u-${i}`, role: 'member', tenant: 'orgiq' });
    const res = await request(buildApp(member())).get(`/api/observability/authz?decision=MAYBE&action=${marker}&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.map((e: { sub: string }) => e.sub)).toEqual(['u-2', 'u-1']);
  });
});

describe('GET /api/observability/recent-invocations and /capability-events', () => {
  it('passes a clamped limit (default 50, 1..200) and answers under its collection key', async () => {
    recentMock.mockReturnValue([{ invocationId: 'i-1' }]);
    const res = await request(buildApp(admin())).get('/api/observability/recent-invocations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invocations: [{ invocationId: 'i-1' }] });
    expect(recentMock).toHaveBeenLastCalledWith(50, expect.any(Function));
    await request(buildApp(admin())).get('/api/observability/recent-invocations?limit=9999');
    expect(recentMock).toHaveBeenLastCalledWith(200, expect.any(Function));
    await request(buildApp(admin())).get('/api/observability/recent-invocations?limit=-4');
    expect(recentMock).toHaveBeenLastCalledWith(1, expect.any(Function));
  });

  it('a member keeps only their own rows in their own tenant', async () => {
    await request(buildApp(member())).get('/api/observability/recent-invocations');
    const keep = recentMock.mock.calls.at(-1)![1] as (r: Record<string, unknown>) => boolean;
    expect(keep({ id: 'a', userId: 'u-member', tenant: 'orgiq' })).toBe(true);
    expect(keep({ id: 'b', userId: 'u-other', tenant: 'orgiq' })).toBe(false);
    expect(keep({ id: 'c', userId: 'u-member', tenant: 'assessment' })).toBe(false);
    expect(keep({ id: 'd', userId: null, tenant: null })).toBe(false);
  });

  it('capability events forward the kind filter with the clamped limit', async () => {
    capEventsMock.mockReturnValue([{ kind: 'browser', id: 'e-1' }]);
    const res = await request(buildApp(admin())).get('/api/observability/capability-events?kind=browser&limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [{ kind: 'browser', id: 'e-1' }] });
    expect(capEventsMock).toHaveBeenLastCalledWith(5, 'browser');
    await request(buildApp(admin())).get('/api/observability/capability-events?limit=abc');
    expect(capEventsMock).toHaveBeenLastCalledWith(50, undefined);
  });

  it('a member keeps every event but reads only their own code and output', async () => {
    capEventsMock.mockReturnValue([
      { kind: 'code_execute', id: 'e-1', userId: 'u-member', tenant: 'orgiq', detail: { codeSnippet: 'mine', language: 'python' } },
      { kind: 'code_execute', id: 'e-2', userId: 'u-other', tenant: 'orgiq', detail: { codeSnippet: 'theirs', language: 'python' } },
    ]);
    const res = await request(buildApp(member())).get('/api/observability/capability-events');
    expect(res.body.events.map((e: { detail: unknown }) => e.detail)).toEqual([
      { codeSnippet: 'mine', language: 'python' }, { language: 'python' }]);
  });
});

describe('GET /api/observability/bedrock-invocations', () => {
  it('clamps limit to 1..100 and the window to 1..1440 minutes, in milliseconds', async () => {
    bedrockMock.mockResolvedValue([{ requestId: 'r-1' }]);
    const res = await request(buildApp(admin())).get('/api/observability/bedrock-invocations?limit=500&sinceMin=5000');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [{ requestId: 'r-1' }] });
    expect(bedrockMock).toHaveBeenLastCalledWith({ limit: 100, sinceMs: 1440 * 60_000 });
    await request(buildApp(admin())).get('/api/observability/bedrock-invocations');
    expect(bedrockMock).toHaveBeenLastCalledWith({ limit: 20, sinceMs: 60 * 60_000 });
  });

  it('names no caller, so anyone but the cross-tenant admin gets the entries without their text', async () => {
    bedrockMock.mockResolvedValue([{ requestId: 'r-1', promptSnippet: 'p', responseSnippet: 'r', inputTokens: 3 }]);
    const res = await request(buildApp(member())).get('/api/observability/bedrock-invocations');
    expect(res.body).toEqual({ entries: [{ requestId: 'r-1', promptSnippet: '', responseSnippet: '', inputTokens: 3 }], textWithheld: true });
  });

  it('a CloudWatch failure is a 5xx, not an empty list', async () => {
    bedrockMock.mockRejectedValue(new Error('log group missing'));
    expect((await request(buildApp(member())).get('/api/observability/bedrock-invocations')).status).toBeGreaterThanOrEqual(500);
  });
});

describe('GET /api/observability/summary and /traces', () => {
  it('summary answers the provider summary as-is', async () => {
    summaryMock.mockResolvedValue({ invocations24h: 12, errorRate: 0.25 });
    const res = await request(buildApp(member())).get('/api/observability/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invocations24h: 12, errorRate: 0.25 });
  });

  it('traces lists with the requested limit (default 10) under `traces`, reading the caller\'s scope', async () => {
    listTracesMock.mockResolvedValue([{ traceId: '1-a' }, { traceId: '1-b' }]);
    const res = await request(buildApp(admin())).get('/api/observability/traces?limit=2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ traces: [{ traceId: '1-a' }, { traceId: '1-b' }] });
    expect(listTracesMock).toHaveBeenLastCalledWith(2, null);
    await request(buildApp(member())).get('/api/observability/traces');
    expect(listTracesMock).toHaveBeenLastCalledWith(10, { tenant: 'orgiq', userId: 'u-member' });
  });

  it('a member lists only their own traces in their own tenant; the org leader every user\'s in the tenant (second regression walk)', async () => {
    const rows = [
      { traceId: 'mine', userId: 'u-member', tenant: 'orgiq' },
      { traceId: 'theirs', userId: 'u-other', tenant: 'orgiq', agentName: 'Supervisor' },
      { traceId: 'elsewhere', userId: 'u-member', tenant: 'assessment' },
      { traceId: 'ownerless' },
    ];
    listTracesMock.mockResolvedValue(rows);
    const ids = async (s: FakeSession) => ((await request(buildApp(s)).get('/api/observability/traces')).body.traces as Array<{ traceId: string }>).map((t) => t.traceId);
    expect(await ids(member())).toEqual(['mine']);
    expect(await ids({ ...sessionFor('org-leader', 'orgiq'), sub: 'u-lead' })).toEqual(['mine', 'theirs']);
    expect(await ids(admin())).toEqual(['mine', 'theirs', 'elsewhere', 'ownerless']);
  });

  it('a provider failure on either is a 5xx', async () => {
    summaryMock.mockRejectedValue(new Error('down'));
    listTracesMock.mockRejectedValue(new Error('down'));
    expect((await request(buildApp(member())).get('/api/observability/summary')).status).toBeGreaterThanOrEqual(500);
    expect((await request(buildApp(member())).get('/api/observability/traces')).status).toBeGreaterThanOrEqual(500);
  });
});

describe('GET /api/observability/authz/stream', () => {
  it('401s anonymous, 403s the wrong tenant and a role without ViewObservability', async () => {
    expect((await request(buildApp(null)).get('/api/observability/authz/stream')).status).toBe(401);
    const wrongTenant = await request(buildApp(sessionFor('assessor', 'assessment'))).get('/api/observability/authz/stream');
    expect(wrongTenant.status).toBe(403);
    expect(wrongTenant.body).toMatchObject({ requiredTenant: 'orgiq' });
    expect((await request(buildApp(sessionFor('no-obs', 'orgiq'))).get('/api/observability/authz/stream')).status).toBe(403);
  });

  it('opens an event stream, replays the buffer oldest-first, then forwards live decisions', async () => {
    const marker = `stream-${Date.now()}`;
    logAuthz({ decision: 'ALLOW', action: `${marker}-first`, sub: 'u-a', role: 'member', tenant: 'orgiq' });
    logAuthz({ decision: 'DENY', action: `${marker}-second`, sub: 'u-b', role: 'member', tenant: 'orgiq' });

    const res = await request(buildApp(member()))
      .get('/api/observability/authz/stream')
      .buffer(true)
      .parse((raw, done) => {
        // superagent hands the parser the Node response stream.
        const stream = raw as unknown as IncomingMessage;
        let text = '';
        let liveSent = false;
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          text += chunk;
          // Once the replay holds both seeded decisions, log a live one.
          if (!liveSent && text.includes(`${marker}-second`)) {
            liveSent = true;
            logAuthz({ decision: 'DENY', action: `${marker}-live`, sub: 'u-c', role: 'sme', tenant: 'orgiq' });
          }
          if (text.includes(`${marker}-live`)) {
            done(null, text);
            stream.destroy();
          }
        });
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    const frames = (res.body as string).trim().split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);
    const mine = frames.filter((f) => String(f['action']).startsWith(marker));
    expect(mine.map((f) => f['action'])).toEqual([`${marker}-first`, `${marker}-second`, `${marker}-live`]);
    expect(mine.every((f) => f['type'] === 'authz')).toBe(true);
    expect(mine[2]).toMatchObject({ decision: 'DENY', sub: 'u-c', role: 'sme', tenant: 'orgiq' });
    expect(typeof mine[2]!['ts']).toBe('string');
  });
});

describe('GET /api/observability/traces/:traceId', () => {
  it('401s anonymous and 403s a role without ViewObservability, before any provider read', async () => {
    expect((await request(buildApp(null)).get('/api/observability/traces/1-abc')).status).toBe(401);
    expect((await request(buildApp(sessionFor('no-obs', 'orgiq'))).get('/api/observability/traces/1-abc')).status).toBe(403);
    expect(getTraceMock).not.toHaveBeenCalled();
  });

  it('returns the provider trace for the requested id', async () => {
    const trace = { traceId: '1-abc', durationMs: 412, spans: [{ name: 'AGENT', durationMs: 400 }], userId: 'u-x', tenant: 'orgiq' };
    getTraceMock.mockResolvedValue(trace);
    const res = await request(buildApp(admin())).get('/api/observability/traces/1-abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(trace);
    expect(getTraceMock).toHaveBeenCalledWith('1-abc');
  });

  it('another user\'s trace, and an ownerless one, answer 404 to anyone but the cross-tenant admin', async () => {
    const spans = [{ name: 'AGENT', attributes: { 'agent.id': 'orgiq-supervisor', 'user.query': 'their question', 'query.type': 'sql', 'tokens.in': 4 } }];
    for (const owner of [{ userId: 'u-other', tenant: 'orgiq' }, { userId: 'u-member', tenant: 'assessment' }, {}]) {
      getTraceMock.mockResolvedValue({ traceId: '1-abc', spans, ...owner });
      const res = await request(buildApp(member())).get('/api/observability/traces/1-abc');
      expect([owner, res.status, res.body]).toEqual([owner, 404, { error: 'Trace not found' }]);
    }
    // The admin reads it whole, text included.
    getTraceMock.mockResolvedValue({ traceId: '1-abc', spans });
    expect((await request(buildApp(admin())).get('/api/observability/traces/1-abc')).body.spans[0].attributes['user.query']).toBe('their question');
  });

  it('a member opens their own trace, text included (like their own rows of invocation_traces)', async () => {
    getTraceMock.mockResolvedValue({ traceId: '1-abc', userId: 'u-member', tenant: 'orgiq', spans: [{ name: 'AGENT', attributes: { 'user.query': 'my question' } }] });
    const res = await request(buildApp(member())).get('/api/observability/traces/1-abc');
    expect(res.status).toBe(200);
    expect(res.body.spans[0].attributes).toEqual({ 'user.query': 'my question' });
  });

  it('404s a trace the provider does not know, rather than answering an empty 200', async () => {
    getTraceMock.mockResolvedValue(null);
    const res = await request(buildApp(member())).get('/api/observability/traces/1-missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Trace not found' });
  });

  it('a provider failure reaches the error handler as a 5xx, not a fake trace', async () => {
    getTraceMock.mockRejectedValue(new Error('XRay throttled'));
    const res = await request(buildApp(member())).get('/api/observability/traces/1-abc');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
