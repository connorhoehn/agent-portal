/**
 * OrgIQ-Foundation — teardown hazards.
 *
 * Every assertion here exists because a teardown wedged. Read the failure each
 * one names before "simplifying" it: these are not property spot-checks, they
 * are the difference between `cdk destroy` finishing and a Foundation stack
 * stuck in DELETE_FAILED with a bucket nobody can empty.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { foundationStack } from './helpers/stacks';
import { actionsOf, statementsForRole } from './helpers/cfn';

const stack = foundationStack();
const template = Template.fromStack(stack);

function bucketByName(suffix: string): [string, any] {
  const hit = Object.entries(template.findResources('AWS::S3::Bucket')).find(
    ([, r]) => JSON.stringify(r.Properties?.BucketName ?? '').includes(suffix),
  );
  assert.ok(hit, `no bucket whose name contains "${suffix}"`);
  return hit as [string, any];
}

describe('OrgIQ-Foundation buckets can actually be deleted', () => {
  test('both buckets are DESTROY, not RETAIN — RETAIN orphaned 203 live versions on the last teardown', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    assert.equal(Object.keys(buckets).length, 2, 'expected exactly the documents + artifacts buckets');
    for (const [id, bucket] of Object.entries(buckets)) {
      assert.equal(
        bucket.DeletionPolicy,
        'Delete',
        `${id}: bucket must be RemovalPolicy.DESTROY — a RETAINed bucket has to be emptied and deleted by hand`,
      );
      assert.equal(bucket.UpdateReplacePolicy, 'Delete', `${id}: UpdateReplacePolicy must match`);
    }
  });

  test('the documents bucket stays versioned, so emptying it must purge versions AND delete markers', () => {
    // A plain DeleteObject on a versioned bucket only writes a delete marker.
    // The bucket is then still non-empty and CloudFormation still cannot
    // delete it. This is why the emptier lists object *versions*.
    const [, docs] = bucketByName('documents');
    assert.equal(docs.Properties?.VersioningConfiguration?.Status, 'Enabled');
  });

  test('NO aws-cdk:auto-delete-objects — the stock provider is denied by this account\'s custodian', () => {
    // CDK's autoDeleteObjects grants its provider S3 access ONLY through a
    // bucket *resource policy*, and tags the bucket with
    // `aws-cdk:auto-delete-objects` as its gate. Account 647757222309 runs a
    // Cloud Custodian layer that trims bucket policies, so by teardown the
    // provider is denied on its first call (s3:GetBucketTagging) with
    // "no identity-based policy allows the s3:GetBucketTagging action" — the
    // bucket never empties and Foundation wedges in DELETE_FAILED.
    const tagged = Object.entries(template.findResources('AWS::S3::Bucket')).filter(([, r]) =>
      ((r.Properties?.Tags ?? []) as any[]).some((t) => t?.Key === 'aws-cdk:auto-delete-objects'),
    );
    assert.deepEqual(tagged.map(([id]) => id), [], 'autoDeleteObjects must stay off');

    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  test('a self-role emptier custom resource covers BOTH buckets', () => {
    const emptiers = template.findResources('Custom::EmptyBucketOnDestroy');
    assert.equal(
      Object.keys(emptiers).length,
      2,
      'each bucket needs its own emptier custom resource, or the uncovered one blocks teardown',
    );
  });

  test('the emptier gets its S3 permissions from its OWN role, never a bucket policy', () => {
    // The whole point: identity-based grants survive a custodian that strips
    // bucket resource policies. If these ever move to a bucket policy, teardown
    // becomes custodian-fragile again.
    const roles = template.findResources('AWS::IAM::Role');
    const emptierPolicies = Object.values<any>(template.findResources('AWS::IAM::Policy')).filter(
      (p) => JSON.stringify(p.Properties?.PolicyDocument ?? {}).includes('s3:DeleteObjectVersion'),
    );
    assert.ok(emptierPolicies.length > 0, 'expected an identity-based policy granting s3:DeleteObjectVersion');

    const granted = new Set(
      emptierPolicies.flatMap((p) =>
        (p.Properties.PolicyDocument.Statement as any[]).flatMap(actionsOf),
      ),
    );
    for (const action of ['s3:ListBucket', 's3:ListBucketVersions', 's3:DeleteObject', 's3:DeleteObjectVersion']) {
      assert.ok(granted.has(action), `emptier role must allow ${action}`);
    }

    // And no AWS::S3::BucketPolicy carrying the delete grant instead.
    for (const [id, bp] of Object.entries(template.findResources('AWS::S3::BucketPolicy'))) {
      const doc = JSON.stringify(bp.Properties?.PolicyDocument ?? {});
      assert.ok(
        !doc.includes('s3:DeleteObject'),
        `${id}: delete permission must not live in a bucket resource policy — the custodian strips those`,
      );
    }
    assert.ok(Object.keys(roles).length > 0);
  });

  test('the emptier runs BEFORE the bucket delete (CFN deletes in reverse dependency order)', () => {
    for (const [id, cr] of Object.entries(template.findResources('Custom::EmptyBucketOnDestroy'))) {
      const deps = (cr.DependsOn ?? []) as string[] | string;
      const list = Array.isArray(deps) ? deps : [deps];
      assert.ok(
        list.some((d) => d.includes('Bucket')),
        `${id}: must DependsOn its bucket, or the emptier can run after the bucket is already gone`,
      );
    }
  });
});

describe('OrgIQ-Foundation exports the names other stacks import', () => {
  // FoundationStack is imported by Agents, MiddlewareService and the KB stack
  // via Fn.importValue on these literal names. Renaming one is a cross-stack
  // break that CloudFormation only reports at deploy time.
  const expected = [
    'orgiq-documents-bucket-name',
    'orgiq-documents-bucket-arn',
    'orgiq-artifacts-bucket-name',
    'orgiq-artifacts-bucket-arn',
    'orgiq-scores-table-name',
    'orgiq-scores-table-arn',
    'orgiq-sessions-table-name',
    'orgiq-agent-base-role-arn',
  ];
  for (const name of expected) {
    test(`exports ${name}`, () => {
      template.hasOutput('*', { Export: { Name: name } });
    });
  }
});

describe('OrgIQ-Foundation data that must survive a teardown', () => {
  test('scores and leaderboards tables are RETAIN — a destroy must not take the score history', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const byName = (n: string) =>
      Object.values<any>(tables).find((t) => t.Properties?.TableName === n);
    assert.equal(byName('orgiq-scores')?.DeletionPolicy, 'Retain');
    assert.equal(byName('orgiq-leaderboards')?.DeletionPolicy, 'Retain');
    // Sessions are ephemeral (TTL'd) and deliberately DESTROY.
    assert.equal(byName('orgiq-sessions')?.DeletionPolicy, 'Delete');
  });

  test('sessions table has a TTL attribute so it does not grow forever', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-sessions',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });
});

describe('OrgIQ-Foundation base agent role', () => {
  test('grants Bedrock invoke + guardrail + retrieve', () => {
    const statements = statementsForRole(template, 'orgiq-agent-base-role');
    const granted = new Set(statements.flatMap(actionsOf));
    for (const action of [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'bedrock:ApplyGuardrail',
      'bedrock:Retrieve',
    ]) {
      assert.ok(granted.has(action), `missing ${action}`);
    }
  });

  test('buckets stay private', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });
});
