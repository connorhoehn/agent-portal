// The run report store: ONE interface, two implementations, the runbook
// store's rule (lib/runbooks/store.ts) — RowsRunReportStore (store-rows.ts,
// registered mock fixtures, the default) and DynamoRunReportStore
// (store-dynamo.ts, the runbook store's own table, opt-in with the same
// RUNBOOK_DYNAMODB_ENDPOINT / RUNBOOK_TABLE / RUNBOOK_STORE switch). The shared
// contract suite (__tests__/run-report-store.test.ts) proves both.
//
// What the interface guarantees:
//  * A report is write-once per runRef and idempotent: a second put returns the
//    report that is already there, unchanged, with `created: false`.
//  * Reads return copies.
//  * Lists are newest `endedAt` first, then runRef.
import type { DebriefState, RunDebrief, RunExecutor, RunOutcome, RunReport } from './types.js';
import { InvalidWriteError, paginate, type Page } from '../runbooks/store.js';

export interface ListRunReportsQuery {
  workItemId?: string;
  initiativeId?: string;
  /** Reports whose brief offered this runbook, or whose run used it (`?runbook=rb-…`). */
  runbookId?: string;
  /** One or more executors (`GET /api/run-reports?executor=fleet,mock`). */
  executors?: readonly RunExecutor[];
  outcome?: RunOutcome;
  /** A debrief state, or `none`: the run has no debrief record. */
  debrief?: DebriefState | 'none';
  /** Only these runs (`?runRefs=a,b`). */
  runRefs?: readonly string[];
  /** Text search (`?q=`): every whitespace-separated term must appear, case-insensitively, in the summary, obstacles, learned text, failure code or run ref. */
  q?: string;
  cursor?: string;
  limit?: number;
}

/** The longest search text a request may carry. */
export const MAX_REPORT_SEARCH_CHARS = 200;

/** True when every term of `q` is a substring of one of the report's searchable texts. Plain substrings, no index. */
export function reportMatchesText(r: RunReport, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [r.summary, ...(r.obstacles ?? []), r.learned ?? '', r.failureCode ?? '', r.runRef].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface RunReportStore {
  readonly kind: 'rows' | 'dynamo';
  /** Store once per runRef. The second and later puts change nothing and return the stored report. */
  putReport(r: RunReport): Promise<{ report: RunReport; created: boolean }>;
  getReport(runRef: string): Promise<RunReport | null>;
  /**
   * Lane C: the one field of a stored report that changes after it is written — its debrief, as
   * the request moves to an end. Conditional: `expect` is the state the debrief must be in now
   * (null: not decided yet), so a token is spent once and two posts cannot both win. Returns the
   * updated report, or null when the report is missing or the condition failed.
   */
  setDebrief(runRef: string, debrief: RunDebrief, expect: DebriefState | null): Promise<RunReport | null>;
  listReports(q?: ListRunReportsQuery): Promise<Page<RunReport>>;
}

export const byEndedDesc = (a: RunReport, b: RunReport): number =>
  b.endedAt.localeCompare(a.endedAt) || a.runRef.localeCompare(b.runRef);

export function filterReports(rows: readonly RunReport[], q: ListRunReportsQuery | undefined): RunReport[] {
  return rows.filter((r) => (!q?.runRefs || q.runRefs.includes(r.runRef))
    && (!q?.workItemId || r.workItemId === q.workItemId)
    && (!q?.initiativeId || r.initiativeId === q.initiativeId)
    && (!q?.runbookId || r.runbooksOffered.some((x) => x.id === q.runbookId) || r.runbooksUsed.some((x) => x.id === q.runbookId))
    && (!q?.q || reportMatchesText(r, q.q))
    && (!q?.executors?.length || q.executors.includes(r.executor))
    && (!q?.outcome || r.outcome === q.outcome)
    && (!q?.debrief || (q.debrief === 'none' ? debriefStateOf(r) === null : debriefStateOf(r) === q.debrief)));
}

export function pageReports(rows: RunReport[], q: ListRunReportsQuery | undefined): Page<RunReport> {
  return paginate(rows.sort(byEndedDesc), q?.cursor, q?.limit);
}

/** The debrief state a stored report is in (null: none decided). */
export const debriefStateOf = (r: RunReport): DebriefState | null => r.debrief?.state ?? null;

export function checkReport(r: RunReport): void {
  if (!r.runRef || typeof r.runRef !== 'string') throw new InvalidWriteError('a run report needs a runRef');
  if (!r.endedAt) throw new InvalidWriteError('a run report needs endedAt');
}
