# Demo content brief: engineering a consultant recognises

2026-10-16. The user's peers are experienced engineering consultants. They
should open a page and recognise an engagement they have worked on: real
systems, real tradeoffs, failure modes, commands and numbers. This brief is
the story the Work, Runbooks and Communication content tells together. It
extends `docs/demo-content-goal.md` (whose judge still decides done) and does
not replace any of its rules: the program seed is generated, the mock mirrors
it, ids and cast names stay as they are.

## What "good" reads like

| Instead of | Write |
|---|---|
| "Improve alerting" | "Multi-window burn-rate alerts: page on 2% budget in 1h (14.4x), ticket on 5% in 6h (6x)" |
| "Decided to use Aurora" | context, the options weighed, the tradeoff that settled it, the consequence we now live with |
| "Run completed" | "bumped otelcol-contrib 0.109 → 0.111 in 3 configs; `make e2e-collector` green; 1 file quarantined" |
| "Glad it was quick" | "Postmortem action: alert on `otelcol_exporter_queue_size / queue_capacity > 0.8`, not on pod restarts" |
| a procedure that says "check the config" | the command, what you should see, why, and how to back out |

No "Q3 alignment", no "synergy", no "leveraging". Numbers are specific and
plausible; every failure has a cause somebody names; every procedure has a
command and an expected output.

## The cast and what they actually do

Names and ids are unchanged (sign-in cast in `middleware/src/providers/identity.ts`,
org graph in `mock/people.ts`). Specialties below govern what each person
writes and what agent runs they start.

| Person | Seat | Specialty on this engagement |
|---|---|---|
| Vera Green (p-002, u-vera) | Principal Engineer, owns **Auth Migration**; org leader | Identity: OIDC, SAML, session design. Writes the ADRs. |
| Nora DaSilva (p-004, u-nora) | Senior Engineer, owns **Observability Platform**; SME on Auth | OTel collector internals, Linux; runs the cutover rehearsals. |
| Simone Chang (p-051) | Senior Security Engineer, owns Zero Trust; SME on Auth | JWKS/kid rotation, token verification, mTLS. Reviews runbook edits. |
| Rhea Castellanos (p-rhea, u-rhea) | Security Engineer, SME on Auth | IAM, threat modelling of the cutover; access requests elsewhere. |
| Sienna Garcia (p-005, u-release) | Release Manager | Release train, change windows; decides the cutover order. |
| Rachel Kowalski (p-012, u-rachel) | Principal Engineer, incident commander | On-call lead; writes the incident timelines and postmortems. |
| Theo Chang (p-001, u-theo) | Engineer, Platform | Realtime gateway and search callbacks; finds root causes. |
| Layla Hassan (p-008, u-layla) | SRE Lead, owns **Cost Optimization**; SME on Observability | Capacity, Aurora/OpenSearch floors, burn-rate math. |
| Eli Garcia (p-011, u-eli) | Senior SRE; SME on Observability and Cost | Alerting, canaries, Fargate/ECS operations. |
| Caleb Turner (p-013, u-caleb) | Senior Engineer; SME on LLM Platform and Inference | Autoscaling, Bedrock, eval harnesses. |
| Nina Rivera (p-047) | Staff ML Engineer, owns **LLM Application Platform** | Prompt management, canary judge, retrieval quality. |
| Paolo Mancini (p-049) | Engineering Manager, owns **Inference Platform** | Serving SLOs, warm pools, cost per 1k requests. |
| Mia Singh (p-030, u-mia) | Program owner; holds Auth Migration's money | Budgets, sprint envelopes, showback. |
| Tomás Ferreira (u-tomas) | Pipelines author | Writes the maintenance bots' definitions. |

Assessment (Asha, Jonas, Farah) and Social (Mira, Lena, Sana) people keep their
products' stories; in shared channels they talk like the engineers they work
with (Jonas runs CI maturity assessments; Farah does accessibility reviews).

## Five initiatives, five technical arcs

Ids, names, owners and SMEs are unchanged. Each arc gives the board, the
decisions, the runs, the runbooks and the threads one story.

### 1. Auth Migration (`p-auth-migration`) — the flagship story

Move every customer tenant off a legacy SAML shim onto Cognito with a BFF
running the OIDC authorization-code + PKCE flow; zero forced logouts.
- **Done:** BFF code+PKCE (`wi-auth-e1-s1`), JWKS verification with `kid`
  rotation (`wi-auth-e1-s2`), consumer inventory (`wi-auth-e2-s1`: 14 tenants,
  2 with custom SAML attribute mappings).
- **In flight:** session cookie hardening (rotate on switch, server-side
  max-age); the refresh loop on revocation (`wi-auth-e1-b4`: the client retries
  a 403 forever because revocation is not a terminal signal; fix = 401 with
  `error="invalid_token"` and a `session_revoked` reason the client does not retry).
- **Blocked:** the tenant-by-tenant cutover runbook (`wi-auth-e2-s2`) waits on
  **`d-cognito-cutover`, "Cutover order for legacy SSO tenants"**, escalated by
  Vera to Sienna: smallest-first (low blast radius) vs riskiest-first (the two
  custom-attribute tenants, while the shim is warm and rollback is a DNS flip).
- **Runs:** the agent run that migrated the token verifier off the deprecated
  JWKS client **failed**: 3 tests in `auth/verify.test.ts` pinned the pre-rotation
  signing key (stale fixtures, not a verifier bug). Rehearsal two
  (`sess-auth-06`) failed at the flip because the tenant origin was missing
  from the Cognito app client's callback URLs; rolled back in two minutes.
- **Runbooks:** `rb-tenant-cutover` (with the pending edit
  `prop-tenant-cutover-callback`: check the callback list before the flip),
  `rb-sso-new-origin`, `rb-auth-pr-csrf-gate`.

### 2. Observability Platform (`p-observability`)

OpenTelemetry collectors (agent + gateway tiers) replacing a StatsD bridge;
tail sampling; SLO burn-rate alerting.
- **The bug:** collector gateways OOM under burst ingest (40k spans/s for 90 s)
  because the exporter's sending queue is unbounded; fix = `memory_limiter`
  first in the pipeline plus a bounded `sending_queue`, accepting dropped
  healthy spans (tail sampling keeps errors and p99).
- **The gotcha that became a runbook:** an agent image built on the vanilla
  `opentelemetry-distro` exported nothing, silently, because the runtime sets
  `OTEL_PYTHON_CONFIGURATOR=aws_configurator`, which only ADOT provides.
- **Decision:** `d-otel-vendor` self-hosted collectors over per-host vendor agents.
- **Runbooks:** `rb-statsd-decommission`, `rb-flaky-test-rerun-diff`, the new
  `rb-adot-span-export`.

### 3. Inference Platform (`p-inference-platform`)

Shared model serving: scale on queue depth instead of CPU, warm pools,
per-model canaries.
- **The bug:** cold-start p99 breaches the 2.5 s SLO after scale-to-zero
  (first request after idle pays a 40–90 s model load).
- **In flight:** queue-depth autoscaling (target 4 in-flight per replica,
  scale-out at 30 s sustained, scale-in after 10 min).
- **Runbooks:** `rb-fargate-arm64-image` (exec format error from a Mac-built
  image), the new `rb-two-phase-runtime-deploy` (runtimes before their ECR
  repos have images fail every `CfnRuntime`) and `rb-ecs-healthy-not-serving`
  (a stack at CREATE_COMPLETE with zero running tasks).

### 4. LLM Application Platform (`p-llm-platform`)

Prompts managed like code, a canary judge, golden-set evals, retrieval quality.
- **Decision (open):** `d-eval-judge-model`, Nova Pro vs Nova Lite as the judge
  (6x the cost, 11 points better agreement with human labels).
- **The gotcha:** the knowledge base's default search ranked results backwards
  (it reported cosine *distance* as score: top-1 correct 0/8 default, 8/8
  HYBRID). Every `Retrieve` call now pins the search type. This is the day
  someone lost; it became `rb-kb-search-type-pin`.
- **Runbooks:** `rb-judge-rubric-weights` (from `prop-judge-rubric-weights`),
  `rb-ingest-pii-scan`, `rb-kb-search-type-pin`.

### 5. Cost Optimization (`p-cost-opt`)

Nothing bills while idle without a written reason; showback per initiative.
- Aurora Serverless v2 bills 0.5 ACU idle (about $45/month per cluster);
  OpenSearch Serverless holds a 2-OCU floor; orphaned NAT gateways survived
  stack teardown at $32/month each plus data processing.
- **Runbooks:** `rb-idle-teardown-proposal`, `rb-aurora-cold-start-retry`
  (the first Data API call to a paused cluster fails until it resumes), the
  new `rb-custodian-sg-allowlist` (an account policy revokes open ingress
  within seconds: request an allow-list instead of opening 0.0.0.0/0).

## The runbook library

The library is the org-wide Claude Code skill library: procedures plus the
scripts and data that make their mechanical steps one command. Each is written
for any AWS engagement, then names this org's values in a labelled paragraph.
Every runbook has preconditions, commands with expected output, a reason for
the non-obvious steps, a verification and a rollback.

Existing (rewritten where thin): the nine migrated runbooks,
`rb-ws-cdp-debug`, `rb-gateway-presence-client`, `rb-journey-walk`,
`rb-ui-components-release`. Added, each generalised from a day this team lost:

| Id | Title | The lost day |
|---|---|---|
| `rb-kb-search-type-pin` | Pin a Bedrock knowledge base's search type and prove the ranking order | Default search returned the right document last; 0/8 top-1 |
| `rb-adot-span-export` | Prove an agent's spans actually export (ADOT, not vanilla OTel) | A week of empty trace dashboards, no error anywhere |
| `rb-pin-bump-verify` | Verify a dependency pin bump against what is actually installed | A short SHA left npm "satisfied" and installed nothing; Vite served the old bundle |
| `rb-two-phase-runtime-deploy` | Deploy container runtimes after their repositories have images | Every runtime failed to create against empty ECR repos |
| `rb-ecs-healthy-not-serving` | Tell "stack healthy" from "service serving" on ECS Fargate | CREATE_COMPLETE, zero running tasks, 503 at the ALB |
| `rb-custodian-sg-allowlist` | Reach a load balancer when a custodian keeps closing its security group | Ingress rule vanished 20 seconds after every edit |

Proposals and applications cite runs and sessions on these initiatives
(`sess-auth-06`, `sess-llm-05`, `sess-obs-03`, …), and a Communication thread
shows where each new one came from.

## Communication: engineers talking about the same work

Shared channels are an engineering workspace. Every thread cross-references
the board, the runs and the runbooks above, with the same people.

- **`#auth-migration`** (unchanged arc): the cutover-order argument, the
  escalation, the JWKS run failure, rehearsal two's callback miss, the
  runbook edit waiting on Simone's review, Sienna deciding after the retry.
- **`#incidents`**: Rachel's Sev 3 (call transcripts delayed for calls over an
  hour; the transcription job's visibility timeout was sized for 30-minute
  calls, so long jobs were redelivered and re-run; Theo's root cause and fix;
  Farah reported it first) plus an older Sev 2 where the realtime gateway
  saturated one vCPU near 900 sockets and the team's decision owed on capacity.
- **`#design-reviews`**: real design debates: session token rotation on tenant
  switch (120 s vs 60 s replay window), RED dashboards from span metrics, an
  accessibility contrast fix with numbers.
- **`#general`**: release-train notices, change freezes, an office-hours
  invitation on OTel, a new runbook announced after someone lost a day.
- **`#events`**: tech talks and office hours with technical agendas
  (Flink checkpoint tuning, "how we test a cutover"), the community call.
- **`#random`**: still off-topic, but the off-topic of engineers.
- **DMs**: a PR question, a review request, a postmortem draft.

## What ties it together (checklist for the fixtures)

1. Every agent-run failure names its cause, and a person discusses it.
2. Every new runbook names the day it came from, and a thread mentions it.
3. Every decision reads as an ADR: context, options, the tradeoff, the consequence.
4. In-flight work items on the five arcs carry a brief and acceptance criteria.
5. No copy names this repository, its developer or its account ids.
