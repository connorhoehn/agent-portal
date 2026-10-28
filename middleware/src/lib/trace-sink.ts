// Trace sink — fire-and-forget pipeline for the drift + quality data plane.
//
// Called from invocations.recordInvocation() at the end of every agent run.
// Flow:
//   1. Look up sampling rate for the invocation's template_id (or 'default').
//   2. Roll a die. If we miss, return — no embedding/judge calls happen.
//   3. If we hit, in the background:
//        a. embed the response with Titan V2 (1024-dim)
//        b. score with Nova Pro (0..1 + rationale)
//        c. validate against the template's JSON schema (if any)
//        d. INSERT into observability.invocation_traces (ON CONFLICT DO NOTHING)
//        e. publish 3 CloudWatch metrics (drift, quality, schema)
//
// Every step swallows its own errors. The agent invocation path NEVER awaits
// the pipeline and NEVER sees a failure here.
//
// OFFLINE. Every one of those nine backends now has a mock branch, and they are
// per-STEP rather than one branch around the pipeline on purpose: the two rules
// this file exists to enforce — sampling gates persistence, and a phantom row
// is dropped only when every substance axis is empty — must run offline exactly
// as they run live, or `dev:mock` would be exercising a different sink. So the
// sampling decision, the die roll, the phantom predicate, the cost arithmetic,
// the conflict rule and the best-effort isolation of the child-table inserts
// are all the production code; only the six Aurora statements, the two Bedrock
// calls and the CloudWatch publish are swapped. What they are swapped for is in
// `mock/trace-sink.ts` (the rows), `mock/answer-check.ts` (the judge) and
// `mock/embedding.ts` (the vector), each of which says what it can and cannot
// claim. Neither rule is softened offline: a `test:*` template still always
// samples, a non-test bundle still rolls against the configured rate, and a
// bundle empty on every axis is still dropped before any of it happens.

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../providers/aurora.js';
import {
  putDriftMetric,
  putQualityMetric,
  putSchemaMetric,
} from '../providers/cloudwatch.js';
import {
  embedText,
  toPgVectorLiteral,
  cosineDistance,
  EMBEDDING_DIMENSIONS,
} from './embedding.js';
import { judgeResponse, NOVA_PRO_MODEL_ID } from './judge.js';
import { validate, tryParseJson } from './schema-validator.js';
import { estimateCost } from './pricing.js';
import { estimateUsageCost } from './model-prices.js';
import { config } from '../config.js';
import { normalizeAgentSteps, type AgentStepRecord } from './pipeline-runs.js';
import { clock } from '../mock/core/index.js';
import { lexicalEmbedding } from '../mock/embedding.js';
import {
  insertSinkTrace, recordSinkMetric, sinkCentroid, sinkGuardrailInterventions,
  sinkMemoryEvents, sinkSamplingConfig, sinkToolCalls,
  type SinkGuardrailRow, type SinkMemoryEventRow, type SinkToolCallRow,
} from '../mock/trace-sink.js';

// ── Public input shape ─────────────────────────────────────────────────────────
//
// We deliberately accept a wider shape than InvocationRecord so callers can pass
// any extra context they have (template_id, guardrail action, pii flag). All
// fields are optional except the IDs and the response text.

// Sprint 2 — per-tool call shape supplied by the trace bundle. Each entry maps
// 1:1 to a row in observability.tool_calls. Field budget intentionally narrow
// so harness/runtime emitters can populate it cheaply.
export interface ToolCallInput {
  toolName: string;
  startedAt?: string;           // ISO; defaults to now() at insert time
  durationMs?: number;
  inputSize?: number;
  outputSize?: number;
  errored?: boolean;
  errorMessage?: string;
  inputSample?: string;         // truncated to 500 by sink
  outputSample?: string;        // truncated to 500 by sink
  estCostUsd?: number;
}

// Sprint 4 (M11) — per-memory-op shape supplied alongside tool calls in the
// trace bundle. One row per AgentCore Memory operation. Persisted to
// observability.memory_events best-effort: a failure here NEVER bubbles up to
// the parent trace insert.
export interface MemoryEventInput {
  kind: 'retrieve' | 'write' | 'summarize' | 'expire';
  sessionId?: string;
  memoryId?: string;
  queryText?: string;
  resultCount?: number;
  durationMs?: number;
  retrievedSummary?: string;    // truncated to 500 by sink
  errored?: boolean;
  errorMessage?: string;
}

// Sprint 4 (M12) — per-fired-rule shape supplied alongside the trace bundle
// when a guardrail intervention occurred. One row per rule fired; an
// invocation can have multiple. Persisted to observability.guardrail_
// interventions best-effort.
export interface GuardrailInterventionInput {
  ruleName: string;
  ruleCategory?: string;        // 'PII' | 'TOPIC' | 'CONTENT' | 'PROMPT_ATTACK'
  severity?: 'LOW' | 'MEDIUM' | 'HIGH';
  action: 'BLOCKED' | 'ANONYMIZED';
  matchedText?: string;         // truncated to 200 by sink
}

export interface TraceInput {
  invocationId?: string;
  agentId: string;
  agentName?: string;
  templateId?: string;
  prompt: string;
  response: string;
  durationMs?: number;
  guardrailAction?: string;
  piiDetected?: boolean;
  // M2 — token + cost. Caller-supplied because the agent's tokens are reported
  // by whichever upstream actually invoked the model (harness runner for the
  // 'sim' path, AgentCore for the 'live' path). When unknown, leave undefined
  // and the trace row stores NULL.
  inputTokens?: number;
  outputTokens?: number;
  // M6 — provenance. promptVersion is a short SHA from the prompt_versions
  // registry; modelId names the inferred-against Bedrock model; image digest
  // is optional and only relevant in live mode.
  promptVersion?: string;
  modelId?: string;
  runtimeImageDigest?: string;
  // Sprint 2 (M3) — trace stitching. parentInvocationId links this row to its
  // caller so the portal can render the multi-agent call graph. user_id /
  // session_id are soft tenant fields stamped by the runtime when known.
  parentInvocationId?: string;  // uuid
  userId?: string;
  sessionId?: string;
  // Sprint 2 (M4) — per-tool call instrumentation. Each entry is inserted as a
  // row in observability.tool_calls. Inserted best-effort: if the tool-call
  // INSERT fails, the parent trace insert still succeeds.
  toolCalls?: ToolCallInput[];
  // Sprint 4 (M11) — per-memory-op rows. Inserted best-effort to
  // observability.memory_events. Never blocks the parent trace insert.
  memoryEvents?: MemoryEventInput[];
  // Sprint 4 (M12) — per-fired-rule rows. Inserted best-effort to
  // observability.guardrail_interventions. Never blocks the parent insert.
  guardrailInterventions?: GuardrailInterventionInput[];
  // Pipelines P1 — the AG-UI run this invocation IS. `runId` is RUN_STARTED's
  // run id (agents/_shared/instrumentation.py), persisted as `agui_run_id`;
  // `steps` is the run's STEP_* record with its TOOL_CALL_* attempts. The
  // projection (lib/pipeline-runs.ts) keys an agent Run on runId and files
  // this row as its `trace` artifact. `tenant` is the invoking session's.
  runId?: string;
  threadId?: string;
  steps?: unknown;
  tenant?: string;
}

// Result of a synchronous processTrace() call. The async enqueue() path
// discards this; the new sync /api/observability/harness/trace endpoint
// returns it to the caller so harness runners can score per-case.
export interface TraceResult {
  invocationId: string;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  embeddingComputed: boolean;
  sampled: boolean;             // false if the sampling die rolled against us
  inserted: boolean;            // false if the Aurora INSERT failed, or if
                                 // ON CONFLICT DO NOTHING fired because the
                                 // invocation_id already had a row (a raced
                                 // writer or a genuine retry)
  skipped: boolean;             // true if the write-side phantom guard dropped it
                                // before any embed/judge/INSERT happened
  // M2 — token + cost. Echoed back so the harness runner can populate
  // test_results without re-computing.
  inputTokens: number | null;
  outputTokens: number | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
  estCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
}

// ── Sampling config cache ─────────────────────────────────────────────────────
//
// We pull `observability.sampling_config` once every 60s. The cache is shared
// process-wide. On any DB failure we fall back to a flat 10% rate so the
// pipeline still produces some signal.

interface SamplingRow {
  rate: number;
  schema?: object | null;
}

const _samplingCache = new Map<string, SamplingRow>();
let _samplingFetchedAt = 0;
const SAMPLING_TTL_MS = 60_000;
const FALLBACK_RATE = 0.1;

async function loadSamplingConfig(): Promise<void> {
  const now = Date.now();
  // OFFLINE. The rows come from `mock/trace-sink.ts`'s `trace-sink-sampling`
  // fixture, which mirrors the one row `schema/observability_schema.sql` seeds
  // (`'default'`, rate 1.0). Read on EVERY call rather than through the TTL:
  // the TTL exists to stop a cold Aurora being hammered, there is no Aurora
  // here, and honouring it would mean a control-plane scenario switch
  // (`POST /api/__mock/scenario {"scenario":"empty","fixture":"trace-sink-sampling"}`)
  // took up to a minute to reach the sampler — which is exactly the rule an
  // auditor asked to stand in front of.
  if (config.mock.aurora) {
    _samplingCache.clear();
    for (const r of sinkSamplingConfig.rows()) {
      if (!r.template_id) continue;
      let schema: object | null = null;
      if (typeof r.schema_json === 'string' && r.schema_json.trim()) {
        try { schema = JSON.parse(r.schema_json) as object; } catch { schema = null; }
      }
      const rate = Number(r.rate);
      _samplingCache.set(r.template_id, {
        rate: Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : FALLBACK_RATE,
        schema,
      });
    }
    _samplingFetchedAt = now;
    return;
  }
  if (now - _samplingFetchedAt < SAMPLING_TTL_MS && _samplingCache.size > 0) return;
  try {
    const rows = await exec(
      `SELECT template_id, rate, schema_json
         FROM observability.sampling_config`,
      [],
    );
    _samplingCache.clear();
    for (const r of rows) {
      const id = typeof r['template_id'] === 'string' ? r['template_id'] : '';
      if (!id) continue;
      const rate = Number(r['rate']);
      let schema: object | null = null;
      const raw = r['schema_json'];
      if (typeof raw === 'string' && raw.trim()) {
        try { schema = JSON.parse(raw) as object; } catch { schema = null; }
      } else if (raw && typeof raw === 'object') {
        schema = raw as object;
      }
      _samplingCache.set(id, {
        rate: Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : FALLBACK_RATE,
        schema,
      });
    }
    _samplingFetchedAt = now;
  } catch (err) {
    // DB unavailable — keep whatever we had cached. Stamp the fetch time so
    // we don't hammer Aurora during an outage.
    _samplingFetchedAt = now;
    console.warn('[trace-sink] sampling_config load failed:',
      (err as Error).message);
  }
}

function decideSampling(templateId: string | undefined): SamplingRow {
  const fallback: SamplingRow = { rate: FALLBACK_RATE, schema: null };
  if (templateId && _samplingCache.has(templateId)) {
    return _samplingCache.get(templateId)!;
  }
  if (_samplingCache.has('default')) {
    return _samplingCache.get('default')!;
  }
  return fallback;
}

// ── Rolling centroid cache for drift ──────────────────────────────────────────
//
// Drift = cosine distance from this response's embedding to the centroid of
// the last N "good" embeddings for the same agent. We compute the centroid in
// SQL (AVG over the recent window) and cache it for 60s. "Good" here means
// any judge_score >= 0.6 or null (we want enough volume to compute a centroid
// even before judge scores accumulate).

interface CentroidEntry {
  vec: number[];
  fetchedAt: number;
}
const _centroidCache = new Map<string, CentroidEntry>();
const CENTROID_TTL_MS = 60_000;
const CENTROID_LOOKBACK_HOURS = 24;
const CENTROID_MIN_SAMPLES = 5;
/**
 * "Good enough to be part of normal": a row the judge did not clearly dislike.
 * Named rather than repeated so the SQL predicate and the offline selector in
 * `mock/trace-sink.ts` cannot drift into disagreeing about what a centroid is.
 */
const CENTROID_TRUST_FLOOR = 0.6;

function parsePgVector(text: string): number[] | null {
  // pgvector text format: "[v1,v2,...,vN]". Trim brackets, split, parse.
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1);
  if (!inner) return null;
  const parts = inner.split(',');
  if (parts.length !== EMBEDDING_DIMENSIONS) return null;
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

async function getCentroid(agentId: string): Promise<number[] | null> {
  const now = Date.now();
  const cached = _centroidCache.get(agentId);
  if (cached && now - cached.fetchedAt < CENTROID_TTL_MS) return cached.vec;

  // OFFLINE. The same aggregate, over the rows this process actually wrote:
  // same 24-hour window, same "judge did not dislike it" filter, same
  // five-sample floor — so a cold offline sink returns null exactly as a cold
  // Aurora does, and drift is not published until there is something to
  // measure drift against.
  if (config.mock.aurora) {
    const vec = sinkCentroid(
      agentId, CENTROID_MIN_SAMPLES, CENTROID_LOOKBACK_HOURS, CENTROID_TRUST_FLOOR,
    );
    if (vec) _centroidCache.set(agentId, { vec, fetchedAt: now });
    return vec;
  }

  try {
    // Use the pgvector aggregate `avg(vector)` which returns the mean vector
    // (centroid). We restrict to "trusted" recent rows where the judge wasn't
    // clearly negative.
    const rows = await exec(
      `SELECT (AVG(output_embedding))::text AS centroid, COUNT(*) AS n
         FROM observability.invocation_traces
        WHERE agent_id = :agent
          AND output_embedding IS NOT NULL
          AND ts > now() - INTERVAL '${CENTROID_LOOKBACK_HOURS} hours'
          AND (judge_score IS NULL OR judge_score >= ${CENTROID_TRUST_FLOOR})`,
      [{ name: 'agent', value: { stringValue: agentId } }],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const n = Number(r['n'] ?? 0);
    if (!Number.isFinite(n) || n < CENTROID_MIN_SAMPLES) return null;
    const centroidText = typeof r['centroid'] === 'string'
      ? (r['centroid'] as string)
      : null;
    if (!centroidText) return null;
    const vec = parsePgVector(centroidText);
    if (!vec) return null;
    _centroidCache.set(agentId, { vec, fetchedAt: now });
    return vec;
  } catch (err) {
    console.warn('[trace-sink] centroid load failed:',
      (err as Error).message);
    return null;
  }
}

// ── INSERT helper ─────────────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function nullableStr(name: string, value: string | undefined | null): SqlParameter {
  if (value === undefined || value === null) return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}
function nullableNumber(name: string, value: number | undefined | null): SqlParameter {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { doubleValue: value } };
}
function nullableInt(name: string, value: number | undefined | null): SqlParameter {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { longValue: Math.round(value) } };
}
function nullableBool(name: string, value: boolean | undefined | null): SqlParameter {
  if (value === undefined || value === null) return { name, value: { isNull: true } };
  return { name, value: { booleanValue: value } };
}

async function insertTrace(args: {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | undefined;
  promptSnippet: string;
  responseSnippet: string;
  embedding: number[] | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  piiDetected: boolean;
  guardrailAction: string | undefined;
  durationMs: number | undefined;
  // M2 + M6 fields
  inputTokens: number | null;
  outputTokens: number | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
  estCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
  runtimeImageDigest: string | null;
  // Sprint 2 (M3) — stitching + tenant.
  parentInvocationId: string | null;
  userId: string | null;
  sessionId: string | null;
  // Pipelines P1 — the AG-UI run.
  aguiRunId: string | null;
  aguiThreadId: string | null;
  steps: AgentStepRecord[] | null;
  tenant: string | null;
}): Promise<boolean> {
  // Returns true only when this call actually created the row. A caller
  // racing another writer for the same invocation_id (another poller
  // replica re-scanning an overlapping CW window, the OrgIQ-SpanProjector
  // Lambda projecting the same agent-minted id from its OTel span, or a
  // genuine retry) hits ON CONFLICT DO NOTHING and gets false back — the
  // insert ran, cost nothing extra at the DB layer, and changed nothing.
  // This used to be silently discarded (the function returned void and
  // every non-throwing call was treated as a fresh insert), which made
  // `cw-trace-ingest.ts`'s "duplicate N" counter and this route's own
  // "the trace insert did not report a row" branch (`routes/invocations.ts`)
  // dead code — every collision logged and counted as "persisted" instead.
  //
  // OFFLINE. One row into the `trace-sink-traces` fixture, with the
  // statement's own conflict rule: `insertSinkTrace` refuses a duplicate
  // invocation_id, which is what `ON CONFLICT (invocation_id) DO NOTHING`
  // means, so a retried bundle leaves the first row standing here too — and
  // now its boolean return (already correct) is actually read.
  if (config.mock.aurora) {
    return insertSinkTrace({
      invocation_id: args.invocationId,
      agent_id: args.agentId,
      agent_name: args.agentName,
      template_id: args.templateId ?? null,
      prompt_snippet: args.promptSnippet,
      response_snippet: args.responseSnippet,
      output_embedding: args.embedding,
      judge_score: args.judgeScore,
      judge_rationale: args.judgeRationale,
      schema_valid: args.schemaValid,
      pii_detected: args.piiDetected,
      guardrail_action: args.guardrailAction ?? null,
      duration_ms: args.durationMs ?? null,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      judge_input_tokens: args.judgeInputTokens,
      judge_output_tokens: args.judgeOutputTokens,
      est_cost_usd: args.estCostUsd,
      judge_cost_usd: args.judgeCostUsd,
      total_cost_usd: args.totalCostUsd,
      prompt_version: args.promptVersion,
      model_id: args.modelId,
      runtime_image_digest: args.runtimeImageDigest,
      parent_invocation_id: args.parentInvocationId,
      user_id: args.userId,
      session_id: args.sessionId,
      agui_run_id: args.aguiRunId,
      agui_thread_id: args.aguiThreadId,
      steps: args.steps,
      tenant: args.tenant,
      // `ts` is `DEFAULT now()` in the schema — the server's clock, never the
      // caller's — so offline it is the mock clock's, never `new Date()`.
      ts: clock.nowIso(),
    });
  }

  // Embed the vector literal directly into the SQL (it's an internally-
  // generated array of numbers, not user input). RDS Data API has no
  // parameter binding for pgvector; we cast on the server with ::vector.
  const embeddingSql = args.embedding
    ? `'${toPgVectorLiteral(args.embedding)}'::vector`
    : 'NULL';

  // parent_invocation_id is a uuid column; emit literal NULL when absent so
  // the cast-to-uuid never sees an empty string.
  const parentSql = args.parentInvocationId
    ? ':parent_invocation_id::uuid'
    : 'NULL';

  // Pipelines P1 columns. Written only while the cluster has them: a cluster
  // that has not re-applied observability_schema.sql answers `column
  // "agui_run_id" … does not exist`, and losing EVERY trace to a missing
  // optional column would be far worse than losing the run link — so that one
  // error flips this process to the pre-P1 column list, says so once, and
  // retries. Re-applying the schema and restarting restores the link.
  const withRun = !_runColumnsMissing;
  const runCols = withRun ? ',\n      agui_run_id, agui_thread_id, steps, tenant' : '';
  const runVals = withRun
    ? `,\n      :agui_run_id, :agui_thread_id, ${args.steps ? ':steps::jsonb' : 'NULL'}, :tenant`
    : '';
  const sql = `INSERT INTO observability.invocation_traces (
      invocation_id, agent_id, agent_name, template_id,
      prompt_snippet, response_snippet,
      output_embedding,
      judge_score, judge_rationale,
      schema_valid, pii_detected, guardrail_action, duration_ms,
      input_tokens, output_tokens,
      judge_input_tokens, judge_output_tokens,
      est_cost_usd, judge_cost_usd, total_cost_usd,
      prompt_version, model_id, runtime_image_digest,
      parent_invocation_id, user_id, session_id${runCols}
    ) VALUES (
      :iid::uuid, :agent_id, :agent_name, :template_id,
      :prompt_snippet, :response_snippet,
      ${embeddingSql},
      :judge_score, :judge_rationale,
      :schema_valid, :pii_detected, :guardrail_action, :duration_ms,
      :input_tokens, :output_tokens,
      :judge_input_tokens, :judge_output_tokens,
      :est_cost_usd, :judge_cost_usd, :total_cost_usd,
      :prompt_version, :model_id, :runtime_image_digest,
      ${parentSql}, :user_id, :session_id${runVals}
    )
    ON CONFLICT (invocation_id) DO NOTHING
    RETURNING invocation_id`;

  const params: SqlParameter[] = [
    strParam('iid', args.invocationId),
    strParam('agent_id', args.agentId),
    strParam('agent_name', args.agentName),
    nullableStr('template_id', args.templateId ?? null),
    nullableStr('prompt_snippet', args.promptSnippet),
    nullableStr('response_snippet', args.responseSnippet),
    nullableNumber('judge_score', args.judgeScore),
    nullableStr('judge_rationale', args.judgeRationale),
    nullableBool('schema_valid', args.schemaValid),
    nullableBool('pii_detected', args.piiDetected),
    nullableStr('guardrail_action', args.guardrailAction ?? null),
    nullableInt('duration_ms', args.durationMs),
    nullableInt('input_tokens', args.inputTokens),
    nullableInt('output_tokens', args.outputTokens),
    nullableInt('judge_input_tokens', args.judgeInputTokens),
    nullableInt('judge_output_tokens', args.judgeOutputTokens),
    nullableNumber('est_cost_usd', args.estCostUsd),
    nullableNumber('judge_cost_usd', args.judgeCostUsd),
    nullableNumber('total_cost_usd', args.totalCostUsd),
    nullableStr('prompt_version', args.promptVersion),
    nullableStr('model_id', args.modelId),
    nullableStr('runtime_image_digest', args.runtimeImageDigest),
    nullableStr('user_id', args.userId),
    nullableStr('session_id', args.sessionId),
  ];
  if (args.parentInvocationId) {
    params.push(strParam('parent_invocation_id', args.parentInvocationId));
  }
  if (withRun) {
    params.push(
      nullableStr('agui_run_id', args.aguiRunId),
      nullableStr('agui_thread_id', args.aguiThreadId),
      nullableStr('tenant', args.tenant),
    );
    if (args.steps) params.push(strParam('steps', JSON.stringify(args.steps)));
  }

  // RETURNING invocation_id comes back with one row on a fresh insert and
  // zero rows when ON CONFLICT DO NOTHING fired — that is how a genuine
  // insert is told apart from a race this call lost.
  let rows: Record<string, unknown>[];
  try {
    rows = await exec(sql, params);
  } catch (err) {
    if (withRun && isMissingRunColumn(err)) {
      _runColumnsMissing = true;
      console.warn(
        '[trace-sink] invocation_traces has no agui_run_id/steps/tenant columns — writing traces without the '
        + 'AG-UI run link until schema/observability_schema.sql is re-applied and the middleware restarted',
      );
      return insertTrace(args);
    }
    throw err;
  }
  return rows.length > 0;
}

// Set once the cluster has said the P1 columns do not exist (see insertTrace).
let _runColumnsMissing = false;

function isMissingRunColumn(err: unknown): boolean {
  const msg = (err as Error | null)?.message ?? '';
  return /column "?(agui_run_id|agui_thread_id|steps|tenant)"? .*does not exist/i.test(msg);
}

// Sprint 2 (M4) — best-effort batch INSERT of per-tool call rows. Capped at 50
// entries per invocation so a runaway agent can't tank the trace path. Wrapped
// in a single try/catch so any failure here NEVER bubbles up to the trace
// insert that just succeeded; we log and move on.
const TOOL_CALL_MAX_PER_INVOCATION = 50;
const TOOL_CALL_SAMPLE_MAX = 500;

function snipSample(text: string | undefined, max = TOOL_CALL_SAMPLE_MAX): string | null {
  if (text === undefined || text === null) return null;
  if (typeof text !== 'string') return null;
  if (text.length === 0) return '';
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
}

function isValidUuid(s: string | undefined | null): s is string {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

async function insertToolCalls(
  invocationId: string,
  toolCalls: ToolCallInput[],
): Promise<void> {
  if (!toolCalls || toolCalls.length === 0) return;
  // Defensive cap.
  const slice = toolCalls.slice(0, TOOL_CALL_MAX_PER_INVOCATION);

  // Build a single multi-row INSERT — N rows in one round-trip. Each row gets
  // its own positional parameter set (:tn_0, :sa_0, ...). started_at falls
  // back to now() if missing or unparseable, so a sloppy emitter still
  // produces a chronologically-coherent row.
  const valueClauses: string[] = [];
  const params: SqlParameter[] = [
    strParam('iid', invocationId),
  ];
  // Offline rows, filled by the SAME loop that builds the statement, so the
  // cap, the blank-name skip and the sample truncation are applied once and
  // both paths accept exactly the same entries.
  const accepted: SinkToolCallRow[] = [];

  let validCount = 0;
  for (let i = 0; i < slice.length; i++) {
    const tc = slice[i]!;
    const toolName = typeof tc.toolName === 'string' ? tc.toolName.trim() : '';
    if (!toolName) continue;

    const tn  = `tn_${validCount}`;
    const sa  = `sa_${validCount}`;
    const dm  = `dm_${validCount}`;
    const isz = `isz_${validCount}`;
    const osz = `osz_${validCount}`;
    const err = `err_${validCount}`;
    const em  = `em_${validCount}`;
    const ism = `ism_${validCount}`;
    const osm = `osm_${validCount}`;
    const ec  = `ec_${validCount}`;

    // started_at: prefer caller's ISO if it parses, else now() server-side.
    let startedAtSql = 'now()';
    let bindStartedAt = false;
    if (typeof tc.startedAt === 'string' && tc.startedAt.trim()) {
      const parsed = Date.parse(tc.startedAt);
      if (Number.isFinite(parsed)) {
        startedAtSql = `:${sa}::timestamptz`;
        bindStartedAt = true;
      }
    }

    valueClauses.push(
      `(:iid::uuid, :${tn}, ${startedAtSql}, :${dm}, :${isz}, :${osz}, :${err}, :${em}, :${ism}, :${osm}, :${ec})`,
    );

    params.push(strParam(tn, toolName));
    if (bindStartedAt) {
      params.push(strParam(sa, tc.startedAt as string));
    }
    params.push(nullableInt(dm,  tc.durationMs ?? null));
    params.push(nullableInt(isz, tc.inputSize ?? null));
    params.push(nullableInt(osz, tc.outputSize ?? null));
    params.push(nullableBool(err, tc.errored ?? false));
    params.push(nullableStr(em,  tc.errorMessage ?? null));
    params.push(nullableStr(ism, snipSample(tc.inputSample)));
    params.push(nullableStr(osm, snipSample(tc.outputSample)));
    params.push(nullableNumber(ec, tc.estCostUsd ?? null));

    accepted.push({
      invocation_id: invocationId,
      tool_name: toolName,
      started_at: bindStartedAt ? (tc.startedAt as string) : clock.nowIso(),
      duration_ms: tc.durationMs ?? null,
      input_size: tc.inputSize ?? null,
      output_size: tc.outputSize ?? null,
      errored: tc.errored ?? false,
      error_message: tc.errorMessage ?? null,
      input_sample: snipSample(tc.inputSample),
      output_sample: snipSample(tc.outputSample),
      est_cost_usd: tc.estCostUsd ?? null,
    });

    validCount++;
  }

  if (validCount === 0) return;
  if (config.mock.aurora) { sinkToolCalls.rows().push(...accepted); return; }

  const sql = `INSERT INTO observability.tool_calls (
      invocation_id, tool_name, started_at, duration_ms,
      input_size, output_size, errored, error_message,
      input_sample, output_sample, est_cost_usd
    ) VALUES ${valueClauses.join(', ')}`;

  await exec(sql, params);
}

// Sprint 4 (M11) — best-effort batch INSERT of per-memory-op rows. Same shape
// as insertToolCalls: capped + wrapped at the call site so failures don't
// bubble. retrieved_summary truncated to 500, query_text untrimmed but logged
// as-is from the agent.
const MEMORY_EVENT_MAX_PER_INVOCATION = 50;
const MEMORY_SUMMARY_MAX = 500;

const VALID_MEMORY_KINDS = new Set(['retrieve', 'write', 'summarize', 'expire']);

async function insertMemoryEvents(
  invocationId: string,
  agentId: string,
  memoryEvents: MemoryEventInput[],
): Promise<void> {
  if (!memoryEvents || memoryEvents.length === 0) return;
  const slice = memoryEvents.slice(0, MEMORY_EVENT_MAX_PER_INVOCATION);

  const valueClauses: string[] = [];
  const params: SqlParameter[] = [
    strParam('iid', invocationId),
    strParam('agent_id', agentId),
  ];
  const accepted: SinkMemoryEventRow[] = [];

  let validCount = 0;
  for (let i = 0; i < slice.length; i++) {
    const me = slice[i]!;
    if (!me || !VALID_MEMORY_KINDS.has(me.kind)) continue;

    const k   = `mk_${validCount}`;
    const ses = `ms_${validCount}`;
    const mid = `mm_${validCount}`;
    const qt  = `mq_${validCount}`;
    const rc  = `mr_${validCount}`;
    const dm  = `md_${validCount}`;
    const rs  = `mrs_${validCount}`;
    const er  = `me_${validCount}`;
    const em  = `mem_${validCount}`;

    valueClauses.push(
      `(:iid::uuid, :agent_id, :${ses}, :${k}, :${mid}, :${qt}, :${rc}, :${dm}, :${rs}, :${er}, :${em})`,
    );

    params.push(strParam(k, me.kind));
    params.push(nullableStr(ses, me.sessionId ?? null));
    params.push(nullableStr(mid, me.memoryId ?? null));
    params.push(nullableStr(qt,  me.queryText ?? null));
    params.push(nullableInt(rc,  me.resultCount ?? null));
    params.push(nullableInt(dm,  me.durationMs ?? null));
    params.push(nullableStr(rs,  snipSample(me.retrievedSummary, MEMORY_SUMMARY_MAX)));
    params.push(nullableBool(er, me.errored ?? false));
    params.push(nullableStr(em,  me.errorMessage ?? null));

    accepted.push({
      invocation_id: invocationId,
      agent_id: agentId,
      session_id: me.sessionId ?? null,
      kind: me.kind,
      memory_id: me.memoryId ?? null,
      query_text: me.queryText ?? null,
      result_count: me.resultCount ?? null,
      duration_ms: me.durationMs ?? null,
      retrieved_summary: snipSample(me.retrievedSummary, MEMORY_SUMMARY_MAX),
      errored: me.errored ?? false,
      error_message: me.errorMessage ?? null,
    });

    validCount++;
  }

  if (validCount === 0) return;
  if (config.mock.aurora) { sinkMemoryEvents.rows().push(...accepted); return; }

  const sql = `INSERT INTO observability.memory_events (
      invocation_id, agent_id, session_id, kind, memory_id, query_text,
      result_count, duration_ms, retrieved_summary, errored, error_message
    ) VALUES ${valueClauses.join(', ')}`;

  await exec(sql, params);
}

// Sprint 4 (M12) — best-effort batch INSERT of per-fired-rule rows. Each entry
// becomes one row in observability.guardrail_interventions. matched_text
// truncated to 200 chars (intentionally tighter than tool/memory samples —
// these can quote raw user content, so keep the storage footprint small).
const GUARDRAIL_INTERVENTION_MAX_PER_INVOCATION = 50;
const GUARDRAIL_MATCHED_TEXT_MAX = 200;

const VALID_GUARDRAIL_ACTIONS = new Set(['BLOCKED', 'ANONYMIZED']);
const VALID_GUARDRAIL_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

async function insertGuardrailInterventions(
  invocationId: string,
  agentId: string,
  interventions: GuardrailInterventionInput[],
): Promise<void> {
  if (!interventions || interventions.length === 0) return;
  const slice = interventions.slice(0, GUARDRAIL_INTERVENTION_MAX_PER_INVOCATION);

  const valueClauses: string[] = [];
  const params: SqlParameter[] = [
    strParam('iid', invocationId),
    strParam('agent_id', agentId),
  ];
  const accepted: SinkGuardrailRow[] = [];

  let validCount = 0;
  for (let i = 0; i < slice.length; i++) {
    const gi = slice[i]!;
    if (!gi) continue;
    const ruleName = typeof gi.ruleName === 'string' ? gi.ruleName.trim() : '';
    const action = typeof gi.action === 'string' ? gi.action : '';
    if (!ruleName || !VALID_GUARDRAIL_ACTIONS.has(action)) continue;
    const severity = typeof gi.severity === 'string' && VALID_GUARDRAIL_SEVERITIES.has(gi.severity)
      ? gi.severity
      : null;

    const rn = `gn_${validCount}`;
    const rc = `gc_${validCount}`;
    const sv = `gs_${validCount}`;
    const ac = `ga_${validCount}`;
    const mt = `gm_${validCount}`;

    valueClauses.push(
      `(:iid::uuid, :agent_id, :${rn}, :${rc}, :${sv}, :${ac}, :${mt})`,
    );

    params.push(strParam(rn, ruleName));
    params.push(nullableStr(rc, gi.ruleCategory ?? null));
    params.push(nullableStr(sv, severity));
    params.push(strParam(ac, action));
    params.push(nullableStr(mt, snipSample(gi.matchedText, GUARDRAIL_MATCHED_TEXT_MAX)));

    accepted.push({
      invocation_id: invocationId,
      agent_id: agentId,
      rule_name: ruleName,
      rule_category: gi.ruleCategory ?? null,
      severity,
      action,
      matched_text: snipSample(gi.matchedText, GUARDRAIL_MATCHED_TEXT_MAX),
    });

    validCount++;
  }

  if (validCount === 0) return;
  if (config.mock.aurora) { sinkGuardrailInterventions.rows().push(...accepted); return; }

  const sql = `INSERT INTO observability.guardrail_interventions (
      invocation_id, agent_id, rule_name, rule_category, severity, action, matched_text
    ) VALUES ${valueClauses.join(', ')}`;

  await exec(sql, params);
}

// ── Phantom-trace write guard ─────────────────────────────────────────────────
//
// Some bundles reaching the sink carry no substance: a partial/aborted run, a
// health-ping replay, or the middleware's own `recordInvocation` shape when it
// wrote before the agent's real bundle arrived — model_id NULL, an empty
// response, no tokens, no tool calls. Persisting these pollutes the drift,
// quality and error surfaces (a NULL-model, empty-response row scores as a hard
// failure it never was) yet adds no signal. We drop them BEFORE the embed/judge/
// INSERT so they never reach Aurora.
//
// The predicate is deliberately conservative — a false-drop of a real trace is
// worse than the occasional phantom slipping through — so EVERY one of these
// must hold before we skip:
//   • no model attributed          (modelId absent/blank)
//   • response is empty/whitespace  (a real short answer has text → kept)
//   • no token usage reported       (neither input nor output tokens finite)
//   • no tool calls
//   • no guardrail signal           (no action, no fired-rule rows, no PII flag —
//                                     a blocked/anonymized run is substantive even
//                                     with an empty response)
//   • no memory events
// A legitimately short answer keeps its text; a legitimately missing model still
// carries a response, tokens, tools, or a guardrail signal. Only a bundle empty
// on ALL of these axes is treated as a phantom. test:* templates are exempt —
// harness writes are explicit and guaranteed a row by contract.

let _phantomSkips = 0;

function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPhantomTrace(input: TraceInput): boolean {
  const hasModel = typeof input.modelId === 'string' && input.modelId.trim().length > 0;
  if (hasModel) return false;

  const hasResponse = typeof input.response === 'string' && input.response.trim().length > 0;
  if (hasResponse) return false;

  const hasTokens = isFiniteNumber(input.inputTokens) || isFiniteNumber(input.outputTokens);
  if (hasTokens) return false;

  const hasToolCalls = Array.isArray(input.toolCalls) && input.toolCalls.length > 0;
  if (hasToolCalls) return false;

  const hasGuardrailSignal =
    (typeof input.guardrailAction === 'string' && input.guardrailAction.trim().length > 0) ||
    (Array.isArray(input.guardrailInterventions) && input.guardrailInterventions.length > 0) ||
    input.piiDetected === true;
  if (hasGuardrailSignal) return false;

  const hasMemoryEvents = Array.isArray(input.memoryEvents) && input.memoryEvents.length > 0;
  if (hasMemoryEvents) return false;

  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

function snip(text: string, max = 500): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
}

/**
 * Step 1's embedding.
 *
 * OFFLINE this is `mock/embedding.ts`'s bag-of-words projection rather than
 * Titan V2 — the same dimensionality, so `cosineDistance` and the centroid
 * average are the real functions over real vectors, but a LEXICAL space, not a
 * semantic one. Offline drift therefore means "the fleet started using
 * different words", never "the fleet changed its mind"; that weaker claim is
 * the honest one and the module says so at length.
 *
 * Guarded here rather than inside `lib/embedding.ts` because that module is the
 * Bedrock wire — the same argument that keeps `providers/aurora.ts` `exec` out
 * of the mock-branch scan.
 */
async function embedForTrace(text: string): Promise<number[] | null> {
  if (config.mock.agentcore) return lexicalEmbedding(text, EMBEDDING_DIMENSIONS);
  return embedText(text).catch(() => null);
}

/**
 * Step 4's metric publish.
 *
 * OFFLINE the datapoint goes into the `trace-sink-metrics` fixture instead of
 * CloudWatch. Recorded rather than dropped because with the calls simply
 * skipped, "the sink stored the row and published nothing" and "the sink ran to
 * completion" are indistinguishable — and step 4 is the half of this pipeline
 * that has no other observable output.
 */
function publishTraceMetric(
  metricName: 'JudgeScore' | 'SchemaConformance' | 'EmbeddingDriftP95',
  agentId: string,
  value: number,
  templateId?: string,
): Promise<unknown> {
  if (config.mock.cloudwatch) {
    recordSinkMetric(metricName, agentId, value, templateId ?? null);
    return Promise.resolve();
  }
  if (metricName === 'JudgeScore') return putQualityMetric(agentId, value);
  if (metricName === 'SchemaConformance') return putSchemaMetric(agentId, value);
  return putDriftMetric(agentId, templateId ?? 'default', value);
}

/**
 * Enqueue an invocation for trace processing. Returns immediately; the
 * pipeline runs on a detached microtask. Any error in the pipeline is logged
 * but never thrown — callers can ignore the return value entirely.
 */
export function enqueue(input: TraceInput): void {
  // We deliberately do NOT await this. The harness `processTrace` returns a
  // result; we discard it here for the production async path.
  void processTrace(input).catch((err) => {
    console.warn('[trace-sink] pipeline error:', (err as Error).message);
  });
}

/**
 * Run the trace pipeline synchronously and return its outcome.
 *
 * Production code uses `enqueue()` which fires this in the background; the
 * sync `/api/observability/harness/trace` endpoint awaits it so harness
 * runners get per-case judge scores back inline.
 *
 * Rules:
 *  - `templateId` starting with `test:` always samples (rate=1) regardless
 *    of `observability.sampling_config`. This guarantees test runs always
 *    persist a row, even on cold-start before the sampling cache is loaded.
 *  - Embedding / judge / schema failures are swallowed and reflected as
 *    nulls on the returned result. Aurora INSERT failures throw so callers
 *    can map them to 5xx.
 */
export async function processTrace(input: TraceInput): Promise<TraceResult> {
  const isTestTemplate = typeof input.templateId === 'string'
    && input.templateId.startsWith('test:');

  // Sampling: test:* templates always sample; everything else honours config.
  let schema: object | null = null;
  let sampled = true;
  if (isTestTemplate) {
    // Still load config so schema-by-template can apply if the researcher
    // configured a schema for a test:* template id.
    await loadSamplingConfig();
    const cfg = decideSampling(input.templateId);
    schema = cfg.schema ?? null;
  } else {
    await loadSamplingConfig();
    const cfg = decideSampling(input.templateId);
    schema = cfg.schema ?? null;
    if (Math.random() >= cfg.rate) {
      sampled = false;
    }
  }

  // We always assign an invocationId — the upstream caller may not have one
  // that's a real UUID. Idempotency via ON CONFLICT means duplicate enqueues
  // (e.g. retry storms) won't blow up.
  const invocationId = input.invocationId && /^[0-9a-f-]{36}$/i.test(input.invocationId)
    ? input.invocationId
    : randomUUID();

  if (!sampled) {
    return {
      invocationId,
      judgeScore: null,
      judgeRationale: null,
      schemaValid: null,
      embeddingComputed: false,
      sampled: false,
      inserted: false,
      skipped: false,
      inputTokens: null,
      outputTokens: null,
      judgeInputTokens: null,
      judgeOutputTokens: null,
      estCostUsd: null,
      judgeCostUsd: null,
      totalCostUsd: null,
    };
  }

  const agentId = input.agentId || 'unknown';
  const agentName = input.agentName || agentId;
  const templateId = input.templateId;
  const promptSnippet = snip(input.prompt);
  const responseSnippet = snip(input.response);

  // Write-side phantom guard. Drop non-substantive bundles before any embed/
  // judge/INSERT so they never contaminate the drift/quality/error surfaces.
  // test:* templates are exempt — the harness contract guarantees them a row.
  if (!isTestTemplate && isPhantomTrace(input)) {
    _phantomSkips++;
    console.log(
      `[trace-sink] skipped phantom trace (agent=${agentId}, invocation=${invocationId}); ` +
      `total skipped ${_phantomSkips}`,
    );
    return {
      invocationId,
      judgeScore: null,
      judgeRationale: null,
      schemaValid: null,
      embeddingComputed: false,
      sampled: true,
      inserted: false,
      skipped: true,
      inputTokens: null,
      outputTokens: null,
      judgeInputTokens: null,
      judgeOutputTokens: null,
      estCostUsd: null,
      judgeCostUsd: null,
      totalCostUsd: null,
    };
  }

  // 1. Embed in parallel with judge — neither depends on the other.
  const [embedding, judge] = await Promise.all([
    embedForTrace(input.response),
    judgeResponse(input.prompt, input.response).catch(() => null),
  ]);

  // 2. Schema validation if a JSON schema is configured for this template.
  let schemaValid: boolean | null = null;
  if (schema && Object.keys(schema).length > 0) {
    const parsed = tryParseJson(input.response);
    schemaValid = parsed === undefined ? false : validate(parsed, schema);
  }

  // 2.5. Cost accounting.
  //   - Agent cost: only when caller supplied tokens AND a known modelId
  //     (defaults to nova-pro since that's the only model the sim path uses).
  //   - Judge cost: always nova-pro v1:0. Even if the judge JSON failed to
  //     parse (judge === null) we don't have usage; treat as zero.
  //   - Total: sum of the two; null only if BOTH are null.
  const agentModelId = input.modelId ?? NOVA_PRO_MODEL_ID;
  const hasAgentTokens = typeof input.inputTokens === 'number'
    && typeof input.outputTokens === 'number'
    && Number.isFinite(input.inputTokens)
    && Number.isFinite(input.outputTokens);
  const agentInputTokens = hasAgentTokens ? (input.inputTokens as number) : null;
  const agentOutputTokens = hasAgentTokens ? (input.outputTokens as number) : null;
  // `estimateUsageCost`, not `estimateCost`: an unpriced model must record
  // NULL, not 0. The devbox runs Bedrock Claude inference profiles, which
  // BEDROCK_PRICING does not cover, so the old call stamped every computer-lab
  // run — the expensive kind — with `cost_usd = 0` beside a real token count.
  // A confident zero reads as free and silently spends no initiative envelope;
  // NULL is excluded from SUMs and reads as unknown, which is the truth. The
  // Claude rates come from lib/model-prices.ts (DE-32), and a `us.` profile
  // id resolves to its bare entry there.
  const estCostUsd = hasAgentTokens
    ? estimateUsageCost(agentModelId, {
        inputTokens: input.inputTokens as number,
        outputTokens: input.outputTokens as number,
      })
    : null;

  const judgeInputTokens = judge ? judge.usage.inputTokens : null;
  const judgeOutputTokens = judge ? judge.usage.outputTokens : null;
  const judgeCostUsd = judge
    ? estimateCost(NOVA_PRO_MODEL_ID, judge.usage)
    : null;

  let totalCostUsd: number | null = null;
  if (estCostUsd !== null || judgeCostUsd !== null) {
    totalCostUsd = (estCostUsd ?? 0) + (judgeCostUsd ?? 0);
  }

  // 3. Persist trace row. For sync callers, INSERT failure is the only
  // signal that bubbles up as an error — every other step swallows.
  let inserted = false;
  let insertError: unknown = null;
  const parentInvocationId = isValidUuid(input.parentInvocationId)
    ? input.parentInvocationId
    : null;
  const userId = typeof input.userId === 'string' && input.userId.trim()
    ? input.userId.trim()
    : null;
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim()
    ? input.sessionId.trim()
    : null;
  // P1 — bounded, because it is agent output that crossed a network.
  const clip = (v: unknown, max: number): string | null =>
    (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const aguiRunId = clip(input.runId, 200);
  const aguiThreadId = clip(input.threadId, 200);
  const runTenant = clip(input.tenant, 64);
  const steps = normalizeAgentSteps(input.steps);

  try {
    // insertTrace's return value is load-bearing, not decorative: false
    // means ON CONFLICT DO NOTHING fired — another writer (another poller
    // replica, the SpanProjector Lambda, or a genuine retry) already holds
    // this invocation_id — and `inserted` must reflect that so callers who
    // key off it (cw-trace-ingest.ts's "duplicate" counter, the /replay
    // route's "did not report a row" branch) see the truth.
    inserted = await insertTrace({
      invocationId,
      agentId,
      agentName,
      templateId,
      promptSnippet,
      responseSnippet,
      embedding,
      judgeScore: judge ? judge.score : null,
      judgeRationale: judge ? judge.rationale : null,
      schemaValid,
      piiDetected: input.piiDetected ?? false,
      guardrailAction: input.guardrailAction,
      durationMs: input.durationMs,
      inputTokens: agentInputTokens,
      outputTokens: agentOutputTokens,
      judgeInputTokens,
      judgeOutputTokens,
      estCostUsd,
      judgeCostUsd,
      totalCostUsd,
      promptVersion: input.promptVersion ?? null,
      modelId: input.modelId ?? null,
      runtimeImageDigest: input.runtimeImageDigest ?? null,
      parentInvocationId,
      userId,
      sessionId,
      aguiRunId,
      aguiThreadId,
      steps: steps && steps.length > 0 ? steps : null,
      tenant: runTenant,
    });
  } catch (err) {
    console.warn('[trace-sink] insertTrace failed:',
      (err as Error).message);
    insertError = err;
    // Don't return — still publish metrics from in-memory values.
  }

  // Sprint 2 (M4) — best-effort per-tool call rows. Wrapped so a failure here
  // NEVER bubbles up; the parent invocation row has already been persisted.
  if (inserted && Array.isArray(input.toolCalls) && input.toolCalls.length > 0) {
    try {
      await insertToolCalls(invocationId, input.toolCalls);
    } catch (err) {
      console.warn('[trace-sink] insertToolCalls failed:',
        (err as Error).message);
    }
  }

  // Sprint 4 (M11) — best-effort per-memory-op rows. Same isolation as tool
  // calls: a failure here NEVER bubbles up.
  if (inserted && Array.isArray(input.memoryEvents) && input.memoryEvents.length > 0) {
    try {
      await insertMemoryEvents(invocationId, agentId, input.memoryEvents);
    } catch (err) {
      console.warn('[trace-sink] insertMemoryEvents failed:',
        (err as Error).message);
    }
  }

  // Sprint 4 (M12) — best-effort per-fired-rule rows. Driven off the same
  // trace bundle the agent supplies; the parent trace's guardrail_action is
  // still the headline signal — these rows just give the breakdown.
  if (inserted && Array.isArray(input.guardrailInterventions) && input.guardrailInterventions.length > 0) {
    try {
      await insertGuardrailInterventions(invocationId, agentId, input.guardrailInterventions);
    } catch (err) {
      console.warn('[trace-sink] insertGuardrailInterventions failed:',
        (err as Error).message);
    }
  }

  // 4. Publish CloudWatch metrics (don't block; let them race).
  const metricCalls: Promise<unknown>[] = [];

  if (judge) {
    metricCalls.push(publishTraceMetric('JudgeScore', agentId, judge.score));
  }
  if (schemaValid !== null) {
    metricCalls.push(publishTraceMetric('SchemaConformance', agentId, schemaValid ? 1 : 0));
  }
  if (embedding) {
    // Drift: cosine distance to centroid. If we don't have a centroid yet
    // (cold start), publish 0 so the alarm doesn't fire on no-signal.
    try {
      const centroid = await getCentroid(agentId);
      if (centroid) {
        const dist = cosineDistance(embedding, centroid);
        metricCalls.push(
          publishTraceMetric('EmbeddingDriftP95', agentId, dist, templateId ?? 'default'),
        );
      }
    } catch (err) {
      console.warn('[trace-sink] drift compute failed:',
        (err as Error).message);
    }
  }

  await Promise.allSettled(metricCalls);

  // For the sync harness path, re-throw the insert error AFTER metrics so
  // callers can map it to a 5xx — the metric-publishing best-effort side
  // effects still complete.
  if (insertError) {
    throw insertError;
  }

  return {
    invocationId,
    judgeScore: judge ? judge.score : null,
    judgeRationale: judge ? judge.rationale : null,
    schemaValid,
    embeddingComputed: !!embedding,
    sampled: true,
    inserted,
    skipped: false,
    inputTokens: agentInputTokens,
    outputTokens: agentOutputTokens,
    judgeInputTokens,
    judgeOutputTokens,
    estCostUsd,
    judgeCostUsd,
    totalCostUsd,
  };
}

// ── Test hooks ────────────────────────────────────────────────────────────────
//
// Exposed for unit tests / forced refresh. Not used in normal operation.

export function _resetCachesForTest(): void {
  _runColumnsMissing = false;
  _samplingCache.clear();
  _samplingFetchedAt = 0;
  _centroidCache.clear();
  _phantomSkips = 0;
}

/** Exposed for unit tests — total phantom bundles the write-side guard dropped. */
export function _phantomSkipCountForTest(): number {
  return _phantomSkips;
}

// `config` isn't strictly needed at runtime here, but importing it eagerly
// triggers .env.aws loading the same way the rest of the providers do.
void config;

export const traceSink = { enqueue, processTrace };
