// Decision records — the `decisions` + `decision_participants` tables of the
// org graph, mirroring schema/seed.sql AND schema/seed_program.sql.
//
// ONE FIXTURE FOR ONE TABLE. `decisions` is one concept with a lifecycle (see
// the comment on the table in schema/orgiq_schema.sql): a call the org has
// made or still has to make, optionally raised against an initiative. Two
// providers read it — `providers/decisions.ts` for `GET /api/graph/decisions`
// and `providers/work-items.ts` for an initiative's Decisions tab — and they
// both read THIS fixture. They used to read two: this file carried seed.sql's
// eight ADR rows with no status and no projectId, while work-items.ts carried
// a hand-typed `MOCK_DECISIONS` of seed_program.sql's four with no decidedAt
// and no participants. Neither list contained the other, so the two surfaces
// described two different worlds out of one table — and MOCK_DECISIONS'
// `workItemId`s were typed by hand, naming items the seed never linked.
//
// `GET /api/graph/decisions` had no mock branch at all before that: it went
// straight to `exec`, so in dev:mock the route 500'd on an RDS Data API call
// that cannot succeed offline. A 500 reads as "this feature is broken", which
// is a different (and wrong) message from "nothing is seeded".
//
// The two tables are mirrored rather than pre-joined, because participantCount
// is a count — it comes from `countBy` over the participant rows at read time,
// not from a number typed next to the decision it describes. `workItemTitle`
// is resolved the same way, by the LEFT JOIN work-items.ts mirrors.

import { clock, defineFixture } from './core/index.js';

/**
 * One row of `decisions`, whole. `decidedAt` is a DATE in the seed and the RDS
 * Data API hands a DATE back as 'YYYY-MM-DD' — the same spelling the real
 * provider passes through `String(r['decided_at'])`; the TIMESTAMPTZ columns
 * come back as ISO strings.
 *
 * `projectId: null` is org-wide, not unknown. `decidedAt` is set exactly when
 * `status` is a settled one. `workItemId` names the work this decision blocks
 * and can only be written by schema/seed_program.sql, which emits the work
 * item in the same file.
 */
export interface DecisionRow {
  id: string;
  topic: string;
  summary: string | null;
  status: 'open' | 'escalated' | 'resolved' | 'rejected';
  projectId: string | null;
  requiredRole: string | null;
  decidedAt: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  /**
   * G54: what was decided, one sentence (the `resolution` column, the
   * record's `outcome`), and who decided it (`decided_by`: a person id, else
   * the account subject of someone with no person). The nine settled seed rows
   * carry both, the outcome taken from the summary's own "we chose" sentence
   * and the decider participant as `decidedBy`; the waiting rows carry
   * neither until POST /api/graph/decisions/:id/decide writes them, with the
   * instant (`resolved_at`).
   */
  decidedBy?: string | null;
  resolution?: string | null;
  resolvedAt?: string | null;
  /**
   * G57: the pre-canned answers a waiting decision offers (the `options`
   * jsonb column), each taken from the decision's own summary; the record
   * page's decision dialogue numbers them, and `decide { optionId }` records
   * the chosen label as the outcome. Settled rows carry none.
   */
  options?: DecisionOption[] | null;
}

/** One pre-canned answer to a waiting decision (G57). */
export interface DecisionOption {
  id: string;
  label: string;
  /** One line on what choosing it means, from the summary. */
  detail?: string;
}

/** `NOW() - INTERVAL 'n days'` as the seeds write it. Through the clock, so a
 *  frozen test sees the instant it froze and a row never bakes at import. */
const D = (days: number): string => clock.daysAgo(days);

/** One row of `decision_participants`. `weight` is the column default (1.0);
 *  the seed never sets it explicitly. */
export interface DecisionParticipantRow {
  decisionId: string;
  personId: string;
  role: string | null;
  weight: number;
}

export const decisionRows = defineFixture<DecisionRow>({
  key: 'graph-decisions',
  scenarios: {
    // schema/seed.sql, `decisions` — the seven org-graph ADRs, ids and prose
    // byte-for-byte. All settled; `projectId: null` on the two that are
    // org-wide standards no single initiative owns.
    default: () => [
  { id: 'd-aurora', topic: 'Adopt Aurora over Neptune',
    summary:
      'The org graph needs graph-shaped questions (who worked with whom, paths across teams) joined to projects and decisions. Neptune Analytics answered the graph questions well but meant a second database, a second query language and a separate backup story. Aurora PostgreSQL with relational edge tables and recursive CTEs answered every query we had under 200 ms p95 on the full graph. We gave up native graph algorithms, so centrality scores run as a nightly batch job instead of a query.',
    status: 'resolved', projectId: null, requiredRole: null,
    decidedAt: D(147).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'Aurora PostgreSQL with relational edge tables and recursive CTEs, not Neptune, with centrality scores as a nightly batch job.', decidedBy: 'p-046' },
  { id: 'd-k8s', topic: 'Migrate to Kubernetes from ECS',
    summary:
      'Twelve teams ran services on ECS through three different deployment pipelines, and the autoscalers, operators and mesh they wanted were Kubernetes-native. We standardised on EKS with one golden-path Helm chart and Karpenter for node provisioning. The cost is a cluster to operate: a version upgrade every quarter and a platform rotation on call for it. Batch jobs that need no mesh stay on ECS.',
    status: 'resolved', projectId: null, requiredRole: null,
    decidedAt: D(183).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'Standardise on EKS with one golden-path Helm chart and Karpenter for node provisioning.', decidedBy: 'p-013' },
  { id: 'd-nova', topic: 'Standardize on Nova Pro',
    summary:
      'Each agent team had picked its own model, so guardrails, evaluation and cost reporting differed per team. We made Nova Pro the default for every agent, with Nova Lite allowed for routing and classification steps that pass the same golden set. One default means some tasks overpay, so the model stays a per-agent override reviewed against the golden set, not a hard rule.',
    status: 'resolved', projectId: 'p-llm-platform', requiredRole: null,
    decidedAt: D(107).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'Nova Pro is the default for every agent, with Nova Lite allowed for routing and classification steps that pass the same golden set.', decidedBy: 'p-043' },
  { id: 'd-legacy-auth', topic: 'Sunset legacy auth service',
    summary:
      'The v1 auth gateway kept sessions in memory, could not rotate its signing key without signing everyone out, and failed its last penetration test on session fixation. We decided to move every service to Cognito with the BFF holding tokens server-side. The SAML shim is deleted once the last tenant has cut over, not kept as a fallback, because a fallback means patching two login paths indefinitely.',
    status: 'resolved', projectId: 'p-auth-migration', requiredRole: null,
    decidedAt: D(188).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'Move every service to Cognito with the BFF holding tokens server-side, and delete the SAML shim once the last tenant has cut over.', decidedBy: 'p-054' },
  { id: 'd-otel', topic: 'Adopt OpenTelemetry',
    summary:
      'Services traced with three different libraries, and no trace crossed a service boundary intact. We adopted OpenTelemetry SDKs with W3C trace context everywhere, using the AWS distribution where the runtime expects it, and export OTLP to X-Ray and the metrics backend. The cost is a migration per service and a collector fleet to run. The payoff is one trace from the browser to the database.',
    status: 'resolved', projectId: 'p-observability', requiredRole: null,
    decidedAt: D(134).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'Adopt OpenTelemetry SDKs with W3C trace context everywhere, exporting OTLP to X-Ray and the metrics backend.', decidedBy: 'p-013' },
  { id: 'd-react-19', topic: 'React 19 upgrade timeline',
    summary:
      'React 19 removes legacy context and string refs, and nine design-system components still used them. The design system upgrades first and publishes on its next channel, then each app moves once its test suite passes against it. Apps stay on React 18 with the previous design-system major until then, so two majors are supported for one quarter.',
    status: 'resolved', projectId: 'p-design-v3', requiredRole: null,
    decidedAt: D(126).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'The design system upgrades to React 19 first, then each app moves once its test suite passes against it.', decidedBy: 'p-031' },
  { id: 'd-vectordb', topic: 'Vector DB vendor selection',
    summary:
      'Retrieval needs about 2 million 1,024-dimension embeddings filtered by team and document type. A standalone vector database was faster at 50 million vectors but meant another service, another copy of access control and a sync job. pgvector with an HNSW index inside Aurora returns the top 10 in about 30 ms at our size and keeps embeddings in the same transaction as their documents. We revisit above 20 million vectors.',
    status: 'resolved', projectId: 'p-rag-search', requiredRole: null,
    decidedAt: D(141).slice(0, 10), escalatedAt: null, workItemId: null,
    resolution: 'pgvector with an HNSW index inside Aurora, revisited above 20 million vectors.', decidedBy: 'p-010' },
    // schema/seed_program.sql, `decisions` — the five the initiatives raised.
    // Relative dates, because the generator writes them as
    // `NOW() - INTERVAL 'n days'` so the demo never goes stale.
  { id: 'd-otel-vendor', topic: 'Self-hosted OTel collectors over vendor agents',
    summary:
      'Vendor APM agents were quoted per host at about three times the cost of running our own collectors, and each shipped sampling we could not tune. We chose self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend. The cost is owning the fleet: upgrades, memory tuning and the burst OOM are ours to fix. Switching backends stays a config change, not a re-instrumentation.',
    status: 'resolved', projectId: 'p-observability', requiredRole: null,
    decidedAt: D(6).slice(0, 10), escalatedAt: null, workItemId: 'wi-obs-e1',
    resolution: 'Self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend.', decidedBy: 'p-004' },
  { id: 'd-cognito-cutover', topic: 'Cutover order for legacy SSO tenants',
    summary:
      'Twelve customer tenants remain on the SAML shim, and each moves with the single-tenant cutover runbook. Smallest first keeps the blast radius low while the team learns the runbook. Riskiest first moves the two tenants with custom SAML attribute mappings while the shim is still warm and rollback is a route flip, but a failure there is loud and customer-visible. The order decides who is warned and when, so it is a release call.',
    status: 'escalated', projectId: 'p-auth-migration', requiredRole: 'org-leader',
    decidedAt: null, escalatedAt: D(2), workItemId: 'wi-auth-e2',
    options: [
      { id: 'smallest-first', label: 'Smallest tenants first', detail: 'Keeps the blast radius low while the team learns the runbook.' },
      { id: 'riskiest-first', label: 'Riskiest two tenants first', detail: 'The custom SAML mappings move while the shim is warm and rollback is a route flip.' },
    ] },
  { id: 'd-eval-judge-model', topic: 'Judge model for canary evaluation',
    summary:
      'The canary judge scores every sampled answer, so its model sets both the evaluation bill and how far the scores can be trusted. On the 120-question pilot set Nova Pro agrees with human labels 82 percent of the time and Nova Lite 71 percent, at about six times the cost per judged answer. Halving the sample rate from 20 to 10 percent would fund Nova Pro at the current spend. Open until the final rubric weights have run on both.',
    status: 'open', projectId: 'p-llm-platform', requiredRole: null,
    decidedAt: null, escalatedAt: null, workItemId: 'wi-llm-e1',
    options: [
      { id: 'nova-pro-10', label: 'Nova Pro, sample rate halved to 10%', detail: '82 percent agreement with human labels, at the current spend.' },
      { id: 'nova-lite-20', label: 'Nova Lite at the current 20% sample rate', detail: '71 percent agreement, at about a sixth of the cost per judged answer.' },
    ] },
  { id: 'd-iceberg', topic: 'Iceberg over Delta for the lakehouse table format',
    summary:
      'The lakehouse is read by Spark, Trino and Flink, so the table format had to work well in all three. Iceberg\'s engine-neutral catalog, hidden partitioning and snapshot isolation fit that roadmap. Delta was faster under Spark in our benchmark but weaker in the other two engines. The consequence: compaction and snapshot expiry are a job we run, not a feature we buy.',
    status: 'resolved', projectId: 'p-data-lake', requiredRole: null,
    decidedAt: D(13).slice(0, 10), escalatedAt: null, workItemId: 'wi-lake-e1',
    resolution: 'Iceberg as the lakehouse table format, for its engine-neutral catalog across Spark, Trino and Flink.', decidedBy: 'p-025' },
  // The Inference Platform's open call (generate_program_seed.py extra_decisions):
  // the warm floor the cold-start bug wi-inf-e1-b3 waits on.
  { id: 'd-inference-warm-floor', topic: 'Warm floor or scale-to-zero for tier-1 models',
    summary:
      'Tier-1 models scale to zero after 15 minutes idle, and the next request pays a 40 to 90 second cold start against a 2.5-second p99 SLO. A warm floor of one replica per tier-1 model removes the cold start at about $380 a month per model. Baking weights into the image cuts the load to about 20 seconds at no standing cost, but still breaches the SLO. Open until the teams that own the SLO agree what a breach costs them.',
    status: 'open', projectId: 'p-inference-platform', requiredRole: null,
    decidedAt: null, escalatedAt: null, workItemId: 'wi-inf-e1',
    options: [
      { id: 'warm-floor', label: 'Warm floor of one replica per tier-1 model', detail: 'No cold start, at about $380 a month per model.' },
      { id: 'bake-weights', label: 'Bake weights into the image', detail: 'Loads in about 20 seconds at no standing cost, but still breaches the SLO.' },
      { id: 'scale-to-zero', label: 'Keep scale-to-zero', detail: 'No standing cost; the 40 to 90 second cold start stays.' },
    ] },
    ],
    empty: () => [],
  },
});

export const decisionParticipantRows = defineFixture<DecisionParticipantRow>({
  key: 'graph-decision-participants',
  scenarios: {
    // schema/seed.sql, `decision_participants` — all 67 rows, then the
    // rows schema/seed_program.sql emits for the five decisions its
    // initiatives raised (owner decides, SMEs contribute).
    default: () => [
  { decisionId: 'd-aurora', personId: 'p-046', role: 'decider', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-002', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-028', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-042', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-011', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-039', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-054', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-052', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-004', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-007', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-aurora', personId: 'p-022', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-013', role: 'decider', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-027', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-045', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-036', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-047', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-052', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-035', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-043', role: 'decider', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-019', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-020', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-016', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-007', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-004', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-026', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-037', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-054', role: 'decider', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-032', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-010', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-004', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-024', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-001', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-028', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-006', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-019', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-043', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-041', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-legacy-auth', personId: 'p-039', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-013', role: 'decider', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-007', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-002', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-014', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-011', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-041', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-019', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-006', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-031', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-008', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel', personId: 'p-020', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-031', role: 'decider', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-032', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-043', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-017', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-006', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-042', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-035', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-025', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-012', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-react-19', personId: 'p-024', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-010', role: 'decider', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-049', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-045', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-043', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-k8s', personId: 'p-006', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-nova', personId: 'p-044', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-001', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-vectordb', personId: 'p-044', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel-vendor', personId: 'p-004', role: 'decider', weight: 1.0 },
  { decisionId: 'd-otel-vendor', personId: 'p-008', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-otel-vendor', personId: 'p-011', role: 'contributor', weight: 1.0 },
  // Escalated by its owner (Vera, p-002) to the release manager (Sienna, p-005), who decides it.
  { decisionId: 'd-cognito-cutover', personId: 'p-005', role: 'decider', weight: 1.0 },
  { decisionId: 'd-cognito-cutover', personId: 'p-002', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-cognito-cutover', personId: 'p-rhea', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-cognito-cutover', personId: 'p-051', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-cognito-cutover', personId: 'p-004', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-047', role: 'decider', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-042', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-013', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-025', role: 'decider', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-017', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-015', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-inference-warm-floor', personId: 'p-049', role: 'decider', weight: 1.0 },
  { decisionId: 'd-inference-warm-floor', personId: 'p-013', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-inference-warm-floor', personId: 'p-043', role: 'contributor', weight: 1.0 },
    ],
    // No decisions, so no participants — the two fixtures stay consistent.
    empty: () => [],
  },
});

/**
 * One row of `decision_events` (schema/orgiq_work_items_schema.sql): the
 * decision's history as the product recorded it (G54). Empty in every seed:
 * a seeded decision's history is derived from its columns (raised, escalated,
 * decided), and a row lands here only when someone decides it on the page or
 * by voice. `POST /api/__mock/reset` takes them away again.
 */
export interface DecisionEventRow {
  id: string;
  decisionId: string;
  /** What happened: the outcome the decider chose. */
  kind: 'resolved' | 'rejected';
  /** ISO timestamp. */
  at: string;
  /** The person id the decider acts under, else their account subject. */
  actorId: string;
  actorName: string;
  rationale: string;
}

export const decisionEventRows = defineFixture<DecisionEventRow>({
  key: 'graph-decision-events',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});
