// The fleet's 24 hours of traffic — and, since this fixture landed on the
// floor, the ONLY place that traffic is counted from.
//
// WHAT THIS BACKS. `getRecentInvocations` (lib/invocations.ts) normally reads
// an in-memory ring that only fills from real chat traffic, so in `dev:mock`
// the Invocations page sat empty forever. These rows are the tail it merges in.
//
// WHY IT IS ALSO THE SOURCE OF THE NUMBERS. Health's summary, the Architecture
// graph and this list are three renderings of one day. They used to be three
// hand-written numbers: `mockAgents.invocationsLast24h/errorsLast24h/
// tokensLast24h` said 2,994 calls and 25 errors, the tail carried 6 error rows,
// and the reconciliation was a `padErrorsToSummary` helper that manufactured 19
// filler rows to make the list agree with a number nobody could otherwise
// justify. That is the count-vs-list defect with a patch on top of it: the
// summary was still the authority, and the list was still catching up.
//
// The direction is now reversed. These rows are the day. `mock/agent-statuses.ts`
// COUNTS them for every per-agent metric, `providers/cloudwatch.ts`'s mock
// `getSummary` sums those, and `mock/topology.ts` reads the same fleet — so
// there is no second number left to reconcile. Change the corpus below and all
// three surfaces move together, because there is only one of them.
//
// CYCLE NOTE. This module imports `agentFleet` from ./agent-statuses.js for
// display names, and that module imports this one's rows to count them. Both
// directions are read exclusively inside function bodies (a fixture is a rows
// FACTORY, never an array literal), so whichever module loads first the other
// is fully evaluated before any row is ever read.

import { HOUR_MS, clock, defineFixture, type ScenarioName } from './core/index.js';
import { agentFleet } from './agent-statuses.js';
import type { InvocationRecord } from '../lib/invocations.js';

/**
 * A row as the fixture holds it. Richer than `InvocationRecord`, which has no
 * column for tokens — `buildMockInvocations` projects that away for the wire,
 * and `mockInvocationRows` keeps it for the surfaces that report token volume.
 *
 * `hoursAgo` is an OFFSET, not an instant: the instant is computed by
 * `clock.hoursAgo()` at read time, so a tail built at 23:59 and read at 00:30
 * still reports rows from the last 24 hours rather than from 24 hours before
 * the process booted (contract.ts bug #3).
 */
export interface MockInvocation {
  id: string;
  agentId: string;
  promptSnippet: string;
  responseSnippet: string;
  durationMs: number;
  hoursAgo: number;
  tokensIn: number;
  tokensOut: number;
  guardrailIntervened?: boolean;
  error?: string;
}

/** What a corpus row looks like before it is given an id and a rank. */
type Authored = Omit<MockInvocation, 'id' | 'hoursAgo'>;

// ── The authored corpus ────────────────────────────────────────────────────
//
// These are the rows a reader actually sees at the top of the Invocations
// page: real-sounding questions with real-sounding answers. The generator
// below multiplies them out to a day's worth of volume; it never invents a
// prompt of its own.

const AUTHORED: Authored[] = [
  // ── Supervisor ──
  { agentId: 'orgiq-supervisor', promptSnippet: 'Who knows Kubernetes best on the platform team?', responseSnippet: 'Priya Desai and Eli Garcia both show strong expertise scores on Kubernetes — Priya via 6 merged PRs on the ingress controller, Eli via the on-call rotation.', durationMs: 2140, tokensIn: 620, tokensOut: 240 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Summarize the auth-rotation ADR for the exec review', responseSnippet: 'The ADR proposes rotating session-signing secrets quarterly via Secrets Manager, ratified 2026-08-14 with 2 sign-offs.', durationMs: 3420, tokensIn: 880, tokensOut: 310 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'What changed in the org chart this month?', responseSnippet: 'Two new SME contributions were recorded on p-obs-rollout, and Nora DaSilva picked up ownership of p-kb-migration.', durationMs: 1870, tokensIn: 540, tokensOut: 200 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Route this to the scoring agent and get PageRank for the platform team', responseSnippet: '', durationMs: 4980, tokensIn: 410, tokensOut: 0, error: 'A2A timeout invoking orgiq-scoring after 4500ms' },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Who should own the incident-review runbook?', responseSnippet: 'Layla Hassan — she authored the two most-cited postmortems referencing incident review this quarter.', durationMs: 2260, tokensIn: 600, tokensOut: 190 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Draft a one-line status update on p-obs-rollout for the release manager', responseSnippet: 'p-obs-rollout: on track, sprint 4 of 6, no budget overage.', durationMs: 1510, tokensIn: 480, tokensOut: 110 },

  // ── Search ──
  { agentId: 'orgiq-search', promptSnippet: 'Find every decision record mentioning Aurora cold starts', responseSnippet: 'Found 3: des-aurora-warmup, des-data-api-retry, des-kb-datasource-init — all cite the 0.5-ACU cold-start gap.', durationMs: 980, tokensIn: 320, tokensOut: 150 },
  { agentId: 'orgiq-search', promptSnippet: 'Search for anyone with OpenSearch Serverless experience', responseSnippet: 'Caleb Turner (2 postmortems), Mia Singh (1 ADR authored).', durationMs: 720, tokensIn: 280, tokensOut: 90 },
  { agentId: 'orgiq-search', promptSnippet: 'What is our employee compensation band for L5 engineers?', responseSnippet: '', durationMs: 410, tokensIn: 210, tokensOut: 40, guardrailIntervened: true },
  { agentId: 'orgiq-search', promptSnippet: 'Pull the Slack thread where we decided on Titan v2 embeddings', responseSnippet: 'thread-2026-03-12-embeddings: consensus on Titan v2 @1024d, cites cost vs. recall tradeoff.', durationMs: 860, tokensIn: 300, tokensOut: 130 },
  { agentId: 'orgiq-search', promptSnippet: 'Vector search for "guardrail intervention rate"', responseSnippet: '', durationMs: 5100, tokensIn: 260, tokensOut: 0, error: 'OpenSearch Serverless query timed out after 5000ms' },
  { agentId: 'orgiq-search', promptSnippet: 'Who reviewed the CSRF hardening PR?', responseSnippet: 'Nora Chang approved with 2 inline comments; Eli Garcia co-reviewed.', durationMs: 690, tokensIn: 250, tokensOut: 100 },
  { agentId: 'orgiq-search', promptSnippet: 'Find the postmortem for the ARM64 Fargate incident', responseSnippet: 'pm-2026-06-02-fargate-exec-format: root cause was a default x86_64 runtime platform on an Apple Silicon build.', durationMs: 810, tokensIn: 290, tokensOut: 140 },

  // ── Scoring ──
  { agentId: 'orgiq-scoring', promptSnippet: 'Recompute composite scores for the platform team', responseSnippet: 'Recomputed for 14 people; top mover: Priya Desai +0.06 on PageRank.', durationMs: 640, tokensIn: 220, tokensOut: 90 },
  { agentId: 'orgiq-scoring', promptSnippet: 'What is Eli Garcia’s expertise_score trend over 90 days?', responseSnippet: 'Rising: 0.71 → 0.79, driven by 3 merged infra PRs and 1 authored insight.', durationMs: 580, tokensIn: 210, tokensOut: 85 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Run centrality analysis on the observability sub-graph', responseSnippet: 'Betweenness centrality computed for 22 nodes; Layla Hassan is the top bridge node.', durationMs: 710, tokensIn: 240, tokensOut: 95 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Update leaderboard after the sprint close', responseSnippet: 'Leaderboard refreshed; 24 people rescored, no ties broken.', durationMs: 560, tokensIn: 200, tokensOut: 70 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Which skills have the thinnest bench (fewest experts)?', responseSnippet: 'OpenSearch Serverless (2 people) and Cedar policy authoring (1 person) are the thinnest.', durationMs: 630, tokensIn: 230, tokensOut: 100 },

  // ── Advisor ──
  { agentId: 'orgiq-advisor', promptSnippet: 'Identify knowledge gaps on the identity & tenancy initiative', responseSnippet: 'Only 1 SME (Nora Chang) covers session-epoch invalidation — recommend pairing a second contributor before her rotation.', durationMs: 3100, tokensIn: 1100, tokensOut: 420 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Recommend a pairing for the new hire on graph ingestion', responseSnippet: 'Pair with Caleb Turner — highest recent activity on merge_* tools and lowest current mentee load.', durationMs: 2870, tokensIn: 980, tokensOut: 360 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Analyze bus-factor risk across all initiatives', responseSnippet: '', durationMs: 6800, tokensIn: 1240, tokensOut: 0, error: 'Bedrock ThrottlingException after 3 retries' },
  { agentId: 'orgiq-advisor', promptSnippet: 'Which initiative is most at risk of stalling next sprint?', responseSnippet: 'p-kb-migration — its sole owner is on-call this sprint with no SME backup scheduled.', durationMs: 3320, tokensIn: 1050, tokensOut: 390 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Suggest a mentor for someone picking up Cedar policy authoring', responseSnippet: 'Nora Chang — authored 4 of the 6 tenant policy sets and the only cross-tenant admin.cedar.', durationMs: 2940, tokensIn: 1010, tokensOut: 370 },

  // ── Ingestion (the degraded one) ──
  { agentId: 'orgiq-ingestion', promptSnippet: 'Ingest the Q3 all-hands recap deck', responseSnippet: 'Extracted 18 entities, 4 decisions, 1 org-chart change; synced to knowledge base.', durationMs: 4200, tokensIn: 2400, tokensOut: 610 },
  { agentId: 'orgiq-ingestion', promptSnippet: 'Process the Confluence export for the auth-migration PRD', responseSnippet: '', durationMs: 12400, tokensIn: 1900, tokensOut: 0, error: 'S3 GetObject failed: NoSuchKey confluence/auth-migration-prd.pdf' },
  { agentId: 'orgiq-ingestion', promptSnippet: 'Re-run entity extraction on the postmortem backlog', responseSnippet: 'Extracted entities for 9 of 11 postmortems; 2 skipped (already current).', durationMs: 8900, tokensIn: 3100, tokensOut: 740 },
  { agentId: 'orgiq-ingestion', promptSnippet: 'Sync the knowledge base after the ADR batch import', responseSnippet: '', durationMs: 15200, tokensIn: 2200, tokensOut: 0, error: 'Bedrock KB sync job failed: data source ingestion job errored' },
  { agentId: 'orgiq-ingestion', promptSnippet: 'Trigger graph-builder for the newly ingested Slack threads', responseSnippet: 'Dispatched 6 merge jobs to orgiq-graph-builder; all acked.', durationMs: 3600, tokensIn: 1700, tokensOut: 430 },

  // ── Graph Builder ──
  { agentId: 'orgiq-graph-builder', promptSnippet: 'Merge the newly extracted decision nodes into the graph', responseSnippet: 'Upserted 4 decision nodes and 9 edges via ON CONFLICT DO UPDATE.', durationMs: 1920, tokensIn: 700, tokensOut: 220 },
  { agentId: 'orgiq-graph-builder', promptSnippet: 'Generate embeddings for the batch of 40 new documents', responseSnippet: 'Generated 40 Titan v2 @1024d embeddings; wrote to node_embeddings.', durationMs: 5100, tokensIn: 1500, tokensOut: 180 },
  { agentId: 'orgiq-graph-builder', promptSnippet: 'Validate schema on the person-skill edge batch', responseSnippet: '', durationMs: 2300, tokensIn: 640, tokensOut: 0, error: 'Schema validation failed: 3 edges reference an unknown skill_id' },
  { agentId: 'orgiq-graph-builder', promptSnippet: 'Merge duplicate person nodes flagged by the dedupe sweep', responseSnippet: 'Merged 2 duplicate pairs; preserved the higher-tenure node in each.', durationMs: 2680, tokensIn: 760, tokensOut: 250 },
  { agentId: 'orgiq-graph-builder', promptSnippet: 'Rebuild the project → initiative rollup edges', responseSnippet: 'Rebuilt 31 rollup edges across 14 initiatives.', durationMs: 1780, tokensIn: 690, tokensOut: 210 },
];

/**
 * How much traffic each agent handled. This is a GENERATOR INPUT, not a
 * reported metric: it makes rows, and every surface then counts the rows it
 * made. Nothing reads these numbers directly, so changing one moves Health,
 * Architecture and the list together — which is precisely what a stored
 * `invocationsLast24h` could not do.
 *
 * The mix is chosen so each agent's `status` in agent-statuses.ts is legible
 * from its own traffic: ingestion is `degraded` and fails 40% of its runs;
 * everything else is `healthy` and fails a few percent; scoring never fails,
 * which is what makes the "0 errors" filter worth having.
 */
const VOLUME: ReadonlyArray<{ agentId: string; rows: number; errors: number }> = [
  { agentId: 'orgiq-supervisor', rows: 90, errors: 2 },
  { agentId: 'orgiq-search', rows: 120, errors: 2 },
  { agentId: 'orgiq-scoring', rows: 45, errors: 0 },
  { agentId: 'orgiq-advisor', rows: 30, errors: 1 },
  { agentId: 'orgiq-ingestion', rows: 20, errors: 8 },
  { agentId: 'orgiq-graph-builder', rows: 30, errors: 1 },
];

/**
 * Failure strings for rows the authored corpus does not cover on its own —
 * filler, not curated examples, and deliberately generic so nobody mistakes
 * one for a story worth reading.
 */
const GENERIC_ERRORS = [
  'Bedrock ThrottlingException after 3 retries',
  'AgentCore Runtime returned 504 Gateway Timeout',
  'Guardrail evaluation timed out after 2000ms',
  'Aurora RDS Data API connection reset',
  'OpenSearch Serverless query timed out after 5000ms',
  'A2A timeout invoking a downstream agent',
  'Bedrock ValidationException: input exceeds context window',
  'S3 GetObject failed: connection reset by peer',
  'Titan embeddings request failed: 500 Internal Server Error',
  'Bedrock ModelStreamErrorException mid-stream',
];

// Two disjoint recency bands. ALL error rows land in [0.05h, 8h) and ALL
// clean rows in [8h, 24h), so in the newest-first sort every error outranks
// every non-error row.
//
// This is not decoration. `/api/observability/recent-invocations` is a fixed
// window (default 50, capped at 200) and `getRecentInvocations` prepends live
// ring traffic ahead of this tail. Spread evenly across the day, the errors
// competed for tail slots with the clean rows and two of them fell past the
// cutoff — Health linked to a list that could not show what Health promised
// (org-leader.md #14). Banded, the day's errors occupy the first ranks of the
// mock tail by construction, whatever the corpus size.
const ERROR_BAND_END_H = 8;
const CLEAN_BAND_END_H = 24;

/**
 * Round-robin the rows across agents, keeping each agent's own order.
 *
 * Rows are generated agent by agent, and recency is then handed out in array
 * order — so without this the newest 90 rows all belonged to the supervisor,
 * and an agent with no errors (scoring, deliberately) never appeared in the
 * default 50-row window at all. The Invocations page's agent filter looked
 * broken and the fleet looked like one agent. Interleaving makes the visible
 * window a cross-section of the fleet, which is what a real tail is.
 */
function interleave(rows: Authored[]): Authored[] {
  const queues = new Map<string, Authored[]>();
  for (const row of rows) {
    const queue = queues.get(row.agentId);
    if (queue) queue.push(row);
    else queues.set(row.agentId, [row]);
  }
  const out: Authored[] = [];
  const lists = [...queues.values()];
  for (let i = 0; out.length < rows.length; i++) {
    for (const list of lists) {
      const row = list[i];
      if (row) out.push(row);
    }
  }
  return out;
}

/**
 * Build a day of traffic: the authored rows first (they rank highest inside
 * their band, so they are what a reader sees), then as many repeats as the
 * volume asks for.
 *
 * Deterministic — same corpus every call, so `mock-inv-*` ids stay stable and
 * the Invocations detail route can still resolve a row the list linked to.
 */
function corpus(scale: { rows: number; errors: number }): MockInvocation[] {
  const built: Authored[] = [];

  for (const volume of VOLUME) {
    const mine = AUTHORED.filter((a) => a.agentId === volume.agentId);
    const authoredErrors = mine.filter((a) => a.error);
    const authoredClean = mine.filter((a) => !a.error);

    const wantErrors = volume.errors * scale.errors;
    const wantTotal = Math.max(volume.rows * scale.rows, wantErrors);
    const wantClean = wantTotal - wantErrors;

    for (let i = 0; i < wantErrors; i++) {
      const base = authoredErrors[i] ?? authoredClean[i % Math.max(1, authoredClean.length)];
      if (!base) break;
      built.push(
        i < authoredErrors.length
          ? base
          : {
              ...base,
              responseSnippet: '',
              tokensOut: 0,
              durationMs: 1500 + ((i * 137) % 4000),
              error: GENERIC_ERRORS[i % GENERIC_ERRORS.length]!,
            },
      );
    }

    for (let i = 0; i < wantClean; i++) {
      const base = authoredClean[i % Math.max(1, authoredClean.length)];
      if (!base) break;
      built.push(
        i < authoredClean.length
          ? base
          // Repeats vary their cost a little so a duration percentile is not
          // one value repeated, which would make p50 and p99 identical.
          : { ...base, durationMs: Math.round(base.durationMs * (0.75 + ((i * 17) % 50) / 100)) },
      );
    }
  }

  const errors = interleave(built.filter((row) => row.error));
  const clean = interleave(built.filter((row) => !row.error));
  const rank = (list: Authored[], from: number, to: number): MockInvocation[] =>
    list.map((row, i) => ({
      ...row,
      id: '',
      hoursAgo: from + (i / Math.max(1, list.length)) * (to - from),
    }));

  return [...rank(errors, 0.05, ERROR_BAND_END_H), ...rank(clean, ERROR_BAND_END_H, CLEAN_BAND_END_H)]
    .map((row, i) => ({ ...row, id: `mock-inv-${i}` }));
}

/**
 * The day of traffic every observability surface counts.
 *
 * `empty`  — a fleet that has been deployed but never called: the Invocations
 *            page, Health's totals and the Architecture graph must all read
 *            zero together, which is the state a fresh account is actually in.
 * `large`  — five times the volume for density and pagination, with only the
 *            errors held near their default count: a busy day, not a broken
 *            one, and few enough failures that the 50-row window still shows
 *            every error the summary promises.
 */
export const invocationTail = defineFixture<MockInvocation>({
  key: 'invocation-tail',
  scenarios: {
    default: () => corpus({ rows: 1, errors: 1 }),
    empty: () => [],
    large: () => corpus({ rows: 5, errors: 2 }),
  },
});

/** Display name for an agent id, from the one fixture that owns the fleet. */
function agentDisplayName(agentId: string, scenario?: ScenarioName): string {
  return agentFleet.rows(scenario).find((a) => a.id === agentId)?.name ?? agentId;
}

/**
 * The tail with its instants resolved — the rows every count in this repo is
 * taken over. `startedAt` is computed here, on every call, so "the last 24
 * hours" stays true however long the process has been up.
 */
export function mockInvocationRows(
  scenario?: ScenarioName,
): Array<MockInvocation & { agentName: string; startedAt: string }> {
  return invocationTail
    .rows(scenario)
    .map((row) => ({
      ...row,
      agentName: agentDisplayName(row.agentId, scenario),
      startedAt: clock.hoursAgo(row.hoursAgo),
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The rows of a rolling `hours`-wide window, newest first.
 *
 * The window is bounded at BOTH ends. A row stamped in the future is not
 * something that happened in the last day, and an unbounded lower comparison
 * would quietly fold one into every total. Read against `clock.now()`, so a
 * frozen-clock test gets the window it froze.
 *
 * This is the ONE definition of "the traffic in the window" — Health's
 * per-agent metrics (mock/agent-statuses.ts) and the Architecture graph
 * (mock/topology.ts) both count what it returns, which is why they cannot
 * report different totals for the same hours.
 */
export function invocationsInWindow(
  hours: number,
  scenario?: ScenarioName,
): Array<MockInvocation & { agentName: string; startedAt: string }> {
  const now = clock.now().getTime();
  const span = Math.max(0, hours) * HOUR_MS;
  return mockInvocationRows(scenario).filter((row) => {
    const ms = new Date(row.startedAt).getTime();
    return Number.isFinite(ms) && ms <= now && now - ms <= span;
  });
}

/**
 * Nearest-rank percentile over the durations of a set of rows. Nearest-rank
 * rather than interpolated because these are observed durations, and a p99 no
 * request actually took is a number the trace list cannot corroborate. No
 * rows means no latency to report, which is 0 rather than NaN.
 */
export function durationPercentile(rows: ReadonlyArray<{ durationMs: number }>, p: number): number {
  if (rows.length === 0) return 0;
  const sorted = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!);
}

/**
 * The same rows in the wire shape `lib/invocations.ts` merges into its ring.
 * Tokens are dropped: `InvocationRecord` has no column for them, and the
 * observability detail route is deliberate about leaving DB-only fields null
 * rather than inventing values `invocation_traces` would carry.
 */
export function buildMockInvocations(): InvocationRecord[] {
  return mockInvocationRows().map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    promptSnippet: row.promptSnippet,
    responseSnippet: row.responseSnippet,
    guardrailIntervened: !!row.guardrailIntervened,
    ...(row.error ? { error: row.error } : {}),
  }));
}
