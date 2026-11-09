// The deployed agent fleet — what each agent IS, never how much it did.
//
// WHAT CHANGED AND WHY. This module used to carry `invocationsLast24h`,
// `errorsLast24h` and `tokensLast24h` as typed fields: 847 calls and 3 errors
// for the supervisor, 2,994 and 25 across the fleet. Three surfaces read them
// — Health's summary (providers/cloudwatch.ts), the Architecture graph
// (mock/topology.ts) and, indirectly, the Invocations list — and none of them
// could produce those rows. The list showed 6 errors under a banner promising
// 25; the fix at the time was a helper in mock/invocations.ts that manufactured
// 19 filler rows to catch up to the number. Two surfaces were reconciled by
// hand twice in one week.
//
// The numbers are gone. Every one of them is now COUNTED from the rows in
// mock/invocations.ts — the same rows the Invocations page lists — so Health,
// Architecture and the list cannot disagree, because there is only one of them
// to disagree with. Latency percentiles come from the same rows' durations
// rather than a second pair of typed constants.
//
// What stays typed here is what a fixture is allowed to carry: identity, and
// facts that are not counts. `status` is the fleet's own health label, not an
// arithmetic result — but the corpus in mock/invocations.ts is written so it
// reads true, `degraded` for the agent that actually fails 40% of its runs.

import { clock, defineFixture, type ScenarioName } from './core/index.js';
import { liveRows } from './live.js';
import { durationPercentile, invocationTail, invocationsInWindow } from './invocations.js';

/**
 * The wire shape `AgentRuntimeSummary` and every consumer already expects.
 * Unchanged — only the source of the four numbers at the bottom moved.
 */
export interface AgentDef {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'deploying';
  protocol: 'ag-ui' | 'a2a';
  model: string;
  tools: string[];
  guardrails: string[];
  endpoint: string;
  latencyP50Ms: number;
  latencyP99Ms: number;
  invocationsLast24h: number;
  errorsLast24h: number;
  tokensLast24h: number;
}

/** An agent as the fixture stores it: identity only, no arithmetic. */
export type AgentDefinition = Omit<
  AgentDef,
  'latencyP50Ms' | 'latencyP99Ms' | 'invocationsLast24h' | 'errorsLast24h' | 'tokensLast24h'
>;

const RUNTIME = 'https://runtime.agentcore.us-east-1.amazonaws.com';

/**
 * The fleet.
 *
 * `empty` — nothing deployed yet, so Architecture, Health and the agent
 *           picker all have to render their own "no agents" state instead of
 *           a page of zeros that looks like a broken query.
 * `error` — the AgentCore control plane is unreachable. Reading rows throws,
 *           which is the point: a surface that only ever renders empty on a
 *           failed list is telling the operator the fleet is gone.
 */
export const agentFleet = defineFixture<AgentDefinition>({
  key: 'agent-fleet',
  scenarios: {
    default: () => [
      {
        id: 'orgiq-supervisor',
        name: 'Supervisor',
        status: 'healthy',
        protocol: 'ag-ui',
        model: 'nova-pro-v1',
        tools: ['route_to_agent', 'synthesize_responses'],
        guardrails: ['pii-filter', 'content-policy'],
        endpoint: `${RUNTIME}/orgiq-supervisor`,
      },
      {
        id: 'orgiq-search',
        name: 'Search',
        status: 'healthy',
        protocol: 'a2a',
        model: 'nova-pro-v1',
        tools: ['search_knowledge_base', 'query_graph', 'vector_search'],
        guardrails: ['pii-filter', 'grounding'],
        endpoint: `${RUNTIME}/orgiq-search`,
      },
      {
        id: 'orgiq-scoring',
        name: 'Scoring',
        status: 'healthy',
        protocol: 'a2a',
        model: 'nova-lite-v1',
        tools: ['compute_pagerank', 'calculate_centrality', 'update_scores'],
        guardrails: ['content-policy'],
        endpoint: `${RUNTIME}/orgiq-scoring`,
      },
      {
        id: 'orgiq-advisor',
        name: 'Advisor',
        status: 'healthy',
        protocol: 'a2a',
        model: 'nova-pro-v1',
        tools: ['analyze_graph_patterns', 'identify_gaps', 'recommend_pairings'],
        guardrails: ['pii-filter', 'content-policy', 'grounding'],
        endpoint: `${RUNTIME}/orgiq-advisor`,
      },
      {
        id: 'orgiq-ingestion',
        name: 'Ingestion',
        status: 'degraded',
        protocol: 'a2a',
        model: 'nova-lite-v1',
        tools: ['process_document', 'extract_entities', 'trigger_graph_builder'],
        guardrails: ['content-policy'],
        endpoint: `${RUNTIME}/orgiq-ingestion`,
      },
      {
        id: 'orgiq-graph-builder',
        name: 'Graph Builder',
        status: 'healthy',
        protocol: 'a2a',
        model: 'nova-lite-v1',
        tools: ['merge_nodes', 'merge_edges', 'generate_embeddings', 'validate_schema'],
        guardrails: ['content-policy'],
        endpoint: `${RUNTIME}/orgiq-graph-builder`,
      },
      // The three runtimes this fixture used to omit. `ListAgentRuntimes`
      // does not filter by tenant or by framework — it returns every runtime
      // in the account — so a fleet of six was a fleet the real control plane
      // never returns. The Architecture page counted "online / 6" against its
      // own static diagram and the two assessment agents were invisible on a
      // page whose whole subject is the fleet.
      {
        id: 'orgiq-assessment-scorer',
        name: 'Assessment Scorer',
        status: 'healthy',
        protocol: 'ag-ui',
        model: 'nova-pro-v1',
        tools: ['classify_evidence', 'score_dimension'],
        guardrails: ['content-policy'],
        endpoint: `${RUNTIME}/orgiq-assessment-scorer`,
      },
      {
        id: 'orgiq-assessment-drafter',
        name: 'Assessment Drafter',
        status: 'healthy',
        protocol: 'ag-ui',
        model: 'nova-pro-v1',
        tools: ['check_story_draft', 'validate_facts'],
        guardrails: ['content-policy'],
        endpoint: `${RUNTIME}/orgiq-assessment-drafter`,
      },
      {
        // Not a Strands agent — it runs coding tasks in a microVM. It is
        // still a runtime the control plane lists, so leaving it out made the
        // fleet page disagree with `agentcore list`.
        id: 'orgiq-devbox',
        name: 'Devbox',
        status: 'healthy',
        protocol: 'ag-ui',
        model: 'nova-pro-v1',
        tools: ['run_command', 'read_file', 'write_file'],
        guardrails: [],
        endpoint: `${RUNTIME}/orgiq-devbox`,
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('AgentCore control plane unreachable (ListAgentRuntimes timed out)');
    },
  },
});

// ── Derived metrics ────────────────────────────────────────────────────────

/** How wide "last 24h" is. The window itself is applied in mock/invocations.ts. */
const WINDOW_HOURS = 24;

/**
 * The five numbers this module used to type, counted from the rows the
 * Invocations page lists. Nothing is stored, so nothing can drift.
 */
function metricsFor(
  agentId: string,
  window: ReturnType<typeof invocationsInWindow>,
): Pick<
  AgentDef,
  'latencyP50Ms' | 'latencyP99Ms' | 'invocationsLast24h' | 'errorsLast24h' | 'tokensLast24h'
> {
  const mine = window.filter((row) => row.agentId === agentId);
  return {
    latencyP50Ms: durationPercentile(mine, 0.5),
    latencyP99Ms: durationPercentile(mine, 0.99),
    invocationsLast24h: mine.length,
    errorsLast24h: mine.filter((row) => row.error).length,
    tokensLast24h: mine.reduce((n, row) => n + row.tokensIn + row.tokensOut, 0),
  };
}

/**
 * The fleet with its metrics attached — rebuilt on every read, because both
 * halves move: the fixture's rows change when the control plane switches
 * scenario, and the 24h window slides as the clock does.
 *
 * Memoised for the instant it was computed in. A single `mockAgents.reduce()`
 * touches the array once per element plus its length, and each of those reads
 * would otherwise rebuild the whole day. Keying on the clock's own millisecond
 * (rather than wall time) keeps a frozen-clock test deterministic; keying on
 * the row arrays' identity and length means a `reset()` or a mutation is never
 * served from the cache.
 */
interface Memo {
  at: number;
  fleet: unknown;
  fleetSize: number;
  tail: unknown;
  tailSize: number;
  value: AgentDef[];
}
let memo: Memo | null = null;

function fleetSnapshot(scenario?: ScenarioName): AgentDef[] {
  const definitions = agentFleet.rows(scenario);
  const seeds = invocationTail.rows(scenario);
  const at = clock.now().getTime();
  // An explicitly-asked-for scenario bypasses the cache: the cache exists to
  // make repeated reads of the ACTIVE world cheap, not to answer a question
  // about a different one.
  if (
    scenario === undefined &&
    memo &&
    memo.at === at &&
    memo.fleet === definitions &&
    memo.fleetSize === definitions.length &&
    memo.tail === seeds &&
    memo.tailSize === seeds.length
  ) {
    return memo.value;
  }
  const window = invocationsInWindow(WINDOW_HOURS, scenario);
  const value = definitions.map((def) => ({ ...def, ...metricsFor(def.id, window) }));
  if (scenario === undefined) {
    memo = {
      at,
      fleet: definitions,
      fleetSize: definitions.length,
      tail: seeds,
      tailSize: seeds.length,
      value,
    };
  }
  return value;
}

/**
 * The fleet, as an array, live.
 *
 * It stays an array export because `mock/core/parity/invariants.ts` iterates
 * it and reduces over it, and the harness is the judge — it does not get
 * edited to suit the code it judges. `liveRows` keeps the array shape while
 * re-reading the fixture on every access, so an auditor who switches to
 * `empty` sees an empty fleet rather than the one that was live at import.
 */
export const mockAgents: AgentDef[] = liveRows<AgentDef>({
  key: agentFleet.key,
  rows: fleetSnapshot,
  reset: (scenario) => agentFleet.reset(scenario),
});
