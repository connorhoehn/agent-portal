/**
 * cdk-nag AwsSolutions findings this app accepts, each with its reason
 * (work item 19). Applied by lib/nag.ts to every stack in bin/app.ts.
 *
 * Reconciled against a real run (cdk-nag 2.38.2, the full-app context test/nag.test.ts uses).
 * IAM4 and IAM5 are path-scoped: each entry names the constructs it covers, so a new role or
 * policy with a wildcard still fails the synth. To audit the raw findings with nothing
 * suppressed: `NAG_NO_SUPPRESS=1 npx cdk synth --quiet -c nag=true <full-app context>`.
 *
 * Fixed in the stacks rather than suppressed: RDS10, COG1, CFR5, S10 (enforceSSL on every bucket)
 * and SNS3 (enforceSSL on both topics).
 */
export interface NagSuppressionEntry {
  readonly id: string;
  readonly reason: string;
  /** Stack-name suffixes ("Aurora", "MiddlewareService"); omitted = every stack. */
  readonly stacks?: readonly string[];
  /**
   * Construct paths relative to the stack (`*` = one path segment). The suppression covers those
   * constructs and their children only. Omitted = the whole stack (non-IAM rules only).
   */
  readonly paths?: readonly string[];
}

export const NAG_SUPPRESSIONS: readonly NagSuppressionEntry[] = [
  // ── IAM4: AWS-managed policies ───────────────────────────────────────────
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole is the AWS-maintained log-write minimum for these Lambda roles: the custom-resource '
      + 'handlers and providers (Foundation, Portal, Aurora, KnowledgeBase, Guardrails, Authentication, MiddlewareService), '
      + 'the gateway tool Lambdas, SpanProjector, PromptCanary ParseMetrics, the telemetry LogRetention function and Foundation AgentBaseRole.',
    paths: [
      'BucketEmptierFn/ServiceRole', 'BucketEmptierProvider/framework-onEvent/ServiceRole', 'AgentBaseRole',
      'PortalBucketEmptierFn/ServiceRole', 'PortalBucketEmptierProvider/framework-onEvent/ServiceRole',
      'AuroraDeleterRole', 'AuroraDeleterProvider/framework-onEvent/ServiceRole',
      'DataApiReadyRole', 'DataApiReadyProvider/framework-onEvent/ServiceRole',
      'AWS679f53fac002430cb0da5b7982bd2287/ServiceRole',
      'GatewayToolsLambdaRole', 'GraphTraversalRole',
      'Projector/ServiceRole', 'ParseMetrics/ServiceRole',
      'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM4',
    reason: 'MiddlewareService/MiddlewareExecutionRole uses AmazonECSTaskExecutionRolePolicy (image pull and log writes), the AWS-maintained minimum for an ECS execution role.',
    stacks: ['MiddlewareService'],
    paths: ['MiddlewareExecutionRole'],
  },
  {
    id: 'AwsSolutions-IAM4',
    reason: 'SocialMedia/SfuInstanceRole uses AmazonSSMManagedInstanceCore so the relay can be reached with Session Manager instead of SSH.',
    stacks: ['SocialMedia'],
    paths: ['SfuInstanceRole'],
  },
  // ── IAM5: wildcards, by role family ──────────────────────────────────────
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AgentCoreRuntime execution roles: ecr:GetAuthorizationToken, xray:Put* and cloudwatch:PutMetricData have no resource-level '
      + 'permission; logs are limited to log-group:/aws/bedrock-agentcore/*; the rest are objects under the documents bucket, knowledge-base/* '
      + 'and browser/* in this account (ids are created by other stacks), the agent\'s own ssm prompts/<agent>/* path, and runtime/<prefix>_* for the supervisor.',
    stacks: ['AgentCoreRuntime'],
    paths: ['*ExecutionRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AgentCoreGateway/GatewayRole: gateway/* and the <prefix>_* runtimes are prefix-scoped to this account; log-group:/aws/bedrock-agentcore/*; '
      + 'workload-identity and token actions have no resource-level permission (test/least-privilege.test.ts pins the named actions).',
    stacks: ['AgentCoreGateway'],
    paths: ['GatewayRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AgentCoreGateway tool Lambda roles (GatewayToolsLambdaRole, GraphTraversalRole): X-Ray and metric actions with no resource-level permission.',
    stacks: ['AgentCoreGateway'],
    paths: ['GatewayToolsLambdaRole', 'GraphTraversalRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AgentCore service roles for evaluation, memory, the code sandbox and the devbox: log-group:/aws/bedrock-agentcore/* and aws/spans prefixes in this '
      + 'account, plus actions with no resource-level permission (ecr token, xray, cloudwatch metrics, bedrock foundation-model and inference-profile invoke).',
    paths: ['EvaluationExecutionRole', 'MemoryExecutionRole', 'SandboxExecutionRole', 'DevboxExecutionRole',
      'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Aurora AuroraDeleterRole may delete only cluster snapshots named <prefix>-aurora-final-*; its provider framework role invokes the deleter Lambda (:* is the version/alias suffix).',
    stacks: ['Aurora'],
    paths: ['AuroraDeleterRole', 'AuroraDeleterProvider/framework-onEvent/ServiceRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Object-level access (<bucket>/*) and GSI access (<table>/index/*) on the named buckets and tables in Foundation (AgentBaseRole, BucketEmptierFn) '
      + 'and KnowledgeBase (KBServiceRole); the emptier has to delete every key, and the provider framework roles invoke their own Lambda (:*).',
    paths: ['AgentBaseRole', 'BucketEmptierFn/ServiceRole', 'BucketEmptierProvider/framework-onEvent/ServiceRole',
      'PortalBucketEmptierFn/ServiceRole', 'PortalBucketEmptierProvider/framework-onEvent/ServiceRole',
      'KBServiceRole', 'DataApiReadyProvider/framework-onEvent/ServiceRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AwsCustomResource policies (Guardrails BedrockInvocationLoggingConfig, MiddlewareService CloudFrontPrefixListLookup) call account-level '
      + 'APIs with no resource-level permission (PutModelInvocationLoggingConfiguration, DescribeManagedPrefixLists).',
    paths: ['BedrockInvocationLoggingConfig/CustomResourcePolicy', 'CloudFrontPrefixListLookup/CustomResourcePolicy'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'MiddlewareService task and execution roles: named prefixes in this account (ssm /<prefix>/{prompts,pricing,canary}/*, runtime/<prefix>_*, runtime-endpoint/*, '
      + 'code-interpreter-custom/<prefix>_code_interpreter-*, GSI index/*, bucket objects /*, the canary score log group) and actions with no resource-level permission.',
    stacks: ['MiddlewareService'],
    paths: ['MiddlewareTaskRole', 'MiddlewareExecutionRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'PromptCanary ControllerRole and PromotionControllerRole, and SpanProjector Projector role: ssm /<prefix>/prompts/* and xray/metric actions with no resource-level permission.',
    paths: ['ControllerRole', 'PromotionControllerRole', 'Projector/ServiceRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Social roles are limited to table/<prefix>-social-* and their GSIs (index/*), the prefix this stack owns; the task execution role needs ecr:GetAuthorizationToken, which has no resource-level permission.',
    stacks: ['Social'],
    paths: ['MiddlewareSocialChatPolicy', 'PlatformApiTaskDef/ExecutionRole', 'PlatformApiTaskRole'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'SocialMedia/SfuInstanceRole: ec2 and metric actions with no resource-level permission.',
    stacks: ['SocialMedia'],
    paths: ['SfuInstanceRole'],
  },
  // ── Lambda ───────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-L1',
    reason: 'Inline custom-resource and gateway-tool Lambdas pin python3.12 / nodejs20.x deliberately; runtime '
      + 'upgrades are their own change (DE-21 dependency hygiene).',
  },
  // ── Secrets Manager ──────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-SMG4',
    reason: 'No rotation yet: the Aurora logins are joined to their database roles by apply_all_seed.py, and the '
      + 'callback, HMAC and token secrets are shared with the middleware or the relay; rotation needs a rotation Lambda per secret kind. Research stack.',
  },
  // ── S3 ───────────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-S1',
    reason: 'No server access log bucket exists, and the account custodian strips the bucket-policy grant S3 log delivery needs '
      + '(same constraint as ELB2); CloudTrail data events are the audit path. Research stack.',
    stacks: ['Foundation', 'Portal'],
  },
  // ── RDS ──────────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-RDS6',
    reason: 'Access is only through the RDS Data API with Secrets Manager logins; IAM database auth does not apply to it.',
    stacks: ['Aurora'],
  },
  // ── ElastiCache ──────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-AEC3',
    reason: 'Social/SocialRedis is a single-node research cache on a private subnet reached from the platform-api task SG only; in-transit encryption and AUTH need client changes in the social service. Research stack.',
    stacks: ['Social'],
  },
  {
    id: 'AwsSolutions-AEC4',
    reason: 'Social/SocialRedis is one node by design (no replication group, no Multi-AZ): research stack, cost.',
    stacks: ['Social'],
  },
  {
    id: 'AwsSolutions-AEC5',
    reason: 'Social/SocialRedis keeps port 6379; it is reachable only from the platform-api security group on a private subnet.',
    stacks: ['Social'],
  },
  {
    id: 'AwsSolutions-AEC6',
    reason: 'Social/SocialRedis has no AUTH token: the social service connects without one and the cache holds only rebuildable presence data. Research stack.',
    stacks: ['Social'],
  },
  // ── Cognito ──────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-COG2',
    reason: 'MFA is OPTIONAL (TOTP) by decision in work item 19; making it REQUIRED needs every seeded user enrolled first.',
    stacks: ['Authentication'],
  },
  {
    id: 'AwsSolutions-COG8',
    reason: 'Authentication/UserPool stays on the Essentials feature plan: the Plus plan is a paid tier; self sign-up is off and users are admin-provisioned. Research stack, cost.',
    stacks: ['Authentication'],
  },
  // ── Networking / compute ─────────────────────────────────────────────────
  {
    id: 'AwsSolutions-VPC7',
    reason: 'No VPC flow logs on Aurora/AuroraVpc (isolated subnets only) or MiddlewareService/MiddlewareVpc: research stack, cost.',
    stacks: ['Aurora', 'MiddlewareService'],
  },
  {
    id: 'AwsSolutions-ELB2',
    reason: 'ALB access logs need a log bucket with an ELB principal policy, which the account custodian strips (see foundation-stack.ts).',
    stacks: ['MiddlewareService'],
  },
  {
    id: 'AwsSolutions-EC23',
    reason: 'MiddlewareService ALB security group (MiddlewareFargateService/LB/SecurityGroup): addRedirect opens 0.0.0.0/0:80 only for the HTTP-to-HTTPS redirect, which has no target; '
      + 'the account custodian revokes it anyway (see openListener in middleware-service-stack.ts). Open item: pass open:false and rely on albAllowCidr.',
    stacks: ['MiddlewareService'],
    paths: ['MiddlewareFargateService/LB/SecurityGroup'],
  },
  {
    id: 'AwsSolutions-EC28',
    reason: 'Detailed monitoring on the SFU relay is a cost choice; the realtime alarms use the basic metrics.',
    stacks: ['SocialMedia'],
  },
  {
    id: 'AwsSolutions-EC29',
    reason: 'The SFU relay is replaceable by design (no termination protection, no ASG yet).',
    stacks: ['SocialMedia'],
  },
  {
    id: 'AwsSolutions-ECS2',
    reason: 'Plain environment variables carry only non-secret configuration; every secret is an ECS container '
      + 'secret from Secrets Manager or SSM (middleware-service-stack.ts, social-stack.ts).',
    stacks: ['MiddlewareService', 'Social'],
  },
  // ── CloudFront ───────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-CFR1',
    reason: 'No geo restriction: the portal has no regional audience restriction.',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR2',
    reason: 'No WAF on the three Portal distributions: research stack, cost. The origin is locked to CloudFront by prefix list and origin-verify header.',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR3',
    reason: 'No CloudFront access logging bucket (same custodian constraint as ELB2 and S1).',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'The no-domain path uses the default *.cloudfront.net certificate, whose minimum viewer protocol CloudFront fixes.',
    stacks: ['Portal'],
  },
  // ── Workflows / DynamoDB ─────────────────────────────────────────────────
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray on the canary state machines is a cost choice; the Lambda steps trace.',
    stacks: ['PromptCanary'],
  },
  {
    id: 'AwsSolutions-DDB3',
    reason: 'PITR is on for the durable tables (scores, social chat); the sessions and leaderboards tables are rebuildable or TTL-bound.',
    stacks: ['Foundation'],
  },
];
