# DE-55 The maintenance reserve (folds DE-39)

Status: spec and local build, 2026-10-29. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Source: `docs/budget-system-analysis-2026-10-28.md` section 6 items 5 and 6.
Needs DE-34 (holds) and DE-36 (the hard cap applies to the sum).

## Current state (read from the code, 2026-10-29)

Cron bots were deliberately unbraked (`bots.enforce_allocation` default
false) and their spend counted into the initiative's `spent`, so discretionary
dispatches were braked by a remainder the floor had already eaten, while the
floor itself had no reserved slice and no limit. "Necessary" was not a column;
the proxy was `trigger = 'cron'`. DE-39 as written would brake cron against
the whole allocation, and DE-36's cap would skip it, so together they would
let discretionary work exhaust the allocation and then starve maintenance.

## Change

**Columns** (`schema/maintenance_reserve_schema.sql`, additive, repeatable):
- `initiative_budgets.maintenance_reserve_usd NUMERIC NULL` — null = auto:
  the last closed month's essential-bot spend × `MAINTENANCE_RESERVE_FACTOR`
  (1.1), else the trailing 30 days × the same factor.
- `initiative_budgets.allow_floor_spill BOOLEAN NOT NULL DEFAULT true`.
- `bots.essential BOOLEAN NULL`. The spec's `NOT NULL DEFAULT (trigger =
  'cron')` cannot be written (PostgreSQL forbids a column reference in a
  DEFAULT), so NULL means "by trigger" and every reader uses
  `COALESCE(essential, trigger = 'cron')`.
- `spend_holds.essential BOOLEAN NOT NULL DEFAULT false` — floor money in flight.

**Figures.** `BudgetRow` gains `reserveUsd`, `reserveSource`
(`set|auto|off`), `maintenanceReserveUsd` (stored), `allowFloorSpill`,
`floorSpentUsd` (essential bots' scheduled spend this month, by bot target),
`discretionarySpentUsd`, `floorHeldUsd`, `discretionaryHeldUsd` and
`discretionaryRemainingUsd = allocated − max(reserve, floorSpent + floorHeld)
− discretionarySpent − discretionaryHeld`. The mock derives every one from the
bot_runs fixture and the holds fixture.

**Decisions** (`lib/budget-decisions.ts`):
- `decideFloorFire` for an essential bot's scheduled firing: funded from the
  reserve; past it, from the discretionary remainder while `allow_floor_spill`;
  else a recorded skip (`gate: 'maintenance-reserve'`), never a pause.
- Every human, job and box path: `decideAllocation` judges the discretionary
  remainder (`AllocationState.floorUsd`).
- The initiative hard cap (DE-36) applies to the sum, before either.

**Wiring.** `fireBot` passes `essential: trigger !== 'manual' &&
botIsEssential(bot) && !bot.enforceAllocation`. A manual firing is a person's
dispatch (discretionary, envelope, user budget). A bot opted into
`enforce_allocation` keeps its old meaning: judged against the allocation like
discretionary work. A non-essential scheduled bot is discretionary.

**HTTP.**
- `PUT /api/budgets/:orgProjectId` accepts `maintenanceReserveUsd` (number or
  null = auto) and `allowFloorSpill` (boolean) under `ManageBudgets`.
- `PUT /api/bots/:id/essential { essential: true | false | null }` →
  `{ bot, essential }` behind `ManageBudgets`.
- The allocation 409's `allocation` body gains `hardCapUsd, reserveUsd,
  floorSpentUsd, floorHeldUsd, discretionarySpentUsd, discretionaryHeldUsd,
  discretionaryRemainingUsd`; `remainingUsd` is the discretionary remainder
  (identical to the old figure whenever the floor has spent past its reserve).

## Decisions taken by default

- Reserve rule ×1.1 of last month's essential spend, else the trailing 30
  days ×1.1; `MAINTENANCE_RESERVE=off` restores the pre-DE-55 arithmetic.
- Spill on by default, so maintenance never stops while any money is left.
- PR-watch bots are not essential by default (`trigger = 'pr_watch'`); they go
  through the job queue, which a bot run owns, so nothing changes for them.
- Who marks a bot essential: `ManageBudgets`.
- The reserve is not capped at the allocation: a floor larger than the
  allocation leaves no discretionary money, which is the truth to show.

## Done when

- Unit tests for `discretionary`, `autoReserveUsd`, `decideFloorFire`.
- Jest (bot-runner): an essential cron firing funded by the reserve fires,
  spills while allowed, skips with `maintenance-reserve` when neither funds it,
  stops at the reserve with spill off, skips (never pauses) at the hard cap,
  is left alone when unbudgeted; a non-essential bot is judged as discretionary.
- Jest, dev:mock: BudgetRow figures derived; a dispatch that fits
  `allocated − spent` is refused when the reserve takes the room (and passes
  with the reserve off); the reserve and spill writes; essential holds counted
  as floor; `PUT /api/bots/:id/essential`.
- PostgreSQL acceptance: auto reserve from last month's history, the
  discretionary refusal, a bot marked non-essential leaving the floor, floor
  holds and spill.
