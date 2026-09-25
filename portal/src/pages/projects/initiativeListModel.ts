// The Initiatives explorer rail's model (F3–F10, v2 R5–R7): status groups of
// title-only rows, the header count and the footer. No React; unit-tested
// alone. v2 dropped the "Owner · N agents" subline (V6): running agents stay
// visible in the Overview's stats line and the Everyone table.
//
// Honest numbers: every count is the length of rows we hold. The list read is
// a capped page (`limit`), so when it came back full the count reads "N+" —
// we do not know how many more there are. A failed read is the `error` state,
// never the empty or no-match copy.

import { compareProjects, filterByStatus, matchesQuery, normalizeStatus, type ProjectSortKey } from './projectFormat.ts';
import type { ProjectSummary } from './types';

export interface InitiativeGroupSpec {
  id: string;
  title: string;
  /** Status keys (normalised) that land in this group. */
  statuses: readonly string[];
  defaultOpen: boolean;
}

/** In progress first and open; the rest collapsed. `active` is in flight
 *  too, so it reads as in progress rather than getting a group of its own. */
export const INITIATIVE_GROUPS: readonly InitiativeGroupSpec[] = [
  { id: 'in_progress', title: 'In progress', statuses: ['in_progress', 'active'], defaultOpen: true },
  { id: 'planning', title: 'Planning', statuses: ['planning'], defaultOpen: false },
  { id: 'paused', title: 'Paused', statuses: ['paused'], defaultOpen: false },
  { id: 'completed', title: 'Completed', statuses: ['completed'], defaultOpen: false },
  { id: 'archived', title: 'Archived', statuses: ['archived'], defaultOpen: false },
];

const OTHER: InitiativeGroupSpec = { id: 'other', title: 'Other', statuses: [], defaultOpen: false };

export function groupIdOf(status: string | null | undefined): string {
  const s = normalizeStatus(status);
  return INITIATIVE_GROUPS.find((g) => g.statuses.includes(s))?.id ?? OTHER.id;
}

/** "14", or "100+" when the capped page came back full. */
export function countLabel(n: number, capped: boolean): string {
  return capped ? `${n}+` : String(n);
}

export interface InitiativeListRow {
  id: string;
  groupId: string;
  title: string;
  href: string;
}

export interface InitiativeListGroup {
  id: string;
  title: string;
  /** Rows in this group after search and filter — the group header's count. */
  count: number;
  /** Open by default, and always open when it holds the selected row. */
  defaultOpen: boolean;
  rows: InitiativeListRow[];
}

export interface InitiativeListInput {
  /** The list read: rows once loaded; null/undefined while loading. */
  rows: ProjectSummary[] | null | undefined;
  error?: string | null;
  scope: 'all' | 'mine';
  /** The `limit` the list was fetched with; a full page means "there may be more". */
  limit?: number;
  query?: string;
  statusFilter?: string;
  sort?: ProjectSortKey;
  /** The initiative the route has open. */
  currentId?: string | null;
}

export type InitiativeListModel =
  | { state: 'loading'; title: 'Initiatives'; count: null; footer: null }
  | { state: 'error'; title: 'Initiatives'; count: null; footer: null; error: string }
  | {
      /** `empty`: the read returned nothing. `no-match`: search/filter hid every row. */
      state: 'empty' | 'no-match' | 'ready';
      title: 'Initiatives';
      /** Header count over everything read ("14", "100+"). */
      count: string;
      groups: InitiativeListGroup[];
      /** "14 initiatives", "3 of 14 initiatives", or "Personal view" on an empty Mine. */
      footer: string;
      /** Rows shown after search and filter. */
      shown: number;
    };

export function buildInitiativeList(input: InitiativeListInput): InitiativeListModel {
  if (input.error) return { state: 'error', title: 'Initiatives', count: null, footer: null, error: input.error };
  if (input.rows == null) return { state: 'loading', title: 'Initiatives', count: null, footer: null };

  const all = input.rows;
  const capped = input.limit != null && all.length >= input.limit;
  const total = countLabel(all.length, capped);
  const sort = input.sort ?? 'activity';

  const visible = filterByStatus(all, input.statusFilter ?? 'all')
    .filter((p) => matchesQuery(p, input.query ?? ''))
    // Name as the final tie-break so equal rows never shuffle between renders.
    .sort((a, b) => compareProjects(a, b, sort) || a.name.localeCompare(b.name));

  const specs = [...INITIATIVE_GROUPS, OTHER];
  const groups: InitiativeListGroup[] = specs
    .map((g) => {
      const rows = visible
        .filter((p) => groupIdOf(p.status) === g.id)
        .map((p) => ({
          id: p.id,
          groupId: g.id,
          title: p.name,
          href: `/iq/projects/${encodeURIComponent(p.id)}`,
        }));
      const holdsCurrent = input.currentId != null && rows.some((r) => r.id === input.currentId);
      return { id: g.id, title: g.title, count: rows.length, defaultOpen: g.defaultOpen || holdsCurrent, rows };
    })
    .filter((g) => g.count > 0);

  const noun = (n: number) => (n === 1 ? 'initiative' : 'initiatives');
  let footer: string;
  if (all.length === 0 && input.scope === 'mine') footer = 'Personal view';
  else if (visible.length === all.length) footer = `${total} ${noun(all.length)}`;
  else footer = `${visible.length} of ${total} ${noun(all.length)}`;

  const state = all.length === 0 ? 'empty' : visible.length === 0 ? 'no-match' : 'ready';
  return { state, title: 'Initiatives', count: total, groups, footer, shown: visible.length };
}

/** The rail's own empty copy (M1), per scope. */
export function railEmptyCopy(scope: 'all' | 'mine'): { title: string; body: string; action: { label: string } | null } {
  if (scope === 'mine') {
    return { title: 'Nothing linked yet', body: 'Try All initiatives to browse the workspace.', action: { label: 'Show all initiatives' } };
  }
  return { title: 'No initiatives yet', body: 'Initiatives appear here once ingestion creates them.', action: null };
}

/** Search/filter hid every row. */
export const RAIL_NO_MATCH = { title: 'No matches', body: 'No initiative matches this search or filter.' };
