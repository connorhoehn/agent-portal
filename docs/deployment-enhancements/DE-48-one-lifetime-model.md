# DE-48 One lifetime model for a box and its tasks

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Feeds DE-40 (policy profiles); reads the shared box record from DE-47 when it
lands, but does not wait for it.

## Current state (read from the code, 2026-10-27)

Five clocks, set in four places, none of which knows about the others:

| Clock | Value | Where |
|-------|-------|-------|
| Reaper idle | 20 min since `lastActivityAt`, skipped while `running` | `middleware/src/lib/devbox-reaper.ts:30-31`, `:84-89` |
| Reaper ceiling | 60 min since box `createdAt`, applies even while `running` | `devbox-reaper.ts:34-35`, `:76-80` |
| Task timeout | 840 s default, 3300 s cap, process-group kill | `agents/devbox/main.py:48-49`, `:315` |
| Task cap, again | `Math.min(timeout, 3300)` | `routes/devbox.ts:583`, `lib/devbox-runner.ts:138` |
| AgentCore runtime | idle 3600 s, `maxLifetime` 28800 s (8 h) | `infra/lib/devbox-stack.ts:233-236` |
| Dispatcher stale claim | 30 min without a heartbeat | `lib/job-dispatcher.ts:38` |

The backlog line is right, and the collision is worse than "a long task can be
killed", because the ceiling is measured from the **box's** creation, not the
task's start, and boxes are reused:

- The dispatcher pushes a job onto any `idle`/`waiting` box regardless of age
  (`lib/job-dispatcher.ts:140-141`), and `ensureWorkspace` reuses a codebase's
  existing box whenever it is not busy (`lib/bot-runner.ts:816-824`). A job
  landing on a 50-minute-old box has 10 minutes before the reaper stops the
  session under it, whatever its own timeout says.
- A portal task can ask for 3300 s (55 min) on a fresh box and still be cut at
  60 min of box age if the box spent more than 5 minutes being provisioned or
  used before it.
- The dispatcher path passes no timeout at all (`routes/devbox.ts:933-988`
  never forwards one), so queued jobs get the 840 s default.
- No env or CDK sets `DEVBOX_MAX_LIFETIME_MINUTES` or
  `DEVBOX_IDLE_TIMEOUT_MINUTES` (`infra/lib/middleware-service-stack.ts` has
  neither), so the deployed values are the defaults above.

Two comments are stale: the reaper header says the platform's own expiry is
"fourteen idle days" (`devbox-reaper.ts:5`, and "14-day idle" at `:133`). The microVM
stops after 1 h idle (`devbox-stack.ts:234`); 14 days is the session-storage
retention, which is a different thing.

The 8 h AgentCore cap is not a constraint in practice: the reaper's 60 min is
always tighter. The streaming invoke is the real outer bound on one task
(`main.py:49`, "under the 60-min streaming connection cap").

## Change

One module, `middleware/src/lib/devbox-lifetime.ts`, owns every number above
except AgentCore's own, and exports a pure `lifetimePolicy(profile)` returning
`{ idleMs, boxCeilingMs, taskDefaultS, taskMaxS, graceMs }`. The rule set:

1. **The ceiling measures continuous work, not box age.** A box records
   `taskStartedAt` at `task_started` (`devbox-fleet.ts` status machine, beside
   `contextTokens` reset). `decideReaping` reaps `running` boxes when
   `now - taskStartedAt >= taskMaxS + graceMs` (a task that outlived its own
   timeout plus grace is stuck, which is the case the ceiling exists for), and
   reaps any box older than `boxCeilingMs` only when it is **not** running.
2. **Invariants, asserted at boot and in tests:** `taskMaxS * 1000 + graceMs <=
   boxCeilingMs`; `boxCeilingMs <= 28_800_000` (AgentCore maxLifetime);
   `idleMs < 3_600_000` (AgentCore idle, so the reaper stops it before the
   platform silently does). A violating env combination logs and falls back to
   defaults rather than booting with a hole.
3. **Claims respect remaining life.** The dispatcher and `ensureWorkspace` skip
   a box whose `boxCeilingMs - age < taskDefaultS + graceMs`, and mint a fresh
   one instead. `timeLeft()` (`devbox-reaper.ts:172`) reports `taskMsLeft` too.
4. **One cap in the middleware.** `routes/devbox.ts:583` and
   `devbox-runner.ts:138` call `clampTaskTimeout()`; the dispatcher passes
   `taskDefaultS` explicitly. `main.py` keeps its own `MAX_TIMEOUT_S` as the
   container's defence, with a comment naming the module that must agree.
5. **Profile-driven.** `profile` is `'default'` until DE-40 exists; DE-40 then
   supplies per-initiative values, bounded by the invariants above. Env vars
   remain as deploy-wide overrides of the default profile, now set explicitly
   in `middleware-service-stack.ts` so the deployed value is visible in CFN.
6. Fix the two stale "fourteen idle days" comments.

Defaults proposed: idle 20 min, task default 840 s, task max 3300 s, grace
5 min, box ceiling 4 h.

## Decisions owed

- **Box ceiling for an idle-but-reused box.** Proposal: 4 h, so a codebase's
  checkout survives a working session; the idle timer still stops a forgotten
  box after 20 min, and storage outlives the stop (DE-49).
- **Should a running task ever be killed before its own timeout?** Proposal:
  no; the only reaper kill of a running box is "past its own timeout plus
  grace". A runaway that stays inside 55 min is DE-50's spend-rate alarm's job.

## Done when

- `cd middleware && npx jest src/lib/__tests__/devbox-fleet.test.ts` passes with
  cases: a 50-minute-old idle box that starts a 3300 s task is not reaped at
  60 min; a running box past `taskMaxS + grace` is reaped with reason
  `task-overrun`; an idle box past `boxCeilingMs` is reaped.
- A `devbox-lifetime` unit test asserts the three invariants and that a bad env
  combination falls back to defaults.
- `npx jest src/lib/__tests__/job-dispatcher.test.ts` shows the dispatcher
  skipping a box with too little life left and passing an explicit timeout.
- `grep -rn "3300" middleware/src --include='*.ts'` hits only `devbox-lifetime.ts`
  and tests.
- `grep -nE "fourteen idle days|14-day idle" middleware/src/lib/devbox-reaper.ts` is empty.
- infra `npx jest test/middleware-service-stack.test.ts` asserts the lifetime
  env vars are present in the task definition.
