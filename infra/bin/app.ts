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
// Stack 2: Aurora Serverless v2 (pgvector + Apache AGE)
// Replaces Neptune Analytics and OpenSearch Serverless.
// Idle cost: ~$0.06/hr (0.5 ACU min). Enable with: cdk deploy OrgIQ-Aurora
// -------------------------------------------------------------------
const aurora = new AuroraStack(app, 'OrgIQ-Aurora', {
  env,
  prefix,
  agentRoleArn: foundation.agentBaseRole.roleArn,
  description: 'OrgIQ Aurora: Serverless v2 PostgreSQL with pgvector + Apache AGE graph',
});
aurora.addDependency(foundation);

// -------------------------------------------------------------------
// Stack 3: Knowledge Base (Bedrock KB backed by Aurora pgvector)
// -------------------------------------------------------------------
const knowledgeBase = new KnowledgeBaseStack(app, 'OrgIQ-KnowledgeBase', {
  env,
  prefix,
  documentsBucket: foundation.documentsBucket,
  agentRoleArn: foundation.agentBaseRole.roleArn,
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
// Stack 5: Agents (per-agent IAM roles + Managed Prompts)
// -------------------------------------------------------------------
const agents = new AgentsStack(app, 'OrgIQ-Agents', {
  env,
  prefix,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
  guardrailArn: guardrails.guardrailArn,
  documentsBucketArn: foundation.documentsBucket.bucketArn,
  artifactsBucketArn: foundation.artifactsBucket.bucketArn,
  scoresTableArn: foundation.scoresTable.tableArn,
  sessionsTableArn: foundation.sessionsTable.tableArn,
  description: 'OrgIQ Agents: IAM roles for 6 AgentCore agents + Managed Prompts',
});
agents.addDependency(foundation);
agents.addDependency(aurora);
agents.addDependency(knowledgeBase);
agents.addDependency(guardrails);

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
  guardrailArn: guardrails.guardrailArn,
  description: 'OrgIQ AgentCore Policy: Cedar-based access control for agent tools',
});
agentCorePolicy.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 9: AgentCore Runtime (6 agent runtimes)
// -------------------------------------------------------------------
const agentCoreRuntime = new AgentCoreRuntimeStack(app, 'OrgIQ-AgentCoreRuntime', {
  env,
  prefix,
  agentRoles: agents.agentRoles,
  memoryId: agentCoreMemory.memoryId,
  guardrailId: guardrails.guardrailId,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  description: 'OrgIQ AgentCore Runtime: 6 agent runtimes with lifecycle and endpoint config',
});
agentCoreRuntime.addDependency(agents);
agentCoreRuntime.addDependency(agentCoreMemory);
agentCoreRuntime.addDependency(aurora);
agentCoreRuntime.addDependency(knowledgeBase);
agentCoreRuntime.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 10: AgentCore MCP Gateway
// -------------------------------------------------------------------
const agentCoreGateway = new AgentCoreGatewayStack(app, 'OrgIQ-AgentCoreGateway', {
  env,
  prefix,
  auroraClusterArn: aurora.clusterArn,
  auroraCredentialsSecretArn: aurora.credentialsSecretArn,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  policyEngineId: agentCorePolicy.policyEngineId,
  agentRoles: agents.agentRoles,
  artifactsBucketArn: foundation.artifactsBucket.bucketArn,
  description: 'OrgIQ AgentCore Gateway: MCP Gateway with Lambda tools + agent-as-tool targets',
});
agentCoreGateway.addDependency(agentCorePolicy);
agentCoreGateway.addDependency(agentCoreRuntime);
agentCoreGateway.addDependency(aurora);
agentCoreGateway.addDependency(knowledgeBase);

app.synth();
