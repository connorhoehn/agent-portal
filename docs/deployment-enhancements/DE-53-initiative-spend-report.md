# DE-53 Spend and run reporting per initiative

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-30 (ledger) for the spend column and DE-34 (reservations) for the
reserved column. Ships first on today's derived spend, with reserved shown as
"not tracked", and switches its source when each dependency lands.

## Current state (read from the code, 2026-10-27)

The figures exist, but on four surfaces that never meet:

| Figure | Where it is read | Where it is shown |
|--------|------------------|-------------------|
| Allocation, month-to-date spend, run count, maintenance | `listBudgets`/`getBudget` (`middleware/src/providers/budgets.ts:509-525`), `GET /api/budgets` (`routes/budgets.ts:26`) | Budgets → Initiatives report, a `DataTable` (`portal/src/pages/budgets/InitiativesReport.tsx:320-408`) |
| Sprint envelopes | `listGrants(orgProjectId)` (`budgets.ts:645`), `GET /api/budgets/grants` (`routes/budgets.ts:44`); the SME's own at `GET /api/sprints/envelopes` (`routes/sprints.ts:195`) | Budgets → Sprints report; sprint detail `GrantsPanel.tsx` |
| Run outcomes | `GET /api/bots/initiative-runs` (`routes/bots.ts:547`, any signed-in reader); `bot_runs.status` `running/done/failed/skipped` and `outcome` JSONB (`schema/agent_bots_schema.sql:87-91`), with `overRunBudget` (`lib/bot-runner.ts:1670-1679`) | Initiative page → Agents tab → Runs (`portal/src/pages/project-detail/InitiativeRail.tsx:43-47`, `agentRunsModel.ts`) |
| Forecasts | Per dispatch only: `loadForecast` (`routes/bots.ts:130-139`) over `runCostSamples`/`perPointCostSamples` (`providers/bots.ts:1202`, `:1242`); the authorized one is stored per item (`work_items.estimate_forecast`, `schema/work_item_estimate_schema.sql`, read at `providers/work-items.ts:275`) | The marketplace drawer, one item at a time |

Corrections to the backlog line:

- **"Forecasts" have no per-initiative form.** `runCostSamples` and
  `perPointCostSamples` are keyed by `(model, agent_project_id)`, meaning a
  codebase uuid and not an initiative id. They read `agent_project_runs`, not
  `bot_runs`, and return `null` under the mock (`providers/bots.ts:1203`). The
  per-initiative forecast that can be supported is the sum of the stored
  `estimate_forecast` on the initiative's open work items, plus a count of open
  sized items that have no stored estimate.
- **Grant spend is not the grantee's burn.** `initiativeSpendInWindowUsd` is the
  initiative's spend inside the sprint window (`budgets.ts:637-641`). Per-SME
  burn exists only where `bot_runs.dispatched_by` is recorded
  (`routes/sprints.ts:188-193`).
- **A join already exists:** the status decks combine `getBudget`,
  `getMaintenance30d` and `listGrants` (`providers/initiative-decks.ts:136`).
  The report reuses that read instead of adding a fifth query path.
- **The read tier is set.** `canReadBudgets` (`lib/budget-read-tier.ts:33`) and
  `withholdBudget` (`:63`) decide who sees dollars. The initiative overview shows
  "Locked" and never $0 (`project-detail/overviewModel.ts:85`). An SME is below
  the tier unless they hold `budgets-reader`.

## Change

**One read**: `GET /api/budgets/:orgProjectId/report`, mounted under the
existing `/api/budgets` (`middleware/src/index.ts:396`). Its gate is
`requireSession`, not the router's `readGate`, and the body is shaped by
`canReadBudgets`. It returns:

- `budget`: allocation, period, spent, unknown-cost run count (DE-30's
  `cost_basis='unknown'`; zero-filled until then and labelled), maintenance
  floor.
- `reserved`: DE-34's open holds, or `null` with `reservedTracked: false`.
- `forecast`: `{ p25Usd, p75Usd, estimatedItems, unestimatedSizedItems,
  models[] }`, summed from open items' `estimate_forecast`. Mixed models are
  listed, never blended silently. The schema comment explains why: a Haiku
  estimate is not an Opus estimate.
- `envelopes`: `listGrants(orgProjectId)`. Below the tier, only the caller's
  own rows, with `attributionAvailable` taken from the sprints route.
- `runs`: counts by status and trigger for the period, plus `overRunBudget`
  and `skipped`-for-budget counts. The row list stays on `initiative-runs`.

Below the tier, every dollar field is withheld through `withholdBudget`, and
the caller's own envelopes stay visible. Spend reads `spendPredicateSql` today
and `spend_entries` after DE-30, in one place in the provider. The mock answer
is derived from the existing budget, grant, run and work-item fixtures
(`mockInitiativeSpend`, `budgets.ts:270`), with no stored totals, per
`docs/mock-floor.md`.

**Release manager (Budgets page).** Extend
`portal/src/pages/budgets/InitiativesReport.tsx`'s `DataTable` instead of
adding a page. Add three columns after `remaining`: *Reserved*, *Forecast
(p75)* and *Failed / unknown-cost runs*. The `CollectionToolbar` and
`StatStrip` (`BudgetsPage.tsx:120-150`) gain *reserved* and *forecast* clusters.
The row's existing link opens `/iq/projects/:id?tab=agents&agents=spend`. No
new route, so `portal/e2e/route-inventory.ts` is unchanged.

**SME and owner (initiative page).** Add a fourth view, `spend`, to the Agents
tab's `SegmentedControl` (`InitiativeRail.tsx:43-47`), with its state held in
`?agents=` instead of `useState` (`:84`) so it can be linked. Contents:

- a `StatStrip variant="line"` with allocated, spent, reserved, forecast p75
  and remaining, using `progress` for spent of allocated (`StatStripItem`,
  ui-components 2.481.2 `dist/shared.d.ts:5922`);
- a `DataTable` of envelopes (SME, sprint, granted, in-window spend);
- a second `DataTable` of open work items with a stored or missing estimate.
  Each row links to `?tab=work&item=` and uses `StatusPill` and `T`.

Locked figures render through the existing `LockedFigure`
(`projects/BudgetAccess.tsx`). Empty and error states use `EmptyState` and
`UnavailableNotice`, and all text goes through `T` tokens. No raw elements, no
`style=`.

**Missing primitive, only if wanted:** a stacked meter (spent, reserved and
forecast against allocation in one bar) does not exist. `ProgressBar` takes
one `value` (`shared.d.ts:4680`). If the decision below chooses it, ship
`ProgressBar.segments` in ui-components first, record it in
`docs/ui-components-queue.md`, then move the pin. v1 uses separate columns.

## Decisions owed

- Does an SME see the initiative's allocation and spend on initiatives where
  they hold an active envelope? Proposal: yes. Holding an envelope counts as
  `budgets-reader` for that one initiative, decided in `canReadBudgets`, so
  decks and answers stay in agreement.
- Forecast scope: open items only, or also in-progress items whose run has not
  settled? Proposal: open items only. In-progress money is DE-34's reservation,
  and counting it twice is the error DE-30 exists to prevent.
- Stacked meter (`ProgressBar.segments`) or columns only. Proposal: columns
  only for v1, following the table-first rule.

## Done when

- The middleware jest file for the report route asserts: a release manager gets
  every field; an SME without the grant gets `budgetAccess` with dollar fields
  absent (not zero) and only their own envelopes; `reservedTracked:false` until
  DE-34; and mixed-model forecasts are listed per model. Run it alone:
  `cd middleware && npx jest routes/__tests__/budget-report`.
- Pure model tests for the new view and columns pass under node:test, next to
  `project-detail/__tests__/agentRunsModel.test.ts`.
- `scripts/validate-component-discipline.sh`,
  `scripts/validate-honest-numbers.sh` and `scripts/validate-mock-floor.sh`
  stay green. `cd middleware && npm run typecheck` and the portal typecheck
  pass.
- `npm --prefix portal run audit:ui -- --tenant orgiq --all --themes
  light,dark --widths 1440,900` reports no new findings on `/admin/budgets`
  and on `/iq/projects/p-auth-migration?tab=agents&agents=spend`.
- On `dev:mock`, the report's spent figure for `p-auth-migration` equals the
  Initiatives report's `spent` cell, and both read the same predicate.
