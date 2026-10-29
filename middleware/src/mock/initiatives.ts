// The fourteen canonical `p-*` initiatives, offline — the `projects` table
// behind /iq/projects and every initiative-scoped route.
//
// These rows were `MOCK_INITIATIVES`, a module-level array inside
// providers/projects.ts. They moved here for three of the floor's reasons
// (docs/mock-floor.md):
//
//   1. TYPED AGGREGATES (rule 1). Each row carried `activeAgents: 2` — a count
//      of `running` bot_runs typed beside a bot_runs fixture that had no running
//      row at all, so the Initiatives rail read "2 agents" over an Agents tab
//      with nothing live on it, and Aurora (which counts rows) read "Idle" for
//      the same initiative. The number is now counted from the run rows
//      (providers/projects.ts `mockActiveAgentRuns`), never stored.
//   2. IMPORT-TIME TIMESTAMPS (rule 3). `activeHoursAgo` became
//      `Date.now() - n hours` at module load — "1h ago" meant one hour before
//      the process started. It was also dead: every reader overwrote it with
//      the ledger's run-derived activity. It is gone, not moved.
//   3. NO SCENARIO CONTROL (rule 4). An auditor could not see the Initiatives
//      page empty or failing without editing code. `empty` and `error` are
//      declared below, so `POST /api/__mock/scenario
//      {"scenario":"error","fixture":"initiatives"}` shows the failure state and
//      a reset puts the fourteen back.
//
// The ids, names, statuses, owners, SMEs, sponsors and repos mirror
// schema/seeds/generate_program_seed.py's INITIATIVES (and schema/seed.sql's
// projects rows); the parity harness's `projects` and `project_contributions`
// entities compare them through providers/projects.ts.

import { defineFixture } from './core/index.js';

export interface MockInitiative {
  id: string;
  name: string;
  /** projects.status — 'planning' | 'in_progress' | 'completed', the seed's own values. */
  status: string;
  createdAt: string;
  /** projects.owner_id — the one person running the initiative. */
  owner: string;
  /** project_contributions rows with role 'sme'. */
  smes: string[];
  /** projects.sponsor_person_id — mirrors the generator's INITIATIVES[*].sponsor. */
  sponsor: string;
  /** projects.summary — 1–3 sentences, the generator's `description`. */
  summary: string;
  /** `owner/repo` under connorhoehnslalom/ — the agent_projects row the seed
      links via org_project_id. */
  repo: string;
  /** Highest open work-item priority for an initiative whose board this mock
      does not carry. The board-derived value wins wherever there is one
      (providers/projects.ts); null for initiatives with nothing open. */
  priority: string | null;
  /** projects.devbox_profile_id — the devbox policy profile this initiative's
      boxes are created under (DE-40); absent/null = `default`. Set by the
      mock branch of providers/devbox-profiles.ts setInitiativeProfile. */
  devboxProfileId?: string | null;
}

/**
 * A creation instant, as a fixed UTC calendar date.
 *
 * `Date.UTC`, not an ISO literal: same instant, but an ISO string in a fixture
 * is the shape rule 3 forbids under src/mock (see mock/work-items.ts's
 * MOCK_EPOCH for the same choice). These are historical dates, not ages — the
 * seed lets `created_at` default to the apply time, so there is no relative
 * age to mirror, and a date that moved with the clock would reorder the list's
 * `created_at DESC` tie-break from one day to the next.
 */
function createdOn(month: number, day: number): string {
  return new Date(Date.UTC(2026, month - 1, day, 12, 0, 0)).toISOString();
}

function seededInitiatives(): MockInitiative[] {
  return [
    // Summary is the v2 Overview mockup's copy (docs/design/initiative-v2-plan.md,
    // V3): schema/seeds/generate_program_seed.py carries the same two lines,
    // the second a "Focus:" paragraph after a newline.
    { id: 'p-observability', name: 'Observability Platform', status: 'in_progress', createdAt: createdOn(5, 24),
      owner: 'p-004', smes: ['p-008', 'p-011'], sponsor: 'p-002',
      summary: 'Centralize telemetry, reduce alert noise, and control retention costs.\nFocus: actionable alerts, team error budgets, and OpenTelemetry.',
      repo: 'connorhoehnslalom/orgiq-observability', priority: 'critical' },
    { id: 'p-auth-migration', name: 'Auth Migration', status: 'in_progress', createdAt: createdOn(6, 5),
      owner: 'p-002', smes: ['p-051', 'p-004', 'p-rhea'], sponsor: 'p-052',
      summary: 'Consolidate every login path onto Cognito + BFF OIDC and retire the legacy SAML shim, tenant by tenant, with zero forced logouts.',
      repo: 'connorhoehnslalom/orgiq-auth-service', priority: 'critical' },
    { id: 'p-llm-platform', name: 'LLM Application Platform', status: 'in_progress', createdAt: createdOn(6, 19),
      owner: 'p-047', smes: ['p-042', 'p-013'], sponsor: 'p-049',
      summary: 'The paved road for LLM features: managed prompts, canary evaluation, guardrail regression, and efficient serving.',
      repo: 'connorhoehnslalom/orgiq-llm-platform', priority: 'high' },
    { id: 'p-cost-opt', name: 'Cost Optimization', status: 'in_progress', createdAt: createdOn(5, 30),
      owner: 'p-008', smes: ['p-011', 'p-017'], sponsor: 'p-006',
      summary: 'Idle capacity teardown and per-initiative showback: every dollar of infra and agent spend attributable, every floor justified.',
      repo: 'connorhoehnslalom/orgiq-finops', priority: 'high' },
    { id: 'p-realtime-analytics', name: 'Real-time Analytics Pipeline', status: 'in_progress', createdAt: createdOn(6, 24),
      owner: 'p-017', smes: ['p-019', 'p-024'], sponsor: 'p-025',
      summary: 'Exactly-once event pipeline on Flink: schema-governed ingest, checkpointed processing, and replayable backfills.',
      repo: 'connorhoehnslalom/orgiq-stream-analytics', priority: 'high' },
    { id: 'p-data-lake', name: 'Data Lake Migration', status: 'planning', createdAt: createdOn(8, 1),
      owner: 'p-025', smes: ['p-017', 'p-015'], sponsor: 'p-012',
      summary: 'Lakehouse foundation on Iceberg: contract-governed ingest zones and time-travel access for analytics and ML.',
      repo: 'connorhoehnslalom/orgiq-data-lake', priority: 'medium' },
    { id: 'p-feature-store', name: 'ML Feature Store', status: 'in_progress', createdAt: createdOn(6, 28),
      owner: 'p-042', smes: ['p-019', 'p-044'], sponsor: 'p-049',
      summary: 'Online feature serving GA: point-in-time correct training data and freshness-SLA\'d online lookups.',
      repo: 'connorhoehnslalom/orgiq-feature-store', priority: 'high' },
    { id: 'p-mobile-redesign', name: 'Mobile App Redesign', status: 'in_progress', createdAt: createdOn(6, 12),
      owner: 'p-030', smes: ['p-035', 'p-026'], sponsor: 'p-036',
      summary: 'Navigation-first redesign of the mobile app: new IA, deep-link routing, and gesture-safe interactions.',
      repo: 'connorhoehnslalom/orgiq-mobile-app', priority: 'medium' },
    { id: 'p-design-v3', name: 'Design System v3', status: 'in_progress', createdAt: createdOn(7, 3),
      owner: 'p-035', smes: ['p-038', 'p-034'], sponsor: 'p-036',
      summary: 'Design System v3: semantic token pipeline from Figma to code with accessibility gates built in.',
      repo: 'connorhoehnslalom/orgiq-design-system', priority: 'medium' },
    { id: 'p-design-system-api', name: 'Design System API', status: 'in_progress', createdAt: createdOn(7, 10),
      owner: 'p-038', smes: ['p-035', 'p-001'], sponsor: 'p-036',
      summary: 'Programmatic access to the design system: typed component contracts, versioned release channels, and codemod-assisted upgrades.',
      repo: 'connorhoehnslalom/orgiq-design-system-api', priority: 'low' },
    { id: 'p-inference-platform', name: 'Inference Platform', status: 'in_progress', createdAt: createdOn(6, 15),
      owner: 'p-049', smes: ['p-013', 'p-043'], sponsor: 'p-012',
      summary: 'Shared model serving: queue-depth autoscaling, warm pools, and per-model canary rollout for every team shipping inference.',
      repo: 'connorhoehnslalom/orgiq-inference-platform', priority: 'high' },
    { id: 'p-rag-search', name: 'RAG Knowledge Search', status: 'completed', createdAt: createdOn(4, 18),
      owner: 'p-048', smes: ['p-047'], sponsor: 'p-006',
      summary: 'Retrieval-augmented org search — shipped. Hybrid retrieval with grounded citations; in maintenance.',
      repo: 'connorhoehnslalom/orgiq-rag-search', priority: null },
    { id: 'p-soc2', name: 'SOC2 Compliance', status: 'in_progress', createdAt: createdOn(6, 22),
      owner: 'p-052', smes: ['p-055', 'p-051'], sponsor: 'p-012',
      summary: 'SOC 2 Type II readiness: controls mapped to owners, evidence collection automated, access reviews on cadence.',
      repo: 'connorhoehnslalom/orgiq-compliance', priority: 'high' },
    { id: 'p-zero-trust', name: 'Zero Trust Network', status: 'planning', createdAt: createdOn(8, 8),
      owner: 'p-051', smes: ['p-052', 'p-056'], sponsor: 'p-052',
      summary: 'Zero-trust segmentation blueprint: service identity everywhere, mTLS by default, policy-engine enforced.',
      repo: 'connorhoehnslalom/orgiq-zero-trust', priority: 'medium' },
  ];
}

/**
 * The initiatives.
 *
 * `default` — the fourteen the seed creates.
 * `empty`   — a tenant with no initiatives yet. Declared explicitly (an
 *             undeclared scenario falls back to `default`): it is the state the
 *             list's "nothing here" copy, and the detail route's 404, are for.
 * `error`   — the projects table is unreadable. The list must render a failure,
 *             never the empty copy: "no initiatives" invites the reader to go
 *             create one, "could not read them" does not.
 */
export const initiatives = defineFixture<MockInitiative>({
  key: 'initiatives',
  scenarios: {
    default: seededInitiatives,
    empty: () => [],
    error: () => { throw new Error('projects unavailable: relation "projects" does not exist'); },
  },
});

/** One initiative by id, or undefined. A selector, so a reset reaches it. */
export function findInitiative(id: string): MockInitiative | undefined {
  return initiatives.rows().find((p) => p.id === id);
}
