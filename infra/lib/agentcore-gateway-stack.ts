import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Neptune Analytics graph ID for graph-traversal tool */
  readonly neptuneGraphId: string;
  /** Bedrock Knowledge Base ID for kb-query tool */
  readonly knowledgeBaseId: string;
  /** Policy Engine ID to attach to gateway */
  readonly policyEngineId: string;
  /** Map of agent name to IAM role for agent-as-tool targets */
  readonly agentRoles: Record<string, iam.Role>;
  /** Artifacts bucket ARN for Lambda code */
  readonly artifactsBucketArn: string;
}

/**
 * Agent names exposed as MCP tools for the supervisor.
 */
const SPECIALIST_AGENTS = [
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
] as const;

/**
 * OrgIQ-AgentCoreGateway: MCP Gateway configuration.
 *
 * Creates an MCP Gateway with:
 * - Lambda targets for custom tools (KB query, graph traversal, PageRank)
 * - Agent-as-tool targets (specialist agents exposed as MCP tools for supervisor)
 * - Policy Engine attachment for access control
 *
 * NOTE: AgentCore MCP Gateway does not yet have CloudFormation resource types.
 * This stack uses CustomResources backed by AwsSdk calls. If the API naming
 * changes, update the service/action references.
 *
 * POST-DEPLOY STEP: Deploy Lambda function code separately:
 *   cd infra/lambda/gateway-tools && ./deploy.sh
 */
export class AgentCoreGatewayStack extends cdk.Stack {
  /** The MCP Gateway ID */
  public readonly gatewayId: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // IAM Role for CustomResource Lambda (manages MCP Gateway)
    // -------------------------------------------------------------------

    const crRole = new iam.Role(this, 'GatewayCRRole', {
      roleName: `${prefix}-gateway-cr-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for CustomResource Lambda that manages MCP Gateway resources',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreMCPGatewayManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:CreateMcpGateway',
        'bedrock:UpdateMcpGateway',
        'bedrock:DeleteMcpGateway',
        'bedrock:GetMcpGateway',
        'bedrock:CreateMcpGatewayTarget',
        'bedrock:UpdateMcpGatewayTarget',
        'bedrock:DeleteMcpGatewayTarget',
        'bedrock:ListMcpGatewayTargets',
      ],
      resources: ['*'],
    }));

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRoleToGateway',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['*'],
    }));

    // -------------------------------------------------------------------
    // IAM Role for Gateway Lambda Tools
    // -------------------------------------------------------------------

    const toolsLambdaRole = new iam.Role(this, 'GatewayToolsLambdaRole', {
      roleName: `${prefix}-gateway-tools-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for MCP Gateway Lambda tool targets',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Neptune access for graph-traversal and compute-pagerank tools
    toolsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'NeptuneAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'neptune-graph:ReadDataViaQuery',
        'neptune-graph:WriteDataViaQuery',
        'neptune-graph:GetQueryStatus',
        'neptune-graph:GetGraphSummary',
      ],
      resources: [`arn:aws:neptune-graph:${this.region}:${this.account}:graph/${props.neptuneGraphId}`],
    }));

    // Knowledge Base access for kb-query tool
    toolsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
      ],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`],
    }));

    // Bedrock invoke for RetrieveAndGenerate
    toolsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // -------------------------------------------------------------------
    // Lambda Functions for Custom MCP Tools
    // -------------------------------------------------------------------

    const kbQueryLambda = new lambda.Function(this, 'KBQueryLambda', {
      functionName: `${prefix}-gateway-kb-query`,
      description: 'MCP tool: Query the OrgIQ Knowledge Base',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'kb_query.handler',
      code: lambda.Code.fromAsset('lambda/gateway-tools'),
      role: toolsLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        KB_ID: props.knowledgeBaseId,
        REGION: this.region,
      },
    });

    const graphTraversalLambda = new lambda.Function(this, 'GraphTraversalLambda', {
      functionName: `${prefix}-gateway-graph-traversal`,
      description: 'MCP tool: Execute openCypher queries against the knowledge graph',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'graph_traversal.handler',
      code: lambda.Code.fromAsset('lambda/gateway-tools'),
      role: toolsLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NEPTUNE_GRAPH_ID: props.neptuneGraphId,
        REGION: this.region,
      },
    });

    const computePageRankLambda = new lambda.Function(this, 'ComputePageRankLambda', {
      functionName: `${prefix}-gateway-compute-pagerank`,
      description: 'MCP tool: Compute PageRank scores for org graph nodes',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'compute_pagerank.handler',
      code: lambda.Code.fromAsset('lambda/gateway-tools'),
      role: toolsLambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        NEPTUNE_GRAPH_ID: props.neptuneGraphId,
        REGION: this.region,
      },
    });

    // -------------------------------------------------------------------
    // MCP Gateway (via CustomResource)
    // -------------------------------------------------------------------

    const gateway = new cr.AwsCustomResource(this, 'MCPGateway', {
      resourceType: 'Custom::MCPGateway',
      onCreate: {
        service: 'BedrockAgentRuntime',
        action: 'createMcpGateway',
        parameters: {
          name: `${prefix}-gateway`,
          description: 'OrgIQ MCP Gateway — unified tool registry for all agents',
          authorizationType: 'AWS_IAM',
          policyEngineConfiguration: {
            policyEngineId: props.policyEngineId,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('mcpGatewayId'),
      },
      onUpdate: {
        service: 'BedrockAgentRuntime',
        action: 'updateMcpGateway',
        parameters: {
          mcpGatewayId: new cr.PhysicalResourceIdReference(),
          name: `${prefix}-gateway`,
          description: 'OrgIQ MCP Gateway — unified tool registry for all agents',
          policyEngineConfiguration: {
            policyEngineId: props.policyEngineId,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('mcpGatewayId'),
      },
      onDelete: {
        service: 'BedrockAgentRuntime',
        action: 'deleteMcpGateway',
        parameters: {
          mcpGatewayId: new cr.PhysicalResourceIdReference(),
        },
      },
      role: crRole,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    const gatewayId = gateway.getResponseField('mcpGatewayId');
    this.gatewayId = gatewayId;

    // -------------------------------------------------------------------
    // Lambda Targets (custom tools)
    // -------------------------------------------------------------------

    const lambdaTargets: Array<{
      name: string;
      description: string;
      lambdaArn: string;
      toolSchema: object;
    }> = [
      {
        name: 'knowledge-base-query',
        description: 'Search the organizational knowledge base for documents, transcripts, and wiki content',
        lambdaArn: kbQueryLambda.functionArn,
        toolSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            maxResults: { type: 'number', description: 'Maximum results to return (1-25)', default: 10 },
            filters: {
              type: 'object',
              description: 'Optional metadata filters',
              properties: {
                documentType: { type: 'string', enum: ['transcript', 'prd', 'wiki', 'jira'] },
                team: { type: 'string' },
                dateRange: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', format: 'date' },
                    end: { type: 'string', format: 'date' },
                  },
                },
              },
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'graph-traversal',
        description: 'Execute openCypher queries against the organizational knowledge graph (Neptune Analytics)',
        lambdaArn: graphTraversalLambda.functionArn,
        toolSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'openCypher query to execute' },
            parameters: { type: 'object', description: 'Query parameters map' },
            explain: { type: 'boolean', description: 'Return query plan instead of results', default: false },
          },
          required: ['query'],
        },
      },
      {
        name: 'compute-pagerank',
        description: 'Compute PageRank scores for nodes in the organizational knowledge graph',
        lambdaArn: computePageRankLambda.functionArn,
        toolSchema: {
          type: 'object',
          properties: {
            nodeLabel: { type: 'string', description: 'Node label to compute PageRank for (Person, Team, Skill)', default: 'Person' },
            dampingFactor: { type: 'number', description: 'PageRank damping factor (0-1)', default: 0.85 },
            maxIterations: { type: 'number', description: 'Maximum iterations', default: 20 },
            writeBack: { type: 'boolean', description: 'Write scores back to graph nodes', default: false },
          },
        },
      },
    ];

    for (const target of lambdaTargets) {
      const targetResource = new cr.AwsCustomResource(this, `Target${this.capitalize(target.name)}`, {
        resourceType: 'Custom::MCPGatewayTarget',
        onCreate: {
          service: 'BedrockAgentRuntime',
          action: 'createMcpGatewayTarget',
          parameters: {
            mcpGatewayId: gatewayId,
            name: target.name,
            description: target.description,
            targetConfiguration: {
              lambdaTarget: {
                lambdaArn: target.lambdaArn,
                toolSchema: JSON.stringify(target.toolSchema),
              },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('mcpGatewayTargetId'),
        },
        onDelete: {
          service: 'BedrockAgentRuntime',
          action: 'deleteMcpGatewayTarget',
          parameters: {
            mcpGatewayId: gatewayId,
            mcpGatewayTargetId: new cr.PhysicalResourceIdReference(),
          },
        },
        role: crRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      targetResource.node.addDependency(gateway);
    }

    // -------------------------------------------------------------------
    // Agent-as-Tool Targets (specialist agents exposed for supervisor)
    // -------------------------------------------------------------------

    for (const agentName of SPECIALIST_AGENTS) {
      const agentToolTarget = new cr.AwsCustomResource(this, `AgentTarget${this.capitalize(agentName)}`, {
        resourceType: 'Custom::MCPGatewayAgentTarget',
        onCreate: {
          service: 'BedrockAgentRuntime',
          action: 'createMcpGatewayTarget',
          parameters: {
            mcpGatewayId: gatewayId,
            name: `invoke-${agentName}`,
            description: `Invoke the OrgIQ ${agentName} specialist agent`,
            targetConfiguration: {
              agentTarget: {
                agentRuntimeName: `${prefix}-${agentName}`,
                authorizationType: 'AWS_IAM',
              },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('mcpGatewayTargetId'),
        },
        onDelete: {
          service: 'BedrockAgentRuntime',
          action: 'deleteMcpGatewayTarget',
          parameters: {
            mcpGatewayId: gatewayId,
            mcpGatewayTargetId: new cr.PhysicalResourceIdReference(),
          },
        },
        role: crRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      agentToolTarget.node.addDependency(gateway);
    }

    // -------------------------------------------------------------------
    // Grant MCP Gateway permission to invoke Lambda tools
    // -------------------------------------------------------------------

    kbQueryLambda.grantInvoke(new iam.ServicePrincipal('bedrock.amazonaws.com'));
    graphTraversalLambda.grantInvoke(new iam.ServicePrincipal('bedrock.amazonaws.com'));
    computePageRankLambda.grantInvoke(new iam.ServicePrincipal('bedrock.amazonaws.com'));

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'GatewayId', {
      value: gatewayId,
      exportName: `${prefix}-mcp-gateway-id`,
    });

    new cdk.CfnOutput(this, 'KBQueryLambdaArn', {
      value: kbQueryLambda.functionArn,
      exportName: `${prefix}-gateway-kb-query-lambda-arn`,
    });

    new cdk.CfnOutput(this, 'GraphTraversalLambdaArn', {
      value: graphTraversalLambda.functionArn,
      exportName: `${prefix}-gateway-graph-traversal-lambda-arn`,
    });

    new cdk.CfnOutput(this, 'ComputePageRankLambdaArn', {
      value: computePageRankLambda.functionArn,
      exportName: `${prefix}-gateway-compute-pagerank-lambda-arn`,
    });
  }

  private capitalize(str: string): string {
    return str.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
