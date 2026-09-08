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

export type ArtifactType = 'runbook' | 'insight' | 'convention' | 'decision';
export type ArtifactStatus = 'draft' | 'published' | 'retired';

export interface Fact {
  id: string;
  artifact_id: string;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  evidence_observation_ids: string[];
  confidence: number;
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
  status: ArtifactStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
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
}

/** GET /artifacts?status=&type=&q= */
export interface ArtifactsResponse {
  artifacts: Artifact[];
}

// ── Lineage ──────────────────────────────────────────────────────────────

export type LineageNodeKind = 'observation' | 'session' | 'cluster' | 'artifact' | 'fact' | 'library_item';
export type LineageRelation = 'written_by' | 'merged_into' | 'distilled_into' | 'supports' | 'published_as';

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
}

export interface CompactionFlowModel {
  nodes: CompactionFlowNode[];
  edges: CompactionFlowEdge[];
}
