// GitHub App installation tokens (DE-45): one hour, one repository, exactly
// the permissions asked for.
//
// Flow, per GitHub's documented one:
//   1. Sign an app JWT (RS256, `iss` = app id, 10-minute window) with the
//      app's private key.
//   2. `GET /repos/{owner}/{repo}/installation` with it — the installation
//      the app has on that repository's owner. 404 means the app is not
//      installed there, and that is a REFUSAL: there is no fallback to a
//      stored PAT, because the whole point is that the box never holds a
//      credential broader than the one run needs.
//   3. `POST /app/installations/{id}/access_tokens` with
//      `repositories: [name]` and `permissions` — GitHub caps the token at
//      one hour and scopes it to exactly those.
//
// `fetch` and the clock are injectable so the provider is tested against a
// fake GitHub (lib/__tests__/github-app-token.test.ts) with no network. The
// private key never leaves this process; what the deploy machine must set up
// is in docs/github-app-tokens-runbook.md.

import { createSign } from 'node:crypto';
import {
  assertRepoFullName, type RepoPermissions, type RepoToken, type RepoTokenContext, type RepoTokenProvider,
} from './repo-token-provider.js';

export interface GitHubAppOptions {
  appId: string;
  /** PEM, RSA (the key GitHub generates for an app). */
  privateKeyPem: string;
  /** Default https://api.github.com; GitHub Enterprise sets its own. */
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (s: Buffer | string): string =>
  Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The app JWT GitHub accepts as the app itself (not an installation). */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;           // a minute of clock skew
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(privateKeyPem))}`;
}

export class GitHubAppNotInstalled extends Error {
  constructor(public readonly repoFullName: string) {
    super(`the GitHub App is not installed on ${repoFullName.split('/')[0]} — install it there, or link the repository to a connection with an installation; no PAT fallback`);
  }
}

export class GitHubAppTokenProvider implements RepoTokenProvider {
  readonly kind = 'github-app' as const;
  private readonly api: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: GitHubAppOptions) {
    if (!opts.appId.trim()) throw new Error('GitHub App id is required');
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(opts.privateKeyPem)) throw new Error('GitHub App private key must be a PEM');
    this.api = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async call<T>(path: string, init: { method?: string; token: string; body?: unknown }): Promise<{ status: number; json: T }> {
    const res = await this.fetchFn(`${this.api}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'OrgIQ-RepoToken/1.0',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: json as T };
  }

  async mintRepoToken(repoFullName: string, perms: RepoPermissions, _ctx: RepoTokenContext): Promise<RepoToken> {
    assertRepoFullName(repoFullName);
    const [owner, name] = repoFullName.split('/') as [string, string];
    const jwt = signAppJwt(this.opts.appId, this.opts.privateKeyPem, this.now());

    const inst = await this.call<{ id?: number; message?: string }>(`/repos/${owner}/${name}/installation`, { token: jwt });
    if (inst.status === 404) throw new GitHubAppNotInstalled(repoFullName);
    if (inst.status !== 200 || !inst.json?.id) {
      throw new Error(`GitHub App installation lookup for ${repoFullName} failed: HTTP ${inst.status}${inst.json?.message ? ` — ${inst.json.message}` : ''}`);
    }

    const permissions: Record<string, string> = { contents: perms.contents, metadata: 'read' };
    if (perms.pull_requests) permissions['pull_requests'] = perms.pull_requests;
    const minted = await this.call<{ token?: string; expires_at?: string; message?: string; repositories?: Array<{ full_name?: string }> }>(
      `/app/installations/${inst.json.id}/access_tokens`,
      { method: 'POST', token: jwt, body: { repositories: [name], permissions } },
    );
    if (minted.status !== 201 || !minted.json?.token) {
      throw new Error(`GitHub refused an installation token for ${repoFullName}: HTTP ${minted.status}${minted.json?.message ? ` — ${minted.json.message}` : ''}`);
    }
    return {
      token: minted.json.token,
      expiresAt: minted.json.expires_at ?? new Date(this.now() + 3_600_000).toISOString(),
      provider: 'github-app',
    };
  }
}
