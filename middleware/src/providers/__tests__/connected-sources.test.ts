// providers/connected-sources.ts under MOCK_AGENTCORE.
//
// borrowApiKey deliberately hands out no fake token in mock mode — see its own
// comment. It is the one thing this file must NEVER do differently just
// because lib/github-connector.ts now has fixtures of its own: those fixtures
// live above this boundary precisely so this function can keep refusing to
// pretend there's a vault. This suite pins that it still throws, for every
// kind, naming the provider and pointing at `npm run dev`.
//
// The rest of the file (list/connect/disconnect) already had a mock branch
// before this change; it had no test. Covered here too, since it's the
// boundary that makes the connector-level fixtures safe: a secret handed to
// connectApiKeySource must not come back out of listConnectedSources.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: true, guardrails: false, cloudwatch: false },
};
jest.mock('../../config.js', () => ({ config: mockConfig }));

import {
  listConnectedSources, connectApiKeySource, disconnectSource, borrowApiKey, providerNameFor,
} from '../connected-sources.js';
import { connectedSourceRows } from '../../mock/connected-sources.js';

beforeEach(() => {
  mockConfig.mock.agentcore = true;
  connectedSourceRows.reset();
});

describe('borrowApiKey in mock mode', () => {
  it('throws — never a fake token — for a github provider', async () => {
    await expect(borrowApiKey('orgiq-github-connorhoehnslalom'))
      .rejects.toThrow(/no credential vault in mock mode — orgiq-github-connorhoehnslalom is a fixture/);
  });

  it('throws for a kind with no reader either (jira) — the message doesn\'t pretend otherwise', async () => {
    await expect(borrowApiKey('orgiq-jira-platform'))
      .rejects.toThrow(/no credential vault in mock mode/);
  });

  it('names the real path out, so the error is actionable and not just a dead end', async () => {
    await expect(borrowApiKey('orgiq-github-connorhoehnslalom'))
      .rejects.toThrow(/npm run dev/);
  });
});

describe('the credential lifecycle in mock mode', () => {
  it('lists the seeded rows, sorted by name', async () => {
    const rows = await listConnectedSources();
    expect(rows.map((r) => r.name)).toEqual(
      [...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)),
    );
    expect(rows.some((r) => r.kind === 'github')).toBe(true);
  });

  it('connecting a source stores its existence but never the key, and it shows up in the next list', async () => {
    const { name } = await connectApiKeySource('github', 'a fresh org', 'super-secret-value');
    expect(name).toBe(providerNameFor('github', 'a fresh org'));

    const rows = await listConnectedSources();
    const created = rows.find((r) => r.name === name);
    expect(created).toBeDefined();
    expect(JSON.stringify(created)).not.toContain('super-secret-value');
  });

  it('disconnecting removes the row', async () => {
    const { name } = await connectApiKeySource('jira', 'temp', 'k');
    expect((await listConnectedSources()).some((r) => r.name === name)).toBe(true);
    await disconnectSource(name);
    expect((await listConnectedSources()).some((r) => r.name === name)).toBe(false);
  });
});
