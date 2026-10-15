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
      'Picked Aurora PostgreSQL + relational graph over Neptune Analytics for cost + latency reasons.',
    status: 'resolved', projectId: null, requiredRole: null,
    decidedAt: '2026-03-12', escalatedAt: null, workItemId: null },
  { id: 'd-k8s', topic: 'Migrate to Kubernetes from ECS',
    summary:
      'Standardize compute layer on EKS for portability and ecosystem.',
    status: 'resolved', projectId: null, requiredRole: null,
    decidedAt: '2026-02-04', escalatedAt: null, workItemId: null },
  { id: 'd-nova', topic: 'Standardize on Nova Pro',
    summary:
      'Use amazon.nova-pro-v1 as primary inference model across all agents.',
    status: 'resolved', projectId: 'p-llm-platform', requiredRole: null,
    decidedAt: '2026-04-21', escalatedAt: null, workItemId: null },
  { id: 'd-legacy-auth', topic: 'Sunset legacy auth service',
    summary:
      'Move every remaining service off the v1 auth gateway; the SAML shim is deleted once the last tenant has cut over to Cognito.',
    status: 'resolved', projectId: 'p-auth-migration', requiredRole: null,
    decidedAt: '2026-01-30', escalatedAt: null, workItemId: null },
  { id: 'd-otel', topic: 'Adopt OpenTelemetry',
    summary:
      'Replace ad-hoc tracing with OTLP + AWS X-Ray for unified observability.',
    status: 'resolved', projectId: 'p-observability', requiredRole: null,
    decidedAt: '2026-03-25', escalatedAt: null, workItemId: null },
  { id: 'd-react-19', topic: 'React 19 upgrade timeline',
    summary:
      'Roll out React 19 across portal + design system over Q2.',
    status: 'resolved', projectId: 'p-design-v3', requiredRole: null,
    decidedAt: '2026-04-02', escalatedAt: null, workItemId: null },
  { id: 'd-vectordb', topic: 'Vector DB vendor selection',
    summary:
      'Chose pgvector inside Aurora over standalone vector DBs to keep ops surface small.',
    status: 'resolved', projectId: 'p-rag-search', requiredRole: null,
    decidedAt: '2026-03-18', escalatedAt: null, workItemId: null },
    // schema/seed_program.sql, `decisions` — the four an initiative raised.
    // Relative dates, because the generator writes them as
    // `NOW() - INTERVAL 'n days'` so the demo never goes stale.
  { id: 'd-otel-vendor', topic: 'Self-hosted OTel collectors over vendor agents',
    summary:
      'Vendor agents priced per-host at 3x our infra cost; the collector fleet is ours to tune and the escape hatch stays open.',
    status: 'resolved', projectId: 'p-observability', requiredRole: null,
    decidedAt: D(6).slice(0, 10), escalatedAt: null, workItemId: 'wi-obs-e1' },
  { id: 'd-cognito-cutover', topic: 'Cutover order for legacy SSO tenants',
    summary:
      'Smallest tenant first vs. riskiest first. Riskiest-first surfaces unknowns while rollback is cheap, but a failed first cutover is loud.',
    status: 'escalated', projectId: 'p-auth-migration', requiredRole: 'org-leader',
    decidedAt: null, escalatedAt: D(2), workItemId: 'wi-auth-e2' },
  { id: 'd-eval-judge-model', topic: 'Judge model for canary evaluation',
    summary:
      'Nova Pro judges cost ~6x Nova Lite but agree with human labels 11 points more often on the current rubric. Sample-rate tuning could fund the gap.',
    status: 'open', projectId: 'p-llm-platform', requiredRole: null,
    decidedAt: null, escalatedAt: null, workItemId: 'wi-llm-e1' },
  { id: 'd-iceberg', topic: 'Iceberg over Delta for the lakehouse table format',
    summary:
      'Engine-neutral catalog support and snapshot isolation fit the multi-engine roadmap; Delta\'s tighter Spark coupling was the deciding cost.',
    status: 'resolved', projectId: 'p-data-lake', requiredRole: null,
    decidedAt: D(13).slice(0, 10), escalatedAt: null, workItemId: 'wi-lake-e1' },
    ],
    empty: () => [],
  },
});

export const decisionParticipantRows = defineFixture<DecisionParticipantRow>({
  key: 'graph-decision-participants',
  scenarios: {
    // schema/seed.sql, `decision_participants` — all 67 rows, then the
    // twelve schema/seed_program.sql emits for the four decisions its
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
  { decisionId: 'd-cognito-cutover', personId: 'p-051', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-cognito-cutover', personId: 'p-004', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-047', role: 'decider', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-042', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-eval-judge-model', personId: 'p-013', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-025', role: 'decider', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-017', role: 'contributor', weight: 1.0 },
  { decisionId: 'd-iceberg', personId: 'p-015', role: 'contributor', weight: 1.0 },
    ],
    // No decisions, so no participants — the two fixtures stay consistent.
    empty: () => [],
  },
});
