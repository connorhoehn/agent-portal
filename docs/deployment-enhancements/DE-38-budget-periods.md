# DE-38 Budget periods beyond monthly

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-30 (spend ledger, `occurred_at`). Feeds DE-34, DE-36, DE-39.

## Current state (read from the code, 2026-10-27)

`initiative_budgets.period` (`schema/agent_budgets_schema.sql:21`) is
`TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly'))`, an inline
column check, so Postgres names it `initiative_budgets_period_check`. The
column is stored and returned (`rowToBudget`, `providers/budgets.ts:441`) but
nothing reads it: the window is the constant `PERIOD_START_SQL =
date_trunc('month', NOW())` (`budgets.ts:99`), used by the per-initiative
spend CTE (`:468`), the org totals (`:761`, `:763`), the by-model reads
(`:795`, `:806`) and the Initiatives rollup (`providers/projects.ts:496`,
`:743`). The mock mirror is `periodStartMs()` (`budgets.ts:222`) and
`mockBudgetRow` hard-codes `'monthly'` (`:344`). `PUT /api/budgets/:id`
accepts only `allocatedUsd` (`routes/budgets.ts:51-66`); `upsertAllocation`
(`budgets.ts:551`) never writes `period`.

Sprint windows already exist, but only for SME envelopes: `sprints.starts_on`
/ `ends_on` (DATE, `schema/program_schema.sql:25-26`, ends inclusive) bound a
grant's burn in `dispatchedSpendInWindow` (`providers/bots.ts:307-330`,
`[starts_on, ends_on + 1)`). Nothing stops two sprints on one initiative being
`active` at once. A trailing 30-day window exists only as a view,
`v_initiative_maintenance_30d` (`program_schema.sql:89`). There is no
carry-over anywhere: a month's unspent allocation vanishes at midnight UTC on
the 1st and an overspend is forgotten.

## Change

**Schema, additive only.** Widen the check (every existing row is `monthly`,
so the new constraint validates) and add nullable columns:

```sql
ALTER TABLE initiative_budgets DROP CONSTRAINT IF EXISTS initiative_budgets_period_check;
ALTER TABLE initiative_budgets ADD CONSTRAINT initiative_budgets_period_check
  CHECK (period IN ('monthly','quarterly','sprint','rolling'));
ALTER TABLE initiative_budgets
  ADD COLUMN IF NOT EXISTS rolling_days INTEGER CHECK (rolling_days BETWEEN 1 AND 366),
  ADD COLUMN IF NOT EXISTS carry_over TEXT NOT NULL DEFAULT 'none'
    CHECK (carry_over IN ('none','unspent','overspend','both')),
  ADD COLUMN IF NOT EXISTS carry_over_cap_usd NUMERIC CHECK (carry_over_cap_usd >= 0),
  ADD COLUMN IF NOT EXISTS carry_over_since TIMESTAMPTZ;
-- added with NOT VALID then VALIDATE, so a live table is not scanned under lock
ALTER TABLE initiative_budgets ADD CONSTRAINT initiative_budgets_period_shape CHECK (
  (period = 'rolling') = (rolling_days IS NOT NULL)
  AND (period <> 'rolling' OR carry_over = 'none')) NOT VALID;

CREATE TABLE IF NOT EXISTS budget_period_closes (
  org_project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  period_key     TEXT NOT NULL,        -- '2026-10' | '2026-Q4' | sprints.id
  period_start   TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL,
  allocated_usd  NUMERIC NOT NULL,     -- the allocation in force at close
  carry_in_usd   NUMERIC NOT NULL DEFAULT 0,
  spent_usd      NUMERIC NOT NULL,     -- known cost only
  unknown_cost_entries INTEGER NOT NULL DEFAULT 0,
  carry_out_usd  NUMERIC NOT NULL,     -- signed: + unspent, - overspend
  reason         TEXT NOT NULL DEFAULT 'boundary' CHECK (reason IN ('boundary','reconfigured')),
  closed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_project_id, period_key)
);
```

**One window function.** `currentPeriod(budget, now)` in TS, and its SQL twin
as a `budget_windows` CTE (`org_project_id, period_start, period_end,
period_key`) that replaces every `PERIOD_START_SQL` use that is about one
initiative:

- `monthly`: `[date_trunc('month', now), +1 month)`, key `YYYY-MM`.
- `quarterly`: `date_trunc('quarter', …)`, key `YYYY-Qn`.
- `sprint`: the initiative's sprint whose `[starts_on, ends_on + 1)` contains
  today, preferring `status = 'active'`, then the latest `starts_on`. Same
  bounds convention as `dispatchedSpendInWindow`, so an envelope and its
  initiative's allocation cover identical days. Key = `sprints.id`. Between
  sprints there is no current period (see decisions).
- `rolling`: `[now - rolling_days, now)`, no key, no close, no carry-over
  (the window never ends, so nothing is left over; the CHECK forbids it).

Initiatives without an allocation row use `monthly`, so the Initiatives
rollup keeps one comparable window for unbudgeted spend.

**Carry-over is a close row, not a running balance.** When a read needs the
current period and the previous keyed period has no close row, it writes one
(`INSERT … ON CONFLICT DO NOTHING`, so replicas and retries agree) from the
ledger. `carry_out` = `allocated + carry_in - spent`, then filtered by policy
(`unspent` keeps only positive, `overspend` only negative), clamped to
`±carry_over_cap_usd`, and zero for periods ending before `carry_over_since`.
The next period's `effective_allocated_usd = allocated_usd + carry_in_usd`. A
close is computed only from its immediate predecessor, so the chain is never
re-walked. Changing `period`, `rolling_days` or carry policy closes the
outgoing window with `reason='reconfigured'` and carry-out 0.

**Readers:** `BudgetRow` gains `periodStart`, `periodEnd`, `periodKey`,
`carryInUsd`, `effectiveAllocatedUsd`; `decideAllocation` and
`decideBotFireAllocation` take the effective figure. `PUT
/api/budgets/:id` accepts `period`, `rollingDays`, `carryOver`,
`carryOverCapUsd`. Org totals (`orgSummary`, `budgets.ts:718`) stay calendar
month and say so, since initiatives no longer share a boundary. Mock:
`periodStartMs` becomes the TS `currentPeriod`, and `budget_period_closes` is
a registered fixture derived from the seeded runs.

## Decisions owed

- Sprint-period initiative between sprints: allocation off (unbudgeted, no
  brake) or the last sprint's window held open? Proposal: unbudgeted, shown as
  "between sprints" on the ledger, because holding a closed sprint open
  silently spends the next sprint's money.
- Two overlapping sprints: refuse a second `active` sprint per initiative
  (partial unique index) or pick one? Proposal: the index, since envelopes have
  the same ambiguity today.
- Does overspend carry by default? Proposal: default `none`; offer `both` with
  a cap, so a release manager opts into debt explicitly.
- Do unknown-cost entries (DE-33) block a close? Proposal: no; the close
  records the count and the ledger flags the period.

## Done when

- Schema applies twice cleanly on a cluster with existing `monthly` rows
  (`load_schema.py` re-run), and an insert of `period='weekly'` still fails.
- Unit tests for `currentPeriod` at month, quarter and sprint boundaries,
  between sprints, and for a 7-day rolling window, run under the mock clock;
  the SQL CTE returns the same bounds on the seed (postgres harness test).
- A close test: 2 periods, `unspent` with a $10 cap, $25 left over, next
  period's effective allocation is allocation + 10; a retried close leaves
  one row.
- `decideAllocation` refuses against the effective allocation, not the raw.
- Budget, Projects-rollup and mock-floor suites pass with every initiative
  still `monthly`, showing no behaviour change before anyone opts in.
