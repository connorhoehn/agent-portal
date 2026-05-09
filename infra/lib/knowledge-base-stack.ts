import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The documents S3 bucket to use as a data source */
  readonly documentsBucket: s3.IBucket;
  /** ARN of the base agent role to grant KB access */
  readonly agentRoleArn: string;
  /** Aurora Serverless v2 cluster ARN (used as vector store) */
  readonly auroraClusterArn: string;
  /** Secrets Manager secret ARN for Aurora credentials */
  readonly auroraCredentialsSecretArn: string;
}

/**
 * OrgIQ-KnowledgeBase: Bedrock Knowledge Base backed by Aurora pgvector.
 *
 * Replaces OpenSearch Serverless (was ~$345/mo idle) with Aurora Serverless v2
 * pgvector, shared with the AGE graph cluster (~$0.06/hr idle floor).
 *
 * Prerequisites (run notebook 02 or the init script before ingesting):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE IF NOT EXISTS bedrock_kb (
 *     id uuid PRIMARY KEY,
 *     embedding vector(1024),
 *     text text,
 *     metadata json
 *   );
 *   CREATE INDEX ON bedrock_kb USING hnsw (embedding vector_cosine_ops);
 */
export class KnowledgeBaseStack extends cdk.Stack {
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // IAM Role for Bedrock Knowledge Base service
    // -------------------------------------------------------------------

    const kbRole = new iam.Role(this, 'KBServiceRole', {
      roleName: `${prefix}-kb-service-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Service role for Bedrock Knowledge Base (Aurora pgvector + S3 data source)',
    });

    // S3 read access to documents bucket
    props.documentsBucket.grantRead(kbRole);

    // Aurora Data API access for vector reads/writes
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraDataApi',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
      ],
      resources: [props.auroraClusterArn],
    }));

    // Read Aurora credentials secret
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraCredentialsSecret',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.auroraCredentialsSecretArn],
    }));

    // Bedrock Titan embedding model access
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbeddingAccess',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    // -------------------------------------------------------------------
    // Bedrock Knowledge Base — RDS (Aurora pgvector) storage
    // -------------------------------------------------------------------

    const knowledgeBase = new cdk.aws_bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${prefix}-knowledge-base`,
      description: 'OrgIQ document knowledge base — meeting transcripts, PRDs, wiki exports',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: 1024,
            },
          },
        },
      },
      storageConfiguration: {
        type: 'RDS',
        rdsConfiguration: {
          resourceArn: props.auroraClusterArn,
          credentialsSecretArn: props.auroraCredentialsSecretArn,
          databaseName: 'orgiq',
          tableName: 'bedrock_kb',
          fieldMapping: {
            primaryKeyField: 'id',
            textField: 'text',
            metadataField: 'metadata',
            vectorField: 'embedding',
          },
        },
      },
    });

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    // -------------------------------------------------------------------
    // S3 Data Source
    // -------------------------------------------------------------------

    new cdk.aws_bedrock.CfnDataSource(this, 'S3DataSource', {
      name: `${prefix}-documents-source`,
      description: 'S3 data source for organizational documents',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.documentsBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'SEMANTIC',
          semanticChunkingConfiguration: {
            breakpointPercentileThreshold: 95,
            bufferSize: 0,
            maxTokens: 512,
          },
        },
      },
    });

    // -------------------------------------------------------------------
    // Grant agent role KB retrieve access
    // -------------------------------------------------------------------

    const agentRole = iam.Role.fromRoleArn(this, 'AgentBaseRole', props.agentRoleArn);
    agentRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRetrieve',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
      ],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }));

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.attrKnowledgeBaseId,
      exportName: `${prefix}-knowledge-base-id`,
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseArn', {
      value: knowledgeBase.attrKnowledgeBaseArn,
      exportName: `${prefix}-knowledge-base-arn`,
    });
  }
}
