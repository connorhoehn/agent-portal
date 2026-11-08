// The two AgentCore control-plane providers in dev:mock.
//
// connected-sources: both List* calls carried `.catch(() => [])`, so offline
// the Ingest page's connected-sources panel showed an empty list with no error
// — the same picture a healthy account with nothing connected gives. Nothing
// distinguished them, and none of the panel's rows could be judged.
//
// capability-reconcile: offline every configured id was empty, so every row
// reported `unconfigured` — the one state that says nothing about whether the
// reconciliation works. Both sides are fixtures now and the real `probe` runs
// over them, which is what makes the sentences below the provider's own.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true },
    agentcore: {
      memoryId: '', browserId: '', browserProfileId: '', codeInterpreterId: '',
      workloadIdentityArn: '', policyEngineId: '', gatewayId: '',
    },
  },
}));

import { fixtureRegistry } from '../../mock/core/index.js';
import { capabilityInventoryRows } from '../../mock/capability-inventory.js';
import { reconcileCapabilities } from '../capability-reconcile.js';
import {
  borrowApiKey, connectApiKeySource, disconnectSource, listConnectedSources, providerNameFor,
} from '../connected-sources.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('connected credential sources in dev:mock', () => {
  it('lists sources whose names the kind can be read back out of', async () => {
    const sources = await listConnectedSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      // kindOf() parses the kind out of the name; a freehand name would make
      // every row `unknown` and the panel unreadable.
      expect(s.name).toBe(providerNameFor(s.kind as 'github', s.name.split('-').slice(2).join('-')));
      expect(s.kind).not.toBe('unknown');
    }
    // Both auth types are represented, so both render paths are reachable.
    expect(new Set(sources.map((s) => s.authType))).toEqual(new Set(['api-key', 'oauth2']));
  });

  it('walks connect → list → disconnect without storing the secret', async () => {
    const { name } = await connectApiKeySource('github', 'Acme Robotics', 'ghp_secret_value');
    expect(name).toBe('orgiq-github-acme-robotics');

    const listed = await listConnectedSources();
    const added = listed.find((s) => s.name === name);
    expect(added).toBeDefined();
    // Nothing anywhere in the listed row carries the token.
    expect(JSON.stringify(listed)).not.toContain('ghp_secret_value');

    await disconnectSource(name);
    expect((await listConnectedSources()).some((s) => s.name === name)).toBe(false);
  });

  it('refuses to hand out a fake credential', async () => {
    // A plausible-looking token would send the GitHub connector at
    // api.github.com and come back 401, which reads as "your token is wrong"
    // rather than "there is no vault here".
    await expect(borrowApiKey('orgiq-github-connorhoehn')).rejects.toThrow(/mock mode/);
  });

  it('has an empty world — nothing connected, which is not an error', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listConnectedSources()).toEqual([]);
  });
});

describe('capability reconciliation in dev:mock', () => {
  it('shows a healthy fleet with exactly one stale id, and names the live one', async () => {
    const { capabilities } = await reconcileCapabilities();
    expect(capabilities).toHaveLength(7);

    const stale = capabilities.filter((c) => c.state === 'missing');
    expect(stale.map((c) => c.key)).toEqual(['browserProfile']);
    // The point of the page: it says which env var to correct and what to.
    expect(stale[0]!.envVar).toBe('BROWSER_PROFILE_ID');
    expect(stale[0]!.detail).toContain('is stale');
    expect(stale[0]!.detail).toContain('orgiq_browser_profile-MOCK00PRF');

    // Everything else is present, so the one red row is legible.
    for (const ok of capabilities.filter((c) => c.key !== 'browserProfile')) {
      expect(ok.state).toBe('ok');
      expect(ok.detail).toBe('Configured and present in this account.');
    }
  });

  it('says "not set" when nothing is configured, which is not the same as stale', async () => {
    fixtureRegistry.resetAll('empty');
    const { capabilities } = await reconcileCapabilities();
    // `empty` clears BOTH sides: with no configured ids either, the honest
    // answer is `unconfigured`, not `missing`.
    for (const c of capabilities) {
      expect(c.state).toBe('unconfigured');
      expect(c.detail).toContain('is not set');
    }
  });

  it('reports missing — not unconfigured — when the ids outlive the resources', async () => {
    // The state a teardown actually leaves behind: .env.aws still names every
    // id, the account holds none of them. `rows()` is the live array, and
    // afterEach puts the seed back.
    capabilityInventoryRows.rows().length = 0;

    const { capabilities } = await reconcileCapabilities();
    for (const c of capabilities) {
      expect(c.state).toBe('missing');
      expect(c.detail).toContain('this account has none of these at all');
    }
  });
});
