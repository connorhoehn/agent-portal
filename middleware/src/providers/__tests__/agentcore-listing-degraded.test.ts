// The three AgentCore listings, and the distinction they used to destroy.
//
// `listRuntimes`, `listCodeSessions` and `listBrowserSessions` each caught
// their AWS call and returned `[]`. That is worse than the route-level swallow
// routes/cost.ts fixed, because a route can at least be TAUGHT to say
// `degraded` — a provider that has already collapsed "nothing is deployed" and
// "the call failed" into one value leaves the route nothing honest to say.
// CLAUDE.md records the consequence: an empty `ListAgentRuntimes` on a rebuilt
// account read as "the fleet is not deployed", and the agent detail page
// turned it into `404 No agent runtime matching "orgiq-supervisor"`.
//
// These tests are the both-halves check the swallowed-failure scan explicitly
// cannot make (see routes/__tests__/swallowed-failure-scan.test.ts, "it is a
// shape, not a semantics"): that the marker is TRUE on a failure, and ABSENT
// on a healthy empty read. One without the other proves nothing — a provider
// that marked everything degraded would pass a shape check and be useless.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    agentcore: { codeInterpreterId: '', browserId: '', browserProfileId: '' },
  },
}));

import { mockAgentCore } from '../agentcore.js';
import { fixtureRegistry, type ScenarioName } from '../../mock/core/index.js';
// Importing the fixture modules is what registers them; the world is switched
// through the registry, exactly as POST /api/__mock/scenario does it, rather
// than by mutating rows — which is the habit the mock floor exists to end.
import '../../mock/agent-statuses.js';
import '../../mock/capabilities.js';

const world = (scenario: ScenarioName): void => fixtureRegistry.resetAll(scenario);

afterEach(() => world('default'));

describe('listRuntimesResult', () => {
  it('reports a real fleet with no marker', async () => {
    const r = await mockAgentCore.listRuntimesResult();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.degraded).toBeUndefined();
  });

  it('reports an UNDEPLOYED fleet as an ordinary empty list', async () => {
    world('empty');
    expect(await mockAgentCore.listRuntimesResult()).toEqual({ items: [] });
  });

  it('reports an unreachable control plane as an empty list that says so', async () => {
    world('error');
    const r = await mockAgentCore.listRuntimesResult();
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.error).toContain('ListAgentRuntimes failed');
  });

  it('makes the two empties distinguishable — the whole point', async () => {
    world('empty');
    const quiet = await mockAgentCore.listRuntimesResult();
    world('error');
    const broken = await mockAgentCore.listRuntimesResult();
    expect(quiet.items).toEqual(broken.items);
    expect(quiet).not.toEqual(broken);
  });
});

describe('the lossy listRuntimes is deliberately still lossy — and still loud', () => {
  it('hands back rows and nothing else', async () => {
    expect(Array.isArray(await mockAgentCore.listRuntimes())).toBe(true);
  });

  it('THROWS on a mock failure rather than degrading to a silent empty', async () => {
    // GET /api/agents answers a bare array that five portal call sites read as
    // `AgentDef[]`, so it has nowhere to put a marker. Routing it through the
    // catch would have turned today's visible 500 into `200 []` — trading a
    // loud failure for exactly the invisible one this change removes. It keeps
    // throwing until that route's shape can change.
    world('error');
    await expect(mockAgentCore.listRuntimes()).rejects.toThrow(/control plane unreachable/);
  });
});

describe('listCodeSessionsResult', () => {
  it('leaves a healthy read unmarked', async () => {
    const r = await mockAgentCore.listCodeSessionsResult();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.degraded).toBeUndefined();
  });

  it('reports no sandbox running as an ordinary empty list', async () => {
    world('empty');
    expect(await mockAgentCore.listCodeSessionsResult()).toEqual({ items: [] });
  });

  it('names the failure a stale CODE_INTERPRETER_ID really produces', async () => {
    // CLAUDE.md: capability ids are minted fresh on every rebuild of
    // OrgIQ-AgentCoreCapabilities and .env.aws is not regenerated, so this is
    // the routine failure — and it rendered as "no sandbox is running".
    world('error');
    const r = await mockAgentCore.listCodeSessionsResult();
    expect(r.items).toEqual([]);
    expect(r.error).toMatch(/ResourceNotFoundException/);
  });
});

describe('listBrowserSessionsResult', () => {
  it('reports no browser open as an ordinary empty list', async () => {
    world('empty');
    expect(await mockAgentCore.listBrowserSessionsResult()).toEqual({ items: [] });
  });

  it('reports a dead browser as degraded — the documented SOFT failure', async () => {
    world('error');
    const r = await mockAgentCore.listBrowserSessionsResult();
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.error).toMatch(/Browser profile not found/);
  });
});
