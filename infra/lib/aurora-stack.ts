import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
