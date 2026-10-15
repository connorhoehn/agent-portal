// GitHub as evidence of expertise.
//
// OrgIQ's central claim is that it knows who is good at what, and today every
// expertise score in the database is synthetic — generated to look plausible.
// The scoring page can tell you Felix Rivera is 94th percentile; nothing can
// tell you why, because there is no underlying evidence at all.
//
// Commit and review history is the strongest evidence of expertise that an org
// already has lying around. It is behavioural rather than self-reported: what
// someone actually touched, how often, how recently, and whose work they were
// trusted to review. That is a far better signal than a skills matrix somebody
// filled in once.
//
// This reads, and never writes to GitHub. The token comes from the AgentCore
// credential vault for the length of one sync and is not stored here.

import { borrowApiKey } from '../providers/connected-sources.js';
import { config } from '../config.js';
import { githubIdentityRow, githubOrgRows, githubRepoRows, githubSignalRows } from '../mock/github.js';
import { mockWorkflowRuns } from '../mock/github-runs.js';

const API = 'https://api.github.com';

export interface RepoRef { owner: string; name: string; fullName: string; pushedAt?: string | null }

export interface ContributionSignal {
  /** GitHub login — reconciled to a person separately, since it may not match. */
  login: string;
  repo: string;
  commits: number;
  /** Distinct top-level paths touched — a proxy for which subsystems. */
  areas: string[];
  /** Languages of the files touched, weighted by how many. */
  languages: Record<string, number>;
  lastActivityAt: string | null;
}

export interface GitHubIdentity { login: string; name: string | null; scopes: string[] }

/** Extensions worth attributing to a language. Anything else is noise. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby',
  cs: 'C#', php: 'PHP', swift: 'Swift', scala: 'Scala', sh: 'Shell',
  sql: 'SQL', tf: 'Terraform', yml: 'YAML', yaml: 'YAML', md: 'Docs',
};

function languageOf(path: string): string | null {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? null;
}

/** Top-level directory, which is usually the subsystem boundary. */
function areaOf(path: string): string {
  const first = path.split('/')[0] ?? '';
  return first.includes('.') ? '(root)' : first || '(root)';
}

interface FetchOpts { token: string; path: string; params?: Record<string, string> }

async function gh<T>({ token, path, params }: FetchOpts): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      // Omitted rather than sent empty when there is no credential: the
      // read-only endpoints on a public repo (workflow runs, notably) answer
      // fine unauthenticated, but `Bearer ` with nothing after it is a
      // malformed credential and GitHub 401s it.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OrgIQ-Connector/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 401 || res.status === 403) {
    // Distinguish the two things that look identical from the outside: a token
    // that is wrong, and a token that is right but rate limited.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
      throw new Error(`GitHub rate limit reached; it resets at ${when}`);
    }
    throw new Error(`GitHub rejected the credential (HTTP ${res.status}) — check the token's scopes`);
  }
  if (!res.ok) throw new Error(`GitHub ${path} failed: HTTP ${res.status}`);
  return await res.json() as T;
}

/**
 * Open a pull request.
 *
 * The one write this connector does, and it is deliberately the only one — the
 * agent pushes a branch and this proposes it for merge; a human still merges.
 * A PR is a proposal, not a commit to main, which is the right amount of
 * authority to hand an automated pipeline.
 *
 * Idempotent-ish: if a PR already exists for the branch, GitHub returns 422 and
 * we surface the existing one rather than treating a re-delivery as an error.
 */
export async function openPullRequest(
  providerName: string,
  input: { owner: string; repo: string; head: string; base: string; title: string; body: string },
): Promise<{ url: string; number: number }> {
  const token = await borrowApiKey(providerName);
  const res = await fetch(`${API}/repos/${input.owner}/${input.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OrgIQ-Connector/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body }),
    signal: AbortSignal.timeout(20_000),
  });

  if (res.ok) {
    const pr = await res.json() as { html_url?: string; number?: number };
    return { url: pr.html_url ?? '', number: pr.number ?? 0 };
  }

  // A branch that already has an open PR comes back 422; find and return it
  // rather than failing a re-run of delivery.
  if (res.status === 422) {
    const existing = await gh<Array<{ html_url?: string; number?: number }>>({
      token, path: `/repos/${input.owner}/${input.repo}/pulls`,
      params: { head: `${input.owner}:${input.head}`, state: 'open' },
    });
    const pr = existing[0];
    if (pr?.html_url) return { url: pr.html_url, number: pr.number ?? 0 };
    const detail = await res.text();
    // Translate the common 422s into something a person can act on. The raw
    // body ("field":"base","code":"invalid") is opaque; the usual cause is an
    // empty repository with no base branch to propose against.
    let reason = '';
    try {
      const parsed = JSON.parse(detail) as {
        message?: string; errors?: Array<{ field?: string; code?: string; message?: string }>;
      };
      const e = parsed.errors?.[0];
      if (e?.field === 'base' && e?.code === 'invalid') {
        reason = `the base branch "${input.base}" does not exist on ${input.owner}/${input.repo}. `
          + `An empty repository has no branch to open a pull request against — initialize it with a commit on "${input.base}" first.`;
      } else if (e?.field === 'head' && e?.code === 'invalid') {
        reason = `the branch "${input.head}" was not found on the remote — the push may not have landed.`;
      } else if (/no commits between/i.test(parsed.message ?? e?.message ?? '')) {
        reason = `there are no commits on "${input.head}" beyond "${input.base}", so there is nothing to propose.`;
      }
    } catch { /* not JSON — fall back to the raw body below */ }
    throw new Error(reason
      ? `Cannot open a pull request: ${reason}`
      : `GitHub refused the pull request (422): ${detail.slice(0, 200)}`);
  }
  throw new Error(`Could not open a pull request: HTTP ${res.status}`);
}

/**
 * Who the stored token belongs to, and what it may do.
 *
 * Worth its own call: the scopes decide whether a sync can see private repos
 * at all, and finding that out during a sync means a partial result that looks
 * like an org with very little activity.
 */
export async function identify(providerName: string): Promise<GitHubIdentity> {
  // Fixture floor, not a network call: there is no vault in mock mode
  // (borrowApiKey throws on purpose — see its own comment), so this branches
  // before ever asking for a token rather than papering over a thrown error.
  if (config.mock.agentcore) {
    const row = githubIdentityRow.rows()[0];
    if (!row) throw new Error(`no mock identity fixture for ${providerName}`);
    return { ...row, scopes: [...row.scopes] };
  }
  const token = await borrowApiKey(providerName);
  const url = new URL(`${API}/user`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OrgIQ-Connector/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(res.status === 401
      ? 'GitHub rejected the credential — the token is invalid or revoked'
      : `GitHub /user failed: HTTP ${res.status}`);
  }
  const body = await res.json() as { login?: string; name?: string | null };
  // Classic PATs advertise their scopes in a header; fine-grained tokens do
  // not, so an empty list means "unknown", not "none".
  const scopes = (res.headers.get('x-oauth-scopes') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { login: body.login ?? '(unknown)', name: body.name ?? null, scopes };
}

/** Repositories the token can see, most recently pushed first. */
export async function listRepos(providerName: string, opts: { org?: string; limit?: number } = {}): Promise<RepoRef[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  if (config.mock.agentcore) {
    // Same filter+sort the real branch below applies, over the seeded rows
    // instead of a page from the API — an `org` this token can't see (real
    // GitHub 404s an org repos listing it has no access to) comes back empty
    // rather than leaking every fixture repo regardless of what was asked.
    const rows = githubRepoRows.rows()
      .filter((r) => !opts.org || r.owner.toLowerCase() === opts.org.toLowerCase())
      .slice()
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }
  const token = await borrowApiKey(providerName);
  const repos = await gh<Array<{ name: string; full_name: string; owner: { login: string }; pushed_at?: string | null }>>({
    token,
    path: opts.org ? `/orgs/${opts.org}/repos` : '/user/repos',
    params: { per_page: String(limit), sort: 'pushed', direction: 'desc' },
  });
  return repos.map((r) => ({
    owner: r.owner.login, name: r.name, fullName: r.full_name, pushedAt: r.pushed_at ?? null,
  }));
}

/**
 * Organizations the token's user belongs to.
 *
 * Takes the token directly (like listPulls): the discovery tree in the portal
 * borrows one token per credential and walks personal + org levels with it,
 * and borrowing per-level would hit the credential vault once per expand.
 */
export async function listOrgs(token: string): Promise<Array<{ login: string; description: string | null }>> {
  // Takes a token like the real branch, but never inspects it: the caller
  // (routes/connections.ts) skips borrowApiKey entirely in mock mode, so
  // `token` here is always the empty string it was given instead — the fixture
  // path never depends on a value that mock mode has no honest way to produce.
  if (config.mock.agentcore) return githubOrgRows.rows().map((o) => ({ ...o }));
  const orgs = await gh<Array<{ login?: string; description?: string | null }>>({
    token,
    path: '/user/orgs',
    params: { per_page: '100' },
  });
  return orgs
    .filter((o) => Boolean(o.login))
    .map((o) => ({ login: o.login as string, description: o.description ?? null }));
}

export interface PullSummary {
  number: number;
  title: string;
  state: string;
  headRef: string;
  baseRef: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  draft: boolean;
}

/**
 * Pull requests on a repository, most recently updated first.
 *
 * Takes the token directly rather than a provider name: the pr_watch poller
 * (a later phase) borrows one token per sweep and fans it across every watched
 * repo, and borrowing per-repo would hit the credential vault N times a tick.
 *
 * `since` filters client-side on updatedAt — the pulls endpoint has no `since`
 * parameter (that is the issues API), and sorting by updated lets the caller's
 * watermark stop the scan at one page in the common no-news case.
 */
export async function listPulls(
  token: string,
  repoFullName: string,
  opts: { state?: 'open' | 'closed' | 'all'; since?: string } = {},
): Promise<PullSummary[]> {
  const state = opts.state ?? 'open';
  const pulls = await gh<Array<{
    number: number; title?: string; state?: string; draft?: boolean;
    head?: { ref?: string }; base?: { ref?: string };
    user?: { login?: string } | null;
    created_at?: string; updated_at?: string; html_url?: string;
  }>>({
    token,
    path: `/repos/${repoFullName}/pulls`,
    params: { state, per_page: '100', sort: 'updated', direction: 'desc' },
  });
  return pulls
    .filter((p) => !opts.since || (p.updated_at ?? '') > opts.since)
    .map((p) => ({
      number: p.number,
      title: p.title ?? '',
      state: p.state ?? 'open',
      headRef: p.head?.ref ?? '',
      baseRef: p.base?.ref ?? '',
      author: p.user?.login ?? null,
      createdAt: p.created_at ?? '',
      updatedAt: p.updated_at ?? '',
      url: p.html_url ?? '',
      draft: Boolean(p.draft),
    }));
}

/**
 * One pull request's terminal-state facts. `merged` is the field worth the
 * extra call: the list endpoint says only open/closed, and a closed-unmerged
 * PR means the work was declined, not delivered — marketplace merge-detection
 * must not confuse the two.
 */
export async function getPullStatus(
  token: string,
  repoFullName: string,
  number: number,
): Promise<{ number: number; state: string; merged: boolean; mergedAt: string | null; url: string }> {
  const pr = await gh<{
    number?: number; state?: string; merged?: boolean; merged_at?: string | null; html_url?: string;
  }>({ token, path: `/repos/${repoFullName}/pulls/${number}` });
  return {
    number: pr.number ?? number,
    state: pr.state ?? '',
    merged: Boolean(pr.merged),
    mergedAt: pr.merged_at ?? null,
    url: pr.html_url ?? '',
  };
}

export interface WorkflowRun {
  id: number;
  /** The workflow's name ("Deploy", "CI"), not the run's title. */
  name: string;
  /** queued | in_progress | completed — where the run is, not how it went. */
  status: string;
  /** success | failure | cancelled | skipped | … ; null while still running. */
  conclusion: string | null;
  branch: string | null;
  sha: string | null;
  /** Who triggered it. A GitHub login, not an OrgIQ person. */
  actor: string | null;
  createdAt: string;
  url: string;
  /** Wall-clock from start to last update. Null while the run is unfinished. */
  durationMs: number | null;
}

/**
 * The latest GitHub Actions runs for a repository. READ ONLY, on purpose.
 *
 * This product does not do CI and should not grow into it. The repositories
 * linked to an initiative already have Actions deploying them, and the only
 * thing worth adding here is a window onto what those runs did — so an
 * environment page can say "the last deploy of this thing failed" without
 * anyone leaving for GitHub. There is deliberately no counterpart to this
 * function: no re-run, no workflow_dispatch, no webhook receiver. A "Deploy"
 * button here would be a second, worse CI system arguing with the real one
 * about what shipped, and a webhook would make this a system of record for
 * state it does not own.
 *
 * Polled on demand rather than cached: a page that shows a run's status is
 * only useful if it is current, and Actions history is small and cheap.
 *
 * `connectionName` is optional because a public repository's runs are readable
 * with no credential at all, and a repo that needs no secret should not be
 * made to carry one (the same rule agent_projects.connection_name follows).
 *
 * `durationMs` is derived from run_started_at → updated_at rather than fetched
 * from /timing, which costs a second round-trip per run to report billable
 * minutes — a different question from "how long did this take".
 */
export async function listWorkflowRuns(
  repoFullName: string,
  limit = 10,
  opts: { token?: string; connectionName?: string | null } = {},
): Promise<WorkflowRun[]> {
  const per = Math.min(Math.max(limit, 1), 50);

  // Fixture floor, not a network call — and the last read in this connector to
  // get one. Every other function here already branched; this one did not, and
  // because its only caller catches, the gap surfaced as an empty list rather
  // than as an error, which is why no check ever saw it. The branch is above
  // the token borrow for the same reason identify()'s is: there is no vault
  // offline, so asking for a credential first would fail for the wrong reason.
  if (config.mock.agentcore) return mockWorkflowRuns(repoFullName, per);

  const token = opts.token
    ?? (opts.connectionName ? await borrowApiKey(opts.connectionName) : '');

  const body = await gh<{
    workflow_runs?: Array<{
      id?: number; name?: string | null; status?: string | null; conclusion?: string | null;
      head_branch?: string | null; head_sha?: string | null;
      actor?: { login?: string } | null; triggering_actor?: { login?: string } | null;
      created_at?: string; run_started_at?: string | null; updated_at?: string | null;
      html_url?: string;
    }>;
  }>({
    token,
    path: `/repos/${repoFullName}/actions/runs`,
    // Newest first is the API default here; per_page bounds it.
    params: { per_page: String(per) },
  });

  return (body.workflow_runs ?? []).slice(0, per).map((r) => {
    const started = r.run_started_at ?? r.created_at ?? '';
    const ended = r.updated_at ?? '';
    // Only a finished run has a meaningful duration — `updated_at` on a run
    // still in progress is just the last heartbeat, and reporting it as an
    // elapsed time would show a number that shrinks and grows at random.
    const done = (r.status ?? '') === 'completed';
    const ms = done && started && ended ? Date.parse(ended) - Date.parse(started) : NaN;
    return {
      id: r.id ?? 0,
      name: r.name ?? '',
      status: r.status ?? '',
      conclusion: r.conclusion ?? null,
      branch: r.head_branch ?? null,
      sha: r.head_sha ?? null,
      actor: r.triggering_actor?.login ?? r.actor?.login ?? null,
      createdAt: r.created_at ?? '',
      url: r.html_url ?? '',
      durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
    };
  });
}

/**
 * Contribution signal for one repository.
 *
 * Reads commits rather than the contributors endpoint, because contributors
 * gives totals with no sense of *what* someone worked on. Which paths and
 * languages a person touches is the part that maps onto a skill.
 */
export async function readRepoSignal(
  providerName: string,
  repo: RepoRef,
  opts: { sinceDays?: number; maxCommits?: number } = {},
): Promise<ContributionSignal[]> {
  if (config.mock.agentcore) {
    // A repo with no seeded row is the honest empty case, not an error — the
    // real endpoint returns no commits just as plainly for a quiet repo.
    return githubSignalRows.rows()
      .filter((s) => s.repo === repo.fullName)
      .map((s) => ({ ...s, areas: [...s.areas], languages: { ...s.languages } }))
      .sort((a, b) => b.commits - a.commits);
  }
  const token = await borrowApiKey(providerName);
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 180, 1), 3650);
  const maxCommits = Math.min(Math.max(opts.maxCommits ?? 200, 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const byLogin = new Map<string, ContributionSignal>();
  let page = 1;
  let seen = 0;

  while (seen < maxCommits) {
    const batch = await gh<Array<{
      sha: string;
      commit: { author?: { date?: string } };
      author?: { login?: string } | null;
    }>>({
      token,
      path: `/repos/${repo.owner}/${repo.name}/commits`,
      params: { since, per_page: '100', page: String(page) },
    });
    if (batch.length === 0) break;

    for (const c of batch) {
      seen++;
      // Commits with no linked GitHub account cannot be attributed to a person
      // without guessing from the email, and guessing identity is exactly the
      // kind of quiet error this is supposed to avoid.
      const login = c.author?.login;
      if (!login) continue;

      const slot = byLogin.get(login) ?? {
        login, repo: repo.fullName, commits: 0, areas: [], languages: {}, lastActivityAt: null,
      };
      slot.commits++;
      const at = c.commit.author?.date ?? null;
      if (at && (!slot.lastActivityAt || at > slot.lastActivityAt)) slot.lastActivityAt = at;
      byLogin.set(login, slot);
    }

    if (batch.length < 100) break;
    page++;
  }

  // File-level detail costs one request per commit, so it is sampled: enough
  // to characterise what someone works on, not a full audit.
  const sampleTargets = [...byLogin.values()].slice(0, 10);
  for (const signal of sampleTargets) {
    try {
      const commits = await gh<Array<{ sha: string }>>({
        token,
        path: `/repos/${repo.owner}/${repo.name}/commits`,
        params: { since, author: signal.login, per_page: '5' },
      });
      const areas = new Set<string>();
      for (const c of commits.slice(0, 5)) {
        const detail = await gh<{ files?: Array<{ filename: string }> }>({
          token, path: `/repos/${repo.owner}/${repo.name}/commits/${c.sha}`,
        });
        for (const f of detail.files ?? []) {
          areas.add(areaOf(f.filename));
          const lang = languageOf(f.filename);
          if (lang) signal.languages[lang] = (signal.languages[lang] ?? 0) + 1;
        }
      }
      signal.areas = [...areas].slice(0, 12);
    } catch {
      // Sampling is an enrichment; losing it should not lose the commit counts.
    }
  }

  return [...byLogin.values()].sort((a, b) => b.commits - a.commits);
}
