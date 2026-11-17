// Retention's own statements on tables nobody else deletes from (row I6.3; SHARED-FILES: "RETENTION's deletion log
// and its redaction of a candidate's contact details live in lib/interviews/retention/"): the consents and the
// scorecards of interviews past their record period, and a candidate's contact details on request.
//
// Memory half over the registered fixtures (mock/interviews.ts, mock/interviews-consents.ts), chosen as every
// interviews store chooses; the SQL half over the Data API's `exec`, injected so the tests run against canned rows.
// Each answers how many rows it changed, so a repeat answers 0.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../../config.js';
import { interviewCandidatesFixture, interviewScorecardsFixture } from '../../../mock/interviews.js';
import { interviewConsentsFixture } from '../../../mock/interviews-consents.js';
import type { SqlExec } from '../store-sql.js';
import { REDACTED_CONTACT, isRedacted } from './rules.js';

export interface RecordStatements {
  eraseConsents(interviewIds: readonly string[]): Promise<number>;
  eraseScorecards(interviewIds: readonly string[]): Promise<number>;
  /** Take the candidate's contact details out (rules.ts REDACTED_CONTACT). 1 when it changed the row, 0 when already done or unknown. */
  redactCandidate(candidateId: string): Promise<number>;
}

function spliceWhere<T>(rows: T[], drop: (r: T) => boolean): number {
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) if (drop(rows[i]!)) { rows.splice(i, 1); n += 1; }
  return n;
}

export class MemoryRecordStatements implements RecordStatements {
  async eraseConsents(ids: readonly string[]): Promise<number> {
    return spliceWhere(interviewConsentsFixture.rows(), (r) => ids.includes(r.interviewId));
  }
  async eraseScorecards(ids: readonly string[]): Promise<number> {
    return spliceWhere(interviewScorecardsFixture.rows(), (r) => ids.includes(r.interviewId));
  }
  async redactCandidate(candidateId: string): Promise<number> {
    const row = interviewCandidatesFixture.rows().find((c) => c.id === candidateId);
    if (!row || isRedacted(row)) return 0;
    Object.assign(row, REDACTED_CONTACT);
    return 1;
  }
}

/** `IN (:id0, :id1, …)` and its parameters. The Data API has no array parameter. */
function idList(ids: readonly string[]): { sql: string; params: SqlParameter[] } {
  const params = ids.map((id, i) => ({ name: `id${i}`, value: { stringValue: id } }));
  return { sql: params.map((p) => `:${p.name}`).join(', '), params };
}

export const eraseConsentsSql = (list: string): string => `DELETE FROM interview_consents WHERE interview_id IN (${list}) RETURNING interview_id`;
export const eraseScorecardsSql = (list: string): string => `DELETE FROM interview_scorecards WHERE interview_id IN (${list}) RETURNING id`;
export const REDACT_CANDIDATE_SQL = `UPDATE interview_candidates
  SET name = :name, email = :email, headline = :headline, location = :location, notes = :notes
  WHERE id = :id AND NOT (name = :name AND email = :email)
  RETURNING id`;

export class SqlRecordStatements implements RecordStatements {
  constructor(private readonly exec: SqlExec) {}
  async eraseConsents(ids: readonly string[]): Promise<number> {
    if (!ids.length) return 0;
    const l = idList(ids);
    return (await this.exec(eraseConsentsSql(l.sql), l.params)).length;
  }
  async eraseScorecards(ids: readonly string[]): Promise<number> {
    if (!ids.length) return 0;
    const l = idList(ids);
    return (await this.exec(eraseScorecardsSql(l.sql), l.params)).length;
  }
  async redactCandidate(candidateId: string): Promise<number> {
    const t = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
    const r = REDACTED_CONTACT;
    return (await this.exec(REDACT_CANDIDATE_SQL, [t('id', candidateId), t('name', r.name), t('email', r.email), t('headline', r.headline), t('location', r.location), t('notes', r.notes)])).length;
  }
}

let current: RecordStatements | null = null;
export function recordStatements(): RecordStatements {
  return (current ??= config.mock?.aurora
    ? new MemoryRecordStatements()
    : new SqlRecordStatements(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params)));
}
export function setRecordStatements(next: RecordStatements | null): void { current = next; }
