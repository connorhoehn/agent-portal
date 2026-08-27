// listWorkflowRuns (lib/github-connector.ts) against a stubbed fetch.
//
// The mapping is where the honesty of this feature lives. `status` and
// `conclusion` are two different questions (where a run is vs. how it went) and
// GitHub returns both, so the mapper must not collapse them. `durationMs` is
// derived, and deriving it from an unfinished run's `updated_at` — the last
// heartbeat, not an end time — would show the reader a number that grows and
// shrinks at random. Those two are what these tests pin.
//
// Also pinned: this function issues exactly one GET and never a POST. It is
// the reporting half of a domain that deliberately has no dispatch half.

jest.mock('../../providers/connected-sources.js', () => ({
  borrowApiKey: jest.fn(async () => 'ghp_test_token'),
}));

import { listWorkflowRuns } from '../github-connector.js';
import { borrowApiKey } from '../../providers/connected-sources.js';

const borrowMock = borrowApiKey as unknown as jest.Mock;

interface Captured { url: string; init: RequestInit }
const calls: Captured[] = [];

function stubFetch(body: unknown, status = 200): void {
  calls.length = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  });
}

const RUN = {
  id: 4242,
  name: 'Deploy',
  status: 'completed',
  conclusion: 'failure',
  head_branch: 'main',
  head_sha: 'a1b2c3d4',
  actor: { login: 'bot-account' },
  triggering_actor: { login: 'priya' },
  created_at: '2026-08-20T10:00:00Z',
  run_started_at: '2026-08-20T10:00:05Z',
  updated_at: '2026-08-20T10:04:05Z',
  html_url: 'https://github.com/acme/obs/actions/runs/4242',
};

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
beforeEach(() => jest.clearAllMocks());

describe('listWorkflowRuns', () => {
  test('maps a completed run, keeping status and conclusion distinct', async () => {
    stubFetch({ workflow_runs: [RUN] });
    const [run] = await listWorkflowRuns('acme/obs', 10);
    expect(run).toEqual({
      id: 4242,
      name: 'Deploy',
      status: 'completed',
      conclusion: 'failure',
      branch: 'main',
      sha: 'a1b2c3d4',
      actor: 'priya',
      createdAt: '2026-08-20T10:00:00Z',
      url: 'https://github.com/acme/obs/actions/runs/4242',
      durationMs: 240_000,
    });
  });

  test('prefers the triggering actor over the run actor', async () => {
    // `actor` on a re-run is whoever pressed re-run's automation; the
    // triggering actor is the human whose name belongs on the row.
    stubFetch({ workflow_runs: [{ ...RUN, triggering_actor: null }] });
    const [run] = await listWorkflowRuns('acme/obs');
    expect(run!.actor).toBe('bot-account');
  });

  test('an unfinished run has a null duration, not a live-growing one', async () => {
    stubFetch({
      workflow_runs: [{ ...RUN, status: 'in_progress', conclusion: null, updated_at: '2026-08-20T10:02:00Z' }],
    });
    const [run] = await listWorkflowRuns('acme/obs');
    expect(run!.status).toBe('in_progress');
    expect(run!.conclusion).toBeNull();
    expect(run!.durationMs).toBeNull();
  });

  test('a repo with no runs is an empty list, not a throw', async () => {
    stubFetch({});
    await expect(listWorkflowRuns('acme/obs')).resolves.toEqual([]);
  });

  test('limit is clamped into the API range and passed as per_page', async () => {
    stubFetch({ workflow_runs: [] });
    await listWorkflowRuns('acme/obs', 5000);
    expect(calls[0]!.url).toContain('per_page=50');
    await listWorkflowRuns('acme/obs', 0);
    expect(calls[1]!.url).toContain('per_page=1');
  });

  test('a public repo is read with no credential at all', async () => {
    // No connectionName means no borrow from the vault, and no Authorization
    // header — `Bearer ` with nothing after it is a malformed credential.
    stubFetch({ workflow_runs: [] });
    await listWorkflowRuns('acme/public-repo', 5);
    expect(borrowMock).not.toHaveBeenCalled();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  test('a private repo borrows its token from the named connection', async () => {
    stubFetch({ workflow_runs: [] });
    await listWorkflowRuns('acme/obs', 5, { connectionName: 'github-main' });
    expect(borrowMock).toHaveBeenCalledWith('github-main');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ghp_test_token');
  });

  test('reads and only reads — one GET against the runs endpoint', async () => {
    stubFetch({ workflow_runs: [] });
    await listWorkflowRuns('acme/obs');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/repos/acme/obs/actions/runs');
    // fetch defaults to GET; anything else would be a dispatch, which this
    // domain deliberately does not do.
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });
});
