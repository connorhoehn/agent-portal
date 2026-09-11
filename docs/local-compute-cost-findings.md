# Local compute — cost and attribution findings

Investigation only; nothing here is fixed yet. Every claim below was checked
against running code or a live probe on 2026-09-11, and the probe commands are
recorded so a later session can re-run them rather than trust this file.

Companion to `docs/local-compute-presence.md` (the goal spec). Where the two
disagree about what P2 can reuse unchanged, this file is the measurement and
the spec is the intention.

---

## 1. The lab's cost number never passes through `lib/pricing.ts`

`lib/pricing.ts` spends thirty lines establishing that an unpriced model must
record `null`, not `0`, because "a 0 with real token counts beside it does not
read as unpriced — it reads as *free*". The only callers of
`estimateCostOrNull` are in `lib/trace-sink.ts`.

The lab/bot path does not use it. `lib/devbox-runner.ts:158`:

```ts
outcome.costUsd = Number(ev['total_cost_usd'] ?? 0);
```

`total_cost_usd` is Claude Code's own self-reported figure, computed from its
own pricing table. `DevboxOutcome.costUsd` is typed `number`, never `number |
null`, so the `?? 0` is load-bearing: a missing cost becomes a countable zero.

From there it reaches durable money:

- `lib/job-dispatcher.ts:105,124` → `agent_jobs.result.costUsd`
- `lib/project-runner.ts:196` → `finishRun({costUsd})` → `agent_project_runs.cost_usd`
- `lib/bot-runner.ts:1563` reads `(j.result->>'costUsd')::float8` → `bot_runs.cost_usd`

The *write* path handles null correctly — `providers/bots.ts:940` is
`cost_usd = COALESCE(:cost, cost_usd)` — so the schema and the readers already
support the three-state story. Only the producer collapses it.

## 2. A local run reports a fabricated Sonnet-rate charge (measured)

Probe, from `/tmp/cclocal-probe`:

```
claude -p "Reply with exactly the word: ok" \
  --model claude-sonnet-4-5-20250929 --output-format json --bare \
  --exclude-dynamic-system-prompt-sections \
  --settings '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0","ANTHROPIC_BASE_URL":"http://127.0.0.1:8080","ANTHROPIC_API_KEY":"local"}}'
```

Result: served locally — `~/models/llama-server.log` grew by 10 lines showing
`prompt eval time = 6929.98 ms / 1227 tokens` and `eval time = 24.75 ms / 2
tokens`, matching the reported usage exactly, and `modelUsage[...].provider`
read `"firstParty"`.

And it reported:

```json
"total_cost_usd": 0.003711,
"modelUsage": {"claude-sonnet-4-5-20250929": {"costUSD": 0.003711, "provider": "firstParty"}}
```

1227 input × $3/M + 2 output × $15/M = $0.003711 — Anthropic first-party
Sonnet 4.5 list price, for a run that spent nothing.

This is the mirror image of the `null` problem `pricing.ts` was written to
solve, and it is worse: the number is non-zero, authoritative-looking, and
lands in `initiative_budgets` spend and `budget_grants` envelope burn. It also
trips the three brakes in `bot-runner.ts` (`decideRunBudget`,
`decideAllocation`, `decideEnvelope`) for dollars nobody spent. The feature's
one selling point — "this initiative's maintenance floor dropped because
Connor's workstation absorbed the batch jobs" — inverts: the floor goes *up*.

## 3. Nothing on the run record can distinguish local from cloud

- `bot_runs` (`schema/agent_bots_schema.sql:72`) has `cost_usd` and no model,
  provider, or execution-location column at all.
- `agent_project_runs` (`schema/agent_projects_schema.sql:60`) has `model` —
  but that column cannot help, because of §5: the local run must send a real
  Anthropic model id to work at all. The recorded model says
  `claude-sonnet-4-5-20250929` for a run served by Qwen3.6-35B. The one column
  that looks like it distinguishes them actively misleads.

So the fabricated dollars in §2 are also unrecoverable after the fact: there is
no predicate that selects "the local runs" for correction.

`schema/agent_run_attribution_schema.sql` sets the doctrine to match — it
"degrades to 'burn unknown' — never to 'burn zero'". Both §1's zero and §2's
fake non-zero break it.

## 4. `subtype: "success"` on a hard API failure, and exit code 0

The 400 probe (unrecognized `--model qwen3.6-35b`) returned:

```json
{"is_error": true, "terminal_reason": "api_error", "api_error_status": 400,
 "subtype": "success", "total_cost_usd": 0, "num_turns": 1,
 "result": "API Error (qwen3.6-35b): 400 The provided model identifier is invalid.."}
```

and `claude -p` exited **0**.

`devbox-runner.ts:161` is `outcome.ok = String(ev['subtype'] ?? '') === 'success'`,
and `agents/devbox/main.py:214` emits `devbox_end` with the CLI's `returncode`,
which is 0. Nothing in the repo reads `is_error` — grep for it across
`devbox-runner.ts`, `devbox-fleet.ts`, `routes/devbox.ts` and
`agents/devbox/main.py` returns nothing.

Net effect: a run that never reached a model records as **successful, cost
$0**, with the API error text as its summary. Through `job-dispatcher.ts:117`
`requiresReview` defaults true, so it lands in `awaiting_review` — a human is
asked to accept an artifact that does not exist.

This one is **live in the shipped devbox path**, not specific to local compute.
The devbox pins `us.anthropic.claude-haiku-4-5-20251001-v1:0`; the day that id
goes stale or model access is revoked, every lab run reports success.

## 5. `cclocal` on this machine does not run locally

`~/.claude/settings.json` has an `env` block setting `CLAUDE_CODE_USE_BEDROCK=1`
and three `ANTHROPIC_DEFAULT_*_MODEL` Bedrock inference-profile ids. Settings
`env` is applied over the process environment, so `claude-local.sh`'s
`export ANTHROPIC_BASE_URL=http://127.0.0.1:8080` loses. Verified: the first
two probes reported `provider: "bedrock"` and left `llama-server.log` at 193
lines. Only passing `CLAUDE_CODE_USE_BEDROCK=0` *through `--settings`* reached
the local server.

Separately, Claude Code 2.1.236 rejects an unrecognized `--model` client-side
(`[claude-code:unrecognized_model]`, `duration_api_ms: 0`) before any HTTP
request, so `cclocal`'s `--model qwen3.6-35b` cannot work with this CLI
version. The alias must be a real Anthropic id that llama.cpp then ignores —
which is what makes the recorded model wrong in §3.

## 6. The dispatcher is push; local compute must be pull

`lib/job-dispatcher.ts` is `listBoxes()` → `claimNextJob(box.id, box.sessionId)`
→ `runDevboxTask()`, and `runDevboxTask` is hard-wired to AgentCore
`InvokeRuntime`. There is no execution seam. A laptop cannot be invoked (no
inbound is a stated non-goal), so P2 is not "add a claim route" — it is a
second execution mode with its own sessionless completion callback, i.e. a
sixth `service-auth.ts` spec alongside the five that exist.

That callback moves the cost number across a trust boundary. Today every
`cost_usd` in the system is server-observed: the middleware itself read the
result event off the runtime stream. A local worker asserts its own. Combined
with §2, an SME's laptop is the thing deciding what its runs cost.

Three concrete gaps behind that:

- **`completeJob` has no ownership or status guard** — `WHERE id = :id` only
  (`providers/agent-jobs.ts:460`). Safe when the middleware is the only caller;
  a late remote completion overwrites a job that has since been requeued.
- **`recoverOrphanedWork()` breaks on a second process.** It calls
  `reapStaleJobs(0)` at boot, justified in its own comment because "in a
  single-process middleware any job still marked live at boot is orphaned by
  definition — there is no run left to wait for." A laptop mid-job is exactly
  the counterexample. Every middleware restart — every `tsx watch` save in dev
  — requeues its in-flight work, and the same function calls
  `registerBox({id: job.boxId, sessionId: job.sessionId})`, minting a phantom
  devbox box named `local:<nodeId>` that the dispatcher then treats as idle and
  the reaper tries to stop through AgentCore. The work runs twice and the
  second copy is invoiced.
  `docs/local-compute-presence.md` §P1 lists skip guards for `devbox-reaper.ts`
  and `job-dispatcher.ts`; it does not mention this function, which is the
  sharper edge of the two.
- **`claimNextJob` cannot filter.** It takes `(boxId, sessionId)` as bare
  strings — good, no FK blocks a `local:` id — but selects the head of the
  queue with no predicate. The spec's "jobs filtered to what the node can run
  (job `kind` allowlist + the node's `local_models`)" does not exist and is not
  a parameter away; a local node calling it takes whatever is next, including
  interactive cloud-only work.

## 7. What P0 got right, and the one inert switch

Presence is real and correctly wired. `ConnectLocalCompute` is in
`lib/authz.ts:57` (`CAPABILITY_ACTIONS`), in
`portal/src/lib/capabilities.tsx:38`, and in all four orgiq cedar files —
the drift the spec warned about did not happen. `ViewLocalCompute` appears only
as a `requireSession()` label, which is an audit string by design, so its
absence from `CAPABILITY_ACTIONS` is correct rather than the usual gotcha.

`compute_nodes.accept_jobs` is the exception. Grep finds readers only in
`providers/local-compute.ts` (the setter and row mapper) and the mock fixture.
`job-dispatcher.ts`, `devbox-reaper.ts`, `routes/devbox.ts` and `bot-runner.ts`
contain no reference to local compute at all. It is a switch the UI can flip
that nothing honours — the same false-flag family as the KB search-type
omission.

## 8. Constraints from the measured server

- **Concurrency is 2**, not "while idle" — 2 slots, `kv_unified`. Any claim
  loop must cap there.
- **Prefill dominates.** The bare (~1.2k token) prompt cost 6.93 s at 177
  tok/s cold. Full-tool mode is ~19k tokens. Agent system prompts here resolve
  from Bedrock Prompt Management with a 60 s refresh and rebuild on change
  (`agents/_shared/prompt_source.py`), so a prompt edit mid-batch silently
  forces a full re-prefill on every subsequent job. Byte-stable prefixes are a
  scheduling constraint for local work, not a footnote.
- **Re-embedding cannot go local.** Titan V2 @1024d is baked into the
  Bedrock-managed KB and the `vector(1024)` columns; embeddings from another
  model are not in the same space. Of the spec's three suggested local job
  kinds, distillation and consolidation qualify — re-embedding does not, and
  `docs/local-compute-presence.md` §P2 should say so.
- **A local run is not free of Bedrock**, only of Bedrock *inference* for the
  generation step. Local vision extraction for the crawler is a genuine fit,
  but the KB embedding step after it still bills Titan.

## Suggested order

Ranked by reversibility and blast radius, not size.

1. **§4 and §1 first** — both are one-file producer fixes in
   `devbox-runner.ts` (read `is_error`; make `costUsd` `number | null` and drop
   the `?? 0`), and both are live today on the shipped devbox path. They also
   cost nothing to unwind. Everything downstream already accepts null.
2. **§3 next** — a `model_provider` (or `executed_on`) column on `bot_runs`
   plus a plain-code rule that a local provider prices at a confident `0` while
   an unpriced cloud model stays `null`. This is additive and idempotent in the
   style of `agent_run_attribution_schema.sql`, but it is the one-way door:
   once wrong dollars are in `bot_runs` history the rollups people read are
   polluted and there is no predicate to select them back out (§3). Do it
   before any local run records money.
3. **§6 third** — the claim route, its service-auth spec, a hard concurrency
   cap of 2, a fencing guard on `completeJob`, and the three skip guards
   (`recoverOrphanedWork` included).
4. **§5 is yours, not the repo's** — but it blocks any end-to-end test, since
   a "local" run currently bills Bedrock.
