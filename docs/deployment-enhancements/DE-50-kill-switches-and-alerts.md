# DE-50 Kill switches and alerts for the agent fleet

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Uses DE-30's ledger for per-initiative spend once it lands, DE-47's leader
lock for the sweep that emits fleet gauges, and DE-48's task-overrun reason.

## Current state (read from the code, 2026-10-27)

The backlog line is accurate. Specifics:

- **No fleet-wide or per-initiative pause exists.** The only pause is per bot:
  `bots.paused_reason`, checked first in `decideFire`
  (`middleware/src/lib/bot-runner.ts:88-90`), set by the daily-budget brake
  (`:922-923`) and filtered in the PR-watch query (`lib/pr-watch-poller.ts:158`).
  The ad-hoc box paths, the job dispatcher and the agent-project runs have no
  pause at all. The global concurrency ceiling (`botMaxConcurrent`, default 3,
  `bot-runner.ts:203-226`) counts bot runs only.
- **The reaper's only output is `console.warn`** (`lib/devbox-reaper.ts:130`,
  `:141`, `:146`) plus a `devbox_reaped` event in the box's own buffer (`:121`).
  A box it cannot stop, the one still costing money, is a warn line nobody reads.
- **Spend is accrued per box in memory** (`lib/devbox-fleet.ts:555-566`) and
  per bot run in `bot_runs.cost_usd`; nothing turns either into a metric.
- **Budget alerts are account-wide only.** `OrgIQ-Observability` has one AWS
  Budget at 80 % / 100 % actual and 120 % forecast, no 50 %
  (`infra/lib/observability-stack.ts:274-310`), and the `<prefix>-alerts` SNS
  topic (`:36-43`). Nothing alerts per initiative against
  `initiative_budgets.allocated_usd`.
- **The alarm pattern to copy exists.** The realtime gateway writes one JSON
  line a minute (`lib/gateway/stats.ts`), and `middleware-service-stack.ts:1385-1436`
  turns its fields into `OrgIQ/RealtimeGateway` metrics with
  `logs.MetricFilter` on `/ecs/<prefix>-middleware` (`:258-262`) and alarms via
  `realtimeAlarm` (`infra/lib/realtime-alarms.ts`). The task role already has
  `cloudwatch:PutMetricData` (`:706-711`), though metric filters do not need it.

## Change

### Pause switches

An additive table `fleet_switches (scope TEXT PRIMARY KEY, paused BOOLEAN,
reason TEXT, set_by TEXT, set_at TIMESTAMPTZ)`; `scope` is `'fleet'` or
`'initiative:<id>'`. One module `lib/fleet-switches.ts` holds a 10 s cached
read and `assertSpendAllowed({ initiativeId })`, throwing a 423 `AppError`
naming the scope and reason. A registered mock fixture backs it offline.

Checked at every place that starts or queues model spend:

| Path | Check at |
|------|----------|
| Box task, portal | `runTaskAndForward`, `routes/devbox.ts:569` (covers `:642`) |
| Box task, platform-api agent loop | same function via `routes/internal-devbox.ts:196` |
| Dispatcher | `tick`, `lib/job-dispatcher.ts:123`, before claiming (paused = no claims) |
| Dispatcher run | `executeDevboxTask`, `lib/devbox-runner.ts:120` (the second InvokeRuntime chokepoint) |
| Cron and manual bot fire | `decideFire`, `bot-runner.ts:88`, as a `refuse` (not a self-pause) |
| Work-item dispatch | `dispatchWorkItem`, `bot-runner.ts:1190` |
| PR watch | the query at `pr-watch-poller.ts:158` joins `fleet_switches` |
| Agent-project runs | `routes/agent-projects.ts:113` |

A fleet pause also makes the reaper stop every **idle** cloud box at the next
sweep; running tasks finish (they are bounded by DE-48). An "emergency stop"
variant (`stopRunning: true`) also stops running boxes through the same
`StopRuntimeSession` path, with reason `paused`.

Flipping a switch: `PUT /api/ops/switches/:scope`, new Cedar action
`PauseFleet` granted to `org-leader` (initiative scope) and `admin` (fleet
scope), added to `CAPABILITY_ACTIONS` (`lib/authz.ts:34`) or every control
behind it hides. Every flip writes an audit row and an Activity-bell event.

### Metrics (namespace `OrgIQ/DevboxFleet`)

Emitted as JSON lines on stdout, extracted by metric filters on
`/ecs/<prefix>-middleware`, the same way as the gateway line:

| Metric | Dimensions | Emitted from |
|--------|-----------|--------------|
| `SpendUsd` (Sum) | none; `InitiativeId` once DE-30 lands | line `devbox-spend` at the cost accrual, `devbox-fleet.ts:566`; moves to `recordSpend` with DE-30 |
| `ReaperKills` (Sum) | `Reason` = idle, max-lifetime, task-overrun, paused | line `devbox-reaped`, replacing `console.warn` at `devbox-reaper.ts:130` |
| `ReaperStopFailures` (Sum) | none | line `devbox-reap-failed` at `devbox-reaper.ts:146` |
| `RunningBoxes`, `LiveBoxes` (Max) | none | line `devbox-fleet-stats`, once a minute from the reaper's leader tick |
| `StuckRuns` (Max) | none | same line: boxes `running` past `taskMax + grace` (DE-48) plus `agent_jobs` claimed past `JOB_STALE_MINUTES` (`job-dispatcher.ts:38`) |
| `BudgetThresholdCrossed` (Sum) | `Threshold` = 50, 80, 100 | line `budget-threshold`, from a leader sweep over `providers/budgets.ts` rows |
| `FleetPaused` (Max, 0/1) | none | the stats line |

Per-initiative thresholds are data, so they cannot be static alarms. The
budget sweep records `last_threshold_notified` per initiative and period
(additive column on `initiative_budgets`), emits one line per crossing, posts
to the bell, and the alarm is on the count.

### Alarms (`--context fleetAlarms=true`, `OrgIQ-MiddlewareService`)

Through `realtimeAlarm` into the `<prefix>-alerts` topic, imported by name:
`devbox-spend-rate` (SpendUsd Sum over 15 min > `fleetSpendRateUsd`, default
$10); `devbox-budget-100` (threshold 100 crossed, 1 period);
`devbox-budget-80` and `-50` (notify only); `devbox-stuck-runs` (> 0 for 3
periods); `devbox-reap-failures` (> 0 in 5 min); `devbox-reaper-silent`
(no stats line for 10 min, breaching on missing data); `devbox-paused` (= 1,
OK action announces the resume).

## Decisions owed

- **Auto-pause on 100 %?** Proposal: yes for the initiative scope (writes
  `fleet_switches` with reason `budget`), no automatic fleet-wide pause; the
  spend-rate alarm pages a human instead.
- **Default spend-rate threshold.** Proposal: $10 per 15 min until there is a
  week of real data, then p99 of observed 15-minute spend times two.
- **Who can lift a budget auto-pause.** Proposal: the release manager
  (`ManageBudgets`), not the SME who spent it.

## Done when

- Unit tests: `assertSpendAllowed` refuses with 423 for fleet and for a matching
  initiative; each path in the table refuses before any `InvokeRuntime` call
  (mock client asserts zero sends).
- `npx jest src/lib/__tests__/devbox-fleet.test.ts` asserts the reaper writes a
  `devbox-reaped` JSON line with `reason`, and no `console.warn` remains in
  `devbox-reaper.ts` for a successful stop.
- A budget sweep test crosses 50, 80, 100 once each per period and never twice.
- infra `npx jest test/middleware-service-stack.test.ts` with `fleetAlarms=true`
  finds the metric filters in `OrgIQ/DevboxFleet` and each alarm name above,
  wired to the `<prefix>-alerts` topic.
- `GET /api/session/capabilities` lists `PauseFleet` for `org-leader`.
- `scripts/validate-mock-floor.sh` stays green with the `fleet_switches` fixture.
