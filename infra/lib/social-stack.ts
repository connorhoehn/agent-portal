import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import { socialRepoName } from './social-images-stack';
import { SFU_PORTS, sfuParameterNames, sfuSecretNames } from './social-media-stack';
import {
  CLOUDFRONT_RULE_PRIORITY, ORIGIN_ROUTE_HEADER, ORIGIN_ROUTES, ORIGIN_VERIFY_HEADER, originVerifyValue, portalParameterNames,
} from './portal-stack';
import { realtimeAlarm, realtimeAlarmsEnabled, realtimeAlarmTopic } from './realtime-alarms';

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
  { name: 'document-video-sessions', hash: S('documentId'), range: S('sessionId'), ttl: 'ttl' },
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
  // teams, follows, recording share links (docs/social-tenant-design.md §4.4,
  // phase S2): platform-api's `/api/teams` (a team's channels are hangout
  // rooms carrying its teamId), the follow graph the contacts page reads, and
  // `POST /api/recordings/:id/share`'s links (TTL'd).
  {
    name: 'teams', hash: S('orgId'), range: S('teamId'),
    gsi: [{ name: 'orgId-slug-index', hash: S('orgId'), range: S('slug') }],
  },
  { name: 'team-members', hash: S('teamId'), range: S('userId'), gsi: [{ name: 'userId-index', hash: S('userId') }] },
  {
    name: 'social-relationships', hash: S('followerId'), range: S('followeeId'),
    gsi: [{ name: 'followeeId-followerId-index', hash: S('followeeId'), range: S('followerId') }],
  },
  { name: 'video-recording-share-links', hash: S('shareToken'), ttl: 'ttl' },
  // touched at boot (dynamo-setup.ts checks TTL on each)
  {
    // TTL on social-outbox, document-video-sessions and pipeline-runs: the
    // attribute platform-api's dynamo-setup.ts enables at boot — which it
    // cannot here (no UpdateTimeToLive on its role), so ended sessions never
    // expired (capacity review §4). CDK owns the setting instead.
    name: 'social-outbox', hash: S('outboxId'), ttl: 'ttl',
    gsi: [
      { name: 'status-index', hash: S('status'), range: S('createdAt') },
      { name: 'pending-index', hash: S('pendingShard'), range: S('outboxId') },
    ],
  },
  {
    name: 'pipeline-runs', hash: S('pipelineId'), range: S('runId'), ttl: 'ttl',
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
  // Work-sharing grants (middleware/src/lib/work-graph/sharing.ts): PK `<org>#<owner>`, SK grantId, TTL past expiry.
  { name: 'work-sharing', hash: S('ownerKey'), range: S('grantId'), ttl: 'ttl' },
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

/**
 * The tables the middleware's own gateway persists social chat and pins in —
 * realtime-modules' `DEFAULT_DYNAMO_CHAT_TABLES` (`DynamoChatStore`, read by
 * middleware/src/lib/social-chat.ts under `SOCIAL_CHAT_STORE=dynamo`). The
 * middleware task role is granted exactly these, not the whole namespace.
 */
export const MIDDLEWARE_CHAT_TABLES = ['chat-messages', 'chat-conversations', 'chat-members', 'chat-reads', 'chat-pins', 'work-sharing'] as const;

/**
 * SSM parameter OrgIQ-Social writes the Redis URL to, and the middleware task
 * reads as its REDIS_URL container secret. By NAME, so no export freezes.
 */
export function socialRedisUrlParameterName(prefix: string): string {
  return `/${prefix}/social/redis-url`;
}

/**
 * The realtime JWT secret's COMPLETE ARN, written by OrgIQ-MiddlewareService
 * and read here by name. Not a by-name import: that renders a partial ARN, and
 * Secrets Manager reads the last `-xxxxxx` of an ARN as the random suffix, so
 * `orgiq-realtime-jwt-secret` (suffix `-secret`) resolves to no secret.
 */
export function realtimeJwtSecretArnParameterName(prefix: string): string {
  return `/${prefix}/realtime/jwt-secret-arn`;
}

/** Private Cloud Map endpoint shared by the Social service and its BFF. */
export function socialPlatformInternalUrl(prefix: string): string {
  return `http://social-platform.${prefix}-social.local:3001`;
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
  /** Fixed name of the middleware task role — granted the chat tables by name. */
  readonly middlewareTaskRoleName: string;
  // From OrgIQ-Authentication.
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId?: string;
  /** From OrgIQ-SocialMedia, when it is part of the app. */
  readonly sfu?: {
    /** Unused since 2026-10-01 — read from SSM by name (sfuParameterNames); kept so callers need not change. */
    readonly privateIp: string;
    /** Unused since 2026-10-01 — read from SSM by name (sfuParameterNames). */
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
 *   deployPortal=true           the no-domain path: OrgIQ-Portal's platform-api and SFU
 *                               distributions reach these targets through header rules
 *                               (priorities 31 and 41) instead of host rules
 *
 * Two phases, the middleware pattern: phase 1 lands the tables, Redis, the
 * secrets and a platform-api service at desiredCount 0; after the image is
 * pushed, phase 2 (`deploySocialService=true` + the digest) scales it to 1.
 *
 * Redis is ElastiCache, one `cache.t4g.micro` node (~$12/mo), not the Fargate
 * container the plan first proposed (~$7/mo). Since social-tenant-design §3.3
 * the middleware's Redis holds the notification inbox as well as call state,
 * and a container loses both — every unread notification, every ringing
 * call — on each task replacement. ElastiCache Serverless is ruled out by the
 * clients, not by price: it is TLS-only and cluster-mode, and the middleware's
 * `lib/redis-lite.ts` refuses `rediss://` and speaks no cluster protocol
 * (platform-api builds plain `redis://` from REDIS_ENDPOINT too). No TLS
 * means no AUTH token either, so the security group is the only lock; it
 * admits the middleware and platform-api and nothing else.
 *
 * Also granted here, to the middleware's task role (imported by name): the
 * four chat tables its gateway persists social chat in
 * (`MIDDLEWARE_CHAT_TABLES`), and the Redis URL as an SSM parameter
 * (`socialRedisUrlParameterName`) the middleware reads as REDIS_URL.
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

    // ── Redis (ElastiCache, one node) ──────────────────────────────────────
    // No 0.0.0.0/0 anywhere: the account's custodian revokes open ingress
    // (CLAUDE.md), and nothing outside the VPC should reach this anyway.
    const redisSg = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: props.vpc,
      description: 'orgiq social Redis (ElastiCache): middleware + platform-api only',
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(
      ec2.Peer.securityGroupId(props.middlewareSecurityGroupId), ec2.Port.tcp(6379),
      'Middleware realtime gateway (call state, notifications)',
    );
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: `${prefix}-social-redis`,
      description: 'orgiq social Redis: the middleware VPC private subnets',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });
    // Default: one cache.t4g.micro node, the dev phase of the deploy plan. A
    // node restart or AZ event loses every ringing call and every unread
    // notification, so the 100-call profile (deploy plan §11) asks for
    // `socialRedisReplicas=1`: a replica in another AZ, automatic failover
    // (the primary endpoint flips; redis-lite reconnects on the next command
    // and its 2 s command deadline bounds the stall) and a daily snapshot.
    // `socialRedisNodeType` sizes the node.
    const redisNodeType = ctx('socialRedisNodeType') ?? 'cache.t4g.micro';
    if (!/^cache\.[a-z0-9]+\.[a-z0-9]+$/.test(redisNodeType)) throw new Error(`socialRedisNodeType must look like cache.t4g.small, got ${redisNodeType}`);
    const replicasRaw = ctx('socialRedisReplicas');
    const redisReplicas = replicasRaw === undefined ? 0 : Number(replicasRaw);
    if (!Number.isInteger(redisReplicas) || redisReplicas < 0 || redisReplicas > 5) {
      throw new Error(`socialRedisReplicas must be 0-5, got ${String(replicasRaw)}`);
    }
    const resilient = redisReplicas > 0;
    const redis = new elasticache.CfnReplicationGroup(this, 'SocialRedis', {
      replicationGroupId: `${prefix}-social-redis`,
      replicationGroupDescription: 'orgiq social: realtime call state + notification inbox',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: redisNodeType,
      numCacheClusters: 1 + redisReplicas,
      automaticFailoverEnabled: resilient,
      multiAzEnabled: resilient,
      port: 6379,
      // Neither client speaks TLS (see the class comment); at rest is free.
      transitEncryptionEnabled: false,
      atRestEncryptionEnabled: true,
      snapshotRetentionLimit: resilient ? 1 : 0,
      cacheSubnetGroupName: redisSubnets.cacheSubnetGroupName!,
      securityGroupIds: [redisSg.securityGroupId],
    });
    redis.addDependency(redisSubnets);
    // A cache: nothing to keep, and nothing left behind to bill after teardown.
    redis.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const redisHost = redis.attrPrimaryEndPointAddress;
    const redisPort = redis.attrPrimaryEndPointPort;
    this.redisUrl = `redis://${redisHost}:${redisPort}`;

    // The middleware reads this as its REDIS_URL container secret (ECS takes
    // a String parameter). By name, so OrgIQ-MiddlewareService imports nothing.
    const redisUrlParam = new ssm.StringParameter(this, 'SocialRedisUrlParameter', {
      parameterName: socialRedisUrlParameterName(prefix),
      stringValue: this.redisUrl,
      description: 'REDIS_URL for the middleware realtime gateway (OrgIQ-Social ElastiCache)',
    });

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

    // ── The middleware's chat tables ───────────────────────────────────────
    // Its gateway persists social chat through realtime-modules' DynamoChatStore
    // (SOCIAL_CHAT_STORE=dynamo, set by OrgIQ-MiddlewareService alongside
    // deploySocial). The role is imported by its fixed NAME and the policy
    // lives in this stack, so the dependency stays one-way (Social → middleware).
    // Exactly the store's six calls; no Scan, no CreateTable.
    const middlewareRole = iam.Role.fromRoleName(this, 'MiddlewareTaskRole', props.middlewareTaskRoleName);
    const tableArn = (name: string) => `arn:aws:dynamodb:${this.region}:${this.account}:table/${this.tablePrefix}${name}`;
    new iam.Policy(this, 'MiddlewareSocialChatPolicy', {
      policyName: `${prefix}-middleware-social-chat`,
      roles: [middlewareRole],
      statements: [new iam.PolicyStatement({
        sid: 'SocialChatTables',
        actions: [
          'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
          'dynamodb:Query', 'dynamodb:BatchGetItem',
        ],
        resources: MIDDLEWARE_CHAT_TABLES.flatMap((t) => [tableArn(t), `${tableArn(t)}/index/*`]),
      })],
    });

    // ── Secrets ────────────────────────────────────────────────────────────
    // The realtime JWT (minted by OrgIQ-MiddlewareService) and the three SFU
    // secrets (minted by OrgIQ-SocialMedia, which deploys first), by their
    // COMPLETE ARNs read from SSM by name, so no export freezes. Not
    // `fromSecretNameV2`: its partial ARN loses to Secrets Manager reading the
    // last `-xxxxxx` as the random suffix (`orgiq-realtime-jwt-secret`), and
    // the task fails AccessDenied before it starts.
    const fromArnParameter = (id: string, parameterName: string) => secretsmanager.Secret.fromSecretCompleteArn(
      this, id, ssm.StringParameter.valueForStringParameter(this, parameterName),
    );
    const realtimeJwt = fromArnParameter('RealtimeJwtSecret', realtimeJwtSecretArnParameterName(prefix));
    const sfuNames = sfuSecretNames(prefix);
    const sfuArns = sfuParameterNames(prefix).secretArns;
    // Without OrgIQ-SocialMedia in the app nothing has minted these yet.
    const sfuSecret = (id: string, name: string, arnParameter: string) => (props.sfu
      ? fromArnParameter(id, arnParameter)
      : secretsmanager.Secret.fromSecretNameV2(this, id, name));
    const sfuAdmin = sfuSecret('SfuAdminToken', sfuNames.adminToken, sfuArns.adminToken);
    const sfuWebhook = sfuSecret('SfuWebhookSecret', sfuNames.webhook, sfuArns.webhook);
    const sfuService = sfuSecret('SfuServiceToken', sfuNames.serviceToken, sfuArns.serviceToken);
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
      description: `Runtime role for the ${prefix} social platform-api task`,
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

    // 0.5 vCPU / 1 GB by default; the 100-call profile gives it a whole core
    // (`platformApiCpu=1024 platformApiMemoryMiB=2048`, capacity review #12).
    // Still one task: ownership fencing across replicas is not established.
    const intCtx = (k: string, fallback: number): number => {
      const raw = ctx(k);
      if (raw === undefined || raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} must be a positive integer, got ${raw}`);
      return n;
    };
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'PlatformApiTaskDef', {
      family: `${prefix}-social-platform-api`,
      cpu: intCtx('platformApiCpu', 512),
      memoryLimitMiB: intCtx('platformApiMemoryMiB', 1024),
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
    // The SFU host's private IP and instance id by NAME (OrgIQ-SocialMedia's
    // SSM parameters, resolved at deploy time), not via props.sfu's imports:
    // the host is replaced on every image roll, and an import would pin the
    // old instance's export (see sfuParameterNames).
    const sfuParams = sfuParameterNames(prefix);
    const sfuPrivateIp = props.sfu ? ssm.StringParameter.valueForStringParameter(this, sfuParams.privateIp) : undefined;
    const sfuInstanceId = props.sfu ? ssm.StringParameter.valueForStringParameter(this, sfuParams.instanceId) : undefined;
    const videoApiUrl = sfuPrivateIp ? `http://${sfuPrivateIp}:${SFU_PORTS.api}` : ctx('videoApiUrl');
    // The portal's public URLs (OrgIQ-Portal's parameters, by name) on a
    // later deploy, as the middleware reads them: the portal stack may not
    // exist yet on a first one.
    const portalParams = portalParameterNames(prefix);
    const portalUrl = (key: 'url' | 'videoUrl') => (flag('portalPublicUrls')
      ? ssm.StringParameter.valueForStringParameter(this, portalParams[key]) : undefined);
    const portalVideoUrl = props.sfu ? portalUrl('videoUrl') : undefined;
    const videoPublicUrl = ctx('videoPublicUrl') ?? (sfuHost ? `https://${sfuHost}` : portalVideoUrl);
    const gatewayWsUrl = ctx('socialGatewayWsUrl');
    const platformInternal = socialPlatformInternalUrl(prefix);
    // Per-resource lobby admission (platform-api docs/lobby-authority.md):
    // opt-in, and only AFTER the middleware carrying POST
    // /api/realtime/lobby-access is deployed — the reverse order refuses
    // every OrgIQ call lobby (docs/social-calls-plan.md, "Lobby admission").
    // The same URL derives the call-seat authority call-binding asks; unset,
    // every call-binding answers 503. With the portal live it is the
    // middleware through CloudFront: the middleware has no in-VPC name.
    const portalSite = portalUrl('url');
    const lobbyAuthorityUrl = ctx('lobbyAuthorityUrl')
      ?? (portalSite ? `${portalSite}/api/realtime/lobby-access` : undefined);

    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3001',
      AWS_REGION: this.region,
      DDB_TABLE_PREFIX: this.tablePrefix,
      REDIS_ENDPOINT: redisHost,
      REDIS_PORT: redisPort,
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
      ...(lobbyAuthorityUrl && { LOBBY_AUTHORITY_URL: lobbyAuthorityUrl, LOBBY_AUTHORITY_REQUIRED: 'true' }),
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
    redisSg.addIngressRule(platformSg, ec2.Port.tcp(6379), 'platform-api');
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
      // ECS rejects maximumPercent <= 100 with AZ rebalancing on.
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
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
    //
    // Without a domain (`deployPortal=true`) the same target groups are also
    // reached through OrgIQ-Portal's CloudFront distributions: each sends the
    // origin-verify secret plus a route header naming its target, and a rule
    // here matches both (lib/portal-stack.ts for why headers, not hosts).
    const viaCloudFront = flag('deployPortal');
    const cloudFrontRule = (id: string, priority: number, route: string, tg: elbv2.IApplicationTargetGroup) => {
      new elbv2.ApplicationListenerRule(this, id, {
        listener,
        priority,
        conditions: [
          elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originVerifyValue(prefix)]),
          elbv2.ListenerCondition.httpHeader(ORIGIN_ROUTE_HEADER, [route]),
        ],
        targetGroups: [tg],
      });
    };
    if (platformHost || viaCloudFront) {
      const tg = new elbv2.ApplicationTargetGroup(this, 'PlatformApiTargetGroup', {
        vpc: props.vpc,
        port: 3001,
        protocol: elbv2.ApplicationProtocol.HTTP,
        protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: { path: '/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
      });
      if (platformHost) {
        new elbv2.ApplicationListenerRule(this, 'PlatformApiHostRule', {
          listener,
          priority: 30,
          conditions: [elbv2.ListenerCondition.hostHeaders([platformHost])],
          targetGroups: [tg],
        });
      }
      if (viaCloudFront) {
        cloudFrontRule('PlatformApiCloudFrontRule', CLOUDFRONT_RULE_PRIORITY.platformApi, ORIGIN_ROUTES.platformApi, tg);
      }
      this.platformService.attachToApplicationTargetGroup(tg);
    } else {
      cdk.Annotations.of(this).addWarning(
        'No socialPlatformHost and no deployPortal — platform-api has no listener rule, so browsers cannot reach it. '
        + 'Deploy with --context socialPlatformHost=platform.<domain> once DNS/TLS exist, or with '
        + '--context deployPortal=true for the CloudFront path.',
      );
    }

    if (props.sfu) {
      const sfuSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SfuSecurityGroup', props.sfu.securityGroupId, { mutable: true });
      // Server-to-server session calls, inside the VPC.
      sfuSg.addIngressRule(ec2.Peer.securityGroupId(platformSg.securityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'platform-api to SFU API');
      // The SFU's recording webhook back to platform-api.
      platformSg.addIngressRule(ec2.Peer.securityGroupId(props.sfu.securityGroupId), ec2.Port.tcp(3001), 'SFU webhook');

      if (sfuHost || viaCloudFront) {
        // Browsers reach the SFU's HTTP API over HTTPS through the shared ALB
        // (an https:// portal cannot call http:// — mixed content).
        const sfuTg = new elbv2.ApplicationTargetGroup(this, 'SfuTargetGroup', {
          vpc: props.vpc,
          port: SFU_PORTS.api,
          protocol: elbv2.ApplicationProtocol.HTTP,
          protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
          targetType: elbv2.TargetType.INSTANCE,
          targets: [new elbv2Targets.InstanceIdTarget(sfuInstanceId!, SFU_PORTS.api)],
          deregistrationDelay: cdk.Duration.seconds(30),
          healthCheck: { path: '/api/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
        });
        if (sfuHost) {
          new elbv2.ApplicationListenerRule(this, 'SfuHostRule', {
            listener,
            priority: 40,
            conditions: [elbv2.ListenerCondition.hostHeaders([sfuHost])],
            targetGroups: [sfuTg],
          });
        }
        if (viaCloudFront) {
          cloudFrontRule('SfuCloudFrontRule', CLOUDFRONT_RULE_PRIORITY.sfu, ORIGIN_ROUTES.sfu, sfuTg);
        }
        sfuSg.addIngressRule(ec2.Peer.securityGroupId(props.loadBalancerSecurityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'ALB to SFU API');
        albSg.addEgressRule(ec2.Peer.securityGroupId(props.sfu.securityGroupId), ec2.Port.tcp(SFU_PORTS.api), 'ALB to SFU API');
      }
    }

    // ── Load alarms (realtimeAlarms=true; lib/realtime-alarms.ts) ─────────
    if (realtimeAlarmsEnabled(this)) {
      const topic = realtimeAlarmTopic(this, prefix);
      const alarm = (spec: Parameters<typeof realtimeAlarm>[3]) => realtimeAlarm(this, prefix, topic, spec);
      const one = cdk.Duration.minutes(1);
      const cacheMetric = (metricName: string, statistic: string) => new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache', metricName, statistic, period: one,
        // The primary is node 001 of the replication group.
        dimensionsMap: { CacheClusterId: `${prefix}-social-redis-001` },
      });
      alarm({ id: 'social-redis-memory', threshold: 80, metric: cacheMetric('DatabaseMemoryUsagePercentage', 'Maximum'),
        description: 'Social Redis memory above 80% — call state and inboxes are next to be refused.' });
      alarm({ id: 'social-redis-evictions', threshold: 0, evaluationPeriods: 1, metric: cacheMetric('Evictions', 'Sum'),
        description: 'Social Redis evicted keys — ringing calls or unread notifications were dropped.' });
      alarm({ id: 'social-redis-cpu', threshold: 80, metric: cacheMetric('EngineCPUUtilization', 'Maximum'),
        description: 'Social Redis engine CPU above 80% for 3 minutes.' });
      alarm({ id: 'social-platform-api-cpu', threshold: 80, metric: this.platformService.metricCpuUtilization({ period: one }),
        description: 'platform-api CPU above 80% for 3 minutes (one task by design).' });
      alarm({ id: 'social-platform-api-memory', threshold: 85, metric: this.platformService.metricMemoryUtilization({ period: one }),
        description: 'platform-api memory above 85% for 3 minutes.' });
      // DynamoDB throttles on the hot tables, as one math alarm (a math
      // expression takes at most 10 metrics: 5 tables × read/write).
      const hot = ['chat-messages', 'chat-members', 'chat-conversations', 'document-video-sessions', 'call-log'];
      const usingMetrics: Record<string, cloudwatch.IMetric> = {};
      hot.forEach((t, i) => {
        for (const [k, name] of [['r', 'ReadThrottleEvents'], ['w', 'WriteThrottleEvents']] as const) {
          usingMetrics[`${k}${i}`] = new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB', metricName: name, statistic: 'Sum', period: one,
            dimensionsMap: { TableName: `${this.tablePrefix}${t}` },
          });
        }
      });
      alarm({ id: 'social-dynamodb-throttles', threshold: 0, evaluationPeriods: 1,
        metric: new cloudwatch.MathExpression({
          expression: Object.keys(usingMetrics).map((k) => `FILL(${k}, 0)`).join(' + '),
          usingMetrics, period: one, label: 'throttle events (hot social tables)',
        }),
        description: `DynamoDB throttled the hot social tables (${hot.join(', ')}).` });
    }

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SocialTablePrefix', {
      value: this.tablePrefix,
      description: 'DDB_TABLE_PREFIX for every social service',
      exportName: `${prefix}-social-table-prefix`,
    });
    new cdk.CfnOutput(this, 'SocialRedisUrl', {
      value: this.redisUrl,
      description: 'Redis (ElastiCache cache.t4g.micro) — reachable only inside the VPC',
    });
    new cdk.CfnOutput(this, 'SocialRedisUrlParameterName', {
      value: redisUrlParam.parameterName,
      description: 'SSM parameter the middleware task reads as REDIS_URL',
    });
    new cdk.CfnOutput(this, 'SocialChatTablePrefix', {
      value: this.tablePrefix,
      description: 'SOCIAL_CHAT_TABLE_PREFIX for the middleware gateway (SOCIAL_CHAT_STORE=dynamo)',
    });
    new cdk.CfnOutput(this, 'PlatformApiInternalUrl', {
      value: platformInternal,
      description: 'platform-api inside the VPC (Cloud Map)',
    });
    // Read back by deploy.sh's sticky context (deploySocialService needs it).
    new cdk.CfnOutput(this, 'PlatformApiImageDigest', {
      value: digest ?? '(none)',
      description: 'platformApiImageDigest this stack was deployed with',
    });
    new cdk.CfnOutput(this, 'PlatformApiServiceName', {
      value: this.platformService.serviceName,
      description: 'aws ecs describe-services --cluster orgiq-middleware --services <this>',
    });
  }
}
