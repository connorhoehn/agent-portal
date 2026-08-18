# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator. Multi-agent system
on Amazon Bedrock AgentCore: ingests org docs → builds knowledge graph → scores
expertise → serves conversational search. See CONSTITUTION.md for full spec.

## Architecture

- **notebooks/** — JupyterLab exploration. Split by cloud: `notebooks/aws/` (Python 3.12, boto3, bedrock-agentcore SDK) and `notebooks/gcp/` (Python 3.12, google-cloud-aiplatform, vertexai, google-genai). Both mount under `/workspace` so the file browser sees both flavors.
- **agents/** — 9 Strands Agents (6 OrgIQ + 3 newsroom), Python 3.12, deployed to AgentCore Runtime via multistage Docker. Shared helpers in `agents/_shared/`; common base image in `agents/base/`
- **infra/** — CDK TypeScript stacks (Aurora, OpenSearch, Guardrails, KB, AgentCore Memory/Policy/Capabilities/Runtime/Gateway/Telemetry, Authorization, SpanProjector)
- **middleware/** — Express + distributed-core (AG-UI SSE proxy, RDS Data API queries against Aurora, WebSocket bridge, OI trace sink)
- **portal/** — React 19 + Vite 7 (ui-components library, @xyflow/react for graphs)
- **schema/** — Aurora SQL (`orgiq_schema.sql` + newsroom + observability) and LLM-driven synth corpus pipeline

## Local dev

```bash
docker-compose up --build            # jupyter + middleware + portal
docker-compose up jupyter            # AWS notebooks at :8888 (cd /workspace/aws)
docker-compose up jupyter-gcp        # GCP notebooks at :8889 (cd /workspace/gcp)
docker-compose up middleware portal  # App stack at :3001 + :5183
```

**Agents are NOT in docker-compose.** Develop agents with:
```bash
cd agents/<name> && agentcore dev    # Hot-reload local server at :8080
```

Requires `~/.aws` credentials. Run `aws-azure-login --mode gui` first — the `default` profile assumes `aws-innovationlabs-washingtondc1-admin` in the **innovation lab account `647757222309`** (us-east-1). ⚠️ Account `264161986065` is a personal account and must NOT be used for this project.

## Key SDKs

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.39 | Agent framework (@tool, Agent, stream_async) |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` | >=0.1.18 | AG-UI event types + SSE encoder |
| `ag-ui-strands` | >=0.1.8 | Strands → AG-UI adapter (StrandsAgent) |
| `boto3` | >=1.34 | Bedrock, RDS Data API (Aurora), S3, DynamoDB, OpenSearch, Verified Permissions |
| `@aws/agentcore` | latest | AgentCore CLI (npm global install — bundled into the jupyter image; install globally on the host if you want `agentcore dev`/`agentcore exec` outside Docker) |

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
| Devbox runtime (Claude Code in a microVM, session storage) | CDK with `--context deployDevbox=true` (`OrgIQ-Devbox`) |

## Agent Dockerfile requirements (AgentCore Runtime)

- Multistage: `uv` builder → `python:3.12-slim` production
- Non-root user: `bedrock_agentcore` (UID 1000)
- Ports: 8080 (HTTP/AG-UI invocations), 8000 (health/MCP)
- Health check: `GET /ping`
- CMD: `opentelemetry-instrument python -m main`
- Max image size: 2 GB (AgentCore Runtime quota)
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
- **Session storage (`/mnt/workspace`, preview) is wiped on every runtime version update.** The runtime stacks digest-pin container URIs so CFN rolls the runtime on every image push — meaning every `build-all.sh`/devbox image push + deploy wipes all session workspaces for that agent. Treat `/mnt/workspace` as a cache, never a durable store; push work out via git or the command API. Also resets after 14 days idle. Limits: 1 GB/session, session IDs must be ≥33 chars.
- **Devbox model exception**: the `orgiq-devbox` runtime runs Claude Code, which requires Claude models — via Bedrock inference profiles (`us.anthropic.claude-*` IDs), so still AWS-hosted/AWS-billed, no Anthropic API key anywhere. This is a deliberate, devbox-only exception to the "AWS-native models only" convention; the 9 OrgIQ agents stay on Nova.
- Span projection runs on a schedule (Lambda) — span data in the Aurora `observability_*` tables can lag CloudWatch by a few minutes. If `OBS_USE_LEGACY_POLLER=true`, the middleware polls CloudWatch directly instead.
- AgentCore Runtime requires ARM64 Docker images. Local `agentcore dev` runs on host arch.
- `agentcore deploy` uses remote CodeBuild — no local Docker needed for deployment.
- AG-UI uses POST for SSE (not GET EventSource). Frontend must use fetch + ReadableStream.
- Titan Embeddings V2 dimension must be specified at embedding time AND match the `vector(1024)` column type.
- OpenSearch Serverless has 2 OCU minimum billing even when idle. Budget alarm is critical.
- Aurora Serverless v2 has a 0.5-ACU minimum that bills even when idle (~$45/mo). The cluster also takes 10–20s to scale up from a cold call. `./scripts/destroy.sh` pre-drains it before stack teardown.
- `@connorhoehnslalom/ui-components` requires `GITHUB_TOKEN` env var for npm install to work.
- **Agent images must install `aws-opentelemetry-distro` (ADOT), not vanilla `opentelemetry-distro`.** AgentCore Runtime injects `OTEL_PYTHON_CONFIGURATOR=aws_configurator`, which only exists in the ADOT package — with the vanilla distro no configurator loads and *no spans are ever exported* (`aws/spans` stays silently empty, which starves the span projector, `/recent-invocations`, and online evaluation). Runtime env also sets `OTEL_TRACES_EXPORTER=otlp` + `AGENT_OBSERVABILITY_ENABLED=true`; account-level X-Ray Transaction Search (`aws xray get-trace-segment-destination` → CloudWatchLogs/ACTIVE) must be on.
- **Prompt canary** is deployed via `--context deployCanary=true` (`OrgIQ-PromptCanary`: subject A/B + judge managed prompts, SSM weight/control params, SFN controller). The LLM-as-judge config (enable, model, rubric weights, sample rate) lives in SSM `/orgiq/canary/judge_config`, edited from `/iq/evaluations`, and is read by `middleware/src/lib/canary-judge.ts` on every canary ask. Online evaluation needs BOTH `--context enableEval=true` AND `--context enableOnlineEvalConfig=true` (the config resource requires `ServiceNames` + `ExecutionStatus: ENABLED` and an exec role that can create its results log group).
- **Agent system prompts are resolved from Bedrock Prompt Management at run time.** Each agent reads `orgiq-<agent>-system-prompt` (DRAFT) via `agents/_shared/prompt_source.py` on every invocation, cached `PROMPT_REFRESH_S` (60s), and rebuilds its Strands `Agent` when the text changes — so a Prompt Studio edit reaches the deployed fleet in ~a minute with **no image rebuild and no redeploy**. The `SYSTEM_PROMPT` literal in `agents/*/main.py` is a fallback used only when the library is unreachable (missing prompt, AccessDenied, throttle) so a Bedrock outage can't take the fleet down; `PROMPT_SOURCE_DISABLED=1` pins an agent to it. Traces record the *resolved* prompt sha as `promptVersion`, so observability shows which prompt actually served a request. ⚠️ The `bedrock:GetPrompt`/`ListPrompts` grant must be on the **runtime execution role** (`orgiq-<agent>-execution-role`, created by `OrgIQ-AgentCoreRuntime`) — the `OrgIQ-Agents` `orgiq-<agent>-role` is a different principal and granting it there has no run-time effect. `ListPrompts` must be paginated: the un-paginated call returns only the first page and silently misses prompts.
- **A2A topology edges require the supervisor's streaming path to set its TraceContext.** `_handle_streaming` (what the portal uses) originally never called `_current_ctx.set(...)`, so `_invoke_sub_agent` threaded no `parentInvocationId`, every sub-agent trace persisted with `parent_invocation_id NULL`, and `/api/topology/a2a` could never return an edge for real user traffic. Both handlers now establish the context and emit a root trace.
- **Trace sampling gates persistence.** `observability.sampling_config.rate` (default now 1.0) is applied in `trace-sink.processTrace` *before* the insert — at the old 0.1 a low-traffic lab wrote ~1 row in 10 while `[cw-ingest]` logged "persisted N" for every parsed bundle, so observability pages looked broken with no signal why. The poller now reports persisted / sampled-out / duplicate separately. Traces reach Aurora via the CloudWatch log poller (30s) parsing `ORGIQ_TRACE:` lines — agents cannot POST to a laptop middleware.
- **The KnowledgeBase stack's exports are imported by four stacks** (Agents, AgentCoreGateway, Observability, AgentCoreRuntime), so once consumers exist the KB id export can be neither deleted nor changed — a knowledge base deleted out-of-band (e.g. by `destroy.sh`'s KB pre-drain) cannot be replaced via CFN without a multi-stack teardown. Recovery without that: recreate the KB + S3 data source via the Bedrock API with the same config (Aurora `bedrock_kb` table, Titan v2 @1024d, `orgiq-kb-service-role`), point the fleet at it with `cdk deploy OrgIQ-AgentCoreRuntime --context kbId=<new-id>`, refresh `KNOWLEDGE_BASE_ID` in `.env.aws` and the `knowledge_bases` registry row, then run an ingestion job. The stale export stays as known drift until the KB stack is rebuilt cleanly.
- **Newsroom is feature-flagged off** in the portal (`portal/src/lib/features.ts`); re-enable with `VITE_ENABLE_NEWSROOM=true`. Routes/backend stay live — only nav + tenant switcher hide.
