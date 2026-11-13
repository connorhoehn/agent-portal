// My work: the signed-in person's open work items across every initiative. The rows come from
// GET /api/graph/work?assignee=me&status=open,in_progress,in_review; this file only decides the
// query, the filters and the order, so they can be tested without a render.

export const OPEN_STATUSES = ['in_progress', 'in_review', 'open'] as const;
export const MY_WORK_URL = `/api/graph/work?assignee=me&status=${OPEN_STATUSES.join(',')}&limit=200`;

export interface MyWorkItem {
  id: string;
  key?: string | null;
  projectId: string;
  projectName: string;
  type: string;
  title: string;
  status: string;
  sprintId?: string | null;
  updatedAt: string;
}

export interface MyWorkFilters { status: string; initiative: string; type: string }

const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', in_review: 'In review' };
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
export const typeLabel = (t: string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

export const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  ...OPEN_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value]! })),
];
export const TYPE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'story', label: 'Story' },
  { value: 'bug', label: 'Bug' },
  { value: 'epic', label: 'Epic' },
];

/** The initiatives the rows belong to, by name, for the filter. */
export function initiativeOptions(items: readonly MyWorkItem[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const i of items) if (!seen.has(i.projectId)) seen.set(i.projectId, i.projectName);
  return [{ value: '', label: 'All' }, ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
}

const rank = (s: string): number => { const n = (OPEN_STATUSES as readonly string[]).indexOf(s); return n < 0 ? OPEN_STATUSES.length : n; };

/** Open items only, filtered, by status (in progress, in review, open) then most recently updated. */
export function myWorkRows(items: readonly MyWorkItem[], f: MyWorkFilters): MyWorkItem[] {
  return items
    .filter((i) => (OPEN_STATUSES as readonly string[]).includes(i.status))
    .filter((i) => (!f.status || i.status === f.status) && (!f.initiative || i.projectId === f.initiative) && (!f.type || i.type === f.type))
    .sort((a, b) => rank(a.status) - rank(b.status) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
}

/** The initiative page a row's initiative cell opens. */
export const initiativeHref = (projectId: string): string => `/iq/projects/${encodeURIComponent(projectId)}`;

/**
 * The empty-table sentence. `GET /api/graph/work?assignee=me` answers [] both for a linked person with nothing
 * open and for an account with no linked person, so the page asks /api/session/person and passes the answer
 * here. `linked` is null while that read is unknown or failed: then the generic sentence is the honest one.
 */
export function myWorkEmptyMessage(filtered: boolean, linked: boolean | null): string {
  if (filtered) return 'No open work item matches these filters.';
  if (linked === false) {
    return 'Your account is not linked to a person in the org directory, so no work can be assigned to you here. A workspace admin links it in Identity, under Users.';
  }
  return 'Nothing is assigned to you right now.';
}
