// A structural guard on every read that can quote someone's prompt or answer.
//
// The per-route suites (trace-scope-routes.test.ts, invocations-scope.test.ts)
// pin the clause each known reader applies. They cannot catch a route nobody
// knew about, and two earlier passes each missed some. This one does not list
// routes by hand: it reads every GET under the guarded prefixes from the
// route snapshot (mock/core/wire/snapshots/routes.json), mounts the routers
// the way index.ts does, plants another user's text in every store that holds
// invocation text, and calls each route as a plain member. Any planted text in
// any response fails the suite. A new route under a guarded prefix is called
// automatically; a new ROUTER under one fails the "every route has a mount"
// check until it is added to MOUNTS below.
//
// The plant is checked from the other side too: the cross-tenant admin must
// see it on the routes that carry it, so the guard can never pass vacuously
// because the text never arrived.

// The ring's fallback trace write is the trace sink's business, not this suite's.
process.env['OBS_MIDDLEWARE_TRACE_WRITE'] = 'never';

// config.ts reads import.meta, which the CommonJS test build cannot compile, so
// it is restated here with every provider on its offline branch.
jest.mock('../../config.js', () => ({
  config: {
    port: 0, region: 'us-east-1', accountId: '',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    messageQueue: { url: '', serviceId: 'orgiq-middleware', observedQueues: '', secret: '', mock: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    foundation: { scoresTable: 'orgiq-scores', sessionsTable: 'orgiq-sessions', documentsBucket: '', artifactsBucket: '' },
    knowledgeBase: { id: '', serviceRoleArn: '' },
    guardrail: { id: '', version: '1', byRole: { member: '', 'org-leader': '', 'hr-admin': '' } },
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    realtime: { gatewayUrl: undefined, platformApiUrl: undefined, videoUrl: undefined },
    cognito: { userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '', postLoginUrl: '/', portalOrigin: '', logoutRedirectUrl: '/' },
    agentcore: { memoryId: '', browserId: '', browserProfileId: '', codeInterpreterId: '', workloadIdentityArn: '', policyEngineId: '', gatewayId: '', gatewayUrl: '' },
    telemetry: { qualityEvaluatorId: '', toolSelectionEvaluatorId: '' },
    ecr: { supervisor: '', search: '', scoring: '', advisor: '', ingestion: '', graphBuilder: '' },
    canary: { subjectAArn: '', subjectBArn: '', judgeArn: '', name: 'orgiq-expert-explainer', scoresLogGroup: '/orgiq/canary/scores' },
  },
  capabilityCheckSkipReason: () => 'test',
  staleCapabilityLines: () => [],
}));

// The roles the gates evaluate, as seeds/roles/*.cedar grant them to these two
// (role-registry.ts reads import.meta too).
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: [
      'Search', 'ViewOrgChart', 'ViewObservability', 'LabelFeedback', 'ViewWorkItems',
      'ConnectLocalCompute', 'ViewSessionBrief', 'DecideDecision', 'VoiceNavigate'] },
  ],
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Router, type RequestHandler } from 'express';
import { errorHandler } from '../../lib/async-handler.js';
import { requireAction, requireSession, requireTenant } from '../../lib/authz.js';
import { insertSinkTrace, sinkMemoryEvents, sinkGuardrailInterventions, sinkToolCalls } from '../../mock/trace-sink.js';
import { recordInvocation, recordCapabilityEvent, appendJourneyStep } from '../../lib/invocations.js';
import { canaryBroker } from '../../lib/canary-broker.js';
import { openAgentRun } from '../../lib/agent-runs-live.js';
import { cloudwatch } from '../../providers/index.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';

import { observabilityRouter } from '../observability.js';
import { approvalsRouter } from '../approvals.js';
import { harnessRouter } from '../harness.js';
import { promptVersionsRouter } from '../prompt-versions.js';
import { costRouter } from '../cost.js';
import { calibrationRouter } from '../calibration.js';
import { oncallRouter } from '../oncall.js';
import { memoryRouter } from '../memory.js';
import { guardrailsDetailRouter } from '../guardrails-detail.js';
import { trafficRouter } from '../traffic.js';
import { testFixturesRouter } from '../test-fixtures.js';
import { invocationsRouter } from '../invocations.js';
import { topologyRouter } from '../topology.js';
import { toolCallsRouter } from '../tool-calls.js';
import { canaryRouter } from '../canary.js';
import { canaryLibraryRouter } from '../canary-library.js';
import { evaluationsRouter } from '../evaluations.js';
import { promptHistoryRouter } from '../prompt-history.js';
import { promptPointersRouter } from '../prompt-pointers.js';
import { agentDetailRouter } from '../agent-detail.js';
import { agentsRouter } from '../agents.js';
import { capabilitiesRouter } from '../capabilities.js';
import { runsFacadeRouter } from '../runs.js';
import { sessionBriefsRouter } from '../session-briefs.js';

/** Every prefix whose routes can return invocation text, or sit beside one that does. */
const GUARDED_PREFIXES = [
  '/api/observability', '/api/agent-detail', '/api/agents/', '/api/topology',
  '/api/iq/prompts', '/api/capabilities', '/api/runs',
];

const viewObs: RequestHandler[] = [requireTenant('orgiq'), requireAction('ViewObservability')];

/**
 * The mounts, in index.ts order, keyed by the router's source file (the
 * snapshot's `source`). Order matters: approvals and the harness are mounted
 * ahead of the gated observability router, as in index.ts.
 */
const MOUNTS: Array<{ source: string; path: string; gates: RequestHandler[]; router: Router }> = [
  { source: 'src/routes/agent-detail.ts', path: '/api/agent-detail', gates: [requireTenant('orgiq'), requireSession('ViewAgents')], router: agentDetailRouter },
  { source: 'src/routes/agents.ts', path: '/api/agents', gates: [requireSession('ViewAgents')], router: agentsRouter },
  { source: 'src/routes/session-briefs.ts', path: '/api', gates: [], router: sessionBriefsRouter },
  { source: 'src/routes/runs.ts', path: '/api/runs', gates: [requireTenant('orgiq')], router: runsFacadeRouter },
  { source: 'src/routes/approvals.ts', path: '/api/observability/approvals', gates: [], router: approvalsRouter },
  { source: 'src/routes/harness.ts', path: '/api/observability/harness', gates: [], router: harnessRouter },
  { source: 'src/routes/prompt-versions.ts', path: '/api/observability/prompt-versions', gates: viewObs, router: promptVersionsRouter },
  { source: 'src/routes/cost.ts', path: '/api/observability/cost', gates: viewObs, router: costRouter },
  { source: 'src/routes/calibration.ts', path: '/api/observability/calibration', gates: viewObs, router: calibrationRouter },
  { source: 'src/routes/oncall.ts', path: '/api/observability/oncall', gates: viewObs, router: oncallRouter },
  { source: 'src/routes/memory.ts', path: '/api/observability/memory', gates: viewObs, router: memoryRouter },
  { source: 'src/routes/guardrails-detail.ts', path: '/api/observability/guardrails-detail', gates: viewObs, router: guardrailsDetailRouter },
  { source: 'src/routes/traffic.ts', path: '/api/observability/traffic', gates: viewObs, router: trafficRouter },
  { source: 'src/routes/test-fixtures.ts', path: '/api/observability/test-fixtures', gates: [requireSession('TestFixtures')], router: testFixturesRouter },
  { source: 'src/routes/invocations.ts', path: '/api/observability/invocations', gates: viewObs, router: invocationsRouter },
  { source: 'src/routes/topology.ts', path: '/api/topology', gates: viewObs, router: topologyRouter },
  { source: 'src/routes/tool-calls.ts', path: '/api/observability/tools', gates: viewObs, router: toolCallsRouter },
  { source: 'src/routes/canary.ts', path: '/api/observability/canary', gates: viewObs, router: canaryRouter },
  { source: 'src/routes/canary-library.ts', path: '/api/observability/canary', gates: viewObs, router: canaryLibraryRouter },
  { source: 'src/routes/prompt-history.ts', path: '/api/iq/prompts', gates: viewObs, router: promptHistoryRouter },
  { source: 'src/routes/prompt-pointers.ts', path: '/api/iq/prompts', gates: viewObs, router: promptPointersRouter },
  { source: 'src/routes/evaluations.ts', path: '/api/observability/evaluations', gates: viewObs, router: evaluationsRouter },
  // observabilityRouter mounts drift and quality inside itself.
  { source: 'src/routes/observability.ts', path: '/api/observability', gates: viewObs, router: observabilityRouter },
  { source: 'src/routes/drift.ts', path: '', gates: [], router: express.Router() },
  { source: 'src/routes/quality.ts', path: '', gates: [], router: express.Router() },
  { source: 'src/routes/capabilities.ts', path: '/api/capabilities', gates: [requireTenant('orgiq'), requireSession('ViewCapabilities')], router: capabilitiesRouter },
];

// ── The plant: another user's text, in every store that holds invocation text ──

const MARK = 'ZQX-OTHER-USER';
const OTHER = { sub: 'u-guard-other', tenant: 'orgiq' };
const TRACE_ID = '7e1f0000-0000-4000-8000-00000000beef';
const BROWSER_SESSION = 'bs-guard';
const NOW = '2026-11-09T21:00:00.000Z';

function plant(): void {
  insertSinkTrace({
    invocation_id: TRACE_ID, agent_id: 'orgiq-supervisor', agent_name: 'Supervisor', template_id: null,
    prompt_snippet: `${MARK} prompt`, response_snippet: `${MARK} response`, output_embedding: null,
    judge_score: 0.4, judge_rationale: `${MARK} rationale`, schema_valid: true, pii_detected: false,
    guardrail_action: 'BLOCKED', duration_ms: 1200, input_tokens: 300, output_tokens: 120,
    judge_input_tokens: 200, judge_output_tokens: 40, est_cost_usd: 0.01, judge_cost_usd: 0.001,
    total_cost_usd: 0.011, prompt_version: null, model_id: 'nova-pro-v1', runtime_image_digest: null,
    parent_invocation_id: null, user_id: OTHER.sub, session_id: 'sess-guard',
    agui_run_id: 'run-guard', agui_thread_id: 'sess-guard', steps: null, tenant: OTHER.tenant,
    ts: NOW,
  });
  sinkMemoryEvents.rows().push({
    invocation_id: TRACE_ID, agent_id: 'orgiq-supervisor', session_id: 'sess-guard', kind: 'retrieve',
    memory_id: 'mem-guard', query_text: `${MARK} memory query`, result_count: 1, duration_ms: 30,
    retrieved_summary: `${MARK} memory summary`, errored: false, error_message: null,
  });
  sinkGuardrailInterventions.rows().push({
    invocation_id: TRACE_ID, agent_id: 'orgiq-supervisor', rule_name: 'pii-guard', rule_category: 'PII',
    severity: 'HIGH', action: 'BLOCKED', matched_text: `${MARK} matched`,
  });
  sinkToolCalls.rows().push({
    invocation_id: TRACE_ID, tool_name: 'search_organization', started_at: NOW, duration_ms: 50,
    input_size: 10, output_size: 0, errored: true, error_message: `${MARK} tool error`,
    input_sample: `${MARK} tool input`, output_sample: null, est_cost_usd: null,
  });
  recordInvocation({
    id: 'inv-guard-ring', agentId: 'orgiq-supervisor', agentName: 'Supervisor', startedAt: NOW,
    durationMs: 900, promptSnippet: `${MARK} ring prompt`, responseSnippet: `${MARK} ring response`,
    guardrailIntervened: false, userId: OTHER.sub, tenant: OTHER.tenant,
  });
  recordCapabilityEvent({
    id: 'cap-guard', kind: 'code_execute', startedAt: NOW, durationMs: 10, sessionId: 'cs-guard',
    detail: { codeSnippet: `${MARK} code`, outputSnippet: `${MARK} output`, language: 'python' },
    ok: true, userId: OTHER.sub, tenant: OTHER.tenant,
  });
  appendJourneyStep(BROWSER_SESSION, {
    startedAt: NOW, url: 'https://example.com', pageTitle: 'Example', textSnippet: '',
    question: `${MARK} web question`, answer: `${MARK} web answer`, userId: OTHER.sub, tenant: OTHER.tenant,
  });
  canaryBroker.publish({ type: 'invocation_started', request_id: 'cr-guard', version_arn: 'arn:a', version_label: 'A',
    question: `${MARK} canary question`, ts: NOW, user_id: OTHER.sub, tenant: OTHER.tenant });
  canaryBroker.publish({ type: 'invocation_complete', request_id: 'cr-guard', latency_ms: 5,
    response_preview: `${MARK} canary answer`, ts: NOW, user_id: OTHER.sub, tenant: OTHER.tenant });
  openAgentRun({ runId: 'run-guard-live', threadId: null, agentId: 'orgiq-supervisor', agentName: 'Supervisor',
    userId: OTHER.sub, tenant: OTHER.tenant, prompt: `${MARK} live run prompt` });

  // X-Ray and Bedrock's invocation log name no caller; offline they are empty, so plant one each.
  const trace = {
    traceId: 'trace-guard', rootSpan: 'span-guard', agentId: 'orgiq-supervisor', agentName: 'Supervisor',
    startTime: NOW, totalDurationMs: 100, spanCount: 1, status: 'ok' as const, tokensIn: 1, tokensOut: 1,
    spans: [{ traceId: 'trace-guard', spanId: 'span-guard', parentSpanId: null, name: 'supervisor.invoke', kind: 'agent' as const,
      startTimeMs: 0, durationMs: 100, status: 'ok' as const, attributes: { 'agent.id': 'orgiq-supervisor', 'user.query': `${MARK} span query` } }],
  };
  jest.spyOn(cloudwatch, 'listTraces').mockResolvedValue([trace]);
  jest.spyOn(cloudwatch, 'getTrace').mockResolvedValue(trace);
  jest.spyOn(cloudwatch, 'listBedrockInvocations').mockResolvedValue([{
    requestId: 'br-guard', timestamp: NOW, agent: 'supervisor', modelId: 'nova-pro-v1', operation: 'Converse',
    promptSnippet: `${MARK} bedrock prompt`, responseSnippet: `${MARK} bedrock response`,
    inputTokens: 1, outputTokens: 1, durationGuess: 0, intervened: false, interventions: [],
  }]);
}

// ── Calling every route ──

interface SnapshotRoute { method: string; path: string; source: string }

const snapshot = JSON.parse(readFileSync(join(__dirname, '../../mock/core/wire/snapshots/routes.json'), 'utf8')) as { routes: SnapshotRoute[] };
const guarded = snapshot.routes.filter((r) => GUARDED_PREFIXES.some((p) => r.path === p || r.path.startsWith(p.endsWith('/') ? p : `${p}/`)));
const sourceFile = (r: SnapshotRoute) => r.source.replace(/:\d+$/, '');

/** Path parameters, filled so the planted rows are the ones each route looks up. */
const PARAMS: Record<string, string> = {
  invocationId: TRACE_ID, traceId: 'trace-guard', agentId: 'orgiq-supervisor', sessionId: BROWSER_SESSION,
  id: 'agent-run:run-guard-live', ref: 'agent-run:run-guard-live', runIdA: 'x', runIdB: 'x',
};
const fill = (path: string) => path.replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(PARAMS[name] ?? 'x'));

const sessions = {
  member: { sub: 'u-guard-member', name: 'Guard Member', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 0 },
  admin: { sub: 'u-guard-admin', name: 'Guard Admin', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] }, iat: 0 },
};
type Who = keyof typeof sessions;

let server: Server;
let base = '';
let who: Who = 'member';

/** The body a GET answers with, or what a stream sent in its first moments. */
async function read(path: string): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  let body = '';
  let status = 0;
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
    status = res.status;
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return { status, body };
}

let restoreClock: () => void;

beforeAll(async () => {
  // The canary broker and the authz audit write JSON lines to stdout; quiet them.
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  restoreClock = freezeClock(NOW);
  plant();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = sessions[who]; next(); });
  for (const m of MOUNTS) if (m.path) app.use(m.path, ...m.gates, m.router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restoreClock?.();
  unfreezeClock();
  jest.restoreAllMocks();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

describe('no route quotes another user\'s prompt or answer to a member', () => {
  it('every guarded route in the snapshot has a mount here', () => {
    expect(guarded.length).toBeGreaterThan(100);
    const known = new Set(MOUNTS.map((m) => m.source));
    const unmounted = guarded.filter((r) => !known.has(sourceFile(r))).map((r) => `${r.method} ${r.path} (${r.source})`);
    expect(unmounted).toEqual([]);
  });

  it('the cross-tenant admin sees the plant, so the guard is not vacuous', async () => {
    who = 'admin';
    const carriers = [
      '/api/observability/recent-invocations?limit=200',
      `/api/observability/invocations/${TRACE_ID}`,
      '/api/observability/memory/events?limit=500',
      '/api/observability/guardrails-detail/interventions?limit=500',
      '/api/observability/tools/errors?limit=500',
      '/api/observability/capability-events',
      '/api/observability/traces',
      '/api/observability/bedrock-invocations',
      '/api/observability/canary/events',
      `/api/capabilities/browser-sessions/${BROWSER_SESSION}/journey`,
    ];
    const missing: string[] = [];
    for (const path of carriers) {
      const { body } = await read(path);
      if (!body.includes(MARK)) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it('a member reading every GET sees none of it', async () => {
    who = 'member';
    const leaks: string[] = [];
    const checked: string[] = [];
    for (const r of guarded.filter((x) => x.method === 'GET')) {
      const path = fill(r.path);
      const { status, body } = await read(path);
      checked.push(`${status} GET ${r.path}`);
      if (body.includes(MARK)) leaks.push(`GET ${r.path} → ${body.slice(Math.max(0, body.indexOf(MARK) - 80), body.indexOf(MARK) + 60)}`);
    }
    if (process.env['TRACE_GUARD_LIST'] === '1') console.warn(checked.join('\n'));
    expect(leaks).toEqual([]);
  }, 120_000);
});
