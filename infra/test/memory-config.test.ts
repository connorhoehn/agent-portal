import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreMemoryStack } from '../lib/agentcore-memory-stack';
import { parseMemoryConfig } from '../lib/memory-config';
import { synthApp } from './helpers/app-assembly';
import { middlewareServiceStack } from './helpers/stacks';

function synth(config?: unknown, prefix?: string) {
  const app = new cdk.App();
  const stack = new AgentCoreMemoryStack(app, 'MemoryConfigTest', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...(config === undefined ? {} : { config }),
    ...(prefix ? { prefix } : {}),
  });
  return Template.fromStack(stack);
}

const memories = (t: Template) => Object.values<any>(t.findResources('AWS::BedrockAgentCore::Memory')).map(m => m.Properties);

test('the shipped config reproduces the one memory that is deployed today', () => {
  const t = synth();
  t.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  const [m] = memories(t);
  assert.equal(m.Name, 'orgiq_memory');
  assert.equal(m.EventExpiryDuration, 90);
  assert.equal(m.Description, 'OrgIQ memory store — semantic knowledge, user preferences, and conversation summaries');
  assert.deepEqual(m.MemoryStrategies, [
    { SemanticMemoryStrategy: { Name: 'semantic', Description: 'Factual knowledge about the organization extracted from conversations', NamespaceTemplates: ['/orgiq/{actorId}/semantic'] } },
    { SummaryMemoryStrategy: { Name: 'summary', Description: 'Conversation summaries for long-term context across sessions', NamespaceTemplates: ['/orgiq/{actorId}/{sessionId}/summary'] } },
    { UserPreferenceMemoryStrategy: { Name: 'user_preference', Description: 'User interaction preferences (formatting, verbosity, focus areas)', NamespaceTemplates: ['/orgiq/{actorId}/prefs'] } },
  ]);
  assert.deepEqual(Object.keys(t.findResources('AWS::BedrockAgentCore::Memory')).map(k => k.replace(/[0-9A-F]{8}$/, '')), ['Memory'], 'logical id stem unchanged');
});

test('one CfnMemory per tenant entry with its own expiry and strategies, and an SSM id each', () => {
  const t = synth({
    default: { eventExpiryDays: 90, strategies: [] },
    tenants: {
      orgiq: { strategies: ['summary', 'user_preference'] },
      assessment: { eventExpiryDays: 365 },
      social: { eventExpiryDays: 30, strategies: ['summary'] },
    },
  });
  t.resourceCountIs('AWS::BedrockAgentCore::Memory', 3);
  const by = Object.fromEntries(memories(t).map(m => [m.Name, m]));
  assert.equal(by.orgiq_memory.EventExpiryDuration, 90);
  assert.deepEqual(by.orgiq_memory.MemoryStrategies.map((s: any) => Object.keys(s)[0]),
    ['SummaryMemoryStrategy', 'UserPreferenceMemoryStrategy']);
  assert.equal(by.orgiq_assessment_memory.EventExpiryDuration, 365);
  assert.equal(by.orgiq_assessment_memory.MemoryStrategies, undefined, 'no strategies means none are created');
  assert.equal(by.orgiq_social_memory.EventExpiryDuration, 30);
  assert.deepEqual(by.orgiq_social_memory.MemoryStrategies[0].SummaryMemoryStrategy.NamespaceTemplates,
    ['/orgiq/social/{actorId}/{sessionId}/summary']);
  const params = Object.values<any>(t.findResources('AWS::SSM::Parameter')).map(p => p.Properties.Name).sort();
  assert.deepEqual(params, ['/orgiq/memory/assessment/id', '/orgiq/memory/orgiq/id', '/orgiq/memory/social/id']);
});

test('a different prefix moves the names and the SSM path', () => {
  const t = synth({ default: { eventExpiryDays: 30 }, tenants: { orgiq: {} } }, 'pv1');
  assert.equal(memories(t)[0].Name, 'pv1_memory');
  t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/pv1/memory/orgiq/id' });
});

test('no memory access policy is left unattached', () => {
  const t = synth();
  t.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  t.resourceCountIs('AWS::IAM::Policy', 0);
});

test('an unknown strategy, tenant or key fails synth', () => {
  assert.throws(() => synth({ default: { eventExpiryDays: 90 }, tenants: { orgiq: { strategies: ['episodic'] } } }), /unknown strategy "episodic"/);
  assert.throws(() => synth({ default: { eventExpiryDays: 90 }, tenants: { newsroom: {} } }), /unknown tenant "newsroom"/);
  assert.throws(() => synth({ default: { eventExpiryDays: 90 }, tenants: { orgiq: { ttl: 1 } } }), /unknown key "ttl"/);
  assert.throws(() => parseMemoryConfig({ default: { eventExpiryDays: 3 }, tenants: {} }), /7\.\.365/);
  assert.throws(() => parseMemoryConfig({ tenants: {} }), /eventExpiryDays is required/);
  assert.throws(() => parseMemoryConfig({ default: { eventExpiryDays: 90 } }), /tenants/);
});

test('consumers read the id from SSM; app.ts imports no memory export', () => {
  assert.doesNotMatch(readFileSync(join(__dirname, '..', 'bin', 'app.ts'), 'utf8'), /memory-id/);
  const app = synthApp();
  for (const name of ['OrgIQ-AgentCoreRuntime', 'OrgIQ-MiddlewareService']) {
    const json = JSON.stringify(app.templates[name]);
    assert.ok(!json.includes('orgiq-memory-id'), `${name} still imports the export`);
    const param = Object.values<any>(app.templates[name].Parameters ?? {})
      .find(p => p.Default === '/orgiq/memory/orgiq/id');
    assert.ok(param, `${name} lacks the SSM parameter`);
    assert.equal(param.Type, 'AWS::SSM::Parameter::Value<String>');
  }
});

test('the legacy orgiq export is the only memory export left, kept for the first deploy', () => {
  const out = synth().toJSON().Outputs;
  assert.deepEqual(Object.values<any>(out).map(o => o.Export.Name).sort(), ['orgiq-memory-arn', 'orgiq-memory-id']);
});

test('the BFF gets MEMORY_ID_<TENANT> and a grant on exactly the memories it is given', () => {
  const stack = middlewareServiceStack({}, {
    memoryId: undefined,
    memoryIdParameter: '/orgiq/memory/orgiq/id',
    tenantMemoryIdParameters: { assessment: '/orgiq/memory/assessment/id' },
  });
  const t = Template.fromStack(stack);
  const params = Object.values<any>(t.toJSON().Parameters).map(p => p.Default);
  assert.ok(params.includes('/orgiq/memory/orgiq/id') && params.includes('/orgiq/memory/assessment/id'));
  const env = JSON.stringify(Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions[0].Environment);
  assert.match(env, /"MEMORY_ID"/);
  assert.match(env, /"MEMORY_ID_ASSESSMENT"/);
  const grant = Object.values<any>(t.findResources('AWS::IAM::Policy'))
    .flatMap(p => p.Properties.PolicyDocument.Statement).find((s: any) => s.Sid === 'AgentCoreMemoryEvents');
  assert.equal(grant.Resource.length, 2);
  assert.ok(!JSON.stringify(grant.Resource).includes('memory/*'));
});
