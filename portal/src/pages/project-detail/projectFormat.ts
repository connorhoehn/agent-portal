// Pure derivations and tone lookups for the initiative detail page.
//
// Nothing here renders. Everything that used to be an arrow function inside a
// JSX tree — the point rollups, the swimlane bucketing, the "which run speaks
// for this item" tiebreak — lives here so it can be read and tested on its own.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp.ts';
import type { BotRun } from '../bots/BotsPage';
import type {
  MyScopedSprint,
  PrStatus,
  WorkItemPriority,
  WorkItemStatus,
  WorkItemTree,
  WorkItemType,
} from './types';

// ─── Tone lookups ─────────────────────────────────────────────────────────────
// Chip carries the colour, StatusDot the leading dot. Every colour is a theme
// token: the page used to carry raw hexes for "in review" purple and the story
// glyph, which is exactly the drift a token family exists to stop.

export const STATUS_TONE: Record<WorkItemStatus, ChipTone> = {
  open:        'neutral',
  in_progress: 'info',
  in_review:   'purple',
  done:        'success',
  cancelled:   'danger',
};

export const STATUS_DOT_COLOR: Record<WorkItemStatus, string> = {
  open:        'var(--color-text-tertiary)',
  in_progress: 'var(--color-info)',
  in_review:   'var(--color-optimize)',
  done:        'var(--color-success)',
  cancelled:   'var(--color-danger)',
};

/** Priority as a text-colour utility — the left rail of a board card and the
 *  glyph on an epic header read the same scale. */
export const PRIORITY_TEXT_CLASS: Record<WorkItemPriority, string> = {
  critical: 'text-danger',
  high:     'text-warning',
  medium:   'text-warning',
  low:      'text-text-tertiary',
};

/** The same scale as a border colour, for the board card's left edge. */
export const PRIORITY_BORDER_CLASS: Record<WorkItemPriority, string> = {
  critical: 'border-l-danger',
  high:     'border-l-warning',
  medium:   'border-l-warning',
  low:      'border-l-text-tertiary',
};

export const PRIORITY_GLYPH: Record<WorkItemPriority, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '⚪',
};

export const PR_TONE: Record<PrStatus, ChipTone> = {
  merged: 'purple',
  open:   'success',
  draft:  'neutral',
  closed: 'danger',
};

export const PR_ICONS: Record<PrStatus, string> = {
  merged: '⬡',
  open:   '⊙',
  draft:  '⊘',
  closed: '✕',
};

export const DECISION_TONE: Record<string, ChipTone> = {
  escalated: 'danger',
  open:      'warning',
  resolved:  'success',
  rejected:  'neutral',
};

export const PROJECT_STATUS_TONE: Record<string, ChipTone> = {
  active:   'success',
  planning: 'info',
  archived: 'neutral',
};

export const BOARD_STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'in_review', 'done'];

export const BOARD_STATUS_LABELS: Record<WorkItemStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Progress bars go warning → primary → success as the work lands. Returned as
 *  a CSS variable because ProgressBar takes a colour, not a class. */
export function progressColor(pct: number): string {
  if (pct >= 80) return 'var(--color-success)';
  if (pct >= 40) return 'var(--color-primary)';
  return 'var(--color-warning)';
}

// ─── Tree arithmetic ──────────────────────────────────────────────────────────

/** Story points under a node — only stories and bugs are sized. */
export function countPoints(item: WorkItemTree): { done: number; total: number } {
  let done = 0, total = 0;
  function walk(node: WorkItemTree) {
    if ((node.type === 'story' || node.type === 'bug') && node.storyPoints) {
      total += node.storyPoints;
      if (node.status === 'done') done += node.storyPoints;
    }
    for (const c of node.children) walk(c);
  }
  walk(item);
  return { done, total };
}

/** Story count under a node. Bugs deliberately don't count — the epic header
 *  reports "n/m stories", and folding bugs in would make that label a lie. */
export function countStories(item: WorkItemTree): { done: number; total: number } {
  let done = 0, total = 0;
  function walk(node: WorkItemTree) {
    if (node.type === 'story') {
      total++;
      if (node.status === 'done') done++;
    }
    for (const c of node.children) walk(c);
  }
  walk(item);
  return { done, total };
}

/** Points across a whole forest — the header's overall rollup. */
export function sumForestPoints(nodes: WorkItemTree[]): { done: number; total: number; pct: number } {
  let done = 0, total = 0;
  for (const n of nodes) {
    const sub = countPoints(n);
    done += sub.done;
    total += sub.total;
  }
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export function flattenByType(nodes: WorkItemTree[], types: WorkItemType[]): WorkItemTree[] {
  const acc: WorkItemTree[] = [];
  function walk(node: WorkItemTree) {
    if (types.includes(node.type)) acc.push(node);
    node.children.forEach(walk);
  }
  nodes.forEach(walk);
  return acc;
}

// ─── Run selection ────────────────────────────────────────────────────────────

/**
 * Aurora hands a `timestamptz` over as `2026-09-08 08:19:23+00`: a space where
 * ISO 8601 wants a `T`, and a bare-hour offset the standard does not allow. The
 * old fix here appended `Z` to anything without a `T`, which turned a stamp
 * that already carried `+00` into `…+00Z` — invalid twice over, and silent,
 * because every caller falls back to the raw string. `parsePgTimestampAsUtc`
 * pads the offset first and only assumes UTC when no zone is named at all.
 */
export function parseTs(iso: string): number {
  return parsePgTimestampAsUtc(iso)?.getTime() ?? Number.NaN;
}

/** The run that speaks for each work item: a running one wins, else the newest. */
export function runsByWorkItem(runs: BotRun[]): Record<string, BotRun> {
  const out: Record<string, BotRun> = {};
  for (const r of runs) {
    if (!r.workItemId) continue;
    const prev = out[r.workItemId];
    if (!prev) { out[r.workItemId] = r; continue; }
    if (prev.status === 'running' && r.status !== 'running') continue;
    if (r.status === 'running' && prev.status !== 'running') { out[r.workItemId] = r; continue; }
    if (parseTs(r.startedAt) > parseTs(prev.startedAt)) out[r.workItemId] = r;
  }
  return out;
}

// ─── Grant cue ────────────────────────────────────────────────────────────────

/** True iff at least one of the SME's `scope=mine` sprints is an active grant
 *  on this initiative. Pure and exported so the pre-dispatch grant cue (audit
 *  finding M2 follow-up) can be unit tested without the fetch plumbing —
 *  grant-scoped dispatch 403s an sme with no active grant here, and this only
 *  tells the caller whether to warn *before* that happens. */
export function hasActiveGrantOnInitiative(
  sprints: MyScopedSprint[],
  initiativeId: string,
): boolean {
  return sprints.some((s) => s.isGrantee && s.status === 'active' && s.orgProjectId === initiativeId);
}

// ─── One board, one table ────────────────────────────────────────────────────
//
// The work column used to render a card per epic, and the board rendered a
// separate four-lane swimlane per epic stacked vertically. Both are the same
// mistake: an initiative has ONE backlog, and an epic is a way of FILTERING it,
// not a reason to draw another board. Ten epics gave you ten boards to scroll
// past instead of one board you could actually read.
//
// So everything below flattens to a single list of dispatchable items (stories
// and bugs — epics are containers, never work), carrying enough of their epic
// with them to be filtered and grouped by it.

/** A dispatchable item that remembers which epic it came from. */
export interface FlatWorkItem extends WorkItemTree {
  epicId: string;
  epicTitle: string;
}

export function flattenWorkItems(epics: WorkItemTree[]): FlatWorkItem[] {
  const out: FlatWorkItem[] = [];
  for (const epic of epics) {
    const walk = (nodes: WorkItemTree[]): void => {
      for (const n of nodes) {
        if (n.type !== 'epic') out.push({ ...n, epicId: epic.id, epicTitle: epic.title });
        if (n.children?.length) walk(n.children);
      }
    };
    walk(epic.children ?? []);
  }
  return out;
}

export interface WorkFilters {
  epicId?: string;
  status?: string;
  type?: string;
  assigneeId?: string;
  q?: string;
}

/**
 * Filter the flat backlog. Every facet is `all`-tolerant so the caller can
 * pass its raw control state, and the search covers the fields somebody
 * actually types — title, labels, assignee, epic — rather than only the title.
 */
export function filterWorkItems(items: FlatWorkItem[], f: WorkFilters): FlatWorkItem[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return items.filter((i) => {
    if (f.epicId && f.epicId !== 'all' && i.epicId !== f.epicId) return false;
    if (f.status && f.status !== 'all' && i.status !== f.status) return false;
    if (f.type && f.type !== 'all' && i.type !== f.type) return false;
    if (f.assigneeId && f.assigneeId !== 'all' && (i.assigneeId ?? '') !== f.assigneeId) return false;
    if (!q) return true;
    return [i.title, i.epicTitle, i.assigneeName ?? '', ...(i.labels ?? [])]
      .join(' ').toLowerCase().includes(q);
  });
}

/**
 * One board for the whole (filtered) backlog, not one per epic.
 *
 * An item in a status the board doesn't draw a lane for (cancelled) falls back
 * to Open rather than vanishing off the board entirely.
 */
export function bucketItemsByStatus(items: FlatWorkItem[]): Map<WorkItemStatus, FlatWorkItem[]> {
  const byStatus = new Map<WorkItemStatus, FlatWorkItem[]>();
  BOARD_STATUSES.forEach((s) => byStatus.set(s, []));
  for (const item of items) {
    (byStatus.get(item.status) ?? byStatus.get('open')!).push(item);
  }
  return byStatus;
}

export interface FacetOption { value: string; label: string; count: number }

export function epicFacets(epics: WorkItemTree[], items: FlatWorkItem[]): FacetOption[] {
  return epics.map((e) => ({
    value: e.id,
    label: e.title,
    count: items.filter((i) => i.epicId === e.id).length,
  }));
}

/** Only people who actually hold work here — an assignee filter listing the
 *  whole org is a filter nobody can use. */
export function assigneeFacets(items: FlatWorkItem[]): FacetOption[] {
  const by = new Map<string, FacetOption>();
  for (const i of items) {
    if (!i.assigneeId) continue;
    const found = by.get(i.assigneeId);
    if (found) found.count += 1;
    else by.set(i.assigneeId, { value: i.assigneeId, label: i.assigneeName ?? i.assigneeId, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

// ─── Initiative age ───────────────────────────────────────────────────────────
//
// "Running since" is one of the two questions people ask of an initiative that
// the rollup never answered (the other is how many repos it spans). Both come
// from data the page already holds, so neither needs inventing.

/** Whole days between `iso` and `now`, or null when the date is unusable. */
export function daysRunning(iso: string | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const started = parseTs(iso);
  if (Number.isNaN(started)) return null;
  // A start date in the future is bad data, not a negative age.
  return Math.max(0, Math.floor((now - started) / 86_400_000));
}

/**
 * The age as a person would say it. Days up to a month, then months, then
 * years — an initiative running for 14 months is "1y 2m", never "428 days",
 * which is precision nobody asked for and nobody can picture.
 */
export function runningLabel(days: number | null): string {
  if (days == null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 31) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years}y` : `${years}y ${rem}m`;
}

// ─── Activity over time ──────────────────────────────────────────────────────
//
// Computed from what the page already holds — the initiative's bot runs and
// its work tree — rather than from a dedicated endpoint. The numbers a graph
// draws should be the same numbers the rest of the page is showing, and the
// surest way to guarantee that is to derive them from the same objects.

export interface ActivityBuckets {
  /** Day labels, oldest first, YYYY-MM-DD. */
  labels: string[];
  runs: number[];
  spendUsd: number[];
  completed: number[];
  totals: { runs: number; spendUsd: number; completed: number };
}

/** UTC day key for a timestamp, tolerating Aurora's "YYYY-MM-DD HH:MM:SS". */
function dayKey(iso: string | null): string | null {
  const d = parsePgTimestampAsUtc(iso);
  return d === null ? null : d.toISOString().slice(0, 10);
}

/**
 * Bucket runs and completed work into one entry PER DAY, oldest first.
 *
 * Every day in the window gets an entry, including the quiet ones. A sparkline
 * reads its array positionally, so omitting empty days would compress the gaps
 * and draw a busier, smoother initiative than the real one.
 */
export function activityBuckets(
  runs: Array<{ startedAt: string; costUsd: number | null }>,
  items: Array<{ completedAt: string | null }>,
  days = 30,
  now: number = Date.now(),
): ActivityBuckets {
  const span = Math.max(1, Math.min(180, Math.floor(days)));
  const labels: string[] = [];
  const index = new Map<string, number>();
  // Anchor on today's UTC midnight so the last bucket is today, not "now
  // minus 30 x 24h", which would slide the whole window by the time of day.
  const end = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  for (let i = span - 1; i >= 0; i -= 1) {
    const key = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    index.set(key, labels.length);
    labels.push(key);
  }

  const runCounts = new Array<number>(span).fill(0);
  const spend = new Array<number>(span).fill(0);
  const completed = new Array<number>(span).fill(0);

  for (const r of runs) {
    const i = index.get(dayKey(r.startedAt) ?? '');
    if (i == null) continue;            // outside the window
    runCounts[i] += 1;
    spend[i] += r.costUsd ?? 0;
  }
  for (const it of items) {
    const i = index.get(dayKey(it.completedAt) ?? '');
    if (i == null) continue;
    completed[i] += 1;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    labels,
    runs: runCounts,
    spendUsd: spend.map(round2),
    completed,
    totals: {
      runs: runCounts.reduce((a, b) => a + b, 0),
      spendUsd: round2(spend.reduce((a, b) => a + b, 0)),
      completed: completed.reduce((a, b) => a + b, 0),
    },
  };
}
