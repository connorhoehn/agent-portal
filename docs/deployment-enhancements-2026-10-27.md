# Deployment enhancements backlog (2026-10-27)

Short-form items for other agents to spec. Each comes from something observed
during the 2026-10-26/27 AWS deploy (`docs/aws-deploy-open-items-2026-10-27.md`)
or a documented gotcha in `CLAUDE.md`; none is generic best practice. The
theme is extensibility, adaptability and operations. Numbering is stable so
specs can cite `DE-<n>`.

## A. AgentCore / Bedrock

- **DE-1 One-command runtime rollout.** Today: deploy `OrgIQ-AgentCoreRuntime`
  (empty ECR repos), run `agents/base/build.sh` + `agents/build-all.sh`,
  redeploy with `deployRuntimes=true`. Fold into one idempotent step.
- **DE-2 Digest-pinned agent images, versioned rollout.** Pin each runtime to
  an image digest; use AgentCore runtime versions/endpoints for per-agent
  canary or traffic shift, beyond the all-or-nothing `onlyAgents`.
- **DE-3 Model registry.** Replace per-agent `MODEL_ID` env with a central,
  versioned config (SSM/AppConfig): inference profiles, fallback models,
  cross-region routing.
- **DE-4 Prompt promotion pipeline.** Prompts are read from the DRAFT version
  with a 60 s cache. Move to versioned prompt aliases promoted through the
  existing prompt canary and eval.
- **DE-5 Eval as a deploy gate.** Online eval is a raw `CfnResource`, off by
  default. Make golden sets plus online eval a pass/fail step before a model,
  prompt or image change ships.
- **DE-6 AgentCore Identity for callbacks.** Runtime callback secrets are
  plain env vars (runtime env cannot reference Secrets Manager), and closing
  the callback guards is an ordered multi-stack deploy. Replace with workload
  identity / OAuth tokens and rotation.
- **DE-7 Registry-driven MCP gateway tools.** Onboard tools and targets from a
  manifest without CDK edits.
- **DE-8 AgentCore Memory as config.** Per-tenant memory strategies and
  retention through config, not code.
- **DE-9 Native observability.** Replace the CloudWatch-polling trace sink
  (`OBS_USE_LEGACY_POLLER=true`, `FALLBACK_RATE = 0.1`) with AgentCore
  Observability / OTLP; per-agent latency, error and token dashboards.
- **DE-10 Bedrock cost and quota operations.** Token and dollar metering per
  runtime and per tenant; throttling (TPM/RPM) alarms; quota requests ahead of
  demand.
- **DE-11 Knowledge Base off CFN exports.** KB exports freeze once imported and
  the KB registry drifts (`PENDING` rows fall back to `KB_ID`). Resolve KB ids
  through SSM; reconcile ingestion state and the pinned `HYBRID` search type.
- **DE-12 Guardrail lifecycle.** Versioned per-role guardrails, live-vs-code
  drift detection, tests before promotion.
- **DE-13 Low-latency directory and graph reads.** Every authoritative read is
  a Data API round trip; RDS Proxy or a direct in-VPC connection for the BFF
  and agents. Likely cause of the ~9 s call join window.

## B. Deployment orchestration

- **DE-14 Single resumable deploy orchestrator.** Fleet → images → runtimes →
  middleware → portal → Social → documents as one command with recorded
  state. Today each phase is hand-run with digests copied between steps.
- **DE-15 CI/CD.** Deploy from GitHub Actions through an OIDC role; build ARM64
  images in the cloud (a local Colima Docker crash stalled builds this
  session; private GitHub deps need a scoped read credential).
- **DE-16 Resume after credential expiry.** Checkpoint progress;
  `aws-azure-login` sessions expire mid-deploy.
- **DE-17 Parameterised environments.** Account, region, prefix and
  domain-vs-CloudFront as configuration, so a preview or fresh environment
  needs no edits.
- **DE-18 Digest pins everywhere.** The middleware service pulls `:latest` and
  needs `--force-new-deployment` after each push.
- **DE-19 Script-made resources under CloudFormation.** Document ECR repos,
  grant keys and the SSM context are created by
  `document-workspace-push.mjs`; a `DocumentImages`-style stack would own
  them, as `OrgIQ-SocialImages` does.
- **DE-20 Automated schema migrations.** A migration ledger with dry-run,
  applied by the deploy, instead of `schema/load_schema.py` by hand.

## C. Operations and verification

- **DE-21 Post-deploy verification gate.** `cloud-call-smoke` and
  `cloud-documents-smoke`, health and target checks as the final deploy step.
- **DE-22 Custodian preflight.** The account custodian revokes open SG rules
  and strips bucket policies; verify the rules and policies survived instead
  of trusting `*_COMPLETE`.
- **DE-23 Allowlists that follow people.** Derive the operator IP; admit call
  participants through TURN (`deployTurn`, built but off), not per-IP
  `sfuAllowCidr`.
- **DE-24 Cloud environment bootstrap.** Cognito test users (seeded ones sit at
  `FORCE_CHANGE_PASSWORD`), a knowledge source and synthetic corpus, demo
  identities.
- **DE-25 Middleware capacity.** One pinned 1 vCPU gateway task; decide a larger
  task vs Redis peer routing (open decision in `CLAUDE.md`).
- **DE-26 Idle cost controls.** Scheduled scale-to-zero for Aurora, Fargate and
  the SFU in idle environments; per-environment budget; hourly-burn estimate.
- **DE-27 Verified teardown.** `destroy.sh` checks the API and reports every
  survivor, including non-CFN resources.
- **DE-28 Lint for this deploy's bug classes.** Partial secret ARNs, uuid binds
  as text, a second CommonJS editor stack in the production bundle.
- **DE-29 Tenant manifest.** Five tenants are hard-coded across `TENANTS`, the
  Cedar seeds, routers and CDK; a manifest should drive policies, routes,
  runtimes and stacks so a tenant is added without code changes.

## D. Agent microVM runs: budgeting and policy

Agents run for an initiative in AgentCore Runtime microVMs (the devbox:
`orgiq_devbox`, Claude Code inside, `infra/lib/devbox-stack.ts`). Money is
allocated as `initiative_budgets` (monthly) and SME `budget_grants` (sprint
envelopes); `POST /api/bots/dispatch-work` runs one hard gate
(`decideGrantScopedDispatch`) and three soft brakes. File refs below are where
the current behaviour lives; each item is the gap it closes.

### D1. Metering: every dollar lands on the initiative

- **DE-30 One spend ledger for every run path.** Budget spend is
  `SUM(bot_runs.cost_usd)` (`schema/agent_budgets_schema.sql`,
  `providers/budgets.ts`), so ad-hoc `/api/devbox/:sid/task`, `/internal/devbox`
  tasks and `POST /api/work/jobs` / `findings/:id/promote` queue jobs spend
  real Bedrock money that no budget sees. One append-only spend ledger keyed by
  initiative, grant, run and box, written by every path.
- **DE-31 Box spend rolls up.** `devbox-fleet.ts` accumulates `spendUsd` per box
  from each `total_cost_usd`, but it never reaches a budget. Attribute it to the
  box's `projectId` and owner.
- **DE-32 Claude prices in the pricing table.** `BEDROCK_PRICING`
  (`lib/pricing.ts`) holds Nova/Titan only, so lab traces price to `null`.
  Source prices per model and inference profile from config, with a fallback
  estimate when Claude Code reports no cost.
- **DE-33 Unknown cost is not "allowed".** The SDLC `max_cost` policy passes a
  change with no recorded cost (`sdlc-policy.ts`), and local runs record a
  confident $0 (`run-cost.ts`). Unknown should route to approval.

### D2. Enforcement: budgets hold during the run, not only before it

- **DE-34 Budget reservations at dispatch.** Checks are before-dispatch only and
  nothing is held, so concurrent dispatches each pass the allocation check
  against the same remaining money (`routes/bots.ts`). Reserve the forecast
  (p75) against the allocation and the envelope at dispatch; settle on finish.
- **DE-35 Mid-run spend cutoff.** `appendEvent` adds spend with no check
  (`devbox-fleet.ts`), and over-budget after the fact only sets
  `overRunBudget: true` (`bot-runner.ts`). Stop the task (the process-group
  kill already exists in `agents/devbox/main.py`) when a run crosses its
  reserved ceiling, with a recorded reason.
- **DE-36 Hard caps beside the soft brakes.** All three brakes are confirmable
  409s; no allocation row means no allocation brake, and an unreadable envelope
  means no envelope brake (fail-open). Add a non-overridable hard cap per
  initiative and per grant, and fail closed when budget state is unreadable.
- **DE-37 Rate and concurrency limits per initiative.** `BOT_MAX_CONCURRENT=3` is
  one global number (`bot-runner.ts`); queue jobs are bounded only by idle
  boxes. Per-initiative and per-tenant concurrency, runs/day and $/hour limits.
- **DE-38 Budget periods beyond monthly.** Monthly is the only period
  (`agent_budgets_schema.sql`); add sprint-aligned and rolling windows, and
  carry-over rules.
- **DE-39 The bot-fire allocation brake.** Documented as not built
  (`docs/program-operating-model.md`, `bots.enforce_allocation`); cron firings
  spend without the allocation check unless opted in.

### D3. Policy: what a box may do, per initiative

- **DE-40 Policy profiles per initiative.** Model allowlist (today in CDK and the
  Dockerfile, silent fallback on an unlisted model), max task time (840 s / 3300 s
  in `main.py`), box lifetime, network mode, org-data access
  (`devboxOrgAccess`, deploy-wide) as one versioned profile an initiative
  references, editable without redeploying the runtime.
- **DE-41 Egress control.** Network mode is `PUBLIC` with no egress rules
  (`devbox-stack.ts`), and Claude Code runs with
  `--dangerously-skip-permissions` (`main.py`). VPC mode with an allowlist
  (GitHub, Bedrock, package registries) per profile.
- **DE-42 Cedar for box actions.** `ManageDevbox` gates everything from shell to
  SDLC policy CRUD (`index.ts`). Split shell, task, delivery and policy-edit
  into separate actions with initiative attributes, evaluated (locally
  attribute conditions are skipped, `authz.ts`).
- **DE-43 Separation of duties.** `POST /changes/:id/decide` does not stop the
  author approving their own change; an SME holding `ManageDevbox` can edit or
  delete the SDLC policies that gate them (`routes/sdlc.ts`).
- **DE-44 Scope checks on every entry point.** Done 2026-10-27:
  `/internal/devbox/sessions` runs the steward check for the signed principal's
  user (`userStewardsInitiative`, `lib/initiative-scope.ts`) before charging a
  box to `projectId`. Other entry points not yet audited.
- **DE-45 Credentials out of shell strings.** The clone token is interpolated
  into a shell command (`providers/agent-projects.ts`, flagged as needing an
  image change); short-lived, repo-scoped tokens (GitHub App) per run.
- **DE-46 Policy as data, versioned.** SDLC defaults ($5, 40 files, sensitive
  paths in `sdlc-policy.ts`) as versioned per-initiative policy with an audit of
  who changed what.

### D4. Operations: the fleet survives scale and failure

- **DE-47 Fleet state that survives replicas.** Busy flags, reservations, event
  buffers and the reaper live in one process (`devbox-fleet.ts`,
  `devbox-reaper.ts`, started on import of `routes/devbox.ts`); sessions the
  registry forgets cannot be enumerated from AgentCore. Move to Redis/Aurora
  with a leader-elected reaper (the lease groups exist upstream).
- **DE-48 One lifetime model.** The reaper's 60 min ceiling from creation can kill
  a running task while AgentCore allows 8 h and the task timeout is up to 55 min;
  align the ceilings and make them profile-driven (DE-40).
- **DE-49 Workspace persistence that survives a deploy.** `/mnt/workspace` is
  wiped on every runtime version update (digest-pinned images roll the runtime);
  snapshot checkouts and `~/.claude` to S3 or re-clone deterministically.
- **DE-50 Kill switches and alerts.** Fleet-wide pause, per-initiative pause, and
  alarms on spend rate, budget thresholds (50/80/100 %), stuck runs and reaper
  kills; today the reaper only writes `console.warn`.
- **DE-51 Lab loop wiring.** Callback auth already fails closed in production
  (`requireServiceAuth` answers 503 with no secret, `service-auth.ts`; covered
  by `service-auth-guard.test.ts`) and the deployed middleware sets
  `LAB_CALLBACK_SECRET`; open only in development. What remains is that
  `LAB_API_BASE` was never set, so the lab loop is inert in AWS (needs DE-52).
- **DE-52 Deployable devbox phase 2.** `OrgIQ-Devbox` is phase 1 only in AWS (no
  runtime); fold `agents/devbox/build.sh` and `deployDevbox` into DE-1/DE-14.
- **DE-53 Spend and run reporting per initiative.** One view joining allocation,
  grants, reservations (DE-34), ledger spend (DE-30), forecasts and run
  outcomes, for the release manager and the SME.
