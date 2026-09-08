// resolveAgentName (routes/agents.ts) — org-leader.md defect #16.
//
// The recent-activity ring (lib/invocations.ts) merges live chat traffic
// recorded by this route with the dev:mock tail (mock/invocations.ts) for the
// SAME agent id. Before this fix, a live invocation recorded
// `agentName: agentId` ("orgiq-supervisor") while the mock tail records the
// registry's human display name ("Supervisor") for that same id — so the
// Invocations page's Agent select, which currently keys off agentName, saw
// two agents where there is only one. `resolveAgentName` closes the gap by
// asking the SAME agent registry (mock or real) both surfaces already use.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false } },
}));

const getRuntime = jest.fn();
jest.mock('../../providers/index.js', () => ({
  agentcore: { getRuntime, listRuntimes: jest.fn(async () => []), invokeAgentStreaming: jest.fn() },
  aurora: { fetchGraph: jest.fn(async () => ({ nodes: [] })) },
}));

import { resolveAgentName } from '../agents.js';

beforeEach(() => getRuntime.mockReset());

describe('resolveAgentName', () => {
  it('resolves the registry display name for a known agent id', async () => {
    getRuntime.mockResolvedValueOnce({ id: 'orgiq-supervisor', name: 'Supervisor' });
    await expect(resolveAgentName('orgiq-supervisor')).resolves.toBe('Supervisor');
    expect(getRuntime).toHaveBeenCalledWith('orgiq-supervisor');
  });

  it('falls back to the id when the runtime is unknown', async () => {
    getRuntime.mockResolvedValueOnce(null);
    await expect(resolveAgentName('orgiq-mystery')).resolves.toBe('orgiq-mystery');
  });

  it('falls back to the id when the runtime carries no name', async () => {
    getRuntime.mockResolvedValueOnce({ id: 'orgiq-search', name: '' });
    await expect(resolveAgentName('orgiq-search')).resolves.toBe('orgiq-search');
  });

  it('falls back to the id when the lookup throws (never breaks recording an invocation)', async () => {
    getRuntime.mockRejectedValueOnce(new Error('AgentCore control plane unreachable'));
    await expect(resolveAgentName('orgiq-advisor')).resolves.toBe('orgiq-advisor');
  });
});
