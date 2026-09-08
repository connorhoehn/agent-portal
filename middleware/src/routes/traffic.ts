// Traffic shape routes — RPS, hour-of-week heatmap, top users, per-agent
// summary. Researchers + ops use this to answer "where is the load going?
// who's hitting us hardest? when do the spikes happen?".
//
// Mounted at /api/observability/traffic BEFORE the gated /api/observability
// router (see index.ts). Same pattern as cost / oncall / invocations: ungated
// so internal dashboards hit it without a session cookie.
//
// All endpoints filter out test rows (template_id LIKE 'test:%') and follow
// drift.ts/cost.ts patterns: bound parameters, COALESCE/SUM zero-safe maths,
// defensive empty-state returns on any DB failure.
//
// Endpoints:
//   GET /rps?windowHours=24&bucketMin=5         — per-agent invocation buckets
//   GET /heatmap?days=7                          — 7×24 hour-of-week grid
//   GET /top-users?windowHours=24&limit=10       — biggest user_id offenders
//   GET /per-agent-summary?windowHours=24        — RPS / p99 / err / cost rollup

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockTrafficHeatmap,
  mockTrafficPerAgentSummary,
  mockTrafficRps,
  mockTrafficTopUsers,
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
  return { ...body, degraded: true, error: (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'query failed' };
}

export const trafficRouter = Router();

// ── clamps (mirrors cost.ts) ────────────────────────────────────────────────

function clampWindowHours(raw: string | undefined, defHours = 24, maxHours = 24 * 30): number {
  const n = parseInt(raw ?? String(defHours), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxHours) : defHours;
}

function clampBucketMin(raw: string | undefined, defBucket = 5, maxBucket = 360): number {
  const n = parseInt(raw ?? String(defBucket), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, maxBucket) : defBucket;
}

function clampLimit(raw: string | undefined, defLimit = 10, maxLimit = 200): number {
  const n = parseInt(raw ?? String(defLimit), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : defLimit;
}

function clampDays(raw: string | undefined, defDays = 7, maxDays = 30): number {
  const n = parseInt(raw ?? String(defDays), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxDays) : defDays;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /rps — invocations per bucket per agent, plus unique users/sessions.
//
// Uses the epoch-floor bucket trick from drift.ts:185-220.
// ─────────────────────────────────────────────────────────────────────────────
interface RpsPoint {
  bucketStart: string;
  agentId: string;
  invocations: number;
  uniqueUsers: number;
  uniqueSessions: number;
}

interface RpsResponse {
  points: RpsPoint[];
  bucketMin: number;
  windowHours: number;
}

trafficRouter.get('/rps', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const bucketMin = clampBucketMin(req.query['bucketMin'] as string | undefined);

  const sql = `
    SELECT to_timestamp(
             floor(EXTRACT(EPOCH FROM ts) / (:bucket * 60))
               * (:bucket * 60)
           )::text                                                  AS bucket_start,
           agent_id,
           COUNT(*)::bigint                                          AS invocations,
           COUNT(DISTINCT user_id)::bigint                           AS unique_users,
           COUNT(DISTINCT session_id)::bigint                        AS unique_sessions
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY bucket_start, agent_id
     ORDER BY bucket_start ASC, agent_id ASC`;

  try {
    const rows = config.mock.aurora
      ? mockTrafficRps(windowHours, bucketMin)
      : await exec(sql, [
          { name: 'hours',  value: { longValue: windowHours } },
          { name: 'bucket', value: { longValue: bucketMin } },
        ]);
    const points: RpsPoint[] = rows.map((r) => ({
      bucketStart: String(r['bucket_start'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      invocations: Number(r['invocations'] ?? 0),
      uniqueUsers: Number(r['unique_users'] ?? 0),
      uniqueSessions: Number(r['unique_sessions'] ?? 0),
    }));
    const out: RpsResponse = { points, bucketMin, windowHours };
    res.json(out);
  } catch (err) {
    console.warn('[traffic] /rps failed:', (err as Error).message);
    res.json(degraded({ points: [], bucketMin, windowHours } satisfies RpsResponse, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /heatmap — 7-day × 24-hour grid (Mon=1..Sun=0 in Postgres DOW).
//
// Each cell is the total invocation count in that (dayOfWeek, hourOfDay) over
// the last `days` days, ignoring test rows. Useful for "spot the Monday 9am
// spike" patterns.
// ─────────────────────────────────────────────────────────────────────────────
interface HeatmapCell {
  dayOfWeek: number;   // 0=Sun..6=Sat (Postgres date_part('dow'))
  hourOfDay: number;   // 0..23
  count: number;
}

interface HeatmapResponse {
  cells: HeatmapCell[];
  days: number;
}

trafficRouter.get('/heatmap', asyncHandler(async (req, res) => {
  const days = clampDays(req.query['days'] as string | undefined);

  // We project rows into (dow, hour) buckets server-side. Cells with zero
  // count are NOT emitted — the client fills in the grid.
  const sql = `
    SELECT date_part('dow',  ts)::int  AS dow,
           date_part('hour', ts)::int  AS hod,
           COUNT(*)::bigint             AS cnt
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 day' * :days)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY dow, hod
     ORDER BY dow ASC, hod ASC`;

  try {
    const rows = config.mock.aurora
      ? mockTrafficHeatmap(days)
      : await exec(sql, [{ name: 'days', value: { longValue: days } }]);
    const cells: HeatmapCell[] = rows.map((r) => ({
      dayOfWeek: Number(r['dow'] ?? 0),
      hourOfDay: Number(r['hod'] ?? 0),
      count: Number(r['cnt'] ?? 0),
    }));
    const out: HeatmapResponse = { cells, days };
    res.json(out);
  } catch (err) {
    console.warn('[traffic] /heatmap failed:', (err as Error).message);
    res.json(degraded({ cells: [], days } satisfies HeatmapResponse, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /top-users — N biggest user_ids by invocation count over the window.
//
// Skips rows with NULL user_id. Includes cost + uniqueAgents touched so a
// single power-user can be triaged without leaving the page.
// ─────────────────────────────────────────────────────────────────────────────
interface TopUserRow {
  userId: string;
  invocations: number;
  uniqueAgents: number;
  totalCostUsd: number;
  lastSeenAt: string;
}

interface TopUsersResponse {
  users: TopUserRow[];
  windowHours: number;
}

trafficRouter.get('/top-users', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);
  const limit = clampLimit(req.query['limit'] as string | undefined, 10, 200);

  const sql = `
    SELECT user_id,
           COUNT(*)::bigint                                          AS invocations,
           COUNT(DISTINCT agent_id)::bigint                          AS unique_agents,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8     AS total_cost_usd,
           MAX(ts)::text                                              AS last_seen_at
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
       AND user_id IS NOT NULL
       AND length(trim(user_id)) > 0
     GROUP BY user_id
     ORDER BY invocations DESC, total_cost_usd DESC
     LIMIT :lim`;

  try {
    const rows = config.mock.aurora
      ? mockTrafficTopUsers(windowHours, limit)
      : await exec(sql, [
          { name: 'hours', value: { longValue: windowHours } },
          { name: 'lim',   value: { longValue: limit } },
        ]);
    const users: TopUserRow[] = rows.map((r) => ({
      userId: String(r['user_id'] ?? ''),
      invocations: Number(r['invocations'] ?? 0),
      uniqueAgents: Number(r['unique_agents'] ?? 0),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
      lastSeenAt: String(r['last_seen_at'] ?? ''),
    }));
    const out: TopUsersResponse = { users, windowHours };
    res.json(out);
  } catch (err) {
    console.warn('[traffic] /top-users failed:', (err as Error).message);
    res.json(degraded({ users: [], windowHours } satisfies TopUsersResponse, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /per-agent-summary — RPS, p50/p99 latency, error rate, cost per agent.
//
// Error rate = fraction of rows that actually FAILED — a guardrail intervention
// (guardrail_action present and not 'NONE') or non-conforming output
// (schema_valid = false). This matches the error proxy the canary rollup view
// uses (observability.v_canary_score_by_version_5m) — invocation_traces has no
// dedicated error column yet, so these two are the honest stand-ins.
//
// A low judge score is NOT an error: it's a poor-quality *answer* to a request
// that otherwise succeeded, so it's surfaced separately as lowQualityRate
// (judge_score < 0.3) rather than folded into errorRate. Conflating the two
// made a fleet look broken when it was merely giving weak answers.
//
// Latency uses Postgres' PERCENTILE_CONT.
// ─────────────────────────────────────────────────────────────────────────────
interface PerAgentSummaryRow {
  agentId: string;
  invocations: number;
  rps: number;
  p50DurationMs: number | null;
  p99DurationMs: number | null;
  errorRate: number;
  lowQualityRate: number;
  totalCostUsd: number;
}

interface PerAgentSummaryResponse {
  byAgent: PerAgentSummaryRow[];
  windowHours: number;
}

trafficRouter.get('/per-agent-summary', asyncHandler(async (req, res) => {
  const windowHours = clampWindowHours(req.query['windowHours'] as string | undefined);

  const sql = `
    SELECT agent_id,
           COUNT(*)::bigint                                          AS invocations,
           PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p99,
           COUNT(*) FILTER (
             WHERE (guardrail_action IS NOT NULL AND guardrail_action <> 'NONE')
                OR schema_valid = false
           )::bigint                                                  AS error_count,
           COUNT(*) FILTER (
             WHERE judge_score IS NOT NULL AND judge_score < 0.3
           )::bigint                                                  AS low_quality_count,
           COALESCE(SUM(COALESCE(total_cost_usd, 0)), 0)::float8     AS total_cost_usd
      FROM observability.invocation_traces
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
     GROUP BY agent_id
     ORDER BY invocations DESC, agent_id ASC`;

  const params: SqlParameter[] = [
    { name: 'hours', value: { longValue: windowHours } },
  ];

  const windowSeconds = windowHours * 3600;

  try {
    const rows = config.mock.aurora
      ? mockTrafficPerAgentSummary(windowHours)
      : await exec(sql, params);
    const byAgent: PerAgentSummaryRow[] = rows.map((r) => {
      const invocations = Number(r['invocations'] ?? 0);
      const errorCount = Number(r['error_count'] ?? 0);
      const lowQualityCount = Number(r['low_quality_count'] ?? 0);
      return {
        agentId: String(r['agent_id'] ?? 'unknown'),
        invocations,
        rps: windowSeconds > 0 ? invocations / windowSeconds : 0,
        p50DurationMs: r['p50'] == null ? null : Number(r['p50']),
        p99DurationMs: r['p99'] == null ? null : Number(r['p99']),
        errorRate: invocations > 0 ? errorCount / invocations : 0,
        lowQualityRate: invocations > 0 ? lowQualityCount / invocations : 0,
        totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
      };
    });
    const out: PerAgentSummaryResponse = { byAgent, windowHours };
    res.json(out);
  } catch (err) {
    console.warn('[traffic] /per-agent-summary failed:', (err as Error).message);
    res.json(degraded({ byAgent: [], windowHours } satisfies PerAgentSummaryResponse, err));
  }
}));
