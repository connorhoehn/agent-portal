import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface AuroraStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** ARN of the base agent role to grant RDS Data API access */
  readonly agentRoleArn: string;
}

/**
 * OrgIQ-Aurora: Aurora Serverless v2 cluster for pgvector (1024d) as the
 * Bedrock Knowledge Base vector store.
 *
 * Accessed exclusively via RDS Data API — no VPC NAT, no bastion required.
 * Idle cost: ~$0.06/hr (0.5 ACU minimum). Scales to 4 ACU under load.
 *
 * Extension setup (run once after first deploy, or via notebook 02):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
export class AuroraStack extends cdk.Stack {
  public readonly clusterArn: string;
  public readonly credentialsSecretArn: string;
  /**
   * Credential for `orgiq_graph_reader` — the SELECT-only role the read agents
   * use for model-authored SQL. See `readOnlySecret` below.
   */
  public readonly readOnlySecretArn: string;
  public readonly clusterEndpoint: string;
  public readonly dbName = 'orgiq';
  public readonly graphName = 'orgiq_graph';

  constructor(scope: Construct, id: string, props: AuroraStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // ---------------------------------------------------------------
    // VPC — isolated subnets only (Data API is the access path)
    // ---------------------------------------------------------------

    const vpc = new ec2.Vpc(this, 'AuroraVpc', {
      vpcName: `${prefix}-aurora-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ---------------------------------------------------------------
    // Parameter group — pg_stat_statements for query observability.
    // pgvector is a trusted extension; no shared_preload needed.
    // Apache AGE is not supported on Aurora PostgreSQL.
    // ---------------------------------------------------------------

    const paramGroup = new rds.ParameterGroup(this, 'ParamGroup', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      description: `${prefix} Aurora param group - pgvector`,
      parameters: {
        shared_preload_libraries: 'pg_stat_statements',
      },
    });

    // ---------------------------------------------------------------
    // Security group
    // ---------------------------------------------------------------

    const dbSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      securityGroupName: `${prefix}-aurora-sg`,
      description: 'OrgIQ Aurora Serverless v2',
      allowAllOutbound: false,
    });
    // Allow Bedrock and notebooks via RDS Data API (AWS-managed endpoint,
    // not a direct TCP connection — inbound rule is for direct client access
    // if a VPC endpoint is ever added later).
    dbSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Internal VPC PostgreSQL',
    );

    // ---------------------------------------------------------------
    // Aurora Serverless v2 cluster (PostgreSQL 16, pgvector).
    // Graph data is modeled as plain relational tables — see
    // schema/orgiq_schema.sql at the repo root.
    // ---------------------------------------------------------------

    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      clusterIdentifier: `${prefix}-aurora`,
      defaultDatabaseName: this.dbName,
      parameterGroup: paramGroup,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        publiclyAccessible: false,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      enableDataApi: true,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backup: { retention: cdk.Duration.days(1) },
    });

    this.clusterArn = cluster.clusterArn;
    this.credentialsSecretArn = cluster.secret!.secretArn;
    this.clusterEndpoint = cluster.clusterEndpoint.hostname;

    // ---------------------------------------------------------------
    // Read-only credential for the agents' model-authored SQL.
    //
    // `search` and `advisor` expose `query_graph(sql)`: the model writes the
    // SQL and the agent runs it verbatim through the Data API. A regex
    // (`agents/_shared/sql_guard.py`) inspects it first and stays, but a regex
    // over SQL an attacker influences is an argument about parsing. A role
    // that cannot write is a fact the engine enforces — this secret is that
    // role's credential.
    //
    // The Data API authenticates by secret ARN, which is the whole reason this
    // is a Secrets Manager secret and not a connection string: swapping the
    // credential is the only lever the caller has over what the database will
    // let it do.
    //
    // The password is GENERATED here and the matching database role is created
    // by `schema/graph_readonly_role.sql` with NO password —
    // `schema/apply_all_seed.py` reads this secret and issues the single
    // `ALTER ROLE ... PASSWORD` that joins the two. Until that runs the role
    // cannot authenticate at all: the failure mode is "reads stop", never
    // "reads succeed as someone who can write".
    //
    // `excludeCharacters` is load-bearing, not cosmetic: the applier inlines
    // this password into an `ALTER ROLE` statement (ALTER ROLE takes no bind
    // parameters), so a quote or backslash would be an escaping problem rather
    // than a formatting one. The applier re-checks the same character set and
    // refuses rather than escaping.
    const readOnlySecret = new secretsmanager.Secret(this, 'GraphReaderSecret', {
      secretName: `${prefix}-aurora-readonly-credentials`,
      description:
        `${prefix} Aurora — SELECT-only login (orgiq_graph_reader) for agent query_graph`,
      generateSecretString: {
        // The full RDS-shaped payload. The Data API needs username/password;
        // the rest is here so an operator debugging with psql has everything.
        secretStringTemplate: JSON.stringify({
          username: 'orgiq_graph_reader',
          engine: 'postgres',
          host: cluster.clusterEndpoint.hostname,
          port: 5432,
          dbname: this.dbName,
          dbClusterIdentifier: cluster.clusterIdentifier,
        }),
        generateStringKey: 'password',
        passwordLength: 40,
        excludeCharacters: '\'"\\`$;/@ ',
      },
      // NOTE for teardown: CloudFormation deletes a secret with a recovery
      // window, so a destroy → redeploy inside that window fails with
      // "already scheduled for deletion" on this fixed name. Recovery is one
      // command:
      //   aws secretsmanager delete-secret \
      //     --secret-id orgiq-aurora-readonly-credentials \
      //     --force-delete-without-recovery
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.readOnlySecretArn = readOnlySecret.secretArn;

    // ---------------------------------------------------------------
    // Fast-delete: a polling Lambda that calls DeleteDBCluster with
    // SkipFinalSnapshot=true and WAITS until the cluster is fully gone
    // before returning. This ensures CFN's subnet group / param group
    // cleanup never races against a still-deleting cluster.
    // ---------------------------------------------------------------

    const deleterRole = new iam.Role(this, 'AuroraDeleterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        RdsDelete: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['rds:DeleteDBCluster', 'rds:DescribeDBClusters'],
            resources: ['*'],
          })],
        }),
      },
    });

    const deleterFn = new lambda.Function(this, 'AuroraDeleterFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(14),
      role: deleterRole,
      code: lambda.Code.fromInline(`
import boto3, time

def handler(event, context):
    if event['RequestType'] != 'Delete':
        return {'PhysicalResourceId': event.get('PhysicalResourceId', 'aurora-deleter')}
    cluster_id = event['ResourceProperties']['ClusterId']
    rds = boto3.client('rds')
    try:
        rds.delete_db_cluster(
            DBClusterIdentifier=cluster_id,
            SkipFinalSnapshot=True,
            DeleteAutomatedBackups=True,
        )
    except rds.exceptions.DBClusterNotFoundFault:
        return {'PhysicalResourceId': cluster_id}
    except Exception as e:
        if 'DBClusterNotFoundFault' in str(e):
            return {'PhysicalResourceId': cluster_id}
        raise
    for _ in range(80):
        time.sleep(10)
        try:
            rds.describe_db_clusters(DBClusterIdentifier=cluster_id)
        except Exception as e:
            if 'DBClusterNotFoundFault' in str(e) or 'not found' in str(e).lower():
                return {'PhysicalResourceId': cluster_id}
    raise Exception(f'Timed out waiting for cluster {cluster_id} to delete')
`),
    });

    const auroraDeleter = new cdk.CustomResource(this, 'AuroraFastDeleter', {
      serviceToken: new cr.Provider(this, 'AuroraDeleterProvider', {
        onEventHandler: deleterFn,
      }).serviceToken,
      properties: { ClusterId: cluster.clusterIdentifier },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    auroraDeleter.node.addDependency(cluster);

    // CFN retains the L2 cluster + writer — already deleted by the time
    // CFN's cleanup pass runs, so skipping them avoids a double-delete error
    (cluster.node.defaultChild as rds.CfnDBCluster).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const cfnWriter = cluster.node.findChild('writer').node.findChild('Resource') as rds.CfnDBInstance;
    cfnWriter.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ---------------------------------------------------------------
    // Grant agent base role RDS Data API access
    // ---------------------------------------------------------------

    const agentRole = iam.Role.fromRoleArn(this, 'AgentBaseRole', props.agentRoleArn);

    agentRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'RdsDataApi',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [cluster.clusterArn],
    }));

    cluster.secret!.grantRead(agentRole);

    // ---------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: cluster.clusterArn,
      exportName: `${prefix}-aurora-cluster-arn`,
    });

    new cdk.CfnOutput(this, 'CredentialsSecretArn', {
      value: cluster.secret!.secretArn,
      exportName: `${prefix}-aurora-secret-arn`,
    });

    new cdk.CfnOutput(this, 'ReadOnlySecretArn', {
      value: readOnlySecret.secretArn,
      exportName: `${prefix}-aurora-readonly-secret-arn`,
      description:
        'SELECT-only Aurora login for the read agents. Pair with schema/graph_readonly_role.sql — see docs/readonly-graph-role.md',
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
      exportName: `${prefix}-aurora-endpoint`,
    });

    new cdk.CfnOutput(this, 'DbName', {
      value: this.dbName,
      exportName: `${prefix}-aurora-db-name`,
    });
  }
}
