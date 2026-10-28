# DE-10 Bedrock cost and quota operations

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-9 (deployed trace rows carry `tenant` and full enrichment). Aligns
with DE-30 (spend ledger), DE-32 (price shape) and DE-50 (fleet alarms);
duplicates none of them.

## Current state (read from the code, 2026-10-27)

Scope split, so this item does not re-solve DE-30: DE-30 meters **runs on
boxes** (bot runs, jobs, box tasks) against initiatives. This item meters
**everything else that calls Bedrock**: the eight agent runtimes and the BFF's
own model calls, by runtime, model and tenant, plus the account's Bedrock
quotas, which the devbox's Claude calls also consume.

- **Agent cost exists per row, not per tenant.** `processTrace` prices agent
  tokens with `estimateCostOrNull` and the judge with `estimateCost`
  (`middleware/src/lib/trace-sink.ts:1095-1129`) into
  `invocation_traces.est_cost_usd / judge_cost_usd / total_cost_usd`.
  `routes/cost.ts` rolls them up by agent and by model (`:171`, `:245`,
  `:397`, `:539`); nothing groups by `tenant`. And deployed rows have no
  tenant: the agent bundle never sends one (`agents/_shared/instrumentation.py:486-535`);
  only the mock path sets it (`providers/agentcore.ts:1252`). DE-9 fixes that.
- **Cost totals inherit sampling.** Unsampled traces are never inserted
  (`trace-sink.ts:1014-1047`), so `SUM(total_cost_usd)` is the sampled spend.
  At the seeded rate 1.0 that is all of it; under the 0.1 fallback it reads
  ten times low. Rows the span projector wins carry no cost at all (DE-9).
- **The BFF's own Bedrock calls are unmetered.** Twelve modules send
  `Converse`/`InvokeModel` directly (`lib/judge.ts`, `canary-judge.ts`,
  `embedding.ts`, `session-titles.ts`, `vision-extractor.ts`,
  `change-reviewer.ts`, `site-survey.ts`, `harness-runner.ts`,
  `providers/doc-linker.ts`, `routes/capabilities.ts`, `routes/canary.ts`,
  `routes/canary-library.ts`); only the judge's cost is recorded, and only
  inside a trace row. Trace embeddings (`embedForTrace`, `:942`) are unpriced.
- **Model choice costs more than the code suggests.** The supervisor defaults
  to Nova Lite (`agents/supervisor/main.py:54`), but the runtime stack sets
  one `MODEL_ID` for every runtime, default Nova Pro
  (`infra/lib/agentcore-runtime-stack.ts:151`, `:448`), so the deployed
  supervisor runs Nova Pro. (DE-3 owns per-agent model config.)
- **Throttle alarm exists, headroom does not.** `OrgIQ-Observability` has
  `<prefix>-bedrock-throttles` (`InvocationThrottles` Sum > 10 over two
  5-minute periods, to `<prefix>-alerts`, `infra/lib/observability-stack.ts:255-268`)
  and a throttles widget (`:130-155`), both with **no `ModelId` dimension**.
  Whether an undimensioned `AWS/Bedrock` series is published is unverified;
  the middleware learned the hard way that AgentCore's is not
  (`providers/cloudwatch.ts:156-170`). Nothing compares token rate to quota.
- **No quota handling anywhere.** No Service Quotas call, no recorded quota
  values, no request runbook (`grep -rn servicequotas infra middleware` is empty).
- **Account budget only.** One AWS Budget at 80/100 % actual, 120 % forecast,
  $200 default (`observability-stack.ts:274-310`, `infra/bin/app.ts:30`).

## Change

1. **Usage line per Bedrock call.** One helper, `lib/bedrock-usage.ts`
   `recordBedrockUsage({ source, modelId, tenant, inputTokens, outputTokens,
   cacheReadTokens?, cacheWriteTokens? })`, called from each of the twelve
   BFF call sites with the response's `usage` block. It writes one JSON line
   (`{"kind":"bedrock-usage",…}`) to stdout, priced with DE-32's widened
   `BedrockPrice` (`costUsd: null` when unpriced, never 0). Agents emit the
   same line from the boto3 Converse patch that already sums tokens
   (`instrumentation.py:250-256`), with `source = runtime name`.
2. **Metrics from the lines, DE-50's pattern.** Metric filters on
   `/ecs/<prefix>-middleware` and on each runtime log group turn the line into
   `OrgIQ/Bedrock` `InputTokens`, `OutputTokens`, `CostUsd`, dimensions
   `Source`, `ModelId`, `Tenant`. Metric filters are free to emit, need no
   `PutMetricData` grant, and survive a dead BFF. Three dimensions with
   bounded values (8 runtimes + ~12 sources, ~4 models, 5 tenants) keep the
   custom-metric count under ~100.
3. **Per-tenant report.** `GET /api/observability/cost/by-tenant` in
   `routes/cost.ts`, `GROUP BY COALESCE(tenant, '(unattributed)')`, with the
   existing `withCost` coverage count and the sampling rate in force, so a
   sampled total says it is sampled. Admin only (`ManageBudgets`).
4. **Quota headroom.** A checked-in `infra/config/bedrock-quotas.json`
   lists, per model id and region, the on-demand TPM and RPM quota values in
   force (filled from the console or `service-quotas list-service-quotas
   --service-code bedrock`; quota codes unverified). `OrgIQ-Observability`
   builds, per listed model, a metric-math alarm on
   `AWS/Bedrock InputTokenCount + OutputTokenCount` per minute against 80 %
   of TPM and `Invocations` against 80 % of RPM (assumes the `ModelId`
   dimension, unverified), plus the throttle alarm per model. A test fails
   when a model in `MODEL_ID`, the devbox allowlist (`devbox-stack.ts:245`)
   or `BEDROCK_PRICING` has no quota entry.
5. **Quota requests as a runbook.** `docs/runbooks/bedrock-quota-request.md`:
   the trigger (the 80 % alarm fires twice in a week, or a load test such as
   the 100-call profile is scheduled), the command, the expected lead time,
   and the update to `bedrock-quotas.json`. Requests are not automated.
6. **Not in this item:** initiative attribution and enforcement (DE-30/34/36),
   Claude prices (DE-32), fleet spend alarms (DE-50).

## Decisions owed

- **Does agent traffic land in DE-30's `spend_entries`?** Proposal: no.
  Agent invocations are not initiative-scoped; they stay in
  `invocation_traces` and the `OrgIQ/Bedrock` metrics, and the release
  manager's view shows them as a separate "platform" line beside initiative
  spend.
- **Tenant budgets.** Proposal: report only for now; add a per-tenant AWS
  Budget or alarm after a month of `OrgIQ/Bedrock CostUsd` data.
- **Alarm thresholds.** Proposal: 80 % of quota sustained 5 minutes; keep the
  existing throttle alarm at > 10 per 5 minutes until per-model data exists.

## Done when

- `cd middleware && npx jest src/lib/__tests__/bedrock-usage.test.ts`: an
  unpriced model writes `costUsd: null`; a priced one matches `estimateCost`.
- A test enumerates every `new ConverseCommand|InvokeModelCommand|ConverseStreamCommand`
  outside `mock/` and fails if the file does not call `recordBedrockUsage`.
- A new `infra/test/observability-stack.test.ts` (none exists) finds the
  `OrgIQ/Bedrock` metric filters, one TPM and one RPM alarm per model in
  `bedrock-quotas.json`, all wired to `<prefix>-alerts`, and fails when a
  model in use has no quota entry.
- `GET /api/observability/cost/by-tenant` under `dev:mock` returns one row per
  tenant in the fixture plus `(unattributed)`, with `withCost` and
  `samplingRate`; `scripts/validate-mock-floor.sh` stays green.
- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_instrumentation`
  asserts one `bedrock-usage` line per Converse call with `Source` and `Tenant`.
