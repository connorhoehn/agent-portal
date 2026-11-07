import { attachDocumentWorkspace, type DocumentWorkspaceConfig } from './document-workspace';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { realtimeAlarm, realtimeAlarmsEnabled, realtimeAlarmTopicName } from './realtime-alarms';
import { attachFleetAlarms, fleetAlarmsEnabled } from './fleet-alarms';
import { capabilityParameterNames } from './agentcore-capabilities-stack';
import { DEVBOX_TASK_TIMEOUT_S } from './devbox-stack';
import type { Construct } from 'constructs';
import { trustedService } from './service-trust';
import {
  realtimeJwtSecretArnParameterName, socialPlatformInternalUrl, socialRedisUrlParameterName, socialTablePrefix,
} from './social-stack';
import {
  CLOUDFRONT_RULE_PRIORITY, ORIGIN_VERIFY_HEADER, cloudFrontOriginSecretName, portalParameterNames,
} from './portal-stack';

export interface MiddlewareServiceStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Opt-in reusable document stack configuration, activated by deployDocumentWorkspace. */
  readonly documentWorkspace?: DocumentWorkspaceConfig;

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

  // ── S3 buckets ─────────────────────────────────────────────────────────────
  // ARNs are for the IAM grants; the NAMES are what the middleware actually
  // needs at run time (`config.foundation.documentsBucket` reads
  // DOCUMENTS_BUCKET). Only the ARNs used to be passed, so the task held S3
  // permissions on a bucket it could not name: /api/ingest/storage answered
  // `bucket: "", totalObjects: 0` on a bucket with the whole corpus in it.
  readonly documentsBucketArn: string;
  readonly artifactsBucketArn: string;
  readonly documentsBucketName: string;
  readonly artifactsBucketName: string;

  // ── Secrets / IDs populated by other stacks ───────────────────────────────
  /** Secrets Manager ARN for the HMAC session signing key (AuthorizationStack) */
  readonly sessionSigningSecretArn: string;
  /** AVP policy store ID (AuthorizationStack) */
  readonly policyStoreId: string;

  // ── Aurora (optional — middleware can run with MOCK_AURORA=true) ───────────
  readonly auroraClusterArn?: string;
  readonly auroraCredentialsSecretArn?: string;

  // ── WebSocket gateway URL ─────────────────────────────────────────────────
  /**
   * HTTP base URL for the websocket-gateway service. Defaults to empty (mock).
   *
   * The gateway is NOT an AWS component: it is a separate service deployed on
   * Kubernetes (Helm in-cluster, Tilt on :18080 locally) — see
   * docs/deploy-via-operator.md. Nothing here builds or hosts it; this stack
   * only tells the middleware where it lives. Pair it with
   * `gatewayServiceAuthSecretArn` or the gateway rejects every signed call.
   */
  readonly websocketGatewayUrl?: string;

  // ── AgentCore (optional — middleware can run with MOCK_AGENTCORE=true) ─────
  readonly memoryId?: string;
  /** SSM name of the orgiq memory id (DE-8); used instead of `memoryId` when set. */
  readonly memoryIdParameter?: string;
  /** tenant -> SSM name of that tenant's memory id; surfaces as MEMORY_ID_<TENANT> and is granted like MEMORY_ID. */
  readonly tenantMemoryIdParameters?: Record<string, string>;
  readonly browserId?: string;
  readonly browserArn?: string;
  /**
   * Read CODE_INTERPRETER_ID / BROWSER_PROFILE_ID from OrgIQ-AgentCoreCapabilities'
   * SSM parameters (capabilityParameterNames) and grant the code-interpreter
   * session calls. bin/app.ts sets it; the single-stack test fixtures do not.
   */
  readonly capabilityParameters?: boolean;
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
  /**
   * ARN of an EXISTING Secrets Manager secret holding the shared HMAC secret
   * the middleware signs gateway requests with (`GATEWAY_SERVICE_AUTH_SECRET`).
   *
   * Imported, never generated. The value has to equal the `orgiq-middleware`
   * entry in the gateway's own `SERVICE_AUTH_ALLOWED_SERVICES` config, so a
   * freshly-generated secret would be guaranteed WRONG — every signed request
   * would fail the gateway's envelope check. The operator creates the secret
   * with the agreed value (the same one the k8s `orgiq-service-auth` secret
   * carries) and passes its ARN here.
   */
  readonly gatewayServiceAuthSecretArn?: string;
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
   * ARNs of the four machine-identity auth secrets minted by this stack.
   * Exposed for completeness (e.g. an operator script resolving by stack
   * output); the first three are NOT consumable by AgentCoreRuntimeStack at
   * synth time — see the ⚠️ comment above where these secrets are created.
   */
  public readonly approvalsRequestSecretArn!: string;
  public readonly harnessTraceSecretArn!: string;
  public readonly assessmentRunCompleteSecretArn!: string;
  /**
   * The harness runner's credential. Unlike the three above this has no
   * agent-runtime half — see the ⚠️ note beside `HarnessRunnerSecret`.
   */
  public readonly harnessRunnerSecretArn!: string;
  /**
   * The devbox lab loop's credential. Its client is `agents/devbox/lab`, a
   * script already in the devbox image that sends the header only when it has
   * the value — so this and `DevboxStack`'s `labCallbackSecret` must be set
   * together, or the loop authenticates against a guard that has just closed.
   */
  public readonly labCallbackSecretArn!: string;

  // ── Handles the social stacks attach to ────────────────────────────────────
  // OrgIQ-Social and OrgIQ-SocialMedia run in this VPC, on this cluster,
  // behind this listener. Passing them as props makes CDK mint hash-named
  // exports that freeze while imported (the KnowledgeBase gotcha) — accepted
  // in docs/social-calls-deploy-plan.md because none of these ever change
  // identity. The consequence: this stack cannot be torn down while the social
  // stacks exist.
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly listener: elbv2.ApplicationListener;
  /** The ALB's security group — the social stacks add their own rules to it. */
  public readonly loadBalancerSecurityGroupId: string;
  /** The middleware task's security group (Redis and platform-api admit it). */
  public readonly serviceSecurityGroupId: string;
  public readonly taskRoleArn: string;
  /** Fixed task role name — OrgIQ-Social attaches its chat-table policy by name. */
  public readonly taskRoleName: string;
  /**
   * Fixed name of the realtime token secret. Consumers import it by its full
   * ARN, read from the SSM parameter `realtimeJwtSecretArnParameterName`
   * (social-stack.ts), never by name: the name ends in `-secret`, which a
   * partial-ARN lookup misreads as the random suffix.
   */
  public readonly realtimeJwtSecretName: string;

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
      assumedBy: trustedService(this, 'ecs-tasks.amazonaws.com'),
      description: `Runtime role for ${prefix}-middleware Fargate task`,
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
    // requireRunCompleteAuth). Each guard requires its secret in production
    // (503 if missing) and checks the caller's header in constant time.
    // Development alone retains the open-when-unset path for offline fixtures.
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

    // Secrets Manager — the devbox lab loop's machine identity
    // (LAB_CALLBACK_SECRET / x-lab-auth, lib/service-auth.ts).
    //
    // WHY IT WAS MISSING. `service-auth.ts` has always declared this spec and
    // `routes/lab.ts` has always guarded on it, but nothing minted it — so of
    // the five specs the module defines, this was the one whose guard could
    // never close in a deployed environment under the previous guard behavior.
    // Missing secrets now fail closed in production as an additional safeguard;
    // the minted secret here is still required for the lab callbacks to work.
    //
    // SAFE TO MINT, unlike the three agent-callback secrets above. Their agent
    // halves had to ship first because a pre-`callbacks.py` image sends no
    // header whatever env it is handed. The lab client is `agents/devbox/lab`,
    // a shell script already in the image, and it has always sent the header
    // conditionally:
    //     [ -n "${LAB_CALLBACK_SECRET:-}" ] && auth=(-H "x-lab-auth: ...")
    // Unset it sends byte-for-byte the old request; set it sends the header. So
    // the two halves are independent here too — but the ORDER still matters,
    // for a different reason: the devbox runtime must receive this value (and
    // LAB_API_BASE) or the lab loop starts failing auth the moment this stack
    // deploys. See DevboxStack's labApiBase/labCallbackSecret props, and note
    // the loop is inert until LAB_API_BASE is set at all.
    const labCallbackSecret = new secretsmanager.Secret(this, 'LabCallbackSecret', {
      secretName: `${prefix}-lab-callback-secret`,
      description: 'Shared secret for x-lab-auth on the devbox lab loop — POST /api/lab/consults, GET /api/lab/consults/:id, GET /api/lab/experiences (requireServiceAuth)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    labCallbackSecret.grantRead(taskRole);

    // Secrets Manager — the harness runner's own machine identity
    // (HARNESS_RUNNER_SECRET / x-harness-runner-auth, lib/service-auth.ts).
    //
    // WHY A FOURTH. infra/scripts/harness.py drives the whole evaluation loop
    // over HTTP — register a prompt version, create a run, post a trace, record
    // each result, patch the run's counters, promote a blessed SHA — and every
    // one of those calls except POST /harness/trace is session-gated (tenant +
    // Cedar). The runner has no session. It worked locally only because
    // `demoFallbackAllowed()` hands a cookie-less request the demo identity,
    // which is off the moment Cognito is configured — so the runner "worked on
    // a laptop and 401'd wholesale in the environment it was built for", and
    // did so MIDWAY THROUGH A RUN: the trace POST carried its own secret and
    // succeeded, while the result POST that records the verdict did not.
    //
    // ⚠️ DIFFERENT FROM THE THREE ABOVE, in the way that matters for deploying
    // it. Those three gate SESSIONLESS AGENT CALLBACKS, so wiring them here
    // flips a guard that deployed agent runtimes must then satisfy — and
    // nothing in agents/ sends any of the headers yet, which is why they carry
    // a blackout window and a hand-copied `--context` value on the runtime
    // side. This one has NO agent-runtime half: nothing in agents/ reads
    // HARNESS_RUNNER_SECRET, no CfnRuntime needs it, and there is no image to
    // roll. Its only client is a script an operator runs, which reads the value
    // from Secrets Manager itself. So minting it costs no coordination — and
    // note the guard is `serviceAuthOr`, not `requireServiceAuth`: a request
    // without the header falls through to the Cedar gate exactly as before, so
    // the portal (and a human with a session) is unaffected either way.
    const harnessRunnerSecret = new secretsmanager.Secret(this, 'HarnessRunnerSecret', {
      secretName: `${prefix}-harness-runner-secret`,
      description: 'Shared secret for x-harness-runner-auth on the harness runner\'s control plane — POST /api/observability/prompt-versions, POST/PATCH /api/observability/harness/runs[/:id][/results], POST /api/observability/harness/promote (serviceAuthOr)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    harnessRunnerSecret.grantRead(taskRole);

    this.approvalsRequestSecretArn = approvalsRequestSecret.secretArn;
    this.harnessTraceSecretArn = harnessTraceSecret.secretArn;
    this.assessmentRunCompleteSecretArn = assessmentRunCompleteSecret.secretArn;
    this.harnessRunnerSecretArn = harnessRunnerSecret.secretArn;
    this.labCallbackSecretArn = labCallbackSecret.secretArn;

    // Secrets Manager — the realtime token secret (REALTIME_JWT_SECRET,
    // middleware/src/lib/realtime-token.ts). The token bridge
    // (GET /api/session/realtime-token) signs HS256 tokens with it, and the
    // middleware's own realtime gateway (REALTIME_GATEWAY=on) and platform-api
    // in OrgIQ-Social verify with it.
    //
    // UNLIKE the machine-callback secrets above, minting this closes nothing:
    // unset in production the bridge 503s, set it issues tokens — so deploying
    // it has no blackout window. Both consumers are ECS tasks, so both take it
    // as an ECS container secret; nobody copies the value by hand. The fixed
    // name is load-bearing; OrgIQ-Social reads its complete ARN from the SSM
    // parameter below, by name, so no CloudFormation export freezes on it.
    // See docs/social-calls-deploy-plan.md §1.
    const realtimeJwtSecretName = `${prefix}-realtime-jwt-secret`;
    const realtimeJwtSecret = new secretsmanager.Secret(this, 'RealtimeJwtSecret', {
      secretName: realtimeJwtSecretName,
      description: 'HS256 signing secret for the realtime token bridge (REALTIME_JWT_SECRET); verified by the middleware gateway and platform-api',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });
    realtimeJwtSecret.grantRead(taskRole);
    this.realtimeJwtSecretName = realtimeJwtSecretName;
    new ssm.StringParameter(this, 'RealtimeJwtSecretArnParameter', {
      parameterName: realtimeJwtSecretArnParameterName(prefix),
      stringValue: realtimeJwtSecret.secretArn,
      description: 'Complete ARN of the realtime token secret; the Social stack reads it by name',
    });
    new cdk.CfnOutput(this, 'RealtimeJwtSecretName', {
      value: realtimeJwtSecretName,
      description: 'Realtime token secret — consumers import it by this name, not by an export',
    });

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
    // This one an operator genuinely does look up by hand on every harness
    // run: `aws secretsmanager get-secret-value --secret-id
    // orgiq-harness-runner-secret` → `HARNESS_RUNNER_SECRET=… python
    // infra/scripts/harness.py …`.
    new cdk.CfnOutput(this, 'HarnessRunnerSecretArnOutput', {
      value: harnessRunnerSecret.secretArn,
      exportName: `${prefix}-harness-runner-secret-arn`,
    });

    // The operator copies this value onto the devbox runtime by hand, the same
    // way the three agent-callback secrets are copied onto the agent runtimes —
    // AgentCore's EnvironmentVariables is a bare string map with no
    // Secrets-Manager reference, and DevboxStack is instantiated before this
    // stack in app.ts with no dependency edge.
    new cdk.CfnOutput(this, 'LabCallbackSecretArnOutput', {
      value: labCallbackSecret.secretArn,
      exportName: `${prefix}-lab-callback-secret-arn`,
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
    // Invoke and describe only this fleet's runtimes (`<prefix>_<agent>` and
    // the devbox); a runtime's description carries its environment. Listing
    // and workload tokens have no narrower resource.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreInvoke',
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:GetAgentRuntime',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${prefix}_*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${prefix}_*/runtime-endpoint/*`,
      ],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreList',
      actions: [
        'bedrock-agentcore:ListAgentRuntimes',
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetWorkloadAccessTokenForJwt',
      ],
      resources: ['*'],
    }));

    // AgentCore Memory — the chat path's turn history. routes/agents.ts calls
    // recordTurn/listEvents (providers/memory.ts: CreateEvent, ListEvents,
    // ListSessions) on every invoke, and nothing granted them: MEMORY_ID was
    // set while the role could not touch the memory it named, so a deployed
    // chat answered but kept no history and every session list came back
    // empty. Scoped to the one memory this stack is given.
    const memoryId = props.memoryIdParameter
      ? ssm.StringParameter.valueForStringParameter(this, props.memoryIdParameter)
      : props.memoryId;
    const tenantMemoryIds: Record<string, string> = {};
    for (const [tenant, name] of Object.entries(props.tenantMemoryIdParameters ?? {})) {
      tenantMemoryIds[tenant] = ssm.StringParameter.valueForStringParameter(this, name);
    }
    const memoryResourceIds = [...new Set([...(memoryId ? [memoryId] : []), ...Object.values(tenantMemoryIds)])];
    if (memoryResourceIds.length > 0) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AgentCoreMemoryEvents',
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListSessions',
        ],
        resources: memoryResourceIds.map(m => `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${m}`),
      }));
    }

    // Code Interpreter sessions — providers/agentcore.ts (Start/Invoke/Stop/
    // ListCodeInterpreterSessions) behind the portal's code-interpreter
    // surfaces. CODE_INTERPRETER_ID was never set on the task and nothing
    // granted these, so the feature read "not configured" in every deployment.
    // Scoped to the one code interpreter OrgIQ-AgentCoreCapabilities owns, by
    // its NAME (`<prefix>_code_interpreter-<suffix>`) rather than an imported
    // ARN, so this stack takes no new export (and freezes none).
    if (props.capabilityParameters) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'CodeInterpreterSessions',
        actions: [
          'bedrock-agentcore:StartCodeInterpreterSession',
          'bedrock-agentcore:InvokeCodeInterpreter',
          'bedrock-agentcore:StopCodeInterpreterSession',
          'bedrock-agentcore:GetCodeInterpreterSession',
          'bedrock-agentcore:ListCodeInterpreterSessions',
        ],
        resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:code-interpreter-custom/${prefix.replace(/-/g, '_')}_code_interpreter-*`],
      }));
    }

    // The capability reconcile page and the boot-time stale-id check
    // (providers/capability-reconcile.ts) list what exists so a dead id is
    // named. Read-only listings, which take no resource ARN.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CapabilityInventory',
      actions: [
        'bedrock-agentcore:ListBrowsers',
        'bedrock-agentcore:ListBrowserProfiles',
        'bedrock-agentcore:ListCodeInterpreters',
        'bedrock-agentcore:ListMemories',
      ],
      resources: ['*'],
    }));

    // The prompt canary's control parameters — lib/weight-cache.ts
    // (/orgiq/canary/weight_b, control, subject_{a,b}_arn) and
    // lib/judge-config.ts (/orgiq/canary/judge_config, edited from
    // /iq/evaluations). Read AND write: the evaluations page saves the judge
    // config and the canary page sets the weight. That path only — no other
    // parameter, and nothing under /orgiq/social or /orgiq/portal.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CanaryParameters',
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${prefix}/canary/*`],
    }));

    // DE-4 prompt pointers (lib/prompt-pointers.ts): the BFF reads and writes
    // /orgiq/prompts/<agent>/{live,candidate} for candidate / promote /
    // rollback. Bedrock prompt versions are read to gate a candidate.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PromptPointerParameters',
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${prefix}/prompts/*`],
    }));

    // The model price table (lib/model-prices.ts, DE-32): read-only, so a
    // compromised task cannot rewrite the rates the ledger estimates from.
    // The parameter itself is created by hand or by a script, never by CDK, so
    // a redeploy cannot overwrite what the operator supplied.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PricingParameters',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${prefix}/pricing/*`],
    }));

    // The canary's score stream (lib/emf-emitter.ts writes EMF lines to
    // /orgiq/canary/scores, which PromptCanary owns).
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CanaryScoreLog',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/${prefix}/canary/scores:*`],
    }));

    // Observability reads: CloudWatch GetMetricData (providers/agentcore.ts
    // invocation metrics) and X-Ray traces (providers/cloudwatch.ts). Neither
    // API takes a resource ARN; both are read-only.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ObservabilityReads',
      actions: ['cloudwatch:GetMetricData', 'xray:GetTraceSummaries', 'xray:BatchGetTraces'],
      resources: ['*'],
    }));

    // Crawl/survey verify PUBLIC network mode before opening a browser session.
    // No update/create permissions: a request cannot turn this resource into a
    // VPC-connected browser. Session operations use this one configured ARN.
    if (props.browserArn) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'PublicBrowserCrawl',
        actions: [
          'bedrock-agentcore:GetBrowser',
          'bedrock-agentcore:StartBrowserSession',
          'bedrock-agentcore:GetBrowserSession',
          'bedrock-agentcore:StopBrowserSession',
          'bedrock-agentcore:InvokeBrowser',
        ],
        resources: [props.browserArn],
      }));
      // ListBrowserSessions has no resource-level grant in the IAM reference.
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'BrowserSessionInventory',
        actions: ['bedrock-agentcore:ListBrowserSessions'],
        resources: ['*'],
      }));
    }

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
    //
    // The three Ingestion* actions are the reason this statement is worth
    // reading twice. Without them the KB surface does not fail — it reports
    // EMPTY, which is far worse. `ListDataSources` is granted, so the data
    // source is found; `ListIngestionJobs` was not, so every caller that asks
    // "when did this last sync, and what did it cover" got AccessDenied and
    // fell into a catch. Measured against a knowledge base holding 157 indexed
    // documents with two COMPLETE jobs: /api/ingest/jobs returned `[]`,
    // /api/ingest/storage returned `kb.totalDocuments: 0`, the reconcile page's
    // last-sync column read "—", and its stuck-pipeline banner claimed the
    // documents "have never been indexed" — then offered a Sync button that
    // needed StartIngestionJob and would have been denied too. Nothing in the
    // stack status, the service health check or the page said a permission was
    // missing. Keep all three: List for the history, Get for the live SSE job
    // monitor (routes/ingest.ts), Start for every sync path.
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
        'bedrock:StartIngestionJob',
        'bedrock:GetIngestionJob',
        'bedrock:ListIngestionJobs',
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

    // ── Realtime gateway (opt-in) ──────────────────────────────────────────
    // `--context realtimeGateway=true` turns the middleware into its own
    // websocket gateway (REALTIME_GATEWAY=on). Opt-in, not default, because
    // the state it wants lives in OrgIQ-Social, which deploys AFTER this
    // stack. With `deploySocial=true` also in context (the plan says every
    // middleware deploy from then on carries the social flags):
    //   - REDIS_URL comes from the SSM parameter OrgIQ-Social writes (its
    //     ElastiCache endpoint), as a container secret, so no export freezes;
    //   - SOCIAL_CHAT_STORE=dynamo + SOCIAL_CHAT_TABLE_PREFIX point social
    //     chat at OrgIQ-Social's chat tables (it grants this role on them).
    // `--context realtimeRedisUrl=redis://…` overrides the Redis as plain env.
    // Without deploySocial and without an override, no REDIS_URL: call state
    // and the notification inbox stay in memory (single task) and synth warns.
    const ctxStr = (k: string) => this.node.tryGetContext(k) as string | undefined;
    const ctxOn = (k: string) => { const v = this.node.tryGetContext(k); return v === true || v === 'true'; };
    const realtimeEnabled = ctxOn('realtimeGateway');
    const socialDeployed = ctxOn('deploySocial');
    // ── Producer-live flags: read another stack's parameter only once it exists
    // `deploySocial` / `deploySocialMedia` put the Social stacks in the app, and
    // OrgIQ-SocialMedia / OrgIQ-Social import this stack's VPC and listener, so
    // the middleware must carry the social flags BEFORE those stacks exist (or
    // the exports they import are missing). But three of the values below are
    // SSM parameters other stacks write, resolved by CloudFormation at deploy
    // time: a deploy that names one before its producer ran fails with
    // "Unable to fetch parameters [...] from parameter store" (the 2026-11
    // rebuild of 647757222309 after aws-nuke). So each is read only when its
    // producer is live, which deploy.sh infers from the account:
    //   socialLive=true                OrgIQ-Social is live and has written
    //                                  /<prefix>/social/redis-url
    //   portalPlatformApiUrlLive=true  OrgIQ-Portal wrote /<prefix>/portal/platform-api-url
    //   portalVideoUrlLive=true        OrgIQ-Portal wrote /<prefix>/portal/video-url
    // On the live lab account all three are inferred, so its template is the
    // one it always was; on a fresh account they stay off until the producer
    // has deployed.
    const socialLive = socialDeployed && ctxOn('socialLive');

    // ── More than one task needs a Redis (DE-47) ───────────────────────────
    // Devbox claims, reservations, the activity clock, cross-replica tails and
    // the reaper's leader lock (lib/replica-fleet.ts withLock) all live in
    // Redis. Without one every task believes it is alone: each reaps from its
    // own stale copy of the fleet (stopping a box another task is running a
    // task on) and each dispatcher pushes jobs onto boxes the others are
    // using. So autoscaling defaults on only when a Redis source exists
    // (`realtimeRedisUrl`, or OrgIQ-Social's ElastiCache via `deploySocial`
    // once OrgIQ-Social is live — `socialLive`, never earlier: the default must
    // not read /<prefix>/social/redis-url before OrgIQ-Social has written it),
    // and asking for it without one is refused, like the gateway safeguard.
    const fleetRedisSource = ctxStr('realtimeRedisUrl') ? 'override' : socialLive ? 'social' : null;
    const autoscaleRaw = this.node.tryGetContext('middlewareAutoscale');
    const autoscale = autoscaleRaw === undefined || autoscaleRaw === null || autoscaleRaw === ''
      ? !realtimeEnabled && fleetRedisSource !== null
      : (autoscaleRaw === true || autoscaleRaw === 'true');
    if (realtimeEnabled && autoscale) {
      throw new Error('middlewareAutoscale=true with realtimeGateway=true violates the one-task realtime gateway safeguard. '
        + 'Native Redis peer routing does not establish full application/service-state scale-out readiness.');
    }
    if (autoscale && !fleetRedisSource) {
      throw new Error('middlewareAutoscale=true needs a Redis for shared fleet state and the reaper\'s leader lock (DE-47): '
        + 'pass deploySocial=true with socialLive=true once OrgIQ-Social is live (its ElastiCache; deploy.sh infers socialLive) '
        + 'or realtimeRedisUrl=redis://…, or middlewareAutoscale=false.');
    }
    const platformHost = ctxStr('socialPlatformHost');
    const sfuHost = ctxStr('socialSfuHost');
    const realtime = {
      enabled: realtimeEnabled,
      redisUrlOverride: ctxStr('realtimeRedisUrl'),
      redisFromSocial: (realtimeEnabled || autoscale) && socialLive && !ctxStr('realtimeRedisUrl'),
      socialChat: realtimeEnabled && socialDeployed,
      gatewayUrl: ctxStr('realtimeGatewayUrl'),
      // Browser-facing URLs: explicit context wins; otherwise derived from
      // the host rules OrgIQ-Social puts on this listener (same context keys
      // it reads), only once the gateway is on so the default synth is unchanged.
      platformPublicUrl: ctxStr('realtimePlatformPublicUrl')
        ?? (realtimeEnabled && platformHost ? `https://${platformHost}` : undefined),
      videoPublicUrl: ctxStr('realtimeVideoPublicUrl') ?? (realtimeEnabled
        ? (ctxStr('videoPublicUrl') ?? (sfuHost ? `https://${sfuHost}` : undefined))
        : undefined),
    };

    // ── CloudFront in front (opt-in, OrgIQ-Portal) ─────────────────────────
    // `--context deployPortal=true` puts CloudFront between browsers and this
    // ALB (lib/portal-stack.ts). Two hops now forward for the client
    // (TRUST_PROXY_HOPS=2, lib/trusted-proxy.ts), and the ALB admits
    // CloudFront and checks its secret header — see the listener lock below.
    //
    // `--context portalPublicUrls=true` (a LATER deploy, once OrgIQ-Portal has
    // written its SSM parameters) points the middleware at its public HTTPS
    // origin: PUBLIC_BASE_URL/PORTAL_ORIGIN (browser-origin allowlist),
    // COGNITO_CALLBACK_URL/COGNITO_LOGOUT_URL (SSO turns on) and the token
    // bridge's REALTIME_* URLs. Container secrets from SSM, by name: no export,
    // no hand-copied CloudFront domain. Separate from deployPortal because a
    // task started before the parameters exist fails ResourceInitializationError.
    const viaCloudFront = ctxOn('deployPortal');
    const portalUrls = ctxOn('portalPublicUrls');
    const portalParams = portalParameterNames(prefix);
    const portalSecret = (name: string, id: string) => ecs.Secret.fromSsmParameter(
      ssm.StringParameter.fromStringParameterName(this, id, name),
    );

    // ── Devbox lifetime and git (DE-48, DE-45) ─────────────────────────────
    // The deploy-wide values of the `default` devbox profile, stated so the
    // deployed numbers are visible in CFN. They equal
    // middleware/src/lib/devbox-lifetime.ts DEFAULT_LIFETIME (idle 20 min,
    // ceiling 4 h, task 840 s / 3300 s, grace 5 min) and the runtime's
    // DEVBOX_TASK_TIMEOUT_S (devbox-stack.ts); the BFF validates them and
    // falls back to those defaults if a value is unsound.
    const devboxLifetime: Record<string, string> = {
      DEVBOX_IDLE_TIMEOUT_MINUTES: '20',
      DEVBOX_MAX_LIFETIME_MINUTES: '240',
      DEVBOX_TASK_TIMEOUT_S: String(DEVBOX_TASK_TIMEOUT_S),
      DEVBOX_TASK_MAX_S: '3300',
      DEVBOX_REAP_GRACE_MINUTES: '5',
    };
    // Credentialed git through the devbox image's entrypoint (lib/devbox-git.ts).
    // Off until the rebuilt image is deployed: `--context devboxGitEntrypoint=true`.
    const devboxGitEntrypoint = ctxOn('devboxGitEntrypoint');
    // Per-run GitHub App tokens (lib/repo-token-provider.ts). The secret
    // `${prefix}/github-app` ({appId, privateKey}) is created by hand
    // (docs/github-app-tokens-runbook.md) and does not exist yet, so it is
    // wired only when `--context githubAppSecretArn=<its complete ARN>` is
    // given; without it the BFF keeps the connection-PAT provider. A complete
    // ARN, never a name: a partial-ARN lookup misreads `-app`-style suffixes
    // (the DE-28 bug class).
    const githubAppSecretArn = this.node.tryGetContext('githubAppSecretArn') as string | undefined;
    const githubAppSecret = githubAppSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'GitHubAppSecret', githubAppSecretArn)
      : null;

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

      // Foundation buckets. The task role is granted S3 on both above; without
      // these two it could not name the bucket it had access to, so every
      // storage read answered an empty bucket instead of an error.
      DOCUMENTS_BUCKET: props.documentsBucketName,
      ARTIFACTS_BUCKET: props.artifactsBucketName,

      // Passed to Bedrock as iam:PassRole when the portal wizard creates a new
      // knowledge base. The PassRole grant for this exact role already exists
      // (BedrockKBProvisioning above); with the env unset, provisioning failed
      // at step 4 with "KB_SERVICE_ROLE_ARN not configured" — a grant with no
      // way to use it.
      KB_SERVICE_ROLE_ARN: `arn:aws:iam::${this.account}:role/${prefix}-kb-service-role`,

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
      // One enforced hop (the ALB), or two with CloudFront in front of it.
      TRUST_PROXY_HOPS: viaCloudFront ? '2' : '1',
      MOCK_GUARDRAILS: 'false',
      MOCK_CLOUDWATCH: 'false',

      // The Claude price table the ledger estimates from (DE-32).
      MODEL_PRICES_PARAM: `/${prefix}/pricing/model_prices`,

      // Money fails closed (docs/next-steps.md §8 work item 16). Spend charged
      // to no initiative is refused rather than judged by nothing, and an
      // unreadable budget or hold store refuses (503) instead of proceeding
      // unbraked. Both used to fall back to code defaults (allow, and the
      // NODE_ENV check), so a task with NODE_ENV dropped would spend unbraked.
      // 'actor': a hold goes to the initiative when known, else to the actor's user budget, and is
      // refused only when neither exists. 'refuse' is the end state (docs/spend-map.md) once every
      // chat question and /summarize carries an initiative scope.
      SPEND_HOLDS_UNATTRIBUTED: 'actor',
      BUDGET_FAIL_CLOSED: 'true',

      // The agent and devbox callbacks sign service-runtime's request envelope
      // (agents/_shared/callbacks.py, agents/devbox/lab); the static
      // x-*-auth headers are bearer tokens that replay forever, so the
      // middleware stops accepting them (lib/service-auth.ts, lane C4).
      SERVICE_AUTH_LEGACY_HEADERS: 'refuse',

      // Devbox lifetime (DE-48) and the git entrypoint switch (DE-45); see above.
      ...devboxLifetime,
      DEVBOX_GIT_ENTRYPOINT: devboxGitEntrypoint ? 'on' : 'off',

      // AgentCore identifiers
      ...(memoryId && { MEMORY_ID: memoryId }),
      ...Object.fromEntries(Object.entries(tenantMemoryIds)
        .map(([tenant, id]) => [`MEMORY_ID_${tenant.toUpperCase()}`, id])),
      ...(props.browserId && { BROWSER_ID: props.browserId }),
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

      // The middleware as its own realtime gateway (docs/social-calls-plan.md
      // step 7) — see `realtime` above for why it is opt-in.
      ...(realtime.enabled && { REALTIME_GATEWAY: 'on' }),
      ...((realtime.enabled || autoscale) && realtime.redisUrlOverride && { REDIS_URL: realtime.redisUrlOverride }),
      // Social chat on OrgIQ-Social's DynamoDB tables (middleware/src/lib/
      // social-chat.ts reads exactly these two names).
      ...(realtime.socialChat && {
        SOCIAL_CHAT_STORE: 'dynamo',
        SOCIAL_CHAT_TABLE_PREFIX: socialTablePrefix(prefix, ctxStr('tableSuffix')),
      }),
      // Social and Assessment documents use separate platform deployments and
      // table namespaces. Never let Social's proxy fall back to the document
      // platform when both stacks are installed. This REST endpoint is needed
      // even when realtimeGateway is disabled and is independent of browser URLs.
      ...(socialDeployed && { SOCIAL_PLATFORM_INTERNAL_URL: socialPlatformInternalUrl(prefix) }),
      // Browser-facing endpoints echoed by the token bridge. Deliberately not
      // PLATFORM_API_URL: that one is the SERVER-side work-graph URL
      // (work-graph/producer.ts), and in AWS the two are different hosts.
      ...(realtime.gatewayUrl && { REALTIME_GATEWAY_URL: realtime.gatewayUrl }),
      ...(realtime.platformPublicUrl && { REALTIME_PLATFORM_PUBLIC_URL: realtime.platformPublicUrl }),
      ...(realtime.videoPublicUrl && { REALTIME_VIDEO_PUBLIC_URL: realtime.videoPublicUrl }),
    };
    // The portal's public URLs, from OrgIQ-Portal's parameters. Explicit
    // context (above) wins over the parameter for each REALTIME_* URL, and an
    // env var is never ALSO a secret (ECS rejects the duplicate).
    const portalSecrets: Record<string, ecs.Secret> = {};
    if (portalUrls) {
      const site = portalSecret(portalParams.url, 'PortalUrlParameter');
      portalSecrets['PUBLIC_BASE_URL'] = site;
      portalSecrets['PORTAL_ORIGIN'] = site;
      portalSecrets['COGNITO_CALLBACK_URL'] = portalSecret(portalParams.cognitoCallbackUrl, 'PortalCognitoCallbackParameter');
      portalSecrets['COGNITO_LOGOUT_URL'] = portalSecret(portalParams.cognitoLogoutUrl, 'PortalCognitoLogoutParameter');
      if (realtime.enabled && !realtime.gatewayUrl) {
        portalSecrets['REALTIME_GATEWAY_URL'] = portalSecret(portalParams.gatewayUrl, 'PortalGatewayUrlParameter');
      }
      // Only the distributions OrgIQ-Portal actually made (it reads the same
      // flags), and only once it has written their parameters (see socialLive).
      if (socialDeployed && ctxOn('portalPlatformApiUrlLive') && !ctxStr('realtimePlatformPublicUrl')) {
        delete environment['REALTIME_PLATFORM_PUBLIC_URL'];
        portalSecrets['REALTIME_PLATFORM_PUBLIC_URL'] = portalSecret(portalParams.platformApiUrl, 'PortalPlatformApiUrlParameter');
      }
      if (ctxOn('deploySocialMedia') && ctxOn('portalVideoUrlLive') && !ctxStr('realtimeVideoPublicUrl')) {
        delete environment['REALTIME_VIDEO_PUBLIC_URL'];
        portalSecrets['REALTIME_VIDEO_PUBLIC_URL'] = portalSecret(portalParams.videoUrl, 'PortalVideoUrlParameter');
      }
      if (!viaCloudFront) {
        cdk.Annotations.of(this).addWarning('portalPublicUrls=true without deployPortal=true — the /'
          + `${prefix}/portal/* parameters come from OrgIQ-Portal; without CloudFront in front, the ALB still `
          + 'admits only albAllowCidr and TRUST_PROXY_HOPS stays 1.');
      }
    }

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
      // The runner's credential. No blackout window: `serviceAuthOr` accepts a
      // valid header and otherwise runs the Cedar gate unchanged, so setting
      // this only ADDS a way in — see the ⚠️ beside HarnessRunnerSecret.
      HARNESS_RUNNER_SECRET: ecs.Secret.fromSecretsManager(harnessRunnerSecret),
      // Closes the fifth service-auth guard. The devbox `lab` script sends
      // x-lab-auth only when it has the value, so the devbox runtime needs it
      // too — DevboxStack takes it as `labCallbackSecret`.
      LAB_CALLBACK_SECRET: ecs.Secret.fromSecretsManager(labCallbackSecret),
      // The realtime token secret — no blackout window, see RealtimeJwtSecret.
      REALTIME_JWT_SECRET: ecs.Secret.fromSecretsManager(realtimeJwtSecret),
      ...portalSecrets,
      // The GitHub App's id and key (DE-45), only when the secret is wired.
      ...(githubAppSecret ? {
        GITHUB_APP_ID: ecs.Secret.fromSecretsManager(githubAppSecret, 'appId'),
        GITHUB_APP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(githubAppSecret, 'privateKey'),
      } : {}),
    };
    if (props.capabilityParameters) {
      // From OrgIQ-AgentCoreCapabilities' parameters, by name (see
      // capabilityParameterNames): no import, and a rebuilt capability's new
      // id reaches the next task start.
      const caps = capabilityParameterNames(prefix);
      containerSecrets['CODE_INTERPRETER_ID'] = ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'CodeInterpreterIdParameter', caps.codeInterpreterId));
      containerSecrets['BROWSER_PROFILE_ID'] = ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'BrowserProfileIdParameter', caps.browserProfileId));
    }
    if (realtime.redisFromSocial) {
      // Written by OrgIQ-Social; read only with socialLive (above), so the
      // parameter exists before CloudFormation resolves it and before a task
      // starts (a task started without it fails ResourceInitializationError).
      containerSecrets['REDIS_URL'] = ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SocialRedisUrlParameter', socialRedisUrlParameterName(prefix)),
      );
    }
    if (realtime.enabled) {
      const warn = (m: string) => cdk.Annotations.of(this).addWarning(m);
      if (socialDeployed && !socialLive && !realtime.redisUrlOverride) {
        warn('realtimeGateway=true with deploySocial=true but without socialLive=true — OrgIQ-Social is not live yet, so '
          + 'REDIS_URL is not wired: call state is in memory until a middleware deploy after OrgIQ-Social (deploy.sh infers socialLive).');
      } else if (!realtime.redisUrlOverride && !realtime.redisFromSocial) {
        warn('realtimeGateway=true without deploySocial=true or realtimeRedisUrl — no REDIS_URL: call state and '
          + 'the notification inbox are in memory and lost on every task replacement.');
      }
      if (!realtime.socialChat) {
        warn('realtimeGateway=true without deploySocial=true — social chat uses the in-memory store (SOCIAL_CHAT_STORE unset).');
      }
      if (!realtime.gatewayUrl && certArn && !portalUrls) {
        warn('No realtimeGatewayUrl — with a certificate the socket URL must be the certificate\'s host '
          + '(wss://<middleware host>), which this stack does not know; REALTIME_GATEWAY_URL is unset.');
      }
      if (!realtime.platformPublicUrl && !portalSecrets['REALTIME_PLATFORM_PUBLIC_URL']) {
        warn('No realtimePlatformPublicUrl or socialPlatformHost — REALTIME_PLATFORM_PUBLIC_URL is unset, so the '
          + 'token bridge tells browsers no platform-api (needs DNS/TLS, deploy plan §5).');
      }
      if (!realtime.videoPublicUrl && !portalSecrets['REALTIME_VIDEO_PUBLIC_URL']) {
        warn('No realtimeVideoPublicUrl, videoPublicUrl or socialSfuHost — REALTIME_VIDEO_PUBLIC_URL is unset, so '
          + 'browsers are told no SFU (the SFU needs DNS/TLS and its custodian decision, deploy plan §3).');
      }
    }
    if (props.gatewayServiceAuthSecretArn) {
      const gatewaySecretRef = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'GatewayServiceAuthSecretRef', props.gatewayServiceAuthSecretArn,
      );
      gatewaySecretRef.grantRead(taskRole);
      containerSecrets['GATEWAY_SERVICE_AUTH_SECRET'] = ecs.Secret.fromSecretsManager(gatewaySecretRef);
    }
    if (props.cognitoClientSecretArn) {
      const cognitoSecretRef = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'CognitoClientSecretRef', props.cognitoClientSecretArn,
      );
      containerSecrets['COGNITO_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(cognitoSecretRef);
    }

    // ── Task size and the one-task rule ────────────────────────────────────
    // With `realtimeGateway=true` this task IS the realtime gateway. Local
    // routing is still the default; native leased Redis routing is an explicit
    // application opt-in. A Redis endpoint by itself does not prove that all
    // application/service state is safe across tasks. Keep the conservative
    // cloud guard until that broader contract is accepted (even if a caller
    // configures native peer routing), rather than reviving main's automatic
    // scale-out just because Social deploys a Redis. With the gateway on:
    //   - no autoscaling (it used to scale 1→4 on CPU 70%);
    //   - stop-before-start deploys (min 0 / max 100), never two tasks at once;
    //   - a short deregistration delay, because with stop-before-start the old
    //     task drains for the WHOLE delay (300 s default) before the new one
    //     starts — that delay is the signalling blackout per deploy;
    //   - 2 vCPU / 4 GB by default: the only size measured to hold 1,000
    //     sockets and 100 calls with no errors (chat p95 ~0.7 s, health p99
    //     19–45 ms; docs/spend-map.md). At 1 vCPU the BFF sat at 100 % of one
    //     core and chat p95 was 1.2–1.8 s; 4 vCPU measured no better.
    // Without the gateway the size is unchanged: 0.5 vCPU / 1 GB.
    // `middlewareCpu` / `middlewareMemoryMiB` override the size either way.
    const realtimePinned = realtime.enabled;
    const ctxNum = (k: string, fallback: number): number => {
      const raw = this.node.tryGetContext(k);
      if (raw === undefined || raw === null || raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} must be a positive integer, got ${String(raw)}`);
      return n;
    };
    const taskCpu = ctxNum('middlewareCpu', realtimePinned ? 2048 : 512);
    // Fargate's floor for 2 vCPU is 4 GB.
    const taskMemory = ctxNum('middlewareMemoryMiB', realtimePinned ? 4096 : 1024);
    // `autoscale` was decided above, with the Redis rule (DE-47).

    // ── Fargate service via L2 pattern ─────────────────────────────────────
    // ApplicationLoadBalancedFargateService handles the ALB, target group,
    // listener, security groups, and service wiring in one construct.
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'MiddlewareFargateService',
      {
        cluster,
        serviceName: `${prefix}-middleware`,
        cpu: taskCpu,
        memoryLimitMiB: taskMemory,

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
        // Gateway on: stop-before-start (see "the one-task rule" above).
        minHealthyPercent: realtimePinned ? 0 : 100,
        maxHealthyPercent: realtimePinned ? 100 : 200,
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
    // ECS rejects maximumPercent <= 100 while AZ rebalancing is on, and a
    // service created at 200% has it on; the pattern does not forward the
    // prop. One pinned task has nothing to rebalance anyway.
    if (realtimePinned) {
      (fargateService.service.node.defaultChild as ecs.CfnService).availabilityZoneRebalancing = 'DISABLED';
    }

    // Without a certificate the ALB's own DNS name IS the middleware origin,
    // so the socket URL can be derived (the portal appends /ws). ws://, not
    // wss://: usable only from an http:// page, i.e. the portal on each
    // participant's localhost — deploy plan §5's phase-2 arrangement.
    if (realtime.enabled && !realtime.gatewayUrl && !certArn && !portalSecrets['REALTIME_GATEWAY_URL']) {
      fargateService.taskDefinition.defaultContainer!.addEnvironment(
        'REALTIME_GATEWAY_URL', `ws://${fargateService.loadBalancer.loadBalancerDnsName}`,
      );
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

    // ── CloudFront → ALB (deployPortal=true) ──────────────────────────────
    // CloudFront's edges are not a CIDR anyone can list, and custodian revokes
    // 0.0.0.0/0, so the ALB admits AWS's managed prefix list
    // `com.amazonaws.global.cloudfront.origin-facing`. Whether custodian
    // tolerates a prefix-list rule is UNVERIFIED (deploy plan §10): if it
    // revokes this too, CloudFront answers 504 while every stack is healthy —
    // read the SG's IpPermissions first.
    //
    // Its own security group because a prefix-list rule counts as the list's
    // max entries (~55) against the per-SG rule quota (60 by default), and
    // because every CloudFront distribution — not just ours — sits behind
    // those addresses. Hence the lock: the listener's default action becomes a
    // 403, and a request is forwarded only if it carries OrgIQ-Portal's secret
    // header, or comes from an albAllowCidr address (rules below). The social
    // stacks' host and header rules sit at lower priorities, unchanged.
    let originVerify: string | undefined;
    if (viaCloudFront) {
      const originSecret = new secretsmanager.Secret(this, 'CloudFrontOriginSecret', {
        secretName: cloudFrontOriginSecretName(prefix),
        description: `${ORIGIN_VERIFY_HEADER} — CloudFront (OrgIQ-Portal) sends it, the ALB listener rules require it`,
        generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      });

      const prefixListOverride = ctxStr('cloudFrontPrefixListId');
      let prefixListId = prefixListOverride;
      if (!prefixListId) {
        // Resolved at deploy time: the id differs per region and a CDK context
        // lookup would need credentials at synth.
        const lookup = new cr.AwsCustomResource(this, 'CloudFrontPrefixListLookup', {
          onUpdate: {
            service: 'EC2',
            action: 'describeManagedPrefixLists',
            parameters: {
              Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }],
            },
            physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing-prefix-list'),
            outputPaths: ['PrefixLists.0.PrefixListId'],
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({ actions: ['ec2:DescribeManagedPrefixLists'], resources: ['*'] }),
          ]),
          installLatestAwsSdk: false,
        });
        prefixListId = lookup.getResponseField('PrefixLists.0.PrefixListId');
      }
      const cloudFrontSg = new ec2.SecurityGroup(this, 'CloudFrontOriginSecurityGroup', {
        vpc,
        description: 'CloudFront origin-facing prefix list to middleware ALB (OrgIQ-Portal)',
        allowAllOutbound: false,
      });
      cloudFrontSg.addIngressRule(
        ec2.Peer.prefixList(prefixListId), ec2.Port.tcp(listenerPortNumber), 'CloudFront origin-facing edges',
      );
      // Onto the CfnLoadBalancer directly, NOT `loadBalancer.addSecurityGroup`:
      // that joins the ALB's Connections, which replays every albAllowCidr rule
      // onto this group too — eating the quota the prefix list needs. Traffic
      // to the tasks needs nothing new: their group admits the ALB's first
      // group, and the ALB's ENIs carry both.
      const cfnLb = fargateService.loadBalancer.node.defaultChild as elbv2.CfnLoadBalancer;
      cfnLb.addPropertyOverride('SecurityGroups', [
        fargateService.loadBalancer.connections.securityGroups[0]!.securityGroupId,
        cloudFrontSg.securityGroupId,
      ]);

      const forward = () => elbv2.ListenerAction.forward([fargateService.targetGroup]);
      (fargateService.listener.node.defaultChild as elbv2.CfnListener).defaultActions = [{
        type: 'fixed-response',
        fixedResponseConfig: {
          statusCode: '403', contentType: 'text/plain',
          messageBody: 'Not through the OrgIQ portal distribution or an allowlisted address.',
        },
      }];
      new elbv2.ApplicationListenerRule(this, 'CloudFrontOriginRule', {
        listener: fargateService.listener,
        priority: CLOUDFRONT_RULE_PRIORITY.middleware,
        conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originSecret.secretValue.unsafeUnwrap()])],
        action: forward(),
      });
      originVerify = originSecret.secretValue.unsafeUnwrap();
      // ALB rules take at most five condition values, so one rule per five CIDRs.
      for (let i = 0; i < allowCidrs.length; i += 5) {
        new elbv2.ApplicationListenerRule(this, `AllowlistedClientRule${i / 5}`, {
          listener: fargateService.listener,
          priority: CLOUDFRONT_RULE_PRIORITY.allowlistFirst + i / 5,
          conditions: [elbv2.ListenerCondition.sourceIps(allowCidrs.slice(i, i + 5))],
          action: forward(),
        });
      }

      new cdk.CfnOutput(this, 'CloudFrontOriginSecretName', {
        value: cloudFrontOriginSecretName(prefix),
        description: 'Origin-verify header value; OrgIQ-Portal and OrgIQ-Social read it by this name',
      });
      new cdk.CfnOutput(this, 'CloudFrontPrefixListId', {
        value: prefixListId,
        description: 'Admitted on the ALB — check custodian left it: aws ec2 describe-security-groups',
      });
    }

    // ── HTTP → HTTPS redirect (only when certificate is present) ──────────
    if (certArn) {
      fargateService.loadBalancer.addRedirect({
        sourcePort: 80,
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        targetPort: 443,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      });
    }

    // ── WebSocket upgrades ─────────────────────────────────────────────────
    // The ALB forwards `Upgrade: websocket` natively; what it needs is time.
    // The default idle timeout is 60 s, and a socket (or an SSE stream) that
    // is quiet for longer is cut. 300 s is set unconditionally now — it used
    // to be set only when the document workspace deployed — and it is
    // ALB-wide, which also lengthens the middleware's SSE allowance.
    fargateService.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');
    // HTTP/1.1 to the target, explicitly: the WebSocket upgrade is an
    // HTTP/1.1 mechanism, and an HTTP2/gRPC target group cannot carry it.
    // HTTP1 is the default today; pinning it keeps a later "optimisation"
    // from silently breaking every socket. The ALB keeps HTTP/1.1
    // connections to targets alive on its own; there is no setting for it.
    (fargateService.targetGroup.node.defaultChild as elbv2.CfnTargetGroup).protocolVersion = 'HTTP1';
    // No sticky sessions: the cloud gateway is pinned to one task above. The
    // native peer router exists, but Redis presence alone must not relax that
    // application-level guard. With the gateway off, REST needs no stickiness.
    fargateService.targetGroup.setAttribute('stickiness.enabled', 'false');
    if (realtimePinned) {
      // Stop-before-start drains the old task for this long before the new
      // one starts; every socket reconnects anyway, so drain briefly.
      fargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '15');
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
    // Start at 1 replica; scale up under CPU/memory pressure — but never with
    // the realtime gateway on (the one-task rule above).
    if (autoscale) {
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
    }

    // ── Load alarms (realtimeAlarms=true; lib/realtime-alarms.ts) ─────────
    if (realtimeAlarmsEnabled(this)) {
      const topic = new sns.Topic(this, 'RealtimeAlarmTopic', {
        topicName: realtimeAlarmTopicName(prefix),
        displayName: 'OrgIQ realtime load alarms',
        enforceSSL: true,
      });
      const email = ctxStr('alertEmail');
      if (email) topic.addSubscription(new subs.EmailSubscription(email));
      const alarm = (spec: Parameters<typeof realtimeAlarm>[3]) => realtimeAlarm(this, prefix, topic, spec);
      const lb = fargateService.loadBalancer;
      const svc = fargateService.service;
      const five = cdk.Duration.minutes(5);
      const one = cdk.Duration.minutes(1);
      alarm({ id: 'middleware-alb-5xx', threshold: 10, evaluationPeriods: 1,
        metric: lb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: five, statistic: 'Sum' }),
        description: 'Middleware returned >10 5xx in 5 minutes (through the ALB).' });
      alarm({ id: 'middleware-alb-response-time', threshold: 2,
        metric: lb.metrics.targetResponseTime({ period: one, statistic: 'p95' }),
        description: 'Middleware p95 response time above 2 s for 3 minutes (SSE streams excluded only by their own length).' });
      alarm({ id: 'middleware-alb-rejected', threshold: 0, evaluationPeriods: 1,
        metric: lb.metrics.rejectedConnectionCount({ period: five, statistic: 'Sum' }),
        description: 'The ALB rejected connections (it hit its connection limit).' });
      alarm({ id: 'middleware-alb-connections', threshold: ctxNum('alarmMaxConnections', 3000),
        metric: lb.metrics.activeConnectionCount({ period: one, statistic: 'Sum' }),
        description: 'ALB active connections (sockets + HTTP) above the expected ceiling — near the one-task gateway\'s budget.' });
      alarm({ id: 'middleware-cpu', threshold: 80,
        metric: svc.metricCpuUtilization({ period: one }),
        description: 'Middleware task CPU above 80% for 3 minutes — the gateway delays every frame when the loop is busy.' });
      alarm({ id: 'middleware-memory', threshold: 85,
        metric: svc.metricMemoryUtilization({ period: one }),
        description: 'Middleware task memory above 85% for 3 minutes.' });

      // The gateway's own load line (lib/realtime-gateway.ts gatewayStatsLine):
      // one JSON line a minute → three metrics.
      const ns = 'OrgIQ/RealtimeGateway';
      const field = (name: string, metricName: string) => new logs.MetricFilter(this, `GatewayStats${metricName}`, {
        logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.type', '=', 'realtime-gateway-stats'),
        metricNamespace: ns,
        metricName,
        metricValue: `$.${name}`,
      });
      field('sockets', 'Sockets');
      field('activeCalls', 'ActiveCalls');
      const loop = field('eventLoopDelayP99Ms', 'EventLoopDelayP99Ms');
      alarm({ id: 'gateway-event-loop', threshold: 100,
        metric: loop.metric({ period: one, statistic: 'Maximum' }),
        description: 'Gateway event-loop delay p99 above 100 ms for 3 minutes — ring and chat frames are queuing.' });
      alarm({ id: 'gateway-silent', threshold: 1, comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 5, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        metric: new cloudwatch.Metric({ namespace: ns, metricName: 'Sockets', period: one, statistic: 'SampleCount' }),
        description: 'No gateway load line for 5 minutes — the gateway is down, restarting, or REALTIME_STATS_INTERVAL_MS=0.' });
      new cdk.CfnOutput(this, 'RealtimeAlarmTopicArn', {
        value: topic.topicArn,
        description: 'SNS topic for the realtime load alarms (social stacks address it by name)',
      });
      if (!realtime.enabled) {
        cdk.Annotations.of(this).addWarning('realtimeAlarms=true without realtimeGateway=true — the gateway-silent alarm will fire: '
          + 'nothing writes the load line.');
      }
    }

    // ── Devbox fleet alarms (fleetAlarms=true; lib/fleet-alarms.ts, DE-50) ─
    if (fleetAlarmsEnabled(this)) attachFleetAlarms(this, prefix, logGroup);

    const deployDocuments = this.node.tryGetContext('deployDocumentWorkspace') === true
      || this.node.tryGetContext('deployDocumentWorkspace') === 'true';
    if (deployDocuments) {
      if (!deployService) throw new Error('deployDocumentWorkspace requires deployMiddlewareService=true');
      // HTTPS from the ALB's certificate, or from the portal's CloudFront
      // certificate in front of it (publicBaseUrl is then the portal URL).
      if (!certArn && !viaCloudFront) throw new Error('deployDocumentWorkspace requires an HTTPS certificate or deployPortal=true');
      // `--context documentWorkspace='{…}'` arrives as a string; cdk.json and
      // props pass the object itself.
      const rawConfig = this.node.tryGetContext('documentWorkspace') as DocumentWorkspaceConfig | string | undefined;
      const documentConfig = props.documentWorkspace
        ?? (typeof rawConfig === 'string' ? JSON.parse(rawConfig) as DocumentWorkspaceConfig : rawConfig);
      if (!documentConfig) throw new Error('deployDocumentWorkspace requires documentWorkspace configuration');
      if (!props.cognitoUserPoolId) throw new Error('deployDocumentWorkspace requires the normal identity pool');
      attachDocumentWorkspace(this, {
        config: documentConfig, prefix, vpc, cluster, middleware: fargateService,
        cognitoUserPoolId: props.cognitoUserPoolId,
        ...(originVerify && { originVerify }),
      });
    }

    this.loadBalancerDnsName = fargateService.loadBalancer.loadBalancerDnsName;
    this.vpc = vpc;
    this.cluster = cluster;
    this.listener = fargateService.listener;
    this.loadBalancerSecurityGroupId =
      fargateService.loadBalancer.connections.securityGroups[0]!.securityGroupId;
    this.serviceSecurityGroupId =
      fargateService.service.connections.securityGroups[0]!.securityGroupId;
    this.taskRoleArn = taskRole.roleArn;
    this.taskRoleName = `${prefix}-middleware-task-role`;

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
