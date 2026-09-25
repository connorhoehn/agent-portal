// The work column's model: the initiative's work tree folded into the rows
// and groups the library's WorkListView draws. No React here, so the grouping,
// ordering and "which item is open" rules are unit-tested on their own.
//
// The list shows the dispatchable units — stories and bugs — each remembering
// its epic, which the detail column prints as its breadcrumb. Epics are
// containers, not work, so they appear only through their children.

import type { WorkListGroup, WorkListItem } from '@connorhoehnslalom/ui-components';
import type { BotRun } from '../bots/BotsPage';
import { filterWorkItems, flattenWorkItems, type FlatWorkItem } from './projectFormat.ts';
import type { WorkItemPriority, WorkItemStatus, WorkItemTree } from './types';

export const WORK_GROUPS: WorkListGroup[] = [
  { id: 'open', title: 'Next up', emptyLabel: 'Nothing up next' },
  // Collapsed by default (mockup W4): agents and people are already on these,
  // so the list opens on what can be picked up next.
  { id: 'in_progress', title: 'In progress', defaultOpen: false, emptyLabel: 'Nothing in progress' },
  { id: 'in_review', title: 'In review', emptyLabel: 'Nothing waiting for review' },
  { id: 'done', title: 'Done', defaultOpen: false, emptyLabel: 'Nothing done yet' },
];

/** Cancelled work is finished work that did not ship — it sits under Done
 *  with a chip rather than vanishing from the list. */
function groupOf(status: WorkItemStatus): string {
  return status === 'cancelled' ? 'done' : status;
}

export type WorkSort = 'priority' | 'points' | 'updated' | 'title';

export const WORK_SORT_OPTIONS: Array<{ value: WorkSort; label: string }> = [
  { value: 'priority', label: 'By priority' },
  { value: 'points', label: 'By points' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'title', label: 'By title' },
];

const PRIORITY_RANK: Record<WorkItemPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function compare(sort: WorkSort) {
  return (a: FlatWorkItem, b: FlatWorkItem): number => {
    switch (sort) {
      case 'points': return (b.storyPoints ?? -1) - (a.storyPoints ?? -1) || a.title.localeCompare(b.title);
      case 'updated': return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.title.localeCompare(b.title);
      case 'title': return a.title.localeCompare(b.title);
      default: return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.title.localeCompare(b.title);
    }
  };
}

/** The list's filter facets — each a set of chosen values; an empty set
 *  means no narrowing on that facet. The owner value `none` is unassigned. */
export interface WorkFilterState {
  types: readonly string[];
  owners: readonly string[];
  priorities: readonly string[];
}

export const NO_FILTERS: WorkFilterState = { types: [], owners: [], priorities: [] };

/** How many facets are narrowing — the badge on the filter button. */
export function activeFilterCount(f: WorkFilterState): number {
  return [f.types, f.owners, f.priorities].filter((v) => v.length > 0).length;
}

/** Every story and bug under the initiative, sorted, then narrowed by the
 *  search and the filter facets. */
export function workRows(tree: WorkItemTree[], sort: WorkSort, query: string, filters: WorkFilterState = NO_FILTERS): FlatWorkItem[] {
  const owns = (r: FlatWorkItem) => filters.owners.includes(r.assigneeId ?? 'none');
  return filterWorkItems(flattenWorkItems(tree), { q: query })
    .filter((r) => filters.types.length === 0 || filters.types.includes(r.type))
    .filter((r) => filters.owners.length === 0 || owns(r))
    .filter((r) => filters.priorities.length === 0 || filters.priorities.includes(r.priority))
    .sort(compare(sort));
}

/** The owner facet's options: everyone who owns a row, then "Unassigned" when any row has nobody. */
export function ownerOptions(rows: FlatWorkItem[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  let unassigned = false;
  for (const r of rows) {
    if (r.assigneeId && r.assigneeName) seen.set(r.assigneeId, r.assigneeName);
    else unassigned = true;
  }
  const people = [...seen].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  return unassigned ? [...people, { value: 'none', label: 'Unassigned' }] : people;
}

/** Blocked is a label, not a status — the same rule the server's work
 *  suggestions use (middleware lib/work-suggestions.ts). */
export function isBlocked(item: Pick<FlatWorkItem, 'labels'>): boolean {
  return item.labels.includes('blocked');
}

const KIND_LABEL: Record<FlatWorkItem['type'], string> = { epic: 'Epic', story: 'Story', bug: 'Bug' };

/** "Bug", "Story" — the first part of a text meta line ("Bug · Eli Garcia · 2 points"). */
export function kindLabel(item: Pick<FlatWorkItem, 'type'>): string {
  return KIND_LABEL[item.type];
}

/** A right-hand row tag, e.g. the red "Blocked". */
export interface WorkListTag {
  label: string;
  tone: 'danger' | 'warning' | 'neutral';
}

/**
 * The row the list draws, plus the fields the text-meta layout reads
 * (library L4: `WorkListItem.kindLabel` and `.tag`). Declared here rather
 * than on the library type so the page compiles against the installed pin;
 * once L4 ships the extra fields are simply the library's own.
 */
export interface InitiativeWorkListItem extends WorkListItem {
  kindLabel?: string;
  tag?: WorkListTag | null;
  blocked?: boolean;
}

export interface WorkListItemOptions {
  /**
   * `chips` (default) keeps the type as a chip, as the list draws today.
   * `text` is the mockup's layout: the type moves into the meta line via
   * `kindLabel`, so the Bug chip would say it twice and is dropped.
   */
  metaStyle?: 'chips' | 'text';
}

/** One list row. The run is this item's latest marketplace run, if any. */
export function toWorkListItem(
  item: FlatWorkItem,
  run: BotRun | undefined,
  pending: boolean,
  opts: WorkListItemOptions = {},
): InitiativeWorkListItem {
  const chips: WorkListItem['chips'] = [];
  if (item.type === 'bug' && opts.metaStyle !== 'text') chips.push({ label: 'Bug', tone: 'danger' });
  if (item.priority === 'critical') chips.push({ label: 'Critical', tone: 'danger' });
  if (item.status === 'cancelled') chips.push({ label: 'Cancelled', tone: 'neutral' });

  let signal: WorkListItem['signal'] = null;
  if (run?.status === 'running') signal = { state: 'running', label: 'Agent running' };
  else if (item.status === 'in_review') signal = { state: 'review', label: 'Awaiting review' };

  return {
    id: item.id,
    groupId: groupOf(item.status),
    title: item.title,
    done: item.status === 'done',
    donePending: pending,
    points: item.storyPoints,
    owner: item.assigneeId && item.assigneeName ? { id: item.assigneeId, name: item.assigneeName } : null,
    chips,
    signal,
    // A story is the default kind of work, so its row names only the owner
    // and points ("Layla Hassan · 5 points"); a bug or an epic says what it is
    // ("Bug · Eli Garcia · 2 points") — the same rule the chip layout followed.
    kindLabel: item.type === 'story' ? undefined : kindLabel(item),
    tag: isBlocked(item) && item.status !== 'done' && item.status !== 'cancelled'
      ? { label: 'Blocked', tone: 'danger' }
      : null,
    blocked: isBlocked(item),
  };
}

/**
 * Which item the detail column shows. The URL's choice wins while it still
 * names a row; otherwise the first item up next, then the first row at all —
 * so a stale `?item=` lands on real work instead of an empty column.
 */
export function pickCurrent(rows: FlatWorkItem[], wanted: string | null): FlatWorkItem | null {
  if (wanted) {
    const hit = rows.find((r) => r.id === wanted);
    if (hit) return hit;
  }
  return rows.find((r) => r.status === 'open') ?? rows[0] ?? null;
}
