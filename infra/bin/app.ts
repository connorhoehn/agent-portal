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
import { OtelCollectorStack } from '../lib/otel-collector-stack';

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
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
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
  knowledgeBaseId: cdk.Fn.importValue(`${prefix}-knowledge-base-id`),
  codeInterpreterId: cdk.Fn.importValue(`${prefix}-code-interpreter-id`),
  codeInterpreterArn: cdk.Fn.importValue(`${prefix}-code-interpreter-arn`),
  browserId: cdk.Fn.importValue(`${prefix}-browser-id`),
  browserArn: cdk.Fn.importValue(`${prefix}-browser-arn`),
  browserProfileId: cdk.Fn.importValue(`${prefix}-browser-profile-id`),
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
// Stack 13: OTel Collector (ADOT on ECS Fargate — OI phase 2)
// Receives OTLP gRPC + HTTP from agent runtimes, exports to CloudWatch
// Logs (/orgiq/otel/spans) and X-Ray. Phase 3 span projector will
// subscribe to the log group exported by this stack.
// -------------------------------------------------------------------
new OtelCollectorStack(app, 'OrgIQ-OTelCollector', {
  env,
  // FoundationStack does not export a VPC; the collector falls back to the
  // account's default VPC. Pass a vpc prop here once a shared VPC is available.
  stage: 'dev',
  description: 'OrgIQ OTel Collector: ADOT Fargate service exporting OTLP spans to CloudWatch + X-Ray',
});

app.synth();
