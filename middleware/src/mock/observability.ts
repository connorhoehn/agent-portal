// The observability data plane, as `dev:mock` sees it.
//
// WHY THIS FILE EXISTS. Eight routers — traffic, drift, tool-calls, quality,
// calibration, guardrails-detail, invocations, memory — read Aurora through
// `providers/aurora.ts` `exec()` and nothing else. `exec()` has no mock branch,
// so in `dev:mock` every one of those twenty reads threw, was caught, and
// answered an empty collection. An empty observability page looks like a quiet
// system, so nobody noticed: a broken query and a fleet that had not been
// called rendered identically. Marking the caught failures `degraded` made the
// gap visible; this file is the other half — the data that makes the surface
// answer for real offline.
//
// THERE IS ONE FLEET. The seeded rows below are derived from
// `mock/invocations.ts`'s `invocationTail` — the same 24 hours the Invocations
// list, Health's summary and the Architecture graph already count. Nothing here
// stores a total: a per-agent error count, a p99, an intervention tally and a
// tool error rate are all selectors over the rows this module projects, so "25
// errors over a list that can only produce 6" cannot happen a second time.
// (contract.ts bug #1.)
//
// AND THERE IS ONE TABLE. `traceRows()` unions the seeded day with whatever
// `lib/trace-sink.ts` has WRITTEN this run (`mock/trace-sink.ts`). Before that
// union the two were separate worlds: a trace posted offline was judged and
// stored and readable by id, and appeared in no list and no rollup — the same
// count-vs-list defect in its widest form, two views of one table disagreeing
// with nothing saying so. The rules the union follows, and what it preserves,
// are at `traceRows()`.
//
// WHAT IS AUTHORED AND WHAT IS DERIVED. Authored — and therefore a registered
// fixture — is what the tail does not already say: which prompt templates an
// agent serves, how well it scores, how far its outputs sit from their own
// centroid, whether it uses AgentCore Memory, and what a token costs it. Every
// other value on a trace row is a deterministic function of the tail row plus
// that profile, so a change to either moves every rollup together.
//
// WIRE STRINGS ARE NOT INVENTED.
//   * Column names are the ones in schema/observability_schema.sql and its
//     sprint1/sprint2 ALTERs — the selectors here return SNAKE_CASE rows in the
//     exact shape `exec()` returns, so the route's own `rows.map(...)` still
//     produces the wire body and the mock cannot drift into a second shape.
//   * `rule_category` is PII / TOPIC / CONTENT / PROMPT_ATTACK, copied from the
//     comment on `observability.guardrail_interventions` and from the switch in
//     portal/src/pages/observability/GuardrailRulesPage.tsx.
//   * Guardrail RULE names are read from the guardrail fixture in
//     mock/capabilities.ts — the rules the Guardrails page shows as configured
//     in this same process. A rule that fires is a rule you can go and look at.
//   * `prompt_version` is the short SHA of the newest revision that agent has
//     in mock/prompt-versions.ts, so the Prompt Versions page and a trace's
//     provenance chip agree.
//   * `user_id` values are `app_users.id` from the identity seed
//     (providers/identity.ts), not invented logins.
//   * Timestamps rendered into `::text` columns use the Postgres text form
//     (`2026-09-08 14:03:11+00`), which is what the RDS Data API actually hands
//     back — an ISO string here would be a second shape the server never sends.
//
// THE ONE MODELLED SCALAR. `output_embedding` is a vector(1024) and the drift
// queries compute `embedding <=> centroid` in the database. A SEEDED row has no
// embedding — there is nothing to embed a fictional answer with — so
// `modelledDistance()` stands in for that expression: a deterministic per-row
// scalar drawn from the agent's authored drift band. It is not presented as a
// column and nothing stores a p95 — the rollups compute PERCENTILE_CONT over
// these per-row values exactly as Postgres would. This is the only number on
// this surface that is modelled rather than counted, and it is called out again
// where it is used. A WRITTEN row is the exception: the offline sink embeds for
// real, so its distance is measured against the mean of that agent's written
// vectors rather than modelled at all.

import { clock, defineFixture, type ScenarioName } from './core/index.js';
import { agentFleet } from './agent-statuses.js';
import { mockInvocationRows } from './invocations.js';
import { mockListPromptVersions } from './prompt-versions.js';
import { mockGuardrailRow } from './capabilities.js';
import type { AgentStepRecord } from '../lib/pipeline-runs.js';
import {
  cosineDistance,
  sinkAgentCentroid,
  sinkGuardrailInterventions,
  sinkMemoryEvents,
  sinkToolCalls,
  sinkTraces,
} from './trace-sink.js';

// ── Deterministic pseudo-randomness ────────────────────────────────────────
//
// Every "varying" value below is a pure function of the row's id. Nothing here
// calls Math.random: two reads of the same world must produce the same corpus,
// or a detail page could disagree with the list that linked to it.

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable value in [0, 1) for a key. */
function unit(key: string): number {
  return hash32(key) / 4294967296;
}

function pick<T>(list: readonly T[], key: string): T | undefined {
  if (list.length === 0) return undefined;
  return list[hash32(key) % list.length];
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ── Time rendering ─────────────────────────────────────────────────────────

/**
 * The Postgres text form of a timestamptz, which is what a `::text` cast comes
 * back as through the RDS Data API — `2026-09-08 14:03:11+00`, not an ISO
 * string. The mock has to speak the server's dialect here: the portal parses
 * whatever it is given, so a divergence would be invisible until something
 * compared two of them.
 */
export function pgTimestamp(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}+00`;
}

/**
 * `to_timestamp(floor(EXTRACT(EPOCH FROM ts) / (bucket*60)) * (bucket*60))` —
 * the epoch-floor bucketing every timeseries read in these routers uses, so a
 * bucket boundary lands on the same wall-clock instant offline as it does in
 * the database.
 */
export function bucketStart(iso: string, bucketMin: number): string {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  const width = Math.max(1, bucketMin) * 60;
  return pgTimestamp(Math.floor(seconds / width) * width * 1000);
}

/**
 * Same epoch-floor bucketing as `bucketStart`, but as epoch ms rather than a
 * `::text` string. `oncall.ts`'s HITL-by-bucket read needs the numeric bucket
 * END (`bucket_start + bucketMin minutes`) to decide whether an approval was
 * still pending at that boundary — arithmetic that only works on a number, not
 * on the Postgres text form the wire actually carries.
 */
export function bucketStartMs(iso: string, bucketMin: number): number {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  const width = Math.max(1, bucketMin) * 60;
  return Math.floor(seconds / width) * width * 1000;
}

// ── Statistics ─────────────────────────────────────────────────────────────

/**
 * Postgres `PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x)` — linear
 * interpolation between the two nearest ranks, and NULL over no rows.
 *
 * Deliberately NOT the nearest-rank `durationPercentile` in mock/invocations.ts:
 * these routes' live branch uses PERCENTILE_CONT, and a mock that answered the
 * discrete percentile would disagree with the deployed surface by a few
 * milliseconds for reasons no reader could ever reconstruct.
 */
export function percentileCont(
  values: readonly (number | null | undefined)[],
  p: number,
): number | null {
  // NULLs are skipped, not zero-filled — `PERCENTILE_CONT` is an aggregate and
  // aggregates ignore NULL. Averaging a missing duration in as 0 would drag
  // every percentile toward a value no request took, which is the same class of
  // mistake as counting an ungraded row as a zero judge score.
  const sorted = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

// ── The authored half: per-agent telemetry profiles ────────────────────────

/**
 * What the invocation tail does not say about an agent.
 *
 * No field here is a count or a total. `judgeCentre`/`judgeSpread` describe a
 * BAND that individual rows are drawn from — the reported p50 and p05 are then
 * percentiles over the rows actually drawn, not these numbers echoed back.
 */
export interface AgentTelemetryProfile {
  agentId: string;
  /** Prompt templates this agent serves. `template_id` is free text in the schema. */
  templates: string[];
  /** Centre of the judge-score band for an answer that got graded at all. */
  judgeCentre: number;
  /** Half-width of that band. */
  judgeSpread: number;
  /** Centre of the modelled distance-to-centroid band. See modelledDistance(). */
  driftCentre: number;
  /** Half-width of that band. */
  driftSpread: number;
  /** Whether this agent calls AgentCore Memory. */
  usesMemory: boolean;
  /** USD per 1k input tokens. */
  usdPer1kIn: number;
  /** USD per 1k output tokens. */
  usdPer1kOut: number;
}

/**
 * The fleet's telemetry character.
 *
 * The bands are chosen so each agent's `status` in mock/agent-statuses.ts is
 * legible from its own numbers as well as its own traffic: ingestion, the one
 * agent marked `degraded`, is the one whose judge band dips under 0.3 and whose
 * drift band is wide. Everyone else scores well and sits close to its centroid.
 * Scoring never fails and never drifts, which is what makes "no findings" on
 * the drift page worth trusting when you see it.
 *
 * `empty` — the span projector has written nothing. Every observability read
 *           answers a real, honest zero: no traces, no tool calls, no
 *           interventions, no memory ops. This is the state of a fleet that is
 *           deployed but whose spans have not landed in Aurora yet, and it is
 *           the world the "no data in this window" copy is written for.
 * `error` — the observability schema is unreachable. Reading throws, which is
 *           how an auditor reaches every one of these routes' `degraded`
 *           answers over HTTP —
 *           `POST /api/__mock/scenario {"scenario":"error","fixture":"observability-agent-profiles"}`
 *           — instead of unplugging a network, and what proves the degraded
 *           answer and the empty answer read differently.
 */
export const agentTelemetryProfiles = defineFixture<AgentTelemetryProfile>({
  key: 'observability-agent-profiles',
  scenarios: {
    default: (): AgentTelemetryProfile[] => [
      {
        agentId: 'orgiq-supervisor',
        templates: ['orgiq.supervisor.route', 'orgiq.supervisor.summarize'],
        judgeCentre: 0.84, judgeSpread: 0.11,
        driftCentre: 0.09, driftSpread: 0.05,
        usesMemory: true,
        usdPer1kIn: 0.0008, usdPer1kOut: 0.0032,
      },
      {
        agentId: 'orgiq-search',
        templates: ['orgiq.search.retrieve', 'orgiq.search.people', 'orgiq.search.decisions'],
        judgeCentre: 0.81, judgeSpread: 0.13,
        driftCentre: 0.12, driftSpread: 0.06,
        usesMemory: true,
        usdPer1kIn: 0.0008, usdPer1kOut: 0.0032,
      },
      {
        agentId: 'orgiq-scoring',
        templates: ['orgiq.scoring.recompute'],
        judgeCentre: 0.88, judgeSpread: 0.06,
        driftCentre: 0.05, driftSpread: 0.02,
        usesMemory: false,
        usdPer1kIn: 0.00006, usdPer1kOut: 0.00024,
      },
      {
        agentId: 'orgiq-advisor',
        templates: ['orgiq.advisor.gaps', 'orgiq.advisor.pairing'],
        judgeCentre: 0.76, judgeSpread: 0.16,
        driftCentre: 0.18, driftSpread: 0.08,
        usesMemory: true,
        usdPer1kIn: 0.0008, usdPer1kOut: 0.0032,
      },
      {
        // The degraded one. Its band reaches under 0.3, so `lowQualityRate` is
        // non-zero for exactly the agent whose status already says `degraded` —
        // and it is non-zero because rows scored low, not because a rate was
        // typed next to them.
        agentId: 'orgiq-ingestion',
        templates: ['orgiq.ingestion.extract', 'orgiq.ingestion.sync'],
        judgeCentre: 0.44, judgeSpread: 0.28,
        driftCentre: 0.34, driftSpread: 0.14,
        usesMemory: false,
        usdPer1kIn: 0.00006, usdPer1kOut: 0.00024,
      },
      {
        agentId: 'orgiq-graph-builder',
        templates: ['orgiq.graph.merge', 'orgiq.graph.embed'],
        judgeCentre: 0.83, judgeSpread: 0.09,
        driftCentre: 0.08, driftSpread: 0.04,
        usesMemory: false,
        usdPer1kIn: 0.00006, usdPer1kOut: 0.00024,
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('observability.invocation_traces unavailable: relation does not exist');
    },
  },
});

// ── The authored half: human labels ────────────────────────────────────────

/**
 * A researcher's verdict on one invocation — `invocation_traces.human_label`
 * and `human_note`, which are the only two columns on a trace row a human
 * writes rather than an agent.
 *
 * This is its own fixture rather than a field on the projection because it is
 * the one thing on this surface that is WRITTEN at run time:
 * `POST /api/observability/quality/feedback` upserts here, so a demo label
 * survives to the next GET and `POST /api/__mock/reset` takes it away again.
 * A projection cannot hold a mutation; a fixture can.
 *
 * `empty` — nobody has labelled anything, which is where every deployment
 *           starts and what the label column's `—` is for.
 */
export interface HumanLabelRow {
  invocationId: string;
  label: string;
  note: string | null;
}

const ALLOWED_HUMAN_LABELS = new Set(['good', 'bad', 'fixed']);

/**
 * Resolve a label's row by CONTENT, not position.
 *
 * Each entry below is a demo narrative about a specific invocation — a
 * timeout, a guardrail miss, an answer worth citing — and `mock-inv-N` is a
 * RANK, not an identity: `mock/invocations.ts` interleaves the day's errors
 * through its tail (docs/mock-floor.md, "The error band, and what it
 * costs"), so the id a given prompt lands at moves whenever the corpus's
 * volume or error mix does. A hardcoded id here would silently detach a note
 * from the row it describes the next time the corpus changed shape — which is
 * exactly what interleaving did to the id that used to be 'mock-inv-0'. Anchor
 * by `agentId` + `promptSnippet` (both stable — they're the AUTHORED text)
 * instead, so a label stays on the row its note is actually about.
 */
function labelTarget(agentId: string, promptSnippet: string): string {
  const row = mockInvocationRows().find((r) => r.agentId === agentId && r.promptSnippet === promptSnippet);
  if (!row) {
    throw new Error(`observability.ts: no seeded row for human-label target ${agentId} / "${promptSnippet}"`);
  }
  return row.id;
}

export const humanLabels = defineFixture<HumanLabelRow>({
  key: 'observability-human-labels',
  scenarios: {
    default: (): HumanLabelRow[] => [
      {
        invocationId: labelTarget(
          'orgiq-supervisor',
          'Route this to the scoring agent and get PageRank for the platform team',
        ),
        label: 'bad',
        note: 'Timed out mid-route; the sub-agent never answered.',
      },
      {
        invocationId: labelTarget('orgiq-search', 'What is our employee compensation band for L5 engineers?'),
        label: 'bad',
        note: 'Blocked on a question the guardrail should not have caught.',
      },
      {
        invocationId: labelTarget('orgiq-supervisor', 'Who knows Kubernetes best on the platform team?'),
        label: 'good',
        note: null,
      },
      {
        invocationId: labelTarget('orgiq-search', 'Find every decision record mentioning Aurora cold starts'),
        label: 'good',
        note: 'Correct owner, correct citation.',
      },
      {
        invocationId: labelTarget('orgiq-ingestion', 'Ingest the Q3 all-hands recap deck'),
        label: 'fixed',
        note: 'Re-ran after the KB sync; answer is now grounded.',
      },
    ],
    empty: () => [],
  },
});

/**
 * Upsert a label. Returns false when the id is not one the tail serves, which
 * is how the route reproduces the real query's `RETURNING` miss → 404.
 */
export function mockSetHumanLabel(invocationId: string, label: string, note: string | null): boolean {
  if (!ALLOWED_HUMAN_LABELS.has(label)) return false;
  if (!traceRows().some((r) => r.invocation_id === invocationId)) return false;
  const rows = humanLabels.rows();
  const existing = rows.find((r) => r.invocationId === invocationId);
  if (existing) {
    existing.label = label;
    existing.note = note;
  } else {
    rows.push({ invocationId, label, note });
  }
  return true;
}

// ── HITL approvals ──────────────────────────────────────────────────────────

/**
 * One row of `observability.approvals`, in `exec()` shape — the table
 * `routes/oncall.ts` reads directly for the HITL alarm probe, the timeline
 * overlay and `/hitl-sla`. This is a SEPARATE table from `routes/approvals.ts`'s
 * own `mockStore` (which exists to keep the live request/decide/poll loop
 * working end-to-end under `MOCK_ENABLED`, in-memory, with no clock and no
 * scenario control) — that loop is out of scope here and untouched; this
 * fixture exists only so the four `oncall.ts` reads have honest offline rows
 * to summarise, following the same contract every other fixture in this file
 * does.
 *
 * `agent_id` is `orgiq-ingestion` on every row: it is the only one of the six
 * agents whose tool list actually carries `request_approval`
 * (`agents/ingestion/main.py`; `agents/supervisor/main.py` imports the tool
 * but does not wire it into its own `Agent(tools=[...])`), and it is also the
 * one agent the telemetry profile already marks `degraded` — a re-sync that
 * needs a human's sign-off before it overwrites or deletes KB content is
 * exactly the kind of action that agent's job produces.
 *
 * `default` — five requests over the last ~30 hours: one approved outside the
 *             default 24h window (so a wider `windowHours` shows something a
 *             24h read does not), two decided inside it (one within the 5-min
 *             SLA, one over it), one that timed out and auto-expired, and one
 *             still `PENDING` a few minutes old — recent enough that neither
 *             HITL alarm threshold (10m warning / 30m critical) fires, so the
 *             default demo stays quiet exactly where computeAlarms already
 *             is for this agent's quality signals.
 * `empty`   — no approval has ever been requested, which is the honest state
 *             before ingestion's first high-stakes sync.
 * `error`   — `observability.approvals` is unreachable, reached over HTTP the
 *             same way `agentTelemetryProfiles`'s `error` scenario is.
 */
export interface MockApprovalRow {
  /**
   * A real UUID, because the column is `uuid` and the single-row route
   * rejects anything that is not one before it queries (so a mistyped id is a
   * not-found rather than a Postgres cast error). Readable ids here meant the
   * seeded approvals could be listed and never decided — the offline HITL
   * loop was visible but not closable.
   */
  approval_id: string;
  tx_id: string;
  agent_id: string;
  /**
   * `observability.approvals.payload` — what the agent is asking to do.
   *
   * The SQL behind the queue selects it and the drawer renders it, so a
   * fixture standing in for that table has to carry it. Without it the
   * offline queue could only ever show a request with no substance, which is
   * the one thing a person deciding on it actually reads.
   */
  payload: Record<string, unknown>;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_note: string | null;
}

export const approvalRequests = defineFixture<MockApprovalRow>({
  key: 'observability-approvals',
  scenarios: {
    default: (): MockApprovalRow[] => [
      {
        approval_id: '7c1e9a20-0f41-4d8e-9a11-000000000001',
        payload: { prefix: 'legal/', chunksAffected: 42, action: 'overwrite' },
        tx_id: 'ing-sync-legal-updates-01',
        agent_id: 'orgiq-ingestion',
        reason: 'Re-sync would overwrite 42 existing KB chunks under legal/ with conflicting revision hashes.',
        status: 'APPROVED',
        requested_at: clock.hoursAgo(30),
        decided_at: clock.hoursAgo(29 + 57 / 60),
        decided_by: 'u-vera',
        decided_note: 'Confirmed the source bucket is authoritative — proceed.',
      },
      {
        approval_id: '7c1e9a20-0f41-4d8e-9a11-000000000002',
        payload: { source: 'slack-export', files: 3, flagged: 'possible-pii' },
        tx_id: 'ing-sync-perf-reviews-09',
        agent_id: 'orgiq-ingestion',
        reason: 'New Slack export batch has 3 files flagged as possible PII ahead of re-embedding.',
        status: 'REJECTED',
        requested_at: clock.hoursAgo(20),
        decided_at: clock.hoursAgo(20 - 15 / 60),
        decided_by: 'u-vera',
        decided_note: 'Redact the flagged files first, then resubmit.',
      },
      {
        approval_id: '7c1e9a20-0f41-4d8e-9a11-000000000003',
        payload: { prefix: 'adr/', documentsDeleted: 6, action: 'delete' },
        tx_id: 'ing-sync-adr-batch-14',
        agent_id: 'orgiq-ingestion',
        reason: 'Sync would delete 6 ADR documents no longer present in the source bucket.',
        status: 'APPROVED',
        requested_at: clock.hoursAgo(9),
        decided_at: clock.hoursAgo(9 - 3 / 60),
        decided_by: 'u-vera',
        decided_note: 'Confirmed those ADRs were deprecated last sprint — proceed.',
      },
      {
        approval_id: '7c1e9a20-0f41-4d8e-9a11-000000000004',
        payload: { corpus: 'all-hands-recap', action: 're-embed' },
        tx_id: 'ing-sync-allhands-recap-22',
        agent_id: 'orgiq-ingestion',
        reason: 'Re-embedding would replace the current all-hands recap corpus mid-day.',
        status: 'EXPIRED',
        requested_at: clock.hoursAgo(6),
        decided_at: clock.hoursAgo(6 - 5 / 60),
        decided_by: 'system',
        decided_note: 'auto-expired after 5min',
      },
      {
        approval_id: '7c1e9a20-0f41-4d8e-9a11-000000000005',
        tx_id: 'ing-sync-postmortem-03',
        agent_id: 'orgiq-ingestion',
        payload: { document: 'postmortem/auth-tenant-cutover-rehearsal-2.md', action: 'index', references: 'customer-token-claims' },
        reason: 'The post-mortem for the failed cutover rehearsal quotes a customer tenant\u2019s token claims — needs sign-off before indexing.',
        status: 'PENDING',
        requested_at: clock.hoursAgo(3 / 60, { keepWithinToday: true }),
        decided_at: null,
        decided_by: null,
        decided_note: null,
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('observability.approvals unavailable: relation does not exist');
    },
  },
});

// ── Trace rows ─────────────────────────────────────────────────────────────

/**
 * One row of `observability.invocation_traces`, in the shape `exec()` returns
 * it: snake_case keys, the same nullability the schema declares. The routes
 * map this to the wire, so there is exactly one mapping and the mock cannot
 * introduce a second.
 */
export interface MockTraceRow {
  invocation_id: string;
  agent_id: string;
  agent_name: string;
  template_id: string | null;
  prompt_snippet: string;
  response_snippet: string;
  judge_score: number | null;
  judge_rationale: string | null;
  schema_valid: boolean | null;
  pii_detected: boolean;
  guardrail_action: string | null;
  // Nullable, because the schema says so and a WRITTEN row can leave them
  // unset. Every seeded row carries all of them — it is projected from a tail
  // row that has a duration and a token count — but a trace posted to
  // `POST /api/observability/harness/trace` need not, and narrowing the type
  // to what the seed happens to hold is how a mock ends up disagreeing with
  // the column it is standing in for.
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  judge_input_tokens: number | null;
  judge_output_tokens: number | null;
  est_cost_usd: number | null;
  judge_cost_usd: number | null;
  total_cost_usd: number | null;
  prompt_version: string | null;
  model_id: string | null;
  runtime_image_digest: string | null;
  parent_invocation_id: string | null;
  user_id: string | null;
  session_id: string | null;
  /**
   * Pipelines P1 — the AG-UI run the bundle closed (`agui_run_id`), its
   * thread, its STEP_* record with TOOL_CALL_* attempts (`steps`), and the
   * invoking session's tenant. On the seeded half only the portal's Ask
   * traffic carries a run (see `attachAguiRuns`); a written row carries
   * whatever its bundle said.
   */
  agui_run_id: string | null;
  agui_thread_id: string | null;
  steps: AgentStepRecord[] | null;
  tenant: string | null;
  human_label: string | null;
  human_note: string | null;
  ts: string;
  /**
   * `vector(1024)`, and the only real one on this surface. NULL on every seeded
   * row — there is nothing to embed a fictional answer with — and populated on
   * a written row, because the offline sink embeds for real
   * (`lexicalEmbedding`, mock/trace-sink's `embedText` branch). `modelledDistance`
   * branches on exactly this: a row with a vector gets a measured distance, a
   * row without gets the modelled one.
   */
  output_embedding: number[] | null;
  /** ISO form of `ts`, for windowing. Not a column — never sent to a route. */
  tsIso: string;
  /**
   * Where the row came from. Not a column: `observability.invocation_traces`
   * cannot tell you whether a row was seeded, because in production nothing is.
   * It is here because the two halves of this union must be treated
   * differently by the DERIVED feeds — a written row brings its own tool
   * calls, its own fired rules and its own memory events, and synthesising a
   * second set beside them would be inventing telemetry for a real request.
   */
  source: 'seed' | 'sink';
  /**
   * The agent's authored profile, for the selectors. Not a column either, and
   * null on a written row: the profile is the fiction the seeded corpus is
   * drawn from, and a real row is not drawn from it. A written row for an
   * agent that HAS a profile still carries null here, because borrowing the
   * band would make a measured row report a modelled number.
   */
  profile: AgentTelemetryProfile | null;
}

/**
 * `app_users.id` values from the identity seed (providers/identity.ts). Only
 * the orgiq-tenant cast: an assessment-tenant user has no reason to appear in
 * the org fleet's traffic, and one would make `top-users` a cross-tenant leak
 * that the real `user_id` column could never produce here.
 */
const TRAFFIC_USERS = [
  'u-theo', 'u-vera', 'u-nora', 'u-eli', 'u-layla', 'u-caleb', 'u-mia', 'u-release',
] as const;

/** Rationales, banded, so the text a reader sees matches the score beside it; a key picks one so a page of rows does not repeat a sentence. */
const RATIONALES = {
  strong: [
    'Grounded in retrieved evidence, answers the question asked, cites its sources.',
    'Every claim traces to a retrieved document and the answer stays on the question.',
    'Names the right people and records, and the citations check out against the knowledge base.',
    'Direct answer, supported by the cited sources; nothing asserted without evidence.',
    'Correct and complete for the question, with sources a reader can open.',
    'Accurate on the specifics, and each one is backed by a document the agent actually retrieved.',
    'Stays inside what the sources say and says so where they are silent.',
    'The people and dates match the records, and the answer is short enough to act on.',
    'Complete answer with citations; the one inference is flagged as an inference.',
  ],
  middling: [
    'Answers the question but leaves one claim uncited; a reader would have to verify it.',
    'Mostly grounded, but one figure has no source and the scope is a little broad.',
    'Right direction, thin evidence: two of the three points are cited.',
    'Answers the question, though the reasoning skips a step a reader would want shown.',
    'Useful and mostly correct; one name is given without the record it came from.',
    'Covers the question but stops short of the follow-up a reader would ask next.',
    'Sound on the main point, with a date that does not match the cited document.',
  ],
  weak: [
    'Does not answer the question asked and cites nothing retrievable.',
    'Off the question: the answer discusses a neighbouring topic and cites no source.',
    'Asserts specifics with no supporting document, and one of them contradicts the records.',
    'Confident but unsupported: nothing in the answer can be traced to a retrieved source.',
    'Answers a different question from the one asked, and the citation points at an unrelated page.',
  ],
} as const;
function rationaleFor(score: number, key: string, agentName: string): string {
  const band = score >= 0.8 ? RATIONALES.strong : score >= 0.5 ? RATIONALES.middling : RATIONALES.weak;
  // The judge reads one agent's answer at a time, so the verdict names the agent: eight agents times a few
  // verdicts is a page of different sentences rather than one sentence pasted down a column.
  return `${agentName}: ${band[hash32(`${key}:rationale`) % band.length]!}`;
}

/**
 * `runtime_image_digest` — the ECR digest the runtime was pinned to when it
 * served the request. One per agent, stable across the day: a fleet whose rows
 * carried a different digest each is a fleet that redeployed on every call,
 * which is not what this column is recording.
 */
function imageDigestFor(agentId: string): string {
  let hex = '';
  for (let i = 0; hex.length < 64; i++) {
    hex += hash32(`${agentId}:image:${i}`).toString(16).padStart(8, '0');
  }
  return `sha256:${hex.slice(0, 64)}`;
}

/** `model_id` — the Bedrock id for the display model name the fleet fixture carries. */
function modelIdFor(displayModel: string): string {
  return `amazon.${displayModel}:0`;
}

/** Newest registered prompt revision for an agent, or null when it has none. */
function promptVersionFor(agentId: string): string | null {
  const mine = mockListPromptVersions(200).filter((r) => r.agentId === agentId);
  return mine[0]?.promptVersion ?? null;
}

/**
 * `output_embedding <=> centroid`, per row.
 *
 * TWO HALVES, AND ONLY ONE OF THEM IS MODELLED.
 *
 * A SEEDED row has no embedding — there are no 1024-dimension vectors behind a
 * fictional answer — so there is no cosine distance to take, and the drift
 * queries' whole subject is that expression. Rather than leave four reads
 * permanently degraded, each seeded row gets a deterministic scalar from its
 * agent's authored drift band, and every drift rollup is then a real
 * PERCENTILE_CONT over those per-row values — so the p95 a page shows is still
 * the p95 of the rows it can list, and switching an agent's band moves the
 * headline and the outlier list together. This is still the only number on
 * this surface that is not counted.
 *
 * A WRITTEN row is measured, not modelled. The offline sink embeds for real,
 * so the row carries a vector, and its distance is the genuine cosine distance
 * to the mean of that agent's written vectors — `AVG(output_embedding)`, which
 * is the centroid the drift SQL itself subqueries. One written row is its own
 * centroid and therefore sits at distance 0, which is exactly what the SQL
 * returns for a single-row window; it is not a stand-in for anything.
 *
 * A row with no graded output (an error, or a blocked answer) has no embedding
 * to compare, exactly as it would have none in the database: null, and the
 * drift queries skip it via their `output_embedding IS NOT NULL` predicate.
 */
export function modelledDistance(row: MockTraceRow): number | null {
  if (row.source === 'sink') {
    if (!row.output_embedding) return null;
    const centroid = sinkAgentCentroid(row.agent_id);
    if (!centroid) return null;
    return round(cosineDistance(row.output_embedding, centroid), 4);
  }
  if (row.response_snippet === '') return null;
  if (!row.profile) return null;
  const { driftCentre, driftSpread } = row.profile;
  const jitter = (unit(`${row.invocation_id}:dist`) - 0.5) * 2 * driftSpread;
  return round(Math.max(0, driftCentre + jitter), 4);
}

/**
 * The whole of `observability.invocation_traces`, offline: the seeded day of
 * traffic with everything this process has WRITTEN layered on top of it.
 *
 * ── The seeded half ────────────────────────────────────────────────────────
 * Every seeded row corresponds one-to-one with a row of `invocationTail`, so
 * the Invocations list, Health's summary, the Architecture graph and every
 * rollup on this surface are four readings of one fleet. An agent with no
 * telemetry profile contributes nothing — that is what makes the `empty`
 * profile scenario a true "the projector has written nothing" rather than a
 * half-world.
 *
 * ── The written half, and why it had to be unioned in ──────────────────────
 * `lib/trace-sink.ts` writes into `mock/trace-sink.ts` offline. Until this
 * union those rows were reachable only by id: a trace posted to
 * `POST /api/observability/harness/trace` was sampled, embedded, judged and
 * stored, was counted in `GET /api/__mock/state`, could be re-judged — and
 * did not appear in `GET /api/observability/invocations/search` or in a single
 * rollup, because both read this function. Two views of one table that
 * disagreed, with nothing saying so, which is the class of defect this whole
 * fixture directory exists to remove.
 *
 * ── What the union preserves, exactly ──────────────────────────────────────
 * The seeded tail is LOAD-BEARING for six other surfaces and is left bit-for-bit
 * alone:
 *
 *   * The seeded rows are built first and unchanged — same ids, same instants,
 *     same bands. Nothing is re-derived from the union, and no seeded row can
 *     see a written one.
 *   * `linkA2aParents` runs over the seeded rows ONLY, before the merge. A
 *     written row carries the `parent_invocation_id` it was posted with; it
 *     neither acquires a fictional parent nor becomes one.
 *   * The two halves are MERGED by instant, newest first — the order each
 *     half already had — never re-sorted. Written rows are stamped at write
 *     time and so land ahead of the whole day, which is what "layered on
 *     top" means; neither half can be reordered within itself, so with
 *     nothing written this function returns the identical array it returned
 *     before the union existed.
 *   * The DERIVED feeds — tool calls, guardrail interventions, memory events —
 *     synthesise from the seeded half only. A written trace brings its own,
 *     which `mock/trace-sink.ts` already holds, and manufacturing a second set
 *     beside them would be inventing telemetry for a request that really ran.
 *
 * A written row is therefore additive: with an empty sink every number on
 * every rollup is unmoved, and each posted trace moves them by exactly the one
 * row it is.
 */
export function traceRows(scenario?: ScenarioName): MockTraceRow[] {
  return mergeByInstant(seededTraceRows(scenario), writtenTraceRows(scenario));
}

/**
 * Newest first, stable.
 *
 * Both inputs are already in that order, so this is a merge rather than a
 * sort — and being a merge is the point: `Array.prototype.sort` is stable in
 * V8, but a merge cannot reorder within either input at all, which is the
 * guarantee the seeded tail needs.
 */
function mergeByInstant(seeded: MockTraceRow[], written: MockTraceRow[]): MockTraceRow[] {
  if (written.length === 0) return seeded;
  const out: MockTraceRow[] = [];
  let i = 0;
  let j = 0;
  while (i < written.length && j < seeded.length) {
    // `>=` keeps a written row ahead of a seeded row stamped at the same
    // instant: it is the newer of the two, since the seeded instant is a
    // rounded offset from the same clock.
    out.push(written[i]!.tsIso >= seeded[j]!.tsIso ? written[i++]! : seeded[j++]!);
  }
  while (i < written.length) out.push(written[i++]!);
  while (j < seeded.length) out.push(seeded[j++]!);
  return out;
}

/** The seeded day, exactly as it was before the sink was unioned in. */
function seededTraceRows(scenario?: ScenarioName): MockTraceRow[] {
  const profiles = new Map(agentTelemetryProfiles.rows(scenario).map((p) => [p.agentId, p]));
  if (profiles.size === 0) return [];

  const fleet = new Map(agentFleet.rows(scenario).map((a) => [a.id, a]));
  const labels = new Map(humanLabels.rows(scenario).map((l) => [l.invocationId, l]));

  const rows: MockTraceRow[] = [];
  for (const src of mockInvocationRows(scenario)) {
    const profile = profiles.get(src.agentId);
    if (!profile) continue;

    const id = src.id;
    const blocked = !!src.guardrailIntervened;
    const errored = !!src.error;
    // A row with no answer has nothing to grade. Null here rather than zero:
    // `judge_score` is nullable in the schema precisely so "not judged" and
    // "judged badly" stay different, and PERCENTILE_CONT skips a NULL while
    // it would happily average a 0 into the fleet's median.
    const graded = !blocked && !errored;
    const judge = graded
      ? round(
          Math.min(1, Math.max(0, profile.judgeCentre + (unit(`${id}:judge`) - 0.5) * 2 * profile.judgeSpread)),
          3,
        )
      : null;

    const estCost = round(
      (src.tokensIn / 1000) * profile.usdPer1kIn + (src.tokensOut / 1000) * profile.usdPer1kOut,
      6,
    );
    // The judge is a second model call over the prompt and the response, so it
    // reads roughly what the invocation produced and writes a short verdict.
    const judgeIn = graded ? Math.round((src.tokensIn + src.tokensOut) * 0.6) : null;
    const judgeOut = graded ? 48 : null;
    const judgeCost = judgeIn !== null && judgeOut !== null
      ? round((judgeIn / 1000) * 0.0008 + (judgeOut / 1000) * 0.0032, 6)
      : null;

    const u = unit(`${id}:user`);
    // ~1 row in 12 carries no user — a scheduled or agent-to-agent call. This
    // is what `top-users`' "skip rows with no user_id" is actually for, and
    // with every row attributed the filter would be untestable offline.
    const userId = u < 1 / 12 ? null : pick(TRAFFIC_USERS, `${id}:who`) ?? null;
    // A session is a few hours of one user's work, so several rows share one —
    // which is what makes `unique_sessions` differ from `invocations` and what
    // gives memory's cold-session rollup something to group by.
    const sessionId = userId
      ? `sess-${userId}-${Math.floor(src.hoursAgo / 3)}`
      : null;

    const label = labels.get(id) ?? null;
    const displayModel = fleet.get(src.agentId)?.model ?? 'nova-lite-v1';

    rows.push({
      invocation_id: id,
      agent_id: src.agentId,
      agent_name: src.agentName,
      template_id: pick(profile.templates, `${id}:tpl`) ?? null,
      prompt_snippet: src.promptSnippet,
      response_snippet: src.responseSnippet,
      judge_score: judge,
      judge_rationale: judge === null ? null : rationaleFor(judge, id, src.agentName),
      // Non-conforming output is what `schema_valid = false` means, and it is
      // half of what `errorRate` counts. A run that threw produced nothing that
      // could conform; a run that answered did.
      schema_valid: errored ? false : true,
      pii_detected: blocked && unit(`${id}:pii`) < 0.5,
      guardrail_action: blocked ? 'BLOCKED' : null,
      duration_ms: src.durationMs,
      input_tokens: src.tokensIn,
      output_tokens: src.tokensOut,
      judge_input_tokens: judgeIn,
      judge_output_tokens: judgeOut,
      est_cost_usd: estCost,
      judge_cost_usd: judgeCost,
      total_cost_usd: round(estCost + (judgeCost ?? 0), 6),
      prompt_version: promptVersionFor(src.agentId),
      model_id: modelIdFor(displayModel),
      runtime_image_digest: imageDigestFor(src.agentId),
      parent_invocation_id: null, // linked below
      user_id: userId,
      session_id: sessionId,
      agui_run_id: null, // attached below
      agui_thread_id: null,
      steps: null,
      tenant: null,
      human_label: label?.label ?? null,
      human_note: label?.note ?? null,
      // Seeded answers were never embedded — there is no vector behind a
      // sentence nobody generated. `modelledDistance` is what stands in.
      output_embedding: null,
      ts: pgTimestamp(src.startedAt),
      tsIso: src.startedAt,
      source: 'seed',
      profile,
    });
  }

  linkA2aParents(rows);
  attachAguiRuns(rows, fleet);
  return rows;
}

/**
 * Give the portal's Ask traffic its AG-UI run (pipelines P1).
 *
 * WHICH ROWS. A supervisor row with a user is a streamed Ask — the portal
 * drives the supervisor's streaming path, and since P1 the middleware mints
 * the run id and the bundle carries it back. Everything else stays without
 * one, exactly as it would in the real table: a sub-agent the supervisor
 * called is invoked synchronously with no run of its own (it folds into its
 * parent's run through `parent_invocation_id`), and a row with no user is a
 * scheduled or agent-to-agent call that no AG-UI stream opened. The
 * projection counts those as unlinked; it does not drop them.
 *
 * WHAT THE STEPS ARE. Not authored: each step is one of the row's OWN derived
 * tool calls (`toolCallsForTrace`, the same function the tool_calls feed
 * reads), so a run's steps and the Tools page can never disagree about what
 * the invocation called or how long it took. The supervisor brackets each
 * routing call with STEP_STARTED/STEP_FINISHED, and that tool call is the
 * step's one attempt.
 */
function attachAguiRuns(rows: MockTraceRow[], fleet: Map<string, { tools: string[] }>): void {
  for (const row of rows) {
    if (row.agent_id !== 'orgiq-supervisor' || !row.user_id) continue;
    row.agui_run_id = uuidFrom(`${row.invocation_id}:agui-run`);
    row.agui_thread_id = row.session_id;
    row.tenant = 'orgiq';
    const calls = toolCallsForTrace(row, fleet.get(row.agent_id)?.tools ?? []);
    row.steps = calls.map((c, i): AgentStepRecord => {
      const finishedAt = c.duration_ms === null ? null : new Date(new Date(c.tsIso).getTime() + c.duration_ms).toISOString();
      const status = c.errored ? 'failed' : 'completed';
      const name = STEP_NAME_OF_TOOL[c.tool_name] ?? c.tool_name;
      return {
        stepId: `${name}-${i + 1}`, name, status, startedAt: c.tsIso, finishedAt,
        toolCalls: [{ toolCallId: c.tool_call_id, name: c.tool_name, status, startedAt: c.tsIso, finishedAt }],
      };
    });
  }
}

/** The step a supervisor tool call is bracketed as (agents/supervisor/main.py SUB_AGENT_STEP_NAMES). */
const STEP_NAME_OF_TOOL: Record<string, string> = {
  route_to_agent: 'route',
  synthesize_responses: 'synthesize',
};

/** A UUID-shaped id, deterministic in its key — the middleware mints v4s. */
function uuidFrom(key: string): string {
  let hex = '';
  for (let i = 0; hex.length < 32; i++) hex += hash32(`${key}:${i}`).toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The rows `lib/trace-sink.ts` has written this run, in the same shape.
 *
 * A projection, not a second corpus: every value comes off the written row,
 * and the two fields `invocation_traces` has no column for — `source` and
 * `profile` — say what the row is rather than dressing it as a seeded one.
 * Human labels are joined in because the label table keys on `invocation_id`
 * and nothing about it cares which half of the union the trace came from: a
 * posted trace can be labelled, and `mockSetHumanLabel` accepts it for exactly
 * that reason.
 *
 * Newest first, matching the seeded half. The sink appends, so its array is
 * oldest-first and is reversed here rather than sorted — the sink's own order
 * is the order the writes happened in and must not be re-derived.
 */
function writtenTraceRows(scenario?: ScenarioName): MockTraceRow[] {
  const written = sinkTraces.rows(scenario);
  if (written.length === 0) return [];
  const labels = new Map(humanLabels.rows(scenario).map((l) => [l.invocationId, l]));

  return written
    .map((r): MockTraceRow => {
      const label = labels.get(r.invocation_id) ?? null;
      return {
        invocation_id: r.invocation_id,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        template_id: r.template_id,
        prompt_snippet: r.prompt_snippet,
        response_snippet: r.response_snippet,
        judge_score: r.judge_score,
        judge_rationale: r.judge_rationale,
        schema_valid: r.schema_valid,
        pii_detected: r.pii_detected,
        guardrail_action: r.guardrail_action,
        duration_ms: r.duration_ms,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        judge_input_tokens: r.judge_input_tokens,
        judge_output_tokens: r.judge_output_tokens,
        est_cost_usd: r.est_cost_usd,
        judge_cost_usd: r.judge_cost_usd,
        total_cost_usd: r.total_cost_usd,
        prompt_version: r.prompt_version,
        model_id: r.model_id,
        runtime_image_digest: r.runtime_image_digest,
        parent_invocation_id: r.parent_invocation_id,
        user_id: r.user_id,
        session_id: r.session_id,
        agui_run_id: r.agui_run_id,
        agui_thread_id: r.agui_thread_id,
        steps: r.steps,
        tenant: r.tenant,
        human_label: label?.label ?? null,
        human_note: label?.note ?? null,
        output_embedding: r.output_embedding,
        ts: pgTimestamp(r.ts),
        tsIso: r.ts,
        source: 'sink',
        profile: null,
      };
    })
    .reverse();
}

/**
 * Attach a quarter of the specialist rows to the supervisor call that could
 * have made them.
 *
 * The supervisor fans out over A2A, so a real `invocation_traces` table has a
 * populated `parent_invocation_id` on the rows it delegated to — and the whole
 * point of the CLAUDE.md A2A gotcha is that when that column is NULL the
 * topology has no edges and the drill-down has no tree. A mock corpus with
 * every parent NULL would reproduce the bug rather than the fix.
 *
 * The candidate is the LATEST supervisor row at or before the child's own
 * instant, never merely the nearest: a parent that starts after its child is
 * not a parent, and picking by absolute distance produced exactly that — a
 * detail page whose "called by" link went forward in time.
 */
function linkA2aParents(rows: MockTraceRow[]): void {
  const supervisors = rows
    .filter((r) => r.agent_id === 'orgiq-supervisor')
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso));
  if (supervisors.length === 0) return;

  const at = supervisors.map((r) => new Date(r.tsIso).getTime());
  // A supervisor call delegates to a few specialists, not to everything that ran after it: without a cap the
  // latest supervisor of a quiet stretch adopted a dozen children and one run's title filled a page of artifacts.
  const MAX_CHILDREN = 3;
  const adopted = new Map<number, number>();
  for (const row of rows) {
    if (row.agent_id === 'orgiq-supervisor') continue;
    if (unit(`${row.invocation_id}:a2a`) >= 0.25) continue;
    const t = new Date(row.tsIso).getTime();
    let best = -1;
    for (let i = 0; i < at.length; i++) {
      if (at[i]! <= t) best = i;
      else break;
    }
    // Nothing had run yet when this one did — an orphan, which is also what a
    // real table holds for the oldest rows in any window.
    if (best < 0) continue;
    if ((adopted.get(best) ?? 0) >= MAX_CHILDREN) continue;
    adopted.set(best, (adopted.get(best) ?? 0) + 1);
    row.parent_invocation_id = supervisors[best]!.invocation_id;
  }
}

/**
 * The window every windowed read applies: `ts > now() - INTERVAL hours`, and
 * bounded above at `now` for the reason mock/invocations.ts states — a row
 * stamped in the future did not happen in the last day.
 */
export function tracesInWindow(hours: number, scenario?: ScenarioName): MockTraceRow[] {
  // The predicate is applied to these rows' OWN instants, not resolved through
  // the invocation tail's ids. It used to be the latter, and that is precisely
  // what made a written trace invisible to every windowed rollup: a row the
  // tail has never heard of could not be in any window, however recently it was
  // written. On the seeded half the two are the same test over the same
  // instants — `mock/invocations.ts` `invocationsInWindow` bounds at both ends
  // for the reason stated there, and so does this.
  const now = clock.now().getTime();
  const span = Math.max(0, hours) * 3_600_000;
  return traceRows(scenario).filter((r) => {
    const ms = new Date(r.tsIso).getTime();
    return Number.isFinite(ms) && ms <= now && now - ms <= span;
  });
}

/**
 * `(template_id NOT LIKE 'test:%' OR template_id IS NULL)` — the live-traffic
 * filter every read in these routers applies except the tool-error tail, which
 * deliberately keeps test rows so a researcher can debug a failing test case.
 */
export function excludeTestTraffic(rows: readonly MockTraceRow[]): MockTraceRow[] {
  return rows.filter((r) => r.template_id === null || !r.template_id.startsWith('test:'));
}

// ── Tool calls ─────────────────────────────────────────────────────────────

/** One row of `observability.tool_calls`, in `exec()` shape. */
export interface MockToolCallRow {
  tool_call_id: string;
  invocation_id: string;
  tool_name: string;
  started_at: string;
  // Nullable for the reason `MockTraceRow`'s numerics are: the schema says so,
  // and a WRITTEN tool call may carry none of them. Every derived row has all
  // three, because it is derived from a trace that does.
  duration_ms: number | null;
  input_size: number | null;
  output_size: number | null;
  errored: boolean;
  error_message: string | null;
  input_sample: string | null;
  output_sample: string | null;
  est_cost_usd: number | null;
  ts: string;
  /** Windowing + the join back to the trace. Not columns. */
  tsIso: string;
  trace: MockTraceRow;
}

/**
 * The tools each invocation called.
 *
 * Tool NAMES are not authored here — they are `agentFleet`'s `tools` array, the
 * same list the Architecture page shows on the agent card. An agent cannot call
 * a tool it is not documented as having, which is the sort of disagreement that
 * only shows up when somebody clicks through.
 *
 * An errored invocation's LAST tool call carries the invocation's own error
 * message. That is the same convention `routes/invocations.ts`'s detail branch
 * already used — `invocation_traces` has no error column, so an agent-level
 * failure surfaces as an errored tool row — and it means `GET /tools/errors`
 * and the Invocations list are showing the same failures, not two sets.
 *
 * ONLY THE SEEDED HALF IS SYNTHESISED. A written trace declares the tools it
 * called and `lib/trace-sink.ts` stores them; those rows are unioned in below
 * rather than replaced by a fresh invention, because a real request that called
 * one tool must not be shown as having called three.
 */
export function toolCallRows(scenario?: ScenarioName): MockToolCallRow[] {
  return [...derivedToolCalls(scenario), ...writtenToolCalls(scenario)];
}

function derivedToolCalls(scenario?: ScenarioName): MockToolCallRow[] {
  const fleet = new Map(agentFleet.rows(scenario).map((a) => [a.id, a]));
  const out: MockToolCallRow[] = [];

  for (const trace of seededTraceRows(scenario)) {
    out.push(...toolCallsForTrace(trace, fleet.get(trace.agent_id)?.tools ?? []));
  }
  return out;
}

/**
 * One seeded trace's tool calls — deterministic in the trace alone, so the
 * tool_calls feed above and a run's recorded steps (`attachAguiRuns`) read the
 * same calls from one derivation.
 */
function toolCallsForTrace(trace: MockTraceRow, tools: readonly string[]): MockToolCallRow[] {
  const out: MockToolCallRow[] = [];
  {
    if (tools.length === 0) return out;

    // One to three calls, deterministic per invocation, always starting from
    // the agent's first tool so a fleet-wide latency panel has a stable spine.
    const calls = 1 + (hash32(`${trace.invocation_id}:tools`) % Math.min(3, tools.length));
    const errored = trace.schema_valid === false;
    // Seeded rows always carry a duration — they are projected from a tail row
    // that has one — so the `?? 0` is a type narrowing, not a default anybody
    // reaches.
    const traceMs = trace.duration_ms ?? 0;
    let offsetMs = Math.round(traceMs * 0.08);

    for (let i = 0; i < calls; i++) {
      const toolName = tools[(hash32(`${trace.invocation_id}:t${i}`) + i) % tools.length]!;
      // Each call takes a slice of the invocation it belongs to, so a tool p99
      // can never exceed the invocation p99 that contains it.
      const share = 0.18 + unit(`${trace.invocation_id}:d${i}`) * 0.35;
      const durationMs = Math.max(1, Math.round(traceMs * share / calls));
      const isLast = i === calls - 1;
      const thisErrored = errored && isLast;
      const startedIso = new Date(new Date(trace.tsIso).getTime() + offsetMs).toISOString();
      offsetMs += durationMs;

      // Retrieval and embedding tools spend Bedrock money; a graph merge or a
      // score computation does not. `with_cost` on the latency rollup counts
      // the rows that carry one, so this has to be a real mix.
      const billable = /retrieve|search|embed|knowledge/i.test(toolName);

      out.push({
        tool_call_id: `${trace.invocation_id}-tc${i}`,
        invocation_id: trace.invocation_id,
        tool_name: toolName,
        started_at: pgTimestamp(startedIso),
        duration_ms: durationMs,
        input_size: 120 + (hash32(`${trace.invocation_id}:is${i}`) % 3800),
        output_size: thisErrored ? 0 : 80 + (hash32(`${trace.invocation_id}:os${i}`) % 9000),
        errored: thisErrored,
        error_message: thisErrored ? errorMessageFor(trace) : null,
        input_sample: trace.prompt_snippet.slice(0, 500) || null,
        output_sample: thisErrored ? null : (trace.response_snippet.slice(0, 500) || null),
        est_cost_usd: billable ? round(0.00004 + unit(`${trace.invocation_id}:c${i}`) * 0.0004, 6) : null,
        ts: pgTimestamp(startedIso),
        tsIso: startedIso,
        trace,
      });
    }
  }
  return out;
}

/**
 * The invocation's own failure text.
 *
 * It lives on the tail row (`MockInvocation.error`), not on the projected trace
 * — `invocation_traces` genuinely has no column for it — so it is looked up
 * from the one place that holds it rather than copied onto every projection.
 */
function errorMessageFor(trace: MockTraceRow): string | null {
  const src = mockInvocationRows().find((r) => r.id === trace.invocation_id);
  return src?.error ?? null;
}

/**
 * The tool calls `lib/trace-sink.ts` has written this run.
 *
 * `observability.tool_calls` has its own `ts DEFAULT now()`, which the sink
 * fixture does not carry; `started_at` — which it does, either from the caller
 * or from the clock at write time — is what every read here windows and orders
 * on, so it stands for both. That is the instant the call actually happened,
 * which is a better answer than a second stamp taken when the row was stored.
 *
 * A call whose trace is not in the union is DROPPED rather than shown
 * parentless: the rollups read `c.trace` for the agent and the test-traffic
 * filter, and a row that cannot answer those is a row no query could have
 * returned. That is also the honest handling of a phantom-dropped bundle whose
 * tool rows landed anyway.
 */
function writtenToolCalls(scenario?: ScenarioName): MockToolCallRow[] {
  const written = sinkToolCalls.rows(scenario);
  if (written.length === 0) return [];
  const traces = new Map(writtenTraceRows(scenario).map((t) => [t.invocation_id, t]));
  const seen = new Map<string, number>();
  const out: MockToolCallRow[] = [];

  for (const c of written) {
    const trace = traces.get(c.invocation_id);
    if (!trace) continue;
    const n = seen.get(c.invocation_id) ?? 0;
    seen.set(c.invocation_id, n + 1);
    out.push({
      // The DB mints a uuid. Offline the key has to be derivable from the row,
      // because the detail view links to it — invocation plus ordinal is the
      // same shape the derived half uses.
      tool_call_id: `${c.invocation_id}-stc${n}`,
      invocation_id: c.invocation_id,
      tool_name: c.tool_name,
      started_at: pgTimestamp(c.started_at),
      duration_ms: c.duration_ms,
      input_size: c.input_size,
      output_size: c.output_size,
      errored: c.errored,
      error_message: c.error_message,
      input_sample: c.input_sample,
      output_sample: c.output_sample,
      est_cost_usd: c.est_cost_usd,
      ts: pgTimestamp(c.started_at),
      tsIso: new Date(c.started_at).toISOString(),
      trace,
    });
  }
  return out;
}

// ── Guardrail interventions ────────────────────────────────────────────────

/** One row of `observability.guardrail_interventions`, in `exec()` shape. */
export interface MockInterventionRow {
  intervention_id: string;
  invocation_id: string;
  agent_id: string;
  rule_name: string;
  // Both nullable in the schema, and a WRITTEN row is where that shows: the
  // sink accepts a fired rule with no category and keeps a severity only when
  // it is one of LOW/MEDIUM/HIGH. Every derived row carries both, because the
  // rule it came from is one the guardrail fixture declares.
  rule_category: string | null;
  severity: string | null;
  action: string;
  matched_text: string | null;
  ts: string;
  tsIso: string;
}

interface ConfiguredRule {
  ruleName: string;
  ruleCategory: 'PII' | 'TOPIC' | 'CONTENT' | 'PROMPT_ATTACK';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  action: 'BLOCKED' | 'ANONYMIZED';
}

/**
 * The rules that can fire — read from the guardrail the Guardrails page shows
 * as attached in this same process (mock/capabilities.ts), never authored here.
 *
 * A rule that appears in the by-rule breakdown is therefore one an operator can
 * go and look at, toggle, and see disappear. Switch the `guardrail` fixture to
 * `empty` — a guardrail with no filters and no topics — and the breakdown
 * empties with it, which is the true reading of "nothing is configured to fire".
 */
function configuredRules(): ConfiguredRule[] {
  const guardrail = mockGuardrailRow();
  if (!guardrail) return [];
  const rules: ConfiguredRule[] = [];

  for (const filter of guardrail.piiFilters) {
    if (!filter.enabled) continue;
    rules.push({
      ruleName: filter.type,
      ruleCategory: 'PII',
      severity: filter.action === 'BLOCK' ? 'HIGH' : 'MEDIUM',
      action: filter.action === 'BLOCK' ? 'BLOCKED' : 'ANONYMIZED',
    });
  }
  for (const topic of guardrail.deniedTopics) {
    if (!topic.enabled) continue;
    rules.push({ ruleName: topic.name, ruleCategory: 'TOPIC', severity: 'HIGH', action: 'BLOCKED' });
  }
  if (guardrail.contentPolicy.promptAttackEnabled) {
    rules.push({ ruleName: 'PROMPT_ATTACK', ruleCategory: 'PROMPT_ATTACK', severity: 'HIGH', action: 'BLOCKED' });
  }
  if (guardrail.contentPolicy.misconductEnabled) {
    rules.push({ ruleName: 'MISCONDUCT', ruleCategory: 'CONTENT', severity: 'MEDIUM', action: 'BLOCKED' });
  }
  return rules;
}

/**
 * One row per fired rule. A single invocation can trip more than one — that is
 * why this table exists beside the opaque `invocation_traces.guardrail_action`
 * — so a blocked row trips one or two.
 *
 * Seeded rows only. A written trace posts the rules that actually fired and
 * `lib/trace-sink.ts` stores them; those come in below, unchanged. Firing a
 * fixture rule at a real request would be inventing an intervention, and the
 * by-rule breakdown is meant to be a list an operator can go and act on.
 */
export function interventionRows(scenario?: ScenarioName): MockInterventionRow[] {
  return [...derivedInterventions(scenario), ...writtenInterventions(scenario)];
}

function derivedInterventions(scenario?: ScenarioName): MockInterventionRow[] {
  const rules = configuredRules();
  if (rules.length === 0) return [];
  const out: MockInterventionRow[] = [];

  for (const trace of seededTraceRows(scenario)) {
    if (trace.guardrail_action === null) continue;
    const fired = 1 + (hash32(`${trace.invocation_id}:fired`) % Math.min(2, rules.length));
    for (let i = 0; i < fired; i++) {
      const rule = rules[(hash32(`${trace.invocation_id}:r${i}`) + i) % rules.length]!;
      out.push({
        intervention_id: `${trace.invocation_id}-gi${i}`,
        invocation_id: trace.invocation_id,
        agent_id: trace.agent_id,
        rule_name: rule.ruleName,
        rule_category: rule.ruleCategory,
        severity: rule.severity,
        action: rule.action,
        // The writer truncates at 200 chars; the prompt is what matched.
        matched_text: trace.prompt_snippet.slice(0, 200) || null,
        ts: trace.ts,
        tsIso: trace.tsIso,
      });
    }
  }
  return out;
}

/**
 * The interventions `lib/trace-sink.ts` has written this run.
 *
 * `observability.guardrail_interventions.ts` is `DEFAULT now()` and the sink
 * fixture carries no column for it, so the instant is taken from the trace the
 * rows belong to — which is the same transaction's `now()` in the real table,
 * to within the milliseconds nothing here measures. A row whose trace is not in
 * the union is dropped, on the same argument as the written tool calls.
 */
function writtenInterventions(scenario?: ScenarioName): MockInterventionRow[] {
  const written = sinkGuardrailInterventions.rows(scenario);
  if (written.length === 0) return [];
  const traces = new Map(writtenTraceRows(scenario).map((t) => [t.invocation_id, t]));
  const seen = new Map<string, number>();
  const out: MockInterventionRow[] = [];

  for (const g of written) {
    const trace = traces.get(g.invocation_id);
    if (!trace) continue;
    const n = seen.get(g.invocation_id) ?? 0;
    seen.set(g.invocation_id, n + 1);
    out.push({
      intervention_id: `${g.invocation_id}-sgi${n}`,
      invocation_id: g.invocation_id,
      agent_id: g.agent_id,
      rule_name: g.rule_name,
      rule_category: g.rule_category,
      severity: g.severity,
      action: g.action,
      matched_text: g.matched_text,
      ts: trace.ts,
      tsIso: trace.tsIso,
    });
  }
  return out;
}

// ── Memory events ──────────────────────────────────────────────────────────

/** One row of `observability.memory_events`, in `exec()` shape. */
export interface MockMemoryEventRow {
  memory_event_id: string;
  invocation_id: string | null;
  agent_id: string;
  session_id: string | null;
  kind: string;
  memory_id: string | null;
  query_text: string | null;
  /** Derived from `retrieved.length` — never stored beside it. */
  result_count: number | null;
  duration_ms: number | null;
  retrieved_summary: string | null;
  errored: boolean;
  error_message: string | null;
  ts: string;
  tsIso: string;
}

/**
 * A memory operation as the fixture holds it: what came BACK, not how many.
 *
 * `result_count` is projected as `retrieved.length` rather than stored, which
 * is rule 1 at the smallest scale that still matters — a stored 4 beside a list
 * of 3 summaries is the same defect as a summary claiming 25 errors over 6
 * rows, and `/stats`' cold-session rollup is computed from exactly this field.
 */
interface MemoryOp {
  invocationId: string;
  agentId: string;
  sessionId: string | null;
  kind: 'retrieve' | 'write' | 'summarize' | 'expire';
  queryText: string | null;
  retrieved: string[];
  durationMs: number;
  errored: boolean;
  errorMessage: string | null;
  tsIso: string;
}

/** Manual inserts from `POST /api/observability/memory/events`. */
export const memoryEventWrites = defineFixture<MockMemoryEventRow>({
  key: 'observability-memory-writes',
  scenarios: {
    // Nothing is seeded here on purpose: the seeded feed is the one DERIVED
    // from the fleet's own invocations below. This fixture holds only what a
    // caller has POSTed in this process, so `POST /api/__mock/reset` drops a
    // demo insert and leaves the real corpus intact.
    default: () => [],
  },
});

const MEMORY_ID = 'orgiq-memory-mock';

/**
 * The fleet's memory ops, derived from the invocations that made them.
 *
 * An agent whose profile says `usesMemory` retrieves before it answers and
 * writes after it succeeds. A retrieve that comes back with nothing is a COLD
 * session — the thing `/stats` exists to count — and it happens for the first
 * invocation of a session, which is exactly when it happens in production.
 *
 * Seeded rows only — a written trace posts its own memory events, and they are
 * unioned in by `memoryEventRows` rather than modelled a second time here.
 */
function derivedMemoryOps(scenario?: ScenarioName): MemoryOp[] {
  const ops: MemoryOp[] = [];
  const seenSession = new Set<string>();

  // Oldest first, so "the first invocation of a session" means the first one.
  const traces = seededTraceRows(scenario)
    .slice()
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso));

  for (const trace of traces) {
    if (!trace.profile?.usesMemory) continue;
    const sessionKey = `${trace.agent_id}|${trace.session_id ?? ''}`;
    const cold = trace.session_id !== null && !seenSession.has(sessionKey);
    if (trace.session_id !== null) seenSession.add(sessionKey);

    const retrieved = cold
      ? []
      : Array.from(
          { length: 1 + (hash32(`${trace.invocation_id}:mem`) % 4) },
          (_, i) => `${trace.agent_name} recalled: ${trace.prompt_snippet.slice(0, 60)} (#${i + 1})`,
        );

    // The degraded agent's memory calls fail sometimes too; that is what makes
    // `/stats`' errorRate non-zero for one agent and zero for the rest.
    const failed = trace.schema_valid === false && unit(`${trace.invocation_id}:memerr`) < 0.4;

    ops.push({
      invocationId: trace.invocation_id,
      agentId: trace.agent_id,
      sessionId: trace.session_id,
      kind: 'retrieve',
      queryText: trace.prompt_snippet.slice(0, 200),
      retrieved: failed ? [] : retrieved,
      durationMs: 18 + (hash32(`${trace.invocation_id}:mr`) % 240),
      errored: failed,
      errorMessage: failed ? 'AgentCore Memory RetrieveMemoryRecords timed out after 2000ms' : null,
      tsIso: trace.tsIso,
    });

    if (trace.schema_valid !== false && trace.guardrail_action === null) {
      ops.push({
        invocationId: trace.invocation_id,
        agentId: trace.agent_id,
        sessionId: trace.session_id,
        kind: 'write',
        queryText: null,
        retrieved: [],
        durationMs: 9 + (hash32(`${trace.invocation_id}:mw`) % 60),
        errored: false,
        errorMessage: null,
        // The write lands when the invocation finishes. Seeded rows always
        // carry a duration, so `?? 0` narrows rather than defaults.
        tsIso: new Date(new Date(trace.tsIso).getTime() + (trace.duration_ms ?? 0)).toISOString(),
      });
    }
  }
  return ops;
}

function toMemoryRow(op: MemoryOp, index: number): MockMemoryEventRow {
  return {
    memory_event_id: `${op.invocationId}-me${index}-${op.kind}`,
    invocation_id: op.invocationId,
    agent_id: op.agentId,
    session_id: op.sessionId,
    kind: op.kind,
    memory_id: MEMORY_ID,
    query_text: op.queryText,
    // Counted from the rows it summarises — see the MemoryOp doc.
    result_count: op.kind === 'retrieve' ? op.retrieved.length : null,
    duration_ms: op.durationMs,
    retrieved_summary: op.retrieved.length > 0 ? op.retrieved.join('; ').slice(0, 500) : null,
    errored: op.errored,
    error_message: op.errorMessage,
    ts: pgTimestamp(op.tsIso),
    tsIso: op.tsIso,
  };
}

/**
 * The whole memory feed: the fleet's own ops, anything POSTed to
 * `/api/observability/memory/events`, and the events a written trace declared.
 */
export function memoryEventRows(scenario?: ScenarioName): MockMemoryEventRow[] {
  const derived = derivedMemoryOps(scenario).map(toMemoryRow);
  return [...derived, ...memoryEventWrites.rows(scenario), ...writtenMemoryEvents(scenario)];
}

/**
 * The memory events `lib/trace-sink.ts` has written this run.
 *
 * Same timestamp argument as the written interventions: `memory_events.ts` is
 * `DEFAULT now()`, the sink fixture has no column for it, and the trace's own
 * instant is the one the real row would carry. A row whose trace is not in the
 * union is dropped — `/stats`' cold-session rollup groups by (agent, session)
 * and an orphan would be a session that never happened.
 */
function writtenMemoryEvents(scenario?: ScenarioName): MockMemoryEventRow[] {
  const written = sinkMemoryEvents.rows(scenario);
  if (written.length === 0) return [];
  const traces = new Map(writtenTraceRows(scenario).map((t) => [t.invocation_id, t]));
  const seen = new Map<string, number>();
  const out: MockMemoryEventRow[] = [];

  for (const e of written) {
    const trace = traces.get(e.invocation_id);
    if (!trace) continue;
    const n = seen.get(e.invocation_id) ?? 0;
    seen.set(e.invocation_id, n + 1);
    out.push({
      memory_event_id: `${e.invocation_id}-sme${n}-${e.kind}`,
      invocation_id: e.invocation_id,
      agent_id: e.agent_id,
      session_id: e.session_id,
      kind: e.kind,
      memory_id: e.memory_id,
      query_text: e.query_text,
      result_count: e.result_count,
      duration_ms: e.duration_ms,
      retrieved_summary: e.retrieved_summary,
      errored: e.errored,
      error_message: e.error_message,
      ts: trace.ts,
      tsIso: trace.tsIso,
    });
  }
  return out;
}

/** `POST /events` — append one manual row and hand back its id. */
export function mockInsertMemoryEvent(input: Omit<MockMemoryEventRow, 'memory_event_id' | 'ts' | 'tsIso'>): string {
  const rows = memoryEventWrites.rows();
  const iso = clock.nowIso();
  const id = `mock-me-${rows.length + 1}`;
  rows.push({ ...input, memory_event_id: id, ts: pgTimestamp(iso), tsIso: iso });
  return id;
}
