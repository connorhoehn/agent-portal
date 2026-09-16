-- Local compute, P2 — a paired workstation PULLS work instead of being pushed it.
--
-- `local_compute_schema.sql` made a machine's PRESENCE real (a node, a token
-- hash, ephemeral sessions). This file makes its WORK real, and everything in it
-- exists because of one asymmetry: every other executor in this system is pushed
-- to. `lib/job-dispatcher.ts` calls AgentCore `InvokeRuntime` and the middleware
-- watches the resulting stream, so the middleware itself observes what happened
-- and what it cost. A laptop has no inbound path — that is a stated non-goal, not
-- an omission — so it must claim work, run it out of sight, and report back.
--
-- That flips two invariants the existing queue was built on, and each one gets a
-- column here.
--
-- ---------------------------------------------------------------------------
-- 1. Cost provenance: the executor stops being the pricing authority
-- ---------------------------------------------------------------------------
--
-- Measured 2026-09-11 against a llama-server on loopback serving Qwen3.6-35B:
-- Claude Code reported `total_cost_usd: 0.003711` for 1227 in / 2 out — exactly
-- Anthropic first-party Sonnet 4.5 list price — for a run that spent nothing. It
-- prices from its own table and cannot know the endpoint was loopback.
--
-- Recorded unchanged, that figure bills `initiative_budgets` allocations and
-- `budget_grants` envelopes, and trips all three brakes in `lib/bot-runner.ts`,
-- for dollars nobody spent. The feature's entire premise — an initiative's
-- maintenance floor DROPS because a workstation absorbed the batch — inverts,
-- and the floor goes up instead.
--
-- It could not be corrected after the fact either, which is why this column has
-- to land before the first local run records money:
--
--   * `bot_runs` had no model, provider or location column at all;
--   * `agent_project_runs.model` looks like it would distinguish them and
--     actively misleads — Claude Code 2.1.236 rejects an unrecognized `--model`
--     client-side before any HTTP request, so a local run MUST send a real
--     Anthropic id that llama.cpp then ignores. The column reads
--     `claude-sonnet-4-5-…` for a run served by Qwen.
--
-- So there was no predicate that selects "the local runs" for correction, and
-- polluted history in the rollups people actually read is not recoverable. The
-- provider is recorded from the middleware's own knowledge of which execution
-- path it took — never from the run's self-report. `lib/run-cost.ts` is the rule:
-- local prices at a confident 0, cloud keeps what it reported or stays NULL.
--
-- NULL means "recorded before this column existed", which is the same honest
-- absence `bot_runs.dispatched_by` carries for pre-migration runs. It is NOT a
-- synonym for 'bedrock': backfilling it as bedrock would be inventing a fact
-- about history, and every one of those runs predates local compute anyway.
--
-- ---------------------------------------------------------------------------
-- 2. Fencing: a claim can now outlive the process that granted it
-- ---------------------------------------------------------------------------
--
-- `completeJob` was `WHERE id = :id` with no ownership or status guard. Correct
-- while the middleware was the only caller — it could not race itself. With a
-- laptop holding a claim across a middleware restart it is not: a late
-- completion from a worker whose job has since been requeued and re-run
-- overwrites the newer result with the older one, and both runs were billed.
--
-- `claim_token` is the fencing token. It is minted per claim, returned to the
-- claimant once, and required on every heartbeat and completion. Requeue clears
-- it, so a stale claimant's write finds no row to update and is told its claim
-- expired — which is information it can act on, unlike a silent overwrite.
--
-- Stored in the clear on purpose, unlike `compute_nodes.token_hash`: this is a
-- one-job capability that dies with the job, not a credential, and the guard
-- needs to be a plain equality inside the same UPDATE that does the work.
--
-- Additive and idempotent: safe to re-run, and the middleware works either side
-- of it (a cluster without these columns degrades to the push-only behaviour and
-- refuses local claims rather than accepting unfenced ones). Loads after
-- agentic_work_schema.sql, agent_bots_schema.sql, agent_projects_schema.sql and
-- local_compute_schema.sql.

-- ---------------------------------------------------------------------------
-- Cost provenance
-- ---------------------------------------------------------------------------

ALTER TABLE bot_runs
  ADD COLUMN IF NOT EXISTS model_provider TEXT;

COMMENT ON COLUMN bot_runs.model_provider IS
  'Where the model that served this run actually ran, as recorded by the '
  'middleware from the execution path it chose: ''bedrock'' | ''local'' | '
  '''simulated''. NOT derived from the run''s self-reported model id, which is a '
  'real Anthropic id even for a locally-served run. NULL = recorded before this '
  'column existed; deliberately not backfilled to ''bedrock'', since asserting a '
  'provider for history nobody observed is the same class of invention this '
  'column exists to stop. Read with cost_usd: a ''local'' run is a confident $0, '
  'a ''bedrock'' run with NULL cost is burn unknown.';

ALTER TABLE agent_project_runs
  ADD COLUMN IF NOT EXISTS model_provider TEXT;

COMMENT ON COLUMN agent_project_runs.model_provider IS
  'Companion to model, and the only one of the two that can be trusted about '
  'where the run executed. model records the id the CLI was asked for — which '
  'must be a real Anthropic id even when a local llama-server served it, because '
  'the CLI rejects unrecognized ids client-side. See bot_runs.model_provider.';

-- The correction predicate this whole file exists to provide: "show me the local
-- runs" and "show me what a provider spent in a window", newest first.
CREATE INDEX IF NOT EXISTS bot_runs_model_provider_idx
  ON bot_runs (model_provider, started_at DESC);

-- ---------------------------------------------------------------------------
-- Fencing + pull-side claim bookkeeping
-- ---------------------------------------------------------------------------

ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

COMMENT ON COLUMN agent_jobs.claim_token IS
  'Fencing token for the current claim. Minted per claim, returned to the '
  'claimant exactly once, required on every heartbeat and completion, and CLEARED '
  'on requeue — so a worker that lost its claim to the stale-job reaper cannot '
  'overwrite the newer attempt''s result. NULL on queued jobs and on every job '
  'claimed by the in-process dispatcher, which cannot race itself.';

ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_jobs.heartbeat_at IS
  'Last liveness ping from a pull-side worker. Distinct from updated_at because '
  'reapStaleJobs reads updated_at, and a heartbeat must be able to say "still '
  'running" without looking like a state change — but also so a job that stopped '
  'heartbeating is distinguishable from one that simply has not changed state. '
  'NULL for pushed jobs, whose liveness is the middleware''s own in-flight run.';

-- ---------------------------------------------------------------------------
-- Node capability advertisement
-- ---------------------------------------------------------------------------
--
-- `local_models` already exists in local_compute_schema.sql and was inert — no
-- reader outside the row mapper. It becomes load-bearing here (the claim filter
-- matches a job's requested model against it), and these two join it.

ALTER TABLE compute_nodes
  ADD COLUMN IF NOT EXISTS job_kinds JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN compute_nodes.job_kinds IS
  'Job kinds this node advertises it can run, intersected server-side with the '
  'kinds local execution is allowed at all — a node cannot widen its own '
  'allowlist by claiming more. Empty = the server default set. Without this a '
  'local node calling claim takes whatever is at the head of the queue, '
  'including interactive cloud-only work it has no way to perform.';

ALTER TABLE compute_nodes
  ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN compute_nodes.max_concurrency IS
  'How many jobs this node may hold at once, capped server-side. Defaults to 1, '
  'not to "while idle": a llama.cpp server has a fixed slot count (the reference '
  'workstation runs 2, kv_unified), and the slot budget is shared with whatever '
  'the developer is doing at their keyboard. Over-claiming does not queue '
  'politely — it degrades every in-flight run, including the human''s.';

-- ---------------------------------------------------------------------------
-- When the worker last ASKED for work
-- ---------------------------------------------------------------------------
--
-- `last_seen_at` is bumped by presence AND by every work-loop call, so it
-- cannot answer "is this machine pulling work?" — a paired laptop whose worker
-- has been switched off still announces presence and still looks alive. From
-- the fleet page that is indistinguishable from a machine turning its poll
-- loop, which is the question someone actually has when they are away from
-- their desk and want to know the thing is working.
--
-- Separate column, written only by POST /claim. Presence says the machine is
-- reachable; this says its work loop is running.

ALTER TABLE compute_nodes
  ADD COLUMN IF NOT EXISTS last_claim_at TIMESTAMPTZ;

COMMENT ON COLUMN compute_nodes.last_claim_at IS
  'When this node last called POST /claim — i.e. last asked the queue for work. '
  'Distinct from last_seen_at, which presence also bumps: a machine can be '
  'reachable and announcing while its work loop is stopped, and only this '
  'column can tell those apart.';

-- The concurrency check counts a node's live claims; the claim filter reads a
-- node's advertised kinds. Both are per-request on the claim path.
CREATE INDEX IF NOT EXISTS agent_jobs_live_box_idx
  ON agent_jobs (box_id, status)
  WHERE status IN ('claimed', 'running');
