import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import { RedisService } from 'realtime-examples/cdk/document-workspace';
import { socialRepoName } from './social-images-stack';
import { SFU_PORTS, sfuSecretNames } from './social-media-stack';

// ── Tables ──────────────────────────────────────────────────────────────────
//
// The DynamoDB tables the call path touches, copied from realtime-examples'
// `infra/dynamodb-schemas.json` at ee1d019b (the manifest its
// `scripts/init-dynamodb.cjs` reads) plus platform-api's two run-time tables.
//
// Why a copy and not realtime-examples' `ApplicationTables` construct: the
// infra pin (2549856e) carries an OLDER manifest — social-outbox and
// pipeline-runs lack a GSI there and pipeline-audit/pipeline-dlq lack their
// TTL — and `ApplicationTables` can neither add a suffix nor create the two
// tables below that no manifest lists. Move to the construct once the pin
// moves and the manifest carries call-log/voicemail (plan backlog).
//
// `call-log` and `voicemail` are created by platform-api itself at run time
// (`CallLogRepository.ts`, `VoicemailRepository.ts`, CreateTableCommand). The
// task role is NOT given dynamodb:CreateTable, so CDK must create them.

type KeyType = 'S' | 'N';
interface Key { readonly name: string; readonly type: KeyType }
interface TableSpec {
  readonly name: string;
  readonly hash: Key;
  readonly range?: Key;
  readonly ttl?: string;
  readonly gsi?: ReadonlyArray<{ readonly name: string; readonly hash: Key; readonly range?: Key }>;
}
const S = (name: string): Key => ({ name, type: 'S' });
const N = (name: string): Key => ({ name, type: 'N' });

export const SOCIAL_TABLES: readonly TableSpec[] = [
  // video sessions + calls
  { name: 'document-video-sessions', hash: S('documentId'), range: S('sessionId') },
  {
    name: 'call-session-bindings', hash: S('callId'), range: S('sessionId'),
    gsi: [{ name: 'sessionId-index', hash: S('sessionId') }, { name: 'lobbyName-index', hash: S('lobbyName') }],
  },
  {
    name: 'video-call-recordings', hash: S('callId'), range: S('recordingId'), ttl: 'ttl',
    gsi: [{ name: 'recordingId-index', hash: S('recordingId') }],
  },
  { name: 'video-call-recording-participants', hash: S('userId'), range: S('startedAtRecordingId'), ttl: 'ttl' },
  { name: 'call-reactions', hash: S('lobbyKey'), range: S('sk') },
  // rooms
  {
    name: 'hangout-rooms', hash: S('orgId'), range: S('roomId'), ttl: 'ttl',
    gsi: [
      { name: 'orgId-slug-index', hash: S('orgId'), range: S('slug') },
      { name: 'orgId-lastActiveAt-index', hash: S('orgId'), range: S('lastActiveAt') },
      { name: 'teamId-index', hash: S('teamId') },
    ],
  },
  { name: 'hangout-room-members', hash: S('roomId'), range: S('userId'), gsi: [{ name: 'userId-roomId-index', hash: S('userId'), range: S('roomId') }] },
  { name: 'social-profiles', hash: S('userId') },
  { name: 'social-rooms', hash: S('roomId') },
  { name: 'social-room-members', hash: S('roomId'), range: S('userId'), gsi: [{ name: 'userId-roomId-index', hash: S('userId'), range: S('roomId') }] },
  // touched at boot (dynamo-setup.ts checks TTL on each)
  {
    name: 'social-outbox', hash: S('outboxId'),
    gsi: [
      { name: 'status-index', hash: S('status'), range: S('createdAt') },
      { name: 'pending-index', hash: S('pendingShard'), range: S('outboxId') },
    ],
  },
  {
    name: 'pipeline-runs', hash: S('pipelineId'), range: S('runId'),
    gsi: [{ name: 'status-startedAt-index', hash: S('status'), range: S('startedAt') }, { name: 'runId-index', hash: S('runId') }],
  },
  {
    name: 'pipeline-audit', hash: S('auditId'), ttl: 'ttlEpoch',
    gsi: [
      { name: 'actor-time-index', hash: S('actorUserId'), range: S('timestamp') },
      { name: 'pipeline-time-index', hash: S('pipelineId'), range: S('timestamp') },
      { name: 'runId-time-index', hash: S('runId'), range: S('timestamp') },
    ],
  },
  { name: 'pipeline-dlq', hash: S('messageId'), ttl: 'ttl', gsi: [{ name: 'failedAt-index', hash: S('partitionKey'), range: S('failedAt') }] },
  // chat
  { name: 'chat-messages', hash: S('channelId'), range: S('messageId') },
  { name: 'chat-members', hash: S('channel'), range: S('userId') },
  { name: 'chat-reads', hash: S('channel'), range: S('userId') },
  { name: 'chat-conversations', hash: S('userId'), range: S('channel'), gsi: [{ name: 'channel-index', hash: S('channel') }] },
  { name: 'chat-reactions', hash: S('channelId'), range: S('reactionKey') },
  { name: 'chat-pins', hash: S('channelId'), range: S('messageId') },
  { name: 'crdt-snapshots', hash: S('documentId'), range: N('timestamp') },
  // platform-api run-time tables — in no schema manifest
  { name: 'call-log', hash: S('userId'), range: S('callId') },
  { name: 'voicemail', hash: S('userId'), range: S('voicemailId') },
];

/**
 * `${prefix}-social-` or, with `--context tableSuffix=v2`, `${prefix}-social-v2-`.
 *
 * The "suffix" is applied to the NAMESPACE, not the end of each name, because
 * the services build names as `${DDB_TABLE_PREFIX}${base}` — a true suffix is
 * not something they can be told about.
 */
export function socialTablePrefix(prefix: string, suffix?: string): string {
  if (suffix !== undefined && !/^[A-Za-z0-9_.-]+$/.test(suffix)) {
    throw new Error(`tableSuffix must match [A-Za-z0-9_.-]+, got ${suffix}`);
  }
  return suffix ? `${prefix}-social-${suffix}-` : `${prefix}-social-`;
}

const attr = (k: Key): dynamodb.Attribute => ({
  name: k.name,
  type: k.type === 'N' ? dynamodb.AttributeType.NUMBER : dynamodb.AttributeType.STRING,
});

// ── Stack ───────────────────────────────────────────────────────────────────

export interface SocialStackProps extends cdk.StackProps {
  readonly prefix?: string;
  // From OrgIQ-MiddlewareService (see its "Handles the social stacks attach to").
  readonly vpc: ec2.Vpc;
  readonly cluster: ecs.Cluster;
  readonly listener: elbv2.IApplicationListener;
  readonly loadBalancerSecurityGroupId: string;
  readonly middlewareSecurityGroupId: string;
  readonly realtimeJwtSecretName: string;
  // From OrgIQ-Authentication.
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId?: string;
  /** From OrgIQ-SocialMedia, when it is part of the app. */
  readonly sfu?: {
    readonly privateIp: string;
    readonly instanceId: string;
    readonly securityGroupId: string;
  };
}

/**
 * OrgIQ-Social: platform-api on Fargate, Redis, and the DynamoDB tables the
 * call path needs — next to OrgIQ-MiddlewareService, on its cluster, behind
 * its load balancer. The middleware is its own realtime gateway
 * (`REALTIME_GATEWAY=on`), so no separate gateway service runs here.
 *
 * Context:
 *   deploySocial=true           instantiate this stack at all (bin/app.ts)
 *   deploySocialService=true    phase 2: scale platform-api to 1 (needs the digest)
 *   platformApiImageDigest      sha256:… of the pushed orgiq-platform-api image
 *   socialPlatformHost          host rule platform.<domain> → platform-api (priority 30)
 *   socialSfuHost               host rule sfu.<domain> → the SFU instance :3901 (priority 40)
 *   videoPublicUrl              browser-facing SFU URL (default https://<socialSfuHost>)
 *   videoApiUrl                 server-side SFU URL when OrgIQ-SocialMedia is not in the app
 *   socialGatewayWsUrl          GATEWAY_WS_URL for platform-api (the middleware's socket)
 *   tableSuffix                 namespace suffix so a redeploy after teardown can dodge
 *                               the RETAINed tables ("already exists")
 *
 * Two phases, the middleware pattern: phase 1 lands the tables, Redis, the
 * secrets and a platform-api service at desiredCount 0; after the image is
 * pushed, phase 2 (`deploySocialService=true` + the digest) scales it to 1.
 *
 * Redis runs as a Fargate container (realtime-examples' `RedisService`, the
 * one the document workspace uses): ~$7/mo, and it loses presence, ringing
 * calls and the ownership map on every task replacement. Acceptable for dev.
 * ElastiCache `cache.t4g.micro` (~$12/mo) is the move once people rely on it;
 * ElastiCache Serverless is probably incompatible (TLS + cluster mode, which
 * neither client builds). Point consumers at it with `realtimeRedisUrl`.
 */
export class SocialStack extends cdk.Stack {
  public readonly tablePrefix: string;
  public readonly platformService: ecs.FargateService;
  public readonly redisUrl: string;

  constructor(scope: Construct, id: string, props: SocialStackProps) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';
    const ctx = (k: string) => this.node.tryGetContext(k) as string | undefined;
    const flag = (k: string) => { const v = this.node.tryGetContext(k); return v === true || v === 'true'; };

    // ── Imported network handles ───────────────────────────────────────────
    // Imported by id with mutable rules, so every rule this stack adds lands
    // in THIS stack — never in OrgIQ-MiddlewareService, which would make the
    // two stacks depend on each other.
    const albSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSecurityGroup', props.loadBalancerSecurityGroupId, {
      allowAllOutbound: false, mutable: true,
    });
    const middlewareSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'MiddlewareSecurityGroup', props.middlewareSecurityGroupId, {
      mutable: true,
    });
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'SharedListener', {
      listenerArn: props.listener.listenerArn,
      securityGroup: albSg,
    });

    // ── Service discovery ──────────────────────────────────────────────────
    const namespace = new discovery.PrivateDnsNamespace(this, 'SocialNamespace', {
      vpc: props.vpc,
      name: `${prefix}-social.local`,
    });

    // ── Redis ──────────────────────────────────────────────────────────────
    // redis.<prefix>-social.local:6379 — the address the middleware's
    // realtimeGateway default points at. Pulled from ECR Public through the
    // NAT (multi-arch, so ARM64 resolves).
    const redis = new RedisService(this, 'SocialRedis', {
      vpc: props.vpc,
      cluster: props.cluster,
      namespace,
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/redis:7-alpine'),
    });
    const redisHost = `redis.${prefix}-social.local`;
    this.redisUrl = `redis://${redisHost}:6379`;
    redis.securityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.middlewareSecurityGroupId), ec2.Port.tcp(6379),
      'Middleware realtime gateway fan-out',
    );

    // ── Tables ─────────────────────────────────────────────────────────────
    // RETAIN + fixed names + deletion protection, like ApplicationTables: a
    // teardown leaves them, and the next create fails with "already exists"
    // unless deploy.sh's orphan sweep learns the prefix — or the redeploy
    // passes a new `tableSuffix`.
    this.tablePrefix = socialTablePrefix(prefix, ctx('tableSuffix'));
    for (const spec of SOCIAL_TABLES) {
      const table = new dynamodb.Table(this, `Table-${spec.name}`, {
        tableName: `${this.tablePrefix}${spec.name}`,
        partitionKey: attr(spec.hash),
        ...(spec.range && { sortKey: attr(spec.range) }),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        ...(spec.ttl && { timeToLiveAttribute: spec.ttl }),
      });
      for (const g of spec.gsi ?? []) {
        table.addGlobalSecondaryIndex({
          indexName: g.name,
          partitionKey: attr(g.hash),
          ...(g.range && { sortKey: attr(g.range) }),
          projectionType: dynamodb.ProjectionType.ALL,
        });
      }
    }

    // ── Secrets ────────────────────────────────────────────────────────────
    // Imported by NAME so no export freezes: the realtime JWT (minted by
    // OrgIQ-MiddlewareService) and the three SFU secrets (minted by
    // OrgIQ-SocialMedia, which deploys first).
    const realtimeJwt = secretsmanager.Secret.fromSecretNameV2(this, 'RealtimeJwtSecret', props.realtimeJwtSecretName);
    const sfuNames = sfuSecretNames(prefix);
    const sfuAdmin = secretsmanager.Secret.fromSecretNameV2(this, 'SfuAdminToken', sfuNames.adminToken);
    const sfuWebhook = secretsmanager.Secret.fromSecretNameV2(this, 'SfuWebhookSecret', sfuNames.webhook);
    const sfuService = secretsmanager.Secret.fromSecretNameV2(this, 'SfuServiceToken', sfuNames.serviceToken);
    const serviceAuth = new secretsmanager.Secret(this, 'SocialServiceAuthSecret', {
      secretName: `${prefix}-social-service-auth-secret`,
      description: 'SERVICE_AUTH_SECRET for platform-api service-to-service envelopes',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // ── platform-api ───────────────────────────────────────────────────────
    const digest = ctx('platformApiImageDigest');
    if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`platformApiImageDigest must be sha256:<64 hex>, got ${digest}`);
    }
    const deployService = flag('deploySocialService');
    if (deployService && !digest) {
      throw new Error('deploySocialService=true requires --context platformApiImageDigest=sha256:…');
    }
    const repo = ecr.Repository.fromRepositoryName(this, 'PlatformApiRepo', socialRepoName(prefix, 'platformApi'));

    const taskRole = new iam.Role(this, 'PlatformApiTaskRole', {
      roleName: `${prefix}-social-platform-api-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime role for the orgiq social platform-api task',
    });
    // Scoped to this deployment's namespace (tables AND their indexes), one
    // statement instead of 23 table grants. No CreateTable: CDK owns them.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SocialTablesReadWrite',
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
        'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem', 'dynamodb:TransactWriteItems', 'dynamodb:TransactGetItems',
        'dynamodb:DescribeTable', 'dynamodb:DescribeTimeToLive',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${this.tablePrefix}*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${this.tablePrefix}*/index/*`,
      ],
    }));

    const logGroup = new logs.LogGroup(this, 'PlatformApiLogGroup', {
      logGroupName: `/ecs/${prefix}-social-platform-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'PlatformApiTaskDef', {
      family: `${prefix}-social-platform-api`,
      cpu: 512,
      memoryLimitMiB: 1024,
      // ARM64: the image is built on Apple Silicon (the middleware's
      // `exec format error` gotcha).
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
    });
    repo.grantPull(taskDefinition.obtainExecutionRole());

    const platformHost = ctx('socialPlatformHost');
    const sfuHost = ctx('socialSfuHost');
    const videoApiUrl = props.sfu ? `http://${props.sfu.privateIp}:${SFU_PORTS.api}` : ctx('videoApiUrl');
    const videoPublicUrl = ctx('videoPublicUrl') ?? (sfuHost ? `https://${sfuHost}` : undefined);
    const gatewayWsUrl = ctx('socialGatewayWsUrl');
    const platformInternal = `http://social-platform.${prefix}-social.local:3001`;

    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3001',
      AWS_REGION: this.region,
      DDB_TABLE_PREFIX: this.tablePrefix,
      REDIS_ENDPOINT: redisHost,
      REDIS_PORT: '6379',
      REDIS_URL: this.redisUrl,
      SERVICE_AUTH_SERVICE_ID: 'platform-api',
      // A missing video secret fails boot rather than falling back to 'admin'.
      VIDEO_SECRETS_REQUIRED: 'true',
      // The SFU calls this from inside the VPC.
      LVS_WEBHOOK_BOOTSTRAP_URL: `${platformInternal}/hooks/lvs/recording`,
      COGNITO_REGION: this.region,
      COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
      ...(props.cognitoClientId && { COGNITO_CLIENT_ID: props.cognitoClientId }),
      ...(videoApiUrl && { VIDEO_API_URL: videoApiUrl }),
      ...(videoPublicUrl && { VIDEO_PUBLIC_URL: videoPublicUrl }),
      ...(gatewayWsUrl && { GATEWAY_WS_URL: gatewayWsUrl }),
    };
    if (!videoApiUrl) {
      cdk.Annotations.of(this).addWarning(
        'No SFU in the app and no videoApiUrl — platform-api gets no VIDEO_API_URL. '
        + 'Deploy with --context deploySocialMedia=true (or --context videoApiUrl=http://<sfu>:3901).',
      );
    }
    if (!videoPublicUrl) {
      cdk.Annotations.of(this).addWarning(
        'No videoPublicUrl/socialSfuHost — platform-api gets no VIDEO_PUBLIC_URL, so browsers are not told where the SFU is.',
      );
    }

    taskDefinition.addContainer('platform-api', {
      containerName: 'platform-api',
      image: ecs.ContainerImage.fromEcrRepository(repo, digest ?? 'latest'),
      // The image's default CMD is a Tilt restart-loop supervisor.
      command: ['node', 'dist/index.js'],
      portMappings: [{ containerPort: 3001 }],
      environment,
      secrets: {
        REALTIME_JWT_SECRET: ecs.Secret.fromSecretsManager(realtimeJwt),
        // One secret under two names: the SFU's ADMIN_TOKEN.
        VIDEO_ADMIN_TOKEN: ecs.Secret.fromSecretsManager(sfuAdmin),
        LVS_ADMIN_TOKEN: ecs.Secret.fromSecretsManager(sfuAdmin),
        // …and the SFU's WEBHOOK_HMAC_SECRET.
        LVS_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(sfuWebhook),
        // The SFU's LVS_SERVICE_TOKEN: platform-api calls LVS's session
        // lifecycle as itself, so no user bearer reaches the SFU.
        VIDEO_SERVICE_TOKEN: ecs.Secret.fromSecretsManager(sfuService),
        SERVICE_AUTH_SECRET: ecs.Secret.fromSecretsManager(serviceAuth),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'platform-api' }),
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const platformSg = new ec2.SecurityGroup(this, 'PlatformApiSecurityGroup', {
      vpc: props.vpc,
      description: 'orgiq social platform-api tasks',
      allowAllOutbound: true,
    });
    redis.securityGroup.addIngressRule(platformSg, ec2.Port.tcp(6379), 'platform-api');
    // The middleware reaches platform-api server-side (work-graph ingest, proxies).
    platformSg.addIngressRule(ec2.Peer.securityGroupId(props.middlewareSecurityGroupId), ec2.Port.tcp(3001), 'Middleware');
    // platform-api reaches the middleware's realtime gateway (GATEWAY_WS_URL).
    middlewareSg.addIngressRule(ec2.Peer.securityGroupId(platformSg.securityGroupId), ec2.Port.tcp(3001), 'Social platform-api');

    this.platformService = new ecs.FargateService(this, 'PlatformApiService', {
      cluster: props.cluster,
      serviceName: `${prefix}-social-platform-api`,
      taskDefinition,
      // Phase 1 runs nothing: the repository may still be empty.
      desiredCount: deployService ? 1 : 0,
      // Stop-before-start. Ownership fencing across two replicas is not
      // established, so a rolling overlap could double-write.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [platformSg],
      cloudMapOptions: {
        name: 'social-platform',
        cloudMapNamespace: namespace,
        dnsRecordType: discovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // ── Host rules on the shared listener ──────────────────────────────────
    // Host rules, not path rules: platform-api mounts /api wholesale, which
    // collides with the middleware. Priorities 10 and 20 belong to the
    // document workspace. One listener, one certificate (SAN or wildcard),
    // one albAllowCidr allowlist.
    if (platformHost) {
      const tg = new elbv2.ApplicationTargetGroup(this, 'PlatformApiTargetGroup', {
        vpc: props.vpc,
        port: 3001,
        protocol: elbv2.ApplicationProtocol.HTTP,
        protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: { path: '/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
      });
      new elbv2.ApplicationListenerRule(this, 'PlatformApiHostRule', {
        listener,
        priority: 30,
        conditions: [elbv2.ListenerCondition.hostHeaders([platformHost])],
        targetGroups: [tg],
      });
      this.platformService.attachToApplicationTargetGroup(tg);
    } else {
      cdk.Annotations.of(this).addWarning(
        'No socialPlatformHost — platform-api has no listener rule, so browsers cannot reach it. '
        + 'Deploy with --context socialPlatformHost=platform.<domain> once DNS/TLS exist.',
      );
    }

    if (props.sfu) {
      const sfuSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SfuSecurityGroup', props.sfu.securityGroupId, { mutable: true });
      // Server-to-server session calls, inside the VPC.
      sfuSg.addIngressRule(ec2.Peer.securityGroupId(platformSg.securityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'platform-api → SFU API');
      // The SFU's recording webhook back to platform-api.
      platformSg.addIngressRule(ec2.Peer.securityGroupId(props.sfu.securityGroupId), ec2.Port.tcp(3001), 'SFU webhook');

      if (sfuHost) {
        // Browsers reach the SFU's HTTP API over HTTPS through the shared ALB
        // (an https:// portal cannot call http:// — mixed content).
        const sfuTg = new elbv2.ApplicationTargetGroup(this, 'SfuTargetGroup', {
          vpc: props.vpc,
          port: SFU_PORTS.api,
          protocol: elbv2.ApplicationProtocol.HTTP,
          protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
          targetType: elbv2.TargetType.INSTANCE,
          targets: [new elbv2Targets.InstanceIdTarget(props.sfu.instanceId, SFU_PORTS.api)],
          deregistrationDelay: cdk.Duration.seconds(30),
          healthCheck: { path: '/api/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
        });
        new elbv2.ApplicationListenerRule(this, 'SfuHostRule', {
          listener,
          priority: 40,
          conditions: [elbv2.ListenerCondition.hostHeaders([sfuHost])],
          targetGroups: [sfuTg],
        });
        sfuSg.addIngressRule(ec2.Peer.securityGroupId(props.loadBalancerSecurityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'ALB → SFU API');
        albSg.addEgressRule(ec2.Peer.securityGroupId(props.sfu.securityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'ALB → SFU API');
      }
    }

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SocialTablePrefix', {
      value: this.tablePrefix,
      description: 'DDB_TABLE_PREFIX for every social service',
      exportName: `${prefix}-social-table-prefix`,
    });
    new cdk.CfnOutput(this, 'SocialRedisUrl', {
      value: this.redisUrl,
      description: 'Redis (Fargate container) — the middleware\'s realtimeGateway default',
    });
    new cdk.CfnOutput(this, 'PlatformApiInternalUrl', {
      value: platformInternal,
      description: 'platform-api inside the VPC (Cloud Map)',
    });
    new cdk.CfnOutput(this, 'PlatformApiServiceName', {
      value: this.platformService.serviceName,
      description: 'aws ecs describe-services --cluster orgiq-middleware --services <this>',
    });
  }
}
