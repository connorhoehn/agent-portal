-- OrgIQ observability — Sprint 4 (M11 + M12) memory + guardrail-rule tables.
--
-- M11  memory observability: AgentCore Memory ops happen inside the agents
--      during invocation but the middleware can't see them. The agent emits
--      memory events in its trace bundle alongside tool_calls; the trace sink
--      best-effort inserts into observability.memory_events. The MemoryPage
--      surface then renders per-agent stats + recent events + cold sessions.
--
-- M12  guardrail rule-level interventions: today invocation_traces.guardrail_
--      action is BLOCKED/ANONYMIZED/NONE — opaque. Bedrock Guardrails returns
--      per-rule trace data; we capture each fired rule into
--      observability.guardrail_interventions so operators can see *which* rule
--      fired (PII.email vs. topic.violence) and on what substring.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint4-memory-schema.sh
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- M11 — Memory events.
--
-- One row per AgentCore Memory operation. kind ∈
-- {'retrieve','write','summarize','expire'}. invocation_id is a soft FK to
-- observability.invocation_traces — we deliberately do NOT enforce it as a
-- hard FK because the trace row may arrive *after* the memory event in the
-- async pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.memory_events (
  memory_event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id      uuid,
  agent_id           text NOT NULL,
  session_id         text,
  kind               text NOT NULL,
  memory_id          text,
  query_text         text,
  result_count       integer,
  duration_ms        integer,
  retrieved_summary  text,
  errored            boolean NOT NULL DEFAULT false,
  error_message      text,
  ts                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_events_invocation_idx
  ON observability.memory_events (invocation_id, ts DESC);
CREATE INDEX IF NOT EXISTS memory_events_agent_idx
  ON observability.memory_events (agent_id, kind, ts DESC);

-- ---------------------------------------------------------------------------
-- M12 — Guardrail rule-level interventions.
--
-- One row per *fired rule* (a single invocation can have multiple). We keep
-- matched_text truncated at 200 chars in the writer so unbounded prompts can't
-- bloat the table. rule_category mirrors Bedrock Guardrails categories
-- (PII / TOPIC / CONTENT / PROMPT_ATTACK). severity is LOW/MEDIUM/HIGH.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.guardrail_interventions (
  intervention_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id    uuid,
  agent_id         text NOT NULL,
  rule_name        text NOT NULL,
  rule_category    text,
  severity         text,
  action           text NOT NULL,
  matched_text     text,
  ts               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guardrail_interventions_invocation_idx
  ON observability.guardrail_interventions (invocation_id);
CREATE INDEX IF NOT EXISTS guardrail_interventions_rule_idx
  ON observability.guardrail_interventions (rule_name, ts DESC);
