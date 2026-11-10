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
//  * A worker's staged part (the devbox `lab report` that arrives before the
//    run's own end) is write-once too; the first one stands.
//  * Reads return copies.
//  * Lists are newest `endedAt` first, then runRef.
import type { RunReport, WorkerReportPart } from './types.js';
import { InvalidWriteError, paginate, type Page } from '../runbooks/store.js';

export interface ListRunReportsQuery {
  workItemId?: string;
  initiativeId?: string;
  cursor?: string;
  limit?: number;
}

export interface StagedWorkerPart {
  runRef: string;
  part: WorkerReportPart;
  at: string;
}

export interface RunReportStore {
  readonly kind: 'rows' | 'dynamo';
  /** Store once per runRef. The second and later puts change nothing and return the stored report. */
  putReport(r: RunReport): Promise<{ report: RunReport; created: boolean }>;
  getReport(runRef: string): Promise<RunReport | null>;
  listReports(q?: ListRunReportsQuery): Promise<Page<RunReport>>;
  /** Stage what a worker said before its run ended. false when a part (or the report itself) is already there. */
  stageWorkerPart(s: StagedWorkerPart): Promise<boolean>;
  getWorkerPart(runRef: string): Promise<StagedWorkerPart | null>;
}

export const byEndedDesc = (a: RunReport, b: RunReport): number =>
  b.endedAt.localeCompare(a.endedAt) || a.runRef.localeCompare(b.runRef);

export function filterReports(rows: readonly RunReport[], q: ListRunReportsQuery | undefined): RunReport[] {
  return rows.filter((r) => (!q?.workItemId || r.workItemId === q.workItemId) && (!q?.initiativeId || r.initiativeId === q.initiativeId));
}

export function pageReports(rows: RunReport[], q: ListRunReportsQuery | undefined): Page<RunReport> {
  return paginate(rows.sort(byEndedDesc), q?.cursor, q?.limit);
}

export function checkReport(r: RunReport): void {
  if (!r.runRef || typeof r.runRef !== 'string') throw new InvalidWriteError('a run report needs a runRef');
  if (!r.endedAt) throw new InvalidWriteError('a run report needs endedAt');
}
