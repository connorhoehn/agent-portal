import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly auroraClusterArn: string;
  readonly auroraCredentialsSecretArn: string;
  readonly knowledgeBaseId: string;
  readonly policyEngineArn: string;
  readonly policyEngineId: string;
  readonly agentRoles: Record<string, iam.Role>;
}

export class AgentCoreGatewayStack extends cdk.Stack {
  public readonly gatewayIdentifier: string;
  public readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // IAM Role for Lambda tool functions
    // -------------------------------------------------------------------

    const toolsLambdaRole = new iam.Role(this, 'GatewayToolsLambdaRole', {
      roleName: `${prefix}-gateway-tools-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for MCP Gateway Lambda tool targets',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        ToolsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AuroraAgeAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [props.auroraClusterArn],
            }),
            new iam.PolicyStatement({
              sid: 'AuroraCredentials',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.auroraCredentialsSecretArn],
            }),
            new iam.PolicyStatement({
              sid: 'KnowledgeBaseAccess',
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
              resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`],
            }),
            new iam.PolicyStatement({
              sid: 'BedrockInvoke',
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // -------------------------------------------------------------------
    // Lambda Functions for MCP Tool Targets
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
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        KB_ID: props.knowledgeBaseId,
        REGION: this.region,
      },
    });

    const graphTraversalLambda = new lambda.Function(this, 'GraphTraversalLambda', {
      functionName: `${prefix}-gateway-graph-traversal`,
      description: 'MCP tool: Execute read-only SQL graph queries against Aurora relational schema',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'graph_traversal.handler',
      code: lambda.Code.fromAsset('lambda/gateway-tools'),
      role: toolsLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        AURORA_CLUSTER_ARN: props.auroraClusterArn,
        AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
        PROJECT_PREFIX: prefix,
        REGION: this.region,
      },
    });

    const computePageRankLambda = new lambda.Function(this, 'ComputePageRankLambda', {
      functionName: `${prefix}-gateway-compute-pagerank`,
      description: 'MCP tool: Compute PageRank scores over the Aurora relational org-graph edges',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'compute_pagerank.handler',
      code: lambda.Code.fromAsset('lambda/gateway-tools'),
      role: toolsLambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        AURORA_CLUSTER_ARN: props.auroraClusterArn,
        AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
        PROJECT_PREFIX: prefix,
        REGION: this.region,
      },
    });

    // -------------------------------------------------------------------
    // Gateway IAM Role — trusted by bedrock-agentcore, can invoke Lambdas
    // Trust policy uses StringLike wildcard since gateway ARN is only known
    // after gateway creation, and this role must be created first.
    // -------------------------------------------------------------------

    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: `${prefix}-mcp-gateway-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          },
        },
      }),
      description: 'Execution role for OrgIQ MCP Gateway',
      inlinePolicies: {
        GatewayAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'InvokeLambdaTools',
              effect: iam.Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: [
                kbQueryLambda.functionArn,
                graphTraversalLambda.functionArn,
                computePageRankLambda.functionArn,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'PolicyEngineAccess',
              effect: iam.Effect.ALLOW,
              actions: ['bedrock-agentcore:*'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'Logs',
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
            }),
          ],
        }),
      },
    });

    // Allow the AgentCore gateway service to invoke these Lambdas directly
    kbQueryLambda.grantInvoke(new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'));
    graphTraversalLambda.grantInvoke(new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'));
    computePageRankLambda.grantInvoke(new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'));

    // -------------------------------------------------------------------
    // MCP Gateway
    // -------------------------------------------------------------------

    const gateway = new bedrockagentcore.CfnGateway(this, 'McpGateway', {
      name: `${prefix}-mcp-gateway`,
      description: 'OrgIQ MCP Gateway — exposes KB query, graph traversal, and PageRank tools',
      roleArn: gatewayRole.roleArn,
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      policyEngineConfiguration: {
        arn: props.policyEngineArn,
        mode: 'ENFORCE',
      },
    });

    this.gatewayIdentifier = gateway.attrGatewayIdentifier;
    this.gatewayUrl = gateway.attrGatewayUrl;

    // Full ARN constructed from the dynamic gateway identifier
    const gatewayArn = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/${gateway.attrGatewayIdentifier}`;

    // -------------------------------------------------------------------
    // MCP Gateway Targets (one per Lambda tool)
    // credentialProviderType GATEWAY_IAM_ROLE — gateway assumes its own
    // IAM role (gatewayRole above) to invoke Lambda
    // -------------------------------------------------------------------

    const credentialProviderConfigurations = [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ];

    const kbQueryTarget = new bedrockagentcore.CfnGatewayTarget(this, 'KBQueryTarget', {
      name: `${prefix}-kb-query`,
      description: 'Retrieve relevant information from the OrgIQ Knowledge Base',
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      credentialProviderConfigurations,
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: kbQueryLambda.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: 'knowledge-base-query',
                  description: 'Query the OrgIQ Knowledge Base for relevant organizational information',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', description: 'The search query' },
                      maxResults: { type: 'number', description: 'Maximum number of results to return (default 5)' },
                    },
                    required: ['query'],
                  },
                },
              ],
            },
          },
        },
      },
    });
    kbQueryTarget.node.addDependency(gateway);

    const graphTraversalTarget = new bedrockagentcore.CfnGatewayTarget(this, 'GraphTraversalTarget', {
      name: `${prefix}-graph-traversal`,
      description: 'Execute read-only SQL graph queries against the Aurora relational schema',
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      credentialProviderConfigurations,
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: graphTraversalLambda.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: 'graph-traversal',
                  description: 'Execute read-only SQL (SELECT/WITH) against the OrgIQ relational graph schema',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      sql: { type: 'string', description: 'PostgreSQL SELECT or WITH statement' },
                      parameters: { type: 'object', description: 'Named query parameters as key-value pairs' },
                    },
                    required: ['sql'],
                  },
                },
              ],
            },
          },
        },
      },
    });
    graphTraversalTarget.node.addDependency(gateway);

    const computePageRankTarget = new bedrockagentcore.CfnGatewayTarget(this, 'ComputePageRankTarget', {
      name: `${prefix}-compute-pagerank`,
      description: 'Compute PageRank expertise scores for people in the knowledge graph',
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      credentialProviderConfigurations,
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: computePageRankLambda.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: 'compute-pagerank',
                  description: 'Compute PageRank scores for expertise ranking in the organizational graph',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      topic: { type: 'string', description: 'Limit PageRank to nodes related to this topic (optional)' },
                      iterations: { type: 'number', description: 'Number of PageRank iterations (default 20)' },
                      dampingFactor: { type: 'number', description: 'Damping factor for PageRank (default 0.85)' },
                      limit: { type: 'number', description: 'Maximum number of ranked results to return (default 10)' },
                    },
                    required: [],
                  },
                },
              ],
            },
          },
        },
      },
    });
    computePageRankTarget.node.addDependency(gateway);

    // -------------------------------------------------------------------
    // Cedar Policies
    // Gateway uses AWS_IAM authorizer → principal must be AgentCore::IamEntity
    // Resource must be the full gateway ARN, not just the gateway ID
    // Policy names must match ^[A-Za-z][A-Za-z0-9_]*$ — no hyphens
    // -------------------------------------------------------------------

    const safeName = prefix.replace(/-/g, '_');

    // Action wildcard — docs show action names follow "TargetName__toolName" pattern;
    // using wildcard here so policies validate cleanly. IamEntity principal still gates by role.
    const agentPolicies: Array<{
      id: string;
      name: string;
      agentKey: string;
    }> = [
      { id: 'PolicySupervisorFullAccess', name: `${safeName}_supervisor_full_access`, agentKey: 'supervisor' },
      { id: 'PolicySearchToolsAccess', name: `${safeName}_search_tools_access`, agentKey: 'search' },
      { id: 'PolicyScoringToolsAccess', name: `${safeName}_scoring_tools_access`, agentKey: 'scoring' },
      { id: 'PolicyAdvisorToolsAccess', name: `${safeName}_advisor_tools_access`, agentKey: 'advisor' },
      { id: 'PolicyIngestionToolsAccess', name: `${safeName}_ingestion_tools_access`, agentKey: 'ingestion' },
      { id: 'PolicyGraphBuilderToolsAccess', name: `${safeName}_graph_builder_tools_access`, agentKey: 'graph-builder' },
    ];

    let prevPolicy: bedrockagentcore.CfnPolicy | undefined;

    for (const { id, name, agentKey } of agentPolicies) {
      const role = props.agentRoles[agentKey];
      if (!role) continue;

      const statement =
        `permit (\n  principal == AgentCore::IamEntity::"${role.roleArn}",\n  action,\n  resource == AgentCore::Gateway::"${gatewayArn}"\n);`;

      const policy = new bedrockagentcore.CfnPolicy(this, id, {
        name,
        description: `OrgIQ Cedar policy: ${name}`,
        policyEngineId: props.policyEngineId,
        definition: { cedar: { statement } },
      });
      // Policies must wait for targets — policy engine validates action names against existing targets
      policy.node.addDependency(kbQueryTarget);
      policy.node.addDependency(graphTraversalTarget);
      policy.node.addDependency(computePageRankTarget);
      // Chain sequentially to avoid concurrent stabilization timeouts
      if (prevPolicy) policy.node.addDependency(prevPolicy);
      prevPolicy = policy;
    }

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'GatewayIdentifier', {
      value: gateway.attrGatewayIdentifier,
      exportName: `${prefix}-mcp-gateway-id`,
    });

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gateway.attrGatewayUrl,
      exportName: `${prefix}-mcp-gateway-url`,
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
}
