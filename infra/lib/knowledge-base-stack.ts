import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { trustedService } from './service-trust';
import { declaredKbPrefixes } from './kb-prefixes';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The documents S3 bucket to use as a data source */
  readonly documentsBucket: s3.IBucket;
  /** Aurora Serverless v2 cluster ARN (used as vector store) */
  readonly auroraClusterArn: string;
  /**
   * The Aurora MASTER secret. Used only by the init steps that create the
   * vector extension, table and indexes (DDL), never by the knowledge base.
   */
  readonly auroraCredentialsSecretArn: string;
  /**
   * The `orgiq_kb_service` login (schema/service_roles.sql) the knowledge base
   * reads and writes bedrock_kb as. Unset, the knowledge base uses the master
   * secret (the state before work item 19).
   */
  readonly knowledgeBaseSecretArn?: string;
  /**
   * The secret the middleware's knowledge-base registry hands to the KBs it
   * creates at run time (its own login, which owns their vector tables). The
   * shared KB service role must be able to read it.
   */
  readonly registrySecretArn?: string;
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
    // What the knowledge base itself authenticates as. NOTE: changing this on
    // a deployed stack REPLACES the knowledge base (StorageConfiguration is a
    // replacement property), and its id is exported; see SECURITY-NOTES.md.
    const kbSecretArn = props.knowledgeBaseSecretArn ?? props.auroraCredentialsSecretArn;
    const kbReadableSecrets = [...new Set([kbSecretArn, ...(props.registrySecretArn ? [props.registrySecretArn] : [])])];

    // -------------------------------------------------------------------
    // IAM Role for Bedrock Knowledge Base service
    // -------------------------------------------------------------------

    // All permissions are bundled as inlinePolicies on the Role resource so they are
    // fully attached before CloudFormation creates the KnowledgeBase resource.
    // Using addToPolicy() creates a separate AWS::IAM::Policy that races with KB creation,
    // causing Bedrock's validation call to fail with a 403 before the policy is attached.
    const kbRole = new iam.Role(this, 'KBServiceRole', {
      roleName: `${prefix}-kb-service-role`,
      // Only knowledge bases in this account (the CFN one and the registry's).
      assumedBy: trustedService(this, 'bedrock.amazonaws.com', `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`),
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
              resources: kbReadableSecrets,
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
              // The master (runs the DDL) and, when scoped, the KB login whose
              // password the DbInitKbLogin step sets.
              resources: [...new Set([props.auroraCredentialsSecretArn, kbSecretArn])],
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
      // Enablement is eventually consistent: on 2026-11-03 one SELECT 1
      // succeeded and the very next call (DbInitExtension, another Lambda)
      // still got "HttpEndpoint is not enabled", on both the first deploy and
      // deploy.sh's retry. So the endpoint counts as ready only after
      // STABLE consecutive successes; any transient resets the count.
      code: lambda.Code.fromInline(`
import boto3, time

TRANSIENT = (
    'HttpEndpoint is not enabled',
    'HttpEndpointNotEnabled',
    'DatabaseResuming',
    'is resuming',
)
STABLE = 6  # consecutive successes, 10s apart, before the endpoint counts as ready

def _run(data, props, sql, label):
    last = None
    for _ in range(54):
        try:
            data.execute_statement(resourceArn=props['ClusterArn'], secretArn=props['SecretArn'],
                                   database=props['Database'], sql=sql)
            return
        except Exception as e:
            last = str(e)
            if any(m in last for m in TRANSIENT):
                time.sleep(10)
                continue
            # Never echo the statement: the login step carries a password.
            raise Exception(f'{label} failed: {last[:300]}')
    raise Exception(f'{label}: Aurora Data API refused the statement until the deadline: {last}')


def _kb_login(data, props):
    # The knowledge base's own login (schema/service_roles.sql, work item 19),
    # created here so a fresh deploy can point the KB at it before anyone runs
    # apply_all_seed.py. Same rules as the applier: password from the secret,
    # refused (not escaped) if it holds a quote or backslash.
    import json, re
    role = props['LoginRole']
    if not re.fullmatch(r'[a-z_]+', role):
        raise Exception('bad role name')
    secret = boto3.client('secretsmanager').get_secret_value(SecretId=props['LoginSecretArn'])['SecretString']
    pw = json.loads(secret).get('password') or ''
    if not pw or set(pw) & set("'\\"\\\\" + chr(96) + "$;\\n\\r"):
        raise Exception('the KB login secret has no usable password')
    _run(data, props, f"DO $R$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN "
         f"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; "
         f"END IF; END $R$", 'create role')
    _run(data, props, f"ALTER ROLE {role} WITH LOGIN PASSWORD '{pw}'", 'set password')
    _run(data, props, f"GRANT CONNECT ON DATABASE {props['Database']} TO {role}", 'grant connect')
    _run(data, props, f"GRANT USAGE ON SCHEMA public TO {role}", 'grant usage')
    _run(data, props, f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bedrock_kb TO {role}", 'grant table')


def handler(event, context):
    pid = event.get('PhysicalResourceId', event['LogicalResourceId'])
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': pid}
    props = event['ResourceProperties']
    data = boto3.client('rds-data')
    last = None
    if props.get('LoginRole'):
        _kb_login(data, props)
        return {'PhysicalResourceId': pid}
    sql = props.get('Sql')
    if sql:
        # One idempotent schema statement, retried through the same
        # transients: the endpoint can answer one call and refuse the next.
        for _ in range(54):
            try:
                data.execute_statement(resourceArn=props['ClusterArn'], secretArn=props['SecretArn'],
                                       database=props['Database'], sql=sql)
                return {'PhysicalResourceId': pid}
            except Exception as e:
                last = str(e)
                if any(m in last for m in TRANSIENT):
                    time.sleep(10)
                    continue
                raise
        raise Exception('Aurora Data API refused the statement until the deadline: ' + str(last))
    stable = 0
    for _ in range(54):  # ~9 min at 10s cadence, inside the 10-min Lambda timeout
        try:
            data.execute_statement(
                resourceArn=props['ClusterArn'],
                secretArn=props['SecretArn'],
                database=props['Database'],
                sql='SELECT 1',
            )
            stable += 1
            if stable >= STABLE:
                return {'PhysicalResourceId': pid}
            time.sleep(10)
        except Exception as e:
            last = str(e)
            if any(m in last for m in TRANSIENT):
                stable = 0
                time.sleep(10)
                continue
            raise
    raise Exception('Aurora Data API did not become ready in time: ' + str(last))
`),
    });

    const dataApiProvider = new cr.Provider(this, 'DataApiReadyProvider', { onEventHandler: dataApiReadyFn });
    const dataApiReady = new cdk.CustomResource(this, 'DataApiReady', {
      serviceToken: dataApiProvider.serviceToken,
      properties: {
        ClusterArn: props.auroraClusterArn,
        SecretArn: props.auroraCredentialsSecretArn,
        Database: 'orgiq',
      },
    });

    // Each schema statement runs through the same Lambda (its `Sql` branch),
    // so it retries the endpoint transients instead of failing on the first
    // refusal: a single-shot AwsCustomResource call failed DbInitExtension and
    // later DbInitTextIndex on the 2026-11-03 rebuild, each time just after
    // the endpoint had answered. Every statement is IF NOT EXISTS.
    const rdsCall = (id: string, sql: string): cdk.CustomResource =>
      new cdk.CustomResource(this, id, {
        serviceToken: dataApiProvider.serviceToken,
        properties: {
          ClusterArn: props.auroraClusterArn,
          SecretArn: props.auroraCredentialsSecretArn,
          Database: 'orgiq',
          Sql: sql,
        },
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

    // The knowledge base's own login, before the knowledge base validates it.
    let kbReady: cdk.CustomResource = dbTextIndex;
    if (props.knowledgeBaseSecretArn) {
      kbReady = new cdk.CustomResource(this, 'DbInitKbLogin', {
        serviceToken: dataApiProvider.serviceToken,
        properties: {
          ClusterArn: props.auroraClusterArn,
          SecretArn: props.auroraCredentialsSecretArn,
          Database: 'orgiq',
          LoginRole: 'orgiq_kb_service',
          LoginSecretArn: props.knowledgeBaseSecretArn,
        },
      });
      kbReady.node.addDependency(dbTextIndex);
    }

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
          credentialsSecretArn: kbSecretArn,
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

    knowledgeBase.node.addDependency(kbReady);

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    // -------------------------------------------------------------------
    // S3 Data Sources: one per declared tenant prefix
    // -------------------------------------------------------------------
    //
    // tenants/kb-prefixes.json names each tenant's corpus prefixes (the same
    // map the middleware and the agents use to decide who owns a document).
    // Each prefix gets its own data source with that prefix as its only
    // inclusion prefix, so nothing outside a declared prefix is indexed and
    // every indexed chunk came from one tenant's prefix. Retrieval also
    // filters on the `tenant` metadata each document carries
    // (`<key>.metadata.json`); see infra/SECURITY-NOTES.md for the migration.

    const dataSources = declaredKbPrefixes().map(({ tenant, prefix: s3Prefix }) => {
      const slug = s3Prefix.replace(/\/+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
      const ds = new cdk.aws_bedrock.CfnDataSource(this, `DataSource-${tenant}-${slug}`, {
        name: `${prefix}-${tenant}-${slug}-source`,
        description: `S3 data source for tenant ${tenant}, prefix ${s3Prefix}`,
        knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
        dataSourceConfiguration: {
          type: 'S3',
          s3Configuration: {
            bucketArn: props.documentsBucket.bucketArn,
            inclusionPrefixes: [s3Prefix],
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
      return { tenant, s3Prefix, ds };
    });
    const sourceFor = (p: string) => dataSources.find((d) => d.s3Prefix === p)?.ds;
    // The registry's default row sits under orgiq/; the synthetic corpus under synth/.
    const s3DataSource = sourceFor('orgiq/') ?? dataSources[0]!.ds;
    const synthDataSource = sourceFor('synth/') ?? s3DataSource;

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

    // `schema/synth/load.py::sync_knowledge_base` reads BOTH `KnowledgeBaseId`
    // and `DataSourceId` from this stack's outputs and skips the ingestion job
    // when either is missing — it logs one warning and exits 0, so a full
    // corpus run reported success while the knowledge base stayed empty and
    // `query_knowledge_base` returned nothing. Only `KnowledgeBaseId` was
    // published, so that skip was unconditional.
    //
    // No exportName on purpose: the consumer reads stack outputs via
    // describe-stacks, and a CFN export cannot be changed or removed once
    // another stack imports it.
    new cdk.CfnOutput(this, 'DataSourceId', {
      value: s3DataSource.attrDataSourceId,
      description: 'The orgiq/ data source id (the registry default row) — the corpus load links the registry to it',
    });
    new cdk.CfnOutput(this, 'SynthDataSourceId', {
      value: synthDataSource.attrDataSourceId,
      description: 'The synth/ data source id — the corpus load syncs it',
    });
    new cdk.CfnOutput(this, 'TenantDataSources', {
      value: cdk.Fn.join('', [
        '{',
        cdk.Fn.join(',', dataSources.map(({ s3Prefix, ds }) => cdk.Fn.join('', [`"${s3Prefix}":"`, ds.attrDataSourceId, '"']))),
        '}',
      ]),
      description: 'JSON map of declared prefix to data source id (tenants/kb-prefixes.json)',
    });
  }
}
