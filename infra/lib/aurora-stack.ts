import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
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
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
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
    // Aurora Serverless v2 cluster (PostgreSQL 16, pgvector + AGE)
    // ---------------------------------------------------------------

    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
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
    // Fast-delete: pre-delete the writer instance then the cluster
    // with SkipFinalSnapshot + DeleteAutomatedBackups before CFN's
    // own cleanup pass. Turns a 30+ min destroy into ~2 min.
    //
    // Delete order (CFN reverses dependencies):
    //   1. WriterDeleter.onDelete  → DeleteDBInstance
    //   2. ClusterDeleter.onDelete → DeleteDBCluster (SkipFinalSnapshot)
    //   3. CFN retains the L2 cluster + instance resources (already gone)
    // ---------------------------------------------------------------

    const clusterDeleter = new cr.AwsCustomResource(this, 'ClusterDeleter', {
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['rds:DeleteDBCluster', 'rds:DescribeDBClusters'],
          resources: ['*'],
        }),
      ]),
      onCreate: {
        service: 'RDS',
        action: 'describeDBClusters',
        parameters: { DBClusterIdentifier: cluster.clusterIdentifier },
        physicalResourceId: cr.PhysicalResourceId.of(`${cluster.clusterIdentifier}-deleter`),
      },
      onDelete: {
        service: 'RDS',
        action: 'deleteDBCluster',
        parameters: {
          DBClusterIdentifier: cluster.clusterIdentifier,
          SkipFinalSnapshot: true,
          DeleteAutomatedBackups: true,
        },
        ignoreErrorCodesMatching: 'DBClusterNotFoundFault',
      },
    });
    clusterDeleter.node.addDependency(cluster);

    const writerDeleter = new cr.AwsCustomResource(this, 'WriterDeleter', {
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['rds:DeleteDBInstance', 'rds:DescribeDBClusters'],
          resources: ['*'],
        }),
      ]),
      onCreate: {
        service: 'RDS',
        action: 'describeDBClusters',
        parameters: { DBClusterIdentifier: cluster.clusterIdentifier },
        physicalResourceId: cr.PhysicalResourceId.of(`${cluster.clusterIdentifier}-writer-deleter`),
      },
      onDelete: {
        service: 'RDS',
        action: 'deleteDBInstance',
        parameters: {
          DBInstanceIdentifier: cluster.instanceIdentifiers[0],
          DeleteAutomatedBackups: true,
        },
        ignoreErrorCodesMatching: 'DBInstanceNotFoundFault|InvalidDBInstanceStateFault',
      },
    });
    // writerDeleter depends on clusterDeleter → writerDeleter is deleted FIRST
    writerDeleter.node.addDependency(clusterDeleter);

    // Tell CFN to skip its own delete of the cluster/writer — already gone
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
