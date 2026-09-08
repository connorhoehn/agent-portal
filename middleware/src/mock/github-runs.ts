// GitHub Actions history, as `dev:mock` sees it.
//
// WHY THIS FILE EXISTS. `GET /api/environments/:id/runs` is the one read in
// this middleware that reached api.github.com with no offline branch at all.
// It did not 500 — the handler catches and answers
// `{ runs: [], repo, note: <the error> }` — so the wire capture recorded a
// cheerful `200` and every check stayed green while the surface said nothing.
// That is the worst shape a gap can take: a broken integration and an idle
// repository render identically, and no reader (and no test) can tell them
// apart. See docs/mock-floor.md § "What the judge cannot see", which named
// this route by hand because nothing mechanical could.
//
// WIRE STRINGS ARE NOT INVENTED. `status` is GitHub's run *state* — queued,
// in_progress, completed — and `conclusion` its *outcome* — success, failure,
// cancelled, skipped, null while running. Both enums are copied from the
// `WorkflowRun` interface in lib/github-connector.ts, which is the shape the
// live branch maps api.github.com onto, rather than typed from memory.
//
// REPOSITORY NAMES ARE NOT INVENTED EITHER. Every `repo` below is one of the
// fourteen `agent_projects.repo_full_name` rows `schema/seed_program.sql`
// inserts — the same list mock/agent-projects.ts carries — because the route
// resolves its repository through the initiative, and a run attributed to a
// repository the seed never linked would be unreachable from any environment.
// Actor logins reuse the contributor logins already seeded in mock/github.ts
// (ndasilva and lhassan on observability, lhassan on finops), so no stranger
// is introduced to trigger a build.
//
// WHAT IS DELIBERATELY ABSENT. `connorhoehnslalom/orgiq-rag-search` has no
// rows. Its environment (`p-rag-search` / prod) is the seeded `provisioning`
// one — nothing has shipped there yet — so it is the honest *genuinely empty*
// case, and it is what makes the route's two empty answers distinguishable by
// hand as well as by a test: an empty list with a plain note, beside an empty
// list carrying `degraded: true` and a reason.

import { clock, defineFixture } from './core/index.js';
import type { WorkflowRun } from '../lib/github-connector.js';

/**
 * A seeded run.
 *
 * `durationMs` is deliberately NOT a field. It is derived — `finishedAt` minus
 * `createdAt` — exactly as the live branch derives it from
 * `run_started_at` → `updated_at`, so a stored duration cannot drift away from
 * the two instants beside it (floor rule 1), and an unfinished run gets `null`
 * for the same reason the real one does rather than by a second convention.
 */
export interface WorkflowRunRow extends Omit<WorkflowRun, 'durationMs'> {
  /** `owner/name`, matching `agent_projects.repo_full_name`. */
  repo: string;
  /** Null while the run is queued or in progress — there is no end yet. */
  finishedAt: string | null;
}

/**
 * A finished run: started `startedHoursAgo` ago, took `minutes`.
 *
 * `keepWithinToday` is what makes "the last deploy ran today" true at 00:05
 * UTC as well as at 18:00 — the claim a deploy history is actually making is
 * about the *day*, and an unclamped age moves the newest run into yesterday
 * whenever the process is read just after UTC midnight. The end instant is
 * then clamped to `now`, because a run cannot finish in the future: on the
 * rare read where the clamp bites, the run reports a shorter duration rather
 * than an impossible one.
 */
function ran(
  startedHoursAgo: number,
  minutes: number,
  opts?: { keepWithinToday?: boolean },
): { createdAt: string; finishedAt: string } {
  const createdAt = clock.hoursAgo(startedHoursAgo, opts);
  const endMs = Math.min(Date.parse(createdAt) + minutes * 60_000, clock.now().getTime());
  return { createdAt, finishedAt: new Date(endMs).toISOString() };
}

const runUrl = (repo: string, id: number): string => `https://github.com/${repo}/actions/runs/${id}`;

const OBS = 'connorhoehnslalom/orgiq-observability';
const FINOPS = 'connorhoehnslalom/orgiq-finops';

/**
 * Workflow runs, per repository.
 *
 * `default` — a plausible fortnight for two of the three initiatives that
 *             have a seeded environment: a deploy still running, a failure
 *             followed by the fix that went green, and ordinary CI. Enough to
 *             exercise every branch the route and the portal have — a null
 *             conclusion, a null duration, a failure, and a run older than
 *             the default `limit=10` window.
 * `empty`   — no repository anywhere has any history. Declared explicitly
 *             because an undeclared scenario falls back to `default`, and this
 *             is the world the "no runs yet" copy is for.
 * `error`   — GitHub is unreachable. Throwing here is the *point*: it is how
 *             an auditor reaches the route's degraded answer over HTTP
 *             (`POST /api/__mock/scenario {"scenario":"error","fixture":"github-workflow-runs"}`)
 *             instead of unplugging a network, and it is what proves the
 *             degraded answer and the empty answer read differently.
 */
export const githubWorkflowRunRows = defineFixture<WorkflowRunRow>({
  key: 'github-workflow-runs',
  scenarios: {
    default: (): WorkflowRunRow[] => [
      // Still running: no conclusion, and therefore no duration.
      {
        repo: OBS, id: 17420881301, name: 'Deploy', status: 'in_progress', conclusion: null,
        branch: 'main', sha: '9f2c41ab7d0e5c3188b6a04f2e7d9c1b5a3e6f80', actor: 'ndasilva',
        createdAt: clock.hoursAgo(1, { keepWithinToday: true }), finishedAt: null,
        url: runUrl(OBS, 17420881301),
      },
      {
        repo: OBS, id: 17420130944, name: 'CI', status: 'completed', conclusion: 'success',
        branch: 'main', sha: '9f2c41ab7d0e5c3188b6a04f2e7d9c1b5a3e6f80', actor: 'ndasilva',
        ...ran(2, 6, { keepWithinToday: true }),
        url: runUrl(OBS, 17420130944),
      },
      // The interesting pair: a deploy that failed, and the deploy that fixed
      // it. A history with nothing but successes tells a reader nothing about
      // whether the page can render a failure at all.
      {
        repo: OBS, id: 17415602117, name: 'Deploy', status: 'completed', conclusion: 'failure',
        branch: 'main', sha: '4d81c6e290a7f3b5e0c2148d9a6f30bb71e4d5c2', actor: 'lhassan',
        ...ran(27, 9),
        url: runUrl(OBS, 17415602117),
      },
      {
        repo: OBS, id: 17415044820, name: 'Deploy', status: 'completed', conclusion: 'success',
        branch: 'main', sha: 'b70a5f19c4e83d6215af0c7b8e93d2416c5a0f77', actor: 'lhassan',
        ...ran(30, 11),
        url: runUrl(OBS, 17415044820),
      },
      {
        repo: OBS, id: 17409771265, name: 'CI', status: 'completed', conclusion: 'cancelled',
        branch: 'fix/alert-dedup', sha: '2c6b98d0417ae5f3c81d240b6e9f7a53d80c1e46', actor: 'lhassan',
        ...ran(52, 2),
        url: runUrl(OBS, 17409771265),
      },
      // Older than a default limit=10 page would reach on a busy repo — here
      // so the `limit` clamp has something to actually clamp.
      {
        repo: OBS, id: 17381209554, name: 'Nightly', status: 'completed', conclusion: 'success',
        branch: 'main', sha: 'e51d7b3a08c96f24d1b0a7e35c8492f6b1d07a3e', actor: 'ndasilva',
        ...ran(24 * 6, 18),
        url: runUrl(OBS, 17381209554),
      },
      {
        repo: FINOPS, id: 17419884012, name: 'Deploy', status: 'completed', conclusion: 'success',
        branch: 'main', sha: '7a0e2c9d61b84f37a5c0d1e8b26f409ac37b5d92', actor: 'lhassan',
        ...ran(5, 7, { keepWithinToday: true }),
        url: runUrl(FINOPS, 17419884012),
      },
      {
        repo: FINOPS, id: 17412667430, name: 'Cost report', status: 'completed', conclusion: 'success',
        branch: 'main', sha: '31fb59a7c082e4d6190b3a5c7e8d240fa96b1c05', actor: 'lhassan',
        ...ran(29, 3),
        url: runUrl(FINOPS, 17412667430),
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('GitHub /repos/.../actions/runs failed: HTTP 503');
    },
  },
});

/**
 * The offline half of `listWorkflowRuns` — same filter, order and clamp the
 * live branch applies, over the seeded rows instead of a page from the API.
 *
 * A repository with no rows returns `[]`, which is the honest answer and not
 * an error: the real endpoint answers exactly that for a repo whose Actions
 * have never run. The route is what turns the two apart — see its `degraded`
 * marker.
 */
export function mockWorkflowRuns(repoFullName: string, limit: number): WorkflowRun[] {
  return githubWorkflowRunRows
    .rows()
    .filter((r) => r.repo === repoFullName)
    .slice()
    // Newest first, matching the API default the live branch relies on.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(0, limit))
    .map(toWorkflowRun);
}

function toWorkflowRun(r: WorkflowRunRow): WorkflowRun {
  // Only a finished run has a meaningful duration — the same rule, and the
  // same arithmetic, as the live branch applies to run_started_at/updated_at.
  const ms = r.status === 'completed' && r.finishedAt
    ? Date.parse(r.finishedAt) - Date.parse(r.createdAt)
    : NaN;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.branch,
    sha: r.sha,
    actor: r.actor,
    createdAt: r.createdAt,
    url: r.url,
    durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
  };
}
