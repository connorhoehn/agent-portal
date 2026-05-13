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

CREATE TABLE IF NOT EXISTS observability.sampling_config (
  template_id text PRIMARY KEY,
  rate        numeric(3,2) NOT NULL CHECK (rate BETWEEN 0 AND 1),
  schema_json jsonb
);

INSERT INTO observability.sampling_config (template_id, rate)
VALUES ('default', 0.1)
ON CONFLICT (template_id) DO NOTHING;
