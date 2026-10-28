# DE-35 Mid-run spend cutoff

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-34 (the hold is the ceiling) and DE-32 (Claude token prices).

## Current state (read from the code, 2026-10-27)

The backlog line points at the right files but misreads two of them.

- **Dollars arrive only at the end.** `appendEvent` (`lib/devbox-fleet.ts:495`)
  adds to `spendUsd` only on the `result` event (`:550-567`), which Claude Code
  emits once, as the run finishes. A check placed there would fire after the
  money is spent. What does arrive mid-run is token usage: every `assistant`
  event carries `message.usage`, and `extractUsage` (`:454`) already sums fresh
  tokens into `tokensUsed` (`:525-529`). A mid-run meter has to price tokens.
- **Tokens cannot be priced yet.** `BEDROCK_PRICING` (`lib/pricing.ts:19`)
  holds Nova and Titan only, and `estimateCost` returns `0` for an unknown model
  (`:38-41`), so a Claude meter built on it today would read $0 and never trip.
  DE-32 is a hard prerequisite.
- **The kill exists but only the box can pull it.** `agents/devbox/main.py`
  starts Claude Code with `start_new_session=True` (`:197-204`) and
  `_kill_process_group` sends `SIGKILL` to the group (`:67-76`), but the only
  caller is the box's own deadline (`:207-221`, `DEVBOX_TASK_TIMEOUT_S` 840 s,
  max 3300 s, `:48-49`). The payload contract (`:296-303`) has no cancel or
  budget field.
- **Aborting from the BFF does not stop Claude Code.**
  `executeDevboxTask` accepts an `AbortSignal` and hands it to
  `InvokeAgentRuntime` (`lib/devbox-runner.ts:143-162`). Closing the stream may
  or may not reach the container (unverified for AgentCore), and even if the
  generator is cancelled, `_run_streaming` has no `try/finally` that kills the
  process group, so Claude Code keeps running and billing. The governed run
  path passes no signal at all (`lib/project-runner.ts:169`); the job path does
  (`lib/job-dispatcher.ts:90`).
- **Session stop is real and already used.** The reaper stops a whole session
  with `StopRuntimeSessionCommand` (`lib/devbox-reaper.ts:125`); the session
  mount survives stop/resume (`main.py` header, lines 17-20).
- **Over-budget after the fact is a flag on bots only.** `overRunBudget` is set
  from `bots.budget_per_run_usd` (`lib/bot-runner.ts:1670`, `:1778`). The
  marketplace dispatch's `budgetPerRunUsd` is never persisted (it is not passed
  to `dispatchWorkItem`, `routes/bots.ts:381`), and those runs have `bot_id`
  NULL, so the join at `:1735` yields NULL and the flag can never fire for them.

## Change

Three layers, each one sufficient on its own, cheapest first.

**1. The box enforces a token ceiling it is given.** The payload gains
`budget: { max_fresh_tokens: int, reason_ref: str }`. `_run_streaming` sums
`input + cache_creation + output` from each parsed event's `usage` (the same
rule as `extractUsage`) and, when the sum crosses the ceiling, calls
`_kill_process_group` and sets `killed = 'budget'`. `devbox_end` gains
`killed_reason: 'timeout' | 'budget' | 'cancelled' | null`. The BFF converts
dollars to tokens with the model's DE-32 price (output price, the pessimistic
rate), so the box needs no price table. Also wrap the read loop in
`try/finally` that kills the group on `GeneratorExit`/`CancelledError`, so a
closed stream stops the work if AgentCore propagates it.

**2. The BFF meters and aborts.** `executeDevboxTask` gains `meter?: {
ceilingUsd, price }`; each event with usage updates `meteredUsd` and, at 80 %
of the ceiling, calls `onNearCeiling` (DE-34 top-up, below). At 100 % it
aborts its own controller. `project-runner.ts:169` starts passing a signal.

**3. Backstop: stop the session.** If no `devbox_end` arrives within 30 s of
an abort, send `StopRuntimeSessionCommand` for the box's session (the
reaper's call), append `{ type: 'devbox_reaped', reason: 'budget' }` and
`markStopped`. The working tree survives; the box's next task resumes it.

**The ceiling is the DE-34 hold.** At 80 % the meter asks `reserveSpend` for a
`basis='topup'` hold of one more p75 under the same lock and brakes; granted
raises the ceiling, refused leaves it. Confirmed-over dispatches get the same
treatment; the confirmation covered the start, not unbounded spend.

**Recorded reason.** A cut run settles `failed` with `outcome.cutoff = {
reason: 'budget', ceilingUsd, meteredUsd, holdIds }`; the job result carries
the same block; the work item gets a system comment ("stopped at $X of its $Y
hold; raise the allocation or re-dispatch"). The ledger entry (DE-30) uses
Claude Code's `total_cost_usd` if the `result` event arrived, else the metered
figure with `cost_basis='estimated'`. Persist `budgetPerRunUsd` on the marketplace
`bot_runs.outcome` so the existing `overRunBudget` flag works for those runs.

Local-compute runs (`modelProvider: 'local'`) are not metered: they cost $0.

## Decisions owed

- Ceiling: proposal, the hold plus automatic top-ups while the allocation and
  envelope have room; a run is cut only when a top-up is refused.
- Kill strength: layer 1 kills the task, layer 3 the session. Proposal: both,
  in that order; a session stop is rare and recoverable.
- What a cut run leaves behind: proposal, keep the working tree and capture its
  diff as a failed run's partial change, never auto-commit it.

## Done when

- `agents/devbox` unit test: a fake `claude` that streams usage lines is
  killed when `max_fresh_tokens` is crossed; `devbox_end.killed_reason ==
  'budget'`, and its child process is gone.
- Same test: cancelling the generator mid-stream kills the process group.
- Jest: `executeDevboxTask` fed a scripted stream aborts at the ceiling and
  calls the stop-session client once when no `devbox_end` follows within the
  grace period (fake timers).
- Jest: a dispatch whose meter crosses 80 % with room left gets a `topup` hold
  and finishes; with no room it is cut, settles `failed` with
  `outcome.cutoff.reason == 'budget'`, and the work item has the comment.
- A marketplace run with `budgetPerRunUsd` set and a higher actual cost
  settles with `overRunBudget: true`.
