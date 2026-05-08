#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { NeptuneStack } from '../lib/neptune-stack';
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
// Stack 2: Neptune Analytics (knowledge graph with vector search)
// -------------------------------------------------------------------
const neptune = new NeptuneStack(app, 'OrgIQ-Neptune', {
  env,
  prefix,
  agentRoleArn: foundation.agentBaseRole.roleArn,
  description: 'OrgIQ Neptune: Analytics graph with 1024d vector search (openCypher)',
});
neptune.addDependency(foundation);

// -------------------------------------------------------------------
// Stack 3: Knowledge Base (OpenSearch Serverless + Bedrock KB)
// -------------------------------------------------------------------
const knowledgeBase = new KnowledgeBaseStack(app, 'OrgIQ-KnowledgeBase', {
  env,
  prefix,
  documentsBucket: foundation.documentsBucket,
  agentRoleArn: foundation.agentBaseRole.roleArn,
  description: 'OrgIQ Knowledge Base: OpenSearch Serverless + Bedrock KB + S3 data source',
});
knowledgeBase.addDependency(foundation);

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
  neptuneGraphArn: neptune.graphArn,
  knowledgeBaseArn: `arn:aws:bedrock:${env.region}:${env.account}:knowledge-base/${knowledgeBase.knowledgeBaseId}`,
  guardrailArn: guardrails.guardrailArn,
  documentsBucketArn: foundation.documentsBucket.bucketArn,
  artifactsBucketArn: foundation.artifactsBucket.bucketArn,
  scoresTableArn: foundation.scoresTable.tableArn,
  sessionsTableArn: foundation.sessionsTable.tableArn,
  description: 'OrgIQ Agents: IAM roles for 6 AgentCore agents + Managed Prompts',
});
agents.addDependency(foundation);
agents.addDependency(neptune);
agents.addDependency(knowledgeBase);
agents.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 6: Observability (CloudWatch dashboard + budget alarm)
// -------------------------------------------------------------------
const observability = new ObservabilityStack(app, 'OrgIQ-Observability', {
  env,
  prefix,
  neptuneGraphId: neptune.graphId,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  monthlyBudgetUsd,
  alertEmail,
  description: 'OrgIQ Observability: CloudWatch dashboard + budget alarms',
});
observability.addDependency(neptune);
observability.addDependency(knowledgeBase);

// ===================================================================
// AgentCore Feature Stacks
// ===================================================================

// -------------------------------------------------------------------
// Stack 7: AgentCore Memory (semantic, user preference, summary strategies)
// -------------------------------------------------------------------
const agentCoreMemory = new AgentCoreMemoryStack(app, 'OrgIQ-AgentCoreMemory', {
  env,
  prefix,
  description: 'OrgIQ AgentCore Memory: semantic, user preference, and summary memory strategies',
});

// -------------------------------------------------------------------
// Stack 8: AgentCore Policy Engine (Cedar policies for access control)
// -------------------------------------------------------------------
const agentCorePolicy = new AgentCorePolicyStack(app, 'OrgIQ-AgentCorePolicy', {
  env,
  prefix,
  guardrailArn: guardrails.guardrailArn,
  description: 'OrgIQ AgentCore Policy: Cedar-based access control for agent tools',
});
agentCorePolicy.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 9: AgentCore Runtime (6 agent runtimes with endpoints)
// -------------------------------------------------------------------
const agentCoreRuntime = new AgentCoreRuntimeStack(app, 'OrgIQ-AgentCoreRuntime', {
  env,
  prefix,
  agentRoles: agents.agentRoles,
  memoryId: agentCoreMemory.memoryId,
  guardrailId: guardrails.guardrailId,
  neptuneGraphId: neptune.graphId,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  description: 'OrgIQ AgentCore Runtime: 6 agent runtimes with lifecycle and endpoint config',
});
agentCoreRuntime.addDependency(agents);
agentCoreRuntime.addDependency(agentCoreMemory);
agentCoreRuntime.addDependency(neptune);
agentCoreRuntime.addDependency(knowledgeBase);
agentCoreRuntime.addDependency(guardrails);

// -------------------------------------------------------------------
// Stack 10: AgentCore MCP Gateway (tool registry + agent-as-tool targets)
// -------------------------------------------------------------------
const agentCoreGateway = new AgentCoreGatewayStack(app, 'OrgIQ-AgentCoreGateway', {
  env,
  prefix,
  neptuneGraphId: neptune.graphId,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
  policyEngineId: agentCorePolicy.policyEngineId,
  agentRoles: agents.agentRoles,
  artifactsBucketArn: foundation.artifactsBucket.bucketArn,
  description: 'OrgIQ AgentCore Gateway: MCP Gateway with Lambda tools + agent-as-tool targets',
});
agentCoreGateway.addDependency(agentCorePolicy);
agentCoreGateway.addDependency(agentCoreRuntime);
agentCoreGateway.addDependency(neptune);
agentCoreGateway.addDependency(knowledgeBase);

app.synth();
