# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator: a multi-agent system
on Amazon Bedrock AgentCore that ingests org docs, builds a knowledge graph,
scores expertise and serves conversational search across four tenants
(`orgiq`, `assessment`, `social`, `pipelines`). `CONSTITUTION.md` is the spec.

**UI continuation (2026-10-28):** read
`docs/claude-code-handoff-2026-10-28-ui.md` for the user-approved dispatch
response component. Changes must stay within individual components; revision
5's page redesign was rejected. Request confirmation stays inline in the response
box, with no modal. This UI handoff supplements the general state below.

**Current state:** read `docs/claude-code-handoff-2026-10-26.md` first, and
`docs/aws-deploy-open-items-2026-10-27.md` for the live AWS deploy's open
items (the call join window is resolved; its fixed table lists what bit). The 10-26 handoff
holds the current commits, pins, verified test scope and the open
continuation items. The dated checkpoint prose that used to live here is in
`docs/history/claude-md-checkpoints-2026-10.md`; treat it as history, not as
the state of the tree. When this file and the code disagree, the code wins and
the claim here is a bug.

Durable facts the handoff does not repeat:

- Pins: the portal consumes `@connorhoehnslalom/ui-components` **2.485.0**;
  portal and middleware consume `@connorhoehn/realtime-modules` (its real
  package name, no alias) **0.140.0** from
  tracked tarballs in `portal/vendor/` (`file:` deps, both lockfiles); middleware
  pins `@connorhoehn/service-runtime` 0.4.1 and `distributed-core` 0.48.0
  (`077d7594`) by full sha; infra consumes
  `@connorhoehn/realtime-examples-cdk` 0.1.0 from `infra/vendor/`. Move a pin by replacing the tarball or sha,
  then clear `portal/node_modules/.vite` and restart Vite.
- Three additive schema changes (`assessment_team_members_schema.sql`,
  `work_item_comment_migration_schema.sql`, `work_item_documents_schema.sql`,
  plus `people.avatar_url`) were applied to Aurora on 2026-10-27; the
  page-thread data migration itself has **not** run (needs sign-off). Order:
  dry-run, migrate, then deploy the BFF.
- The platform was deployed to 647757222309 on 2026-10-26/27 from a machine
  with working credentials (`docs/aws-deploy-open-items-2026-10-27.md`);
  machines whose default credentials are still `InvalidClientTokenId` cannot
  verify or change it. Capacity for 100
  calls / 1,000 sockets is unaccepted (1 vCPU BFF is CPU-bound; decision owed:
  raise `middlewareCpu`, accept a smaller profile, or lift the single-gateway
  safeguard).
- Open user decisions: burn-down due dates (`portal/e2e/type-scale-burndown.tsv`,
  `scripts/layout-drift-burndown.tsv`), retiring `POST /knowledge/doc/comment`
  (410 vs eager import), the Alt-click Social quick panel, Communication
  landing depth, deck save-permission unification.

---

# Orientation

## Architecture

- **agents/** — 8 Strands agents (6 OrgIQ + 2 assessment), Python 3.12, deployed
  to AgentCore Runtime. Shared helpers in `agents/_shared/`, base image in
  `agents/base/`. `agents/devbox/` is a ninth runtime that runs Claude Code, not
  a Strands agent.
- **infra/** — CDK TypeScript stacks (18 default + opt-in Social/Portal).
- **middleware/** — Express 5 BFF: AG-UI SSE proxy, RDS Data API against Aurora,
  the realtime gateway on `/ws`, trace sink, mock providers.
- **portal/** — React 19 + Vite 7, built on ui-components.
- **schema/** — Aurora SQL (`orgiq_schema.sql`, `orgiq_work_items_schema.sql`,
  `program_schema.sql`, `assessment_schema.sql`, `identity_schema.sql`,
  observability) and the synthetic corpus pipeline (`schema/synth/`).
- **notebooks/** — JupyterLab exploration, `aws/` and `gcp/` flavours.

## Local dev

The shared app is the **Tilt stack** (`Tiltfile`): middleware :3001 running
`dev:mock` with `middleware/.env.tilt.local`, portal :5183, social-sim, the
forwarded platform-api and social gateway, native SFU :3902. Portal and
middleware are native Tilt resources, not Docker images; `tilt trigger portal`
after changing the consumed UI bundle. Without Tilt:

```bash
cd middleware && npm run dev:mock     # MOCK_* providers, DEV_OFFLINE, demo auth, Cognito/AVP vars blanked
cd portal && npm run dev
docker-compose up jupyter             # notebooks at :8888 (gcp flavour at :8889)
cd agents/<name> && agentcore dev     # agents are NOT in docker-compose
```

`dev:mock` blanks `POLICY_STORE_ID`, `SESSION_SIGNING_SECRET_ARN` and
`COGNITO_*` because `.env.aws` is only read for undefined vars, and a stale
policy store id makes every gated route 503.

**The mock is a contract** (`docs/mock-floor.md`, `mock/core/contract.ts`): a
fixture exports rows and selectors, never a count it could derive; timestamps
come from `mock/core/clock.ts`; wire strings are checked against captured real
responses; writes mutate registered fixtures so `POST /api/__mock/reset`
undoes them. Ask for empty/error states via `POST /api/__mock/scenario`
instead of damaging shared state. `scripts/validate-mock-floor.sh` judges it
and its budgets only ratchet down.

AWS access: `aws-azure-login --mode gui`; the `default` profile assumes the
innovation-lab account **647757222309** (us-east-1). Account 264161986065 is
personal and must not be used here.

## Key SDKs

Python pins live in `agents/base/Dockerfile` and are mirrored per agent.

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.55 | Agent framework |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` / `ag-ui-strands` | >=0.1.18 / >=0.1.8 | AG-UI events + Strands adapter |
| `aws-opentelemetry-distro` | >=0.12.1 | ADOT, **not** vanilla `opentelemetry-distro` |
| `boto3` | >=1.34 | Bedrock, RDS Data API, S3, DynamoDB, OpenSearch, AVP |
| `@aws/agentcore` | latest | AgentCore CLI (`agentcore dev`) |

The base image installs `bedrock-agentcore[a2a,ag-ui]` for everyone; the
supervisor calls sub-agents with `invoke_agent_runtime`, not A2A
(`docs/research-strands-graph-2026-09-16.md`).

## What deploys what

Everything is CDK; never `agentcore deploy` for the cloud (it drifts from CDK).

| Resource | Stack / flag |
|----------|--------------|
| Aurora Serverless v2 (pgvector) | `OrgIQ-Aurora` |
| Bedrock KB on Aurora pgvector | `OrgIQ-KnowledgeBase` |
| Guardrails (one per role) | `OrgIQ-Guardrails` |
| Verified Permissions + Cedar | `OrgIQ-Authorization` |
| Cognito pool + hosted UI | `OrgIQ-Authentication` |
| S3, DynamoDB, IAM | `OrgIQ-Foundation` |
| Dashboards + budget alarm | `OrgIQ-Observability` |
| Agent ECR repos + execution roles | `OrgIQ-AgentCoreRuntime` phase 1 |
| Agent runtimes | `OrgIQ-AgentCoreRuntime --context deployRuntimes=true` (`onlyAgents=a,b` narrows) |
| MCP gateway, Memory, Policy, Capabilities, Telemetry | `OrgIQ-AgentCoreGateway/-Memory/-Policy/-Capabilities/-Telemetry` |
| Online evaluation config | `--context enableOnlineEvalConfig=true` (raw `CfnResource`) |
| Span projector, prompt canary, devbox | `OrgIQ-SpanProjector`, `OrgIQ-PromptCanary` (default on), `OrgIQ-Devbox` (`deployDevbox`) |
| Middleware on Fargate + ALB | `OrgIQ-MiddlewareService` (`deployMiddlewareService=true` scales to 1) |
| Social images / SFU / platform-api | `deploySocialImages` / `deploySocialMedia` / `deploySocial` |
| Portal on S3 + CloudFront | `deployPortal=true`, publish with `node scripts/portal-publish.mjs` |

Agent image rules live in `agents/base/Dockerfile`: multistage `uv` build,
non-root `bedrock_agentcore` (UID 1000), ports 8080/8000, `GET /ping`,
`opentelemetry-instrument python -m main`, under 2 GB, ARM64 via local
`docker buildx`.

## Conventions and naming

- ESM is the agreed target, tracked as
  [TD-ESM-01](docs/chassis-extensibility-goal.md#technical-debt). Migration is
  deferred: only convert code already being touched for other authorized work
  when the current package boundary supports it safely. Do not turn a file edit
  into a package-wide module/config migration. Preserve required CommonJS
  consumers; future bulk work should use the deterministic inventory/codemod
  and packed-artifact checks in the chassis plan.
- TypeScript strict everywhere; Python 3.12+. AWS-native models only
  (`amazon.nova-pro-v1:0` default, `MODEL_ID` override); the devbox's Claude
  via Bedrock inference profiles is the one deliberate exception.
- The org graph is relational tables in Aurora (no Neptune, no AGE). Graph
  access is RDS Data API with parameterised SQL; read tools enforce SELECT/WITH.
- AG-UI over SSE uses POST, not EventSource. Titan Embeddings V2 at 1024
  dimensions everywhere.
- Cedar policies per tenant in `middleware/seeds/roles/<tenant>/<role>.cedar`;
  `admin.cedar` is cross-tenant and the only `Masquerade` grant. Roles:
  `orgiq` `member` / `sme` / `program-owner` / `org-leader` / `hr-admin`;
  `assessment` `assessor` / `lead-assessor` / `program-lead`;
  `social` `participant` / `moderator` / `community-admin`;
  `pipelines` `author` / `operator` / `pipeline-admin`; the fifth tenant
  `access` (`requester` / `approver` / `access-admin`; cast u-rhea, u-omar,
  u-priya; `/access/*`, `/api/access/*`, `docs/access-tenant-goal.md`,
  registered 2026-10-13 at phase A0). The non-orgiq routers
  mount behind `requireTenant('assessment')`, `requireTenant('social')` and
  `requireTenant('pipelines')` and `requireTenant('access')`; the cookie-less
  demo identity holds no grant in `social`, `pipelines` or `access`, so sign in
  as a seeded user for those.
- Prefix `orgiq-` on AWS resources; stacks `OrgIQ-*`; agents `orgiq-<name>`;
  tenants in `middleware/src/lib/session.ts` `TENANTS`; portal trees `/iq` +
  `/admin`, `/assessment`, `/social`, `/pipelines`; API prefixes
  `/api/assessment`, `/api/social`, `/api/pipelines` (orgiq unprefixed).
- Initiative ids and person ids share the `p-` prefix: initiatives are the
  slug-shaped rows in `projects` (`p-auth-migration`), people are `p-001`…

## Common commands

```bash
cd infra && ./scripts/deploy.sh [Stack] [--context k=v]   # reconciles real CFN status after deploy
cd infra && DEPLOY_PLAN_ONLY=true ./scripts/deploy.sh [Stack]  # inference, stack closure, diff; changes nothing
cd infra && ./scripts/destroy.sh                           # pre-drains runtimes/Aurora, sweeps billing survivors
node scripts/docker/middleware-image-build.mjs --dry-run   # ARM64 middleware image
cd middleware && npm test && npm run typecheck             # jest + supertest (run full suites alone, not concurrently)
cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source test_callbacks
cd agents/tests && ../../.venv-synth/bin/python golden_runner.py   # structural eval, offline
.venv-synth/bin/python -m schema.synth all [--skip-load]   # synthetic corpus; verify_* scripts spend Bedrock $
npm --prefix portal run audit:ui -- --tenant pipelines --all --strict-coverage --themes light,dark --widths 1440,900 --out .scratch/<name>
```

Agent tests need `botocore`, which only the synth venv has; never `pip install`
to fix that.

## Sibling repositories

All under `~/Projects`. A repo NAME does not identify a repository: several
exist under both `connorhoehn/` and `connorhoehnslalom/` with different
histories. Check the remote the pin names before concluding a commit is gone.

- **ui-components** (`@connorhoehnslalom/ui-components`): consumed as a packed
  tarball. Its optional peers (e.g. `@tiptap/extension-mention`) are not
  installed by npm, so the portal lists the ones it needs directly. Verify a new
  API against the installed `dist`, never the library's source or changelog.
  Queue missing composites in `docs/ui-components-queue.md`; that ledger is
  also the only exemption source for the component-discipline gate.
- **realtime-modules** (installed under its own name `@connorhoehn/realtime-modules`, no alias; canonical
  repo `connorhoehn/realtime-modules`): gateway server, `/client/video`,
  `/deck`, `agent-streaming`. The portal's socket authenticates with the BFF's
  realtime token (`GET /api/session/realtime-token`, HS256, 10 min) sent as
  `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`.
- **service-runtime** (`@connorhoehn/service-runtime`): the `X-Service-Auth`
  HMAC envelope for internal hops.
- **realtime-examples** (infra only): `ApplicationTables`,
  `DocumentWorkspaceServices`, `RedisService`, `MessageQueueTask` from its
  dependency-free `cdk/` package (`@connorhoehn/realtime-examples-cdk`, peers
  `aws-cdk-lib`/`constructs`), packed into `infra/vendor/`. Rebuild and repack in
  `realtime-examples/cdk` (its README), then move the tarball; the manifest
  ships inside the package's `dist/`.
- **distributed-core** consume `connorhoehn`; **message-queue** consume
  `connorhoehnslalom` (diverged lineages). message-queue is the `mq` container
  image input, not an npm dep.

Cross-repo fixes go upstream in the owning repo (read its CLAUDE.md), with
the consumer pin moved afterwards. Never edit `node_modules`.

## Program operating model

`docs/program-operating-model.md`. One owner per initiative plus a few SMEs;
a release manager (`org-leader`, `ManageBudgets`) allocates `initiative_budgets`
and grants sprint envelopes (`budget_grants`); the `sme` role spends them by
dispatching agents. Work is estimated in `story_points` and
`estimated_cost_usd`, never hours. `v_initiative_maintenance_30d` is the
cron-bot maintenance floor. Seed: `schema/seed_program.sql`, generated by
`schema/seeds/generate_program_seed.py` (regenerate, don't hand-edit). Seeded
bots are parked and no jobs are queued, because the scheduler and dispatcher
fire at boot against repos that may not exist.

🔒 Every initiative GitHub repo must be created **private** and checked with
`gh repo list <owner> --visibility public` afterwards; fourteen `orgiq-*` repos
were public until 2026-09-29 because nothing in this tree creates them.

## The docs map

Features follow goal-doc + validator: `docs/<feature>-goal.md` is the
definition of done and `scripts/validate-<feature>.sh` is the only judge (most
take `--quick`). `ls docs/*-goal.md scripts/validate-*.sh` is authoritative
(25 validators).

| Doc | What it is | Judge |
|-----|------------|-------|
| `program-operating-model.md` | Work, people, money, agents | — |
| `assessment-tenant.md`, `assessment-goal.md`, `assessment-parity.md` | Second tenant | `validate-assessment-tenant.sh` |
| `mock-floor.md`, `mock-floor-goal.md` | The `dev:mock` contract | `validate-mock-floor.sh` |
| `orgiq-audit.md`, `orgiq-audit-goal.md` | Org tenant audit as real seed users | `validate-orgiq-audit.sh` |
| `journeys.md` | Journey logs; stale when a walked route's rendered contract changed (`scripts/journeys/measure.sh`), sealed only by `scripts/journeys/seal.sh` after a walk | tenant validators' freshness sections |
| `branding.md` | Token/colour system | `validate-branding.sh` |
| `distillation-runbooks-design.md`, `distillation-runbooks-goal.md` | Runbooks replace distillation: readable procedures, run proposals, the frozen session brief a box receives (R0 model built 2026-10-14) | `validate-distillation-runbooks.sh` |
| `layout-cascade.md` | Page frame: two rails max, trail first, flush list rails, one type scale; route inventory in `portal/e2e/route-inventory.ts` | `validate-rail-parity.sh` |
| `route-test-coverage.md` | Route ↔ test parity | `validate-route-coverage.sh` |
| `research-honesty-checks-2026-09-16.md` | "Numbers that lie" scanners | `validate-honest-numbers.sh` |
| `nav-server-tier-decisions.md` | Rail / palette / `App.tsx` gate parity | `validate-nav-parity.sh` |
| `ui-components-queue.md` | Missing composites; the component-discipline exemption ledger | `validate-component-discipline.sh` |
| `social-tenant-design.md`, `social-tenant-goal.md`, `pipelines-tenant-goal.md` | Third and fourth tenants, the activity bell | `validate-social-tenant.sh`, `validate-pipelines-tenant.sh` |
| `communication-plane-goal.md` | Social seen from the other tenants | `validate-communication-plane.sh` |
| `access-tenant-design.md`, `access-tenant-goal.md`, `access-tenant-api.md` | The fifth tenant: access requests, approvals, provisioning (A0 registered 2026-10-13; A1/A2/E in progress) | `validate-access-tenant.sh` |
| `demo-content-audit.md`, `demo-content-goal.md` | Demo content a peer believes: per-tenant five-minute stories, the clone probe over every tenant × role (`portal/e2e/demo-content-probe.spec.ts`), fix lanes | `validate-demo-content.sh` |
| `work-journeys-goal.md`, `work-journeys/PROTOCOL.md` | Deep, executable Work-tenant (orgiq) journeys per role: the catalog, maps under `docs/journeys/maps/work/`, logs in `docs/work-journeys/`, ratcheting route × role × state floors (`scripts/work-journeys-floors.tsv`), refusals of every gated route; replaces the `docs/orgiq-journeys` hand logs | `validate-work-journeys.sh` |
| `user-search-goal.md`, `user-search-intents.md` | User search per tenant: the intent catalog and clone probe (`portal/e2e/user-search-catalog.ts`, `user-search-probe.spec.ts`), the storage-agnostic search index (`middleware/src/lib/search-index`, memory + DynamoDB-wire, updated on write), ratcheting per-tenant floors (`scripts/user-search-floors.tsv`), search journey maps | `validate-user-search.sh` |
| `upstream-refinement-goal.md`, `upstream-refinement-plan-2026-10-14.md` | The realtime chain under the app: one distributed-core, realtime-modules owns its seams and capacity, apps on the chain, the consumer on the canonical name | `validate-upstream-refinement.sh` |
| `meeting-rooms-app-goal.md` | Teams-style meetings on the app's calls: raise hand, reactions, breakout rooms (media and chat follow the room), announcements; library side in realtime-modules `docs/design/meeting-rooms-goal.md`; behind `VITE_MEETING_ROOMS` | `validate-meeting-rooms-app.sh` |
| `agent-eval-goal.md` | Golden sets + `golden_runner.py` | `validate-agent-eval.sh` |
| `deployment-enhancements/DE-28-bug-class-lint.md` | Lint for the deploy's bug classes: partial secret ARNs, uuid binds as text, a second CommonJS editor stack | `validate-deploy-bug-classes.sh` |
| `agentcore-preview-surface.md`, `agentcore-preview-plan.md` | Preview API research, callback runbook (§6a) | — |
| `audit/2026-10-07-audit-plan.md` | Structural duplication audit and its "stop doing" list | — |
| `realtime-validation/<date>/` | Dated acceptance records for realtime, calls, capacity | — |

One further pair records a retired tenant's removal and asserts its name
appears nowhere in this file, so it is not listed by name.

The UI DOM audit skill lives in `../ui-components/skills/ui-dom-audit/`
(adapter `portal/e2e/ui-dom-audit.adapter.ts`, routes
`ui-dom-audit.routes.ts`, policies `ui-dom-audit.policies.ts`). Live tests sign
in through `portal/e2e/realSession.ts`; never run two browser processes as the
same fixture identity at once, because a tenant switch revokes the other
cookie through session epochs.

---

# Gotchas

Each entry is a day someone lost. Read the group for the area you are about to
touch.

## Deploying and tearing down

- **Runtimes are a second phase.** `OrgIQ-AgentCoreRuntime` creates the repos
  the runtimes pull from, so deploying with `deployRuntimes=true` on empty repos
  fails every `CfnRuntime`. Order: deploy the stack, `agents/base/build.sh`,
  `agents/build-all.sh`, redeploy with the flag. Agent, base and devbox repos
  are `DESTROY` with `emptyOnDelete`; only `orgiq-middleware` is `RETAIN`.
- **Runtimes delete slower than CFN waits** (`NotStabilized`, `DELETE_FAILED`).
  `destroy.sh` pre-drains endpoints then runtimes; "already deleting" is
  success. A retry with `--retain-resources` must exclude the stack's own name.
- **Aurora cold start and the custodian.** The first Data API call to a cold
  cluster fails until the endpoint enables; `schema/load_schema.py` and the KB
  stack's `DataApiReady` resource retry transients only. Both S3 buckets use a
  self-role emptier Lambda because the account's custodian strips the bucket
  policy CDK's `autoDeleteObjects` relies on. `deploy.sh` reconciles every
  stack's real status (rollback states count as failures) and auto-retries the
  KB `CREATE_FAILED` race once.
- **The account closes open security groups within seconds**
  (`custodian-restrict-security-group-admin-ingress`). The middleware ALB uses
  `openListener: false`; pass `--context albAllowCidr=<ip>/32`. Healthy but
  unreachable means read the live SG first. Whether the CloudFront prefix-list
  rule survives is unverified.
- **The middleware task is ARM64** and its stack reaches `CREATE_COMPLETE`
  with an empty repo and zero running tasks. "All stacks healthy" is not "the
  middleware is serving"; check `describe-services` desired vs running. Build
  and push the image, then redeploy with `deployMiddlewareService=true`.
- **KB exports are frozen once imported** (middleware by stable name, others by
  hash). A KB deleted out of band must be recreated via the Bedrock API with
  the same config and re-pointed with `--context kbId=`.
- **`middleware/.env.aws` rots on every rebuild** (browser, code interpreter,
  memory ids). Regenerate with `./schema/dump-stack-outputs.sh`; `config.ts`
  only fills vars the shell leaves undefined.
- Aurora bills 0.5 ACU idle (~$45/mo), and the knowledge base shares that
  cluster (pgvector); the budget alarm matters.

## Agent runtimes and images

- **ADOT, not vanilla OTel.** The runtime sets
  `OTEL_PYTHON_CONFIGURATOR=aws_configurator`, which only ADOT provides; with
  the vanilla distro no spans are exported and observability starves silently.
- **The devbox fleet registry is in-memory Maps mirrored to Aurora**
  (`lib/devbox-fleet.ts`, `devbox_boxes`). The Data API returns `TIMESTAMPTZ`
  naive (`lib/devbox-fleet-rows.ts::utcIso`), writes are serialised per box,
  and a structural write drops queued `touch`es. Degrades to memory when
  Aurora is mocked or missing the table.
- **`/mnt/workspace` is wiped on every runtime version update** (digest-pinned
  images roll the runtime on each push). Treat it as a cache.
- **System prompts come from Bedrock Prompt Management at run time**
  (`orgiq-<agent>-system-prompt` DRAFT, 60 s cache); `SYSTEM_PROMPT` in
  `main.py` is the fallback. The `bedrock:GetPrompt`/`ListPrompts` grant must be
  on the **execution** role, and `ListPrompts` must be paginated.

## Observability

- The supervisor's streaming path must set its TraceContext or A2A topology
  edges never appear (every sub-agent trace gets a NULL parent).
- **Sampling gates persistence.** `observability.sampling_config.rate` applies
  before insert; the seeded default is 1.0, but `trace-sink.ts`'s
  `FALLBACK_RATE = 0.1` returns when the sampling cache is empty.
  `OBS_USE_LEGACY_POLLER` defaults to `'true'` (the middleware polls
  CloudWatch for `ORGIQ_TRACE:` lines).
- **Error rate ≠ answer quality.** `errorRate` counts guardrail interventions
  and schema failures; weak answers are `lowQualityRate` (only
  `routes/traffic.ts` reports both). Phantom rows are dropped only when every
  substance axis is empty.
- Judge config lives in SSM `/orgiq/canary/judge_config`, owned by
  `lib/judge-config.ts`, not by the canary stack.
- **The KB registry drifts.** `resolve_kb_id` filters on `status = 'ACTIVE'`, so
  a `PENDING` row silently falls back to the `KB_ID` env var; `/admin/knowledge`
  reconciles against live Bedrock.

## The knowledge base

- **Default search type ranks this store's results backwards** (reports cosine
  distance as `score`; top-1 correct 0/8 default, 8/8 `HYBRID`). Every
  `Retrieve` call pins the search type via
  `agents/_shared/kb_resolver.py::vector_search_config()` (the gateway Lambda
  carries a literal copy); `HYBRID` needs the `bedrock_kb_text_idx` GIN index
  the KB stack creates. `turn-tool-calls.ts` trims result lists from the tail,
  which compounds a reversed order. Tests assert the key's presence.
- `sync_knowledge_base` needs both `KnowledgeBaseId` and `DataSourceId` outputs
  and used to skip with exit 0 when one was missing. If the KB looks empty,
  look for an ingestion job first.
- `schema/synth/staged/` is gitignored scratch; `load_staged()` filters on
  `generate.DOC_TYPES` so orphaned artifacts stay inert.
- `documents.doc_type`/`headline`/`published_at`/`section` are deliberate
  `ADD COLUMN`s in `orgiq_schema.sql` so old and new clusters converge.

## Identity, authz and tenancy

- **Identity is real.** Users, tenants and grants live in Aurora
  (`identity_schema.sql`) with an in-memory mirror; the signed cookie carries
  `grants` and `act`; every switch is validated in `routes/session.ts`.
  `requireTenant()` is the data boundary for the non-orgiq tenants. Open-mode
  authz (no `POLICY_STORE_ID`) denies in production and treats the admin
  wildcard as every action (`seedPolicyDecision`).
- **New Cedar actions must also be listed in `CAPABILITY_ACTIONS`**
  (`lib/authz.ts`), or `GET /api/session/capabilities` reads `undefined` and
  every control behind the action hides for every role.
- **`session_epoch` closes the stateless-cookie replay window to ≤120 s.**
  Tenant/role switches and `revoke-others` bump it; the grants refresh in
  `sessionMiddleware` drops older cookies. The client hard-navigates and
  `clearTenantScopedCaches()` wipes tenant-scoped storage while keeping device
  prefs.
- **`requireSession` vs `requireAction`.** Readable-by-every-role means
  signed-in, not anonymous. Agent callbacks (`/approvals/request`,
  `/harness/trace`, assessment run-complete) carry per-route service auth from
  `lib/service-auth.ts`, never a mount-level session floor; a blanket mount
  silently 401s the fleet.
- **Closing the callback guards is an ordered two-stack deploy** (roll agent
  images first, then middleware, then redeploy runtimes with the three secret
  contexts and `portalPublicUrl`). `docs/agentcore-preview-surface.md` §6a.
- **platform-api lobby admission asks the BFF** (`POST /api/realtime/lobby-access`);
  deploy the route before setting `LOBBY_AUTHORITY_URL` on platform-api.
- **SSO is Cognito + a BFF OIDC flow** minting the same cookie via
  `mintSession`. Pool ids are reminted on every auth rebuild; regenerate
  `.env.aws`. Cognito rejects non-localhost http callbacks, so the deployed
  BFF needs the CloudFront portal origin first.
- **ONE Social permission path** (`lib/social-authority.ts` `socialGate`), ONE
  "mine" reader (`lib/mine.ts`, `GET /api/me/groups`), ONE shared-work notion
  (`lib/work-graph/shared-work.ts`), ONE gateway authority facade
  (`lib/gateway/authority.ts`). Do not add a second spelling of any of them.
- **The agents' SQL guard is a security boundary.** `agents/_shared/sql_guard.py`
  strips comments and quotes, requires a single statement and scans for write
  verbs anywhere (a regex `^(WITH|SELECT)` let `WITH x AS (DELETE …)` through).
  Deployed readers run as `orgiq_graph_reader` (`schema/graph_readonly_role.sql`,
  `AURORA_READONLY_SECRET_ARN` mandatory, fail closed). Keep both layers.

## Money, dispatch and write gates

- `POST /api/bots/dispatch-work` runs a hard `decideGrantScopedDispatch` gate
  (SME needs an active sprint grant) then three soft brakes, each with its own
  confirm flag (`confirmOverRunBudget` / `confirmOverAllocation` /
  `confirmOverEnvelope`); `dispatched_by` comes from the session, never the
  body. Sprint writes share the shape via `requireInitiativeSteward`.
- Direct invoke of a write agent (graph-builder, ingestion, scoring) needs
  `ManageIngest` (`WRITE_AGENT_RE` in `routes/agents.ts`).
- **A second replica made boot recovery destructive.** `recoverOrphanedWork`
  requeues every live job only when `lib/replica-fleet.ts` reports no peers
  (Redis sorted set); unreachable Redis means peers unknown, never alone.

## Local dev traps

- **Another server on :3001 silently takes every portal `/api` call** (`::1`
  first). Vite probes `127.0.0.1:3001` then `:3011` for the middleware health
  signature; `PORT=3011 npm run dev:mock` when 3001 is taken. `tsx watch` can
  also look alive while holding no socket after a rebind failure.
- **Stop only PIDs you started.** Pattern `pkill` has killed shared dev servers.
- **The realtime gateway is on `/ws`** (`REALTIME_GATEWAY=on` outside
  production). `channelGuard` via `authorize` is the one guard; do not also wire
  `presence({ authorizeChannel })`. Chat state is Dynamo when
  `SOCIAL_CHAT_STORE=dynamo`, registered mock fixtures otherwise. Keep the
  single-gateway safeguard (CDK pins it) until capacity is accepted.
- **Browser origins are restricted** (`lib/browser-origin.ts`: own origin,
  `PORTAL_ORIGIN`, `PUBLIC_BASE_URL`, `CORS_ALLOWED_ORIGINS`, loopback in dev).
  `TRUST_PROXY_HOPS` is 1 behind the ALB, 2 with CloudFront; only then is the
  viewer scheme read from `CloudFront-Forwarded-Proto`.
- **`useFetch` polls pause in hidden tabs and back off on failure**; anything
  handed to `ComputeProvider` as `clientOptions` must be a stable reference.
- **Jest shares one server per file** (`jest-shared-server.ts`, keep-alive off)
  to stop recycled ports serving a previous test's body. Run the full suite and
  the mock-floor judge sequentially; two concurrent full runs have hung.
- **Pin bumps lie three ways.** A short sha leaves npm satisfied and installs
  nothing; a `github:` dep is foldered by the dependency key, so a version
  check can pass for a package you cannot import; Vite serves the old dist
  until `node_modules/.vite` is cleared and the server restarts. "does not
  provide an export named …" is almost always that stale cache: check with
  `node --input-type=module -e "import('@connorhoehnslalom/ui-components/shared').then(m=>console.log(typeof m.T))"`
  before reimplementing anything.

## Facts that bite

- Scanning JSX tags with `<Tag[^>]*>` truncates at `=>`; walk braces
  (`validate-component-discipline.sh` is the worked example).
- `decisions` is one table, extended in place; `observability.approval_decisions`
  and `canary_decisions` are unrelated.
- The initiative/person `p-` prefix clash (above). The RDS Data API returns
  naive timestamps. Aurora does not support AGE.
- Journey logs are stale on rendered-contract change, not file mtime; never
  seal to clear a digest mismatch, and a fresh clone masks staleness.
