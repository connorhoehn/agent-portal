#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { FoundationStack } from '../lib/foundation-stack';
import { AuroraStack } from '../lib/aurora-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { GuardrailsStack } from '../lib/guardrails-stack';
import { AgentsStack } from '../lib/agents-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { AgentCoreMemoryStack } from '../lib/agentcore-memory-stack';
import { memoryIdParameterName } from '../lib/memory-config';
import { loadEnvironment, stackId } from '../lib/environment';
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
import { SocialImagesStack } from '../lib/social-images-stack';
import { SocialMediaStack } from '../lib/social-media-stack';
import { SocialStack } from '../lib/social-stack';
import { PortalStack } from '../lib/portal-stack';
import { contextFlag, dbMasterSecret as dbMasterSecretFlag } from '../lib/context-flags';
import { applyNag } from '../lib/nag';

const app = new cdk.App();

// The environment file (infra/environments/<name>.json, DE-17) names the
// account, region, resource prefix and stack-id prefix. `--context env=<name>`
// picks one; the default is `lab`. `envDir` points at another directory (tests).
const environment = loadEnvironment(
  (app.node.tryGetContext('env') as string | undefined) ?? undefined,
  (app.node.tryGetContext('envDir') as string | undefined) ?? undefined,
);
const prefix = environment.prefix;
const ctxPrefix = app.node.tryGetContext('projectPrefix') as string | undefined;
if (ctxPrefix !== undefined && ctxPrefix !== prefix) {
  throw new Error(`--context projectPrefix=${ctxPrefix} disagrees with environment "${environment.name}" (prefix "${prefix}"); edit the environment file instead`);
}
const alertEmail = app.node.tryGetContext('alertEmail') ?? '';
const monthlyBudgetUsd = Number(app.node.tryGetContext('monthlyBudgetUsd') ?? environment.monthlyBudgetUsd);

// Explicit, from the file and never from the shell: CDK refuses to deploy a
// stack whose account differs from the credentials in use.
const env: cdk.Environment = {
  account: environment.account,
  region: environment.region,
};

// -------------------------------------------------------------------
// Stack 1: Foundation (S3, DynamoDB, base IAM)
// -------------------------------------------------------------------
const foundation = new FoundationStack(app, stackId(environment, 'Foundation'), {
  env,
  prefix,
  description: 'OrgIQ Foundation: S3 buckets, DynamoDB tables, base IAM roles',
});
// The resolved environment, as a resource so `cdk diff` shows it whenever an
// environment file changes AND the deploy applies it. (It was template
// Metadata first: CloudFormation never applies a Metadata-only change, so the
// record never reached the account and every diff, every DEPLOY_PLAN_ONLY run
// included, showed it pending.) Readable by tools at /<prefix>/environment.
new ssm.StringParameter(foundation, 'EnvironmentRecord', {
  parameterName: `/${prefix}/environment`,
  description: `The resolved environment file (infra/environments/${environment.name}.json)`,
  stringValue: JSON.stringify(environment),
});

// -------------------------------------------------------------------
// Stack 2: Aurora Serverless v2 (pgvector for embeddings + relational tables for the org graph)
// Replaces Neptune Analytics and OpenSearch Serverless.
// Idle cost: ~$0.06/hr (0.5 ACU min). Enable with: cdk deploy OrgIQ-Aurora
// -------------------------------------------------------------------
const aurora = new AuroraStack(app, stackId(environment, 'Aurora'), {
  env,
  prefix,
  description: 'OrgIQ Aurora: Serverless v2 PostgreSQL with pgvector + relational org-graph schema',
});
aurora.addDependency(foundation);

// -------------------------------------------------------------------
// Stack 3: Knowledge Base (Bedrock KB backed by Aurora pgvector)
// -------------------------------------------------------------------
// Work item 19: each service authenticates to Aurora as its own role
// (schema/service_roles.sql); the master secret is for migrations.
// `-c dbMasterSecret=true` hands it back to every service for one release;
// `-c kbMasterSecret=true` holds back only the knowledge base, whose switch
// replaces it (infra/SECURITY-NOTES.md).
const dbMasterSecret = dbMasterSecretFlag(app);
const kbMasterSecret = dbMasterSecret || contextFlag(app, 'kbMasterSecret', false);
const middlewareDbSecretArn = dbMasterSecret
  ? cdk.Fn.importValue(`${prefix}-aurora-secret-arn`)
  : cdk.Fn.importValue(`${prefix}-aurora-middleware-secret-arn`);

const knowledgeBase = new KnowledgeBaseStack(app, stackId(environment, 'KnowledgeBase'), {
  env,
  prefix,
  documentsBucket: foundation.documentsBucket,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  ...(!kbMasterSecret && { knowledgeBaseSecretArn: aurora.kbSecretArn }),
  ...(!dbMasterSecret && { registrySecretArn: aurora.middlewareSecretArn }),
  description: 'OrgIQ Knowledge Base: Bedrock KB with Aurora pgvector storage + S3 data source',
});
knowledgeBase.addDependency(aurora);

// -------------------------------------------------------------------
// Stack 4: Guardrails (PII, content policy, grounding)
// -------------------------------------------------------------------
const guardrails = new GuardrailsStack(app, stackId(environment, 'Guardrails'), {
  env,
  prefix,
  description: 'OrgIQ Guardrails: PII filtering, content policy, topic denials',
});

// -------------------------------------------------------------------
// Stack 4b: Authorization (Verified Permissions + Cedar policies + cookie key)
// User-facing RBAC for masquerade roles. Middleware calls AVP IsAuthorized;
// supervisor reads role-mapped guardrail IDs at agent-invoke time.
// -------------------------------------------------------------------
const authorization = new AuthorizationStack(app, stackId(environment, 'Authorization'), {
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
//
// `--context portalPublicUrl=https://<id>.cloudfront.net` (OrgIQ-Portal's
// `PortalUrl` output) registers that origin's callback and sign-out URL too —
// the no-domain HTTPS path (docs/social-calls-deploy-plan.md §10). A context
// value, not an import: this stack deploys long before OrgIQ-Portal exists.
const portalPublicUrl = (app.node.tryGetContext('portalPublicUrl') as string | undefined)?.trim().replace(/\/+$/, '');
if (portalPublicUrl !== undefined && !/^https:\/\/[^/\s]+$/.test(portalPublicUrl)) {
  throw new Error(`portalPublicUrl must be an https:// origin (Cognito refuses http callbacks), got ${portalPublicUrl}`);
}
const splitList = (key: string) => (app.node.tryGetContext(key) as string | undefined)
  ?.split(',').map(s => s.trim()).filter(Boolean);
const withPortal = (list: string[] | undefined, extra: string) =>
  (portalPublicUrl ? [...(list ?? []), `${portalPublicUrl}${extra}`] : list);
const authCallbackUrls = withPortal(splitList('authCallbackUrls'), '/api/auth/callback');
const authLogoutUrls = withPortal(splitList('authLogoutUrls'), '/');
const authentication = new AuthenticationStack(app, stackId(environment, 'Authentication'), {
  env,
  prefix,
  ...(authCallbackUrls ? { callbackUrls: authCallbackUrls } : {}),
  ...(authLogoutUrls ? { logoutUrls: authLogoutUrls } : {}),
  description: 'OrgIQ Authentication: Cognito User Pool + Hosted UI (OIDC SSO)',
});

// -------------------------------------------------------------------
// Stack 5: Agents (per-agent IAM roles + Managed Prompts)
// -------------------------------------------------------------------
const agents = new AgentsStack(app, stackId(environment, 'Agents'), {
  env,
  prefix,
  description: 'OrgIQ Agents: Managed Prompts for the 8 AgentCore agents',
});
// OrgIQ-Agents used to import these for its (now removed) per-agent roles.
// CloudFormation refuses to delete an export another stack still imports, and
// the producers deploy before Agents, so keep the auto-named exports for one
// release; drop these lines once a deploy has run with them.
knowledgeBase.exportValue(knowledgeBase.knowledgeBaseArn);
for (const v of [foundation.artifactsBucket.bucketArn, foundation.scoresTable.tableArn,
  foundation.sessionsTable.tableArn]) foundation.exportValue(v);
// Likewise OrgIQ-Aurora, which used to grant the agent base role the master
// secret (removed, work item 19).
foundation.exportValue(foundation.agentBaseRole.roleArn);
agents.addDependency(foundation);
agents.addDependency(aurora);
agents.addDependency(knowledgeBase);
// Agents no longer depends on Guardrails — IAM policies use bedrock:ApplyGuardrail
// on resource:* and the guardrail ID itself is passed at runtime via env vars.

// -------------------------------------------------------------------
// Stack 6: Observability (CloudWatch dashboard + budget alarm)
// -------------------------------------------------------------------
const observability = new ObservabilityStack(app, stackId(environment, 'Observability'), {
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
const agentCoreMemory = new AgentCoreMemoryStack(app, stackId(environment, 'AgentCoreMemory'), {
  env,
  prefix,
  description: 'OrgIQ AgentCore Memory: semantic, user preference, and summary memory strategies',
});

// The orgiq tenant's memory id reaches the runtimes and the BFF by SSM
// parameter (infra/memory-config.json), not by CFN export.
const orgiqMemory = agentCoreMemory.tenants.some(t => t.tenant === 'orgiq');

// -------------------------------------------------------------------
// Stack 8: AgentCore Policy Engine
// -------------------------------------------------------------------
const agentCorePolicy = new AgentCorePolicyStack(app, stackId(environment, 'AgentCorePolicy'), {
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

const agentCoreCapabilities = new AgentCoreCapabilitiesStack(app, stackId(environment, 'AgentCoreCapabilities'), {
  env,
  prefix,
  allowedOauth2ReturnUrls,
  description: 'OrgIQ AgentCore Capabilities: Code Interpreter, Browser, Workload Identity',
});

// -------------------------------------------------------------------
// Stack 10: AgentCore Runtime (8 agent runtimes — 6 OrgIQ + 2 assessment)
// -------------------------------------------------------------------
// Use Fn.importValue with stable exportNames to avoid CDK auto-generated hash-based
// exports (ExportsOutputFnGetAtt...) whose hashes change when the runtime stack template
// changes (e.g. deployRuntimes=true / enableEval=true), causing UPDATE_FAILED on the
// source stacks due to the CloudFormation cross-stack export deletion lock.
const agentCoreRuntime = new AgentCoreRuntimeStack(app, stackId(environment, 'AgentCoreRuntime'), {
  env,
  prefix,
  ...(orgiqMemory && { memoryIdParameter: memoryIdParameterName(prefix, 'orgiq') }),
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
  // (approvals/request, harness/trace, assessment run-complete). Each runtime
  // gets the NAMES of the secrets OrgIQ-MiddlewareService mints
  // (`*_SECRET_ID`) and reads the values itself (lib/callback-secrets.ts).
  // The three context values below are the old plaintext path: refused unless
  // `--context plaintextCallbackSecrets=true` (one release, SECURITY-NOTES.md).
  approvalsRequestSecret: app.node.tryGetContext('approvalsRequestSecret') as string | undefined,
  harnessTraceSecret: app.node.tryGetContext('harnessTraceSecret') as string | undefined,
  assessmentRunCompleteSecret: app.node.tryGetContext('assessmentRunCompleteSecret') as string | undefined,
  // MIDDLEWARE_URL for those callbacks. A deployed runtime cannot reach the
  // ALB (PUBLIC network mode, AWS addresses outside albAllowCidr) but can
  // reach CloudFront, which the ALB admits — so the portal URL is the
  // default; `middlewareCallbackUrl` names anything else.
  middlewareUrl: (app.node.tryGetContext('middlewareCallbackUrl') as string | undefined) ?? portalPublicUrl,
  description: 'OrgIQ AgentCore Runtime: 8 agent runtimes with lifecycle and endpoint config',
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
const agentCoreGateway = new AgentCoreGatewayStack(app, stackId(environment, 'AgentCoreGateway'), {
  env,
  prefix,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  auroraReadOnlySecretArn: aurora.readOnlySecretArn,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  policyEngineArn: agentCorePolicy.policyEngineArn,
  policyEngineId: agentCorePolicy.policyEngineId,
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
const agentCoreTelemetry = new AgentCoreTelemetryStack(app, stackId(environment, 'AgentCoreTelemetry'), {
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
const spanProjector = new SpanProjectorStack(app, stackId(environment, 'SpanProjector'), {
  prefix,
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
  // DE-4: the per-agent promotion controller is built but its schedule is
  // DISABLED unless asked for; the default promotion path is gate-only
  // (scripts/prompt-pointers.ts candidate → promote).
  const promptPromotionCanary = app.node.tryGetContext('promptPromotionCanary') === 'true' || app.node.tryGetContext('promptPromotionCanary') === true;
  const promptCanary = new PromptCanaryStack(app, stackId(environment, 'PromptCanary'), {
    env, prefix, promptPromotion: { enabled: promptPromotionCanary },
  });
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
new DevboxStack(app, stackId(environment, 'Devbox'), {
  env,
  prefix,
  // Only referenced (and therefore only imported) when devboxOrgAccess=true.
  ...(devboxOrgAccess && {
    auroraClusterArn: cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`),
    // The SELECT-only reader, not the master secret (DE-40).
    auroraReadOnlySecretArn: cdk.Fn.importValue(`${prefix}-aurora-readonly-secret-arn`),
    knowledgeBaseId: cdk.Fn.importValue(`${prefix}-knowledge-base-id`),
  }),
  // The lab loop, off unless an operator turns it on:
  //   cdk deploy OrgIQ-Devbox --context deployDevbox=true \
  //     --context labApiBase=https://<middleware-origin>
  // The runtime then gets LAB_CALLBACK_SECRET_ID (the name of
  // `<prefix>-lab-callback-secret`) and reads the value itself.
  // `labCallbackSecret=<value>` is the old plaintext path, refused unless
  // `--context plaintextCallbackSecrets=true` (one release).
  //
  // Without labApiBase the in-container `lab` CLI soft-exits at every session
  // start and the loop does nothing.
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

const middlewareService = new MiddlewareServiceStack(app, stackId(environment, 'MiddlewareService'), {
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

  // S3 buckets — ARNs for the IAM grants, names for the container env.
  // FoundationStack already exports both, so the names cost no new export.
  documentsBucketArn: cdk.Fn.importValue(`${prefix}-documents-bucket-arn`),
  artifactsBucketArn: cdk.Fn.importValue(`${prefix}-artifacts-bucket-arn`),
  documentsBucketName: cdk.Fn.importValue(`${prefix}-documents-bucket-name`),
  artifactsBucketName: cdk.Fn.importValue(`${prefix}-artifacts-bucket-name`),

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
  // The orgiq_app_middleware login, not the master (dbMasterSecret above).
  auroraCredentialsSecretArn: middlewareDbSecretArn,

  // AgentCore identifiers (from AgentCoreMemoryStack + KnowledgeBaseStack)
  browserId: agentCoreCapabilities.browserId,
  browserArn: agentCoreCapabilities.browserArn,
  // CODE_INTERPRETER_ID / BROWSER_PROFILE_ID by SSM name from the
  // capabilities stack (no import, no freeze) + the code-interpreter grant.
  capabilityParameters: true,
  ...(orgiqMemory && { memoryIdParameter: memoryIdParameterName(prefix, 'orgiq') }),
  tenantMemoryIdParameters: Object.fromEntries(
    agentCoreMemory.tenants.filter(t => t.tenant !== 'orgiq')
      .map(t => [t.tenant, memoryIdParameterName(prefix, t.tenant)])),
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
// The capability-id SSM parameters are read by name, which creates no CDK
// dependency (the PromptCanary race): they must exist before this deploys.
middlewareService.addDependency(agentCoreCapabilities);

// -------------------------------------------------------------------
// Stacks 16-18: Social calls (docs/social-calls-deploy-plan.md). All opt-in —
// none is in the app unless its flag is set, so `deploy.sh`'s default fleet is
// unchanged.
//
//   deploySocialImages=true  OrgIQ-SocialImages — three RETAIN ECR repos
//   deploySocialMedia=true   OrgIQ-SocialMedia  — the SFU on EC2 + Elastic IP
//                            (sfuAllowCidr, sfuImageDigest, socialPortalOrigin)
//   deploySocial=true        OrgIQ-Social       — platform-api, ElastiCache Redis, tables,
//                            the middleware's chat-table grant + REDIS_URL parameter
//                            (deploySocialService, platformApiImageDigest,
//                             socialPlatformHost, socialSfuHost, tableSuffix, …)
//
// The images stack joins the app whenever any social flag is set so `--all`
// orders it first; the service stacks import its repos BY NAME, so there is
// no export to freeze. OrgIQ-Social wires to the SFU only when
// OrgIQ-SocialMedia is in the same app (pass both flags on its deploy).
// -------------------------------------------------------------------
const ctxFlag = (key: string): boolean => {
  const v = app.node.tryGetContext(key);
  return v === true || v === 'true';
};
const deploySocialMedia = ctxFlag('deploySocialMedia');
const deploySocial = ctxFlag('deploySocial');
const deploySocialImages = ctxFlag('deploySocialImages') || deploySocialMedia || deploySocial;

const socialImages = deploySocialImages
  ? new SocialImagesStack(app, stackId(environment, 'SocialImages'), {
    env,
    prefix,
    description: 'OrgIQ Social images: ECR repos for the gateway, platform-api and the SFU (RETAIN)',
  })
  : undefined;

const socialMedia = deploySocialMedia
  ? new SocialMediaStack(app, stackId(environment, 'SocialMedia'), {
    env,
    prefix,
    vpc: middlewareService.vpc,
    cognitoUserPoolId: authentication.userPoolId,
    description: 'OrgIQ Social media: the mediasoup SFU on EC2 with an Elastic IP (allowlisted ingress)',
  })
  : undefined;
if (socialMedia) {
  socialMedia.addDependency(middlewareService);
  if (socialImages) socialMedia.addDependency(socialImages);
}

if (deploySocial) {
  const social = new SocialStack(app, stackId(environment, 'Social'), {
    env,
    prefix,
    vpc: middlewareService.vpc,
    cluster: middlewareService.cluster,
    listener: middlewareService.listener,
    loadBalancerSecurityGroupId: middlewareService.loadBalancerSecurityGroupId,
    middlewareSecurityGroupId: middlewareService.serviceSecurityGroupId,
    middlewareTaskRoleName: middlewareService.taskRoleName,
    cognitoUserPoolId: authentication.userPoolId,
    cognitoClientId: authentication.userPoolClientId,
    ...(socialMedia && {
      sfu: {
        privateIp: socialMedia.privateIp,
        instanceId: socialMedia.instance.instanceId,
        securityGroupId: socialMedia.securityGroup.securityGroupId,
      },
    }),
    description: 'OrgIQ Social: platform-api on Fargate, Redis, and the call-path DynamoDB tables',
  });
  social.addDependency(middlewareService);
  social.addDependency(authentication);
  if (socialImages) social.addDependency(socialImages);
  if (socialMedia) social.addDependency(socialMedia);
}

// -------------------------------------------------------------------
// Stack 19: Portal (opt-in) — the portal bundle on S3 behind CloudFront, and
// HTTPS without a domain: CloudFront's *.cloudfront.net certificate fronts
// the middleware (/api, /ws), and, with the social flags, platform-api and
// the SFU's signalling on their own distributions (lib/portal-stack.ts).
//
//   deployPortal=true        OrgIQ-Portal, plus the ALB side on the middleware
//                            and social stacks (prefix list, origin secret,
//                            header rules) — pass it to every one of them.
//                            Needs certificateArn + portalAlbOriginHost: the
//                            CloudFront → ALB leg is refused over plain HTTP
//                            unless allowHttpOrigin=true (throwaway stacks)
//   portalPublicUrls=true    a LATER middleware deploy: read the public URLs
//                            back from OrgIQ-Portal's SSM parameters
//   portalPublicUrl=https://…  Cognito callback/sign-out + the runtimes'
//                            MIDDLEWARE_URL (copied from the PortalUrl output)
//
// It imports only `<prefix>-middleware-alb-dns`, an export the middleware
// has always had, and the origin secret BY NAME — no new export to freeze.
// -------------------------------------------------------------------
if (ctxFlag('deployPortal')) {
  const portal = new PortalStack(app, stackId(environment, 'Portal'), {
    env,
    prefix,
    stackPrefix: environment.stackPrefix,
    loadBalancerDnsName: cdk.Fn.importValue(`${prefix}-middleware-alb-dns`),
    platformApi: deploySocial,
    sfu: deploySocialMedia,
    description: 'OrgIQ Portal: S3 + CloudFront for the portal, HTTPS in front of the middleware, platform-api and SFU signalling',
  });
  portal.addDependency(middlewareService);
}

// cdk-nag AwsSolutions over every stack, with the reviewed suppressions in
// infra/nag-suppressions.ts (`--context nag=false` to skip, `nag=true` to
// require it). See lib/nag.ts.
applyNag(app, app.node.children.filter((c): c is cdk.Stack => c instanceof cdk.Stack));

app.synth();
