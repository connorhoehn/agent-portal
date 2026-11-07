/**
 * cdk-nag AwsSolutions findings this app accepts, each with its reason
 * (work item 19). Applied by lib/nag.ts to every stack in bin/app.ts.
 *
 * NOT YET RECONCILED AGAINST A REAL RUN. cdk-nag is not installed in this
 * checkout (adding it needs `npm install`, which the work item could not run),
 * so this list is the expected set from reading the stacks, at rule
 * granularity. The first `npm install -D cdk-nag@^2` + `npm test` run will
 * print any finding not listed here (test/nag.test.ts fails on it), and any
 * entry here that matches nothing should be deleted. Narrow IAM5 to
 * `appliesTo` entries once the real finding strings are visible.
 *
 * The things this work item fixed are deliberately NOT suppressed: RDS10
 * (deletion protection), COG1 (password policy), CFR5 (TLS to the origin),
 * and IAM5 is backed by test/least-privilege.test.ts for the wildcards that
 * matter (bedrock-agentcore:*, GetAgentRuntime/InvokeAgentRuntime on *).
 */
export interface NagSuppressionEntry {
  readonly id: string;
  readonly reason: string;
  /** Stack-name suffixes ("Aurora", "MiddlewareService"); omitted = every stack. */
  readonly stacks?: readonly string[];
}

export const NAG_SUPPRESSIONS: readonly NagSuppressionEntry[] = [
  // ── IAM ──────────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole (custom-resource and tool Lambdas) and AmazonECSTaskExecutionRolePolicy '
      + '(image pull + log writes) are the AWS-maintained minimum for those service roles.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Remaining wildcards are actions with no resource-level permission (ecr:GetAuthorizationToken, '
      + 'xray:Put*, cloudwatch:PutMetricData with a namespace condition, bedrock-agentcore:ListAgentRuntimes and '
      + 'GetWorkloadAccessToken*, bedrock:InvokeModel on inference profiles), or prefix-scoped names in this account '
      + '(runtime/<prefix>_*, <prefix>-*-secret-??????, log-group:/aws/bedrock-agentcore/*, object keys /*). '
      + 'The ones that mattered are pinned by test/least-privilege.test.ts.',
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
      + 'callback/HMAC secrets are shared with the middleware; rotation needs a rotation Lambda per secret kind.',
  },
  // ── S3 ───────────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-S1',
    reason: 'No server access logging bucket in this lab account; CloudTrail data events are the audit path.',
  },
  {
    id: 'AwsSolutions-S10',
    reason: 'Buckets are private (BLOCK_ALL) and reached only by SigV4 SDK calls and CloudFront OAC; an aws:SecureTransport '
      + 'deny is still worth adding (open item in SECURITY-NOTES.md).',
  },
  // ── RDS ──────────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-RDS6',
    reason: 'Access is only through the RDS Data API with Secrets Manager logins; IAM database auth does not apply to it.',
    stacks: ['Aurora'],
  },
  {
    id: 'AwsSolutions-RDS11',
    reason: 'Default port 5432 on isolated subnets with no route in; the Data API is the only access path.',
    stacks: ['Aurora'],
  },
  // ── Cognito ──────────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-COG2',
    reason: 'MFA is OPTIONAL (TOTP) by decision in work item 19; making it REQUIRED needs every seeded user enrolled first.',
    stacks: ['Authentication'],
  },
  {
    id: 'AwsSolutions-COG3',
    reason: 'Threat protection (advanced security) is a paid Cognito feature plan; self sign-up is off and users are admin-provisioned.',
    stacks: ['Authentication'],
  },
  // ── Networking / compute ─────────────────────────────────────────────────
  {
    id: 'AwsSolutions-VPC7',
    reason: 'No VPC flow logs in the lab account (cost); the Aurora VPC has only isolated subnets.',
  },
  {
    id: 'AwsSolutions-ELB2',
    reason: 'ALB access logs need a log bucket with an ELB principal policy, which the account custodian strips (see foundation-stack.ts).',
  },
  {
    id: 'AwsSolutions-EC23',
    reason: 'Ingress is the CloudFront origin-facing prefix list or the albAllowCidr / sfuAllowCidr allowlists; '
      + 'cdk-nag cannot resolve those tokens and flags them as open.',
  },
  {
    id: 'AwsSolutions-EC26',
    reason: 'The SFU / TURN instances keep no data on EBS (stateless media relays, rebuilt from the AMI).',
    stacks: ['SocialMedia'],
  },
  {
    id: 'AwsSolutions-EC28',
    reason: 'Detailed monitoring on the media relays is a cost choice; the realtime alarms use the basic metrics.',
    stacks: ['SocialMedia'],
  },
  {
    id: 'AwsSolutions-EC29',
    reason: 'The media relays are replaceable by design (no termination protection, no ASG yet).',
    stacks: ['SocialMedia'],
  },
  {
    id: 'AwsSolutions-ECS2',
    reason: 'Plain environment variables carry only non-secret configuration; every secret is an ECS container '
      + 'secret from Secrets Manager or SSM (middleware-service-stack.ts).',
  },
  {
    id: 'AwsSolutions-ECS4',
    reason: 'Container Insights is off for cost in the lab; the service publishes its own metrics and alarms.',
  },
  // ── CloudFront ───────────────────────────────────────────────────────────
  {
    id: 'AwsSolutions-CFR1',
    reason: 'No geo restriction: the portal has no regional audience restriction.',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR2',
    reason: 'No WAF yet; the origin is locked to CloudFront by prefix list and origin-verify header. Open item.',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR3',
    reason: 'No CloudFront access logging bucket (same custodian constraint as ELB2).',
    stacks: ['Portal'],
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'The no-domain path uses the default *.cloudfront.net certificate, whose minimum viewer protocol CloudFront fixes.',
    stacks: ['Portal'],
  },
  // ── Messaging / workflows ────────────────────────────────────────────────
  {
    id: 'AwsSolutions-SNS2',
    reason: 'The alert topic carries alarm text only; SSE with a CMK is an open item.',
  },
  {
    id: 'AwsSolutions-SNS3',
    reason: 'The alert topic has only email and CloudWatch publishers; an aws:SecureTransport policy is an open item.',
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'The prompt canary state machines are Express workflows whose results are written to SSM and Aurora.',
    stacks: ['PromptCanary'],
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray on the canary state machines is a cost choice; the Lambda steps trace.',
    stacks: ['PromptCanary'],
  },
  {
    id: 'AwsSolutions-DDB3',
    reason: 'PITR is on for the durable tables (scores, social chat); the session and cache tables are TTL-bound and disposable.',
  },
];
