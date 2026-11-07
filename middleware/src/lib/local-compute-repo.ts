// Which repos a local-compute machine may be handed (docs/next-steps.md
// section 7 for the shape, section 9 item 3 for the hosts). Kept apart from
// routes/local-compute.ts so the worker contract test can hold it against
// tools/local-compute-policy.mjs without loading the route's providers.

import { REPO_FULL_NAME_RE } from './repo-token-provider.js';

const REPO_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The git hosts a machine may be handed a repo on: github.com plus
 * LOCAL_ALLOWED_REPO_HOSTS (comma list of bare host names, for GitHub
 * Enterprise or GitLab; docs/next-steps.md section 9 item 3). An entry that is
 * not a plain host name (scheme, path, port, user) is ignored. The worker
 * reads the same variable with the same rules (tools/local-compute-policy.mjs
 * `allowedRepoHosts`); the contract test holds the two to one answer.
 */
export function allowedRepoHosts(raw: string | undefined = process.env['LOCAL_ALLOWED_REPO_HOSTS']): string[] {
  const hosts = ['github.com'];
  for (const entry of String(raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)) {
    if (REPO_HOST_RE.test(entry) && !hosts.includes(entry)) hosts.push(entry);
  }
  return hosts;
}

/**
 * The one shape of `repo` a machine is handed: a repository on an allowed
 * host (github.com, plus LOCAL_ALLOWED_REPO_HOSTS), as `owner/name`,
 * `https://<host>/owner/name[.git]` or `git@<host>:owner/name[.git]`, with
 * owner/name held to the same pattern the GitHub token provider uses
 * (lib/repo-token-provider.ts). A bare `owner/name` is stored as its
 * github.com https URL. Anything else is null: the worker clones this string,
 * and it once reached a shell (docs/next-steps.md section 7, middleware).
 */
export function normaliseRepo(raw: string, hosts: readonly string[] = allowedRepoHosts()): string | null {
  // The prefix decides the host; nothing else in the string does (a check for
  // "contains github.com" passed `evil.com/github.com` through verbatim).
  const prefix = hosts.flatMap((h) => [`https://${h}/`, `git@${h}:`]).find((p) => raw.startsWith(p)) ?? '';
  const full = raw.slice(prefix.length).replace(/\.git$/, '');
  if (!REPO_FULL_NAME_RE.test(full) || full.split('/').some((seg) => /^\.+$/.test(seg) || seg.startsWith('-'))) return null;
  return prefix ? raw : `https://github.com/${raw}`;
}
