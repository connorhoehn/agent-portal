// Wire contracts for /api/distillation — the shared-memory store's
// compaction state AND the domain it compacts into: observations (L0),
// clusters (L1), artifacts (L2), the facts an artifact carries, lineage
// between them, and the human review sample. See
// middleware/src/providers/distillation.ts and middleware/src/mock/distillation.ts
// for the authoritative shape (read directly — the middleware side of this
// feature landed while this file was being written).
//
// Two casing conventions coexist deliberately: the OPERATIONAL surface
// (LevelState, IngestState, CompactionJob's own fields, SamplingState — all
// pre-existing) stays camelCase, matching every other /api/distillation and
// /api/library response in this codebase. The DOMAIN layer added for this
// feature (Observation, Cluster, Artifact, Fact, ReviewSample, Lineage, and
// CompactionJob's new `produced` field) is snake_case, verbatim from
// docs/distillation-goal.md's domain-model sketch — the middleware
// implemented it literally rather than translating to the house convention.
// Do not "fix" the casing here without changing the middleware to match.

export type Level = 'L0' | 'L1' | 'L2';

export interface LevelState {
  level: Level;
  items: number;
  sizeBytes: number;
  oldestAt: string;
  lagSeconds: number;
}

export interface IngestState {
  activeWriters: number;
  observationsPerHour: number;
  topRepos: Array<{ repo: string; share: number }>;
}

export type CompactionStatus = 'running' | 'succeeded' | 'failed';

/** What a compaction pass made — lets a job row open the clusters/artifacts
 *  it produced instead of only reporting counts. snake_case: part of the
 *  domain layer, not the pre-existing operational fields around it. Kept
 *  optional here even though the provider types it as required — older mock
 *  compaction rows predate this field (a live middleware tsc gap as of this
 *  writing), so the portal treats "missing" as "nothing produced" rather
 *  than crashing on it. */
export interface CompactionProduced {
  cluster_ids: string[];
  artifact_ids: string[];
}

export interface CompactionJob {
  id: string;
  level: Level;
  startedAt: string;
  finishedAt: string | null;
  status: CompactionStatus;
  inputItems: number;
  outputItems: number;
  dedupedItems: number;
  bytesReclaimed: number;
  costUsd: number;
  error?: string;
  produced?: CompactionProduced;
}

export interface SamplingState {
  l1SampleRatePct: number;
  reviewedLast30d: number;
  agreementRatePct: number;
  queueDepth: number;
}

export type LevelHealthStatus = 'healthy' | 'behind' | 'stalled';

export interface LevelHealth {
  level: Level;
  status: LevelHealthStatus;
  reason: string;
}

export type SamplingVerdictLabel = 'undersampled' | 'calibrated' | 'oversampled';

export interface SamplingVerdict {
  verdict: SamplingVerdictLabel;
  reason: string;
}

/** GET /api/distillation/levels */
export interface LevelsResponse {
  levels: LevelState[];
  health: LevelHealth[];
}

/** GET /api/distillation/compactions */
export interface CompactionsResponse {
  jobs: CompactionJob[];
}

/** GET /api/distillation/sampling */
export interface SamplingResponse extends SamplingState {
  verdict: SamplingVerdict;
}

export type CompactableLevel = 'L1' | 'L2';

// ── Domain: L0 observations, L1 clusters, L2 artifacts ─────────────────────

export type ObservationKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';

export interface Observation {
  id: string;
  session_id: string;
  box_id: string;
  repo: string;
  initiative_id: string;
  kind: ObservationKind;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

export interface Cluster {
  id: string;
  title: string;
  summary: string;
  /** Shares the observation-kind vocabulary — a cluster inherits the
   *  dominant kind of the observations merged into it. */
  kind: ObservationKind;
  repo: string;
  initiative_id: string;
  tags: string[];
  member_observation_ids: string[];
  confidence: number;
  created_by_compaction_id: string;
  created_at: string;
  updated_at: string;
}

/** 'procedure' is procedural memory: an ordered recipe ("do A, then B")
 *  rather than a claim. Its facts are its steps, ordered by `Fact.ordinal`,
 *  and it is the only type with an application history (ProcedureApplication). */
export type ArtifactType = 'runbook' | 'insight' | 'convention' | 'decision' | 'procedure';
export type ArtifactStatus = 'draft' | 'published' | 'retired';
/** Sensitivity, not release-readiness — `LibraryAsset.tier` already answers
 *  "is this safe to run"; this answers "who is allowed to see this." */
export type ArtifactClassification = 'internal' | 'confidential' | 'public';

export interface Fact {
  id: string;
  artifact_id: string;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  evidence_observation_ids: string[];
  confidence: number;
  /** 1-based step position when the fact is a step of a procedure; null for
   *  a plain claim. Ordinal, not array index, because a procedure's steps
   *  arrive through lineage (unordered nodes), and the reader must be able to
   *  say "failed at step 3" without depending on node order on the wire. */
  ordinal: number | null;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  summary: string;
  body_markdown: string;
  cluster_ids: string[];
  /** Fact IDs only — a fact is resolved through lineage (its node meta
   *  carries subject/predicate/object/confidence), never inlined here, so it
   *  has exactly one representation on the wire. There is no `GET /facts/:id`;
   *  `GET /facts/:id/lineage` and an artifact's own
   *  `GET /items/:id/lineage` are the only ways to read a fact's content. */
  facts: string[];
  library_item_id: string | null;
  /** Who is accountable for this artifact as enterprise IP — distinct from
   *  `reviewed_by`, which is who signed off on the L1 sample it was
   *  distilled from. A reviewer is not an owner. */
  owner: string;
  classification: ArtifactClassification;
  status: ArtifactStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Last time this artifact's published Library asset was actually
   *  invoked — null until it has BOTH `status: 'published'` and a Library
   *  link; never borrows `updated_at`'s meaning (last EDITED). */
  last_used_at: string | null;
  /** Server-computed rollup — mean confidence of the artifact's own facts
   *  (falling back to its source clusters), never stored. */
  confidence: number;
  created_by_compaction_id: string;
  created_at: string;
  updated_at: string;
}

/** GET /items/:id — kind-discriminated by `level`; GET /items?level=&… — a
 *  page of these, full objects (not a slimmed summary — the level's own
 *  fields ARE the row shape, so L0/L1/L2 each render from their own type). */
export type Item =
  | ({ level: 'L0' } & Observation)
  | ({ level: 'L1' } & Cluster)
  | ({ level: 'L2' } & Artifact);

export interface ItemsResponse {
  items: Item[];
  next_cursor: string | null;
  /** Rows matching the filtered query across every page (spec §3a). Absent
   *  on a middleware that has not shipped it — then only "N loaded" can be
   *  said, never "N of M". */
  total?: number | null;
}

/** GET /artifacts?status=&type=&q= */
export interface ArtifactsResponse {
  artifacts: Artifact[];
}

// ── Lineage ──────────────────────────────────────────────────────────────

/** 'application' = one run of a procedure in a session (see
 *  ProcedureApplication). Its node meta carries { outcome, applied_at,
 *  session_id, box_id, failed_at_step_id, subtitle }; a 'fact' node that is a
 *  procedure step additionally carries `meta.ordinal`. */
export type LineageNodeKind = 'observation' | 'session' | 'cluster' | 'artifact' | 'fact' | 'library_item' | 'application';
/** 'applied_in' runs artifact → application: the procedure was applied in
 *  that session, so the edge points at the run the same way `published_as`
 *  points at the library item. */
export type LineageRelation = 'written_by' | 'merged_into' | 'distilled_into' | 'supports' | 'published_as' | 'applied_in';

export interface LineageNode {
  id: string;
  kind: LineageNodeKind;
  label: string;
  meta: Record<string, unknown>;
}

export interface LineageEdge {
  from: string;
  to: string;
  relation: LineageRelation;
}

/** GET /items/:id/lineage?depth= and GET /facts/:id/lineage */
export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

// ── Review sample ────────────────────────────────────────────────────────

export type ReviewTargetKind = 'cluster' | 'artifact';
export type ReviewVerdict = 'pending' | 'agree' | 'disagree';

export interface ReviewSample {
  id: string;
  target_kind: ReviewTargetKind;
  target_id: string;
  sampled_at: string;
  reviewer: string | null;
  verdict: ReviewVerdict;
  note: string | null;
}

/** GET /review?verdict= */
export interface ReviewResponse {
  samples: ReviewSample[];
}

// ── Procedures (procedural memory) ───────────────────────────────────────
// A procedure is an L2 artifact whose facts are ordered steps. Unlike the
// other artifact types it is *applied*, not just read: each run in a session
// is recorded as an application, and the middleware folds those runs into a
// per-procedure health verdict. Same rule as the level health above — the
// server owns the judgment (`ProcedureHealth.reason` is its sentence), the
// portal only renders it. snake_case: domain layer, like Artifact/Fact.

export type ApplicationOutcome = 'succeeded' | 'failed' | 'abandoned';

export interface ProcedureApplication {
  id: string;
  procedure_id: string;
  session_id: string;
  box_id: string;
  repo: string;
  applied_at: string;
  outcome: ApplicationOutcome;
  /** The step (a Fact id) the run failed on; null unless `outcome` is
   *  'failed' — an abandoned run stopped without a step blaming itself. */
  failed_at_step_id: string | null;
  note: string | null;
}

/** 'proven' = recent runs succeed; 'drifting' = it used to work but recent
 *  runs fail or new gotchas cluster around its repo, so the recipe is
 *  probably stale; 'unproven' = never (or not recently) applied, so there is
 *  no evidence either way. */
export type ProcedureHealthStatus = 'proven' | 'drifting' | 'unproven';

export interface ProcedureHealth {
  status: ProcedureHealthStatus;
  reason: string;
}

/** GET /api/distillation/procedures — one row per procedure artifact with
 *  its run history rolled up server-side, so the list page needs no
 *  per-row applications fetch. */
export interface ProcedureView {
  artifact: Artifact;
  /** The repo the procedure was distilled for; null when its clusters span
   *  more than one and no single repo can be named. */
  repo: string | null;
  step_count: number;
  runs: { total: number; succeeded: number; failed: number; abandoned: number };
  last_applied_at: string | null;
  last_succeeded_at: string | null;
  /** The session that last proved it — what the health reason names. */
  last_succeeded_by: string | null;
  /** 14 UTC-day buckets, oldest → newest, of applications per day — the
   *  sparkline input. Always 14 long; a quiet day is a 0, not a gap. */
  applied_per_day: number[];
  /** The drift evidence behind `health` — shown next to the verdict so a
   *  reader can see what the server counted, not just what it concluded. */
  drift: { new_gotcha_clusters: number; failed_runs: number };
  health: ProcedureHealth;
}

export interface ProceduresResponse {
  procedures: ProcedureView[];
}

/** GET /api/distillation/procedures/:id/applications — newest first. */
export interface ApplicationsResponse {
  applications: ProcedureApplication[];
}

// ── Library provenance ───────────────────────────────────────────────────

/** GET /library/:libraryItemId/provenance — 404 when the asset was not
 *  distilled, which the caller treats as "no section," not an error. */
export interface ProvenanceResponse {
  artifact: Artifact;
  lineage: Lineage;
}

// ── Compaction flow (Compactions page — top-of-page tier ladder) ───────────
// A small, non-interactive xyflow canvas: L0 → L1 → L2 → Library, fed by
// /api/distillation/levels (counts + health) and the same `jobs` the
// Compactions table already polls (edge labels — the latest merge for that
// step). See distillationFormat.ts `compactionFlowModel`/`latestJobFor`.

/** 'source' = the agents and bots whose sessions and findings feed L0;
 *  'session' = the session bundle agents boot with (Session config) —
 *  both used only by the Overview's end-to-end process flow. */
export type CompactionFlowNodeKind = 'tier' | 'library' | 'source' | 'session' | 'review' | 'promotions';

export interface CompactionFlowNode {
  id: string;
  kind: CompactionFlowNodeKind;
  /** Set only for kind: 'tier'. */
  level?: Level;
  label: string;
  /** null when the caller couldn't determine a count — e.g. `bots` on the
   *  Overview process flow when /api/bots 403s for the viewer's role
   *  (defect #12). Rendered as an unknown state, never coerced to 0. */
  count: number | null;
  /** Set only for kind: 'tier' — the library node isn't a compaction level
   *  and has no health verdict of its own. */
  health?: LevelHealthStatus;
  x: number;
  y: number;
  /** "L1 clusters, 22 items, behind" — the node's accessible name, read
   *  whole by a screen reader/keyboard user rather than assembled from
   *  a chip + a number + a separate label. */
  ariaLabel: string;
  /** Route to push on click/Enter. Absent when the node has nothing to open
   *  — e.g. a `count: null` node whose caller has no working query for it;
   *  the frame renders such a node as non-interactive rather than offering
   *  a door it can't actually walk through. */
  navigateTo?: string;
}

/** Edge tone drives its stroke colour. 'neutral' is for the L2 → Library
 *  edge, which isn't a compaction level and so carries no health verdict to
 *  colour itself by. */
export type CompactionFlowEdgeTone = 'healthy' | 'behind' | 'stalled' | 'neutral';

export interface CompactionFlowEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  /** A job for this merge is running right now — fast dashed flow + a dot
   *  travelling the edge. */
  running: boolean;
  /** Nothing is running, but the destination level is behind/stalled — a
   *  slow, subtle pulse so the ladder still visibly needs attention.
   *  Mutually exclusive with `running` (running always wins). */
  breathing: boolean;
  tone: CompactionFlowEdgeTone;
  /** Hover explanation for an edge that stays static on purpose — e.g. the
   *  wire carries no timestamp yet to honestly animate from. Absent for
   *  every other edge; never set to explain an edge that IS animating. */
  title?: string;
}

export interface CompactionFlowModel {
  nodes: CompactionFlowNode[];
  edges: CompactionFlowEdge[];
}

// ── Redesign wire additions (docs/distillation-redesign-spec.md §3a) ────────
// Additive: every field is optional on the existing shapes so the portal
// keeps rendering against a middleware that has not shipped them yet. The
// models (tierFlowModel, reviewQueueModel, sourcesModel, procedureRunsModel)
// treat "absent" as "unknown", never as zero or healthy.

/** Server-owned verdict for a tier's inbound edge. 'ok' | 'behind' |
 *  'stalled' — never inferred by the portal from `lastCompletedAt`. */
export type TierHealthState = 'ok' | 'behind' | 'stalled';

export interface TierHealth {
  state: TierHealthState;
  reason: string;
  lagSeconds: number;
}

/** One tier in GET /api/distillation/levels after §3a. `count` is the new
 *  spelling of the item count; `items` is the pre-redesign field and is
 *  still read when `count` is absent. */
export interface TierLevel extends Partial<LevelState> {
  level: Level;
  count?: number;
  /** Distinct sessions writing in the last hour (L0). */
  writers?: number;
  /** Items waiting for the next pass into this tier. */
  backlog?: number;
  /** Last completed run of this tier's INBOUND edge. */
  lastCompletedAt?: string | null;
  /** Merkle root over (id, updated_at) of the tier's rows. */
  digest?: string;
  health?: TierHealth;
}

export interface TierLevelsResponse {
  levels: TierLevel[];
  /** Pre-redesign verdicts — read only when a level carries no `health`. */
  health?: LevelHealth[];
}

export interface CompactionLogLine {
  at: string;
  level: 'info' | 'warn' | 'error' | string;
  message: string;
}

/** A compaction job after §3a/§3b — queue states plus the run inspector's
 *  fields. */
export interface CompactionRun extends Omit<CompactionJob, 'status'> {
  status: 'queued' | CompactionStatus;
  input_ids?: string[];
  output_ids?: string[];
  log?: CompactionLogLine[];
  what_changed?: string;
  duration_ms?: number | null;
  cost_usd?: number | null;
  /** Live progress (distill:jobs frames). */
  phase?: string;
  percent?: number;
  stepLabel?: string;
  repo?: string;
}

/** GET /review — the server-joined target of a sample. */
export interface ReviewTarget {
  id: string;
  kind: string;
  /** Cluster kind (gotcha/worked/…) or artifact type (runbook/…). */
  type?: string | null;
  title: string;
  repo: string | null;
  source_count: number | null;
}

export interface ReviewSampleWithTarget extends ReviewSample {
  target?: ReviewTarget | null;
  target_error?: string | null;
  reviewed_at?: string | null;
}

/** GET /items/:id/sources — direct evidence of one item. */
export type SourceKind = 'cluster' | 'observation' | 'session' | 'artifact' | string;

export interface ItemSource {
  id: string;
  kind: SourceKind;
  title: string;
  timestamp: string | null;
  excerpt: string | null;
  session_id?: string | null;
  repo?: string | null;
}

export interface ItemSourcesResponse {
  sources: ItemSource[];
}

/** GET /procedures/:id/runs */
export type ProcedureStepStatus = 'done' | 'failed' | 'pending' | 'skipped';

export interface ProcedureRun {
  id?: string;
  at: string;
  actor: string | null;
  note: string | null;
  steps: Array<{ step_id: string; status: ProcedureStepStatus }>;
  /** Carried over from the application row when the server sends it. */
  outcome?: ApplicationOutcome;
  failed_at_step_id?: string | null;
  box_id?: string | null;
}

export interface ProcedureRunsResponse {
  runs: ProcedureRun[];
}

// ── Facets, sessions, replication (spec §3a/§3c) ─────────────────────────

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
}

/** GET /facets?level= — the filter popover's options for one tier. */
export interface FacetsResponse {
  repos?: FacetOption[];
  initiatives?: FacetOption[];
  kinds?: FacetOption[];
}

/** GET /sessions/:id — the agent run a set of run notes came from. */
export interface SessionRecord {
  id: string;
  repo?: string | null;
  box_id?: string | null;
  initiative_id?: string | null;
  started_at?: string | null;
  last_at?: string | null;
  writing?: boolean;
  notes?: Observation[];
}

export interface ReplicaState {
  id: string;
  digest?: string;
  lagMs?: number | null;
  lastSync?: string | null;
  repaired?: number;
}

/** GET /replication — the L2 read replicas against the primary's digest. */
export interface ReplicationResponse {
  primary?: { id: string; digest?: string } | null;
  replicas?: ReplicaState[];
  inSync?: boolean;
}
