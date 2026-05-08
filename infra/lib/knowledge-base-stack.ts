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
}

/**
 * OrgIQ-KnowledgeBase: OpenSearch Serverless collection + Bedrock Knowledge Base.
 * Uses Titan Embeddings V2 at 1024 dimensions.
 * NOTE: OpenSearch Serverless has a 2 OCU minimum billing even when idle.
 */
export class KnowledgeBaseStack extends cdk.Stack {
  /** The Knowledge Base ID */
  public readonly knowledgeBaseId: string;
  /** The OpenSearch Serverless collection ARN */
  public readonly collectionArn: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const collectionName = `${prefix}-kb-collection`;
    const indexName = `${prefix}-kb-index`;

    // -------------------------------------------------------------------
    // OpenSearch Serverless — Encryption Policy
    // -------------------------------------------------------------------

    const encryptionPolicy = new cdk.aws_opensearchserverless.CfnSecurityPolicy(
      this, 'EncryptionPolicy', {
        name: `${prefix}-enc-policy`,
        type: 'encryption',
        policy: JSON.stringify({
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
            },
          ],
          AWSOwnedKey: true,
        }),
      },
    );

    // -------------------------------------------------------------------
    // OpenSearch Serverless — Network Policy
    // -------------------------------------------------------------------

    const networkPolicy = new cdk.aws_opensearchserverless.CfnSecurityPolicy(
      this, 'NetworkPolicy', {
        name: `${prefix}-net-policy`,
        type: 'network',
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: 'collection',
                Resource: [`collection/${collectionName}`],
              },
              {
                ResourceType: 'dashboard',
                Resource: [`collection/${collectionName}`],
              },
            ],
            AllowFromPublic: true,
          },
        ]),
      },
    );

    // -------------------------------------------------------------------
    // OpenSearch Serverless — Collection
    // -------------------------------------------------------------------

    const collection = new cdk.aws_opensearchserverless.CfnCollection(
      this, 'KBCollection', {
        name: collectionName,
        type: 'VECTORSEARCH',
        description: 'OrgIQ Knowledge Base vector store (Titan Embeddings V2, 1024d)',
        standbyReplicas: 'DISABLED', // Cost optimization for dev
      },
    );

    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);

    this.collectionArn = collection.attrArn;

    // -------------------------------------------------------------------
    // IAM Role for Bedrock Knowledge Base service
    // -------------------------------------------------------------------

    const kbRole = new iam.Role(this, 'KBServiceRole', {
      roleName: `${prefix}-kb-service-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Service role for Bedrock Knowledge Base to access OpenSearch and S3',
    });

    // S3 read access to documents bucket
    props.documentsBucket.grantRead(kbRole);

    // OpenSearch Serverless data access
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OpenSearchServerlessAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'aoss:APIAccessAll',
      ],
      resources: [collection.attrArn],
    }));

    // Bedrock embedding model access
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbeddingAccess',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    // -------------------------------------------------------------------
    // OpenSearch Serverless — Data Access Policy
    // -------------------------------------------------------------------

    new cdk.aws_opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: `${prefix}-data-access`,
      type: 'data',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'index',
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
            },
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:DescribeCollectionItems',
                'aoss:UpdateCollectionItems',
              ],
            },
          ],
          Principal: [
            kbRole.roleArn,
            props.agentRoleArn,
          ],
        },
      ]),
    });

    // -------------------------------------------------------------------
    // Bedrock Knowledge Base (L1 - CfnKnowledgeBase)
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
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: collection.attrArn,
          fieldMapping: {
            metadataField: 'metadata',
            textField: 'text',
            vectorField: 'embedding',
          },
          vectorIndexName: indexName,
        },
      },
    });

    knowledgeBase.addDependency(collection);

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;

    // -------------------------------------------------------------------
    // Bedrock Knowledge Base — S3 Data Source
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
    (agentRole as iam.Role).addToPolicy?.(new iam.PolicyStatement({
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

    new cdk.CfnOutput(this, 'CollectionEndpoint', {
      value: collection.attrCollectionEndpoint,
      exportName: `${prefix}-opensearch-endpoint`,
    });

    new cdk.CfnOutput(this, 'CollectionArn', {
      value: collection.attrArn,
      exportName: `${prefix}-opensearch-collection-arn`,
    });
  }
}
