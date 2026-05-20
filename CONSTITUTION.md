# AWS AgentCore Accelerator — Project Constitution

## Domain: Organizational Intelligence Platform (OrgIQ)

A multi-agent system built on Amazon Bedrock AgentCore that ingests meeting transcripts, PRDs, Confluence docs, and Jira tickets to construct a living organizational knowledge graph. The platform surfaces expertise networks, collaboration patterns, delivery velocity, and influence scoring — accessible through conversational search and a visual node-graph UI powered by the AG-UI streaming protocol.

---

## Why This Domain

This domain naturally exercises **every** AgentCore service and Bedrock feature:

| Feature | How OrgIQ Uses It |
|---------|-------------------|
| **AgentCore Runtime** | All 9 agents (6 OrgIQ + 3 newsroom) deployed as microVM-isolated sessions |
| **A2A Protocol** | Supervisor → specialist routing (Search, Advisor, Scoring) |
| **AG-UI Protocol** | Streaming events (text, tool calls, state) to React portal |
| **MCP Gateway** | Tools for Jira, Confluence, Slack, Calendar, Aurora SQL queries |
| **AgentCore Policy** | Cedar: managers see team scores, ICs see collaboration only |
| **AgentCore Memory** | Short-term: multi-turn search. Long-term: user preferences |
| **AgentCore Identity** | OAuth2 with corporate SSO, token vault for third-party APIs |
| **Code Interpreter** | Scoring algorithms (PageRank, betweenness centrality) |
| **Browser** | Scrape rendered Confluence pages, internal wikis |
| **Evaluations** | Score search relevance, measure agent accuracy continuously |
| **Agent Registry** | Semantic discovery of available agents |
| **Observability** | OpenTelemetry traces for full pipeline, cost tracking |
| **Knowledge Base** | Vector search over ingested documents (OpenSearch Serverless) |
| **Aurora GraphRAG** | Relational org graph in Aurora PostgreSQL — people, teams, skills, projects, decisions — with `pgvector` embeddings alongside |
| **Bedrock Guardrails** | PII filtering on employee data, bias prevention in scoring |
| **Bedrock Flows** | Orchestrate ingestion → enrichment → scoring pipeline |
| **Managed Prompts** | Versioned templates for each agent's system prompt |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    LOCAL DEVELOPMENT (docker-compose)                          │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │  portal (React 19 + Vite 7)          http://localhost:5183            │   │
│  │                                                                       │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────────┐  │   │
│  │  │ Agent Flow   │ │ Org Graph    │ │ Conversational Search        │  │   │
│  │  │ (Node Editor │ │ (Force-      │ │ (AG-UI stream + citations +  │  │   │
│  │  │  + AG-UI     │ │  directed    │ │  graph context sidebar)      │  │   │
│  │  │  trace ovly) │ │  @xyflow)    │ │                              │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────────────┘  │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────────┐  │   │
│  │  │ Scoring      │ │ Observability│ │ Ingest Monitor               │  │   │
│  │  │ (Radar/Bar)  │ │ (Traces)     │ │ (Sources, DLQ, Sync)        │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                           │ AG-UI SSE + WebSocket + REST                      │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │  middleware (Express + distributed-core)   http://localhost:3001       │   │
│  │                                                                       │   │
│  │  • AG-UI proxy (SSE passthrough from AgentCore Runtime)               │   │
│  │  • Aurora query routes (/graph/*, /scores/*) via RDS Data API         │   │
│  │  • Score routes (/scores/*)                                           │   │
│  │  • WebSocket bridge (trace events, graph updates → portal)            │   │
│  │  • Auth bypass (local dev) or Cognito JWT (deployed)                  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                           │ boto3 / bedrock-agentcore SDK                     │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │  jupyter (JupyterLab 4)                  http://localhost:8888         │   │
│  │  Phase 1 exploration notebooks — validate all services                │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                         AWS credentials (SSO / env vars)
                                    │
┌───────────────────────────────────┼──────────────────────────────────────────┐
│                          AWS CLOUD                                            │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Amazon Bedrock AgentCore                                               │ │
│  │                                                                         │ │
│  │  ┌───────────┐ ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐  │ │
│  │  │ Runtime   │ │ Gateway  │ │ Policy  │ │ Memory  │ │ Identity     │  │ │
│  │  │ (9 agents │ │ (MCP     │ │ (Cedar  │ │ (short+ │ │ (OAuth2,     │  │ │
│  │  │  in       │ │  tools,  │ │  rules) │ │  long   │ │  token vault)│  │ │
│  │  │  microVMs)│ │  search) │ │         │ │  term)  │ │              │  │ │
│  │  └───────────┘ └──────────┘ └─────────┘ └─────────┘ └──────────────┘  │ │
│  │  ┌───────────┐ ┌──────────┐ ┌─────────┐ ┌───────────────────────────┐  │ │
│  │  │ Code      │ │ Browser  │ │ Evals   │ │ Agent Registry            │  │ │
│  │  │ Interp.   │ │ (Playwrt)│ │ (13     │ │ (semantic agent discovery) │  │ │
│  │  │ (scoring) │ │          │ │  built-in│ │                           │  │ │
│  │  └───────────┘ └──────────┘ └─────────┘ └───────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Amazon Bedrock                                                         │ │
│  │  ┌───────────────┐ ┌────────────────┐ ┌────────────┐ ┌──────────────┐  │ │
│  │  │ Knowledge Base│ │ Guardrails     │ │ Flows      │ │ Managed      │  │ │
│  │  │ (OpenSearch   │ │ (PII, content, │ │ (ingestion │ │ Prompts      │  │ │
│  │  │  Serverless)  │ │  grounding)    │ │  pipeline) │ │ (versioned)  │  │ │
│  │  └───────────────┘ └────────────────┘ └────────────┘ └──────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌───────────────────┐ ┌──────────────────┐ ┌─────────────────────────────┐ │
│  │ Aurora Serverless │ │ OpenSearch       │ │ S3 (documents)              │ │
│  │ v2 (PostgreSQL 16 │ │ Serverless       │ │ DynamoDB (sessions, scores) │ │
│  │  + pgvector 1024d)│ │ (KB embeddings)  │ │                             │ │
│  └───────────────────┘ └──────────────────┘ └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Agents (Strands Framework)

All agents use the Strands Agents SDK (`strands-agents`) deployed to AgentCore Runtime via multistage Docker containers. The Supervisor agent serves AG-UI protocol for frontend streaming.

### Agent Definitions

```python
# Pattern for all agents:
from strands import Agent, tool
from strands.models import BedrockModel
from bedrock_agentcore import BedrockAgentCoreApp

app = BedrockAgentCoreApp()
model = BedrockModel(model_id=os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0"))

@tool
def my_tool(query: str) -> str:
    """Tool description for LLM."""
    ...

agent = Agent(model=model, tools=[my_tool], system_prompt="...")

@app.entrypoint
async def invoke(payload, context):
    async for event in agent.stream_async(payload["prompt"]):
        yield event
```

### 1. Supervisor Agent (Orchestrator)
- **Protocol**: AG-UI (SSE at `/invocations`, WebSocket at `/ws`)
- **Role**: Routes user queries to appropriate specialist via A2A; runs ad-hoc Python in Code Interpreter
- **Tools**: `search_organization`, `get_expertise_scores`, `get_strategic_advice`, `ingest_documents`, `build_graph`, `run_in_sandbox` (each routes to a specialist runtime via A2A invocation, except `run_in_sandbox` which uses AgentCore Code Interpreter)
- **Memory**: Short-term session + long-term user preferences
- **Policy**: Cedar (Verified Permissions) enforces role-based data access; guardrail is attached per role at model-build time
- **AG-UI Events**: `RunStarted` → `StepStarted("routing")` → `TextMessageContent` → `ToolCallStart` → `StepFinished` → `RunFinished`

### 2. Ingestion Agent
- **Protocol**: HTTP / A2A (called by Supervisor or Bedrock Flows, not directly by users)
- **Role**: Fetch and normalize documents from multiple sources; trigger KB ingestion
- **MCP Tools** (via Gateway): `jira_search`, `confluence_fetch`, `s3_list_documents`, `slack_search`
- **Output**: Normalized document chunks → S3 → KB ingestion trigger

### 3. Graph Builder Agent
- **Protocol**: HTTP / A2A
- **Role**: Extract entities and relationships from documents, upsert into Aurora relational tables
- **Tools**: `merge_person`, `merge_skill`, `merge_team`, `merge_project`, `merge_decision`, `link_person_to_skill`, `link_person_to_team`, `link_person_to_project` (each issues parameterized `INSERT … ON CONFLICT DO UPDATE` via the RDS Data API)
- **Uses Code Interpreter**: Entity extraction prompts, relationship classification

### 4. Scoring Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Compute influence, expertise, and velocity scores
- **Tools**: SQL aggregates over `person_skills`, `project_contributions`, `collaborations` → `dynamodb_write_scores`; PageRank/centrality run inside Code Interpreter against the relational graph
- **Uses Code Interpreter**: Custom scoring formulas, normalization
- **Algorithms**: PageRank, betweenness centrality, contribution frequency

### 5. Search Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Conversational search over docs + Aurora graph + the open web
- **Tools**: `query_knowledge_base` (Bedrock KB retrieve), `query_graph` (read-only `SELECT`/`WITH` SQL against Aurora), `fetch_web_page` (AgentCore Browser via CDP)
- **Memory**: Session context for multi-turn refinement
- **Guardrails**: PII filter on outputs, grounding check on citations

### 6. Advisor Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Proactive recommendations from org patterns
- **Tools**: `query_graph`, `dynamodb_get_scores`, `query_knowledge_base`
- **Examples**: "Team X has bus factor of 1 on service Y", "Consider pairing A with B"

### 7. News Researcher Agent (`news-researcher`)
- **Protocol**: A2A
- **Role**: Fetch and triage external news for the Newsroom demo surface
- **Tools**: web fetch, KB-grounded summarization, entity extraction against Aurora

### 8. News Brief Agent (`news-brief`)
- **Protocol**: A2A
- **Role**: Synthesize researched items into per-entity briefs
- **Tools**: KB retrieve, Aurora entity lookup, summarization

### 9. News Headline Agent (`news-headline`)
- **Protocol**: A2A
- **Role**: Lightweight headline + lede generator (smallest of the news family)
- **Tools**: Nova Pro completion only (no external IO)

> **Shared utilities** live in `agents/_shared/` (`approval_tool.py`, `instrumentation.py`).
> The common runtime image is built from `agents/base/Dockerfile` and pinned via `agents/Dockerfile.agent`.

---

## Aurora Org-Graph Schema (PostgreSQL + pgvector)

Aurora does not support Apache AGE, so the org-graph is modeled as plain
relational tables: one table per "node label" and one edge table per
relationship type. `pgvector` lives alongside in `node_embeddings` for
semantic similarity. Canonical DDL: `schema/orgiq_schema.sql`. Access is
via the RDS Data API; read tools enforce `SELECT`/`WITH` only.

### Node tables

| Table | Key Columns | Embedding |
|-------|-------------|-----------|
| `people` | id, name, email, title, team, expertise_score, pagerank_score, composite_score, scored_at | via `node_embeddings` (kind='person') |
| `teams` | id, name, parent_id | via `node_embeddings` (kind='team') |
| `projects` | id, name, status | via `node_embeddings` (kind='project') |
| `skills` | id, name, domain | via `node_embeddings` (kind='skill') |
| `decisions` | id, topic, summary, decided_at | via `node_embeddings` (kind='decision') |
| `documents` | id, source, source_uri, title, ingested_at | via `node_embeddings` (kind='document') |
| `node_embeddings` | node_id, kind, embedding `vector(1024)` (Titan V2) | — |

Newsroom adds its own tables (`schema/newsroom_schema.sql`): articles,
entities, clusters, pitches. Observability adds `schema/observability_*.sql`
(spans, approvals, calibration, memory).

### Edge tables (one per relationship type)

| Table | From → To | Key Columns |
|-------|-----------|-------------|
| `person_skills` | person → skill | weight, source |
| `team_memberships` | person → team | role, started_at |
| `project_contributions` | person → project | role, contribution_count |
| `collaborations` | person ↔ person | strength, interaction_count |
| `mentions` | document → entity | offset, span, confidence |

### Key queries (parameterized SQL, run via RDS Data API)

```sql
-- Find experts for a skill (joins replace the old MATCH … -[EXPERT_IN]-> …)
SELECT p.id, p.name, p.title, ps.weight
FROM   people p
JOIN   person_skills ps ON ps.person_id = p.id
JOIN   skills s         ON s.id = ps.skill_id
WHERE  s.name = :skill
ORDER  BY ps.weight DESC
LIMIT  10;

-- Two-hop: who collaborates with people who know X but doesn't know X themselves?
SELECT DISTINCT c.target_id AS candidate_id, array_agg(DISTINCT e.id) AS connected_experts
FROM   person_skills ps
JOIN   people        e  ON e.id = ps.person_id
JOIN   skills        s  ON s.id = ps.skill_id AND s.name = :skill
JOIN   collaborations c ON c.source_id = e.id
WHERE  NOT EXISTS (
         SELECT 1 FROM person_skills ps2
         JOIN   skills s2 ON s2.id = ps2.skill_id
         WHERE  ps2.person_id = c.target_id AND s2.name = :skill)
GROUP  BY c.target_id;

-- Hybrid: vector similarity (Titan V2 1024d) then expand to skills
SELECT p.id, p.name, ne.embedding <=> :query_vec AS distance,
       array_agg(DISTINCT s.name)               AS skills
FROM   node_embeddings ne
JOIN   people          p  ON p.id = ne.node_id AND ne.kind = 'person'
LEFT   JOIN person_skills ps ON ps.person_id = p.id
LEFT   JOIN skills        s  ON s.id = ps.skill_id
GROUP  BY p.id, p.name, ne.embedding
ORDER  BY distance
LIMIT  5;
```

PageRank and betweenness centrality are computed inside AgentCore Code
Interpreter (Python + `networkx`), reading the edge tables and writing
scores back to `people.pagerank_score` / `people.composite_score`. There
is no in-database graph algorithm runtime.

---

## AG-UI Event Flow (Frontend Integration)

The Supervisor agent serves AG-UI protocol. The portal consumes these events:

```
Portal (React)                    Middleware                  AgentCore Runtime
     │                                │                            │
     │── POST /api/agents/invoke ────>│── POST /invocations ──────>│
     │   {threadId, runId, messages}  │   (AG-UI RunAgentInput)    │
     │                                │                            │
     │<── SSE stream ────────────────<│<── SSE stream ────────────<│
     │                                │                            │
     │  data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}  │
     │  data: {"type":"STEP_STARTED","stepName":"routing"}         │
     │  data: {"type":"TEXT_MESSAGE_START","messageId":"m1"}       │
     │  data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Searching"}  │
     │  data: {"type":"TOOL_CALL_START","toolCallName":"search"}   │
     │  data: {"type":"TOOL_CALL_ARGS","delta":"{\"query\":...}"}  │
     │  data: {"type":"TOOL_CALL_END"}                             │
     │  data: {"type":"STATE_DELTA","delta":[{op,path,value}]}     │
     │  data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Based on..."} │
     │  data: {"type":"TEXT_MESSAGE_END"}                           │
     │  data: {"type":"RUN_FINISHED"}                              │
```

The portal's `useAgentStream` hook parses these events and dispatches to:
- Chat panel (TextMessage events → streaming text)
- Agent flow node editor (ToolCall events → node highlighting)
- State panel (StateDelta events → graph context sidebar)

---

## Docker Architecture

### docker-compose.yml (Local Development)

```yaml
services:
  jupyter:
    build: ./notebooks
    ports: ["8888:8888"]
    volumes:
      - ./notebooks:/workspace
      - ~/.aws:/root/.aws:ro
    environment:
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - AWS_PROFILE=${AWS_PROFILE:-default}

  middleware:
    build:
      context: ./middleware
      target: development
    ports: ["3001:3001"]
    volumes:
      - ./middleware/src:/app/src
      - ~/.aws:/home/node/.aws:ro
    environment:
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - NEPTUNE_GRAPH_ID=${NEPTUNE_GRAPH_ID}
      - AGENTCORE_ENDPOINT=${AGENTCORE_ENDPOINT}
      - NODE_ENV=development

  portal:
    build:
      context: ./portal
      target: development
      additional_contexts:
        ui_components: ../ui-components
    ports: ["5183:5183"]
    volumes:
      - ./portal:/app
      - /app/node_modules
    environment:
      - VITE_API_URL=http://localhost:3001
      - VITE_WS_URL=ws://localhost:3001
      - API_PROXY_TARGET=http://middleware:3001
```

### Agent Dockerfile (Multistage, AWS-deployable)

```dockerfile
# Stage 1: dependency resolution with uv
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache -r pyproject.toml

# Stage 2: production image
FROM public.ecr.aws/docker/library/python:3.12-slim AS production
WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
RUN pip install --no-cache-dir aws-opentelemetry-distro>=0.10.1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

COPY . .
EXPOSE 8080 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ping || exit 1

CMD ["opentelemetry-instrument", "python", "-m", "main"]
```

Requirements for AgentCore Runtime:
- ARM64 architecture (CodeBuild uses `amazonlinux2-aarch64-standard:3.0`)
- Non-root user with UID 1000 named `bedrock_agentcore`
- Port 8080 (HTTP invocations), Port 8000 (health/MCP)
- Health check at `/ping`
- Image size limit: 1 GB
- OTEL instrumentation wrapper

---

## Phase Plan

### Dependency Graph

```
Phase 1a (Notebooks)  ──────────┐
                                ├──→ Phase 2 (CDK) ──→ Phase 3a (Agents) ──→ Phase 3b (Middleware)
Phase 1b (Portal scaffold) ─────┘                                                    │
                                                                                     ▼
                                                                              Phase 4 (Integration)
```

- **1a + 1b run in parallel**: notebooks validate AWS APIs while portal scaffolding uses mock data
- **Phase 2 requires 1a**: you need to know the APIs work before codifying in CDK
- **Phase 3a requires 2**: agents need Aurora/KB/Guardrails deployed
- **Phase 3b requires 3a**: middleware needs agent endpoints to proxy
- **Phase 4 (integration)**: wire portal to real middleware (replacing mocks)
- **Portal mock UI starts in Phase 1b**: so you can visualize while services are being built

### Phase 1a: Jupyter Exploration (Weeks 1-2)

**Goal**: Validate all AWS services, build running config

```
notebooks/aws/
├── 00-index.ipynb                     # Workshop overview + setup guide
├── 01-setup-credentials.ipynb         # AWS config, model access, bedrock-agentcore install
├── 02-aurora-graph.ipynb              # Create Aurora cluster, apply schema, write nodes/edges
├── 03-embeddings.ipynb                # Titan Embeddings V2 (1024d) into pgvector
├── 04-knowledge-base.ipynb            # OpenSearch Serverless KB + document ingestion
├── 05-guardrails.ipynb                # Content filters, PII, topic denial, grounding
├── 06-strands-agent.ipynb             # Define agent with @tool, invoke locally
├── 07-agentcore-memory.ipynb          # Short-term events, long-term extraction, retrieval
├── 08-agentcore-gateway.ipynb         # Create MCP tools from OpenAPI, semantic search
├── 09-agentcore-policy.ipynb          # Cedar policies, natural language → Cedar
├── 10-agentcore-identity.ipynb        # OAuth setup, token vault, credential flow
├── 11-code-execution.ipynb            # AgentCore Code Interpreter (sandboxed Python)
├── 12-ag-ui-streaming.ipynb           # serve_ag_ui(), stream events, test frontend contract
├── 13-a2a-protocol.ipynb              # Supervisor + specialist A2A collaboration
├── 14-scoring.ipynb                   # PageRank / centrality in Code Interpreter → DynamoDB
├── 15-deploy-runtime.ipynb            # agentcore deploy → ECR → Runtime
├── 16-evaluations.ipynb               # Built-in evaluators, custom LLM-as-judge
├── 17-telemetry.ipynb                 # OpenInference spans → ADOT → CloudWatch → Aurora
├── 18-fairness.ipynb                  # DI ratio, SPD, LLM-as-judge bias, Bedrock Model Evaluation
└── 19-cleanup.ipynb                   # Resource teardown with tracker (cleanup_utils.py)
```

### Phase 1b: Portal Scaffold with Mock Data (Weeks 1-2, parallel with 1a)

**Goal**: Build UI components against mock data so visualization is ready when backends come online

- Scaffold Vite + React app with ui-components dependency
- Build AgentFlowPage with static node graph (hardcoded 9 agents + tools)
- Build OrgGraphPage with synthetic graph data (20 people, 4 teams)
- Build SearchPage with mock AG-UI event stream (simulated SSE)
- Build ScoresPage with hardcoded radar/leaderboard data
- Use ui-components EventSimulator to drive demo mode

**Deliverable**: `docker-compose up portal` shows all pages with realistic-looking fake data.

### Phase 2: CDK Infrastructure (Week 3)

**Goal**: Codify data stores, Bedrock resources, and AgentCore feature stacks. Agent container deployment uses CDK with `--context deployRuntimes=true` (phase 2 of the same stack), not the standalone AgentCore CLI.

CDK manages **everything**, including AgentCore primitives (Memory, Policy, Gateway, Runtime, Telemetry). The breakdown is:

| Stack | Resources |
|-------|-----------|
| `OrgIQ-Foundation` | S3 buckets (documents, artifacts), DynamoDB tables (sessions, scores), base IAM roles, KMS keys |
| `OrgIQ-Aurora` | Aurora Serverless v2 (PostgreSQL 16 + `pgvector`), Secrets Manager credentials, RDS Data API enablement |
| `OrgIQ-KnowledgeBase` | OpenSearch Serverless collection + Bedrock Knowledge Base + S3 data source |
| `OrgIQ-Guardrails` | Bedrock Guardrails (PII filter, content policy, grounding) per role |
| `OrgIQ-Authorization` | Verified Permissions policy store, Cedar policies, session-signing secret, tenant config |
| `OrgIQ-Agents` | ECR repos + execution roles for the original 6 agents (phase 1 — no `CfnRuntime`) |
| `OrgIQ-Observability` | CloudWatch dashboards, budget alarm, log groups, OpenInference exporters |
| `OrgIQ-AgentCoreMemory` | `CfnMemory` resources for the supervisor session store |
| `OrgIQ-AgentCorePolicy` | `CfnPolicyEngine` wiring Cedar → AgentCore at request time |
| `OrgIQ-AgentCoreCapabilities` | Code Interpreter, Browser, Workload Identity (`CfnCodeInterpreter`, `CfnBrowser`, `CfnWorkloadIdentity`) |
| `OrgIQ-AgentCoreRuntime` | `CfnRuntime` + `CfnRuntimeEndpoint` for the 6 originals + 3 newsroom agents (phase 2, gated on `--context deployRuntimes=true`) |
| `OrgIQ-AgentCoreGateway` | `CfnGateway` + targets (Jira/Confluence/Slack OpenAPI specs) + Cedar gateway policies |
| `OrgIQ-AgentCoreTelemetry` | Custom evaluators + online evaluation config (gated on `--context enableEval=true`) |
| `OrgIQ-SpanProjector` | Lambda that consumes CloudWatch Logs Insights, projects OpenInference spans into Aurora observability tables |

Stack ordering and cross-stack refs live in `infra/bin/app.ts`. Both phase-2 flags (`deployRuntimes`, `enableEval`) are documented in `CLAUDE.md` under "Common workflows".

```
infra/
├── bin/app.ts                                # 14-stack composition + context flags
├── lib/
│   ├── foundation-stack.ts                   # S3, DynamoDB, base IAM
│   ├── aurora-stack.ts                       # Aurora Serverless v2 + pgvector
│   ├── knowledge-base-stack.ts               # OpenSearch Serverless + Bedrock KB
│   ├── guardrails-stack.ts                   # Bedrock Guardrails (per-role)
│   ├── authorization-stack.ts                # Verified Permissions + Cedar + session signing
│   ├── agents-stack.ts                       # ECR + execution roles for the 6 originals
│   ├── observability-stack.ts                # Dashboards, budget alarm, log groups
│   ├── agentcore-memory-stack.ts             # CfnMemory
│   ├── agentcore-policy-stack.ts             # CfnPolicyEngine
│   ├── agentcore-capabilities-stack.ts       # Code Interpreter, Browser, Workload Identity
│   ├── agentcore-runtime-stack.ts            # CfnRuntime + CfnRuntimeEndpoint (gated)
│   ├── agentcore-gateway-stack.ts            # CfnGateway + targets + Cedar policies
│   ├── agentcore-telemetry-stack.ts          # Custom evaluators + online eval (gated)
│   └── span-projector-stack.ts               # OpenInference span → Aurora Lambda
├── scripts/
│   ├── deploy.sh                             # Sequenced deploy with orphan cleanup
│   └── destroy.sh                            # Pre-drains KB + Aurora before teardown
├── cdk.json
├── package.json
└── tsconfig.json
```

> Schemas (OpenAPI for MCP Gateway, Cedar policy text) live under the relevant stack
> as inline TypeScript or `assets/` subfolders — there is no top-level `infra/schemas/`.

### Phase 3a: Agent Implementation (Week 4)

**Goal**: Working agents deployed to AgentCore Runtime

```
agents/
├── base/                              # Shared multistage Dockerfile (uv builder → python:3.12-slim)
│   ├── Dockerfile                     # ARM64, non-root bedrock_agentcore, OTel-instrumented
│   └── build.sh
├── _shared/                           # Cross-agent Python helpers
│   ├── approval_tool.py               # Human-in-the-loop approval gating
│   └── instrumentation.py             # OpenInference root spans, RETRIEVER, guardrail capture
├── Dockerfile.agent                   # Per-agent thin layer over base/Dockerfile
├── build-all.sh                       # Build + push all 9 ECR images
│
├── supervisor/main.py                 # AG-UI entrypoint, A2A routing, Cedar role resolution
├── ingestion/main.py                  # MCP tool consumer (Jira, Confluence, S3, Slack)
├── graph-builder/main.py              # Aurora upserts (merge_person, merge_skill, …)
├── scoring/main.py                    # PageRank/centrality in Code Interpreter → DynamoDB
├── search/main.py                     # query_knowledge_base, query_graph, fetch_web_page
├── advisor/main.py                    # Pattern-detection queries against Aurora + scores
│
├── news-researcher/main.py            # Newsroom: external fetch + triage
├── news-brief/main.py                 # Newsroom: per-entity brief synthesis
└── news-headline/main.py              # Newsroom: headline + lede (Nova Pro only)
```

### Phase 3b: Middleware (Week 5)

**Goal**: Bridge deployed agents + Aurora to portal via AG-UI proxy + WebSocket

Standalone Express service (imports distributed-core for WS, does NOT modify platform-api):

```
middleware/
├── src/
│   ├── index.ts                       # Express app setup
│   ├── routes/
│   │   ├── agents.ts                  # AG-UI proxy (SSE passthrough)
│   │   ├── graph.ts                   # Aurora SQL queries (entities, relationships, search)
│   │   ├── scores.ts                  # Leaderboards, breakdowns, trends
│   │   ├── ingest.ts                  # Trigger ingestion, monitor progress
│   │   └── traces.ts                  # Fetch OpenTelemetry traces
│   ├── lib/
│   │   ├── invocations.ts             # Agent invocations + SSE streaming
│   │   ├── trace-sink.ts              # OI trace ingest from CloudWatch
│   │   ├── crawler.ts                 # Document crawler + ingest scheduling
│   │   ├── authz.ts                   # Cedar / Verified Permissions calls
│   │   ├── embedding.ts               # Titan V2 embedding helper
│   │   └── …                          # Aurora access is via the RDS Data API directly in routes
│   └── ws/
│       ├── bridge.ts                  # WebSocket server (distributed-core transport)
│       └── handlers.ts               # Graph update + trace event handlers
├── Dockerfile
├── package.json
└── tsconfig.json
```

### Phase 4: Integration + Polish (Week 6)

**Goal**: Wire portal to real middleware (replace mocks with live data)

```
portal/
├── src/
│   ├── App.tsx                        # Router + providers
│   ├── pages/
│   │   ├── AgentFlowPage.tsx          # Node editor: agent DAG + live trace overlay
│   │   ├── OrgGraphPage.tsx           # Force-directed org graph explorer
│   │   ├── SearchPage.tsx             # AG-UI chat + citations + graph context
│   │   ├── ScoresPage.tsx             # Scoring dashboards (radar, bar, trends)
│   │   ├── IngestPage.tsx             # Ingest monitor (reuse ui-components/ingest)
│   │   └── ObservabilityPage.tsx      # Traces, metrics (reuse ui-components/observability)
│   ├── components/
│   │   ├── agent-flow/
│   │   │   ├── AgentNode.tsx          # Custom node: represents a deployed agent
│   │   │   ├── ToolNode.tsx           # Custom node: MCP tool (lights up on call)
│   │   │   ├── GuardrailGate.tsx      # Custom node: guardrail checkpoint
│   │   │   ├── MemoryNode.tsx         # Custom node: memory read/write
│   │   │   └── TraceOverlay.tsx       # Maps AG-UI events → node animations
│   │   ├── org-graph/
│   │   │   ├── ForceGraph.tsx         # @xyflow/react force-directed layout
│   │   │   ├── PersonNode.tsx         # Person with score-based sizing
│   │   │   ├── TeamCluster.tsx        # Visual team boundary
│   │   │   └── GraphControls.tsx      # Filter by team/skill/project, layout toggle
│   │   ├── search/
│   │   │   ├── AgUiChat.tsx           # Consumes AG-UI SSE events for streaming chat
│   │   │   ├── CitationPanel.tsx      # Source document viewer with highlights
│   │   │   └── GraphContext.tsx       # Related entities sidebar (from StateDelta)
│   │   └── scoring/
│   │       ├── RadarChart.tsx         # Multi-dimension score (Recharts)
│   │       ├── ScoreCard.tsx          # Individual breakdown
│   │       └── TrendLine.tsx          # Score over time
│   ├── hooks/
│   │   ├── useAgUiStream.ts           # Parse AG-UI SSE events into typed state
│   │   ├── useGraphData.ts            # Fetch Aurora graph data, transform to @xyflow nodes
│   │   ├── useScores.ts              # Score API hooks
│   │   └── useTraceStream.ts         # WebSocket subscription for live traces
│   └── providers/
│       ├── AgUiProvider.tsx           # Thread/session state management
│       └── GraphProvider.tsx          # Graph query cache + optimistic updates
├── Dockerfile
├── package.json
├── vite.config.ts
└── tailwind.config.ts
```

---

## Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent framework | **Strands Agents** (`strands-agents` 1.39+) | Native AgentCore integration, `@tool` decorator, `stream_async()` |
| Agent-to-UI protocol | **AG-UI** (`ag-ui-protocol`) | Standard event schema, SSE transport, maps to React state |
| Agent-to-Agent | **A2A** via `bedrock-agentcore[a2a]` | `serve_a2a(executor)` for specialist agents |
| Agent deployment | **CDK `CfnRuntime`** (gated `--context deployRuntimes=true`) | Single source of truth; AgentCore CLI used only for local `agentcore dev` |
| Graph store | **Aurora Serverless v2** (PostgreSQL 16 + `pgvector`) | Relational tables + pgvector; Aurora has no AGE, so graph is modeled as edge tables. PageRank/centrality run in Code Interpreter |
| Vector store (KB) | **OpenSearch Serverless** | KB quick-create, hybrid search + reranking |
| Embedding model | **Titan Embeddings V2** (1024d) | Cost-effective; `vector(1024)` columns in Aurora match exactly |
| LLM | **Amazon Nova Pro** (`amazon.nova-pro-v1:0`) | AWS-native default; overridable per agent via `MODEL_ID` env |
| IaC (everything) | **CDK TypeScript** | L1 constructs for all Bedrock + Aurora + AgentCore resources |
| Middleware | **Express + distributed-core** | AG-UI SSE proxy, WebSocket bridge, RDS Data API client |
| Frontend | **React 19 + Vite 7** | Matches ui-components, uses @xyflow/react for graphs |
| Component library | **@connorhoehnslalom/ui-components** | Node editor, observability, ingest, social, hooks |
| Local dev | **docker-compose** | jupyter + middleware + portal, hot-reload volumes |
| Agent containers | **Multistage Docker** (uv + python:3.12-slim) | ARM64, non-root, OTEL instrumented |

---

## What Gets Reused vs. Built New

### Reused
- **ui-components**: Pipeline node editor (extend with custom agent nodes), observability module, ingest dashboard, ChatPanel, WebSocket hooks, theming, Recharts wrapper
- **distributed-core**: WebSocketAdapter (middleware WS server), EventBus, PubSubManager
- **Sandbox notebook patterns**: Docker setup, resource tracker, config.json sharing, cleanup utilities

### Built New
- **Strands agent code** (9 agents — 6 OrgIQ + 3 newsroom — with tools, prompts, memory)
- **CDK stacks** (Aurora, KB, Guardrails, AgentCore Memory/Policy/Capabilities/Runtime/Gateway/Telemetry, SpanProjector, Authorization)
- **Schema + synth pipeline** (`schema/orgiq_schema.sql`, `schema/synth/` LLM-driven corpus generator)
- **Middleware** (AG-UI proxy, RDS Data API layer, WebSocket bridge, trace sink)
- **Portal pages** (OrgGraph, Search with AG-UI, Scoring dashboards)
- **Custom node types** (AgentNode, ToolNode, GuardrailGate for flow visualizer)
- **AG-UI stream hooks** (useAgUiStream parsing SSE into typed React state)
- **Synthetic org data** (20 people, 4 teams, projects, transcripts)

---

## File Structure (Complete)

```
aws-agentcore/
├── CONSTITUTION.md
├── CLAUDE.md
├── README.md
├── docker-compose.yml                  # Local stack (jupyter + middleware + portal)
├── .env.example
│
├── notebooks/                          # Phase 1: Jupyter exploration (00–19), split per cloud
│   ├── aws/                            # AWS flavor — boto3, bedrock-agentcore SDK, AgentCore
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   ├── jupyter_lab_config.py
│   │   ├── cleanup_utils.py            # Resource tracker + teardown
│   │   ├── 00-index.ipynb ... 19-cleanup.ipynb
│   │   ├── data/                       # Synthetic org data
│   │   └── scripts/                    # start.sh / stop.sh / check-aws.sh
│   └── gcp/                            # GCP flavor — vertexai, google-genai, Agent Engine
│       ├── Dockerfile
│       ├── requirements.txt
│       ├── jupyter_lab_config.py
│       ├── cleanup_utils.py            # Resource tracker + teardown (GCP-aware)
│       ├── 00-index.ipynb ... 19-cleanup.ipynb
│       ├── data/                       # Same synthetic org data as aws/
│       └── README.md                   # AWS → GCP service mapping
│
├── schema/                             # Aurora SQL + LLM-driven synth pipeline
│   ├── orgiq_schema.sql                # Canonical org-graph relational schema
│   ├── newsroom_schema.sql             # Articles, entities, clusters, pitches
│   ├── observability_*.sql             # Sprint-versioned OI projections + approvals
│   ├── seed.py / seed.sql              # Idempotent seed loader
│   ├── apply-schema.sh                 # Apply via RDS Data API
│   ├── README.md
│   └── synth/                          # LLM-driven synthetic corpus pipeline
│
├── agents/                             # Phase 3: 9 Strands agents + shared layer
│   ├── base/                           # Shared multistage Dockerfile
│   ├── _shared/                        # approval_tool, instrumentation (OI helpers)
│   ├── Dockerfile.agent
│   ├── build-all.sh
│   ├── supervisor/  ingestion/  graph-builder/
│   ├── scoring/  search/  advisor/
│   └── news-researcher/  news-brief/  news-headline/
│
├── infra/                              # Phase 2: 14 CDK stacks
│   ├── bin/app.ts
│   ├── lib/                            # *-stack.ts (see Phase 2 table)
│   ├── scripts/                        # deploy.sh / destroy.sh
│   ├── cdk.json
│   └── package.json
│
├── middleware/                         # Express + AG-UI SSE proxy + WS bridge
│   ├── src/
│   │   ├── routes/  lib/  providers/  ws/  mock/  types/
│   │   ├── config.ts
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
│
└── portal/                             # React 19 + Vite 7 (~25 pages)
    ├── src/
    │   ├── pages/                      # iq, admin, newsroom, capabilities, identity, observability, ingest …
    │   ├── components/
    │   ├── hooks/
    │   └── providers/
    ├── Dockerfile
    ├── package.json
    └── vite.config.ts
```

---

## Running Locally

```bash
# Prerequisites — only the `default` AWS profile is configured locally
aws sso login            # uses the default profile (account 264161986065)

# Start the app stack (middleware + portal + jupyter)
docker-compose up --build

# Services:
#   Jupyter    → http://localhost:8888
#   Middleware → http://localhost:3001
#   Portal     → http://localhost:5183

# Or run individually:
docker-compose up jupyter              # Just notebooks
docker-compose up middleware portal    # Just the app stack
```

### Agent development (NOT in docker-compose)

Agents run via `agentcore dev` on the host (not inside containers). This gives you
hot-reload, credential forwarding, and gateway env var injection automatically:

```bash
cd agents/supervisor && agentcore dev          # Interactive chat at :8080
cd agents/search && agentcore dev --logs       # Non-interactive stdout
agentcore dev "Who knows Kubernetes?"          # One-shot test prompt
```

docker-compose runs **jupyter + middleware + portal**. Agents are developed/tested
separately and deployed to AgentCore Runtime via `agentcore deploy`.

### Dependency setup

Portal needs access to `@connorhoehnslalom/ui-components` from GitHub Packages:
```bash
# portal/.npmrc
@connorhoehnslalom:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Middleware imports distributed-core from GitHub:
```json
"distributed-core": "github:connorhoehn/distributed-core#main"
```

---

## Deployment (AWS)

```bash
# 1. Deploy data + foundation infra (13 of 14 stacks; runtimes are gated)
cd infra && ./scripts/deploy.sh

# 2. Build + push the 9 agent container images to ECR
cd agents && ./build-all.sh

# 3. Deploy the AgentCore runtimes (CfnRuntime + CfnRuntimeEndpoint)
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true

# 4. (Optional) enable online evaluation now that runtimes are live
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreTelemetry --context enableEval=true

# 5. Verify
agentcore invoke --agent orgiq-supervisor --prompt "Who are our Kubernetes experts?"

# Teardown (drains KB + Aurora first to avoid DELETE_FAILED stacks)
cd infra && ./scripts/destroy.sh
```

---

## Success Criteria

1. `docker-compose up` → All 3 services healthy, hot-reload working
2. Run any notebook → Live AWS responses (no mocks, no numpy fakes)
3. Portal agent flow → See 9 agents as nodes with tool/memory/guardrail connections
4. Type search query → AG-UI stream renders incrementally in chat, tool calls animate nodes
5. Org graph → People/teams/skills with PageRank-sized nodes, click for drill-down
6. Trigger ingestion → Watch document flow through agents (trace overlay on node editor)
7. Observability → OpenTelemetry traces waterfall, token costs per agent
8. Guardrails → Ask for PII → See blocked response with guardrail metadata
9. Policy → Switch role → Different data visibility (Cedar enforcement)
10. `cdk deploy --all` + `agentcore deploy` → Full cloud deployment from code
11. `cdk destroy` + resource tracker → Clean teardown, no orphaned resources

---

## Cost Estimate (Innovation Lab)

| Service | Monthly (dev use) |
|---------|-------------------|
| AgentCore Runtime (9 agents, light) | ~$15-30 |
| AgentCore Gateway + Memory + Policy | ~$5-10 |
| Bedrock Models (Nova Pro + Titan V2) | ~$10-25 |
| Aurora Serverless v2 (0.5 ACU min) | ~$30-60 |
| OpenSearch Serverless (2 OCU min) | ~$20-50 |
| S3 + DynamoDB | ~$1-5 |
| CloudWatch (traces + logs + span projector Lambda) | ~$5-15 |
| **Total** | **~$85-195/month** |

Budget alarm at $200/month in CDK observability stack. Cleanup notebook + `cdk destroy` for teardown.

---

## Testing Strategy

| Layer | Approach |
|-------|----------|
| Notebooks | Manual execution against live AWS (the point is validation) |
| Agents (unit) | `bedrock-agentcore[simulation]` — mock LLM responses, test tool routing |
| Agents (integration) | `agentcore dev` locally → invoke with test prompts |
| Middleware | Vitest — mock Aurora/AgentCore clients, test route handlers |
| Portal | Playwright e2e — mock middleware responses, test AG-UI event rendering |
| CDK | `cdk synth` → snapshot tests for CloudFormation templates |
| Full stack | Docker-compose + real AWS — manual E2E validation |
