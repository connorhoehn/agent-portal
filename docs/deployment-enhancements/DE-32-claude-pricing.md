# DE-32 Claude prices in the pricing table

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Feeds DE-30's `cost_basis = 'estimated'`; independent of DE-31 and DE-33.

## Current state (read from the code, 2026-10-27)

`BEDROCK_PRICING` holds four Nova/Titan rates, per 1K tokens, input and output
only (`middleware/src/lib/pricing.ts:14-24`). Claude is left out on purpose,
and the file says why: Bedrock's Anthropic rates are not in the Price List API,
and an invented number "would be worse than the null" (`pricing.ts:73-80`).
The backlog line is accurate about traces, but it understates the gaps:

- **Traces.** The one table consumer for agent spend is `trace-sink.ts:1101-1118`,
  which calls `estimateCostOrNull` with the supplied model id. A devbox model
  (`us.anthropic.claude-haiku-4-5-20251001-v1:0` default, plus Sonnet 5 and
  Opus 4.8 on the allowlist, `infra/lib/devbox-stack.ts:100,245`) prices to
  `null`.
- **Runs never consult the table.** Box tasks, bot runs and jobs record Claude
  Code's own `total_cost_usd` (`lib/devbox-runner.ts:203`,
  `lib/devbox-fleet.ts:555`). When it is absent the cost is `null` and nothing
  estimates it. `devbox-runner.ts` does not read the `usage` block at all;
  only the fleet does (`devbox-fleet.ts:454-479`).
- **The shape cannot price Claude Code.** Its usage carries
  `cache_creation_input_tokens` and `cache_read_input_tokens`
  (`devbox-fleet.ts:470-473`), and cache reads dominate a multi-turn run.
  Pricing them at the input rate would overcharge many times over;
  `BedrockPrice` has no slot for either.
- **Ids don't match one key.** The runtime sends inference-profile ids
  (`us.` prefix); the mock fleet uses bare `claude-sonnet-5`
  (`mock/devbox-fleet.ts:110`).
- **The reported figure is Claude Code's own price list.** That is the same
  table that produced the loopback "confident lie" (`lib/run-cost.ts:20-30`).
  On Bedrock it is probably close to the Bedrock rate, but nothing checks that.

## Change

1. **Price shape.** In `pricing.ts`, widen `BedrockPrice` to
   `{ input, output, cacheWrite?, cacheRead?, source?, effectiveFrom? }`
   (USD per 1K). Nova/Titan stay in code unchanged.
2. **Claude rates from config, not code.** A new `lib/model-prices.ts` reads SSM
   `/orgiq/pricing/model_prices` (JSON map of model id to price, each entry
   required to carry `source` and `effectiveFrom`). It uses the
   `lib/judge-config.ts` read-through pattern: a 5-minute TTL, with the mock
   fixture `mock/model-prices.ts` read offline. It exposes a **synchronous**
   `priceFor(modelId)` over the last snapshot, because the trace path calls the
   estimator synchronously. A refresh is kicked at boot and on TTL expiry. An
   entry without `source` is rejected and logged, not loaded.
3. **One id rule.** `normalizeModelId(id)` tries an exact match first. If that
   misses, it strips a geo/global profile prefix (`us.`, `eu.`, `apac.`,
   `global.`) and tries again. The mock fixture keys its prices by the same ids
   the mock fleet uses.
4. **`estimateUsageCost(modelId, usage)`** prices input, output, cache write and
   cache read separately. It returns `null` when the model or any rate a
   non-zero bucket needs is missing, so there is never a partial price.
   `estimateCostOrNull` delegates to it; `trace-sink.ts` swaps in `priceFor`.
5. **Fallback when Claude Code reports no cost.** `devbox-runner.ts` keeps the
   `result` event's `usage` and the run's model (the `model` on `devbox_start`,
   `agents/devbox/main.py:189`). When `parseReportedCost` is `null`, it sets
   `outcome.costUsd = estimateUsageCost(...)` and
   `outcome.costBasis = 'estimated'`; otherwise `'reported'` (or `'unknown'`
   when both are null). DE-30's writers pass `costBasis` straight through. The
   fleet's live figure does the same. Local runs are untouched: their cost is
   decided by the route (`routes/local-compute.ts:668-669`).
6. **Drift check.** When both a reported figure and an estimate exist, record
   the estimate beside it (`agent_jobs.result.estimatedCostUsd`, and a
   `estimated_cost_usd` column on `spend_entries`, additive) so a gap between
   Claude Code's price list and the Bedrock rate can be selected.
7. **Infra.** Extend the middleware task role's SSM grant
   (`infra/lib/middleware-service-stack.ts:607-616`, today scoped to
   `parameter/orgiq/canary/*`) with `GetParameter` on
   `parameter/orgiq/pricing/*`. The parameter is created by hand or by a
   script, not by CDK, so a redeploy cannot overwrite the rates.

**Mock floor:** price rows are configuration, not aggregates. The fixture lists
one entry per mock model with `source: 'mock'` and is registered so a scenario
can blank it to exercise the `null` path.

## Decisions owed

- Who supplies the Claude rates, and from where? Proposal: the operator copies
  the Bedrock console's on-demand rates for the three allowlisted profiles
  (including any geo-profile premium) into the parameter, with the console URL
  and date as `source`. Until then the table stays empty and costs stay `null`.
- When Claude Code reports a figure and the table can also price the run,
  which is recorded? Proposal: the reported figure. Keep the estimate beside it
  and alarm when they drift by more than 10% over a week.

## Done when

- `lib/__tests__/model-prices.test.ts`:
  - a `us.` profile id resolves to its bare entry
  - cache-read tokens are priced at `cacheRead`, not `input`
  - a model with no entry, or an entry missing a rate a non-zero bucket needs,
    returns `null`
  - an entry without `source` is refused
- The trace-sink test: a `us.anthropic.*` trace with a seeded price stores a
  non-null `cost_usd`, and with the fixture blanked stores `null`.
- `devbox-runner` test: a `result` with usage but no `total_cost_usd` yields
  `costBasis: 'estimated'` with the expected figure; one with neither yields
  `'unknown'` and `null`.
- `grep -nE "claude.*[0-9]\.[0-9]{3}" middleware/src/lib/pricing.ts` returns
  nothing, because no Claude rate is hard-coded.
- `cd infra && npx cdk synth OrgIQ-MiddlewareService` shows the
  `parameter/orgiq/pricing/*` grant.
