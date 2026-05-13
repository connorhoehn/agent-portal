-- OrgIQ observability — Sprint 1 (M1+M2+M6) data plane extensions.
--
-- M1  live mode harness:    `test_runs.mode` distinguishes 'live' (deployed
--                            AgentCore runtimes invoked via invoke_agent_runtime)
--                            from 'sim' (Bedrock Nova-Pro called directly with
--                            role-play system prompts — the legacy path).
-- M2  token + cost capture:  every invocation_traces row gets agent token counts,
--                            judge token counts, and three USD cost columns.
--                            test_results gets cost columns so the harness UI
--                            can render per-case spend without re-joining.
-- M6  provenance:            invocation_traces.prompt_version, .model_id, and
--                            .runtime_image_digest stamp WHICH version of WHICH
--                            prompt ran on WHICH image. prompt_versions is a
--                            content-addressed registry — the short SHA on each
--                            trace row points back to a row here.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint1-schema.sh
--
-- Idempotent (IF NOT EXISTS, ON CONFLICT DO UPDATE). Safe on every boot.
-- Backward compatible: existing trace inserts with no token/cost fields
-- continue to work — the new columns are nullable.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- Token + cost + provenance on every trace row.
-- ---------------------------------------------------------------------------
ALTER TABLE observability.invocation_traces
  ADD COLUMN IF NOT EXISTS input_tokens          integer,
  ADD COLUMN IF NOT EXISTS output_tokens         integer,
  ADD COLUMN IF NOT EXISTS judge_input_tokens    integer,
  ADD COLUMN IF NOT EXISTS judge_output_tokens   integer,
  ADD COLUMN IF NOT EXISTS est_cost_usd          numeric(10,6),
  ADD COLUMN IF NOT EXISTS judge_cost_usd        numeric(10,6),
  ADD COLUMN IF NOT EXISTS total_cost_usd        numeric(10,6),
  ADD COLUMN IF NOT EXISTS prompt_version        text,
  ADD COLUMN IF NOT EXISTS model_id              text,
  ADD COLUMN IF NOT EXISTS runtime_image_digest  text;

-- ---------------------------------------------------------------------------
-- Per-case token + cost on test_results so the harness UI doesn't re-join.
-- ---------------------------------------------------------------------------
ALTER TABLE observability.test_results
  ADD COLUMN IF NOT EXISTS input_tokens   integer,
  ADD COLUMN IF NOT EXISTS output_tokens  integer,
  ADD COLUMN IF NOT EXISTS est_cost_usd   numeric(10,6);

-- ---------------------------------------------------------------------------
-- Mode on test_runs ('live' invokes deployed runtimes, 'sim' calls Bedrock
-- directly with role-play prompts). Defaults to 'sim' for backward compat
-- with rows created before this migration.
-- ---------------------------------------------------------------------------
ALTER TABLE observability.test_runs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'sim';

-- ---------------------------------------------------------------------------
-- Prompt versions registry. Content-addressed: prompt_version is a short SHA
-- of the system_prompt content. content_sha256 is the full hash for collision
-- checks. The harness runner POSTs each agent's system_prompt to the
-- /api/observability/prompt-versions endpoint at the start of every run, then
-- stamps the returned short SHA onto every trace produced by that agent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.prompt_versions (
  prompt_version  text PRIMARY KEY,        -- short sha (12 hex chars)
  agent_id        text NOT NULL,
  content         text NOT NULL,
  content_sha256  text NOT NULL,           -- full hex sha-256 for collision check
  registered_at   timestamptz NOT NULL DEFAULT now(),
  notes           text
);

CREATE INDEX IF NOT EXISTS prompt_versions_agent_idx
  ON observability.prompt_versions (agent_id, registered_at DESC);
