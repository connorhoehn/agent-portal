import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface AgentCorePolicyStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Guardrail ARN to reference in PII policy */
  readonly guardrailArn: string;
}

/**
 * OrgIQ-AgentCorePolicy: Policy Engine with Cedar policies for agent access control.
 *
 * Policies:
 * 1. Supervisor: access all tools
 * 2. Search: KB + graph tools only
 * 3. Scoring: graph + write-scores only
 * 4. PII protection: require guardrail for PII-tagged resources
 * 5. Rate limiting: max 100 tool calls per minute per agent
 *
 * Mode: LOG_ONLY (monitoring mode — switch to ENFORCE when validated)
 *
 * NOTE: AgentCore Policy Engine does not yet have CloudFormation resource types.
 * This stack uses CustomResources. Cedar policies are defined inline.
 */
export class AgentCorePolicyStack extends cdk.Stack {
  /** The Policy Engine ID */
  public readonly policyEngineId: string;

  constructor(scope: Construct, id: string, props: AgentCorePolicyStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // Cedar Policies (inline definitions)
    // -------------------------------------------------------------------

    const cedarPolicies = {
      // Policy 1: Supervisor can access all tools
      'supervisor-full-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-supervisor",
  action in [AgentCore::Action::"invokeTool", AgentCore::Action::"invokeAgent"],
  resource
)
when { true };
`.trim(),

      // Policy 2: Search agent — KB + graph tools only
      'search-tools-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-search",
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource.name == "knowledge-base-query" ||
  resource.name == "graph-traversal"
};
`.trim(),

      // Policy 3: Scoring agent — graph + write-scores only
      'scoring-tools-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-scoring",
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource.name == "graph-traversal" ||
  resource.name == "compute-pagerank"
};
`.trim(),

      // Policy 4: Deny PII-tagged resources without guardrail
      'deny-pii-without-guardrail': `
forbid (
  principal,
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource has tags &&
  resource.tags.contains("pii") &&
  !(context has guardrailApplied && context.guardrailApplied == true)
}
unless {
  principal == AgentCore::Agent::"${prefix}-supervisor"
};
`.trim(),

      // Policy 5: Rate limiting — max 100 tool calls per minute per agent
      'rate-limit-tool-calls': `
forbid (
  principal,
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  context has rateLimit &&
  context.rateLimit.toolCallsPerMinute > 100
};
`.trim(),

      // Policy 6: Advisor — read-only access to KB + graph
      'advisor-tools-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-advisor",
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource.name == "knowledge-base-query" ||
  resource.name == "graph-traversal"
};
`.trim(),

      // Policy 7: Ingestion agent — KB write + graph traversal
      'ingestion-tools-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-ingestion",
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource.name == "knowledge-base-query" ||
  resource.name == "graph-traversal"
};
`.trim(),

      // Policy 8: Graph-builder — full graph access
      'graph-builder-tools-access': `
permit (
  principal == AgentCore::Agent::"${prefix}-graph-builder",
  action == AgentCore::Action::"invokeTool",
  resource
)
when {
  resource.name == "graph-traversal" ||
  resource.name == "compute-pagerank"
};
`.trim(),
    };

    // -------------------------------------------------------------------
    // IAM Role for CustomResource Lambda (manages Policy Engine)
    // -------------------------------------------------------------------

    const crRole = new iam.Role(this, 'PolicyCRRole', {
      roleName: `${prefix}-policy-cr-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for CustomResource Lambda that manages AgentCore Policy Engine',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    crRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCorePolicyManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:CreatePolicyEngine',
        'bedrock:UpdatePolicyEngine',
        'bedrock:DeletePolicyEngine',
        'bedrock:GetPolicyEngine',
        'bedrock:CreatePolicy',
        'bedrock:UpdatePolicy',
        'bedrock:DeletePolicy',
        'bedrock:ListPolicies',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------------------
    // Policy Engine (via CustomResource)
    // -------------------------------------------------------------------

    const policyEngine = new cr.AwsCustomResource(this, 'PolicyEngine', {
      resourceType: 'Custom::AgentCorePolicyEngine',
      onCreate: {
        service: 'BedrockAgentRuntime',
        action: 'createPolicyEngine',
        parameters: {
          name: `${prefix}-policy-engine`,
          description: 'OrgIQ Policy Engine - Cedar-based access control for agent tools and resources',
          mode: 'LOG_ONLY', // Start in monitoring mode; switch to ENFORCE after validation
          configuration: {
            guardrailArn: props.guardrailArn,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('policyEngineId'),
      },
      onUpdate: {
        service: 'BedrockAgentRuntime',
        action: 'updatePolicyEngine',
        parameters: {
          policyEngineId: new cr.PhysicalResourceIdReference(),
          name: `${prefix}-policy-engine`,
          description: 'OrgIQ Policy Engine - Cedar-based access control for agent tools and resources',
          mode: 'LOG_ONLY',
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('policyEngineId'),
      },
      onDelete: {
        service: 'BedrockAgentRuntime',
        action: 'deletePolicyEngine',
        parameters: {
          policyEngineId: new cr.PhysicalResourceIdReference(),
        },
      },
      role: crRole,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    const policyEngineId = policyEngine.getResponseField('policyEngineId');
    this.policyEngineId = policyEngineId;

    // -------------------------------------------------------------------
    // Cedar Policies (one CustomResource per policy)
    // -------------------------------------------------------------------

    for (const [policyName, cedarBody] of Object.entries(cedarPolicies)) {
      const policyResource = new cr.AwsCustomResource(this, `Policy${this.capitalize(policyName)}`, {
        resourceType: 'Custom::AgentCorePolicy',
        onCreate: {
          service: 'BedrockAgentRuntime',
          action: 'createPolicy',
          parameters: {
            policyEngineId: policyEngineId,
            name: `${prefix}-${policyName}`,
            description: `OrgIQ Cedar policy: ${policyName}`,
            policyType: 'CEDAR',
            policyBody: cedarBody,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('policyId'),
        },
        onUpdate: {
          service: 'BedrockAgentRuntime',
          action: 'updatePolicy',
          parameters: {
            policyEngineId: policyEngineId,
            policyId: new cr.PhysicalResourceIdReference(),
            name: `${prefix}-${policyName}`,
            policyBody: cedarBody,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('policyId'),
        },
        onDelete: {
          service: 'BedrockAgentRuntime',
          action: 'deletePolicy',
          parameters: {
            policyEngineId: policyEngineId,
            policyId: new cr.PhysicalResourceIdReference(),
          },
        },
        role: crRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      policyResource.node.addDependency(policyEngine);
    }

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'PolicyEngineId', {
      value: policyEngineId,
      exportName: `${prefix}-policy-engine-id`,
    });

    new cdk.CfnOutput(this, 'PolicyEngineMode', {
      value: 'LOG_ONLY',
      description: 'Current policy engine mode. Change to ENFORCE after validation.',
      exportName: `${prefix}-policy-engine-mode`,
    });
  }

  private capitalize(str: string): string {
    return str.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
