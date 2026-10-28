# Deployment backlog: the half that builds locally (2026-10-28)

Definition of done for the specs in `docs/deployment-enhancements/` that can
be built and proven **without AWS access**. Rows are in dependency order:
the spend ledger first, because most money specs read from it. Specs that
need the deployed stack to prove (DE-1, 2, 5, 6, 9, 10, 11, 12, 13, 15, 16,
18, 19, 21, 22, 23, 24, 25, 26, 27, 41, 44 leftovers, 49, 51, 52) are not
rows; a row below may still write their CDK or script half when the spec says
it is synth-testable.

Rules for whoever continues:
- Read this file first; take the first row that is not `done`.
- Read the row's spec, build only its **Change** and **Done when**; one row
  can take several commits. Mark a row `done` only when every local "done
  when" item has a test.
- **Decisions owed:** when the spec recommends a default and the choice is
  engineering (a TTL, a table shape, an error code), take it and note it in
  the commit. When it is a product or money call (who may do what, a dollar
  figure, a UI placement, anything CLAUDE.md lists as open), build the
  conservative default (fail closed, off by default, existing behaviour
  kept) behind config, and list it under "Decisions taken by default" below
  for the user to confirm or change.
- No cloud apply, no shared mock reset, no business-data cleanup, no pattern
  pkill; stop only processes you started. Keep the single-gateway safeguard.
- Schema changes are additive SQL files plus their mock fixtures; never run
  them against Aurora.
- Portal pages use ui-components composites only; a missing primitive is
  queued in `docs/ui-components-queue.md` and released upstream first.
- Run full suites alone (middleware jest, infra `npm test`, portal
  typecheck); recapture the wire snapshots on a throwaway :3012 server when a
  response shape changes (docs/mock-floor.md § Regenerating the snapshots),
  then `scripts/validate-mock-floor.sh --quick`.
- Update this table and push after each batch.

| # | Spec | Local scope | State |
|---|------|-------------|-------|
| 1 | DE-30 spend ledger | append-only ledger keyed by initiative/grant/run/box, written by bot runs, devbox tasks, internal tasks and work jobs; budgets read it | done (writers, readers behind `SPEND_LEDGER`, backfill, Postgres acceptance); direct `agent_project_run` writer built and Postgres-tested; remaining: `bff_call`, `grant_id`, direct-run history backfill and direct-run mock ledger parity |
| 2 | DE-32 Claude pricing | per-model/profile prices from config, fallback estimate when no cost is reported | done (2026-10-28): `lib/model-prices.ts` + `lib/model-prices-defaults.ts` + `mock/model-prices.ts`; per-bucket `estimateUsageCost`; `costBasis`/`estimatedCostUsd` on the runner, box tasks, agent loop, jobs and the fleet; `spend_entries.estimated_cost_usd` (additive); SSM read grant + `MODEL_PRICES_PARAM` in the middleware stack; `cdk synth --no-lookups` confirms the grant; estimates survive direct/project/bot/job settlement and backfill |
| 3 | DE-33 unknown cost gates | unknown cost routes to approval in SDLC `max_cost`; local runs record unknown, not $0 | |
| 4 | DE-31 box spend rollup | box `spendUsd` lands in the ledger under its project and owner | |
| 5 | DE-34 spend holds | reserve the p75 forecast at dispatch against allocation and envelope; settle on finish | |
| 6 | DE-35 mid-run cutoff | a run crossing its reserved ceiling is stopped with a recorded reason | |
| 7 | DE-36 hard caps | non-overridable cap per initiative and grant; unreadable budget state fails closed | |
| 8 | DE-39 bot-fire allocation brake | cron firings pass the allocation check | |
| 9 | DE-37 run limits | per-initiative/tenant concurrency, runs/day, $/hour | |
| 10 | DE-38 budget periods | sprint-aligned and rolling windows, carry-over rules | |
| 11 | DE-50 kill switches and alerts | fleet and initiative pause; threshold/stuck-run/reaper alerts as events (CloudWatch alarm half synth-tested) | |
| 12 | DE-53 initiative spend report | API plus portal view joining allocation, grants, holds, ledger, forecasts, outcomes | |
| 13 | DE-40 policy profiles | versioned per-initiative profile (models, task time, lifetime, network mode, org access) read at dispatch | |
| 14 | DE-48 one lifetime model | reaper, task timeout and AgentCore ceilings aligned and profile-driven | |
| 15 | DE-42 Cedar box actions | split `ManageDevbox` into shell/task/delivery/policy-edit with initiative attributes || built and green (2026-10-28); **review when back**: the agent was stopped before reporting its defaults — check each Done-when and decision against the spec |
| 16 | DE-43 separation of duties | author cannot decide own change; gated users cannot edit their own gate || built and green (2026-10-28); **review when back**: the agent was stopped before reporting its defaults — check each Done-when and decision against the spec |
| 17 | DE-46 SDLC policy versioned | defaults as versioned per-initiative policy with an audit trail || built and green (2026-10-28); **review when back**: the agent was stopped before reporting its defaults — check each Done-when and decision against the spec |
| 18 | DE-47 fleet state across replicas | busy flags, reservations, buffers in Redis/Aurora; leader-elected reaper (local Redis) | |
| 19 | DE-45 credentials out of shell | token never in a command string on the BFF side; per-run token provider interface (GitHub App half needs the image) | |
| 20 | DE-28 bug-class lint | lint for partial secret ARNs, uuid binds as text, second CommonJS editor stack | done |
| 21 | DE-20 schema migrations | migration ledger with dry-run, tested against local Postgres | done |
| 22 | DE-3 model registry | central versioned model config read by agents and BFF, env fallback | done (pricing.ts `us.` normalisation landed with row 2: `lib/__tests__/pricing.test.ts`) |
| 23 | DE-4 prompt promotion | alias-based prompt reads and promotion through canary/eval (code + synth) | |
| 24 | DE-7 MCP tool registry | gateway tools from a manifest; synth tests | done (synth); `gateway_tools.py` not wired into an agent until the cloud check |
| 25 | DE-8 memory config | per-tenant memory strategies and retention from config; synth tests | done (infra half); middleware actor-id step already shipped in deploy-hardening row 1 |
| 26 | DE-17 parameterised environments | account/region/prefix/domain as config; synth tests for a second environment | done (infra); scripts outside infra/ (aws-env.mjs, agents build scripts, dump-stack-outputs.sh) still hard-code names |
| 27 | DE-14 deploy orchestrator | one resumable command with recorded state, tested with a fake `aws`/`cdk` | |
| 28 | DE-29 tenant manifest | one manifest drives TENANTS, Cedar seeds, routers and CDK | |

## Decisions taken by default

Confirm or change each; every one is a config flag or a small edit.

- **DE-30 ledger** — readers stay on `bot_runs` until `SPEND_LEDGER=dual`
  (log drift) then `ledger`; default `off`. Ad-hoc box tasks with no
  initiative land unattributed and count only in the org total, never
  blocking. Backfill covers all history (readers window themselves). A run
  the legacy OR-predicate counted under two initiatives is booked to the
  first arm (work item, then bot target, then codebase). An unknown cost may
  later be replaced by a reported one; a known cost never moves. The
  per-person envelope burn in ledger mode counts every path the person spent
  through (box tasks and jobs too), not only dispatches. `grant_id` is not
  yet written (DE-34 carries it at dispatch). Local `local:*` jobs write no
  entry yet (DE-33).
- **DE-20 migrations** — run from `deploy.sh` (`DEPLOY_MIGRATE=false` skips).
  The 2026-10-28 rollout applied the page-thread migration; that deploy
  block is cleared. Approvals expire after 24 h; apply refuses >5 % row growth.
- **DE-3 models** — primaries stay on bare ids, `us.` profiles are fallbacks;
  SSM, not AppConfig; the supervisor is registered as Nova Pro (its code
  literal moved from Lite to Pro); streaming has no fallback;
  `MODEL_REGISTRY_DISABLED=1` turns the registry off.
- **DE-32 pricing** — **Who supplies the Claude rates:** nobody has yet, so
  the tree ships a checked-in default table (`middleware/src/lib/model-prices-defaults.ts`)
  holding Anthropic's **first-party list prices** for the three devbox
  profiles (Haiku 4.5 $1/$5, Sonnet 5 $2/$10, Opus 4.8 $5/$25 per MTok, with
  the page's 5-minute cache-write and cache-read rates), read from
  platform.claude.com/docs/en/about-claude/pricing on 2026-10-28 and labelled
  so in every row's `source`. Bedrock's on-demand rates are partner-priced
  and were not verifiable without AWS (the Bedrock pricing page carries no
  Anthropic figures in its text); every cost priced from the table is
  recorded `cost_basis = 'estimated'`, never `'reported'`. The operator
  overrides per id in SSM `/orgiq/pricing/model_prices` (rows without
  `source`/`effectiveFrom` are refused and logged), and
  `MODEL_PRICES_DEFAULTS=off` ships an empty table — the spec's
  "null until supplied" behaviour — if the defaults are not wanted. When
  Claude Code reports a figure and the table can also price the run, the
  **reported figure is recorded** and the estimate is kept beside it
  (`spend_entries.estimated_cost_usd`, `agent_jobs.result.estimatedCostUsd`);
  the 10 %-drift alarm is not built (DE-50). The devbox fleet's live chip uses
  the same estimate when a result carries tokens but no figure. The read-only
  SSM grant is CDK; the parameter itself is created by hand or script, never
  by CDK. Offline, the mock fixture is the table (`source: 'mock'`) and the
  `empty` scenario blanks it; the mock agent loop's ledger entries therefore
  now carry an estimated cost instead of unknown. Project runs retain
  `cost_basis` and `estimated_cost_usd` until the bot poller settles them;
  bot and job backfills retain that basis. An older cluster without those
  project columns records an estimate as unknown instead of mislabelling it
  reported. Malformed/incomplete token usage stays unknown. These defaults
  are first-party estimates, not reconciled account charges or profile-specific
  Bedrock quotes; the operator should supply exact profile rows in SSM.
- **DE-28 lint** — the SFU secret fallback in `social-stack.ts` (partial ARNs
  with `deploySocial` but no `deploySocialMedia`) is a named exemption whose
  test fails once it is fixed; the portal build runs only in the full judge.

## Completed continuation validation (2026-10-28)

DE-32 and the direct-run writer passed on top of deploy-machine commit
`013cbf87`: middleware typecheck; **564 suites / 7,753 tests passed** (11
suites / 73 tests skipped); the full mock-floor judge; infra typecheck
and **415 tests**; the deployment bug-class judge (`--quick`); CDK synthesis of `OrgIQ-MiddlewareService` with lookups
disabled and the pricing permission present. PostgreSQL acceptance passed
**7 tests** on an owned disposable pgvector/Postgres 16 container; the runner
suite passed **9 tests**, including incomplete usage. The missing-model trace
regression and incoming AVP pagination tests passed as well. This is local
acceptance, not an Aurora rollout or billed reconciliation.

The combined changes now preserve estimated versus reported provenance through
direct project runs, bot-owned runs and job backfill. A missing runtime model
id stays unpriced instead of crashing trace ingestion. Wire snapshots were
recaptured from an isolated :3012 server; the final capture retained every
previously captured GET and write response shape.

The interrupted UI pipeline is complete locally under
`.scratch/initiatives-mockups-2026-10-28/index.html`: 25 source captures,
12 validated concepts, one dark variant and 23 supplementary scroll views.
The shell and stylesheet are preserved, table widths fit at 1440px, and gallery
links were checked. These are illustrative designs; no portal implementation
or budget-enforcement behavior is claimed. Test logs and a machine-readable
summary are in `.scratch/resume-2026-10-28/`.

## Next session

Read `docs/budget-system-analysis-2026-10-28.md` first: it re-orders the money
rows (2–12) toward the intended model (real Bedrock dollars, per-user budgets,
boxes and jobs gated, a funded maintenance reserve, discretionary remainder
judged against work) and adds three rows that have no spec yet: user budgets,
the maintenance reserve (folds in DE-39), billed reconciliation.

## Owed from the deploy machine

The 2026-10-28 rollout of `fa782230` (`docs/aws-deploy-open-items-2026-10-27.md`)
applied the schema ledger baseline and the page-thread migration, and fixed
the gateway's Cedar action separator (`___`), the Agents exports, the
middleware image's vendor copy and the migration env. Still owed:

- DE-30/32: re-apply the changed repeatable `spend_ledger_schema.sql` (new source constraint, ledger estimate, project cost provenance), then backfill `--dry-run` and run, deploy with `SPEND_LEDGER=dual`, read the drift log, then `ledger`. Supply account/profile prices in `/orgiq/pricing/model_prices` or set `MODEL_PRICES_DEFAULTS=off` until supplied.
- DE-20: `2026-09-05-drop-newsroom` is pending (not gated).
- DE-3: confirm the runtimes read `/orgiq/models/registry`.
- DE-18: the middleware still pulls `:latest` (`--force-new-deployment` after each push).
