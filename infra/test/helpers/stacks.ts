/**
 * Single-stack builders.
 *
 * The app-level helper (app-assembly.ts) is the right tool for cross-stack
 * invariants; these are for the many assertions that only need one stack and
 * want the *construct* (so `Annotations.fromStack` works) rather than a
 * template read back off disk.
 *
 * Every stack is built environment-agnostic — no account, no region — which is
 * what keeps `new ec2.Vpc` off the availability-zones context provider and the
 * whole suite off the network. Region/account therefore appear in templates as
 * `{"Ref": "AWS::Region"}` / `{"Ref": "AWS::AccountId"}`, and assertions on
 * ARNs must match on the surrounding Fn::Join rather than a flat string.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as iam from 'aws-cdk-lib/aws-iam';

import { FoundationStack } from '../../lib/foundation-stack';
import { AuroraStack } from '../../lib/aurora-stack';
import { KnowledgeBaseStack } from '../../lib/knowledge-base-stack';
import { GuardrailsStack } from '../../lib/guardrails-stack';
import { AgentsStack } from '../../lib/agents-stack';
import { ObservabilityStack } from '../../lib/observability-stack';
import { AgentCoreCapabilitiesStack } from '../../lib/agentcore-capabilities-stack';
import { AgentCoreRuntimeStack } from '../../lib/agentcore-runtime-stack';
import { AgentCoreTelemetryStack } from '../../lib/agentcore-telemetry-stack';
import { DevboxStack, type DevboxStackProps } from '../../lib/devbox-stack';
import { MiddlewareServiceStack, type MiddlewareServiceStackProps } from '../../lib/middleware-service-stack';
import { SpanProjectorStack } from '../../lib/span-projector-stack';

export const PREFIX = 'orgiq';

const CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:orgiq-aurora';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:orgiq-aurora-abc123';
const READONLY_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:111111111111:secret:orgiq-aurora-readonly-def456';
const KB_ARN = 'arn:aws:bedrock:us-east-1:111111111111:knowledge-base/KBTEST0001';
const DOCS_BUCKET_ARN = 'arn:aws:s3:::orgiq-documents-111111111111-us-east-1';
const ARTIFACTS_BUCKET_ARN = 'arn:aws:s3:::orgiq-artifacts-111111111111-us-east-1';
const SCORES_TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/orgiq-scores';
const SESSIONS_TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/orgiq-sessions';
const SIGNING_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:111111111111:secret:orgiq-session-signing-ghi789';

export function newApp(context: Record<string, unknown> = {}): cdk.App {
  return new cdk.App({ context });
}

/**
 * agentcore-runtime-stack.ts's `resolveContainerUri` shells out to
 * `aws ecr describe-images` DURING SYNTH to digest-pin the container image.
 * Tests must never depend on a live registry, so the call is forced to fail and
 * the documented `:latest` fallback is what gets synthesised.
 *
 * NB `require`, not `import * as` — a namespace import compiles to an
 * __importStar *copy* with getter-only properties, so patching it would both
 * throw and (worse) not be seen by the module under test.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('node:child_process') as any;

export function withoutEcrLookup<T>(fn: () => T): T {
  const saved = childProcess.execFileSync;
  (childProcess as any).execFileSync = () => {
    throw new Error('execFileSync disabled in tests');
  };
  try {
    return fn();
  } finally {
    (childProcess as any).execFileSync = saved;
  }
}

export function foundationStack(context: Record<string, unknown> = {}): FoundationStack {
  return new FoundationStack(newApp(context), 'OrgIQ-Foundation', { prefix: PREFIX });
}

export function auroraStack(context: Record<string, unknown> = {}): AuroraStack {
  return new AuroraStack(newApp(context), 'OrgIQ-Aurora', {
    prefix: PREFIX,
    agentRoleArn: 'arn:aws:iam::111111111111:role/orgiq-agent-base-role',
  });
}

export function knowledgeBaseStack(context: Record<string, unknown> = {}): KnowledgeBaseStack {
  const app = newApp(context);
  const host = new cdk.Stack(app, 'Host');
  return new KnowledgeBaseStack(app, 'OrgIQ-KnowledgeBase', {
    prefix: PREFIX,
    documentsBucket: s3.Bucket.fromBucketArn(host, 'Docs', DOCS_BUCKET_ARN),
    auroraClusterArn: CLUSTER_ARN,
    auroraCredentialsSecretArn: SECRET_ARN,
  });
}

export function guardrailsStack(context: Record<string, unknown> = {}): GuardrailsStack {
  return new GuardrailsStack(newApp(context), 'OrgIQ-Guardrails', { prefix: PREFIX });
}

export function agentsStack(context: Record<string, unknown> = {}): AgentsStack {
  return new AgentsStack(newApp(context), 'OrgIQ-Agents', {
    prefix: PREFIX,
    auroraClusterArn: CLUSTER_ARN,
    auroraCredentialsSecretArn: SECRET_ARN,
    knowledgeBaseArn: KB_ARN,
    documentsBucketArn: DOCS_BUCKET_ARN,
    artifactsBucketArn: ARTIFACTS_BUCKET_ARN,
    scoresTableArn: SCORES_TABLE_ARN,
    sessionsTableArn: SESSIONS_TABLE_ARN,
  });
}

export function observabilityStack(context: Record<string, unknown> = {}): ObservabilityStack {
  return new ObservabilityStack(newApp(context), 'OrgIQ-Observability', {
    prefix: PREFIX,
    auroraClusterIdentifier: `${PREFIX}-aurora`,
    knowledgeBaseIds: { default: 'KBTEST0001' },
    monthlyBudgetUsd: 200,
    alertEmail: 'ops@example.com',
  });
}

export function capabilitiesStack(
  context: Record<string, unknown> = {},
): AgentCoreCapabilitiesStack {
  return new AgentCoreCapabilitiesStack(newApp(context), 'OrgIQ-AgentCoreCapabilities', {
    prefix: PREFIX,
  });
}

export function telemetryStack(context: Record<string, unknown> = {}): AgentCoreTelemetryStack {
  return new AgentCoreTelemetryStack(newApp(context), 'OrgIQ-AgentCoreTelemetry', {
    prefix: PREFIX,
  });
}

export function devboxStack(
  context: Record<string, unknown> = {},
  props: Partial<DevboxStackProps> = {},
): DevboxStack {
  return withoutEcrLookup(
    () =>
      new DevboxStack(newApp(context), 'OrgIQ-Devbox', {
        prefix: PREFIX,
        auroraClusterArn: CLUSTER_ARN,
        auroraCredentialsSecretArn: SECRET_ARN,
        knowledgeBaseId: 'KBTEST0001',
        ...props,
      }),
  );
}

export function spanProjectorStack(context: Record<string, unknown> = {}): SpanProjectorStack {
  return new SpanProjectorStack(newApp(context), 'OrgIQ-SpanProjector', {
    auroraClusterArn: CLUSTER_ARN,
    auroraSecretArn: SECRET_ARN,
    auroraDatabase: 'orgiq',
  });
}

export interface RuntimeStackBuild {
  readonly agents: AgentsStack;
  readonly runtime: AgentCoreRuntimeStack;
  readonly agentRoles: Record<string, iam.Role>;
}

/**
 * AgentCore Runtime needs real `iam.Role` objects, which in the real app come
 * from OrgIQ-Agents. Building both keeps the roles genuine rather than faked,
 * and means the two stacks' agent lists have to agree for the build to work at
 * all.
 */
export function runtimeStack(
  context: Record<string, unknown> = {},
  overrides: Partial<{
    codeInterpreterArn: string;
    browserArn: string;
    approvalsRequestSecret: string;
    harnessTraceSecret: string;
    assessmentRunCompleteSecret: string;
    auroraReadOnlySecretArn: string;
  }> = {},
): RuntimeStackBuild {
  const app = newApp(context);
  const agents = new AgentsStack(app, 'OrgIQ-Agents', {
    prefix: PREFIX,
    auroraClusterArn: CLUSTER_ARN,
    auroraCredentialsSecretArn: SECRET_ARN,
    knowledgeBaseArn: KB_ARN,
    documentsBucketArn: DOCS_BUCKET_ARN,
    artifactsBucketArn: ARTIFACTS_BUCKET_ARN,
    scoresTableArn: SCORES_TABLE_ARN,
    sessionsTableArn: SESSIONS_TABLE_ARN,
  });
  const runtime = withoutEcrLookup(() => new AgentCoreRuntimeStack(app, 'OrgIQ-AgentCoreRuntime', {
    prefix: PREFIX,
    agentRoles: agents.agentRoles,
    memoryId: 'orgiq_memory-ABCDEF',
    guardrailIdMember: 'gr-member',
    guardrailIdOrgLeader: 'gr-orgleader',
    guardrailIdHrAdmin: 'gr-hradmin',
    auroraClusterArn: CLUSTER_ARN,
    auroraCredentialsSecretArn: SECRET_ARN,
    auroraReadOnlySecretArn: overrides.auroraReadOnlySecretArn ?? READONLY_SECRET_ARN,
    knowledgeBaseId: 'KBTEST0001',
    codeInterpreterId: 'orgiq_ci-1234',
    codeInterpreterArn: overrides.codeInterpreterArn
      ?? 'arn:aws:bedrock-agentcore:us-east-1:111111111111:code-interpreter-custom/orgiq_ci-1234',
    browserId: 'orgiq_browser-5678',
    browserArn: overrides.browserArn
      ?? 'arn:aws:bedrock-agentcore:us-east-1:111111111111:browser-custom/orgiq_browser-5678',
    browserProfileId: 'orgiq_browser_profile-9012',
    approvalsRequestSecret: overrides.approvalsRequestSecret,
    harnessTraceSecret: overrides.harnessTraceSecret,
    assessmentRunCompleteSecret: overrides.assessmentRunCompleteSecret,
  }));
  return { agents, runtime, agentRoles: agents.agentRoles };
}

export function middlewareServiceStack(
  context: Record<string, unknown> = {},
  props: Partial<MiddlewareServiceStackProps> = {},
): MiddlewareServiceStack {
  return new MiddlewareServiceStack(newApp(context), 'OrgIQ-MiddlewareService', {
    prefix: PREFIX,
    ...props,
    scoresTableName: `${PREFIX}-scores`,
    sessionsTableName: `${PREFIX}-sessions`,
    scoresTableArn: SCORES_TABLE_ARN,
    sessionsTableArn: SESSIONS_TABLE_ARN,
    documentsBucketArn: DOCS_BUCKET_ARN,
    artifactsBucketArn: ARTIFACTS_BUCKET_ARN,
    sessionSigningSecretArn: SIGNING_SECRET_ARN,
    policyStoreId: 'PSTORE123456',
    auroraClusterArn: CLUSTER_ARN,
    auroraCredentialsSecretArn: SECRET_ARN,
    memoryId: 'orgiq_memory-ABCDEF',
    knowledgeBaseId: 'KBTEST0001',
    guardrailIdMember: 'gr-member',
    guardrailIdOrgLeader: 'gr-orgleader',
    guardrailIdHrAdmin: 'gr-hradmin',
  });
}

export const ARNS = {
  CLUSTER_ARN,
  SECRET_ARN,
  READONLY_SECRET_ARN,
  KB_ARN,
  DOCS_BUCKET_ARN,
  ARTIFACTS_BUCKET_ARN,
  SCORES_TABLE_ARN,
  SESSIONS_TABLE_ARN,
  SIGNING_SECRET_ARN,
};
