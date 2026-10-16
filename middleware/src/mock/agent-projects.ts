// Linked codebases — `agent_projects`, offline.
//
// These 14 rows were previously a `const MOCK_AGENT_PROJECTS: AgentProject[]`
// inside providers/agent-projects.ts. They moved here for two reasons, both of
// them rules of the floor:
//
//   1. WRITES NEED SOMEWHERE TO GO. `POST /api/agent-projects` and
//      `DELETE /:id` had no mock branch at all — a raw `exec()` reaches the RDS
//      Data API whatever `config.mock.aurora` says — so linking or unlinking a
//      repository 500'd offline. A mock branch has to mutate *something*, and
//      mutating a bare module-level array is the exact "auditor damages shared
//      state and warns the next auditor" problem the scenario control plane
//      exists to end. Behind a fixture, `POST /api/__mock/reset` puts the
//      seeded fleet back.
//   2. THE TIMESTAMPS WERE FROZEN LITERALS. Each row carried a hand-typed
//      `createdAt: '2026-05-24T12:00:00Z'`. The seed does not even set the
//      column — `schema/seed_program.sql` inserts (id, repo_full_name,
//      default_branch, org_project_id, added_by) and lets `created_at` default
//      to `NOW()`, so every seeded repo is linked "just now" and the literals
//      were invented, ageing a day per day until "linked 8 months ago". The
//      relative order they encoded is real and is preserved; the instants come
//      from the clock.
//
// WHAT IS STILL DELIBERATELY THIN. `owners` is empty (it fans out to
// `project_contributions`); filling it here would mean a second, drift-prone
// copy of providers/projects.ts's cast table. `orgProjectName` is derived from
// the initiatives fixture (2026-10-15, the work-journeys lane: Codebases must say what each repository delivers).

import { randomUUID } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import type { AgentProject } from '../providers/agent-projects.js';
import { findInitiative } from './initiatives.js';

/**
 * The seeded fleet, in the order `schema/seed_program.sql` links them.
 *
 * `linkedDaysAgo` is the age the old literal encoded, kept so the list still
 * reads oldest-repo-last; `clock.daysAgo` turns it into an instant at read
 * time. Ids and repo names mirror the seed exactly — a wrong uuid here 400s
 * the dispatch preflight for that initiative.
 */
const SEEDED: Array<{ id: string; repoFullName: string; orgProjectId: string; linkedDaysAgo: number }> = [
  { id: 'db4978ec-903a-5398-a88a-807447cdaa44', repoFullName: 'connorhoehnslalom/orgiq-rag-search', orgProjectId: 'p-rag-search', linkedDaysAgo: 141 },
  { id: '4870e01d-9274-5c4a-91af-ea9acb7f857a', repoFullName: 'connorhoehnslalom/orgiq-observability', orgProjectId: 'p-observability', linkedDaysAgo: 105 },
  { id: '34ce3706-b201-539f-818e-5ed551186fae', repoFullName: 'connorhoehnslalom/orgiq-finops', orgProjectId: 'p-cost-opt', linkedDaysAgo: 99 },
  { id: '7aad75a2-a91c-5f87-a312-2b2691b37b8c', repoFullName: 'connorhoehnslalom/orgiq-auth-service', orgProjectId: 'p-auth-migration', linkedDaysAgo: 93 },
  { id: '4fbe2b7a-7f55-5008-a226-3905635c89d4', repoFullName: 'connorhoehnslalom/orgiq-mobile-app', orgProjectId: 'p-mobile-redesign', linkedDaysAgo: 86 },
  { id: '246a5843-5308-518d-88ca-749e1bd3ae0a', repoFullName: 'connorhoehnslalom/orgiq-inference-platform', orgProjectId: 'p-inference-platform', linkedDaysAgo: 83 },
  { id: '0c7b1f2f-79d2-5851-81ce-713455d6ac9c', repoFullName: 'connorhoehnslalom/orgiq-llm-platform', orgProjectId: 'p-llm-platform', linkedDaysAgo: 79 },
  { id: '5e00ed8f-fd6a-5bff-b394-bc45358c85a1', repoFullName: 'connorhoehnslalom/orgiq-compliance', orgProjectId: 'p-soc2', linkedDaysAgo: 76 },
  { id: 'fe14d5bf-b55f-55eb-8b3d-4956357bf1fe', repoFullName: 'connorhoehnslalom/orgiq-stream-analytics', orgProjectId: 'p-realtime-analytics', linkedDaysAgo: 74 },
  { id: '5643cea7-dc73-5555-a944-6110115fef5e', repoFullName: 'connorhoehnslalom/orgiq-feature-store', orgProjectId: 'p-feature-store', linkedDaysAgo: 70 },
  { id: '62494906-efb3-56fc-ab99-10d48698a820', repoFullName: 'connorhoehnslalom/orgiq-design-system', orgProjectId: 'p-design-v3', linkedDaysAgo: 65 },
  { id: '7395f933-eca7-57d8-b0ab-387f63f87589', repoFullName: 'connorhoehnslalom/orgiq-design-system-api', orgProjectId: 'p-design-system-api', linkedDaysAgo: 58 },
  { id: '8bf7c98b-0c23-5bae-839d-2c346ad02006', repoFullName: 'connorhoehnslalom/orgiq-data-lake', orgProjectId: 'p-data-lake', linkedDaysAgo: 36 },
  { id: '340cfae2-476d-533d-a291-49d29d3f1496', repoFullName: 'connorhoehnslalom/orgiq-zero-trust', orgProjectId: 'p-zero-trust', linkedDaysAgo: 29 },
];

/** providerNameFor('github', 'connorhoehnslalom') — see mock/connected-sources.ts. */
const SEEDED_CONNECTION = 'orgiq-github-connorhoehnslalom';

function seedRow(s: (typeof SEEDED)[number]): AgentProject {
  return {
    id: s.id,
    repoFullName: s.repoFullName,
    orgProjectId: s.orgProjectId,
    // Derived from the initiatives fixture at read time (what the Aurora path's LEFT JOIN on `projects` returns), so Codebases
    // can say what each repository delivers; `owners` stays empty (it fans out to project_contributions).
    orgProjectName: findInitiative(s.orgProjectId)?.name ?? null,
    owners: [],
    defaultBranch: 'main',
    // Every seeded repository is private (flipped 2026-09-29) and linked
    // through the GitHub credential — the same row schema/seed_program.sql
    // writes (GH_CONNECTION in its generator) and the one the
    // `connected-sources` fixture lists. Null here read as "public" on
    // Codebases, which no initiative repo is.
    connectionName: SEEDED_CONNECTION,
    sessionId: null,
    workspacePath: '/mnt/workspace',
    clonedAt: null,
    createdAt: clock.daysAgo(s.linkedDaysAgo),
  };
}

/**
 * Linked codebases.
 *
 * `default` — the 14 repositories `schema/seed_program.sql` links, one per
 *             initiative, all private behind the GitHub connection, none of
 *             them cloned into a workspace yet.
 * `empty`   — the fleet exists but nothing has been linked. Declared
 *             explicitly: an undeclared scenario falls back to `default`, so an
 *             unwritten `empty` would not be empty — and this is the state the
 *             "link your first repository" copy is for.
 * `error`   — the registry read fails the way the Aurora path does when the
 *             `agent_projects` table is unreachable. Declared so the Codebases
 *             page's failed-read notice can be seen without breaking the
 *             database: before this branch existed `scenario=error` on this
 *             fixture was a silent no-op that still served all 14 rows.
 */
export const agentProjects = defineFixture<AgentProject>({
  key: 'agent-projects',
  scenarios: {
    default: () => SEEDED.map(seedRow),
    empty: () => [],
    error: () => {
      throw new Error('agent-projects registry unavailable: agent_projects query failed');
    },
  },
});

/** A defensive copy — a caller must not be able to edit the fixture by reference. */
function copy(p: AgentProject): AgentProject {
  return { ...p, owners: p.owners.map((o) => ({ ...o })) };
}

/**
 * Every linked repository, newest link first.
 *
 * The sort is not decoration: the Aurora path is `ORDER BY ap.created_at DESC`,
 * and the old array returned insertion order, so the offline list and the live
 * one showed the same 14 repositories in different orders.
 */
export function mockListAgentProjects(): AgentProject[] {
  return agentProjects
    .rows()
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(copy);
}

export function mockGetAgentProject(id: string): AgentProject | null {
  const found = agentProjects.rows().find((p) => p.id === id);
  return found ? copy(found) : null;
}

/**
 * Link a repository — the offline half of `INSERT ... ON CONFLICT (repo_full_name)
 * DO UPDATE`.
 *
 * The conflict target is `repo_full_name`, not the id, so re-linking a repo
 * that is already there UPDATES it in place and keeps its id and `created_at`
 * — exactly what the statement does. Getting that wrong would let the offline
 * fleet grow a duplicate row for a repository Aurora can only hold once.
 */
export function mockLinkAgentProject(input: {
  repoFullName: string; defaultBranch?: string; connectionName?: string | null;
  orgProjectId?: string | null;
}): AgentProject {
  const rows = agentProjects.rows();
  const existing = rows.find((p) => p.repoFullName === input.repoFullName);
  if (existing) {
    existing.defaultBranch = input.defaultBranch || 'main';
    existing.connectionName = input.connectionName ?? null;
    existing.orgProjectId = input.orgProjectId ?? null;
    return copy(existing);
  }
  const created: AgentProject = {
    id: randomUUID(),
    repoFullName: input.repoFullName,
    orgProjectId: input.orgProjectId ?? null,
    orgProjectName: null,
    owners: [],
    defaultBranch: input.defaultBranch || 'main',
    connectionName: input.connectionName ?? null,
    sessionId: null,
    workspacePath: '/mnt/workspace',
    clonedAt: null,
    createdAt: clock.nowIso(),
  };
  rows.push(created);
  return copy(created);
}

/** Unlink — `DELETE ... RETURNING id`, so false means "no such row", not "failed". */
export function mockUnlinkAgentProject(id: string): boolean {
  const rows = agentProjects.rows();
  const i = rows.findIndex((p) => p.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  return true;
}

/** Record a successful clone — `SET session_id = :sid, cloned_at = NOW()`. */
export function mockMarkCloned(id: string, sessionId: string): void {
  const project = agentProjects.rows().find((p) => p.id === id);
  if (!project) return;
  project.sessionId = sessionId;
  project.clonedAt = clock.nowIso();
}
