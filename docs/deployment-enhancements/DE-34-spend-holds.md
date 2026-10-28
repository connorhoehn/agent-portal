# DE-34 Budget reservations at dispatch

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-30 (`spend_entries`). Unblocks DE-35, DE-36, DE-53.

## Current state (read from the code, 2026-10-27)

The backlog line is right about the race and slightly wrong about its scope.
`POST /api/bots/dispatch-work` (`routes/bots.ts:204`) reads the allocation
(`getBudget`, `routes/bots.ts:316`) and the caller's envelope (`loadEnvelope`,
`routes/bots.ts:354`), judges each against the p75 forecast, and then starts
the run (`dispatchWorkItem`, `routes/bots.ts:381`). Nothing is written between
the read and the start, and spend only becomes visible once a run settles
(`settleBotRun`, `providers/bots.ts:1089`, from the 30 s reconcile tick,
`lib/bot-scheduler.ts:27`). So two dispatches on **different** work items of
one initiative both see the same remaining money and both pass. Two dispatches
of the **same** item cannot race: the item claim is a compare-and-swap
(`updateWorkItem(..., expectStatus: 'open')`, `lib/bot-runner.ts:1234`).

Three facts the design has to respect:

- **The existing "atomic" pattern is not atomic for sums.** `insertBotRun`'s
  ceiling (`providers/bots.ts:1070`) is `INSERT … SELECT … WHERE (SELECT COUNT(*)
  …) < :ceiling`. Under Postgres READ COMMITTED both concurrent statements
  read their own snapshot, neither sees the other's uncommitted row, and both
  insert. The comment calling it "TOCTOU-safe" is wrong; it narrows the window,
  it does not close it. A money hold must not copy it.
- **The run starts before its row exists.** `dispatchWorkItem` calls
  `dispatchGovernedRun` (`lib/bot-runner.ts:1281`) and only then
  `createBotRun` with the ceiling (`:1289`); a ceiling refusal answers 503
  while the governed run is already live, with no `bot_run` to carry its cost.
  `fireBot` has the same order (`:1001` then `:1013`). A hold must be taken
  before any side effect.
- **"Reservation" is taken.** `devbox-fleet.ts:595` already has box
  reservations (`reserveBox`, who holds a box). This spec calls money held at
  dispatch a **spend hold** to keep the two apart.

Money brakes run on `dispatch-work` only (plus the opt-in cron allocation
brake, `lib/bot-runner.ts:943`). Manual `POST /api/bots/:id/run`
(`routes/bots.ts:715`, run-budget only), `POST /api/work/findings/:id/promote`
(`routes/work.ts:383`, grant check only), `POST /api/work/jobs` (`routes/work.ts:233`) and
local-compute work-item runs (`routes/local-compute.ts:1240`) hold nothing.

## Change

```sql
CREATE TABLE IF NOT EXISTS spend_holds (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  grant_id       TEXT REFERENCES budget_grants (id) ON DELETE SET NULL,
  source         TEXT CHECK (source IN ('bot_run','job','box_task','agent_loop')),
  source_id      TEXT,                 -- same key spend_entries uses; set once the row exists
  amount_usd     NUMERIC(10,4) NOT NULL CHECK (amount_usd >= 0),
  basis          TEXT NOT NULL CHECK (basis IN ('p75','confirmed_over','topup')),
  status         TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released','expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_by     TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS spend_holds_open_idx ON spend_holds (initiative_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_grant_open_idx ON spend_holds (grant_id) WHERE status = 'held';
```

**Taking a hold is one transaction with a lock, not one statement.**
`providers/spend-holds.ts` `reserveSpend({ initiativeId, grantId, amount,
confirmed })` runs inside `withTransaction` (`providers/aurora.ts:158`):

1. `SELECT pg_advisory_xact_lock(hashtext('spend:' || :pid))`, then, when a
   grant applies, the same for `'grant:' || :gid` (always initiative first, so
   two dispatches cannot deadlock).
2. With the lock held, a fresh statement reads `allocated_usd`, ledger spend
   for the period (`spend_entries`, DE-30) and `SUM(amount_usd)` of open holds;
   the same for the grant window. Each statement after the lock takes a new
   READ COMMITTED snapshot, so it sees every hold committed by the dispatch it
   waited on.
3. Run the existing pure `decideAllocation` / `decideEnvelope` with
   `spentUsd = ledger + held`. A `confirm` verdict rolls back and the route
   answers the same 409 it does today. `proceed` inserts the hold and commits.

The advisory lock needs no row to exist, so an initiative with no allocation
still serializes (and DE-36 decides what it may spend). Brakes 5 and 6 in
`routes/bots.ts` move inside this call so the check and the hold cannot drift.
A confirmed-over dispatch still takes a hold (`basis='confirmed_over'`), so the
next caller sees it. Offline (`config.mock.aurora`) the read, decision and
append are one synchronous step on a registered fixture, as the mock ceiling
already does (`providers/bots.ts:1014`).

**Order.** The hold is taken before `dispatchGovernedRun`/`enqueueJob`; the
hold id is passed down and written onto the `bot_runs` row
(`outcome.holdId`, then `source_id` set on the hold). Any failure after the
hold and before the run is live (claim lost, workspace 503, ceiling null)
calls `releaseHold(id)` in the same `revertClaim` path.

**Settle.** DE-30's `recordSpend` runs in a transaction that inserts the
ledger entry and sets the matching hold `settled` (`WHERE source = … AND
source_id = …`). Held money becomes spent money in one commit, never both,
never neither. An unknown cost (`cost_basis='unknown'`) settles per the
decision below.

**Crash and expiry.** `expires_at = NOW() + run ceiling` (governed runs:
`BOT_STALE_RUN_MINUTES`, 30, `lib/bot-runner.ts:1703`; jobs:
`JOB_STALE_MINUTES`, 30, `lib/job-dispatcher.ts:39`; plus 5 min grace). The
reconcile tick gains one statement: `UPDATE spend_holds SET status='expired',
closed_at=NOW() WHERE status='held' AND expires_at < NOW()`. A late ledger
write for an expired hold still lands (money spent is spent); it simply no
longer double-counts. The boot sweep (`sweepOrphanedRuns`) expires holds whose
owner row is already terminal.

**Other paths** take a hold with the same call: manual and cron `fireBot`
(amount from `botFireProjectionP75`, `lib/bot-runner.ts:896`), promote and
`/api/work/jobs` (model prior p75). Holds are skipped for `modelProvider:
'local'` runs, which cost $0.

## Decisions owed

- Unknown-cost settle: proposal, convert the hold into a `cost_basis =
  'estimated'` ledger entry at the held amount, so a run that reports no cost
  never frees money (DE-33's rule applied here).
- Ad-hoc box tasks (`/api/devbox/:sid/task`): proposal, no hold until DE-44
  ties a box to an initiative; then hold the model prior p75.
- Fix `insertBotRun`'s ceiling with the same advisory lock now, or leave it to
  DE-37. Proposal: now; it is three lines and the comment is false today.

## Done when

- `spend_holds` registered in both loaders; `validate-mock-floor.sh` green.
- A jest test fires two `dispatch-work` requests concurrently against an
  allocation that fits one p75: exactly one 202, the other 409
  `gate: 'allocation'`; same for an envelope (`gate: 'envelope'`).
- An Aurora-backed test (local Postgres) runs 20 parallel `reserveSpend`
  calls and asserts `SUM(held) <= allocated - spent`.
- A dispatch whose workspace step fails leaves no `held` row.
- Settling a run leaves one ledger entry and the hold `settled`; a retried
  settle changes nothing.
- Advancing the mock clock past `expires_at` and running one reconcile tick
  marks an orphaned hold `expired`.
