/**
 * OrgIQ-KnowledgeBase.
 *
 * Two failures are encoded here. The first is the Data-API cold-start race:
 * `CREATE EXTENSION vector` fired before a freshly-created cluster had finished
 * enabling its HTTP endpoint, failed with HttpEndpointNotEnabledException, and
 * rolled back the whole stack — a redeploy "fixed" it only because the endpoint
 * had since stabilised. The second is the IAM race: permissions added with
 * addToPolicy() become a separate AWS::IAM::Policy that CloudFormation may
 * still be attaching when Bedrock validates the knowledge base, which 403s.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { knowledgeBaseStack } from './helpers/stacks';

const template = Template.fromStack(knowledgeBaseStack());

function dependsOn(resource: any): string[] {
  const deps = resource.DependsOn ?? [];
  return Array.isArray(deps) ? deps : [deps];
}

function byLogicalIdPrefix(type: string, prefix: string): [string, any] {
  const hit = Object.entries(template.findResources(type)).find(([id]) => id.startsWith(prefix));
  assert.ok(hit, `no ${type} with logical id starting "${prefix}"`);
  return hit as [string, any];
}

describe('the Data-API readiness gate', () => {
  test('a DataApiReady custom resource exists', () => {
    // Endpoint enablement is asynchronous and monotonic, so one probe that
    // proves `SELECT 1` answers makes every later DbInit* call safe.
    byLogicalIdPrefix('AWS::CloudFormation::CustomResource', 'DataApiReady');
  });

  test('the FIRST schema statement waits for it', () => {
    const [, extension] = byLogicalIdPrefix('Custom::AWS', 'DbInitExtension');
    assert.ok(
      dependsOn(extension).some((d) => d.startsWith('DataApiReady')),
      'DbInitExtension must depend on DataApiReady, or the cold-cluster race returns',
    );
  });

  test('the schema statements run in order — extension, table, vector index, text index', () => {
    // The RDS Data API takes one statement per call, so the ordering is
    // explicit DependsOn rather than a transaction. Out of order, the index
    // creation runs against a table that does not exist yet.
    const chain = ['DbInitExtension', 'DbInitTable', 'DbInitIndex', 'DbInitTextIndex'];
    for (let i = 1; i < chain.length; i++) {
      const [, resource] = byLogicalIdPrefix('Custom::AWS', chain[i]!);
      assert.ok(
        dependsOn(resource).some((d) => d.startsWith(chain[i - 1]!)),
        `${chain[i]} must depend on ${chain[i - 1]}`,
      );
    }
  });

  test('the knowledge base is created only after the schema exists', () => {
    const [, kb] = byLogicalIdPrefix('AWS::Bedrock::KnowledgeBase', 'KnowledgeBase');
    assert.ok(
      dependsOn(kb).some((d) => d.startsWith('DbInitTextIndex')),
      'Bedrock validates the vector table at create time — the GIN index must exist first',
    );
  });

  test('the readiness probe can reach the Data API and the secret', () => {
    const granted = Object.values<any>(template.findResources('AWS::IAM::Role'))
      .flatMap((r) => (r.Properties?.Policies ?? []) as any[])
      .flatMap((p) => (p.PolicyDocument?.Statement ?? []) as any[])
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    assert.ok(granted.includes('rds-data:ExecuteStatement'));
    assert.ok(granted.includes('secretsmanager:GetSecretValue'));
  });
});

describe('the KB service role is attached before Bedrock validates', () => {
  test('all of its permissions are inline on the Role, not a separate IAM::Policy', () => {
    // addToPolicy() emits an AWS::IAM::Policy that races KB creation; Bedrock's
    // validation call then fails with a 403 before the policy is attached.
    const roles = Object.entries(template.findResources('AWS::IAM::Role'));
    const kbRole = roles.find(([, r]) => r.Properties?.RoleName === 'orgiq-kb-service-role');
    assert.ok(kbRole, 'expected orgiq-kb-service-role');
    const [logicalId, role] = kbRole;
    assert.ok(
      (role.Properties?.Policies ?? []).length > 0,
      'the KB role must carry inlinePolicies',
    );
    for (const [id, policy] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
      const targets = (policy.Properties?.Roles ?? []) as any[];
      assert.ok(
        !targets.some((r) => r?.Ref === logicalId),
        `${id}: a detached AWS::IAM::Policy on the KB role reintroduces the 403 race`,
      );
    }
  });
});

describe('embeddings must match the pgvector column exactly', () => {
  test('Titan Embeddings V2 at 1024 dimensions', () => {
    // The dimension is specified at embedding time AND is the vector(1024)
    // column type in the bedrock_kb table. A mismatch is an ingestion-time
    // failure, not a synth-time one.
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: Match.objectLike({
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: Match.objectLike({
          EmbeddingModelConfiguration: {
            BedrockEmbeddingModelConfiguration: { Dimensions: 1024 },
          },
        }),
      }),
    });
    const kb = Object.values<any>(
      template.findResources('AWS::Bedrock::KnowledgeBase'),
    )[0];
    assert.match(
      JSON.stringify(kb.Properties.KnowledgeBaseConfiguration),
      /amazon\.titan-embed-text-v2:0/,
    );
  });

  test('the vector store is Aurora RDS, with the field mapping the DbInit table creates', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      StorageConfiguration: Match.objectLike({
        Type: 'RDS',
        RdsConfiguration: Match.objectLike({
          DatabaseName: 'orgiq',
          TableName: 'bedrock_kb',
          FieldMapping: {
            PrimaryKeyField: 'id',
            TextField: 'text',
            MetadataField: 'metadata',
            VectorField: 'embedding',
          },
        }),
      }),
    });
  });

  test('there is no OpenSearch Serverless collection here — that was the $345/mo idle bill', () => {
    template.resourceCountIs('AWS::OpenSearchServerless::Collection', 0);
  });
});

describe('exports', () => {
  for (const name of ['orgiq-knowledge-base-id', 'orgiq-knowledge-base-arn']) {
    test(`exports ${name}`, () => {
      template.hasOutput('*', { Export: { Name: name } });
    });
  }
});
