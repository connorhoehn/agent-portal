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

import { defineFixture } from './core/index.js';
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
// for six p-observability items only, and every other row is null in the seed
// too — restating four nulls on ~100 rows would be noise, not parity.
type BriefFields = 'summary' | 'blockedReason' | 'nextStep' | 'nextStepDetail';

type MockSeed = Omit<WorkItem, 'projectName' | 'sprintId' | 'estimatedCostUsd' | EstimateFields | BriefFields>
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
  { id: 'wi-zt-e1', projectId: 'p-zero-trust', parentId: null, type: 'epic', title: 'Segmentation blueprint', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 0 },
  { id: 'wi-zt-e1-s1', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'Service identity inventory across environments', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: ['identity'], storyPoints: 5, estimatedCostUsd: 5.35, sprintId: 'spr-zt-s1', prUrl: null, prStatus: null, createdAt: D(46), updatedAt: D(3), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-zt-e1-s2', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'mTLS rollout plan with break-glass procedure', description: null, status: 'open', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: ['mtls'], storyPoints: 5, estimatedCostUsd: 4.39, sprintId: 'spr-zt-s1', prUrl: null, prStatus: null, createdAt: D(65), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-zt-e1-s3', projectId: 'p-zero-trust', parentId: 'wi-zt-e1', type: 'story', title: 'Policy engine selection ADR', description: null, status: 'open', priority: 'medium', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: ['adr'], storyPoints: 3, estimatedCostUsd: 3.58, prUrl: null, prStatus: null, createdAt: D(67), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-llm-platform — prompts, evals, serving (seed_program.sql:109-118) ───
  { id: 'wi-llm-e1', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Prompt management and canary', description: 'Prompts ship like code: drafted, canaried, judged, promoted.', status: 'in_progress', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-llm-e1-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'story', title: 'Prompt registry with DRAFT/live resolution at runtime', description: null, status: 'done', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['prompts'], storyPoints: 5, estimatedCostUsd: 4.6, sprintId: 'spr-llm-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-llm-platform/pull/25', prStatus: 'merged', createdAt: D(31), updatedAt: D(4), completedAt: D(3), childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e1-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'story', title: 'LLM-as-judge canary rubric with weighted dimensions', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['canary', 'evals'], storyPoints: 8, estimatedCostUsd: 10.06, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(27), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e1-b3', projectId: 'p-llm-platform', parentId: 'wi-llm-e1', type: 'bug', title: 'Prompt cache stampede on TTL expiry under load', description: null, status: 'open', priority: 'medium', assigneeId: 'p-042', assigneeName: 'Vera Petrov', assigneeDept: 'ML / AI', labels: ['prompts', 'perf'], storyPoints: 3, estimatedCostUsd: 2.64, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(55), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e2', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Evals and guardrails', description: 'No model or guardrail change lands without a regression verdict.', status: 'in_progress', priority: 'critical', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-llm-e2-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e2', type: 'story', title: 'Eval harness with golden sets per agent', description: null, status: 'in_review', priority: 'critical', assigneeId: 'p-042', assigneeName: 'Vera Petrov', assigneeDept: 'ML / AI', labels: ['evals'], storyPoints: 8, estimatedCostUsd: 6.9, sprintId: 'spr-llm-s2', prUrl: 'https://github.com/connorhoehnslalom/orgiq-llm-platform/pull/29', prStatus: 'open', createdAt: D(53), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e2-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e2', type: 'story', title: 'Guardrail regression suite wired into CI', description: null, status: 'open', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['guardrails', 'ci'], storyPoints: 5, estimatedCostUsd: 6.29, sprintId: 'spr-llm-s2', prUrl: null, prStatus: null, createdAt: D(51), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e3', projectId: 'p-llm-platform', parentId: null, type: 'epic', title: 'Serving efficiency', description: 'Token spend per request trends down while quality holds.', status: 'open', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-llm-e3-s1', projectId: 'p-llm-platform', parentId: 'wi-llm-e3', type: 'story', title: 'Batch inference queue for non-interactive workloads', description: null, status: 'open', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['serving'], storyPoints: 8, estimatedCostUsd: 6.88, prUrl: null, prStatus: null, createdAt: D(69), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-llm-e3-s2', projectId: 'p-llm-platform', parentId: 'wi-llm-e3', type: 'story', title: 'Token budget middleware with per-tenant ceilings', description: null, status: 'done', priority: 'medium', assigneeId: 'p-042', assigneeName: 'Vera Petrov', assigneeDept: 'ML / AI', labels: ['serving', 'budgets'], storyPoints: 3, estimatedCostUsd: 3.15, sprintId: 'spr-llm-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-llm-platform/pull/33', prStatus: 'merged', createdAt: D(64), updatedAt: D(0), completedAt: D(8), childCount: 0, childDoneCount: 0 },

  // ── p-inference-platform — Serving reliability (seed_program.sql:393-396) ─
  { id: 'wi-inf-e1', projectId: 'p-inference-platform', parentId: null, type: 'epic', title: 'Serving reliability', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-049', assigneeName: 'Hiro Mancini', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-inf-e1-s1', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'story', title: 'Autoscaling on queue depth instead of CPU', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-049', assigneeName: 'Hiro Mancini', assigneeDept: 'ML / AI', labels: ['autoscaling'], storyPoints: 8, estimatedCostUsd: 7.25, sprintId: 'spr-inf-s1', prUrl: null, prStatus: null, createdAt: D(52), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-inf-e1-s2', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'story', title: 'Warm-pool management for large model loads', description: null, status: 'done', priority: 'high', assigneeId: 'p-013', assigneeName: 'Caleb Turner', assigneeDept: 'Platform Engineering', labels: ['warm-pool'], storyPoints: 5, estimatedCostUsd: 5.65, sprintId: 'spr-inf-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-inference-platform/pull/29', prStatus: 'merged', createdAt: D(51), updatedAt: D(4), completedAt: D(9), childCount: 0, childDoneCount: 0 },
  { id: 'wi-inf-e1-b3', projectId: 'p-inference-platform', parentId: 'wi-inf-e1', type: 'bug', title: 'Cold-start p99 breaches SLA after scale-to-zero', description: null, status: 'open', priority: 'critical', assigneeId: 'p-049', assigneeName: 'Hiro Mancini', assigneeDept: 'ML / AI', labels: ['latency'], storyPoints: 3, estimatedCostUsd: 3.44, sprintId: 'spr-inf-s1', prUrl: null, prStatus: null, createdAt: D(65), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-rag-search — GA hardening, shipped (seed_program.sql:310-313) ───────
  { id: 'wi-rag-e1', projectId: 'p-rag-search', parentId: null, type: 'epic', title: 'GA hardening', description: null, status: 'done', priority: 'high', assigneeId: 'p-048', assigneeName: 'Lucas Kim', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: D(8), childCount: 3, childDoneCount: 3 },
  { id: 'wi-rag-e1-s1', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Hybrid dense + keyword retrieval with fusion ranking', description: null, status: 'done', priority: 'high', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['retrieval'], storyPoints: 8, estimatedCostUsd: 9.53, prUrl: 'https://github.com/connorhoehnslalom/orgiq-rag-search/pull/51', prStatus: 'merged', createdAt: D(49), updatedAt: D(4), completedAt: D(8), childCount: 0, childDoneCount: 0 },
  { id: 'wi-rag-e1-s2', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Citation grounding with source-span attribution', description: null, status: 'done', priority: 'high', assigneeId: 'p-048', assigneeName: 'Lucas Kim', assigneeDept: 'ML / AI', labels: ['grounding'], storyPoints: 5, estimatedCostUsd: 6.38, prUrl: 'https://github.com/connorhoehnslalom/orgiq-rag-search/pull/56', prStatus: 'merged', createdAt: D(74), updatedAt: D(0), completedAt: D(6), childCount: 0, childDoneCount: 0 },
  { id: 'wi-rag-e1-s3', projectId: 'p-rag-search', parentId: 'wi-rag-e1', type: 'story', title: 'Retrieval eval harness with labeled query set', description: null, status: 'done', priority: 'medium', assigneeId: 'p-047', assigneeName: 'Nina Rivera', assigneeDept: 'ML / AI', labels: ['evals'], storyPoints: 5, estimatedCostUsd: 6.39, prUrl: 'https://github.com/connorhoehnslalom/orgiq-rag-search/pull/60', prStatus: 'merged', createdAt: D(24), updatedAt: D(3), completedAt: D(7), childCount: 0, childDoneCount: 0 },

  // ── Project: Mobile App Redesign ──────────────────────────────────────────
  //
  // The "Developer Onboarding Improvements" family that used to sit here
  // (wi-onboard-*, 4 items) was fabricated with no basis in
  // schema/seed_program.sql: it was pointed at p-mobile-redesign's id while
  // its own projectName said something else entirely, and its assignees
  // (Sienna Garcia, Marcus O'Brien, Marcus Shah) are not that initiative's
  // real owner (p-030) or SMEs (p-035, p-026). The Initiatives page's
  // hand-typed rollup (MOCK_INITIATIVES in providers/projects.ts) separately
  // claimed "23/51 pts" for the row while this fixture's real items summed to
  // 0/8 — list and detail disagreeing about the same initiative.
  // program-owner.md defect #3. Replaced with the real wi-mob-* family,
  // lifted straight from the seed (ids, assignees, points, sprint and PRs all
  // included) the same way wi-obs-*/wi-auth-* already are below, and the
  // rollup numbers in providers/projects.ts now derive from these same four
  // items instead of being restated by hand.
  { id: 'wi-mob-e1', projectId: 'p-mobile-redesign', parentId: null, type: 'epic', title: 'Navigation overhaul', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-030', assigneeName: 'Mia Singh', assigneeDept: 'Product', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-mob-e1-s1', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'story', title: 'Bottom-tab information architecture', description: null, status: 'done', priority: 'high', assigneeId: 'p-030', assigneeName: 'Mia Singh', assigneeDept: 'Product', labels: ['ia', 'ux'], storyPoints: 5, prUrl: 'https://github.com/connorhoehnslalom/orgiq-mobile-app/pull/45', prStatus: 'merged', createdAt: D(44), updatedAt: D(1), completedAt: D(8), childCount: 0, childDoneCount: 0 },
  { id: 'wi-mob-e1-s2', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'story', title: 'Deep-link routing map with fallback screens', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-026', assigneeName: 'Mateo Green', assigneeDept: 'Product', labels: ['routing'], storyPoints: 5, prUrl: 'https://github.com/connorhoehnslalom/orgiq-mobile-app/pull/46', prStatus: 'open', createdAt: D(34), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-mob-e1-b3', projectId: 'p-mobile-redesign', parentId: 'wi-mob-e1', type: 'bug', title: 'Android back gesture conflicts with drawer swipe', description: null, status: 'open', priority: 'medium', assigneeId: 'p-026', assigneeName: 'Mateo Green', assigneeDept: 'Product', labels: ['android', 'gestures'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(63), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },

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
  // denied existed (the decisions fixture's d-otel-vendor -> wi-obs-e1, and
  // providers/rediscovery.ts -> wi-obs-e1-s3).
  //
  // The six open / in-review items carry the titles and briefs the Initiatives
  // redesign shows (docs/design/initiative-*-mockup.png), copied from the
  // generator's BRIEFS dict — the seed's UPDATEs, which the parity harness
  // reads, not the other way round.
  { id: 'wi-obs-e1', projectId: 'p-observability', parentId: null, type: 'epic', title: 'OpenTelemetry everywhere', description: 'Every service emits OTLP through the collector fleet; legacy StatsD retired.', status: 'in_progress', priority: 'critical', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['otel'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 5, childDoneCount: 2 },
  { id: 'wi-obs-e1-s1', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Roll out collector fleet with gateway + agent topology', description: null, status: 'done', priority: 'critical', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['otel', 'infra'], storyPoints: 8, estimatedCostUsd: 10.47, sprintId: 'spr-obs-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-observability/pull/27', prStatus: 'merged', createdAt: D(55), updatedAt: D(5), completedAt: D(12), childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e1-s2', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Tail-sampling policy: errors + p99 latency always kept', description: null, status: 'done', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['otel', 'sampling'], storyPoints: 5, estimatedCostUsd: 6.05, sprintId: 'spr-obs-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-observability/pull/29', prStatus: 'merged', createdAt: D(46), updatedAt: D(0), completedAt: D(13), childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e1-s3', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Span-metrics connector feeding RED dashboards', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['otel', 'metrics'], storyPoints: 8, estimatedCostUsd: 10.77, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(47), updatedAt: D(0), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e1-s4', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'story', title: 'Decommission the legacy StatsD bridge', summary: 'Move remaining service metrics to OpenTelemetry.', description: null, status: 'open', priority: 'medium', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: 5, estimatedCostUsd: 5.77, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(69), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e1-b5', projectId: 'p-observability', parentId: 'wi-obs-e1', type: 'bug', title: 'Collector OOMs under burst ingest when queue is unbounded', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['otel', 'stability'], storyPoints: 3, estimatedCostUsd: 3.92, sprintId: 'spr-obs-s3', prUrl: null, prStatus: null, createdAt: D(49), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e3', projectId: 'p-observability', parentId: null, type: 'epic', title: 'Cost-aware telemetry', description: 'Telemetry spend is budgeted like compute: cardinality and retention have owners.', status: 'open', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['finops'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(2), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-obs-e3-s1', projectId: 'p-observability', parentId: 'wi-obs-e3', type: 'story', title: 'Metric cardinality budgets', summary: 'Define limits before new metrics increase storage costs.', description: null, status: 'open', priority: 'medium', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['finops', 'metrics'], storyPoints: 5, estimatedCostUsd: 5.28, prUrl: null, prStatus: null, createdAt: D(60), updatedAt: D(0), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e3-s2', projectId: 'p-observability', parentId: 'wi-obs-e3', type: 'story', title: 'Tiered log sampling', description: null, status: 'open', priority: 'medium', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['finops', 'logs'], storyPoints: 3, estimatedCostUsd: 3.52, prUrl: null, prStatus: null, createdAt: D(51), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-observability — SLOs and error budgets (Nora owns this initiative) ──
  { id: 'wi-obs-e2', projectId: 'p-observability', parentId: null, type: 'epic', title: 'SLOs and error budgets', description: 'Every tier-1 service has an SLO, a burn-rate alert, and an owner.', status: 'in_progress', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null, childCount: 4, childDoneCount: 1 },
  { id: 'wi-obs-e2-s1', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'SLO definitions in the service catalog with owners', description: null, status: 'done', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo'], storyPoints: 5, estimatedCostUsd: 5.22, sprintId: 'spr-obs-s2', prUrl: 'https://github.com/connorhoehnslalom/orgiq-observability/pull/35', prStatus: 'merged', createdAt: D(65), updatedAt: D(0), completedAt: D(5), childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e2-s2', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'Multi-window burn-rate alerts', description: 'Fast burn pages, slow burn tickets. Thresholds derived from the SLO, not hand-picked.', status: 'in_review', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['slo', 'alerting'], storyPoints: 5, prUrl: 'https://github.com/connorhoehnslalom/orgiq-observability/pull/38', prStatus: 'open', createdAt: D(21), updatedAt: D(6), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e2-s3', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'story', title: 'Error-budget dashboard per team', summary: 'Make each team\'s remaining error budget visible.', description: 'One panel per team: budget remaining, burn over the window, and who owns the service.', status: 'open', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['slo', 'dashboards'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(33), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-obs-e2-b4', projectId: 'p-observability', parentId: 'wi-obs-e2', type: 'bug', title: 'Stop duplicate alerts during a dependency outage', summary: 'One failing dependency can trigger forty pages.', description: 'When one shared dependency fails, it can trigger forty separate pages. Fixing this should help the on-call engineer identify the root problem without sorting through duplicate alerts.', blockedReason: 'Waiting on the dependency map.', nextStep: 'Confirm the dependency map with Eli Garcia.', nextStepDetail: 'The team needs this before choosing how to group duplicate alerts.', status: 'open', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['alerting', 'blocked'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-auth-migration — Nora is an SME here, not the owner ────────────────
  //
  // wi-auth-e1-s1/s2/b4 and wi-auth-e2-s1 joined the four items already here
  // when the parity check moved to 'complete': the seed gives this initiative
  // nine work items and the fixture carried five, which is the same defect
  // sme.md #14 found on p-design-system-api — an initiative with less work
  // than the seed gives it. childCount/childDoneCount on both epics below
  // now count all of their real children, not just the ones that used to be
  // mirrored.
  { id: 'wi-auth-e1', projectId: 'p-auth-migration', parentId: null, type: 'epic', title: 'Cognito consolidation', description: 'One IdP, one session mint path, verified JWKS everywhere.', status: 'in_progress', priority: 'critical', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['oidc'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(3), completedAt: null, childCount: 4, childDoneCount: 2 },
  { id: 'wi-auth-e1-s1', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'BFF authorization-code + PKCE flow behind the middleware', description: null, status: 'done', priority: 'critical', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: ['oidc', 'bff'], storyPoints: 8, estimatedCostUsd: 9.16, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-auth-service/pull/39', prStatus: 'merged', createdAt: D(64), updatedAt: D(1), completedAt: D(14), childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e1-s2', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'JWKS verification with kid-rotation handling', description: null, status: 'done', priority: 'critical', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['oidc', 'jwt'], storyPoints: 5, estimatedCostUsd: 5.92, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-auth-service/pull/43', prStatus: 'merged', createdAt: D(59), updatedAt: D(4), completedAt: D(10), childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e1-s3', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'story', title: 'Session cookie hardening: max-age, rotation on switch', description: 'Re-mint on every tenant and role switch; the pre-switch cookie stops working within the refresh window.', status: 'in_review', priority: 'high', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['session'], storyPoints: 5, prUrl: 'https://github.com/connorhoehnslalom/orgiq-auth-service/pull/49', prStatus: 'open', createdAt: D(30), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e1-b4', projectId: 'p-auth-migration', parentId: 'wi-auth-e1', type: 'bug', title: 'Refresh loop when a grant is revoked mid-session', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['session'], storyPoints: 3, estimatedCostUsd: 2.91, sprintId: 'spr-auth-s2', prUrl: null, prStatus: null, createdAt: D(48), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e2', projectId: 'p-auth-migration', parentId: null, type: 'epic', title: 'Legacy SSO decommission', description: 'The SAML shim serves zero tenants and is deleted, not paused.', status: 'open', priority: 'high', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-auth-e2-s1', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'story', title: 'Inventory every consumer still on the SAML shim', description: null, status: 'done', priority: 'medium', assigneeId: 'p-004', assigneeName: 'Nora DaSilva', assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: 3, estimatedCostUsd: 3.42, sprintId: 'spr-auth-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-auth-service/pull/54', prStatus: 'merged', createdAt: D(73), updatedAt: D(4), completedAt: D(12), childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e2-s2', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'story', title: 'Tenant-by-tenant cutover runbook with rollback', description: 'Cannot be written until the cutover order is settled — smallest tenant first or riskiest first is still escalated.', status: 'open', priority: 'high', assigneeId: 'p-051', assigneeName: 'Nora Chang', assigneeDept: 'Security', labels: ['decom', 'runbook', 'blocked'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(44), updatedAt: D(9), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-auth-e2-b3', projectId: 'p-auth-migration', parentId: 'wi-auth-e2', type: 'bug', title: 'Logout leaves the legacy shim cookie alive', description: 'Signing out clears the OrgIQ session and not the SAML shim cookie, so the next visit silently re-authenticates.', status: 'open', priority: 'medium', assigneeId: 'p-002', assigneeName: 'Vera Green', assigneeDept: 'Platform Engineering', labels: ['session', 'decom'], storyPoints: 2, prUrl: null, prStatus: null, createdAt: D(39), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },

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
  { id: 'wi-cost-e1', projectId: 'p-cost-opt', parentId: null, type: 'epic', title: 'Idle capacity teardown', description: 'Nothing bills while idle without a written justification.', status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null, childCount: 3, childDoneCount: 2 },
  { id: 'wi-cost-e1-s1', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'story', title: 'Aurora ACU right-sizing with scale-to-floor windows', description: null, status: 'done', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['aurora', 'finops'], storyPoints: 5, estimatedCostUsd: 4.96, sprintId: 'spr-cost-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-finops/pull/59', prStatus: 'merged', createdAt: D(43), updatedAt: D(3), completedAt: D(7), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cost-e1-s2', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'story', title: 'OpenSearch OCU floor audit and collection consolidation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: ['opensearch', 'finops'], storyPoints: 5, estimatedCostUsd: 5.3, sprintId: 'spr-cost-s2', prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-cost-e1-b3', projectId: 'p-cost-opt', parentId: 'wi-cost-e1', type: 'bug', title: 'Orphaned NAT gateways surviving stack teardown', description: null, status: 'done', priority: 'medium', assigneeId: 'p-017', assigneeName: 'Daniel Chang', assigneeDept: 'Data Platform', labels: ['network', 'teardown'], storyPoints: 2, estimatedCostUsd: 2.33, sprintId: 'spr-cost-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-finops/pull/62', prStatus: 'merged', createdAt: D(59), updatedAt: D(5), completedAt: D(7), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cost-e2', projectId: 'p-cost-opt', parentId: null, type: 'epic', title: 'Spend attribution', description: 'Showback per initiative: infra, model tokens, and bot baseline in one view.', status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Layla Hassan', assigneeDept: 'Platform Engineering', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-cost-e2-s1', projectId: 'p-cost-opt', parentId: 'wi-cost-e2', type: 'story', title: 'Tagging policy enforced at deploy time', description: null, status: 'in_review', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['tagging', 'governance'], storyPoints: 5, estimatedCostUsd: 6.2, sprintId: 'spr-cost-s2', prUrl: 'https://github.com/connorhoehnslalom/orgiq-finops/pull/69', prStatus: 'open', createdAt: D(74), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-cost-e2-s2', projectId: 'p-cost-opt', parentId: 'wi-cost-e2', type: 'story', title: 'Per-initiative showback rollup joining agent spend', description: null, status: 'open', priority: 'high', assigneeId: 'p-011', assigneeName: 'Eli Garcia', assigneeDept: 'Platform Engineering', labels: ['showback'], storyPoints: 8, estimatedCostUsd: 10.47, sprintId: 'spr-cost-s2', prUrl: null, prStatus: null, createdAt: D(21), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-realtime-analytics — Exactly-once pipeline (seed_program.sql:191-195)
  { id: 'wi-rta-e1', projectId: 'p-realtime-analytics', parentId: null, type: 'epic', title: 'Exactly-once pipeline', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Chang', assigneeDept: 'Data Platform', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(5), completedAt: null, childCount: 4, childDoneCount: 1 },
  { id: 'wi-rta-e1-s1', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Flink checkpoint tuning for sub-minute recovery', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Chang', assigneeDept: 'Data Platform', labels: ['flink'], storyPoints: 8, estimatedCostUsd: 9.72, sprintId: 'spr-rta-s1', prUrl: null, prStatus: null, createdAt: D(66), updatedAt: D(0), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-rta-e1-s2', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Schema registry rollout with compatibility gates', description: null, status: 'done', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Chang', assigneeDept: 'Data Platform', labels: ['schema'], storyPoints: 5, estimatedCostUsd: 6.47, sprintId: 'spr-rta-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-stream-analytics/pull/49', prStatus: 'merged', createdAt: D(27), updatedAt: D(0), completedAt: D(15), childCount: 0, childDoneCount: 0 },
  { id: 'wi-rta-e1-b3', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'bug', title: 'Late events dropped at the watermark boundary', description: null, status: 'open', priority: 'high', assigneeId: 'p-017', assigneeName: 'Daniel Chang', assigneeDept: 'Data Platform', labels: ['flink', 'correctness'], storyPoints: 3, estimatedCostUsd: 2.95, sprintId: 'spr-rta-s1', prUrl: null, prStatus: null, createdAt: D(28), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-rta-e1-s4', projectId: 'p-realtime-analytics', parentId: 'wi-rta-e1', type: 'story', title: 'Self-serve backfill tooling with replay budgets', description: null, status: 'open', priority: 'medium', assigneeId: 'p-024', assigneeName: 'Theo Williams', assigneeDept: 'Data Platform', labels: ['backfill'], storyPoints: 5, estimatedCostUsd: 4.34, prUrl: null, prStatus: null, createdAt: D(59), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-data-lake — Lakehouse foundation (seed_program.sql:219-222) ─────────
  { id: 'wi-lake-e1', projectId: 'p-data-lake', parentId: null, type: 'epic', title: 'Lakehouse foundation', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Aisha Mehta', assigneeDept: 'Data Platform', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(6), completedAt: null, childCount: 3, childDoneCount: 0 },
  { id: 'wi-lake-e1-s1', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Iceberg table format evaluation against Delta', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Aisha Mehta', assigneeDept: 'Data Platform', labels: ['iceberg', 'eval'], storyPoints: 5, estimatedCostUsd: 5.95, sprintId: 'spr-lake-s1', prUrl: null, prStatus: null, createdAt: D(53), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-lake-e1-s2', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Ingest contract spec for producer teams', description: null, status: 'open', priority: 'medium', assigneeId: 'p-015', assigneeName: 'Raj Mehta', assigneeDept: 'Data Platform', labels: ['contracts'], storyPoints: 3, estimatedCostUsd: 3.2, sprintId: 'spr-lake-s1', prUrl: null, prStatus: null, createdAt: D(61), updatedAt: D(0), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-lake-e1-s3', projectId: 'p-data-lake', parentId: 'wi-lake-e1', type: 'story', title: 'Bronze/silver/gold access zone design', description: null, status: 'open', priority: 'medium', assigneeId: 'p-025', assigneeName: 'Aisha Mehta', assigneeDept: 'Data Platform', labels: ['governance'], storyPoints: 5, estimatedCostUsd: 5.26, prUrl: null, prStatus: null, createdAt: D(60), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-feature-store — Online serving GA (seed_program.sql:234-237) ────────
  { id: 'wi-fs-e1', projectId: 'p-feature-store', parentId: null, type: 'epic', title: 'Online serving GA', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-042', assigneeName: 'Vera Petrov', assigneeDept: 'ML / AI', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-fs-e1-s1', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'story', title: 'Freshness SLAs per feature group with alerting', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-044', assigneeName: 'Aisha Thompson', assigneeDept: 'ML / AI', labels: ['sla'], storyPoints: 5, estimatedCostUsd: 4.5, sprintId: 'spr-fs-s1', prUrl: null, prStatus: null, createdAt: D(56), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-fs-e1-s2', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'story', title: 'Point-in-time join correctness in offline store', description: null, status: 'done', priority: 'critical', assigneeId: 'p-044', assigneeName: 'Aisha Thompson', assigneeDept: 'ML / AI', labels: ['correctness'], storyPoints: 8, estimatedCostUsd: 8.35, sprintId: 'spr-fs-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-feature-store/pull/31', prStatus: 'merged', createdAt: D(53), updatedAt: D(0), completedAt: D(18), childCount: 0, childDoneCount: 0 },
  { id: 'wi-fs-e1-b3', projectId: 'p-feature-store', parentId: 'wi-fs-e1', type: 'bug', title: 'TTL eviction races leave stale features served', description: null, status: 'open', priority: 'high', assigneeId: 'p-042', assigneeName: 'Vera Petrov', assigneeDept: 'ML / AI', labels: ['online-store'], storyPoints: 3, estimatedCostUsd: 3.5, sprintId: 'spr-fs-s1', prUrl: null, prStatus: null, createdAt: D(41), updatedAt: D(4), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-design-v3 — Token pipeline (seed_program.sql:290-293) ───────────────
  { id: 'wi-ds-e1', projectId: 'p-design-v3', parentId: null, type: 'epic', title: 'Token pipeline', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-035', assigneeName: 'Ben Okafor', assigneeDept: 'Design Systems', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-ds-e1-s1', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'story', title: 'Semantic color tokens with light/dark resolution', description: null, status: 'done', priority: 'high', assigneeId: 'p-035', assigneeName: 'Ben Okafor', assigneeDept: 'Design Systems', labels: ['tokens'], storyPoints: 5, estimatedCostUsd: 4.73, sprintId: 'spr-ds-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-design-system/pull/26', prStatus: 'merged', createdAt: D(29), updatedAt: D(5), completedAt: D(13), childCount: 0, childDoneCount: 0 },
  { id: 'wi-ds-e1-s2', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'story', title: 'Figma-to-repo token sync automation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['automation'], storyPoints: 8, estimatedCostUsd: 10.39, sprintId: 'spr-ds-s1', prUrl: null, prStatus: null, createdAt: D(53), updatedAt: D(3), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-ds-e1-b3', projectId: 'p-design-v3', parentId: 'wi-ds-e1', type: 'bug', title: 'Dark-mode contrast regression on disabled states', description: null, status: 'open', priority: 'medium', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['a11y'], storyPoints: 2, estimatedCostUsd: 2.39, sprintId: 'spr-ds-s1', prUrl: null, prStatus: null, createdAt: D(48), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-soc2 — Evidence automation (seed_program.sql:335-338) ───────────────
  { id: 'wi-soc2-e1', projectId: 'p-soc2', parentId: null, type: 'epic', title: 'Evidence automation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-052', assigneeName: 'Hugo DaSilva', assigneeDept: 'Security', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(4), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-soc2-e1-s1', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'story', title: 'Control-to-owner mapping in the compliance register', description: null, status: 'done', priority: 'high', assigneeId: 'p-052', assigneeName: 'Hugo DaSilva', assigneeDept: 'Security', labels: ['controls'], storyPoints: 5, estimatedCostUsd: 4.48, sprintId: 'spr-soc2-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-compliance/pull/33', prStatus: 'merged', createdAt: D(56), updatedAt: D(1), completedAt: D(15), childCount: 0, childDoneCount: 0 },
  { id: 'wi-soc2-e1-s2', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'story', title: 'Automated evidence collectors for CM and access controls', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-055', assigneeName: 'Mia Chen', assigneeDept: 'Security', labels: ['evidence'], storyPoints: 8, estimatedCostUsd: 7.64, sprintId: 'spr-soc2-s1', prUrl: null, prStatus: null, createdAt: D(46), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-soc2-e1-b3', projectId: 'p-soc2', parentId: 'wi-soc2-e1', type: 'bug', title: 'Quarterly access reviews stale for two service accounts', description: null, status: 'open', priority: 'high', assigneeId: 'p-052', assigneeName: 'Hugo DaSilva', assigneeDept: 'Security', labels: ['access'], storyPoints: 3, estimatedCostUsd: 2.84, sprintId: 'spr-soc2-s1', prUrl: null, prStatus: null, createdAt: D(27), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── p-design-system-api — Component API contract (seed_program.sql:366-369)
  //
  // Theo Chang (p-001, u-theo) is an SME here per seed_program.sql:361 and is
  // assigned wi-dsapi-e1-s1 below — the item that puts real work on his Ask
  // page instead of a generic prompt.
  { id: 'wi-dsapi-e1', projectId: 'p-design-system-api', parentId: null, type: 'epic', title: 'Component API contract', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: [], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(75), updatedAt: D(2), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-dsapi-e1-s1', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'story', title: 'Typed prop contracts with generated codemods', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-001', assigneeName: 'Theo Chang', assigneeDept: 'Platform Engineering', labels: ['api', 'codemods'], storyPoints: 8, estimatedCostUsd: 10.03, sprintId: 'spr-dsapi-s1', prUrl: null, prStatus: null, createdAt: D(24), updatedAt: D(0), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-dsapi-e1-s2', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'story', title: 'Versioned release channels (stable/next)', description: null, status: 'done', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['releases'], storyPoints: 5, estimatedCostUsd: 4.27, sprintId: 'spr-dsapi-s1', prUrl: 'https://github.com/connorhoehnslalom/orgiq-design-system-api/pull/57', prStatus: 'merged', createdAt: D(36), updatedAt: D(4), completedAt: D(9), childCount: 0, childDoneCount: 0 },
  { id: 'wi-dsapi-e1-b3', projectId: 'p-design-system-api', parentId: 'wi-dsapi-e1', type: 'bug', title: 'Breaking prop rename slipped past the semver gate', description: null, status: 'open', priority: 'high', assigneeId: 'p-038', assigneeName: 'Isabel Vasquez', assigneeDept: 'Design Systems', labels: ['semver'], storyPoints: 3, estimatedCostUsd: 3.85, sprintId: 'spr-dsapi-s1', prUrl: null, prStatus: null, createdAt: D(32), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
];

/** Sprint membership + dollar estimate for the seeds that carry one. */
const MOCK_PROGRAM_FIELDS: Record<string, { sprintId?: string; estimatedCostUsd?: number }> = {
  // The SME's board, matching schema/seed_program.sql row for row.
  'wi-obs-e2-s2': { sprintId: 'spr-obs-s2', estimatedCostUsd: 6.32 },
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
function normalizeSeed(seed: MockSeed, idOverride?: { id: string; parentId: string | null }): WorkItem {
  return {
    key: SEEDED_WORK_KEYS[seed.id] ?? null,
    sprintId: null,
    estimatedCostUsd: null,
    summary: null,
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
    ...seed,
    ...MOCK_PROGRAM_FIELDS[seed.id],
    ...(idOverride ?? {}),
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
    default: () => MOCK_WORK_ITEM_SEEDS.map((seed) => normalizeSeed(seed)),
    empty: () => [],
    large: largeWorkItems,
    demo: demoWorkItems,
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
