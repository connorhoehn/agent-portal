# OrgIQ — Organizational Intelligence Platform

Multi-agent system built on Amazon Bedrock AgentCore that ingests organizational documents, builds a knowledge graph, scores expertise, and serves conversational search. Designed as an accelerator for enterprise teams looking to surface "who knows what" across their organization.

## Quick Start

```bash
docker-compose up --build
```

This starts three services:

| Service | URL | Description |
|---------|-----|-------------|
| Jupyter | http://localhost:8888 | SDK exploration notebooks |
| Middleware | http://localhost:3001 | Express API + AG-UI SSE proxy |
| Portal | http://localhost:5183 | React frontend |

Requires AWS credentials — run `aws-azure-login --mode gui` first. The `default` profile targets the innovation lab account `647757222309` (us-east-1).

## Demo Portal

The portal (http://localhost:5183) is organized into two tenants — the IQ
workspace (analyst-facing) and Admin (operator-facing) — plus a Newsroom demo
surface. Headline pages:

| Area | Path | Description |
|------|------|-------------|
| Agent Flow | `/agents` | Multi-agent orchestration visualizer |
| Org Graph | `/graph` (Explore) | Interactive Aurora graph explorer |
| Search | `/search` | Conversational expertise search (AG-UI streaming) |
| Scores | `/scores`, `/scores/cohort`, `/scores/compare` | Expertise leaderboards + cohort/compare views |
| Projects | `/projects`, `/projects/:id` | Project portfolio + drill-down |
| Decisions | `/decisions`, `/decisions/:id` | ADR/decision log |
| Knowledge Base | `/knowledge-base` | KB sources, sync status, retrieval test |
| Invoke | `/invoke` | Direct agent invocation |
| Code Interpreter | `/code-interpreter` | Sandboxed Python demo |
| Capabilities | `/capabilities/*` | AgentCore primitives: Browser, Code Interpreter, Guardrails, Memory |
| Identity | `/identity/*` | Cedar policies, role assignment, schema, policy testing |
| Ingest | `/ingest/*` | Sources, schedules, crawl targets, run history, storage |
| Newsroom | `/newsroom/*` | News researcher/brief/headline demo: articles, briefs, beats, entities |
| Observability | `/observability/*` | Invocations, traces, sessions, cost, drift, calibration, on-call, traffic, quality, model compare, approval queue, harness |
| Admin | `/admin/*` | Tenant + role configuration |
| Settings | `/settings` | Local dev settings |

## Notebooks

Progressive walkthrough of every AgentCore capability:

| # | Notebook | Topic |
|---|----------|-------|
| 00 | `00-index` | Index and overview |
| 01 | `01-setup-credentials` | AWS credentials and SDK setup |
| 02 | `02-aurora-graph` | Aurora PostgreSQL org-graph (relational + pgvector) |
| 03 | `03-embeddings` | Titan Embeddings V2 (1024d) |
| 04 | `04-knowledge-base` | Bedrock Knowledge Base + OpenSearch |
| 05 | `05-guardrails` | Bedrock Guardrails |
| 06 | `06-strands-agent` | Strands Agents framework |
| 07 | `07-agentcore-memory` | AgentCore Memory service |
| 08 | `08-agentcore-gateway` | MCP Gateway + tool routing |
| 09 | `09-agentcore-policy` | Policy Engine (Cedar) |
| 10 | `10-agentcore-identity` | Identity and credentials |
| 11 | `11-code-execution` | AgentCore Code Interpreter (sandboxed Python) |
| 12 | `12-ag-ui-streaming` | AG-UI protocol streaming |
| 13 | `13-a2a-protocol` | Agent-to-Agent communication |
| 14 | `14-scoring` | Expertise scoring algorithms |
| 15 | `15-deploy-runtime` | Deploy agents to AgentCore Runtime |
| 16 | `16-evaluations` | Agent evaluation framework |
| 17 | `17-telemetry` | OpenInference spans → ADOT → CloudWatch → Aurora |
| 18 | `18-fairness` | Statistical fairness (DI ratio, SPD), LLM-as-judge bias check, Bedrock Model Evaluation (BOLD) |
| 19 | `19-cleanup` | Resource teardown |
| 20 | `20-coding-agent` | Devbox: Claude Code hosted in an AgentCore Runtime microVM — session storage, command API, interactive shell |

## AWS Services Used

- **Amazon Bedrock AgentCore** — Runtime (microVM), MCP Gateway, Memory, Policy Engine, Identity, Code Interpreter, Browser
- **Amazon Bedrock** — Foundation models (Nova Pro), Guardrails, Knowledge Bases, Managed Prompts
- **Amazon Aurora Serverless v2** — PostgreSQL 16 + `pgvector` for the org-graph (relational tables + 1024d embeddings)
- **Amazon OpenSearch Serverless** — Vector search backing Bedrock Knowledge Bases
- **Amazon Verified Permissions** — Cedar policy evaluation for tenant + role authorization
- **Amazon S3** — Document storage and artifact persistence
- **Amazon DynamoDB** — Scores, sessions, and leaderboard tables
- **AWS CDK** — Infrastructure as code (14 TypeScript stacks)
- **AWS Lambda** — Span projector (OpenInference → Aurora)
- **Amazon CloudWatch + ADOT** — Dashboards, OpenInference traces, budget alarms
- **Amazon Titan Embeddings V2** — 1024-dimension vector embeddings
- **AWS IAM** — Fine-grained roles for agents and services
