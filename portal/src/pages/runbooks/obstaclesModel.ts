// Runbooks → Recurring obstacles: the walls different runs keep hitting (GET /api/run-reports/recurring-obstacles),
// and the way from one to "write a runbook for this" (the Library's New runbook form, opened with its fields filled).
import { RUNBOOKS, type NewRunbookDraft } from './runbooksModel.ts';

export const obstaclesHref = () => `${RUNBOOKS}/obstacles`;

export interface RecurringObstacle {
  key: string;
  text: string;
  scope: { kind: 'repo' | 'initiative'; ref: string };
  runs: number;
  workItems: number;
  failedRuns: number;
  firstSeen: string;
  lastSeen: string;
  runRefs: string[];
  initiativeIds: string[];
}
export interface RecurringObstaclesResponse { obstacles: RecurringObstacle[]; windowDays: number; since: string; runsRead: number }

export const WINDOW_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
] as const;

export function obstaclesQuery(f: { initiative: string; repo: string; days: string }): string {
  const p = new URLSearchParams();
  if (f.initiative) p.set('initiative', f.initiative);
  if (f.repo) p.set('repo', f.repo);
  if (f.days) p.set('days', f.days);
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** "orgiq-auth-service" from "org/orgiq-auth-service". */
export const repoName = (repo: string): string => repo.replace(/\.git$/, '').split('/').pop() ?? repo;

/** The Library URL that opens the New runbook form for this obstacle: description and scope filled in. */
export function writeRunbookHref(o: Pick<RecurringObstacle, 'text' | 'scope'>): string {
  const p = new URLSearchParams({ new: '1', description: o.text, scopeKind: o.scope.kind, scopeRef: o.scope.ref });
  return `${RUNBOOKS}?${p.toString()}`;
}

/** The form's starting values from the Library URL's query; null when the URL does not ask for the form. */
export function draftFromParams(p: URLSearchParams): Partial<NewRunbookDraft> | null {
  if (p.get('new') !== '1') return null;
  const out: Partial<NewRunbookDraft> = {};
  const description = p.get('description');
  if (description) out.description = description.replace(/\s+/g, ' ').trim().slice(0, 300);
  const kind = p.get('scopeKind');
  if (kind === 'repo' || kind === 'initiative') out.scopeKind = kind;
  const ref = p.get('scopeRef');
  if (ref) out.scopeRef = ref.slice(0, 200);
  return out;
}
