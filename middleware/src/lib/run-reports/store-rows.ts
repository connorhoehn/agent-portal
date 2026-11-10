// RowsRunReportStore: the mock-floor RunReportStore. Reads and writes two
// registered fixtures (mock/run-reports.ts) through accessors, so
// `POST /api/__mock/reset` takes back every report and scenarios apply. Every
// method is synchronous inside, so the write-once check is atomic.
import { clone, type Page } from '../runbooks/store.js';
import type { RunReport } from './types.js';
import {
  checkReport, filterReports, pageReports,
  type ListRunReportsQuery, type RunReportStore, type StagedWorkerPart,
} from './store.js';

export interface RunReportRowSources {
  reports(): RunReport[];
  staged(): StagedWorkerPart[];
}

export function privateRunReportSources(): RunReportRowSources {
  const r: RunReport[] = [], s: StagedWorkerPart[] = [];
  return { reports: () => r, staged: () => s };
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

  async stageWorkerPart(s: StagedWorkerPart): Promise<boolean> {
    if (this.src.staged().some((x) => x.runRef === s.runRef)) return false;
    if (this.src.reports().some((x) => x.runRef === s.runRef)) return false;
    this.src.staged().push(clone(s));
    return true;
  }

  async getWorkerPart(runRef: string): Promise<StagedWorkerPart | null> {
    const s = this.src.staged().find((x) => x.runRef === runRef);
    return s ? clone(s) : null;
  }
}
