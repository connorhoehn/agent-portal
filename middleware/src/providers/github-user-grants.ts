// GitHub user grants (docs/microvm-runner-design.md §8, §10 item 5, §13): storage,
// plus the one read of the token itself.
//
// The row says a person linked GitHub and names the Secrets Manager secret
// (`orgiq/github-user/<sub>`) that holds their user-to-server token. The token
// is read only here, only by the BFF, only at the PR step, and is never
// returned to anything that sends it on: the microVM never sees it.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { githubUserGrants } from '../mock/github-user-grants.js';

export interface GithubUserGrant {
  user_sub: string;
  tenant: string;
  github_login: string;
  github_user_id: number;
  noreply_email: string;
  secret_arn: string;
  scopes: string[] | null;
  granted_at: string;
  refreshed_at: string | null;
  revoked_at: string | null;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }

/** The actor's grant when it is live (not revoked), else null. */
export async function liveGithubUserGrant(userSub: string): Promise<GithubUserGrant | null> {
  if (config.mock.aurora) {
    const row = githubUserGrants.rows().find((g) => g.user_sub === userSub && !g.revoked_at);
    return row ? { ...row, scopes: row.scopes ? [...row.scopes] : null } : null;
  }
  try {
    const rows = await exec(
      `SELECT user_sub, tenant, github_login, github_user_id, noreply_email, secret_arn,
              array_to_json(scopes)::text AS scopes, granted_at::text AS granted_at,
              refreshed_at::text AS refreshed_at, revoked_at::text AS revoked_at
         FROM github_user_grants WHERE user_sub = :sub AND revoked_at IS NULL`,
      [s('sub', userSub)],
    );
    const r = rows[0];
    if (!r) return null;
    let scopes: string[] | null = null;
    try { scopes = r['scopes'] ? (JSON.parse(String(r['scopes'])) as string[]) : null; } catch { scopes = null; }
    return {
      user_sub: String(r['user_sub']), tenant: String(r['tenant']), github_login: String(r['github_login']),
      github_user_id: Number(r['github_user_id']), noreply_email: String(r['noreply_email']), secret_arn: String(r['secret_arn']),
      scopes, granted_at: String(r['granted_at'] ?? ''),
      refreshed_at: r['refreshed_at'] == null ? null : String(r['refreshed_at']),
      revoked_at: r['revoked_at'] == null ? null : String(r['revoked_at']),
    };
  } catch (err) {
    // A cluster without the table has no grants: the job is held back, never sent on.
    if (/relation .*github_user_grants.* does not exist/i.test((err as Error).message ?? '')) return null;
    throw err;
  }
}

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Only a secret under `<PROJECT_PREFIX>/github-user/` (sweep 4 M4). The BFF's
 * task role may also read `<prefix>/github-app*`, so a grant row naming the
 * App's secret would otherwise make the PR step send the App's credential to
 * GitHub as a bearer token. A grant row is data; the prefix is the boundary.
 */
export function githubUserSecretArnAllowed(secretArn: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const prefix = (env['PROJECT_PREFIX'] ?? '').trim() || 'orgiq';
  const re = new RegExp(`^arn:aws:secretsmanager:[a-z0-9-]+:\\d{12}:secret:${escapeRe(prefix)}/github-user/[A-Za-z0-9_+=.@-][A-Za-z0-9/_+=.@-]*$`);
  return typeof secretArn === 'string' && secretArn.length <= 2048 && re.test(secretArn);
}

/**
 * The user token behind a grant. The secret is either the bare token or JSON
 * carrying `access_token` (the OAuth exchange's own field) or `token`. Throws
 * when it cannot be read or holds neither: a PR is never opened as anyone else.
 */
export async function readGithubUserToken(secretArn: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!githubUserSecretArnAllowed(secretArn, env)) {
    throw new Error('github user grant names no secret under <prefix>/github-user/');
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const region = secretArn.split(':')[3] ?? process.env['AWS_REGION'] ?? 'us-east-1';
  const out = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = (out.SecretString ?? '').trim();
  if (!raw) throw new Error('github user secret is empty');
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { access_token?: unknown; token?: unknown };
    const tok = typeof parsed.access_token === 'string' ? parsed.access_token : typeof parsed.token === 'string' ? parsed.token : '';
    if (!tok.trim()) throw new Error('github user secret carries no access_token');
    return tok.trim();
  }
  return raw;
}
