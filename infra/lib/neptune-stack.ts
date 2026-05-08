import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface NeptuneStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** ARN of the base agent role to grant Neptune access */
  readonly agentRoleArn: string;
}

/**
 * OrgIQ-Neptune: Neptune Analytics graph with vector search (1024-dim).
 * openCypher ONLY - Neptune Analytics does NOT support Gremlin or SPARQL.
 */
export class NeptuneStack extends cdk.Stack {
  /** Neptune Analytics graph identifier */
  public readonly graphId: string;
  /** Neptune Analytics graph ARN */
  public readonly graphArn: string;
  /** Neptune Analytics graph endpoint */
  public readonly graphEndpoint: string;

  constructor(scope: Construct, id: string, props: NeptuneStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // Neptune Analytics Graph (L1 - CfnGraph)
    // -------------------------------------------------------------------

    const graph = new cdk.aws_neptunegraph.CfnGraph(this, 'OrgGraph', {
      graphName: `${prefix}-knowledge-graph`,
      provisionedMemory: 128, // 128 NCU (Neptune Capacity Units)
      deletionProtection: false, // Set true for production
      replicaCount: 0, // Single instance for dev
      vectorSearchConfiguration: {
        vectorSearchDimension: 1024, // Titan Embeddings V2 dimension
      },
      tags: [
        { key: 'Project', value: 'OrgIQ' },
        { key: 'Service', value: 'Neptune Analytics' },
      ],
    });

    this.graphId = graph.attrGraphId;
    this.graphArn = graph.attrGraphArn;
    this.graphEndpoint = graph.attrEndpoint;

    // -------------------------------------------------------------------
    // IAM: Grant agent role access to Neptune Analytics
    // -------------------------------------------------------------------

    const agentRole = iam.Role.fromRoleArn(this, 'AgentBaseRole', props.agentRoleArn);

    const neptunePolicy = new iam.Policy(this, 'NeptuneAccessPolicy', {
      policyName: `${prefix}-neptune-access`,
      statements: [
        new iam.PolicyStatement({
          sid: 'NeptuneAnalyticsDataAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'neptune-graph:ReadDataViaQuery',
            'neptune-graph:WriteDataViaQuery',
            'neptune-graph:DeleteDataViaQuery',
            'neptune-graph:GetQueryStatus',
            'neptune-graph:CancelQuery',
            'neptune-graph:GetGraphSummary',
            'neptune-graph:GetGraph',
          ],
          resources: [graph.attrGraphArn],
        }),
      ],
    });

    neptunePolicy.attachToRole(agentRole as iam.Role);

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'GraphId', {
      value: graph.attrGraphId,
      exportName: `${prefix}-neptune-graph-id`,
    });

    new cdk.CfnOutput(this, 'GraphArn', {
      value: graph.attrGraphArn,
      exportName: `${prefix}-neptune-graph-arn`,
    });

    new cdk.CfnOutput(this, 'GraphEndpoint', {
      value: graph.attrEndpoint,
      exportName: `${prefix}-neptune-graph-endpoint`,
    });
  }
}
