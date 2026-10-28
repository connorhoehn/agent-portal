# DE-36 Hard caps beside the soft brakes

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-30 (ledger) and DE-34 (holds, the locked check the cap lives in).

## Current state (read from the code, 2026-10-27)

The backlog line is right that every money brake is confirmable and that two
fail open, but "all three brakes" undercounts and one gate already fails
closed. Every gate that can stop agent spend today:

| Gate | Where | Kind | No data | Read fails |
|------|-------|------|---------|------------|
| Grant scope (`decideGrantScopedDispatch`) | `lib/bot-runner.ts:695`, via `grantScopedDispatchVerdict` `:769` | hard 403, sme only | sme with no person or session: 503 (`:777`) | **closed**: 503 `gate: 'grant-authorization'` (`:754-757`, `routes/bots.ts:251`) |
| Run budget (`decideRunBudget`) | `lib/bot-runner.ts:247`, `routes/bots.ts:281`, `:733` | soft 409 `confirmOverRunBudget` | request sends no cap: no brake | no read; the cap is never persisted for marketplace runs |
| Allocation (`decideAllocation`) | `lib/bot-runner.ts:334`, `routes/bots.ts:316-339` | soft 409 `confirmOverAllocation` | no allocation row: **skipped** by design (`routes/bots.ts:310-317`) | missing table: `safeExec` returns `[]` (`providers/budgets.ts:426-434`), so **open**; any other error: 500 from `asyncHandler`, closed by accident with no gate name |
| Envelope (`decideEnvelope`) | `lib/bot-runner.ts:456`, `routes/bots.ts:354-378` | soft 409 `confirmOverEnvelope` | no active grant: skipped | **open**: `loadEnvelope` catches everything and returns null (`lib/bot-runner.ts:639-644`); attribution column missing degrades to "only refuse a forecast bigger than the whole envelope" (`providers/bots.ts:314`, `:340-344`; `lib/bot-runner.ts:474`) |
| Cron allocation (`decideBotFireAllocation`) | `lib/bot-runner.ts:166`, `:943` | skip, cron only, opt-in `bots.enforce_allocation` (default false, `schema/agent_bots_schema.sql:55`) | no allocation: proceed | as the allocation row above |
| Bot daily caps (`decideFire`) | `lib/bot-runner.ts:88` | skip / self-pause | caps null: no brake | — |

Also: the deprecated `confirmOverBudget` still opens both the run-budget and
allocation brakes (`routes/bots.ts:179-185`). The money brakes exist only on
`dispatch-work`; promote, `/api/work/jobs`, manual bot runs (beyond the run
budget) and local-compute dispatch have none (see DE-34). And
`docs/program-operating-model.md:295-300` says the `bots.enforce_allocation`
flag is yet to be added; it exists, so that line (and DE-39's premise) is stale.

## Change

**A cap is a column, enforced inside the hold.**

```sql
ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS hard_cap_usd NUMERIC
  CHECK (hard_cap_usd IS NULL OR hard_cap_usd >= allocated_usd);
ALTER TABLE budget_grants ADD COLUMN IF NOT EXISTS hard_cap_usd NUMERIC
  CHECK (hard_cap_usd IS NULL OR hard_cap_usd >= allocated_usd);
```

`reserveSpend` (DE-34) already holds the initiative and grant locks and reads
`spent + held`. It gains a pure `decideHardCap({ capUsd, spentUsd, heldUsd,
amountUsd })` evaluated **before** the soft brakes and ignoring every confirm
flag, including the legacy one. Over the cap answers 403 with `{ gate:
'allocation-cap' | 'envelope-cap', capUsd, spentUsd, heldUsd }` and no
`confirmFlag`, the same shape as the grant-scope refusal. The cap applies on
every path that takes a hold (dispatch-work, every `fireBot` trigger including
cron regardless of `enforce_allocation`, promote, `/api/work/jobs`) and to
DE-35's top-up, so a running task stops at the cap rather than at its first
hold. A null column means the deployment default (below).

**Writes.** `PUT /api/budgets/:orgProjectId` (`routes/budgets.ts:51`) and
`POST`/`PATCH /api/grants` (`routes/grants.ts:58`, `:100`) accept
`hardCapUsd` under the existing `ManageBudgets` gate; no new Cedar action.

**Fail closed.** Budget reads return a tri-state instead of null-or-throw:
`{ kind: 'ok', … } | { kind: 'none' } | { kind: 'unavailable', reason }`.

- `getBudget` used by a gate stops going through `safeExec`; a missing table
  or a Data API error is `unavailable`. The ledger and Budgets pages keep
  `safeExec`.
- `loadEnvelope` separates "not an SME here" (no person, no grant: `none`)
  from "could not read" (`getUser`/`listGrants`/burn threw: `unavailable`).
- After DE-30 the envelope burn reads `spend_entries.grant_id`, so the
  attribution-column probe and its partial brake go away.
- `reserveSpend` maps `unavailable` from either read to 503 `{ gate:
  'budget-state' }`, wording like the grant gate's: "Budget state could not be
  read. No work was started."

Fail-closed applies when `NODE_ENV=production` or `BUDGET_FAIL_CLOSED=1`;
`dev:mock` reads fixtures and never hits it.

**Retire `confirmOverBudget`.** Log a deprecation warning on use for one
release, then remove it, so one click cannot answer two questions.

## Decisions owed

- Default cap when `hard_cap_usd` is null: proposal `allocated_usd × 1.25`
  (`BUDGET_HARD_CAP_FACTOR`), so confirmations still have room but end
  somewhere.
- Initiatives with no allocation row: today deliberately unbraked. Proposal: in
  production, a deployment-wide `UNBUDGETED_HARD_CAP_USD` per period (e.g.
  $25), shown on the Budgets page as the blind spot it already is.
- Cron firings that hit the cap: proposal, a `skipped` run (as the opt-in brake
  does), never a bot self-pause.

## Done when

- Unit tests for `decideHardCap`: under, at, over; every confirm flag set
  still refuses.
- Jest: dispatch-work with all three confirm flags and a forecast over the
  initiative cap answers 403 `gate: 'allocation-cap'`; same for a grant cap
  (`envelope-cap`); a cron `fireBot` over the cap records a `skipped` run.
- Jest with `BUDGET_FAIL_CLOSED=1`: a provider that throws from `getBudget`,
  from `listGrants`, or reports a missing table makes dispatch-work answer 503
  `gate: 'budget-state'` and creates no `bot_runs` row and no hold.
- Jest: `confirmOverBudget` alone logs the deprecation warning.
- `PUT /api/budgets/:id` with `hardCapUsd` below `allocatedUsd` answers 400.
