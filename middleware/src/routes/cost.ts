// Cost aggregation routes — surface aggregated $-cost rollups derived from the
// per-row token/cost columns Agent A is adding to
// `observability.invocation_traces` (input_tokens, output_tokens,
// est_cost_usd, judge_cost_usd, total_cost_usd, prompt_version, model_id).
//
// Mounted at /api/observability/cost — see index.ts. Mounted BEFORE the gated
// /api/observability mount so cost telemetry stays accessible to internal
// dashboards on the same authz model as the harness/approvals routes.
//
// All endpoints are defensive: missing cost columns or schema-not-yet-applied
// must yield empty / zero responses, never 500. Each response includes a
// `withCost` count so the UI can warn the user when cost data coverage is
// partial (e.g. "only 67% of invocations have cost data").
//
// Endpoints:
//   GET /total?windowHours=24
//   GET /per-agent?windowHours=24
//   GET /timeseries?windowHours=24&bucketMin=60
//   GET /top?windowHours=24&limit=20
//   GET /by-model?windowHours=24
//   GET /a2a-overhead?windowHours=24       (Sprint 3 M7)
//   GET /value-ratio?windowHours=24        (Sprint 3 M7)
//   GET /deploy-markers?windowHours=168    (Sprint 3 M7)
//   GET /summary?windowHours=24&bucketMin=60&limit=20
//     One-shot envelope over all eight reads above, so a page that renders
//     one dataset stops firing eight independently-polled requests. Each
//     section is fetched with the SAME functions the individual routes call
//     (no duplicated SQL) via Promise.allSettled, so one section's query
//     blowing up cannot fail the other seven — it lands in that section with
//     the route's own `degraded` shape and its name is added to the
//     top-level `degraded` array. `deployMarkers` keeps its own wider
//     default window (168h) independent of the `windowHours` the other seven
//     use, exactly as the individual /deploy-markers route does.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockCostA2AOverhead,
  mockCostByModel,
  mockCostDeployMarkers,
  mockCostPerAgent,
  mockCostTimeseries,
  mockCostTop,
  mockCostTotal,
  mockCostValueRatio,
} from '../mock/observability-queries.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';


/**
 * Marks a response whose query failed.
 *
 * These endpoints deliberately answer 200 with an empty payload rather than
 * failing the page, which is reasonable — but it destroyed the distinction
 * between "no spend in this window" and "the database is gone", and the portal
 * rendered $0.0000 either way. `degraded` restores that distinction without
 * changing any existing field.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'query failed' };
}

export const costRouter = Router();

// Standard window-hours clamp — same shape as drift.ts uses.
function clampWindowHours(raw: string | undefined, defHours = 24, maxHours = 24 * 14): number {
  const n = parseInt(raw ?? String(defHours), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxHours) : defHours;
}

function clampLimit(raw: string | undefined, defLimit = 20, maxLimit = 500): number {
  const n = parseInt(raw ?? String(defLimit), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : defLimit;
}

function clampBucketMin(raw: string | undefined, defBucket = 60, maxBucket = 360): number {
  const n = parseInt(raw ?? String(defBucket), 10);
  return Number.isFinite(n) && n >= 5 ? Math.min(n, maxBucket) : defBucket;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /total — Single-number total cost across the window.
// ─────────────────────────────────────────────────────────────────────────────
interface CostTotalResponse {
  totalCostUsd: number;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  withCost: number;
  windowHours: number;
}

function emptyCostTotal(windowHours: number): CostTotalResponse {
  return { totalCostUsd: 0, invocations: 0, inputTokens: 0, outputTokens: 0, withCost: 0, windowHours };
}

async function fetchCostTotal(windowHours: number): Promise<CostTotalResponse> {
  const sql = `
    SELECT COUNT(*)::bigint                                         AS invocations,
           COUNT(total_cost_usd)::bigint                             AS with_cost,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8     AS total_cost_usd,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint       AS input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint      AS output_tokens
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)`;

  const rows = config.mock.aurora
    ? mockCostTotal(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  const r = rows[0] ?? {};
  return {
    totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    invocations: Number(r['invocations'] ?? 0),
    inputTokens: Number(r['input_tokens'] ?? 0),
    outputTokens: Number(r['output_tokens'] ?? 0),
    withCost: Number(r['with_cost'] ?? 0),
    windowHours,
  };
}

costRouter.get('/total', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  try {
    res.json(await fetchCostTotal(windowHours));
  } catch (err) {
    console.warn('[cost] /total failed:', (err as Error).message);
    res.json(degraded(emptyCostTotal(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /per-agent — Per-agent cost rollup.
// ─────────────────────────────────────────────────────────────────────────────
interface CostPerAgentRow {
  agentId: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  judgeCostUsd: number;
  totalCostUsd: number;
}

interface CostPerAgentResponse {
  byAgent: CostPerAgentRow[];
  withCost: number;
  windowHours: number;
}

function emptyCostPerAgent(windowHours: number): CostPerAgentResponse {
  return { byAgent: [], withCost: 0, windowHours };
}

async function fetchCostPerAgent(windowHours: number): Promise<CostPerAgentResponse> {
  const sql = `
    SELECT agent_id,
           COUNT(*)::bigint                                          AS invocations,
           COUNT(total_cost_usd)::bigint                              AS with_cost,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint        AS input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint       AS output_tokens,
           COALESCE(SUM(COALESCE(est_cost_usd, 0)), 0)::float8        AS est_cost_usd,
           COALESCE(SUM(COALESCE(judge_cost_usd, 0)), 0)::float8      AS judge_cost_usd,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8      AS total_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY agent_id
     ORDER BY total_cost_usd DESC, invocations DESC`;

  const rows = config.mock.aurora
    ? mockCostPerAgent(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  let withCost = 0;
  const byAgent: CostPerAgentRow[] = rows.map((r) => {
    withCost += Number(r['with_cost'] ?? 0);
    return {
      agentId: String(r['agent_id'] ?? 'unknown'),
      invocations: Number(r['invocations'] ?? 0),
      inputTokens: Number(r['input_tokens'] ?? 0),
      outputTokens: Number(r['output_tokens'] ?? 0),
      estCostUsd: r['est_cost_usd'] == null ? 0 : Number(r['est_cost_usd']),
      judgeCostUsd: r['judge_cost_usd'] == null ? 0 : Number(r['judge_cost_usd']),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    };
  });
  return { byAgent, withCost, windowHours };
}

costRouter.get('/per-agent', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  try {
    res.json(await fetchCostPerAgent(windowHours));
  } catch (err) {
    console.warn('[cost] /per-agent failed:', (err as Error).message);
    res.json(degraded(emptyCostPerAgent(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /timeseries — Bucketed cost over time per agent.
//
// Uses the epoch-floor bucket trick from drift.ts:185-220.
// ─────────────────────────────────────────────────────────────────────────────
interface CostTimeseriesPoint {
  bucketStart: string;
  agentId: string;
  invocations: number;
  totalCostUsd: number;
}

interface CostTimeseriesResponse {
  points: CostTimeseriesPoint[];
  withCost: number;
  bucketMin: number;
  windowHours: number;
}

function emptyCostTimeseries(windowHours: number, bucketMin: number): CostTimeseriesResponse {
  return { points: [], withCost: 0, bucketMin, windowHours };
}

async function fetchCostTimeseries(
  windowHours: number,
  bucketMin: number,
  agentId?: string,
): Promise<CostTimeseriesResponse> {
  const whereAgent = agentId ? 'AND agent_id = :agent' : '';
  const sql = `
    SELECT to_timestamp(
             floor(EXTRACT(EPOCH FROM ts) / (:bucket * 60))
               * (:bucket * 60)
           )::text                                                  AS bucket_start,
           agent_id,
           COUNT(*)::bigint                                          AS invocations,
           COUNT(total_cost_usd)::bigint                              AS with_cost,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8      AS total_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
           ${whereAgent}
     GROUP BY bucket_start, agent_id
     ORDER BY bucket_start ASC, agent_id ASC`;

  const params: SqlParameter[] = [
    { name: 'hours',  value: { longValue: windowHours } },
    { name: 'bucket', value: { longValue: bucketMin } },
  ];
  if (agentId) params.push({ name: 'agent', value: { stringValue: agentId } });

  const rows = config.mock.aurora
    ? mockCostTimeseries(windowHours, bucketMin, agentId)
    : await exec(sql, params);
  let withCost = 0;
  const points: CostTimeseriesPoint[] = rows.map((r) => {
    withCost += Number(r['with_cost'] ?? 0);
    return {
      bucketStart: String(r['bucket_start'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      invocations: Number(r['invocations'] ?? 0),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    };
  });
  return { points, withCost, bucketMin, windowHours };
}

costRouter.get('/timeseries', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const bucketMin = clampBucketMin(req.query['bucketMin'] as string | undefined);
  const agentId = (req.query['agentId'] as string | undefined)?.trim();

  try {
    res.json(await fetchCostTimeseries(windowHours, bucketMin, agentId));
  } catch (err) {
    console.warn('[cost] /timeseries failed:', (err as Error).message);
    res.json(degraded(emptyCostTimeseries(windowHours, bucketMin), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /top — Most expensive single invocations.
// ─────────────────────────────────────────────────────────────────────────────
interface CostTopInvocation {
  invocationId: string;
  agentId: string;
  promptSnippet: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  ts: string;
  promptVersion: string | null;
}

interface CostTopResponse {
  invocations: CostTopInvocation[];
  withCost: number;
  windowHours: number;
}

function emptyCostTop(windowHours: number): CostTopResponse {
  return { invocations: [], withCost: 0, windowHours };
}

async function fetchCostTop(windowHours: number, limit: number): Promise<CostTopResponse> {
  // Order by total_cost_usd DESC NULLS LAST so null-cost rows fall to the
  // bottom rather than masking the real top-N. Only rows with a real cost
  // value are interesting in a "most expensive" list.
  const sql = `
    SELECT invocation_id::text                                       AS invocation_id,
           agent_id,
           COALESCE(prompt_snippet, '')                              AS prompt_snippet,
           COALESCE(total_cost_usd, 0)::float8                       AS total_cost_usd,
           COALESCE(input_tokens, 0)::bigint                         AS input_tokens,
           COALESCE(output_tokens, 0)::bigint                        AS output_tokens,
           ts::text                                                  AS ts,
           prompt_version
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
       AND total_cost_usd IS NOT NULL
     ORDER BY total_cost_usd DESC NULLS LAST
     LIMIT :lim`;

  const rows = config.mock.aurora
    ? mockCostTop(windowHours, limit)
    : await exec(sql, [
        { name: 'hours', value: { longValue: windowHours } },
        { name: 'lim',   value: { longValue: limit } },
      ]);
  const invocations: CostTopInvocation[] = rows.map((r) => ({
    invocationId: String(r['invocation_id'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    promptSnippet: String(r['prompt_snippet'] ?? ''),
    totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    inputTokens: Number(r['input_tokens'] ?? 0),
    outputTokens: Number(r['output_tokens'] ?? 0),
    ts: String(r['ts'] ?? ''),
    promptVersion: r['prompt_version'] == null ? null : String(r['prompt_version']),
  }));
  return {
    invocations,
    withCost: invocations.length,
    windowHours,
  };
}

costRouter.get('/top', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const limit = clampLimit(req.query['limit'] as string | undefined, 20, 500);

  try {
    res.json(await fetchCostTop(windowHours, limit));
  } catch (err) {
    console.warn('[cost] /top failed:', (err as Error).message);
    res.json(degraded(emptyCostTop(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /by-model — Per-model cost rollup. Useful when evaluating model swaps.
// ─────────────────────────────────────────────────────────────────────────────
interface CostByModelRow {
  modelId: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

interface CostByModelResponse {
  byModel: CostByModelRow[];
  withCost: number;
  windowHours: number;
}

function emptyCostByModel(windowHours: number): CostByModelResponse {
  return { byModel: [], withCost: 0, windowHours };
}

async function fetchCostByModel(windowHours: number): Promise<CostByModelResponse> {
  // COALESCE model_id → '(unknown)' so older rows without provenance still
  // appear (so total$ across models == total$ for the window). They're easy
  // to filter in the UI if a user wants only labeled rows.
  const sql = `
    SELECT COALESCE(model_id, '(unknown)')                          AS model_id,
           COUNT(*)::bigint                                          AS invocations,
           COUNT(total_cost_usd)::bigint                              AS with_cost,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint        AS input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint       AS output_tokens,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8      AS total_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY COALESCE(model_id, '(unknown)')
     ORDER BY total_cost_usd DESC, invocations DESC`;

  const rows = config.mock.aurora
    ? mockCostByModel(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  let withCost = 0;
  const byModel: CostByModelRow[] = rows.map((r) => {
    withCost += Number(r['with_cost'] ?? 0);
    return {
      modelId: String(r['model_id'] ?? '(unknown)'),
      invocations: Number(r['invocations'] ?? 0),
      inputTokens: Number(r['input_tokens'] ?? 0),
      outputTokens: Number(r['output_tokens'] ?? 0),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    };
  });
  return { byModel, withCost, windowHours };
}

costRouter.get('/by-model', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  try {
    res.json(await fetchCostByModel(windowHours));
  } catch (err) {
    console.warn('[cost] /by-model failed:', (err as Error).message);
    res.json(degraded(emptyCostByModel(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /a2a-overhead — Of total Bedrock cost, what % is supervisor → sub-agent
// invocation overhead (multi-agent topology cost) vs direct user invocations?
//
// A2A invocations are those with parent_invocation_id IS NOT NULL — i.e. spawned
// by another agent rather than initiated directly by a user request.
// ─────────────────────────────────────────────────────────────────────────────
interface CostA2AOverheadResponse {
  totalCostUsd: number;
  a2aCostUsd: number;
  directCostUsd: number;
  a2aFraction: number;
  a2aInvocations: number;
  directInvocations: number;
  windowHours: number;
}

function emptyCostA2AOverhead(windowHours: number): CostA2AOverheadResponse {
  return {
    totalCostUsd: 0,
    a2aCostUsd: 0,
    directCostUsd: 0,
    a2aFraction: 0,
    a2aInvocations: 0,
    directInvocations: 0,
    windowHours,
  };
}

async function fetchCostA2AOverhead(windowHours: number): Promise<CostA2AOverheadResponse> {
  // SUM(...) FILTER (WHERE ...) gives us both branches in a single round-trip
  // without GROUP BY gymnastics. Cost columns may be NULL on older rows — the
  // COALESCE keeps the totals zero-safe.
  const sql = `
    SELECT COUNT(*)::bigint                                            AS total_invocations,
           COUNT(*) FILTER (WHERE parent_invocation_id IS NOT NULL)::bigint    AS a2a_invocations,
           COUNT(*) FILTER (WHERE parent_invocation_id IS NULL)::bigint        AS direct_invocations,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8        AS total_cost_usd,
           COALESCE(SUM(COALESCE(total_cost_usd, 0))
                    FILTER (WHERE parent_invocation_id IS NOT NULL), 0)::float8 AS a2a_cost_usd,
           COALESCE(SUM(COALESCE(total_cost_usd, 0))
                    FILTER (WHERE parent_invocation_id IS NULL), 0)::float8     AS direct_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)`;

  const rows = config.mock.aurora
    ? mockCostA2AOverhead(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  const r = rows[0] ?? {};
  const totalCostUsd = r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']);
  const a2aCostUsd = r['a2a_cost_usd'] == null ? 0 : Number(r['a2a_cost_usd']);
  const directCostUsd = r['direct_cost_usd'] == null ? 0 : Number(r['direct_cost_usd']);
  return {
    totalCostUsd,
    a2aCostUsd,
    directCostUsd,
    a2aFraction: totalCostUsd > 0 ? a2aCostUsd / totalCostUsd : 0,
    a2aInvocations: Number(r['a2a_invocations'] ?? 0),
    directInvocations: Number(r['direct_invocations'] ?? 0),
    windowHours,
  };
}

costRouter.get('/a2a-overhead', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  try {
    res.json(await fetchCostA2AOverhead(windowHours));
  } catch (err) {
    console.warn('[cost] /a2a-overhead failed:', (err as Error).message);
    res.json(degraded(emptyCostA2AOverhead(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /value-ratio — Cost per "good" response per agent.
//
// Defined as: sum(total_cost_usd) / count(*) WHERE judge_score >= 0.7
// Lower is better — agents that produce good answers cheaply.
// ─────────────────────────────────────────────────────────────────────────────
interface CostValueRatioRow {
  agentId: string;
  goodResponses: number;
  goodCostUsd: number;
  costPerGood: number | null;
  totalResponses: number;
  totalCostUsd: number;
  goodRate: number;
}

interface CostValueRatioResponse {
  byAgent: CostValueRatioRow[];
  windowHours: number;
}

function emptyCostValueRatio(windowHours: number): CostValueRatioResponse {
  return { byAgent: [], windowHours };
}

async function fetchCostValueRatio(windowHours: number): Promise<CostValueRatioResponse> {
  // Compute "good" cost+count branches inline using FILTER. costPerGood comes
  // from the client side (null when goodResponses == 0).
  const sql = `
    SELECT agent_id,
           COUNT(*)::bigint                                            AS total_responses,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8        AS total_cost_usd,
           COUNT(*) FILTER (WHERE judge_score >= 0.7)::bigint           AS good_responses,
           COALESCE(SUM(COALESCE(total_cost_usd, 0))
                    FILTER (WHERE judge_score >= 0.7), 0)::float8       AS good_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY agent_id
     ORDER BY agent_id ASC`;

  const rows = config.mock.aurora
    ? mockCostValueRatio(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  const byAgent: CostValueRatioRow[] = rows.map((r) => {
    const totalResponses = Number(r['total_responses'] ?? 0);
    const totalCostUsd = r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']);
    const goodResponses = Number(r['good_responses'] ?? 0);
    const goodCostUsd = r['good_cost_usd'] == null ? 0 : Number(r['good_cost_usd']);
    return {
      agentId: String(r['agent_id'] ?? 'unknown'),
      goodResponses,
      goodCostUsd,
      costPerGood: goodResponses > 0 ? goodCostUsd / goodResponses : null,
      totalResponses,
      totalCostUsd,
      goodRate: totalResponses > 0 ? goodResponses / totalResponses : 0,
    };
  });
  return { byAgent, windowHours };
}

costRouter.get('/value-ratio', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  try {
    res.json(await fetchCostValueRatio(windowHours));
  } catch (err) {
    console.warn('[cost] /value-ratio failed:', (err as Error).message);
    res.json(degraded(emptyCostValueRatio(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /deploy-markers — Prompt-version registration events for overlay on the
// cost-over-time chart. Each marker is a (registeredAt, agentId, promptVersion)
// triple from observability.prompt_versions, scoped to the same window.
// ─────────────────────────────────────────────────────────────────────────────
interface CostDeployMarker {
  promptVersion: string;
  agentId: string;
  registeredAt: string;
  notes: string | null;
}

interface CostDeployMarkersResponse {
  markers: CostDeployMarker[];
  windowHours: number;
}

function emptyCostDeployMarkers(windowHours: number): CostDeployMarkersResponse {
  return { markers: [], windowHours };
}

async function fetchCostDeployMarkers(windowHours: number): Promise<CostDeployMarkersResponse> {
  const sql = `
    SELECT prompt_version,
           agent_id,
           registered_at::text       AS registered_at,
           notes
      FROM observability.prompt_versions
     WHERE registered_at > now() - (INTERVAL '1 hour' * :hours)
     ORDER BY registered_at ASC`;

  const rows = config.mock.aurora
    ? mockCostDeployMarkers(windowHours)
    : await exec(sql, [{ name: 'hours', value: { longValue: windowHours } }]);
  const markers: CostDeployMarker[] = rows.map((r) => ({
    promptVersion: String(r['prompt_version'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    registeredAt: String(r['registered_at'] ?? ''),
    notes: r['notes'] == null ? null : String(r['notes']),
  }));
  return { markers, windowHours };
}

costRouter.get('/deploy-markers', asyncHandler(async (req, res) => {
  // Default to a 7-day window — deploy markers are sparse, so a wider lookback
  // is more useful when the user picks a tight cost window.
  const windowHours = clampWindowHours(
    req.query['windowHours'] as string | undefined,
    168,
    24 * 30,
  );

  try {
    res.json(await fetchCostDeployMarkers(windowHours));
  } catch (err) {
    console.warn('[cost] /deploy-markers failed:', (err as Error).message);
    res.json(degraded(emptyCostDeployMarkers(windowHours), err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /summary — All eight sections above in one envelope.
//
// The portal's CostPage fired all eight (seven on the primary window, one
// pinned to a 168h deploy-marker lookback) every 30s for what is one
// dataset. This composes the SAME fetch functions the individual routes call
// via Promise.allSettled: one section failing marks it `degraded` in the
// envelope rather than taking the other seven down with it (matching how a
// single route already answers 200 + degraded rather than 500).
// `deployMarkers` keeps its own default 168h/30d-cap window, independent of
// `windowHours`, exactly like GET /deploy-markers does on its own.
// ─────────────────────────────────────────────────────────────────────────────
interface CostSummaryResponse {
  windowHours: number;
  sections: {
    total: CostTotalResponse;
    perAgent: CostPerAgentResponse;
    timeseries: CostTimeseriesResponse;
    top: CostTopResponse;
    byModel: CostByModelResponse;
    a2aOverhead: CostA2AOverheadResponse;
    valueRatio: CostValueRatioResponse;
    deployMarkers: CostDeployMarkersResponse;
  };
  degraded: string[];
}

costRouter.get('/summary', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const bucketMin = clampBucketMin(req.query['bucketMin'] as string | undefined);
  const limit = clampLimit(req.query['limit'] as string | undefined, 20, 500);
  const agentId = (req.query['agentId'] as string | undefined)?.trim();
  const deployWindowHours = clampWindowHours(
    req.query['deployWindowHours'] as string | undefined,
    168,
    24 * 30,
  );

  const sections = [
    { name: 'total' as const, run: () => fetchCostTotal(windowHours), empty: emptyCostTotal(windowHours) },
    { name: 'perAgent' as const, run: () => fetchCostPerAgent(windowHours), empty: emptyCostPerAgent(windowHours) },
    {
      name: 'timeseries' as const,
      run: () => fetchCostTimeseries(windowHours, bucketMin, agentId),
      empty: emptyCostTimeseries(windowHours, bucketMin),
    },
    { name: 'top' as const, run: () => fetchCostTop(windowHours, limit), empty: emptyCostTop(windowHours) },
    { name: 'byModel' as const, run: () => fetchCostByModel(windowHours), empty: emptyCostByModel(windowHours) },
    {
      name: 'a2aOverhead' as const,
      run: () => fetchCostA2AOverhead(windowHours),
      empty: emptyCostA2AOverhead(windowHours),
    },
    {
      name: 'valueRatio' as const,
      run: () => fetchCostValueRatio(windowHours),
      empty: emptyCostValueRatio(windowHours),
    },
    {
      name: 'deployMarkers' as const,
      run: () => fetchCostDeployMarkers(deployWindowHours),
      empty: emptyCostDeployMarkers(deployWindowHours),
    },
  ];

  const results = await Promise.allSettled(sections.map((s) => s.run()));
  const degradedNames: string[] = [];
  const out = {} as CostSummaryResponse['sections'];
  results.forEach((r, i) => {
    const s = sections[i]!;
    if (r.status === 'fulfilled') {
      (out as Record<string, unknown>)[s.name] = r.value;
    } else {
      console.warn(`[cost] /summary section "${s.name}" failed:`, (r.reason as Error).message);
      (out as Record<string, unknown>)[s.name] = degraded(s.empty, r.reason);
      degradedNames.push(s.name);
    }
  });

  const out2: CostSummaryResponse = { windowHours, sections: out, degraded: degradedNames };
  res.json(out2);
}));
