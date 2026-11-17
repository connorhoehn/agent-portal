// The invites SQL store (schema/interviews_schema.sql `interview_invites`), over the RDS Data API's `exec`
// shape, injected as lib/interviews/store-sql.ts injects it so the contract test runs the statements
// against canned rows. Timestamps travel as ISO text, CAST in the statement; an absent value is NULL.
//
// Issuing is one statement: a data-modifying CTE revokes the interview's live invite and the INSERT
// adds the new one, so no reader ever sees two live invites (the partial unique index on
// `interview_id WHERE revoked_at IS NULL` holds the database to it). The INSERT selects FROM the CTE's
// count so the revoke runs to completion first: an unread data-modifying CTE runs after the main
// statement, and the insert would meet the old live row in the index.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { Invite, InviteStore, NewInvite } from './store.js';
import { newInviteId } from './token.js';

const COLUMNS = 'id, interview_id, token_hash, issued_by, issued_at, expires_at, revoked_at, revoked_by, first_opened_at, last_opened_at, open_count, session_hash';

export const ISSUE_INVITE_SQL = `WITH revoked AS (
    UPDATE interview_invites SET revoked_at = CAST(:issued_at AS TIMESTAMPTZ), revoked_by = :issued_by
    WHERE interview_id = :interview_id AND revoked_at IS NULL
    RETURNING id
  )
  INSERT INTO interview_invites (id, interview_id, token_hash, issued_by, issued_at, expires_at)
  SELECT :id, :interview_id, :token_hash, :issued_by, CAST(:issued_at AS TIMESTAMPTZ), CAST(:expires_at AS TIMESTAMPTZ)
  FROM (SELECT COUNT(*) FROM revoked) AS done
  RETURNING ${COLUMNS}`;
export const FIND_INVITE_BY_HASH_SQL = `SELECT ${COLUMNS} FROM interview_invites WHERE token_hash = :token_hash`;
export const GET_INVITE_SQL = `SELECT ${COLUMNS} FROM interview_invites WHERE id = :id`;
export const LATEST_INVITE_SQL = `SELECT ${COLUMNS} FROM interview_invites WHERE interview_id = :interview_id
  ORDER BY issued_at DESC, id DESC LIMIT 1`;
export const REVOKE_INVITE_SQL = `UPDATE interview_invites SET revoked_at = CAST(:at AS TIMESTAMPTZ), revoked_by = :by
  WHERE interview_id = :interview_id AND revoked_at IS NULL`;
export const RECORD_OPENING_SQL = `UPDATE interview_invites
  SET first_opened_at = COALESCE(first_opened_at, CAST(:at AS TIMESTAMPTZ)), last_opened_at = CAST(:at AS TIMESTAMPTZ),
    open_count = open_count + 1, session_hash = :session_hash
  WHERE id = :id AND revoked_at IS NULL
  RETURNING ${COLUMNS}`;

export const INVITE_STATEMENTS = [
  ISSUE_INVITE_SQL, FIND_INVITE_BY_HASH_SQL, GET_INVITE_SQL, LATEST_INVITE_SQL, REVOKE_INVITE_SQL, RECORD_OPENING_SQL,
] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : isoOf(v));

export function inviteFromRow(r: Record<string, unknown>): Invite {
  return {
    id: String(r['id']), interviewId: String(r['interview_id']), tokenHash: String(r['token_hash']),
    issuedBy: String(r['issued_by']), issuedAt: isoOf(r['issued_at']), expiresAt: isoOf(r['expires_at']),
    revokedAt: isoOrNull(r['revoked_at']), revokedBy: strOrNull(r['revoked_by']),
    firstOpenedAt: isoOrNull(r['first_opened_at']), lastOpenedAt: isoOrNull(r['last_opened_at']),
    openCount: Number(r['open_count'] ?? 0), sessionHash: strOrNull(r['session_hash']),
  };
}

const first = (rows: Record<string, unknown>[]): Invite | null => (rows[0] ? inviteFromRow(rows[0]) : null);

export class SqlInviteStore implements InviteStore {
  constructor(private readonly exec: SqlExec) {}

  async issueInvite(input: NewInvite): Promise<Invite> {
    const row = first(await this.exec(ISSUE_INVITE_SQL, [
      text('id', newInviteId()), text('interview_id', input.interviewId), text('token_hash', input.tokenHash),
      text('issued_by', input.issuedBy), text('issued_at', input.issuedAt), text('expires_at', input.expiresAt),
    ]));
    if (!row) throw new Error('The invite was not saved.');
    return row;
  }

  async findInviteByHash(tokenHash: string): Promise<Invite | null> {
    return first(await this.exec(FIND_INVITE_BY_HASH_SQL, [text('token_hash', tokenHash)]));
  }

  async getInvite(id: string): Promise<Invite | null> { return first(await this.exec(GET_INVITE_SQL, [text('id', id)])); }

  async latestInvite(interviewId: string): Promise<Invite | null> {
    return first(await this.exec(LATEST_INVITE_SQL, [text('interview_id', interviewId)]));
  }

  async revokeInvite(interviewId: string, at: string, by: string): Promise<Invite | null> {
    await this.exec(REVOKE_INVITE_SQL, [text('interview_id', interviewId), text('at', at), text('by', by)]);
    return this.latestInvite(interviewId);
  }

  async recordOpening(id: string, at: string, sessionHash: string): Promise<Invite | null> {
    return first(await this.exec(RECORD_OPENING_SQL, [text('id', id), text('at', at), text('session_hash', sessionHash)]));
  }
}
