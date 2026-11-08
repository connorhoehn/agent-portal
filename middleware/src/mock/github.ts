// GitHub, as `dev:mock` sees it.
//
// lib/github-connector.ts reads three shapes from api.github.com: who a token
// belongs to, which repositories and orgs it can see, and per-repo commit
// activity. Offline there is no vault and no token (see borrowApiKey's comment
// in providers/connected-sources.ts), so identify()/listOrgs()/listRepos()/
// readRepoSignal() branch to the rows below instead of ever calling fetch —
// nothing here reaches the network in mock mode, by construction: the branch
// happens before the connector builds a URL, not after a call fails.
//
// Repo full names are not invented — they are the fourteen
// `agent_projects.repo_full_name` rows schema/seed_program.sql actually
// inserts, under the same `connorhoehnslalom` account the connected-sources
// fixture uses for the one seeded GitHub credential. Contribution logins reuse
// the initiative owner/sponsor already seeded in mock/people.ts (Nora DaSilva
// owns p-observability, so `ndasilva` is who orgiq-observability's signal
// credits) — not a reconciliation (readRepoSignal's own doc comment says a
// login "may not match" a person, and nothing here claims otherwise), just a
// fixture that doesn't invent a stranger when a name is already sitting right
// there in the seed.
//
// `borrowApiKey` is left throwing in mock mode (providers/connected-sources.ts
// is unchanged) — these fixtures are read by the connector functions that take
// a provider name or a token and never ask the vault for either.

import { clock, defineFixture } from './core/index.js';
import type { GitHubIdentity, RepoRef, ContributionSignal } from '../lib/github-connector.js';

/** The one credential the connected-sources fixture seeds: connectApiKeySource / borrowApiKey never touch this — it's who `identify()` reports the (nonexistent) token as belonging to. */
export const githubIdentityRow = defineFixture<GitHubIdentity>({
  key: 'github-identity',
  scenarios: {
    default: () => [
      { login: 'connorhoehn', name: 'Connor Hoehn', scopes: ['repo', 'read:org', 'workflow'] },
    ],
  },
});

export const githubOrgRows = defineFixture<{ login: string; description: string | null }>({
  key: 'github-orgs',
  scenarios: {
    default: () => [
      {
        login: 'connorhoehnslalom',
        description: 'OrgIQ demo organization — the repositories the seeded initiatives deliver against.',
      },
    ],
    empty: () => [],
  },
});

// pushedAt spread over the last two weeks so listRepos's "most recently pushed
// first" ordering has something to sort, without claiming any repo pushed
// later than clock.nowIso() would allow.
export const githubRepoRows = defineFixture<RepoRef>({
  key: 'github-repos',
  scenarios: {
    default: () => [
      { owner: 'connorhoehnslalom', name: 'orgiq-zero-trust', fullName: 'connorhoehn/orgiq-zero-trust', pushedAt: clock.hoursAgo(6) },
      { owner: 'connorhoehnslalom', name: 'orgiq-inference-platform', fullName: 'connorhoehn/orgiq-inference-platform', pushedAt: clock.daysAgo(1) },
      { owner: 'connorhoehnslalom', name: 'orgiq-llm-platform', fullName: 'connorhoehn/orgiq-llm-platform', pushedAt: clock.daysAgo(2) },
      { owner: 'connorhoehnslalom', name: 'orgiq-observability', fullName: 'connorhoehn/orgiq-observability', pushedAt: clock.daysAgo(3) },
      { owner: 'connorhoehnslalom', name: 'orgiq-auth-service', fullName: 'connorhoehn/orgiq-auth-service', pushedAt: clock.daysAgo(4) },
      { owner: 'connorhoehnslalom', name: 'orgiq-rag-search', fullName: 'connorhoehn/orgiq-rag-search', pushedAt: clock.daysAgo(5) },
      { owner: 'connorhoehnslalom', name: 'orgiq-compliance', fullName: 'connorhoehn/orgiq-compliance', pushedAt: clock.daysAgo(6) },
      { owner: 'connorhoehnslalom', name: 'orgiq-finops', fullName: 'connorhoehn/orgiq-finops', pushedAt: clock.daysAgo(7) },
      { owner: 'connorhoehnslalom', name: 'orgiq-stream-analytics', fullName: 'connorhoehn/orgiq-stream-analytics', pushedAt: clock.daysAgo(8) },
      { owner: 'connorhoehnslalom', name: 'orgiq-feature-store', fullName: 'connorhoehn/orgiq-feature-store', pushedAt: clock.daysAgo(9) },
      { owner: 'connorhoehnslalom', name: 'orgiq-data-lake', fullName: 'connorhoehn/orgiq-data-lake', pushedAt: clock.daysAgo(10) },
      { owner: 'connorhoehnslalom', name: 'orgiq-design-system', fullName: 'connorhoehn/orgiq-design-system', pushedAt: clock.daysAgo(11) },
      { owner: 'connorhoehnslalom', name: 'orgiq-design-system-api', fullName: 'connorhoehn/orgiq-design-system-api', pushedAt: clock.daysAgo(12) },
      { owner: 'connorhoehnslalom', name: 'orgiq-mobile-app', fullName: 'connorhoehn/orgiq-mobile-app', pushedAt: clock.daysAgo(13) },
    ],
    empty: () => [],
  },
});

// Signal for a handful of the repos above — enough to prove the shape end to
// end, not a full audit of all fourteen. A repo with no row here is the
// honest "nothing sampled for this one" case: readRepoSignal returns `[]`
// rather than fabricating a contributor for it.
export const githubSignalRows = defineFixture<ContributionSignal>({
  key: 'github-signal',
  scenarios: {
    default: (): ContributionSignal[] => [
      {
        login: 'ndasilva', repo: 'connorhoehn/orgiq-observability', commits: 64,
        areas: ['collectors', 'dashboards', 'alerting'],
        languages: { TypeScript: 22, Go: 6 },
        lastActivityAt: clock.daysAgo(3),
      },
      {
        login: 'lhassan', repo: 'connorhoehn/orgiq-observability', commits: 31,
        areas: ['alerting', 'runbooks'],
        languages: { TypeScript: 9, YAML: 5 },
        lastActivityAt: clock.daysAgo(5),
      },
      {
        login: 'vgreen', repo: 'connorhoehn/orgiq-auth-service', commits: 48,
        areas: ['oidc', 'session'],
        languages: { TypeScript: 18, SQL: 3 },
        lastActivityAt: clock.daysAgo(4),
      },
      {
        login: 'hdasilva', repo: 'connorhoehn/orgiq-auth-service', commits: 19,
        areas: ['jwks', 'oidc'],
        languages: { TypeScript: 7 },
        lastActivityAt: clock.daysAgo(10),
      },
      {
        login: 'nrivera', repo: 'connorhoehn/orgiq-llm-platform', commits: 57,
        areas: ['prompts', 'evals'],
        languages: { Python: 21, TypeScript: 4 },
        lastActivityAt: clock.daysAgo(2),
      },
      {
        login: 'hmancini', repo: 'connorhoehn/orgiq-llm-platform', commits: 26,
        areas: ['serving', 'budgets'],
        languages: { Python: 10 },
        lastActivityAt: clock.daysAgo(6),
      },
      {
        login: 'lkim', repo: 'connorhoehn/orgiq-rag-search', commits: 40,
        areas: ['retrieval', 'ranking'],
        languages: { Python: 15 },
        lastActivityAt: clock.daysAgo(5),
      },
      {
        login: 'lhassan', repo: 'connorhoehn/orgiq-finops', commits: 22,
        areas: ['aurora', 'tagging'],
        languages: { Terraform: 8, Python: 2 },
        lastActivityAt: clock.daysAgo(7),
      },
    ],
    empty: () => [],
  },
});
