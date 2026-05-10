import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

export interface AgentCoreMemoryStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

export class AgentCoreMemoryStack extends cdk.Stack {
  public readonly memoryId: string;

  constructor(scope: Construct, id: string, props?: AgentCoreMemoryStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // Execution role — bedrock-agentcore service reads/writes memory events
    // -------------------------------------------------------------------

    const memoryRole = new iam.Role(this, 'MemoryExecutionRole', {
      roleName: `${prefix}-memory-execution-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for OrgIQ AgentCore Memory store',
      inlinePolicies: {
        MemoryAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'MemoryEventAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:ListEvents',
                'bedrock-agentcore:RetrieveMemories',
                'bedrock-agentcore:ListMemoryRecords',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // -------------------------------------------------------------------
    // Memory Store
    // -------------------------------------------------------------------

    const safeName = prefix.replace(/-/g, '_');

    const memory = new bedrockagentcore.CfnMemory(this, 'Memory', {
      name: `${safeName}_memory`,
      description: 'OrgIQ memory store — semantic knowledge, user preferences, and conversation summaries',
      eventExpiryDuration: 90,
      memoryExecutionRoleArn: memoryRole.roleArn,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: 'semantic',
            description: 'Factual knowledge about the organization extracted from conversations',
            namespaceTemplates: [`/${prefix}/{actorId}/semantic`],
          },
        },
        {
          summaryMemoryStrategy: {
            name: 'summary',
            description: 'Conversation summaries for long-term context across sessions',
            namespaceTemplates: [`/${prefix}/{actorId}/{sessionId}/summary`],
          },
        },
        {
          userPreferenceMemoryStrategy: {
            name: 'user_preference',
            description: 'User interaction preferences (formatting, verbosity, focus areas)',
            namespaceTemplates: [`/${prefix}/{actorId}/prefs`],
          },
        },
      ],
    });

    this.memoryId = memory.attrMemoryId;

    // -------------------------------------------------------------------
    // IAM Managed Policy for agents to access the memory store
    // -------------------------------------------------------------------

    new iam.ManagedPolicy(this, 'MemoryAccessPolicy', {
      managedPolicyName: `${prefix}-memory-access-policy`,
      description: 'Allows AgentCore agents to read/write to the OrgIQ memory store',
      statements: [
        new iam.PolicyStatement({
          sid: 'AgentCoreMemoryAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock-agentcore:CreateEvent',
            'bedrock-agentcore:ListEvents',
            'bedrock-agentcore:RetrieveMemories',
            'bedrock-agentcore:ListMemoryRecords',
          ],
          resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`],
        }),
      ],
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'MemoryId', {
      value: memory.attrMemoryId,
      exportName: `${prefix}-memory-id`,
    });

    new cdk.CfnOutput(this, 'MemoryArn', {
      value: memory.attrMemoryArn,
      exportName: `${prefix}-memory-arn`,
    });
  }
}
