// The panel's notice SQL store (schema/interviews_schema.sql `interview_panel_notices`), over the RDS Data API's
// `exec` shape, injected as ./store-sql.ts injects it so the contract test runs the statements against canned rows.
//
// "Once" is the primary key (user_id, notice_version): the insert does nothing on a second acknowledgement of the
// same version, and the store then reads the first one back.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { PanelNoticeRow, PanelNoticeStore } from './panel-notice-store.js';

const COLUMNS = 'user_id, notice_version, acknowledged_at, interview_id';

export const LIST_PANEL_NOTICES_SQL = `SELECT ${COLUMNS} FROM interview_panel_notices
  WHERE user_id IN (SELECT jsonb_array_elements_text(CAST(:user_ids AS JSONB)))
  ORDER BY acknowledged_at`;
export const GET_PANEL_NOTICE_SQL = `SELECT ${COLUMNS} FROM interview_panel_notices
  WHERE user_id = :user_id AND notice_version = :notice_version`;
export const INSERT_PANEL_NOTICE_SQL = `INSERT INTO interview_panel_notices (user_id, notice_version, acknowledged_at, interview_id)
  VALUES (:user_id, :notice_version, CAST(:acknowledged_at AS TIMESTAMPTZ), :interview_id)
  ON CONFLICT (user_id, notice_version) DO NOTHING
  RETURNING ${COLUMNS}`;

export const PANEL_NOTICE_STATEMENTS = [LIST_PANEL_NOTICES_SQL, GET_PANEL_NOTICE_SQL, INSERT_PANEL_NOTICE_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });

export function panelNoticeFromRow(r: Record<string, unknown>): PanelNoticeRow {
  return {
    userId: String(r['user_id']), noticeVersion: String(r['notice_version']),
    acknowledgedAt: isoOf(r['acknowledged_at']), interviewId: String(r['interview_id']),
  };
}

export class SqlPanelNoticeStore implements PanelNoticeStore {
  constructor(private readonly exec: SqlExec) {}

  async listFor(userIds: readonly string[]): Promise<PanelNoticeRow[]> {
    if (!userIds.length) return [];
    return (await this.exec(LIST_PANEL_NOTICES_SQL, [text('user_ids', JSON.stringify(userIds))])).map(panelNoticeFromRow);
  }

  async acknowledge(row: PanelNoticeRow): Promise<{ created: boolean; row: PanelNoticeRow }> {
    const inserted = await this.exec(INSERT_PANEL_NOTICE_SQL, [
      text('user_id', row.userId), text('notice_version', row.noticeVersion),
      text('acknowledged_at', row.acknowledgedAt), text('interview_id', row.interviewId),
    ]);
    if (inserted[0]) return { created: true, row: panelNoticeFromRow(inserted[0]) };
    const first = await this.exec(GET_PANEL_NOTICE_SQL, [text('user_id', row.userId), text('notice_version', row.noticeVersion)]);
    // The key exists (the insert did nothing), so the read finds it; the fallback only guards a racing delete.
    return { created: false, row: first[0] ? panelNoticeFromRow(first[0]) : row };
  }
}
