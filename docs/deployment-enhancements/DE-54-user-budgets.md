# DE-54 User budgets

Status: spec and local build, 2026-10-29. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Source: `docs/budget-system-analysis-2026-10-28.md` section 6 item 2. Needs
DE-30 (ledger, `spend_entries.actor_id`) and DE-34 (the `reserveSpend` hold).

## Current state (read from the code, 2026-10-29)

Budgets are real Bedrock money, but no limit applied to a person. The nearest
things were a sprint envelope (`budget_grants`, one person on one initiative,
enforced only inside that initiative), `bot_runs.dispatched_by`, and
`spend_entries.actor_id`, which `GET /api/me/spend` already summed per
initiative (DE-31). An SME with envelopes on three initiatives, or anyone
spending on a box with no initiative, had no ceiling across them. The lock
order in `providers/spend-holds.ts` already reserved a third slot: initiative,
grant, then user.

## Change

**Storage.** `schema/user_budgets_schema.sql` (additive, repeatable, in
`schema/manifest.json` after `spend_holds_schema`):
`user_budgets (user_id PK → app_users ON DELETE CASCADE, period 'monthly',
allocated_usd, hard_cap_usd NULL CHECK >= allocated_usd, note, set_by,
updated_at, created_at)`. It also relaxes `spend_holds.initiative_id` to
nullable so unattributed spend can be held against its spender. Offline: the
registered `user-budgets` fixture (`mock/user-budgets.ts`), columns only.

**Burn, derived.** `providers/user-budgets.ts`: spent = `SUM(cost_usd) FROM
spend_entries WHERE actor_id = :sub AND occurred_at >= date_trunc('month',
NOW()) AND trigger IS DISTINCT FROM 'cron'`, plus the unknown-cost count;
held = the user's open, non-essential `spend_holds`. Offline the same read
over stored entries and bot runs derived from the `bot_runs` fixture.

**Decision.** `lib/budget-decisions.ts` `decideUserBudget({ allocatedUsd,
spentUsd, heldUsd, unknownCount }, forecast, confirmed)`: the allocation is a
soft brake (409 `gate: 'user-budget'`, `confirmFlag: 'confirmOverUserBudget'`),
the cap a hard one (DE-36 `decideHardCap`, 403 `gate: 'user-cap'`).

**Enforcement.** Inside `reserveSpend`, after the initiative and grant locks,
`pg_advisory_xact_lock(hashtext('user:' || sub))`, then the user budget is read
and judged with the hold written in the same transaction. Every path that
takes a hold is covered: dispatch-work, manual bot runs, the job dispatcher,
box tasks, the agent loop and direct governed runs. Unattributed spend takes
the user key as its only lock and is held against the user budget; with no
user budget it stays unheld, as before.

**HTTP.**
- `PUT /api/user-budgets/:userId { allocatedUsd, hardCapUsd?, note? }` →
  `{ budget }` behind `ManageBudgets`; 403 `gate: 'self-budget'` on your own row
  or the masquerading actor's; 400 cap below allocation; 404 unknown user.
- `DELETE /api/user-budgets/:userId` (same gate and self rule).
- `GET /api/user-budgets` (org-leader, hr-admin, program-owner, else
  ManageBudgets): every budget plus every user who spent this month without
  one (`allocatedUsd: null`, the blind spot).
- `GET /api/me/spend` gains `budget: { userId, period, since, allocatedUsd,
  hardCapUsd, effectiveHardCapUsd, hardCapSource, spentUsd, unknownCount,
  heldUsd, remainingUsd, note, setBy, setByName, updatedAt } | null`.
- Spend refusals carry `userBudget: { userId, period, allocatedUsd,
  hardCapUsd, spentUsd, heldUsd, remainingUsd, unknownCostCount }` on the
  `user-budget` 409 and the `user-cap` 403.

## Decisions taken by default

- A user with no row is unbraked and listed as a blind spot (no default
  allocation).
- The user budget applies across all initiatives in addition to envelopes;
  both brakes run, initiative first, then envelope, then user.
- Cron spend never charges a user: an essential firing is never judged
  against a user budget and the burn excludes `trigger = 'cron'`.
- Writes refuse your own row (and a masquerade's real actor), including a
  DELETE, which would raise the limit to "none".
- Monthly only, like `initiative_budgets`. `confirmOverBudget` (legacy) never
  opens the user budget.

## Done when

- Unit tests for `decideUserBudget` (`lib/__tests__/budget-decisions.test.ts`).
- Jest, dev:mock end to end (`routes/__tests__/budget-users-caps-reserve.test.ts`):
  write route (set, self refusal, masquerade refusal, validation, delete,
  list with blind spots), `/api/me/spend` budget, 409 user-budget and its
  confirm, 403 user-cap past every flag with no hold and no run, spend on one
  initiative judged on another, two concurrent holds on two initiatives
  serialised on the user lock, unattributed spend held, cron never charged.
- PostgreSQL acceptance (`providers/__tests__/spend-holds-postgres.test.ts`):
  the CHECK and cascade, the actor-burn SQL, 20 parallel unattributed holds
  never above the remainder, cross-initiative serialisation, the cap.
- Both write routes classified in `routes/__tests__/initiative-scope-matrix.test.ts`.
