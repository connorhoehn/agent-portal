import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreGatewayStack } from '../lib/agentcore-gateway-stack';

test('gateway graph queries ship the canonical guard and cannot read the admin secret', () => {
  const app = new cdk.App();
  const reader = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:reader';
  const admin = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin';
  const stack = new AgentCoreGatewayStack(app, 'GatewayReadOnlyTest', {
    env: { account: '123456789012', region: 'us-east-1' },
    auroraClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:orgiq',
    auroraCredentialsSecretArn: admin,
    auroraReadOnlySecretArn: reader,
    knowledgeBaseId: 'KB12345678', policyEngineArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/test-1234567890',
    policyEngineId: 'test-1234567890', agentRoles: {},
  });
  const template = Template.fromStack(stack);
  const fn = Object.values<any>(template.findResources('AWS::Lambda::Function'))
    .find(x => x.Properties.Handler === 'graph_traversal.handler');
  assert.equal(fn.Properties.Environment.Variables.AURORA_SECRET_ARN, reader);
  const pagerank = Object.values<any>(template.findResources('AWS::Lambda::Function'))
    .find(x => x.Properties.Handler === 'compute_pagerank.handler');
  assert.equal(pagerank.Properties.Environment.Variables.AURORA_SECRET_ARN, reader);
  assert.deepEqual(pagerank.Properties.Role, fn.Properties.Role);
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  const policies = Object.values<any>(template.findResources('AWS::IAM::Policy'))
    .filter(x => x.Properties.Roles.some((role: any) => role.Ref === roleId));
  assert.equal(policies.length, 1);
  const policy = JSON.stringify(policies[0].Properties.PolicyDocument);
  assert.ok(policy.includes(reader));
  assert.ok(!policy.includes(admin));
  assert.ok(!policy.includes('BatchExecuteStatement'));
  const assembly = app.synth();
  const bundledGuards = readdirSync(assembly.directory).filter(x => x.startsWith('asset.'))
    .map(x => join(assembly.directory, x, 'sql_guard.py')).filter(existsSync);
  assert.ok(bundledGuards.length > 0, 'deployed asset must contain the guard');
  for (const file of bundledGuards) assert.equal(readFileSync(file, 'utf8'),
    readFileSync(resolve('../agents/_shared/sql_guard.py'), 'utf8'));
});
