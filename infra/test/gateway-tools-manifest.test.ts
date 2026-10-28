import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreGatewayStack } from '../lib/agentcore-gateway-stack';
import { AGENT_NAMES } from '../lib/agentcore-runtime-stack';
import { loadGatewayToolManifest, parseGatewayToolManifest } from '../lib/gateway-tools-manifest';

const ADMIN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin';
const READER = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:reader';

function synth(manifest?: unknown) {
  const app = new cdk.App();
  const stack = new AgentCoreGatewayStack(app, 'GatewayManifestTest', {
    env: { account: '123456789012', region: 'us-east-1' },
    auroraClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:orgiq',
    auroraCredentialsSecretArn: ADMIN,
    auroraReadOnlySecretArn: READER,
    knowledgeBaseId: 'KB12345678',
    policyEngineArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/test-1234567890',
    policyEngineId: 'test-1234567890',
    ...(manifest === undefined ? {} : { manifest }),
  });
  return Template.fromStack(stack);
}

const shipped = () => JSON.parse(readFileSync(join(__dirname, '..', 'gateway-tools.json'), 'utf8'));
const cedar = (t: Template): string[] => Object.values<any>(t.findResources('AWS::BedrockAgentCore::Policy'))
  .map(p => JSON.stringify(p.Properties.Definition.Cedar.Statement).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' '));

test('the stack names no tool: tools exist only in infra/gateway-tools.json', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'agentcore-gateway-stack.ts'), 'utf8');
  assert.doesNotMatch(src, /pagerank|graph-traversal|knowledge-base-query/i);
});

test('one Lambda, one target and one tool schema per manifest entry', () => {
  const m = loadGatewayToolManifest(AGENT_NAMES);
  const t = synth();
  t.resourceCountIs('AWS::Lambda::Function', m.tools.length);
  t.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', m.tools.length);
  const targets = Object.values<any>(t.findResources('AWS::BedrockAgentCore::GatewayTarget'));
  assert.deepEqual(targets.map(x => x.Properties.Name).sort(), m.tools.map(x => `orgiq-${x.target}`).sort());
  for (const tool of m.tools) {
    const target = targets.find(x => x.Properties.Name === `orgiq-${tool.target}`);
    const payload = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload;
    assert.equal(payload.length, 1);
    assert.equal(payload[0].Name, tool.name);
  }
  const handlers = Object.values<any>(t.findResources('AWS::Lambda::Function')).map(f => f.Properties.Handler).sort();
  assert.deepEqual(handlers, m.tools.map(x => x.handler).sort());
});

test('already-deployed construct ids, function names and exports are unchanged', () => {
  const t = synth();
  for (const id of ['KBQueryLambda', 'GraphTraversalLambda', 'ComputePageRankLambda', 'KBQueryTarget',
    'GraphTraversalTarget', 'ComputePageRankTarget', 'GatewayToolsLambdaRole', 'GraphTraversalRole']) {
    assert.ok(Object.keys(t.toJSON().Resources).some(k => k.startsWith(id)), `${id} missing`);
  }
  const names = Object.values<any>(t.findResources('AWS::Lambda::Function')).map(f => f.Properties.FunctionName).sort();
  assert.deepEqual(names, ['orgiq-gateway-compute-pagerank', 'orgiq-gateway-graph-traversal', 'orgiq-gateway-kb-query']);
  const exports = Object.values<any>(t.toJSON().Outputs).map(o => o.Export?.Name).filter(Boolean);
  for (const n of ['orgiq-gateway-kb-query-lambda-arn', 'orgiq-gateway-graph-traversal-lambda-arn',
    'orgiq-gateway-compute-pagerank-lambda-arn', 'orgiq-mcp-gateway-id', 'orgiq-mcp-gateway-url']) {
    assert.ok(exports.includes(n), n);
  }
});

test('every Cedar principal is a runtime execution role and no policy has a bare action', () => {
  const statements = cedar(synth());
  assert.ok(statements.length > 0);
  for (const s of statements) {
    const principal = s.match(/principal == AgentCore::IamEntity::"([^"]*)"/)![1];
    assert.match(principal, /^arn:aws:iam::123456789012:role\/orgiq-[a-z-]+-execution-role$/);
    assert.match(s, /action in \[AgentCore::Action::"/);
    assert.doesNotMatch(s, /action,/);
    assert.doesNotMatch(s, /action\s*[;,)]/);
  }
});

test('an agent gets exactly the tools the manifest lists for it', () => {
  const t = synth();
  const search = cedar(t).find(s => s.includes('orgiq-search-execution-role'))!;
  assert.match(search, /orgiq-kb-query__knowledge-base-query/);
  assert.match(search, /orgiq-graph-traversal__graph-traversal/);
  assert.doesNotMatch(search, /compute-pagerank/);
  // ingestion is in no manifest entry: no policy, so the gateway denies it.
  assert.ok(!cedar(t).some(s => s.includes('orgiq-ingestion-execution-role')));
});

test('listed agents may InvokeGateway as their execution role', () => {
  const t = synth();
  const policies = Object.values<any>(t.findResources('AWS::IAM::Policy'))
    .filter(p => JSON.stringify(p.Properties.PolicyDocument).includes('bedrock-agentcore:InvokeGateway'));
  assert.equal(policies.length, 5);
  for (const p of policies) {
    assert.match(JSON.stringify(p.Properties.Roles), /orgiq-[a-z-]+-execution-role/);
  }
});

test('no gateway Lambda role can read the Aurora admin secret or write to Aurora', () => {
  const t = synth();
  const lambdaRoles = new Set(Object.values<any>(t.findResources('AWS::Lambda::Function'))
    .map(f => f.Properties.Role['Fn::GetAtt'][0]));
  const policies = Object.values<any>(t.findResources('AWS::IAM::Policy'))
    .filter(p => p.Properties.Roles.some((r: any) => lambdaRoles.has(r.Ref)));
  assert.ok(policies.length >= 2);
  for (const p of policies) {
    const doc = JSON.stringify(p.Properties.PolicyDocument);
    assert.ok(!doc.includes(ADMIN), 'admin secret must not be readable');
    assert.ok(!doc.includes('BatchExecuteStatement') && !doc.includes('BeginTransaction'));
  }
  const roleJson = JSON.stringify(Object.values(t.findResources('AWS::IAM::Role')).filter((_, i) => i >= 0));
  assert.ok(!roleJson.includes(ADMIN));
  // the KB tool's role holds no Aurora or model-invoke grant it never used
  const kbRole = Object.values<any>(t.findResources('AWS::Lambda::Function'))
    .find(f => f.Properties.Handler === 'kb_query.handler').Properties.Role['Fn::GetAtt'][0];
  const kbPolicy = JSON.stringify(Object.values<any>(t.findResources('AWS::IAM::Policy'))
    .filter(p => p.Properties.Roles.some((r: any) => r.Ref === kbRole)).map(p => p.Properties.PolicyDocument));
  assert.ok(!kbPolicy.includes('rds-data') && !kbPolicy.includes('InvokeModel') && kbPolicy.includes('bedrock:Retrieve'));
});

test('a manifest with aurora "admin", an unknown key or an unknown agent fails synth', () => {
  const bad = (edit: (tool: any) => void) => { const m = shipped(); edit(m.tools[0]); return m; };
  assert.throws(() => synth(bad(t => { t.access.aurora = 'admin'; })), /access\.aurora must be "none" or "reader"/);
  assert.throws(() => synth(bad(t => { t.iam = ['*']; })), /unknown key "iam"/);
  assert.throws(() => synth(bad(t => { t.access.statements = []; })), /unknown key "statements"/);
  assert.throws(() => synth(bad(t => { t.agents = ['nobody']; })), /unknown agent "nobody"/);
  assert.throws(() => synth(bad(t => { t.handler = 'missing_file.handler'; })), /does not exist/);
  assert.throws(() => parseGatewayToolManifest({ tools: [], extra: 1 }, AGENT_NAMES), /unknown key "extra"/);
  assert.throws(() => synth({ tools: [shipped().tools[0], shipped().tools[0]] }), /duplicate name/);
});

test('a fourth tool in a fixture manifest yields a fourth target with no TypeScript change', () => {
  const m = shipped();
  m.tools.push({
    name: 'people-lookup', target: 'people-lookup', handler: 'graph_traversal.handler',
    description: 'Fixture tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    access: { aurora: 'reader' }, timeoutSeconds: 20, memoryMb: 256, agents: ['search'],
  });
  const t = synth(m);
  t.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 4);
  t.resourceCountIs('AWS::Lambda::Function', 4);
  t.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', { Name: 'orgiq-people-lookup' });
  assert.match(cedar(t).find(s => s.includes('orgiq-search-execution-role'))!, /orgiq-people-lookup__people-lookup/);
});
