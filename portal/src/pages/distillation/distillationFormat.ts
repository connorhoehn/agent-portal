// Pure derivations for the distillation surface. No React — testable under
// node:test like the other format modules. The server owns every judgment
// (level health, sampling verdict, dedupe ratio) — this owns how those
// numbers and labels read on screen, not the reasoning behind them.

import { relativeTime } from '../../lib/relativeTime.ts';
import { pgTimestampMs } from '../../lib/pgTimestamp.ts';
import { knowledgeHref, reviewHref, viewForLevel } from './distillationRoutes.ts';
import type {
  ApplicationOutcome, Artifact, ArtifactStatus, ArtifactType, CompactableLevel, CompactionFlowEdge,
  CompactionFlowEdgeTone, CompactionFlowModel, CompactionFlowNode, CompactionJob, CompactionProduced,
  CompactionStatus, Item, Lineage, Level, LevelHealth, LevelHealthStatus, LevelState, LineageEdge, LineageNode,
  LineageNodeKind, LineageRelation, ObservationKind, ProcedureApplication, ProcedureHealthStatus, ProcedureView,
  ReviewVerdict, SamplingVerdictLabel,
} from './types';

export const LEVEL_MEANING: Record<Level, string> = {
  L0: 'Raw observations as sessions write them — many concurrent writers, duplicates expected.',
  L1: 'Merged, deduped clusters — the tier humans sample.',
  L2: 'Stable distilled artifacts (runbooks, insights) that feed the library.',
};

export const LEVEL_HEALTH_TONE: Record<LevelHealthStatus, 'success' | 'warning' | 'danger'> = {
  healthy: 'success', behind: 'warning', stalled: 'danger',
};

/** InlineAlert's tone vocabulary uses 'error' where Chip uses 'danger' — kept
 *  as a separate map rather than a runtime translation at every call site. */
export const LEVEL_HEALTH_ALERT_TONE: Record<LevelHealthStatus, 'success' | 'warning' | 'error'> = {
  healthy: 'success', behind: 'warning', stalled: 'error',
};

export const STATUS_TONE: Record<CompactionStatus, 'success' | 'danger' | 'info'> = {
  succeeded: 'success', failed: 'danger', running: 'info',
};

export const SAMPLING_TONE: Record<SamplingVerdictLabel, 'success' | 'warning' | 'info'> = {
  calibrated: 'success', undersampled: 'warning', oversampled: 'info',
};

export const SAMPLING_LABEL: Record<SamplingVerdictLabel, string> = {
  calibrated: 'Calibrated', undersampled: 'Undersampled', oversampled: 'Oversampled',
};

/** "45m" / "2h 30m" / "3d 6h" — lag reads in the largest unit that keeps two
 *  digits of precision, because "162000 seconds behind" says nothing and
 *  "45 minutes" does. */
export function lagLabel(seconds: number): string {
  if (seconds <= 0) return 'caught up';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/** "427 KB" / "1.2 MB" — a size proxy, not a precise byte count, so one
 *  decimal is enough precision to be honest about that. */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Slice 2: has this timestamp landed inside the given window (ms) as of
 *  `nowMs`? Backs the Tiers "Landed" column's `StatusDot pulse` — the mock's
 *  ingest simulator mints L0 observations on a per-minute tick, so a 60s
 *  window shows that heartbeat directly, with zero new fields. An
 *  unparseable/missing timestamp reads as "not recent" rather than throwing,
 *  same failure posture as the rest of this module. */
export function isRecentlyLanded(iso: string | null | undefined, nowMs: number, windowMs: number): boolean {
  const ms = pgTimestampMs(iso);
  if (Number.isNaN(ms)) return false;
  const age = nowMs - ms;
  return age >= 0 && age < windowMs;
}

/** A node presence row shaped just enough to count live sessions per repo —
 *  the honest join key per the audit (repo, not session id: the two id
 *  spaces are disjoint). Callers pass whatever `GET /api/local-compute/nodes`
 *  returns; an offline node already reports zero sessions server-side. */
export interface RepoPresenceNode {
  presence: { sessions: Array<{ repo?: string | null }> };
}

/** How many live sessions (on the CALLER's own paired machines — this route
 *  is owner-scoped, "my machines," not fleet-wide) are touching `repo` right
 *  now. Null/no-repo reads as 0 rather than throwing — a procedure whose
 *  clusters span multiple repos has no single repo to check activity for. */
export function liveSessionCountForRepo(nodes: RepoPresenceNode[], repo: string | null): number {
  if (!repo) return 0;
  let count = 0;
  for (const node of nodes) {
    for (const s of node.presence.sessions) {
      if (s.repo === repo) count += 1;
    }
  }
  return count;
}

/** Slice 5 (docs/distillation-concept-audit-2026-09-16.md §2): one row per
 *  repo with a live session touching it right now (connected or stale),
 *  aggregated org-wide across every unrevoked machine in the fleet — the
 *  shape `GET /api/local-compute/presence/repos` returns. Deliberately
 *  redacted to counts: no node id, label, session id, intent or model, same
 *  posture as `/nodes/all`'s `summarize()`. */
export interface RepoPresenceEntry {
  repo: string;
  machines: number;
  sessions: number;
  lastSeenAt: string | null;
}

/** The aggregated row for one repo, or null when nobody in the fleet is
 *  touching it right now (or the caller has no single repo to check, per
 *  `liveSessionCountForRepo`'s null-repo convention). */
export function repoPresenceFor(repos: RepoPresenceEntry[], repo: string | null): RepoPresenceEntry | null {
  if (!repo) return null;
  return repos.find((r) => r.repo === repo) ?? null;
}

/** "3 sessions across 2 machines · 1 yours" / "1 session on 1 machine" /
 *  "1 yours" / "no live sessions" — the Overview repo-activity column's
 *  label. Leads with the org-wide figure, the honest redacted signal, and
 *  appends the caller's own count only when it is nonzero — restating
 *  "0 yours" tells a reader nothing. */
export function repoActivityLabel(entry: RepoPresenceEntry | null, mine: number): string {
  const minePart = mine > 0 ? ` · ${mine} yours` : '';
  if (!entry || entry.sessions === 0) return mine > 0 ? `${mine} yours` : 'no live sessions';
  const sessionsPart = `${entry.sessions} session${entry.sessions === 1 ? '' : 's'}`;
  const machinesPart = entry.machines === 1 ? ' on 1 machine' : ` across ${entry.machines} machines`;
  return `${sessionsPart}${machinesPart}${minePart}`;
}

/** Mirrors the server's dedupeRatio guard: a job that consumed nothing has
 *  no ratio to report, so "—" rather than a misleading 0% or 100%. */
export function dedupePctLabel(job: Pick<CompactionJob, 'inputItems' | 'dedupedItems'>): string {
  if (job.inputItems <= 0) return '—';
  return `${Math.round((job.dedupedItems / job.inputItems) * 100)}%`;
}

/** "3 clusters, 5 artifacts" / "1 artifact" / "nothing new" — the completion
 *  toast's detail once a launched job flips from running to succeeded.
 *  `produced` is guarded as absent-or-empty rather than assumed present: the
 *  job carries it from the start with both arrays empty while running (the
 *  counts "fill in" at completion per the middleware contract), so a caller
 *  polling mid-run and a caller reading the finished job both get a safe
 *  answer without a `produced == null` check of their own. */
export function producedSummaryLabel(produced: CompactionProduced | undefined | null): string {
  const clusters = produced?.cluster_ids.length ?? 0;
  const artifacts = produced?.artifact_ids.length ?? 0;
  if (clusters === 0 && artifacts === 0) return 'nothing new';
  const parts: string[] = [];
  if (clusters > 0) parts.push(`${clusters} cluster${clusters === 1 ? '' : 's'}`);
  if (artifacts > 0) parts.push(`${artifacts} artifact${artifacts === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** Wall-clock of one compaction job. A job still running has no duration
 *  yet — say so rather than measuring against now and reporting a number
 *  that keeps growing underneath the reader. */
export function durationLabel(job: Pick<CompactionJob, 'startedAt' | 'finishedAt'>): string {
  if (!job.finishedAt) return 'running…';
  const ms = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return secs % 60 === 0 ? `${mins}m` : `${mins}m ${secs % 60}s`;
}

// Promoted to lib/format.ts — the app-wide canonical `usd`. This used to skip
// thousands separators (`$1234.56` instead of `$1,234.56`); repointing fixes
// that for any distillation spend figure at or above $1,000.
export { usd } from '../../lib/format.ts';

export function pct(n01: number): string {
  return `${Math.round(n01 * 100)}%`;
}

// ── Artifacts (L2) ───────────────────────────────────────────────────────

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  runbook: 'Runbook', insight: 'Insight', convention: 'Convention', decision: 'Decision', procedure: 'Procedure',
};

/** 'success' for procedure is deliberate: it is the one type that gets
 *  *proven* by being run, so it borrows the "this worked" colour the rest of
 *  the surface uses for a succeeded job. */
export const ARTIFACT_TYPE_TONE: Record<ArtifactType, 'info' | 'accent' | 'neutral' | 'purple' | 'success'> = {
  runbook: 'info', insight: 'accent', convention: 'neutral', decision: 'purple', procedure: 'success',
};

export const ARTIFACT_STATUS_LABEL: Record<ArtifactStatus, string> = {
  draft: 'Draft', published: 'Published', retired: 'Retired',
};

export const ARTIFACT_STATUS_TONE: Record<ArtifactStatus, 'neutral' | 'success' | 'caution'> = {
  draft: 'neutral', published: 'success', retired: 'caution',
};

export const OBSERVATION_KIND_TONE: Record<ObservationKind, 'success' | 'danger' | 'warning' | 'purple' | 'info'> = {
  worked: 'success', failed: 'danger', gotcha: 'warning', decision: 'purple', convention: 'info',
};

/** How many facts an artifact carries. `Artifact.facts` is a list of fact
 *  IDs, not resolved Fact objects (there is no `GET /facts/:id` — a fact's
 *  content only comes back through lineage), so this is the cheap count a
 *  list row can show without an extra fetch per row. The Artifacts drawer
 *  shows the deeper, per-fact evidence-observation count once it already has
 *  the artifact's lineage loaded. */
export function artifactFactCount(a: Pick<Artifact, 'facts'>): number {
  return a.facts.length;
}

/** "3 observations" / "1 observation" — a fact's evidence count, read as
 *  support rather than a bare number, since the whole point of a fact panel
 *  is "how many observations back this claim up." Takes a count directly
 *  (not a Fact) so it works equally for a real `Fact.evidence_observation_ids`
 *  and for a count derived from lineage edges (the only way to learn a
 *  fact's evidence from the wire, since facts arrive as bare IDs). */
export function evidenceLabel(n: number): string {
  return `${n} observation${n === 1 ? '' : 's'}`;
}

export interface LineageFact {
  id: string;
  statement: string;
  confidence: number;
  evidenceCount: number;
}

/** A fact's content only ever arrives through lineage — `Artifact.facts` is
 *  bare IDs, and there is no `GET /facts/:id`. `nodeForFact` (the middleware
 *  provider) puts the statement in the node's `label` and confidence in
 *  `meta.confidence`; an evidence-observation count isn't handed over
 *  directly, but it's exactly the number of `supports` edges pointing AT the
 *  fact (an evidence observation "supports" the fact; the fact separately
 *  "supports" its artifact, which is an edge FROM the fact, not counted
 *  here). */
export function factsFromLineage(lineage: Pick<Lineage, 'nodes' | 'edges'>): LineageFact[] {
  return lineage.nodes
    .filter((n) => n.kind === 'fact')
    .map((n) => ({
      id: n.id,
      statement: n.label,
      confidence: typeof n.meta['confidence'] === 'number' ? (n.meta['confidence'] as number) : 0,
      evidenceCount: lineage.edges.filter((e) => e.relation === 'supports' && e.to === n.id).length,
    }));
}

// ── Items list filters (Tiers page — defect #2) ─────────────────────────────
// GET /api/distillation/items only accepts level/repo/initiative/q/limit/
// cursor (middleware/src/routes/distillation.ts) — there is no `kind` param,
// so a kind filter (L0 only) is applied here, client-side, against whatever
// page of items is already loaded, rather than sent to the server.

export interface ItemsQuery {
  level: Level;
  repo?: string;
  initiativeId?: string;
  q?: string;
  cursor?: string;
}

/** The exact query params GET /items accepts, in the request's own casing
 *  (`initiative`, not `initiativeId`). Omits anything falsy so an unset
 *  filter is absent from the URL rather than sent as an empty string. */
export function itemsQueryParams(query: ItemsQuery): Record<string, string> {
  const params: Record<string, string> = { level: query.level };
  if (query.repo) params['repo'] = query.repo;
  if (query.initiativeId) params['initiative'] = query.initiativeId;
  if (query.q) params['q'] = query.q;
  if (query.cursor) params['cursor'] = query.cursor;
  return params;
}

/** Keeps only items whose kind matches — L0 observations and L1 clusters
 *  both carry `kind`; L2 artifacts don't and always pass through. No kind
 *  selected means no filtering. */
export function filterByObservationKind(items: Item[], kind?: ObservationKind | ''): Item[] {
  if (!kind) return items;
  return items.filter((it) => (it.level === 'L0' || it.level === 'L1' ? it.kind === kind : true));
}

export interface ItemFilterState {
  repo?: string;
  initiativeId?: string;
  kind?: ObservationKind | '';
  q?: string;
}

/** One phrase per active filter, in a fixed order, so the empty state and
 *  any other summary read identically regardless of which filters are set. */
export function describeActiveFilters(f: ItemFilterState): string[] {
  const parts: string[] = [];
  if (f.repo) parts.push(`repo ${f.repo}`);
  if (f.initiativeId) parts.push(`initiative ${f.initiativeId}`);
  if (f.kind) parts.push(`kind ${f.kind}`);
  if (f.q) parts.push(`search "${f.q}"`);
  return parts;
}

export function hasActiveFilters(f: ItemFilterState): boolean {
  return describeActiveFilters(f).length > 0;
}

/** "repo x, kind gotcha" / "no filters" — the empty-state description reads
 *  either way without an extra branch at the call site. */
export function filtersSummaryLabel(f: ItemFilterState): string {
  const parts = describeActiveFilters(f);
  return parts.length > 0 ? parts.join(', ') : 'no filters';
}

/** "12 of 69 shown" — the tier card's count once a filter narrows the list;
 *  the unfiltered count (`lvlState.items`, already the real corpus total per
 *  defect #1's fix) is shown instead when no filter is active. */
export function itemsShownLabel(shown: number, total: number): string {
  return `${shown} of ${total} shown`;
}

// ── Review sample ────────────────────────────────────────────────────────

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pending: 'Pending', agree: 'Agree', disagree: 'Disagree',
};

export const REVIEW_VERDICT_TONE: Record<ReviewVerdict, 'neutral' | 'success' | 'danger'> = {
  pending: 'neutral', agree: 'success', disagree: 'danger',
};

// ── Lineage ──────────────────────────────────────────────────────────────

export const LINEAGE_NODE_LABEL: Record<LineageNodeKind, string> = {
  observation: 'Observation', session: 'Session', cluster: 'Cluster',
  artifact: 'Artifact', fact: 'Fact', library_item: 'Library item', application: 'Application',
};

export const LINEAGE_NODE_ICON: Record<LineageNodeKind, string> = {
  observation: '📝', session: '🖥️', cluster: '🧩', artifact: '📦', fact: '🔎', library_item: '📚', application: '▶️',
};

/** An application's accent is the same secondary grey as a session, because
 *  it IS a session-side event (a run in a box) — the outcome colour lives on
 *  the node's outcome chip (OUTCOME_SEVERITY), not on the accent bar, so a
 *  failed run doesn't paint the whole card red. */
export const LINEAGE_NODE_ACCENT: Record<LineageNodeKind, string> = {
  observation: 'bg-text-tertiary', session: 'bg-text-secondary', cluster: 'bg-warning',
  artifact: 'bg-primary', fact: 'bg-success', library_item: 'bg-optimize', application: 'bg-text-secondary',
};

export const LINEAGE_RELATION_LABEL: Record<LineageRelation, string> = {
  written_by: 'written by', merged_into: 'merged into', distilled_into: 'distilled into',
  supports: 'supports', published_as: 'published as', applied_in: 'applied in',
};

/** Reading order, left to right: raw writes, then merged clusters, then
 *  stable artifacts, then the facts they carry, then what got published. An
 *  application shares the rightmost column with the library item: both are
 *  "what happened to the artifact after it stabilised," and a procedure with
 *  a run history but no library item would otherwise leave column 4 empty
 *  and push its runs off to a sixth column for no reading benefit. A node
 *  kind not in this map (future-proofing an added kind) falls back to
 *  column 0 rather than throwing. */
const LINEAGE_COLUMN: Record<LineageNodeKind, number> = {
  observation: 0, session: 0, cluster: 1, artifact: 2, fact: 3, library_item: 4, application: 4,
};

const LINEAGE_COLUMN_WIDTH = 260;
// Was 100 — a node card is title + kind chip + accent bar, ~86px tall at
// that pitch. Widened to fit an id caption under the title (LineageFrame's
// truncation fix: a reader who can't read the whole title from the
// single-line ellipsis can still identify the node from its short, stable
// id) without shrinking the per-row headroom the "no node-on-node overlap"
// contract below relies on.
const LINEAGE_ROW_HEIGHT = 116;

export interface LineageLayoutNode {
  id: string;
  x: number;
  y: number;
}

/** Pure positioning for the lineage graph: one column per kind (see
 *  LINEAGE_COLUMN), and within a column, a node that has an incoming edge
 *  from an earlier column sorts above one that doesn't — so a cluster's
 *  member observations tend to land near the cluster they feed, instead of
 *  every column just being input order. No overlap resolution beyond that;
 *  @xyflow/react's own fitView handles the rest. */
export function layoutLineage(nodes: LineageNode[], edges: LineageEdge[]): LineageLayoutNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const columnOf = (id: string): number => LINEAGE_COLUMN[byId.get(id)?.kind as LineageNodeKind] ?? 0;

  const hasEarlierSource = (id: string): boolean =>
    edges.some((e) => e.to === id && byId.has(e.from) && columnOf(e.from) < columnOf(id));

  const rowInColumn = new Map<number, number>();
  const rowOf = new Map<string, number>();
  const nextRow = (col: number): number => {
    const r = rowInColumn.get(col) ?? 0;
    rowInColumn.set(col, r + 1);
    return r;
  };

  // First pass: nodes whose only inbound edges (if any) come from a later
  // or equal column — these anchor the top of their column.
  for (const n of nodes) {
    if (!hasEarlierSource(n.id)) rowOf.set(n.id, nextRow(LINEAGE_COLUMN[n.kind] ?? 0));
  }
  // Second pass: everything else, in input order.
  for (const n of nodes) {
    if (!rowOf.has(n.id)) rowOf.set(n.id, nextRow(LINEAGE_COLUMN[n.kind] ?? 0));
  }

  return nodes.map((n) => ({
    id: n.id,
    x: (LINEAGE_COLUMN[n.kind] ?? 0) * LINEAGE_COLUMN_WIDTH,
    y: (rowOf.get(n.id) ?? 0) * LINEAGE_ROW_HEIGHT,
  }));
}

// A node card's own height beyond the row pitch (the pitch already leaves it
// headroom, see LINEAGE_ROW_HEIGHT above) plus a little slack for fitView's
// padding fraction to work with, so the computed canvas height isn't shrink-
// wrapped so tight that fitView has nothing to breathe into.
const LINEAGE_CANVAS_ROW_ALLOWANCE = 50;

export interface LineageCanvasBand {
  min: number;
  max: number;
}

/** Residual defect (distillation lineage audit): `LineageFrame` used to hand
 *  `@xyflow/react` a fixed 560px-tall canvas no matter how short the graph
 *  actually was. `layoutLineage` places every node on a fixed grid — one
 *  column per kind (LINEAGE_COLUMN_WIDTH=260 apart) and one row per sibling
 *  in that column (LINEAGE_ROW_HEIGHT=116 apart) — so most single-artifact
 *  traces (one cluster, one artifact, its facts, its library item) are only
 *  1-4 rows tall: a bounding box of ~116-460px against a hard-coded 560px
 *  canvas. `fitView`'s zoom is the SMALLER of (canvas width / content
 *  width) and (canvas height / content height); a canvas far taller than the
 *  content it's given makes the height ratio irrelevant and leaves the
 *  actually-binding width ratio to decide the zoom, so the extra canvas
 *  height doesn't get used — it just sits empty and the graph renders small
 *  and boxed near the top. Sizing the canvas to the content's own row count
 *  (clamped to a band so a one-row graph isn't a sliver and a deep one still
 *  gets the room it needs) removes the mismatch instead of fighting it with
 *  a bigger fitView padding or a narrower zoom band. */
export function lineageCanvasHeight(positions: LineageLayoutNode[], band: LineageCanvasBand): number {
  if (positions.length === 0) return band.min;
  const maxY = Math.max(...positions.map((p) => p.y));
  const contentHeight = maxY + LINEAGE_ROW_HEIGHT + LINEAGE_CANVAS_ROW_ALLOWANCE;
  return Math.min(band.max, Math.max(band.min, contentHeight));
}

// ── Procedures (procedural memory) ───────────────────────────────────────
// A procedure's steps are its facts, ordered by `meta.ordinal`; its runs are
// `application` lineage nodes / ProcedureApplication rows. The server owns
// the health verdict (ProcedureView.health); this owns how steps, runs and
// verdicts read on screen.

export const PROCEDURE_HEALTH_LABEL: Record<ProcedureHealthStatus, string> = {
  proven: 'Proven', drifting: 'Drifting', unproven: 'Unproven',
};

/** Chip tones. 'unproven' is neutral, not a warning: no evidence isn't bad
 *  evidence, and a freshly distilled procedure shouldn't look like a
 *  drifting one before anyone has tried it. */
export const PROCEDURE_HEALTH_TONE: Record<ProcedureHealthStatus, 'success' | 'warning' | 'neutral'> = {
  proven: 'success', drifting: 'warning', unproven: 'neutral',
};

export const OUTCOME_LABEL: Record<ApplicationOutcome, string> = {
  succeeded: 'Succeeded', failed: 'Failed', abandoned: 'Abandoned',
};

/** EventRow's severity vocabulary (ui-components `EventRowProps.severity`)
 *  — 'error' rather than Chip's 'danger', same split as
 *  LEVEL_HEALTH_ALERT_TONE. Abandoned is a warning, not an error: the run
 *  stopped without the procedure being shown wrong. */
export const OUTCOME_SEVERITY: Record<ApplicationOutcome, 'success' | 'error' | 'warning'> = {
  succeeded: 'success', failed: 'error', abandoned: 'warning',
};

/** "1 step" / "4 steps". */
export function stepsLabel(n: number): string {
  return `${n} step${n === 1 ? '' : 's'}`;
}

export interface ProcedureStep {
  id: string;
  ordinal: number;
  label: string;
  meta: Record<string, unknown>;
}

/** A procedure's steps, in order, from its lineage. Only fact nodes with a
 *  numeric `meta.ordinal` qualify — a fact with a null ordinal is a plain
 *  claim the artifact also carries (a precondition, a gotcha) and is not a
 *  step, so it is dropped rather than sorted to one end. Sorted here
 *  because lineage nodes arrive in no promised order. */
export function stepsFromLineage(lineage: Pick<Lineage, 'nodes'>): ProcedureStep[] {
  const steps: ProcedureStep[] = [];
  for (const n of lineage.nodes) {
    if (n.kind !== 'fact') continue;
    const ordinal = n.meta['ordinal'];
    if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) continue;
    steps.push({ id: n.id, ordinal, label: n.label, meta: n.meta });
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}

export type StepTone = 'success' | 'danger' | 'neutral';

/** One tone per step (index-aligned with `steps`) from the latest run: a
 *  succeeded run proves every step; a failed run proves the steps before the
 *  one it failed on, blames that one, and says nothing about the rest; an
 *  abandoned run, or no run at all, proves nothing. A failed run whose
 *  `failed_at_step_id` names no known step (the step was since removed)
 *  reads as all-neutral rather than blaming the wrong step. */
export function stepTonesForRun(
  steps: Array<Pick<ProcedureStep, 'id'>>,
  latestRun: Pick<ProcedureApplication, 'outcome' | 'failed_at_step_id'> | null,
): StepTone[] {
  if (!latestRun) return steps.map(() => 'neutral');
  if (latestRun.outcome === 'succeeded') return steps.map(() => 'success');
  if (latestRun.outcome === 'abandoned') return steps.map(() => 'neutral');
  const failedAt = steps.findIndex((s) => s.id === latestRun.failed_at_step_id);
  if (failedAt < 0) return steps.map(() => 'neutral');
  return steps.map((_, i) => (i < failedAt ? 'success' : i === failedAt ? 'danger' : 'neutral'));
}

export interface ProcedureRollup {
  total: number;
  proven: number;
  drifting: number;
  unproven: number;
  /** "3 procedures · 1 proven · 1 drifting · 1 unproven" — zero buckets are
   *  omitted so a healthy fleet reads "3 procedures · 3 proven", not a row
   *  of "0 drifting · 0 unproven"; "no procedures" when the list is empty. */
  hint: string;
}

/** Health counts across the procedures list — the page header's one-line
 *  summary. Counts what the server said per row; it does not re-judge. */
export function procedureRollup(views: Array<Pick<ProcedureView, 'health'>>): ProcedureRollup {
  const counts = { proven: 0, drifting: 0, unproven: 0 };
  for (const v of views) counts[v.health.status] += 1;
  const total = views.length;
  if (total === 0) return { total, ...counts, hint: 'no procedures' };
  const parts = [`${total} procedure${total === 1 ? '' : 's'}`];
  for (const status of ['proven', 'drifting', 'unproven'] as const) {
    if (counts[status] > 0) parts.push(`${counts[status]} ${status}`);
  }
  return { total, ...counts, hint: parts.join(' · ') };
}

/** "6 runs · 4 succeeded" / "1 run · 1 succeeded" / "no runs yet" — the
 *  list row's run summary. Leads with the success count because that is
 *  the number a reader compares against total; failed and abandoned are
 *  the remainder and the health chip already says whether they matter. */
export function runsLabel(runs: ProcedureView['runs']): string {
  if (runs.total === 0) return 'no runs yet';
  return `${runs.total} run${runs.total === 1 ? '' : 's'} · ${runs.succeeded} succeeded`;
}

// ── Compaction flow (Compactions page — top-of-page tier ladder) ───────────

const TIER_NOUN: Record<Level, string> = { L0: 'observations', L1: 'clusters', L2: 'artifacts' };
const TIER_TITLE: Record<Level, string> = { L0: 'L0 Observations', L1: 'L1 Clusters', L2: 'L2 Artifacts' };

// Node cards are 168px wide; the audit saw edges that were a 52px stub hidden
// under their own label chip, and labels sitting on the cards. 360 leaves a
// ~190px run per edge for the line, the arrow and the label.
const COMPACTION_FLOW_COLUMN_WIDTH = 360;

/** Health tone → edge tone is the identity map today, but kept as its own
 *  type (CompactionFlowEdgeTone adds 'neutral' for the Library edge, which
 *  has no health verdict) rather than reusing LevelHealthStatus directly. */
function edgeToneForHealth(status: LevelHealthStatus | undefined): CompactionFlowEdgeTone {
  return status ?? 'healthy';
}

/** The most recently started compaction job for a given merge step (L0→L1
 *  is recorded as level 'L1', L1→L2 as level 'L2' — CompactionJob.level is
 *  the level it PRODUCED, per the middleware contract). `null` when nothing
 *  has run for that step yet, which the caller reads as "no merges yet"
 *  rather than picking a job at random. */
export function latestJobFor(level: CompactableLevel, jobs: CompactionJob[]): CompactionJob | null {
  let latest: CompactionJob | null = null;
  for (const job of jobs) {
    if (job.level !== level) continue;
    if (!latest || Date.parse(job.startedAt) > Date.parse(latest.startedAt)) latest = job;
  }
  return latest;
}

/** "140 in · 62 out · 56% deduped · 1h ago" for a merge step's latest job,
 *  or a plain "no merges yet" when the step has never run. */
function mergeEdgeLabel(job: CompactionJob | null): string {
  if (!job) return 'no merges yet';
  return `${job.inputItems} in · ${job.outputItems} out · ${dedupePctLabel(job)} deduped · ${relativeTime(job.startedAt)}`;
}

/** Pure layout + labelling for the Compactions page's tier-ladder canvas:
 *  L0 Observations → L1 Clusters → L2 Artifacts → Library, left to right.
 *  Counts and health come from GET /api/distillation/levels; edge labels
 *  come from the latest job (per `latestJobFor`) for that merge step; the
 *  Library node's count is the caller's own published-artifact count
 *  (GET /api/distillation/artifacts?status=published, filtered to
 *  `library_item_id != null` — this module has no fetching of its own).
 *  `animated`/`breathing` flags are derived here so the presentational
 *  frame only has to read them, not re-derive "is anything running." */
export function compactionFlowModel(
  levels: LevelState[],
  health: LevelHealth[],
  jobs: CompactionJob[],
  publishedCount: number,
): CompactionFlowModel {
  const countFor = (level: Level): number => levels.find((l) => l.level === level)?.items ?? 0;
  const healthFor = (level: Level): LevelHealthStatus | undefined => health.find((h) => h.level === level)?.status;

  const tierNode = (level: Level, index: number): CompactionFlowNode => {
    const count = countFor(level);
    const status = healthFor(level);
    return {
      id: level,
      kind: 'tier',
      level,
      label: TIER_TITLE[level],
      count,
      health: status,
      x: index * COMPACTION_FLOW_COLUMN_WIDTH,
      y: 0,
      ariaLabel: `${level} ${TIER_NOUN[level]}, ${count} item${count === 1 ? '' : 's'}${status ? `, ${status}` : ''}`,
      navigateTo: knowledgeHref({ view: viewForLevel(level) }),
    };
  };

  const nodes: CompactionFlowNode[] = [
    tierNode('L0', 0),
    tierNode('L1', 1),
    tierNode('L2', 2),
    {
      id: 'library',
      kind: 'library',
      label: 'Library',
      count: publishedCount,
      x: 3 * COMPACTION_FLOW_COLUMN_WIDTH,
      y: 0,
      ariaLabel: `Library, ${publishedCount} published`,
      navigateTo: '/iq/library',
    },
  ];

  const l1Job = latestJobFor('L1', jobs);
  const l2Job = latestJobFor('L2', jobs);
  const l1Health = healthFor('L1');
  const l2Health = healthFor('L2');

  const mergeEdge = (
    id: string, source: string, target: string, job: CompactionJob | null, targetHealth: LevelHealthStatus | undefined,
  ): CompactionFlowEdge => {
    const running = job?.status === 'running';
    return {
      id, source, target,
      label: mergeEdgeLabel(job),
      running,
      breathing: !running && targetHealth != null && targetHealth !== 'healthy',
      tone: edgeToneForHealth(targetHealth),
    };
  };

  const edges: CompactionFlowEdge[] = [
    mergeEdge('L0-L1', 'L0', 'L1', l1Job, l1Health),
    mergeEdge('L1-L2', 'L1', 'L2', l2Job, l2Health),
    {
      id: 'L2-library', source: 'L2', target: 'library',
      label: 'published as',
      running: false,
      breathing: false,
      tone: 'neutral',
    },
  ];

  return { nodes, edges };
}

// ── Overview: how findings become org knowledge ──────────────────────────
//
// The same node/edge model the Compactions ladder draws, laid out as a DAG:
// four input branches on the left (agent sessions, bot runs, sweep findings,
// lab signals) fan into L0; the pipeline L0 → L1 → L2 runs through the
// middle with the live merge state the Compactions page shows; human review
// feeds L1 from below (the sample verdicts calibrate what a cluster is); and
// L2 fans out on the right — published runbooks into the Library, candidate
// skills into Promotions — with the Library bundled into the session config
// every agent boots with, which is how a runbook distilled from last week's
// runs steers next week's. Positions are absolute canvas units; the frame
// fits the whole graph to its box.
// Defect #10: at 262 (NODE_WIDTH=168) the gap between two tier cards is only
// 94px, but a merge-edge label (`mergeEdgeLabel()`, e.g. "140 in · 62 out ·
// 56% deduped · 1h ago") measures ~123px wide — every label overhung both
// neighbouring cards by ~33px and read as truncated nonsense under them. The
// Compactions ladder's own pitch (`COMPACTION_FLOW_COLUMN_WIDTH = 360`,
// gap = 360 - 168 = 192px) is the working reference and clips the same label
// by only 3-5px, so ~200px of gap is the honest floor, not just "no overlap."
// 370 gives 370 - 168 = 202px of gap — enough room for the 123px label with
// margin either side, not a bare fit.
const PROCESS_FLOW_COL = 370;
const PROCESS_FLOW_ROW = 96;

export interface ProcessFlowInputs {
  /** Sessions writing observations right now (ingest.activeWriters). */
  activeWriters: number;
  /** Runs the enabled maintenance bots made today; null when the caller
   *  couldn't tell — a failed /api/bots fetch (e.g. a member's 403) or a
   *  response that wasn't the expected array shape. Defect #12: a role
   *  without Bots access must see "unknown," never a lying 0. */
  botRunsToday: number | null;
  /** Open findings from the scheduled sweeps (bus factor, stale docs, …). */
  sweepFindings: number;
  /** Open findings agents filed themselves from a devbox (lab signals). */
  labSignals: number;
  /** Human review verdicts in the last 30 days (sampling.reviewedLast30d). */
  reviewed30d: number;
  /** Sampled items waiting for a verdict right now (sampling.queueDepth) —
   *  real backlog pressure on the review step, the same "behind" semantic
   *  the tier-health breathing already uses. */
  queueDepth: number;
  levels: LevelState[];
  health: LevelHealth[];
  jobs: CompactionJob[];
  /** Artifacts that are published AND carry a library item. */
  publishedCount: number;
  /** Promotion candidates awaiting approval. */
  candidates: number;
  /** Skills in the live session bundle; null when the bundle is unknown. */
  bundleSkills: number | null;
}

export function processFlowModel(input: ProcessFlowInputs): CompactionFlowModel {
  const { levels, health, jobs } = input;
  const countFor = (level: Level): number => levels.find((l) => l.level === level)?.items ?? 0;
  const healthFor = (level: Level): LevelHealthStatus | undefined => health.find((h) => h.level === level)?.status;
  const col = (i: number) => i * PROCESS_FLOW_COL;
  const row = (i: number) => i * PROCESS_FLOW_ROW;
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const centre = row(1.5); // the pipeline's row: between the four input rows

  const tierNode = (level: Level, index: number): CompactionFlowNode => {
    const count = countFor(level);
    const status = healthFor(level);
    return {
      id: level, kind: 'tier', level, label: TIER_TITLE[level], count, health: status,
      x: col(index), y: centre,
      ariaLabel: `${level} ${TIER_NOUN[level]}, ${plural(count, 'item')}${status ? `, ${status}` : ''}`,
      navigateTo: knowledgeHref({ view: viewForLevel(level) }),
    };
  };
  const source = (
    id: string, label: string, count: number, y: number, aria: string, navigateTo?: string,
  ): CompactionFlowNode => ({ id, kind: 'source', label, count, x: col(0), y, ariaLabel: aria, navigateTo });

  // Defect #12: /api/bots 403s for a member, and a caller-side fetch failure
  // is not "zero bots ran today" — it's "this role can't see bot data."
  // `botRunsToday` carries that distinction in from ProcessFlow (null on a
  // failed fetch or a malformed response); rendered as an unknown count, not
  // a lying 0, and with no door offered to a route the caller can't open —
  // the same "unknown" shape `bundleSkills == null` already used below for
  // Session config.
  const botsNode: CompactionFlowNode = input.botRunsToday == null
    ? { id: 'bots', kind: 'source', label: 'Bot runs', count: null, x: col(0), y: row(1), ariaLabel: 'Bot runs, unknown — no access to bot data' }
    : source('bots', 'Bot runs', input.botRunsToday, row(1), `Bot runs, ${plural(input.botRunsToday, 'run')} today`, '/admin/bots');

  const nodes: CompactionFlowNode[] = [
    source('sessions', 'Agent sessions', input.activeWriters, row(0), `Agent sessions, ${plural(input.activeWriters, 'session')} writing observations`, '/iq/invoke'),
    botsNode,
    source('sweeps', 'Sweep findings', input.sweepFindings, row(2), `Sweep findings, ${plural(input.sweepFindings, 'open finding')}`, '/iq/work/findings'),
    source('lab', 'Lab signals', input.labSignals, row(3), `Lab signals, ${plural(input.labSignals, 'open signal')} filed by agents`, '/iq/work/findings'),
    tierNode('L0', 1),
    tierNode('L1', 2),
    tierNode('L2', 3),
    {
      id: 'review', kind: 'review', label: 'Human review', count: input.reviewed30d,
      x: col(1), y: row(3.5),
      ariaLabel: `Human review, ${plural(input.reviewed30d, 'verdict')} in 30 days, calibrates L1`,
      navigateTo: reviewHref(),
    },
    {
      id: 'library', kind: 'library', label: 'Library', count: input.publishedCount,
      x: col(4), y: row(0.5),
      ariaLabel: `Library, ${plural(input.publishedCount, 'published runbook')}`,
      navigateTo: '/iq/library',
    },
    {
      id: 'promotions', kind: 'promotions', label: 'Promotions', count: input.candidates,
      x: col(4), y: row(2.5),
      ariaLabel: `Promotions, ${plural(input.candidates, 'candidate skill')} awaiting approval`,
      navigateTo: '/iq/promotions',
    },
    {
      id: 'session', kind: 'session', label: 'Session config', count: input.bundleSkills ?? 0,
      x: col(5), y: row(0.5),
      ariaLabel: input.bundleSkills == null
        ? 'Session config, live bundle unknown'
        : `Session config, ${plural(input.bundleSkills, 'skill')} every agent boots with`,
      navigateTo: '/iq/release',
    },
  ];

  const l1Job = latestJobFor('L1', jobs);
  const l2Job = latestJobFor('L2', jobs);
  const mergeEdge = (
    id: string, sourceId: string, target: string, job: CompactionJob | null, targetHealth: LevelHealthStatus | undefined,
  ): CompactionFlowEdge => {
    const running = job?.status === 'running';
    return {
      id, source: sourceId, target, label: mergeEdgeLabel(job), running,
      breathing: !running && targetHealth != null && targetHealth !== 'healthy',
      tone: edgeToneForHealth(targetHealth),
    };
  };
  // Input edges carry no label: four labels converging on L0 overlapped each
  // other and the node — the counts are on the source nodes instead.
  const plain = (id: string, sourceId: string, target: string, label = '', title?: string): CompactionFlowEdge =>
    ({ id, source: sourceId, target, label, running: false, breathing: false, tone: 'neutral', ...(title ? { title } : {}) });
  // "Something is in flight right now" — the moving-dot class. Only a real
  // concurrency signal earns this; `sessions-L0` is the one input edge with
  // one (`activeWriters`), per the audit's per-edge table.
  const running = (id: string, sourceId: string, target: string, isRunning: boolean): CompactionFlowEdge =>
    ({ id, source: sourceId, target, label: '', running: isRunning, breathing: false, tone: 'neutral' });
  // "Real pressure, not necessarily this instant" — a today-total or an
  // open-count is honest as breathing (a slow pulse) but would overclaim as
  // a moving dot, since a single run at 3am still reads as a nonzero count.
  const breathing = (id: string, sourceId: string, target: string, label: string, hasPressure: boolean): CompactionFlowEdge =>
    ({ id, source: sourceId, target, label, running: false, breathing: hasPressure, tone: 'neutral' });

  const edges: CompactionFlowEdge[] = [
    running('sessions-L0', 'sessions', 'L0', input.activeWriters > 0),
    breathing('bots-L0', 'bots', 'L0', '', (input.botRunsToday ?? 0) > 0),
    breathing('sweeps-L0', 'sweeps', 'L0', '', input.sweepFindings > 0),
    breathing('lab-L0', 'lab', 'L0', '', input.labSignals > 0),
    mergeEdge('L0-L1', 'L0', 'L1', l1Job, healthFor('L1')),
    mergeEdge('L1-L2', 'L1', 'L2', l2Job, healthFor('L2')),
    breathing('review-L1', 'review', 'L1', 'calibrates', input.queueDepth > 0),
    // Static on purpose: `Artifact.updated_at` exists but nothing scans it
    // for "published within window W" yet (needs a small `hasRecentArtifact`
    // helper, not a new endpoint) — leave static rather than fake it.
    plain('L2-library', 'L2', 'library', 'published as', 'Not yet wired to activity — no recent-publish window is computed from Artifact.updated_at.'),
    // Static: a promotion candidate carries no timestamp on the wire today
    // (`PromotionsResponse.candidates` has no `created_at`) — needs a field
    // add to `providers/promotions.ts` before this can honestly breathe.
    plain('L2-promotions', 'L2', 'promotions', 'candidate skills', 'Cannot animate yet — promotion candidates carry no created_at on the wire.'),
    // Static: the live session bundle (`session-bundle/live`) exposes only
    // `skills?: unknown[]`, no timestamp — same gap as above.
    plain('library-session', 'library', 'session', 'bundled into', 'Cannot animate yet — the live session bundle carries no timestamp.'),
  ];
  return { nodes, edges };
}

/** Vertical pitch between two labels that would otherwise sit on the same
 *  point. One label height plus a hairline of air. */
export const LABEL_STAGGER_Y = 16;

export interface LabelAnchor { x: number; y: number }

/**
 * Lineage edges anchor their label at a fixed inset past the leftmost
 * endpoint, so two edges that start in the same column and end in the same
 * row get byte-identical anchors and paint on top of each other — the audit
 * found four such edges rendering as "supports to" and two labels invisible.
 * Spread every colliding group symmetrically about its shared point, keeping
 * input order stable so a re-render never reshuffles them.
 */
export function staggerLabelAnchors(anchors: LabelAnchor[]): LabelAnchor[] {
  const groups = new Map<string, number[]>();
  anchors.forEach((a, i) => {
    const key = `${Math.round(a.x)}:${Math.round(a.y)}`;
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });
  const out = anchors.map((a) => ({ ...a }));
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const span = (idxs.length - 1) * LABEL_STAGGER_Y;
    idxs.forEach((idx, n) => {
      out[idx]!.y = anchors[idx]!.y - span / 2 + n * LABEL_STAGGER_Y;
    });
  }
  return out;
}
