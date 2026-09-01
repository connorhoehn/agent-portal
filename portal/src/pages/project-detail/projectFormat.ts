// Pure derivations and tone lookups for the initiative detail page.
//
// Nothing here renders. Everything that used to be an arrow function inside a
// JSX tree — the point rollups, the swimlane bucketing, the "which run speaks
// for this item" tiebreak — lives here so it can be read and tested on its own.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
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

/** Bucket an epic's stories and bugs into the four board lanes. An item in a
 *  lane the board doesn't show (cancelled) falls back to Open rather than
 *  vanishing off the swimlane entirely. */
export function bucketByStatus(epic: WorkItemTree): Map<WorkItemStatus, WorkItemTree[]> {
  const byStatus = new Map<WorkItemStatus, WorkItemTree[]>();
  BOARD_STATUSES.forEach((s) => byStatus.set(s, []));
  for (const item of flattenByType([epic], ['story', 'bug'])) {
    (byStatus.get(item.status) ?? byStatus.get('open')!).push(item);
  }
  return byStatus;
}

// ─── Run selection ────────────────────────────────────────────────────────────

/** Aurora timestamps arrive without T/Z — same normalization as the bots pages. */
export function parseTs(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
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
