// The consents SQL store (schema/interviews_schema.sql `interview_consents`), over the RDS Data API's `exec`
// shape, injected as lib/interviews/invite/store-sql.ts injects it so the contract test runs the statements
// against canned rows. Timestamps travel as ISO text, CAST in the statement.
//
// The first answer inserts at revision 1 (ON CONFLICT DO NOTHING: a second tab that inserted first makes this
// one stale). A change updates against the revision it read and appends its entry to `history` in the same
// statement (`history || jsonb_build_array(entry)`), so the list can only grow.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { WriteResult } from '../store.js';
import type { ConsentHistoryEntry, ConsentRecord, ConsentStore, ConsentWrite } from './store.js';

const COLUMNS = 'interview_id, notice_version, recording, recording_at, transcription, transcription_at, milo, milo_at, answered_at, changed_at, history, revision';

export const GET_CONSENT_SQL = `SELECT ${COLUMNS} FROM interview_consents WHERE interview_id = :interview_id`;
export const INSERT_CONSENT_SQL = `INSERT INTO interview_consents (interview_id, notice_version, recording, recording_at, transcription,
    transcription_at, milo, milo_at, answered_at, changed_at, history, revision)
  VALUES (:interview_id, :notice_version, :recording, CAST(:recording_at AS TIMESTAMPTZ), :transcription,
    CAST(:transcription_at AS TIMESTAMPTZ), :milo, CAST(:milo_at AS TIMESTAMPTZ), CAST(:changed_at AS TIMESTAMPTZ),
    CAST(:changed_at AS TIMESTAMPTZ), jsonb_build_array(CAST(:entry AS JSONB)), 1)
  ON CONFLICT (interview_id) DO NOTHING
  RETURNING ${COLUMNS}`;
export const UPDATE_CONSENT_SQL = `UPDATE interview_consents
  SET notice_version = :notice_version, recording = :recording, recording_at = CAST(:recording_at AS TIMESTAMPTZ),
    transcription = :transcription, transcription_at = CAST(:transcription_at AS TIMESTAMPTZ), milo = :milo,
    milo_at = CAST(:milo_at AS TIMESTAMPTZ), changed_at = CAST(:changed_at AS TIMESTAMPTZ),
    history = history || jsonb_build_array(CAST(:entry AS JSONB)), revision = revision + 1
  WHERE interview_id = :interview_id AND revision = :revision
  RETURNING ${COLUMNS}`;

export const CONSENT_STATEMENTS = [GET_CONSENT_SQL, INSERT_CONSENT_SQL, UPDATE_CONSENT_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const bool = (name: string, value: boolean): SqlParameter => ({ name, value: { booleanValue: value } });
const int = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 'true';

function historyOf(v: unknown): ConsentHistoryEntry[] {
  if (Array.isArray(v)) return v as ConsentHistoryEntry[];
  if (typeof v === 'string' && v) { try { const p = JSON.parse(v) as unknown; return Array.isArray(p) ? p as ConsentHistoryEntry[] : []; } catch { return []; } }
  return [];
}

export function consentFromRow(r: Record<string, unknown>): ConsentRecord {
  return {
    interviewId: String(r['interview_id']), noticeVersion: String(r['notice_version']),
    recording: truthy(r['recording']), recordingAt: isoOf(r['recording_at']),
    transcription: truthy(r['transcription']), transcriptionAt: isoOf(r['transcription_at']),
    milo: truthy(r['milo']), miloAt: isoOf(r['milo_at']),
    answeredAt: isoOf(r['answered_at']), changedAt: isoOf(r['changed_at']),
    history: historyOf(r['history']), revision: Number(r['revision'] ?? 1),
  };
}

const first = (rows: Record<string, unknown>[]): ConsentRecord | null => (rows[0] ? consentFromRow(rows[0]) : null);

export class SqlConsentStore implements ConsentStore {
  constructor(private readonly exec: SqlExec) {}

  async getConsent(interviewId: string): Promise<ConsentRecord | null> {
    return first(await this.exec(GET_CONSENT_SQL, [text('interview_id', interviewId)]));
  }

  async saveConsent(write: ConsentWrite, revision: number): Promise<WriteResult<ConsentRecord>> {
    const params = [
      text('interview_id', write.interviewId), text('notice_version', write.noticeVersion),
      bool('recording', write.recording), text('recording_at', write.recordingAt),
      bool('transcription', write.transcription), text('transcription_at', write.transcriptionAt),
      bool('milo', write.milo), text('milo_at', write.miloAt), text('changed_at', write.changedAt),
      text('entry', JSON.stringify(write.entry)),
    ];
    const row = revision === 0
      ? first(await this.exec(INSERT_CONSENT_SQL, params))
      : first(await this.exec(UPDATE_CONSENT_SQL, [...params, int('revision', revision)]));
    if (row) return { ok: true, row };
    const now = await this.getConsent(write.interviewId);
    return now ? { ok: false, reason: 'stale', row: now } : { ok: false, reason: 'not-found' };
  }
}
