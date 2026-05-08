import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface AgentCoreMemoryStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

/**
 * OrgIQ-AgentCoreMemory: AgentCore Memory store configuration.
 *
 * Creates a memory store with three strategies:
 * - Semantic: Factual knowledge about the organization (entities, relationships)
 * - UserPreference: User interaction preferences (formatting, verbosity, etc.)
 * - Summary: Conversation summaries for long-term context
 *
 * Events expire after 90 days. Namespaces isolate per-actor memory.
 *
 * NOTE: AgentCore Memory does not yet have CloudFormation resource types.
 * This stack uses CustomResources. If `@aws-cdk/aws-bedrock-agentcore-alpha`
 * L2 constructs become available, migrate to those.
 */
export class AgentCoreMemoryStack extends cdk.Stack {
  /** The Memory Store ID */
  public readonly memoryId: string;

  constructor(scope: Construct, id: string, props?: AgentCoreMemoryStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // IAM Role for CustomResource Lambda (manages Memory store)
    // -------------------------------------------------------------------

    const crRole = new iam.Role(this, 'MemoryCRRole', {
      roleName: `${prefix}-memory-cr-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for CustomResource Lambda that manages AgentCore Memory resources',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreMemoryManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:CreateMemory',
        'bedrock:UpdateMemory',
        'bedrock:DeleteMemory',
        'bedrock:GetMemory',
        'bedrock:ListMemories',
        'bedrock:CreateMemoryStrategy',
        'bedrock:UpdateMemoryStrategy',
        'bedrock:DeleteMemoryStrategy',
        'bedrock:ListMemoryStrategies',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------------------
    // AgentCore Memory Store
    // -------------------------------------------------------------------

    const memoryStore = new cr.AwsCustomResource(this, 'MemoryStore', {
      resourceType: 'Custom::AgentCoreMemory',
      onCreate: {
        service: 'BedrockAgentRuntime',
        action: 'createMemory',
        parameters: {
          name: `${prefix}-memory`,
          description: 'OrgIQ memory store — semantic knowledge, user preferences, and conversation summaries',
          eventExpiryDuration: 7776000, // 90 days in seconds
          memoryStrategies: [
            {
              strategyName: 'semantic',
              type: 'SEMANTIC',
              description: 'Factual knowledge about the organization extracted from conversations',
              namespaceConfiguration: {
                namespacePattern: `/${prefix}/{actorId}/semantic/`,
              },
              configuration: {
                semanticConfiguration: {
                  embeddingModelId: 'amazon.titan-embed-text-v2:0',
                  embeddingDimension: 1024,
                  maxMemories: 10000,
                  similarityThreshold: 0.7,
                },
              },
            },
            {
              strategyName: 'user-preference',
              type: 'USER_PREFERENCE',
              description: 'User interaction preferences (formatting, verbosity, focus areas)',
              namespaceConfiguration: {
                namespacePattern: `/${prefix}/{actorId}/prefs/`,
              },
              configuration: {
                userPreferenceConfiguration: {
                  maxPreferences: 100,
                  consolidationEnabled: true,
                },
              },
            },
            {
              strategyName: 'summary',
              type: 'SUMMARY',
              description: 'Conversation summaries for long-term context across sessions',
              namespaceConfiguration: {
                namespacePattern: `/${prefix}/{actorId}/summary/`,
              },
              configuration: {
                summaryConfiguration: {
                  modelId: 'anthropic.claude-sonnet-4-20250514',
                  maxSummaryTokens: 2048,
                  consolidationInterval: 5, // Summarize every 5 conversations
                },
              },
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('memoryId'),
      },
      onUpdate: {
        service: 'BedrockAgentRuntime',
        action: 'updateMemory',
        parameters: {
          memoryId: new cr.PhysicalResourceIdReference(),
          name: `${prefix}-memory`,
          description: 'OrgIQ memory store — semantic knowledge, user preferences, and conversation summaries',
          eventExpiryDuration: 7776000,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('memoryId'),
      },
      onDelete: {
        service: 'BedrockAgentRuntime',
        action: 'deleteMemory',
        parameters: {
          memoryId: new cr.PhysicalResourceIdReference(),
        },
      },
      role: crRole,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    this.memoryId = memoryStore.getResponseField('memoryId');

    // -------------------------------------------------------------------
    // IAM Policy for agents to access memory
    // -------------------------------------------------------------------

    const memoryAccessPolicy = new iam.ManagedPolicy(this, 'MemoryAccessPolicy', {
      managedPolicyName: `${prefix}-memory-access-policy`,
      description: 'Allows AgentCore agents to read/write to the OrgIQ memory store',
      statements: [
        new iam.PolicyStatement({
          sid: 'AgentCoreMemoryAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeMemory',
            'bedrock:RetrieveMemory',
            'bedrock:WriteMemory',
            'bedrock:DeleteMemoryEvent',
          ],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:memory/*`,
          ],
        }),
      ],
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'MemoryId', {
      value: this.memoryId,
      exportName: `${prefix}-memory-id`,
    });

    new cdk.CfnOutput(this, 'MemoryAccessPolicyArn', {
      value: memoryAccessPolicy.managedPolicyArn,
      exportName: `${prefix}-memory-access-policy-arn`,
    });
  }
}
