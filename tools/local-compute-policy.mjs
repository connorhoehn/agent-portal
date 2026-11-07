// local-compute-policy — what a local-compute run may do and which repos it may clone.
//
// Pure functions, kept out of local-compute-worker.mjs (which starts its loop
// on import) so the middleware's contract tests can call them in a fresh node.
// The middleware's repo check (routes/local-compute.ts `normaliseRepo`) reads
// the same LOCAL_ALLOWED_REPO_HOSTS with the same rules.

import { resolve } from 'node:path';

// The repo's own test commands (docs/next-steps.md section 9 item 3). A
// `local:task` that cannot run the tests is useless for the research loop it
// exists for, so they are on by default — but ONLY for a run whose working
// directory is the checkout this worker cloned (toolsForRun below). An edit
// to package.json plus `npm test` is a shell inside that checkout; outside it
// (no repo named, so the worker's own directory, possibly the operator's
// home) it would be a shell anywhere.
export const TEST_TOOLS = [
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx jest:*)', 'Bash(npx vitest:*)', 'Bash(pytest:*)',
];

// A code change in the checkout: read and search it, edit it, follow the
// org's skills, look at or commit its git state, and run its tests. No
// general shell and no network beyond what a test command does.
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Skill',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(ls:*)',
  ...TEST_TOOLS,
];

/** LOCAL_ALLOWED_TOOLS (comma list) replaces the default list; unset = DEFAULT_ALLOWED_TOOLS. */
export function allowedToolsFrom(raw) {
  return raw ? raw.split(',').map((t) => t.trim()).filter(Boolean) : [...DEFAULT_ALLOWED_TOOLS];
}

/**
 * The tool rules for one run. The test commands stay only when the run has a
 * cloned repo and its working directory IS that clone; otherwise they are
 * removed, whatever list they came from, so `npm test` is refused (dontAsk)
 * rather than run in a directory this worker does not own.
 */
export function toolsForRun(allowed, { cwd, clonePath }) {
  const inClone = !!clonePath && !!cwd && resolve(cwd) === resolve(clonePath);
  return inClone ? [...allowed] : allowed.filter((t) => !TEST_TOOLS.includes(t));
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * github.com plus LOCAL_ALLOWED_REPO_HOSTS (comma list of bare host names,
 * e.g. `github.example.com,gitlab.com`) for GitHub Enterprise or GitLab.
 * Entries that are not a plain host name (a scheme, a path, a port, a user)
 * are dropped and returned as `ignored`, never half-used.
 */
export function allowedRepoHosts(raw) {
  const hosts = ['github.com'];
  const ignored = [];
  for (const entry of String(raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)) {
    if (!HOST_RE.test(entry)) { ignored.push(entry); continue; }
    if (!hosts.includes(entry)) hosts.push(entry);
  }
  return { hosts, ignored };
}

const FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * A clonable repo URL on an allowed host, or null: `https://<host>/owner/name[.git]`
 * or `git@<host>:owner/name[.git]`, the prefix deciding the host and nothing
 * else in the string doing so. A bare `owner/name` is GitHub's https URL.
 * owner/name is held to the GitHub token provider's pattern, and no segment
 * may be all dots or start with a dash (git would read it as an option).
 */
export function normaliseRepoUrl(raw, hosts = ['github.com']) {
  if (typeof raw !== 'string' || !raw) return null;
  const prefixes = hosts.flatMap((h) => [`https://${h}/`, `git@${h}:`]);
  const prefix = prefixes.find((p) => raw.startsWith(p)) ?? '';
  const full = raw.slice(prefix.length).replace(/\.git$/, '');
  if (!FULL_NAME_RE.test(full) || full.split('/').some((seg) => /^\.+$/.test(seg) || seg.startsWith('-'))) return null;
  return prefix ? raw : `https://github.com/${raw}`;
}
