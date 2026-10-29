// Repository tokens, per run (DE-45): the interface every clone and push asks,
// and the providers behind it.
//
// Before this a "connection" was one long-lived personal access token shared
// by every codebase and initiative that named it, valid until revoked, with
// whatever scopes its owner gave it. The box runs Claude Code with
// permissions skipped and public egress, so whatever it can read it can send
// anywhere; a token broader than one run needs is a token the next prompt can
// exfiltrate. The fix is a short-lived, one-repository token minted per run
// (GitHub App installation tokens: one hour, the repositories and permissions
// named at mint), and an audit row per mint so "which runs could push to
// repo X yesterday" has an answer.
//
// Three providers behind one interface:
//
//   github-app  lib/github-app-token.ts — the real thing. Needs the app id,
//               the private key and GitHub; see docs/github-app-tokens-runbook.md.
//   pat         the stored connection credential, unchanged (legacy). The
//               conservative default where no app is configured, so nothing
//               that works today stops working; every mint still writes its
//               audit row, with no expiry.
//   local       dev:mock. Mints an obviously fake token the fake microVM
//               ignores, so the whole path — mint, audit, the entrypoint that
//               takes the token out of the shell — runs offline.
//
// Selection is `repoTokenProvider()`; tests inject with `_setRepoTokenProvider`.

import { randomBytes } from 'node:crypto';

export type RepoPermissions = {
  contents: 'read' | 'write';
  pull_requests?: 'write';
};

export interface RepoTokenContext {
  /** `run:<id>`, `bot-run:<id>`, `clone:<session>` — whatever names the run. */
  runRef: string;
  /** Who caused the run (session sub); null for a cron bot. */
  callerSub: string | null;
  /** The connection the legacy provider reads; the app provider ignores it. */
  connectionName?: string | null;
}

export interface RepoToken {
  token: string;
  /** ISO instant; null for a PAT, which does not expire per run. */
  expiresAt: string | null;
  provider: RepoTokenProviderKind;
}

export type RepoTokenProviderKind = 'github-app' | 'pat' | 'local';

export interface RepoTokenProvider {
  readonly kind: RepoTokenProviderKind;
  /**
   * A token scoped to ONE repository with exactly `perms`. Throws when it
   * cannot mint one — never falls back to a broader credential.
   */
  mintRepoToken(repoFullName: string, perms: RepoPermissions, ctx: RepoTokenContext): Promise<RepoToken>;
}

export const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export function assertRepoFullName(repoFullName: string): void {
  // `.` / `..` match the character class but are path segments, not names —
  // `../etc` would walk the GitHub API URL the provider builds from it.
  if (!REPO_FULL_NAME_RE.test(repoFullName) || repoFullName.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw new Error(`"${repoFullName}" is not an owner/name repository`);
  }
}

/** The legacy provider: the connection's stored credential, broad as ever. */
export class ConnectionPatProvider implements RepoTokenProvider {
  readonly kind = 'pat' as const;
  constructor(private readonly borrow: (connectionName: string) => Promise<string>) {}
  async mintRepoToken(repoFullName: string, _perms: RepoPermissions, ctx: RepoTokenContext): Promise<RepoToken> {
    assertRepoFullName(repoFullName);
    if (!ctx.connectionName) throw new Error(`no GitHub connection to clone or push ${repoFullName} with`);
    return { token: await this.borrow(ctx.connectionName), expiresAt: null, provider: 'pat' };
  }
}

/** dev:mock — a fake, per-mint token that the fake microVM never looks at. */
export class LocalFakeTokenProvider implements RepoTokenProvider {
  readonly kind = 'local' as const;
  readonly minted: Array<{ repoFullName: string; perms: RepoPermissions; ctx: RepoTokenContext; token: string }> = [];
  constructor(private readonly now: () => number = Date.now) {}
  async mintRepoToken(repoFullName: string, perms: RepoPermissions, ctx: RepoTokenContext): Promise<RepoToken> {
    assertRepoFullName(repoFullName);
    const token = `orgiq-local-${randomBytes(12).toString('hex')}`;
    this.minted.push({ repoFullName, perms, ctx, token });
    return { token, expiresAt: new Date(this.now() + 3_600_000).toISOString(), provider: 'local' };
  }
}

let override: RepoTokenProvider | null = null;

/** Test hook: force a provider (null restores selection). */
export function _setRepoTokenProvider(p: RepoTokenProvider | null): void {
  override = p;
}

/**
 * The provider for this process. The GitHub App provider when its two
 * settings are present (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, the
 * latter normally injected from the `orgiq/github-app` secret by the task
 * definition); the local fake under MOCK_AGENTCORE; else the PAT provider —
 * existing behaviour, kept.
 */
export async function repoTokenProvider(): Promise<RepoTokenProvider> {
  if (override) return override;
  const appId = (process.env['GITHUB_APP_ID'] ?? '').trim();
  const key = process.env['GITHUB_APP_PRIVATE_KEY'] ?? '';
  if (appId && key.trim()) {
    const { GitHubAppTokenProvider } = await import('./github-app-token.js');
    return (override = new GitHubAppTokenProvider({ appId, privateKeyPem: key }));
  }
  if (process.env['MOCK_AGENTCORE'] === 'true') return (override = new LocalFakeTokenProvider());
  const { borrowApiKey } = await import('../providers/connected-sources.js');
  return (override = new ConnectionPatProvider(borrowApiKey));
}

/**
 * Mint a token for one run and write its audit row (never the token). The
 * one call sites use; the audit write failing is logged, not fatal — a run
 * must not stop because the ledger is unavailable.
 */
export async function mintAuditedRepoToken(
  repoFullName: string, perms: RepoPermissions, ctx: RepoTokenContext,
): Promise<RepoToken> {
  const provider = await repoTokenProvider();
  const minted = await provider.mintRepoToken(repoFullName, perms, ctx);
  try {
    const { recordCredentialIssue } = await import('../providers/credential-issues.js');
    await recordCredentialIssue({
      runRef: ctx.runRef, repo: repoFullName, provider: minted.provider,
      permissions: perms, expiresAt: minted.expiresAt, callerSub: ctx.callerSub,
    });
  } catch (err) {
    console.warn('[repo-token] could not record the credential issue:', (err as Error).message);
  }
  return minted;
}
