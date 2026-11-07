import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { protectData as protectDataFlag } from './context-flags';

export interface FoundationStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

/**
 * OrgIQ-Foundation: S3 buckets, DynamoDB tables, base IAM roles.
 * All other stacks reference resources created here.
 */
export class FoundationStack extends cdk.Stack {
  /** S3 bucket for raw document ingestion (transcripts, PRDs, wiki exports) */
  public readonly documentsBucket: s3.Bucket;
  /** S3 bucket for processed artifacts (embeddings, graph snapshots, reports) */
  public readonly artifactsBucket: s3.Bucket;
  /** DynamoDB table for expertise scores */
  public readonly scoresTable: dynamodb.Table;
  /** DynamoDB table for session state */
  public readonly sessionsTable: dynamodb.Table;
  /** DynamoDB table for leaderboard snapshots */
  public readonly leaderboardsTable: dynamodb.Table;
  /** Base execution role for AgentCore Runtime agents */
  public readonly agentBaseRole: iam.Role;

  /** Lazily-built custodian-resistant bucket emptier (see emptyBucketOnDestroy). */
  private emptierFn?: lambda.Function;
  private emptierProvider?: cr.Provider;

  constructor(scope: Construct, id: string, props?: FoundationStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';
    // The documents bucket holds every ingested source document; with
    // protectData (the default) it is RETAINed and never emptied on destroy.
    const protectData = protectDataFlag(this);

    // -------------------------------------------------------------------
    // S3 Buckets
    // -------------------------------------------------------------------

    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `${prefix}-documents-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      // RETAIN by default (protectData): this is the only copy of the source
      // documents. A throwaway stack (`-c protectData=false`) is DESTROY and
      // emptied by emptyBucketOnDestroy below — on the last such teardown a
      // RETAINed bucket orphaned 203 live versions that had to be emptied by
      // hand. Versioned, so the emptier removes every version AND delete
      // marker (a plain object delete only adds a marker).
      removalPolicy: protectData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `${prefix}-artifacts-${this.account}-${this.region}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'ExpireOldArtifacts',
          expiration: cdk.Duration.days(365),
        },
      ],
      // NB: no `autoDeleteObjects: true`. The CDK auto-delete custom resource
      // failed to destroy this stack in account 647757222309 with:
      //   AccessDenied ... not authorized to perform: s3:GetBucketTagging
      //   because no identity-based policy allows the s3:GetBucketTagging action
      // CDK grants the auto-delete provider role its S3 permissions ONLY through
      // a bucket *resource* policy (s3:GetBucket*/s3:List*/s3:DeleteObject*); the
      // role has no identity-based S3 access. This account's Cloud Custodian /
      // SCP layer trims bucket policies (it also silently revokes open SG
      // ingress), so that grant is gone by teardown and the provider is denied
      // on its very first call (getBucketTagging) -> bucket can't empty -> the
      // whole Foundation stack wedges in DELETE_FAILED. The provider also gates
      // on the `aws-cdk:auto-delete-objects` tag and rewrites the bucket policy
      // mid-teardown -- two more custodian-fragile dependencies. We instead empty
      // on delete via a role we own whose permissions are identity-based.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custodian-resistant teardown: empty both buckets on stack delete using an
    // emptier Lambda whose S3 permissions live on its own IAM role (identity-
    // based), not on a per-bucket resource policy the custodian layer strips.
    // The documents emptier stays in the template even when protected: a
    // custom resource REMOVED from a template runs its Delete handler, which
    // would empty the bucket on the deploy meant to protect it. Instead its
    // `Retain` property turns that Delete into a no-op.
    this.emptyBucketOnDestroy(this.documentsBucket, protectData);
    this.emptyBucketOnDestroy(this.artifactsBucket, false);

    // -------------------------------------------------------------------
    // DynamoDB Tables
    // -------------------------------------------------------------------

    this.scoresTable = new dynamodb.Table(this, 'ScoresTable', {
      tableName: `${prefix}-scores`,
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'scoreType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.scoresTable.addGlobalSecondaryIndex({
      indexName: 'by-team',
      partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'score', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `${prefix}-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.leaderboardsTable = new dynamodb.Table(this, 'LeaderboardsTable', {
      tableName: `${prefix}-leaderboards`,
      partitionKey: { name: 'boardId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rank', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.leaderboardsTable.addGlobalSecondaryIndex({
      indexName: 'by-person',
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'boardId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -------------------------------------------------------------------
    // Base IAM Role for AgentCore Runtime agents
    // -------------------------------------------------------------------

    this.agentBaseRole = new iam.Role(this, 'AgentBaseRole', {
      roleName: `${prefix}-agent-base-role`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('lambda.amazonaws.com'),
      ),
      description: 'Base role for OrgIQ AgentCore Runtime agents',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant read/write to S3 buckets
    this.documentsBucket.grantRead(this.agentBaseRole);
    this.artifactsBucket.grantReadWrite(this.agentBaseRole);

    // Grant read/write to DynamoDB tables
    this.scoresTable.grantReadWriteData(this.agentBaseRole);
    this.sessionsTable.grantReadWriteData(this.agentBaseRole);
    this.leaderboardsTable.grantReadWriteData(this.agentBaseRole);

    // Bedrock invoke permission
    this.agentBaseRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ApplyGuardrail',
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      exportName: `${prefix}-documents-bucket-name`,
    });

    new cdk.CfnOutput(this, 'DocumentsBucketArn', {
      value: this.documentsBucket.bucketArn,
      exportName: `${prefix}-documents-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: this.artifactsBucket.bucketName,
      exportName: `${prefix}-artifacts-bucket-name`,
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketArn', {
      value: this.artifactsBucket.bucketArn,
      exportName: `${prefix}-artifacts-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'ScoresTableName', {
      value: this.scoresTable.tableName,
      exportName: `${prefix}-scores-table-name`,
    });

    new cdk.CfnOutput(this, 'ScoresTableArn', {
      value: this.scoresTable.tableArn,
      exportName: `${prefix}-scores-table-arn`,
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      exportName: `${prefix}-sessions-table-name`,
    });

    new cdk.CfnOutput(this, 'AgentBaseRoleArn', {
      value: this.agentBaseRole.roleArn,
      exportName: `${prefix}-agent-base-role-arn`,
    });
  }

  /**
   * Empty a bucket (all object versions AND delete markers) when the stack is
   * destroyed, then let CloudFormation delete the now-empty bucket.
   *
   * This replaces `autoDeleteObjects: true`. The stock CDK provider is denied at
   * teardown in this account because it depends on grants the Cloud Custodian /
   * SCP layer removes (see the comment on the artifacts bucket). Here every
   * permission is an INLINE policy on the emptier Lambda's own role — the
   * durable, identity-based grant path — so nothing the custodian does to a
   * bucket *resource* policy or a bucket *tag* can stop teardown. There is also
   * no tag gate and no mid-teardown bucket-policy rewrite.
   *
   * A single Lambda + Provider is shared across buckets; each bucket gets its
   * own custom resource that depends on the bucket, so on delete the emptier
   * runs first (CloudFormation deletes in reverse dependency order) and the
   * bucket delete then finds it empty.
   */
  private emptyBucketOnDestroy(bucket: s3.Bucket, retain: boolean): void {
    if (!this.emptierFn) {
      this.emptierFn = new lambda.Function(this, 'BucketEmptierFn', {
        description: 'Empties OrgIQ-Foundation S3 buckets on stack destroy (versions + delete markers).',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.minutes(15),
        memorySize: 256,
        // AWS SDK v3 (@aws-sdk/client-s3) ships in the Node.js 20 Lambda runtime,
        // so this needs no bundling. Only runs on the custom resource's Delete.
        code: lambda.Code.fromInline([
          "const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');",
          'const s3 = new S3Client({});',
          'exports.handler = async (event) => {',
          "  if (event.RequestType !== 'Delete') return {};",
          "  if (event.ResourceProperties.Retain === 'true') return {};",
          '  const Bucket = event.ResourceProperties.BucketName;',
          '  try {',
          '    let KeyMarker, VersionIdMarker;',
          '    do {',
          '      const page = await s3.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }));',
          '      const objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])]',
          '        .map((o) => ({ Key: o.Key, VersionId: o.VersionId }));',
          '      if (objects.length > 0) {',
          '        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } }));',
          '      }',
          '      KeyMarker = page.NextKeyMarker;',
          '      VersionIdMarker = page.NextVersionIdMarker;',
          '    } while (KeyMarker || VersionIdMarker);',
          '  } catch (err) {',
          "    if (err && err.name === 'NoSuchBucket') return {};",
          '    throw err;',
          '  }',
          '  return {};',
          '};',
        ].join('\n')),
      });
      this.emptierProvider = new cr.Provider(this, 'BucketEmptierProvider', {
        onEventHandler: this.emptierFn,
      });
    }

    // Identity-based grants, scoped to this bucket. ListBucketVersions backs the
    // paginated listObjectVersions loop; DeleteObjectVersion is required to purge
    // a versioned bucket (plain DeleteObject only writes a delete marker).
    this.emptierFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [bucket.bucketArn],
    }));
    this.emptierFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [bucket.arnForObjects('*')],
    }));

    const cleaner = new cdk.CustomResource(this, `${bucket.node.id}Emptier`, {
      serviceToken: this.emptierProvider!.serviceToken,
      resourceType: 'Custom::EmptyBucketOnDestroy',
      // Only the documents bucket ever carries Retain=true; the artifacts
      // bucket keeps its original properties so its resource does not change.
      properties: { BucketName: bucket.bucketName, ...(retain ? { Retain: 'true' } : {}) },
    });
    // Force the emptier's Delete to run before the bucket's Delete.
    cleaner.node.addDependency(bucket);
  }
}
