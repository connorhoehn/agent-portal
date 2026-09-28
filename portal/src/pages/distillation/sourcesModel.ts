// Sources and lineage graphs (spec §1 "Sources inspector", "Tier graph").
//
// Three graph models share one node/edge shape — the one the library's
// `TypedNodeCanvas` takes (`nodes {id, kind, data, rank}`, `edges {id, from,
// to, label?, tone?, animated?, marker?}`) — so phase 2 hands them straight to
// the canvas, and every graph has a list equivalent built from the same model:
//   - `sourcesGraph`   an item and its direct evidence (GET /items/:id/sources)
//   - `lineageGraph`   the deeper lineage (GET /items/:id/lineage) when shown
//   - `tierGraph`      L0 → L1 → L2 → Library with job markers on the edges
//
// Pure: no React.

import { knowledgeItemHref } from './distillationRoutes.ts';
import type { TierFlowItem, TierFlowModel } from './tierFlowModel.ts';
import type {
  CompactionRun, ItemSource, ItemSourcesResponse, Level, Lineage, LineageNodeKind, LineageRelation,
} from './types.ts';

// ── Shared graph shape ───────────────────────────────────────────────────

export type GraphNodeKind =
  | 'session' | 'observation' | 'cluster' | 'artifact' | 'fact' | 'library_item' | 'application'
  | 'tier' | 'library' | 'unknown';

export type GraphTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface GraphNode<D = Record<string, unknown>> {
  id: string;
  kind: GraphNodeKind;
  /** Column in a left-to-right layout: evidence left, outcome right. */
  rank: number;
  data: D & { title: string; subtitle?: string; href?: string | null; current?: boolean };
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  tone?: GraphTone;
  /** Only ever true for a job the server confirms is running. */
  animated?: boolean;
  /** A job marker sitting on the edge — clicking it selects that job. */
  marker?: { id: string; label: string; tone?: GraphTone };
}

export interface GraphModel<D = Record<string, unknown>> {
  nodes: GraphNode<D>[];
  edges: GraphEdge[];
}

/** One line of a graph's list equivalent: "Run note A — merged into → Pattern B". */
export interface GraphListRow {
  id: string;
  from: string;
  relation: string;
  to: string;
  fromHref: string | null;
  toHref: string | null;
}

const RANK: Record<GraphNodeKind, number> = {
  session: 0, observation: 1, cluster: 2, artifact: 3, fact: 3, application: 4, library_item: 4,
  tier: 0, library: 3, unknown: 1,
};

const KIND_LABEL: Record<string, string> = {
  session: 'Session', observation: 'Run note', cluster: 'Pattern', artifact: 'Guide',
  fact: 'Fact', application: 'Run', library_item: 'Agent library asset',
};

export function sourceKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
}

function asKind(kind: string): GraphNodeKind {
  return kind in RANK ? (kind as GraphNodeKind) : 'unknown';
}

/** The tier a source kind lives in, for linking into Knowledge. */
const KIND_LEVEL: Record<string, Level> = { observation: 'L0', cluster: 'L1', artifact: 'L2' };

/** Where following a source goes: that record in Knowledge. A session is not
 *  a Knowledge record — its notes are, and GET /items has no session filter
 *  (`q` does not match a session id) — so a session source has no link; the
 *  run note's own record lists the other notes from the same run. */
export function sourceHref(s: Pick<ItemSource, 'id' | 'kind'>): string | null {
  const level = KIND_LEVEL[s.kind];
  if (level) return knowledgeItemHref(s.id, level);
  return null;
}

/** The tier a source kind lives in, or null (sessions, facts, …). */
export function sourceLevel(kind: string): Level | null {
  return KIND_LEVEL[kind] ?? null;
}

/** The library's `FileKind` glyph for a record kind: a guide is a page, a
 *  procedure a workflow, a pattern a diagram of notes, a run note a
 *  transcript of what happened, a session the conversation it came from. */
export type RecordFileKind = 'page' | 'workflow' | 'diagram' | 'transcript' | 'conversation' | 'folder';

export function recordFileKind(kind: string, artifactType?: string | null): RecordFileKind {
  if (kind === 'artifact') return artifactType === 'procedure' ? 'workflow' : 'page';
  if (kind === 'cluster') return 'diagram';
  if (kind === 'observation') return 'transcript';
  if (kind === 'session') return 'conversation';
  if (kind === 'library_item' || kind === 'library') return 'folder';
  return 'page';
}

// ── Sources list ─────────────────────────────────────────────────────────

export interface SourceRow {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  timestamp: string | null;
  excerpt: string | null;
  repo: string | null;
  sessionId: string | null;
  href: string | null;
}

export function sourceRows(res: ItemSourcesResponse | null | undefined): SourceRow[] {
  return (res?.sources ?? []).map((s) => ({
    id: s.id,
    kind: s.kind,
    kindLabel: sourceKindLabel(s.kind),
    // Never a bare empty title: fall back to "<Kind> <id>".
    title: s.title?.trim() || `${sourceKindLabel(s.kind)} ${s.id}`,
    timestamp: s.timestamp ?? null,
    excerpt: s.excerpt ?? null,
    repo: s.repo ?? null,
    sessionId: s.session_id ?? null,
    href: sourceHref(s),
  }));
}

// ── Item + direct evidence graph ─────────────────────────────────────────

const EVIDENCE_RELATION: Record<string, string> = {
  session: 'wrote',
  observation: 'evidence for',
  cluster: 'distilled into',
  artifact: 'related to',
};

export interface GraphSubject {
  id: string;
  kind: 'observation' | 'cluster' | 'artifact' | string;
  title: string;
}

/**
 * The item and its direct evidence. For a guide that is its patterns and
 * notes; where a note's session or a pattern relation is not on the wire, the
 * graph does not invent the edge — every edge runs source → item.
 */
export function sourcesGraph(subject: GraphSubject, res: ItemSourcesResponse | null | undefined): GraphModel {
  const rows = sourceRows(res);
  const nodes: GraphNode[] = [{
    id: subject.id,
    kind: asKind(subject.kind),
    rank: RANK[asKind(subject.kind)],
    data: { title: subject.title, subtitle: sourceKindLabel(subject.kind), current: true, href: null },
  }];
  const edges: GraphEdge[] = [];
  const seen = new Set([subject.id]);
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const kind = asKind(r.kind);
    // Evidence always sits left of what it supports, whatever its kind.
    const rank = Math.min(RANK[kind], nodes[0].rank - 1);
    nodes.push({ id: r.id, kind, rank, data: { title: r.title, subtitle: r.kindLabel, href: r.href } });
    edges.push({ id: `${r.id}->${subject.id}`, from: r.id, to: subject.id, label: EVIDENCE_RELATION[r.kind] ?? 'source of' });
  }
  return { nodes, edges };
}

// ── Full lineage graph (GET /items/:id/lineage) ──────────────────────────

const RELATION_LABEL: Record<LineageRelation, string> = {
  written_by: 'written by',
  merged_into: 'merged into',
  distilled_into: 'distilled into',
  supports: 'supports',
  published_as: 'published as',
  applied_in: 'applied in',
};

const LINEAGE_KIND_LEVEL: Partial<Record<LineageNodeKind, Level>> = { observation: 'L0', cluster: 'L1', artifact: 'L2' };

export function lineageGraph(lineage: Lineage | null | undefined, focusId: string | null = null): GraphModel {
  if (!lineage) return { nodes: [], edges: [] };
  const nodes: GraphNode[] = lineage.nodes.map((n) => {
    const level = LINEAGE_KIND_LEVEL[n.kind];
    const href = level
      ? knowledgeItemHref(n.id, level)
      : n.kind === 'library_item' ? `/iq/library/${encodeURIComponent(n.id)}` : null;
    return {
      id: n.id,
      kind: asKind(n.kind),
      rank: RANK[asKind(n.kind)],
      data: { title: n.label, subtitle: sourceKindLabel(n.kind), href, current: n.id === focusId },
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = lineage.edges
    // `written_by` points observation → session; draw it session → note so
    // every edge reads left-to-right.
    .map((e) => (e.relation === 'written_by'
      ? { id: `${e.to}->${e.from}`, from: e.to, to: e.from, label: 'wrote' }
      : { id: `${e.from}->${e.to}`, from: e.from, to: e.to, label: RELATION_LABEL[e.relation] ?? e.relation }))
    .filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

// ── Tier graph (Activity → Tier graph) ───────────────────────────────────

export interface TierNodeData {
  level: Level | null;
  value: number | null;
  status?: TierFlowItem['status'];
}

/** The edge a compaction run belongs to: L1 = L0→L1, L2 = L1→L2. */
function edgeIdFor(level: Level): string | null {
  if (level === 'L1') return 'L0->L1';
  if (level === 'L2') return 'L1->L2';
  return null;
}

/**
 * Three storage tiers + Library, edges Compact / Compact / Publish, and at
 * most one job marker per edge: the running job if the server says one is
 * running (the only case the edge animates), else the newest queued job.
 */
export function tierGraph(flow: TierFlowModel, jobs: CompactionRun[] = []): GraphModel<TierNodeData> {
  const nodes: GraphNode<TierNodeData>[] = flow.items.map((it, i) => ({
    id: it.id,
    kind: it.id === 'library' ? 'library' : 'tier',
    rank: i,
    data: { title: it.label, subtitle: it.level ?? undefined, href: it.href, level: it.level, value: it.value, status: it.status },
  }));
  const pairs: Array<[string, string]> = [['L0', 'L1'], ['L1', 'L2'], ['L2', 'library']];
  const edges: GraphEdge[] = pairs.map(([from, to], i) => ({
    id: `${from}->${to}`,
    from,
    to,
    label: flow.connectors[i]?.label,
    tone: flow.connectors[i]?.tone,
  }));
  for (const edge of edges) {
    const onEdge = jobs.filter((j) => edgeIdFor(j.level) === edge.id);
    const running = onEdge.find((j) => j.status === 'running');
    const queued = onEdge.find((j) => j.status === 'queued');
    const job = running ?? queued;
    if (!job) continue;
    edge.animated = job.status === 'running';
    edge.marker = {
      id: job.id,
      label: job.status === 'running'
        ? (typeof job.percent === 'number' ? `Running ${Math.round(job.percent)}%` : 'Running')
        : 'Queued',
      tone: job.status === 'running' ? 'info' : 'neutral',
    };
  }
  return { nodes, edges };
}

// ── List equivalent ──────────────────────────────────────────────────────

export function graphListRows<D>(graph: GraphModel<D>): GraphListRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .map((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) return null;
      return {
        id: e.id,
        from: from.data.title,
        relation: e.marker ? `${e.label ?? ''} (${e.marker.label})`.trim() : (e.label ?? ''),
        to: to.data.title,
        fromHref: from.data.href ?? null,
        toHref: to.data.href ?? null,
      };
    })
    .filter((r): r is GraphListRow => r !== null)
    .sort((a, b) => {
      const ra = byId.get(graph.edges.find((e) => e.id === a.id)!.from)!.rank;
      const rb = byId.get(graph.edges.find((e) => e.id === b.id)!.from)!.rank;
      return ra - rb || a.from.localeCompare(b.from);
    });
}
