# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator. Multi-agent system
on Amazon Bedrock AgentCore: ingests org docs → builds knowledge graph → scores
expertise → serves conversational search. See CONSTITUTION.md for full spec.

**How to read this file.** *Orientation* (Architecture → Common workflows) is
the map: where things live, what deploys what, how to run it. *The docs map*
points at the long-form design docs and the validators that judge them.
*Gotchas* is the scar tissue — each entry is a day someone lost, grouped by
the area it bites in, and each says **why**, not just what. Skim the gotcha
headings; read the one whose area you are about to touch. Everything here is
meant to be checkable: if a claim disagrees with the code, the code wins and
the claim is a bug in this file.

---

## Current checkpoint

The 2026-09-19 checkpoint was pushed as `f837bd68`; the user subsequently
resumed work. Read [the handoff](docs/handoff-2026-09-19.md) for the checkpoint's
completed fixes/tests and unfinished browser verification. Its pause is
historical; do not treat the checkpoint as full acceptance.

# Orientation

## Architecture

- **notebooks/** — JupyterLab exploration. Split by cloud: `notebooks/aws/` (Python 3.12, boto3, bedrock-agentcore SDK) and `notebooks/gcp/` (Python 3.12, google-cloud-aiplatform, vertexai, google-genai). Both mount `notebooks/` at `/workspace` so the file browser sees both flavors.
- **agents/** — 8 Strands Agents (6 OrgIQ + 2 assessment), Python 3.12, deployed to AgentCore Runtime via multistage Docker. Shared helpers in `agents/_shared/`; common base image in `agents/base/`. `agents/devbox/` is a ninth runtime but not a Strands agent (it runs Claude Code — see the devbox gotcha).
- **infra/** — CDK TypeScript stacks (Aurora, OpenSearch, Guardrails, KB, AgentCore Memory/Policy/Capabilities/Runtime/Gateway/Telemetry, Authorization, Authentication, SpanProjector, PromptCanary, Devbox, MiddlewareService)
- **middleware/** — Express 5 + `@connorhoehnslalom/realtime-modules` (AG-UI SSE proxy, RDS Data API queries against Aurora, WebSocket bridge, OI trace sink)
- **portal/** — React 19 + Vite 7 (ui-components library, @xyflow/react for graphs)
- **schema/** — Aurora SQL (`orgiq_schema.sql` + `orgiq_work_items_schema.sql` + observability + `program_schema.sql` + `assessment_schema.sql` + `identity_schema.sql`) and LLM-driven synth corpus pipeline

## Local dev

```bash
node scripts/docker/prepare-libraries.mjs # export exact locked library commits
docker-compose up --build            # jupyter + middleware + portal
docker-compose up jupyter            # AWS notebooks at :8888 (cd /workspace/aws)
docker-compose up jupyter-gcp        # GCP notebooks at :8889 (cd /workspace/gcp)
docker-compose up middleware portal  # App stack at :3001 + :5183
```

**Working without AWS** (stack torn down, credentials expired, offline):
```bash
cd middleware && npm run dev:mock    # then `cd portal && npm run dev` as usual
```
`dev:mock` turns on the `MOCK_*` providers, sets `DEV_OFFLINE=true` +
`NODE_ENV=development` + `AUTH_DEMO_MODE=true`, *and* blanks `POLICY_STORE_ID`,
`SESSION_SIGNING_SECRET_ARN` and the `COGNITO_*` vars. Blanking matters:
`.env.aws` is only read for vars the shell leaves undefined, so a stale
`POLICY_STORE_ID` makes every gated route 503 with "authorization unavailable",
and stale Cognito vars redirect login to a hosted UI that may no longer
resolve. Blank means open-mode authz (dev-only) plus the user picker. The mock
fixtures mirror `schema/seed_program.sql`, so initiatives, work items, budgets
and sprint envelopes all render with the real cast.

**The mock is a contract, not a pile of stubs** — `docs/mock-floor.md` is the
working guide and `middleware/src/mock/core/contract.ts` is the reasoning (the
five bug classes that put it there). The short version: a fixture exports rows
and selectors, never a number it could have counted from rows it also exports;
every timestamp comes from `mock/core/clock.ts`; every wire-shaped string is
checked against a captured real response rather than typed from memory; and a
write mutates a **registered** fixture so `POST /api/__mock/reset` undoes it.
To see an empty or error state, ask for it — `GET /api/__mock/scenarios`,
`POST /api/__mock/scenario {"scenario":"empty","fixture":"bots"}` — instead of
damaging shared state and warning the next person in a journey log.
`GET /api/__mock/state` reports what is currently loaded. The router
(`middleware/src/routes/mock-control.ts`, mounted at the app root in
`index.ts`) 404s unless `NODE_ENV !== 'production'` **and** at least one of
`MOCK_AURORA` / `MOCK_AGENTCORE` is on, and each route additionally honours an
optional `MOCK_CONTROL_SECRET` header check.
`./scripts/validate-mock-floor.sh` is the judge, and its budgets are ratchets:
they may go down, never up.

**Agents are NOT in docker-compose.** Develop agents with:
```bash
cd agents/<name> && agentcore dev    # Hot-reload local server at :8080
```

The agent unit tests (`agents/_shared/test_*.py`) import `botocore`, which the
host's `python3`/`python3.12` does not have — run them in the synth venv, which
does: `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source test_callbacks`
(61 tests). Never `pip install` to fix this.

Requires `~/.aws` credentials. Run `aws-azure-login --mode gui` first — the `default` profile assumes `aws-innovationlabs-washingtondc1-admin` in the **innovation lab account `647757222309`** (us-east-1). ⚠️ Account `264161986065` is a personal account and must NOT be used for this project.

## Key SDKs

Python pins live in `agents/base/Dockerfile` (the shared base installs them
once) and are mirrored per agent in `agents/*/pyproject.toml`. All eight
Strands agents pin identically.

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.55 | Agent framework (@tool, Agent, stream_async) |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` | >=0.1.18 | AG-UI event types + SSE encoder |
| `ag-ui-strands` | >=0.1.8 | Strands → AG-UI adapter (StrandsAgent) |
| `aws-opentelemetry-distro` | >=0.12.1 | ADOT — **not** vanilla `opentelemetry-distro`, see the ADOT gotcha |
| `boto3` | >=1.34 | Bedrock, RDS Data API (Aurora), S3, DynamoDB, OpenSearch, Verified Permissions |
| `@aws/agentcore` | latest | AgentCore CLI (npm global install — bundled into the jupyter image; install globally on the host if you want `agentcore dev`/`agentcore exec` outside Docker) |

Two deliberate exceptions: the supervisor takes `bedrock-agentcore[a2a,ag-ui]`
(everyone else takes `[ag-ui]`), and `agents/devbox` pins only
`bedrock-agentcore` — it is not a Strands agent and has no ag-ui dependency.

⚠️ Those extras are what each `pyproject.toml` DECLARES, not what the images
install: `agents/base/Dockerfile` installs the superset
`bedrock-agentcore[a2a,ag-ui]` once and `agents/Dockerfile.agent` is a thin
`FROM ${BASE_IMAGE}`, so every shipped agent image carries the `a2a` extra
whether or not its pin asks for it — and nothing uses it. The supervisor's
sub-agent calls are `invoke_agent_runtime` against each sub-agent's runtime
ARN, the plain Runtime API, not A2A; its docstring claimed otherwise until
2026-09-16. See `docs/research-strands-graph-2026-09-16.md` for why the
routing stays hand-rolled rather than becoming a Strands `Graph`.

## CDK vs AgentCore CLI — what deploys what

| Resource | Deployed by |
|----------|-------------|
| Aurora Serverless v2 cluster (PostgreSQL + pgvector) | CDK (`OrgIQ-Aurora`) |
| OpenSearch Serverless + Bedrock KB | CDK (`OrgIQ-KnowledgeBase` — `CfnKnowledgeBase` + `CfnDataSource`) |
| Bedrock Guardrails (one per role, `orgiq-guardrail-<role>`) | CDK (`OrgIQ-Guardrails` — `CfnGuardrail`) |
| Verified Permissions policy store + Cedar policies | CDK (`OrgIQ-Authorization`) |
| Cognito User Pool + Hosted UI + app client (enterprise SSO) | CDK (`OrgIQ-Authentication`) |
| S3 buckets, DynamoDB tables, IAM roles | CDK (`OrgIQ-Foundation`) |
| CloudWatch dashboards + budget alarm | CDK (`OrgIQ-Observability`) |
| Agent ECR repos + execution roles (8 agents + shared base) | CDK (`OrgIQ-AgentCoreRuntime` — phase 1). `OrgIQ-Agents` owns the *agent* IAM roles and Managed Prompts for the same 8. |
| Agent Runtime (`CfnRuntime` + `CfnRuntimeEndpoint`, all 8 agents) | CDK with `--context deployRuntimes=true` (`OrgIQ-AgentCoreRuntime` — phase 2) |
| MCP Gateway + targets + Cedar policies | CDK (`OrgIQ-AgentCoreGateway` — `CfnGateway`, `CfnGatewayTarget`, `CfnPolicy`) |
| AgentCore Memory | CDK (`OrgIQ-AgentCoreMemory` — `CfnMemory`) |
| AgentCore Policy Engine | CDK (`OrgIQ-AgentCorePolicy` — `CfnPolicyEngine`) |
| AgentCore Capabilities (Code Interpreter, Browser + profile, Workload Identity) | CDK (`OrgIQ-AgentCoreCapabilities`) |
| Custom Evaluators + alarms + anomaly detectors | CDK (`OrgIQ-AgentCoreTelemetry` — `CfnEvaluator`) |
| Online Evaluation config | CDK with `--context enableOnlineEvalConfig=true`. No L1 exists — it is a raw `CfnResource` of type `AWS::BedrockAgentCore::OnlineEvaluationConfig`. |
| Span Projector Lambda (OpenInference → Aurora observability tables, 1-min schedule) | CDK (`OrgIQ-SpanProjector`) |
| Prompt canary (A/B + judge managed prompts, SSM params, SFN controller) | CDK (`OrgIQ-PromptCanary`) — `deployCanary` defaults **true** in `cdk.json` |
| Devbox runtime (Claude Code in a microVM, session storage) | CDK with `--context deployDevbox=true` (`OrgIQ-Devbox`) |
| Middleware on ECS Fargate + ALB | CDK with `--context deployMiddlewareService=true` (`OrgIQ-MiddlewareService`) |

## Agent Dockerfile requirements (AgentCore Runtime)

These live in **`agents/base/Dockerfile`**, the shared base image every agent
extends. `agents/Dockerfile.agent` is a ~20-line `FROM ${BASE_IMAGE}` plus two
`COPY` layers — it carries none of these directives, so a change here goes in
the base.

- Multistage: `uv` builder → `python:3.12-slim` production
- Non-root user: `bedrock_agentcore` (UID 1000)
- Ports: 8080 (HTTP/AG-UI invocations), 8000 (health/MCP)
- Health check: `GET /ping` on 8080
- CMD: `opentelemetry-instrument python -m main`
- Max image size: 2 GB (AgentCore Runtime quota)
- ARM64 at deploy — built locally with `docker buildx`, not CodeBuild (see the build-order gotcha)

## Conventions

- TypeScript strict mode for middleware, infra, portal
- Python 3.12+ for agents and notebooks
- Org graph lives in Aurora PostgreSQL as relational tables (no Neptune, no AGE — see `schema/orgiq_schema.sql`)
- Graph access via RDS Data API + parameterized SQL. Read tools enforce SELECT/WITH only.
- AG-UI protocol for agent→frontend streaming (SSE transport, POST not EventSource)
- A2A protocol for agent→agent communication
- Cedar policies live in **Verified Permissions** (`OrgIQ-Authorization` stack); the supervisor resolves a role per request and attaches the role-specific guardrail at model-build time
- All notebooks share `config.json` for cross-notebook state (progressive enrichment). It is gitignored — `notebooks/aws/config.json` is generated by `01-setup-credentials.ipynb`.
- Resource tracker (`notebooks/aws/cleanup_utils.py`, mirrored in `notebooks/gcp/`) tracks all AWS resources for safe teardown
- `INSERT ... ON CONFLICT DO UPDATE` for idempotent upserts (handled by graph-builder `merge_*` tools)
- Scores stored as columns on `people` (`expertise_score`, `pagerank_score`, `composite_score` — `schema/orgiq_schema.sql`)
- Titan Embeddings V2 at 1024 dimensions everywhere (`node_embeddings vector(1024)` in Aurora + Bedrock KB)
- **OpenInference instrumentation** lives in `agents/_shared/instrumentation.py` (root AGENT span, RETRIEVER spans, guardrail capture). Spans are exported via ADOT and projected into Aurora observability tables by the `OrgIQ-SpanProjector` Lambda
- Default model is `amazon.nova-pro-v1:0`, overridable per agent via `MODEL_ID` env var (AWS-native only — no Anthropic models)

## Naming conventions

- AWS resources: prefix `orgiq-` (`orgiq-knowledge-base`, `orgiq-aurora`, `orgiq-guardrail-<role>`, `orgiq-agent-base`)
- CDK stack names: `OrgIQ-Foundation`, `OrgIQ-Aurora`, `OrgIQ-KnowledgeBase`, `OrgIQ-Guardrails`, `OrgIQ-Authorization`, `OrgIQ-Authentication`, `OrgIQ-Agents`, `OrgIQ-Observability`, `OrgIQ-AgentCoreMemory`, `OrgIQ-AgentCorePolicy`, `OrgIQ-AgentCoreCapabilities`, `OrgIQ-AgentCoreRuntime`, `OrgIQ-AgentCoreGateway`, `OrgIQ-AgentCoreTelemetry`, `OrgIQ-SpanProjector`, `OrgIQ-PromptCanary`, `OrgIQ-Devbox`, `OrgIQ-MiddlewareService` (18 with `cdk.json`'s defaults)
- Agent names: `orgiq-supervisor`, `orgiq-search`, `orgiq-scoring`, `orgiq-advisor`,
  `orgiq-ingestion`, `orgiq-graph-builder`, `orgiq-assessment-scorer`, `orgiq-assessment-drafter`
- DynamoDB tables: `orgiq-scores`, `orgiq-sessions`, `orgiq-leaderboards`
- S3 buckets: `orgiq-documents-{account}-{region}`, `orgiq-artifacts-{account}-{region}`

## Common workflows

```bash
# Deploy all infrastructure (18 stacks with cdk.json defaults) — cleans up
# orphaned resources first, then reconciles every stack's real CFN status
cd infra && ./scripts/deploy.sh

# Deploy a single stack
cd infra && ./scripts/deploy.sh OrgIQ-Aurora

# Phase 2: deploy runtimes after pushing container images to ECR
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true
# ...or only the agents whose images actually exist:
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true --context onlyAgents=supervisor,search

# Turn on online evaluation. `enableEval` is already "true" in cdk.json, so in
# practice only the config resource needs asking for:
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreTelemetry --context enableOnlineEvalConfig=true

# Destroy everything — drains Cedar policies, orphan gateways, runtimes and
# the Aurora cluster first, then sweeps for survivors that still bill
cd infra && ./scripts/destroy.sh

# Run CDK synth (dry-run). Needs live credentials for context lookups.
cd infra && npx cdk synth

# Invoke deployed agent
agentcore invoke --agent orgiq-supervisor --prompt "Who knows auth best?"

# Test agent locally
cd agents/search && agentcore dev "Find Kubernetes experts"

# Middleware tests (jest + supertest) and typecheck
cd middleware && npm test && npm run typecheck

# Agent unit tests — in the synth venv, which has botocore
cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source test_callbacks

# Golden-set eval harness — structural mode (free, offline, no AWS); see docs/agent-eval-goal.md
cd agents/tests && ../../.venv-synth/bin/python golden_runner.py
# Live grading against a deployed runtime or `agentcore dev` — real Bedrock $, needs credentials
cd agents/tests && ../../.venv-synth/bin/python golden_runner.py advisor --mode live

# Generate the synthetic demo corpus (personas, ADRs, postmortems, perf reviews,
# Slack threads, all-hands recaps).
# Requires Aurora + KB deployed and schema/seed.py applied first.
python3.11 -m venv .venv-synth && .venv-synth/bin/pip install -r schema/synth/requirements.txt
.venv-synth/bin/python -m schema.synth all                # full pipeline
.venv-synth/bin/python -m schema.synth all --skip-load    # generate only, no Aurora/S3/KB writes
.venv-synth/bin/python -m schema.synth stats              # corpus + cache snapshot
```

## Project dependencies

- **ui-components** (`~/projects/ui-components`): `@connorhoehnslalom/ui-components`,
  installed at **2.407.20** (sha `cc57807c`, verified 2026-09-29 with the two settling
  commands below; 2.407.9 carries the CallDock render fixes and `--dock-floor`). 2.385 added `@tiptap/extension-mention` to what the rich
  composer imports; it is an *optional* peer, so npm does not install it and Vite
  fails at runtime with "Could not resolve @tiptap/extension-mention" — the portal
  now lists it directly. Check new optional peers after every bump. The portal pins it by **git sha** in `package.json`
  (`github:connorhoehnslalom/ui-components#<sha>`) rather than resolving a range
  from GitHub Packages — bump by moving the sha. It resolves over SSH, so no
  `GITHUB_TOKEN` and no registry `.npmrc` are needed; `portal/.npmrc` holds only
  `strict-ssl=true`. (Older instructions here described a
  `@connorhoehnslalom:registry=https://npm.pkg.github.com` + `_authToken` setup —
  that applied when the dep resolved from GitHub Packages and no longer does.)
  Peer deps include react 19, @xyflow/react 12, recharts 3, yjs 13, @tiptap/* 3,
  @xterm 6.

- **realtime-modules**: `@connorhoehnslalom/realtime-modules`, pinned by sha in
  **both** middleware and portal. The middleware uses
  `.../agent-streaming` (`routes/agents.ts`, the AG-UI streaming route). The
  generic service-signing proxy in `routes/gateway-proxy.ts` is retired (410):
  it had no verified user/channel-membership contract. Portal health probes
  still use `.../proxy-client`. The library replaced the older
  `distributed-core` import — nothing in the repo depends on `distributed-core`
  any more, and a lone stale comment in `providers/distillation.ts` still names
  its EventBus. ⚠️ Two remotes, two version lines: this repo pins the
  **`connorhoehn/realtime-modules`** canonical repository (the slalom fork is
  the second remote and is not what either package.json points at). As of
  2026-09-29 **both** the middleware and the portal pin
  `71a46567c5153a3ff43768808036783d48a2671c` (0.98.7, tag
  `realtime-modules-v0.98.7`; from `d84d9612`/0.98.3 via 0.98.4–0.98.6 — 0.98.4
  fixed the ghost participant after both call sockets close under
  `attachRealtime`, recognises tenant-prefixed `<org>:dm:` lobbies, and
  refuses targetless invites by default (`calls({ allowUntargetedInvites })`);
  0.98.5 stamps chat/presence/reaction sender identity from the socket's
  auth context instead of trusting the frame (`chat({ resolveSender,
  trustFrameSender })`, default untrusted — so our gateway `auth` MUST return
  `displayName`, and it does) and ships `typesVersions` so the `/server`
  types resolve under `tsconfig.test.json`'s `moduleResolution: "node"`;
  0.98.6 makes the router the single authorization point — a refused
  presence/reactions/cursor subscribe reaches no service state, and every
  fan-out (presence `set`, reactions, cursor, chat send/edit/history/members)
  runs `authorize` first, answering `AUTHZ_CHANNEL_DENIED`; chat channels
  arrive at the hook unprefixed, only presence/reactions/cursor wrap as
  `presence:`/`reactions:`/`cursor:` (`splitServiceChannel` strips them);
  0.98.7 gates presence `get` by `targetClientId` on a readable shared
  channel, answering an unreadable target like an unknown one; middleware
  typecheck and the gateway tests unchanged — one test had to change:
  `distillation-realtime.test.ts` asserted "no frame names the refused
  channel", and since 0.98.6 the refusal itself is an error frame naming
  it). ⚠️ `jest.config.cjs`
  ignores TS2307/TS2304/TS2345, which is how a `/server` type import once
  became `any` silently — un-hiding those codes is an open follow-up. 0.98.x adds the conversation-call surface
  under `/client/video` — `useConversationCall`,
  `useIncomingConversationCalls`, `conversationCallDockProps`,
  `useDevicePreferences`, `dmLobbyName` — and `calls({ lobbyGuard })` on the
  server; the initiative call (`portal/src/pages/projects/InitiativeCall.tsx`)
  uses it. `/client/video` ships its own `LVSProvider` and WHIP/WHEP
  transport: it neither bundles nor peer-depends on `@connorhoehn/lvs-react`
  / `lvs-client`, so no LVS package is installed here. 0.97 dropped `./package.json` from the
  package's `exports`, so the settling version check is
  `node -p "require('./node_modules/@connorhoehnslalom/realtime-modules/package.json').version"`
  from `portal/` or `middleware/` — `require('…/package.json')` by package
  name throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The portal's socket
  authenticates with the BFF's realtime token: `portal/src/lib/realtimeToken.ts`
  fetches and caches `GET /api/session/realtime-token` (cleared by
  `clearTenantScopedCaches`), and `OptionalGatewayProvider` hands it to
  `GatewaySocketProvider`'s `token`, which the library sends as
  `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`. A changed `token` prop
  reconnects the socket, so the token is swapped only when the socket is
  down, never proactively while connected.
  The middleware also imports `.../server` and `.../adapters/tiptap`
  (distillation realtime, document canvas), not only `agent-streaming`.
  The dependency key remains
  `@connorhoehnslalom/realtime-modules` so existing imports keep working.
  The former slalom 0.17.0 pin advertised server/typed-documents subpaths with
  absent built files. Server exports now load. The full document workflows
  additionally depend on platform-api; see
  `docs/document-backend-integration-2026-09-19.md`. Do not confuse that REST
  backend with the package's typed-documents subscription service.
  [The workspace reuse research](docs/document-workspace-reuse-research-2026-09-20.md)
  records the shared canvas composition, converter regressions, and the user
  requirement to preserve the accelerator's navigation/draft/publish UX.

**Realtime integration task exception (user-authorized 2026-09-19):** the user
explicitly requested fixes in the owning sibling repos while making the MQ/DC/
realtime middleware and supporting Docker containers reusable and deployable
through CDK. For this work, read each repo's instructions, fix shared contracts
upstream, and record commits and consumer verification. Preserve unrelated
in-flight edits. Do not rebuild UI that those projects already provide.
See [the middleware deployment research](docs/realtime-middleware-deployment-research-2026-09-20.md).
Outside that task, consume libraries and queue UI gaps in
`docs/ui-components-queue.md`.

## Synthetic corpus pipeline (`schema/synth/`)

Generates a complete demo corpus from the seed graph using AWS-native models.
Reads people/teams/skills/projects/decisions from Aurora, writes documents +
mentions + node_embeddings back. Per-doc disk cache makes reruns free.
`verify_adr.py` / `verify_docs.py` spend real Bedrock $ — don't run them
casually. Corpus size is not fixed: the per-type counts in `synth/config.py`
are env-overridable defaults multiplied by live row counts, so read
`schema.synth stats` rather than trusting a remembered total. Ballpark cost for
a full demo-grade run is well under a dollar.

## Program operating model

See `docs/program-operating-model.md` for the full frame. In short: one **owner**
runs each initiative and a few **SMEs** attach across several — never a ten-person
team per initiative. A release manager (`org-leader`, holds `ManageBudgets`)
allocates `initiative_budgets` monthly and grants an SME a sprint envelope
(`budget_grants`); the SME (`sme` role — member + `DispatchAgentRun`, explicitly
forbidden `ApproveTransaction`) spends it by assigning agents to work. Work is
estimated in **complexity** (`story_points`) and **dollars**
(`estimated_cost_usd`), never human-hours. Cron bots are the **baseline cost of
maintaining** an initiative's repos — `v_initiative_maintenance_30d`
(`schema/program_schema.sql`) is that floor, and an allocation should be read
against it. Bots on an initiative target enqueue `agent_jobs` for the fleet
dispatcher rather than running directly, so scheduled maintenance rides the same
governed pipeline as hand-driven runs.

Seed data lives in `schema/seed_program.sql`, generated by
`schema/seeds/generate_program_seed.py` (regenerate, don't hand-edit): 14
canonical initiatives with owner+SME contributions, epics/stories/bugs
carrying both estimates, sprints, grants, and maintenance bots with ~30 days of
run history. The middleware's no-Aurora fallbacks mirror it exactly.
⚠️ Initiative ids and *person* ids share the `p-` prefix — the 14 initiatives are
the slug-shaped ones (`p-auth-migration`, `p-rag-search`, `p-soc2`, …) while
people are `p-001`…`p-056`, so a bare `grep 'p-'` conflates them. Initiatives
are rows in `projects`, not a table named `initiatives`.
⚠️ Seeded bots are **parked** and no `queued` jobs are seeded — `initBotScheduler`
registers every enabled cron bot at boot and the dispatcher claims queued jobs
as soon as a box is idle, so either would fire against repos that don't exist
yet. Provision the repo, then un-pause the bot. ⚠️ The retired `seed_work_items*.sql` /
`schema/seeds/work_items_*.sql` family targeted a `proj-*` project family that
no seed ever created — those files are gone; don't resurrect those ids.

🔒 **Every GitHub repo generated for an initiative MUST be created private, and
"private" is the default to assert, not a preference to ask about.** Fourteen
`orgiq-*` repos (`orgiq-auth-service`, `orgiq-rag-search`, `orgiq-zero-trust`,
`orgiq-llm-platform`, `orgiq-finops`, `orgiq-compliance`, `orgiq-data-lake`,
`orgiq-feature-store`, `orgiq-stream-analytics`, `orgiq-inference-platform`,
`orgiq-observability`, `orgiq-mobile-app`, `orgiq-design-system`,
`orgiq-design-system-api`) were provisioned **public** in
`github.com/connorhoehnslalom` and stayed that way until 2026-09-29, when they
were flipped private. Nothing in this repo creates them, which is exactly why the
default went unchecked: the provisioning lives outside the tree, so no code
review here ever saw a visibility flag. These repos are the targets cron
maintenance bots and dispatched work items push commits to, so a public one
publishes generated code, branch names and commit messages describing internal
initiatives. Visibility is also not fully reversible — anything public may
already be cached, forked or indexed. Check with
`gh repo list <owner> --visibility public` after provisioning rather than
trusting the creating call's default, and pass `--private` (or `private: true`)
explicitly.

## The docs map

Long-form design lives in `docs/`. Several features follow a **goal-doc +
validator** pattern: `docs/<feature>-goal.md` states the definition of done and
`scripts/validate-<feature>.sh` is the only judge — it exits 0 only when every
mechanical check passes, and prints every failing line so one run shows the
whole backlog. Most take `--quick` to skip the slow suites (jest, vite build).

| Doc | What it is | Judge |
|-----|------------|-------|
| `program-operating-model.md` | How work, people, money and agents relate. Read before touching initiatives, budgets or the work queue. | — |
| `assessment-tenant.md`, `assessment-parity.md`, `assessment-goal.md` | The second tenant's contract, its parity with the source app, and its goal | `validate-assessment-tenant.sh` |
| `mock-floor.md`, `mock-floor-goal.md` | The `dev:mock` fixture contract | `validate-mock-floor.sh` |
| `orgiq-audit.md`, `orgiq-audit-goal.md` | Surface-by-surface audit of the org tenant as the real seed users | `validate-orgiq-audit.sh` |
| `branding.md`, `branding-goal.md` | The token/colour system the portal paints from | `validate-branding.sh` |
| `distillation.md`, `distillation-goal.md` | `/iq/distillation` — the fleet's shared memory | `validate-distillation.sh` |
| `route-test-coverage.md` | Route ↔ test parity across every router | `validate-route-coverage.sh` |
| `research-honesty-checks-2026-09-16.md` | The four "numbers that lie" bug classes, the class-4 triage rule (rates vs latencies), and each scanner's false-positive story | `validate-honest-numbers.sh` |
| `nav-server-tier-decisions.md` | Nav ↔ route parity: the rail, the palette and `App.tsx` must gate every page the same way, every palette jump must resolve, and a nav item must not be gated narrower than the API it reads (that last one is ratcheted — the doc is where those get decided) | `validate-nav-parity.sh` |
| `ui-components-queue.md` | Composites the library is missing — and, since it is the ledger the component-discipline gate reads, the ONLY thing that exempts a file from it. A row must say "Composed locally in `<file>`" to mint an exemption. | `validate-component-discipline.sh` |
| `agent-eval-goal.md` | Per-agent golden sets (`agents/tests/golden/*.json`) + `agents/tests/golden_runner.py` — a `--mode structural` offline regression suite the validator runs, and a `--mode live` operator workflow (real Bedrock $, needs a deployed runtime or `agentcore dev`) it deliberately does not | `validate-agent-eval.sh` |
| `agentcore-preview-surface.md` | Verified preview-API research + the machine-callback operator runbook (§6a) | — |
| `agentcore-preview-plan.md` | The sequenced work plan against that research | — |
| `bots-and-work-marketplace.md` | Bots, the work marketplace, authorize → review → gate | — |
| `asset-library-and-promotion.md` | How fleet instructions are stored, typed, gated and shipped | — |
| `sdlc-capture-delivery-model.md` | Commit-per-capture: how a run's change is scoped to its own work | — |
| `local-compute-presence.md` | A developer's machine as a fleet participant | — |
| `devbox-interactive-terminal.md`, `handoff-computer-lab.md` | Devbox terminals and the environments domain | — |
| `deploy-via-operator.md`, `researcher-pipeline-crd.md` | Kubernetes deployment via `dc-k8s-operator` CRDs | — |


⚠️ This table is not the whole set — one further goal-doc/validator pair records
the removal of a retired tenant, and it deliberately asserts that the removed
tenant's name appears **nowhere** in `CLAUDE.md`, so it cannot be listed here by
name without failing its own check. `ls docs/*-goal.md scripts/validate-*.sh`
(11 validators) is always the authoritative list.

---

# Gotchas

## Deploying and tearing down

- **Agent runtimes are a genuine second phase — the images must exist first.** `OrgIQ-AgentCoreRuntime` creates the agent ECR repos *and* the runtimes that pin images from them, so a rebuild has a chicken-and-egg: deploy it with runtimes on and every `CfnRuntime` fails with an invalid-image error against the empty repo it just created. `cdk.json` used to set `"deployRuntimes": "true"`, which made that failure the guaranteed outcome of the first deploy after any teardown. The default is now unset, restoring the documented order: deploy the stack (repos + execution roles), run `agents/base/build.sh` then `agents/build-all.sh` (local `docker buildx`, ARM64 — **not** CodeBuild), then redeploy with `--context deployRuntimes=true`. `--context onlyAgents=a,b` restricts phase 2 to the images that actually exist. Note the eight agent repos *and* the shared base repo *and* the devbox repo are all `RemovalPolicy.DESTROY` with `emptyOnDelete`, so a teardown takes their images with them; only `orgiq-middleware` is RETAIN (so a failed-stack delete doesn't destroy the image, and `deploy.sh`'s orphan sweep adopts it next time).
- **AgentCore runtimes delete slower than CloudFormation will wait.** `AWS::BedrockAgentCore::Runtime` regularly exceeds the resource handler's timeout, failing with `NotStabilized` ("Request timed out while deleting") and dropping the stack into `DELETE_FAILED` — which aborts `cdk destroy --all` partway through the fleet. The runtime finishes deleting server-side anyway; only CFN gave up. `destroy.sh` pre-drains runtimes (endpoints first — the API rejects a runtime delete with `ConflictException` while any endpoint remains, and `DEFAULT` can't be deleted separately) before `cdk destroy`. Both calls also reject while a delete is already in flight, so "already deleting" is success. If a stack still lands in `DELETE_FAILED`, retry `delete-stack --retain-resources <failed logical ids>` — and note the retain list must **exclude the stack's own name**, which appears as the `LogicalResourceId` of the stack-level `DELETE_FAILED` event; passing it makes CFN reject the whole call.
- **The deploy/teardown scripts self-heal the Aurora Data-API cold-start race and the custodian.** A cluster of fixes so a rebuild after teardown stops wedging: (1) `destroy.sh` no longer CFN-pre-deletes `OrgIQ-Aurora` — downstream stacks still import `orgiq-aurora-cluster-arn`, so the delete cancelled with "Cannot delete export … in use" and `wait` polled to its ~60-min ceiling; it now only pre-drains the RDS *cluster* and lets `cdk destroy --all` tear the stack in dependency order, then runs a read-only billing sweep (Aurora, OpenSearch Serverless, AgentCore runtimes/memories/browsers/code-interpreters, S3) that records survivors and exits non-zero. (2) `schema/load_schema.py` retries `HttpEndpointNotEnabledException` and sibling resume/scale transients (6×3s, warm-up `SELECT 1` first) — the first Data API call to a cold 0.5-ACU cluster fails until the endpoint enables — and fails loud on genuine SQL errors (non-transient re-raise immediately). (3) The KB stack gates its `DbInit` chain on a `DataApiReady` custom resource (boto3 Lambda polling `SELECT 1` ~9 min, cold-cluster transients only). (4) `OrgIQ-Foundation` sets **both** S3 buckets to `RemovalPolicy.DESTROY` with a *self-role* emptier Lambda (identity-based IAM, paginates object *versions* + delete markers) rather than CDK's stock `autoDeleteObjects` — the stock provider gets its perms via a bucket resource policy the custodian strips, wedging teardown in DELETE_FAILED (other Foundation resources still RETAIN). (5) `deploy.sh` reconciles every expected stack's real CFN status after `cdk deploy --all` (a mid-fleet failure doesn't reliably exit non-zero) and exits 1 on any not `*_COMPLETE` — and treats `ROLLBACK_COMPLETE`/`UPDATE_ROLLBACK_COMPLETE` as the failures they are despite the `_COMPLETE` suffix — and single-shot auto-recovers the KB `CREATE_FAILED` Data-API race (delete the failed KB stack, redeploy once, bounded by `KB_RETRIED`).
- **This account silently closes open security groups.** `custodian-restrict-security-group-admin-ingress` revokes `0.0.0.0/0` ingress within seconds — CFN authorized the middleware ALB rule at 14:20:22 and custodian removed it at 14:20:28, with no stack event and no drift. The task was running and the target group healthy while the load balancer accepted no traffic. `OrgIQ-MiddlewareService` therefore sets `openListener: false`; pass `--context albAllowCidr=<ip>/32[,<cidr>...]` to reach it, and synth warns when you don't. When something here is deployed, healthy and unreachable, read the live SG's `IpPermissions` first.
- **The middleware task runs on ARM64.** Fargate defaults to x86_64; the image is built on Apple Silicon, so the default produced tasks that failed with `exec format error` in the entrypoint and were replaced in a loop while the stack sat in UPDATE_IN_PROGRESS. `MiddlewareServiceStack` pins `runtimePlatform` to ARM64 (also the cheaper option). The stack owns its ECR repo *and* pulls from it, so it deploys in two phases: the first lands the repo with the service scaled to 0 (the L2 pattern rejects `desiredCount: 0`, so it is forced on the underlying `CfnService`), then `--context deployMiddlewareService=true` scales it up.
- **`OrgIQ-MiddlewareService` reaches `CREATE_COMPLETE` with an empty ECR repo and zero running tasks.** The stack owns its repo *and* pulls from it, so on a fresh account or after a teardown the service is created against a repo with no images: CFN reports success, `describe-stacks` says `CREATE_COMPLETE`, and the service sits at `desiredCount 1 / runningCount 0` retrying forever with `CannotPullContainerError: ... orgiq-middleware:latest: not found`. Nothing in the stack status says so, which is why "all 18 stacks healthy" is not the same claim as "the middleware is serving" — check `aws ecs describe-services --cluster orgiq-middleware --services orgiq-middleware --query 'services[0].[desiredCount,runningCount]'`, or `aws ecr list-images --repository-name orgiq-middleware --query 'length(imageIds)'`. The repo being `RETAIN` protects an image that exists; it does not create one. Note the consequence for the machine-callback guards: they flip to *required* the moment this stack deploys, so with no task running the deployed fleet's callbacks have no endpoint at all — a local `npm run dev` middleware (secrets unset → guards open) is the only listener. Build and push the middleware image, then redeploy with `--context deployMiddlewareService=true` to scale it up.
- **The KnowledgeBase stack's exports are imported by four stacks** (Agents, AgentCoreGateway, Observability, AgentCoreRuntime), so once consumers exist the KB id export can be neither deleted nor changed. ⚠️ Precision the CDK tests added: only `OrgIQ-MiddlewareService` imports `orgiq-knowledge-base-id` by that **stable name** (and `OrgIQ-AgentCoreRuntime` once runtimes deploy); Agents, Gateway and Observability consume the KB through CDK's auto-generated hash exports. The freeze is real either way, but it is spread across several export names rather than concentrated in the one you would grep for — `infra/test/cross-stack.test.ts` therefore asserts that at least three stacks import *some* KB export, which is the honest form of the claim. The consequence is unchanged — a knowledge base deleted out-of-band (e.g. by `destroy.sh`'s KB pre-drain) cannot be replaced via CFN without a multi-stack teardown. Recovery without that: recreate the KB + S3 data source via the Bedrock API with the same config (Aurora `bedrock_kb` table, Titan v2 @1024d, `orgiq-kb-service-role`), point the fleet at it with `cdk deploy OrgIQ-AgentCoreRuntime --context kbId=<new-id>`, refresh `KNOWLEDGE_BASE_ID` in `.env.aws` and the `knowledge_bases` registry row, then run an ingestion job. The stale export stays as known drift until the KB stack is rebuilt cleanly.
- **`middleware/.env.aws` rots on every rebuild, silently.** Capability ids are minted fresh when `OrgIQ-AgentCoreCapabilities` is recreated, and the file is not regenerated — so `BROWSER_ID`, `BROWSER_PROFILE_ID`, `CODE_INTERPRETER_ID` and `MEMORY_ID` keep pointing at resources that no longer exist. The failures are unhelpful: the Code Interpreter says "not found", the browser says "Browser profile not found" and surfaces as a bare 500, and `site-survey`'s browser fallback fails *soft* — a dead `BROWSER_ID` is indistinguishable from "this site has no JavaScript-only pages". Reconcile with `aws bedrock-agentcore-control list-browsers | list-browser-profiles | list-code-interpreters | list-memories`, or regenerate the file with `./schema/dump-stack-outputs.sh`. Note `config.ts` only fills vars that are `undefined`, so anything exported in the launching shell shadows the file.
- Aurora Serverless v2 has a 0.5-ACU minimum that bills even when idle (~$45/mo). The cluster also takes 10–20s to scale up from a cold call. `./scripts/destroy.sh` pre-drains it before stack teardown.
- OpenSearch Serverless has 2 OCU minimum billing even when idle. Budget alarm is critical.

## Agent runtimes and images

- **Agent images must install `aws-opentelemetry-distro` (ADOT), not vanilla `opentelemetry-distro`.** AgentCore Runtime injects `OTEL_PYTHON_CONFIGURATOR=aws_configurator`, which only exists in the ADOT package — with the vanilla distro no configurator loads and *no spans are ever exported* (`aws/spans` stays silently empty, which starves the span projector, `/recent-invocations`, and online evaluation). Runtime env also sets `OTEL_TRACES_EXPORTER=otlp` + `AGENT_OBSERVABILITY_ENABLED=true`; account-level X-Ray Transaction Search (`aws xray get-trace-segment-destination` → CloudWatchLogs/ACTIVE) must be on.
- **The devbox fleet is persisted, and the write path is order-sensitive.** The registry in `middleware/src/lib/devbox-fleet.ts` is still two in-memory Maps — synchronous, read on every request — but it is now mirrored to Aurora (`devbox_boxes`, `schema/devbox_fleet_schema.sql`) through a `FleetStore` seam, hydrated at boot by `providers/devbox-fleet-store.ts`. It exists because a restart used to drop every box while the AgentCore sessions kept running, and `devbox-reaper` reaps only what `listBoxes()` returns — so a forgotten session sat outside BOTH the 20-minute idle timeout and the 60-minute ceiling, permanently, with no way to find it again (no AgentCore API enumerates live *runtime* sessions; `list-sessions` is Memory). Under `tsx watch` that happened on every file save. Three things bite here, each found by running it rather than reading it: (1) the RDS Data API returns `TIMESTAMPTZ` as a NAIVE string, and `new Date()` reads that shape as LOCAL time — a box came back 4h in the future, making `age` negative so the ceiling never fired; `lib/devbox-fleet-rows.ts::utcIso` is the fix and the reason that mapping is a separate, tested module. (2) Writes are fire-and-forget (the mutators can't await Aurora), so they are serialized per box id — without that, `DELETE`'s `markStopped`-then-`removeBox` reordered and the row came back from the dead. (3) `touch` coalesces on a 15s flush, so a structural write must drop any queued touch first or a stale snapshot replays over it — that is how the reaper's own stop got undone. Boxes marked `stopped` are pruned at boot rather than restored, so the fleet does not fill with corpses. Everything degrades to the old in-memory behaviour when Aurora is mocked, unconfigured, or missing the table.
- **Session storage (`/mnt/workspace`, preview) is wiped on every runtime version update.** The runtime stacks digest-pin container URIs so CFN rolls the runtime on every image push — meaning every `build-all.sh`/devbox image push + deploy wipes all session workspaces for that agent. Treat `/mnt/workspace` as a cache, never a durable store; push work out via git or the command API. Also resets after 14 days idle. Limits: 1 GB/session, session IDs must be ≥33 chars.
- **Devbox model exception**: the `orgiq-devbox` runtime runs Claude Code, which requires Claude models — via Bedrock inference profiles (`us.anthropic.claude-*` IDs, currently haiku-4.5; bare foundation-model ids don't support on-demand invocation), so still AWS-hosted/AWS-billed, no Anthropic API key anywhere. This is a deliberate, devbox-only exception to the "AWS-native models only" convention; the 8 OrgIQ agents stay on Nova.
- **Agent system prompts are resolved from Bedrock Prompt Management at run time.** Each agent reads `orgiq-<agent>-system-prompt` (DRAFT) via `agents/_shared/prompt_source.py` on every invocation, cached `PROMPT_REFRESH_S` (60s), and rebuilds its Strands `Agent` when the text changes — so a Prompt Studio edit reaches the deployed fleet in ~a minute with **no image rebuild and no redeploy**. The `SYSTEM_PROMPT` literal in `agents/*/main.py` is a fallback used only when the library is unreachable (missing prompt, AccessDenied, throttle) so a Bedrock outage can't take the fleet down; `PROMPT_SOURCE_DISABLED=1` pins an agent to it. Traces record the *resolved* prompt sha as `promptVersion`, so observability shows which prompt actually served a request. ⚠️ The `bedrock:GetPrompt`/`ListPrompts` grant must be on the **runtime execution role** (`orgiq-<agent>-execution-role`, created by `OrgIQ-AgentCoreRuntime`) — the `OrgIQ-Agents` `orgiq-<agent>-role` is a different principal and granting it there has no run-time effect. `ListPrompts` must be paginated: the un-paginated call returns only the first page and silently misses prompts.
- AgentCore Runtime is deployed via CDK `CfnRuntime` gated on `--context deployRuntimes=true`. Do NOT use the standalone `agentcore deploy` CLI for cloud deploys; it'll drift from the CDK source of truth. (`agentcore dev` is still the right tool for local hot-reload; it runs on host arch, unlike the ARM64 deploy images.) For the record of what you are giving up: `agentcore deploy` builds via remote CodeBuild and needs no local Docker at all — that convenience is the price of keeping CDK as the single source of truth, and it is why the documented build path is a local ARM64 `buildx`.

## Observability

- **A2A topology edges require the supervisor's streaming path to set its TraceContext.** `_handle_streaming` (what the portal uses) originally never called `_current_ctx.set(...)`, so `_invoke_sub_agent` threaded no `parentInvocationId`, every sub-agent trace persisted with `parent_invocation_id NULL`, and `/api/topology/a2a` could never return an edge for real user traffic. Both handlers now establish the context and emit a root trace.
- **Trace sampling gates persistence.** `observability.sampling_config.rate` is applied in `trace-sink.processTrace` *before* the insert — at the old 0.1 a low-traffic lab wrote ~1 row in 10 while `[cw-ingest]` logged "persisted N" for every parsed bundle, so observability pages looked broken with no signal why. The seeded `default` row is now 1.0 and an unlisted template id falls back to it. ⚠️ There is a second, quieter default: `FALLBACK_RATE = 0.1` in `trace-sink.ts` applies when the sampling cache is empty — an Aurora that never had `observability_schema.sql` applied, or a first config read that failed — so the 10% behaviour can still reappear on a half-provisioned cluster. The poller reports persisted / sampled-out / duplicate separately. Traces reach Aurora via the CloudWatch log poller (30s) parsing `ORGIQ_TRACE:` lines — agents cannot POST to a laptop middleware.
- Span projection runs on a 1-minute schedule (Lambda) — span data in the Aurora `observability_*` tables can lag CloudWatch. ⚠️ `OBS_USE_LEGACY_POLLER` (`lib/cw-trace-ingest.ts`) defaults to **`'true'`**, i.e. the middleware polls CloudWatch directly *unless* you turn it off — the reverse of how this used to read here.
- **Error rate ≠ answer quality, and phantom rows are dropped at the sink.** Two related observability fixes: (1) `errorRate` counts only *real failures* — a guardrail intervention (`guardrail_action` present and not `'NONE'`) or non-conforming output (`schema_valid = false`) — not `judge_score < 0.3`. A weak answer to a request that otherwise succeeded is surfaced separately as `lowQualityRate` (judge<0.3); folding it into errors made a healthy fleet giving mediocre answers alarm as erroring. `invocation_traces` has no dedicated error column, so these are the honest stand-ins, matching the canary rollup view. ⚠️ Only `routes/traffic.ts` (`/per-agent-summary`) reports both: `routes/oncall.ts` (`/timeline`) shares the error predicate but has **no** `lowQualityRate` field — its judge threshold lives in the separate judge-regression alarm. (2) `trace-sink.processTrace` drops a **phantom** row — partial/aborted bundles or pre-agent middleware writes — only when *every* substance axis is empty (no model AND empty response AND no tokens AND no tool calls AND no guardrail signal AND no memory events), `test:*` exempt, before any Bedrock spend, so a real short answer is never dropped. The poller counts these in a distinct `phantom-skipped` bucket instead of miscounting them as duplicates.
- **Prompt canary** is deployed via `OrgIQ-PromptCanary` (subject A/B + judge managed prompts, SSM weight/control params, SFN controller); `deployCanary` is `"true"` in `cdk.json`, so it deploys by default. The LLM-as-judge config (enable, model, rubric weights, sample rate) lives in SSM `/orgiq/canary/judge_config` and is edited from `/iq/evaluations`. That parameter is owned by `middleware/src/lib/judge-config.ts` — **not** the canary stack (which owns `/orgiq/canary/{weight_b,control,config}`) and not `lib/canary-judge.ts`, which merely calls `getJudgeConfig()` on every canary ask and otherwise talks to Bedrock. Online evaluation needs `--context enableOnlineEvalConfig=true` on top of `enableEval` (already default-true in `cdk.json`); the config resource requires `ServiceNames` + `ExecutionStatus: ENABLED` and an exec role that can create its results log group.
- **The KB registry is bookkeeping, and drifts.** `/admin/knowledge` reconciles `knowledge_bases` rows against live Bedrock (`middleware/src/providers/kb-reconcile.ts`) and names each disagreement; a seeded row claimed a knowledge base id that never existed while the real one went unregistered. Adoption repoints a broken row and captures its data source id — repointing `bedrock_kb_id` alone leaves a row that still rejects every sync. The corpus load now repoints the row itself (`schema/synth/load.py::reconcile_kb_registry`, called from `trigger_kb_sync`) because that step is the one thing already holding both live ids, so the link repairs itself after a KB rebuild instead of waiting for a hand-driven adoption. ⚠️ `resolve_kb_id` filters on `status = 'ACTIVE'`, so a row left at the seeded `PENDING` makes every agent fall through to the `KB_ID` env var — which usually *works*, and therefore hides the drift rather than surfacing it.

## The knowledge base

- **Bedrock's DEFAULT search type ranks this store's results BACKWARDS.** Against the Aurora/pgvector vector store, `bedrock-agent-runtime:Retrieve` with no `overrideSearchType` returns the correct k nearest neighbours **in exactly reverse relevance order**, reporting cosine *distance* in a field named `score` that every caller reads as "higher is better". Measured against ground truth (`ORDER BY embedding <=> query` on `bedrock_kb`, the same table Bedrock reads) over 8 representative queries: **top-1 correct 0/8 on the default, 8/8 on `HYBRID`**. "Why did we choose Aurora over Neptune?" put `adr-d-iceberg.md` first (distance 0.831) and the actual `adr-d-aurora.md` *last* (0.492, the nearest chunk). This is why the KB read as a **false flag** rather than an outage — real org documents came back, so nothing looked broken, while the model was handed the least relevant evidence and the right answer fell off the end. Two things compound it: nothing in the agents sorts by `score` (results reach the model in Bedrock's order), and `middleware/src/lib/turn-tool-calls.ts` trims oversized result lists **from the tail**, discarding the most relevant document first. All three production call sites — `agents/search/main.py` `query_knowledge_base`, `agents/advisor/main.py` `retrieve_context`, and `infra/lambda/gateway-tools/kb_query.py` — now pin the search type; the agents share `agents/_shared/kb_resolver.py::vector_search_config()`, and the gateway Lambda carries a deliberate literal copy because it ships on its own. The four notebook `retrieve` sites are pinned too (`notebooks/aws/04-knowledge-base.ipynb` ×3, `06-strands-agent.ipynb` ×1) — they are how a human forms their first impression of whether retrieval works, and two of them are the rerank *demo*, whose whole point is a before/after ordering: on the default search type the "before" column is reverse-ranked, so the demo measures the missing search type rather than the rerank model and makes it look far better than it is. `KB_SEARCH_TYPE=SEMANTIC` reproduces the inversion for diagnosis. `HYBRID` is supported here, not a workaround: it needs the GIN full-text index the KB stack creates as `bedrock_kb_text_idx` (`DbInitTextIndex`), and it is the better mode for this corpus anyway since the queries carry exact proper nouns ("Neptune", "Kubernetes", "SOC2"). ⚠️ That index is a real dependency, not a detail: `04-knowledge-base.ipynb`'s hand-driven table setup created only the HNSW index, so a table built from the notebook rather than the CDK stack would fail every HYBRID retrieve while looking complete — the cell now creates `bedrock_kb_text_idx` as well, and the two must stay in step. Regression tests: `agents/_shared/test_kb_resolver.py::SearchType` (the helper) and `agents/tests/test_kb_retrieve_config.py` (both shipped tools) — they assert the key's *presence*, because the bug was an omission.
- **A corpus run reported success against an empty knowledge base.** `schema/synth/load.py::sync_knowledge_base` needs BOTH `KnowledgeBaseId` and `DataSourceId` from `OrgIQ-KnowledgeBase`'s outputs and skips ingestion when either is missing — one warning, **exit 0**. Only `KnowledgeBaseId` was ever published, so the skip was unconditional and no ingestion job had ever run in this account. The stack now also outputs `DataSourceId` (no `exportName` on purpose — the consumer reads `describe-stacks`, and a CFN export can't be changed once imported). If the KB looks empty, check for an ingestion job before suspecting retrieval.
- **`staged/` outlives the code that wrote it.** `schema/synth/staged/` is gitignored scratch, so a retired tenant's 46 `news_article` JSONs stayed on disk after its generator was deleted, and `load_staged()` globbed the directory blind — re-uploading them to S3, re-upserting them into `documents` and re-indexing them into the KB on every run. They carried **0 mentions** (linked to no person, team or project) and still outranked the authoritative ADRs. `load_staged()` now filters on `generate.DOC_TYPES` and logs what it skipped, so an orphaned artifact stays inert: no generator, no load. Adding a doc type means adding a planner AND a name to that tuple.
- **`documents.doc_type`/`headline`/`published_at`/`section` are ADD COLUMN in `orgiq_schema.sql`, on purpose.** A retired tenant's schema file originally added them, and deleting that file took the only definition with it — so a cluster built from `orgiq_schema.sql` alone had none of them and the corpus load died on `column "doc_type" does not exist`, while a cluster built before the removal had all four. They are defined in `orgiq_schema.sql` now precisely so both converge; `generate.py` populates all four for live doc types, so they are live columns, not residue of the retired tenant.

## Identity, authz and tenancy

- **Identity & tenancy are real, not cosmetic.** Users/tenants/grants live in Aurora (`schema/identity_schema.sql`: `tenants`, `app_users`, `user_tenant_roles`) with an in-memory fallback mirroring the seed when Aurora is unconfigured. The signed session cookie carries `grants` (tenant→roles) and `act` (real identity while masquerading); every role/tenant switch is validated against grants in `middleware/src/routes/session.ts` — no grant in the target tenant → 403. Cedar policies live per tenant in `middleware/seeds/roles/{tenant}/{role}.cedar` (orgiq: `member`, `sme`, `program-owner`, `org-leader`, `hr-admin`; assessment: `assessor`, `lead-assessor`, `program-lead`) plus cross-tenant `admin.cedar`, the only role granted `Masquerade`, and condition on `principal.tenant`; the AVP decision cache key is `tenant|role|action`. `requireTenant()` guards the assessment tenant's routes and graph/scores (orgiq). Supervisor caches one Agent per `(tenant, role)`; admin rides hr-admin's guardrail. Provision users/tenants from `/admin/identity/users` (gated `ManageUsers`), including linking a user to an org-graph person after creation via `PUT /api/identity/users/:id/person` (`null` clears) — previously `personId` was settable only at creation, dead-ending the "link it from Identity → Users" remediation. ⚠️ authz open-mode (no `POLICY_STORE_ID`) DENYs when `NODE_ENV=production`; cookie-less requests still get the permissive `demo-user` identity in dev — but only while `demoFallbackAllowed()` holds, which is false whenever Cognito is fully configured even in dev. "Permissive" there means permissive *grants*, not a blanket ALLOW: the demo session still carries `DEFAULT_ROLE` and still faces Cedar.
- **New Cedar actions must ALSO be listed in `CAPABILITY_ACTIONS` (`middleware/src/lib/authz.ts`).** `GET /api/session/capabilities` evaluates only that list, so an action that is gated server-side but missing there reads `undefined` in the portal's `can()` — every control behind it hides for every role, including roles Cedar permits. This is how all eight assessment-tenant actions shipped invisible. Same list feeds the masquerade menu. (One action is probed with attributes rather than bare: `ApproveTransaction` goes in with `{ amount: 20000 }` so the amount-conditioned policies decide honestly.)
- **Open-mode authz (no `POLICY_STORE_ID`) treats the admin wildcard as every action.** `admin.cedar` is an unconstrained permit; the role registry records it as `['*']`, and until 2026-09 the seed-matrix decision did a plain `has(action)`, denying admin on every plain `requireAction` gate while the read gates that special-case `role === 'admin'` let it through. Fixed in `seedPolicyDecision`; regression test in `lib/__tests__/authz-open-mode.test.ts`. If a new gate 403s admin locally, suspect the gate, not the wildcard.
- **A tenant/role switch invalidates the pre-switch cookie within ≤120s — `session_epoch`.** The session is a stateless signed cookie (`orgiq.session`, HMAC-SHA256, no server store), so re-minting on switch (`mintSession`/`issue` in `routes/session.ts` `POST /tenant`/`/role`) scopes the *new* cookie but can't retroactively kill copies already minted — other tabs/devices, or a stolen cookie. `session_epoch` (INTEGER on `app_users`, `schema/identity_schema.sql`, embedded in the cookie) closes that window: every tenant/role switch and `POST /api/session/revoke-others` calls `bumpSessionEpoch` (`providers/identity.ts`), and the periodic grants-refresh in `sessionMiddleware` (`lib/session.ts`, every `GRANTS_REFRESH_S`, default **120s**, compared in seconds) drops any cookie whose `epoch` is below the stored one — shrinking the stateless replay window to ≤120s. Masquerade deliberately does *not* bump (carries the target's epoch) and `revoke-others` 409s while masquerading; a cookie minted before the column existed carries epoch 0 and matches a never-bumped user. Client side: the switch/logout **hard-navigates** (tearing down in-memory React state) AND `clearTenantScopedCaches()` (`portal/src/lib/tenantCaches.ts`, wired into `auth.tsx` `enterContext`/`login`/`logout`) removes tenant/user-scoped localStorage — judge-config, devbox fleet+session, terminal dock, masquerade history, `chat.session.*`, and the sessionStorage context marker — while **preserving** device prefs (theme, `projects-view`, `sprints-view`). The bytes would otherwise survive at rest on a shared browser even though `requireTenant` won't render the other tenant.
- **Second tenant: `assessment`** (roles `assessor` / `lead-assessor` / `program-lead`; seeds in `middleware/seeds/roles/assessment/`; routes `/api/assessment/*` behind `requireTenant('assessment')`; portal `/assessment/*` with its OWN shell-rail hierarchy — Assess / Analyze / Informatics / System — against orgiq's Plan / Design / Build / Release / Operate / Org / System). Both hierarchies are declared in `GROUP_ORDER_BY_TENANT` in `portal/src/components/shell/portalCommands.ts`; `Layout.tsx` only consumes the derived `groupRank`, and an unlisted group sorts last. Design contract and the source-app reverse-engineering live in `docs/assessment-tenant.md`. Agents `orgiq-assessment-scorer` / `-drafter` never persist scores; the provider's deterministic `applyScores` validates and applies their envelope. (There were briefly three; the removed one's record is the unnamed goal-doc/validator pair noted under The docs map, and `middleware/src/lib/session.ts` `TENANTS` is the authority on how many there are now.)
- **The auth floor: `requireSession` vs `requireAction`.** `requireAction('X')`/`readForRolesElseAction` gate a *capability*; `requireSession()` (`lib/authz.ts`) gates *authentication only* — its label arg is just an audit string. Some surfaces are readable by every role (the work queue, the agent fleet, session history, sprints), and "every role" means *signed-in*, not anonymous: mounting those with no guard let anonymous callers read them (transcripts included). They now take a `requireSession` floor. ⚠️ **Not every route on an observability/tooling router is human-facing.** `POST /api/observability/approvals/request` and `POST /api/observability/harness/trace` are **agent callbacks** — deployed runtimes POST to them with no session — so they carry an *optional service-auth* guard, never a session floor. A blanket session mount over those routers silently 401s the fleet's trace emission. Gate machine-callback routes per-route, not at the mount.
- **Service auth is one module with per-route specs.** `middleware/src/lib/service-auth.ts` owns the mechanism: a `Callback`-style spec per sessionless route, `requireServiceAuth(spec)` (open outside production when the secret env is unset; 503 in production when unset; constant-time `timingSafeEqual` header check when set), and `serviceAuthOr(...)` for routes that accept either a session or a secret — note `serviceAuthOr` is deliberately **not** open when unset. The guards you'll see at call sites (`requireTraceAuth` in `routes/harness.ts`, `requireRunCompleteAuth` in `routes/assessment.ts`) are route-local consts built from it, not exports of the module. The five specs: `APPROVALS_REQUEST_SECRET`/`x-approvals-auth`, `HARNESS_TRACE_SECRET`/`x-harness-auth`, `ASSESSMENT_RUN_COMPLETE_SECRET`/`x-assessment-run-auth`, plus `LAB_CALLBACK_SECRET` and `MOCK_CONTROL_SECRET`.
- **Closing the machine-callback guards is a coordinated two-stack deploy with a real blackout window, not a flip of one env var.** `OrgIQ-MiddlewareService` (`infra/lib/middleware-service-stack.ts`) mints `orgiq-approvals-request-secret` / `orgiq-harness-trace-secret` / `orgiq-assessment-run-complete-secret` in Secrets Manager and wires them as ECS container secrets — the moment that stack deploys, all three guards flip from open to required, with no staged "mint but stay open" mode. `AWS::BedrockAgentCore::Runtime` has no ECS-style `Secret.fromSecretsManager` equivalent (its `EnvironmentVariables` is a bare string map) and `AgentCoreRuntimeStack` is instantiated before `MiddlewareServiceStack` in `app.ts` with no dependency edge, so the runtime side takes the three values as plain `--context` strings the operator copies in by hand after reading them with `aws secretsmanager get-secret-value`. ✅ **The agent half has shipped** — `agents/_shared/callbacks.py` defines the three callbacks and both `instrumentation.py` (trace POST) and `approval_tool.py` (approval POST + poll) send the matching header, but **only when the secret env var is set**; unset sends byte-for-byte the old request. That makes the halves independent, so the required order is: roll the agent images first *with no secret context* (a behavioural no-op, and the slow step), then deploy the middleware, then read the secret values, then redeploy the runtimes with the three contexts. Skipping the image roll makes the window unbounded — a pre-`callbacks.py` image sends no header no matter what env it is handed. Full runbook, including what the window costs per callback, in `docs/agentcore-preview-surface.md` §6a.
- **Enterprise SSO is Cognito + a BFF OIDC flow** (`OrgIQ-Authentication` stack). Cognito is only the *authenticator*: `middleware/src/routes/auth.ts` drives authorization-code+PKCE (`lib/oidc.ts`), verifies the ID token against the Cognito JWKS (`aws-jwt-verify`), resolves the OrgIQ user by `app_users.external_sub` then email (linking on first login), and mints the **same** signed session cookie via `mintSession` — so grants/masquerade/Cedar are unchanged and the browser still holds only that cookie. Turns on when `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID`/`COGNITO_DOMAIN`/`COGNITO_CALLBACK_URL` are set (`config.cognito`); unset → the user picker is available only in demo mode. Both `POST /api/session/login` and `GET /api/session/users` return 403 in `NODE_ENV=production` unless `AUTH_DEMO_MODE=true`, whether or not SSO is configured. Portal shows "Sign in with SSO" (`auth.tsx` `signInWithSso`/`ssoEnabled` from `GET /api/auth/config`). **Deployed pool** (⚠️ minted fresh on every `OrgIQ-Authentication` rebuild — the id below was the latest as of 2026-09 and is the first thing to re-check, not to trust): `us-east-1_YAQjmVEw2`, client `5m0776daodsm1lmhrhvd8v71s5`, domain `orgiq-auth-647757222309.auth.us-east-1.amazoncognito.com`; seed users = the 14 `app_users` emails including the release-manager, SME and assessment casts (the stack's `seedUsers` list is kept in step with `schema/identity_schema.sql`), passwords set via `aws cognito-idp admin-set-user-password`. Regenerate `middleware/.env.aws` after any auth rebuild with `./schema/dump-stack-outputs.sh` (it fetches `COGNITO_CLIENT_SECRET` from the API — CFN never exports it — and sets `PORTAL_ORIGIN` so the BFF post-login redirect lands on the portal, not the middleware). ⚠️ Cognito rejects non-localhost **http** callbacks, so the deployed ECS middleware needs an HTTPS origin before `COGNITO_CALLBACK_URL` is set there (the stack leaves it unset until then; production picker access requires explicit `AUTH_DEMO_MODE=true`). Local run: `COGNITO_USER_POOL_ID=… COGNITO_CLIENT_ID=… COGNITO_CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client … --query UserPoolClient.ClientSecret --output text) COGNITO_DOMAIN=… COGNITO_CALLBACK_URL=http://localhost:3001/api/auth/callback npm run dev`, then open `/api/auth/login`. `GET /api/session/realtime-token` is the one place the BFF mints a JWT: a 10-minute HS256 token (`REALTIME_JWT_SECRET`, `tokenKind: 'orgiq-hs256'`, `lib/realtime-token.ts`) for the websocket-gateway/platform-api — it is **not** the Cognito id_token, which `routes/auth.ts` still discards after verifying; see `docs/social-calls-plan.md` step 3.

- **The agents' read-only SQL guard is a security boundary, and the regex version had a hole.** `search` and `advisor` expose `query_graph(sql)`: the **model** writes the SQL and the agent runs it verbatim through the RDS Data API, against a role that can write. Both used to check `^\s*(WITH|SELECT)\b` plus "no semicolon" — which `WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone` satisfies, and PostgreSQL executes the DELETE. `SELECT * INTO evil FROM people` is the same story. Since these agents read ingested documents, that regex was the whole distance between a prompt injection in a document and the org graph. It is now `agents/_shared/sql_guard.py`, which blanks comments and quoted runs *before* matching (so a keyword in a comment cannot smuggle, and `WHERE title = 'Update Manager'` cannot false-positive), rejects an unterminated quote outright, requires a single statement, and scans for write verbs **anywhere** rather than only at the front. A 21-case attack table runs against the shipped tool of both agents and asserts `execute_statement` was never reached, alongside 7 legitimate queries that must still pass — a guard that breaks the read path is just a broken tool. ✅ **The braces have now shipped**: `schema/graph_readonly_role.sql` creates `orgiq_graph_reader` — `CONNECT`, `USAGE` on `public`, and `SELECT` on exactly the thirteen tables `query_graph`'s docstring describes to the model, with every escalation attribute negated, `default_transaction_read_only = on`, no `ALTER DEFAULT PRIVILEGES` (so the list cannot grow silently when a migration adds a table), and `node_embeddings` deliberately excluded. `agents/_shared/db_credentials.py` is the only chooser: `AURORA_READONLY_SECRET_ARN` is mandatory for deployed graph readers; missing credentials fail closed. Search/advisor always receive the reader secret and `APP_ENV=production`, and CDK rejects `readOnlyGraphRole=false`. Apply `schema/graph_readonly_role.sql` before deploying these readers. A deliberate local experiment may set both `APP_ENV=development` and `ALLOW_UNSAFE_SQL_ADMIN_FALLBACK=true`; errors never retry as admin. The gateway traversal and PageRank Lambdas also use an isolated read-only credential role. See `docs/readonly-graph-role.md`. The regex guard stays regardless — defence in depth, and it is what protects a local `agentcore dev` or any cluster that has not applied the grant. Do not delete it, and do not add a second copy of the check anywhere.

## Money, dispatch and write gates

- **The dispatch surface has three soft brakes, each with its own confirm flag.** `POST /api/bots/dispatch-work` runs per-run cap → allocation → envelope (`decideRunBudget`/`decideAllocation`/`decideEnvelope`, all pure in `lib/bot-runner.ts`); each 409 names `gate` + `confirmFlag` and clears only on `confirmOverRunBudget`/`confirmOverAllocation`/`confirmOverEnvelope`. The deprecated `confirmOverBudget` opens the first two but **not** the envelope. `bot_runs.dispatched_by` (from the session sub, never the body — `schema/agent_run_attribution_schema.sql`) is the envelope's attribution; unknown burn is treated as unknown, not zero. Ahead of those three soft brakes sits a **hard** gate: `decideGrantScopedDispatch` (also in `lib/bot-runner.ts`, reached from `routes/bots.ts` and `routes/work.ts` via the `grantScopedDispatchVerdict` wrapper) 403s an `sme` who holds no active sprint grant on the target initiative before any money gate runs (org-leader/hr-admin/admin bypass), and its deny text distinguishes "no grant here" from "your grant's sprint isn't active yet." Sprint writes carry the same shape — Cedar grants `ManageSprints` role-wide to `sme`+`org-leader`, but `requireInitiativeSteward` (`routes/sprints.ts`) scopes an SME's create/move to initiatives they own or contribute to. Sprint surface: `/iq/sprints` + `GET /api/sprints?scope=mine|all` (`scope=all` is budgets-read-tier and 403s without `ManageBudgets`). See `docs/program-operating-model.md`.
- **Direct-invoke of a write agent requires `ManageIngest`.** `POST /api/agents/:id/invoke` gates the pipeline agents that mutate durable state — graph-builder (`merge_*` Aurora upserts), ingestion (`sync_knowledge_base`), scoring — on the `ManageIngest` capability, matched by `WRITE_AGENT_RE` (`routes/agents.ts`) so every id spelling gates (`graph-builder` / `orgiq-graph-builder` / `orgiq_graph_builder`). Read agents (supervisor/search/advisor) are ungated; reading *through* the fleet is fine, only direct invocation of a writer is gated. Member sessions 403.

## Local dev traps

- **Local Docker services bind to loopback; Jupyter requires its generated token.** The notebooks mount cloud credentials, so disabling notebook authentication or publishing the dev stack on all host interfaces exposes more than a demo UI. Read the login URL with `docker compose logs jupyter` or `jupyter-gcp`. npm certificate verification is enabled; install the appropriate CA for a corporate proxy instead of disabling TLS verification.
- **Browser origins are restricted before session processing.** `middleware/src/lib/browser-origin.ts` allows the API's own origin, `PORTAL_ORIGIN`, `PUBLIC_BASE_URL`, and comma-separated `CORS_ALLOWED_ORIGINS`. Development additionally allows loopback origins. Set a frontend origin explicitly for a separate production portal. Requests without an Origin header still pass through the normal authentication and authorization gates.

- **`useFetch` polls pause in hidden tabs, back off on failure, and can share a request.** `portal/src/hooks/useFetch.ts` (helpers in `hooks/pollSchedule.ts`): `pollIntervalMs` timers stop while `document.visibilityState === 'hidden'` and refetch once on return; consecutive failures double the delay (cap ×5); `{ share: true }` in the options dedupes concurrent in-flight requests for one URL (opt-in — the ~217 call sites keep independent `isLoading`/`refresh`). Two consequences: a Chrome tab driven by automation often reports `hidden`, so request-cadence measurements need visibility forced on (`docs/request-budget-audit-2026-09-16.md`); and anything handed to the library `ComputeProvider` as `clientOptions` MUST be a stable reference — an inline literal re-mints its client every render and re-fires the fleet poll, which is how devbox was polling every ~2s on every page. The mock agent stream is paced (`MOCK_STREAM_PACE_MS`, `docs/mock-floor.md`) and brackets each seeded tool call with STEP_STARTED/STEP_FINISHED the way the supervisor now does around each sub-agent call (`agents/supervisor/main.py`, `docs/research-agui-steps-2026-09-16.md`).

- **The middleware serves the realtime gateway on `/ws` when `REALTIME_GATEWAY=on`** (default outside production, off in production unless set). `lib/realtime-gateway.ts` attaches realtime-modules' chat/presence/calls to the BFF's own server, authenticates only `Sec-WebSocket-Protocol: bearer-token-v1, <realtime token>` (the HS256 token `GET /api/session/realtime-token` mints), and refuses call lobbies AND chat/presence channels outside the caller's `<tenant>:` prefix (`channelGuard` via `authorize` — do NOT also wire `presence({ authorizeChannel })`: it answers silently and hides the router's `AUTHZ_CHANNEL_DENIED` frame; the library's presence/reactions/cursor services subscribe as `presence:<ch>`/`reactions:<ch>`/`cursor:<ch>`/`chat:<ch>`, so the guard strips that prefix first — forgetting it refused the tenant's own presence). (0.98.5 left an outsider's presence `set` fanning into another tenant's roster — the library ran no publish check on presence broadcasts; 0.98.6 closed it and the assessment isolation logs record the re-probe.) That is why the portal's `VITE_GATEWAY_URL=http://localhost:3001` now connects (the portal appends `/ws`) instead of 404ing, and why `social-gateway` is optional locally. Every other upgrade path still 404s (`lib/unsupported-upgrades.ts`). Call state is Redis only when `REDIS_URL` is set; the router is single-process either way, so one task. See `docs/social-calls-plan.md` step 7.
- **Another server on :3001 silently takes every portal `/api` call.** `localhost` resolves to `::1` first under Node, so a dual-stack listener from a different project (platform-api's `ts-node-dev` did this) answers the Vite proxy with 404s while `127.0.0.1:3001` is fine — `/select` then shows "Session unavailable" for every user. `portal/vite.config.ts` probes `127.0.0.1:3001` then `:3011` for the `orgiq-middleware` health signature and proxies to the first that is ours (`API_PROXY_TARGET` still wins); run `PORT=3011 npm run dev:mock` when 3001 is taken. `tsx watch` also fails to REBIND 3001 after a file change if something grabbed it meanwhile — the middleware looks alive but holds no socket.
- **The middleware test suite is jest + supertest with one shared server per file.** `npm test` runs `jest --config jest.config.cjs`; `jest.setup.cjs` disables HTTP keep-alive and `src/test-support/jest-shared-server.ts` binds a single `http.Server` per test file rather than letting supertest listen/close per request. Both halves fix one flake: supertest's per-request `listen(0)`/close churn recycles OS ephemeral ports fast, and Node ≥19's `http.globalAgent` pools keep-alive sockets by `host:port` — so a pooled socket from an old, closed server gets handed to a request against a *new* server on the same recycled port, surfacing either as `ECONNRESET` or, worse, as the **previous test's response body**. The signature is a suite that passes alone and an innocent different suite that fails under parallel workers. ⚠️ `middleware/src/mock/harness.ts` is **not** part of that: it is the mock fixture for the regression-test *harness feature* (`routes/harness.ts`) under `MOCK_AURORA`.
- **A pin bump can report success and install nothing, and a version check can read true against a package you do not import.** Three traps in one family, all hit on 2026-09-16. (1) A SHORT sha in `package.json` (`#1e6c0bde`) leaves npm believing the dep is satisfied: `npm install` prints "changed 1 package" and the installed version never moves. Write the full 40-char sha. (2) For a `github:` dependency npm creates the folder from the **dependency key**, not from the library's own `name` field — this repo's key is `@connorhoehnslalom/ui-components` while the sibling realtime-examples repo keys the SAME library as `@connorhoehn/ui-components`, and each repo can only import under its own scope. The installed manifest keeps the slalom name inside either folder, so a *version* check reads true under both while only the local scope is *importable*: version and identity are separate questions needing separate checks. (3) Vite serves the old dist until `portal/node_modules/.vite` is cleared AND the server restarts. The settling commands, run from `portal/`: `node -e "console.log(require.resolve('@connorhoehnslalom/ui-components/package.json'))"` for identity and `node -e "console.log(require('@connorhoehnslalom/ui-components/package.json').version)"` for version. And verify a newly adopted API against the installed `dist`, never against the library's source or CHANGELOG — 2.275.0 documented and unit-tested two `SubNavLayout` exports that its barrel never re-exported, so they never shipped; the library's own test passed by importing the component file rather than the barrel.
- **"does not provide an export named …" from the Vite dev server usually means a STALE CACHE, not a removed export — check before you reimplement.** This one has already cost the repo once. On 2026-09-17 a package bump surfaced module-export errors for `T`, `activeNavItemClassName` and `inactiveNavItemClassName`; the errors were read as "ui-components removed these", and all three were replaced with local copies. They had not been removed — every one still resolved from `/shared` at the installed pin — and the replacements were not equivalent: the substituted nav classes dropped the active item's accent bar, its highlight and all of its padding, so the primary rail rendered flush to the window edge with no active state on every page, while the seven layouts that had not been touched kept the real look. The cause was the cache trap in the entry above: Vite serves the old dist until `portal/node_modules/.vite` is cleared AND the server restarts.

  **The diagnostic is two commands, and it takes ten seconds.** Ask the installed package, not the dev server:

  ```bash
  cd portal
  # Is it really gone? (prints the export's type, or undefined)
  node --input-type=module -e "import('@connorhoehnslalom/ui-components/shared').then(m=>console.log(typeof m.T, typeof m.activeNavItemClassName))"
  # If it is NOT gone, this is the fix — not a reimplementation:
  rm -rf node_modules/.vite && npm run dev
  ```

  If the export resolves there, the library is fine and the dev server is stale. Only if it prints `undefined` is the export genuinely gone — and then the fix is a queue row in `docs/ui-components-queue.md`, not a local copy of the class strings, because a hand-copied constant silently stops matching the library the next time the library changes.

- The `@connorhoehnslalom` packages resolve over SSH from `github:` URLs, so `npm install` needs no `GITHUB_TOKEN` and no registry `.npmrc`. (This entry used to say a `GITHUB_TOKEN` was required; that was true when ui-components resolved from GitHub Packages.) A sha bump can still fail mid-install with "early EOF" — never cache-clean mid-install, and after a bump `rm -rf portal/node_modules/.vite` and restart the dev server or exports go missing.

## Facts that bite

- **Scanning JSX open tags with `<Tag[^>]*>` undercounts, because `=>` contains a `>`.** Any element carrying an inline arrow handler — `onClick={(e) => ...}` — is truncated at that arrow, so anything spelled later in the tag (a `className`, a `border-0`, a raw element) is invisible to the scan. This has bitten twice: `b47bdff` fixed it in the raw-element gate ("the raw-element counter could not see past an arrow function"), and on 2026-09-17 the same shape produced a wrong ghost-Button audit (88/12 reported, 78/22 true) that reached a commit message before being caught. Walk the tag brace-aware — count `{`/`}` and stop at the first `>` seen at depth 0 — rather than reaching for a character class. `scripts/validate-component-discipline.sh` is the worked example.
- Aurora does NOT support Apache AGE — the graph is modeled as relational tables, not Cypher. Schema in `schema/orgiq_schema.sql`.
- AG-UI uses POST for SSE (not GET EventSource). Frontend must use fetch + ReadableStream.
- Titan Embeddings V2 dimension must be specified at embedding time AND match the `vector(1024)` column type.
- `decisions` is **one** table (`schema/orgiq_schema.sql`, extended in place by `ALTER TABLE` in `orgiq_work_items_schema.sql`) after a split-worlds bug where two decision surfaces disagreed. `observability.approval_decisions` and `observability.canary_decisions` are unrelated, namespaced, and not the old split — don't "re-unify" them.

- **Forwarding headers require an enforced proxy hop.** Direct/local middleware ignores them. ECS sets `TRUST_PROXY_HOPS=1` for its ALB; only set this when callers cannot bypass the reverse proxy. This controls both secure-cookie detection and client-IP rate limits.
