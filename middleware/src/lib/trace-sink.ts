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
import { judgeResponse } from './judge.js';
import { validate, tryParseJson } from './schema-validator.js';
import { config } from '../config.js';

// ── Public input shape ─────────────────────────────────────────────────────────
//
// We deliberately accept a wider shape than InvocationRecord so callers can pass
// any extra context they have (template_id, guardrail action, pii flag). All
// fields are optional except the IDs and the response text.

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
  inserted: boolean;            // false if the Aurora INSERT failed
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
          AND (judge_score IS NULL OR judge_score >= 0.6)`,
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
}): Promise<void> {
  // Embed the vector literal directly into the SQL (it's an internally-
  // generated array of numbers, not user input). RDS Data API has no
  // parameter binding for pgvector; we cast on the server with ::vector.
  const embeddingSql = args.embedding
    ? `'${toPgVectorLiteral(args.embedding)}'::vector`
    : 'NULL';

  const sql = `INSERT INTO observability.invocation_traces (
      invocation_id, agent_id, agent_name, template_id,
      prompt_snippet, response_snippet,
      output_embedding,
      judge_score, judge_rationale,
      schema_valid, pii_detected, guardrail_action, duration_ms
    ) VALUES (
      :iid::uuid, :agent_id, :agent_name, :template_id,
      :prompt_snippet, :response_snippet,
      ${embeddingSql},
      :judge_score, :judge_rationale,
      :schema_valid, :pii_detected, :guardrail_action, :duration_ms
    )
    ON CONFLICT (invocation_id) DO NOTHING`;

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
  ];

  await exec(sql, params);
}

// ── Public API ────────────────────────────────────────────────────────────────

function snip(text: string, max = 500): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
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
    };
  }

  const agentId = input.agentId || 'unknown';
  const agentName = input.agentName || agentId;
  const templateId = input.templateId;
  const promptSnippet = snip(input.prompt);
  const responseSnippet = snip(input.response);

  // 1. Embed in parallel with judge — neither depends on the other.
  const [embedding, judge] = await Promise.all([
    embedText(input.response).catch(() => null),
    judgeResponse(input.prompt, input.response).catch(() => null),
  ]);

  // 2. Schema validation if a JSON schema is configured for this template.
  let schemaValid: boolean | null = null;
  if (schema && Object.keys(schema).length > 0) {
    const parsed = tryParseJson(input.response);
    schemaValid = parsed === undefined ? false : validate(parsed, schema);
  }

  // 3. Persist trace row. For sync callers, INSERT failure is the only
  // signal that bubbles up as an error — every other step swallows.
  let inserted = false;
  let insertError: unknown = null;
  try {
    await insertTrace({
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
    });
    inserted = true;
  } catch (err) {
    console.warn('[trace-sink] insertTrace failed:',
      (err as Error).message);
    insertError = err;
    // Don't return — still publish metrics from in-memory values.
  }

  // 4. Publish CloudWatch metrics (don't block; let them race).
  const metricCalls: Promise<unknown>[] = [];

  if (judge) {
    metricCalls.push(putQualityMetric(agentId, judge.score));
  }
  if (schemaValid !== null) {
    metricCalls.push(putSchemaMetric(agentId, schemaValid ? 1 : 0));
  }
  if (embedding) {
    // Drift: cosine distance to centroid. If we don't have a centroid yet
    // (cold start), publish 0 so the alarm doesn't fire on no-signal.
    try {
      const centroid = await getCentroid(agentId);
      if (centroid) {
        const dist = cosineDistance(embedding, centroid);
        metricCalls.push(
          putDriftMetric(agentId, templateId ?? 'default', dist),
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
  };
}

// ── Test hooks ────────────────────────────────────────────────────────────────
//
// Exposed for unit tests / forced refresh. Not used in normal operation.

export function _resetCachesForTest(): void {
  _samplingCache.clear();
  _samplingFetchedAt = 0;
  _centroidCache.clear();
}

// `config` isn't strictly needed at runtime here, but importing it eagerly
// triggers .env.aws loading the same way the rest of the providers do.
void config;

export const traceSink = { enqueue, processTrace };
