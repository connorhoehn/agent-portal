// Credential issues (DE-45): the audit row every repository-token mint writes.
//
// Storage only. lib/repo-token-provider.ts::mintAuditedRepoToken is the one
// writer; the token itself is never passed in, so it cannot be stored. A
// cluster that has not loaded schema/credential_issues_schema.sql logs and
// drops the row rather than failing the run (the mint has already happened;
// refusing the clone now would only lose the work, not the exposure).

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { hasColumns } from './column-probe.js';
import type { RepoPermissions, RepoTokenProviderKind } from '../lib/repo-token-provider.js';
import {
  mockInsertCredentialIssue, mockListCredentialIssues, type CredentialIssueRow,
} from '../mock/credential-issues.js';

export type { CredentialIssueRow };

/** What was handed out (docs/microvm-runner-design.md §13). Absent = a repository token from before the runner. */
export type CredentialKind = 'repo-install' | 'repo-user' | 'run-token' | 'presign';
/** Who issued a non-repository credential: the actor's GitHub grant, the lab run-token signer, the S3 presigner. */
export type CredentialIssuer = RepoTokenProviderKind | 'github-user' | 'lab' | 's3';

export interface CredentialIssueInput {
  runRef: string;
  repo: string;
  provider: CredentialIssuer;
  /** Repository permissions for a repo token; `{lab:'run'}`, `{s3:'put'|'get'}` for the runner's others. */
  permissions: RepoPermissions | Record<string, string>;
  expiresAt: string | null;
  callerSub: string | null;
  /** The runtime session the credential went to (the microVM runner). */
  sessionId?: string | null;
  kind?: CredentialKind | null;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function sOrNull(name: string, value: string | null): SqlParameter {
  return value == null ? { name, value: { isNull: true } } : s(name, value);
}

/**
 * The permissions as stored: only the keys a credential of that kind can carry,
 * nothing a caller smuggled in. A repository token keeps `contents` and
 * `pull_requests`; a run token is `{lab:'run'}`; a presigned URL `{s3:'put'|'get'}`.
 */
function cleanPermissions(p: RepoPermissions | Record<string, string>, kind: CredentialKind | null | undefined): Record<string, string> {
  const r = p as Record<string, unknown>;
  if (kind === 'run-token') return { lab: 'run' };
  if (kind === 'presign') return { s3: r['s3'] === 'get' ? 'get' : 'put' };
  if (kind === 'repo-user') return { pull_requests: 'write' };
  return { contents: r['contents'] === 'write' ? 'write' : 'read', ...(r['pull_requests'] === 'write' ? { pull_requests: 'write' } : {}) };
}

export async function recordCredentialIssue(input: CredentialIssueInput): Promise<void> {
  const permissions = cleanPermissions(input.permissions, input.kind);
  const sessionId = input.sessionId ?? null;
  const kind = input.kind ?? null;
  if (config.mock.aurora) {
    mockInsertCredentialIssue({
      run_ref: input.runRef, repo: input.repo, provider: input.provider, permissions,
      expires_at: input.expiresAt, caller_sub: input.callerSub,
      ...(sessionId || kind ? { session_id: sessionId, kind } : {}),
    });
    return;
  }
  try {
    // session_id / kind (the microVM runner) are additive; a cluster that has
    // not re-applied the file still takes the row, without them.
    const runner = (sessionId !== null || kind !== null) && await hasColumns('credential_issues', ['session_id', 'kind']).catch(() => false);
    await exec(
      `INSERT INTO credential_issues (run_ref, repo, provider, permissions, expires_at, caller_sub${runner ? ', session_id, kind' : ''})
       VALUES (:run, :repo, :provider, :perms::jsonb, :exp::timestamptz, :caller${runner ? ', :session, :kind' : ''})`,
      [s('run', input.runRef), s('repo', input.repo), s('provider', input.provider),
        s('perms', JSON.stringify(permissions)), sOrNull('exp', input.expiresAt), sOrNull('caller', input.callerSub),
        ...(runner ? [sOrNull('session', sessionId), sOrNull('kind', kind)] : [])],
    );
  } catch (err) {
    if (/relation .*credential_issues.* does not exist/i.test((err as Error).message ?? '')) {
      console.warn('[credential-issues] schema/credential_issues_schema.sql has not been applied — mint not audited');
      return;
    }
    throw err;
  }
}

/** Recent issues, newest first — by repo or by run. */
export async function listCredentialIssues(filter: { repo?: string; runRef?: string } = {}, limit = 100): Promise<CredentialIssueRow[]> {
  if (config.mock.aurora) return mockListCredentialIssues(filter).slice(0, limit);
  const where: string[] = [];
  const params: SqlParameter[] = [];
  if (filter.repo) { where.push('repo = :repo'); params.push(s('repo', filter.repo)); }
  if (filter.runRef) { where.push('run_ref = :run'); params.push(s('run', filter.runRef)); }
  const rows = await exec(
    `SELECT id::text AS id, run_ref, repo, provider, permissions::text AS permissions,
            expires_at, caller_sub, created_at
       FROM credential_issues ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    run_ref: String(r['run_ref'] ?? ''),
    repo: String(r['repo'] ?? ''),
    provider: String(r['provider'] ?? 'pat') as CredentialIssueRow['provider'],
    permissions: (() => { try { return JSON.parse(String(r['permissions'] ?? '{}')) as Record<string, string>; } catch { return { contents: 'read' }; } })(),
    expires_at: r['expires_at'] == null ? null : String(r['expires_at']),
    caller_sub: r['caller_sub'] == null ? null : String(r['caller_sub']),
    created_at: String(r['created_at'] ?? ''),
  }));
}
