import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { gatewayToolCode } from './gateway-tool-code';
import { AGENT_NAMES } from './agentcore-runtime-stack';
import { loadGatewayToolManifest, parseGatewayToolManifest } from './gateway-tools-manifest';
import type { GatewayToolManifest, GatewayToolSpec } from './gateway-tools-manifest';
import type { Construct } from 'constructs';

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly auroraClusterArn: string;
  readonly auroraCredentialsSecretArn: string;
  readonly auroraReadOnlySecretArn: string;
  readonly knowledgeBaseId: string;
  readonly policyEngineArn: string;
  readonly policyEngineId: string;
  /** @deprecated No longer read: Cedar principals are the runtime execution roles (DE-7). */
  readonly agentRoles?: Record<string, iam.Role>;
  /**
   * The tool manifest. Defaults to `infra/gateway-tools.json`; tests pass a
   * fixture. It goes through the same schema check either way.
   */
  readonly manifest?: unknown;
}

// Construct ids and policy names deployed before the manifest existed. A rename
// would replace a named resource, so these stay as they were.
const LEGACY_POLICY: Record<string, { id: string; name: string }> = {
  supervisor: { id: 'PolicySupervisorFullAccess', name: 'supervisor_full_access' },
  search: { id: 'PolicySearchToolsAccess', name: 'search_tools_access' },
  scoring: { id: 'PolicyScoringToolsAccess', name: 'scoring_tools_access' },
  advisor: { id: 'PolicyAdvisorToolsAccess', name: 'advisor_tools_access' },
  ingestion: { id: 'PolicyIngestionToolsAccess', name: 'ingestion_tools_access' },
  'graph-builder': { id: 'PolicyGraphBuilderToolsAccess', name: 'graph_builder_tools_access' },
};

const pascal = (s: string): string => s.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');

export class AgentCoreGatewayStack extends cdk.Stack {
  public readonly gatewayIdentifier: string;
  public readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const manifest: GatewayToolManifest = props.manifest === undefined
      ? loadGatewayToolManifest(AGENT_NAMES)
      : parseGatewayToolManifest(props.manifest, AGENT_NAMES);

    for (const tool of manifest.tools) {
      const file = join(__dirname, '..', 'lambda', 'gateway-tools', `${tool.handler.split('.')[0]}.py`);
      if (!existsSync(file)) {
        throw new Error(`gateway-tools manifest: tool "${tool.name}" names handler "${tool.handler}" but ${file} does not exist`);
      }
    }

    // -------------------------------------------------------------------
    // One execution role per distinct access signature. `access` is a closed
    // vocabulary; nothing in a manifest can carry raw IAM, and no value grants
    // the Aurora admin secret.
    // -------------------------------------------------------------------

    const basic = () => [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')];
    const roles = new Map<string, iam.Role>();
    const roleFor = (tool: GatewayToolSpec): iam.Role => {
      const a = tool.access;
      const sig = [a.kb ? 'kb' : '', a.aurora === 'reader' ? 'aurora-reader' : '', a.bedrockInvoke ? 'bedrock-invoke' : '']
        .filter(Boolean).join('+') || 'none';
      const existing = roles.get(sig);
      if (existing) return existing;
      // The two signatures that existed before the manifest keep their construct ids.
      const legacy = sig === 'kb' ? 'GatewayToolsLambdaRole' : sig === 'aurora-reader' ? 'GraphTraversalRole' : undefined;
      const roleId = legacy ?? `GatewayTools${sig.split('+').map(pascal).join('')}Role`;
      const role = new iam.Role(this, roleId, {
        ...(sig === 'kb' ? { roleName: `${prefix}-gateway-tools-lambda-role` } : {}),
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        description: `Execution role for MCP Gateway Lambda tool targets (${sig})`,
        managedPolicies: basic(),
      });
      if (a.aurora === 'reader') {
        role.addToPolicy(new iam.PolicyStatement({
          actions: ['rds-data:ExecuteStatement'], resources: [props.auroraClusterArn],
        }));
        role.addToPolicy(new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'], resources: [props.auroraReadOnlySecretArn],
        }));
      }
      if (a.kb) {
        role.addToPolicy(new iam.PolicyStatement({
          sid: 'KnowledgeBaseAccess',
          actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
          resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`],
        }));
      }
      if (a.bedrockInvoke) {
        role.addToPolicy(new iam.PolicyStatement({
          sid: 'BedrockInvoke', actions: ['bedrock:InvokeModel'], resources: ['*'],
        }));
      }
      roles.set(sig, role);
      return role;
    };

    // -------------------------------------------------------------------
    // Lambda Functions for MCP Tool Targets (one per manifest entry)
    // -------------------------------------------------------------------

    const lambdas = new Map<string, lambda.Function>();
    for (const tool of manifest.tools) {
      const environment: Record<string, string> = { REGION: this.region };
      if (tool.access.kb) environment.KB_ID = props.knowledgeBaseId;
      if (tool.access.aurora === 'reader') {
        environment.AURORA_CLUSTER_ARN = props.auroraClusterArn;
        environment.AURORA_SECRET_ARN = props.auroraReadOnlySecretArn;
        environment.PROJECT_PREFIX = prefix;
      }
      lambdas.set(tool.name, new lambda.Function(this, `${tool.logicalId}Lambda`, {
        functionName: `${prefix}-gateway-${tool.target}`,
        description: `MCP tool: ${tool.description}`.slice(0, 256),
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: tool.handler,
        code: gatewayToolCode(),
        role: roleFor(tool),
        timeout: cdk.Duration.seconds(tool.timeoutSeconds),
        memorySize: tool.memoryMb,
        tracing: lambda.Tracing.ACTIVE,
        environment,
      }));
    }

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
              resources: [...lambdas.values()].map(fn => fn.functionArn),
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
    for (const fn of lambdas.values()) fn.grantInvoke(new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'));

    // -------------------------------------------------------------------
    // MCP Gateway
    // -------------------------------------------------------------------

    const gateway = new bedrockagentcore.CfnGateway(this, 'McpGateway', {
      name: `${prefix}-mcp-gateway`,
      description: 'OrgIQ MCP Gateway — Lambda tool targets declared in infra/gateway-tools.json',
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
    // MCP Gateway Targets (one per manifest entry)
    // credentialProviderType GATEWAY_IAM_ROLE — gateway assumes its own
    // IAM role (gatewayRole above) to invoke Lambda
    // -------------------------------------------------------------------

    const credentialProviderConfigurations = [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ];

    const targets: bedrockagentcore.CfnGatewayTarget[] = [];
    for (const tool of manifest.tools) {
      const target = new bedrockagentcore.CfnGatewayTarget(this, `${tool.logicalId}Target`, {
        name: `${prefix}-${tool.target}`,
        description: tool.description,
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        credentialProviderConfigurations,
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: lambdas.get(tool.name)!.functionArn,
              toolSchema: {
                inlinePayload: [
                  { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as unknown as bedrockagentcore.CfnGatewayTarget.SchemaDefinitionProperty },
                ],
              },
            },
          },
        },
      });
      target.node.addDependency(gateway);
      targets.push(target);
    }

    // -------------------------------------------------------------------
    // Cedar Policies — one per agent, listing exactly the tools the manifest
    // gives it. Principal is the runtime execution role (what a deployed
    // runtime actually runs as), built from its fixed name so this stack takes
    // no edge on the role's stack. Policy names must match
    // ^[A-Za-z][A-Za-z0-9_]*$ — no hyphens.
    // Action naming: "<target name>__<tool name>" (the gateway docs' pattern;
    // unverified against a live policy engine).
    // -------------------------------------------------------------------

    const safeName = prefix.replace(/-/g, '_');
    const agentTools = new Map<string, GatewayToolSpec[]>();
    for (const tool of manifest.tools) {
      for (const agent of tool.agents) agentTools.set(agent, [...(agentTools.get(agent) ?? []), tool]);
    }

    let prevPolicy: bedrockagentcore.CfnPolicy | undefined;
    for (const agent of AGENT_NAMES) {
      const tools = agentTools.get(agent);
      if (!tools) continue;

      const roleArn = `arn:aws:iam::${this.account}:role/${prefix}-${agent}-execution-role`;
      const actions = tools
        .map(t => `AgentCore::Action::"${prefix}-${t.target}___${t.name}"`).join(', ');
      const statement =
        `permit (\n  principal == AgentCore::IamEntity::"${roleArn}",\n  action in [${actions}],\n  resource == AgentCore::Gateway::"${gatewayArn}"\n);`;

      const legacy = LEGACY_POLICY[agent];
      const name = `${safeName}_${legacy?.name ?? `${agent.replace(/-/g, '_')}_tools_access`}`;
      const policy = new bedrockagentcore.CfnPolicy(this, legacy?.id ?? `Policy${pascal(agent)}ToolsAccess`, {
        name,
        description: `OrgIQ Cedar policy: ${name}`,
        policyEngineId: props.policyEngineId,
        definition: { cedar: { statement } },
      });
      // Policies must wait for targets — policy engine validates action names against existing targets
      for (const t of targets) policy.node.addDependency(t);
      // Chain sequentially to avoid concurrent stabilization timeouts
      if (prevPolicy) policy.node.addDependency(prevPolicy);
      prevPolicy = policy;

      // Cedar permits the call only if IAM lets the role make it.
      iam.Role.fromRoleArn(this, `${pascal(agent)}RuntimeRole`, roleArn, { mutable: true })
        .addToPrincipalPolicy(new iam.PolicyStatement({
          sid: 'InvokeMcpGateway',
          actions: ['bedrock-agentcore:InvokeGateway'], // action name unverified
          resources: [gatewayArn],
        }));
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

    for (const tool of manifest.tools) {
      new cdk.CfnOutput(this, `${tool.logicalId}LambdaArn`, {
        value: lambdas.get(tool.name)!.functionArn,
        exportName: `${prefix}-gateway-${tool.target}-lambda-arn`,
      });
    }
  }
}
