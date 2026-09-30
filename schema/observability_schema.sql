-- OrgIQ observability — drift + quality data plane.
--
-- Stores a sampled record of every AgentCore agent invocation that the
-- middleware decides to trace. Each row carries:
--   - the Titan-V2 embedding of the response (1024-dim) for cosine drift,
--   - the Nova-Pro judge score + rationale (LLM-as-a-judge),
--   - schema validation + PII + guardrail metadata,
--   - an optional human review label/note (for the portal feedback button).
--
-- Apply via RDS Data API. The companion script
-- `infra/scripts/apply-observability-schema.sh` splits this file into single
-- statements (RDS Data API doesn't support multistatement SQL).
--
-- Agent C maintains a separate `observability.approvals` table in a different
-- migration file — do not add it here. `CREATE SCHEMA IF NOT EXISTS` keeps the
-- two migrations safely independent of apply order.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.invocation_traces (
  invocation_id     uuid PRIMARY KEY,
  agent_id          text NOT NULL,
  agent_name        text NOT NULL,
  template_id       text,
  prompt_snippet    text,
  response_snippet  text,
  output_embedding  vector(1024),
  judge_score       numeric(4,3),
  judge_rationale   text,
  schema_valid      boolean,
  pii_detected      boolean DEFAULT false,
  guardrail_action  text,
  duration_ms       integer,
  human_label       text,
  human_note        text,
  ts                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invocation_traces_agent_ts_idx
  ON observability.invocation_traces (agent_id, ts DESC);

CREATE INDEX IF NOT EXISTS invocation_traces_template_ts_idx
  ON observability.invocation_traces (template_id, ts DESC);

CREATE INDEX IF NOT EXISTS invocation_traces_embedding_idx
  ON observability.invocation_traces
  USING ivfflat (output_embedding vector_cosine_ops) WITH (lists = 100);

-- Pipelines P1 (docs/pipelines-tenant-goal.md): every fleet invocation is a
-- pipeline Run. The trace bundle now names the AG-UI run it closes — `runId`
-- from RUN_STARTED, the id the middleware minted and the portal holds — so the
-- run and its trace finally share a key (they were disjoint before; see
-- docs/program-operating-model.md, "Not built yet"). `steps` is the run's
-- STEP_STARTED/STEP_FINISHED record, each with its TOOL_CALL_* attempts.
-- `agui_run_id`, not `run_id`: that name is `test_runs`' primary key below.
-- ADD COLUMN IF NOT EXISTS so an existing cluster converges on re-apply; the
-- sink (lib/trace-sink.ts) falls back to the old column list until it has.
ALTER TABLE observability.invocation_traces
  ADD COLUMN IF NOT EXISTS agui_run_id    text,
  ADD COLUMN IF NOT EXISTS agui_thread_id text,
  ADD COLUMN IF NOT EXISTS steps          jsonb,
  -- The invoking session's tenant (the payload's `auth.tenant`), so a Run's
  -- context tenant comes from the trace, not a guess from the agent id.
  ADD COLUMN IF NOT EXISTS tenant         text;

CREATE INDEX IF NOT EXISTS invocation_traces_agui_run_idx
  ON observability.invocation_traces (agui_run_id)
  WHERE agui_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS observability.sampling_config (
  template_id text PRIMARY KEY,
  rate        numeric(3,2) NOT NULL CHECK (rate BETWEEN 0 AND 1),
  schema_json jsonb
);

-- Sample every trace by default. A 0.1 rate was silently dropping 90% of
-- invocations in this lab, so with a handful of runs per day every
-- observability surface (traces, A2A topology, cost, drift) rendered empty
-- and looked broken. Lower this deliberately for a high-traffic deployment;
-- the trade-off is cost/volume, not correctness.
INSERT INTO observability.sampling_config (template_id, rate)
VALUES ('default', 1.0)
ON CONFLICT (template_id) DO NOTHING;

-- Test harness tables — populated by infra/scripts/harness.py and the
-- /api/observability/harness routes.
CREATE TABLE IF NOT EXISTS observability.test_cases (
  test_id          text PRIMARY KEY,
  agent_id         text NOT NULL,
  template_id      text,
  prompt           text NOT NULL,
  reference_output text,
  expected_tags    jsonb NOT NULL DEFAULT '[]',
  rubric_override  text,
  pass_threshold   numeric(4,3) NOT NULL DEFAULT 0.7,
  active           boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_cases_agent_idx
  ON observability.test_cases (agent_id, active);

CREATE TABLE IF NOT EXISTS observability.test_runs (
  run_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label          text NOT NULL,
  git_sha        text,
  judge_model_id text NOT NULL,
  agent_versions jsonb NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'pending',
  total_cases    integer,
  completed      integer NOT NULL DEFAULT 0,
  passed         integer NOT NULL DEFAULT 0,
  failed         integer NOT NULL DEFAULT 0,
  pass_rate      numeric(5,4),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  notes          text,
  mode           text NOT NULL DEFAULT 'sim'
);

CREATE TABLE IF NOT EXISTS observability.test_results (
  run_id                uuid NOT NULL,
  test_id               text NOT NULL,
  invocation_id         uuid,
  passed                boolean,
  judge_score           numeric(5,4),
  judge_rationale       text,
  schema_valid          boolean,
  tag_hits              jsonb,
  reference_similarity  numeric(5,4),
  response_snippet      text,
  fail_reasons          jsonb,
  duration_ms           integer,
  input_tokens          integer,
  output_tokens         integer,
  est_cost_usd          numeric(10,6),
  ts                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, test_id)
);
