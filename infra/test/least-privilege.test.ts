/**
 * Work item 19 (docs/next-steps.md §8): named actions on named ARNs.
 *
 * Whole-app checks, so a new stack cannot quietly reintroduce what was removed:
 * `bedrock-agentcore:*` anywhere, or `GetAgentRuntime` on `*` (a runtime's
 * description carries its environment variables).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { synthApp } from './helpers/app-assembly';

const EVERYTHING = {
  deployRuntimes: 'true', deployDevbox: 'true', deployCanary: 'true', deployMiddlewareService: 'true',
  deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
};

/** Every IAM statement in the app, with where it lives. */
function statements(templates: Record<string, any>): Array<{ where: string; st: any }> {
  const out: Array<{ where: string; st: any }> = [];
  for (const [stack, t] of Object.entries(templates)) {
    for (const [id, r] of Object.entries<any>(t.Resources ?? {})) {
      const docs = r.Type === 'AWS::IAM::Role' ? (r.Properties.Policies ?? []).map((p: any) => p.PolicyDocument)
        : r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy' ? [r.Properties.PolicyDocument]
          : [];
      for (const d of docs) for (const st of d?.Statement ?? []) out.push({ where: `${stack}/${id}`, st });
    }
  }
  return out;
}
const actions = (st: any): string[] => [].concat(st.Action ?? []);
const resources = (st: any): unknown[] => [].concat(st.Resource ?? []);

describe('AgentCore grants name their actions and resources', () => {
  const all = statements(synthApp(EVERYTHING).templates);

  test('no bedrock-agentcore:* anywhere', () => {
    const hits = all.filter(({ st }) => actions(st).some((a) => a === 'bedrock-agentcore:*' || a === '*'));
    assert.deepEqual(hits.map((h) => h.where), []);
  });

  test('GetAgentRuntime and InvokeAgentRuntime are never granted on *', () => {
    const hits = all.filter(({ st }) =>
      actions(st).some((a) => a === 'bedrock-agentcore:GetAgentRuntime' || a === 'bedrock-agentcore:InvokeAgentRuntime')
      && resources(st).includes('*'));
    assert.deepEqual(hits.map((h) => h.where), []);
  });

  test('the gateway role holds exactly the three policy-engine actions, on the engine', () => {
    const gw = all.filter(({ where, st }) => where.startsWith('OrgIQ-AgentCoreGateway/GatewayRole')
      && actions(st).some((a) => a.startsWith('bedrock-agentcore:')));
    assert.deepEqual(gw.flatMap(({ st }) => actions(st)).sort(),
      ['bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:GetPolicyEngine', 'bedrock-agentcore:PartiallyAuthorizeActions']);
    for (const { st } of gw) assert.ok(!resources(st).includes('*'));
  });
});
