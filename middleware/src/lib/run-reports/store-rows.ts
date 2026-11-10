// RowsRunReportStore: the mock-floor RunReportStore. Reads and writes a
// registered fixture (mock/run-reports.ts) through accessors, so
// `POST /api/__mock/reset` takes back every report and scenarios apply. Every
// method is synchronous inside, so the write-once check is atomic.
import { clone, type Page } from '../runbooks/store.js';
import type { RunReport } from './types.js';
import {
  checkReport, filterReports, pageReports,
  type ListRunReportsQuery, type RunReportStore,
} from './store.js';

export interface RunReportRowSources {
  reports(): RunReport[];
}

export function privateRunReportSources(): RunReportRowSources {
  const r: RunReport[] = [];
  return { reports: () => r };
}

export class RowsRunReportStore implements RunReportStore {
  readonly kind = 'rows' as const;
  constructor(private readonly src: RunReportRowSources) {}

  async putReport(r: RunReport): Promise<{ report: RunReport; created: boolean }> {
    checkReport(r);
    const existing = this.src.reports().find((x) => x.runRef === r.runRef);
    if (existing) return { report: clone(existing), created: false };
    this.src.reports().push(clone(r));
    return { report: clone(r), created: true };
  }

  async getReport(runRef: string): Promise<RunReport | null> {
    const r = this.src.reports().find((x) => x.runRef === runRef);
    return r ? clone(r) : null;
  }

  async listReports(q?: ListRunReportsQuery): Promise<Page<RunReport>> {
    const page = pageReports(filterReports(this.src.reports(), q), q);
    return { items: clone(page.items), next: page.next };
  }
}
