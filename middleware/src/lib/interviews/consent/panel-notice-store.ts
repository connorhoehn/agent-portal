// The panel's notice store (docs/interviews-tenant-plan.md decision 5, its last sentence): one row per person and
// notice version, kept when an interviewer acknowledges the notice on their way to accepting a seat.
//
// Two implementations behind one interface, chosen as ./store.ts chooses: the memory store over the registered
// fixture (mock/interviews-panel-notices.ts) under the mock providers, the SQL store (panel-notice-store-sql.ts,
// schema/interviews_schema.sql `interview_panel_notices`) otherwise. __tests__/panel-notice.test.ts runs one
// contract over both.
//
// "Once": the row's key is the person and the version, and a second acknowledgement of the same version keeps
// the first (its time and the interview it was given for). Rows are never edited and never removed here.
// Who may acknowledge, and which version is current, is decided above it (panel-notice.ts, the route).

import { config } from '../../../config.js';
import { interviewPanelNoticesFixture } from '../../../mock/interviews-panel-notices.js';
import { SqlPanelNoticeStore } from './panel-notice-store-sql.js';

/** One acknowledgement: who, which notice version, when, and the interview they were accepting. */
export interface PanelNoticeRow {
  userId: string;
  noticeVersion: string;
  acknowledgedAt: string;
  interviewId: string;
}

export interface PanelNoticeStore {
  /** Every acknowledgement the given people made, oldest first. */
  listFor(userIds: readonly string[]): Promise<PanelNoticeRow[]>;
  /** Keep `row` unless the person already acknowledged that version; `created` is false and `row` the first one then. */
  acknowledge(row: PanelNoticeRow): Promise<{ created: boolean; row: PanelNoticeRow }>;
}

const byTime = (a: PanelNoticeRow, b: PanelNoticeRow) => a.acknowledgedAt.localeCompare(b.acknowledgedAt);

export class MemoryPanelNoticeStore implements PanelNoticeStore {
  private rows(): PanelNoticeRow[] { return interviewPanelNoticesFixture.rows(); }

  async listFor(userIds: readonly string[]): Promise<PanelNoticeRow[]> {
    return this.rows().filter((r) => userIds.includes(r.userId)).map((r) => ({ ...r })).sort(byTime);
  }

  async acknowledge(row: PanelNoticeRow): Promise<{ created: boolean; row: PanelNoticeRow }> {
    const rows = this.rows();
    const first = rows.find((r) => r.userId === row.userId && r.noticeVersion === row.noticeVersion);
    if (first) return { created: false, row: { ...first } };
    rows.push({ ...row });
    return { created: true, row: { ...row } };
  }
}

let current: PanelNoticeStore | null = null;

export function createPanelNoticeStore(): PanelNoticeStore {
  if (config.mock?.aurora) return new MemoryPanelNoticeStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlPanelNoticeStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function panelNoticeStore(): PanelNoticeStore { return (current ??= createPanelNoticeStore()); }
export function setPanelNoticeStore(next: PanelNoticeStore | null): void { current = next; }
