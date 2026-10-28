# DE-26 Idle cost controls: a schedule, a per-environment budget, an hourly burn

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Pairs with DE-27 (the burn inventory and the teardown sweep share one resource
list) and DE-17 (an environment name to tag and budget by).

## Current state (read from the code, 2026-10-27)

The backlog line is right, but two of the cost facts it leans on are stale.

- **There is no OpenSearch Serverless any more.** CLAUDE.md said "OpenSearch
  Serverless 2 OCU" (corrected 2026-10-27) and listed `OrgIQ-KnowledgeBase` as "OpenSearch Serverless +
  Bedrock KB". The KB stack replaced it with Aurora pgvector
  (`infra/lib/knowledge-base-stack.ts:18-22`, `storageConfiguration.type: 'RDS'`
  at `:269-283`), and nothing in `infra/lib` creates an `aoss` collection.
  `destroy.sh:726-730` and `:840` still sweep for and warn about one; that is
  harmless but stale.
- **Aurora is the one pausable floor, and it never idles while the BFF runs.**
  Min 0.5 / max 4 ACU, no auto-pause (`infra/lib/aurora-stack.ts:111-112`).
  CLAUDE.md's ~$45/mo is the right order (0.5 ACU around the clock).
  `infra/scripts/idle.sh` stops the cluster by hand but prints "~$0.30/day"
  (`idle.sh:5`, `:74`, `:101`), about five times too low (0.5 ACU at list price is
  about $1.44/day; unverified against the bill). The middleware polls Aurora
  every 5 s (`middleware/src/lib/assessment-dispatcher.ts:95`) plus the job
  dispatcher, bot scheduler, PR-watch and canary pollers, so auto-pause cannot
  happen until the middleware is at zero.
- **`idle.sh` touches only Aurora.** It claims everything else is pay-per-use
  or cents (`idle.sh:6-11`). That was true before the Social and document
  stacks. Always-on lines today:

| Resource | Where | Pausable? | Approx. $/mo (list price, unverified) |
|---|---|---|---|
| Aurora writer 0.5 ACU | `aurora-stack.ts:111` | stop (7-day auto-restart) or auto-pause | 44 |
| NAT gateway ×1 | `middleware-service-stack.ts:207` | no (remove only) | 33 + data |
| Middleware ALB | `middleware-service-stack.ts` | no | 16 |
| Middleware task 1 vCPU / 2 GB ARM | `:1062-1063` | desiredCount 0 | 29 |
| platform-api 0.5 / 1 GB | `social-stack.ts:469-470` | desiredCount 0 | 14 |
| Document workspace: 4 × 0.5/1 GB + Redis 0.25/0.5 GB, EFS | realtime-examples-cdk `document-workspace-services.js:84`, `redis-service.js:26-36` | desiredCount 0 | about 65 |
| ElastiCache `cache.t4g.micro` | `social-stack.ts:304` | no | 12 |
| SFU `t4g.small` + EIP + gp3 | `social-media-stack.ts:165` | stop instance (EIP still bills) | 17 |
| Public IPv4, Secrets, logs, CloudFront | various | no | under 15 |

  That is an idle floor of roughly $240/mo (about $0.33/hr) before any Bedrock
  or AgentCore usage, against a default budget of $200/mo.
- **The budget is account-wide, not per environment.** `OrgIQ-Observability`
  creates one `CfnBudget` of `monthlyBudgetUsd` (default 200,
  `infra/bin/app.ts:30`; `observability-stack.ts:274-310`) with no cost
  filter, so it measures the whole account. It notifies only when `alertEmail`
  is set (`:281`). No stack applies a tag (`grep -n "Tags.of" infra/` finds
  nothing), so there is nothing to filter by.
- **No burn estimate exists.** The user-level `/cost-aws` command reads Cost
  Explorer, which lags by about a day and cannot say what is billing now.

## Change

1. **One environment tag.** `cdk.Tags.of(app).add('orgiq:env', envName)` in
   `infra/bin/app.ts`, with `envName` from `--context envName` (default
   `PREFIX`). Activating it as a cost-allocation tag is a one-time console or
   `ce update-cost-allocation-tags-status` step, recorded in the runbook.
2. **Per-environment budget.** The existing `CfnBudget` gains
   `costFilters: { TagKeyValue: ['user:orgiq:env$<envName>'] }` and is named
   `${prefix}-${envName}-monthly-budget`. Keep the account-wide budget as an
   opt-in (`accountBudgetUsd`), since this account is shared.
3. **A scheduled sleep, off by default.** `--context idleSchedule='{"sleep":"cron(0 1 ? * MON-FRI *)","wake":"cron(0 12 ? * MON-FRI *)"}'`
   adds an `OrgIQ-IdleSchedule` stack with EventBridge Scheduler universal
   targets: ECS `UpdateService desiredCount=0/1` for the middleware,
   platform-api and the document services; `ec2:StopInstances` /
   `StartInstances` for the SFU (the host's loopback Redis holds nothing that
   outlives a call); `rds:StopDBCluster` / `StartDBCluster` after the services
   are down. Scheduler, not Application Auto Scaling scheduled actions,
   because `realtime-capacity.test.ts:45` asserts no `ScalableTarget` while the
   gateway is on, and the one-task safeguard (DE-25) must stay intact. A
   deploy resets desiredCount to 1, which is the intended "a deploy wakes it".
4. **Aurora auto-pause as an alternative to stop.** CDK 2.270 supports
   `serverlessV2MinCapacity: 0` with `serverlessV2AutoPauseDuration`
   (`infra/node_modules/aws-cdk-lib/aws-rds/lib/cluster.d.ts`). Engine support
   for 16.13 is unverified. The first Data API call after a pause hits the
   cold-start path `schema/load_schema.py:12-28` already retries; the
   middleware's own Data API client needs the same transient retry first.
5. **`infra/scripts/burn.sh`** lists live resources through describe APIs
   (ECS running counts and task sizes, RDS ACU and status, NAT, ALB, EC2,
   ElastiCache, EIPs) and multiplies by a checked-in price table
   `infra/pricing/us-east-1.json` (dated, each row citing the AWS price page).
   It prints $/hr now and the projected month, and exits non-zero on a
   credential or API error rather than printing $0. `idle.sh` gains
   `down`/`up` for the services and SFU, and its Aurora estimate comes from
   the same table.

## Decisions owed

- **Sleep hours and which environments get them.** Proposal: on for every
  environment except one named "demo", 01:00 to 12:00 UTC weekdays plus all
  weekend; the operator wakes it with `idle.sh up`.
- **Stop vs auto-pause for Aurora.** Proposal: auto-pause with a 30-minute
  delay once the BFF's Data API retry exists, since a stopped cluster restarts
  itself after seven days and the scheduler has to keep re-stopping it.
- **The NAT gateway.** It is the largest line nothing can pause. Proposal: keep
  it, and record it as the floor in the price table; VPC endpoints instead of
  NAT is a larger, separate change.

## Done when

- `cd infra && npm test` passes with new cases: every stack in `synthApp()`
  carries `orgiq:env`; the budget has the tag filter; `idleSchedule` absent
  creates no scheduler resources; present, it creates schedules targeting the
  three ECS services, the SFU instance and the cluster, and still no
  `ScalableTarget` with `realtimeGateway=true`.
- `bash infra/scripts/burn.sh --fixtures infra/test/fixtures/burn/` (recorded
  describe outputs, no AWS) prints a total within 1 % of the hand sum in the
  fixture's README, and a fixture with an `ExpiredToken` error exits non-zero.
- `grep -n "0.30/day" infra/scripts/idle.sh` finds nothing.
- CLAUDE.md's cost line and stack table no longer mention OpenSearch
  Serverless (validators grep CLAUDE.md for other strings, not this one).
