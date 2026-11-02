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
| 3 | DE-33 unknown cost gates | unknown cost routes to approval in SDLC `max_cost`; local runs record unknown, not $0 | done (2026-10-29): unknown cost → approval in SDLC `max_cost`; unknown-only brake trip on dispatch-work only; ledger `provider` column, local jobs write $0 `provider=local` |
| 4 | DE-31 box spend rollup | box `spendUsd` lands in the ledger under its project and owner | done: ledger-backed box spend (`GET /api/devbox/boxes`), `GET /api/me/spend`; mock box `spendUsd` literals removed. Not built: the release manager's per-person view |
| 5 | DE-34 spend holds | reserve the p75 forecast at dispatch against allocation and envelope; settle on finish | done: one `reserveSpend` before dispatch-work, fireBot, the job dispatcher, box tasks and governed runs; settle in the ledger transaction; ceiling insert under an advisory lock |
| 6 | DE-35 mid-run cutoff | a run crossing its reserved ceiling is stopped with a recorded reason | done (2026-10-29): hold = ceiling, metered per frame, top-ups at 80 %, cut at 100 % with a recorded reason; box token backstop |
| 7 | DE-36 hard caps | non-overridable cap per initiative and grant; unreadable budget state fails closed | done (2026-10-29): non-overridable caps per initiative, grant and user before the soft brakes; fail closed in production (`BUDGET_FAIL_CLOSED`); one refusal renderer `lib/spend-refusal.ts` |
| 8 | DE-39 bot-fire allocation brake | cron firings pass the allocation check | done, folded into DE-55 (maintenance reserve): essential bots judged against the reserve, then spill |
| 9 | DE-37 run limits | per-initiative/tenant concurrency, runs/day, $/hour | done: per-initiative/tenant concurrency slots, runs/day, $/hour inside reserveSpend; 429 `run-limit`. Gaps: PR-watch enqueue takes no slot |
| 10 | DE-38 budget periods | sprint-aligned and rolling windows, carry-over rules | done (2026-10-29): one window helper `lib/budget-periods.ts` used by every reader; monthly/quarterly/sprint/rolling; carry-over close rows; every initiative stays monthly until it opts in |
| 11 | DE-50 kill switches and alerts | fleet and initiative pause; threshold/stuck-run/reaper alerts as events (CloudWatch alarm half synth-tested) | done: fleet and initiative pause (423 at every path), metric lines, 50/80/100 % alerts, CloudWatch alarms behind `fleetAlarms`. Gap: no `PauseFleet` Cedar action (ManageBudgets reused) |
| 12 | DE-53 initiative spend report | API plus portal view joining allocation, grants, holds, ledger, forecasts, outcomes | done: `GET /api/spend/report` grouped by initiative/actor/model/source/trigger; budgets page rolls up and drills down through the rails (floor / discretionary / held / projected, fit per open item); includes DE-31's per-person view |
| 13 | DE-40 policy profiles | versioned per-initiative profile (models, task time, lifetime, network mode, org access) read at dispatch | done: versioned profiles per initiative (models, task time, lifetime), box stamp, unlisted model refused (400 `MODEL_NOT_ALLOWED`); IAM limited to `devboxModels` |
| 14 | DE-48 one lifetime model | reaper, task timeout and AgentCore ceilings aligned and profile-driven | done: `lib/devbox-lifetime.ts` holds every ceiling; running boxes reaped only as task overrun; env set in both stacks |
| 15 | DE-42 Cedar box actions | split `ManageDevbox` into shell/task/delivery/policy-edit with initiative attributes | done; reviewed 2026-10-29 (defaults below); portal re-pointed off `ManageDevbox` |
| 16 | DE-43 separation of duties | author cannot decide own change; gated users cannot edit their own gate | done; reviewed 2026-10-29 (defaults below) |
| 17 | DE-46 SDLC policy versioned | defaults as versioned per-initiative policy with an audit trail | done; reviewed 2026-10-29 (defaults below) |
| 18 | DE-47 fleet state across replicas | busy flags, reservations, buffers in Redis/Aurora; leader-elected reaper (local Redis) | done: shared box state, claims, holds and tails in Redis; leader-locked reaper; dev:mock stays single-process |
| 19 | DE-45 credentials out of shell | token never in a command string on the BFF side; per-run token provider interface (GitHub App half needs the image) | done locally: token provider interface (`github-app`, `pat`, `local`), audit rows, token only in the git child env; real runtime path off until the image rebuild (`docs/github-app-tokens-runbook.md`) |
| 20 | DE-28 bug-class lint | lint for partial secret ARNs, uuid binds as text, second CommonJS editor stack | done |
| 21 | DE-20 schema migrations | migration ledger with dry-run, tested against local Postgres | done |
| 22 | DE-3 model registry | central versioned model config read by agents and BFF, env fallback | done (pricing.ts `us.` normalisation landed with row 2: `lib/__tests__/pricing.test.ts`) |
| 23 | DE-4 prompt promotion | alias-based prompt reads and promotion through canary/eval (code + synth) | done except: the BFF gate is structural (no golden runner), `harness.ts` still keys promoted_at by sha |
| 24 | DE-7 MCP tool registry | gateway tools from a manifest; synth tests | done (synth); `gateway_tools.py` not wired into an agent until the cloud check |
| 25 | DE-8 memory config | per-tenant memory strategies and retention from config; synth tests | done (infra half); middleware actor-id step already shipped in deploy-hardening row 1 |
| 26 | DE-17 parameterised environments | account/region/prefix/domain as config; synth tests for a second environment | done (infra); scripts outside infra/ (aws-env.mjs, agents build scripts, dump-stack-outputs.sh) still hard-code names |
| 27 | DE-14 deploy orchestrator | one resumable command with recorded state, tested with a fake `aws`/`cdk` | done: `scripts/deploy/orchestrate.mjs` (plan/apply, recorded state, SSM lock), fake-aws tests |
| 29 | DE-54 user budgets (new spec) | per-user allocation and cap, third lock in reserveSpend, `GET /api/me/spend` budget | done (2026-10-29) |
| 30 | DE-55 maintenance reserve (new spec, folds DE-39) | reserve column, `bots.essential`, discretionary remainder on every brake | done (2026-10-29) |
| 28 | DE-29 tenant manifest | one manifest drives TENANTS, Cedar seeds, routers and CDK | done: `tenants/manifest.json` → generated TS (`scripts/gen-tenants.mjs`, `--check`) + drift check `scripts/check-tenant-manifest.mjs`; five tenants unchanged |

## Decisions taken by default

Confirm or change each; every one is a config flag or a small edit.

- **DE-38 periods** — carry-over `none` by default (overspend/underspend
  opt-in, optional cap); between sprints an initiative is unbudgeted (hard
  cap still applies in production); one active sprint per initiative; a
  policy change mid-period forfeits that period's carry; org totals and user
  budgets stay calendar month.
- **DE-29 tenants** — generated TypeScript from the manifest (not runtime
  JSON); role labels stay in `role-registry.ts`; the seed loader throws at
  boot for a manifest role with no Cedar file; AuthzLog gains an `access`
  filter (the spec called its absence a bug).
- **DE-35/37/50 run controls** — `RUN_CUTOFF` on, 2 top-ups max, 30 s
  grace; the box's token backstop is hold × 3 at the output rate (cache-heavy
  runs cut there first). Run limits are hard 429s, none seeded,
  `BOT_MAX_CONCURRENT` kept as the global ceiling. **Auto-pause at 100 % is
  off** (`BUDGET_AUTO_PAUSE`) — your call. Spend-rate alarm $10 / 15 min;
  pause bells go to org-leaders only; initiative pause needs ManageBudgets +
  stewardship, fleet pause an org-wide role.
- **DE-53 spend report** — projection always to month end; fit ordered by
  priority then age; Runs and Updated-by columns and the two breakdown cards
  were replaced by the group selector. Until `SPEND_LEDGER=ledger` the
  drill-in's ledger spend includes box tasks the allocation's "spent" omits.
- **BFF metering** — 11 middleware Bedrock call sites write `bff_call`
  entries (unattributed; prompt-ARN models unpriced). Decks/summaries reach
  models another way and are not metered yet.
- **DE-54/36/55 (user budgets, hard caps, reserve)** — no user row =
  unbraked, shown as a blind spot; user budget applies on top of envelopes;
  cron never charges a user; nobody sets their own budget. Hard cap default =
  allocation × 1.25 (`BUDGET_HARD_CAP_FACTOR`, `off` keeps explicit caps
  only); `UNBUDGETED_HARD_CAP_USD` $25 in production; cron at a cap skips.
  `BUDGET_FAIL_CLOSED` on in production (also turns on
  `SPEND_HOLDS_FAIL_CLOSED`) — the schema must reach Aurora before the BFF
  (deploy.sh's migrate step does this). Auto reserve = last month's essential
  spend × 1.1 (`MAINTENANCE_RESERVE_FACTOR`), spill on, `MAINTENANCE_RESERVE=off`
  restores the old arithmetic; PR-watch bots not essential; ManageBudgets marks
  bots essential. Seed: u-nora has a $25 user budget offline.
- **DE-47** — a deploy without Redis now runs one middleware task (it scaled
  1–4 and could double-reap); `middlewareAutoscale=true` without Redis fails
  synth. Cross-replica tails use Redis pub/sub; claims live in Redis, Aurora
  stays the startup mirror. A non-leader replica's `GET /boxes` can lag ~10 s.
- **Dispatch UI (approved component)** — "Request budget" files a
  `sprint-envelope` access request (`POST /api/access-requests/envelope`):
  standing duration, amount = forecast p75 (disabled with no forecast),
  approver = the allocation's last editor when they can decide in Access, else
  org-leaders; the last approval creates the grant via the `POST /api/grants`
  path. "Save for later" stores one job setup per work item. The message names
  "the budget holder" (the page has no reliable name).
- **DE-33/34 money** — an unknown-cost run trips the soft brakes only on
  dispatch-work (where the deck confirms); box tasks, the agent loop, manual
  runs, cron and jobs still take holds and refuse real over-allocation. An
  unknown-cost hold stays open until expiry. Manual bot runs are now judged
  like a dispatch (portal shows the refusal; no "run anyway" yet). Cron holds
  money but is judged only with `enforceAllocation`. A task into a box a
  governed run already holds is held, never refused. Demo envelope $0.70 →
  $0.95. Kill switches: `SPEND_HOLDS=off`, `SPEND_HOLDS_FAIL_CLOSED=1`,
  `SPEND_HOLDS_UNATTRIBUTED=refuse`.
- **DE-40/48** — profile edits need `ManageBudgets` + an org-wide role;
  assigning needs `ManageBudgets` + stewardship. An unknown or unlisted model
  routes an SDLC change to approval. **Behaviour change:** bots and
  dispatches on Nova models are now refused up front on the real devbox path
  (they used to run silently on the default Claude model).
- **DE-45** — `pat` stays the default provider until a GitHub App is
  configured (`--context githubAppSecretArn=<complete ARN>`, `devboxGitEntrypoint=true`
  after the image rebuild).
- **DE-4** — candidate weight 10; promote/rollback gated `ManageCanary`.
- **DE-42/43/46 authz** (reviewed 2026-10-29; full review in the commit
  message): authors never decide their own change; nobody edits rules that
  gate changes they caused (admin `override` skips both, now audited).
  `EditSdlcPolicy` is hr-admin and admin only (sme lost policy editing).
  hr-admin keeps shell and task (spec proposed removing them);
  program-owner and org-leader did not get decide/deliver (spec proposed
  adding them) — so unattributed changes are approvable in practice only by
  hr-admin/admin, governance-code changes only by admin. Two-person rule on
  for loosening edits (`SDLC_POLICY_TWO_PERSON=off`). Governance-path hits
  need `org-leader,admin` approval (`require_approval`, not `block`).
  **Open gap:** the portal still gates on `ManageDevbox` (65 sites), so an
  SME sees the policy editor and gets 403 on save — needs a portal lane.
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

**Latest document and people follow-up (2026-11-01):** see
[the UI handoff and technical-debt ledger](ui-document-reading-2026-11-01.md)
for the embedded contents/document work, section controls, compact initiative
Details and photo propagation. All 71 seeded identities now have portraits.
It records the remaining code-diff/keyboard-focus audit issues, deployed avatar
backfill and name-only team/design contracts. Keep those debts open;
this follow-up does not renew the whole journey acceptance or deploy to AWS.


**Local journey goal complete (2026-11-01):** all 160 target maps have complete,
passing, sealed and fresh logs: Pipelines 55, Social 48, Assessment 57. The four Social activity
maps are unblocked through disposable clone DM/inbox isolation. Assessment's
cursor stretch proof is renewed; its older chat/call/edit history is preserved
separately, not claimed as renewed. Access was already re-walked and sealed
(`b9507421`). All 364 maps validate and all 49 runner tests pass.

That journey acceptance used shared UI 2.486.3. The earlier targeted batch fixed an
Artifacts long-title overflow (`3e8dd398`). The broader follow-up renewed 15
Pipelines walks after its Configuration readiness assertions changed. Final
rail, layout and typography measurements pass, and all three tenant judges pass with
`--quick --no-time`. See [the continuation report](journeys/continuation-2026-10-31.md)
for the scope, validation and retained failure evidence. Never weaken an
expectation or seal a failed/incomplete walk to clear the judge.

**Broader UI/audit follow-ups complete (2026-11-01):** prompt dialogues show
numbered answers directly and a plain input only for manual answers. Brief
preview opens the right pane. Today moves between the header and footer by
dragging or keyboard, with placement saved on this device. The owner components
and Storybook are updated. All 77 strict Work/Brief/Configuration audit cases,
14 app interaction checks and five Storybook checks pass. The continuation
report records the full scope and retained failed attempts.

**Latest layout refinement (2026-11-01):** shared UI is now 2.488.0. The Work
rail has a compact header, smaller indicators and a saved adjustable width.
Brief preview is a dedicated wider document pane with a toggle; narrow screens
give it the available column. Designs uses one navigation rail and plain thread
sections. Decisions and Initiatives share rail width and content insets. The
Chat/Agent mode menu no longer contains formatting commands. Owner components,
Storybook and the packed application are updated. All 134 targeted strict deep
cases pass; see [the refinement evidence](journeys/layout-refinement-2026-11-01.json)
and the continuation report for interaction checks and retained failures.
This UI revision did not renew all 160 journey logs against its new source digest;
the full journey acceptance above belongs to the earlier checkpoint.

The budget defaults under "Decisions taken by default" and the deploy-machine
items below remain open. No cloud rollout was performed by these local goals.

**Follow-ups (2026-10-29): done** — PR-watch takes a hold/slot; the spend
metric fires for SQL settles; `GET /api/harness/promoted-versions` reports
the live prompt pointers; deck/summary model calls run inside AgentCore
runtimes (no BFF usage to meter; their traces carry tokens); the budgets
page labels the period and "between sprints". The local journey goal is closed above.

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
