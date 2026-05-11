import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

export interface AgentCoreCapabilitiesStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** OAuth2 return URLs for the workload identity (portal + middleware) */
  readonly allowedOauth2ReturnUrls?: string[];
}

/**
 * AgentCore Capabilities: Code Interpreter, Browser, and Workload Identity.
 *
 * Code Interpreter — sandboxed Python execution for agents:
 *   - No outbound network (RESTRICTED mode)
 *   - Used by graph-builder (NER/entity extraction) and scoring (PageRank)
 *
 * Browser — headless web browser for agents:
 *   - PUBLIC network mode (needs internet to browse)
 *   - BrowserProfile persists session state across invocations
 *   - Used by supervisor, search, advisor for web research
 *
 * WorkloadIdentity — OIDC token federation:
 *   - Allows the portal/middleware to exchange tokens for AgentCore access
 *   - Configure allowedOauth2ReturnUrls to match your portal's callback URL
 */
export class AgentCoreCapabilitiesStack extends cdk.Stack {
  public readonly codeInterpreterId: string;
  public readonly codeInterpreterArn: string;
  public readonly browserId: string;
  public readonly browserArn: string;
  public readonly browserProfileId: string;
  public readonly workloadIdentityArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreCapabilitiesStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const safePrefix = prefix.replace(/-/g, '_');

    // -------------------------------------------------------------------
    // Shared execution role for AgentCore sandbox resources
    // Trusted by bedrock-agentcore; granted CloudWatch for logs
    // -------------------------------------------------------------------

    const sandboxRole = new iam.Role(this, 'SandboxExecutionRole', {
      roleName: `${prefix}-sandbox-execution-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for OrgIQ AgentCore Code Interpreter and Browser',
      inlinePolicies: {
        SandboxAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'Logs',
              actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
            }),
            new iam.PolicyStatement({
              sid: 'Xray',
              actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // -------------------------------------------------------------------
    // Code Interpreter — sandboxed Python execution (no network)
    // -------------------------------------------------------------------

    const codeInterpreter = new bedrockagentcore.CfnCodeInterpreterCustom(this, 'CodeInterpreter', {
      name: `${safePrefix}_code_interpreter`,
      description: 'OrgIQ sandboxed Python execution for graph-builder NER and scoring algorithms',
      executionRoleArn: sandboxRole.roleArn,
      networkConfiguration: { networkMode: 'SANDBOX' },
    });

    this.codeInterpreterId = codeInterpreter.attrCodeInterpreterId;
    this.codeInterpreterArn = codeInterpreter.attrCodeInterpreterArn;

    // -------------------------------------------------------------------
    // Browser — headless web browser for web research
    // -------------------------------------------------------------------

    const browser = new bedrockagentcore.CfnBrowserCustom(this, 'Browser', {
      name: `${safePrefix}_browser`,
      description: 'OrgIQ headless browser for agent web research',
      executionRoleArn: sandboxRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
    });

    this.browserId = browser.attrBrowserId;
    this.browserArn = browser.attrBrowserArn;

    const browserProfile = new bedrockagentcore.CfnBrowserProfile(this, 'BrowserProfile', {
      name: `${safePrefix}_browser_profile`,
      description: 'OrgIQ default browser profile for persistent session state',
    });
    browserProfile.node.addDependency(browser);

    this.browserProfileId = browserProfile.attrProfileId;

    // -------------------------------------------------------------------
    // Workload Identity — OIDC/OAuth2 token federation
    // Portal and middleware exchange their Cognito/Okta tokens for
    // AgentCore-scoped access without embedding long-lived credentials.
    // -------------------------------------------------------------------

    const workloadIdentity = new bedrockagentcore.CfnWorkloadIdentity(this, 'WorkloadIdentity', {
      name: `${prefix}-workload-identity`,
      allowedResourceOauth2ReturnUrls: props.allowedOauth2ReturnUrls ?? [
        'http://localhost:3001/auth/callback',   // middleware dev
        'http://localhost:5173/auth/callback',   // portal dev
      ],
    });

    this.workloadIdentityArn = workloadIdentity.attrWorkloadIdentityArn;

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'CodeInterpreterId', {
      value: codeInterpreter.attrCodeInterpreterId,
      exportName: `${prefix}-code-interpreter-id`,
    });

    new cdk.CfnOutput(this, 'CodeInterpreterArn', {
      value: codeInterpreter.attrCodeInterpreterArn,
      exportName: `${prefix}-code-interpreter-arn`,
    });

    new cdk.CfnOutput(this, 'BrowserId', {
      value: browser.attrBrowserId,
      exportName: `${prefix}-browser-id`,
    });

    new cdk.CfnOutput(this, 'BrowserArn', {
      value: browser.attrBrowserArn,
      exportName: `${prefix}-browser-arn`,
    });

    new cdk.CfnOutput(this, 'BrowserProfileId', {
      value: browserProfile.attrProfileId,
      exportName: `${prefix}-browser-profile-id`,
    });

    new cdk.CfnOutput(this, 'WorkloadIdentityArn', {
      value: workloadIdentity.attrWorkloadIdentityArn,
      exportName: `${prefix}-workload-identity-arn`,
    });
  }
}
