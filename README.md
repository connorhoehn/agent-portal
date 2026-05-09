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

Requires AWS credentials via SSO — run `aws sso login --profile bedrock` first.

## Demo Portal

The portal (http://localhost:5183) provides the following pages:

| Page | Path | Description |
|------|------|-------------|
| Agent Flow | `/agents` | Visualize multi-agent orchestration |
| Org Graph | `/graph` | Interactive knowledge graph explorer |
| Search | `/search` | Conversational expertise search |
| Invoke | `/invoke` | Direct agent invocation |
| Scores | `/scores` | Expertise scoring leaderboards |
| Ingest | `/ingest` | Document upload and processing |
| Observability | `/observability` | Agent traces and metrics |

## Notebooks

Progressive walkthrough of every AgentCore capability:

| # | Notebook | Topic |
|---|----------|-------|
| 00 | `00-index` | Index and overview |
| 01 | `01-setup-credentials` | AWS credentials and SDK setup |
| 02 | `02-neptune-graph` | Neptune Analytics graph (openCypher) |
| 03 | `03-embeddings` | Titan Embeddings V2 (1024d) |
| 04 | `04-knowledge-base` | Bedrock Knowledge Base + OpenSearch |
| 05 | `05-guardrails` | Bedrock Guardrails |
| 06 | `06-strands-agent` | Strands Agents framework |
| 07 | `07-agentcore-memory` | AgentCore Memory service |
| 08 | `08-agentcore-gateway` | MCP Gateway + tool routing |
| 09 | `09-agentcore-policy` | Policy Engine (Cedar) |
| 10 | `10-agentcore-identity` | Identity and credentials |
| 11 | `11-ag-ui-streaming` | AG-UI protocol streaming |
| 12 | `12-a2a-protocol` | Agent-to-Agent communication |
| 13 | `13-scoring` | Expertise scoring algorithms |
| 14 | `14-deploy-runtime` | Deploy agents to AgentCore Runtime |
| 15 | `15-evaluations` | Agent evaluation framework |
| 16 | `16-cleanup` | Resource teardown |

## AWS Services Used

- **Amazon Bedrock AgentCore** — Agent runtime (microVM), MCP Gateway, Memory, Policy Engine, Identity
- **Amazon Bedrock** — Foundation models (Claude), Guardrails, Knowledge Bases, Managed Prompts, Flows
- **Amazon Neptune Analytics** — Graph database for organizational knowledge (openCypher)
- **Amazon OpenSearch Serverless** — Vector search backing Bedrock Knowledge Bases
- **Amazon S3** — Document storage and artifact persistence
- **Amazon DynamoDB** — Scores, sessions, and leaderboard tables
- **AWS CDK** — Infrastructure as code (TypeScript stacks)
- **Amazon CloudWatch** — Dashboards, metrics, and budget alarms
- **Amazon Titan Embeddings V2** — 1024-dimension vector embeddings
- **AWS IAM** — Fine-grained roles for agents and services
