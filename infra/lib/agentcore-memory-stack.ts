import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { loadMemoryConfig, memoryIdParameterName, parseMemoryConfig } from './memory-config';
import type { MemoryStrategy, TenantMemoryConfig } from './memory-config';
import type { Construct } from 'constructs';
import { trustedService } from './service-trust';

export interface AgentCoreMemoryStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Tenant memory config; defaults to `infra/memory-config.json`. Validated either way. */
  readonly config?: unknown;
}

export class AgentCoreMemoryStack extends cdk.Stack {
  /** The orgiq tenant's memory id ('' when the config has no orgiq entry). */
  public readonly memoryId: string;
  public readonly memoryIds: Record<string, string> = {};
  public readonly tenants: readonly TenantMemoryConfig[];

  constructor(scope: Construct, id: string, props?: AgentCoreMemoryStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // Execution role — bedrock-agentcore service reads/writes memory events
    // -------------------------------------------------------------------

    const memoryRole = new iam.Role(this, 'MemoryExecutionRole', {
      roleName: `${prefix}-memory-execution-role`,
      assumedBy: trustedService(this, 'bedrock-agentcore.amazonaws.com'),
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
    // Memory stores — one CfnMemory per tenant entry in memory-config.json.
    // Expiry is a property of the resource, so per-tenant retention cannot
    // share one. Ids are published to SSM so adding a tenant never touches a
    // frozen CFN import.
    // -------------------------------------------------------------------

    const safeName = prefix.replace(/-/g, '_');
    this.tenants = props?.config === undefined ? loadMemoryConfig() : parseMemoryConfig(props.config);

    const strategyBlocks = (ns: string): Record<MemoryStrategy, bedrockagentcore.CfnMemory.MemoryStrategyProperty> => ({
      semantic: {
        semanticMemoryStrategy: {
          name: 'semantic',
          description: 'Factual knowledge about the organization extracted from conversations',
          namespaceTemplates: [`/${ns}/{actorId}/semantic`],
        },
      },
      summary: {
        summaryMemoryStrategy: {
          name: 'summary',
          description: 'Conversation summaries for long-term context across sessions',
          namespaceTemplates: [`/${ns}/{actorId}/{sessionId}/summary`],
        },
      },
      user_preference: {
        userPreferenceMemoryStrategy: {
          name: 'user_preference',
          description: 'User interaction preferences (formatting, verbosity, focus areas)',
          namespaceTemplates: [`/${ns}/{actorId}/prefs`],
        },
      },
    });

    const arns: Record<string, string> = {};
    for (const cfg of this.tenants) {
      // The orgiq tenant keeps the construct id and name of the single memory
      // that existed before this config, so it is not replaced.
      const isOrgiq = cfg.tenant === 'orgiq';
      const suffix = isOrgiq ? '' : cfg.tenant.charAt(0).toUpperCase() + cfg.tenant.slice(1);
      const namespaceRoot = isOrgiq ? prefix : `${prefix}/${cfg.tenant}`;
      const blocks = strategyBlocks(namespaceRoot);
      const memory = new bedrockagentcore.CfnMemory(this, `Memory${suffix}`, {
        name: isOrgiq ? `${safeName}_memory` : `${safeName}_${cfg.tenant}_memory`,
        description: isOrgiq
          ? 'OrgIQ memory store — semantic knowledge, user preferences, and conversation summaries'
          : `OrgIQ ${cfg.tenant} memory store (${cfg.strategies.join(', ') || 'events only'})`,
        eventExpiryDuration: cfg.eventExpiryDays,
        memoryExecutionRoleArn: memoryRole.roleArn,
        ...(cfg.strategies.length > 0 && { memoryStrategies: cfg.strategies.map(s => blocks[s]) }),
      });
      this.memoryIds[cfg.tenant] = memory.attrMemoryId;
      arns[cfg.tenant] = memory.attrMemoryArn;
      new ssm.StringParameter(this, `MemoryId${suffix}Parameter`, {
        parameterName: memoryIdParameterName(prefix, cfg.tenant),
        stringValue: memory.attrMemoryId,
        description: `AgentCore Memory id for the ${cfg.tenant} tenant`,
      });
    }
    this.memoryId = this.memoryIds.orgiq ?? '';

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    // Nothing imports these any more (consumers read the SSM parameters). The
    // orgiq pair stays only so the first deploy does not try to delete an
    // export the old runtime/middleware templates still import; drop it one
    // release after both consumers have deployed.
    if (this.memoryIds.orgiq) {
      new cdk.CfnOutput(this, 'MemoryId', {
        value: this.memoryIds.orgiq,
        exportName: `${prefix}-memory-id`,
      });
      new cdk.CfnOutput(this, 'MemoryArn', {
        value: arns.orgiq,
        exportName: `${prefix}-memory-arn`,
      });
    }
  }
}
