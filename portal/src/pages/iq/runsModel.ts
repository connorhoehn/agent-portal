// The Runs list and the run page (docs/learning-loop-design.md "Pages"): the wire shape of a run
// report as the portal reads it (middleware lib/run-reports/types.ts) and the words every run
// surface shares. Pure: no React, so node:test loads it.

export type RunExecutor = 'fleet' | 'governed' | 'microvm' | 'local' | 'mock';
export type RunOutcome = 'done' | 'failed' | 'cancelled' | 'needs-review';
export type DebriefState = 'skipped' | 'requested' | 'filed' | 'nothing-to-keep' | 'lint-failed' | 'refused' | 'expired';

export interface RunReportDebrief {
  state: DebriefState;
  reasonText: string | null;
  answer: { kind: string; reason: string; runbookId: string | null } | null;
  proposalId: string | null;
  proposalKind: 'new' | 'edit' | null;
  convertedFrom: string | null;
  problems: string[];
  lint: Array<{ rule: string; severity: 'error' | 'warning'; path: string; message: string }>;
  simulated: boolean;
}

export interface RunReportRow {
  runRef: string;
  workItemId: string | null;
  initiativeId: string | null;
  executor: RunExecutor;
  startedAt: string | null;
  endedAt: string;
  outcome: RunOutcome;
  failureCode: string | null;
  summary: string;
  changes: { files: Array<{ path: string; added: number | null; removed: number | null }>; changeRequestId: string | null };
  verification: Array<{ command: string; passed: boolean }>;
  obstacles: string[];
  runbooksOffered: Array<{ id: string; version: number | null }>;
  runbooksUsed: Array<{ id: string; version: number | null; source: 'observed' | 'lab-applied' }>;
  cost: { billedUsd: number | null; reportedUsd: number | null; basis: 'billed' | 'reported' | 'simulated' | 'unknown' };
  selfReport: 'ok' | 'missing' | 'malformed';
  learned?: string;
  runbookAccounts?: Array<{ id: string; followed: 'yes' | 'partly' | 'no'; wrongStep: number | null; note: string | null }>;
  debrief?: RunReportDebrief | null;
}

/** The run ref a /iq/runs/:id id names (`job:abc` and `abc` are the same run), or null for a run no report can exist for. */
export function runRefOf(id: string | undefined): string | null {
  if (!id) return null;
  if (id.startsWith('job:')) return id.slice(4) || null;
  return id.includes(':') ? null : id;
}

/** The façade's id for a run ref. */
export const facadeIdOf = (id: string): string => (id.includes(':') ? id : `job:${id}`);

export const EXECUTOR_FILTERS = [
  { value: '', label: 'All' },
  { value: 'fleet', label: 'Queue' },
  { value: 'local', label: 'Your machine' },
  { value: 'governed,mock', label: 'Bot' },
  { value: 'microvm', label: 'MicroVM' },
] as const;

export const OUTCOME_FILTERS = [
  { value: '', label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'needs-review', label: 'Needs review' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

export const DEBRIEF_FILTERS = [
  { value: '', label: 'All' },
  { value: 'filed', label: 'Filed a runbook' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'none', label: 'Not asked' },
] as const;

export const EXECUTOR_WORD: Record<RunExecutor, string> = {
  fleet: 'Queue', governed: 'Bot', mock: 'Bot', microvm: 'MicroVM', local: 'Your machine',
};

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled', 'needs-review': 'Needs review',
};
export const OUTCOME_TONE: Record<RunOutcome, 'success' | 'danger' | 'neutral' | 'warning'> = {
  done: 'success', failed: 'danger', cancelled: 'neutral', 'needs-review': 'warning',
};

/** Who ran it: the bot's name when the façade knows one, else "Your machine" or the executor's word. */
export function whoRan(executor: RunExecutor, botName: string | null | undefined): string {
  if (executor === 'local') return EXECUTOR_WORD.local;
  return botName ? botName : EXECUTOR_WORD[executor];
}

/** A simulated run (the mock): its report and any runbook it filed are hand-written. */
export const isSimulated = (r: Pick<RunReportRow, 'cost' | 'debrief'>): boolean =>
  r.cost.basis === 'simulated' || r.debrief?.simulated === true;

/** The cost cell: money only when it was billed; a local run says it was reported, not billed. */
export function costWords(cost: RunReportRow['cost'], usd: (n: number) => string): string {
  if (cost.basis === 'simulated') return 'Demo data';
  if (cost.basis === 'reported') return cost.reportedUsd != null ? `${usd(cost.reportedUsd)} reported, not billed` : 'Reported, not billed';
  if (cost.basis === 'billed' && cost.billedUsd != null) return usd(cost.billedUsd);
  return '—';
}

/** A run that did not report: its summary block was missing or unreadable. */
export function didNotReport(r: Pick<RunReportRow, 'selfReport'>): string | null {
  if (r.selfReport === 'missing') return 'This run did not report. It ended without the summary it was asked for, so what is shown here is only what the platform recorded.';
  if (r.selfReport === 'malformed') return 'This run did not report. The summary it sent could not be read, so what is shown here is only what the platform recorded.';
  return null;
}

/** `needs_gpu_pool` → `needs gpu pool`. */
export const failureWords = (code: string | null): string | null => (code ? code.replace(/_/g, ' ') : null);

/** The façade names a step by its machinery; the page uses plain words. */
export function stepWords(label: string): string {
  return label.replace(/^Claimed by a box$/i, 'Picked up').replace(/\bbox\b/gi, 'computer');
}
/** A step's detail naming the machine by id is dropped. */
export const stepDetail = (detail: string | null | undefined): string | null => (!detail || /^box\s/i.test(detail) ? null : detail);

/** The learned dot: a proposal was filed. */
export const learnedDot = (r: Pick<RunReportRow, 'debrief'>): boolean => r.debrief?.state === 'filed';

/** The query string a Runs list filter state makes (`executor`, `initiative`, `outcome`, `debrief`). */
export function reportsQuery(f: { executor: string; initiative: string; outcome: string; debrief: string }, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.executor) p.set('executor', f.executor);
  if (f.initiative) p.set('initiative', f.initiative);
  if (f.outcome) p.set('outcome', f.outcome);
  if (f.debrief) p.set('debrief', f.debrief);
  p.set('limit', '100');
  if (cursor) p.set('cursor', cursor);
  return `?${p.toString()}`;
}

/** The Runs list's URL for a filter (what the rails link to). */
export function runsListHref(f: Partial<{ executor: string; initiative: string; outcome: string; debrief: string }>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const q = p.toString();
  return `/iq/runs${q ? `?${q}` : ''}`;
}
