// The harness routes that drive and audit a run — execute, live status,
// re-judge, and the promoted-prompt list — under MOCK_AURORA with the REAL
// authz gates in front of them.
//
// harness-mock.test.ts stubs `requireAction` away to test the fixture
// branches; that is right for it and wrong here. These four routes carry a
// capability gate that is the whole point of their contract: executing a
// suite and re-judging spend Bedrock tokens (ManageCanary), and status /
// promoted-versions are observability reads (ViewObservability). So each
// route is pinned three ways: anonymous → 401, a role without the action →
// 403 (and the handler never ran), and the success shape off the fixtures.
//
// Cognito is configured in the mocked config so the dev demo-user fallback is
// off — a request with no session is genuinely anonymous.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    auth: { policyStoreId: undefined },
    cognito: {
      userPoolId: 'us-east-1_test', clientId: 'cid', clientSecret: 'csec',
      domain: 'example.auth', callbackUrl: 'http://localhost/cb',
    },
  },
}));

// Open-mode authz reads the Cedar seeds through role-registry, which uses
// import.meta.url and cannot load under ts-jest's CJS transform.
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'org-leader', tenant: 'orgiq', label: 'Org Leader', summary: '',
      capabilities: ['ViewObservability', 'ManageCanary'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['ViewObservability'] },
    { id: 'participant', tenant: 'social', label: 'Participant', summary: '',
      capabilities: ['ViewSocial'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

// Offline, nothing here may reach the Data API — every route has a forced
// mock branch, and a call to exec would mean that branch was skipped.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => { throw new Error('exec reached offline'); }) }));
jest.mock('../../lib/trace-sink.js', () => ({ processTrace: jest.fn() }));
jest.mock('../../lib/judge.js', () => ({ judgeResponse: jest.fn() }));
jest.mock('../../lib/harness-runner.js', () => ({
  executeRun: jest.fn(async () => undefined), loadCasesForRun: jest.fn(async () => []),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { harnessRouter } from '../harness.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { judgeResponse } from '../../lib/judge.js';
import { executeRun, loadCasesForRun } from '../../lib/harness-runner.js';
import { fixtureRegistry } from '../../mock/core/fixture.js';
import { testRuns, mockListRuns } from '../../mock/harness.js';
import { insertSinkTrace, type SinkTraceRow } from '../../mock/trace-sink.js';
import { mockListPromotedVersions } from '../../mock/prompt-versions.js';
import type { Session } from '../../lib/session.js';

const leader: Session = { sub: 'u-lead', role: 'org-leader', tenant: 'orgiq', iat: 0, grants: { orgiq: ['org-leader'] } };
const member: Session = { sub: 'u-mem', role: 'member', tenant: 'orgiq', iat: 0, grants: { orgiq: ['member'] } };
const outsider: Session = { sub: 'u-soc', role: 'participant', tenant: 'social', iat: 0, grants: { social: ['participant'] } };

function buildApp(session: Session | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (session) req.session = session; next(); });
  app.use('/api/observability/harness', harnessRouter);
  app.use(errorHandler);
  return app;
}

const TRACE_ID = '0f8c5a2e-6b1d-4c3e-9a7f-1d2e3f4a5b6c';
function trace(): SinkTraceRow {
  return {
    invocation_id: TRACE_ID, agent_id: 'orgiq-search', agent_name: 'search', template_id: null,
    prompt_snippet: 'Who knows auth best?', response_snippet: 'Vera Green owns Auth Migration.',
    output_embedding: null, judge_score: null, judge_rationale: null, schema_valid: true,
    pii_detected: false, guardrail_action: null, duration_ms: 900, input_tokens: 10, output_tokens: 20,
    judge_input_tokens: null, judge_output_tokens: null, est_cost_usd: null, judge_cost_usd: null,
    total_cost_usd: null, prompt_version: null, model_id: 'amazon.nova-pro-v1:0', runtime_image_digest: null,
    parent_invocation_id: null, user_id: null, session_id: null, agui_run_id: null, agui_thread_id: null,
    steps: null, tenant: 'orgiq', ts: '2026-09-30T12:00:00.000Z',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fixtureRegistry.resetAll();
});
afterAll(() => fixtureRegistry.resetAll());

describe('POST /api/observability/harness/runs/:id/execute', () => {
  it('is ManageCanary: anonymous 401, a member 403, and neither reaches the runner', async () => {
    const runId = mockListRuns(1)[0]!.runId;
    expect((await request(buildApp(null)).post(`/api/observability/harness/runs/${runId}/execute`).send({})).status).toBe(401);
    const denied = await request(buildApp(member)).post(`/api/observability/harness/runs/${runId}/execute`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ action: 'ManageCanary' });
    expect(loadCasesForRun).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('404s an unknown run without touching the Data API', async () => {
    const res = await request(buildApp(leader)).post('/api/observability/harness/runs/no-such-run/execute').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('run not found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('409s a run that is already executing rather than starting it twice', async () => {
    const seed = testRuns.rows()[0]!;
    seed.status = 'running';
    const res = await request(buildApp(leader)).post(`/api/observability/harness/runs/${seed.runId}/execute`).send({});
    expect(res.status).toBe(409);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('400s when there are no active cases, naming the agent when one was asked for', async () => {
    const runId = mockListRuns(1)[0]!.runId;
    const any = await request(buildApp(leader)).post(`/api/observability/harness/runs/${runId}/execute`).send({});
    expect(any.status).toBe(400);
    expect(any.body.error).toMatch(/no active test cases/);
    const scoped = await request(buildApp(leader)).post(`/api/observability/harness/runs/${runId}/execute`).send({ agentId: 'orgiq-advisor' });
    expect(scoped.status).toBe(400);
    expect(scoped.body.error).toContain("'orgiq-advisor'");
    expect(loadCasesForRun).toHaveBeenLastCalledWith('orgiq-advisor');
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('202s with the case count and hands the run its own judge model and agent filter', async () => {
    jest.mocked(loadCasesForRun).mockResolvedValueOnce([{}, {}, {}] as never);
    const run = mockListRuns(1)[0]!;
    const res = await request(buildApp(leader)).post(`/api/observability/harness/runs/${run.runId}/execute`).send({ agentId: 'orgiq-search' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: run.runId, started: true, totalCases: 3 });
    expect(executeRun).toHaveBeenCalledWith(run.runId, { agentId: 'orgiq-search', judgeModelId: run.judgeModelId });
  });
});

describe('GET /api/observability/harness/runs/:id/status', () => {
  it('is ViewObservability: anonymous 401, a role without it 403', async () => {
    const runId = mockListRuns(1)[0]!.runId;
    expect((await request(buildApp(null)).get(`/api/observability/harness/runs/${runId}/status`)).status).toBe(401);
    expect((await request(buildApp(outsider)).get(`/api/observability/harness/runs/${runId}/status`)).status).toBe(403);
  });

  it('reports the fixture run\'s live counters, counted from its results', async () => {
    const run = mockListRuns(1)[0]!;
    const res = await request(buildApp(member)).get(`/api/observability/harness/runs/${run.runId}/status`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: run.status, total: run.totalCases, completed: run.completed,
      passed: run.passed, failed: run.failed, passRate: run.passRate,
    });
    expect(res.body.passed + res.body.failed).toBeLessThanOrEqual(res.body.completed);
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports a fresh run with no results as pass rate null, not 0', async () => {
    const seed = { ...testRuns.rows()[0]!, runId: 'fresh-run', status: 'pending' as const };
    testRuns.rows().push(seed);
    const res = await request(buildApp(member)).get('/api/observability/harness/runs/fresh-run/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending', completed: 0, passRate: null });
  });

  it('404s an unknown run', async () => {
    const res = await request(buildApp(member)).get('/api/observability/harness/runs/no-such-run/status');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/observability/harness/results/:invocationId/rejudge', () => {
  it('is ManageCanary: anonymous 401, a member 403, no judge spend', async () => {
    insertSinkTrace(trace());
    expect((await request(buildApp(null)).post(`/api/observability/harness/results/${TRACE_ID}/rejudge`)).status).toBe(401);
    expect((await request(buildApp(member)).post(`/api/observability/harness/results/${TRACE_ID}/rejudge`)).status).toBe(403);
    expect(judgeResponse).not.toHaveBeenCalled();
  });

  it('400s an id that is not a UUID before any lookup', async () => {
    const res = await request(buildApp(leader)).post('/api/observability/harness/results/mock-inv-0/rejudge');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/);
    expect(judgeResponse).not.toHaveBeenCalled();
  });

  it('404s a well-formed id the trace sink never wrote', async () => {
    const res = await request(buildApp(leader)).post('/api/observability/harness/results/11111111-2222-4333-8444-555555555555/rejudge');
    expect(res.status).toBe(404);
    expect(judgeResponse).not.toHaveBeenCalled();
  });

  it('judges the stored prompt/response three times and reports a failed judgement as absent (null), not a score', async () => {
    insertSinkTrace(trace());
    jest.mocked(judgeResponse)
      .mockResolvedValueOnce({ score: 0.9, rationale: 'grounded' } as never)
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ score: 0.8, rationale: 'mostly grounded' } as never);
    const res = await request(buildApp(leader)).post(`/api/observability/harness/results/${TRACE_ID}/rejudge`);
    expect(res.status).toBe(200);
    expect(judgeResponse).toHaveBeenCalledTimes(3);
    expect(judgeResponse).toHaveBeenCalledWith('Who knows auth best?', 'Vera Green owns Auth Migration.');
    // JSON has no NaN: the failed judgement serialises as null — absent, never 0.
    expect(res.body.scores).toEqual([0.9, null, 0.8]);
    expect(res.body.rationales).toEqual(['grounded', '', 'mostly grounded']);
  });
});

describe('GET /api/observability/harness/promoted-versions', () => {
  it('is ViewObservability: anonymous 401, a role without it 403', async () => {
    expect((await request(buildApp(null)).get('/api/observability/harness/promoted-versions')).status).toBe(401);
    expect((await request(buildApp(outsider)).get('/api/observability/harness/promoted-versions')).status).toBe(403);
  });

  it('lists only promoted SHAs, newest promotion first, from the registry fixture', async () => {
    const res = await request(buildApp(member)).get('/api/observability/harness/promoted-versions');
    expect(res.status).toBe(200);
    expect(exec).not.toHaveBeenCalled();
    expect(res.body.versions).toEqual(JSON.parse(JSON.stringify(mockListPromotedVersions(200))));
    // The seed holds six versions, two of them promoted; the four never
    // promoted must not appear.
    expect(res.body.versions).toHaveLength(2);
    const stamps = (res.body.versions as Array<{ promotedAt: string }>).map((v) => v.promotedAt);
    expect(stamps.every(Boolean)).toBe(true);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });
});
