import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface AgentCoreRuntimeStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Map of agent name to IAM role ARN */
  readonly agentRoles: Record<string, iam.Role>;
  /** AgentCore Memory store ID (injected as env var) */
  readonly memoryId: string;
  /** Bedrock Guardrail ID (injected as env var) */
  readonly guardrailId: string;
  /** Aurora Serverless v2 cluster ARN (graph + vector store, injected as env var) */
  readonly auroraClusterArn: string;
  /** Secrets Manager secret ARN for Aurora credentials (injected as env var) */
  readonly auroraCredentialsSecretArn: string;
  /** Bedrock Knowledge Base ID (injected as env var) */
  readonly knowledgeBaseId: string;
  /** The model ID for agent inference */
  readonly modelId?: string;
}

/**
 * Agent names as defined in CLAUDE.md.
 */
const AGENT_NAMES = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
] as const;

/**
 * OrgIQ-AgentCoreRuntime: Deploys 6 agent runtimes to AgentCore Runtime.
 *
 * NOTE: AgentCore Runtime does not yet have native CloudFormation resource types.
 * This stack uses CustomResources backed by AwsSdk calls to the
 * bedrock-agent-runtime control plane. If the control plane API changes,
 * update the service/action references accordingly.
 *
 * Alternative: If `@aws-cdk/aws-bedrock-agentcore-alpha` L2 constructs become
 * available, replace the CustomResources with those constructs.
 *
 * POST-DEPLOY STEP: After CDK deploy, you must still push container images:
 *   cd agents/<name> && agentcore deploy
 * The CDK stack creates the runtime configuration; `agentcore deploy` handles
 * the Docker build + push via CodeBuild.
 */
export class AgentCoreRuntimeStack extends cdk.Stack {
  /** Map of agent name to runtime ID */
  public readonly runtimeIds: Record<string, string>;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const modelId = props.modelId ?? 'amazon.nova-pro-v1:0';
    this.runtimeIds = {};

    // -------------------------------------------------------------------
    // IAM Role for CustomResource Lambda (manages AgentCore runtimes)
    // -------------------------------------------------------------------

    const crRole = new iam.Role(this, 'AgentCoreCustomResourceRole', {
      roleName: `${prefix}-agentcore-cr-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for CustomResource Lambda that manages AgentCore Runtime resources',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreRuntimeManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:CreateAgentRuntime',
        'bedrock:UpdateAgentRuntime',
        'bedrock:DeleteAgentRuntime',
        'bedrock:GetAgentRuntime',
        'bedrock:CreateAgentRuntimeEndpoint',
        'bedrock:UpdateAgentRuntimeEndpoint',
        'bedrock:DeleteAgentRuntimeEndpoint',
        'bedrock:GetAgentRuntimeEndpoint',
        'bedrock:ListAgentRuntimeEndpoints',
      ],
      resources: ['*'],
    }));

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRoleToAgentCore',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: Object.values(props.agentRoles).map(r => r.roleArn),
    }));

    // -------------------------------------------------------------------
    // AgentCore Runtimes (one per agent)
    // -------------------------------------------------------------------

    for (const agentName of AGENT_NAMES) {
      const agentRole = props.agentRoles[agentName];
      if (!agentRole) continue;

      const runtimeName = `${prefix}-${agentName}`;
      const pascalName = this.capitalize(agentName);

      // Create AgentCore Runtime via CustomResource (AwsSdk)
      const runtime = new cr.AwsCustomResource(this, `${pascalName}Runtime`, {
        resourceType: 'Custom::AgentCoreRuntime',
        onCreate: {
          service: 'BedrockAgentRuntime',
          action: 'createAgentRuntime',
          parameters: {
            agentRuntimeName: runtimeName,
            description: `OrgIQ ${agentName} agent runtime`,
            roleArn: agentRole.roleArn,
            agentRuntimeArtifact: {
              containerConfiguration: {
                containerUri: `placeholder-${agentName}`, // Updated by `agentcore deploy`
              },
            },
            lifecycleConfiguration: {
              idleTimeoutSeconds: 300, // 5 minutes
              maxLifetimeSeconds: 28800, // 8 hours
            },
            environmentVariables: {
              AGENT_NAME: agentName,
              MEMORY_ID: props.memoryId,
              GUARDRAIL_ID: props.guardrailId,
              MODEL_ID: modelId,
              AURORA_CLUSTER_ARN: props.auroraClusterArn,
              AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
              KB_ID: props.knowledgeBaseId,
              PROJECT_PREFIX: prefix,
            },
            authorizationConfiguration: {
              authorizationType: 'AWS_IAM',
            },
            networkConfiguration: {
              networkMode: 'PUBLIC',
            },
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('agentRuntimeId'),
        },
        onUpdate: {
          service: 'BedrockAgentRuntime',
          action: 'updateAgentRuntime',
          parameters: {
            agentRuntimeId: new cr.PhysicalResourceIdReference(),
            agentRuntimeName: runtimeName,
            description: `OrgIQ ${agentName} agent runtime`,
            roleArn: agentRole.roleArn,
            lifecycleConfiguration: {
              idleTimeoutSeconds: 300,
              maxLifetimeSeconds: 28800,
            },
            environmentVariables: {
              AGENT_NAME: agentName,
              MEMORY_ID: props.memoryId,
              GUARDRAIL_ID: props.guardrailId,
              MODEL_ID: modelId,
              AURORA_CLUSTER_ARN: props.auroraClusterArn,
              AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
              KB_ID: props.knowledgeBaseId,
              PROJECT_PREFIX: prefix,
            },
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('agentRuntimeId'),
        },
        onDelete: {
          service: 'BedrockAgentRuntime',
          action: 'deleteAgentRuntime',
          parameters: {
            agentRuntimeId: new cr.PhysicalResourceIdReference(),
          },
        },
        role: crRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      // Create a default endpoint for the runtime
      const endpoint = new cr.AwsCustomResource(this, `${pascalName}Endpoint`, {
        resourceType: 'Custom::AgentCoreRuntimeEndpoint',
        onCreate: {
          service: 'BedrockAgentRuntime',
          action: 'createAgentRuntimeEndpoint',
          parameters: {
            agentRuntimeId: runtime.getResponseField('agentRuntimeId'),
            name: `${runtimeName}-default`,
            description: `Default endpoint for ${agentName} agent`,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('agentRuntimeEndpointId'),
        },
        onDelete: {
          service: 'BedrockAgentRuntime',
          action: 'deleteAgentRuntimeEndpoint',
          parameters: {
            agentRuntimeId: runtime.getResponseField('agentRuntimeId'),
            agentRuntimeEndpointId: new cr.PhysicalResourceIdReference(),
          },
        },
        role: crRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      endpoint.node.addDependency(runtime);

      // Store runtime ID for cross-stack references
      const runtimeId = runtime.getResponseField('agentRuntimeId');

      new cdk.CfnOutput(this, `${pascalName}RuntimeId`, {
        value: runtimeId,
        exportName: `${prefix}-${agentName}-runtime-id`,
      });
    }

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'ModelId', {
      value: modelId,
      exportName: `${prefix}-runtime-model-id`,
    });
  }

  private capitalize(str: string): string {
    return str.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
