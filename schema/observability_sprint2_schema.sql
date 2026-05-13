-- OrgIQ observability — Sprint 2 (M3+M4+M5) trace stitching + per-tool latency.
--
-- M3  trace stitching:        invocation_traces gains parent_invocation_id so the
--                              portal can render the multi-agent call graph
--                              (supervisor -> search -> knowledge-base). user_id +
--                              session_id are soft tenant fields the harness/
--                              runtime stamps when the caller identity is known.
-- M4  per-tool latency:        tool_calls is a new child table — one row per tool
--                              invocation inside an agent run (search.retrieve,
--                              graph.query, embed, ...). Soft FK on invocation_id
--                              (no CASCADE) so a manual purge of traces doesn't
--                              blow up the tool rows.
-- M5  triage workflow:         pre-built indexes for the patterns the triage UI
--                              hits: parent lookup, per-user history, per-tool
--                              latency rollups, recent error tail.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint2-schema.sh
--
-- Idempotent (IF NOT EXISTS). Safe on every boot. Backward compatible: existing
-- trace rows without parent_invocation_id / user_id / session_id continue to
-- work — the new columns are nullable.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- Parent-link + soft tenant fields on traces.
-- ---------------------------------------------------------------------------
ALTER TABLE observability.invocation_traces
  ADD COLUMN IF NOT EXISTS parent_invocation_id uuid,
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS invocation_traces_parent_idx
  ON observability.invocation_traces (parent_invocation_id);

CREATE INDEX IF NOT EXISTS invocation_traces_user_idx
  ON observability.invocation_traces (user_id, ts DESC);

-- ---------------------------------------------------------------------------
-- Per-tool call rows. Inserted when trace-sink receives a `toolCalls[]` array.
-- invocation_id is a soft FK — no cascade — so an invocation deletion doesn't
-- blow up tool rows (and vice versa). Indexed for the three triage queries:
--   - "show me the tools called by this invocation"        → tool_calls_invocation_idx
--   - "p99 latency of search.retrieve over the last 24h"   → tool_calls_tool_name_idx
--   - "recent errors across all tools"                      → tool_calls_errored_idx
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.tool_calls (
  tool_call_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id uuid NOT NULL,                       -- soft FK; no cascade so an
                                                     -- invocation deletion doesn't blow up tool rows
  tool_name     text NOT NULL,
  started_at    timestamptz NOT NULL,
  duration_ms   integer,
  input_size    integer,
  output_size   integer,
  errored       boolean NOT NULL DEFAULT false,
  error_message text,
  input_sample  text,                                -- first 500 chars
  output_sample text,                                -- first 500 chars
  est_cost_usd  numeric(10,6),                       -- for tool calls that cost (Bedrock retrieve, embed)
  ts            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_invocation_idx
  ON observability.tool_calls (invocation_id);

CREATE INDEX IF NOT EXISTS tool_calls_tool_name_idx
  ON observability.tool_calls (tool_name, ts DESC);

CREATE INDEX IF NOT EXISTS tool_calls_errored_idx
  ON observability.tool_calls (errored, ts DESC) WHERE errored = true;
