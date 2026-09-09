#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { AuroraStack } from '../lib/aurora-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { GuardrailsStack } from '../lib/guardrails-stack';
import { AgentsStack } from '../lib/agents-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { AgentCoreMemoryStack } from '../lib/agentcore-memory-stack';
import { AgentCorePolicyStack } from '../lib/agentcore-policy-stack';
import { AgentCoreRuntimeStack } from '../lib/agentcore-runtime-stack';
import { AgentCoreGatewayStack } from '../lib/agentcore-gateway-stack';
import { AgentCoreTelemetryStack } from '../lib/agentcore-telemetry-stack';
import { AgentCoreCapabilitiesStack } from '../lib/agentcore-capabilities-stack';
import { AuthorizationStack } from '../lib/authorization-stack';
import { AuthenticationStack } from '../lib/authentication-stack';
import { SpanProjectorStack } from '../lib/span-projector-stack';
import { PromptCanaryStack } from '../lib/prompt-canary-stack';
import { MiddlewareServiceStack } from '../lib/middleware-service-stack';
import { DevboxStack } from '../lib/devbox-stack';

const app = new cdk.App();

const prefix = app.node.tryGetContext('projectPrefix') ?? 'orgiq';
const alertEmail = app.node.tryGetContext('alertEmail') ?? '';
const monthlyBudgetUsd = Number(app.node.tryGetContext('monthlyBudgetUsd') ?? '200');

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// -------------------------------------------------------------------
// Stack 1: Foundation (S3, DynamoDB, base IAM)
// -------------------------------------------------------------------
const foundation = new FoundationStack(app, 'OrgIQ-Foundation', {
  env,
  prefix,
  description: 'OrgIQ Foundation: S3 buckets, DynamoDB tables, base IAM roles',
});

// -------------------------------------------------------------------
// Stack 2: Aurora Serverless v2 (pgvector for embeddings + relational tables for the org graph)
// Replaces Neptune Analytics and OpenSearch Serverless.
// Idle cost: ~$0.06/hr (0.5 ACU min). Enable with: cdk deploy OrgIQ-Aurora
// -------------------------------------------------------------------
const aurora = new AuroraStack(app, 'OrgIQ-Aurora', {
  env,
  prefix,
  agentRoleArn: foundation.agentBaseRole.roleArn,
  description: 'OrgIQ Aurora: Serverless v2 PostgreSQL with pgvector + relational org-graph schema',
});
aurora.addDependency(foundation);

// -------------------------------------------------------------------
// Stack 3: Knowledge Base (Bedrock KB backed by Aurora pgvector)
// -------------------------------------------------------------------
const knowledgeBase = new KnowledgeBaseStack(app, 'OrgIQ-KnowledgeBase', {
  env,
  prefix,
  documentsBucket: foundation.documentsBucket,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  description: 'OrgIQ Knowledge Base: Bedrock KB with Aurora pgvector storage + S3 data source',
});
knowledgeBase.addDependency(aurora);

// -------------------------------------------------------------------
// Stack 4: Guardrails (PII, content policy, grounding)
// -------------------------------------------------------------------
const guardrails = new GuardrailsStack(app, 'OrgIQ-Guardrails', {
  env,
  prefix,
  description: 'OrgIQ Guardrails: PII filtering, content policy, topic denials',
});

// -------------------------------------------------------------------
// Stack 4b: Authorization (Verified Permissions + Cedar policies + cookie key)
// User-facing RBAC for masquerade roles. Middleware calls AVP IsAuthorized;
// supervisor reads role-mapped guardrail IDs at agent-invoke time.
// -------------------------------------------------------------------
const authorization = new AuthorizationStack(app, 'OrgIQ-Authorization', {
  env,
  prefix,
  description: 'OrgIQ Authorization: Cedar policies + AVP policy store + session signing key',
});

// -------------------------------------------------------------------
// Stack 4c: Authentication (Cognito User Pool + Hosted UI — enterprise SSO)
// Additive + independently destroyable. The middleware BFF drives OIDC and
// mints its own session cookie; unwired, the picker login stays the only path.
//   cdk deploy OrgIQ-Authentication \
//     --context authCallbackUrls=https://mw.example.com/api/auth/callback \
//     --context authLogoutUrls=https://portal.example.com/
// -------------------------------------------------------------------
const authCallbackUrls = (app.node.tryGetContext('authCallbackUrls') as string | undefined)
  ?.split(',').map(s => s.trim()).filter(Boolean);
const authLogoutUrls = (app.node.tryGetContext('authLogoutUrls') as string | undefined)
  ?.split(',').map(s => s.trim()).filter(Boolean);
const authentication = new AuthenticationStack(app, 'OrgIQ-Authentication', {
  env,
  prefix,
  ...(authCallbackUrls ? { callbackUrls: authCallbackUrls } : {}),
  ...(authLogoutUrls ? { logoutUrls: authLogoutUrls } : {}),
  description: 'OrgIQ Authentication: Cognito User Pool + Hosted UI (OIDC SSO)',
});

// -------------------------------------------------------------------
// Stack 5: Agents (per-agent IAM roles + Managed Prompts)
// -------------------------------------------------------------------
const agents = new AgentsStack(app, 'OrgIQ-Agents', {
  env,
  prefix,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
  documentsBucketArn: foundation.documentsBucket.bucketArn,
  artifactsBucketArn: foundation.artifactsBucket.bucketArn,
  scoresTableArn: foundation.scoresTable.tableArn,
  sessionsTableArn: foundation.sessionsTable.tableArn,
  description: 'OrgIQ Agents: IAM roles for 6 AgentCore agents + Managed Prompts',
});
agents.addDependency(foundation);
agents.addDependency(aurora);
agents.addDependency(knowledgeBase);
// Agents no longer depends on Guardrails — IAM policies use bedrock:ApplyGuardrail
// on resource:* and the guardrail ID itself is passed at runtime via env vars.

// -------------------------------------------------------------------
// Stack 6: Observability (CloudWatch dashboard + budget alarm)
// -------------------------------------------------------------------
const observability = new ObservabilityStack(app, 'OrgIQ-Observability', {
  env,
  prefix,
  auroraClusterIdentifier: `${prefix}-aurora`,
  knowledgeBaseIds: {
    default: knowledgeBase.knowledgeBaseId,
  },
  monthlyBudgetUsd,
  alertEmail,
  description: 'OrgIQ Observability: CloudWatch dashboard (Aurora ACU + Bedrock) + budget alarm',
});
observability.addDependency(aurora);
observability.addDependency(knowledgeBase);

// ===================================================================
// AgentCore Feature Stacks
// ===================================================================

// -------------------------------------------------------------------
// Stack 7: AgentCore Memory
// -------------------------------------------------------------------
const agentCoreMemory = new AgentCoreMemoryStack(app, 'OrgIQ-AgentCoreMemory', {
  env,
  prefix,
  description: 'OrgIQ AgentCore Memory: semantic, user preference, and summary memory strategies',
});

// -------------------------------------------------------------------
// Stack 8: AgentCore Policy Engine
// -------------------------------------------------------------------
const agentCorePolicy = new AgentCorePolicyStack(app, 'OrgIQ-AgentCorePolicy', {
  env,
  prefix,
  description: 'OrgIQ AgentCore Policy: Cedar-based access control for agent tools',
});
// No dependency on guardrails — the policy engine doesn't reference the
// guardrail ARN. Cedar PII rules in the gateway stack reference it directly.

// -------------------------------------------------------------------
// Stack 9: AgentCore Capabilities (Code Interpreter, Browser, Workload Identity)
// Deploy before Runtime so capability IDs flow into agent env vars.
// Override portal callback URL: cdk deploy --context portalUrl=https://your-domain.com
// -------------------------------------------------------------------
const portalUrl = app.node.tryGetContext('portalUrl') as string | undefined;
const allowedOauth2ReturnUrls = portalUrl
  ? [`${portalUrl}/auth/callback`]
  : undefined; // falls back to localhost dev URLs defined in the stack

const agentCoreCapabilities = new AgentCoreCapabilitiesStack(app, 'OrgIQ-AgentCoreCapabilities', {
  env,
  prefix,
  allowedOauth2ReturnUrls,
  description: 'OrgIQ AgentCore Capabilities: Code Interpreter, Browser, Workload Identity',
});

// -------------------------------------------------------------------
// Stack 10: AgentCore Runtime (6 agent runtimes)
// -------------------------------------------------------------------
// Use Fn.importValue with stable exportNames to avoid CDK auto-generated hash-based
// exports (ExportsOutputFnGetAtt...) whose hashes change when the runtime stack template
// changes (e.g. deployRuntimes=true / enableEval=true), causing UPDATE_FAILED on the
// source stacks due to the CloudFormation cross-stack export deletion lock.
const agentCoreRuntime = new AgentCoreRuntimeStack(app, 'OrgIQ-AgentCoreRuntime', {
  env,
  prefix,
  agentRoles: agents.agentRoles,
  memoryId: cdk.Fn.importValue(`${prefix}-memory-id`),
  // Sub-agents no longer get a guardrail — enforcement lives only on the
  // supervisor edge, which selects from the three role-keyed IDs below.
  guardrailIdMember: cdk.Fn.importValue(`${prefix}-guardrail-id-member`),
  guardrailIdOrgLeader: cdk.Fn.importValue(`${prefix}-guardrail-id-org-leader`),
  guardrailIdHrAdmin: cdk.Fn.importValue(`${prefix}-guardrail-id-hr-admin`),
  auroraClusterArn: cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`),
  auroraCredentialsSecretArn: cdk.Fn.importValue(`${prefix}-aurora-secret-arn`),
  // `--context kbId=<id>` overrides the CFN import for the agent fleet.
  // The KnowledgeBase stack's exports are imported by four other stacks, so a
  // knowledge base deleted out-of-band cannot be replaced without a multi-stack
  // teardown — the export value is frozen while consumers exist. This lets the
  // runtimes point at a rebuilt KB immediately; drop it once the KB stack is
  // recreated cleanly and the export matches reality.
  knowledgeBaseId: app.node.tryGetContext('kbId') || cdk.Fn.importValue(`${prefix}-knowledge-base-id`),
  codeInterpreterId: cdk.Fn.importValue(`${prefix}-code-interpreter-id`),
  codeInterpreterArn: cdk.Fn.importValue(`${prefix}-code-interpreter-arn`),
  browserId: cdk.Fn.importValue(`${prefix}-browser-id`),
  browserArn: cdk.Fn.importValue(`${prefix}-browser-arn`),
  browserProfileId: cdk.Fn.importValue(`${prefix}-browser-profile-id`),
  // Machine-callback auth for the sessionless routes the fleet POSTs to
  // (approvals/request, harness/trace, assessment run-complete). These are
  // plain CLI context values, not Fn.importValue — OrgIQ-MiddlewareService
  // mints the actual secrets and is declared *after* this stack in this
  // file with no dependency edge between them, so there is no CloudFormation
  // export to import from here yet. Operator runbook (also in
  // docs/agentcore-preview-surface.md): deploy OrgIQ-MiddlewareService
  // first, `aws secretsmanager get-secret-value` each of the three
  // `orgiq-*-secret` secrets it creates, then redeploy this stack with:
  //   --context approvalsRequestSecret=<value>
  //   --context harnessTraceSecret=<value>
  //   --context assessmentRunCompleteSecret=<value>
  approvalsRequestSecret: app.node.tryGetContext('approvalsRequestSecret') as string | undefined,
  harnessTraceSecret: app.node.tryGetContext('harnessTraceSecret') as string | undefined,
  assessmentRunCompleteSecret: app.node.tryGetContext('assessmentRunCompleteSecret') as string | undefined,
  description: 'OrgIQ AgentCore Runtime: 6 agent runtimes with lifecycle and endpoint config',
});
agentCoreRuntime.addDependency(agents);
agentCoreRuntime.addDependency(agentCoreMemory);
agentCoreRuntime.addDependency(agentCoreCapabilities);
agentCoreRuntime.addDependency(aurora);
agentCoreRuntime.addDependency(knowledgeBase);
agentCoreRuntime.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 11: AgentCore MCP Gateway
// -------------------------------------------------------------------
const agentCoreGateway = new AgentCoreGatewayStack(app, 'OrgIQ-AgentCoreGateway', {
  env,
  prefix,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  policyEngineArn: agentCorePolicy.policyEngineArn,
  policyEngineId: agentCorePolicy.policyEngineId,
  agentRoles: agents.agentRoles,
  description: 'OrgIQ AgentCore Gateway: MCP Gateway with Lambda tools + Cedar policy enforcement',
});
agentCoreGateway.addDependency(agentCorePolicy);
agentCoreGateway.addDependency(agentCoreRuntime);
agentCoreGateway.addDependency(aurora);
agentCoreGateway.addDependency(knowledgeBase);

// -------------------------------------------------------------------
// Stack 12: AgentCore Telemetry (evaluators, online eval, CW dashboard)
// Enable online evaluation after runtimes are deployed:
//   cdk deploy OrgIQ-AgentCoreTelemetry --context enableEval=true
// -------------------------------------------------------------------
const agentCoreTelemetry = new AgentCoreTelemetryStack(app, 'OrgIQ-AgentCoreTelemetry', {
  env,
  prefix,
  description: 'OrgIQ AgentCore Telemetry: custom evaluators, online eval config, X-Ray, CloudWatch dashboard',
});
agentCoreTelemetry.addDependency(agentCoreRuntime);
agentCoreTelemetry.addDependency(agentCoreGateway);

// Authorization is deployed in parallel with the rest of the app — neither
// stack imports from the other. Middleware reads POLICY_STORE_ID and
// SESSION_SIGNING_SECRET_ARN from this stack's exports at runtime.
void authorization;

// -------------------------------------------------------------------
// Stack 13: Span Projector (OI Phase 3)
// Polls CloudWatch Logs Insights for OI-attributed OTel spans and projects
// each trace into observability.invocation_traces + observability.tool_calls.
// Runs on a 1-minute EventBridge schedule. Idempotent.
// -------------------------------------------------------------------
const spanProjector = new SpanProjectorStack(app, 'OrgIQ-SpanProjector', {
  env,
  auroraClusterArn: cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`),
  auroraSecretArn: cdk.Fn.importValue(`${prefix}-aurora-secret-arn`),
  auroraDatabase: 'orgiq',
  description: 'OrgIQ Span Projector: Lambda that projects OI OTel spans into Aurora observability tables',
});
spanProjector.addDependency(aurora);
void spanProjector;

// -------------------------------------------------------------------
// Stack 14: Prompt Canary (opt-in)
// Two Managed Prompt variants (A vs B) + judge prompt, EventBridge
// scheduler that fires an Express SFN every minute to promote/rollback
// the B-traffic weight in SSM. Disabled by default.
//   cdk deploy OrgIQ-PromptCanary --context deployCanary=true
// -------------------------------------------------------------------
const deployCanary = app.node.tryGetContext('deployCanary') === 'true' || app.node.tryGetContext('deployCanary') === true;
if (deployCanary) {
  const promptCanary = new PromptCanaryStack(app, 'OrgIQ-PromptCanary', { env, prefix });
// PromptCanary reads the Aurora cluster and secret ARNs through raw
// Fn.importValue, which creates no CDK dependency — so on a from-scratch
// deploy with concurrency the canary stack raced ahead of Aurora and failed
// with "No export named orgiq-aurora-secret-arn found". Every other Aurora
// consumer declares this; this one was constructed inline and could not.
promptCanary.addDependency(aurora);
}

// -------------------------------------------------------------------
// Stack 14b: Devbox (Claude Code in an AgentCore Runtime microVM)
// Phase 1 (always): ECR repo + minimal execution role (Bedrock Claude + logs).
// Phase 2 (after agents/devbox/build.sh pushes the image):
//   cdk deploy OrgIQ-Devbox --context deployDevbox=true
// Optional read-only OrgIQ data-plane access (Aurora + KB Retrieve):
//   ... --context devboxOrgAccess=true
// Model override (Bedrock Claude IDs only):
//   ... --context devboxModel=anthropic.claude-opus-5
// -------------------------------------------------------------------
const devboxOrgAccess = app.node.tryGetContext('devboxOrgAccess') === 'true' || app.node.tryGetContext('devboxOrgAccess') === true;
new DevboxStack(app, 'OrgIQ-Devbox', {
  env,
  prefix,
  // Only referenced (and therefore only imported) when devboxOrgAccess=true.
  ...(devboxOrgAccess && {
    auroraClusterArn: cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`),
    auroraCredentialsSecretArn: cdk.Fn.importValue(`${prefix}-aurora-secret-arn`),
    knowledgeBaseId: cdk.Fn.importValue(`${prefix}-knowledge-base-id`),
  }),
  // The lab loop, off unless an operator turns it on. Same hand-copied shape as
  // the three agent-callback secrets above, and for the same reason: an
  // AgentCore runtime's EnvironmentVariables is a bare string map, so neither
  // value can be a Secrets-Manager reference resolved at deploy time.
  //
  //   aws secretsmanager get-secret-value --secret-id orgiq-lab-callback-secret \
  //     --query SecretString --output text
  //   cdk deploy OrgIQ-Devbox --context deployDevbox=true \
  //     --context labApiBase=https://<middleware-origin> \
  //     --context labCallbackSecret=<value>
  //
  // Without labApiBase the in-container `lab` CLI soft-exits at every session
  // start and the loop does nothing — the state every deployed devbox has been
  // in so far.
  labApiBase: app.node.tryGetContext('labApiBase') as string | undefined,
  labCallbackSecret: app.node.tryGetContext('labCallbackSecret') as string | undefined,
  description: 'OrgIQ Devbox: Claude Code hosted on AgentCore Runtime with persistent session workspace',
});

// -------------------------------------------------------------------
// Stack 15: Middleware Service (ECS Fargate + ALB)
// Deploys the Express middleware as a production Fargate service.
//
// First-time setup:
//   1. cdk deploy OrgIQ-MiddlewareService
//   2. Push image: docker build + push to the ECR repo in stack outputs
//   3. Force a new ECS deployment to pick up the image
//
// HTTPS (with ACM certificate):
//   cdk deploy OrgIQ-MiddlewareService --context certificateArn=arn:aws:acm:...
//
// Pass the WebSocket gateway URL so the middleware can proxy realtime calls:
//   cdk deploy OrgIQ-MiddlewareService --context websocketGatewayUrl=https://ws.example.com
// -------------------------------------------------------------------
const middlewareCertArn = app.node.tryGetContext('certificateArn') as string | undefined;
const websocketGatewayUrl = app.node.tryGetContext('websocketGatewayUrl') as string | undefined;
// ARN of an EXISTING secret holding the shared HMAC value the gateway knows the
// `orgiq-middleware` client by. Imported rather than generated on purpose — the
// value must equal the gateway's own SERVICE_AUTH_ALLOWED_SERVICES entry (the
// same value the k8s `orgiq-service-auth` secret carries), so a generated one
// would fail every envelope check. Without it the URL alone is not enough: the
// middleware signs nothing and the gateway refuses the call.
//   cdk deploy OrgIQ-MiddlewareService \
//     --context websocketGatewayUrl=https://ws.example.com \
//     --context gatewayServiceAuthSecretArn=arn:aws:secretsmanager:...
const gatewayServiceAuthSecretArn =
  app.node.tryGetContext('gatewayServiceAuthSecretArn') as string | undefined;

const middlewareService = new MiddlewareServiceStack(app, 'OrgIQ-MiddlewareService', {
  env,
  prefix,
  certificateArn: middlewareCertArn,
  websocketGatewayUrl,
  gatewayServiceAuthSecretArn,

  // Foundation DynamoDB table names + ARNs
  scoresTableName: cdk.Fn.importValue(`${prefix}-scores-table-name`),
  sessionsTableName: cdk.Fn.importValue(`${prefix}-sessions-table-name`),
  scoresTableArn: cdk.Fn.importValue(`${prefix}-scores-table-arn`),
  // Sessions table ARN is not exported by FoundationStack today; construct it
  // from the stable table name pattern.  This avoids adding a new export to
  // FoundationStack (which is an existing deployed stack).
  sessionsTableArn: `arn:aws:dynamodb:${env.region ?? 'us-east-1'}:${env.account ?? '*'}:table/${prefix}-sessions`,

  // S3 bucket ARNs
  documentsBucketArn: cdk.Fn.importValue(`${prefix}-documents-bucket-arn`),
  artifactsBucketArn: cdk.Fn.importValue(`${prefix}-artifacts-bucket-arn`),

  // Authorization
  sessionSigningSecretArn: cdk.Fn.importValue(`${prefix}-session-signing-secret-arn`),
  policyStoreId: cdk.Fn.importValue(`${prefix}-policy-store-id`),

  // Authentication (Cognito SSO). Values come from OrgIQ-Authentication; the
  // BFF stays inert until COGNITO_CALLBACK_URL (HTTPS) is also set at deploy.
  cognitoUserPoolId: authentication.userPoolId,
  cognitoClientId: authentication.userPoolClientId,
  cognitoDomain: authentication.hostedUiDomain,
  cognitoClientSecretArn: authentication.clientSecretArn,

  // Aurora (from AuroraStack exports)
  auroraClusterArn: cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`),
  auroraCredentialsSecretArn: cdk.Fn.importValue(`${prefix}-aurora-secret-arn`),

  // AgentCore identifiers (from AgentCoreMemoryStack + KnowledgeBaseStack)
  memoryId: cdk.Fn.importValue(`${prefix}-memory-id`),
  // `--context kbId=<id>` overrides the CFN import. The KnowledgeBase stack's
  // exports are imported by four other stacks, so a knowledge base deleted
  // out-of-band cannot be replaced without a multi-stack teardown — the export
  // value is frozen while consumers exist. This override lets the fleet point
  // at a rebuilt knowledge base immediately; drop it once the KB stack is
  // recreated cleanly and the export matches reality again.
  knowledgeBaseId: cdk.Fn.importValue(`${prefix}-knowledge-base-id`),

  // Guardrail IDs (from GuardrailsStack)
  guardrailIdMember: cdk.Fn.importValue(`${prefix}-guardrail-id-member`),
  guardrailIdOrgLeader: cdk.Fn.importValue(`${prefix}-guardrail-id-org-leader`),
  guardrailIdHrAdmin: cdk.Fn.importValue(`${prefix}-guardrail-id-hr-admin`),

  description: 'OrgIQ Middleware Service: ECS Fargate + ALB for the Express middleware API',
});
middlewareService.addDependency(foundation);
middlewareService.addDependency(aurora);
middlewareService.addDependency(authorization);
middlewareService.addDependency(agentCoreMemory);
middlewareService.addDependency(knowledgeBase);
middlewareService.addDependency(guardrails);

app.synth();
