import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { middlewareServiceStack } from './helpers/stacks';
import type { DocumentWorkspaceConfig } from '../lib/document-workspace';

const config: DocumentWorkspaceConfig = {
  tenantId: 'assessment', publicBaseUrl: 'https://assessment.example.test', grantIssuer: 'assessment-bff', grantKeyId: 'v1',
  grantPrivateKeySecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:document-private-abcdef',
  grantPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:document-public-abcdef',
  architecture: 'ARM64', sourceOwnerSub: 'assessment-steward',
  source: { url: 'https://accelerator.example.test', secretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:accelerator-source-abcdef' },
  images: Object.fromEntries(['gateway', 'platform', 'catalog', 'mq', 'redis'].map(name => [name, { repositoryName: `documents-${name}`, digest: 'sha256:' + 'a'.repeat(64) }])) as DocumentWorkspaceConfig['images'],
};
const context = { deployMiddlewareService: true, deployDocumentWorkspace: true };
const props = { certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/document-cert', cognitoUserPoolId: 'us-east-1_docs', documentWorkspace: config };

test('opt-in document workspace uses the exported backend composition with scoped signing identity', () => {
  const template = Template.fromStack(middlewareServiceStack(context, props));
  template.resourceCountIs('AWS::ECS::Service', 6);
  template.resourceCountIs('AWS::DynamoDB::Table', 53);
  template.resourceCountIs('AWS::EFS::FileSystem', 1);
  const tasks = Object.values<any>(template.findResources('AWS::ECS::TaskDefinition'));
  const containers = tasks.flatMap(task => task.Properties.ContainerDefinitions);
  const bff = containers.find(c => c.Name === 'middleware');
  assert.ok(bff.Secrets.some((s: any) => s.Name === 'ASSESSMENT_SOURCE_SECRET' && s.ValueFrom === config.source!.secretArn));
  assert.ok(bff.Environment.some((e: any) => e.Name === 'ASSESSMENT_SOURCE_URL' && e.Value === config.source!.url));
  assert.ok(bff.Secrets.some((s: any) => s.Name === 'DOCUMENT_GRANT_PRIVATE_KEY' && s.ValueFrom === config.grantPrivateKeySecretArn));
  assert.ok(bff.Environment.some((e: any) => e.Name === 'DOCUMENT_GATEWAY_PUBLIC_URL' && e.Value === 'wss://assessment.example.test/document-realtime'));
  assert.ok(bff.Environment.some((e: any) => e.Name === 'DOCUMENT_SOURCE_OWNER_SUB' && e.Value === 'assessment-steward'));
  assert.ok(bff.Environment.some((e: any) => e.Name === 'DOCUMENT_PLATFORM_INTERNAL_URL' && String(e.Value).startsWith('http://workspace-platform.')));
  for (const container of containers.filter(c => c.Name !== 'middleware')) {
    assert.ok(!container.Secrets?.some((s: any) => ['DOCUMENT_GRANT_PRIVATE_KEY', 'ASSESSMENT_SOURCE_SECRET'].includes(s.Name)));
    assert.ok(JSON.stringify(container.Image).includes('@sha256:'), `unpinned ${container.Name}`);
  }
  const workflows = containers.filter(c => ['gateway', 'platform'].includes(c.Name));
  for (const container of workflows) {
    assert.ok(container.Environment.some((e: any) => e.Name === 'DOCUMENT_TENANT_ID' && e.Value === 'assessment'));
    assert.ok(container.Environment.some((e: any) => e.Name === 'DOCUMENT_SESSION_EPOCH_URL' && e.Value === 'http://bff.orgiq-documents.local:3001/internal/document-grants/session'));
    assert.ok(container.Secrets.some((s: any) => s.Name === 'DOCUMENT_POLICY_SECRET'));
  }
  const rules = Object.values<any>(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
  assert.ok(rules.some(r => JSON.stringify(r.Properties.Conditions).includes('/internal/document-grants/*') && r.Properties.Actions[0].Type === 'fixed-response'));
  assert.ok(rules.some(r => JSON.stringify(r.Properties.Conditions).includes('/document-realtime') && JSON.stringify(r.Properties.Conditions).includes('/api/uploads/*')));
  const fs = Object.values<any>(template.findResources('AWS::EFS::FileSystem'))[0];
  assert.equal(fs.Properties.Encrypted, true);
  assert.equal(fs.DeletionPolicy, 'Retain');
  const policies = Object.values<any>(template.toJSON().Resources).filter(resource => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::Role'].includes(resource.Type));
  const allPolicies = JSON.stringify(policies);
  assert.ok(allPolicies.includes('elasticfilesystem:ClientWrite'));
  assert.ok(!allPolicies.includes('dynamodb:CreateTable'));
});

// Regression for a deploy-breaking omission rather than a style preference:
// platform-api runs five TTL preflights at startup and refuses connections in
// production when any fails, so a missing grant does not degrade the service,
// it rolls the whole stack update back through the service circuit breaker.
test('the platform role can describe AND update TTL on every table it preflights', () => {
  const template = Template.fromStack(middlewareServiceStack(context, props));
  const tables = template.findResources('AWS::DynamoDB::Table');
  const logicalIdFor = (suffix: string) => Object.entries(tables)
    .find(([, t]) => String(t.Properties.TableName).endsWith(suffix))?.[0];
  // Every statement attached to a platform task role, across the default policy
  // AND the overflow managed policy CDK spills into once the default is full.
  const statements = Object.entries(template.toJSON().Resources)
    .filter(([id, r]: [string, any]) => /platformTaskTaskRole/.test(id)
      && ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(r.Type))
    .flatMap(([, r]: [string, any]) => r.Properties.PolicyDocument.Statement);

  for (const suffix of ['social-outbox', 'document-video-sessions', 'pipeline-runs', 'pipeline-audit', 'pipeline-dlq']) {
    const logicalId = logicalIdFor(suffix);
    assert.ok(logicalId, `no table ends with ${suffix}`);
    for (const action of ['dynamodb:DescribeTimeToLive', 'dynamodb:UpdateTimeToLive']) {
      const granted = statements.some((s: any) => [].concat(s.Action ?? []).includes(action as never)
        && JSON.stringify([].concat(s.Resource ?? [])).includes(logicalId!));
      assert.ok(granted, `${action} not granted on ${suffix}`);
    }
  }
});

test('document services remain disabled unless explicitly requested', () => {
  const template = Template.fromStack(middlewareServiceStack({}, props));
  template.resourceCountIs('AWS::ECS::Service', 1);
  template.resourceCountIs('AWS::EFS::FileSystem', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
});

test('co-deployed Social and document proxies keep distinct private platform namespaces', () => {
  const template = Template.fromStack(middlewareServiceStack({ ...context, deploySocial: true }, props));
  const containers = Object.values<any>(template.findResources('AWS::ECS::TaskDefinition'))
    .flatMap(task => task.Properties.ContainerDefinitions);
  const env = Object.fromEntries(containers.find(c => c.Name === 'middleware').Environment.map((e: any) => [e.Name, e.Value]));
  assert.equal(env.SOCIAL_PLATFORM_INTERNAL_URL, 'http://social-platform.orgiq-social.local:3001');
  assert.equal(env.DOCUMENT_PLATFORM_INTERNAL_URL, 'http://workspace-platform.orgiq-documents.local:3001');
  assert.notEqual(env.SOCIAL_PLATFORM_INTERNAL_URL, env.DOCUMENT_PLATFORM_INTERNAL_URL);
});

test('requires BFF service, HTTPS, normal identity and concrete configuration', () => {
  assert.throws(() => middlewareServiceStack({ deployDocumentWorkspace: true }, props), /deployMiddlewareService/);
  assert.throws(() => middlewareServiceStack(context, { ...props, certificateArn: undefined }), /HTTPS/);
  assert.throws(() => middlewareServiceStack(context, { ...props, documentWorkspace: undefined }), /configuration/);
  assert.throws(() => middlewareServiceStack(context, { ...props, cognitoUserPoolId: undefined }), /identity pool/);
});

test('rejects mutable image references and non-origin public URLs', () => {
  assert.throws(() => middlewareServiceStack(context, { ...props, documentWorkspace: { ...config, images: { ...config.images, gateway: { ...config.images.gateway, digest: 'latest' } } } }), /immutable digest/);
  assert.throws(() => middlewareServiceStack(context, { ...props, documentWorkspace: { ...config, publicBaseUrl: 'http://localhost:8080' } }), /HTTPS origin/);
});


test('local-only document deployment does not require an accelerator source', () => {
  const template = Template.fromStack(middlewareServiceStack(context, { ...props, documentWorkspace: { ...config, source: undefined } }));
  assert.ok(!JSON.stringify(template.findResources('AWS::ECS::TaskDefinition')).includes('ASSESSMENT_SOURCE_SECRET'));
  assert.throws(() => middlewareServiceStack(context, { ...props, documentWorkspace: { ...config, source: { url: 'http://accelerator.example.test', secretArn: config.source!.secretArn } } }), /HTTPS URL/);
});
