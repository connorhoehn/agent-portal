import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface MiddlewareServiceStackProps extends cdk.StackProps {
  readonly prefix?: string;

  /**
   * ARN of the ACM certificate for the ALB HTTPS listener.
   * Pass via CDK context: --context certificateArn=arn:aws:acm:...
   * When omitted the stack creates an HTTP-only listener on port 80.
   */
  readonly certificateArn?: string;

  // ── Foundation DynamoDB table names (imported via Fn.importValue) ──────────
  readonly scoresTableName: string;
  readonly sessionsTableName: string;

  // ── Foundation DynamoDB table ARNs (for IAM grants) ───────────────────────
  readonly scoresTableArn: string;
  readonly sessionsTableArn: string;

  // ── S3 bucket names ────────────────────────────────────────────────────────
  readonly documentsBucketArn: string;
  readonly artifactsBucketArn: string;

  // ── Secrets / IDs populated by other stacks ───────────────────────────────
  /** Secrets Manager ARN for the HMAC session signing key (AuthorizationStack) */
  readonly sessionSigningSecretArn: string;
  /** AVP policy store ID (AuthorizationStack) */
  readonly policyStoreId: string;

  // ── Aurora (optional — middleware can run with MOCK_AURORA=true) ───────────
  readonly auroraClusterArn?: string;
  readonly auroraCredentialsSecretArn?: string;

  // ── WebSocket gateway URL ─────────────────────────────────────────────────
  /** HTTP base URL for the websocket-gateway service. Defaults to empty (mock). */
  readonly websocketGatewayUrl?: string;

  // ── AgentCore (optional — middleware can run with MOCK_AGENTCORE=true) ─────
  readonly memoryId?: string;
  readonly knowledgeBaseId?: string;
  readonly gatewayId?: string;
  readonly gatewayUrl?: string;

  // ── Guardrail IDs per role (optional) ────────────────────────────────────
  readonly guardrailIdMember?: string;
  readonly guardrailIdOrgLeader?: string;
  readonly guardrailIdHrAdmin?: string;

  // ── Cognito SSO (optional) ───────────────────────────────────────────────
  // When present, the BFF exposes the OIDC sign-in flow. The callback URL must
  // be HTTPS for a non-localhost origin, so it's only set when a certificate
  // (HTTPS listener) is configured; without it, SSO stays off on ECS.
  readonly cognitoUserPoolId?: string;
  readonly cognitoClientId?: string;
  readonly cognitoDomain?: string;
  readonly cognitoClientSecretArn?: string;
}

/**
 * OrgIQ-MiddlewareService: ECS Fargate + ALB for the Express middleware.
 *
 * Self-contained stack: owns its own VPC, ECS cluster, and ECR repo.
 * All cross-stack data is injected via props (Fn.importValue in app.ts).
 *
 * First-time deploy flow:
 *   1. cdk deploy OrgIQ-MiddlewareService        ← creates ECR repo + Fargate skeleton
 *   2. docker build + push orgiq-middleware:latest to the ECR repo
 *   3. Re-trigger the service update (force-new-deployment or re-deploy)
 *
 * HTTP-only mode (no certificate):
 *   cdk deploy OrgIQ-MiddlewareService
 *
 * HTTPS mode:
 *   cdk deploy OrgIQ-MiddlewareService --context certificateArn=arn:aws:acm:...
 */
export class MiddlewareServiceStack extends cdk.Stack {
  /** ECR repository URI for the middleware Docker image */
  public readonly ecrRepoUri: string;
  /** ALB DNS name (use this as CNAME in Route 53 or as origin in CloudFront) */
  public readonly loadBalancerDnsName: string;
  /**
   * ARNs of the three machine-callback auth secrets minted by this stack.
   * Exposed for completeness (e.g. an operator script resolving by stack
   * output); NOT consumable by AgentCoreRuntimeStack at synth time — see the
   * ⚠️ comment above where these secrets are created.
   */
  public readonly approvalsRequestSecretArn!: string;
  public readonly harnessTraceSecretArn!: string;
  public readonly assessmentRunCompleteSecretArn!: string;

  constructor(scope: Construct, id: string, props: MiddlewareServiceStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';

    // ── Certificate (optional) ─────────────────────────────────────────────
    // Prefer the prop value, then the CDK context key.  Allows the cert ARN to
    // be passed either from app.ts or from the CLI without changing this file.
    const certArn: string | undefined =
      props.certificateArn ??
      (this.node.tryGetContext('certificateArn') as string | undefined);

    // ── VPC ────────────────────────────────────────────────────────────────
    // Dedicated VPC for the middleware service.  Public + private subnets so
    // the ALB is internet-facing while Fargate tasks stay in private subnets
    // with NAT egress for outbound AWS API calls.
    const vpc = new ec2.Vpc(this, 'MiddlewareVpc', {
      vpcName: `${prefix}-middleware-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ── ECS Cluster ────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'MiddlewareCluster', {
      vpc,
      clusterName: `${prefix}-middleware`,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // ── ECR Repository ─────────────────────────────────────────────────────
    // ── ECR ─────────────────────────────────────────────────────────────────
    //
    // The repository is gated behind `deployMiddleware` and the service behind
    // an image existing, because owning both in one stack is unshippable: the
    // stack creates an empty repository, the Fargate service cannot pull,
    // the deployment circuit breaker trips, and CREATE_FAILED follows. The
    // usual recovery — delete the failed stack and retry — destroys the
    // repository (emptyOnDelete) along with the image that was just pushed, so
    // the loop never terminates.
    //
    // Two phases, the same pattern the agent stacks already use: deploy once to
    // create the repository, push the image, deploy again with
    // `--context deployMiddlewareService=true` to bring the service up.
    const repo = new ecr.Repository(this, 'MiddlewareEcrRepo', {
      repositoryName: `${prefix}-middleware`,
      // RETAIN so a failed-stack delete does not take the image with it. The
      // orphan sweep in scripts/deploy.sh adopts an existing repository on the
      // next deploy.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      lifecycleRules: [{ maxImageCount: 10 }],
    });
    this.ecrRepoUri = repo.repositoryUri;

    const deployService = this.node.tryGetContext('deployMiddlewareService') === 'true'
      || this.node.tryGetContext('deployMiddlewareService') === true;

    // ── CloudWatch Log Group ────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'MiddlewareLogGroup', {
      logGroupName: `/ecs/${prefix}-middleware`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Task Role (runtime permissions) ────────────────────────────────────
    const taskRole = new iam.Role(this, 'MiddlewareTaskRole', {
      roleName: `${prefix}-middleware-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime role for orgiq-middleware Fargate task',
    });

    // Secrets Manager — session signing key
    const signingSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this, 'SessionSigningSecretRef', props.sessionSigningSecretArn,
    );
    signingSecret.grantRead(taskRole);

    // Secrets Manager — Aurora credentials (if wired)
    if (props.auroraCredentialsSecretArn) {
      const auroraSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'AuroraSecretRef', props.auroraCredentialsSecretArn,
      );
      auroraSecret.grantRead(taskRole);
    }

    // Secrets Manager — machine-callback auth for the three sessionless
    // agent-facing routes (routes/approvals.ts requireServiceAuth,
    // routes/harness.ts requireTraceAuth, routes/assessment.ts
    // requireRunCompleteAuth). Each guard is OPEN when its env var is unset
    // and does a constant-time header check when it's set — today none of
    // these vars are set anywhere, so all three callbacks are open on this
    // internet-facing service.
    //
    // Three separate secrets rather than one JSON secret: CDK's
    // `generateSecretString` only auto-generates a single random field per
    // Secret resource (a JSON secret would need a custom resource to
    // populate more than one key at deploy time), and three independent
    // secrets let an operator rotate one callback's credential (e.g. if a
    // harness-trace secret leaks into a log) without touching the other two
    // — matching the fact that each guard already checks exactly one
    // independent env var with no shared state.
    //
    // ⚠️ Wiring these as container secrets flips each guard from open to
    // required the moment this stack deploys. As of this change NO agent
    // code sends the corresponding header — see the operator runbook in
    // docs/agentcore-preview-surface.md — so deploying this alone will 401
    // every approval request, every trace POST, and (if anything calls it)
    // every assessment run-complete callback until the agent side is also
    // patched and redeployed. Read that runbook before deploying.
    const approvalsRequestSecret = new secretsmanager.Secret(this, 'ApprovalsRequestSecret', {
      secretName: `${prefix}-approvals-request-secret`,
      description: 'Shared secret for x-approvals-auth on POST /api/observability/approvals/request (requireServiceAuth)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    approvalsRequestSecret.grantRead(taskRole);

    const harnessTraceSecret = new secretsmanager.Secret(this, 'HarnessTraceSecret', {
      secretName: `${prefix}-harness-trace-secret`,
      description: 'Shared secret for x-harness-auth on POST /api/observability/harness/trace (requireTraceAuth)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    harnessTraceSecret.grantRead(taskRole);

    const assessmentRunCompleteSecret = new secretsmanager.Secret(this, 'AssessmentRunCompleteSecret', {
      secretName: `${prefix}-assessment-run-complete-secret`,
      description: 'Shared secret for x-assessment-run-auth on POST /api/assessment/runs/:runId/complete (requireRunCompleteAuth)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    assessmentRunCompleteSecret.grantRead(taskRole);

    this.approvalsRequestSecretArn = approvalsRequestSecret.secretArn;
    this.harnessTraceSecretArn = harnessTraceSecret.secretArn;
    this.assessmentRunCompleteSecretArn = assessmentRunCompleteSecret.secretArn;

    // Exported so a future stack (or an operator script) can look these up
    // by stable name instead of hunting through the console. NOTE: these
    // exports do NOT solve the AgentCoreRuntime wiring problem described in
    // agentcore-runtime-stack.ts — that stack is instantiated earlier in
    // app.ts than this one, and even if it imported the ARN it could not
    // resolve the secret's plaintext value at synth time. See the comment
    // near ApprovalsRequestSecret usage in agentcore-runtime-stack.ts.
    new cdk.CfnOutput(this, 'ApprovalsRequestSecretArnOutput', {
      value: approvalsRequestSecret.secretArn,
      exportName: `${prefix}-approvals-request-secret-arn`,
    });
    new cdk.CfnOutput(this, 'HarnessTraceSecretArnOutput', {
      value: harnessTraceSecret.secretArn,
      exportName: `${prefix}-harness-trace-secret-arn`,
    });
    new cdk.CfnOutput(this, 'AssessmentRunCompleteSecretArnOutput', {
      value: assessmentRunCompleteSecret.secretArn,
      exportName: `${prefix}-assessment-run-complete-secret-arn`,
    });

    // DynamoDB — scores + sessions tables
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DdbScoresReadWrite',
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
        'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem',
      ],
      resources: [
        props.scoresTableArn,
        `${props.scoresTableArn}/index/*`,
      ],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DdbSessionsReadWrite',
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
      ],
      resources: [
        props.sessionsTableArn,
        `${props.sessionsTableArn}/index/*`,
      ],
    }));

    // S3 — documents read/write (landing-zone uploads + deletes) + artifacts read/write
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3DocumentsReadWrite',
      actions: [
        's3:GetObject', 's3:ListBucket', 's3:GetBucketLocation',
        's3:PutObject', 's3:DeleteObject',   // required for landing-zone upload + delete
      ],
      resources: [props.documentsBucketArn, `${props.documentsBucketArn}/*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ArtifactsReadWrite',
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [props.artifactsBucketArn, `${props.artifactsBucketArn}/*`],
    }));

    // Aurora RDS Data API (if wired)
    if (props.auroraClusterArn) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AuroraDataApi',
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.auroraClusterArn],
      }));
    }

    // Bedrock — invoke + retrieve + guardrails + AgentCore ops
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
        'bedrock:ApplyGuardrail',
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
        'bedrock:InvokeAgent',
        'bedrock:InvokeFlow',
        'bedrock:GetPrompt',
        'bedrock:ListPrompts',
      ],
      resources: ['*'],
    }));

    // Bedrock AgentCore — invoke runtimes + A2A
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreInvoke',
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:ListAgentRuntimes',
        'bedrock-agentcore:GetAgentRuntime',
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetWorkloadAccessTokenForJwt',
      ],
      resources: ['*'],
    }));

    // Devbox routes (/api/devbox) — command-mode shell + session stop, scoped
    // to the devbox runtime only. InvokeAgentRuntime for devbox task mode is
    // already covered by AgentCoreInvoke above; these two are the additional
    // devbox-only operations and stay off every other runtime.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DevboxCommandAndStop',
      actions: [
        'bedrock-agentcore:InvokeAgentRuntimeCommand',
        // Interactive PTY terminals. This is a CALLER permission — it belongs
        // to whoever opens the WebSocket, not to the devbox execution role,
        // which is a different principal entirely.
        'bedrock-agentcore:InvokeAgentRuntimeCommandShell',
        'bedrock-agentcore:StopRuntimeSession',
      ],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${prefix}_devbox*`],
    }));

    // AWS Verified Permissions — IsAuthorized calls for RBAC
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AvpIsAuthorized',
      actions: [
        'verifiedpermissions:IsAuthorized',
        'verifiedpermissions:IsAuthorizedWithToken',
        'verifiedpermissions:GetPolicy',
        'verifiedpermissions:ListPolicies',
        'verifiedpermissions:CreatePolicy',
        'verifiedpermissions:UpdatePolicy',
        'verifiedpermissions:DeletePolicy',
        'verifiedpermissions:GetSchema',
        'verifiedpermissions:PutSchema',
      ],
      resources: [`arn:aws:verifiedpermissions::${this.account}:policy-store/${props.policyStoreId}`],
    }));

    // CloudWatch — trace poller reads CW Logs Insights
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsInsights',
      actions: [
        'logs:StartQuery',
        'logs:GetQueryResults',
        'logs:StopQuery',
        'logs:DescribeLogGroups',
        'logs:FilterLogEvents',
      ],
      resources: ['*'],
    }));

    // CloudWatch Metrics for cost aggregation
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      actions: ['cloudwatch:PutMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics'],
      resources: ['*'],
    }));

    // Bedrock KB provisioning — allows middleware to create/delete KBs and data
    // sources on behalf of the portal wizard. The iam:PassRole grant lets
    // Bedrock assume the existing orgiq-kb-service-role when creating new KBs.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockKBProvisioning',
      actions: [
        'bedrock:CreateKnowledgeBase',
        'bedrock:DeleteKnowledgeBase',
        'bedrock:GetKnowledgeBase',
        'bedrock:ListKnowledgeBases',
        'bedrock:UpdateKnowledgeBase',
        'bedrock:CreateDataSource',
        'bedrock:DeleteDataSource',
        'bedrock:GetDataSource',
        'bedrock:UpdateDataSource',
        'bedrock:ListDataSources',
      ],
      resources: ['*'],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockKBPassRole',
      actions: ['iam:PassRole'],
      // Allow passing only the KB service role to Bedrock — not arbitrary roles.
      resources: [`arn:aws:iam::${this.account}:role/${props.prefix ?? 'orgiq'}-kb-service-role`],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' },
      },
    }));

    // Step Functions — canary state machine describe + send task token
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StepFunctions',
      actions: [
        'states:ListStateMachines',
        'states:DescribeStateMachine',
        'states:StartExecution',
        'states:DescribeExecution',
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
      ],
      resources: ['*'],
    }));

    // ── Task Execution Role (ECR pull + CloudWatch logs) ───────────────────
    const executionRole = new iam.Role(this, 'MiddlewareExecutionRole', {
      roleName: `${prefix}-middleware-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    repo.grantPull(executionRole);

    // ── Container environment variables ────────────────────────────────────
    // All values that are resolvable at synth time go here as plain strings.
    // Secrets (ARNs only known at runtime) are injected separately below.
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3001',
      AWS_REGION: this.region,
      AWS_ACCOUNT_ID: this.account,

      // Foundation tables
      SCORES_TABLE: props.scoresTableName,
      SESSIONS_TABLE: props.sessionsTableName,

      // Authorization
      POLICY_STORE_ID: props.policyStoreId,
      SESSION_SIGNING_SECRET_ARN: props.sessionSigningSecretArn,

      // Aurora (populated; mock flag controlled at deploy time)
      ...(props.auroraClusterArn && { AURORA_CLUSTER_ARN: props.auroraClusterArn }),
      ...(props.auroraCredentialsSecretArn && { AURORA_SECRET_ARN: props.auroraCredentialsSecretArn }),
      AURORA_DB_NAME: 'orgiq',

      // Mock kill-switches — all off in production; override via env override
      // in the ECS task if you want to scale a backing service to zero.
      MOCK_AURORA: 'false',
      MOCK_AGENTCORE: 'false',
      MOCK_GUARDRAILS: 'false',
      MOCK_CLOUDWATCH: 'false',

      // AgentCore identifiers
      ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      ...(props.knowledgeBaseId && { KNOWLEDGE_BASE_ID: props.knowledgeBaseId }),
      ...(props.gatewayId && { GATEWAY_ID: props.gatewayId }),
      ...(props.gatewayUrl && { GATEWAY_URL: props.gatewayUrl }),

      // Guardrails (per-role)
      ...(props.guardrailIdMember && { GUARDRAIL_ID_MEMBER: props.guardrailIdMember }),
      ...(props.guardrailIdOrgLeader && { GUARDRAIL_ID_ORG_LEADER: props.guardrailIdOrgLeader }),
      ...(props.guardrailIdHrAdmin && { GUARDRAIL_ID_HR_ADMIN: props.guardrailIdHrAdmin }),

      // Cognito SSO — ids/domain (the client secret is injected below as an ECS
      // secret). COGNITO_CALLBACK_URL is intentionally NOT set here: it must be
      // an HTTPS origin registered on the app client, which only exists once a
      // certificate + real domain are attached — set it (or PUBLIC_BASE_URL) as
      // an env override at that point. Until then the BFF stays inert (cognitoEnabled
      // is false without a callback URL) and the picker login remains.
      ...(props.cognitoUserPoolId && { COGNITO_USER_POOL_ID: props.cognitoUserPoolId }),
      ...(props.cognitoClientId && { COGNITO_CLIENT_ID: props.cognitoClientId }),
      ...(props.cognitoDomain && { COGNITO_DOMAIN: props.cognitoDomain }),

      // WebSocket gateway
      ...(props.websocketGatewayUrl && { WEBSOCKET_GATEWAY_URL: props.websocketGatewayUrl }),
    };

    // Cognito app-client secret injected as an ECS secret (pulled at task start
    // by the execution role, never rendered into the task-def env in plaintext).
    const containerSecrets: Record<string, ecs.Secret> = {
      // Machine-callback auth — see the ⚠️ comment above where these secrets
      // are minted. Env var names must match the exact strings the route
      // guards read: APPROVALS_REQUEST_SECRET (approvals.ts), HARNESS_TRACE_SECRET
      // (harness.ts), ASSESSMENT_RUN_COMPLETE_SECRET (assessment.ts).
      APPROVALS_REQUEST_SECRET: ecs.Secret.fromSecretsManager(approvalsRequestSecret),
      HARNESS_TRACE_SECRET: ecs.Secret.fromSecretsManager(harnessTraceSecret),
      ASSESSMENT_RUN_COMPLETE_SECRET: ecs.Secret.fromSecretsManager(assessmentRunCompleteSecret),
    };
    if (props.cognitoClientSecretArn) {
      const cognitoSecretRef = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'CognitoClientSecretRef', props.cognitoClientSecretArn,
      );
      containerSecrets['COGNITO_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(cognitoSecretRef);
    }

    // ── Fargate service via L2 pattern ─────────────────────────────────────
    // ApplicationLoadBalancedFargateService handles the ALB, target group,
    // listener, security groups, and service wiring in one construct.
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'MiddlewareFargateService',
      {
        cluster,
        serviceName: `${prefix}-middleware`,
        cpu: 512,
        memoryLimitMiB: 1024,

        // ARM64, to match the image.
        //
        // Fargate defaults to x86_64. The middleware image is built on the
        // developer's Apple Silicon machine and pushed as arm64, so the default
        // produced a task that started, failed with `exec format error` in the
        // entrypoint, and was replaced — over and over, with the stack sitting
        // in UPDATE_IN_PROGRESS and nothing in the ECS events naming an
        // architecture. Graviton is also the cheaper of the two, so matching
        // the build host is the right direction to reconcile in.
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },

        // The L2 pattern rejects 0 here ("You must specify a desiredCount
        // greater than 0"), so phase one drops it to zero through the escape
        // hatch below instead.
        desiredCount: 1,

        // ── Task definition ──────────────────────────────────────────────
        taskImageOptions: {
          image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
          containerName: 'middleware',
          containerPort: 3001,
          taskRole,
          executionRole,
          environment,
          ...(Object.keys(containerSecrets).length > 0 ? { secrets: containerSecrets } : {}),
          logDriver: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: 'middleware',
          }),
        },

        // ── ALB configuration ────────────────────────────────────────────
        // Public internet-facing; tasks live in private subnets.
        publicLoadBalancer: true,

        // Do not let the construct open the listener to 0.0.0.0/0.
        //
        // This account runs a Cloud Custodian policy
        // (`custodian-restrict-security-group-admin-ingress`) that revokes
        // open ingress. On the first deploy CloudFormation authorized
        // 0.0.0.0/0:80 at 14:20:22 and custodian revoked it at 14:20:28 — six
        // seconds later, with no stack event and no drift reported. The
        // result was the worst kind of healthy: task running, target group
        // healthy, and an ALB nothing on earth could connect to.
        //
        // Re-adding the open rule just loses the same race again, so ingress
        // is explicit instead. Pass the CIDRs that should reach it:
        //   --context albAllowCidr=203.0.113.4/32,198.51.100.0/24
        // With none given the load balancer stays closed, which is the honest
        // default in an account that will close it anyway.
        openListener: false,
        listenerPort: certArn ? 443 : 80,
        ...(certArn && {
          certificate: acm.Certificate.fromCertificateArn(this, 'AlbCertificate', certArn),
        }),
        protocol: certArn
          ? elbv2.ApplicationProtocol.HTTPS
          : elbv2.ApplicationProtocol.HTTP,
        targetProtocol: elbv2.ApplicationProtocol.HTTP,

        // Assign to public subnets for the ALB, private subnets for tasks.
        taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },

        // Keep this false so we can control the removal policy on the service.
        enableECSManagedTags: true,

        circuitBreaker: { enable: true, rollback: true },

        // Ensure 100% of tasks stay healthy during rolling updates when there
        // is only one task; CDK defaults to 50% which would briefly take the
        // service to zero running tasks on single-task services.
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      },
    );

    // Phase one: create the infrastructure without asking anything to run.
    //
    // The L2 construct will not accept desiredCount 0, but CloudFormation
    // will — so it is set on the underlying CfnService. Without this the
    // service tries to pull from a repository that is still empty on a first
    // deploy, the circuit breaker trips, the stack fails, and the failed-stack
    // cleanup deletes the repository along with any image pushed into it.
    // Phase two (--context deployMiddlewareService=true) scales it to one.
    if (!deployService) {
      const cfnService = fargateService.service.node.defaultChild as ecs.CfnService;
      cfnService.desiredCount = 0;
    }

    // ── Who may reach the load balancer ───────────────────────────────────
    // See `openListener: false` above for why this is not 0.0.0.0/0.
    const allowRaw = this.node.tryGetContext('albAllowCidr');
    const allowCidrs = typeof allowRaw === 'string'
      ? allowRaw.split(',').map((c) => c.trim()).filter(Boolean)
      : [];

    const listenerPortNumber = certArn ? 443 : 80;
    for (const cidr of allowCidrs) {
      fargateService.loadBalancer.connections.allowFrom(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(listenerPortNumber),
        `Allowed client ${cidr}`,
      );
    }

    if (allowCidrs.length === 0) {
      // Say it at synth time. A load balancer with no ingress is a support
      // question that looks like a broken deploy, and the stack is the only
      // thing that knows the difference.
      cdk.Annotations.of(this).addWarning(
        'No albAllowCidr given — the middleware load balancer will accept no traffic. '
        + 'Deploy with --context albAllowCidr=<your-ip>/32 to reach it.',
      );
    }

    new cdk.CfnOutput(this, 'MiddlewareAllowedCidrs', {
      value: allowCidrs.length ? allowCidrs.join(',') : '(none — load balancer is closed)',
      description: 'CIDRs permitted to reach the middleware load balancer',
    });

    // ── HTTP → HTTPS redirect (only when certificate is present) ──────────
    if (certArn) {
      fargateService.loadBalancer.addRedirect({
        sourcePort: 80,
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        targetPort: 443,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      });
    }

    // ── Health check ──────────────────────────────────────────────────────
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // ── Auto-scaling ──────────────────────────────────────────────────────
    // Start at 1 replica; scale up under CPU/memory pressure.
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    this.loadBalancerDnsName = fargateService.loadBalancer.loadBalancerDnsName;

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'MiddlewareEcrRepoUri', {
      value: repo.repositoryUri,
      description:
        'ECR URI for the middleware image — push with: docker push <uri>:latest',
      exportName: `${prefix}-middleware-ecr-uri`,
    });

    new cdk.CfnOutput(this, 'MiddlewareLoadBalancerDns', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name — create a CNAME record pointing your domain here',
      exportName: `${prefix}-middleware-alb-dns`,
    });

    new cdk.CfnOutput(this, 'MiddlewareServiceUrl', {
      value: certArn
        ? `https://${fargateService.loadBalancer.loadBalancerDnsName}`
        : `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
      description: 'Base URL for the middleware API',
      exportName: `${prefix}-middleware-url`,
    });

    new cdk.CfnOutput(this, 'MiddlewareClusterName', {
      value: cluster.clusterName,
      exportName: `${prefix}-middleware-cluster-name`,
    });

    new cdk.CfnOutput(this, 'MiddlewareServiceName', {
      value: fargateService.service.serviceName,
      exportName: `${prefix}-middleware-service-name`,
    });
  }
}
