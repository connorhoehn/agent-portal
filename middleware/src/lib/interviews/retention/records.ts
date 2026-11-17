// Retention's own statements on tables nobody else deletes from (row I6.3; SHARED-FILES: "RETENTION's deletion log
// and its redaction of a candidate's contact details live in lib/interviews/retention/"): the consents and the
// scorecards of interviews past their record period, and a candidate's contact details on request, with the free-text
// reasons written on their applications' stage moves (the stage, the time and who moved it stay).
//
// Memory half over the registered fixtures (mock/interviews.ts, mock/interviews-consents.ts), chosen as every
// interviews store chooses; the SQL half over the Data API's `exec`, injected so the tests run against canned rows.
// Each answers how many rows it changed, so a repeat answers 0.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../../config.js';
import { interviewApplicationsFixture, interviewCandidatesFixture, interviewScorecardsFixture } from '../../../mock/interviews.js';
import { interviewConsentsFixture } from '../../../mock/interviews-consents.js';
import type { SqlExec } from '../store-sql.js';
import { REDACTED_CONTACT, REDACTED_REASON, isRedacted } from './rules.js';

export interface RecordStatements {
  eraseConsents(interviewIds: readonly string[]): Promise<number>;
  eraseScorecards(interviewIds: readonly string[]): Promise<number>;
  /** Take the candidate's contact details out (rules.ts REDACTED_CONTACT). 1 when it changed the row, 0 when already done or unknown. */
  redactCandidate(candidateId: string): Promise<number>;
  /**
   * Every reason written on a stage move of the candidate's applications becomes REDACTED_REASON (a move without a reason keeps
   * none). How many applications it changed: 0 when already done or unknown.
   */
  redactStageReasons(candidateId: string): Promise<number>;
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
  async redactStageReasons(candidateId: string): Promise<number> {
    let n = 0;
    for (const app of interviewApplicationsFixture.rows()) {
      if (app.candidateId !== candidateId) continue;
      const changes = app.history.filter((h) => h.reason !== null && h.reason !== REDACTED_REASON);
      for (const h of changes) h.reason = REDACTED_REASON;
      if (changes.length) n += 1;
    }
    return n;
  }
}

/** `IN (:id0, :id1, …)` and its parameters. The Data API has no array parameter. */
function idList(ids: readonly string[]): { sql: string; params: SqlParameter[] } {
  const params = ids.map((id, i) => ({ name: `id${i}`, value: { stringValue: id } }));
  return { sql: params.map((p) => `:${p.name}`).join(', '), params };
}

export const eraseConsentsSql = (list: string): string => `DELETE FROM interview_consents WHERE interview_id IN (${list}) RETURNING interview_id`;
export const eraseScorecardsSql = (list: string): string => `DELETE FROM interview_scorecards WHERE interview_id IN (${list}) RETURNING id`;
/** The candidate's own fields, and the lower-cased address their applications hold for the one-per-opening rule, so it goes with the address. */
export const REDACT_CANDIDATE_SQL = `WITH keys AS (
    UPDATE interview_applications SET email_key = NULL WHERE candidate_id = :id AND email_key IS NOT NULL RETURNING id)
  UPDATE interview_candidates
  SET name = :name, email = :email, headline = :headline, location = :location, notes = :notes
  WHERE id = :id AND NOT (name = :name AND email = :email)
  RETURNING id`;

/** Each application of the candidate that still holds a reason of its own: every non-null reason in `history` set to the phrase, in order. */
export const REDACT_STAGE_REASONS_SQL = `UPDATE interview_applications a
  SET history = (SELECT jsonb_agg(CASE WHEN e->>'reason' IS NULL THEN e ELSE jsonb_set(e, '{reason}', to_jsonb(:phrase::text)) END ORDER BY i)
                 FROM jsonb_array_elements(a.history) WITH ORDINALITY AS h(e, i))
  WHERE a.candidate_id = :id
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.history) AS x(e) WHERE x.e->>'reason' IS NOT NULL AND x.e->>'reason' <> :phrase)
  RETURNING a.id`;

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
  async redactStageReasons(candidateId: string): Promise<number> {
    const t = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
    return (await this.exec(REDACT_STAGE_REASONS_SQL, [t('id', candidateId), t('phrase', REDACTED_REASON)])).length;
  }
}

let current: RecordStatements | null = null;
export function recordStatements(): RecordStatements {
  return (current ??= config.mock?.aurora
    ? new MemoryRecordStatements()
    : new SqlRecordStatements(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params)));
}
export function setRecordStatements(next: RecordStatements | null): void { current = next; }
