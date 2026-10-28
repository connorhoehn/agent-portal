# DE-30 One spend ledger for every run path

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Unblocks DE-31, DE-34, DE-35, DE-36, DE-53.

## Current state (read from the code, 2026-10-27)

Budget spend is derived at read time from `bot_runs.cost_usd`
(`schema/agent_budgets_schema.sql` header; `spendPredicateSql`,
`middleware/src/providers/budgets.ts:110`). A run belongs to an initiative
through its work item, a bot targeting the initiative, or a bot targeting a
codebase that delivers it. Every `bot_runs` insert comes from
`lib/bot-runner.ts` (`createBotRun`, nine call sites) or
`lib/pr-watch-poller.ts:189`.

Three paths spend Bedrock money on a box without writing a `bot_runs` row:

| Path | Where the cost lands | Seen by a budget? |
|------|----------------------|-------------------|
| `POST /api/devbox/:sid/task` (`routes/devbox.ts:642`) | box lifetime `spendUsd` (`devbox_boxes.spend_usd`) | no |
| `POST /internal/devbox/:sid/task` (platform-api's chat agent loop) | same | no |
| `POST /api/work/jobs`, `POST /api/work/findings/:id/promote` → `job-dispatcher.ts:101` | `agent_jobs.result->>'costUsd'` | no |

Two facts constrain the design:

- **Bot runs execute on boxes too** (`bot-runner.ts` registers boxes and
  appends events). A box's `spendUsd` already includes bot-run cost, so adding
  box totals to `bot_runs` would count the same dollar twice. The unit of
  record must be one task attempt, not a box.
- **Cost can be unknown.** `run-cost.ts` returns `null` when Claude Code
  reports no figure; local runs record $0. DE-33 owns what unknown means for
  enforcement; the ledger must keep "unknown" distinct from zero.

## Change

An append-only `spend_entries` table, written once per finished task attempt
by whichever path ran it, and read by every budget, envelope and report query.

```sql
CREATE TABLE IF NOT EXISTS spend_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('bot_run','job','box_task','agent_loop')),
  source_id      TEXT NOT NULL,      -- bot_runs.id | agent_jobs.id:<attempt> | <boxId>:<taskSeq>
  initiative_id  TEXT REFERENCES projects (id) ON DELETE SET NULL,  -- null = unattributed
  grant_id       TEXT REFERENCES budget_grants (id) ON DELETE SET NULL,  -- when dispatched under a grant
  box_id         TEXT,
  actor_id       TEXT,               -- who caused the spend (session sub or principal.requestedBy)
  model          TEXT,
  cost_usd       NUMERIC(10,4),      -- NULL = cost unknown, never coerced to 0
  cost_basis     TEXT NOT NULL CHECK (cost_basis IN ('reported','estimated','unknown')),
  input_tokens   BIGINT, output_tokens BIGINT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id)         -- a retried write is a no-op, not a second charge
);
CREATE INDEX IF NOT EXISTS spend_entries_initiative_idx ON spend_entries (initiative_id, occurred_at);
CREATE INDEX IF NOT EXISTS spend_entries_grant_idx ON spend_entries (grant_id, occurred_at);
```

**One writer module** (`providers/spend-ledger.ts`, `recordSpend(entry)`,
`INSERT … ON CONFLICT (source, source_id) DO NOTHING`), called from:

1. `settleBotRun` (`providers/bots.ts:1089`): `source='bot_run'`, initiative
   resolved once at write time with the existing three-way rule, so readers
   stop re-deriving it.
2. `job-dispatcher.ts` beside `completeJob`: `source='job'`, keyed by job id
   and attempt; initiative from the job's work item or finding
   (`initiativeIdForFinding`, already used by the promote route).
3. `runTaskAndForward` on the terminal result frame, **only when the task is
   not already owned by a bot run or job** (the caller passes an owner; the
   ad-hoc routes pass none): `source='box_task'` or `'agent_loop'` for the
   internal router, initiative = the box's `projectId` (checked at box
   creation since DE-44), actor = session sub or `principal.requestedBy`.

**Readers move to the ledger:** `spendPredicateSql` and the four
`SUM(br.cost_usd)` queries in `budgets.ts` read
`SUM(cost_usd) FROM spend_entries WHERE initiative_id = …`;
`dispatchedSpendInWindow` (the envelope brake) reads `grant_id`. Unknown-cost
rows are counted separately (`COUNT(*) FILTER (WHERE cost_usd IS NULL)`) and
surfaced, never summed as zero.

**Migration:** additive schema registered in both loaders; a backfill script
writes `bot_run` entries from existing `bot_runs` (idempotent by the unique
key) and `job` entries from `agent_jobs.result`. Box tasks before the cutover
cannot be split per task and stay out, recorded as a known gap. Order: apply
schema, backfill dry-run, backfill, deploy the BFF with dual-read
(`SPEND_LEDGER=read`) that logs any initiative whose ledger and legacy sums
differ, then cut over.

**Mock floor:** a registered `spend_entries` fixture derived from the
`bot_runs` fixture rows (never a stored total, per `docs/mock-floor.md`), so
`POST /api/__mock/reset` restores it.

## Decisions owed

- Do ad-hoc box tasks with no initiative count against anything? Proposal:
  they land unattributed and show as a per-user "unattributed spend" line on
  the release manager's view, without blocking.
- Backfill window: all history, or the current budget period only.

## Done when

- `spend_entries` exists in both loaders; `validate-mock-floor.sh` stays green.
- A unit test per writer path (bot run, job, ad-hoc box task, internal agent
  loop) asserts exactly one entry, with initiative, actor and cost basis, and
  that a bot-run task on a box writes no second `box_task` entry.
- A retried write (same `source`, `source_id`) leaves one row.
- Budget, envelope and Projects-rollup tests pass against the ledger, and a
  dual-read test shows ledger and legacy sums equal on the seed.
- A job with `costUsd: null` produces `cost_basis='unknown'` and appears in the
  unknown count, not as $0.
