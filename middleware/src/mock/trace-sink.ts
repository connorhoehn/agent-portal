// What `lib/trace-sink.ts` writes when there is no Aurora — the offline
// `observability.*` write side.
//
// WHY THIS EXISTS. `processTrace` is the sink both the CloudWatch log poller
// and every agent's `ORGIQ_TRACE:` line feed. Offline it reached Aurora at six
// places (`loadSamplingConfig`, `getCentroid`, `insertTrace`, `insertToolCalls`,
// `insertMemoryEvents`, `insertGuardrailInterventions`), Bedrock at two
// (`embedText`, `judgeResponse`) and CloudWatch at one — so `POST
// /api/observability/harness/trace` and `POST /api/observability/invocations/
// :id/replay` both 500'd in `dev:mock`, and the two rules this pipeline exists
// to enforce — sampling, and the phantom-row drop — could not be exercised at
// all. Nine unmocked leaves on each of two routes, and no test could reach
// either rule.
//
// WHAT IS AND IS NOT HERE. These fixtures are the WRITE side: rows this process
// has actually written this run, empty until something writes one. They are
// deliberately NOT the seeded day of traffic — `mock/observability.ts`'s
// `traceRows()` is that, derived from `mock/invocations.ts`.
//
// THE TWO ARE NOW ONE READ. They used to be two worlds that never met: a trace
// posted offline landed here, was judged, was visible in `GET /api/__mock/state`
// and readable by id from `POST /results/:id/rejudge` — and was absent from the
// Invocations list and from every rollup, because those read `traceRows()` and
// `traceRows()` could not see this. That is the count-vs-list defect
// (contract.ts bug #1) in its widest form: two views of one table disagreeing,
// with nothing saying so. `traceRows()` now returns the seeded corpus with
// these rows layered on top of it, so a trace that exists is a trace the list
// shows. The rules that union follows — what it preserves, and why a written
// row's tool calls, fired rules and memory events come from the fixtures below
// rather than being synthesised — are stated at `traceRows()`.
//
// The rows here stay snake_case and stay in `exec()` shape, so the union is a
// projection and not a translation.
//
// Everything countable is a selector. There is no stored row count, no stored
// mean judge score and no stored centroid: `sinkCentroid` averages the vectors
// on the rows, honouring the same window, the same trust filter and the same
// minimum-sample floor the SQL does, so a mock centroid can never claim a
// window the rows do not support.

import { clock, defineFixture, type ScenarioName } from './core/index.js';

// ─── sampling_config ────────────────────────────────────────────────────────

/**
 * `schema/observability_schema.sql` seeds exactly one row, `('default', 1.0)`,
 * with the comment "Sample every trace by default. A 0.1 rate was silently
 * dropping 90% of invocations in this lab". This mirrors that row rather than
 * inventing a rate, and it is a named constant rather than a literal because a
 * literal `rate: 1.0` beside rows is the shape rule 1 forbids — even where, as
 * here, it is a configured rate and not a counted one.
 */
const SAMPLE_EVERYTHING = 1;

/** One row of `observability.sampling_config`, in the shape `exec()` returns. */
export interface SinkSamplingRow {
  template_id: string;
  rate: number;
  schema_json: string | null;
}

/**
 * Sampling configuration.
 *
 * `empty` — the table has no rows at all, so `decideSampling` falls back to its
 *           hard-coded 0.1 and nine traces in ten are dropped before any embed,
 *           judge or INSERT happens. That fallback is a real branch with real
 *           consequences (it is the one that made this lab's observability
 *           pages look broken) and until this fixture existed there was no way
 *           to stand in front of it offline. Ask for it:
 *           `POST /api/__mock/scenario {"scenario":"empty","fixture":"trace-sink-sampling"}`.
 */
export const sinkSamplingConfig = defineFixture<SinkSamplingRow>({
  key: 'trace-sink-sampling',
  scenarios: {
    default: () => [{ template_id: 'default', rate: SAMPLE_EVERYTHING, schema_json: null }],
    empty: () => [],
  },
});

// ─── invocation_traces ──────────────────────────────────────────────────────

/**
 * One row of `observability.invocation_traces` as the sink writes it —
 * snake_case, the nullability the schema declares, and the vector kept as
 * numbers rather than the pgvector text literal because the only offline reader
 * (`sinkCentroid`) wants to average it.
 */
export interface SinkTraceRow {
  invocation_id: string;
  agent_id: string;
  agent_name: string;
  template_id: string | null;
  prompt_snippet: string;
  response_snippet: string;
  output_embedding: number[] | null;
  judge_score: number | null;
  judge_rationale: string | null;
  schema_valid: boolean | null;
  pii_detected: boolean;
  guardrail_action: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  judge_input_tokens: number | null;
  judge_output_tokens: number | null;
  est_cost_usd: number | null;
  judge_cost_usd: number | null;
  total_cost_usd: number | null;
  prompt_version: string | null;
  model_id: string | null;
  runtime_image_digest: string | null;
  parent_invocation_id: string | null;
  user_id: string | null;
  session_id: string | null;
  ts: string;
}

/**
 * Traces this process has written.
 *
 * `default` is EMPTY, and that is the honest seed: the sink has written nothing
 * until something posts a trace. A fixture that seeded rows here would claim
 * the pipeline had run when it had not, and would double-count against the
 * seeded corpus in `mock/observability.ts` that every read surface already
 * counts.
 */
export const sinkTraces = defineFixture<SinkTraceRow>({
  key: 'trace-sink-traces',
  scenarios: { default: () => [] },
});

/**
 * The write, with the statement's own conflict rule.
 *
 * `insertTrace` ends `ON CONFLICT (invocation_id) DO NOTHING`, so a retry storm
 * that re-posts the same id must leave the FIRST row standing. Returning
 * whether the row was taken is what lets `processTrace` report `inserted`
 * truthfully instead of assuming the write landed.
 */
export function insertSinkTrace(row: SinkTraceRow): boolean {
  const rows = sinkTraces.rows();
  if (rows.some((r) => r.invocation_id === row.invocation_id)) return false;
  rows.push(row);
  return true;
}

/** One trace by id, for the read-back paths (`/results/:id/rejudge`). */
export function sinkTraceById(invocationId: string): SinkTraceRow | null {
  return sinkTraces.rows().find((r) => r.invocation_id === invocationId) ?? null;
}

/**
 * The mean of an agent's written vectors — `AVG(output_embedding)` with no
 * window and no floor, which is the centroid the DRIFT queries subquery
 * (`routes/drift.ts`: `SELECT agent_id, AVG(output_embedding) AS centroid`).
 *
 * Deliberately not `sinkCentroid` above. That one mirrors `getCentroid`, a
 * different statement with a 24-hour lookback, a trust floor and a five-sample
 * minimum, and it exists so the sink refuses to publish a drift metric it
 * cannot support. This one exists so a written row can be given the distance
 * the drift PAGE would compute for it, which is defined over one row.
 * Collapsing the two would make one of the surfaces wrong.
 */
export function sinkAgentCentroid(agentId: string, scenario?: ScenarioName): number[] | null {
  const vectors = sinkTraces
    .rows(scenario)
    .filter((r) => r.agent_id === agentId && r.output_embedding)
    .map((r) => r.output_embedding!);
  return meanVector(vectors);
}

/** The element-wise mean, or null when there is nothing (or nothing consistent) to average. */
function meanVector(vectors: readonly number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const width = vectors[0]?.length ?? 0;
  if (width === 0) return null;
  const out = new Array<number>(width).fill(0);
  for (const v of vectors) {
    if (v.length !== width) return null;
    for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  }
  for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) / vectors.length;
  return out;
}

/**
 * pgvector's `<=>` — cosine distance, `1 - cos(a, b)`.
 *
 * A SECOND COPY OF `lib/embedding.ts`'s `cosineDistance`, deliberately, and
 * held to it by `__tests__/trace-sink-union.test.ts` which runs both over the
 * same vectors and fails if they ever disagree. The reason for the copy is that
 * `lib/embedding.ts` imports `src/config.ts` at module scope, and a fixture
 * module has to be loadable with no application config at all — every mock test
 * that does not mock `config.js` would fail to compile the moment this
 * directory reached into `src/lib` for arithmetic. Behaviour is matched clause
 * for clause, degenerate cases included: mismatched or empty vectors and a
 * zero-magnitude vector all answer 1, the maximum distance, because there is no
 * angle between them to measure.
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  const sim = dot / denom;
  // Numerical drift can push sim slightly outside [-1, 1].
  const clamped = sim > 1 ? 1 : sim < -1 ? -1 : sim;
  return 1 - clamped;
}

/**
 * The centroid of an agent's recent trusted embeddings, or null.
 *
 * Mirrors the SQL in `getCentroid` clause for clause: same agent, embedding not
 * null, inside the lookback window, `judge_score IS NULL OR judge_score >= 0.6`,
 * and null unless at least `minSamples` rows qualify. Not a stored vector: a
 * centroid written beside the rows it averages is rule 1 in vector form.
 */
export function sinkCentroid(
  agentId: string,
  minSamples: number,
  lookbackHours: number,
  trustFloor: number,
): number[] | null {
  const cutoff = clock.now().getTime() - lookbackHours * 3600_000;
  const vectors: number[][] = [];
  for (const r of sinkTraces.rows()) {
    if (r.agent_id !== agentId) continue;
    if (!r.output_embedding) continue;
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at) || at <= cutoff) continue;
    if (r.judge_score !== null && r.judge_score < trustFloor) continue;
    vectors.push(r.output_embedding);
  }
  if (vectors.length < minSamples) return null;
  const width = vectors[0]?.length ?? 0;
  if (width === 0) return null;
  const out = new Array<number>(width).fill(0);
  for (const v of vectors) {
    if (v.length !== width) return null;
    for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  }
  for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) / vectors.length;
  return out;
}

// ─── tool_calls ─────────────────────────────────────────────────────────────

/** One row of `observability.tool_calls`. */
export interface SinkToolCallRow {
  invocation_id: string;
  tool_name: string;
  started_at: string;
  duration_ms: number | null;
  input_size: number | null;
  output_size: number | null;
  errored: boolean;
  error_message: string | null;
  input_sample: string | null;
  output_sample: string | null;
  est_cost_usd: number | null;
}

export const sinkToolCalls = defineFixture<SinkToolCallRow>({
  key: 'trace-sink-tool-calls',
  scenarios: { default: () => [] },
});

// ─── memory_events ──────────────────────────────────────────────────────────

/** One row of `observability.memory_events`. */
export interface SinkMemoryEventRow {
  invocation_id: string;
  agent_id: string;
  session_id: string | null;
  kind: string;
  memory_id: string | null;
  query_text: string | null;
  result_count: number | null;
  duration_ms: number | null;
  retrieved_summary: string | null;
  errored: boolean;
  error_message: string | null;
}

export const sinkMemoryEvents = defineFixture<SinkMemoryEventRow>({
  key: 'trace-sink-memory-events',
  scenarios: { default: () => [] },
});

// ─── guardrail_interventions ────────────────────────────────────────────────

/** One row of `observability.guardrail_interventions`. */
export interface SinkGuardrailRow {
  invocation_id: string;
  agent_id: string;
  rule_name: string;
  rule_category: string | null;
  severity: string | null;
  action: string;
  matched_text: string | null;
}

export const sinkGuardrailInterventions = defineFixture<SinkGuardrailRow>({
  key: 'trace-sink-guardrail-interventions',
  scenarios: { default: () => [] },
});

// ─── published metrics ──────────────────────────────────────────────────────

/**
 * A datapoint the sink would have published to CloudWatch.
 *
 * Kept because step 4 of the pipeline is otherwise unobservable offline: with
 * the metric calls simply skipped, "the sink judged and stored the row but
 * published nothing" and "the sink ran to completion" look identical. The
 * metric NAMES are the ones `providers/cloudwatch.ts` publishes
 * (`JudgeScore`, `SchemaConformance`, `EmbeddingDriftP95`) — copied from that
 * module, never typed from memory.
 */
export interface SinkMetricRow {
  metric_name: 'JudgeScore' | 'SchemaConformance' | 'EmbeddingDriftP95';
  agent_id: string;
  template_id: string | null;
  value: number;
  ts: string;
}

export const sinkMetrics = defineFixture<SinkMetricRow>({
  key: 'trace-sink-metrics',
  scenarios: { default: () => [] },
});

export function recordSinkMetric(
  metricName: SinkMetricRow['metric_name'],
  agentId: string,
  value: number,
  templateId?: string | null,
): void {
  sinkMetrics.rows().push({
    metric_name: metricName,
    agent_id: agentId || 'unknown',
    template_id: templateId ?? null,
    value,
    ts: clock.nowIso(),
  });
}

/** Datapoints published for one agent — a selector, for tests and audits. */
export function sinkMetricsFor(agentId: string): SinkMetricRow[] {
  return sinkMetrics.rows().filter((r) => r.agent_id === agentId);
}
