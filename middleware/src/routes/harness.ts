// Harness routes — backend for the OrgIQ regression-test harness.
//
// Mounted at /api/observability/harness BEFORE the gated /api/observability
// router so the runner (infra/scripts/harness.py) can hit these without a
// session cookie. Same pattern as approvals.
//
// Surface:
//   POST /trace                       — sync variant of trace-sink.enqueue
//   GET    /cases                     — list active test cases
//   GET    /cases/:id                 — fetch one
//   POST   /cases                     — upsert (id auto-slugged from prompt)
//   PATCH  /cases/:id                 — partial update
//   DELETE /cases/:id                 — soft delete (sets active=false)
//   POST   /runs                      — create a new run row
//   GET    /runs                      — recent runs
//   GET    /runs/:id                  — run + joined results
//   GET    /runs/:id/status           — live counters
//   POST   /runs/:runId/results       — upsert one result row
//   PATCH  /runs/:id                  — partial update of run counters
//   POST   /results/:invocationId/rejudge — re-run judge 3x on existing trace
//   GET    /coverage                  — per-agent test coverage
//
// All Aurora I/O uses the RDS Data API via providers/aurora.ts exec().
//
// OFFLINE. Every route above that a harness run touches now branches on
// `config.mock.aurora` into `mock/harness.ts` / `mock/prompt-versions.ts`. The
// three that did not — `POST /runs/:runId/results`, `PATCH /runs/:id` and
// `POST /promote` — called `exec` unconditionally and so 500'd in `dev:mock`
// with `UnrecognizedClientException`, which meant a run could be created
// offline, could never record a verdict, and reported every case unrecorded.
//
// Note why no check caught that: rule 4's write-half scan
// (`mock/core/wire/mock-branches.ts`) only names an unmocked leaf in
// `src/lib/**` or `src/providers/**`, and `exec` is excluded everywhere as
// transport — so a route handler calling `exec` directly, which is what all
// three did, is structurally invisible to it. THREE ROUTES WERE STILL LIKE THAT
// HERE and were on that scan's list for the libraries below them rather than
// for their own `exec` calls: `POST /trace` (lib/trace-sink.ts), `POST
// /runs/:id/execute` (lib/harness-runner.ts) and `POST
// /results/:invocationId/rejudge` (lib/judge.ts). Each wanted a mock branch in
// the library it calls — the transport, where every caller gets it — not a
// second pipeline behind a branch in this file, and each now has one.
//
// Two of the three needed a branch here as well, and the distinction matters:
// `/runs/:id/execute` and `/results/:invocationId/rejudge` each run their OWN
// `exec` before the library is ever reached, so the library branch alone left
// them 500ing offline on their first statement. Those two branches are lookups
// only — they read the run's status and the trace's text out of the fixtures —
// and every decision after them is the same code the Aurora path runs.
// `POST /trace` needed nothing here: it calls `processTrace` and nothing else.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { readPointers, AGENT_RE, type Pointer } from '../lib/prompt-pointers.js';
import { processTrace, type TraceInput } from '../lib/trace-sink.js';
import { judgeResponse } from '../lib/judge.js';
import { executeRun, loadCasesForRun } from '../lib/harness-runner.js';
import { requireAction, requireTenant } from '../lib/authz.js';
import {
  HARNESS_TRACE_SERVICE_AUTH, HARNESS_RUNNER_SERVICE_AUTH,
  requireServiceAuth, serviceAuthOr,
} from '../lib/service-auth.js';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import {
  mockListCases, mockGetCase, mockUpsertCase, mockPatchCase, mockDeleteCase,
  mockListRuns, mockGetRun, mockGetResults, mockCreateRun, mockCoverage,
  mockUpsertResult, mockPatchRun, type MockRunPatch,
} from '../mock/harness.js';
import { mockListPromotedVersions, mockPromotePromptVersion } from '../mock/prompt-versions.js';
import { sinkTraceById } from '../mock/trace-sink.js';

export const harnessRouter = Router();

// The trace callback (`POST /trace`) is agent-facing: deployed runtimes post
// their bundles here with no session (agents/_shared/instrumentation.py). It
// therefore cannot take the session floor the rest of this router does — but
// it must not be anonymously writable either, since the body carries userId
// and cost and would poison telemetry. Same shape as approvals' service auth:
// open when HARNESS_TRACE_SECRET is unset (dev), a constant-time header check
// when it is set. The stdout+CloudWatch path is unaffected by any of this.
//
// This used to be a private copy of the compare that lib/service-auth.ts
// already owns. Same behaviour, one implementation — see that module's "ONE
// COMPARE, ONE PLACE". Still applied PER ROUTE, never at the mount: a blanket
// guard over this router 401s the fleet's trace emission.
const requireTraceAuth = requireServiceAuth(HARNESS_TRACE_SERVICE_AUTH);

/**
 * The harness RUNNER's control plane — the routes `infra/scripts/harness.py`
 * calls that are not `/trace`.
 *
 * The runner had no credential for any of them. It worked in dev only because
 * `demoFallbackAllowed()` hands a cookie-less request the demo session — which
 * is off the moment Cognito is configured, so the runner "worked locally and
 * 401'd wholesale in the environment it was built for", and did so *midway
 * through a run*: the trace POST succeeded (it had its own secret) while the
 * result POST that records the verdict did not.
 *
 * `serviceAuthOr`, never `requireServiceAuth`: the portal reads and writes
 * every one of these routes with a real session, and that must keep working
 * unchanged. A valid `x-harness-runner-auth` passes; anything else — including
 * a request with no header at all, and every request while
 * HARNESS_RUNNER_SECRET is unset — runs the same Cedar gate it ran before.
 *
 * NOT applied to the case CRUD (`POST/PATCH/DELETE /cases`): the runner reads
 * cases straight from Aurora over the Data API and never edits them, so
 * authoring a test case stays a human decision.
 */
const runnerOr = (...human: RequestHandler[]): RequestHandler =>
  serviceAuthOr(HARNESS_RUNNER_SERVICE_AUTH, ...human);

/** The router-level tenant gate, or the runner's credential. Built once. */
const runnerOrTenant = serviceAuthOr(HARNESS_RUNNER_SERVICE_AUTH, requireTenant('orgiq'));

// Canary/harness telemetry is an orgiq surface. Tenant-scope every route so
// an assessment-tenant session can't read another tenant's eval runs, cases
// or results — EXCEPT the agent-facing `/trace` callback below, which is
// sessionless by design and so has no tenant to check (it self-gates via
// requireTraceAuth).
harnessRouter.use((req, res, next) => {
  if (req.path === '/trace') { next(); return; }
  // …and except the harness RUNNER, which has a machine identity rather than a
  // tenant (see `runnerOr` above). `serviceAuthOr` falls through to
  // requireTenant for everyone else, and with HARNESS_RUNNER_SECRET unset it
  // falls through always — so this line is a no-op until an operator mints the
  // secret.
  runnerOrTenant(req, res, next);
});


// ── Shared types ───────────────────────────────────────────────────────────

export interface TestCase {
  testId: string;
  agentId: string;
  templateId: string | null;
  prompt: string;
  referenceOutput: string | null;
  expectedTags: string[];
  rubricOverride: string | null;
  passThreshold: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

export interface TestRun {
  runId: string;
  label: string;
  gitSha: string | null;
  judgeModelId: string;
  agentVersions: Record<string, string>;
  status: 'pending' | 'running' | 'done' | 'failed';
  totalCases: number;
  completed: number;
  passed: number;
  failed: number;
  passRate: number | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  // M1 — 'live' invokes deployed AgentCore runtimes; 'sim' calls Bedrock
  // Nova-Pro directly with role-play prompts (the legacy path). Defaults to
  // 'sim' for backward compat with rows from before this column existed.
  mode: 'live' | 'sim';
}

export interface TestResult {
  runId: string;
  testId: string;
  invocationId: string | null;
  passed: boolean | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  tagHits: Record<string, boolean> | null;
  referenceSimilarity: number | null;
  responseSnippet: string | null;
  failReasons: string[] | null;
  durationMs: number | null;
  ts: string;
  // M2 — per-case cost + tokens, persisted alongside the result so the UI
  // can render without re-joining invocation_traces.
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
  // Joined fields, populated by GET /runs/:id:
  agentId?: string;
  prompt?: string;
}

// ── Parameter helpers (copy of approvals.ts conventions) ───────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function nullableStr(name: string, value: string | null | undefined): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}

function nullableNumber(name: string, value: number | null | undefined): SqlParameter {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { doubleValue: value } };
}

function nullableInt(name: string, value: number | null | undefined): SqlParameter {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { longValue: Math.round(value) } };
}

function nullableBool(name: string, value: boolean | null | undefined): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  return { name, value: { booleanValue: value } };
}

function boolParam(name: string, value: boolean): SqlParameter {
  return { name, value: { booleanValue: value } };
}

function jsonParam(name: string, value: unknown): SqlParameter {
  return { name, value: { stringValue: JSON.stringify(value ?? null) }, typeHint: 'JSON' };
}

// ── JSON parsing helpers (RDS Data API returns jsonb as text) ──────────────

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    if (!raw.trim()) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  if (typeof raw === 'object') return raw as T;
  return fallback;
}

// ── Row coercion ───────────────────────────────────────────────────────────

function rowToTestCase(r: Record<string, unknown>): TestCase {
  return {
    testId: String(r['test_id'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    templateId: r['template_id'] == null ? null : String(r['template_id']),
    prompt: String(r['prompt'] ?? ''),
    referenceOutput: r['reference_output'] == null ? null : String(r['reference_output']),
    expectedTags: parseJsonField<string[]>(r['expected_tags'], []),
    rubricOverride: r['rubric_override'] == null ? null : String(r['rubric_override']),
    passThreshold: r['pass_threshold'] == null ? 0.7 : Number(r['pass_threshold']),
    active: r['active'] == null ? true : Boolean(r['active']),
    createdAt: String(r['created_at'] ?? ''),
    updatedAt: String(r['updated_at'] ?? ''),
    notes: r['notes'] == null ? null : String(r['notes']),
  };
}

function rowToTestRun(r: Record<string, unknown>): TestRun {
  const status = String(r['status'] ?? 'pending') as TestRun['status'];
  const modeRaw = r['mode'] == null ? 'sim' : String(r['mode']);
  const mode: TestRun['mode'] = modeRaw === 'live' ? 'live' : 'sim';
  return {
    runId: String(r['run_id'] ?? ''),
    label: String(r['label'] ?? ''),
    gitSha: r['git_sha'] == null ? null : String(r['git_sha']),
    judgeModelId: String(r['judge_model_id'] ?? ''),
    agentVersions: parseJsonField<Record<string, string>>(r['agent_versions'], {}),
    status,
    totalCases: Number(r['total_cases'] ?? 0),
    completed: Number(r['completed'] ?? 0),
    passed: Number(r['passed'] ?? 0),
    failed: Number(r['failed'] ?? 0),
    passRate: r['pass_rate'] == null ? null : Number(r['pass_rate']),
    startedAt: String(r['started_at'] ?? ''),
    finishedAt: r['finished_at'] == null ? null : String(r['finished_at']),
    notes: r['notes'] == null ? null : String(r['notes']),
    mode,
  };
}

function rowToTestResult(r: Record<string, unknown>): TestResult {
  const out: TestResult = {
    runId: String(r['run_id'] ?? ''),
    testId: String(r['test_id'] ?? ''),
    invocationId: r['invocation_id'] == null ? null : String(r['invocation_id']),
    passed: r['passed'] == null ? null : Boolean(r['passed']),
    judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
    judgeRationale: r['judge_rationale'] == null ? null : String(r['judge_rationale']),
    schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
    tagHits: parseJsonField<Record<string, boolean> | null>(r['tag_hits'], null),
    referenceSimilarity: r['reference_similarity'] == null ? null : Number(r['reference_similarity']),
    responseSnippet: r['response_snippet'] == null ? null : String(r['response_snippet']),
    failReasons: parseJsonField<string[] | null>(r['fail_reasons'], null),
    durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
    ts: String(r['ts'] ?? ''),
    inputTokens: r['input_tokens'] == null ? null : Number(r['input_tokens']),
    outputTokens: r['output_tokens'] == null ? null : Number(r['output_tokens']),
    estCostUsd: r['est_cost_usd'] == null ? null : Number(r['est_cost_usd']),
  };
  if (r['agent_id'] != null) out.agentId = String(r['agent_id']);
  if (r['prompt'] != null) out.prompt = String(r['prompt']);
  return out;
}

// ── Slug helper for test_id auto-generation ────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function autoTestId(agentId: string, prompt: string): string {
  const base = `${slugify(agentId)}-${slugify(prompt) || 'case'}`.slice(0, 80);
  // Append a short random suffix to keep duplicates from colliding.
  return `${base}-${randomUUID().slice(0, 6)}`;
}

// ── POST /trace — synchronous trace pipeline ───────────────────────────────
// Wraps lib/trace-sink.processTrace. Behaviour deltas vs enqueue():
//   - awaits embed/judge/INSERT
//   - returns judge score + rationale to caller
//   - template_id starting with 'test:' is always sampled (forced inside
//     processTrace) so harness runs never silently drop on a sampling miss
//   - non-Aurora failures degrade to nulls; Aurora INSERT failure → 500

harnessRouter.post('/trace', requireTraceAuth, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Partial<TraceInput>;
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const response = typeof body.response === 'string' ? body.response : '';
  if (!agentId) throw new ValidationError('agentId is required');
  if (!prompt) throw new ValidationError('prompt is required');
  if (typeof body.response !== 'string') {
    throw new ValidationError('response is required');
  }

  const input: TraceInput = {
    agentId,
    prompt,
    response,
  };
  if (typeof body.invocationId === 'string') input.invocationId = body.invocationId;
  if (typeof body.agentName === 'string') input.agentName = body.agentName;
  if (typeof body.templateId === 'string') input.templateId = body.templateId;
  if (typeof body.durationMs === 'number') input.durationMs = body.durationMs;
  if (typeof body.guardrailAction === 'string') input.guardrailAction = body.guardrailAction;
  if (typeof body.piiDetected === 'boolean') input.piiDetected = body.piiDetected;
  // M2 — token + cost passthrough.
  if (typeof body.inputTokens === 'number' && Number.isFinite(body.inputTokens)) {
    input.inputTokens = body.inputTokens;
  }
  if (typeof body.outputTokens === 'number' && Number.isFinite(body.outputTokens)) {
    input.outputTokens = body.outputTokens;
  }
  // M6 — provenance passthrough.
  if (typeof body.promptVersion === 'string' && body.promptVersion.trim()) {
    input.promptVersion = body.promptVersion.trim();
  }
  if (typeof body.modelId === 'string' && body.modelId.trim()) {
    input.modelId = body.modelId.trim();
  }
  if (typeof body.runtimeImageDigest === 'string' && body.runtimeImageDigest.trim()) {
    input.runtimeImageDigest = body.runtimeImageDigest.trim();
  }
  // Sprint 2 (M3/M4) — trace stitching + per-tool calls passthrough. We
  // accept these on /trace so the harness runner (sim mode) can emit
  // multi-agent bundles even before the live-mode AgentCore path exists.
  if (typeof body.parentInvocationId === 'string'
      && /^[0-9a-f-]{36}$/i.test(body.parentInvocationId)) {
    input.parentInvocationId = body.parentInvocationId;
  }
  if (typeof body.userId === 'string' && body.userId.trim()) {
    input.userId = body.userId.trim();
  }
  if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
    input.sessionId = body.sessionId.trim();
  }
  if (Array.isArray(body.toolCalls)) {
    input.toolCalls = body.toolCalls;
  }
  // Pipelines P1 — the AG-UI run this bundle closes. Presence is checked
  // here; shape (bounds, statuses) is lib/pipeline-runs normalizeAgentSteps'.
  if (typeof body.runId === 'string' && body.runId.trim()) input.runId = body.runId.trim();
  if (typeof body.threadId === 'string' && body.threadId.trim()) input.threadId = body.threadId.trim();
  if (typeof body.tenant === 'string' && body.tenant.trim()) input.tenant = body.tenant.trim();
  if (Array.isArray(body.steps)) input.steps = body.steps;
  // `memoryEvents` and `guardrailInterventions` are the other two substance
  // axes `processTrace` persists, and they were the only ones with no way in
  // through this route — so an agent could report the tool calls it made but
  // not the memory it read or the guardrail that fired, and the memory half of
  // the observability surface was reachable only by calling processTrace
  // directly. They are passed through on the same terms as toolCalls: shape is
  // the sink's problem, presence is ours.
  if (Array.isArray(body.memoryEvents)) {
    input.memoryEvents = body.memoryEvents as TraceInput['memoryEvents'];
  }
  if (Array.isArray(body.guardrailInterventions)) {
    input.guardrailInterventions = body.guardrailInterventions as TraceInput['guardrailInterventions'];
  }

  // 30s ceiling — embedding + judge + INSERT must complete inside this window.
  const TIMEOUT_MS = 30_000;
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('processTrace timeout')), TIMEOUT_MS),
  );

  try {
    const result = await Promise.race([processTrace(input), timer]);
    res.json({
      invocationId: result.invocationId,
      judgeScore: result.judgeScore,
      judgeRationale: result.judgeRationale,
      schemaValid: result.schemaValid,
      embeddingComputed: result.embeddingComputed,
      // M2 — token + cost echo so the runner can populate test_results.
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      judgeInputTokens: result.judgeInputTokens,
      judgeOutputTokens: result.judgeOutputTokens,
      estCostUsd: result.estCostUsd,
      judgeCostUsd: result.judgeCostUsd,
      totalCostUsd: result.totalCostUsd,
    });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    if (msg === 'processTrace timeout') {
      // Surface as 504 so the runner can retry; same as Aurora outage class.
      res.status(504).json({ error: 'processTrace timeout', timeoutMs: TIMEOUT_MS });
      return;
    }
    // Aurora INSERT failure path — bubble as 500 per contract. Other failures
    // (embed/judge) are already absorbed inside processTrace and never throw.
    console.warn('[harness] /trace failed:', msg);
    res.status(500).json({ error: 'trace pipeline failed', detail: msg });
  }
}));

// ── GET /cases ─────────────────────────────────────────────────────────────

harnessRouter.get('/cases', requireAction('ViewObservability'), asyncHandler(async (req, res) => {
  const includeInactive = req.query['includeInactive'] === '1'
    || req.query['includeInactive'] === 'true';
  // Same silent-clamp convention /runs uses just below: a suite of a few
  // hundred cases is normal, an unbounded `SELECT * FROM test_cases` with no
  // LIMIT at all is not.
  const rawLimit = parseInt((req.query['limit'] as string) ?? '200', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 1000)
    : 200;
  if (config.mock.aurora) { res.json({ cases: mockListCases(includeInactive).slice(0, limit) }); return; }
  const sql = `
    SELECT test_id, agent_id, template_id, prompt, reference_output,
           expected_tags::text AS expected_tags,
           rubric_override, pass_threshold, active,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           notes
      FROM observability.test_cases
     ${includeInactive ? '' : 'WHERE active = true'}
     ORDER BY agent_id ASC, test_id ASC
     LIMIT :lim`;
  const rows = await exec(sql, [{ name: 'lim', value: { longValue: limit } }]);
  res.json({ cases: rows.map(rowToTestCase) });
}));

// ── GET /cases/:id ─────────────────────────────────────────────────────────

harnessRouter.get('/cases/:id', requireAction('ViewObservability'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (config.mock.aurora) {
    const found = mockGetCase(id);
    if (!found) { res.status(404).json({ error: 'test case not found' }); return; }
    res.json({ case: found });
    return;
  }
  const rows = await exec(
    `SELECT test_id, agent_id, template_id, prompt, reference_output,
            expected_tags::text AS expected_tags,
            rubric_override, pass_threshold, active,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            notes
       FROM observability.test_cases
      WHERE test_id = :id`,
    [strParam('id', id)],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'test case not found' });
    return;
  }
  res.json({ case: rowToTestCase(rows[0]!) });
}));

// ── POST /cases — insert-or-update ─────────────────────────────────────────

interface UpsertCaseBody {
  testId?: string;
  agentId?: string;
  templateId?: string | null;
  prompt?: string;
  referenceOutput?: string | null;
  expectedTags?: unknown;
  rubricOverride?: string | null;
  passThreshold?: number;
  active?: boolean;
  notes?: string | null;
}

harnessRouter.post('/cases', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as UpsertCaseBody;
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!agentId) throw new ValidationError('agentId is required');
  if (!prompt) throw new ValidationError('prompt is required');

  const testId = (typeof body.testId === 'string' && body.testId.trim())
    ? body.testId.trim()
    : autoTestId(agentId, prompt);

  const expectedTags = Array.isArray(body.expectedTags)
    ? (body.expectedTags as unknown[]).filter((t) => typeof t === 'string')
    : [];
  const passThreshold = (typeof body.passThreshold === 'number' && Number.isFinite(body.passThreshold))
    ? Math.max(0, Math.min(1, body.passThreshold))
    : 0.7;
  const active = typeof body.active === 'boolean' ? body.active : true;

  if (config.mock.aurora) {
    mockUpsertCase({
      testId,
      agentId,
      templateId: body.templateId ?? null,
      prompt,
      referenceOutput: body.referenceOutput ?? null,
      expectedTags,
      rubricOverride: body.rubricOverride ?? null,
      passThreshold,
      active,
      notes: body.notes ?? null,
    });
    res.status(201).json({ testId });
    return;
  }

  await exec(
    `INSERT INTO observability.test_cases
       (test_id, agent_id, template_id, prompt, reference_output,
        expected_tags, rubric_override, pass_threshold, active, notes,
        created_at, updated_at)
     VALUES
       (:test_id, :agent_id, :template_id, :prompt, :reference_output,
        CAST(:expected_tags AS jsonb), :rubric_override, :pass_threshold,
        :active, :notes, now(), now())
     ON CONFLICT (test_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        template_id = EXCLUDED.template_id,
        prompt = EXCLUDED.prompt,
        reference_output = EXCLUDED.reference_output,
        expected_tags = EXCLUDED.expected_tags,
        rubric_override = EXCLUDED.rubric_override,
        pass_threshold = EXCLUDED.pass_threshold,
        active = EXCLUDED.active,
        notes = EXCLUDED.notes,
        updated_at = now()`,
    [
      strParam('test_id', testId),
      strParam('agent_id', agentId),
      nullableStr('template_id', body.templateId ?? null),
      strParam('prompt', prompt),
      nullableStr('reference_output', body.referenceOutput ?? null),
      jsonParam('expected_tags', expectedTags),
      nullableStr('rubric_override', body.rubricOverride ?? null),
      nullableNumber('pass_threshold', passThreshold),
      boolParam('active', active),
      nullableStr('notes', body.notes ?? null),
    ],
  );

  res.status(201).json({ testId });
}));

// ── PATCH /cases/:id — partial update ──────────────────────────────────────

harnessRouter.patch('/cases/:id', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const body = (req.body ?? {}) as UpsertCaseBody;

  if (config.mock.aurora) {
    const patch: Partial<import('../mock/harness.js').MockTestCase> = {};
    if (typeof body.agentId === 'string') patch.agentId = body.agentId;
    if ('templateId' in body) patch.templateId = body.templateId ?? null;
    if (typeof body.prompt === 'string') patch.prompt = body.prompt;
    if ('referenceOutput' in body) patch.referenceOutput = body.referenceOutput ?? null;
    if (Array.isArray(body.expectedTags)) {
      patch.expectedTags = (body.expectedTags as unknown[]).filter((t): t is string => typeof t === 'string');
    }
    if ('rubricOverride' in body) patch.rubricOverride = body.rubricOverride ?? null;
    if (typeof body.passThreshold === 'number' && Number.isFinite(body.passThreshold)) {
      patch.passThreshold = Math.max(0, Math.min(1, body.passThreshold));
    }
    if (typeof body.active === 'boolean') patch.active = body.active;
    if ('notes' in body) patch.notes = body.notes ?? null;
    const ok = mockPatchCase(id, patch);
    if (!ok) throw new NotFoundError('test case not found');
    res.json({ ok: true });
    return;
  }

  const sets: string[] = [];
  const params: SqlParameter[] = [strParam('id', id)];

  if (typeof body.agentId === 'string') {
    sets.push('agent_id = :agent_id'); params.push(strParam('agent_id', body.agentId));
  }
  if ('templateId' in body) {
    sets.push('template_id = :template_id');
    params.push(nullableStr('template_id', body.templateId ?? null));
  }
  if (typeof body.prompt === 'string') {
    sets.push('prompt = :prompt'); params.push(strParam('prompt', body.prompt));
  }
  if ('referenceOutput' in body) {
    sets.push('reference_output = :reference_output');
    params.push(nullableStr('reference_output', body.referenceOutput ?? null));
  }
  if (Array.isArray(body.expectedTags)) {
    const tags = (body.expectedTags as unknown[]).filter((t) => typeof t === 'string');
    sets.push('expected_tags = CAST(:expected_tags AS jsonb)');
    params.push(jsonParam('expected_tags', tags));
  }
  if ('rubricOverride' in body) {
    sets.push('rubric_override = :rubric_override');
    params.push(nullableStr('rubric_override', body.rubricOverride ?? null));
  }
  if (typeof body.passThreshold === 'number' && Number.isFinite(body.passThreshold)) {
    sets.push('pass_threshold = :pass_threshold');
    params.push(nullableNumber('pass_threshold', Math.max(0, Math.min(1, body.passThreshold))));
  }
  if (typeof body.active === 'boolean') {
    sets.push('active = :active'); params.push(boolParam('active', body.active));
  }
  if ('notes' in body) {
    sets.push('notes = :notes');
    params.push(nullableStr('notes', body.notes ?? null));
  }

  if (sets.length === 0) {
    res.json({ ok: true, changed: 0 });
    return;
  }
  sets.push('updated_at = now()');

  const rows = await exec(
    `UPDATE observability.test_cases
        SET ${sets.join(', ')}
      WHERE test_id = :id
      RETURNING test_id`,
    params,
  );
  if (rows.length === 0) throw new NotFoundError('test case not found');
  res.json({ ok: true });
}));

// ── DELETE /cases/:id — soft delete ────────────────────────────────────────

harnessRouter.delete('/cases/:id', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (config.mock.aurora) {
    if (!mockDeleteCase(id)) throw new NotFoundError('test case not found');
    res.json({ ok: true });
    return;
  }
  const rows = await exec(
    `UPDATE observability.test_cases
        SET active = false, updated_at = now()
      WHERE test_id = :id
      RETURNING test_id`,
    [strParam('id', id)],
  );
  if (rows.length === 0) throw new NotFoundError('test case not found');
  res.json({ ok: true });
}));

// ── POST /runs — create a new run row ──────────────────────────────────────

interface CreateRunBody {
  label?: string;
  gitSha?: string | null;
  judgeModelId?: string;
  agentVersions?: Record<string, string>;
  notes?: string | null;
  totalCases?: number;
  mode?: 'live' | 'sim';
}

harnessRouter.post('/runs', runnerOr(requireAction('ManageCanary')), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as CreateRunBody;
  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim()
    : `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const judgeModelId = typeof body.judgeModelId === 'string' && body.judgeModelId.trim()
    ? body.judgeModelId.trim()
    : 'amazon.nova-pro-v1:0';
  const agentVersions = (body.agentVersions && typeof body.agentVersions === 'object' && !Array.isArray(body.agentVersions))
    ? body.agentVersions as Record<string, string>
    : {};
  const totalCases = (typeof body.totalCases === 'number' && Number.isFinite(body.totalCases))
    ? Math.max(0, Math.floor(body.totalCases))
    : 0;
  // M1 — mode defaults to 'sim' so older callers that don't know about
  // live mode still produce well-formed rows. Any value other than the
  // exact string 'live' collapses to 'sim'.
  const mode: 'live' | 'sim' = body.mode === 'live' ? 'live' : 'sim';

  if (config.mock.aurora) {
    const created = mockCreateRun({ label, gitSha: body.gitSha ?? null, judgeModelId, agentVersions, notes: body.notes ?? null, totalCases, mode });
    res.status(201).json(created);
    return;
  }

  const runId = randomUUID();
  await exec(
    `INSERT INTO observability.test_runs
       (run_id, label, git_sha, judge_model_id, agent_versions,
        status, total_cases, completed, passed, failed, started_at, notes, mode)
     VALUES
       (CAST(:run_id AS uuid), :label, :git_sha, :judge_model_id,
        CAST(:agent_versions AS jsonb),
        'pending', :total_cases, 0, 0, 0, now(), :notes, :mode)`,
    [
      strParam('run_id', runId),
      strParam('label', label),
      nullableStr('git_sha', body.gitSha ?? null),
      strParam('judge_model_id', judgeModelId),
      jsonParam('agent_versions', agentVersions),
      nullableInt('total_cases', totalCases),
      nullableStr('notes', body.notes ?? null),
      strParam('mode', mode),
    ],
  );

  res.status(201).json({ runId, mode });
}));

// ── POST /runs/:id/execute — actually run the suite ────────────────────────
//
// The gap this closes: creating a run only ever inserted a 'pending' row, and
// nothing in the repo posted results, so a run could never progress. This
// invokes each active case against its real agent, judges the answer, and
// records results. It returns immediately and the work continues in the
// background — a forty-case suite outlives any sensible request timeout — so
// the client polls /runs/:id/status, which already existed and finally has
// something to report.

harnessRouter.post('/runs/:id/execute', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const runId = String(req.params['id'] ?? '');
  // FORCED ROUTE BRANCH — this handler's OWN `exec`, not the library's.
  // `lib/harness-runner.ts` now has a mock branch at every layer, but this
  // lookup runs before any of it, so offline the route still 500'd on the very
  // first statement and the runner below was unreachable. That is the same
  // structural blind spot this file's header describes: rule 4's write scan
  // excludes `exec` as transport everywhere, so a handler calling it directly
  // is invisible to the ratchet — the identical fix landed here for
  // `POST /runs/:runId/results`, `PATCH /runs/:id` and `POST /promote`.
  const rows = config.mock.aurora
    ? (() => { const r = mockGetRun(runId); return r ? [{ status: r.status, judge_model_id: r.judgeModelId }] : []; })()
    : await exec(
      `SELECT status, judge_model_id FROM observability.test_runs
        WHERE run_id = CAST(:id AS uuid)`,
      [strParam('id', runId)],
    );
  if (rows.length === 0) { res.status(404).json({ error: 'run not found' }); return; }
  const status = String(rows[0]?.['status'] ?? 'pending');
  if (status === 'running') { res.status(409).json({ error: 'run is already executing' }); return; }

  const body = (req.body ?? {}) as { agentId?: string };
  const judgeModelId = String(rows[0]?.['judge_model_id'] ?? 'amazon.nova-pro-v1:0');

  const cases = await loadCasesForRun(body.agentId);
  if (cases.length === 0) {
    res.status(400).json({
      error: body.agentId
        ? `no active test cases for agent '${body.agentId}'`
        : 'no active test cases — add one before running the suite',
    });
    return;
  }

  void executeRun(runId, { ...(body.agentId ? { agentId: body.agentId } : {}), judgeModelId })
    .catch((err: unknown) => console.warn('[harness] run failed:', (err as Error).message));

  res.status(202).json({ runId, started: true, totalCases: cases.length });
}));

// ── GET /runs — recent runs ────────────────────────────────────────────────

harnessRouter.get('/runs', runnerOr(requireAction('ViewObservability')), asyncHandler(async (req, res) => {
  const rawLimit = parseInt((req.query['limit'] as string) ?? '14', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 100)
    : 14;
  if (config.mock.aurora) { res.json({ runs: mockListRuns(limit) }); return; }
  const rows = await exec(
    `SELECT run_id::text AS run_id, label, git_sha, judge_model_id,
            agent_versions::text AS agent_versions,
            status, total_cases, completed, passed, failed, pass_rate,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            notes, mode
       FROM observability.test_runs
      ORDER BY started_at DESC
      LIMIT :lim`,
    [{ name: 'lim', value: { longValue: limit } }],
  );
  res.json({ runs: rows.map(rowToTestRun) });
}));

// ── GET /runs/:id — run + joined results ───────────────────────────────────

harnessRouter.get('/runs/:id', runnerOr(requireAction('ViewObservability')), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (config.mock.aurora) {
    const run = mockGetRun(id);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({ run, results: mockGetResults(id) });
    return;
  }
  const runRows = await exec(
    `SELECT run_id::text AS run_id, label, git_sha, judge_model_id,
            agent_versions::text AS agent_versions,
            status, total_cases, completed, passed, failed, pass_rate,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            notes, mode
       FROM observability.test_runs
      WHERE run_id = CAST(:id AS uuid)`,
    [strParam('id', id)],
  );
  if (runRows.length === 0) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  const resultRows = await exec(
    `SELECT r.run_id::text AS run_id, r.test_id,
            r.invocation_id::text AS invocation_id,
            r.passed, r.judge_score, r.judge_rationale,
            r.schema_valid,
            r.tag_hits::text AS tag_hits,
            r.reference_similarity, r.response_snippet,
            r.fail_reasons::text AS fail_reasons,
            r.duration_ms,
            r.ts::text AS ts,
            r.input_tokens, r.output_tokens, r.est_cost_usd,
            c.agent_id AS agent_id,
            c.prompt AS prompt,
            t.response_snippet AS trace_response_snippet
       FROM observability.test_results r
       LEFT JOIN observability.test_cases c ON c.test_id = r.test_id
       LEFT JOIN observability.invocation_traces t
         ON t.invocation_id = r.invocation_id
      WHERE r.run_id = CAST(:id AS uuid)
      ORDER BY r.ts ASC, r.test_id ASC`,
    [strParam('id', id)],
  );
  const results: TestResult[] = resultRows.map((r) => {
    const out = rowToTestResult(r);
    // Prefer the result's own response_snippet; fall back to the trace's.
    if (!out.responseSnippet && r['trace_response_snippet']) {
      out.responseSnippet = String(r['trace_response_snippet']);
    }
    return out;
  });
  res.json({ run: rowToTestRun(runRows[0]!), results });
}));

// ── GET /runs/:id/status — live counters ───────────────────────────────────

harnessRouter.get('/runs/:id/status', requireAction('ViewObservability'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (config.mock.aurora) {
    const run = mockGetRun(id);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({
      status: run.status, total: run.totalCases, completed: run.completed,
      passed: run.passed, failed: run.failed,
      passRate: run.passRate ?? (run.completed > 0 ? run.passed / run.completed : null),
    });
    return;
  }
  const rows = await exec(
    `SELECT status, total_cases, completed, passed, failed, pass_rate
       FROM observability.test_runs
      WHERE run_id = CAST(:id AS uuid)`,
    [strParam('id', id)],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  const r = rows[0]!;
  const total = Number(r['total_cases'] ?? 0);
  const completed = Number(r['completed'] ?? 0);
  const passed = Number(r['passed'] ?? 0);
  const failed = Number(r['failed'] ?? 0);
  const passRateRaw = r['pass_rate'];
  const passRate = passRateRaw == null
    ? (completed > 0 ? passed / completed : null)
    : Number(passRateRaw);
  res.json({
    status: String(r['status'] ?? 'pending'),
    total,
    completed,
    passed,
    failed,
    passRate,
  });
}));

// ── POST /runs/:runId/results — upsert one result ──────────────────────────

interface UpsertResultBody {
  testId?: string;
  invocationId?: string | null;
  passed?: boolean | null;
  judgeScore?: number | null;
  judgeRationale?: string | null;
  schemaValid?: boolean | null;
  tagHits?: Record<string, boolean> | null;
  referenceSimilarity?: number | null;
  responseSnippet?: string | null;
  failReasons?: string[] | null;
  durationMs?: number | null;
  // M2 — per-case tokens + cost.
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
}

harnessRouter.post('/runs/:runId/results', runnerOr(requireAction('ManageCanary')), asyncHandler(async (req, res) => {
  const runId = String(req.params['runId'] ?? '');
  const body = (req.body ?? {}) as UpsertResultBody;
  const testId = typeof body.testId === 'string' ? body.testId : '';
  if (!testId) throw new ValidationError('testId is required');

  const invocationId = (typeof body.invocationId === 'string' && /^[0-9a-f-]{36}$/i.test(body.invocationId))
    ? body.invocationId
    : null;

  // The runner's verdict for one case. Without this branch a `dev:mock` run
  // reached the Data API and every result came back unrecorded — and since the
  // runner started checking, loudly so.
  if (config.mock.aurora) {
    mockUpsertResult(runId, {
      testId,
      invocationId,
      passed: body.passed ?? null,
      judgeScore: body.judgeScore ?? null,
      judgeRationale: body.judgeRationale ?? null,
      schemaValid: body.schemaValid ?? null,
      tagHits: body.tagHits ?? null,
      referenceSimilarity: body.referenceSimilarity ?? null,
      responseSnippet: body.responseSnippet ?? null,
      failReasons: body.failReasons ?? null,
      durationMs: body.durationMs ?? null,
      inputTokens: body.inputTokens ?? null,
      outputTokens: body.outputTokens ?? null,
      estCostUsd: body.estCostUsd ?? null,
    });
    res.json({ ok: true });
    return;
  }

  await exec(
    `INSERT INTO observability.test_results
       (run_id, test_id, invocation_id, passed, judge_score, judge_rationale,
        schema_valid, tag_hits, reference_similarity, response_snippet,
        fail_reasons, duration_ms,
        input_tokens, output_tokens, est_cost_usd,
        ts)
     VALUES
       (CAST(:run_id AS uuid), :test_id,
        ${invocationId ? 'CAST(:invocation_id AS uuid)' : 'NULL'},
        :passed, :judge_score, :judge_rationale,
        :schema_valid,
        CAST(:tag_hits AS jsonb),
        :reference_similarity, :response_snippet,
        CAST(:fail_reasons AS jsonb),
        :duration_ms,
        :input_tokens, :output_tokens, :est_cost_usd,
        now())
     ON CONFLICT (run_id, test_id) DO UPDATE SET
        invocation_id = EXCLUDED.invocation_id,
        passed = EXCLUDED.passed,
        judge_score = EXCLUDED.judge_score,
        judge_rationale = EXCLUDED.judge_rationale,
        schema_valid = EXCLUDED.schema_valid,
        tag_hits = EXCLUDED.tag_hits,
        reference_similarity = EXCLUDED.reference_similarity,
        response_snippet = EXCLUDED.response_snippet,
        fail_reasons = EXCLUDED.fail_reasons,
        duration_ms = EXCLUDED.duration_ms,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        est_cost_usd = EXCLUDED.est_cost_usd,
        ts = now()`,
    [
      strParam('run_id', runId),
      strParam('test_id', testId),
      ...(invocationId ? [strParam('invocation_id', invocationId)] : []),
      nullableBool('passed', body.passed ?? null),
      nullableNumber('judge_score', body.judgeScore ?? null),
      nullableStr('judge_rationale', body.judgeRationale ?? null),
      nullableBool('schema_valid', body.schemaValid ?? null),
      jsonParam('tag_hits', body.tagHits ?? null),
      nullableNumber('reference_similarity', body.referenceSimilarity ?? null),
      nullableStr('response_snippet', body.responseSnippet ?? null),
      jsonParam('fail_reasons', body.failReasons ?? null),
      nullableInt('duration_ms', body.durationMs ?? null),
      nullableInt('input_tokens', body.inputTokens ?? null),
      nullableInt('output_tokens', body.outputTokens ?? null),
      nullableNumber('est_cost_usd', body.estCostUsd ?? null),
    ],
  );
  res.json({ ok: true });
}));

// ── PATCH /runs/:id — partial counter / status update ──────────────────────

interface PatchRunBody {
  status?: TestRun['status'];
  completed?: number;
  passed?: number;
  failed?: number;
  finishedAt?: string | null;
  passRate?: number | null;
  totalCases?: number;
  notes?: string | null;
  agentVersions?: Record<string, string>;
}

harnessRouter.patch('/runs/:id', runnerOr(requireAction('ManageCanary')), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const body = (req.body ?? {}) as PatchRunBody;
  const sets: string[] = [];
  const params: SqlParameter[] = [strParam('id', id)];

  if (typeof body.status === 'string') {
    sets.push('status = :status'); params.push(strParam('status', body.status));
  }
  if (typeof body.completed === 'number' && Number.isFinite(body.completed)) {
    sets.push('completed = :completed'); params.push(nullableInt('completed', body.completed));
  }
  if (typeof body.passed === 'number' && Number.isFinite(body.passed)) {
    sets.push('passed = :passed'); params.push(nullableInt('passed', body.passed));
  }
  if (typeof body.failed === 'number' && Number.isFinite(body.failed)) {
    sets.push('failed = :failed'); params.push(nullableInt('failed', body.failed));
  }
  if (typeof body.totalCases === 'number' && Number.isFinite(body.totalCases)) {
    sets.push('total_cases = :total_cases'); params.push(nullableInt('total_cases', body.totalCases));
  }
  if ('finishedAt' in body) {
    // 'auto' / true => now(); explicit ISO string => bind as timestamptz; null => null
    if (body.finishedAt === null) {
      sets.push('finished_at = NULL');
    } else if (typeof body.finishedAt === 'string') {
      sets.push('finished_at = :finished_at::timestamptz');
      params.push(strParam('finished_at', body.finishedAt));
    } else {
      sets.push('finished_at = now()');
    }
  }
  if ('passRate' in body) {
    sets.push('pass_rate = :pass_rate');
    params.push(nullableNumber('pass_rate', body.passRate ?? null));
  }
  if ('notes' in body) {
    sets.push('notes = :notes');
    params.push(nullableStr('notes', body.notes ?? null));
  }
  if (body.agentVersions && typeof body.agentVersions === 'object' && !Array.isArray(body.agentVersions)) {
    sets.push('agent_versions = CAST(:agent_versions AS jsonb)');
    params.push(jsonParam('agent_versions', body.agentVersions));
  }

  if (sets.length === 0) {
    res.json({ ok: true, changed: 0 });
    return;
  }

  // Placed AFTER the `sets` build so both paths share one definition of "the
  // body carried something we recognise" — a second list of field names here
  // would drift from the SQL one the first time a column was added.
  //
  // Only the four storable fields are handed on. The five counters the body may
  // also carry are selectors over the result rows offline (see
  // `mock/harness.ts` `MockRunPatch`), and the runner posts those rows before
  // it patches, so the numbers a reader gets back are the ones the caller meant
  // — counted rather than asserted.
  if (config.mock.aurora) {
    const patch: MockRunPatch = {};
    if (typeof body.status === 'string') patch.status = body.status;
    if ('finishedAt' in body) {
      patch.finishedAt = body.finishedAt === null ? null
        : typeof body.finishedAt === 'string' ? body.finishedAt
        : 'now';
    }
    if ('notes' in body) patch.notes = body.notes ?? null;
    if (body.agentVersions && typeof body.agentVersions === 'object' && !Array.isArray(body.agentVersions)) {
      patch.agentVersions = body.agentVersions;
    }
    if (!mockPatchRun(id, patch)) throw new NotFoundError('run not found');
    res.json({ ok: true });
    return;
  }

  const rows = await exec(
    `UPDATE observability.test_runs
        SET ${sets.join(', ')}
      WHERE run_id = CAST(:id AS uuid)
      RETURNING run_id`,
    params,
  );
  if (rows.length === 0) throw new NotFoundError('run not found');
  res.json({ ok: true });
}));

// ── POST /results/:invocationId/rejudge — re-run judge 3x ──────────────────

harnessRouter.post('/results/:invocationId/rejudge', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const invocationId = String(req.params['invocationId'] ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(invocationId)) {
    throw new ValidationError('invocationId must be a UUID');
  }
  // FORCED ROUTE BRANCH — same reason as `/runs/:id/execute` above: the
  // handler's own `exec` runs before `lib/judge.ts`'s mock branch can, so
  // offline the route 500'd before it could re-judge anything.
  //
  // Offline the table is `mock/trace-sink.ts`'s `trace-sink-traces` fixture —
  // what `processTrace` actually wrote this run — and NOT the seeded day of
  // traffic in `mock/observability.ts`, whose ids (`mock-inv-0`) are not uuids
  // and are rejected by the guard above. So the offline sequence is the real
  // one: post a trace, take the uuid it returns, re-judge that.
  const rows = config.mock.aurora
    ? (() => {
      const t = sinkTraceById(invocationId);
      return t ? [{ prompt_snippet: t.prompt_snippet, response_snippet: t.response_snippet }] : [];
    })()
    : await exec(
      `SELECT prompt_snippet, response_snippet
         FROM observability.invocation_traces
        WHERE invocation_id = CAST(:id AS uuid)`,
      [strParam('id', invocationId)],
    );
  if (rows.length === 0) throw new NotFoundError('trace not found');
  const trace = rows[0]!;
  const prompt = String(trace['prompt_snippet'] ?? '');
  const response = String(trace['response_snippet'] ?? '');

  // Three independent invocations. Nova at temperature=0 should produce a
  // tight distribution; the harness UI displays the spread as a stability
  // signal.
  const judgements = await Promise.all([
    judgeResponse(prompt, response).catch(() => null),
    judgeResponse(prompt, response).catch(() => null),
    judgeResponse(prompt, response).catch(() => null),
  ]);
  const scores = judgements.map((j) => j ? j.score : NaN);
  const rationales = judgements.map((j) => j ? j.rationale : '');
  res.json({ scores, rationales });
}));

// ── GET /coverage — per-agent test coverage rollup ─────────────────────────

interface CoverageRow {
  agentId: string;
  count: number;
  lastRunPassed?: number;
  lastRunTotal?: number;
  lastRunAt?: string;
}

harnessRouter.get('/coverage', requireAction('ViewObservability'), asyncHandler(async (_req, res) => {
  if (config.mock.aurora) { res.json({ byAgent: mockCoverage() }); return; }
  // Count active cases per agent + join the most-recent run's pass numbers.
  // We compute the latest run per agent by looking at when its results last
  // landed in test_results. This is approximate (a run touches multiple
  // agents) but matches what researchers want: "did the last time we tested
  // this agent pass".
  const rows = await exec(
    `WITH counts AS (
       SELECT agent_id, COUNT(*)::bigint AS cnt
         FROM observability.test_cases
        WHERE active = true
        GROUP BY agent_id
     ),
     latest AS (
       SELECT c.agent_id,
              MAX(r.ts) AS last_ts
         FROM observability.test_results r
         JOIN observability.test_cases c ON c.test_id = r.test_id
        GROUP BY c.agent_id
     ),
     last_run AS (
       SELECT c.agent_id,
              r.run_id,
              SUM(CASE WHEN r.passed THEN 1 ELSE 0 END)::bigint AS passed,
              COUNT(*)::bigint AS total,
              MAX(r.ts) AS ts
         FROM observability.test_results r
         JOIN observability.test_cases c ON c.test_id = r.test_id
         JOIN latest l ON l.agent_id = c.agent_id
        WHERE r.run_id = (
          SELECT r2.run_id
            FROM observability.test_results r2
            JOIN observability.test_cases c2 ON c2.test_id = r2.test_id
           WHERE c2.agent_id = c.agent_id
           ORDER BY r2.ts DESC
           LIMIT 1
        )
        GROUP BY c.agent_id, r.run_id
     )
     SELECT counts.agent_id,
            counts.cnt,
            last_run.passed,
            last_run.total,
            last_run.ts::text AS last_ts
       FROM counts
       LEFT JOIN last_run ON last_run.agent_id = counts.agent_id
      ORDER BY counts.agent_id ASC`,
    [],
  );

  const byAgent: CoverageRow[] = rows.map((r) => {
    const row: CoverageRow = {
      agentId: String(r['agent_id'] ?? ''),
      count: Number(r['cnt'] ?? 0),
    };
    if (r['passed'] != null) row.lastRunPassed = Number(r['passed']);
    if (r['total'] != null) row.lastRunTotal = Number(r['total']);
    if (r['last_ts'] != null) row.lastRunAt = String(r['last_ts']);
    return row;
  });
  res.json({ byAgent });
}));

// ── Sprint 3 (M8) — run-vs-run comparison ──────────────────────────────────
//
// GET /runs/:runIdA/compare/:runIdB
//   Returns runA, runB, plus per-test deltas bucketed into regressions /
//   fixes / neutral (|Δ| < 0.05). Sums per-side cost + average duration into
//   a summary block. The promptVersionDelta entry surfaces agents whose
//   prompt-version SHA differs between runs A and B — the most actionable
//   diff for a researcher who's about to ship.

export interface ComparedResult {
  testId: string;
  agentId: string;
  scoreA: number | null;
  scoreB: number | null;
  scoreDelta: number | null;
  passedA: boolean | null;
  passedB: boolean | null;
  costDeltaUsd: number | null;
  durationDeltaMs: number | null;
  responseA?: string;
  responseB?: string;
}

export interface PromptVersionDeltaEntry {
  agentId: string;
  fromVersion: string;
  toVersion: string;
}

export interface CompareRunsSummary {
  // null, not 0, when a side has zero completed results / zero timed
  // results — a run that has not finished (or crashed before its first
  // verdict) has no pass rate or latency to report, and 0 would read as "0%
  // passing" / "0ms latency" rather than "not measured yet". Same convention
  // GET /runs/:id/status and the mock fixtures (mock/harness.ts::withCounts)
  // already use for passRate; this brings the compare summary in line.
  passRateA: number | null;
  passRateB: number | null;
  passRateDelta: number | null;
  costAUsd: number | null;
  costBUsd: number | null;
  costDeltaUsd: number | null;
  avgDurationMsA: number | null;
  avgDurationMsB: number | null;
  durationDeltaMs: number | null;
  modeA: 'live' | 'sim';
  modeB: 'live' | 'sim';
  judgeModelA: string;
  judgeModelB: string;
  promptVersionDelta: PromptVersionDeltaEntry[];
}

const NEUTRAL_BAND = 0.05;

async function fetchRunRow(id: string): Promise<TestRun | null> {
  if (config.mock.aurora) return mockGetRun(id);
  const rows = await exec(
    `SELECT run_id::text AS run_id, label, git_sha, judge_model_id,
            agent_versions::text AS agent_versions,
            status, total_cases, completed, passed, failed, pass_rate,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            notes, mode
       FROM observability.test_runs
      WHERE run_id = CAST(:id AS uuid)`,
    [strParam('id', id)],
  );
  if (rows.length === 0) return null;
  return rowToTestRun(rows[0]!);
}

interface JoinedResultRow {
  test_id: string;
  agent_id: string | null;
  judge_score: number | null;
  passed: boolean | null;
  est_cost_usd: number | null;
  duration_ms: number | null;
  response_snippet: string | null;
}

async function fetchJoinedResults(runId: string): Promise<JoinedResultRow[]> {
  if (config.mock.aurora) {
    return mockGetResults(runId).map((r) => ({
      test_id: r.testId,
      agent_id: r.agentId ?? null,
      judge_score: r.judgeScore,
      passed: r.passed,
      est_cost_usd: r.estCostUsd,
      duration_ms: r.durationMs,
      response_snippet: r.responseSnippet,
    }));
  }
  const rows = await exec(
    `SELECT r.test_id AS test_id,
            COALESCE(c.agent_id, '') AS agent_id,
            r.judge_score,
            r.passed,
            r.est_cost_usd,
            r.duration_ms,
            COALESCE(r.response_snippet, t.response_snippet) AS response_snippet
       FROM observability.test_results r
       LEFT JOIN observability.test_cases c ON c.test_id = r.test_id
       LEFT JOIN observability.invocation_traces t
         ON t.invocation_id = r.invocation_id
      WHERE r.run_id = CAST(:id AS uuid)`,
    [strParam('id', runId)],
  );
  return rows.map((r) => ({
    test_id: String(r['test_id'] ?? ''),
    agent_id: r['agent_id'] == null ? null : String(r['agent_id']),
    judge_score: r['judge_score'] == null ? null : Number(r['judge_score']),
    passed: r['passed'] == null ? null : Boolean(r['passed']),
    est_cost_usd: r['est_cost_usd'] == null ? null : Number(r['est_cost_usd']),
    duration_ms: r['duration_ms'] == null ? null : Number(r['duration_ms']),
    response_snippet: r['response_snippet'] == null ? null : String(r['response_snippet']),
  }));
}

function sumCost(rows: JoinedResultRow[]): number | null {
  let any = false;
  let total = 0;
  for (const r of rows) {
    if (r.est_cost_usd != null && Number.isFinite(r.est_cost_usd)) {
      any = true;
      total += r.est_cost_usd;
    }
  }
  return any ? total : null;
}

function avgDurationMs(rows: JoinedResultRow[]): number | null {
  let n = 0;
  let total = 0;
  for (const r of rows) {
    if (r.duration_ms != null && Number.isFinite(r.duration_ms)) {
      total += r.duration_ms;
      n += 1;
    }
  }
  return n === 0 ? null : total / n;
}

function computePassRate(run: TestRun): number | null {
  if (run.passRate != null && Number.isFinite(run.passRate)) return run.passRate;
  if (run.completed > 0) return run.passed / run.completed;
  return null;
}

function diffPromptVersions(
  a: Record<string, string>,
  b: Record<string, string>,
): PromptVersionDeltaEntry[] {
  const out: PromptVersionDeltaEntry[] = [];
  const agentIds = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const agentId of agentIds) {
    const fromVersion = a[agentId];
    const toVersion = b[agentId];
    if (!fromVersion || !toVersion) {
      // One side missing — record only when both sides claim a version. Single-
      // sided records aren't actionable as a delta. Skip.
      if (fromVersion !== toVersion && fromVersion && toVersion) {
        out.push({ agentId, fromVersion, toVersion });
      }
      continue;
    }
    if (fromVersion !== toVersion) {
      out.push({ agentId, fromVersion, toVersion });
    }
  }
  out.sort((x, y) => x.agentId.localeCompare(y.agentId));
  return out;
}

harnessRouter.get('/runs/:runIdA/compare/:runIdB', requireAction('ViewObservability'), asyncHandler(async (req, res) => {
  const runIdA = String(req.params['runIdA'] ?? '');
  const runIdB = String(req.params['runIdB'] ?? '');
  if (!runIdA || !runIdB) {
    throw new ValidationError('runIdA and runIdB are required');
  }

  const [runA, runB] = await Promise.all([fetchRunRow(runIdA), fetchRunRow(runIdB)]);
  if (!runA || !runB) {
    res.status(404).json({
      error: 'run not found',
      missing: [!runA ? runIdA : null, !runB ? runIdB : null].filter(Boolean),
    });
    return;
  }

  const [rowsA, rowsB] = await Promise.all([
    fetchJoinedResults(runIdA),
    fetchJoinedResults(runIdB),
  ]);

  const mapA = new Map<string, JoinedResultRow>(rowsA.map((r) => [r.test_id, r]));
  const mapB = new Map<string, JoinedResultRow>(rowsB.map((r) => [r.test_id, r]));
  const allTestIds = new Set<string>([...mapA.keys(), ...mapB.keys()]);

  const regressions: ComparedResult[] = [];
  const fixes: ComparedResult[] = [];
  const neutral: ComparedResult[] = [];

  for (const tid of allTestIds) {
    const a = mapA.get(tid);
    const b = mapB.get(tid);
    const scoreA = a?.judge_score ?? null;
    const scoreB = b?.judge_score ?? null;
    const scoreDelta = (scoreA != null && scoreB != null) ? (scoreB - scoreA) : null;
    const costA = a?.est_cost_usd ?? null;
    const costB = b?.est_cost_usd ?? null;
    const costDelta = (costA != null && costB != null) ? (costB - costA) : null;
    const durA = a?.duration_ms ?? null;
    const durB = b?.duration_ms ?? null;
    const durDelta = (durA != null && durB != null) ? (durB - durA) : null;

    const agentId = (a?.agent_id || b?.agent_id || '') ?? '';

    const entry: ComparedResult = {
      testId: tid,
      agentId,
      scoreA,
      scoreB,
      scoreDelta,
      passedA: a?.passed ?? null,
      passedB: b?.passed ?? null,
      costDeltaUsd: costDelta,
      durationDeltaMs: durDelta,
    };
    if (a?.response_snippet) entry.responseA = a.response_snippet;
    if (b?.response_snippet) entry.responseB = b.response_snippet;

    if (scoreDelta == null) {
      // No score on one side — treat as neutral so the test still surfaces.
      neutral.push(entry);
      continue;
    }
    if (scoreDelta <= -NEUTRAL_BAND) regressions.push(entry);
    else if (scoreDelta >= NEUTRAL_BAND) fixes.push(entry);
    else neutral.push(entry);
  }

  // Sort by |Δ| desc; null deltas drop to bottom.
  const byAbsDelta = (x: ComparedResult, y: ComparedResult): number => {
    const ax = x.scoreDelta == null ? -1 : Math.abs(x.scoreDelta);
    const ay = y.scoreDelta == null ? -1 : Math.abs(y.scoreDelta);
    return ay - ax;
  };
  regressions.sort(byAbsDelta);
  fixes.sort(byAbsDelta);
  neutral.sort((x, y) => x.testId.localeCompare(y.testId));

  const costAUsd = sumCost(rowsA);
  const costBUsd = sumCost(rowsB);
  const costDeltaUsd = (costAUsd != null && costBUsd != null) ? (costBUsd - costAUsd) : null;
  const avgDurationMsA = avgDurationMs(rowsA);
  const avgDurationMsB = avgDurationMs(rowsB);
  const passRateA = computePassRate(runA);
  const passRateB = computePassRate(runB);
  const promptVersionDelta = diffPromptVersions(runA.agentVersions, runB.agentVersions);

  const summary: CompareRunsSummary = {
    passRateA,
    passRateB,
    passRateDelta: (passRateA != null && passRateB != null) ? (passRateB - passRateA) : null,
    costAUsd,
    costBUsd,
    costDeltaUsd,
    avgDurationMsA,
    avgDurationMsB,
    durationDeltaMs: (avgDurationMsA != null && avgDurationMsB != null)
      ? (avgDurationMsB - avgDurationMsA)
      : null,
    modeA: runA.mode,
    modeB: runB.mode,
    judgeModelA: runA.judgeModelId,
    judgeModelB: runB.judgeModelId,
    promptVersionDelta,
  };

  res.json({
    runA,
    runB,
    regressions,
    fixes,
    neutral,
    summary,
  });
}));

// ── Sprint 3 (M8) — promote a prompt version ───────────────────────────────
//
// POST /promote { promptVersion, agentId, notes? } → marks the version
// production-blessed by stamping promoted_at / promoted_by / promote_notes
// on observability.prompt_versions. Idempotent — re-promoting the same row
// just refreshes promoted_at. agentId is required so a UI mis-click can't
// silently promote a version from a different agent (we verify the SHA
// belongs to the claimed agent).
//
// Promoted_by: we don't have a session on this route (mounted before the
// Cedar gate so the harness CLI can hit it). Body may supply 'promotedBy'
// for now — the portal will pass the current user's id once the gate is
// extended.

interface PromoteBody {
  promptVersion?: string;
  agentId?: string;
  notes?: string | null;
  promotedBy?: string | null;
}

harnessRouter.post('/promote', runnerOr(requireAction('ManageCanary')), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as PromoteBody;
  const promptVersion = typeof body.promptVersion === 'string' ? body.promptVersion.trim() : '';
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!promptVersion) throw new ValidationError('promptVersion is required');
  if (!agentId) throw new ValidationError('agentId is required');

  const promotedBy = (typeof body.promotedBy === 'string' && body.promotedBy.trim())
    ? body.promotedBy.trim()
    : 'harness-runner';

  // Offline the registry is `mock/prompt-versions.ts`, which is also what the
  // POST that registered the SHA wrote to — so a prompt registered in this
  // process can be promoted in it, and the promote list (which already had a
  // mock branch) shows the result. Both the 404 and the 409 are real decisions
  // taken against that registry, not softened into a 200.
  if (config.mock.aurora) {
    const outcome = mockPromotePromptVersion({
      promptVersion, agentId, promotedBy, notes: body.notes ?? null,
    });
    if (!outcome.ok && outcome.reason === 'not_found') {
      res.status(404).json({ error: 'prompt_version not found', promptVersion });
      return;
    }
    if (!outcome.ok) {
      res.status(409).json({
        error: 'agentId mismatch — this prompt_version belongs to a different agent',
        promptVersion,
        expectedAgentId: outcome.expectedAgentId,
        gotAgentId: agentId,
      });
      return;
    }
    res.json({ ok: true, promotedAt: outcome.promotedAt });
    return;
  }

  // Verify the SHA exists AND matches the claimed agent. Surfaces a 404 when
  // the version is unknown (mistyped) and a 409 when it belongs to a
  // different agent (UI bug or stale state).
  const existing = await exec(
    `SELECT agent_id FROM observability.prompt_versions
      WHERE prompt_version = :pv`,
    [strParam('pv', promptVersion)],
  );
  if (existing.length === 0) {
    res.status(404).json({ error: 'prompt_version not found', promptVersion });
    return;
  }
  const ownerAgentId = String(existing[0]?.['agent_id'] ?? '');
  if (ownerAgentId && ownerAgentId !== agentId) {
    res.status(409).json({
      error: 'agentId mismatch — this prompt_version belongs to a different agent',
      promptVersion,
      expectedAgentId: ownerAgentId,
      gotAgentId: agentId,
    });
    return;
  }

  const updated = await exec(
    `UPDATE observability.prompt_versions
        SET promoted_at = now(),
            promoted_by = :promoted_by,
            promote_notes = :promote_notes
      WHERE prompt_version = :pv
      RETURNING prompt_version, promoted_at::text AS promoted_at`,
    [
      strParam('pv', promptVersion),
      strParam('promoted_by', promotedBy),
      nullableStr('promote_notes', body.notes ?? null),
    ],
  );
  if (updated.length === 0) {
    // Race: row deleted between the SELECT and the UPDATE. Same shape as 404.
    res.status(404).json({ error: 'prompt_version not found', promptVersion });
    return;
  }
  const promotedAt = String(updated[0]?.['promoted_at'] ?? '');
  res.json({ ok: true, promotedAt });
}));

// ── Sprint 3 (M8) — list promoted versions ─────────────────────────────────

export interface PromotedPromptVersion {
  promptVersion: string;
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;
  promotedAt: string;
  promotedBy: string | null;
  promoteNotes: string | null;
  notes: string | null;
}

function rowToPromotedVersion(r: Record<string, unknown>): PromotedPromptVersion {
  return {
    promptVersion: String(r['prompt_version'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    content: String(r['content'] ?? ''),
    contentSha256: String(r['content_sha256'] ?? ''),
    registeredAt: String(r['registered_at'] ?? ''),
    promotedAt: String(r['promoted_at'] ?? ''),
    promotedBy: r['promoted_by'] == null ? null : String(r['promoted_by']),
    promoteNotes: r['promote_notes'] == null ? null : String(r['promote_notes']),
    notes: r['notes'] == null ? null : String(r['notes']),
  };
}

/**
 * The live prompt pointer (DE-4, `/orgiq/prompts/<agent>/live`) for each agent
 * on the list, so a reader can tell which promoted SHA is serving by what the
 * runtime actually reads, not by the promoted_at stamp alone. An agent with no
 * pointer (day-one state, an unreadable parameter, an id that is not an agent
 * name) maps to null and the stamp order is the only signal, as before. A
 * pointer names a Bedrock prompt id + version, not a content SHA, so this is
 * reported beside the list rather than matched into it.
 */
export async function livePointersFor(agentIds: readonly string[]): Promise<Record<string, Pointer | null>> {
  const out: Record<string, Pointer | null> = {};
  await Promise.all([...new Set(agentIds)].map(async (agent) => {
    if (!AGENT_RE.test(agent)) { out[agent] = null; return; }
    try { out[agent] = (await readPointers(agent)).live; } catch { out[agent] = null; }
  }));
  return out;
}

harnessRouter.get('/promoted-versions', requireAction('ViewObservability'), asyncHandler(async (_req, res) => {
  // Same registry the prompt-version chip reads (mock/prompt-versions.ts),
  // filtered to the SHAs a human promoted. A raw exec() here reached the RDS
  // Data API whatever config.mock.aurora said, so the promote list 500'd
  // offline and there was no way to audit it.
  if (config.mock.aurora) {
    const versions: PromotedPromptVersion[] = mockListPromotedVersions(200);
    res.json({ versions, livePointers: await livePointersFor(versions.map((v) => v.agentId)) });
    return;
  }
  const rows = await exec(
    `SELECT prompt_version, agent_id, content, content_sha256,
            registered_at::text AS registered_at,
            promoted_at::text AS promoted_at,
            promoted_by, promote_notes, notes
       FROM observability.prompt_versions
      WHERE promoted_at IS NOT NULL
      ORDER BY promoted_at DESC
      LIMIT 200`,
    [],
  );
  const versions = rows.map(rowToPromotedVersion);
  res.json({ versions, livePointers: await livePointersFor(versions.map((v) => v.agentId)) });
}));
