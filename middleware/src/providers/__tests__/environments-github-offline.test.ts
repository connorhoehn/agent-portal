// The two offline branches behind `GET /api/environments/:id/runs`, driven for
// real with `config.mock` on.
//
// Nothing here is mocked except the config flags and `providers/aurora.js` —
// and aurora only so that a leak onto the live path is a loud failure instead
// of a silent AWS call. That is deliberate: the finding this file exists for
// is a MISSING mock branch, and a test that stubs the module under test can
// never see one. The route-level contract lives in
// routes/__tests__/environments-runs-degraded.test.ts.
//
// What was wrong before:
//
//   * `repoForInitiative` returned `null` unconditionally offline, so every
//     environment in `dev:mock` answered "No repository is linked to this
//     initiative" — a claim `schema/seed_program.sql` flatly contradicts,
//     since it links one repository to each of the fourteen initiatives.
//   * `listWorkflowRuns` had no mock branch at all. It reached api.github.com,
//     the route caught the failure, and the answer came back as an empty list
//     with a `200`. Every check stayed green.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));

// A call through here offline is the bug, not a fallback — so it throws rather
// than resolving to something a test could mistake for an answer.
jest.mock('../aurora.js', () => ({
  exec: jest.fn(async () => { throw new Error('aurora reached with config.mock.aurora on'); }),
}));

import { repoForInitiative } from '../environments.js';
import { listWorkflowRuns } from '../../lib/github-connector.js';
import { agentProjects } from '../../mock/agent-projects.js';
import { githubWorkflowRunRows } from '../../mock/github-runs.js';
import { fixtureRegistry } from '../../mock/core/index.js';

afterEach(() => { fixtureRegistry.resetAll('default'); });

describe('repoForInitiative, offline', () => {
  it('resolves the seeded repository instead of claiming none is linked', async () => {
    // Private, like every initiative repo — reached through the GitHub
    // credential the seed links it with.
    expect(await repoForInitiative('p-observability')).toEqual({
      repoFullName: 'connorhoehnslalom/orgiq-observability',
      connectionName: 'orgiq-github-connorhoehnslalom',
    });
  });

  it('agrees with the linked-codebase fixture for every seeded initiative', async () => {
    // One mapping, read twice — not a second copy that can drift from the
    // surface that lists linked repositories.
    for (const project of agentProjects.rows()) {
      const repo = await repoForInitiative(project.orgProjectId!);
      expect(repo?.repoFullName).toBe(project.repoFullName);
    }
  });

  it('answers null for an initiative the seed links no repository to', async () => {
    expect(await repoForInitiative('p-not-a-real-initiative')).toBeNull();
  });

  it('answers null once the fixture is emptied — an unlinked world is reachable', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await repoForInitiative('p-observability')).toBeNull();
  });
});

describe('listWorkflowRuns, offline', () => {
  it('returns seeded history without touching the network', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const runs = await listWorkflowRuns('connorhoehnslalom/orgiq-observability', 3);
      expect(runs).toHaveLength(3);
      expect(runs[0]!.url).toContain('connorhoehnslalom/orgiq-observability');
      // The branch sits ABOVE the token borrow and above the URL build. A mock
      // that fetched first and caught afterwards would be the original bug.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('clamps the limit the same way the live branch does', async () => {
    expect(await listWorkflowRuns('connorhoehnslalom/orgiq-observability', 1)).toHaveLength(1);
    // 0 and negatives clamp UP to 1, matching Math.min(Math.max(limit, 1), 50).
    expect(await listWorkflowRuns('connorhoehnslalom/orgiq-observability', 0)).toHaveLength(1);
  });

  it('answers [] for a linked repository with no history', async () => {
    expect(await listWorkflowRuns('connorhoehnslalom/orgiq-rag-search', 10)).toEqual([]);
  });

  it('THROWS under the error scenario, so the route can report a degraded upstream', async () => {
    // Without this an auditor could not reach the degraded answer over HTTP at
    // all — the only way to see it would be to unplug a network, which is the
    // "damage shared state and warn the next auditor" problem the control
    // plane exists to end.
    fixtureRegistry.resetAll('error');
    await expect(listWorkflowRuns('connorhoehnslalom/orgiq-observability', 10))
      .rejects.toThrow(/HTTP 503/);
    expect(githubWorkflowRunRows.rows('default').length).toBeGreaterThan(0);
  });
});
