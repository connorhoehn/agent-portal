# DE-31 Box spend rolls up

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-30 (the `spend_entries` ledger); this spec is only the remainder.

## Current state (read from the code, 2026-10-27)

`appendEvent` adds each `result` event's reported cost to the box's lifetime
`spendUsd` (`middleware/src/lib/devbox-fleet.ts:551-567`), skipping a null or
zero figure, and the fleet store persists it to `devbox_boxes.spend_usd`
(`providers/devbox-fleet-store.ts:115-141`, `schema/devbox_fleet_schema.sql:60`).
Nothing outside the fleet reads it: the Projects rollup and every budget query
sum `bot_runs.cost_usd` (`providers/projects.ts:518`, `providers/budgets.ts:110`).
The only consumer is the initiative compute rail's per-box chip
(`portal/src/components/marketplace/InitiativeComputeRail.tsx:50-54`).

What the backlog line misses:

- **Most of it is DE-30.** Attributing ad-hoc box tasks to the box's
  `projectId` is DE-30's `box_task` / `agent_loop` writer. Adding box totals to
  a budget on top of that would double-count, because bot runs and queued jobs
  tee their events into the same box (`lib/bot-runner.ts:1538`,
  `lib/job-dispatcher.ts:94`), so `spendUsd` already contains their cost.
- **"Owner" is the wrong person to charge.** A box with a `projectId` is shared
  with the initiative's owner and SMEs (`devbox-fleet.ts:46-54`), so whoever
  sent a task is not necessarily `ownerId`. And the task route never learns who
  that was: `runTaskAndForward` takes no caller identity
  (`routes/devbox.ts:569-578`, called at `:653`).
- **Platform-api boxes can already carry an initiative.** `POST
  /internal/devbox/sessions` accepts a `projectId` behind the steward check
  (`routes/internal-devbox.ts:171-190`). Only the task route's fallback, for a
  session that never went through `/sessions`, registers a box with no
  `projectId` (`:213-214`); those land unattributed under DE-30.
- **The box figure understates and hides it.** Unknown-cost results are
  dropped from `spendUsd` with no counter beside it (`devbox-fleet.ts:565`).
- **The mock stores the totals.** `mock/devbox-fleet.ts:107,126,144,163,180,197`
  hard-codes `spendUsd` per box, a stored aggregate that `docs/mock-floor.md`
  rule 1 forbids once the rows exist.

## Change

1. **`box_id` on every ledger entry.** DE-30 has the column; this item makes the
   `bot_run` and `job` writers fill it (the box the run claimed), not only the
   `box_task` writer. That is what lets one box's spend be summed across all
   three sources without double-counting.
2. **Actor plumbing.** Add `actorId?: string` to `runTaskAndForward`'s options;
   `POST /api/devbox/:sid/task` passes the session `sub`, the internal router
   passes `principal.requestedBy`. DE-30's writer records it as `actor_id`.
   `ownerId` stays a box fact, read by join, never copied as the spender.
3. **No initiative by accident.** The internal task route's auto-register
   fallback (`internal-devbox.ts:214`) logs `devbox.unattributed_box` with the
   service id, so unattributed chat-agent spend is traceable to a caller that
   skipped `/sessions`. Its entries stay `initiative_id = NULL`.
4. **Box spend becomes a ledger read.** `getBoxSpend(boxId)` in
   `providers/spend-ledger.ts` returns `{ knownUsd, unknownCount, bySource }`
   from `spend_entries WHERE box_id = :id`. The fleet list endpoint fills
   `spendUsd` from it (batched per list, not per box) and adds
   `spendUnknownCount`. The in-memory `appendEvent` accrual stays only as a
   live, in-flight estimate between a task starting and its entry landing, and
   is labelled as such on the wire (`spendLiveUsd`).
5. **Per-person rollup.** `GET /api/me/spend?period=` and a release-manager
   view grouped by `actor_id` over the same table (DE-30's "unattributed
   spend" line is this query filtered to `initiative_id IS NULL`).
6. **Retire `devbox_boxes.spend_usd` as a source.** Keep the column one release
   for the dual-read comparison, then stop writing it. No schema change here
   beyond DE-30's table.

**Mock floor:** the six fleet fixture rows lose their `spendUsd` literals;
`spend_entries` fixture rows carry `boxId`, and the mock fleet's spend is the
same `getBoxSpend` selector over them, so a mock task that settles moves the
chip and `POST /api/__mock/reset` restores it.

**Order:** DE-30 lands first (schema, backfill, dual-read). Then this item's
writer changes, then the fleet read switch behind the same `SPEND_LEDGER` flag,
logging any box whose ledger and `spend_usd` figures differ by more than a cent.

## Decisions owed

- Who is charged when a shared box runs a task: the person who sent it, or the
  box owner? Proposal: the sender (`actor_id`); the owner is shown, not billed.
- Should the internal fallback that registers a box without `/sessions` be
  refused instead of logged? Proposal: refuse (409, "create the session first")
  once platform-api is confirmed to always call `/sessions`.

## Done when

- `devbox-fleet.test.ts`: a box running one bot-run task and one ad-hoc task
  reports `spendUsd` equal to the sum of exactly two ledger entries, one per
  source, with no duplicate.
- A route test: `POST /api/devbox/:sid/task` by an SME on a shared box writes
  `actor_id` = that SME, not the box `ownerId`.
- An internal-devbox route test: a task on a session created with a stewarded
  `projectId` writes an `agent_loop` entry with that `initiative_id` and
  `actor_id = requestedBy`; a task on an auto-registered box writes
  `initiative_id = NULL`.
- A result with no `total_cost_usd` raises `spendUnknownCount` and leaves the
  known sum unchanged.
- `scripts/validate-mock-floor.sh` is green with no `spendUsd` literal left in
  `middleware/src/mock/devbox-fleet.ts` (`grep -c 'spendUsd:'` returns 0).
