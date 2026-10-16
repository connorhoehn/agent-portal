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
  { agentId: 'orgiq-supervisor', promptSnippet: 'Who knows Kubernetes best on the platform team?', responseSnippet: 'Marcus Müller and Eli Garcia both show strong expertise scores on Kubernetes — Marcus via 6 merged PRs on the ingress controller, Eli via the on-call rotation.', durationMs: 2140, tokensIn: 620, tokensOut: 240 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Summarize the auth-rotation ADR for the exec review', responseSnippet: 'The design bumps the session epoch on every tenant or role switch, so a copied pre-switch cookie is refused within 120 s with no server-side session store. Masquerade is exempt. One open question blocks sign-off: whether the access-control evidence needs 60 s instead.', durationMs: 3420, tokensIn: 880, tokensOut: 310 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'What changed in the org chart this month?', responseSnippet: 'Two new SME contributions were recorded on Observability Platform, and Nora DaSilva joined Auth Migration as an SME.', durationMs: 1870, tokensIn: 540, tokensOut: 200 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Route this to the scoring agent and get PageRank for the platform team', responseSnippet: '', durationMs: 4980, tokensIn: 410, tokensOut: 0, error: 'A2A timeout invoking orgiq-scoring after 4500ms' },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Who should own the incident-review runbook?', responseSnippet: 'Layla Hassan — she authored the two most-cited postmortems referencing incident review this quarter.', durationMs: 2260, tokensIn: 600, tokensOut: 190 },
  { agentId: 'orgiq-supervisor', promptSnippet: 'Draft a one-line status update on Auth Migration for the release manager', responseSnippet: 'Auth Migration: on track except the tenant cutover runbook, which waits on Sienna Garcia’s decision on cutover order.', durationMs: 1510, tokensIn: 480, tokensOut: 110 },

  // ── Search ──
  { agentId: 'orgiq-search', promptSnippet: 'Find every decision record mentioning Aurora cold starts', responseSnippet: "Found 3: 'Adopt Aurora over Neptune' and two postmortem follow-ups — all cite the 0.5-ACU cold-start gap.", durationMs: 980, tokensIn: 320, tokensOut: 150 },
  { agentId: 'orgiq-search', promptSnippet: 'Search for anyone with OpenSearch Serverless experience', responseSnippet: 'Caleb Turner (2 postmortems), Mia Singh (1 ADR authored).', durationMs: 720, tokensIn: 280, tokensOut: 90 },
  { agentId: 'orgiq-search', promptSnippet: 'What is our employee compensation band for L5 engineers?', responseSnippet: '', durationMs: 410, tokensIn: 210, tokensOut: 40, guardrailIntervened: true },
  { agentId: 'orgiq-search', promptSnippet: 'Pull the Slack thread where we decided on Titan v2 embeddings', responseSnippet: 'The embeddings thread in the platform channel: consensus on Titan v2 @1024d, citing the cost vs. recall tradeoff.', durationMs: 860, tokensIn: 300, tokensOut: 130 },
  { agentId: 'orgiq-search', promptSnippet: 'Vector search for "guardrail intervention rate"', responseSnippet: '', durationMs: 5100, tokensIn: 260, tokensOut: 0, error: 'OpenSearch Serverless query timed out after 5000ms' },
  { agentId: 'orgiq-search', promptSnippet: 'Who reviewed the CSRF hardening PR?', responseSnippet: 'Simone Chang approved with 2 inline comments; Eli Garcia co-reviewed.', durationMs: 690, tokensIn: 250, tokensOut: 100 },
  { agentId: 'orgiq-search', promptSnippet: 'Find the postmortem for the ARM64 Fargate incident', responseSnippet: 'The Fargate exec-format postmortem: root cause was a default x86_64 runtime platform on an Apple Silicon build.', durationMs: 810, tokensIn: 290, tokensOut: 140 },

  // ── Scoring ──
  { agentId: 'orgiq-scoring', promptSnippet: 'Recompute composite scores for the platform team', responseSnippet: 'Recomputed for 14 people; top mover: Theo Chang +0.06 on PageRank.', durationMs: 640, tokensIn: 220, tokensOut: 90 },
  { agentId: 'orgiq-scoring', promptSnippet: 'What is Eli Garcia’s expertise_score trend over 90 days?', responseSnippet: 'Rising: 0.71 → 0.79, driven by 3 merged infra PRs and 1 authored insight.', durationMs: 580, tokensIn: 210, tokensOut: 85 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Run centrality analysis on the observability sub-graph', responseSnippet: 'Betweenness centrality computed for 22 nodes; Layla Hassan is the top bridge node.', durationMs: 710, tokensIn: 240, tokensOut: 95 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Update leaderboard after the sprint close', responseSnippet: 'Leaderboard refreshed; 24 people rescored, no ties broken.', durationMs: 560, tokensIn: 200, tokensOut: 70 },
  { agentId: 'orgiq-scoring', promptSnippet: 'Which skills have the thinnest bench (fewest experts)?', responseSnippet: 'OpenSearch Serverless (2 people) and Cedar policy authoring (1 person) are the thinnest.', durationMs: 630, tokensIn: 230, tokensOut: 100 },

  // ── Advisor ──
  { agentId: 'orgiq-advisor', promptSnippet: 'Identify knowledge gaps on the identity & tenancy initiative', responseSnippet: 'Only 1 SME (Simone Chang) covers session-epoch invalidation — recommend pairing a second contributor before her rotation.', durationMs: 3100, tokensIn: 1100, tokensOut: 420 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Recommend a pairing for the new hire on graph ingestion', responseSnippet: 'Pair with Caleb Turner — highest recent activity on merge_* tools and lowest current mentee load.', durationMs: 2870, tokensIn: 980, tokensOut: 360 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Analyze bus-factor risk across all initiatives', responseSnippet: '', durationMs: 6800, tokensIn: 1240, tokensOut: 0, error: 'Bedrock ThrottlingException after 3 retries' },
  { agentId: 'orgiq-advisor', promptSnippet: 'Which initiative is most at risk of stalling next sprint?', responseSnippet: 'Data Lake Migration — its sole owner is on-call this sprint with no SME backup scheduled.', durationMs: 3320, tokensIn: 1050, tokensOut: 390 },
  { agentId: 'orgiq-advisor', promptSnippet: 'Suggest a mentor for someone picking up Cedar policy authoring', responseSnippet: 'Simone Chang — authored 4 of the 6 tenant policy sets and the only cross-tenant admin.cedar.', durationMs: 2940, tokensIn: 1010, tokensOut: 370 },

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

// ── Variants ───────────────────────────────────────────────────────────────
//
// The volume below multiplies the authored rows out to a day's traffic. It used
// to repeat them verbatim, so one page showed "Search for anyone with OpenSearch
// Serverless experience" twenty-one times. A repeat is now a new question about
// the org's own initiatives, decisions and people, answered in terms of the
// same ones, so no sentence recurs more than a handful of times and every name
// a reader meets is somebody on the Initiatives page.

const INITIATIVES: ReadonlyArray<{ name: string; owner: string }> = [
  { name: 'Observability Platform', owner: 'Nora DaSilva' },
  { name: 'Auth Migration', owner: 'Vera Green' },
  { name: 'LLM Application Platform', owner: 'Nina Rivera' },
  { name: 'Cost Optimization', owner: 'Layla Hassan' },
  { name: 'Real-time Analytics Pipeline', owner: 'Daniel Chang' },
  { name: 'Data Lake Migration', owner: 'Anika Mehta' },
  { name: 'ML Feature Store', owner: 'Katya Petrov' },
  { name: 'Mobile App Redesign', owner: 'Mia Singh' },
  { name: 'Design System v3', owner: 'Ben Okafor' },
  { name: 'Design System API', owner: 'Isabel Vasquez' },
  { name: 'Inference Platform', owner: 'Paolo Mancini' },
  { name: 'SOC2 Compliance', owner: 'Diego Ortiz' },
  { name: 'Zero Trust Network', owner: 'Simone Chang' },
  { name: 'RAG Knowledge Search', owner: 'Lucas Kim' },
];

const PEOPLE = [
  'Theo Chang', 'Owen Brooks', 'Maria Johnson', 'Marcus Müller', 'Arjun Shah', 'Kenji Chen', 'Eli Garcia', 'Rachel Kowalski',
  'Caleb Turner', 'Grace Singh', 'Raj Mehta', 'Camille Dubois', 'Henry Hassan', 'Andre Williams', 'Mateo Green', 'Ezra Park',
  'Fatima Ahmed', 'Miles Wright', 'David Tanaka', 'Rosa Ahmed', 'Zoe Thompson', 'Noah Vasquez', 'Vikram Patel', 'Ingrid Larsen',
  'Kevin Garcia', 'Joy Chen', 'Hugo Lee', 'Sasha Kim',
];

const DECISIONS = [
  'Adopt Aurora over Neptune', 'Migrate to Kubernetes from ECS', 'Standardize on Nova Pro', 'Sunset legacy auth service',
  'Adopt OpenTelemetry', 'React 19 upgrade timeline', 'Vector DB vendor selection', 'Self-hosted OTel collectors over vendor agents',
  'Judge model for canary evaluation', 'Iceberg over Delta for the lakehouse table format',
];

const SKILLS = [
  'Kubernetes', 'Terraform', 'Cedar policy authoring', 'Flink', 'Iceberg', 'OpenTelemetry', 'Postgres tuning', 'OIDC and JWKS',
  'prompt evaluation', 'Android accessibility', 'dbt', 'incident response',
];

type Variant = { promptSnippet: string; responseSnippet: string };
type VariantCtx = { n: number; init: (typeof INITIATIVES)[number]; init2: (typeof INITIATIVES)[number]; p: string; p2: string; d: string; skill: string };

const VARIANTS: Record<string, Array<(c: VariantCtx) => Variant>> = {
  'orgiq-supervisor': [
    (c) => ({ promptSnippet: `What is in flight on ${c.init.name}?`, responseSnippet: `${c.init.owner} owns ${c.init.name}; ${1 + (c.n % 4)} work items are in review and ${c.p} has the most recent merged change.` }),
    (c) => ({ promptSnippet: `Who owns ${c.init.name}?`, responseSnippet: `${c.init.owner}, with ${c.p} and ${c.p2} as the SMEs who touched it most recently.` }),
    (c) => ({ promptSnippet: `Summarize "${c.d}" for ${c.p}`, responseSnippet: `The decision on "${c.d}" carries ${1 + (c.n % 3)} sign-offs; the summary names the cost and rollback trade-offs and links ${c.init.name}.` }),
    (c) => ({ promptSnippet: `Draft a status line on ${c.init.name} for the release manager`, responseSnippet: `${c.init.name}: ${c.init.owner} owns it, sprint work is moving and spend is inside this month's allocation.` }),
    (c) => ({ promptSnippet: `What changed on ${c.init.name} this week?`, responseSnippet: `${2 + (c.n % 5)} work items moved; ${c.p} closed ${1 + (c.n % 3)} and the rest are waiting on review from ${c.p2}.` }),
    (c) => ({ promptSnippet: `Which initiatives does ${c.p} contribute to?`, responseSnippet: `${c.init.name} and ${c.init2.name}; the strongest signal is merged work on ${c.init.name}.` }),
  ],
  'orgiq-search': [
    (c) => ({ promptSnippet: `Find every decision record that mentions ${c.init.name}`, responseSnippet: `Found ${1 + (c.n % 4)} for ${c.init.name}, led by "${c.d}" and owned by ${c.init.owner}.` }),
    (c) => ({ promptSnippet: `Search for anyone with ${c.skill} experience`, responseSnippet: `${c.p} (${1 + (c.n % 3)} postmortems) and ${c.p2} (${1 + (c.n % 2)} ADRs authored) have the most evidence for ${c.skill}.` }),
    (c) => ({ promptSnippet: `Pull the discussion where ${c.init.name} settled on "${c.d}"`, responseSnippet: `The thread started by ${c.p}; ${c.init.owner} closed it with a summary of the trade-offs.` }),
    (c) => ({ promptSnippet: `Who reviewed the last change to ${c.init.name}?`, responseSnippet: `${c.p} approved with ${1 + (c.n % 4)} inline comments; ${c.p2} co-reviewed.` }),
    (c) => ({ promptSnippet: `Find the runbook for ${c.skill}`, responseSnippet: `The ${c.skill} runbook, last edited by ${c.p}; ${c.init.name} links to it from its operations page.` }),
    (c) => ({ promptSnippet: `What did ${c.p} write about ${c.init2.name}?`, responseSnippet: `${1 + (c.n % 5)} documents: a design note, ${1 + (c.n % 2)} postmortem follow-up and a section of the ${c.init2.name} plan.` }),
  ],
  'orgiq-scoring': [
    (c) => ({ promptSnippet: `Recompute composite scores for the ${c.init.name} team`, responseSnippet: `Recomputed for ${8 + (c.n % 9)} people; top mover: ${c.p} +0.0${1 + (c.n % 8)} on PageRank.` }),
    (c) => ({ promptSnippet: `What is ${c.p}'s ${c.skill} score trend over 90 days?`, responseSnippet: `Rising: 0.${60 + (c.n % 20)} → 0.${70 + (c.n % 25)}, driven by ${1 + (c.n % 4)} merged changes on ${c.init.name}.` }),
    (c) => ({ promptSnippet: `Run centrality analysis on the ${c.init.name} sub-graph`, responseSnippet: `Betweenness computed for ${14 + (c.n % 20)} nodes; ${c.p} is the top bridge node, ahead of ${c.p2}.` }),
    (c) => ({ promptSnippet: `Which skills are thinnest on ${c.init.name}?`, responseSnippet: `${c.skill} (${1 + (c.n % 2)} people) is the thinnest; ${c.p} is the only strong contributor.` }),
    (c) => ({ promptSnippet: `Refresh the leaderboard after the ${c.init.name} sprint closed`, responseSnippet: `Leaderboard refreshed; ${18 + (c.n % 12)} people rescored, ${c.p} moved up ${1 + (c.n % 3)} places.` }),
  ],
  'orgiq-advisor': [
    (c) => ({ promptSnippet: `Identify knowledge gaps on ${c.init.name}`, responseSnippet: `Only ${1 + (c.n % 2)} person (${c.p}) covers ${c.skill}; recommend pairing ${c.p2} with them before the next sprint.` }),
    (c) => ({ promptSnippet: `Recommend a pairing for a new hire on ${c.init.name}`, responseSnippet: `Pair with ${c.p} — recent activity on ${c.init.name} and the lightest mentee load of ${c.init.owner}'s team.` }),
    (c) => ({ promptSnippet: `Is ${c.init.name} at risk of stalling next sprint?`, responseSnippet: `${c.init.name} has ${1 + (c.n % 3)} open decisions and one owner (${c.init.owner}); backup is thin on ${c.skill}.` }),
    (c) => ({ promptSnippet: `Suggest a mentor for someone picking up ${c.skill}`, responseSnippet: `${c.p} — authored ${2 + (c.n % 5)} of the recent ${c.skill} changes and has mentored on ${c.init.name}.` }),
    (c) => ({ promptSnippet: `Who should review "${c.d}" before it is final?`, responseSnippet: `${c.p} and ${c.p2}; both have deep context from ${c.init.name}.` }),
  ],
  'orgiq-ingestion': [
    (c) => ({ promptSnippet: `Ingest the ${c.init.name} planning notes from ${c.p}`, responseSnippet: `Extracted ${8 + (c.n % 14)} entities, ${1 + (c.n % 4)} decisions and ${c.n % 2} org-chart change; synced to the knowledge base.` }),
    (c) => ({ promptSnippet: `Re-run entity extraction on the ${c.init.name} postmortems`, responseSnippet: `Extracted entities for ${5 + (c.n % 6)} of ${7 + (c.n % 6)} postmortems; the rest were already current.` }),
    (c) => ({ promptSnippet: `Process the "${c.d}" decision record`, responseSnippet: `Linked the record to ${c.init.name} and ${2 + (c.n % 4)} people; embeddings queued.` }),
    (c) => ({ promptSnippet: `Trigger graph-builder for ${c.init.name} documents`, responseSnippet: `Dispatched ${3 + (c.n % 7)} merge jobs to orgiq-graph-builder; all acknowledged.` }),
    (c) => ({ promptSnippet: `Sync the knowledge base after the ${c.init.name} import`, responseSnippet: `Sync job finished: ${12 + (c.n % 30)} documents added, ${c.n % 4} updated.` }),
  ],
  'orgiq-graph-builder': [
    (c) => ({ promptSnippet: `Merge the new ${c.init.name} decision nodes into the graph`, responseSnippet: `Upserted ${2 + (c.n % 5)} decision nodes and ${5 + (c.n % 9)} edges linking ${c.p} and ${c.p2}.` }),
    (c) => ({ promptSnippet: `Generate embeddings for ${20 + (c.n % 40)} new ${c.init.name} documents`, responseSnippet: `Generated Titan v2 @1024d embeddings; wrote to node_embeddings.` }),
    (c) => ({ promptSnippet: `Validate the person-skill edges for ${c.skill}`, responseSnippet: `${6 + (c.n % 12)} edges valid; ${c.p} was added to ${c.skill}.` }),
    (c) => ({ promptSnippet: `Merge duplicate person nodes flagged near ${c.p}`, responseSnippet: `Merged ${1 + (c.n % 3)} duplicate pair${c.n % 3 === 0 ? '' : 's'}; kept the higher-tenure node in each.` }),
    (c) => ({ promptSnippet: `Rebuild the rollup edges for ${c.init.name}`, responseSnippet: `Rebuilt ${14 + (c.n % 20)} rollup edges for ${c.init.name} and ${c.init2.name}.` }),
  ],
};

/** A fresh, deterministic question and answer for an agent's `i`th repeat. */
function variantFor(base: Authored, i: number): Authored {
  const templates = VARIANTS[base.agentId];
  if (!templates || templates.length === 0) return base;
  const t = i % templates.length;
  const r = Math.floor(i / templates.length);
  const ctx: VariantCtx = {
    n: i,
    init: INITIATIVES[r % INITIATIVES.length]!,
    init2: INITIATIVES[(r + 5) % INITIATIVES.length]!,
    p: PEOPLE[(r * 5 + t) % PEOPLE.length]!,
    p2: PEOPLE[(r * 7 + t + 3) % PEOPLE.length]!,
    d: DECISIONS[(r + t) % DECISIONS.length]!,
    skill: SKILLS[(r * 3 + t) % SKILLS.length]!,
  };
  return { ...base, ...templates[t]!(ctx) };
}

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

// The requirement (org-leader.md #14, re-audited as
// `mock/core/parity/invariants.ts` "the promised errors survive the default
// 50-row window"): every error the day produced must land inside
// `/api/observability/recent-invocations`' fixed tail window (default 50,
// capped at 200) — EVEN AFTER `getRecentInvocations` prepends live ring
// traffic ahead of this fixture. The invariant models that prepend directly:
// it records ten live invocations (`recordInvocation`, "a handful of real
// chat turns, as a manual audit session leaves behind") and re-checks the
// 50-row window afterward. Ten live rows ahead of the mock tail leaves only
// the tail's own top `TAIL_WINDOW - LIVE_RING_HEADROOM` ranks visible inside
// that 50-row page — so the real placement budget is 40, not 50, and
// treating 50 as the budget (an earlier attempt at this) left errors ranked
// 40–49 that the invariant's live-traffic case pushed straight out of frame.
//
// A first version of this satisfied the *bare* requirement (no live traffic)
// by putting every error ahead of every clean row in time — two disjoint
// bands, errors in [0.05h, 8h) and clean rows in [8h, 24h). That
// over-satisfies it: it also guarantees the tail is wall-to-wall red (every
// error outranks every success, so the top of the newest-first list reads as
// a much higher error rate than the day actually had — 28% of the visible
// rows vs. the fleet's real 4.2%). The requirement only needs each error
// somewhere inside the window that survives live traffic, not all of them
// ahead of everything else in it.
//
// `interleaveThroughTail` below spreads the errors evenly across the first
// `ERROR_WINDOW` ranks instead, mixed with clean rows, and lets the remaining
// clean rows fill out the rest of the 24-hour day after that. The corpus's 14
// errors land roughly one every three rows inside that window, which is what
// a real bad hour looks like, rather than a wall — with ten rows of headroom
// still free for whatever the live ring has prepended.
export const TAIL_WINDOW = 50;
const LIVE_RING_HEADROOM = 10;
export const ERROR_WINDOW = TAIL_WINDOW - LIVE_RING_HEADROOM;
const DAY_END_H = 24;

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
 * Spread `errors` evenly across the first `window` ranks of the combined,
 * newest-first list, mixed with `clean` rows rather than staged ahead of
 * them, then let the rest of `clean` fill out the remainder in its own order.
 *
 * This is the mechanism for the tail requirement above: as long as
 * `errors.length <= window` (true for every scenario this fixture builds —
 * `large`'s 28 errors still fit under `ERROR_WINDOW`'s 40), every error is
 * guaranteed a rank below `window` without any of them needing to be older or
 * newer than a clean row on principle. Spacing is even (`window /
 * errors.length`), not random, so the corpus stays deterministic.
 */
function interleaveThroughTail(errors: Authored[], clean: Authored[], window: number): Authored[] {
  const out: Authored[] = [];
  const gap = window / Math.max(1, errors.length);
  let cleanIdx = 0;
  let errorIdx = 0;
  // Start half a gap in, so the very first row is not always an error.
  let nextErrorSlot = gap / 2;

  while (out.length < window && (errorIdx < errors.length || cleanIdx < clean.length)) {
    const dueForError = errorIdx < errors.length && out.length >= nextErrorSlot;
    if (dueForError) {
      out.push(errors[errorIdx]!);
      errorIdx++;
      nextErrorSlot += gap;
    } else if (cleanIdx < clean.length) {
      out.push(clean[cleanIdx]!);
      cleanIdx++;
    } else if (errorIdx < errors.length) {
      out.push(errors[errorIdx]!);
      errorIdx++;
    } else {
      break;
    }
  }
  // Any errors the window could not fit (only possible if errors.length >
  // window, which none of today's scenarios produce) go right after it —
  // still ahead of the rest of the day, so the requirement holds even then.
  while (errorIdx < errors.length) {
    out.push(errors[errorIdx]!);
    errorIdx++;
  }
  while (cleanIdx < clean.length) {
    out.push(clean[cleanIdx]!);
    cleanIdx++;
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
              // A failure after the authored ones is a new question that failed,
              // not the same authored prompt failing again.
              ...variantFor(base, i + authoredClean.length + 37),
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
          : { ...variantFor(base, i - authoredClean.length), durationMs: Math.round(base.durationMs * (0.75 + ((i * 17) % 50) / 100)) },
      );
    }
  }

  const errors = interleave(built.filter((row) => row.error));
  const clean = interleave(built.filter((row) => !row.error));
  const ordered = interleaveThroughTail(errors, clean, ERROR_WINDOW);
  const rank = (list: Authored[], from: number, to: number): MockInvocation[] =>
    list.map((row, i) => ({
      ...row,
      id: '',
      hoursAgo: from + (i / Math.max(1, list.length)) * (to - from),
    }));

  return rank(ordered, 0.05, DAY_END_H).map((row, i) => ({ ...row, id: `mock-inv-${i}` }));
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
    // This fixture stands in for `observability.invocation_traces`, which is
    // the table the entire observability family reads — on-call, traffic,
    // cost, drift, memory, tool-calls. Each of those routes already has a
    // `degraded()` branch that answers 200 with a body it tells you not to
    // believe, and without this scenario not one of them was reachable
    // offline: the branch existed, and no auditor could ever see what it
    // renders. That matters most on /admin/observability/oncall, where an
    // unbelieved empty answer is an all-clear.
    error: () => { throw new Error('invocation_traces unavailable: relation does not exist'); },
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
