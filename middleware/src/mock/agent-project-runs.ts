// Agent runs against a linked codebase — `agent_project_runs`, offline.
//
// This is the activity feed on /admin/codebases: what was asked of a repo,
// which model answered, how long it took, what it cost, and whether the
// working tree ended up different. Two routes read it, and until now they
// disagreed with each other in dev:mock — `GET /api/agent-projects` had a mock
// branch that returned an empty map (every repo read "Nothing has been run
// against this yet") while `GET /api/agent-projects/:id/runs` had none at all
// and 500'd. Both now read these rows, so the list and the focused detail
// cannot tell different stories about the same repository.
//
// `agent_project_runs` is NOT seeded — schema/seed_program.sql seeds
// `agent_projects` (the 14 linked repos, mirrored in providers/agent-projects.ts)
// and stops there, because a run is something the fleet does, not something
// the corpus declares. So there is no parity entity for this table; the
// project ids below are the seeded ones, which is the part that has to agree.
//
// WHAT IS NOT STORED. `durationMs` is `finished_at - started_at` — Aurora
// literally computes it that way in `finishRun` — so it is derived here from
// the two stamps rather than typed beside them, and a run still in flight has
// no duration rather than a stale one.

import { randomUUID } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';

/** A run as the seed carries it: the two stamps, not the span between them. */
export interface ProjectRunSeed {
  id: string;
  projectId: string;
  prompt: string;
  model: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  filesChanged: number | null;
  diffSummary: string | null;
  error: string | null;
  costUsd: number | null;
  /** The marketplace work item this run answers, when a dispatch bound one. */
  workItemId?: string | null;
}

/** The wire shape both routes return — `durationMs` computed, everything else carried. */
export interface ProjectRunRow extends ProjectRunSeed {
  durationMs: number | null;
}

// The seeded repos these runs belong to (schema/seed_program.sql
// `agent_projects`). Named rather than inlined so a wrong uuid is one edit,
// and so it is obvious that no run points at an invented project.
const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a';
const AUTH_SERVICE = '7aad75a2-a91c-5f87-a312-2b2691b37b8c';
const RAG_SEARCH = 'db4978ec-903a-5398-a88a-807447cdaa44';

// Bedrock inference-profile ids, the same strings portal/src/lib/devboxModels.ts
// sends and the devbox allowlist accepts. A run started by a maintenance bot
// carries the bot's model instead, which is why both spellings appear.
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET = 'us.anthropic.claude-sonnet-5';
const NOVA_LITE = 'us.amazon.nova-lite-v1:0';

/**
 * Runs.
 *
 * `default` — three repos with history and one run still in flight, so the
 *             page has a `running` chip, a `failed` chip with an error string,
 *             a run that changed nothing, and a repo with no runs at all
 *             (every other seeded project) all visible at once.
 * `empty`   — the fleet has been linked but has never been dispatched. That is
 *             a genuinely different state from "this repo is idle", and it is
 *             what the "Nothing has been run against this yet" copy is for.
 *             Declared explicitly: an undeclared scenario falls back to
 *             `default`, so an unwritten `empty` would not be empty.
 */
export const agentProjectRuns = defineFixture<ProjectRunSeed>({
  key: 'agent-project-runs',
  scenarios: {
    default: () => [
      {
        id: '0b8a1c4e-2f6d-4a51-9c3b-7d1e5a904f11',
        projectId: OBSERVABILITY,
        prompt: 'Enable the span-metrics connector on the gateway collectors for checkout and search only, and add a RED dashboard for each.',
        model: SONNET,
        status: 'running',
        startedAt: clock.hoursAgo(0.2, { keepWithinToday: true }),
        finishedAt: null,
        filesChanged: null,
        diffSummary: null,
        error: null,
        costUsd: null,
      },
      {
        id: '1c9b2d5f-3a70-4b62-8d4c-8e2f6b015a22',
        projectId: OBSERVABILITY,
        prompt: 'Bound the gateway exporter sending queue at 5,000 batches, put memory_limiter first in the pipeline, and replay the 40k spans/s burst.',
        model: HAIKU,
        status: 'done',
        startedAt: clock.hoursAgo(5, { keepWithinToday: true }),
        finishedAt: clock.hoursAgo(4.8, { keepWithinToday: true }),
        filesChanged: 3,
        diffSummary: '3 files changed, 41 insertions(+), 6 deletions(-) in collector/gateway.yaml, collector/limits.yaml and test/burst_replay_test.go. Burst replay: no OOM kills, peak RSS 1.6 GiB of 2 GiB.',
        error: null,
        costUsd: 0.42,
      },
      {
        id: '2da03e60-4b81-4c73-9e5d-9f3a7c126b33',
        projectId: OBSERVABILITY,
        prompt: 'Audit the collector and OpenTelemetry SDK pins against upstream releases.',
        model: NOVA_LITE,
        status: 'done',
        startedAt: clock.daysAgo(1),
        finishedAt: clock.daysAgo(0.98),
        filesChanged: 0,
        diffSummary: 'No changes: otelcol-contrib 0.111.0 and all six SDK pins are already at the latest patch release.',
        error: null,
        costUsd: 0.03,
      },
      {
        id: '3eb14f71-5c92-4d84-af6e-a04b8d237c44',
        projectId: AUTH_SERVICE,
        prompt: 'Migrate the token verifier off the deprecated JWKS client.',
        model: SONNET,
        status: 'failed',
        startedAt: clock.daysAgo(2),
        finishedAt: clock.daysAgo(1.96),
        filesChanged: null,
        diffSummary: null,
        // The cause Nora explains in #auth-migration and the initiative thread (mock/social-history.ts).
        error: 'npm test failed in auth/verify.test.ts: 3 tests still expect the signing key from before the last JWKS rotation.',
        costUsd: 0.81,
      },
      {
        id: '4fc25082-6da3-4e95-b07f-b15c9e348d55',
        projectId: AUTH_SERVICE,
        prompt: 'Add a regression test: revoking a grant mid-session produces exactly one refresh call, then a sign-out.',
        model: HAIKU,
        status: 'done',
        startedAt: clock.daysAgo(6),
        finishedAt: clock.daysAgo(5.99),
        filesChanged: 1,
        diffSummary: '2 files changed, 64 insertions(+), 3 deletions(-) in web/session/refresh.ts and web/session/refresh.test.ts. The new test fails on main (31 refresh calls in a minute) and passes on the branch.',
        error: null,
        costUsd: 0.07,
      },
      {
        id: '50d36193-7eb4-4fa6-b180-c26daf459e66',
        projectId: RAG_SEARCH,
        prompt: 'Pin the retrieval search type to HYBRID on every Retrieve call and re-run the eight ranking cases.',
        model: SONNET,
        status: 'done',
        startedAt: clock.daysAgo(9),
        finishedAt: clock.daysAgo(8.97),
        filesChanged: 5,
        diffSummary: '5 files changed, 96 insertions(+), 41 deletions(-). Ranking cases: top-1 correct 8 of 8, up from 0 of 8 on the default search type.',
        error: null,
        costUsd: 1.14,
      },
    ],
    empty: () => [],
  },
});

/** `duration_ms` as Aurora computes it: finished − started, or nothing yet. */
function durationMs(seed: ProjectRunSeed): number | null {
  if (!seed.finishedAt) return null;
  const ms = new Date(seed.finishedAt).getTime() - new Date(seed.startedAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
}

function toRow(seed: ProjectRunSeed): ProjectRunRow {
  return { ...seed, durationMs: durationMs(seed) };
}

function newestFirst(a: ProjectRunSeed, b: ProjectRunSeed): number {
  return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
}

/** One project's runs, newest first — `GET /api/agent-projects/:id/runs`. */
export function mockRunsForProject(projectId: string, limit = 25): ProjectRunRow[] {
  return agentProjectRuns
    .rows()
    .filter((r) => r.projectId === projectId)
    .sort(newestFirst)
    .slice(0, limit)
    .map(toRow);
}

/**
 * The latest `perProject` runs for each of several projects — the same shape
 * the windowed query returns for `GET /api/agent-projects`. Projects with no
 * runs are absent from the map, matching the real path (the route falls back
 * to `[]`), so "no runs" is never confused with "project not found".
 */
export function mockRecentRunsForProjects(
  ids: readonly string[],
  perProject = 5,
): Map<string, ProjectRunRow[]> {
  const grouped = new Map<string, ProjectRunRow[]>();
  for (const id of ids) {
    const runs = mockRunsForProject(id, perProject);
    if (runs.length > 0) grouped.set(id, runs);
  }
  return grouped;
}

/**
 * Begin a run — the offline half of the `agent_project_runs` INSERT.
 *
 * A new row is `running` with a start stamp and nothing else: no finish, no
 * duration, no cost. That is the state the table's own defaults produce, and it
 * is what the portal's `running` chip is for. `durationMs` is NOT stored — it
 * falls out of the two stamps in `toRow`, the way Aurora computes it in
 * `finishRun` — so a run in flight has no duration rather than a zero.
 */
export function mockStartRun(input: {
  projectId: string; prompt: string; model?: string | null; workItemId?: string | null;
}): ProjectRunRow {
  const seed: ProjectRunSeed = {
    id: randomUUID(),
    projectId: input.projectId,
    prompt: input.prompt,
    model: input.model ?? null,
    status: 'running',
    startedAt: clock.nowIso(),
    finishedAt: null,
    filesChanged: null,
    diffSummary: null,
    error: null,
    costUsd: null,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
  };
  agentProjectRuns.rows().push(seed);
  return toRow(seed);
}

/**
 * Finish a run — the offline half of the `agent_project_runs` UPDATE.
 *
 * Returns false when no such run exists, matching the real path's honest
 * outcome for an unknown id (`UPDATE ... WHERE id = :id` affects no row). The
 * finish stamp comes from the clock and `duration_ms` is left to `toRow`,
 * because Aurora derives it from the same two stamps — storing it here would
 * be a typed aggregate that could disagree with its own row.
 */
export function mockFinishRun(id: string, outcome: {
  status: 'done' | 'failed'; filesChanged?: number | null; diffSummary?: string | null;
  error?: string | null; costUsd?: number | null;
}): boolean {
  const run = agentProjectRuns.rows().find((r) => r.id === id);
  if (!run) return false;
  run.status = outcome.status;
  run.finishedAt = clock.nowIso();
  run.filesChanged = outcome.filesChanged ?? null;
  run.diffSummary = outcome.diffSummary ?? null;
  run.error = outcome.error ?? null;
  run.costUsd = outcome.costUsd ?? null;
  return true;
}
