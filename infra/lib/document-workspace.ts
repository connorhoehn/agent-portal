import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import type { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationTables, DocumentWorkspaceServices, RedisService } from '@connorhoehn/realtime-examples-cdk';
import { ORIGIN_VERIFY_HEADER } from './portal-stack';

interface ImageConfig { repositoryName: string; digest: string }
export interface DocumentWorkspaceConfig {
  tenantId: string;
  /** HTTPS origin served by the middleware ALB and covered by its certificate. */
  publicBaseUrl: string;
  grantIssuer: string;
  grantKeyId: string;
  /** Optional known source steward, recorded on newly imported mappings only. */
  sourceOwnerSub?: string;
  /** Separately deployed, authenticated accelerator source adapter. */
  source?: { url: string; secretArn: string };
  /** Existing matching Ed25519 PEM keys; CDK never generates or reads key bytes. */
  grantPrivateKeySecretArn: string;
  grantPublicKeySecretArn: string;
  images: Record<'gateway' | 'platform' | 'catalog' | 'mq' | 'redis', ImageConfig>;
  architecture: 'ARM64' | 'X86_64';
}

export function attachDocumentWorkspace(scope: cdk.Stack, props: {
  config: DocumentWorkspaceConfig;
  prefix: string;
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  middleware: ApplicationLoadBalancedFargateService;
  cognitoUserPoolId: string;
  /** The portal's origin-verify header value, when CloudFront fronts the ALB:
   * the document route then answers only requests that came through it. */
  originVerify?: string;
}): DocumentWorkspaceServices {
  const { config, prefix, vpc, cluster, middleware } = props;
  if (config.tenantId !== 'assessment') throw new Error('This BFF document adapter currently serves the assessment tenant');
  const origin = new URL(config.publicBaseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('documentWorkspace.publicBaseUrl must be an HTTPS origin');
  }
  if (!['ARM64', 'X86_64'].includes(config.architecture)) throw new Error('Document image architecture must be explicit');
  for (const name of ['gateway', 'platform', 'catalog', 'mq', 'redis'] as const) {
    const image = config.images?.[name];
    if (!image?.repositoryName || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error(`Document ${name} image requires a repository and immutable digest`);
  }
  if (!config.grantPrivateKeySecretArn || !config.grantPublicKeySecretArn) throw new Error('Matching document signing key secret ARNs are required');
  if (config.source) {
    const sourceUrl = new URL(config.source.url);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash || !config.source.secretArn) {
      throw new Error('Assessment source requires an HTTPS URL and existing secret ARN');
    }
  }
  if (config.grantPrivateKeySecretArn === config.grantPublicKeySecretArn) throw new Error('Document public and private key secrets must be separate');
  const namespace = new discovery.PrivateDnsNamespace(scope, 'DocumentNamespace', { vpc, name: `${prefix}-documents.local` });
  middleware.service.enableCloudMap({ cloudMapNamespace: namespace, name: 'bff' });
  const cpuArchitecture = config.architecture === 'ARM64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64;
  const images = Object.fromEntries(Object.entries(config.images).map(([name, image]) => [name, {
    repository: ecr.Repository.fromRepositoryName(scope, `Document${name}Image`, image.repositoryName), digest: image.digest,
  }])) as Record<keyof DocumentWorkspaceConfig['images'], { repository: ecr.IRepository; digest: string }>;
  const redis = new RedisService(scope, 'DocumentRedis', {
    vpc, cluster, namespace, cpuArchitecture,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    image: ecs.ContainerImage.fromEcrRepository(images.redis.repository, images.redis.digest),
  });
  const tablePrefix = `${prefix}-${config.tenantId}-documents-`;
  const tables = new ApplicationTables(scope, 'DocumentTables', { tablePrefix });
  const mqTable = new dynamodb.Table(scope, 'DocumentQueueTable', {
    tableName: `${tablePrefix}mq`, partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'ttl', pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    deletionProtection: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const uploads = new efs.FileSystem(scope, 'DocumentUploads', {
    vpc, encrypted: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    enableAutomaticBackups: true, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  const accessPoint = uploads.addAccessPoint('DocumentUploadsAccess', {
    path: '/document-uploads', posixUser: { uid: '1000', gid: '1000' },
    createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
  });
  const secret = (id: string) => new secretsmanager.Secret(scope, id, { generateSecretString: { passwordLength: 48, excludePunctuation: true } });
  const policySecret = secret('DocumentPolicySecret');
  const gatewaySecret = secret('DocumentGatewayServiceSecret');
  const publicKey = secretsmanager.Secret.fromSecretCompleteArn(scope, 'DocumentGrantPublicKey', config.grantPublicKeySecretArn);
  const privateKey = secretsmanager.Secret.fromSecretCompleteArn(scope, 'DocumentGrantPrivateKey', config.grantPrivateKeySecretArn);
  const workspace = new DocumentWorkspaceServices(scope, 'DocumentWorkspace', {
    vpc, cluster, namespace, servicePrefix: 'workspace', cpuArchitecture,
    images, tables, tablePrefix, messageQueueTable: mqTable,
    gatewayTableNames: ['crdt-snapshots', 'crdt-documents', 'file-uploads', 'chat-messages', 'chat-conversations', 'chat-reactions', 'chat-pins', 'chat-reads', 'chat-members', 'call-session-bindings', 'work-graph'],
    // The existing platform boots shared workflow/outbox consumers. Their
    // canonical schema remains one owned manifest, scoped to this deployment.
    platformTableNames: [...tables.tables.keys()],
    redis: { host: `redis.${namespace.namespaceName}`, securityGroup: redis.securityGroup },
    uploads: { accessPoint, securityGroup: uploads.connections.securityGroups[0]! },
    tenantId: config.tenantId, grantIssuer: config.grantIssuer, grantKeyId: config.grantKeyId, grantPublicKey: publicKey,
    sessionEpochUrl: `http://bff.${namespace.namespaceName}:3001/internal/document-grants/session`,
    documentPolicySecret: policySecret, mqAuthSecret: secret('DocumentQueueAuthSecret'), catalogAuthSecret: secret('DocumentCatalogAuthSecret'),
    gatewayServiceAuthSecret: gatewaySecret, videoWebhookSecret: secret('DocumentVideoWebhookSecret'), videoAdminSecret: secret('DocumentVideoAdminSecret'),
    cognito: { region: scope.region, userPoolId: props.cognitoUserPoolId },
  });
  // platform-api refuses to serve in production until five TTL preflights pass
  // (`ddb-outbox-ttl`, `ddb-video-sessions-ttl`, `ddb-pipeline-runs-ttl`,
  // `ddb-pipeline-audit-ttl`, `ddb-pipeline-dlq-ttl` — src/index.ts). Each calls
  // `ensureTableTTL`, which DESCRIBES the table's TTL and then UPDATES it only
  // when the status is not already ENABLED/ENABLING. grantReadWriteData covers
  // neither action, and DocumentWorkspaceServices grants DescribeTimeToLive on
  // just three of the five.
  //
  // The failure is loud but late, and it fails the whole deploy:
  //   [startup] FATAL: ddb-pipeline-audit-ttl ping failed in prod.
  //             Refusing to accept connections.
  // The task never goes healthy, `circuitBreaker: { rollback: true }` rolls the
  // service back, and the stack update fails with it.
  //
  // The describe is unconditional, so all five need it. The update is reached
  // only when the manifest left TTL off, so that half is DERIVED from the
  // synthesized table rather than listed by hand: `dynamodb-schemas.json` sets
  // `ttlAttribute` on pipeline-audit (`ttlEpoch`) and pipeline-dlq (`ttl`) but
  // not on the other three, and deriving it means a table that gains one
  // upstream drops its write grant on the next bump instead of keeping a stale
  // one. Read off the L1 because the L2 does not expose TTL.
  for (const name of ['social-outbox', 'document-video-sessions', 'pipeline-runs', 'pipeline-audit', 'pipeline-dlq']) {
    const table = tables.get(name);
    const provisionedTtl = (table.node.defaultChild as dynamodb.CfnTable).timeToLiveSpecification;
    workspace.platform.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: provisionedTtl
        ? ['dynamodb:DescribeTimeToLive']
        : ['dynamodb:DescribeTimeToLive', 'dynamodb:UpdateTimeToLive'],
      resources: [table.tableArn],
    }));
  }
  // No `dynamodb:UpdateTable` grant: `ensureOutboxTTL()` also calls
  // `ensureOutboxPendingIndex()`, which DESCRIBES social-outbox and returns
  // 'present' without an UpdateTable once the GSI exists. The manifest now
  // declares `pending-index` (pendingShard/outboxId, matching the constants in
  // platform-api's outbox-pending.ts), so CDK creates it and the app never
  // reaches the additive UpdateTable it used to need permission for.

  const container = middleware.taskDefinition.defaultContainer!;
  container.addEnvironment('DOCUMENT_GATEWAY_INTERNAL_URL', workspace.gatewayUrl.replace(/^http:/, 'ws:'));
  container.addEnvironment('DOCUMENT_GATEWAY_PUBLIC_URL', `${origin.origin.replace(/^https:/, 'wss:')}/document-realtime`);
  container.addEnvironment('DOCUMENT_PLATFORM_INTERNAL_URL', workspace.platformUrl);
  container.addEnvironment('DOCUMENT_GRANT_ISSUER', config.grantIssuer);
  container.addEnvironment('DOCUMENT_GRANT_KEY_ID', config.grantKeyId);
  if (config.sourceOwnerSub) container.addEnvironment('DOCUMENT_SOURCE_OWNER_SUB', config.sourceOwnerSub);
  if (config.source) {
    container.addEnvironment('ASSESSMENT_SOURCE_URL', config.source.url);
    const sourceSecret = secretsmanager.Secret.fromSecretCompleteArn(scope, 'AssessmentSourceSecret', config.source.secretArn);
    container.addSecret('ASSESSMENT_SOURCE_SECRET', ecs.Secret.fromSecretsManager(sourceSecret));
  }
  container.addSecret('DOCUMENT_GRANT_PRIVATE_KEY', ecs.Secret.fromSecretsManager(privateKey));
  container.addSecret('DOCUMENT_POLICY_SECRET', ecs.Secret.fromSecretsManager(policySecret));
  workspace.gateway.connections.allowFrom(middleware.service, ec2.Port.tcp(8080), 'BFF scoped document transport');
  workspace.platform.connections.allowFrom(middleware.service, ec2.Port.tcp(3001), 'BFF document workflow proxy');
  middleware.service.connections.allowFrom(workspace.gateway, ec2.Port.tcp(3001), 'Gateway document session policy');
  middleware.service.connections.allowFrom(workspace.platform, ec2.Port.tcp(3001), 'Platform document session policy');
  middleware.listener.addAction('DenyPublicDocumentPolicy', {
    priority: 10, conditions: [elbv2.ListenerCondition.pathPatterns(['/internal/document-grants/*'])],
    action: elbv2.ListenerAction.fixedResponse(404),
  });
  middleware.listener.addTargets('DocumentRealtime', {
    priority: 20, conditions: [
      elbv2.ListenerCondition.pathPatterns(['/document-realtime', '/document-realtime/*', '/api/uploads/*']),
      ...(props.originVerify ? [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [props.originVerify])] : []),
    ],
    port: 8080, protocol: elbv2.ApplicationProtocol.HTTP,
    targets: [workspace.gateway.loadBalancerTarget({ containerName: 'gateway', containerPort: 8080 })],
    healthCheck: { path: '/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
    deregistrationDelay: cdk.Duration.seconds(120),
  });
  middleware.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');
  new cdk.CfnOutput(scope, 'DocumentGatewayPublicUrl', { value: `${origin.origin.replace(/^https:/, 'wss:')}/document-realtime` });
  new cdk.CfnOutput(scope, 'DocumentPlatformPrivateUrl', { value: workspace.platformUrl });
  new cdk.CfnOutput(scope, 'DocumentTablePrefix', { value: tablePrefix });
  return workspace;
}
