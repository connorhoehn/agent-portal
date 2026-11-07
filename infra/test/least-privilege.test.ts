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

describe('the Aurora master secret is for migrations (work item 19)', () => {
  const MASTER_IMPORTS = ['orgiq-aurora-secret-arn', 'OrgIQ-Aurora:ExportsOutputRefAuroraClusterSecretAttachment'];
  const holders = (templates: Record<string, any>) => Object.entries(templates)
    .filter(([name, t]) => name !== 'OrgIQ-Aurora' && MASTER_IMPORTS.some((m) => JSON.stringify(t).includes(m)))
    .map(([name]) => name).sort();

  test('only the schema init and the two observability jobs still import it', () => {
    // OrgIQ-KnowledgeBase: its DbInit* steps run the vector DDL (and create the
    // KB's own login). SpanProjector and PromptCanary write observability
    // tables and are not yet on a scoped login (SECURITY-NOTES.md, open items).
    assert.deepEqual(holders(synthApp(EVERYTHING).templates),
      ['OrgIQ-KnowledgeBase', 'OrgIQ-PromptCanary', 'OrgIQ-SpanProjector']);
  });

  test('the middleware runs as orgiq_app_middleware; dbMasterSecret=true restores the master for one release', () => {
    const env = (ctx: Record<string, string>) => {
      const t = synthApp(ctx).templates['OrgIQ-MiddlewareService'];
      const td = Object.values<any>(t.Resources).find((r) => r.Type === 'AWS::ECS::TaskDefinition'
        && r.Properties.ContainerDefinitions.some((c: any) => c.Name === 'middleware'));
      const c = td.Properties.ContainerDefinitions.find((x: any) => x.Name === 'middleware');
      return JSON.stringify(c.Environment.find((e: any) => e.Name === 'AURORA_SECRET_ARN').Value);
    };
    assert.match(env({}), /orgiq-aurora-middleware-secret-arn/);
    assert.match(env({ dbMasterSecret: 'true' }), /"orgiq-aurora-secret-arn"/);
  });
});
