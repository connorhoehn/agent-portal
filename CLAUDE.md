# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator. Multi-agent system
on Amazon Bedrock AgentCore: ingests org docs → builds knowledge graph → scores
expertise → serves conversational search. See CONSTITUTION.md for full spec.

## Architecture

- **notebooks/** — JupyterLab exploration (Python 3.12, boto3, bedrock-agentcore SDK)
- **agents/** — 9 Strands Agents (6 OrgIQ + 3 newsroom), Python 3.12, deployed to AgentCore Runtime via multistage Docker. Shared helpers in `agents/_shared/`; common base image in `agents/base/`
- **infra/** — CDK TypeScript stacks (Aurora, OpenSearch, Guardrails, KB, AgentCore Memory/Policy/Capabilities/Runtime/Gateway/Telemetry, Authorization, SpanProjector)
- **middleware/** — Express + distributed-core (AG-UI SSE proxy, RDS Data API queries against Aurora, WebSocket bridge, OI trace sink)
- **portal/** — React 19 + Vite 7 (ui-components library, @xyflow/react for graphs)
- **schema/** — Aurora SQL (`orgiq_schema.sql` + newsroom + observability) and LLM-driven synth corpus pipeline

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

Requires `~/.aws` credentials via SSO. Run `aws sso login` first (only the `default` profile is configured locally — account `264161986065`).

## Key SDKs

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.39 | Agent framework (@tool, Agent, stream_async) |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` | >=0.1.18 | AG-UI event types + SSE encoder |
| `ag-ui-strands` | >=0.1.8 | Strands → AG-UI adapter (StrandsAgent) |
| `boto3` | >=1.34 | Bedrock, RDS Data API (Aurora), S3, DynamoDB, OpenSearch, Verified Permissions |
| `@aws/agentcore` | latest | AgentCore CLI (npm global install) |

## CDK vs AgentCore CLI — what deploys what

| Resource | Deployed by |
|----------|-------------|
| Aurora Serverless v2 cluster (PostgreSQL + pgvector) | CDK (`OrgIQ-Aurora`) |
| OpenSearch Serverless + Bedrock KB | CDK (`CfnKnowledgeBase`) |
| Bedrock Guardrails | CDK (`CfnGuardrail`) |
| Verified Permissions policy store + Cedar policies | CDK (`OrgIQ-Authorization`) |
| S3 buckets, DynamoDB tables, IAM roles | CDK (`OrgIQ-Foundation`) |
| CloudWatch dashboards + budget alarm | CDK (`OrgIQ-Observability`) |
| Agent ECR repos + execution roles (6 originals) | CDK (`OrgIQ-Agents` — phase 1) |
| Agent Runtime (CfnRuntime + CfnRuntimeEndpoint, all 9 agents) | CDK with `--context deployRuntimes=true` (`OrgIQ-AgentCoreRuntime`) |
| MCP Gateway + targets + Cedar policies | CDK (`CfnGateway`, `CfnGatewayTarget`, `CfnPolicy`) |
| AgentCore Memory | CDK (`CfnMemory`) |
| AgentCore Policy Engine | CDK (`CfnPolicyEngine`) |
| AgentCore Capabilities (Code Interpreter, Browser, Workload Identity) | CDK (`OrgIQ-AgentCoreCapabilities`) |
| Custom Evaluators + Online Evaluation | CDK (`CfnEvaluator`, `CfnOnlineEvaluationConfig`) |
| Online Evaluation (enable after runtimes) | CDK with `--context enableEval=true` |
| Span Projector Lambda (OpenInference → Aurora observability tables) | CDK (`OrgIQ-SpanProjector`) |

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
- Cedar policies live in **Verified Permissions** (`OrgIQ-Authorization` stack); the supervisor resolves a role per request and attaches the role-specific guardrail at model-build time
- All notebooks share `config.json` for cross-notebook state (progressive enrichment)
- Resource tracker (`cleanup_utils.py`) tracks all AWS resources for safe teardown
- `INSERT ... ON CONFLICT DO UPDATE` for idempotent upserts (handled by graph-builder `merge_*` tools)
- Scores stored as columns on `people` (expertise_score, pagerank_score, composite_score)
- Titan Embeddings V2 at 1024 dimensions everywhere (`node_embeddings` table in Aurora + Bedrock KB)
- **Newsroom agents** (`news-researcher`, `news-brief`, `news-headline`) are demo-surface agents deployed alongside the 6 OrgIQ agents. They read from Aurora and write to `newsroom_*` tables (`schema/newsroom_schema.sql`)
- **OpenInference instrumentation** lives in `agents/_shared/instrumentation.py` (root AGENT span, RETRIEVER spans, guardrail capture). Spans are exported via ADOT and projected into Aurora observability tables by the `OrgIQ-SpanProjector` Lambda
- Default model is `amazon.nova-pro-v1:0`, overridable per agent via `MODEL_ID` env var (AWS-native only — no Anthropic models)

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
- CDK stack names: `OrgIQ-Foundation`, `OrgIQ-Aurora`, `OrgIQ-KnowledgeBase`, `OrgIQ-Guardrails`, `OrgIQ-Authorization`, `OrgIQ-Agents`, `OrgIQ-Observability`, `OrgIQ-AgentCoreMemory`, `OrgIQ-AgentCorePolicy`, `OrgIQ-AgentCoreCapabilities`, `OrgIQ-AgentCoreRuntime`, `OrgIQ-AgentCoreGateway`, `OrgIQ-AgentCoreTelemetry`, `OrgIQ-SpanProjector`
- Agent names: `orgiq-supervisor`, `orgiq-search`, `orgiq-scoring`, `orgiq-advisor`,
  `orgiq-ingestion`, `orgiq-graph-builder`, `orgiq-news-researcher`, `orgiq-news-brief`, `orgiq-news-headline`
- DynamoDB tables: `orgiq-scores`, `orgiq-sessions`, `orgiq-leaderboards`
- S3 buckets: `orgiq-documents-{account}-{region}`, `orgiq-artifacts-{account}-{region}`

## Common workflows

```bash
# Deploy all infrastructure (14 stacks) — cleans up orphaned resources first
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

# Generate the synthetic demo corpus (personas, ADRs, postmortems, perf reviews,
# Slack threads, all-hands recaps, ~50 news articles, NER, clusters, pitches).
# Requires Aurora + KB deployed and schema/seed.py applied first.
python3.11 -m venv .venv-synth && .venv-synth/bin/pip install -r schema/synth/requirements.txt
.venv-synth/bin/python -m schema.synth all                # full pipeline
.venv-synth/bin/python -m schema.synth all --skip-load    # generate only, no Aurora/S3/KB writes
.venv-synth/bin/python -m schema.synth stats              # corpus + cache snapshot
```

## Synthetic corpus pipeline (`schema/synth/`)

Generates a complete demo corpus from the seed graph using AWS-native models.
Reads people/teams/skills/projects/decisions from Aurora, writes documents +
mentions + newsroom (entities, clusters, pitches) + node_embeddings back. Per-doc
disk cache makes reruns free. `verify_*.py` scripts spend real Bedrock $ — don't
run them casually. Cost ballpark: ~$0.50 per full demo-grade run (213 docs).

## Gotchas

- Aurora does NOT support Apache AGE — the graph is modeled as relational tables, not Cypher. Schema in `schema/orgiq_schema.sql`.
- AgentCore Runtime is deployed via CDK `CfnRuntime` gated on `--context deployRuntimes=true`. Do NOT use the standalone `agentcore deploy` CLI for cloud deploys; it'll drift from the CDK source of truth. (`agentcore dev` is still the right tool for local hot-reload.)
- Span projection runs on a schedule (Lambda) — span data in the Aurora `observability_*` tables can lag CloudWatch by a few minutes. If `OBS_USE_LEGACY_POLLER=true`, the middleware polls CloudWatch directly instead.
- AgentCore Runtime requires ARM64 Docker images. Local `agentcore dev` runs on host arch.
- `agentcore deploy` uses remote CodeBuild — no local Docker needed for deployment.
- AG-UI uses POST for SSE (not GET EventSource). Frontend must use fetch + ReadableStream.
- Titan Embeddings V2 dimension must be specified at embedding time AND match the `vector(1024)` column type.
- OpenSearch Serverless has 2 OCU minimum billing even when idle. Budget alarm is critical.
- Aurora Serverless v2 has a 0.5-ACU minimum that bills even when idle (~$45/mo). The cluster also takes 10–20s to scale up from a cold call. `./scripts/destroy.sh` pre-drains it before stack teardown.
- `@connorhoehnslalom/ui-components` requires `GITHUB_TOKEN` env var for npm install to work.
