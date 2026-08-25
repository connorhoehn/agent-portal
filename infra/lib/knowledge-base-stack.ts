import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The documents S3 bucket to use as a data source */
  readonly documentsBucket: s3.IBucket;
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

    // All permissions are bundled as inlinePolicies on the Role resource so they are
    // fully attached before CloudFormation creates the KnowledgeBase resource.
    // Using addToPolicy() creates a separate AWS::IAM::Policy that races with KB creation,
    // causing Bedrock's validation call to fail with a 403 before the policy is attached.
    const kbRole = new iam.Role(this, 'KBServiceRole', {
      roleName: `${prefix}-kb-service-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Service role for Bedrock Knowledge Base (Aurora pgvector + S3 data source)',
      inlinePolicies: {
        KBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AuroraDataApi',
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
              ],
              resources: [props.auroraClusterArn],
            }),
            new iam.PolicyStatement({
              sid: 'AuroraDescribe',
              effect: iam.Effect.ALLOW,
              actions: ['rds:DescribeDBClusters'],
              resources: [props.auroraClusterArn],
            }),
            new iam.PolicyStatement({
              sid: 'AuroraCredentialsSecret',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.auroraCredentialsSecretArn],
            }),
            new iam.PolicyStatement({
              sid: 'BedrockEmbeddingAccess',
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'S3DocumentsRead',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.documentsBucket.bucketArn,
                `${props.documentsBucket.bucketArn}/*`,
              ],
            }),
          ],
        }),
      },
    });

    // -------------------------------------------------------------------
    // Aurora schema init — runs before KnowledgeBase creation
    // RDS Data API accepts one statement per call, so chain three CRs.
    // -------------------------------------------------------------------

    // Data API readiness gate — guards the DbInit* calls below against the
    // endpoint-enablement race.
    //
    // A freshly-created Aurora Serverless v2 cluster enables its RDS Data API
    // (HTTP endpoint) *asynchronously*: `enableHttpEndpoint: true` is accepted
    // at create time, but propagation lags — for a window after CREATE_COMPLETE
    // the Data API still rejects `executeStatement` with
    // `HttpEndpointNotEnabledException` ("HttpEndpoint is not enabled for
    // resource arn:...:cluster:orgiq-aurora"). On the FIRST KB deploy after a
    // cold cluster, DbInitExtension's `CREATE EXTENSION vector` fired inside
    // that window and failed, rolling back the whole stack; a later redeploy
    // only worked because the endpoint had since stabilised. Endpoint
    // enablement is monotonic (once live it stays live), so a single gate that
    // proves the Data API answers is enough to make every DbInit* call safe.
    //
    // We mirror aurora-stack's custom-resource idiom: a Python (boto3) inline
    // Lambda behind a cr.Provider. boto3 always ships the `rds-data` client, so
    // this avoids depending on which SDK clients the Node Lambda runtime bundles.
    const dataApiReadyRole = new iam.Role(this, 'DataApiReadyRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        DataApiProbe: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['rds-data:ExecuteStatement'],
              resources: [props.auroraClusterArn],
            }),
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.auroraCredentialsSecretArn],
            }),
          ],
        }),
      },
    });

    const dataApiReadyFn = new lambda.Function(this, 'DataApiReadyFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(10),
      role: dataApiReadyRole,
      // Poll a trivial `SELECT 1` until the endpoint answers. We retry only the
      // known cold-cluster transients — the endpoint still enabling, or the
      // serverless cluster resuming/scaling from zero — and re-raise anything
      // else (auth, missing DB) so real misconfiguration still fails loudly.
      code: lambda.Code.fromInline(`
import boto3, time

TRANSIENT = (
    'HttpEndpoint is not enabled',
    'HttpEndpointNotEnabled',
    'DatabaseResuming',
    'is resuming',
)

def handler(event, context):
    pid = event.get('PhysicalResourceId', 'data-api-ready')
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': pid}
    props = event['ResourceProperties']
    data = boto3.client('rds-data')
    last = None
    for _ in range(54):  # ~9 min at 10s cadence, inside the 10-min Lambda timeout
        try:
            data.execute_statement(
                resourceArn=props['ClusterArn'],
                secretArn=props['SecretArn'],
                database=props['Database'],
                sql='SELECT 1',
            )
            return {'PhysicalResourceId': pid}
        except Exception as e:
            last = str(e)
            if any(m in last for m in TRANSIENT):
                time.sleep(10)
                continue
            raise
    raise Exception('Aurora Data API did not become ready in time: ' + str(last))
`),
    });

    const dataApiReady = new cdk.CustomResource(this, 'DataApiReady', {
      serviceToken: new cr.Provider(this, 'DataApiReadyProvider', {
        onEventHandler: dataApiReadyFn,
      }).serviceToken,
      properties: {
        ClusterArn: props.auroraClusterArn,
        SecretArn: props.auroraCredentialsSecretArn,
        Database: 'orgiq',
      },
    });

    const rdsCall = (id: string, sql: string): cr.AwsCustomResource =>
      new cr.AwsCustomResource(this, id, {
        onCreate: {
          service: 'RDSDataService',
          action: 'executeStatement',
          parameters: {
            resourceArn: props.auroraClusterArn,
            secretArn: props.auroraCredentialsSecretArn,
            database: 'orgiq',
            sql,
          },
          physicalResourceId: cr.PhysicalResourceId.of(id),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['rds-data:ExecuteStatement'],
            resources: [props.auroraClusterArn],
          }),
          new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.auroraCredentialsSecretArn],
          }),
        ]),
      });

    const dbExtension = rdsCall('DbInitExtension', 'CREATE EXTENSION IF NOT EXISTS vector');
    // Gate the whole DbInit* chain: nothing runs until the Data API is proven
    // usable, so the endpoint-enablement race can no longer fail the first call.
    dbExtension.node.addDependency(dataApiReady);

    const dbTable = rdsCall(
      'DbInitTable',
      'CREATE TABLE IF NOT EXISTS bedrock_kb (id uuid PRIMARY KEY, embedding vector(1024), text text, metadata json)',
    );
    dbTable.node.addDependency(dbExtension);

    const dbIndex = rdsCall(
      'DbInitIndex',
      'CREATE INDEX IF NOT EXISTS bedrock_kb_emb_idx ON bedrock_kb USING hnsw (embedding vector_cosine_ops)',
    );
    dbIndex.node.addDependency(dbTable);

    // Bedrock also requires a GIN full-text index on the text column
    const dbTextIndex = rdsCall(
      'DbInitTextIndex',
      "CREATE INDEX IF NOT EXISTS bedrock_kb_text_idx ON bedrock_kb USING gin (to_tsvector('simple', text))",
    );
    dbTextIndex.node.addDependency(dbIndex);

    // -------------------------------------------------------------------
    // Bedrock Knowledge Base — RDS (Aurora pgvector) storage
    // -------------------------------------------------------------------

    const knowledgeBase = new cdk.aws_bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${prefix}-knowledge-base`,
      description: 'OrgIQ document knowledge base - meeting transcripts, PRDs, wiki exports',
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

    knowledgeBase.node.addDependency(dbTextIndex);

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
