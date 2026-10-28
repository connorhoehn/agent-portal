# DE-37 Rate and concurrency limits per initiative

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-30 (spend ledger); pairs with DE-34 (reservations) and DE-47
(fleet state across replicas).

## Current state (read from the code, 2026-10-27)

There is one limit, and it is global. `botMaxConcurrent()`
(`middleware/src/lib/bot-runner.ts:203`) reads `BOT_MAX_CONCURRENT`, default 3,
and `decideConcurrency` (`:216`) compares it with `countRunningRuns()`
(`providers/bots.ts:1158`), a count of every `bot_runs` row in `running`
within 24 h. Four paths consult it: `fireBot` (`bot-runner.ts:966`),
`dispatchWorkItem` (`:1215`, answers 429), the PR-watch poller
(`pr-watch-poller.ts:313`, defers), and the `running` insert itself, which
passes `ceiling` to `createBotRun` (`bot-runner.ts:1015`, `:1036`, `:1291`,
`:1459`).

What the backlog line does not say:

- **The "atomic" insert is not atomic.** `createBotRun`
  (`providers/bots.ts:1065-1077`) does `INSERT … SELECT … WHERE (SELECT
  COUNT(*) …) < :ceiling` and its comment calls it TOCTOU-safe. Under Postgres
  READ COMMITTED two concurrent statements each see the other's row as
  uncommitted, so both pass at count 2 against a ceiling of 3 and the fleet
  runs 4. Nothing serialises them (no row lock, no advisory lock).
- **Queue jobs are outside the count.** `job-dispatcher.ts:140-148` claims one
  job per idle box (`claimNextJob`, `providers/agent-jobs.ts:520`, `FOR UPDATE
  SKIP LOCKED` on priority then age). The only bound is how many boxes are
  idle. Ad-hoc `/api/devbox/:sid/task` and `/internal/devbox` tasks are bounded
  by nothing but the box busy flag.
- **Jobs carry no initiative column.** `agent_jobs`
  (`schema/agentic_work_schema.sql:19-50`) has `payload` JSONB; `POST
  /api/work/jobs` puts `initiativeId` there only when a work item is named
  (`servedWorkItem`, `routes/work.ts:168-180`). A claim cannot filter on it
  cheaply.
- **Per-bot limits exist, per-initiative do not.** `bots.max_runs_per_day`
  and `budget_per_day_usd` (`schema/agent_bots_schema.sql:42-43`) are judged
  per bot in `decideFire` (`bot-runner.ts:88`). Ten bots on one initiative get
  ten daily caps and no shared one.
- **"Per tenant" has one tenant to apply to.** `/api/bots`, `/api/work` and
  `/api/budgets` mount behind `requireTenant('orgiq')` (`index.ts:411`, `:520`,
  `:396`); `/api/devbox` is role-gated with no tenant (`index.ts:505-509`).
  No other tenant dispatches devbox work today.
- The existing `rateLimit` helper (`lib/rate-limit.ts:34`) is per-IP,
  in-memory and per-replica; it is the wrong tool for money.

## Change

**One limits table, scoped.** Absent row = no limit beyond the global ceiling.

```sql
CREATE TABLE IF NOT EXISTS run_limits (
  scope_kind     TEXT NOT NULL CHECK (scope_kind IN ('global','tenant','initiative')),
  scope_id       TEXT NOT NULL,          -- '*' | tenant id | projects.id
  max_concurrent INTEGER CHECK (max_concurrent >= 0),   -- 0 = paused
  max_runs_per_day INTEGER CHECK (max_runs_per_day >= 0),
  max_usd_per_hour NUMERIC CHECK (max_usd_per_hour >= 0),
  updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_kind, scope_id)
);
CREATE TABLE IF NOT EXISTS run_slots (
  scope_key   TEXT NOT NULL,             -- 'global:*' | 'initiative:p-…'
  slot_no     INTEGER NOT NULL,
  holder      TEXT NOT NULL,             -- bot_runs.id | agent_jobs.id | <boxId>:<taskSeq>
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_key, slot_no)
);
```

`BOT_MAX_CONCURRENT` seeds the `global` row on first read and stays as the
fallback when the table is absent.

**Concurrency is a slot lease, not a count.** `acquireSlots(holder,
scopeKeys[])` inserts the lowest free `slot_no` below the scope's limit per
key; the primary key, not a snapshot read, is what refuses the loser (a
conflict retries once, then refuses). All keys are taken in a fixed order and
released together on settle. `expires_at` is renewed by the same heartbeat
`maintainJobAttempt` already runs for jobs and by bot-run reconcile; the
reaper frees expired slots. This replaces the `INSERT … WHERE COUNT` at
`providers/bots.ts:1065` and holds across replicas without in-process state.

**Every spending path acquires.** `fireBot`, `dispatchWorkItem`, PR-watch
enqueue, the job dispatcher (after `claimNextJob`, before `markRunning`; on
refuse the job goes back to `queued` without burning an attempt), and
`runTaskAndForward` for ad-hoc and internal tasks. To make the job path
cheap, `agent_jobs` gains `initiative_id TEXT` (additive, stamped at enqueue
from the work item, finding or bot; backfilled from `payload->>'initiativeId'`)
and `claimNextJob` skips jobs whose initiative is at its limit with `AND
initiative_id NOT IN (<saturated set>)`, so one hot initiative cannot hold the
queue head.

**Rate limits read the ledger.** Runs per day and dollars per hour are
`COUNT(*)` and `SUM(cost_usd)` from `spend_entries` (DE-30) for the scope,
plus slots currently held (a running task counts as one run now; its dollars
count once DE-34 reserves them). A pure `decideRunLimits(limits, usage)`
returns `proceed` or `refuse` with the scope and limit named; cron and
PR-watch record a skipped run, humans get 429 with `Retry-After`.

**API and UI:** `GET/PUT /api/budgets/:orgProjectId/limits` behind the same
`manageGate` as allocations; the initiative pane shows "2 of 3 slots, 4 of 10
runs today".

## Decisions owed

- Is a limit hit a hard refuse or a confirmable 409 for humans? Proposal:
  hard. Limits protect the fleet and the rate of spend, not a forecast, so
  there is nothing for a confirm to vouch for.
- Do ad-hoc box tasks take a slot? Proposal: yes for the initiative scope
  when the box has a `projectId`, never for the global scope, so a person
  typing into their own box is not blocked by a cron storm.
- Tenant scope: build the column now with only `orgiq` populated, or drop it
  until a second tenant dispatches devbox work. Proposal: keep it; it costs one
  CHECK value.
- Defaults for initiatives with no row. Proposal: none (global ceiling only),
  so behaviour is unchanged until a release manager sets one.

## Done when

- `run_limits` and `run_slots` in both loaders; `validate-mock-floor.sh` green
  with registered fixtures for both.
- A Postgres-backed test (the `*-postgres.test.ts` harness) fires N parallel
  `acquireSlots` against a limit of 3 and asserts exactly 3 holders; the same
  test against today's `createBotRun` ceiling is recorded as the regression it
  replaces.
- Unit tests for `decideRunLimits` per scope and per limit kind, and for the
  job dispatcher returning a refused claim to `queued` with `attempts`
  unchanged.
- With an initiative limit of 1, a second `POST /api/bots/dispatch-work` on
  that initiative answers 429 naming the initiative, while a dispatch on a
  different initiative proceeds.
- An expired slot is freed by the reaper and the next acquire succeeds.
