import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

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

  constructor(scope: Construct, id: string, props?: FoundationStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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

    new cdk.CfnOutput(this, 'DocumentsBucketArn', {
      value: this.documentsBucket.bucketArn,
      exportName: `${prefix}-documents-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketArn', {
      value: this.artifactsBucket.bucketArn,
      exportName: `${prefix}-artifacts-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'ScoresTableArn', {
      value: this.scoresTable.tableArn,
      exportName: `${prefix}-scores-table-arn`,
    });

    new cdk.CfnOutput(this, 'AgentBaseRoleArn', {
      value: this.agentBaseRole.roleArn,
      exportName: `${prefix}-agent-base-role-arn`,
    });
  }
}
