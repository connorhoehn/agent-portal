# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator. Multi-agent system
on Amazon Bedrock AgentCore: ingests org docs → builds knowledge graph → scores
expertise → serves conversational search. See CONSTITUTION.md for full spec.

## Architecture

- **notebooks/** — JupyterLab exploration (Python 3.12, boto3, bedrock-agentcore SDK)
- **agents/** — 6 Strands Agents (Python 3.12, deployed to AgentCore Runtime via multistage Docker)
- **infra/** — CDK TypeScript stacks (Neptune, OpenSearch, Guardrails, KB, Flows)
- **middleware/** — Express + distributed-core (AG-UI SSE proxy, Neptune queries, WebSocket bridge)
- **portal/** — React 19 + Vite 7 (ui-components library, @xyflow/react for graphs)

## Local dev

```bash
docker-compose up --build            # jupyter + middleware + portal
docker-compose up jupyter            # Just notebooks at :8888
docker-compose up middleware portal  # App stack at :3001 + :5183
```

**Agents are NOT in docker-compose.** Develop agents with:
```bash
cd agents/<name> && agentcore dev    # Hot-reload local server at :8080
```

Requires `~/.aws` credentials via SSO. Run `aws sso login --profile bedrock` first.

## Key SDKs

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.39 | Agent framework (@tool, Agent, stream_async) |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` | >=0.1.18 | AG-UI event types + SSE encoder |
| `ag-ui-strands` | >=0.1.8 | Strands → AG-UI adapter (StrandsAgent) |
| `boto3` | >=1.34 | Neptune, Bedrock, S3, DynamoDB, OpenSearch |
| `@aws/agentcore` | latest | AgentCore CLI (npm global install) |

## CDK vs AgentCore CLI — what deploys what

| Resource | Deployed by |
|----------|-------------|
| Neptune Analytics graph | CDK (`CfnGraph`) |
| OpenSearch Serverless + Bedrock KB | CDK (`CfnKnowledgeBase`) |
| Bedrock Guardrails | CDK (`CfnGuardrail`) |
| Managed Prompts | CDK (`CfnPrompt`) |
| Bedrock Flows | CDK (`CfnFlow`) |
| S3 buckets, DynamoDB tables | CDK |
| IAM roles | CDK |
| CloudWatch dashboards + budget alarm | CDK |
| Agent Runtime (ECR repos + execution roles) | CDK (`CfnRuntime` — phase 1) |
| Agent Runtime (CfnRuntime + CfnRuntimeEndpoint) | CDK with `--context deployRuntimes=true` |
| MCP Gateway + targets + Cedar policies | CDK (`CfnGateway`, `CfnGatewayTarget`, `CfnPolicy`) |
| AgentCore Memory | CDK (`CfnMemory`) |
| AgentCore Policy Engine | CDK (`CfnPolicyEngine`) |
| Custom Evaluators + Online Evaluation | CDK (`CfnEvaluator`, `CfnOnlineEvaluationConfig`) |
| Online Evaluation (enable after runtimes) | CDK with `--context enableEval=true` |

## Agent Dockerfile requirements (AgentCore Runtime)

- Multistage: `uv` builder → `python:3.12-slim` production
- Non-root user: `bedrock_agentcore` (UID 1000)
- Ports: 8080 (HTTP/AG-UI invocations), 8000 (health/MCP)
- Health check: `GET /ping`
- CMD: `opentelemetry-instrument python -m main`
- Max image size: 1 GB
- ARM64 architecture at deploy (CodeBuild handles this)

## Conventions

- TypeScript strict mode for middleware, infra, portal
- Python 3.12+ for agents and notebooks
- Org graph lives in Aurora PostgreSQL as relational tables (no Neptune, no AGE — see `schema/orgiq_schema.sql`)
- Graph access via RDS Data API + parameterized SQL. Read tools enforce SELECT/WITH only.
- AG-UI protocol for agent→frontend streaming (16 event types, SSE transport)
- A2A protocol for agent→agent communication
- Cedar for policy authoring (natural language → Cedar via AgentCore Policy)
- All notebooks share `config.json` for cross-notebook state (progressive enrichment)
- Resource tracker (`cleanup_utils.py`) tracks all AWS resources for safe teardown
- `INSERT ... ON CONFLICT DO UPDATE` for idempotent upserts (handled by graph-builder `merge_*` tools)
- Scores stored as columns on `people` (expertise_score, pagerank_score, composite_score)
- Titan Embeddings V2 at 1024 dimensions everywhere (`node_embeddings` table in Aurora + Bedrock KB)

## Existing project dependencies

- **ui-components** (`~/projects/ui-components`): Published to GitHub Packages as
  `@connorhoehnslalom/ui-components`. Portal consumes via `.npmrc` with GitHub token.
  Peer deps: react 19, @xyflow/react 12, recharts 3, yjs 13, @tiptap/react 3.

- **distributed-core** (`~/projects/distributed-core`): WebSocketAdapter + EventBus.
  Imported as `"distributed-core": "github:connorhoehn/distributed-core#main"` in
  middleware package.json (same pattern as platform-api).

**Do NOT modify ui-components or distributed-core from this repo.** Consume as libraries.
If you need new features in those packages, note it as a TODO — don't cross-repo edit.

## Portal .npmrc setup

```
@connorhoehnslalom:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Naming conventions

- AWS resources: prefix `orgiq-` (e.g., `orgiq-knowledge-base`, `orgiq-aurora`)
- CDK stack names: `OrgIQ-Foundation`, `OrgIQ-Neptune`, `OrgIQ-KnowledgeBase`, etc.
- Agent names: `orgiq-supervisor`, `orgiq-search`, `orgiq-scoring`, `orgiq-advisor`,
  `orgiq-ingestion`, `orgiq-graph-builder`
- DynamoDB tables: `orgiq-scores`, `orgiq-sessions`, `orgiq-leaderboards`
- S3 buckets: `orgiq-documents-{account}-{region}`, `orgiq-artifacts-{account}-{region}`

## Common workflows

```bash
# Deploy all infrastructure (11 stacks) — cleans up orphaned resources first
cd infra && ./scripts/deploy.sh

# Deploy a single stack
cd infra && ./scripts/deploy.sh OrgIQ-Aurora

# Phase 2: deploy runtimes after pushing container images to ECR
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true

# Enable online evaluation after runtimes are running
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreTelemetry --context enableEval=true

# Destroy everything — drains Cedar policies and orphan gateways first
cd infra && ./scripts/destroy.sh

# Run CDK synth (dry-run)
cd infra && npx cdk synth

# Invoke deployed agent
agentcore invoke --agent orgiq-supervisor --prompt "Who knows auth best?"

# Test agent locally
cd agents/search && agentcore dev "Find Kubernetes experts"
```

## Gotchas

- Aurora does NOT support Apache AGE — the graph is modeled as relational tables, not Cypher. Schema in `schema/orgiq_schema.sql`.
- AgentCore Runtime requires ARM64 Docker images. Local `agentcore dev` runs on host arch.
- `agentcore deploy` uses remote CodeBuild — no local Docker needed for deployment.
- AG-UI uses POST for SSE (not GET EventSource). Frontend must use fetch + ReadableStream.
- Titan Embeddings V2 dimension must be specified at embedding time AND match the `vector(1024)` column type.
- OpenSearch Serverless has 2 OCU minimum billing even when idle. Budget alarm is critical.
- Neptune Analytics billing is per-NCU-hour even when idle. Shut down via CDK destroy when not in use.
- `@connorhoehnslalom/ui-components` requires `GITHUB_TOKEN` env var for npm install to work.
