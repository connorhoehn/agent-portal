// Tool-calls routes — surface per-tool latency, time-series, and error tail
// aggregations from observability.tool_calls.
//
// Mounted at /api/observability/tools BEFORE the gated /api/observability
// router. Same ungated pattern as cost / harness / approvals so internal
// dashboards can hit it without a session cookie.
//
// Endpoints:
//   GET /latency?windowHours=24&agentId=        per-tool aggregate rollup
//   GET /timeseries?windowHours=24&bucketMin=60 bucketed per-tool series
//   GET /errors?limit=50                        most recent errored calls
//
// Aggregations exclude tool calls that belong to test:* template traces — same
// pattern as drift.ts / cost.ts. We exclude via a soft join on
// invocation_traces.template_id so test-only tool calls don't pollute live
// dashboards. Each endpoint degrades to an empty result on any DB error.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { reasonLine } from '../lib/upstream.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockToolErrors,
  mockToolLatency,
  mockToolTimeseries,
} from '../mock/observability-queries.js';

/**
 * Marks a response whose query failed — the wrapper from routes/cost.ts, kept
 * local so each router owns its own copy.
 *
 * Every read below answers 200 with an empty payload rather than failing the
 * page, which is the right call. What it cost was the difference between
 * "nothing happened in this window" and "the query blew up": both rendered as
 * an empty panel. The marker restores it without touching the healthy shape —
 * a quiet window answers exactly as it did before, and only a caught failure
 * carries `degraded` + the first line of the error.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: reasonLine(err) };
}

export const toolCallsRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function clampWindowHours(raw: string | undefined, def = 24, max = 24 * 14): number {
  const n = parseInt(raw ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function clampBucketMin(raw: string | undefined, def = 60, max = 360): number {
  const n = parseInt(raw ?? String(def), 10);
  return Number.isFinite(n) && n >= 5 ? Math.min(n, max) : def;
}

function clampLimit(raw: string | undefined, def = 50, max = 500): number {
  const n = parseInt(raw ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /latency — per-tool aggregate rollup. p50 + p99 duration, error rate,
// total cost. Used by the headline tool-latency panel on the triage page.
// ─────────────────────────────────────────────────────────────────────────────
interface ToolLatencyRow {
  toolName: string;
  count: number;
  p50DurationMs: number | null;
  p99DurationMs: number | null;
  errorRate: number;        // 0..1
  totalCostUsd: number;
  withCost: number;
}

toolCallsRouter.get('/latency', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const agentId = typeof req.query['agentId'] === 'string'
    ? req.query['agentId'].trim()
    : '';

  // Join tool_calls -> invocation_traces so we can filter by template/agent.
  // LEFT JOIN to be lenient on dangling tool_calls (an invocation deletion
  // shouldn't make tool rows vanish). The trace-row filter is in the WHERE.
  const whereClauses: string[] = [
    `tc.ts > now() - (INTERVAL '1 hour' * :hours)`,
    `(it.template_id NOT LIKE 'test:%' OR it.template_id IS NULL)`,
  ];
  const params: SqlParameter[] = [
    { name: 'hours', value: { longValue: windowHours } },
  ];

  if (agentId) {
    whereClauses.push(`it.agent_id = :agent_id`);
    params.push({ name: 'agent_id', value: { stringValue: agentId } });
  }

  const sql = `
    SELECT tc.tool_name                                                    AS tool_name,
           COUNT(*)::bigint                                                AS cnt,
           PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY tc.duration_ms)::float8 AS p50,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY tc.duration_ms)::float8 AS p99,
           AVG(CASE WHEN tc.errored THEN 1.0 ELSE 0.0 END)::float8         AS error_rate,
           COALESCE(SUM(COALESCE(tc.est_cost_usd, 0)), 0)::float8          AS total_cost_usd,
           COUNT(tc.est_cost_usd)::bigint                                  AS with_cost
      FROM observability.tool_calls tc
      LEFT JOIN observability.invocation_traces it
        ON it.invocation_id = tc.invocation_id
     WHERE ${whereClauses.join(' AND ')}
     GROUP BY tc.tool_name
     ORDER BY cnt DESC, tc.tool_name ASC`;

  try {
    const rows = config.mock.aurora
      ? mockToolLatency(windowHours, agentId)
      : await exec(sql, params);
    const byTool: ToolLatencyRow[] = rows.map((r) => ({
      toolName: String(r['tool_name'] ?? ''),
      count: Number(r['cnt'] ?? 0),
      p50DurationMs: r['p50'] == null ? null : Number(r['p50']),
      p99DurationMs: r['p99'] == null ? null : Number(r['p99']),
      errorRate: r['error_rate'] == null ? 0 : Number(r['error_rate']),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
      withCost: Number(r['with_cost'] ?? 0),
    }));
    res.json({ byTool });
  } catch (err) {
    console.warn('[tool-calls] /latency failed:', (err as Error).message);
    res.json(degraded({ byTool: [] as ToolLatencyRow[] }, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /timeseries — bucketed per-tool series. Uses the epoch-floor bucketing
// trick from drift.ts:185-220 so buckets always align to a clean wall-clock
// boundary (e.g. 60-minute buckets land on the top of each hour).
// ─────────────────────────────────────────────────────────────────────────────
interface ToolTimeseriesPoint {
  bucketStart: string;
  toolName: string;
  count: number;
  p99DurationMs: number | null;
  errorRate: number;
  totalCostUsd: number;
}

toolCallsRouter.get('/timeseries', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const bucketMin = clampBucketMin(req.query['bucketMin'] as string | undefined);

  const sql = `
    SELECT to_timestamp(
             floor(EXTRACT(EPOCH FROM tc.ts) / (:bucket * 60))
               * (:bucket * 60)
           )::text                                                          AS bucket_start,
           tc.tool_name                                                    AS tool_name,
           COUNT(*)::bigint                                                AS cnt,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY tc.duration_ms)::float8 AS p99,
           AVG(CASE WHEN tc.errored THEN 1.0 ELSE 0.0 END)::float8         AS error_rate,
           COALESCE(SUM(COALESCE(tc.est_cost_usd, 0)), 0)::float8          AS total_cost_usd
      FROM observability.tool_calls tc
      LEFT JOIN observability.invocation_traces it
        ON it.invocation_id = tc.invocation_id
     WHERE tc.ts > now() - (INTERVAL '1 hour' * :hours)
       AND (it.template_id NOT LIKE 'test:%' OR it.template_id IS NULL)
     GROUP BY bucket_start, tc.tool_name
     ORDER BY bucket_start ASC, tc.tool_name ASC`;

  const params: SqlParameter[] = [
    { name: 'hours',  value: { longValue: windowHours } },
    { name: 'bucket', value: { longValue: bucketMin } },
  ];

  try {
    const rows = config.mock.aurora
      ? mockToolTimeseries(windowHours, bucketMin)
      : await exec(sql, params);
    const points: ToolTimeseriesPoint[] = rows.map((r) => ({
      bucketStart: String(r['bucket_start'] ?? ''),
      toolName: String(r['tool_name'] ?? ''),
      count: Number(r['cnt'] ?? 0),
      p99DurationMs: r['p99'] == null ? null : Number(r['p99']),
      errorRate: r['error_rate'] == null ? 0 : Number(r['error_rate']),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    }));
    res.json({ points, bucketMin, windowHours });
  } catch (err) {
    console.warn('[tool-calls] /timeseries failed:', (err as Error).message);
    res.json(degraded({ points: [] as ToolTimeseriesPoint[], bucketMin, windowHours }, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /errors — most recent errored tool calls. Joined with invocation_traces
// to give the triage UI an agent_id without a second round-trip.
//
// We do NOT exclude test:* here — researchers want to see test errors too
// (they often debug failing test cases via this tail).
// ─────────────────────────────────────────────────────────────────────────────
interface ToolErrorRow {
  toolCallId: string;
  invocationId: string;
  agentId: string;
  toolName: string;
  errorMessage: string | null;
  ts: string;
}

toolCallsRouter.get('/errors', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query['limit'] as string | undefined, 50, 500);

  const sql = `
    SELECT tc.tool_call_id::text                                           AS tool_call_id,
           tc.invocation_id::text                                          AS invocation_id,
           COALESCE(it.agent_id, '')                                       AS agent_id,
           tc.tool_name                                                    AS tool_name,
           tc.error_message                                                AS error_message,
           tc.ts::text                                                     AS ts
      FROM observability.tool_calls tc
      LEFT JOIN observability.invocation_traces it
        ON it.invocation_id = tc.invocation_id
     WHERE tc.errored = true
     ORDER BY tc.ts DESC
     LIMIT :lim`;

  try {
    const rows = config.mock.aurora
      ? mockToolErrors(limit)
      : await exec(sql, [{ name: 'lim', value: { longValue: limit } }]);
    const errors: ToolErrorRow[] = rows.map((r) => ({
      toolCallId: String(r['tool_call_id'] ?? ''),
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      toolName: String(r['tool_name'] ?? ''),
      errorMessage: r['error_message'] == null ? null : String(r['error_message']),
      ts: String(r['ts'] ?? ''),
    }));
    res.json({ errors });
  } catch (err) {
    console.warn('[tool-calls] /errors failed:', (err as Error).message);
    // The most misleading empty in the tree: "no tool errors" is exactly
    // what someone opens this route to confirm.
    res.json(degraded({ errors: [] as ToolErrorRow[] }, err));
  }
}));
