# Spend map: what costs money, what reaches the ledger, and what the BFF can carry

Read-only analysis, 7 November 2026, against `main` (fa5a4ec1) and the capacity
notes at `5b6b828c`. Every `file:line` was read in source; anything not read is
marked *inferred*. Context: `docs/next-steps.md` §5 item 1 and §8 ("Medium
(money)" findings, work item 16), `docs/project-story.md` §14.

Two mechanisms exist today. `reserveSpend` (`middleware/src/lib/spend-holds.ts:280`)
writes a P75 hold before a path's first side effect and judges it against the
initiative allocation, maintenance reserve, grant envelope and user budget.
`recordSpend` / `recordBffCall` (`middleware/src/providers/spend-ledger.ts:107,185`)
append the ledger row that settles the hold once `cost_usd` is known
(`providers/spend-holds.ts:396`, `SETTLE_HOLD_SQL`). A row with no known cost
leaves the hold held until it expires.

## 1. Every path that costs money

Columns: what the path bills; whether it calls `reserveSpend` (hold), lands on
`spend_entries` (ledger), both or neither; where a real figure could come from.

### 1a. The BFF's own Bedrock calls (`ConverseCommand` / `InvokeModel`)

| # | Path | Bills | Hold | Ledger | Real figure |
|---|---|---|---|---|---|
| 1 | `lib/session-titles.ts:144` (`maybeGenerateTitle`, fired unawaited from `routes/agents.ts:580,631`) | Nova tokens | no | `recordBffCall` :156 | `resp.usage` × `pricing.ts:33-38` |
| 2 | `lib/judge.ts:141` | Nova Pro tokens | no | `recordBffCall` :152 | same |
| 3 | `lib/harness-runner.ts:349` (harness judge) | configured judge model | no | `recordBffCall` :354 | same |
| 4 | `lib/canary-judge.ts:180,186` | judge model or prompt ARN | no | `recordBffCall` :195 | same |
| 5 | `lib/change-reviewer.ts:107` (SDLC review) | Nova tokens | no | `recordBffCall` :113 | same |
| 6 | `lib/site-survey.ts:386` | Nova tokens | no | `recordBffCall` :391 | same |
| 7 | `lib/vision-extractor.ts:133` | Nova Pro vision tokens | no | `recordBffCall` :147 | same |
| 8 | `lib/embedding.ts:45` (Titan v2) | embedding tokens | no | `recordBffCall` :56 | `inputTextTokenCount` × Titan rate |
| 9 | `providers/doc-linker.ts:267` | Nova tokens | no | `recordBffCall` :277 | `decoded.usage` × price |
| 10 | `routes/canary.ts:143` (`ConverseStream`, user-triggered) | Nova tokens | no | `recordBffCall` :155 | stream `metadata.usage` |
| 11 | `routes/canary-library.ts:678` (`ConverseStream`, user-triggered) | Nova tokens | no | `recordBffCall` :694 | same |
| 12 | `routes/capabilities.ts:299` (browser vision answer, user-triggered) | Nova Pro vision | no | `recordBffCall` :314 | `visionResp.usage` × price |

All twelve sites pass only `feature`, `model`, `usage`: none passes `actorId` or
`initiativeId` (grep: 0 of 12), so every `bff_call` row is unattributed and is
counted by no budget. The figure itself is already real tokens at a list price
(`cost_basis = 'estimated'`), never reconciled against a bill.

### 1b. AgentCore runtime invokes (the agent's Nova tokens plus runtime session time)

| # | Path | Bills | Hold | Ledger | Real figure |
|---|---|---|---|---|---|
| 13 | `routes/agents.ts:253` `POST /api/agents/:id/invoke` → `providers/agentcore.ts:769` (`InvokeAgentRuntimeCommand`, streaming) | agent's Bedrock Converse calls + runtime CPU/GB-seconds | no | no | tokens: the agent accumulates Converse usage (`agents/_shared/instrumentation.py:250-436`), emits an `ORGIQ_TRACE` line, `lib/cw-trace-ingest.ts` polls it into `observability.invocation_traces` priced at `lib/trace-sink.ts:1118` (read by `routes/cost.ts`), not `spend_entries`. Runtime time: `durationMs` at `agents.ts:528,565`; nothing in the invoke response carries billing (*inferred*) |
| 14 | `lib/conversation-summarize.ts:187` (`/summarize`, `routes/conversation-summarize.ts:100`, `routes/social-summarize.ts`) → `agentcore.invokeAgent` (`providers/agentcore.ts:713`), agent `orgiq-assessment-drafter` | same | no | no | same trace path; `out.raw` carries no usage |
| 15 | `lib/conversation-artifact.ts:243` (drafter) | same | no | no | same |
| 16 | `lib/assessment-drafts.ts:222` (drafter) | same | no | no | same |
| 17 | `lib/agent-loop/plan.ts:112` (drafter plan step; execution is row 22) | same | no | no | same |
| 18 | `lib/social-deck.ts:120`, `lib/deck-shared/service.ts:123,188` (deck agents) | same | no | no | same |
| 19 | `lib/assessment-dispatcher.ts:67` (assessment runs) | same | no | no | same |
| 20 | `lib/harness-runner.ts:268` (harness case invoke; judge is row 3) | same | no | no | `durationMs` only |
| 21 | `routes/invocations.ts:874` (`/replay`) | same | no | no | `processTrace` with no tokens → `est_cost_usd` null |

### 1c. Devbox microVMs (AgentCore runtime sessions running Claude Code)

| # | Path | Bills | Hold | Ledger | Real figure |
|---|---|---|---|---|---|
| 22 | `routes/devbox.ts:862` `POST /:sessionId/task` → `runTaskAndForward` :684 (`reserveSpend`, `box_task`), meter :699, `recordSpend` :829 | Bedrock Claude tokens + session time | yes | yes (`provider: 'bedrock'`) | `result.total_cost_usd` (`reported`) else `usage` × SSM `/orgiq/pricing/model_prices` (`estimated`, Anthropic list defaults `lib/model-prices-defaults.ts`); a cut run books the metered figure |
| 23 | `routes/internal-devbox.ts:280` (agent loop step, `agent_loop`) → same function; local branch `recordSpend` :260 | same | yes | yes | same |
| 24 | `lib/job-dispatcher.ts:132` `holdJobSpend` (`job`) → `markRunning` :210 → `lib/devbox-runner.ts:220` (`InvokeRuntime`) → `recordJobSpend` | same | yes (skipped when `job.botId`: the bot_run hold covers it) | yes | same parsers (`lib/run-cost.ts`) |
| 25 | `lib/sdlc-pipeline.ts:112` `dispatchGovernedRun` (`agent_project_run`) → `lib/project-runner.ts:176` → `recordAgentProjectRunSpend` :226 | same | yes | yes | same |
| 26 | `routes/devbox.ts:896` `POST /:sessionId/command` (`InvokeAgentRuntimeCommandCommand` shell) | session time only | no | no | wall time of the command; CloudWatch `AWS/Bedrock-AgentCore` per-runtime metrics |
| 27 | `routes/devbox.ts:1072` shell URL → `lib/devbox-shell.ts:112` (PTY) | session time while the shell is open | no | no | same |
| 28 | `lib/devbox-git.ts` `runDevboxGit` (clone/push through the entrypoint, `InvokeRuntime`) | session time | no | no | same |
| 29 | `lib/project-runner.ts:50` `runDevboxShell` (working-tree probes around a governed run) | session time | no | no | inside row 25's hold but never booked |
| 30 | The session itself: alive between tasks until `lib/devbox-reaper.ts` (idle 20 min, ceiling 4 h; AgentCore's own 1 h idle / 8 h max, `lib/devbox-lifetime.ts:4-6,62-64`) | idle microVM time | no | no | session start (`registerBox`) to `StopRuntimeSessionCommand` (`devbox.ts:813`, reaper) × a runtime rate; Cost Explorer by the runtime's usage type |

Only Claude tokens inside a task are booked. Runtime CPU/memory seconds, the
larger part of a long idle box (*inferred*), are booked nowhere.

### 1d. Queued jobs and bots

| # | Path | Bills | Hold | Ledger | Real figure |
|---|---|---|---|---|---|
| 31 | `lib/bot-runner.ts:1046` `reserveBotFiring` → `fireBot` :1113 (`bot_run`; `essential` for a scheduled essential bot) → governed run :1183 or `enqueueJob` :1217; hold bound :1206,1237; settled by `providers/bots.ts:1211` and `recordBotRunSpend` (`spend-ledger.ts:308`) from `bot_runs.cost_usd` | the devbox run (rows 24/25) | yes | yes | the run's reported/estimated figure |
| 32 | `lib/pr-watch-poller.ts:224` `dispatchPrRun` → `reserveBotFiring`, job :231 | same | yes | yes (via bot_run) | same |
| 33 | `routes/bots.ts:331` marketplace dispatch → `dispatchWorkItem` (`bot-runner.ts:1381`) | same | yes | yes | same |
| 34 | `routes/local-compute.ts:723` (paired workstation claims a job) | nothing (local inference) | no | yes: a confident `$0`, `provider: 'local'` | by doctrine (`lib/run-cost.ts`) |

### 1e. Live video (LVS media minutes)

| # | Path | Bills | Hold | Ledger | Real figure |
|---|---|---|---|---|---|
| 35 | A call: the browser creates the LVS session through platform-api (`platform-api/src/routes/videoSessions.ts`, *inferred from headers only*); the BFF's part is the realtime token (`lib/realtime-token.ts:108`) and the seat/lobby admission platform-api asks for (`routes/realtime-lobby-access.ts:42,68`) | SFU EC2 (`infra/lib/social-media-stack.ts:185`, default `t4g.small`), TURN EIP :671, egress ≈0.64 Mbps per consumer pair; ≈$0.03–0.08 per participant-hour (2026-10-01 note, its own [M] label) | no | no | participant-minutes from LVS session start/end (platform-api owns them); Cost Explorer `DataTransfer-Out` on the SFU |
| 36 | Recordings and transcripts: `providers/social-platform.ts:557,576,599` (`listRecordings`, `recordingPlayback`, `recordingTranscript`) | recording storage + transcription (*inferred*; billed in LVS/platform-api, not read here) | no | no | platform-api recording rows; S3/Transcribe in Cost Explorer |

### 1f. Cross-cutting gaps

- No cost-allocation tags: `infra/lib` carries only `Name` tags (`social-media-stack.ts:305,671`); the `initiative` tag exists only in a mock runbook seed (`middleware/src/mock/runbooks.seed.ts:614`). Cost Explorer cannot split by tenant or initiative today.
- The only account-wide figure the BFF reads is `AWS/Bedrock` `InputTokenCount` + `OutputTokenCount` over 24 h (`providers/cloudwatch.ts:354-355`), a total with no attribution.
- Unattributed spend is allowed unless `SPEND_HOLDS_UNATTRIBUTED=refuse` (`spend-holds.ts:194-196,307`); infra sets neither it nor `BUDGET_FAIL_CLOSED` (§8).
- `spend_holds.source` has a CHECK list (`schema/spend_holds_schema.sql:25`); `spend_entries.source` does not (`schema/spend_ledger_schema.sql:18`). New sources need the holds constraint widened.

## 2. The minimum change: a real figure on every path

The settle mechanism already replaces the P75 with the real figure for rows
22–25 and 31–33 (`recordSpend` → `settleHold` keyed on `(source, source_id)`).
The work is to put the other rows on the same rails.

| Rows | Change | Figure that lands |
|---|---|---|
| 13–21 | One `meteredInvoke` wrapper in `providers/agentcore.ts` around :713 and :769: `reserveSpend({ source: 'agent_invoke', actorId: session.sub, initiativeId, forecast })` before `send`, `recordSpend` after. The agent already sums Converse usage (`instrumentation.py:422-436`) and emits `duration_ms` on its final event (`agui_stream.py:215-245`): add `usage` to that event so the BFF prices it in-stream with `estimateUsageCost` instead of waiting for the CW Logs poll. Forecast: trailing `agent_invoke` samples per agent, else a fixed Nova P75. Add `'agent_invoke'` to `SpendSource` (`spend-ledger.ts:25`) and the holds CHECK. | tokens × Nova rate, `estimated`; runtime seconds from `durationMs` × a runtime rate row in SSM (see 30) |
| 1–12 | Pass `actorId` / `initiativeId` at all twelve `recordBffCall` sites (the request session, or the run the judge serves). Route the four user-triggered ones (10, 11, 12, 6) through `reserveSpend` first; leave titles, judges, embeddings and reviews as record-only but attributed. | unchanged (already real tokens), now judged |
| 22–30 | Book runtime time as its own row: `source: 'box_session'`, `source_id: <boxId>`, written at `StopRuntimeSessionCommand` (reaper and `devbox.ts:813`) as `(stop − registerBox.createdAt) × rate`, `cost_basis: 'estimated'`, charged to `box.projectId` and `box.ownerId`. Rate from an SSM row `/orgiq/pricing/agentcore_runtime` through the `lib/model-prices.ts` read-through pattern; AgentCore Runtime bills active CPU and memory seconds (*from memory, unverified*). Hold: extend the task's hold by the session's expected idle (`lifetimePolicy().idleMs × rate`) rather than a separate hold. | microVM seconds, `estimated` |
| 35–36 | platform-api owns session start/end; its `/end` path (`videoSessions.ts:187`) already calls back into the BFF's lobby admission. Add a service-signed callback (`lib/service-auth.ts` envelope) that writes `source: 'call_minutes'`, `source_id: <lvs session id>`, one row per participant (`actorId`), `initiativeId` from the lobby family (`lib/tenant-channels.ts`), `participant_minutes × $/participant-hour` from SSM. No hold: a call cannot be refused mid-ring; it is discretionary spend judged after the fact. Recording rows the same way from platform-api's recording-complete event (*inferred* that one exists). | participant-minutes × rate, `estimated` |
| all | Nightly reconciliation: `GetCostAndUsage` grouped by service and by tag → a `spend_reconciliation(day, service, bill_usd, ledger_usd)` table; the ratio is shown beside the ledger total on `/me/spend` and `/budgets`. Needs `Tags.of(stack).add('orgiq:tenant', …)` on the devbox runtime, SFU, middleware and platform-api tasks; per-initiative split stays ledger-side because one runtime serves every initiative. Cost Explorer lags ~24 h (*inferred*). | the bill, `reported` |

### How the three budgets are fed by those rows

| Budget | How it reads the ledger today | What the new rows must carry |
|---|---|---|
| User budget (`providers/user-budgets.ts:152-154`) | `SUM(cost_usd) WHERE actor_id = :user AND trigger IS DISTINCT FROM 'cron'`; held money by actor (`openHeldUsdForActor`) | `actorId` on every row: the chat invoker, the bff_call requester, the box owner for `box_session`, each participant for `call_minutes` (a 4-way call splits four ways) |
| Maintenance reserve, the floor (`providers/budgets.ts:905-906,207,214`) | `maintenance_usd = SUM WHERE trigger = 'cron'`; `floorSpent = min(maintenance, spent)`; reserve = stored else last period's essential spend × 1.1 (`budget-decisions.ts`); holds with `essential = true` count as floor (`openHeldSplit`) | `trigger: 'cron'` on bot-triggered `agent_invoke` and `box_session` rows (a cron bot's box time is floor); `essential` on their holds via `reserveBotFiring` |
| Discretionary remainder (`budgets.ts:208`, judged at `spend-holds.ts:459`) | `spent − floor`, less open non-essential holds; `decideAllocation` against `allocated − reserve` | everything else: manual chat invokes, user-triggered bff_calls, `call_minutes` on an initiative lobby, idle box time of a hand-started box |
| Unattributed (`spend-holds.ts:307-310`) | judged by the user budget alone; refused only under `SPEND_HOLDS_UNATTRIBUTED=refuse` | orgiq chat invokes and social DM calls usually have no initiative: decide whether they stay user-budget-only or the invoke body must name one before the flag is set (§8 work item 16) |

## 3. Load model for the BFF at 1, 2 and 4 vCPU

Source: `docs/realtime-validation/2026-10-05/capacity-progress.md`,
`2026-10-06/capacity-{sizing,sockets,latency}/manifest.json` and
`capacity-sockets/runs-summary.jsonl`, `2026-10-14/capacity-r6.md`,
`docs/deployment-enhancements/DE-25-middleware-capacity.md`, all at `5b6b828c`.
Every run was local: two BFF containers with Redis peer routing, DynamoDB
Local, 1,000 sockets, 100 calls, 800 paired chat senders. Targets
(`2026-10-05/capacity-baseline-profile/manifest.json`): invite p95 < 250 ms,
p99 < 1,000 ms; accept p95 < 250 ms; chat delivery p95 < 300 ms; health p99
< 50 ms; memory < 700 MiB. No cloud run exists.

| Size (Fargate `middlewareCpu`/MiB) | Sockets / calls established | Soak (chat every 30 s) | Burst (800 sends at once) | Health p99 | What it supports |
|---|---|---|---|---|---|
| 1 vCPU / 2 GB (deployed with the gateway on, `middleware-service-stack.ts:1188-1189`) | 1,000 / 100 in soak; burst on 0.110 established only 84–94 of 100 calls | chat p95 1,210–1,840 ms | chat p95 2,746–4,663 ms; invite p95 834–2,663 ms | 95–204 ms | steady presence and churn pass; the 0.105 constrained collision profile passed every target (health p99 35/44 ms). Chat must stay spread: a synchronized burst fails every latency target. BFF pinned at 100–106 % of one core. ≈$0.04/h (2026-10-01 note, [M]) |
| 2 vCPU / 4 GB (`middlewareProfile=capacity` in DE-25) | 1,000 / 100 in both shapes, no errors | chat p95 623–697 ms; health p99 19–45 ms passes | chat p95 1,135–1,428 ms (metrics mode), 2,580 ms plain; invite p95 49–101 ms | soak passes; burst 44–204 ms | the only size where soak passes health with every socket and call up; chat p95 still 2× target. Headroom goes to GC, libuv and SDK threads, not to the JS thread (CPU peaks 107–130 % of 200 %) |
| 4 vCPU / 4 GB | 1,000 / 100 | chat p95 802 ms | chat p95 998–1,465 ms; invite p95 53–78 ms | soak 46–50 ms; burst 82–137 ms | no better than 2 vCPU: CPU peaks 98–128 % of 400 %, so two to three cores idle. Single-thread bound |

What bounds it at every size is authority I/O per send, not CPU count: the
DynamoDB SDK's 50-socket pool queues ~1,200 requests in every run
(`capacity-sizing/manifest.json`, finding); a two-node DM send costs 15.2 → 12.4
Dynamo requests all-in (6.7 → 3.9 on the send path) after realtime-modules
0.110; raising the pool to 256/512 made soak p95 worse (1,840 → 2,855 →
4,606 ms at 1 vCPU) because the thread could not absorb the released work.
Burst p50 is 0.66–0.72 s of frame-queue wait behind the same socket's presence
`set`, then ~1.7 s to reach the peer (`capacity-latency/manifest.json`).

Chat burst each size supports at the 300 ms target (*inferred* by scaling the
measured p95 linearly with concurrent sends, which the notes do not do): about
80 simultaneous sends at 1 vCPU, about 200 at 2 vCPU, no more at 4. The
untested lever is the verdict cache: in-library it cut member queries per send
1.40 → 0.40 and burst chat p95 ≈1.2 s → 0.36 s (`capacity-r6.md`, Results); it
is off in production and unmeasured inside the BFF (DE-25, step 1).

### What changes when the gateway is split out

| Today (`realtimeGateway=true`) | Gateway as its own process |
|---|---|
| The BFF task is the gateway: 1 vCPU/2 GB, `desiredCount 1`, no autoscaling (`:873-876`), stop-before-start deploys with a signalling blackout per deploy (`:1171-1179`) | The BFF drops to 512/1024 and autoscales 1→4 tasks on CPU 70 % / memory 80 % (`:1188-1189,1489-1500`), but only with a Redis for shared fleet state and the reaper's leader lock (DE-47, `:877-880`) |
| REST, agent SSE, the dispatcher, the reaper and the pollers share the one core with 1,000 sockets | They get the core back; sockets, call signalling and chat fan-out move to the gateway (realtime-examples' websocket-gateway, `:18080` locally; the portal picks it through `REALTIME_GATEWAY_URL` / `VITE_GATEWAY_URL`, `portal/src/components/OptionalGatewayProvider.ts:104-132`) |
| Peer routing exists (`REALTIME_GATEWAY_ROUTER=redis`, `lib/gateway/env.ts`) and CDK never sets it | The gateway needs it on from day one and, by the same single-thread finding, about one vCPU per 1,000 sockets (*inferred*); the two-node numbers above already are the peer-routed shape, so the split alone does not move chat p95 |
| One deploy blackout | Two (`2026-10-08/gateway-split.md`, "not warranted now"): the note defers a process split until the capacity decision moves the gateway off one task |
| Media minutes are on the SFU either way (`social-media-stack.ts`) | Unchanged: splitting the gateway changes who carries signalling, never who carries video |

The decision DE-25 leaves with the user still stands: 2 vCPU with the
measured soak as the stated pilot limit, the authority cache measured in the
BFF first, and peer routing only after DE-47.
