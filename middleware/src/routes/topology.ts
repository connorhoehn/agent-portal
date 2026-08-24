// A2A topology routes — aggregate parent→child invocation links in
// observability.invocation_traces to produce a directed graph of which agent
// calls which. The portal renders this as the AgentFlow page.
//
// Endpoints:
//   GET  /a2a?windowHours=24    — nodes + edges over a rolling window
//
// All queries degrade defensively: if invocation_traces is missing or empty,
// the response is { nodes: [], edges: [], window }. The portal merges with
// /api/agents on the client so a newly-deployed agent with zero invocations
// still appears on the canvas.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';

export const topologyRouter = Router();

interface TopologyNode {
  agentId: string;
  agentName: string;
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number;
}

interface TopologyEdge {
  source: string;       // source agent_id
  sourceName: string;
  target: string;       // target agent_id
  targetName: string;
  callCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number;
}

interface TopologyResponse {
  windowHours: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string;
}

// agent_id is the identity; agent_name is a label that varies by whoever
// wrote the row. The agent's own bundle says "Supervisor"; a middleware-side
// fallback row says "orgiq-supervisor"; a future writer may say something
// else again. Grouping by (agent_id, agent_name) turned that variance into
// TWO nodes for one agent — the graph disagreed with itself about how many
// agents exist, and each node carried half the traffic.
//
// So: group by agent_id alone, and pick one display name for the group,
// preferring a name that is not just the id echoed back. MIN() over the
// filtered set keeps it deterministic; the COALESCE chain falls back to any
// name, then to the id, so a group can never render nameless.
function agentNamePick(nameCol: string, idCol: string): string {
  return `COALESCE(
                MIN(${nameCol}) FILTER (WHERE ${nameCol} IS NOT NULL AND ${nameCol} <> ${idCol}),
                MIN(${nameCol}),
                MIN(${idCol})
              )`;
}

// Clamp the window so a buggy frontend can't scan 10 years of traces.
function clampWindow(raw: string | undefined): number {
  const n = parseInt(raw ?? '24', 10);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(n, 24 * 30); // 30d max
}

topologyRouter.get('/a2a', asyncHandler(async (req, res) => {
  const hours = clampWindow(req.query['windowHours'] as string | undefined);
  const params: SqlParameter[] = [
    { name: 'hours', value: { longValue: hours } },
  ];

  let nodes: TopologyNode[] = [];
  let edges: TopologyEdge[] = [];

  // ── Nodes: one row per agent that invoked anything in the window. ────────
  try {
    const nodeRows = await exec(
      `SELECT agent_id,
              ${agentNamePick('agent_name', 'agent_id')} AS agent_name,
              COUNT(*)::int AS invocation_count,
              PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50_ms,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95_ms,
              SUM(CASE
                    WHEN schema_valid = false
                      OR guardrail_action IN ('BLOCKED', 'INTERVENED')
                    THEN 1 ELSE 0
                  END)::int AS error_count,
              COALESCE(SUM(total_cost_usd), 0)::float8 AS total_cost_usd
         FROM observability.invocation_traces
        WHERE ts > now() - make_interval(hours => :hours::int)
          AND agent_id IS NOT NULL
          AND agent_id NOT LIKE 'test:%'
        GROUP BY agent_id`,
      params,
    );
    nodes = nodeRows.map((r) => ({
      agentId: String(r['agent_id'] ?? ''),
      agentName: String(r['agent_name'] ?? r['agent_id'] ?? ''),
      invocationCount: r['invocation_count'] == null ? 0 : Number(r['invocation_count']),
      errorCount: r['error_count'] == null ? 0 : Number(r['error_count']),
      p50Ms: r['p50_ms'] == null ? null : Number(r['p50_ms']),
      p95Ms: r['p95_ms'] == null ? null : Number(r['p95_ms']),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    }));
  } catch (err) {
    console.warn('[topology] /a2a node aggregation failed:', (err as Error).message);
    nodes = [];
  }

  // ── Edges: self-join parent→child on parent_invocation_id within window. ─
  try {
    const edgeRows = await exec(
      `WITH win AS (
         SELECT invocation_id, agent_id, agent_name,
                parent_invocation_id, duration_ms, total_cost_usd,
                schema_valid, guardrail_action
           FROM observability.invocation_traces
          WHERE ts > now() - make_interval(hours => :hours::int)
            AND agent_id IS NOT NULL
            AND agent_id NOT LIKE 'test:%'
       )
       SELECT p.agent_id      AS source_agent_id,
              ${agentNamePick('p.agent_name', 'p.agent_id')} AS source_agent_name,
              c.agent_id      AS target_agent_id,
              ${agentNamePick('c.agent_name', 'c.agent_id')} AS target_agent_name,
              COUNT(*)::int   AS call_count,
              PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY c.duration_ms)::float8 AS p50_ms,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.duration_ms)::float8 AS p95_ms,
              COALESCE(SUM(c.total_cost_usd), 0)::float8 AS total_cost_usd,
              SUM(CASE
                    WHEN c.schema_valid = false
                      OR c.guardrail_action IN ('BLOCKED', 'INTERVENED')
                    THEN 1 ELSE 0
                  END)::int AS error_count
         FROM win p
         JOIN win c ON c.parent_invocation_id = p.invocation_id
        GROUP BY p.agent_id, c.agent_id
        ORDER BY call_count DESC`,
      params,
    );
    edges = edgeRows.map((r) => ({
      source: String(r['source_agent_id'] ?? ''),
      sourceName: String(r['source_agent_name'] ?? r['source_agent_id'] ?? ''),
      target: String(r['target_agent_id'] ?? ''),
      targetName: String(r['target_agent_name'] ?? r['target_agent_id'] ?? ''),
      callCount: r['call_count'] == null ? 0 : Number(r['call_count']),
      errorCount: r['error_count'] == null ? 0 : Number(r['error_count']),
      p50Ms: r['p50_ms'] == null ? null : Number(r['p50_ms']),
      p95Ms: r['p95_ms'] == null ? null : Number(r['p95_ms']),
      totalCostUsd: r['total_cost_usd'] == null ? 0 : Number(r['total_cost_usd']),
    }));
  } catch (err) {
    console.warn('[topology] /a2a edge aggregation failed:', (err as Error).message);
    edges = [];
  }

  const response: TopologyResponse = {
    windowHours: hours,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  };
  res.json(response);
}));
