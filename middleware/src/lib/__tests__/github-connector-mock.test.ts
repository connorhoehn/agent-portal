// github-connector.ts under MOCK_AGENTCORE (dev:mock).
//
// The previous state of the world: borrowApiKey throws "no credential vault in
// mock mode" (providers/connected-sources.ts, deliberately — see its own
// comment), so every one of these functions failed before it could ever reach
// api.github.com. That was honest but useless offline: /check and every
// /github/* route 502'd or 500'd regardless of what was asked.
//
// What's pinned here: identify/listRepos/listOrgs/readRepoSignal now branch to
// mock/github.ts's fixtures BEFORE calling borrowApiKey or fetch — not after a
// network failure. borrowApiKey itself is untouched and still throws; these
// tests assert it is never even called in mock mode, which is the strongest
// available proof that nothing here can reach api.github.com.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: true, guardrails: false, cloudwatch: false },
};

jest.mock('../../config.js', () => ({ config: mockConfig }));

const borrowApiKey = jest.fn(async () => {
  throw new Error('no credential vault in mock mode — borrowApiKey should not have been called');
});
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey }));

import { identify, listRepos, listOrgs, readRepoSignal } from '../github-connector.js';
import { githubRepoRows, githubSignalRows } from '../../mock/github.js';

describe('github-connector under MOCK_AGENTCORE', () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.mock.agentcore = true;
    fetchSpy = jest.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
  });

  it('identify() returns the fixture identity, never fetch, never borrowApiKey', async () => {
    const id = await identify('orgiq-github-connorhoehn');
    expect(id.login).toBe('connorhoehn');
    expect(id.scopes.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(borrowApiKey).not.toHaveBeenCalled();
  });

  it('listRepos() returns the seeded repo_full_name rows, most recently pushed first', async () => {
    const repos = await listRepos('orgiq-github-connorhoehn', {});
    expect(repos.length).toBe(githubRepoRows.rows().length);
    // agent_projects.repo_full_name from schema/seed_program.sql, not invented.
    expect(repos.map((r) => r.fullName)).toContain('connorhoehn/orgiq-observability');
    for (let i = 1; i < repos.length; i++) {
      expect((repos[i - 1]!.pushedAt ?? '') >= (repos[i]!.pushedAt ?? '')).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(borrowApiKey).not.toHaveBeenCalled();
  });

  it('listRepos() filters by org and returns empty for an org this fixture world has no repos under', async () => {
    const none = await listRepos('orgiq-github-connorhoehn', { org: 'some-other-org' });
    expect(none).toEqual([]);
    const some = await listRepos('orgiq-github-connorhoehn', { org: 'connorhoehnslalom' });
    expect(some.length).toBeGreaterThan(0);
  });

  it('listRepos() respects limit', async () => {
    const repos = await listRepos('orgiq-github-connorhoehn', { limit: 3 });
    expect(repos.length).toBe(3);
  });

  it('listOrgs() ignores the token it is handed and returns the fixture org, never fetch', async () => {
    const orgs = await listOrgs('');
    expect(orgs).toEqual([
      { login: 'connorhoehnslalom', description: expect.any(String) as unknown as string },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('readRepoSignal() returns the seeded contributors for a repo with fixture rows', async () => {
    const signals = await readRepoSignal('orgiq-github-connorhoehn', {
      owner: 'connorhoehnslalom', name: 'orgiq-observability', fullName: 'connorhoehn/orgiq-observability',
    });
    expect(signals.length).toBe(
      githubSignalRows.rows().filter((s) => s.repo === 'connorhoehn/orgiq-observability').length,
    );
    expect(signals[0]!.commits).toBeGreaterThanOrEqual(signals[signals.length - 1]!.commits);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(borrowApiKey).not.toHaveBeenCalled();
  });

  it('readRepoSignal() returns [] rather than an error for a repo with no sampled rows', async () => {
    const signals = await readRepoSignal('orgiq-github-connorhoehn', {
      owner: 'connorhoehnslalom', name: 'orgiq-mobile-app', fullName: 'connorhoehn/orgiq-mobile-app',
    });
    expect(signals).toEqual([]);
  });

  it('mutating a returned row does not corrupt the fixture for the next call', async () => {
    const first = await listRepos('orgiq-github-connorhoehn', {});
    (first[0] as { name: string }).name = 'tampered';
    const second = await listRepos('orgiq-github-connorhoehn', {});
    expect(second[0]!.name).not.toBe('tampered');
  });
});
