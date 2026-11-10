// A structural guard on every read that can quote someone's prompt or answer.
//
// The per-route suites (trace-scope-routes.test.ts, invocations-scope.test.ts)
// pin the clause each known reader applies. They cannot catch a route nobody
// knew about, and two earlier passes each missed some. This one does not list
// routes by hand: it reads every GET under the guarded prefixes from the
// route snapshot (mock/core/wire/snapshots/routes.json), mounts the routers
// the way index.ts does, plants another user's text in every store that holds
// invocation text, and calls each route as a plain member and as a scoped
// operator (a role that holds the write capabilities but reads only its own
// traces). Any planted text in any response fails the suite. A new GET under a
// guarded prefix is called automatically; a new ROUTER under one fails the
// "every route has a mount" check until it is added to MOUNTS below.
//
// Writes are not called blindly (a DELETE or a promote has effects), so every
// non-GET route under the prefixes must appear in NON_GET: either exercised,
// with a body that names the planted ids, or listed as not reading trace text
// with the reason. A new POST that is in neither fails the suite. Streams are
// also held open while new foreign events arrive, so a live frame is checked
// as well as the replay.
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
    // A test-only role that holds every write the guarded routes gate on but
    // is neither fleet-wide nor cross-tenant, so its trace scope is its own
    // rows. A 403 for the plain member cannot make a POST check vacuous.
    { id: 'guard-operator', tenant: 'orgiq', label: 'Guard operator', summary: '', capabilities: [
      'Search', 'ViewOrgChart', 'ViewObservability', 'LabelFeedback', 'ViewWorkItems', 'ManageCanary',
      'EditGuardrail', 'ManageDevbox', 'ManageBots', 'ViewSessionBrief', 'VoiceNavigate'] },
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
import { openAgentRun, recordAgentRunEvent } from '../../lib/agent-runs-live.js';
import { mockCreateRun } from '../../mock/harness.js';
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
  operator: { sub: 'u-guard-operator', name: 'Guard Operator', role: 'guard-operator', tenant: 'orgiq', grants: { orgiq: ['guard-operator'] }, iat: 0 },
  admin: { sub: 'u-guard-admin', name: 'Guard Admin', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] }, iat: 0 },
};
type Who = keyof typeof sessions;

// ── Every non-GET route under the prefixes: exercised, or why it reads no trace text ──

/** A run the operator may drive; a result is linked to the planted trace through it. */
let GUARD_RUN_ID = '';
const UNKNOWN_RUN = '00000000-0000-4000-8000-0000000000aa';

type NonGetCase =
  | { exercise: true; body?: unknown; params?: () => Record<string, string> }
  | { readsNoTraceText: string };

const DESTRUCTIVE = 'destructive: deletes or resets, and answers only ok/404 with no trace text';
const OPERATOR_TEXT = 'operator-authored configuration or prompt text, not a user prompt or answer';

const NON_GET: Record<string, NonGetCase> = {
  // The seven stored-text readers the November review named.
  'POST /api/observability/invocations/:invocationId/replay': { exercise: true, body: {} },
  'POST /api/observability/harness/results/:invocationId/rejudge': { exercise: true, body: {} },
  'POST /api/observability/harness/runs': { exercise: true, body: { label: 'guard-run', notes: 'guard' } },
  'POST /api/observability/harness/runs/:id/execute': { exercise: true, body: {}, params: () => ({ id: UNKNOWN_RUN }) },
  'POST /api/observability/harness/runs/:runId/results': {
    exercise: true,
    body: { testId: 'guard-case', invocationId: TRACE_ID, passed: false },
    params: () => ({ runId: GUARD_RUN_ID }),
  },
  'POST /api/observability/calibration/runs': { exercise: true, body: { label: 'guard' } },
  'POST /api/observability/canary/ask': { exercise: true, body: { person_name: 'Guard', topic: 'guard topic', summary: 'guard summary' } },
  // Other writes that take a planted id or could quote stored text back.
  'POST /api/observability/harness/trace': { exercise: true, body: { invocationId: TRACE_ID } },
  'POST /api/observability/approvals/:id/decision': { exercise: true, body: { decision: 'REJECTED', note: 'guard' } },
  'POST /api/observability/approvals/request': { exercise: true, body: {} },
  'POST /api/agents/:agentId/invoke': { exercise: true, body: { message: 'what did I ask last time?', sessionId: 'sess-guard' } },
  'POST /api/capabilities/browser/web-qa': { exercise: true, body: { url: 'https://example.com', question: 'guard?', sessionId: BROWSER_SESSION } },
  'POST /api/capabilities/browser-sessions/:sessionId/navigate': { exercise: true, body: { url: 'https://example.com', captureScreenshot: true } },
  'POST /api/capabilities/browser-sessions/:sessionId/screenshot': { exercise: true, body: {} },
  'POST /api/observability/memory/events': { exercise: true, body: { agentId: 'orgiq-supervisor', kind: 'retrieve', invocationId: TRACE_ID } },
  'POST /api/observability/quality/feedback': { exercise: true, body: { invocationId: 'not-a-planted-id', label: 'good' } },

  // Writes that read no stored invocation text, each with the reason.
  'POST /api/capabilities/browser-sessions': { readsNoTraceText: 'launches a browser for the caller; answers the new session only' },
  'DELETE /api/capabilities/browser-sessions/:sessionId': { readsNoTraceText: DESTRUCTIVE },
  'DELETE /api/capabilities/browser-sessions/:sessionId/journey': { readsNoTraceText: DESTRUCTIVE },
  'POST /api/capabilities/browser/crawl': { readsNoTraceText: 'starts a crawl of a public URL; answers the crawl record' },
  'POST /api/capabilities/browser/crawl/:crawlId/cancel': { readsNoTraceText: 'cancels a crawl; answers ok or 404' },
  'POST /api/capabilities/code-interpreter/execute': { readsNoTraceText: "runs the caller's own code; answers that run's output only" },
  'DELETE /api/capabilities/code-sessions/:sessionId': { readsNoTraceText: DESTRUCTIVE },
  'PATCH /api/capabilities/guardrail/pii': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/capabilities/guardrail/topics': { readsNoTraceText: OPERATOR_TEXT },
  'DELETE /api/capabilities/guardrail/topics/:name': { readsNoTraceText: DESTRUCTIVE },
  'PATCH /api/capabilities/guardrail/topics/:name': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/iq/prompts/:agent/candidate': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/iq/prompts/:agent/promote': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/iq/prompts/:agent/rollback': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/iq/prompts/experiments/:experimentId/complete': { readsNoTraceText: 'closes a prompt experiment; answers aggregate scores only' },
  'PUT /api/iq/prompts/meta/:promptId/:version': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/calibration/cases': { readsNoTraceText: OPERATOR_TEXT },
  'DELETE /api/observability/calibration/cases/:id': { readsNoTraceText: DESTRUCTIVE },
  'PATCH /api/observability/calibration/cases/:id': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/canary/halt': { readsNoTraceText: 'canary control state; no text' },
  'POST /api/observability/canary/library': { readsNoTraceText: OPERATOR_TEXT },
  'PUT /api/observability/canary/library/:promptId/draft': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/canary/library/:promptId/invoke': { readsNoTraceText: "runs an operator-authored prompt with the caller's own variables; answers that run" },
  'POST /api/observability/canary/library/:promptId/optimize': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/canary/library/:promptId/publish': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/canary/reset': { readsNoTraceText: DESTRUCTIVE },
  'POST /api/observability/canary/start': { readsNoTraceText: 'canary control state; no text' },
  'PUT /api/observability/canary/weight': { readsNoTraceText: 'canary control state; no text' },
  'PUT /api/observability/evaluations/config': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/harness/cases': { readsNoTraceText: OPERATOR_TEXT },
  'DELETE /api/observability/harness/cases/:id': { readsNoTraceText: DESTRUCTIVE },
  'PATCH /api/observability/harness/cases/:id': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/harness/promote': { readsNoTraceText: 'promotes agent versions from run aggregates; no invocation text' },
  'PATCH /api/observability/harness/runs/:id': { readsNoTraceText: 'run counters and status; answers ok' },
  'POST /api/observability/prompt-versions': { readsNoTraceText: OPERATOR_TEXT },
  'POST /api/observability/test-fixtures/refresh-seed-timestamps': { readsNoTraceText: 'test-fixture maintenance; answers counts' },
  'POST /api/observability/test-fixtures/reset-approvals': { readsNoTraceText: DESTRUCTIVE },
};
const nonGet = guarded.filter((r) => r.method !== 'GET');
const routeKey = (r: SnapshotRoute) => `${r.method} ${r.path}`;

/** GETs that stream: held open while new foreign events arrive. */
const streams = guarded.filter((r) => r.method === 'GET' && /(^|\/)(stream|events)$/.test(r.path));

/** New text from the other user, published while a member's stream is open. */
function publishLive(n: number): void {
  canaryBroker.publish({ type: 'invocation_started', request_id: `cr-live-${n}`, version_arn: 'arn:a', version_label: 'A',
    question: `${MARK} live canary question`, ts: NOW, user_id: OTHER.sub, tenant: OTHER.tenant });
  canaryBroker.publish({ type: 'invocation_complete', request_id: `cr-live-${n}`, latency_ms: 5,
    response_preview: `${MARK} live canary answer`, ts: NOW, user_id: OTHER.sub, tenant: OTHER.tenant });
  recordAgentRunEvent('run-guard-live', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-guard', delta: `${MARK} live run delta` });
  recordAgentRunEvent('run-guard-live', { type: 'TOOL_CALL_START', toolCallId: `tc-${n}`, toolCallName: 'search_organization' });
  recordAgentRunEvent('run-guard-live', { type: 'TOOL_CALL_ARGS', toolCallId: `tc-${n}`, delta: `${MARK} live tool args` });
}

const excerpt = (body: string) => body.slice(Math.max(0, body.indexOf(MARK) - 80), body.indexOf(MARK) + 60);

let server: Server;
let base = '';
let who: Who = 'member';

/** The body a route answers with, or what a stream sent in its first moments. */
async function read(path: string, init: { method?: string; body?: unknown; windowMs?: number } = {}): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.windowMs ?? 1500);
  let body = '';
  let status = 0;
  try {
    const res = await fetch(`${base}${path}`, {
      signal: ctrl.signal,
      method: init.method ?? 'GET',
      ...(init.method && init.method !== 'GET'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) }
        : {}),
    });
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
  GUARD_RUN_ID = mockCreateRun({ label: 'guard', notes: null }).runId;
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

  async function everyGet(as: Who): Promise<string[]> {
    who = as;
    const leaks: string[] = [];
    const checked: string[] = [];
    for (const r of guarded.filter((x) => x.method === 'GET')) {
      const { status, body } = await read(fill(r.path));
      checked.push(`${status} ${as} GET ${r.path}`);
      if (body.includes(MARK)) leaks.push(`${as} GET ${r.path} → ${excerpt(body)}`);
    }
    // stderr directly: the jest setup silences console.
    if (process.env['TRACE_GUARD_LIST'] === '1') process.stderr.write(`${checked.join('\n')}\n`);
    return leaks;
  }

  it('a member reading every GET sees none of it', async () => {
    expect(await everyGet('member')).toEqual([]);
  }, 120_000);

  it('a scoped operator reading every GET sees none of it', async () => {
    expect(await everyGet('operator')).toEqual([]);
  }, 120_000);

  it('every non-GET route under the prefixes is exercised or says why it reads no trace text', () => {
    const snapshotKeys = new Set(nonGet.map(routeKey));
    const unclassified = [...snapshotKeys].filter((k) => !(k in NON_GET));
    const stale = Object.keys(NON_GET).filter((k) => !snapshotKeys.has(k));
    const noReason = Object.entries(NON_GET)
      .filter(([, c]) => 'readsNoTraceText' in c && c.readsNoTraceText.trim().length < 10).map(([k]) => k);
    expect({ unclassified, stale, noReason }).toEqual({ unclassified: [], stale: [], noReason: [] });
  });

  it('a member and a scoped operator calling every exercised write see none of it', async () => {
    const leaks: string[] = [];
    const checked: string[] = [];
    for (const r of nonGet) {
      const c = NON_GET[routeKey(r)];
      if (!c || !('exercise' in c)) continue;
      const extra = c.params?.() ?? {};
      const path = r.path.replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(extra[name] ?? PARAMS[name] ?? 'x'));
      for (const as of ['member', 'operator'] as const) {
        who = as;
        const { status, body } = await read(path, { method: r.method, body: c.body });
        checked.push(`${status} ${as} ${r.method} ${r.path}`);
        if (body.includes(MARK)) leaks.push(`${as} ${r.method} ${r.path} → ${excerpt(body)}`);
      }
    }
    if (process.env['TRACE_GUARD_LIST'] === '1') process.stderr.write(`${checked.join('\n')}\n`);
    // The two that address another user's trace by id answer as if it did not exist.
    who = 'operator';
    expect((await read(`/api/observability/harness/results/${TRACE_ID}/rejudge`, { method: 'POST' })).status).toBe(404);
    expect((await read(`/api/observability/invocations/${TRACE_ID}/replay`, { method: 'POST' })).status).toBe(404);
    // A result linked to the foreign trace does not carry its text back on read.
    for (const path of [`/api/observability/harness/runs/${GUARD_RUN_ID}`, `/api/observability/harness/runs/${GUARD_RUN_ID}/compare/${GUARD_RUN_ID}`]) {
      for (const as of ['member', 'operator'] as const) {
        who = as;
        const { body } = await read(path);
        if (body.includes(MARK)) leaks.push(`${as} GET ${path} → ${excerpt(body)}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it('a held-open stream carries none of the text published while it is open', async () => {
    expect(streams.length).toBeGreaterThan(3);
    const leaks: string[] = [];
    for (const as of ['member', 'operator'] as const) {
      who = as;
      const reads = streams.map((r) => read(fill(r.path), { windowMs: 1200 }).then((out) => ({ r, ...out })));
      // `who` is read when each request arrives; publish once every stream has connected.
      await new Promise((resolve) => setTimeout(resolve, 300));
      publishLive(as === 'member' ? 1 : 2);
      for (const { r, body } of await Promise.all(reads)) {
        if (body.includes(MARK)) leaks.push(`${as} GET ${r.path} → ${excerpt(body)}`);
      }
    }
    expect(leaks).toEqual([]);
    // Not vacuous: the cross-tenant admin's stream does carry the live text.
    who = 'admin';
    const pending = read('/api/observability/canary/events', { windowMs: 1200 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    publishLive(3);
    expect((await pending).body).toContain(`${MARK} live canary question`);
  }, 60_000);
});
