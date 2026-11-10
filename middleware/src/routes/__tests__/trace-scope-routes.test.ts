// Every route that returns prompt or response text from
// observability.invocation_traces applies one scope (lib/trace-scope.ts): a
// member reads only their own rows in their own tenant, whatever route they
// come through. invocations.ts has its own suite (invocations-scope.test.ts);
// this one covers the siblings: drift outliers and neighbours, the on-call
// judge regressions, cost /top (and the /summary that embeds it), the agent
// detail page's recent prompts, the quality chart's judge rationale, and the
// harness joins and re-judge.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', accountId: '', auth: { policyStoreId: '' },
    mock: { aurora: false, agentcore: false, guardrails: true, cloudwatch: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => { next(); },
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => { next(); },
}));
jest.mock('../../lib/judge.js', () => ({ judgeResponse: jest.fn(async () => ({ score: 0.5, rationale: 'ok' })) }));
jest.mock('../../lib/trace-sink.js', () => ({ processTrace: jest.fn() }));
jest.mock('../../lib/harness-runner.js', () => ({ executeRun: jest.fn(), loadCasesForRun: jest.fn(async () => []) }));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  listRuntimesResult: jest.fn(async () => ({ items: [{ id: 'rt-search', name: 'orgiq_search' }] })),
  getRuntimeMetrics: jest.fn(async () => null),
} }));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.reject(new Error('offline')); } },
  GetPromptCommand: class {}, ListPromptsCommand: class {},
}));
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class { send() { return Promise.reject(new Error('offline')); } },
  FilterLogEventsCommand: class {},
}));

import express, { type Router } from 'express';
import request from '../../test-support/http.js';
import { driftRouter } from '../drift.js';
import { oncallRouter } from '../oncall.js';
import { costRouter } from '../cost.js';
import { qualityRouter } from '../quality.js';
import { agentDetailRouter } from '../agent-detail.js';
import { harnessRouter } from '../harness.js';
import { memoryRouter } from '../memory.js';
import { guardrailsDetailRouter } from '../guardrails-detail.js';
import { toolCallsRouter } from '../tool-calls.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { scopeSql, joinScopeSql, rowInScope, scopeForSession } from '../../lib/trace-scope.js';

const execMock = exec as unknown as jest.Mock;
const UUID = '11111111-2222-3333-4444-555555555555';
const member = { sub: 'u-member', role: 'member', tenant: 'orgiq' };
const admin = { sub: 'u-admin', role: 'admin', tenant: 'orgiq' };

function app(mount: string, router: Router, session: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (session) (req as unknown as { session: unknown }).session = { grants: {}, iat: 0, ...session };
    next();
  });
  a.use(mount, router);
  a.use(errorHandler);
  return a;
}

type Param = { name: string; value: { stringValue?: string } };
const paramsOf = (call: unknown[]) =>
  Object.fromEntries(((call[1] ?? []) as Param[]).map((p) => [p.name, p.value.stringValue]));
/** The exec call whose SQL reads invocation_traces with snippet text. */
const snippetCall = () => execMock.mock.calls.find((c) => /_snippet/.test(String(c[0])) && /invocation_traces/.test(String(c[0])));

function expectMemberScoped(call: unknown[] | undefined) {
  expect(call).toBeDefined();
  expect(String(call![0])).toMatch(/user_id = :scope_user AND (\w+\.)?tenant = :scope_tenant/);
  const params = paramsOf(call!);
  expect(params['scope_user']).toBe('u-member');
  expect(params['scope_tenant']).toBe('orgiq');
}

beforeEach(() => { execMock.mockReset(); execMock.mockResolvedValue([]); });

describe('a member reads only their own snippet rows, route by route', () => {
  it('drift /outliers', async () => {
    await request(app('/d', driftRouter, member)).get('/d/outliers').expect(200);
    expectMemberScoped(snippetCall());
  });

  it('drift /neighbors: the probe and the neighbours are both scoped', async () => {
    await request(app('/d', driftRouter, member)).get(`/d/neighbors/${UUID}`).expect(200);
    const call = snippetCall()!;
    expectMemberScoped(call);
    expect(String(call[0])).toMatch(/invocation_id = :id::uuid AND user_id = :scope_user/);
    expect(String(call[0])).toMatch(/t\.user_id = :scope_user AND t\.tenant = :scope_tenant/);
  });

  it('on-call /recent-events judge regressions', async () => {
    await request(app('/o', oncallRouter, member)).get('/o/recent-events').expect(200);
    expectMemberScoped(snippetCall());
  });

  it('cost /top and the /summary that embeds it', async () => {
    await request(app('/c', costRouter, member)).get('/c/top').expect(200);
    expectMemberScoped(snippetCall());
    execMock.mockClear();
    await request(app('/c', costRouter, member)).get('/c/summary').expect(200);
    expectMemberScoped(snippetCall());
  });

  it('agent detail recent invocations', async () => {
    const res = await request(app('/a', agentDetailRouter, member)).get('/a/orgiq_search').expect(200);
    expectMemberScoped(snippetCall());
    // The runtime log names no caller, so only the cross-tenant admin reads it.
    expect(res.body.log.events).toEqual([]);
    expect(res.body.log.problem).toMatch(/administrators only/);
  });

  it('harness re-judge reads only an in-scope trace', async () => {
    await request(app('/h', harnessRouter, member)).post(`/h/results/${UUID}/rejudge`).expect(404);
    expectMemberScoped(snippetCall());
  });

  it('harness run results join a trace\'s text only when it is a harness trace or in scope', async () => {
    execMock.mockResolvedValueOnce([{ run_id: UUID, status: 'completed' }]).mockResolvedValue([]);
    await request(app('/h', harnessRouter, member)).get(`/h/runs/${UUID}`).expect(200);
    const call = execMock.mock.calls.find((c) => /trace_response_snippet/.test(String(c[0])))!;
    expect(String(call[0])).toContain('t.user_id IS NULL OR (TRUE AND t.user_id = :scope_user AND t.tenant = :scope_tenant)');
    expect(paramsOf(call)['scope_user']).toBe('u-member');
  });
});

it('the quality chart keeps every point but returns the rationale only for the caller\'s rows', async () => {
  execMock.mockResolvedValue([
    { invocation_id: 'a', agent_id: 'x', ts: 't', judge_rationale: 'mine', user_id: 'u-member', tenant: 'orgiq' },
    { invocation_id: 'b', agent_id: 'x', ts: 't', judge_rationale: 'theirs', user_id: 'u-other', tenant: 'orgiq' },
  ]);
  const res = await request(app('/q', qualityRouter, member)).get('/q/scores').expect(200);
  expect(res.body.points.map((p: { judgeRationale: string | null }) => p.judgeRationale)).toEqual(['mine', null]);
});

it('a fleet-wide role reads every user in its own tenant, never another tenant', async () => {
  await request(app('/d', driftRouter, { sub: 'u-lead', role: 'org-leader', tenant: 'orgiq' })).get('/d/outliers').expect(200);
  const call = snippetCall()!;
  expect(String(call[0])).not.toContain(':scope_user');
  expect(String(call[0])).toContain('w.tenant = :scope_tenant');
  expect(paramsOf(call)['scope_tenant']).toBe('orgiq');
});

it('the cross-tenant admin reads every row (no clause)', async () => {
  await request(app('/d', driftRouter, admin)).get('/d/outliers').expect(200);
  expect(String(snippetCall()![0])).not.toContain(':scope_user');
  expect(String(snippetCall()![0])).not.toContain(':scope_tenant');
});

it('no session is refused before any read', async () => {
  for (const [mount, router, path] of [['/d', driftRouter, '/d/outliers'], ['/o', oncallRouter, '/o/recent-events'],
    ['/c', costRouter, '/c/top'], ['/q', qualityRouter, '/q/scores'], ['/a', agentDetailRouter, '/a/orgiq_search']] as const) {
    await request(app(mount, router, null)).get(path).expect(401);
  }
  expect(snippetCall()).toBeUndefined();
});

describe('feeds that hang off a trace keep every row but quote only the caller\'s text', () => {
  const mine = { trace_user_id: 'u-member', trace_tenant: 'orgiq' };
  const theirs = { trace_user_id: 'u-other', trace_tenant: 'orgiq' };
  it('memory events: the query and what came back', async () => {
    execMock.mockResolvedValue([{ memory_event_id: 'm1', query_text: 'mine', retrieved_summary: 'mine', ...mine },
      { memory_event_id: 'm2', query_text: 'theirs', retrieved_summary: 'theirs', ...theirs }]);
    const res = await request(app('/m', memoryRouter, member)).get('/m/events').expect(200);
    expect(String(execMock.mock.calls[0]![0])).toMatch(/LEFT JOIN observability\.invocation_traces t ON t\.invocation_id = m\.invocation_id/);
    expect(res.body.events.map((e: { queryText: string | null; retrievedSummary: string | null }) => [e.queryText, e.retrievedSummary]))
      .toEqual([['mine', 'mine'], [null, null]]);
  });
  it('guardrail interventions: the matched text', async () => {
    execMock.mockResolvedValue([{ intervention_id: 'g1', matched_text: 'mine', ...mine }, { intervention_id: 'g2', matched_text: 'theirs', ...theirs }]);
    const res = await request(app('/g', guardrailsDetailRouter, member)).get('/g/interventions').expect(200);
    expect(res.body.interventions.map((i: { matchedText: string | null }) => i.matchedText)).toEqual(['mine', null]);
  });
  it('tool errors: the error text', async () => {
    execMock.mockResolvedValue([{ tool_call_id: 't1', error_message: 'mine', ...mine }, { tool_call_id: 't2', error_message: 'theirs', ...theirs }]);
    const res = await request(app('/t', toolCallsRouter, member)).get('/t/errors').expect(200);
    expect(res.body.errors.map((e: { errorMessage: string | null }) => e.errorMessage)).toEqual(['mine', null]);
  });
});

describe('the helper', () => {
  it('builds the clause with or without an alias, and nothing for the cross-tenant admin', () => {
    expect(scopeSql({ tenant: 'orgiq', userId: 'u' }, 't.').clause).toBe(' AND t.user_id = :scope_user AND t.tenant = :scope_tenant');
    expect(scopeSql(null).clause).toBe('');
    expect(joinScopeSql('none', 't.').clause).toBe(' AND t.user_id IS NULL');
    expect(scopeSql({ tenant: 'orgiq', userId: null }).clause).toBe(' AND tenant = :scope_tenant');
  });
  it('scopeForSession: admin everything, fleet-wide its tenant, member itself', () => {
    expect(scopeForSession({ sub: 'a', role: 'admin', tenant: 'orgiq' })).toBeNull();
    expect(scopeForSession({ sub: 'l', role: 'org-leader', tenant: 'orgiq' })).toEqual({ tenant: 'orgiq', userId: null });
    expect(scopeForSession({ sub: 'h', role: 'hr-admin', tenant: 'orgiq' })).toEqual({ tenant: 'orgiq', userId: null });
    expect(scopeForSession({ sub: 'm', role: 'member', tenant: 'orgiq' })).toEqual({ tenant: 'orgiq', userId: 'm' });
    expect(scopeForSession(undefined)).toBe('none');
  });
  it('rowInScope matches the SQL for the offline corpus', () => {
    const scope = { tenant: 'orgiq', userId: 'u' };
    expect(rowInScope(scope, { user_id: 'u' })).toBe(true);
    expect(rowInScope(scope, { user_id: 'v' })).toBe(false);
    expect(rowInScope(scope, { user_id: 'u', tenant: 'assessment' })).toBe(false);
  });
});
