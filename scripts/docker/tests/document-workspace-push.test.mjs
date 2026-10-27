import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCUMENT_IMAGE_KEYS, documentConfigParameterName, planDocumentPush, workspaceConfig } from '../document-workspace-push.mjs';

const infra = (file) => readFileSync(new URL(`../../../infra/${file}`, import.meta.url), 'utf8');
const images = { GATEWAY_IMAGE: 'realtime-examples:document-907991255b14', PLATFORM_API_IMAGE: 'platform-api:document-9c0c96f428d9',
  CATALOG_IMAGE: 'event-catalog:document-b0bff824021a', MQ_IMAGE: 'message-queue:document-b93c6b7ff12f', REDIS_IMAGE: 'redis@sha256:' + 'a'.repeat(64) };

test('one repository per image key the CDK config requires', () => {
  const lib = infra('lib/document-workspace.ts');
  for (const key of Object.keys(DOCUMENT_IMAGE_KEYS)) assert.match(lib, new RegExp(`'${key}'`), `${key} is not a document image key`);
  const plan = planDocumentPush({ account: '647757222309', region: 'us-east-1', prefix: 'orgiq', images });
  assert.deepEqual(plan.images.map(i => i.repository), ['orgiq-documents-gateway', 'orgiq-documents-platform', 'orgiq-documents-catalog', 'orgiq-documents-mq', 'orgiq-documents-redis']);
  assert.equal(plan.images.find(i => i.key === 'gateway').remote, '647757222309.dkr.ecr.us-east-1.amazonaws.com/orgiq-documents-gateway:document-907991255b14');
  assert.equal(plan.images.find(i => i.key === 'redis').tag, 'pinned', 'a digest-pinned image gets a plain tag');
});

test('the context is what attachDocumentWorkspace validates, and deploy.sh reads its SSM copy back', () => {
  const digests = Object.fromEntries(Object.keys(DOCUMENT_IMAGE_KEYS).map(k => [k, 'sha256:' + 'b'.repeat(64)]));
  const config = workspaceConfig({ publicBaseUrl: 'https://d1.cloudfront.net', digests, prefix: 'orgiq', keyArns: { privateKey: 'arn:priv', publicKey: 'arn:pub' } });
  assert.equal(config.tenantId, 'assessment');
  assert.equal(config.architecture, 'ARM64');
  assert.notEqual(config.grantPrivateKeySecretArn, config.grantPublicKeySecretArn);
  for (const image of Object.values(config.images)) assert.match(image.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(infra('scripts/deploy.sh').includes('/${PREFIX}/documents/workspace-config'));
  assert.equal(documentConfigParameterName('orgiq'), '/orgiq/documents/workspace-config');
});
