import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

export interface AgentCoreRuntimeStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly agentRoles: Record<string, iam.Role>;
  readonly memoryId: string;
  readonly guardrailId: string;
  readonly auroraClusterArn: string;
  readonly auroraCredentialsSecretArn: string;
  readonly knowledgeBaseId: string;
  readonly modelId?: string;
  readonly codeInterpreterId?: string;
  readonly codeInterpreterArn?: string;
  readonly browserId?: string;
  readonly browserArn?: string;
  readonly browserProfileId?: string;
}

const AGENT_NAMES = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
] as const;

/**
 * OrgIQ-AgentCoreRuntime: ECR repos, execution roles, and CfnRuntime resources.
 *
 * After deploying this stack, push container images to the ECR repos:
 *   cd agents/<name>
 *   aws ecr get-login-password | docker login --username AWS --password-stdin <ecr-uri>
 *   docker buildx build --platform linux/arm64 -t <ecr-uri>:latest --push .
 *
 * Runtime resources will be PENDING until the image exists in ECR.
 */
export class AgentCoreRuntimeStack extends cdk.Stack {
  public readonly runtimeIds: Record<string, string> = {};
  public readonly ecrRepos: Record<string, ecr.Repository> = {};

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const modelId = props.modelId ?? 'amazon.nova-pro-v1:0';

    // Phase 1 (default): create ECR repos + execution roles
    // Phase 2 (after images pushed): add CfnRuntime + CfnRuntimeEndpoint
    //   cdk deploy OrgIQ-AgentCoreRuntime --context deployRuntimes=true
    const deployRuntimes = this.node.tryGetContext('deployRuntimes') === 'true';

    for (const agentName of AGENT_NAMES) {
      const agentRole = props.agentRoles[agentName];
      if (!agentRole) continue;

      const pascal = this.pascal(agentName);
      const runtimeName = `${prefix}-${agentName}`;
      // agentRuntimeName and endpoint name must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens
      const safeRuntimeName = `${prefix}_${agentName.replace(/-/g, '_')}`;

      // ECR repo for agent container image (built by `docker buildx --platform linux/arm64`)
      const repo = new ecr.Repository(this, `${pascal}Repo`, {
        repositoryName: runtimeName,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [{ maxImageCount: 5 }],
      });
      this.ecrRepos[agentName] = repo;

      // Runtime execution role — trusted by bedrock-agentcore service
      const executionRole = new iam.Role(this, `${pascal}ExecutionRole`, {
        roleName: `${runtimeName}-execution-role`,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        description: `Execution role for ${runtimeName} AgentCore Runtime`,
        inlinePolicies: {
          RuntimeAccess: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: 'BedrockInvoke',
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                resources: ['*'],
              }),
              new iam.PolicyStatement({
                sid: 'EcrAccess',
                actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
                resources: [repo.repositoryArn],
              }),
              new iam.PolicyStatement({
                sid: 'EcrAuth',
                actions: ['ecr:GetAuthorizationToken'],
                resources: ['*'],
              }),
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
              new iam.PolicyStatement({
                sid: 'Metrics',
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
              }),
              new iam.PolicyStatement({
                sid: 'AgentCoreWorkload',
                actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJwt'],
                resources: ['*'],
              }),
            ],
          }),
        },
      });

      // Supervisor needs A2A: list runtimes for discovery + invoke sub-agents
      if (agentName === 'supervisor') {
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'A2ARuntimeDiscovery',
          actions: [
            'bedrock-agentcore-control:ListAgentRuntimes',
            'bedrock-agentcore-control:GetAgentRuntime',
          ],
          resources: ['*'],
        }));
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'A2AInvokeSubAgents',
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${prefix}_*`],
        }));
      }

      new cdk.CfnOutput(this, `${pascal}EcrUri`, {
        value: repo.repositoryUri,
        description: `ECR URI for ${agentName} — push ARM64 image then redeploy with --context deployRuntimes=true`,
      });

      if (!deployRuntimes) continue;

      // AgentCore Runtime resource (requires image in ECR)
      const runtime = new bedrockagentcore.CfnRuntime(this, `${pascal}Runtime`, {
        agentRuntimeName: safeRuntimeName,
        description: `OrgIQ ${agentName} agent runtime`,
        roleArn: executionRole.roleArn,
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: `${repo.repositoryUri}:latest`,
          },
        },
        networkConfiguration: { networkMode: 'PUBLIC' },
        protocolConfiguration: 'HTTP',
        environmentVariables: {
          AGENT_NAME: agentName,
          MEMORY_ID: props.memoryId,
          GUARDRAIL_ID: props.guardrailId,
          MODEL_ID: modelId,
          AURORA_CLUSTER_ARN: props.auroraClusterArn,
          AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
          KB_ID: props.knowledgeBaseId,
          PROJECT_PREFIX: prefix,
          ...(props.codeInterpreterId && { CODE_INTERPRETER_ID: props.codeInterpreterId }),
          ...(props.browserId && { BROWSER_ID: props.browserId }),
          ...(props.browserProfileId && { BROWSER_PROFILE_ID: props.browserProfileId }),
        },
      });

      this.runtimeIds[agentName] = runtime.attrAgentRuntimeId;

      const endpoint = new bedrockagentcore.CfnRuntimeEndpoint(this, `${pascal}Endpoint`, {
        name: `${safeRuntimeName}_endpoint`,
        agentRuntimeId: runtime.attrAgentRuntimeId,
        description: `Default endpoint for ${agentName} agent`,
      });
      endpoint.node.addDependency(runtime);

      new cdk.CfnOutput(this, `${pascal}RuntimeId`, {
        value: runtime.attrAgentRuntimeId,
        exportName: `${prefix}-${agentName}-runtime-id`,
      });
    }

    // Grant capability access to the appropriate agent roles now that both
    // AgentsStack (roles) and AgentCoreCapabilitiesStack (ARNs) are resolved.
    // These grants live here to avoid a cross-stack dependency cycle.
    if (props.codeInterpreterArn) {
      for (const agentName of ['graph-builder', 'scoring'] as const) {
        props.agentRoles[agentName]?.addToPolicy(new iam.PolicyStatement({
          sid: 'CodeInterpreterInvoke',
          actions: [
            'bedrock-agentcore:InvokeCodeInterpreter',
            'bedrock-agentcore:StartCodeInterpreterSession',
            'bedrock-agentcore:StopCodeInterpreterSession',
            'bedrock-agentcore:ExecuteCodeInterpreterCode',
            'bedrock-agentcore:ListCodeInterpreterSessions',
          ],
          resources: [props.codeInterpreterArn],
        }));
      }
    }

    if (props.browserArn) {
      for (const agentName of ['supervisor', 'search', 'advisor'] as const) {
        props.agentRoles[agentName]?.addToPolicy(new iam.PolicyStatement({
          sid: 'BrowserInvoke',
          actions: [
            'bedrock-agentcore:InvokeBrowser',
            'bedrock-agentcore:StartBrowserSession',
            'bedrock-agentcore:StopBrowserSession',
            'bedrock-agentcore:TakeBrowserScreenshot',
            'bedrock-agentcore:ClickBrowserElement',
            'bedrock-agentcore:SendKeystrokesToBrowser',
            'bedrock-agentcore:ScrollBrowserElement',
            'bedrock-agentcore:NavigateBrowserToPage',
            'bedrock-agentcore:GetBrowserPageSource',
          ],
          resources: [props.browserArn],
        }));
      }
    }

    new cdk.CfnOutput(this, 'ModelId', {
      value: modelId,
      exportName: `${prefix}-runtime-model-id`,
    });
  }

  private pascal(name: string): string {
    return name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
