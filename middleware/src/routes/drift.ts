// Drift routes — surface the observability data plane to the portal.
//
// Mounted at /api/observability/drift (see routes/observability.ts).
//
//   GET /summary?windowHours=1   → per-agent rollup of count, schema
//                                  conformance, p50/p05 judge score, p95
//                                  embedding drift.
//   GET /outliers?agentId=&limit → top-N rows in the last 1h ordered by
//                                  cosine distance to the per-agent centroid.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { EMBEDDING_DIMENSIONS } from '../lib/embedding.js';

export const driftRouter = Router();

interface DriftSummaryRow {
  agentId: string;
  count: number;
  schemaConformance: number;     // 0..1 (avg over schema_valid)
  judgeP50: number | null;       // median judge_score
  judgeP05: number | null;       // 5th percentile judge_score (worst tail)
  embeddingDriftP95: number;     // p95 cosine distance to per-agent centroid
}

driftRouter.get('/summary', asyncHandler(async (req, res) => {
  const raw = parseInt((req.query['windowHours'] as string) ?? '1', 10);
  const windowHours = Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 24 * 7)
    : 1;

  // Aggregate everything in a single round-trip. p95 drift is computed as the
  // 95th percentile of (1 - cosine_similarity(embedding, centroid)) where the
  // centroid is `avg(output_embedding)` over the same window.
  //
  // pgvector's `<=>` operator returns cosine distance directly, so we just
  // subquery the centroid.
  const sql = `
    WITH window_rows AS (
      SELECT *
        FROM observability.invocation_traces
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
         AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
    ),
    centroids AS (
      SELECT agent_id,
             AVG(output_embedding) AS centroid
        FROM window_rows
       WHERE output_embedding IS NOT NULL
         AND (judge_score IS NULL OR judge_score >= 0.6)
       GROUP BY agent_id
    ),
    distances AS (
      SELECT w.agent_id,
             (w.output_embedding <=> c.centroid)::float8 AS dist
        FROM window_rows w
        JOIN centroids c USING (agent_id)
       WHERE w.output_embedding IS NOT NULL
    )
    SELECT w.agent_id AS agent_id,
           COUNT(*)::bigint AS cnt,
           AVG(CASE WHEN w.schema_valid IS NULL THEN NULL
                    WHEN w.schema_valid THEN 1.0 ELSE 0.0 END)::float8 AS conformance,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p50,
           PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p05,
           COALESCE(
             (SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY d.dist)::float8
                FROM distances d WHERE d.agent_id = w.agent_id),
             0
           ) AS drift_p95
      FROM window_rows w
     GROUP BY w.agent_id
     ORDER BY cnt DESC`;

  try {
    const rows = await exec(sql, [
      { name: 'hours', value: { longValue: windowHours } },
    ]);
    const out: DriftSummaryRow[] = rows.map((r) => ({
      agentId: String(r['agent_id'] ?? 'unknown'),
      count: Number(r['cnt'] ?? 0),
      schemaConformance: r['conformance'] == null ? 1 : Number(r['conformance']),
      judgeP50: r['p50'] == null ? null : Number(r['p50']),
      judgeP05: r['p05'] == null ? null : Number(r['p05']),
      embeddingDriftP95: r['drift_p95'] == null ? 0 : Number(r['drift_p95']),
    }));
    res.json(out);
  } catch (err) {
    console.warn('[drift] /summary failed:', (err as Error).message);
    // Empty array — the portal renders an empty state without breaking.
    res.json([]);
  }
}));

interface DriftOutlierRow {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  distance: number;
  ts: string;
}

driftRouter.get('/outliers', asyncHandler(async (req, res) => {
  const agentId = (req.query['agentId'] as string | undefined)?.trim();
  const rawLimit = parseInt((req.query['limit'] as string) ?? '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 500)
    : 50;

  // Compute per-row distance to the agent's centroid in the last 1h.
  // Agent filter is optional — without it we rank globally across all agents.
  const whereAgent = agentId ? 'AND w.agent_id = :agent' : '';
  const sql = `
    WITH window_rows AS (
      SELECT *
        FROM observability.invocation_traces
       WHERE ts > now() - INTERVAL '1 hour'
         AND output_embedding IS NOT NULL
         AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
    ),
    centroids AS (
      SELECT agent_id, AVG(output_embedding) AS centroid
        FROM window_rows
       WHERE (judge_score IS NULL OR judge_score >= 0.6)
       GROUP BY agent_id
    )
    SELECT w.invocation_id::text AS invocation_id,
           w.agent_id, w.agent_name, w.template_id,
           w.prompt_snippet, w.response_snippet,
           w.judge_score, w.judge_rationale, w.schema_valid,
           (w.output_embedding <=> c.centroid)::float8 AS dist,
           w.ts
      FROM window_rows w
      JOIN centroids c USING (agent_id)
     WHERE 1=1 ${whereAgent}
     ORDER BY dist DESC
     LIMIT :lim`;

  const params: import('@aws-sdk/client-rds-data').SqlParameter[] = [
    { name: 'lim', value: { longValue: limit } },
  ];
  if (agentId) params.push({ name: 'agent', value: { stringValue: agentId } });

  try {
    const rows = await exec(sql, params);
    const out: DriftOutlierRow[] = rows.map((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      agentName: String(r['agent_name'] ?? ''),
      templateId: r['template_id'] == null ? null : String(r['template_id']),
      promptSnippet: String(r['prompt_snippet'] ?? ''),
      responseSnippet: String(r['response_snippet'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      judgeRationale: r['judge_rationale'] == null ? null : String(r['judge_rationale']),
      schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
      distance: r['dist'] == null ? 0 : Number(r['dist']),
      ts: String(r['ts'] ?? ''),
    }));
    res.json({ outliers: out });
  } catch (err) {
    console.warn('[drift] /outliers failed:', (err as Error).message);
    res.json({ outliers: [] });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Time-series drift — bucketed P95 cosine distance over a longer window.
// Researchers use this to see *when* drift started, not just the headline P95.
// ─────────────────────────────────────────────────────────────────────────────
interface DriftTimePoint {
  bucketStart: string;       // ISO timestamp of bucket start
  agentId: string;
  count: number;
  driftP95: number;
  judgeP50: number | null;
}

driftRouter.get('/timeseries', asyncHandler(async (req, res) => {
  const rawHours = parseInt((req.query['windowHours'] as string) ?? '24', 10);
  const windowHours = Number.isFinite(rawHours) && rawHours > 0
    ? Math.min(rawHours, 24 * 14)
    : 24;
  const rawBucket = parseInt((req.query['bucketMin'] as string) ?? '60', 10);
  const bucketMin = Number.isFinite(rawBucket) && rawBucket >= 5
    ? Math.min(rawBucket, 360)
    : 60;
  const agentId = (req.query['agentId'] as string | undefined)?.trim();

  // Centroid is computed over the whole window (one anchor per agent).
  // Then each bucket gets P95 distance against that anchor + median judge.
  const whereAgent = agentId ? 'AND agent_id = :agent' : '';
  const sql = `
    WITH window_rows AS (
      SELECT *,
             to_timestamp(
               floor(EXTRACT(EPOCH FROM ts) / (:bucket * 60))
                 * (:bucket * 60)
             ) AS bucket_start
        FROM observability.invocation_traces
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
         AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
             ${whereAgent}
    ),
    centroids AS (
      SELECT agent_id, AVG(output_embedding) AS centroid
        FROM window_rows
       WHERE output_embedding IS NOT NULL
         AND (judge_score IS NULL OR judge_score >= 0.6)
       GROUP BY agent_id
    )
    SELECT w.bucket_start::text AS bucket_start,
           w.agent_id,
           COUNT(*)::bigint AS cnt,
           COALESCE(
             PERCENTILE_CONT(0.95) WITHIN GROUP
               (ORDER BY (w.output_embedding <=> c.centroid)::float8),
             0
           )::float8 AS drift_p95,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p50
      FROM window_rows w
      LEFT JOIN centroids c ON c.agent_id = w.agent_id
     GROUP BY w.bucket_start, w.agent_id
     ORDER BY w.bucket_start ASC, w.agent_id ASC`;

  const params: import('@aws-sdk/client-rds-data').SqlParameter[] = [
    { name: 'hours',  value: { longValue: windowHours } },
    { name: 'bucket', value: { longValue: bucketMin } },
  ];
  if (agentId) params.push({ name: 'agent', value: { stringValue: agentId } });

  try {
    const rows = await exec(sql, params);
    const out: DriftTimePoint[] = rows.map((r) => ({
      bucketStart: String(r['bucket_start'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      count: Number(r['cnt'] ?? 0),
      driftP95: r['drift_p95'] == null ? 0 : Number(r['drift_p95']),
      judgeP50: r['p50'] == null ? null : Number(r['p50']),
    }));
    res.json({ points: out, bucketMin, windowHours });
  } catch (err) {
    console.warn('[drift] /timeseries failed:', (err as Error).message);
    res.json({ points: [], bucketMin, windowHours });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Per-(agent, template) drift breakdown. Researchers care about *which prompt*
// is drifting — not all templates degrade equally.
// ─────────────────────────────────────────────────────────────────────────────
interface DriftTemplateRow {
  agentId: string;
  templateId: string;
  count: number;
  judgeP50: number | null;
  judgeP05: number | null;
  schemaConformance: number;
  driftP95: number;
}

driftRouter.get('/templates', asyncHandler(async (req, res) => {
  const raw = parseInt((req.query['windowHours'] as string) ?? '1', 10);
  const windowHours = Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 24 * 7)
    : 1;
  const minCount = Math.max(parseInt((req.query['minCount'] as string) ?? '3', 10) || 3, 1);

  const sql = `
    WITH window_rows AS (
      SELECT *
        FROM observability.invocation_traces
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
         AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
    ),
    centroids AS (
      SELECT agent_id, template_id, AVG(output_embedding) AS centroid
        FROM window_rows
       WHERE output_embedding IS NOT NULL
         AND (judge_score IS NULL OR judge_score >= 0.6)
       GROUP BY agent_id, template_id
    )
    SELECT w.agent_id,
           COALESCE(w.template_id, '(none)') AS template_id,
           COUNT(*)::bigint AS cnt,
           PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p50,
           PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p05,
           AVG(CASE WHEN w.schema_valid IS NULL THEN NULL
                    WHEN w.schema_valid THEN 1.0 ELSE 0.0 END)::float8 AS conformance,
           COALESCE(
             PERCENTILE_CONT(0.95) WITHIN GROUP
               (ORDER BY (w.output_embedding <=> c.centroid)::float8),
             0
           )::float8 AS drift_p95
      FROM window_rows w
      LEFT JOIN centroids c
        ON c.agent_id = w.agent_id
       AND COALESCE(c.template_id, '') = COALESCE(w.template_id, '')
     GROUP BY w.agent_id, w.template_id
    HAVING COUNT(*) >= :mincnt
     ORDER BY drift_p95 DESC, p05 ASC NULLS LAST`;

  const params: import('@aws-sdk/client-rds-data').SqlParameter[] = [
    { name: 'hours',  value: { longValue: windowHours } },
    { name: 'mincnt', value: { longValue: minCount } },
  ];

  try {
    const rows = await exec(sql, params);
    const out: DriftTemplateRow[] = rows.map((r) => ({
      agentId: String(r['agent_id'] ?? ''),
      templateId: String(r['template_id'] ?? '(none)'),
      count: Number(r['cnt'] ?? 0),
      judgeP50: r['p50'] == null ? null : Number(r['p50']),
      judgeP05: r['p05'] == null ? null : Number(r['p05']),
      schemaConformance: r['conformance'] == null ? 1 : Number(r['conformance']),
      driftP95: r['drift_p95'] == null ? 0 : Number(r['drift_p95']),
    }));
    res.json({ templates: out });
  } catch (err) {
    console.warn('[drift] /templates failed:', (err as Error).message);
    res.json({ templates: [] });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Nearest known-good neighbors for an outlier. Lets a researcher diff a
// drifted output against the closest trusted example to understand *what*
// changed semantically.
// ─────────────────────────────────────────────────────────────────────────────
interface DriftNeighbor {
  invocationId: string;
  ts: string;
  responseSnippet: string;
  judgeScore: number | null;
  distance: number;
}

driftRouter.get('/neighbors/:invocationId', asyncHandler(async (req, res) => {
  const id = (req.params['invocationId'] as string).trim();
  const limit = Math.min(Math.max(parseInt((req.query['limit'] as string) ?? '3', 10) || 3, 1), 20);

  const sql = `
    WITH probe AS (
      SELECT agent_id, template_id, output_embedding
        FROM observability.invocation_traces
       WHERE invocation_id = :id::uuid
    )
    SELECT t.invocation_id::text AS invocation_id,
           t.ts::text AS ts,
           t.response_snippet,
           t.judge_score,
           (t.output_embedding <=> p.output_embedding)::float8 AS dist
      FROM observability.invocation_traces t, probe p
     WHERE t.invocation_id::text <> :id
       AND t.agent_id = p.agent_id
       AND t.output_embedding IS NOT NULL
       AND (t.judge_score IS NULL OR t.judge_score >= 0.7)
       AND t.ts > now() - INTERVAL '7 days'
     ORDER BY t.output_embedding <=> p.output_embedding ASC
     LIMIT :lim`;

  try {
    const rows = await exec(sql, [
      { name: 'id',  value: { stringValue: id } },
      { name: 'lim', value: { longValue: limit } },
    ]);
    const out: DriftNeighbor[] = rows.map((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      ts: String(r['ts'] ?? ''),
      responseSnippet: String(r['response_snippet'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      distance: r['dist'] == null ? 0 : Number(r['dist']),
    }));
    res.json({ neighbors: out });
  } catch (err) {
    console.warn('[drift] /neighbors failed:', (err as Error).message);
    res.json({ neighbors: [] });
  }
}));

// Defensive: keep an import path-resolved at module load so a bad
// EMBEDDING_DIMENSIONS doesn't go unnoticed.
void EMBEDDING_DIMENSIONS;
