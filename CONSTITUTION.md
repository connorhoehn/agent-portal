# AWS AgentCore Accelerator — Project Constitution

## Domain: Organizational Intelligence Platform (OrgIQ)

A multi-agent system built on Amazon Bedrock AgentCore that ingests meeting transcripts, PRDs, Confluence docs, and Jira tickets to construct a living organizational knowledge graph. The platform surfaces expertise networks, collaboration patterns, delivery velocity, and influence scoring — accessible through conversational search and a visual node-graph UI powered by the AG-UI streaming protocol.

---

## Why This Domain

This domain naturally exercises **every** AgentCore service and Bedrock feature:

| Feature | How OrgIQ Uses It |
|---------|-------------------|
| **AgentCore Runtime** | All 6 agents deployed as microVM-isolated sessions |
| **A2A Protocol** | Supervisor → specialist routing (Search, Advisor, Scoring) |
| **AG-UI Protocol** | Streaming events (text, tool calls, state) to React portal |
| **MCP Gateway** | Tools for Jira, Confluence, Slack, Calendar, Neptune queries |
| **AgentCore Policy** | Cedar: managers see team scores, ICs see collaboration only |
| **AgentCore Memory** | Short-term: multi-turn search. Long-term: user preferences |
| **AgentCore Identity** | OAuth2 with corporate SSO, token vault for third-party APIs |
| **Code Interpreter** | Scoring algorithms (PageRank, betweenness centrality) |
| **Browser** | Scrape rendered Confluence pages, internal wikis |
| **Evaluations** | Score search relevance, measure agent accuracy continuously |
| **Agent Registry** | Semantic discovery of available agents |
| **Observability** | OpenTelemetry traces for full pipeline, cost tracking |
| **Knowledge Base** | Vector search over ingested documents (OpenSearch Serverless) |
| **Neptune GraphRAG** | Organizational graph — people, teams, skills, decisions |
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
│  │  portal (React 19 + Vite 7)          http://localhost:5173            │   │
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
│  │  • Neptune query routes (/graph/*)                                    │   │
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
│  │  │ (6 agents │ │ (MCP     │ │ (Cedar  │ │ (short+ │ │ (OAuth2,     │  │ │
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
│  │ Neptune Analytics │ │ OpenSearch       │ │ S3 (documents)              │ │
│  │ (128 NCU, 1024d   │ │ Serverless       │ │ DynamoDB (state, scores)    │ │
│  │  vector search)   │ │ (embeddings)     │ │                             │ │
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
model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-6-20250929-v1:0")

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
- **Role**: Routes user queries to appropriate specialist via A2A
- **Tools**: `route_to_search`, `route_to_advisor`, `route_to_scoring` (each wraps A2A invocation)
- **Memory**: Short-term session + long-term user preferences
- **Policy**: Cedar rules enforce role-based data access
- **AG-UI Events**: `RunStarted` → `StepStarted("routing")` → `TextMessageContent` → `ToolCallStart` → `StepFinished` → `RunFinished`

### 2. Ingestion Agent
- **Protocol**: HTTP (called by Bedrock Flows, not directly by users)
- **Role**: Fetch and normalize documents from multiple sources
- **MCP Tools** (via Gateway): `jira_search`, `confluence_fetch`, `s3_list_documents`, `slack_search`
- **Output**: Normalized document chunks → S3 → KB ingestion trigger

### 3. Graph Builder Agent
- **Protocol**: HTTP
- **Role**: Extract entities and relationships from documents, populate Neptune
- **Tools**: `neptune_create_node`, `neptune_create_edge`, `neptune_query` (custom @tool functions)
- **Uses Code Interpreter**: Entity extraction prompts, relationship classification

### 4. Scoring Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Compute influence, expertise, and velocity scores
- **Tools**: `neptune_pagerank`, `neptune_centrality`, `dynamodb_write_scores`
- **Uses Code Interpreter**: Custom scoring formulas, normalization
- **Algorithms**: PageRank, betweenness centrality, contribution frequency

### 5. Search Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Conversational search over docs + graph
- **Tools**: `knowledge_base_retrieve`, `neptune_traverse`, `memory_search`
- **Memory**: Session context for multi-turn refinement
- **Guardrails**: PII filter on outputs, grounding check on citations

### 6. Advisor Agent
- **Protocol**: A2A (callable by Supervisor)
- **Role**: Proactive recommendations from org patterns
- **Tools**: `neptune_query`, `dynamodb_get_scores`, `knowledge_base_retrieve`
- **Examples**: "Team X has bus factor of 1 on service Y", "Consider pairing A with B"

---

## Neptune Graph Schema (openCypher)

### Node Labels

| Label | Key Properties | Embedding |
|-------|---------------|-----------|
| `Person` | id, name, email, title, department, hire_date, influence_score, collaboration_score | Profile summary |
| `Team` | id, name, org_path, charter, size | Charter text |
| `Project` | id, name, status, priority, start_date, target_end | Description |
| `Skill` | id, name, category, subcategory | Definition |
| `Document` | id, title, type (ADR/RFC/wiki), url, created_date | Content summary |
| `Decision` | id, title, status, date, impact, outcome | Context + outcome |
| `Meeting` | id, title, type, date, summary, action_items_count | Summary |

### Edge Types

| Edge | From → To | Key Properties |
|------|-----------|---------------|
| `MEMBER_OF` | Person → Team | role, start_date, end_date, is_current |
| `WORKS_ON` | Person → Project | role, allocation_pct, contributions_count |
| `EXPERT_IN` | Person → Skill | level, since, endorsed_by_count, last_demonstrated |
| `COLLABORATES_WITH` | Person ↔ Person | strength (0-1), interaction_count, channels[] |
| `REPORTS_TO` | Person → Person | start_date, is_current |
| `AUTHORED` | Person → Document | role (primary/contributor/reviewer), date |
| `ATTENDED` | Person → Meeting | role, spoke, action_items_assigned |
| `DECIDED` | Person → Decision | role (decision_maker/advisor/dissenter) |
| `OWNS` | Team → Project | since |
| `REQUIRES` | Project → Skill | importance, min_level |
| `DEPENDS_ON` | Project → Project | type (blocks/informs/enables) |

### Key Queries

```cypher
-- Find experts for a skill
MATCH (p:Person)-[e:EXPERT_IN]->(s:Skill {name: $skill})
WHERE e.level IN ['expert', 'advanced']
RETURN p.name, p.title, e.endorsed_by_count
ORDER BY e.endorsed_by_count DESC LIMIT 10

-- Multi-hop: who collaborates with people who know X?
MATCH (expert:Person)-[:EXPERT_IN {level: 'expert'}]->(:Skill {name: $skill}),
      (expert)-[:COLLABORATES_WITH]-(candidate:Person)
WHERE NOT (candidate)-[:EXPERT_IN]->(:Skill {name: $skill})
RETURN DISTINCT candidate.name, collect(expert.name) AS connected_experts

-- PageRank (built-in Neptune Analytics algorithm)
CALL neptune.algo.pageRank({edgeLabels: ['COLLABORATES_WITH']})
YIELD node, score WHERE node:Person
RETURN node.name, score ORDER BY score DESC LIMIT 20

-- Betweenness centrality (bridge connectors)
CALL neptune.algo.betweennessCentrality({edgeLabels: ['COLLABORATES_WITH']})
YIELD node, score WHERE node:Person
RETURN node.name, node.department, score ORDER BY score DESC

-- Vector + graph hybrid: similar people then expand
-- Vector similarity (1024d Titan V2 embeddings stored on nodes)
CALL neptune.algo.vectors.topKByEmbedding({embedding: $queryVec, k: 5, nodeLabels: ['Person']})
YIELD node, score
MATCH (node)-[:EXPERT_IN]->(skill:Skill)
RETURN node.name, score, collect(skill.name) AS skills
```

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
    ports: ["5173:5173"]
    volumes:
      - ./portal/src:/app/src
    environment:
      - VITE_API_URL=http://localhost:3001
      - VITE_WS_URL=ws://localhost:3001
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
- **Phase 3a requires 2**: agents need Neptune/KB/Guardrails deployed
- **Phase 3b requires 3a**: middleware needs agent endpoints to proxy
- **Phase 4 (integration)**: wire portal to real middleware (replacing mocks)
- **Portal mock UI starts in Phase 1b**: so you can visualize while services are being built

### Phase 1a: Jupyter Exploration (Weeks 1-2)

**Goal**: Validate all AWS services, build running config

```
notebooks/
├── 00-index.ipynb                     # Workshop overview + setup guide
├── 01-setup-credentials.ipynb         # AWS config, model access, bedrock-agentcore install
├── 02-strands-agent-local.ipynb       # Define agent with @tool, invoke locally
├── 03-agentcore-runtime-deploy.ipynb  # agentcore create → deploy → invoke
├── 04-agentcore-gateway-mcp.ipynb     # Create MCP tools from OpenAPI, semantic search
├── 05-agentcore-memory.ipynb          # Short-term events, long-term extraction, retrieval
├── 06-agentcore-identity.ipynb        # OAuth setup, token vault, credential flow
├── 07-agentcore-policy-cedar.ipynb    # Cedar policies, natural language → Cedar
├── 08-knowledge-base-setup.ipynb      # OpenSearch Serverless KB + document ingestion
├── 09-neptune-graph.ipynb             # Create graph, write nodes/edges, openCypher
├── 10-neptune-algorithms.ipynb        # PageRank, centrality, vector search
├── 11-guardrails.ipynb                # Content filters, PII, topic denial, grounding
├── 12-bedrock-flows.ipynb             # Multi-node flow: ingest → enrich → store
├── 13-multi-agent-a2a.ipynb           # Supervisor + specialist A2A collaboration
├── 14-ag-ui-protocol.ipynb            # serve_ag_ui(), stream events, test frontend contract
├── 15-evaluations.ipynb               # Built-in evaluators, custom LLM-as-judge
├── 16-observability.ipynb             # OpenTelemetry traces, CloudWatch integration
├── 17-agent-registry.ipynb            # Register agents, semantic discovery
├── 18-full-pipeline.ipynb             # End-to-end: ingest → graph → score → search
├── 19-simulation-testing.ipynb        # bedrock-agentcore[simulation] for CI
└── 99-cleanup.ipynb                   # Resource teardown with tracker
```

### Phase 1b: Portal Scaffold with Mock Data (Weeks 1-2, parallel with 1a)

**Goal**: Build UI components against mock data so visualization is ready when backends come online

- Scaffold Vite + React app with ui-components dependency
- Build AgentFlowPage with static node graph (hardcoded 6 agents + tools)
- Build OrgGraphPage with synthetic graph data (20 people, 4 teams)
- Build SearchPage with mock AG-UI event stream (simulated SSE)
- Build ScoresPage with hardcoded radar/leaderboard data
- Use ui-components EventSimulator to drive demo mode

**Deliverable**: `docker-compose up portal` shows all pages with realistic-looking fake data.

### Phase 2: CDK Infrastructure (Week 3)

**Goal**: Codify data stores and Bedrock resources. Agent deployment uses AgentCore CLI separately.

CDK handles (stateful resources):
- S3 buckets (documents, artifacts)
- DynamoDB tables (scores, session state, leaderboards)
- OpenSearch Serverless collection + Bedrock Knowledge Base
- Neptune Analytics graph (128 NCU, vector dim 1024)
- Bedrock Guardrails (PII filter, content policy, grounding)
- Bedrock Managed Prompts (versioned agent system prompts)
- IAM roles for all cross-service access
- CloudWatch dashboards and budget alarms

AgentCore CLI handles (agent deployment):
- `agentcore create` → scaffold agent project structure
- `agentcore add memory` → configure memory resources
- `agentcore add gateway` → configure MCP gateway
- `agentcore add policy-engine` → configure Cedar policies
- `agentcore deploy` → CodeBuild → ECR → Runtime

```
infra/
├── bin/app.ts
├── lib/
│   ├── foundation-stack.ts            # S3, DynamoDB, IAM base roles
│   ├── knowledge-base-stack.ts        # OpenSearch Serverless + Bedrock KB + data source
│   ├── neptune-stack.ts               # Neptune Analytics (CfnGraph, vector search)
│   ├── guardrails-stack.ts            # Bedrock Guardrails (PII, content, grounding)
│   ├── prompts-stack.ts               # Bedrock Managed Prompts (CfnPrompt)
│   ├── flows-stack.ts                 # Bedrock Flows (ingestion pipeline)
│   ├── observability-stack.ts         # CloudWatch dashboards, budget alarm
│   └── outputs-stack.ts              # Cross-stack output aggregation
├── schemas/
│   ├── openapi/                       # OpenAPI specs for MCP Gateway tools
│   │   ├── jira-tools.yaml
│   │   ├── confluence-tools.yaml
│   │   └── neptune-tools.yaml
│   └── cedar/                         # Cedar policy templates
│       ├── manager-access.cedar
│       └── ic-access.cedar
├── cdk.json
├── package.json
└── tsconfig.json
```

### Phase 3a: Agent Implementation (Week 4)

**Goal**: Working agents deployed to AgentCore Runtime

```
agents/
├── supervisor/
│   ├── main.py                        # BedrockAgentCoreApp + AG-UI protocol
│   ├── tools.py                       # route_to_search, route_to_advisor, etc.
│   ├── pyproject.toml
│   └── Dockerfile
├── ingestion/
│   ├── main.py                        # MCP tool consumer (Jira, Confluence, S3)
│   ├── tools.py                       # normalize_document, chunk_text
│   ├── pyproject.toml
│   └── Dockerfile
├── graph-builder/
│   ├── main.py                        # Entity extraction + Neptune writes
│   ├── tools.py                       # neptune_create_node, neptune_create_edge
│   ├── pyproject.toml
│   └── Dockerfile
├── scoring/
│   ├── main.py                        # A2A protocol, scoring algorithms
│   ├── tools.py                       # neptune_pagerank, compute_scores
│   ├── pyproject.toml
│   └── Dockerfile
├── search/
│   ├── main.py                        # A2A protocol, KB + Neptune hybrid search
│   ├── tools.py                       # knowledge_base_retrieve, neptune_traverse
│   ├── pyproject.toml
│   └── Dockerfile
└── advisor/
    ├── main.py                        # A2A protocol, recommendations
    ├── tools.py                       # pattern detection queries
    ├── pyproject.toml
    └── Dockerfile
```

### Phase 3b: Middleware (Week 5)

**Goal**: Bridge deployed agents + Neptune to portal via AG-UI proxy + WebSocket

Standalone Express service (imports distributed-core for WS, does NOT modify platform-api):

```
middleware/
├── src/
│   ├── index.ts                       # Express app setup
│   ├── routes/
│   │   ├── agents.ts                  # AG-UI proxy (SSE passthrough)
│   │   ├── graph.ts                   # Neptune queries (entities, relationships, search)
│   │   ├── scores.ts                  # Leaderboards, breakdowns, trends
│   │   ├── ingest.ts                  # Trigger ingestion, monitor progress
│   │   └── traces.ts                  # Fetch OpenTelemetry traces
│   ├── lib/
│   │   ├── neptune.ts                 # Neptune Analytics query client (Sig4 + openCypher)
│   │   ├── agentcore.ts              # AgentCore SDK operations
│   │   └── bedrock.ts                # Bedrock KB retrieve, guardrail apply
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
│   │   ├── useGraphData.ts            # Fetch Neptune data, transform to @xyflow nodes
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
| Agent deployment | **AgentCore CLI** (`@aws/agentcore`) | `create/dev/deploy` workflow, handles ECR + Runtime |
| Graph store | **Neptune Analytics** (128 NCU, 1024d vectors) | Built-in PageRank/centrality, vector search, openCypher |
| Vector store | **OpenSearch Serverless** | KB quick-create, hybrid search + reranking |
| Embedding model | **Titan Embeddings V2** (1024d) | Cost-effective, Neptune vector dim set to match |
| LLM | **Claude Sonnet 4** via Bedrock | Best price/performance for agent orchestration |
| IaC (data stores) | **CDK TypeScript** | L1 constructs for all Bedrock/Neptune resources |
| IaC (agents) | **AgentCore CLI** | Manages Runtime, Gateway, Memory, Policy lifecycle |
| Middleware | **Express + distributed-core** | AG-UI SSE proxy, WebSocket bridge, Neptune client |
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
- **Strands agent code** (6 agents with tools, prompts, memory integration)
- **CDK stacks** (Neptune, KB, Guardrails, Prompts, Flows)
- **AgentCore configuration** (agentcore.json, gateway targets, policies)
- **Middleware** (AG-UI proxy, Neptune query layer, WebSocket bridge)
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
├── docker-compose.yml                  # Full local stack (jupyter + middleware + portal)
├── .env.example                        # Template for AWS config
│
├── notebooks/                          # Phase 1: Jupyter exploration
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── config.json                     # Shared state across notebooks
│   ├── cleanup_utils.py               # Resource tracking + teardown
│   ├── 00-index.ipynb ... 99-cleanup.ipynb
│   ├── data/                           # Synthetic org data
│   │   ├── transcripts/
│   │   ├── documents/
│   │   ├── jira/
│   │   ├── confluence/
│   │   └── org/
│   └── scripts/
│       ├── start.sh
│       ├── stop.sh
│       └── check-aws.sh
│
├── agents/                             # Phase 3: Strands agent implementations
│   ├── supervisor/
│   ├── ingestion/
│   ├── graph-builder/
│   ├── scoring/
│   ├── search/
│   └── advisor/
│
├── infra/                              # Phase 2: CDK stacks
│   ├── bin/app.ts
│   ├── lib/
│   ├── schemas/
│   ├── cdk.json
│   └── package.json
│
├── middleware/                          # Phase 3: Express + WS bridge
│   ├── src/
│   ├── Dockerfile
│   └── package.json
│
└── portal/                             # Phase 4: React UI
    ├── src/
    ├── Dockerfile
    ├── package.json
    └── vite.config.ts
```

---

## Running Locally

```bash
# Prerequisites
aws sso login --profile bedrock
export AWS_PROFILE=bedrock

# Start the app stack (middleware + portal + jupyter)
docker-compose up --build

# Services:
#   Jupyter    → http://localhost:8888
#   Middleware → http://localhost:3001
#   Portal    → http://localhost:5173

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
@connorhoehn:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Middleware imports distributed-core from GitHub:
```json
"distributed-core": "github:connorhoehn/distributed-core#main"
```

---

## Deployment (AWS)

```bash
# 1. Deploy data infrastructure (CDK)
cd infra && npx cdk deploy --all

# 2. Deploy agents (AgentCore CLI)
cd agents/supervisor && agentcore deploy
cd agents/search && agentcore deploy
cd agents/scoring && agentcore deploy
cd agents/advisor && agentcore deploy
cd agents/ingestion && agentcore deploy
cd agents/graph-builder && agentcore deploy

# 3. Verify
agentcore status
agentcore invoke --agent supervisor --prompt "Who are our Kubernetes experts?"
```

---

## Success Criteria

1. `docker-compose up` → All 3 services healthy, hot-reload working
2. Run any notebook → Live AWS responses (no mocks, no numpy fakes)
3. Portal agent flow → See 6 agents as nodes with tool/memory/guardrail connections
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
| AgentCore Runtime (6 agents, light) | ~$10-25 |
| AgentCore Gateway + Registry | ~$2-5 |
| AgentCore Memory | ~$2-5 |
| Bedrock Models (Claude Sonnet 4) | ~$15-40 |
| Neptune Analytics (128 NCU) | ~$20-50 |
| OpenSearch Serverless (2 OCU min) | ~$20-50 |
| S3 + DynamoDB | ~$1-5 |
| CloudWatch (traces + logs) | ~$5-10 |
| **Total** | **~$75-190/month** |

Budget alarm at $200/month in CDK observability stack. Cleanup notebook + `cdk destroy` for teardown.

---

## Testing Strategy

| Layer | Approach |
|-------|----------|
| Notebooks | Manual execution against live AWS (the point is validation) |
| Agents (unit) | `bedrock-agentcore[simulation]` — mock LLM responses, test tool routing |
| Agents (integration) | `agentcore dev` locally → invoke with test prompts |
| Middleware | Vitest — mock Neptune/AgentCore clients, test route handlers |
| Portal | Playwright e2e — mock middleware responses, test AG-UI event rendering |
| CDK | `cdk synth` → snapshot tests for CloudFormation templates |
| Full stack | Docker-compose + real AWS — manual E2E validation |
