// The board — `work_items`, offline.
//
// These 100-odd rows were a `MOCK_WORK_ITEM_SEEDS` array plus a
// `mockWorkItemsCache` inside providers/work-items.ts. They moved here for the
// reason the floor names in contract.ts #4: every write on this surface
// mutated a bare module-level array, so `POST /api/__mock/reset` could not put
// the board back.
//
// The consequences were concrete. `POST /api/graph/work-items` appends a row
// nothing removes; `PATCH /api/graph/work-items/:id` edits a seeded row in
// place; `lib/bot-runner.ts` claims an item (`open` -> `in_progress`) and
// settles it, and `lib/sdlc-pipeline.ts` moves it to `in_review`. The wire
// capture could therefore only replay the PATCH as an *echo-back* — writing
// the item's own current priority back so the row ended byte-identical — which
// pins a response shape while proving nothing about the write. Behind a
// fixture, a real edit is undoable and the echo-back is no longer the only
// safe replay.
//
// THE STAMPS ARE OFFSETS, NOT INSTANTS, and deliberately stay that way.
// `D(n)` is "n days before MOCK_EPOCH", and `mockReprojectedIso` (still in the
// provider, because providers/activity.ts imports it) replays that offset from
// the real clock at READ time. Routing the seeds through `clock.daysAgo`
// instead would have been the obvious move and is wrong here: the *relative*
// spacing between a row's createdAt, updatedAt and completedAt is what the
// activity feed and the parity harness read, and MOCK_EPOCH is the one anchor
// both the feed and providers/activity.ts's graph reproject from. What did
// change is how the anchor is spelled — `Date.UTC(...)` rather than an ISO
// string literal, because a literal timestamp under src/mock is a mint frozen
// at edit time and rule 3 rejects it on sight.
//
// IDS ARE PART OF THE CONTRACT. Every `wi-*` id below is lifted from
// schema/seed_program.sql and is asserted against it by the parity harness
// (`core/parity/entities.ts`, coverage `complete`), so they are written out
// rather than generated. A row created at run time takes `nextMockWorkItemId`,
// a high-water mark read off the live rows — a module counter would re-mint
// `wi-mock-1` after a reset had already given it back to nobody, or keep
// climbing past a seed it no longer collides with.

import { clock, defineFixture } from './core/index.js';
import { mockSprintDates } from './sprints.js';
import { createHash } from 'node:crypto';
import { SEEDED_WORK_KEYS, WORK_KEY_PREFIXES } from '../lib/work-item-keys.js';
// Type-only, so it is erased at compile: providers/work-items.ts imports the
// fixture below at run time, and a value import back the other way would be a
// genuine cycle rather than a shared shape.
import type { WorkItem } from '../providers/work-items.js';
// The initiative name is NOT a seed field — it is read from the initiative
// list at build time, which is what stops a row labelling its initiative with
// a name that initiative does not have. This import closes a cycle
// (projects -> work-items -> here -> projects), which is safe only because
// `defineFixture` never runs its factory at import: by the time a row is
// built, every module in the ring is fully evaluated.
import { mockProjectName } from '../providers/projects.js';

/**
 * The fixed "today" every `D(n)` offset is written against. Real time keeps
 * moving, so this instant drifts further into the past — providers/work-items
 * re-exports it, and providers/activity.ts reprojects a mock `completedAt`
 * back onto the real calendar from it.
 *
 * `Date.UTC` rather than `new Date('2026-05-21T12:00:00Z')`: identical instant,
 * but an ISO literal in a fixture is a timestamp frozen at edit time, which is
 * the shape rule 3 forbids under src/mock.
 */
export const MOCK_EPOCH = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));

/**
 * `n` days before MOCK_EPOCH, as an ISO string.
 *
 * Fixed-length days in UTC, not `setDate(getDate() - n)`. The old spelling
 * walked the LOCAL calendar, so on a host observing DST a seeded offset that
 * crossed a transition came out an hour off — and everything downstream of
 * these stamps (`todayInUtc`, Aurora's `date_trunc('day', NOW())` in a UTC
 * session) buckets in UTC. D(0) is the epoch itself.
 */
const D = (days: number): string =>
  new Date(MOCK_EPOCH.getTime() - days * 86_400_000).toISOString();

// The fixtures predate sprint_id / estimated_cost_usd; rather than restate two
// nulls on every row, seeds omit what they don't carry and the normaliser below
// fills them in. Costs on the seeded rows follow the same ~$1.2/point curve the
// program seed uses (schema/seed_program.sql).
//
// `projectName` is NOT a seed field: it is derived from the initiative list in
// providers/projects.ts inside the rows factory below. Storing it
// is what let 19 rows label their initiative with a name it does not have.
// The estimate-provenance fields join sprintId/estimatedCostUsd as optional on
// a seed: no seeded item has an authorized estimate, which is the same truth
// the migration states — an item nobody has dispatched has no estimator, and
// inventing one here would put a fabricated decision in front of a reader.
type EstimateFields =
  | 'estimatedBy' | 'estimatedByName' | 'estimatedAt' | 'estimateModel' | 'estimateForecast'
  | 'estimateReviewedBy' | 'estimateReviewedByName' | 'estimateReviewedAt';

// The brief fields (schema/orgiq_work_items_schema.sql, "The work item's
// brief") are optional on a seed the same way: the program seed writes a brief
// for the in-flight items of the engineering arcs only (SEEDED_BRIEFS below),
// and every other row is null in the seed too — restating four nulls on ~100
// rows would be noise, not parity.
type BriefFields = 'summary' | 'blockedReason' | 'nextStep' | 'nextStepDetail' | 'blockedByDecisionId';

type MockSeed = Omit<WorkItem, 'projectName' | 'sprintId' | 'estimatedCostUsd' | 'childCount' | 'childDoneCount' | EstimateFields | BriefFields>
  & Partial<Pick<WorkItem, 'sprintId' | 'estimatedCostUsd' | EstimateFields | BriefFields>>;

const MOCK_WORK_ITEM_SEEDS: MockSeed[] = [
  // The "Kubernetes Cluster Upgrade" family that used to open here (wi-k8s-*,
  // 16 items) was hard-coded onto p-observability with no basis in
  // schema/seed_program.sql — that seed's Observability Platform initiative
  // is telemetry/SLO work (wi-obs-*, below), never a Kubernetes upgrade, and
  // the fabricated items were assigned to Theo Chang/Vera Green/Marcus
  // Shah/Caleb Turner, none of whom are p-observability's real owner (p-004)
  // or SMEs (p-008, p-011) per the seed's contribution table. The initiative's
  // owner opened Work to 17 items, 14 of them a phantom narrative the seed
  // never gave it. Removed rather than relocated: sme.md defect #8 — CLAUDE.md
  // promises this fallback mirrors seed_program.sql, and no seeded initiative
  // has a Kubernetes-upgrade epic to relocate it to. See the parity test in
  // __tests__/work-items.test.ts ("mirrors seed_program.sql's initiative for
  // every seeded item").

  // The four families that used to open here — wi-istio-* (11 items pointed at
  // p-zero-trust), wi-cicd-* (8 at p-llm-platform), wi-otel-* (12 at
  // p-inference-platform) and wi-cedar-* (7 at p-rag-search) — were the same
  // defect as the wi-k8s-* family above: 38 ids that appear in no
  // schema/seed_program.sql row, written about subject matter (Istio, GitHub
  // Actions, ADOT collectors, Cedar) their initiatives were never given. 19 of
  // them additionally carried a *foreign* initiative name in `projectName`, so
  // the Work tab labelled p-inference-platform "Unified Observability Stack"
  // and p-rag-search "Cedar Auth Policy Migration" directly under a header
  // reading Inference Platform / RAG Knowledge Search.
  //
  // Deleted rather than seeded: the seed ALREADY gives all four initiatives
  // work (4 + 10 + 4 + 4 rows), so nothing had to be added to
  // schema/seeds/generate_program_seed.py — the fixture just had to mirror
  // what was there. Those 22 rows follow, lifted from the seed ids and all,
  // the same way wi-obs-*/wi-auth-*/wi-mob-* are.

  // ── p-zero-trust — Segmentation blueprint (seed_program.sql:422-425) ───────
  { id: 'wi-zt-e1', projectId: 'p-zero-trust', parentId: null, type: 'epic', title: 'Segmentation blueprint', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null },
  { id: 'wi-zt-e1-s1', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'Service identity inventory across environments', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: ['identity'], storyPoints: 5, estimatedCostUsd: 5.35, sprintId: 'spr-zt-s1', prUrl: null, prStatus: null, createdAt: D(46), updatedAt: D(3), completedAt: null },
  { id: 'wi-zt-e1-s2', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'mTLS rollout plan with break-glass procedure', description: null, status: 'open', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: ['mtls'], storyPoints: 5, estimatedCostUsd: 4.39, sprintId: 'spr-zt-s1', prUrl: null, prStatus: null, createdAt: D(65), updatedAt: D(5), completedAt: null },
  { id: 'wi-zt-e1-s3', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'Policy engine selection ADR', description: null, status: 'open', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: ['adr'], storyPoints: 3, estimatedCostUsd: 3.58, prUrl: null, prStatus: null, createdAt: D(67), updatedAt: D(2), completedAt: null },

  // ── p-llm-platform — prompts, evals, serving (seed_program.sql:109-118) ───
  { id: 'wi-llm-e1', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Prompt management and canary', description: 'Prompts ship like code: drafted, canaried, judged, promoted.', status: 'in_progress', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null },
  { id: 'wi-llm-e1-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'story', title: 'Prompt registry with DRAFT/live resolution at runtime', description: null, status: 'done', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['prompts'], storyPoints: 5, estimatedCostUsd: 4.6, sprintId: 'spr-llm-s1', prUrl: 'https://github.com/connorhoehn/orgiq-llm-platform/pull/25', prStatus: 'merged', createdAt: D(31), updatedAt: D(4), completedAt: D(3) },
  { id: 'wi-llm-e1-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'story', title: 'LLM-as-judge canary rubric with weighted dimensions', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['canary', 'evals'], storyPoints: 8, estimatedCostUsd: 10.06, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(27), updatedAt: D(1), completedAt: null },
  { id: 'wi-llm-e1-b3', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'bug', title: 'Prompt cache stampede on TTL expiry under load', description: null, status: 'open', priority: 'medium', assigneeId: 'p-042', assigneeName: 'Katya Petrov', assigneeDept: 'ML / AI', labels: ['prompts', 'perf'], storyPoints: 3, estimatedCostUsd: 2.64, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(55), updatedAt: D(1), completedAt: null },
  { id: 'wi-llm-e2', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Evals and guardrails', description: 'No model or guardrail change lands without a regression verdict.', status: 'in_progress', priority: 'critical', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },
  { id: 'wi-llm-e2-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e2', type: 'story', title: 'Eval harness with golden sets per agent', description: null, status: 'in_review', priority: 'critical', assigneeId: 'p-042', assigneeName: 'Katya Petrov', assigneeDept: 'ML / AI', labels: ['evals'], storyPoints: 8, estimatedCostUsd: 6.9, sprintId: 'spr-llm-s2', prUrl: 'https://github.com/connorhoehn/orgiq-llm-platform/pull/29', prStatus: 'open', createdAt: D(53), updatedAt: D(5), completedAt: null },
  { id: 'wi-llm-e2-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e2', type: 'story', title: 'Guardrail regression suite wired into CI', description: null, status: 'open', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['guardrails', 'ci'], storyPoints: 5, estimatedCostUsd: 6.29, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(51), updatedAt: D(4), completedAt: null },
  { id: 'wi-llm-e3', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Serving efficiency', description: 'Token spend per request trends down while quality holds.', status: 'open', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null },
  { id: 'wi-llm-e3-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e3', type: 'story', title: 'Batch inference queue for non-interactive workloads', description: null, status: 'open', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['serving'], storyPoints: 8, estimatedCostUsd: 6.88, prUrl: null, prStatus: null, createdAt: D(69), updatedAt: D(4), completedAt: null },
  { id: 'wi-llm-e3-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e3', type: 'story', title: 'Token budget middleware with per-tenant ceilings', description: null, status: 'done', priority: 'medium', assigneeId: 'p-042', assigneeName: 'Katya Petrov', assigneeDept: 'ML / AI', labels: ['serving', 'budgets'], storyPoints: 3, estimatedCostUsd: 3.15, sprintId: 'spr-llm-s1', prUrl: 'https://github.com/connorhoehn/orgiq-llm-platform/pull/33', prStatus: 'merged', createdAt: D(64), updatedAt: D(0), completedAt: D(8) },

  // ── p-inference-platform — Serving reliability (seed_program.sql:393-396) ─
  { id: 'wi-inf-e1', projectId: 'p-inference-platform', parentId: null, type: 'epic', title: 'Serving reliability', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-049', assigneeName: 'Paolo Mancini', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null },
  { id: 'wi-inf-e1-s1', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'story', title: 'Autoscaling on queue depth instead of CPU', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-049', assigneeName: 'Paolo Mancini', assigneeDept: 'ML / AI', labels: ['autoscaling'], storyPoints: 8, estimatedCostUsd: 7.25, sprintId: 'spr-inf-s1', prUrl: null, prStatus: null, createdAt: D(52), updatedAt: D(4), completedAt: null },
  { id: 'wi-inf-e1-s2', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'story', title: 'Warm-pool management for large model loads', description: null, status: 'done', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['warm-pool'], storyPoints: 5, estimatedCostUsd: 5.65, sprintId: 'spr-inf-s1', prUrl: 'https://github.com/connorhoehn/orgiq-inference-platform/pull/29', prStatus: 'merged', createdAt: D(51), updatedAt: D(4), completedAt: D(9) },
  { id: 'wi-inf-e1-b3', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'bug', title: 'Cold-start p99 breaches SLA after scale-to-zero', description: null, status: 'open', priority: 'critical', assigneeId: 'p-049', assigneeName: 'Paolo Mancini', assigneeDept: 'ML / AI', labels: ['latency'], storyPoints: 3, estimatedCostUsd: 3.44, sprintId: 'spr-inf-s1', prUrl: null, prStatus: null, createdAt: D(65), updatedAt: D(4), completedAt: null },

  // ── p-rag-search — GA hardening, shipped (seed_program.sql:310-313) ───────
  { id: 'wi-rag-e1', projectId: 'p-rag-search', parentId: null, type: 'epic', title: 'GA hardening', description: null, status: 'done', priority: 'high', assigneeId: 'p-048', assigneeName: 'Lucas Kim', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: D(8) },
  { id: 'wi-rag-e1-s1', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Hybrid dense + keyword retrieval with fusion ranking', description: null, status: 'done', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['retrieval'], storyPoints: 8, estimatedCostUsd: 9.53, prUrl: 'https://github.com/connorhoehn/orgiq-rag-search/pull/51', prStatus: 'merged', createdAt: D(49), updatedAt: D(4), completedAt: D(8) },
  { id: 'wi-rag-e1-s2', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Citation grounding with source-span attribution', description: null, status: 'done', priority: 'high', assigneeId: 'p-048', assigneeName: 'Lucas Kim', assigneeDept: 'ML / AI', labels: ['grounding'], storyPoints: 5, estimatedCostUsd: 6.38, prUrl: 'https://github.com/connorhoehn/orgiq-rag-search/pull/56', prStatus: 'merged', createdAt: D(74), updatedAt: D(0), completedAt: D(6) },
  { id: 'wi-rag-e1-s3', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Retrieval eval harness with labeled query set', description: null, status: 'done', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['evals'], storyPoints: 5, estimatedCostUsd: 6.39, prUrl: 'https://github.com/connorhoehn/orgiq-rag-search/pull/60', prStatus: 'merged', createdAt: D(24), updatedAt: D(3), completedAt: D(7) },

  // ── Project: Mobile App Redesign ──────────────────────────────────────────
  //
  // The "Developer Onboarding Improvements" family that used to sit here
  // (wi-onboard-*, 4 items) was fabricated with no basis in
  // schema/seed_program.sql: it was pointed at p-mobile-redesign's id while
  // its own projectName said something else entirely, and its assignees
  // (Sienna Garcia, Owen Brooks, Arjun Shah) are not that initiative's
  // real owner (p-030) or SMEs (p-035, p-026). The Initiatives page's
  // hand-typed rollup (MOCK_INITIATIVES in providers/projects.ts) separately
  // claimed "23/51 pts" for the row while this fixture's real items summed to
  // 0/8 — list and detail disagreeing about the same initiative.
  // program-owner.md defect #3. Replaced with the real wi-mob-* family,
  // lifted straight from the seed (ids, assignees, points, sprint and PRs all
  // included) the same way wi-obs-*/wi-auth-* already are below, and the
  // rollup numbers in providers/projects.ts now derive from these same four
  // items instead of being restated by hand.
  { id: 'wi-mob-e1', projectId: 'p-mobile-redesign', parentId: null, type: 'epic', title: 'Navigation overhaul', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-030', assigneeName: 'Mia Singh', assigneeDept: 'Product', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },
  { id: 'wi-mob-e1-s1', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'story', title: 'Bottom-tab information architecture', description: null, status: 'done', priority: 'high', assigneeId: 'p-030', assigneeName: 'Mia Singh', assigneeDept: 'Product', labels: ['ia', 'ux'], storyPoints: 5, prUrl: 'https://github.com/connorhoehn/orgiq-mobile-app/pull/45', prStatus: 'merged', createdAt: D(44), updatedAt: D(1), completedAt: D(8) },
  { id: 'wi-mob-e1-s2', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'story', title: 'Deep-link routing map with fallback screens', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-026', assigneeName: 'Mateo Ruiz', assigneeDept: 'Product', labels: ['routing'], storyPoints: 5, prUrl: 'https://github.com/connorhoehn/orgiq-mobile-app/pull/46', prStatus: 'open', createdAt: D(34), updatedAt: D(1), completedAt: null },
  { id: 'wi-mob-e1-b3', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'bug', title: 'Android back gesture conflicts with drawer swipe', description: null, status: 'open', priority: 'medium', assigneeId: 'p-026', assigneeName: 'Mateo Ruiz', assigneeDept: 'Product', labels: ['android', 'gestures'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(63), updatedAt: D(1), completedAt: null },

  // ── The SME's own board ────────────────────────────────────────────────────
  //
  // Everything above predates the program operating model: it is a fixture
  // about Kubernetes and Istio that was later re-pointed at `p-*` initiative
  // ids, so an initiative's name and its items' subject matter disagree, and
  // the cast is the older one (p-004 reads as "Priya Patel" up there, and as
  // Nora DaSilva everywhere the identity provider is involved).
  //
  // These rows are lifted straight from `schema/seed_program.sql`, ids and
  // all, so mock mode and a seeded Aurora tell the same story about the two
  // initiatives Nora DaSilva (p-004, `u-nora`, role `sme`) is attached to —
  // she owns Observability Platform and is an SME on Auth Migration. Without
  // them the Work page's suggestion strip was empty for her and there was
  // nothing on the page to explain why: the mock board carried no `in_review`
  // work and nothing blocked on either initiative, so the ranker had nothing
  // to rank. They also give the page its narrative — one thing waiting on
  // *her* review, one thing stalled on someone else's decision.
  //
  // `blocked` is a label, not a status: see kindOf in lib/work-suggestions.ts.

  // ── p-observability — the rest of the seed's board ────────────────────────
  //
  // wi-obs-e1-* / wi-obs-e3-* joined wi-obs-e2-* when the fabricated families
  // came out: the fixture carried only the e2 epic, so spr-obs-s1 was a sprint
  // no work item pointed at, and two other fixtures referenced items the board
  // denied existed (the decisions fixture's d-otel-vendor -> wi-obs-e1).
  //
  // The six open / in-review items carry the titles and briefs the Initiatives
  // redesign shows (docs/design/initiative-*-mockup.png), copied from the
  // generator's BRIEFS dict — the seed's UPDATEs, which the parity harness
  // reads, not the other way round.
  { id: 'wi-obs-e1', projectId: 'p-observability', parentId: null, type: 'epic', title: 'OpenTelemetry everywhere', description: 'Every service emits OTLP through the collector fleet; legacy StatsD retired.', status: 'in_progress', priority: 'critical', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['otel'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },
  { id: 'wi-obs-e1-s1', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Roll out collector fleet with gateway + agent topology', description: null, status: 'done', priority: 'critical', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['otel', 'infra'], storyPoints: 8, estimatedCostUsd: 10.47, sprintId: 'spr-obs-s1', prUrl: 'https://github.com/connorhoehn/orgiq-observability/pull/27', prStatus: 'merged', createdAt: D(55), updatedAt: D(5), completedAt: D(12) },
  { id: 'wi-obs-e1-s2', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Tail-sampling policy: errors + p99 latency always kept', description: null, status: 'done', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['otel', 'sampling'], storyPoints: 5, estimatedCostUsd: 6.05, sprintId: 'spr-obs-s1', prUrl: 'https://github.com/connorhoehn/orgiq-observability/pull/29', prStatus: 'merged', createdAt: D(46), updatedAt: D(0), completedAt: D(13) },
  { id: 'wi-obs-e1-s3', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Span-metrics connector feeding RED dashboards', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['otel', 'metrics'], storyPoints: 8, estimatedCostUsd: 10.77, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(47), updatedAt: D(0), completedAt: null },
  { id: 'wi-obs-e1-s4', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Decommission the legacy StatsD bridge', description: null, status: 'open', priority: 'medium', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: 5, estimatedCostUsd: 5.77, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(69), updatedAt: D(2), completedAt: null },
  { id: 'wi-obs-e1-b5', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'bug', title: 'Collector OOMs under burst ingest when queue is unbounded', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['otel', 'stability'], storyPoints: 3, estimatedCostUsd: 3.92, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(49), updatedAt: D(4), completedAt: null },
  { id: 'wi-obs-e3', projectId: 'p-observability', parentId: null, type: 'epic', title: 'Cost-aware telemetry', description: 'Telemetry spend is budgeted like compute: cardinality and retention have owners.', status: 'open', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['finops'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(2), completedAt: null },
  { id: 'wi-obs-e3-s1', projectId: 'p-observability', parentId: 'wi-obs-e3', type: 'story', title: 'Metric cardinality budgets', description: null, status: 'open', priority: 'medium', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['finops', 'metrics'], storyPoints: 5, estimatedCostUsd: 5.28, prUrl: null, prStatus: null, createdAt: D(60), updatedAt: D(0), completedAt: null },
  { id: 'wi-obs-e3-s2', projectId: 'p-observability', parentId: 'wi-obs-e3', type: 'story', title: 'Tiered log sampling', description: null, status: 'open', priority: 'medium', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['finops', 'logs'], storyPoints: 3, estimatedCostUsd: 3.52, prUrl: null, prStatus: null, createdAt: D(51), updatedAt: D(2), completedAt: null },

  // ── p-observability — SLOs and error budgets (Nora owns this initiative) ──
  { id: 'wi-obs-e2', projectId: 'p-observability', parentId: null, type: 'epic', title: 'SLOs and error budgets', description: 'Every tier-1 service has an SLO, a burn-rate alert, and an owner.', status: 'in_progress', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null },
  { id: 'wi-obs-e2-s1', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'SLO definitions in the service catalog with owners', description: null, status: 'done', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo'], storyPoints: 5, estimatedCostUsd: 5.22, sprintId: 'spr-obs-s2', prUrl: 'https://github.com/connorhoehn/orgiq-observability/pull/35', prStatus: 'merged', createdAt: D(65), updatedAt: D(0), completedAt: D(5) },
  { id: 'wi-obs-e2-s2', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'Multi-window burn-rate alerts', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['slo', 'alerting'], storyPoints: 5, prUrl: 'https://github.com/connorhoehn/orgiq-observability/pull/38', prStatus: 'open', createdAt: D(21), updatedAt: D(6), completedAt: null },
  { id: 'wi-obs-e2-s3', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'Error-budget dashboard per team', description: null, status: 'open', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo', 'dashboards'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(33), updatedAt: D(2), completedAt: null },
  { id: 'wi-obs-e2-b4', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'bug', title: 'Stop duplicate alerts during a dependency outage', description: null, status: 'open', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['alerting', 'blocked'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },

  // ── p-auth-migration — Nora is an SME here, not the owner ────────────────
  //
  // wi-auth-e1-s1/s2/b4 and wi-auth-e2-s1 joined the four items already here
  // when the parity check moved to 'complete': the seed gives this initiative
  // nine work items and the fixture carried five, which is the same defect
  // sme.md #14 found on p-design-system-api — an initiative with less work
  // than the seed gives it. (An epic's childCount/childDoneCount are counted
  // from its children when the rows are built — see deriveChildCounts.)
  { id: 'wi-auth-e1', projectId: 'p-auth-migration', parentId: null, type: 'epic', title: 'Cognito consolidation', description: 'One IdP, one session mint path, verified JWKS everywhere.', status: 'in_progress', priority: 'critical', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['oidc'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(3), completedAt: null },
  { id: 'wi-auth-e1-s1', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'BFF authorization-code + PKCE flow behind the middleware', description: null, status: 'done', priority: 'critical', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: ['oidc', 'bff'], storyPoints: 8, estimatedCostUsd: 9.16, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehn/orgiq-auth-service/pull/39', prStatus: 'merged', createdAt: D(64), updatedAt: D(1), completedAt: D(14) },
  { id: 'wi-auth-e1-s2', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'JWKS verification with kid-rotation handling', description: null, status: 'done', priority: 'critical', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['oidc', 'jwt'], storyPoints: 5, estimatedCostUsd: 5.92, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehn/orgiq-auth-service/pull/43', prStatus: 'merged', createdAt: D(59), updatedAt: D(4), completedAt: D(10) },
  { id: 'wi-auth-e1-s3', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'Session cookie hardening: max-age, rotation on switch', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['session'], storyPoints: 5, prUrl: 'https://github.com/connorhoehn/orgiq-auth-service/pull/49', prStatus: 'open', createdAt: D(30), updatedAt: D(5), completedAt: null },
  { id: 'wi-auth-e1-b4', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'bug', title: 'Refresh loop when a grant is revoked mid-session', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['session'], storyPoints: 3, estimatedCostUsd: 2.91, sprintId: 'spr-auth-s2', prUrl: 'https://github.com/connorhoehn/orgiq-auth-service/pull/51', prStatus: 'open', createdAt: D(48), updatedAt: D(1), completedAt: null },
  { id: 'wi-auth-e2', projectId: 'p-auth-migration', parentId: null, type: 'epic', title: 'Legacy SSO decommission', description: 'The SAML shim serves zero tenants and is deleted, not paused.', status: 'open', priority: 'high', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null },
  { id: 'wi-auth-e2-s1', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'story', title: 'Inventory every consumer still on the SAML shim', description: null, status: 'done', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: 3, estimatedCostUsd: 3.42, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehn/orgiq-auth-service/pull/54', prStatus: 'merged', createdAt: D(73), updatedAt: D(4), completedAt: D(12) },
  { id: 'wi-auth-e2-s2', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'story', title: 'Tenant-by-tenant cutover runbook with rollback', description: null, status: 'open', priority: 'high', assigneeId: 'p-051', assigneeName: 'Simone Chang', assigneeDept: 'Security', labels: ['decom', 'runbook', 'blocked'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(44), updatedAt: D(2), completedAt: null },
  { id: 'wi-auth-e2-b3', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'bug', title: 'Logout leaves the legacy shim cookie alive', description: null, status: 'open', priority: 'medium', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['session', 'decom'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(39), updatedAt: D(4), completedAt: null },

  // ── The remaining seven initiatives (member defect #14) ───────────────────
  //
  // MOCK_WORK_ITEM_SEEDS used to mirror only 7 of the 14 seeded initiatives
  // (the ones above). p-cost-opt, p-realtime-analytics, p-data-lake,
  // p-feature-store, p-design-v3, p-soc2 and p-design-system-api had none —
  // so u-theo (member, personId p-001, an SME on p-design-system-api per
  // seed_program.sql:361) opened Ask and "From your work" fell back to
  // generic prompts because his initiative's board was empty offline, even
  // though the seed gives it an open high-priority bug
  // (seed_program.sql:369). All 32 rows below are lifted straight from
  // schema/seed_program.sql, ids and all, the same way the families above
  // are — every seeded work item now has a mock counterpart.

  // ── p-cost-opt — Idle capacity teardown + spend attribution (seed_program.sql:151-157)
  { id: 'wi-cost-e1', projectId: 'p-cost-opt', parentId: null, type: 'epic', title: 'Idle capacity teardown', description: 'Nothing bills while idle without a written justification.', status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null },
  { id: 'wi-cost-e1-s1', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'story', title: 'Aurora ACU right-sizing with scale-to-floor windows', description: null, status: 'done', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['aurora', 'finops'], storyPoints: 5, estimatedCostUsd: 4.96, sprintId: 'spr-cost-s1', prUrl: 'https://github.com/connorhoehn/orgiq-finops/pull/59', prStatus: 'merged', createdAt: D(43), updatedAt: D(3), completedAt: D(7) },
  { id: 'wi-cost-e1-s2', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'story', title: 'OpenSearch OCU floor audit and collection consolidation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['opensearch', 'finops'], storyPoints: 5, estimatedCostUsd: 5.3, sprintId: 'spr-cost-s2', prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(1), completedAt: null },
  { id: 'wi-cost-e1-b3', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'bug', title: 'Orphaned NAT gateways surviving stack teardown', description: null, status: 'done', priority: 'medium', assigneeId: 'p-017', assigneeName: 'Daniel Novak', assigneeDept: 'Data Platform', labels: ['network', 'teardown'], storyPoints: 2, estimatedCostUsd: 2.33, sprintId: 'spr-cost-s1', prUrl: 'https://github.com/connorhoehn/orgiq-finops/pull/62', prStatus: 'merged', createdAt: D(59), updatedAt: D(5), completedAt: D(7) },
  { id: 'wi-cost-e2', projectId: 'p-cost-opt', parentId: null, type: 'epic', title: 'Spend attribution', description: 'Showback per initiative: infra, model tokens, and bot baseline in one view.', status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null },
  { id: 'wi-cost-e2-s1', projectId: 'p-cost-opt', parentId: 'wi-cost-e2', type: 'story', title: 'Tagging policy enforced at deploy time', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['tagging', 'governance'], storyPoints: 5, estimatedCostUsd: 6.2, sprintId: 'spr-cost-s2', prUrl: 'https://github.com/connorhoehn/orgiq-finops/pull/69', prStatus: 'open', createdAt: D(74), updatedAt: D(1), completedAt: null },
  { id: 'wi-cost-e2-s2', projectId: 'p-cost-opt', parentId: 'wi-cost-e2', type: 'story', title: 'Per-initiative showback rollup joining agent spend', description: null, status: 'open', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['showback'], storyPoints: 8, estimatedCostUsd: 10.47, sprintId: 'spr-cost-s2', prUrl: null, prStatus: null, createdAt: D(21), updatedAt: D(5), completedAt: null },

  // ── p-realtime-analytics — Exactly-once pipeline (seed_program.sql:191-195)
  { id: 'wi-rta-e1', projectId: 'p-realtime-analytics', parentId: null, type: 'epic', title: 'Exactly-once pipeline', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Novak', assigneeDept: 'Data Platform', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null },
  { id: 'wi-rta-e1-s1', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Flink checkpoint tuning for sub-minute recovery', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Novak', assigneeDept: 'Data Platform', labels: ['flink'], storyPoints: 8, estimatedCostUsd: 9.72, sprintId: 'spr-rta-s1', prUrl: null, prStatus: null, createdAt: D(66), updatedAt: D(0), completedAt: null },
  { id: 'wi-rta-e1-s2', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Schema registry rollout with compatibility gates', description: null, status: 'done', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Novak', assigneeDept: 'Data Platform', labels: ['schema'], storyPoints: 5, estimatedCostUsd: 6.47, sprintId: 'spr-rta-s1', prUrl: 'https://github.com/connorhoehn/orgiq-stream-analytics/pull/49', prStatus: 'merged', createdAt: D(27), updatedAt: D(0), completedAt: D(15) },
  { id: 'wi-rta-e1-b3', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'bug', title: 'Late events dropped at the watermark boundary', description: null, status: 'open', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Novak', assigneeDept: 'Data Platform', labels: ['flink', 'correctness'], storyPoints: 3, estimatedCostUsd: 2.95, sprintId: 'spr-rta-s1', prUrl: null, prStatus: null, createdAt: D(28), updatedAt: D(5), completedAt: null },
  { id: 'wi-rta-e1-s4', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Self-serve backfill tooling with replay budgets', description: null, status: 'open', priority: 'medium', assigneeId: 'p-024', assigneeName: 'Andre Williams', assigneeDept: 'Data Platform', labels: ['backfill'], storyPoints: 5, estimatedCostUsd: 4.34, prUrl: null, prStatus: null, createdAt: D(59), updatedAt: D(2), completedAt: null },

  // ── p-data-lake — Lakehouse foundation (seed_program.sql:219-222) ─────────
  { id: 'wi-lake-e1', projectId: 'p-data-lake', parentId: null, type: 'epic', title: 'Lakehouse foundation', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Anika Mehta', assigneeDept: 'Data Platform', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null },
  { id: 'wi-lake-e1-s1', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Iceberg table format evaluation against Delta', description: null, status: 'done', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Anika Mehta', assigneeDept: 'Data Platform', labels: ['iceberg', 'eval'], storyPoints: 5, estimatedCostUsd: 5.95, sprintId: 'spr-lake-s1', prUrl: null, prStatus: null, createdAt: D(53), updatedAt: D(1), completedAt: D(4) },
  { id: 'wi-lake-e1-s2', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Ingest contract spec for producer teams', description: null, status: 'open', priority: 'medium', assigneeId: 'p-015', assigneeName: 'Raj Mehta', assigneeDept: 'Data Platform', labels: ['contracts'], storyPoints: 3, estimatedCostUsd: 3.2, sprintId: 'spr-lake-s1', prUrl: null, prStatus: null, createdAt: D(61), updatedAt: D(0), completedAt: null },
  { id: 'wi-lake-e1-s3', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Bronze/silver/gold access zone design', description: null, status: 'open', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Anika Mehta', assigneeDept: 'Data Platform', labels: ['governance'], storyPoints: 5, estimatedCostUsd: 5.26, prUrl: null, prStatus: null, createdAt: D(60), updatedAt: D(1), completedAt: null },

  // ── p-feature-store — Online serving GA (seed_program.sql:234-237) ────────
  { id: 'wi-fs-e1', projectId: 'p-feature-store', parentId: null, type: 'epic', title: 'Online serving GA', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-042', assigneeName: 'Katya Petrov', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null },
  { id: 'wi-fs-e1-s1', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'story', title: 'Freshness SLAs per feature group with alerting', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-044', assigneeName: 'Zoe Thompson', assigneeDept: 'ML / AI', labels: ['sla'], storyPoints: 5, estimatedCostUsd: 4.5, sprintId: 'spr-fs-s1', prUrl: null, prStatus: null, createdAt: D(56), updatedAt: D(5), completedAt: null },
  { id: 'wi-fs-e1-s2', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'story', title: 'Point-in-time join correctness in offline store', description: null, status: 'done', priority: 'critical', assigneeId: 'p-044', assigneeName: 'Zoe Thompson', assigneeDept: 'ML / AI', labels: ['correctness'], storyPoints: 8, estimatedCostUsd: 8.35, sprintId: 'spr-fs-s1', prUrl: 'https://github.com/connorhoehn/orgiq-feature-store/pull/31', prStatus: 'merged', createdAt: D(53), updatedAt: D(0), completedAt: D(18) },
  { id: 'wi-fs-e1-b3', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'bug', title: 'TTL eviction races leave stale features served', description: null, status: 'open', priority: 'high', assigneeId: 'p-042', assigneeName: 'Katya Petrov', assigneeDept: 'ML / AI', labels: ['online-store'], storyPoints: 3, estimatedCostUsd: 3.5, sprintId: 'spr-fs-s1', prUrl: null, prStatus: null, createdAt: D(41), updatedAt: D(4), completedAt: null },

  // ── p-design-v3 — Token pipeline (seed_program.sql:290-293) ───────────────
  { id: 'wi-ds-e1', projectId: 'p-design-v3', parentId: null, type: 'epic', title: 'Token pipeline', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-035', assigneeName: 'Ben Okafor', assigneeDept: 'Design Systems', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },
  { id: 'wi-ds-e1-s1', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'story', title: 'Semantic color tokens with light/dark resolution', description: null, status: 'done', priority: 'high', assigneeId: 'p-035', assigneeName: 'Ben Okafor', assigneeDept: 'Design Systems', labels: ['tokens'], storyPoints: 5, estimatedCostUsd: 4.73, sprintId: 'spr-ds-s1', prUrl: 'https://github.com/connorhoehn/orgiq-design-system/pull/26', prStatus: 'merged', createdAt: D(29), updatedAt: D(5), completedAt: D(13) },
  { id: 'wi-ds-e1-s2', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'story', title: 'Figma-to-repo token sync automation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['automation'], storyPoints: 8, estimatedCostUsd: 10.39, sprintId: 'spr-ds-s1', prUrl: null, prStatus: null, createdAt: D(53), updatedAt: D(3), completedAt: null },
  { id: 'wi-ds-e1-b3', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'bug', title: 'Dark-mode contrast regression on disabled states', description: null, status: 'open', priority: 'medium', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['a11y'], storyPoints: 2, estimatedCostUsd: 2.39, sprintId: 'spr-ds-s1', prUrl: null, prStatus: null, createdAt: D(48), updatedAt: D(1), completedAt: null },

  // ── p-soc2 — Evidence automation (seed_program.sql:335-338) ───────────────
  { id: 'wi-soc2-e1', projectId: 'p-soc2', parentId: null, type: 'epic', title: 'Evidence automation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-052', assigneeName: 'Diego Ortiz', assigneeDept: 'Security', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null },
  { id: 'wi-soc2-e1-s1', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'story', title: 'Control-to-owner mapping in the compliance register', description: null, status: 'done', priority: 'high', assigneeId: 'p-052', assigneeName: 'Diego Ortiz', assigneeDept: 'Security', labels: ['controls'], storyPoints: 5, estimatedCostUsd: 4.48, sprintId: 'spr-soc2-s1', prUrl: 'https://github.com/connorhoehn/orgiq-compliance/pull/33', prStatus: 'merged', createdAt: D(56), updatedAt: D(1), completedAt: D(15) },
  { id: 'wi-soc2-e1-s2', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'story', title: 'Automated evidence collectors for CM and access controls', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-055', assigneeName: 'Joy Chen', assigneeDept: 'Security', labels: ['evidence'], storyPoints: 8, estimatedCostUsd: 7.64, sprintId: 'spr-soc2-s1', prUrl: null, prStatus: null, createdAt: D(46), updatedAt: D(1), completedAt: null },
  { id: 'wi-soc2-e1-b3', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'bug', title: 'Quarterly access reviews stale for two service accounts', description: null, status: 'open', priority: 'high', assigneeId: 'p-052', assigneeName: 'Diego Ortiz', assigneeDept: 'Security', labels: ['access'], storyPoints: 3, estimatedCostUsd: 2.84, sprintId: 'spr-soc2-s1', prUrl: null, prStatus: null, createdAt: D(27), updatedAt: D(2), completedAt: null },

  // ── p-design-system-api — Component API contract (seed_program.sql:366-369)
  //
  // Theo Chang (p-001, u-theo) is an SME here per seed_program.sql:361 and is
  // assigned wi-dsapi-e1-s1 below — the item that puts real work on his Ask
  // page instead of a generic prompt.
  { id: 'wi-dsapi-e1', projectId: 'p-design-system-api', parentId: null, type: 'epic', title: 'Component API contract', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(2), completedAt: null },
  { id: 'wi-dsapi-e1-s1', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'story', title: 'Typed prop contracts with generated codemods', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-001', assigneeName: 'Theo Chang', assigneeDept: 'Platform Engineering', labels: ['api', 'codemods'], storyPoints: 8, estimatedCostUsd: 10.03, sprintId: 'spr-dsapi-s1', prUrl: null, prStatus: null, createdAt: D(24), updatedAt: D(0), completedAt: null },
  { id: 'wi-dsapi-e1-s2', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'story', title: 'Versioned release channels (stable/next)', description: null, status: 'done', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['releases'], storyPoints: 5, estimatedCostUsd: 4.27, sprintId: 'spr-dsapi-s1', prUrl: 'https://github.com/connorhoehn/orgiq-design-system-api/pull/57', prStatus: 'merged', createdAt: D(36), updatedAt: D(4), completedAt: D(9) },
  { id: 'wi-dsapi-e1-b3', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'bug', title: 'Breaking prop rename slipped past the semver gate', description: null, status: 'open', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['semver'], storyPoints: 3, estimatedCostUsd: 3.85, sprintId: 'spr-dsapi-s1', prUrl: null, prStatus: null, createdAt: D(32), updatedAt: D(1), completedAt: null },
];

/**
 * The work-item briefs, mirroring schema/seeds/generate_program_seed.py's
 * BRIEFS row for row (the seed writes them as UPDATEs after the inserts, and
 * the parity harness compares every field). An item listed here takes all five
 * fields from this table, nulls included, exactly as the seed's UPDATE states
 * the whole brief; an item not listed keeps whatever its seed row says, which
 * for every such row is null. The in-flight and blocked items of the five arcs
 * in docs/demo-content-engineering-brief.md carry one.
 */
type SeededBrief = Pick<WorkItem, 'summary' | 'description' | 'blockedReason' | 'nextStep' | 'nextStepDetail'>;
const SEEDED_BRIEFS: Partial<Record<string, SeededBrief>> = {
  'wi-obs-e2-b4': {
    summary: 'One failing dependency can trigger forty pages.',
    description: 'When the shared Postgres connection proxy failed last month, 41 services paged separately within 6 minutes and the on-call engineer spent the first 20 minutes acknowledging duplicates. Alerts should group by the failing dependency, with the affected services listed inside one page.',
    blockedReason: 'Waiting on the dependency map.',
    nextStep: 'Confirm the dependency map with Eli Garcia.',
    nextStepDetail: 'The team needs this before choosing how to group duplicate alerts.',
  },
  'wi-obs-e1-s4': {
    summary: 'Move remaining service metrics to OpenTelemetry.',
    description: 'Nine services still push StatsD through the bridge, which drops packets under load because it is UDP with a 64 KB receive buffer. Each service moves to OTLP through the collector, and every alert that read a StatsD metric reads its OpenTelemetry equivalent before the bridge is switched off.',
    blockedReason: null,
    nextStep: 'Move billing and notifications first.',
    nextStepDetail: 'Neither has a paging alert on a StatsD metric. Keep the bridge running until dashboard parity is verified for both.',
  },
  'wi-obs-e1-s3': {
    summary: 'Derive rate, errors and duration for every service from its spans.',
    description: 'The span-metrics connector turns every server span into a call counter and a duration histogram per service and route, so dashboards cover services that never wrote a metric. Cardinality is the risk: route labels must be templated, never raw paths.',
    blockedReason: null,
    nextStep: 'Enable the connector for checkout and search behind an allow-list.',
    nextStepDetail: 'Compare their RED panels against the StatsD dashboards for a week, then widen the list.',
  },
  'wi-obs-e1-b5': {
    summary: 'A 90-second ingest burst kills the gateway collectors because nothing bounds the export queue.',
    description: 'At 40k spans/s for 90 seconds the gateway pods reach their 2 GiB limit inside 4 minutes and are OOM-killed, dropping every span in flight, errors included. With memory_limiter first in the pipeline and a bounded sending queue the collector refuses data under pressure instead of dying.',
    blockedReason: null,
    nextStep: 'Replay the burst against the fixed config in staging.',
    nextStepDetail: 'Pass means no OOM kill, the exporter queue stays under capacity, and tail sampling still keeps every error span.',
  },
  'wi-obs-e2-s2': {
    summary: 'Alert on how fast the error budget burns, not on raw error counts.',
    description: 'Fast burn pages, slow burn tickets. Page when 2 percent of the 30-day budget burns in 1 hour (14.4x) and ticket at 5 percent in 6 hours (6x), each confirmed by a short window. Thresholds come from the SLO, not from a feel for the error rate.',
    blockedReason: null,
    nextStep: 'Backtest the recording rules over 30 days of checkout traffic.',
    nextStepDetail: 'They must page for the two real incidents in that window and stay quiet otherwise.',
  },
  'wi-obs-e2-s3': {
    summary: 'Make each team\'s remaining error budget visible.',
    description: 'One panel per team: budget remaining, burn over the window, and who owns the service. When a budget is spent, feature work on that service waits for reliability work, and the panel is what makes that conversation short.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-obs-e3-s1': {
    summary: 'Define limits before new metrics increase storage costs.',
    description: 'One team added a user_id label and created 1.2 million active series in a day, doubling the metrics bill for the month. Every service gets a series budget, and CI fails a pull request that adds an unbounded label.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-obs-e3-s2': {
    summary: null,
    description: 'Debug logs are 70 percent of log volume and almost never read. Debug is sampled at 1 in 20, info is kept for 14 days, and audit logs bypass sampling entirely because compliance needs every line.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-auth-e2-s2': {
    summary: 'Sequence the remaining customer tenants off the SAML shim, each with a two-minute way back.',
    description: 'Each tenant already moves with the single-tenant cutover runbook: pre-flight the Cognito app client, flip the IdP route, watch the login error rate for 15 minutes, and roll back by restoring the shim route. This story writes down the order the 12 remaining customer tenants move in, as the decision "Cutover order for legacy SSO tenants" sets it, and the rollback for each.',
    // The waiting state lives in the block (label, reason, blocked_by_decision_id), which deciding settles; the
    // brief derives its "Next step" from it (portal briefModel.ts nextStepCallout), so no seeded line says who decides.
    blockedReason: 'Blocked on "Cutover order for legacy SSO tenants", escalated to Sienna Garcia. She decides once the second internal rehearsal passes.',
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-auth-e1-s1': {
    summary: null,
    description: 'The BFF runs the authorization-code flow with PKCE (S256) against the Cognito hosted UI and keeps the tokens server-side. The browser only holds an HttpOnly, SameSite=Lax session cookie, so a script injected into the page cannot lift a bearer token.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-auth-e1-s2': {
    summary: null,
    description: 'Access tokens are verified against the cached JWKS by key id. An unknown kid triggers one rate-limited refetch, at most once a minute, before the token is rejected, so a signing-key rotation signs nobody out and a forged kid cannot hammer the endpoint.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-auth-e2-s1': {
    summary: null,
    description: 'Every consumer still on the SAML shim, each with an owner: 14 tenants (12 customer, 2 internal), two of them with custom SAML attribute mappings, plus one internal search callback still pointed at the shim. The cutover order needs this list to order.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-auth-e1-s3': {
    summary: 'A switched tenant or role stops honouring the old cookie within the refresh window.',
    description: 'Every tenant or role switch re-mints the cookie and bumps the session epoch. A copy of the pre-switch cookie on another device is refused at its next grants refresh, at most 120 seconds later, without adding a server-side session store.',
    blockedReason: null,
    nextStep: 'Simone Chang reviews the epoch comparison in the session middleware.',
    nextStepDetail: 'The server-side max-age is in the same pull request behind a flag, which flips after the cutover window closes.',
  },
  'wi-auth-e1-b4': {
    summary: 'A revoked grant must sign the session out once, not loop on refresh.',
    description: 'When a grant is revoked mid-session the refresh endpoint answers 403, and the client treats every 403 as retryable, so it refreshes every 2 seconds until the tab closes. One revoked user produced 1,800 refresh calls in an hour. Revocation must answer 401 with a reason the client treats as terminal.',
    blockedReason: null,
    nextStep: 'Return 401 with a session_revoked reason from the refresh endpoint.',
    nextStepDetail: 'Then the client signs out once on that reason. A regression test revokes a grant mid-session and asserts exactly one refresh call.',
  },
  'wi-auth-e2-b3': {
    summary: 'Signing out must also clear the SAML shim cookie.',
    description: 'Signing out clears the BFF session but not the shim session cookie on the legacy domain, so the next visit silently re-authenticates through the shim. Logout has to pass through the shim single-logout endpoint until the shim is deleted.',
    blockedReason: null,
    nextStep: 'Add the shim single-logout redirect to the BFF logout handler.',
    nextStepDetail: 'Verify in a fresh browser profile that the visit after logout lands on the Cognito hosted UI, not straight back in.',
  },
  'wi-llm-e1-s2': {
    summary: 'Score every canary answer on a weighted rubric so a prompt change is judged, not eyeballed.',
    description: 'The judge scores grounding, completeness, tone and latency against the retrieved context. On the 120-question pilot set it agrees with human labels 82 percent of the time. Which model judges is the open decision "Judge model for canary evaluation".',
    blockedReason: null,
    // What follows the open decision: the readers derive "the decision comes first" from it (portal
    // lib/workNextStep.ts), so no stored step says who decides (check-story: pending-decision-step).
    nextStep: 'Wire the chosen judge model into the canary scoring run.',
    nextStepDetail: 'Re-score the 120-question pilot set with the chosen judge and the final weights; agreement with human labels stays at 82 percent or better.',
  },
  'wi-llm-e1-b3': {
    summary: 'Every replica refetches its prompt in the same second when the cache expires.',
    description: 'Replicas cache each prompt for exactly 60 seconds from boot, so after a deploy they expire together and the prompt store throttles at about 40 requests a second. Jittering the TTL and serving the stale prompt while one refresh runs removes the stampede.',
    blockedReason: null,
    nextStep: 'Add TTL jitter and stale-while-revalidate to the prompt cache.',
    nextStepDetail: 'Load test with 50 replicas restarted at once: zero throttled fetches.',
  },
  'wi-llm-e2-s1': {
    summary: 'Gate every prompt and model change on a versioned golden set per agent.',
    description: 'Each agent has 30 to 60 golden questions with expected facts, versioned with the prompt they test. A change merges only when no rubric dimension drops more than 0.03 against the current baseline.',
    blockedReason: null,
    nextStep: 'Katya Petrov records the golden-set version in the baseline file.',
    nextStepDetail: 'Without it, a score cannot be compared with the one before it.',
  },
  'wi-llm-e2-s2': {
    summary: 'Run the guardrail regression set on every pull request that touches a prompt or a guardrail.',
    description: 'The set holds 200 prompts that must be blocked (prompt injection, PII exfiltration, off-topic requests) and 200 that must pass. A regression in either direction fails the build, because a guardrail that blocks good questions is also broken.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-llm-e3-s1': {
    summary: 'Move nightly summarisation and re-embedding off the interactive endpoint.',
    description: 'Non-interactive jobs share the on-demand quota with users and cause throttling every night around 02:00 UTC. A batch queue with its own concurrency limit takes them off the interactive path.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-cost-e1-s2': {
    summary: 'Justify or merge every OpenSearch Serverless collection holding its own capacity floor.',
    description: 'Collections share capacity only when they share an encryption key, so each key group bills its own 2-OCU floor whether or not anyone queries it. Three of five collections served fewer than 100 queries last week. Merging them onto the shared key saves about $350 a month per group.',
    blockedReason: null,
    nextStep: 'Reindex the three quiet collections onto the shared key group.',
    nextStepDetail: 'Switch readers, then delete the old collections after 7 days of zero queries.',
  },
  'wi-cost-e2-s1': {
    summary: 'Refuse a deploy that creates an untagged resource.',
    description: 'Showback is only as good as the tags. A CDK aspect fails synthesis when a taggable resource lacks initiative and owner tags, and the daily sweep lists anything created outside CDK without them.',
    blockedReason: null,
    nextStep: 'Layla Hassan reviews the exemption list.',
    nextStepDetail: 'Only resources that cannot carry tags are exempt, each with a reason.',
  },
  'wi-cost-e2-s2': {
    summary: 'One view per initiative: infrastructure, model tokens and the bot baseline.',
    description: 'Infrastructure cost comes from tags, model spend from invocation logs and bot spend from the run ledger. Joining the three per initiative per day shows what an initiative actually costs, with the maintenance-bot baseline shown as a floor rather than mixed into interactive work.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-inf-e1-s1': {
    summary: 'Scale replicas on in-flight requests per replica instead of CPU.',
    description: 'GPU-bound replicas sit at 30 percent CPU while requests queue for seconds, so CPU-based scaling never fires. Target tracking on queue depth reacts to the load users actually feel: 4 in flight per replica, out after 30 seconds sustained, in after 10 minutes.',
    blockedReason: null,
    nextStep: 'Publish the in-flight metric from the router.',
    nextStepDetail: 'Emit in-flight requests per model every 10 seconds, switch the staging policy over, and replay the last traffic peak.',
  },
  'wi-inf-e1-b3': {
    summary: 'The first request after scale-to-zero waits 40 to 90 seconds for the model to load.',
    description: 'Models idle for 15 minutes scale to zero, and the next request pays the container start plus a 7 GB weight load. p99 on the embedding model reached 74 seconds against a 2.5-second SLO. The fix is a warm floor on tier-1 models or a faster load path.',
    blockedReason: null,
    nextStep: 'Apply the decided warm floor to the tier-1 models.',
    nextStepDetail: 'Replay the cold-start trace afterwards: p99 on the embedding model back under the 2.5-second SLO. A warm replica costs about $380 a month per model on the current instance type.',
  },
  'wi-rta-e1-s1': {
    summary: 'Recover from a task failure in under 60 seconds.',
    description: 'Checkpoints take 3 to 4 minutes because the job snapshots 180 GB of keyed state in full each time. Incremental RocksDB checkpoints, plus unaligned checkpoints under backpressure, bring the interval to 30 seconds and recovery under a minute.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
  'wi-rta-e1-b3': {
    summary: 'Events arriving after the watermark are silently dropped from the hourly aggregates.',
    description: 'Mobile clients batch events and deliver them up to 4 minutes late, but the watermark allows 30 seconds of lateness, so about 0.6 percent of events miss their window. Late events should go to a side output and be merged by a correction job, not vanish.',
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
  },
};

/**
 * The decision a blocked item waits on (`work_items.blocked_by_decision_id`),
 * mirroring schema/seeds/generate_program_seed.py BLOCKED_BY_DECISION row for
 * row. The seed already implied each link: the decision names the item as its
 * `work_item_id`, the item carries the `blocked` label, and its brief's
 * `blockedReason` quotes the decision's topic. Deciding the decision settles
 * the item (providers/work-items.ts `settleWorkBlockedOn`).
 */
const SEEDED_BLOCKED_BY_DECISION: Partial<Record<string, string>> = {
  'wi-auth-e2-s2': 'd-cognito-cutover',
};

/** Sprint membership + dollar estimate for the seeds that carry one. */
const MOCK_PROGRAM_FIELDS: Record<string, { sprintId?: string; estimatedCostUsd?: number }> = {
  // The SME's board, matching schema/seed_program.sql row for row.
  'wi-obs-e2-s2': { sprintId: 'spr-obs-s3', estimatedCostUsd: 6.32 },
  'wi-obs-e2-s3': { sprintId: 'spr-obs-s3', estimatedCostUsd: 2.67 },
  'wi-obs-e2-b4': { sprintId: 'spr-obs-s3', estimatedCostUsd: 1.82 },
  'wi-auth-e1-s3': { sprintId: 'spr-auth-s2', estimatedCostUsd: 5.33 },
  'wi-auth-e2-s2': { sprintId: 'spr-auth-s2', estimatedCostUsd: 4.85 },
  'wi-auth-e2-b3': { sprintId: 'spr-auth-s2', estimatedCostUsd: 1.74 },
  // p-mobile-redesign — program-owner.md defect #1/#3.
  'wi-mob-e1-s1': { sprintId: 'spr-mob-s1', estimatedCostUsd: 6.0 },
  'wi-mob-e1-s2': { sprintId: 'spr-mob-s1', estimatedCostUsd: 5.13 },
  'wi-mob-e1-b3': { sprintId: 'spr-mob-s1', estimatedCostUsd: 1.9 },
};

/**
 * A seed, normalized to a full `WorkItem` — the shared body `default` and
 * `large` both call, so the field list (and the "no seeded item has an
 * authorized estimate" rule) is written once. `idOverride` is how `large`
 * relabels a clone's id/parentId without duplicating everything else.
 */
/**
 * A seed stamp — `D(n)`, n days before MOCK_EPOCH — as the same n days before
 * the mock clock's now. Called inside the fixture factory, so the board moves
 * with the clock (middleware/src/mock/core/contract.ts rule 3) and agrees with Aurora, whose
 * seed writes `NOW() - INTERVAL 'n days'`. Before 2026-10-15 the rows kept
 * their spring dates and only the activity feed reprojected them, so an item
 * read "Created Apr 6" beside a comment from two days ago
 * (docs/demo-content-audit.md, Work story-breaker 5). `mockReprojectedIso`
 * (providers/work-items.ts) passes these through unchanged: they are already
 * later than the epoch.
 */
function onClock(iso: string): string;
function onClock(iso: string | null): string | null;
function onClock(iso: string | null): string | null {
  if (iso === null) return null;
  return new Date(buildNowMs() - (MOCK_EPOCH.getTime() - Date.parse(iso))).toISOString();
}

/**
 * ONE clock read per fixture build. Every stamp of a build is offset from the
 * same instant, so two seeds `D(n)` days old stay exactly equal. Reading the
 * clock per stamp let a millisecond tick land partway through the seed list:
 * the rows after it came out 1 ms newer, ties on `updatedAt` broke on where
 * the tick fell, and the board's first row and its 50-row cut changed from
 * one boot (or reset) to the next — which the wire capture recorded as drift.
 */
let buildClockMs: number | null = null;
function buildNowMs(): number {
  return buildClockMs ?? clock.now().getTime();
}
function onOneClock<T>(build: () => T): () => T {
  return () => {
    const outer = buildClockMs;
    buildClockMs = clock.now().getTime();
    try { return build(); } finally { buildClockMs = outer; }
  };
}

/**
 * A done item finished inside the sprint it belongs to.
 *
 * The seed stamped completions "3 to 18 days ago" without looking at the
 * sprint window, so a story in a sprint that ended five weeks ago read as
 * finished last week, and an item could be updated before it completed. The
 * completion is moved into [sprint start, min(sprint end, now)] at a stable
 * point derived from the id (the same item lands on the same day after every
 * reset); creation is kept three days ahead of it and `updatedAt` never trails
 * it. A completion already inside the window is left exactly as the seed has it.
 */
function completedInSprint(item: { id: string; status: string; sprintId: string | null; createdAt: string; updatedAt: string; completedAt: string | null }): void {
  if (item.status !== 'done' || !item.sprintId || !item.completedAt) return;
  const window = mockSprintDates(item.sprintId);
  if (!window) return;
  const now = buildNowMs();
  const start = Date.parse(`${window.startsOn}T12:00:00.000Z`);
  const end = Math.min(Date.parse(`${window.endsOn}T12:00:00.000Z`), now - 3_600_000);
  let completed = Date.parse(item.completedAt);
  if (!(completed >= start && completed <= end)) {
    const spread = [...item.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 11) / 997;
    completed = Math.round(start + spread * 0.85 * Math.max(0, end - start));
    item.completedAt = new Date(completed).toISOString();
  }
  if (Date.parse(item.createdAt) > completed - 3 * 86_400_000) item.createdAt = new Date(completed - 3 * 86_400_000).toISOString();
  if (Date.parse(item.updatedAt) < completed) item.updatedAt = item.completedAt;
}

function normalizeSeed(seed: MockSeed, idOverride?: { id: string; parentId: string | null }): WorkItem {
  const item = buildSeed(seed, idOverride);
  completedInSprint(item);
  return item;
}

/**
 * An epic's children, counted from the rows. These two numbers were typed on
 * each epic beside the stories they claimed to count (middleware/src/mock/core/contract.ts rule
 * 1), and drifted whenever a story was added; now the list is the authority.
 */
function deriveChildCounts(items: WorkItem[]): WorkItem[] {
  const total = new Map<string, number>();
  const done = new Map<string, number>();
  for (const item of items) {
    if (!item.parentId) continue;
    total.set(item.parentId, (total.get(item.parentId) ?? 0) + 1);
    if (item.status === 'done') done.set(item.parentId, (done.get(item.parentId) ?? 0) + 1);
  }
  for (const item of items) {
    item.childCount = total.get(item.id) ?? 0;
    item.childDoneCount = done.get(item.id) ?? 0;
  }
  return items;
}

function buildSeed(seed: MockSeed, idOverride?: { id: string; parentId: string | null }): WorkItem {
  return {
    childCount: 0,
    childDoneCount: 0,
    key: SEEDED_WORK_KEYS[seed.id] ?? null,
    sprintId: null,
    estimatedCostUsd: null,
    summary: null,
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
    blockedByDecisionId: SEEDED_BLOCKED_BY_DECISION[seed.id] ?? null,
    ...seed,
    ...SEEDED_BRIEFS[seed.id],
    ...MOCK_PROGRAM_FIELDS[seed.id],
    ...(idOverride ?? {}),
    createdAt: onClock(seed.createdAt),
    updatedAt: onClock(seed.updatedAt),
    completedAt: onClock(seed.completedAt ?? null),
    // A missing name falls back to the id rather than to '': an id with no
    // initiative is a bug worth seeing on the page, not a blank label.
    projectName: mockProjectName(seed.projectId) ?? seed.projectId,
    // No seeded item has an authorized estimate — see the MockSeed note.
    estimatedBy: null,
    estimatedByName: null,
    estimatedAt: null,
    estimateModel: null,
    estimateForecast: null,
    estimateReviewedBy: null,
    estimateReviewedByName: null,
    estimateReviewedAt: null,
  };
}

// The busiest seeded initiative (`p-observability`) carries 14 items;
// `LARGE_ROUNDS` clones of the WHOLE seed set (so every initiative grows in
// proportion, not just one) puts it at 14 * 36 = 504 — past
// `PROJECT_WORK_ITEMS_LIMIT` (500, providers/work-items.ts), the circuit
// breaker on a single initiative's Work tab — and the board overall past the
// 200-row cap `searchWorkItems` applies by default. Round 0 keeps the seed's
// own ids; later rounds suffix `-x<round>`, translating `parentId` the same
// way so each round's epic/story/bug tree stays intact.
const LARGE_ROUNDS = 36;

function suffixId(id: string, round: number): string {
  return round === 0 ? id : `${id}-x${round}`;
}

function largeWorkItems(): WorkItem[] {
  const out: WorkItem[] = [];
  const numbers = new Map<string, number>();
  for (let round = 0; round < LARGE_ROUNDS; round += 1) {
    for (const seed of MOCK_WORK_ITEM_SEEDS) {
      const item = normalizeSeed(seed, {
        id: suffixId(seed.id, round),
        parentId: seed.parentId ? suffixId(seed.parentId, round) : null,
      });
      if (round > 0) {
        const prefix = WORK_KEY_PREFIXES[item.projectId]!;
        const high = numbers.get(item.projectId) ?? reservedWorkKeyNumber(prefix);
        item.key = `${prefix}-${high + 1}`;
        numbers.set(item.projectId, high + 1);
      }
      out.push(item);
    }
  }
  return out;
}

/**
 * The Computer Lab demo's board (mock/demo-director.ts): the seed, with Auth
 * Migration's sprint at its first morning — the two items the seed has
 * already started (the refresh-loop bug in progress, cookie hardening in
 * review with PR 49) are still open and unclaimed, so the four agents' worth
 * of work the demo needs is four of the seed's own items rather than four
 * invented ones. Nothing else on the board moves.
 */
const DEMO_UNSTARTED = new Set(['wi-auth-e1-b4', 'wi-auth-e1-s3']);
function demoWorkItems(): WorkItem[] {
  return MOCK_WORK_ITEM_SEEDS.map((seed) => {
    const item = normalizeSeed(seed);
    if (!DEMO_UNSTARTED.has(item.id)) return item;
    return { ...item, status: 'open', prUrl: null, prStatus: null, completedAt: null };
  });
}

/**
 * The board.
 *
 * `default` — every work item schema/seed_program.sql gives the fourteen
 *             initiatives, ids and all.
 * `empty`   — the initiatives exist and nothing has been planned yet.
 *             Declared explicitly: an undeclared scenario falls back to
 *             `default`, so an unwritten `empty` would not be empty — and the
 *             "no work items yet" copy on an initiative's Work tab is the one
 *             state a fully seeded board can never show.
 * `large`   — the seed replayed across `LARGE_ROUNDS` rounds (see above), for
 *             both the board-wide and the per-initiative caps.
 * `demo`    — Auth Migration's sprint before any of it started (demoWorkItems).
 *
 * The rows are built in the factory, not at module scope, so `projectName` is
 * resolved after providers/projects.ts has finished evaluating (see the import
 * note above) and re-resolved on every reset.
 */
export const workItems = defineFixture<WorkItem>({
  key: 'work-items',
  scenarios: {
    default: onOneClock(() => deriveChildCounts(MOCK_WORK_ITEM_SEEDS.map((seed) => normalizeSeed(seed)))),
    empty: () => [],
    large: onOneClock(() => deriveChildCounts(largeWorkItems())),
    demo: onOneClock(() => deriveChildCounts(demoWorkItems())),
    // An initiative with no work and an initiative whose work could not be
    // read look identical without this — and the second is the one where the
    // progress and spend figures above the table are computed from nothing.
    error: () => { throw new Error('work_items unavailable: relation does not exist'); },
  },
});

/**
 * The next `wi-mock-N` id, derived from the rows that are actually there
 * rather than from a module counter.
 *
 * Same reasoning as mock/org-findings.ts's `nextMockFindingId`: a counter
 * survives `POST /api/__mock/reset` while the rows do not, so it keeps
 * climbing past ids nothing holds; a counter reset *with* the fixture re-mints
 * an id the previous world already handed out. The high-water mark reads the
 * live rows and is right in both directions.
 *
 * It is deliberately scoped to the `wi-mock-` family — the seeded `wi-obs-*`
 * ids are the seed's, and nothing minted here may land inside that namespace.
 */
export function nextMockWorkItemId(): string {
  let max = 0;
  for (const item of workItems.rows()) {
    const m = /^wi-mock-(\d+)$/.exec(item.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `wi-mock-${max + 1}`;
}

function reservedWorkKeyNumber(prefix: string): number {
  return Math.max(0, ...Object.values(SEEDED_WORK_KEYS)
    .filter(key => key.startsWith(`${prefix}-`)).map(key => Number(key.slice(prefix.length + 1))));
}

/** Mirrors the database namespace rule; resets restore the same seeded keys. */
export function nextMockWorkItemKey(projectId: string): string {
  const name = projectId.replace(/^p-/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase() || 'WORK';
  const prefix = WORK_KEY_PREFIXES[projectId] ?? `ORG-${name}-${createHash('md5').update(projectId).digest('hex').slice(0, 6).toUpperCase()}`;
  const live = workItems.rows().filter(item => item.projectId === projectId && item.key?.startsWith(`${prefix}-`));
  const high = Math.max(reservedWorkKeyNumber(prefix), ...live.map(item => Number(item.key!.slice(prefix.length + 1))));
  return `${prefix}-${high + 1}`;
}
