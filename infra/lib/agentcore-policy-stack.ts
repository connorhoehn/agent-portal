import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

export interface AgentCorePolicyStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

export class AgentCorePolicyStack extends cdk.Stack {
  public readonly policyEngineId: string;
  public readonly policyEngineArn: string;

  constructor(scope: Construct, id: string, props: AgentCorePolicyStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    // PolicyEngine name must match ^[A-Za-z][A-Za-z0-9_]*$ — no hyphens
    const safeName = prefix.replace(/-/g, '_');

    // -------------------------------------------------------------------
    // Policy Engine (Cedar policies are created in AgentCoreGatewayStack
    // because they require a specific gateway ID as the resource)
    // -------------------------------------------------------------------

    const policyEngine = new bedrockagentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: `${safeName}_policy_engine`,
      description: 'OrgIQ Cedar-based access control for agent tools and resources',
    });

    this.policyEngineId = policyEngine.attrPolicyEngineId;
    this.policyEngineArn = policyEngine.attrPolicyEngineArn;

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'PolicyEngineId', {
      value: policyEngine.attrPolicyEngineId,
      exportName: `${prefix}-policy-engine-id`,
    });

    new cdk.CfnOutput(this, 'PolicyEngineArn', {
      value: policyEngine.attrPolicyEngineArn,
      exportName: `${prefix}-policy-engine-arn`,
    });

  }
}
