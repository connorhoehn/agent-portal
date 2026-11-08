import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';
import { trustedService } from './service-trust';
import { refusePlaintext } from './callback-secrets';
import { resolveContainerUri } from './agentcore-runtime-stack';
import { DEVBOX_TASK_TIMEOUT_S, bedrockModelArns, resolveDevboxModels } from './devbox-stack';
import { MICROVM_BEDROCK_ACTIONS, microvmLabApiBase } from './microvm-network-stack';
import { protectData } from './context-flags';

/** AgentCore's ceiling on a session's lifetime. */
export const AGENTCORE_MAX_LIFETIME_S = 8 * 3600;

/**
 * `maxLifetime` for a one-work-item session (design §7): the task timeout plus
 * 15 minutes for boot, clone, push and report, rounded up to the hour, capped
 * at AgentCore's 8 h.
 */
export function microvmMaxLifetime(taskTimeoutSeconds: number): number {
  if (!Number.isInteger(taskTimeoutSeconds) || taskTimeoutSeconds <= 0) {
    throw new Error(`taskTimeoutSeconds must be a positive integer, got ${taskTimeoutSeconds}`);
  }
  return Math.min(Math.ceil((taskTimeoutSeconds + 900) / 3600) * 3600, AGENTCORE_MAX_LIFETIME_S);
}

/** Stable export names and SSM parameters the middleware reads. */
export const microvmRuntimeExports = (prefix: string) => ({
  runtimeArn: `${prefix}-microvm-runtime-arn`,
  endpointArn: `${prefix}-microvm-endpoint-arn`,
  runsBucketName: `${prefix}-microvm-runs-bucket-name`,
});
export const microvmParameterNames = (prefix: string) => ({
  runtimeArn: `/${prefix}/microvm/runtime-arn`,
  endpointArn: `/${prefix}/microvm/endpoint-arn`,
  runsBucketName: `/${prefix}/microvm/runs-bucket`,
});

/** The execution role's statements, exactly design §12's table. */
export const MICROVM_ROLE_SIDS = [
  'BedrockInvokeClaude', 'EcrPull', 'EcrAuth', 'Logs', 'Traces', 'Metrics', 'Workload',
] as const;

export interface MicrovmRuntimeStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The two runtime subnets of OrgIQ-MicrovmNetwork. */
  readonly subnetIds: string[];
  /** The runtime security group of OrgIQ-MicrovmNetwork. */
  readonly securityGroupIds: string[];
  /** The profile's task timeout (s); sets maxLifetime (design §7). Default DEVBOX_TASK_TIMEOUT_S. */
  readonly taskTimeoutSeconds?: number;
  readonly modelId?: string;
  readonly smallModelId?: string;
  /**
   * @deprecated Refused unless `-c plaintextCallbackSecrets=true`, as on
   * OrgIQ-Devbox. Unlike the devbox, this runtime is NOT given the secret's
   * name either: its role has no secretsmanager action by design (§12), so
   * the fleet secret has to reach the lab broker another way (the boot
   * payload, beside the run token). See infra/SECURITY-NOTES.md.
   */
  readonly labCallbackSecret?: string;
}

/**
 * OrgIQ-MicrovmRuntime: `orgiq_microvm`, a second AgentCore runtime from the
 * `orgiq-devbox` image, in VPC mode behind OrgIQ-MicrovmNetwork's allowlist
 * (docs/microvm-runner-design.md §2, §7, §12).
 *
 * One session per (actor, agent project, job attempt), one work item, then
 * stop. No session storage: the workspace is the container's ephemeral disk
 * and durable state leaves by git and by one transcript object in the runs
 * bucket (presigned by the BFF, so this role has no S3 access at all).
 *
 * Deploy after OrgIQ-MicrovmNetwork, and after agents/devbox/build.sh has
 * pushed the image the devbox runtime already uses.
 */
export class MicrovmRuntimeStack extends cdk.Stack {
  public readonly runtimeArn: string;
  public readonly endpointArn: string;
  public readonly runsBucket: s3.Bucket;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: MicrovmRuntimeStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const repoName = `${prefix}-devbox`;
    const runtimeName = `${prefix}_microvm`;
    const taskTimeoutSeconds = props.taskTimeoutSeconds ?? DEVBOX_TASK_TIMEOUT_S;
    const maxLifetime = microvmMaxLifetime(taskTimeoutSeconds);
    const { modelId, smallModelId, allowedModels } = resolveDevboxModels(this, props);

    refusePlaintext(this, { labCallbackSecret: props.labCallbackSecret });

    // The devbox stack owns the repository; reference it by name so no export
    // is minted on OrgIQ-Devbox.
    const repo = ecr.Repository.fromRepositoryName(this, 'DevboxRepo', repoName);

    // ── Execution role: design §12, nothing else ────────────────────────────
    this.executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      roleName: `${prefix}-microvm-execution-role`,
      assumedBy: trustedService(this, 'bedrock-agentcore.amazonaws.com',
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`),
      description: `Execution role for ${runtimeName} (Claude Code, one work item per session, egress allowlist)`,
      inlinePolicies: {
        MicrovmRuntimeAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'BedrockInvokeClaude',
              actions: [...MICROVM_BEDROCK_ACTIONS],
              resources: allowedModels.flatMap((m) => bedrockModelArns(this.region, this.account, m)),
            }),
            new iam.PolicyStatement({
              sid: 'EcrPull',
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
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}*`],
            }),
            new iam.PolicyStatement({
              sid: 'Traces',
              actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'Metrics',
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
            }),
          ],
        }),
      },
    });

    // ── Runtime ─────────────────────────────────────────────────────────────
    const runtime = new bedrockagentcore.CfnRuntime(this, 'MicrovmRuntime', {
      agentRuntimeName: runtimeName,
      description: 'OrgIQ microVM runner: Claude Code, one work item per session, VPC egress allowlist',
      roleArn: this.executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: resolveContainerUri(repo.repositoryUri, repoName, this.region),
        },
      },
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: { subnets: props.subnetIds, securityGroups: props.securityGroupIds },
      },
      protocolConfiguration: 'HTTP',
      // No filesystemConfigurations: nothing survives the session on purpose (§2).
      lifecycleConfiguration: {
        // A job session is never idle on purpose; five minutes covers boot_end
        // → task and devbox_end → push (§7).
        idleRuntimeSessionTimeout: 300,
        maxLifetime,
      },
      environmentVariables: {
        AGENT_NAME: 'devbox',
        ORGIQ_RUNNER: 'microvm',
        PROJECT_PREFIX: prefix,
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: modelId,
        ANTHROPIC_SMALL_FAST_MODEL: smallModelId,
        DEVBOX_ALLOWED_MODELS: allowedModels.join(','),
        DEVBOX_TASK_TIMEOUT_S: String(taskTimeoutSeconds),
        DISABLE_AUTOUPDATER: '1',
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_SERVICE_NAME: `${prefix}-microvm`,
        OTEL_PYTHON_LOG_CORRELATION: 'true',
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=dev,service.namespace=${prefix},agent.id=${prefix}-microvm`,
        LAB_API_BASE: microvmLabApiBase(prefix),
        // No LAB_CALLBACK_SECRET and no LAB_CALLBACK_SECRET_ID: see labCallbackSecret above.
      },
    });

    // The workload identity AgentCore creates for this runtime. A separate
    // policy, not inline: the runtime needs the role first, the ARN needs the runtime.
    const workloadIdentityArn = cdk.Fn.getAtt(runtime.logicalId, 'WorkloadIdentityDetails.WorkloadIdentityArn').toString();
    new iam.Policy(this, 'MicrovmWorkloadAccess', {
      roles: [this.executionRole],
      statements: [new iam.PolicyStatement({
        sid: 'Workload',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken'],
        resources: [workloadIdentityArn],
      })],
    });

    const endpoint = new bedrockagentcore.CfnRuntimeEndpoint(this, 'MicrovmEndpoint', {
      name: `${runtimeName}_endpoint`,
      agentRuntimeId: runtime.attrAgentRuntimeId,
      description: 'Default endpoint for the microVM runtime',
    });
    endpoint.node.addDependency(runtime);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    this.endpointArn = endpoint.attrAgentRuntimeEndpointArn;

    // ── Runs bucket: one transcript per session under runs/ (§9, §11) ──────
    this.runsBucket = new s3.Bucket(this, 'RunsBucket', {
      bucketName: `${prefix}-microvm-runs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ id: 'expire-runs', prefix: 'runs/', expiration: cdk.Duration.days(30) }],
      removalPolicy: protectData(this) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── Outputs + SSM parameters the middleware reads ───────────────────────
    const ex = microvmRuntimeExports(prefix);
    const params = microvmParameterNames(prefix);
    new cdk.CfnOutput(this, 'MicrovmRuntimeArn', { value: this.runtimeArn, exportName: ex.runtimeArn });
    new cdk.CfnOutput(this, 'MicrovmEndpointArn', { value: this.endpointArn, exportName: ex.endpointArn });
    new cdk.CfnOutput(this, 'MicrovmRunsBucketName', { value: this.runsBucket.bucketName, exportName: ex.runsBucketName });
    new cdk.CfnOutput(this, 'MicrovmMaxLifetime', { value: String(maxLifetime) });
    new ssm.StringParameter(this, 'RuntimeArnParameter', {
      parameterName: params.runtimeArn,
      stringValue: this.runtimeArn,
      description: 'ARN of the orgiq_microvm AgentCore runtime',
    });
    new ssm.StringParameter(this, 'EndpointArnParameter', {
      parameterName: params.endpointArn,
      stringValue: this.endpointArn,
      description: 'ARN of the orgiq_microvm runtime endpoint',
    });
    new ssm.StringParameter(this, 'RunsBucketParameter', {
      parameterName: params.runsBucketName,
      stringValue: this.runsBucket.bucketName,
      description: 'Bucket for microVM run transcripts (runs/, 30-day expiry)',
    });
  }
}
