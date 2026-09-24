// Knowledge (spec §1 "Knowledge"): the explorer rail's rows, groups, filters
// and footer line, and the record pane's crumbs, lifecycle, history and
// technical details — one Item (L0 run note / L1 pattern / L2 guide) at a time.
//
// Honest counting is the load-bearing rule here. GET /items filters level,
// repo, initiative and `q` on the server; type/kind and lifecycle are applied
// to the rows ALREADY LOADED (the endpoint has no param for them). So the
// footer never claims a filtered total it cannot know: "N of M loaded" only
// when the server sent `total`, and a client-side filter says it applies to
// the loaded rows.
//
// Pure: no React.

import { parsePgTimestamp } from '../../lib/pgTimestamp.ts';
import { ARTIFACT_STATUS_LABEL, ARTIFACT_TYPE_LABEL } from './distillationFormat.ts';
import { recordFileKind, type RecordFileKind } from './sourcesModel.ts';
import type { KnowledgeView } from './distillationRoutes.ts';
import type { Item } from './types.ts';

// ── Vocabulary ───────────────────────────────────────────────────────────

export const VIEW_LABEL: Record<KnowledgeView, string> = {
  guides: 'Guides & findings',
  patterns: 'Patterns',
  notes: 'Run notes',
};

/** Lower-case, for sentences: "11 guides & findings". */
export const VIEW_NOUN: Record<KnowledgeView, string> = {
  guides: 'guides & findings',
  patterns: 'patterns',
  notes: 'run notes',
};

const VIEW_SINGULAR: Record<KnowledgeView, string> = {
  guides: 'guide or finding',
  patterns: 'pattern',
  notes: 'run note',
};

export const VIEWS: readonly KnowledgeView[] = ['guides', 'patterns', 'notes'];

const OBS_KIND_LABEL: Record<string, string> = {
  worked: 'Worked', failed: 'Failed', gotcha: 'Gotcha', decision: 'Decision', convention: 'Convention',
};

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s;
}

export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return '';
  return OBS_KIND_LABEL[kind] ?? (ARTIFACT_TYPE_LABEL as Record<string, string>)[kind] ?? titleCase(kind);
}

/** "Runbook" · "Procedure" (L2) · "Pattern" (L1) · "Run note" (L0). */
export function itemTypeLabel(item: Item): string {
  if (item.level === 'L2') return ARTIFACT_TYPE_LABEL[item.type] ?? titleCase(item.type);
  return item.level === 'L1' ? 'Pattern' : 'Run note';
}

/** Lifecycle for a guide (Published / Draft / Retired); the observation kind
 *  for a pattern or note (Gotcha / Worked …) — the field a reader filters on. */
export function itemLifecycle(item: Item): string {
  if (item.level === 'L2') return ARTIFACT_STATUS_LABEL[item.status] ?? titleCase(item.status);
  return kindLabel(item.kind);
}

/** When the record last changed: `updated_at`, or a run note's `created_at`
 *  (notes are written once). */
export function itemUpdatedAt(item: Item): string {
  return item.level === 'L0' ? item.created_at : item.updated_at;
}

export function itemFileKind(item: Item): RecordFileKind {
  if (item.level === 'L2') return recordFileKind('artifact', item.type);
  return recordFileKind(item.level === 'L1' ? 'cluster' : 'observation');
}

export function itemRepo(item: Item): string | null {
  if (item.level === 'L2') return null; // guides span clusters; no single repo on the row
  return item.repo || null;
}

/** "org/repo-name" → "repo-name" — the header's short form. */
export function shortRepo(repo: string | null | undefined): string {
  if (!repo) return '';
  const i = repo.lastIndexOf('/');
  return i === -1 ? repo : repo.slice(i + 1);
}

// ── Time ─────────────────────────────────────────────────────────────────

/** Compact age for a list row: "now" · "12m" · "2h" · "3d" · "5w"; '' when
 *  unparseable. */
export function compactAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const then = parsePgTimestamp(iso);
  if (then === null) return '';
  const mins = Math.max(0, Math.floor((nowMs - then.getTime()) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ── Explorer rail ────────────────────────────────────────────────────────

export type RecencyGroup = 'recent' | 'week' | 'older';

export const RECENCY_GROUPS: ReadonlyArray<{ id: RecencyGroup; title: string }> = [
  { id: 'recent', title: 'Recently updated' },
  { id: 'week', title: 'Earlier this week' },
  { id: 'older', title: 'Older' },
];

const DAY_MS = 86_400_000;

export function recencyGroup(iso: string | null | undefined, nowMs: number): RecencyGroup {
  const then = iso ? parsePgTimestamp(iso) : null;
  if (then === null) return 'older';
  const age = nowMs - then.getTime();
  if (age <= DAY_MS) return 'recent';
  if (age <= 7 * DAY_MS) return 'week';
  return 'older';
}

export interface ExplorerRow {
  id: string;
  groupId: RecencyGroup;
  title: string;
  /** "Runbook · Published · 2h" */
  subline: string;
  fileKind: RecordFileKind;
  ariaLabel: string;
}

export interface LoadedFilters {
  /** Artifact type (guides) or observation kind (patterns / notes). */
  kind?: string | null;
  /** Artifact lifecycle; guides only. */
  lifecycle?: string | null;
}

/** The client-side half of the filters, applied to the loaded rows only. */
export function filterLoaded(items: Item[], f: LoadedFilters): Item[] {
  return items.filter((it) => {
    if (f.kind) {
      const k = it.level === 'L2' ? it.type : it.kind;
      if (k !== f.kind) return false;
    }
    if (f.lifecycle && it.level === 'L2' && it.status !== f.lifecycle) return false;
    return true;
  });
}

export function explorerRow(item: Item, nowMs: number): ExplorerRow {
  const type = itemTypeLabel(item);
  const life = itemLifecycle(item);
  const age = compactAge(itemUpdatedAt(item), nowMs);
  const subline = [type, life, age].filter(Boolean).join(' · ');
  return {
    id: item.id,
    groupId: recencyGroup(itemUpdatedAt(item), nowMs),
    title: item.title,
    subline,
    fileKind: itemFileKind(item),
    ariaLabel: `${item.title}, ${subline}`,
  };
}

/** Rows newest-first, so each recency group reads top-down by age. */
export function explorerRows(items: Item[], f: LoadedFilters, nowMs: number): ExplorerRow[] {
  return filterLoaded(items, f)
    .map((it) => ({ it, t: parsePgTimestamp(itemUpdatedAt(it))?.getTime() ?? 0 }))
    .sort((a, b) => b.t - a.t || a.it.id.localeCompare(b.it.id))
    .map(({ it }) => explorerRow(it, nowMs));
}

/** Group headers with their counts, only for groups that have rows. */
export function explorerGroups(rows: ExplorerRow[]): Array<{ id: RecencyGroup; title: string; count: number }> {
  return RECENCY_GROUPS
    .map((g) => ({ ...g, count: rows.filter((r) => r.groupId === g.id).length }))
    .filter((g) => g.count > 0);
}

/**
 * The rail footer. `loaded` is how many rows the server has sent; `shown` how
 * many survive the client-side filters; `total` the server's count for the
 * server-filtered query (null = not reported).
 *
 *   all loaded, no client filter   → "11 guides & findings"
 *   more pages, total known        → "50 of 304 loaded"
 *   more pages, total unknown      → "50 loaded"
 *   client filter active           → "3 shown · filter applies to 50 loaded"
 */
export function loadedLabel(view: KnowledgeView, loaded: number, shown: number, total: number | null, hasMore: boolean, clientFiltered: boolean): string {
  const noun = VIEW_NOUN[view];
  if (clientFiltered) return `${shown} shown · filter applies to ${loaded} loaded`;
  if (!hasMore) return `${loaded} ${loaded === 1 ? VIEW_SINGULAR[view] : noun}`;
  return total != null ? `${loaded} of ${total} loaded` : `${loaded} loaded`;
}

/** The search box names its scope, so it never implies a global search. */
export function searchPlaceholder(view: KnowledgeView): string {
  return `Search ${VIEW_NOUN[view]}`;
}

export function searchScopeNote(view: KnowledgeView, repo: string | null): string {
  return `Searches ${VIEW_NOUN[view]}${repo ? ` in ${shortRepo(repo)}` : ''} only`;
}

/** How many filter-popover facets are active (repo counts: the header owns
 *  it, but the popover shows it too). */
export function activeFacetCount(f: { initiative?: string | null; kind?: string | null; lifecycle?: string | null }): number {
  return [f.initiative, f.kind, f.lifecycle].filter(Boolean).length;
}

export const LIFECYCLE_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'retired', label: 'Retired' },
] as const;

// ── Record pane ──────────────────────────────────────────────────────────

/** "Guides & findings / Runbook" */
export function recordCrumbs(item: Item): string[] {
  const view: KnowledgeView = item.level === 'L2' ? 'guides' : item.level === 'L1' ? 'patterns' : 'notes';
  return [VIEW_LABEL[view], itemTypeLabel(item)];
}

export type StatusTone = 'success' | 'warning' | 'neutral' | 'info' | 'error';

/** The pill beside the title. A guide's lifecycle; a pattern/note's kind. */
export function recordStatus(item: Item): { label: string; tone: StatusTone } {
  if (item.level === 'L2') {
    const tone: StatusTone = item.status === 'published' ? 'success' : item.status === 'retired' ? 'warning' : 'neutral';
    return { label: ARTIFACT_STATUS_LABEL[item.status] ?? titleCase(item.status), tone };
  }
  const tone: StatusTone = item.kind === 'failed' ? 'error' : item.kind === 'gotcha' ? 'warning' : item.kind === 'worked' ? 'success' : 'info';
  return { label: kindLabel(item.kind), tone };
}

/** Strip a leading "## Steps" section from a procedure's markdown — the steps
 *  render once, from ProcedureSteps, with their run outcomes. Everything
 *  after the section (the "Why") stays. Headings of any depth ≤ 3 match. */
export function withoutStepsSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,3}\s+steps\b/i.test(l.trim()));
  if (start === -1) return markdown;
  const depth = (lines[start].match(/^#+/)?.[0].length) ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= depth) { end = i; break; }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
}

export interface HistoryEvent {
  id: string;
  kind: 'status' | 'run' | 'system' | 'comment';
  at: string;
  text: string;
  actor?: string | null;
}

/** What the record's own fields say happened to it — nothing inferred. */
export function recordHistory(item: Item): HistoryEvent[] {
  const ev: HistoryEvent[] = [];
  if (item.level === 'L0') {
    ev.push({ id: 'written', kind: 'system', at: item.created_at, text: `Written by session ${item.session_id}`, actor: item.box_id });
  } else {
    ev.push({
      id: 'created', kind: 'run', at: item.created_at,
      text: `Created by compaction ${item.created_by_compaction_id}`,
    });
    if (item.level === 'L2') {
      if (item.reviewed_at) ev.push({ id: 'reviewed', kind: 'comment', at: item.reviewed_at, text: 'Source sample reviewed', actor: item.reviewed_by });
      if (item.last_used_at) ev.push({ id: 'used', kind: 'run', at: item.last_used_at, text: 'Library asset last used' });
    }
    if (item.updated_at && item.updated_at !== item.created_at) {
      ev.push({ id: 'updated', kind: 'status', at: item.updated_at, text: item.level === 'L2' ? `Updated — now ${ARTIFACT_STATUS_LABEL[item.status].toLowerCase()}` : 'Updated by a later pass' });
    }
  }
  return ev.sort((a, b) => (parsePgTimestamp(b.at)?.getTime() ?? 0) - (parsePgTimestamp(a.at)?.getTime() ?? 0));
}

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** Ids, versions, timestamps, classification — what the Technical details
 *  disclosure lists, in the order a reader looks for them. */
export function technicalDetails(item: Item): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Id', value: item.id, mono: true },
    { label: 'Tier', value: item.level },
  ];
  if (item.level === 'L2') {
    rows.push(
      { label: 'Type', value: item.type },
      { label: 'Classification', value: item.classification },
      { label: 'Owner', value: item.owner },
      { label: 'Confidence', value: `${Math.round(item.confidence * 100)}%` },
      { label: 'Patterns', value: item.cluster_ids.join(', ') || '—', mono: true },
      { label: 'Facts', value: String(item.facts.length) },
      { label: 'Compaction', value: item.created_by_compaction_id, mono: true },
      { label: 'Library item', value: item.library_item_id ?? '—', mono: true },
      { label: 'Created', value: item.created_at, mono: true },
      { label: 'Updated', value: item.updated_at, mono: true },
    );
  } else if (item.level === 'L1') {
    rows.push(
      { label: 'Kind', value: item.kind },
      { label: 'Repository', value: item.repo, mono: true },
      { label: 'Initiative', value: item.initiative_id, mono: true },
      { label: 'Confidence', value: `${Math.round(item.confidence * 100)}%` },
      { label: 'Run notes', value: item.member_observation_ids.join(', ') || '—', mono: true },
      { label: 'Compaction', value: item.created_by_compaction_id, mono: true },
      { label: 'Created', value: item.created_at, mono: true },
      { label: 'Updated', value: item.updated_at, mono: true },
    );
  } else {
    rows.push(
      { label: 'Kind', value: item.kind },
      { label: 'Session', value: item.session_id, mono: true },
      { label: 'Box', value: item.box_id, mono: true },
      { label: 'Repository', value: item.repo, mono: true },
      { label: 'Initiative', value: item.initiative_id, mono: true },
      { label: 'Tags', value: item.tags.join(', ') || '—' },
      { label: 'Written', value: item.created_at, mono: true },
    );
  }
  return rows;
}

/** The composer's prepared question for the Ask page: the reader's words plus
 *  which record they are asking about. Explains only — nothing here writes. */
export function explainPrompt(question: string, subject: { kind: string; id: string; title: string }): string {
  const q = question.trim() || 'Explain this record and the evidence behind it.';
  return `${q}\n\nAbout the distillation ${subject.kind} "${subject.title}" (${subject.id}). Explain only; do not change anything.`;
}
