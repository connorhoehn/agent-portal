import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCorePolicyStack, GATEWAY_TOOL_ALLOW_LIST, denyUnlistedToolsStatement } from '../lib/agentcore-policy-stack';
import { AgentCoreGatewayStack } from '../lib/agentcore-gateway-stack';
import { loadGatewayToolManifest, parseGatewayToolManifest } from '../lib/gateway-tools-manifest';
import { AGENT_NAMES } from '../lib/agentcore-runtime-stack';

// docs/next-steps.md §8 work item 22: the policy engine used to be created with
// no policies of its own. It now carries a deny-by-default guard that forbids
// every action except the read-only gateway tools on an explicit allow list.

const env = { account: '123456789012', region: 'us-east-1' };
const manifestJson = () => JSON.parse(readFileSync(join(__dirname, '..', 'gateway-tools.json'), 'utf8'));

function policies(stack: cdk.Stack): any[] {
  return Object.values<any>(Template.fromStack(stack).findResources('AWS::BedrockAgentCore::Policy'));
}

test('the engine carries one deny-by-default forbid capped at the allow list', () => {
  const stack = new AgentCorePolicyStack(new cdk.App(), 'PolicyTest', { env, prefix: 'orgiq' });
  Template.fromStack(stack).resourceCountIs('AWS::BedrockAgentCore::PolicyEngine', 1);
  const all = policies(stack);
  assert.equal(all.length, 1);
  const p = all[0].Properties;
  assert.equal(p.Name, 'orgiq_deny_unlisted_tools');
  assert.deepEqual(p.PolicyEngineId, { 'Fn::GetAtt': [Object.keys(Template.fromStack(stack).findResources('AWS::BedrockAgentCore::PolicyEngine'))[0], 'PolicyEngineId'] });
  const cedar: string = p.Definition.Cedar.Statement;
  assert.match(cedar, /^forbid \(\n  principal,\n  action,\n  resource\n\) unless \{/);
  assert.ok(!/\bpermit\b/.test(cedar), 'the guard grants nothing');
  const actions = [...cedar.matchAll(/AgentCore::Action::"([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(actions, [
    'orgiq-compute-pagerank___compute-pagerank',
    'orgiq-graph-traversal___graph-traversal',
    'orgiq-kb-query___knowledge-base-query',
  ]);
});

test('every allow-listed tool is read-only, and the list is the manifest exactly', () => {
  const manifest = loadGatewayToolManifest(AGENT_NAMES);
  assert.deepEqual([...GATEWAY_TOOL_ALLOW_LIST].sort(), manifest.tools.map(t => t.name).sort());
  for (const tool of manifest.tools) {
    assert.ok(tool.access.aurora === 'none' || tool.access.aurora === 'reader', tool.name);
    assert.equal(tool.access.bedrockInvoke, false, tool.name);
  }
});

test('a manifest tool missing from the allow list fails the synth loudly', () => {
  const manifest = manifestJson();
  manifest.tools.push({ ...manifest.tools[0], name: 'graph-delete', target: 'graph-delete', logicalId: 'GraphDelete' });
  assert.throws(() => new AgentCorePolicyStack(new cdk.App(), 'PolicyUnlisted', { env, manifest }),
    /"graph-delete" is in infra\/gateway-tools.json but not in GATEWAY_TOOL_ALLOW_LIST/);
});

test('an allow-listed tool that is not read-only fails the synth', () => {
  const manifest = manifestJson();
  const kb = manifest.tools.find((t: any) => t.name === 'knowledge-base-query');
  kb.access = { ...kb.access, bedrockInvoke: true };
  assert.throws(() => denyUnlistedToolsStatement('orgiq', parseGatewayToolManifest(manifest, AGENT_NAMES)), /not read-only/);
});

test('the guard names exactly the actions the gateway permits use', () => {
  const app = new cdk.App();
  const policyStack = new AgentCorePolicyStack(app, 'PolicyParity', { env, prefix: 'orgiq' });
  const gateway = new AgentCoreGatewayStack(app, 'GatewayParity', {
    env, prefix: 'orgiq',
    auroraClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:orgiq',
    auroraCredentialsSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin',
    auroraReadOnlySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:reader',
    knowledgeBaseId: 'KB12345678',
    policyEngineArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/test-1234567890',
    policyEngineId: 'test-1234567890',
  });
  const guarded = new Set([...policies(policyStack)[0].Properties.Definition.Cedar.Statement
    .matchAll(/AgentCore::Action::"([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]));
  const permitted = new Set<string>();
  for (const p of policies(gateway)) {
    const statement = JSON.stringify(p.Properties.Definition.Cedar.Statement);
    assert.match(statement, /permit/);
    for (const m of statement.matchAll(/AgentCore::Action::\\"([^"\\]+)\\"/g)) permitted.add(m[1]);
  }
  assert.ok(permitted.size > 0);
  for (const action of permitted) assert.ok(guarded.has(action), `${action} is permitted but the guard forbids it`);
  assert.deepEqual([...guarded].sort(), [...permitted].sort());
});
