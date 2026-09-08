// Mock A2A topology for GET /api/topology/a2a (dev:mock / MOCK_AURORA).
//
// The real handler aggregates `observability.invocation_traces` directly via
// `exec()`. In dev:mock there is no Aurora, the SELECT throws, the route's
// catch swallows it, and every node used to read "calls 0 · err 0" while
// Health's summary reported thousands of invocations for the identical 24h
// window (org-leader.md defect #13). Architecture and Health disagreed about
// whether anything had run today.
//
// The first fix pointed this file at `mockAgents.invocationsLast24h` — the
// same hand-written number Health summed — and then SCALED it by
// `windowHours / 24`, so a 6h window reported a quarter of a day's traffic
// whether or not a quarter of the day's rows fell in it. Two derived-looking
// numbers, neither countable from a row.
//
// Now it counts the rows. `invocationsInWindow(hours)` (mock/invocations.ts)
// is the same selector Health's per-agent metrics are taken over, so at
// `windowHours=24` these nodes and that summary are literally the same
// arithmetic over the same set — and a narrower window narrows honestly,
// returning what actually landed in it rather than a fraction of a day.

import { durationPercentile, invocationsInWindow } from './invocations.js';
import { agentFleet } from './agent-statuses.js';

export interface MockTopologyNode {
  agentId: string;
  agentName: string;
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number;
}

/**
 * Node metrics for a `windowHours`-wide slice of the fleet.
 *
 * Every deployed agent gets a node, including one with no traffic in the
 * window — that is the state a freshly-deployed agent is genuinely in, and
 * dropping it would make the graph disagree with the agent list about how
 * many agents exist.
 *
 * `totalCostUsd` stays 0: no mock row carries a price, and a fabricated one
 * would put a second, unreconciled spend figure next to /admin/budgets.
 */
export function buildMockTopologyNodes(windowHours: number): MockTopologyNode[] {
  const window = invocationsInWindow(windowHours);
  return agentFleet.rows().map((agent) => {
    const mine = window.filter((row) => row.agentId === agent.id);
    return {
      agentId: agent.id,
      agentName: agent.name,
      invocationCount: mine.length,
      errorCount: mine.filter((row) => row.error).length,
      p50Ms: mine.length > 0 ? durationPercentile(mine, 0.5) : null,
      p95Ms: mine.length > 0 ? durationPercentile(mine, 0.95) : null,
      totalCostUsd: 0,
    };
  });
}
