import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';
import { resolveContainerUri } from './agentcore-runtime-stack';

export interface DevboxStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /**
   * Claude model for Claude Code, as a Bedrock inference-profile ID (`us.anthropic.claude-*` — bare model IDs don't support on-demand invocation).
   * Deliberate exception to the "AWS-native models only" convention — Claude
   * Code requires Claude; via Bedrock it stays AWS-hosted and AWS-billed with
   * no Anthropic API key anywhere. Recorded in CLAUDE.md Gotchas.
   */
  readonly modelId?: string;
  readonly smallModelId?: string;
  /**
   * Optional OrgIQ data-plane access, wired ONLY when the `devboxOrgAccess`
   * context flag is true. Off by default on purpose: unlike the 9-agent
   * runtime stack (whose loop grants every role Aurora/KB/S3/DDB access),
   * the devbox starts with Bedrock inference + logging and nothing else.
   */
  readonly auroraClusterArn?: string;
  readonly auroraCredentialsSecretArn?: string;
  readonly knowledgeBaseId?: string;
}

/**
 * OrgIQ-Devbox: Claude Code hosted in an AgentCore Runtime microVM.
 *
 * A tenth runtime unlike the nine OrgIQ agents — the container runs the Claude
 * Code CLI behind a thin runtime-contract wrapper (agents/devbox/main.py).
 * Three access modes: task mode (InvokeAgentRuntime → `claude -p` headless),
 * command mode (InvokeAgentRuntimeCommand — deterministic shell, no LLM), and
 * interactive PTY (`agentcore exec --it` from the CLI / JupyterLab Terminal).
 *
 * Persistence: managed session storage (preview) mounted at /mnt/workspace —
 * survives stop/resume on the same runtimeSessionId. ⚠️ Wiped on every runtime
 * version update: digest-pinning means every image push + deploy resets all
 * workspaces. 1 GB/session, 14-day idle expiry, session IDs ≥33 chars.
 *
 * Two-phase deploy, mirroring OrgIQ-AgentCoreRuntime:
 *   Phase 1 (default):  ECR repo + execution role
 *   Phase 2:            cdk deploy OrgIQ-Devbox --context deployDevbox=true
 *                       (after agents/devbox/build.sh has pushed the image)
 */
export class DevboxStack extends cdk.Stack {
  public readonly ecrRepo: ecr.Repository;
  public readonly runtimeId?: string;
  public readonly runtimeArn?: string;

  constructor(scope: Construct, id: string, props: DevboxStackProps = {}) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const repoName = `${prefix}-devbox`;
    // agentRuntimeName must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens
    const safeRuntimeName = `${prefix}_devbox`;

    const deployDevbox = this.node.tryGetContext('deployDevbox') === 'true'
      || this.node.tryGetContext('deployDevbox') === true;
    const orgAccess = this.node.tryGetContext('devboxOrgAccess') === 'true'
      || this.node.tryGetContext('devboxOrgAccess') === true;

    const modelId = (this.node.tryGetContext('devboxModel') as string | undefined)
      ?? props.modelId
      // Haiku by default. A devbox task is usually small — read a file, run a
      // test, leave a note — and Sonnet was charging ~$0.12 for a three-second
      // "are you there". Callers opt into a larger model per task when the work
      // warrants it; see DEVBOX_ALLOWED_MODELS below.
      ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const smallModelId = (this.node.tryGetContext('devboxSmallModel') as string | undefined)
      ?? props.smallModelId
      ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    // ── ECR ──────────────────────────────────────────────────────────────────
    this.ecrRepo = new ecr.Repository(this, 'DevboxRepo', {
      repositoryName: repoName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 5 }],
    });

    // ── Execution role — minimal by design ──────────────────────────────────
    const executionRole = new iam.Role(this, 'DevboxExecutionRole', {
      roleName: `${repoName}-execution-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `Execution role for ${repoName} AgentCore Runtime (Claude Code devbox)`,
      inlinePolicies: {
        DevboxRuntimeAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'BedrockInvokeClaude',
              // Claude Code with CLAUDE_CODE_USE_BEDROCK=1 calls Bedrock
              // inference under the container credentials. Cover both ID
              // forms: bare foundation-model (`anthropic.claude-*`) and
              // regional inference profiles (`us.anthropic.claude-*`).
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:CountTokens',
              ],
              resources: [
                'arn:aws:bedrock:*::foundation-model/anthropic.*',
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*anthropic*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'EcrAccess',
              actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
              resources: [this.ecrRepo.repositoryArn],
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

    // Opt-in, read-only OrgIQ data-plane access — for devbox sessions that
    // exercise real OrgIQ agent code against live data.
    //   cdk deploy OrgIQ-Devbox --context deployDevbox=true --context devboxOrgAccess=true
    if (orgAccess) {
      if (props.auroraClusterArn && props.auroraCredentialsSecretArn) {
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'OrgAccessAuroraRead',
          // ExecuteStatement only — no transactions, no batch writes. SQL-level
          // read enforcement is the caller's responsibility, as with the
          // OrgIQ read tools.
          actions: ['rds-data:ExecuteStatement'],
          resources: [props.auroraClusterArn],
        }));
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'OrgAccessAuroraSecret',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.auroraCredentialsSecretArn],
        }));
      }
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'OrgAccessKbRetrieve',
        actions: ['bedrock:Retrieve'],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }));
    }

    new cdk.CfnOutput(this, 'DevboxEcrUri', {
      value: this.ecrRepo.repositoryUri,
      description: 'ECR URI for the devbox image — push via agents/devbox/build.sh, then redeploy with --context deployDevbox=true',
      exportName: `${prefix}-devbox-ecr-uri`,
    });

    new cdk.CfnOutput(this, 'DevboxModelId', {
      value: modelId,
      description: 'Bedrock Claude model Claude Code runs on (override: --context devboxModel=...)',
    });

    if (!deployDevbox) return;

    // ── Runtime (phase 2 — requires image in ECR) ───────────────────────────
    const runtime = new bedrockagentcore.CfnRuntime(this, 'DevboxRuntime', {
      agentRuntimeName: safeRuntimeName,
      description: 'OrgIQ devbox: Claude Code in a microVM with persistent session workspace',
      roleArn: executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: resolveContainerUri(this.ecrRepo.repositoryUri, repoName, this.region),
        },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      // Managed session storage (preview): per-session persistent workspace.
      // No VPC and no extra IAM required. See stack header for lifecycle
      // caveats (wipe-on-version-update, 14-day idle expiry, 1 GB cap).
      filesystemConfigurations: [
        { sessionStorage: { mountPath: '/mnt/workspace' } },
      ],
      // 1 h idle so a thinking pause or a stepped-away user doesn't kill the
      // microVM mid-session (the workspace survives either way — this just
      // avoids cold-start churn); 8 h hard cap (the service maximum).
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 3600,
        maxLifetime: 28800,
      },
      environmentVariables: {
        AGENT_NAME: 'devbox',
        PROJECT_PREFIX: prefix,
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: modelId,
        ANTHROPIC_SMALL_FAST_MODEL: smallModelId,
        // Per-task overrides are validated against this list in the container,
        // so a typo or a stray client cannot bill against an arbitrary model.
        DEVBOX_ALLOWED_MODELS: 'us.anthropic.claude-haiku-4-5-20251001-v1:0,us.anthropic.claude-sonnet-5,us.anthropic.claude-opus-4-8',
        DISABLE_AUTOUPDATER: '1',
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_SERVICE_NAME: `${prefix}-devbox`,
        OTEL_PYTHON_LOG_CORRELATION: 'true',
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=dev,service.namespace=${prefix},agent.id=${prefix}-devbox`,
      },
    });

    const endpoint = new bedrockagentcore.CfnRuntimeEndpoint(this, 'DevboxEndpoint', {
      name: `${safeRuntimeName}_endpoint`,
      agentRuntimeId: runtime.attrAgentRuntimeId,
      description: 'Default endpoint for the devbox runtime',
    });
    endpoint.node.addDependency(runtime);

    this.runtimeId = runtime.attrAgentRuntimeId;
    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new cdk.CfnOutput(this, 'DevboxRuntimeId', {
      value: runtime.attrAgentRuntimeId,
      exportName: `${prefix}-devbox-runtime-id`,
    });
    new cdk.CfnOutput(this, 'DevboxRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      exportName: `${prefix}-devbox-runtime-arn`,
    });
  }
}
