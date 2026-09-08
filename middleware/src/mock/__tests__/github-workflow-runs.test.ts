// The GitHub-backed READ that had no mock branch — `listWorkflowRuns` — and
// the fixture that gave it one.
//
// This gap was a different shape from the four in blank-route-fixtures.test.ts.
// Those 500'd, so the wire capture recorded `HTTP 500` and rule 4 could see
// them. This one did not: `GET /api/environments/:id/runs` catches, so an
// unreachable api.github.com came back as `{ runs: [], note }` with a cheerful
// `200`, indistinguishable from an idle repository. Nothing mechanical
// reported it; docs/mock-floor.md § "What the judge cannot see" named it by
// hand.
//
// What is asserted here is what the floor asks of a fixture, not merely that
// rows exist:
//
//   1. The fixture is REGISTERED, so `POST /api/__mock/reset` restores it and
//      the control plane can switch it.
//   2. `empty` is DECLARED — an undeclared scenario falls back to `default`,
//      so an unwritten `empty` would still hand the page eight runs.
//   3. `error` THROWS, on purpose: it is how an auditor reaches the route's
//      degraded answer over HTTP instead of unplugging a network.
//   4. Nothing derivable is stored. `durationMs` is the span between the two
//      instants on the row, never a field, and it is null while a run is
//      unfinished — the same rule the live branch applies.
//   5. Timestamps are sampled when the rows are BUILT, so freezing the clock
//      moves them; and the newest run stays inside today even at 00:05 UTC.
//   6. Repository names are the seeded `agent_projects.repo_full_name` rows,
//      not invented, because the route resolves its repo through the
//      initiative and a run on an unlinked repo is unreachable.

import { clock, freezeClock, fixtureRegistry } from '../core/index.js';
import { githubWorkflowRunRows, mockWorkflowRuns } from '../github-runs.js';
import { agentProjects } from '../agent-projects.js';

const OBS = 'connorhoehnslalom/orgiq-observability';
const FINOPS = 'connorhoehnslalom/orgiq-finops';
const RAG = 'connorhoehnslalom/orgiq-rag-search';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('registration and scenarios', () => {
  it('is in the shared registry, so the control plane can reach it', () => {
    expect(fixtureRegistry.get('github-workflow-runs')).toBe(githubWorkflowRunRows);
  });

  it('declares empty rather than inheriting default there', () => {
    expect(githubWorkflowRunRows.rows('empty')).toEqual([]);
    expect(githubWorkflowRunRows.rows('default').length).toBeGreaterThan(0);
  });

  it('throws under error — that is how the degraded answer is reachable at all', () => {
    expect(() => githubWorkflowRunRows.rows('error')).toThrow(/HTTP 503/);
  });

  it('reset puts the seeded history back after a scenario switch', () => {
    const before = githubWorkflowRunRows.rows().length;
    fixtureRegistry.resetAll('empty');
    expect(githubWorkflowRunRows.rows()).toEqual([]);
    fixtureRegistry.resetAll('default');
    expect(githubWorkflowRunRows.rows()).toHaveLength(before);
  });
});

describe('the rows say only what they can back up', () => {
  it('stores no durationMs — it is the span between the two instants', () => {
    for (const row of githubWorkflowRunRows.rows()) {
      expect(row).not.toHaveProperty('durationMs');
    }
    const runs = mockWorkflowRuns(OBS, 50);
    for (const run of runs) {
      const row = githubWorkflowRunRows.rows().find((r) => r.id === run.id)!;
      if (row.status === 'completed' && row.finishedAt) {
        expect(run.durationMs).toBe(Date.parse(row.finishedAt) - Date.parse(row.createdAt));
      } else {
        expect(run.durationMs).toBeNull();
      }
    }
  });

  it('gives an unfinished run no conclusion and no duration', () => {
    const running = mockWorkflowRuns(OBS, 50).filter((r) => r.status !== 'completed');
    expect(running.length).toBeGreaterThan(0);
    for (const run of running) {
      expect(run.conclusion).toBeNull();
      expect(run.durationMs).toBeNull();
    }
  });

  it('uses only GitHub run states and conclusions, copied from the connector', () => {
    // The enums are the ones lib/github-connector.ts's WorkflowRun documents;
    // a value outside them is a fixture inventing a wire string.
    const STATUSES = ['queued', 'in_progress', 'completed'];
    const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out'];
    for (const row of githubWorkflowRunRows.rows()) {
      expect(STATUSES).toContain(row.status);
      if (row.conclusion !== null) expect(CONCLUSIONS).toContain(row.conclusion);
      // A conclusion on an unfinished run, or none on a finished one, is the
      // pair of nonsense states the portal has no way to render.
      expect(row.conclusion === null).toBe(row.status !== 'completed');
    }
  });

  it('attributes every run to a repository the seed actually links', () => {
    const linked = new Set(agentProjects.rows('default').map((p) => p.repoFullName));
    for (const row of githubWorkflowRunRows.rows()) {
      expect(linked).toContain(row.repo);
    }
  });

  it('never claims a run finished before it started, or in the future', () => {
    const nowMs = clock.now().getTime();
    for (const row of githubWorkflowRunRows.rows()) {
      expect(Date.parse(row.createdAt)).toBeLessThanOrEqual(nowMs);
      if (row.finishedAt) {
        expect(Date.parse(row.finishedAt)).toBeGreaterThanOrEqual(Date.parse(row.createdAt));
        expect(Date.parse(row.finishedAt)).toBeLessThanOrEqual(nowMs);
      }
    }
  });
});

describe('timestamps come from the clock', () => {
  it('samples at read time, not at import', () => {
    const restore = freezeClock('2026-03-04T15:00:00.000Z');
    try {
      githubWorkflowRunRows.reset();
      const newest = mockWorkflowRuns(OBS, 1)[0]!;
      expect(newest.createdAt.startsWith('2026-03-04')).toBe(true);
    } finally {
      restore();
      githubWorkflowRunRows.reset();
    }
  });

  it('keeps the newest run inside today even at 00:05 UTC', () => {
    // The bug this guards is real: an unclamped "one hour ago" at 00:05 puts
    // the latest deploy in yesterday, and "the last deploy ran today" is the
    // claim a run list is actually making.
    const restore = freezeClock('2026-03-04T00:05:00.000Z');
    try {
      githubWorkflowRunRows.reset();
      const newest = mockWorkflowRuns(OBS, 1)[0]!;
      expect(newest.createdAt.startsWith('2026-03-04')).toBe(true);
    } finally {
      restore();
      githubWorkflowRunRows.reset();
    }
  });
});

describe('the selector behaves like the live branch', () => {
  it('returns newest first', () => {
    const runs = mockWorkflowRuns(OBS, 50);
    const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(runs).toEqual(sorted);
  });

  it('honours the limit', () => {
    expect(mockWorkflowRuns(OBS, 2)).toHaveLength(2);
    expect(mockWorkflowRuns(OBS, 50).length).toBeGreaterThan(2);
  });

  it('scopes to one repository', () => {
    expect(mockWorkflowRuns(FINOPS, 50).every((r) => r.url.includes('orgiq-finops'))).toBe(true);
  });

  it('answers [] for a linked repo with no history — the honest empty case', () => {
    // p-rag-search's environment is the seeded `provisioning` one. Nothing has
    // shipped there, and that has to be expressible without looking like a
    // failure — which is the whole point of the route's degraded marker.
    expect(mockWorkflowRuns(RAG, 50)).toEqual([]);
  });
});
