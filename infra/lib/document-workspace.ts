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
import { ApplicationTables, DocumentWorkspaceServices, RedisService } from 'realtime-examples/cdk/document-workspace';

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
  // an ensure*TTL() that DESCRIBES and then UPDATES the table's TTL config.
  //
  // Neither half is covered by what the library grants. `dynamodb-schemas.json`
  // sets `ttlAttribute` on only six of its 52 tables and none of these five, so
  // ApplicationTables creates them with TTL OFF and the app is the only thing
  // that can turn it on — but DocumentWorkspaceServices grants
  // DescribeTimeToLive on just three of the five and UpdateTimeToLive on none.
  // grantReadWriteData does not cover either action.
  //
  // The failure is loud but late, and it fails the whole deploy:
  //   [startup] FATAL: ddb-pipeline-audit-ttl ping failed in prod.
  //             Refusing to accept connections.
  // The task never goes healthy, `circuitBreaker: { rollback: true }` rolls the
  // service back, and the stack update fails with it.
  //
  // Granted here rather than upstream because the library's comment ("bootstrap
  // reads TTL state; provisioning owns TTL changes") describes an arrangement
  // its own manifest does not implement. If the manifest ever does set
  // ttlAttribute on these five, drop UpdateTimeToLive and keep the describes.
  for (const name of ['social-outbox', 'document-video-sessions', 'pipeline-runs', 'pipeline-audit', 'pipeline-dlq']) {
    workspace.platform.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:DescribeTimeToLive', 'dynamodb:UpdateTimeToLive'],
      resources: [tables.get(name).tableArn],
    }));
  }
  // `ensureOutboxTTL()` does not only touch TTL: it also calls
  // `ensureOutboxPendingIndex()`, which adds the drainer's `pending-index` GSI
  // with an additive UpdateTable. The manifest gives social-outbox only
  // `status-index`, so that index never exists until the app makes it — and
  // grantReadWriteData does not include UpdateTable.
  //
  // platform-api's own comment says the index "never gates boot" because the
  // drainer walks the table until it is ACTIVE. That is true of a SLOW index and
  // false of a FORBIDDEN one: the AccessDenied escapes ensureOutboxTTL() into
  // assertRequiredInProd, which is a boot gate, so the whole service dies with
  //   [startup] FATAL: ddb-outbox-ttl ping failed in prod.
  // Scoped to this one table because it is the only index the app self-creates.
  workspace.platform.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateTable'],
    resources: [tables.get('social-outbox').tableArn],
  }));

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
    priority: 20, conditions: [elbv2.ListenerCondition.pathPatterns(['/document-realtime', '/document-realtime/*', '/api/uploads/*'])],
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
