// The two invite stores behave the same (lib/interviews/invite/store.ts; docs/interviews-tenant-plan.md row I2.1).
//
// One contract over both: the memory store writes the registered fixture; the SQL store runs its real
// statements against an executor that keeps the table the way the RDS Data API answers it (snake_case
// columns, TIMESTAMPTZ as '2026-11-16 10:00:00.000' text). A second block holds every statement to
// schema/interviews_schema.sql.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { MemoryInviteStore, type InviteStore, type NewInvite } from '../store.js';
import {
  FIND_INVITE_BY_HASH_SQL, GET_INVITE_SQL, INVITE_STATEMENTS, ISSUE_INVITE_SQL, LATEST_INVITE_SQL, RECORD_OPENING_SQL, REVOKE_INVITE_SQL, SET_ADMISSION_SQL, SqlInviteStore,
} from '../store-sql.js';
import type { SqlExec } from '../../store-sql.js';
import { hashInviteToken, newInviteToken } from '../token.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));
const value = (params: SqlParameter[] | undefined, name: string): string => {
  const p = params?.find((x) => x.name === name);
  return String((p?.value as { stringValue?: string } | undefined)?.stringValue ?? '');
};

/** interview_invites as the Data API would keep and answer it. */
function invitesTableExec(): { exec: SqlExec; seen: string[] } {
  const table: Record<string, unknown>[] = [];
  const seen: string[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  const exec: SqlExec = async (sql, params) => {
    seen.push(sql);
    const v = (n: string) => value(params, n);
    if (sql === ISSUE_INVITE_SQL) {
      for (const r of table) if (r['interview_id'] === v('interview_id') && r['revoked_at'] === null) { r['revoked_at'] = ts(v('issued_at')); r['revoked_by'] = v('issued_by'); }
      const row = {
        id: v('id'), interview_id: v('interview_id'), token_hash: v('token_hash'), issued_by: v('issued_by'), issued_at: ts(v('issued_at')),
        expires_at: ts(v('expires_at')), revoked_at: null, revoked_by: null, first_opened_at: null, last_opened_at: null, open_count: 0, session_hash: null,
        admission_state: 'not-knocked', knocked_at: null, admission_decided_at: null,
      };
      table.push(row);
      return out([row]);
    }
    if (sql === FIND_INVITE_BY_HASH_SQL) return out(table.filter((r) => r['token_hash'] === v('token_hash')));
    if (sql === GET_INVITE_SQL) return out(table.filter((r) => r['id'] === v('id')));
    if (sql === LATEST_INVITE_SQL) {
      return out(table.filter((r) => r['interview_id'] === v('interview_id'))
        .sort((a, b) => String(b['issued_at']).localeCompare(String(a['issued_at'])) || String(b['id']).localeCompare(String(a['id']))).slice(0, 1));
    }
    if (sql === REVOKE_INVITE_SQL) {
      for (const r of table) if (r['interview_id'] === v('interview_id') && r['revoked_at'] === null) { r['revoked_at'] = ts(v('at')); r['revoked_by'] = v('by'); }
      return [];
    }
    if (sql === RECORD_OPENING_SQL) {
      const r = table.find((x) => x['id'] === v('id') && x['revoked_at'] === null);
      if (!r) return [];
      r['first_opened_at'] ??= ts(v('at'));
      r['last_opened_at'] = ts(v('at'));
      r['open_count'] = Number(r['open_count']) + 1;
      r['session_hash'] = v('session_hash');
      r['admission_state'] = 'not-knocked'; r['knocked_at'] = null; r['admission_decided_at'] = null;
      return out([r]);
    }
    if (sql === SET_ADMISSION_SQL) {
      const r = table.find((x) => x['id'] === v('id') && x['revoked_at'] === null && x['session_hash'] === v('session_hash') && x['admission_state'] === v('was'));
      if (!r) return [];
      const orNull = (n: string) => ((params?.find((p) => p.name === n)?.value as { isNull?: boolean } | undefined)?.isNull ? null : ts(v(n)));
      r['admission_state'] = v('admission_state'); r['knocked_at'] = orNull('knocked_at'); r['admission_decided_at'] = orNull('admission_decided_at');
      return out([r]);
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
  return { exec, seen };
}

afterEach(() => fixtureRegistry.resetAll('default'));

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const draft = (interviewId: string, minute: number): NewInvite & { token: string } => {
  const token = newInviteToken();
  return { token, interviewId, tokenHash: hashInviteToken(token), issuedBy: 'u-greta', issuedAt: T(minute), expiresAt: T(minute + 60) };
};
const strip = ({ token: _t, ...rest }: NewInvite & { token: string }): NewInvite => rest;

describe.each([
  ['memory', () => new MemoryInviteStore() as InviteStore],
  ['sql', () => new SqlInviteStore(invitesTableExec().exec) as InviteStore],
])('the %s invite store', (_name, make) => {
  let store: InviteStore;
  beforeEach(() => { store = make(); });

  it('issues an invite that is live, unopened and keeps only the hash', async () => {
    const d = draft('iv-1', 0);
    const row = await store.issueInvite(strip(d));
    expect(row).toMatchObject({ interviewId: 'iv-1', tokenHash: d.tokenHash, issuedBy: 'u-greta', issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      revokedAt: null, firstOpenedAt: null, lastOpenedAt: null, openCount: 0, sessionHash: null });
    expect(row.id).toMatch(/^inv-/);
    expect(JSON.stringify(row)).not.toContain(d.token);
    expect(await store.findInviteByHash(d.tokenHash)).toEqual(row);
    expect(await store.getInvite(row.id)).toEqual(row);
    expect(await store.findInviteByHash(hashInviteToken(newInviteToken()))).toBeNull();
  });

  it('keeps one live invite per interview: issuing again revokes the one before, and only that interview\'s', async () => {
    const first = await store.issueInvite(strip(draft('iv-1', 0)));
    const other = await store.issueInvite(strip(draft('iv-2', 1)));
    const second = await store.issueInvite(strip(draft('iv-1', 2)));
    expect(await store.getInvite(first.id)).toMatchObject({ revokedAt: T(2), revokedBy: 'u-greta' });
    expect((await store.getInvite(other.id))!.revokedAt).toBeNull();
    expect((await store.getInvite(second.id))!.revokedAt).toBeNull();
    expect((await store.latestInvite('iv-1'))!.id).toBe(second.id);
    expect(await store.latestInvite('iv-9')).toBeNull();
  });

  it('records every opening, keeps the first, and makes the newest guest session the only one', async () => {
    const row = await store.issueInvite(strip(draft('iv-1', 0)));
    await store.recordOpening(row.id, T(5), 'a'.repeat(64));
    const again = await store.recordOpening(row.id, T(9), 'b'.repeat(64));
    expect(again).toMatchObject({ firstOpenedAt: T(5), lastOpenedAt: T(9), openCount: 2, sessionHash: 'b'.repeat(64) });
  });

  it('keeps the current session\'s admission: a compare-and-set on the session and the state, reset by a new opening', async () => {
    const row = await store.issueInvite(strip(draft('iv-1', 0)));
    expect(row).toMatchObject({ admissionState: 'not-knocked', knockedAt: null, admissionDecidedAt: null });
    await store.recordOpening(row.id, T(5), 'a'.repeat(64));
    const waiting = await store.setAdmission(row.id, 'a'.repeat(64), 'not-knocked', { admissionState: 'waiting', knockedAt: T(6), admissionDecidedAt: null });
    expect(waiting).toMatchObject({ admissionState: 'waiting', knockedAt: T(6), admissionDecidedAt: null });
    expect(await store.setAdmission(row.id, 'a'.repeat(64), 'not-knocked', { admissionState: 'admitted', knockedAt: T(6), admissionDecidedAt: T(7) })).toBeNull();
    expect(await store.setAdmission(row.id, 'b'.repeat(64), 'waiting', { admissionState: 'admitted', knockedAt: T(6), admissionDecidedAt: T(7) })).toBeNull();
    expect(await store.setAdmission(row.id, 'a'.repeat(64), 'waiting', { admissionState: 'admitted', knockedAt: T(6), admissionDecidedAt: T(7) }))
      .toMatchObject({ admissionState: 'admitted', admissionDecidedAt: T(7) });
    expect(await store.recordOpening(row.id, T(9), 'b'.repeat(64))).toMatchObject({ admissionState: 'not-knocked', knockedAt: null, admissionDecidedAt: null });
    await store.revokeInvite('iv-1', T(10), 'u-greta');
    expect(await store.setAdmission(row.id, 'b'.repeat(64), 'not-knocked', { admissionState: 'waiting', knockedAt: T(10), admissionDecidedAt: null })).toBeNull();
  });

  it('revokes the live invite, and a revoked invite records no opening', async () => {
    const row = await store.issueInvite(strip(draft('iv-1', 0)));
    const revoked = await store.revokeInvite('iv-1', T(3), 'u-greta');
    expect(revoked).toMatchObject({ id: row.id, revokedAt: T(3), revokedBy: 'u-greta' });
    expect(await store.recordOpening(row.id, T(4), 'c'.repeat(64))).toBeNull();
    expect(await store.revokeInvite('iv-9', T(3), 'u-greta')).toBeNull();
  });
});

describe('every invite statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS interview_invites \(([\s\S]*?)\n\);/.exec(ddl)?.[1] ?? '';
  const columns = new Set([...table.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]));

  it('declares the table, its one-live index, and every column a statement names', () => {
    expect(columns.size).toBeGreaterThan(10);
    expect(ddl).toMatch(/UNIQUE INDEX IF NOT EXISTS interview_invites_one_live_idx ON interview_invites \(interview_id\) WHERE revoked_at IS NULL/);
    for (const sql of INVITE_STATEMENTS) {
      const named = [...sql.matchAll(/\b([a-z]+(?:_[a-z]+)+|id)\b/g)].map((m) => m[1]!)
        .filter((w) => !['interview_invites', 'one_live_idx'].includes(w));
      for (const col of named) expect([col, columns.has(col)]).toEqual([col, true]);
    }
  });
});
