# DE-39 The bot-fire allocation brake

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Mostly built; this spec covers the gaps. Depends on DE-30 and DE-34; reads
DE-38's effective allocation once that lands.

## Current state (read from the code, 2026-10-27)

**The backlog line is stale.** It says the brake is "documented as not built"
and cron firings spend unchecked "unless opted in". The opt-in has existed
since `9f152cfc` (2026-08-26, "feat(bots): opt-in bot-fire allocation brake"):

- Column `bots.enforce_allocation BOOLEAN NOT NULL DEFAULT FALSE`
  (`schema/agent_bots_schema.sql:55`, plus the idempotent `ALTER` at `:112`).
- Provider mapping and writes (`providers/bots.ts:92`, `:152`, `:586`, `:606`,
  `:677`), wire snapshots (`mock/core/wire/snapshots/wire.json:2139`).
- `PATCH /api/bots/:id` accepts it (`routes/bots.ts:682-686`); the bot page's
  Guardrails form has an "Enforce initiative allocation" checkbox
  (`portal/src/pages/bots/BotDetailPage.tsx:638-645`).
- The pure decision `decideBotFireAllocation` (`lib/bot-runner.ts:166`) and its
  use in `fireBot` (`:943-960`): for `trigger === 'cron'` on an opted-in bot it
  resolves the initiative (`resolveBotInitiativeId`, `:878`), reads
  `getBudget`, projects p75 through the shared forecast selector
  (`botFireProjectionP75`, `:896`), and on overrun records a `skipped`
  `bot_run` with the reason. Never a self-pause.
- Tests: `bot-runner.test.ts:433` (`decideBotFireAllocation`) and `:629`
  (`fireBot — opt-in allocation brake`), `providers/__tests__/bots.test.ts:39-73`.

`docs/program-operating-model.md:295-300` still lists it under "Not built yet"
("for when a `bots.enforce_allocation` flag is added"). The doc is wrong.

What is actually open:

1. **Create ignores the flag.** `POST /api/bots` (`routes/bots.ts:633-643`)
   does not pass `enforceAllocation` to `createBot`, which accepts it
   (`providers/bots.ts:586`). A bot can only be opted in after creation.
2. **PR-watch bots are never braked.** The poller enqueues `agent_jobs`
   directly (`pr-watch-poller.ts:206-215`, "the queue rather than fireBot"), so
   the flag does nothing for them. The `fireBot` comment (`bot-runner.ts:942`)
   calls `pr_watch` "hand-driven"; it is the automatic poller.
3. **Spend excludes in-flight runs.** `getBudget().spentThisPeriodUsd` sums
   settled `bot_runs.cost_usd` only. The boot catch-up fires every stale cron
   bot in one loop (`bot-scheduler.ts:133-137`), and each sees the same
   remaining money. Box tasks and queue jobs are invisible until DE-30.
4. **Fail-open on a missing table.** `getBudget` goes through `safeExec`,
   which turns "relation does not exist" into no rows (`budgets.ts:426-433`);
   no row reads as unbudgeted and the brake proceeds. That is DE-36's rule to
   change, noted here because this brake inherits it.
5. **Off by default**, by an argued choice (`bot-runner.ts:106-136`): cron
   bots are the maintenance floor that `v_initiative_maintenance_30d` reads an
   allocation against. Nothing in the code is wrong about that; whether it
   should stay the default is a user decision.

## Change

- **Docs:** move the entry out of "Not built yet" in
  `program-operating-model.md`, describing the opt-in, the skip-not-pause
  outcome and the cron-only scope; correct the backlog line.
- **Create:** add `enforceAllocation` to the `POST /api/bots` body and to
  the create form; validate it as a boolean through `checkFieldTypes`.
- **PR-watch:** call `decideBotFireAllocation` in the poller before
  `dispatchPrRun` for an opted-in bot. On skip, record one skipped run for the
  batch and leave the watermark (the PRs are deferred, the same handling the
  concurrency refusal at `pr-watch-poller.ts:313-318` uses), so they dispatch
  when the period resets or the allocation rises. Fix the comment at
  `bot-runner.ts:940-942`.
- **Spend input:** read `spent` from `spend_entries` (DE-30) plus the
  initiative's open reservations (DE-34), and the allocation as DE-38's
  `effectiveAllocatedUsd`. The catch-up loop then sees each earlier firing's
  reservation. Until DE-34 ships, the brake adds the p75 projection of the
  initiative's `running` bot_runs to `spent`, since a settled-only sum lets
  every firing in one catch-up pass see the same remainder.
- **Visibility:** the bot list and the initiative ledger show which bots are
  braked by allocation and how many firings were skipped this period
  (`COUNT(*) FILTER (WHERE status='skipped' AND outcome->>'reason' LIKE
  'initiative allocation%')`, or a `skip_kind` in `outcome` to avoid matching
  on prose).

## Decisions owed

- Keep the default off? Proposal: keep it off for existing bots and default
  it on for new bots created by an SME (whose spend should sit inside the
  release manager's envelope), off for bots created by a program owner or
  org leader. Folding it into the DE-40 policy profile later makes this one
  setting there.
- Should an exhausted allocation brake cron firings even with the flag off
  once DE-36's hard cap is set? Proposal: yes. The hard cap is
  non-overridable by design; the flag governs the soft allocation only.
- Who may flip the flag? Today any `ManageBots` holder (`routes/bots.ts:51`).
  Proposal: turning it off requires `ManageBudgets`, so an SME cannot unbrake
  their own maintenance spend.

## Done when

- `program-operating-model.md` no longer lists the brake as unbuilt, and
  `scripts/validate-*.sh` that grep that doc stay green.
- A route test creates a bot with `enforceAllocation: true` and reads it back
  true.
- A poller test: an opted-in PR-watch bot on an exhausted initiative records
  one skipped run, dispatches nothing, and leaves the watermark unchanged; a
  bot with the flag off dispatches.
- A catch-up test: two opted-in cron bots on one initiative with room for
  one firing; exactly one dispatches and one is skipped.
- Existing `decideBotFireAllocation` and `fireBot — opt-in allocation brake`
  tests pass unchanged (`cd middleware && npx jest src/lib/__tests__/bot-runner.test.ts`).
